/**
 * Reconciliación Automática Idempotente de Correos de Promotoras (Sin Tocar Contraseñas)
 *
 * Detecta y corrige cualquier desincronización entre `public.promotoras` y
 * (`auth.users`, `public.profiles`) — por ejemplo, tras ediciones directas en SQL/Table Editor:
 *   - Propaga cambios de `correo`, `nombre_completo` y `activo` hacia `auth.users` y `public.profiles`.
 *   - Preserva intactas las contraseñas existentes (nunca requiere ni modifica contraseñas).
 *   - Confirma el nuevo correo (`email_confirm: true`) para acceso inmediato a la App de Promotoras.
 *   - Modo simulación `--dry-run` POR DEFECTO; solo escribe con `--apply`.
 *   - Permite acotar por región con `--region=OCCIDENTE|CENTRO|ANDES|ALL` (default: `ALL`).
 *
 * Uso:
 *   # 1) Simulación segura (solo lectura):
 *   npm run sync:promotoras-emails
 *   npm run sync:promotoras-emails -- --region=OCCIDENTE
 *
 *   # 2) Aplicar cambios reales:
 *   npm run sync:promotoras-emails -- --apply
 *   npm run sync:promotoras-emails -- --apply --region=OCCIDENTE
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  createSupabasePromotoraAuthSyncGateway,
  normalizeSyncEmail,
  resolveSyncRegionMetadata,
  syncPromotoraIdentityToSupabaseAuth,
  type PromotoraAuthSyncGateway,
  type PromotoraAuthSyncResult,
} from '../src/server/promotoraAuthSync';

export type SyncEmailsRegionFilter = 'ALL' | 'OCCIDENTE' | 'CENTRO' | 'ANDES';

export interface SyncEmailsCliOptions {
  mode: 'dry-run' | 'apply';
  region: SyncEmailsRegionFilter;
  delayMs: number;
}

export interface PromotoraEmailDriftItem {
  id: string;
  nombre_completo: string;
  region: string;
  activo: boolean;
  promotora_correo: string | null;
  auth_user_id: string | null;
  auth_email: string | null;
  profile_email: string | null;
  profile_full_name: string | null;
  profile_active: boolean | null;
  reasons: string[];
}

export interface SyncPromotorasEmailsReport {
  mode: 'dry-run' | 'apply';
  regionFilter: SyncEmailsRegionFilter;
  totalEvaluadas: number;
  sincronizadasPreviamente: number;
  desincronizadasDetectadas: number;
  sinCuentaAuth: number;
  actualizadas: number;
  conflictos: number;
  errores: number;
  driftItems: PromotoraEmailDriftItem[];
  resultados: Array<{
    id: string;
    nombre_completo: string;
    region: string;
    result: PromotoraAuthSyncResult;
  }>;
}

export function parseSyncEmailsCliArgs(argv: readonly string[]): SyncEmailsCliOptions {
  let mode: 'dry-run' | 'apply' = 'dry-run';
  let region: SyncEmailsRegionFilter = 'ALL';
  let delayMs = 60;

  for (const arg of argv) {
    if (arg === '--apply') mode = 'apply';
    else if (arg === '--dry-run') mode = 'dry-run';
    else if (arg.startsWith('--region=')) {
      const val = arg.slice('--region='.length).trim().toUpperCase();
      if (val === 'OCCIDENTE' || val === 'ZULIA') region = 'OCCIDENTE';
      else if (val === 'CENTRO' || val === 'VALENCIA') region = 'CENTRO';
      else if (val === 'ANDES') region = 'ANDES';
      else region = 'ALL';
    } else if (arg.startsWith('--delay-ms=')) {
      const parsed = Number(arg.slice('--delay-ms='.length));
      if (Number.isFinite(parsed) && parsed >= 0) delayMs = parsed;
    }
  }

  return { mode, region, delayMs };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPromotorasEmailDriftSync(params: {
  client: SupabaseClient;
  gateway?: PromotoraAuthSyncGateway | null;
  mode?: 'dry-run' | 'apply';
  region?: SyncEmailsRegionFilter;
  delayMs?: number;
}): Promise<SyncPromotorasEmailsReport> {
  const {
    client,
    mode = 'dry-run',
    region = 'ALL',
    delayMs = 60,
  } = params;
  const gateway = params.gateway ?? createSupabasePromotoraAuthSyncGateway(client);
  if (!gateway) {
    throw new Error('No se pudo inicializar el cliente administrativo de Supabase Auth.');
  }

  const { data: rawProms, error: promErr } = await client
    .from('promotoras')
    .select('id, nombre_completo, correo, email, region, region_id, sucursal, activo, auth_user_id')
    .order('id', { ascending: true });
  if (promErr || !Array.isArray(rawProms)) {
    throw new Error(`No se pudo leer public.promotoras: ${promErr?.message ?? 'sin datos'}`);
  }

  const filtered = (rawProms as Array<Record<string, unknown>>).filter((row) => {
    if (region === 'ALL') return true;
    const meta = resolveSyncRegionMetadata(row.region, row.sucursal);
    return meta.erpRegion === region;
  });

  const report: SyncPromotorasEmailsReport = {
    mode,
    regionFilter: region,
    totalEvaluadas: filtered.length,
    sincronizadasPreviamente: 0,
    desincronizadasDetectadas: 0,
    sinCuentaAuth: 0,
    actualizadas: 0,
    conflictos: 0,
    errores: 0,
    driftItems: [],
    resultados: [],
  };

  for (const row of filtered) {
    const id = String(row.id ?? '').trim();
    const nombre = String(row.nombre_completo ?? '').replace(/\s+/g, ' ').trim();
    const correo = normalizeSyncEmail(row.correo ?? row.email);
    const regionMeta = resolveSyncRegionMetadata(row.region, row.sucursal);
    const activo = row.activo !== false;
    const authUserId = row.auth_user_id ? String(row.auth_user_id).trim() : null;

    const authUser = authUserId ? await gateway.getAuthUserById(authUserId) : null;
    const profile = authUser ? await gateway.getProfileById(authUser.id) : null;

    if (!authUser) {
      report.sinCuentaAuth += 1;
      report.driftItems.push({
        id,
        nombre_completo: nombre,
        region: regionMeta.erpRegion,
        activo,
        promotora_correo: correo,
        auth_user_id: authUserId,
        auth_email: null,
        profile_email: null,
        profile_full_name: null,
        profile_active: null,
        reasons: ['unlinked_no_auth_account'],
      });
      continue;
    }

    const authEmail = normalizeSyncEmail(authUser.email);
    const profEmail = normalizeSyncEmail(profile?.email);
    const profName = String(profile?.full_name ?? '').trim();
    const reasons: string[] = [];

    if (correo && authEmail !== correo) reasons.push(`auth_email_drift(${authEmail ?? 'null'} -> ${correo})`);
    if (!authUser.email_confirmed_at) reasons.push('auth_email_unconfirmed');
    if (correo && profEmail !== correo) reasons.push(`profile_email_drift(${profEmail ?? 'null'} -> ${correo})`);
    if (!profile) reasons.push('profile_missing');
    if (profile && nombre && profName.toUpperCase() !== nombre.toUpperCase()) {
      reasons.push(`profile_name_drift(${profName} -> ${nombre})`);
    }
    if (profile && Boolean(profile.is_active) !== activo) {
      reasons.push(`profile_active_drift(${String(profile.is_active)} -> ${String(activo)})`);
    }

    if (reasons.length === 0) {
      report.sincronizadasPreviamente += 1;
      continue;
    }

    report.desincronizadasDetectadas += 1;
    report.driftItems.push({
      id,
      nombre_completo: nombre,
      region: regionMeta.erpRegion,
      activo,
      promotora_correo: correo,
      auth_user_id: authUser.id,
      auth_email: authEmail,
      profile_email: profEmail,
      profile_full_name: profName || null,
      profile_active: profile?.is_active ?? null,
      reasons,
    });

    if (mode === 'dry-run') {
      continue;
    }

    try {
      const result = await syncPromotoraIdentityToSupabaseAuth({
        gateway,
        promotora: {
          id,
          nombre_completo: nombre,
          email: correo,
          region: String(row.region ?? regionMeta.erpRegion),
          region_id: row.region_id ? String(row.region_id) : null,
          sucursal: row.sucursal ? String(row.sucursal) : regionMeta.canonicalSucursal,
          activo,
          auth_user_id: authUser.id,
        },
        previousEmail: authEmail,
      });

      report.resultados.push({ id, nombre_completo: nombre, region: regionMeta.erpRegion, result });
      if (result.status === 'synced') report.actualizadas += 1;
      else if (
        result.status === 'conflict_email_in_use' ||
        result.status === 'conflict_non_promotora_account'
      ) {
        report.conflictos += 1;
      } else if (result.status === 'error') {
        report.errores += 1;
      }
    } catch (err) {
      report.errores += 1;
      report.resultados.push({
        id,
        nombre_completo: nombre,
        region: regionMeta.erpRegion,
        result: {
          synced: false,
          status: 'error',
          authUserId: authUser.id,
          previousEmail: authEmail,
          email: correo,
          emailChanged: false,
          profileSynced: false,
          passwordPreserved: true,
          message: err instanceof Error ? err.message : 'Error inesperado durante sincronización.',
        },
      });
    }

    await sleep(delayMs);
  }

  return report;
}

function loadLocalEnvFilesSafe(): void {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const filename of ['.env.local', '.env']) {
    const filePath = path.join(rootDir, filename);
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false, quiet: true });
    }
  }
}

async function runCli(): Promise<void> {
  loadLocalEnvFilesSafe();
  const options = parseSyncEmailsCliArgs(process.argv.slice(2));
  const supabaseUrl = String(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno local.');
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const report = await runPromotorasEmailDriftSync({
    client,
    mode: options.mode,
    region: options.region,
    delayMs: options.delayMs,
  });

  console.log(`=== SINCRONIZACIÓN DE CORREOS PROMOTORAS (${options.mode.toUpperCase()} | REGIÓN: ${options.region}) ===`);
  console.log(`Destino Supabase: ${new URL(supabaseUrl).hostname}`);
  console.log(JSON.stringify(report, null, 2));

  if (report.conflictos > 0 || report.errores > 0) {
    process.exitCode = 1;
  }
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runCli().catch((err) => {
    console.error(
      `[ERROR] ${err instanceof Error ? err.message : 'Fallo sincronizando correos de promotoras.'}`
    );
    process.exit(1);
  });
}
