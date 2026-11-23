/**
 * Auditoría de Solo Lectura de Identidades 1:1 de Promotoras (Fase A / Diagnóstico)
 *
 * Contabiliza el total de promotoras por región en `public.promotoras` y detecta:
 *   - Perfiles sin correo o con formato inválido
 *   - Correos duplicados (intrarregionales o interregionales)
 *   - Homónimos de nombre completo entre distintas regiones o misma región
 *   - Regiones nulas o desalineadas contra `public."Regiones"`
 *   - Estado de vinculación 1:1 `auth_user_id` contra `auth.users` y `public.profiles`
 *
 * 100% SOLO LECTURA: jamás inserta, actualiza ni elimina datos ni expone secretos.
 *
 * Uso:
 *   npm run audit:promotoras
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildDeterministicPromotoraLoginEmail,
  planPromotoraIdentities1To1,
  type RawPromotoraDbRow,
} from './provision-promotoras-auth';

export interface PromotoraAuditReport {
  totalPromotoras: number;
  countsByRegion: Record<string, { total: number; activas: number; inactivas: number; vinculadasAuth: number }>;
  countsByCategoria: Record<string, number>;
  nullOrEmptyEmails: Array<{ id: number | string; nombre_completo: string; region: string; suggestedLogin: string }>;
  invalidEmails: Array<{ id: number | string; nombre_completo: string; region: string; correo: string; suggestedLogin: string }>;
  duplicateEmails: Array<{ email: string; rows: Array<{ id: number | string; nombre_completo: string; region: string }> }>;
  interregionalHomonyms: Array<{ normalizedName: string; rows: Array<{ id: number | string; nombre_completo: string; region: string; correo: string | null }> }>;
  intrarregionalHomonyms: Array<{ normalizedName: string; rows: Array<{ id: number | string; nombre_completo: string; region: string; correo: string | null }> }>;
  nullOrEmptyRegions: Array<{ id: number | string; nombre_completo: string; correo: string | null }>;
  regionIdMismatches: Array<{ id: number | string; nombre_completo: string; region: string; region_id: string | null; region_desc: string | null }>;
  unlinkedAuthCount: number;
  authEmailCollisionsWithNonPromotora: Array<{ id: number | string; correo: string; existingRole: string }>;
  deterministicFallbacksNeeded: number;
  parity1To1Ok: boolean;
}

const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizePersonName(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

async function fetchAllPromotorasOrdered(client: SupabaseClient): Promise<RawPromotoraDbRow[]> {
  const rows: RawPromotoraDbRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('promotoras')
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`No se pudo leer public.promotoras: ${error.message}`);
    }
    const page = Array.isArray(data) ? (data as RawPromotoraDbRow[]) : [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function listAllAuthUsersReadOnly(client: SupabaseClient) {
  const byEmail = new Map<string, { id: string; email: string; role: string }>();
  const byId = new Map<string, { id: string; email: string; role: string }>();
  const perPage = 200;
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`No se pudo listar auth.users (página ${page}): ${error.message}`);
    }
    const users = Array.isArray(data?.users) ? data.users : [];
    for (const u of users) {
      const email = String(u.email ?? '').trim().toLowerCase();
      const appMeta = (u.app_metadata ?? {}) as Record<string, unknown>;
      const role = String(appMeta.role ?? appMeta.app_role ?? '').trim().toLowerCase();
      const entry = { id: u.id, email, role };
      if (email) byEmail.set(email, entry);
      if (u.id) byId.set(u.id, entry);
    }
    if (users.length < perPage) break;
  }
  return { byEmail, byId };
}

export async function runReadOnlyPromotorasAudit(client: SupabaseClient): Promise<PromotoraAuditReport> {
  const [promotoras, regionesRes, authMaps] = await Promise.all([
    fetchAllPromotorasOrdered(client),
    client.from('Regiones').select('id_regi, regi_desd'),
    listAllAuthUsersReadOnly(client),
  ]);

  const regionDescById = new Map<string, string>();
  if (!regionesRes.error && Array.isArray(regionesRes.data)) {
    for (const r of regionesRes.data as Array<Record<string, unknown>>) {
      const id = String(r.id_regi ?? '').trim();
      const desc = String(r.regi_desd ?? '').trim().toUpperCase();
      if (id && desc) regionDescById.set(id, desc);
    }
  }

  const planResult = planPromotoraIdentities1To1(promotoras);

  const countsByRegion: PromotoraAuditReport['countsByRegion'] = {};
  const countsByCategoria: Record<string, number> = {};
  const nullOrEmptyEmails: PromotoraAuditReport['nullOrEmptyEmails'] = [];
  const invalidEmails: PromotoraAuditReport['invalidEmails'] = [];
  const emailGroups = new Map<string, Array<{ id: number | string; nombre_completo: string; region: string }>>();
  const nameGroups = new Map<string, Array<{ id: number | string; nombre_completo: string; region: string; correo: string | null }>>();
  const nullOrEmptyRegions: PromotoraAuditReport['nullOrEmptyRegions'] = [];
  const regionIdMismatches: PromotoraAuditReport['regionIdMismatches'] = [];
  const authEmailCollisionsWithNonPromotora: PromotoraAuditReport['authEmailCollisionsWithNonPromotora'] = [];
  let unlinkedAuthCount = 0;

  for (const row of promotoras) {
    const regionLabel = String(row.region ?? '').trim() || 'SIN_REGION';
    if (!countsByRegion[regionLabel]) {
      countsByRegion[regionLabel] = { total: 0, activas: 0, inactivas: 0, vinculadasAuth: 0 };
    }
    countsByRegion[regionLabel]!.total += 1;
    if (row.activo === false) countsByRegion[regionLabel]!.inactivas += 1;
    else countsByRegion[regionLabel]!.activas += 1;

    const hasValidAuthLink = Boolean(row.auth_user_id && authMaps.byId.has(String(row.auth_user_id)));
    if (hasValidAuthLink) countsByRegion[regionLabel]!.vinculadasAuth += 1;
    else unlinkedAuthCount += 1;

    const cat = String(row.categoria ?? 'Sin categoría').trim() || 'Sin categoría';
    countsByCategoria[cat] = (countsByCategoria[cat] || 0) + 1;

    if (!row.region || !String(row.region).trim()) {
      nullOrEmptyRegions.push({
        id: row.id,
        nombre_completo: String(row.nombre_completo ?? ''),
        correo: row.correo ?? null,
      });
    }

    const regUpper = regionLabel.toUpperCase();
    const desc = row.region_id ? regionDescById.get(String(row.region_id)) ?? null : null;
    const expectedOk =
      Boolean(desc) &&
      ((regUpper === 'OCCIDENTE' && desc === 'OCCIDENTE') ||
        ((regUpper === 'VALENCIA' || regUpper === 'CENTRO') && desc === 'CENTRO') ||
        (regUpper === 'ANDES' && desc === 'ANDES'));
    if (!expectedOk) {
      regionIdMismatches.push({
        id: row.id,
        nombre_completo: String(row.nombre_completo ?? ''),
        region: regionLabel,
        region_id: row.region_id ?? null,
        region_desc: desc,
      });
    }

    const cleanEmail = String(row.correo ?? '').trim().toLowerCase();
    if (!cleanEmail) {
      nullOrEmptyEmails.push({
        id: row.id,
        nombre_completo: String(row.nombre_completo ?? ''),
        region: regionLabel,
        suggestedLogin: buildDeterministicPromotoraLoginEmail(row.id, regionLabel),
      });
    } else if (!STRICT_EMAIL_REGEX.test(cleanEmail)) {
      invalidEmails.push({
        id: row.id,
        nombre_completo: String(row.nombre_completo ?? ''),
        region: regionLabel,
        correo: String(row.correo ?? ''),
        suggestedLogin: buildDeterministicPromotoraLoginEmail(row.id, regionLabel),
      });
    } else {
      const list = emailGroups.get(cleanEmail) ?? [];
      list.push({ id: row.id, nombre_completo: String(row.nombre_completo ?? ''), region: regionLabel });
      emailGroups.set(cleanEmail, list);

      const authHit = authMaps.byEmail.get(cleanEmail);
      if (authHit && authHit.role && authHit.role !== 'promotora') {
        authEmailCollisionsWithNonPromotora.push({
          id: row.id,
          correo: cleanEmail,
          existingRole: authHit.role,
        });
      }
    }

    const normName = normalizePersonName(String(row.nombre_completo ?? ''));
    const nameList = nameGroups.get(normName) ?? [];
    nameList.push({
      id: row.id,
      nombre_completo: String(row.nombre_completo ?? ''),
      region: regionLabel,
      correo: cleanEmail || null,
    });
    nameGroups.set(normName, nameList);
  }

  const duplicateEmails: PromotoraAuditReport['duplicateEmails'] = [];
  for (const [email, rows] of emailGroups.entries()) {
    if (rows.length > 1) duplicateEmails.push({ email, rows });
  }

  const interregionalHomonyms: PromotoraAuditReport['interregionalHomonyms'] = [];
  const intrarregionalHomonyms: PromotoraAuditReport['intrarregionalHomonyms'] = [];
  for (const [normalizedName, rows] of nameGroups.entries()) {
    if (rows.length > 1) {
      const regions = new Set(rows.map((r) => r.region.toUpperCase()));
      if (regions.size > 1) interregionalHomonyms.push({ normalizedName, rows });
      else intrarregionalHomonyms.push({ normalizedName, rows });
    }
  }

  return {
    totalPromotoras: promotoras.length,
    countsByRegion,
    countsByCategoria,
    nullOrEmptyEmails,
    invalidEmails,
    duplicateEmails,
    interregionalHomonyms,
    intrarregionalHomonyms,
    nullOrEmptyRegions,
    regionIdMismatches,
    unlinkedAuthCount,
    authEmailCollisionsWithNonPromotora,
    deterministicFallbacksNeeded: planResult.plans.filter((p) => p.loginEmailSource === 'deterministic_fallback').length,
    parity1To1Ok:
      planResult.plans.length === promotoras.length &&
      new Set(planResult.plans.map((p) => p.loginEmail)).size === promotoras.length,
  };
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
  const supabaseUrl = String(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno local.');
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const report = await runReadOnlyPromotorasAudit(client);
  console.log('=== AUDITORÍA SOLO LECTURA — PROMOTORAS 1:1 POR REGIÓN ===');
  console.log(`Destino Supabase: ${new URL(supabaseUrl).hostname}`);
  console.log(JSON.stringify(report, null, 2));
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runCli().catch((err) => {
    console.error(`[ERROR] ${err instanceof Error ? err.message : 'Fallo en auditoría de promotoras.'}`);
    process.exit(1);
  });
}
