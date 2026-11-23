/**
 * Aprovisionamiento Idempotente y Seguro de 33 Promotoras en Supabase Auth + `public.promotoras`
 *
 * Uso local seguro (sin exponer secretos en código ni historial de Git):
 *   PowerShell:
 *     $env:PROMOTORA_UNIVERSAL_PASSWORD = "<CLAVE_UNIVERSAL>"
 *     npm run seed:promotoras
 *
 *   Bash / macOS / Linux:
 *     PROMOTORA_UNIVERSAL_PASSWORD="<CLAVE_UNIVERSAL>" npm run seed:promotoras
 *
 * Variables de entorno requeridas (el script aborta si falta cualquiera):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - PROMOTORA_UNIVERSAL_PASSWORD
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type PromotoraRegionOficial = 'Occidente' | 'Valencia';

export interface PromotoraSeedRecord {
  nombre_completo: string;
  direccion: string | null;
  telefono: string;
  correo: string;
  region: PromotoraRegionOficial;
  activo: boolean;
  categoria?: string;
  created_at?: string;
}

export interface SeedEnvConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  universalPassword: string;
}

export interface PromotoraSeedSummary {
  totalProcesados: number;
  authCreados: number;
  authActualizados: number;
  perfilesCreados: number;
  perfilesActualizados: number;
  perfilesOccidente: number;
  perfilesValencia: number;
  advertencias: string[];
  errores: Array<{ correo: string; fase: 'auth' | 'db'; detalle: string }>;
}

const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 6;

export function normalizeSeedEmail(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function normalizeSeedPhone(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeSeedAddress(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function mapPromotoraRegionToSucursal(region: PromotoraRegionOficial): 'ZULIA' | 'VALENCIA' {
  return region === 'Valencia' ? 'VALENCIA' : 'ZULIA';
}

export function mapPromotoraRegionToErpCode(region: PromotoraRegionOficial): 'OCCIDENTE' | 'CENTRO' {
  return region === 'Valencia' ? 'CENTRO' : 'OCCIDENTE';
}

/**
 * Carga y valida el dataset oficial de promotoras desde JSON sin contraseñas.
 */
export function loadPromotorasSeedDataset(customFilePath?: string): PromotoraSeedRecord[] {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const datasetPath = customFilePath ?? path.resolve(currentDir, 'data', 'promotoras-seed.json');
  const rawContent = fs.readFileSync(datasetPath, 'utf8');
  const parsed = JSON.parse(rawContent) as unknown;

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`El dataset "${datasetPath}" está vacío o no es un arreglo JSON válido.`);
  }

  const seenEmails = new Set<string>();
  const normalized: PromotoraSeedRecord[] = [];

  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i] as Record<string, unknown>;
    const nombre_completo = String(item?.nombre_completo ?? '').replace(/\s+/g, ' ').trim();
    const correo = normalizeSeedEmail(String(item?.correo ?? ''));
    const telefono = normalizeSeedPhone(String(item?.telefono ?? ''));
    const direccion = normalizeSeedAddress(item?.direccion as string | null | undefined);
    const regionRaw = String(item?.region ?? '').trim();

    if (!nombre_completo) {
      throw new Error(`Registro #${i + 1}: falta nombre_completo.`);
    }
    if (!STRICT_EMAIL_REGEX.test(correo)) {
      throw new Error(`Registro #${i + 1} (${nombre_completo}): correo inválido "${correo}".`);
    }
    if (seenEmails.has(correo)) {
      throw new Error(`Registro #${i + 1}: correo duplicado en el dataset "${correo}".`);
    }
    if (regionRaw !== 'Occidente' && regionRaw !== 'Valencia') {
      throw new Error(
        `Registro #${i + 1} (${nombre_completo}): región inválida "${regionRaw}". Solo se permiten "Occidente" o "Valencia".`
      );
    }

    seenEmails.add(correo);
    normalized.push({
      nombre_completo,
      direccion,
      telefono,
      correo,
      region: regionRaw,
      activo: item?.activo !== false,
      categoria: String(item?.categoria ?? 'Fijas').trim() || 'Fijas',
      ...(typeof item?.created_at === 'string' && item.created_at.trim()
        ? { created_at: item.created_at.trim() }
        : {}),
    });
  }

  return normalized;
}

/**
 * Valida las 3 variables de entorno obligatorias sin imprimir jamás sus valores.
 */
export function validateSeedEnv(envSource: NodeJS.ProcessEnv = process.env): SeedEnvConfig {
  const supabaseUrl = String(envSource.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const serviceRoleKey = String(envSource.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  const universalPassword = String(envSource.PROMOTORA_UNIVERSAL_PASSWORD ?? '').trim();

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!universalPassword) missing.push('PROMOTORA_UNIVERSAL_PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno obligatorias para ejecutar el aprovisionamiento: ${missing.join(', ')}. ` +
        'Configúralas en tu entorno local/servidor seguro (nunca en código fuente ni en Git).'
    );
  }

  try {
    const parsedUrl = new URL(supabaseUrl);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error('Protocolo inválido');
    }
  } catch {
    throw new Error('SUPABASE_URL no tiene un formato de URL válido.');
  }

  if (universalPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `PROMOTORA_UNIVERSAL_PASSWORD debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres para Supabase Auth.`
    );
  }

  return { supabaseUrl, serviceRoleKey, universalPassword };
}

interface AuthUserLite {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

async function listAllAuthUsersPaginated(
  client: SupabaseClient,
  perPage = 200
): Promise<Map<string, AuthUserLite>> {
  const byEmail = new Map<string, AuthUserLite>();

  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`No se pudo listar usuarios de Supabase Auth (página ${page}): ${error.message}`);
    }

    const users = Array.isArray(data?.users) ? (data.users as AuthUserLite[]) : [];
    for (const user of users) {
      const normalized = normalizeSeedEmail(String(user.email ?? ''));
      if (normalized && user.id) {
        byEmail.set(normalized, user);
      }
    }

    if (users.length < perPage) {
      break;
    }
  }

  return byEmail;
}

async function resolveErpRegionIdsByCode(
  client: SupabaseClient
): Promise<Map<'OCCIDENTE' | 'CENTRO', string>> {
  const out = new Map<'OCCIDENTE' | 'CENTRO', string>();
  try {
    const { data, error } = await client.from('Regiones').select('id_regi, regi_desd');
    if (error || !Array.isArray(data)) return out;
    for (const row of data as Array<Record<string, unknown>>) {
      const code = String(row.regi_desd ?? '').trim().toUpperCase();
      const id = String(row.id_regi ?? '').trim();
      if ((code === 'OCCIDENTE' || code === 'CENTRO') && id) {
        out.set(code, id);
      }
    }
  } catch {
    // Tabla Regiones opcional en entornos de prueba mínimos
  }
  return out;
}

function isMissingOptionalColumnError(errorMessage: string): boolean {
  return /column\s+["']?(region|auth_user_id|region_id)["']?\s+.*does not exist|Could not find the ['"]?(region|auth_user_id|region_id)['"]? column/i.test(
    errorMessage
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sincroniza de forma 100% idempotente:
 *   1. Cuentas de acceso en Supabase Auth (`auth.users`) con `email_confirm: true`,
 *      `app_metadata` seguro (para RLS/autorización) y `user_metadata` de perfil.
 *   2. Registros en `public.promotoras` emparejados insensiblemente por `correo`.
 */
export async function syncPromotorasCatalogAndAuth(params: {
  client: SupabaseClient;
  records: readonly PromotoraSeedRecord[];
  universalPassword: string;
  delayMs?: number;
}): Promise<PromotoraSeedSummary> {
  const { client, records, universalPassword, delayMs = 60 } = params;
  const summary: PromotoraSeedSummary = {
    totalProcesados: 0,
    authCreados: 0,
    authActualizados: 0,
    perfilesCreados: 0,
    perfilesActualizados: 0,
    perfilesOccidente: 0,
    perfilesValencia: 0,
    advertencias: [],
    errores: [],
  };

  // 1. Cargar usuarios Auth existentes (paginado) y mapa dinámico de Regiones
  const existingAuthByEmail = await listAllAuthUsersPaginated(client);
  const erpRegionIdByCode = await resolveErpRegionIdsByCode(client);

  // 2. Leer filas existentes en `public.promotoras` para UPSERT idempotente case-insensitive
  const existingPromotorasByEmail = new Map<string, Record<string, unknown>>();
  const { data: existingRows, error: fetchPromError } = await client
    .from('promotoras')
    .select('*');

  if (fetchPromError) {
    throw new Error(`No se pudo consultar public.promotoras: ${fetchPromError.message}`);
  }

  let hasRegionColumn = false;
  let hasAuthUserIdColumn = false;
  let hasRegionIdColumn = false;

  const rowsList = Array.isArray(existingRows) ? (existingRows as Array<Record<string, unknown>>) : [];
  if (rowsList.length > 0) {
    const sampleKeys = new Set(Object.keys(rowsList[0] ?? {}));
    hasRegionColumn = sampleKeys.has('region');
    hasAuthUserIdColumn = sampleKeys.has('auth_user_id');
    hasRegionIdColumn = sampleKeys.has('region_id');
  } else {
    // Tabla vacía: intentaremos incluir las columnas extendidas y degradar si falta migración
    hasRegionColumn = true;
    hasAuthUserIdColumn = true;
    hasRegionIdColumn = erpRegionIdByCode.size > 0;
  }

  for (const row of rowsList) {
    const key = normalizeSeedEmail(String(row.correo ?? row.email ?? ''));
    if (key) {
      existingPromotorasByEmail.set(key, row);
    }
  }

  if (rowsList.length > 0 && (!hasRegionColumn || !hasAuthUserIdColumn)) {
    summary.advertencias.push(
      'Faltan columnas extendidas (`region` y/o `auth_user_id`) en `public.promotoras`. ' +
        'Ejecuta primero la migración `supabase/migrations/20261128000200_promotoras_personal_auth_rls.sql` en Supabase SQL Editor y vuelve a correr este script.'
    );
  }

  let warnedFallbackSchema = false;

  // 3. Procesamiento secuencial controlado (evita rate limits de Supabase Auth)
  for (const record of records) {
    const correo = normalizeSeedEmail(record.correo);
    const sucursalCompat = mapPromotoraRegionToSucursal(record.region);
    const erpRegionCode = mapPromotoraRegionToErpCode(record.region);
    const resolvedRegionId = erpRegionIdByCode.get(erpRegionCode) ?? null;

    summary.totalProcesados += 1;

    // 3A. Sincronización en Supabase Auth (`auth.users`)
    let authUserId: string | null = null;
    try {
      const existingAuth = existingAuthByEmail.get(correo);
      const nextAppMetadata = {
        ...(existingAuth?.app_metadata ?? {}),
        role: 'promotora',
        app_role: 'promotora',
        region: record.region,
        sucursal: sucursalCompat,
        ...(resolvedRegionId ? { region_id: resolvedRegionId } : {}),
        must_change_password: false,
      };
      const nextUserMetadata = {
        ...(existingAuth?.user_metadata ?? {}),
        nombre_completo: record.nombre_completo,
        region: record.region,
        rol: 'promotora',
      };

      if (existingAuth) {
        const { data: updatedAuth, error: updateAuthError } =
          await client.auth.admin.updateUserById(existingAuth.id, {
            password: universalPassword,
            email_confirm: true,
            app_metadata: nextAppMetadata,
            user_metadata: nextUserMetadata,
          });
        if (updateAuthError || !updatedAuth?.user?.id) {
          throw new Error(updateAuthError?.message || 'Respuesta vacía al actualizar Auth.');
        }
        authUserId = updatedAuth.user.id;
        summary.authActualizados += 1;
      } else {
        const { data: createdAuth, error: createAuthError } =
          await client.auth.admin.createUser({
            email: correo,
            password: universalPassword,
            email_confirm: true,
            app_metadata: nextAppMetadata,
            user_metadata: nextUserMetadata,
          });
        if (createAuthError || !createdAuth?.user?.id) {
          throw new Error(createAuthError?.message || 'Respuesta vacía al crear usuario Auth.');
        }
        authUserId = createdAuth.user.id;
        existingAuthByEmail.set(correo, {
          id: authUserId,
          email: correo,
          app_metadata: nextAppMetadata,
          user_metadata: nextUserMetadata,
        });
        summary.authCreados += 1;
      }
    } catch (err) {
      summary.errores.push({
        correo,
        fase: 'auth',
        detalle: err instanceof Error ? err.message : 'Error sincronizando en Supabase Auth.',
      });
      await sleep(delayMs);
      continue;
    }

    // 3B. Sincronización idempotente en `public.promotoras`
    try {
      const existingRow = existingPromotorasByEmail.get(correo);
      const basePayload: Record<string, unknown> = {
        nombre_completo: record.nombre_completo,
        direccion: record.direccion,
        telefono: record.telefono,
        correo,
        activo: record.activo,
        updated_at: new Date().toISOString(),
      };

      const extendedPayload: Record<string, unknown> = {
        ...basePayload,
        ...(hasRegionColumn ? { region: record.region } : {}),
        ...(hasAuthUserIdColumn && authUserId ? { auth_user_id: authUserId } : {}),
        ...(hasRegionIdColumn && resolvedRegionId ? { region_id: resolvedRegionId } : {}),
      };

      const applyDbWrite = async (payloadToWrite: Record<string, unknown>) => {
        if (existingRow && existingRow.id !== undefined && existingRow.id !== null) {
          const { data, error } = await client
            .from('promotoras')
            .update(payloadToWrite)
            .eq('id', existingRow.id)
            .select('*')
            .single();
          if (error) throw new Error(error.message);
          if (data) existingPromotorasByEmail.set(correo, data as Record<string, unknown>);
          return 'updated' as const;
        }

        const insertPayload: Record<string, unknown> = {
          ...payloadToWrite,
          categoria: record.categoria ?? 'Fijas',
          ...(record.created_at ? { created_at: record.created_at } : {}),
        };
        const { data, error } = await client
          .from('promotoras')
          .insert(insertPayload)
          .select('*')
          .single();
        if (error) throw new Error(error.message);
        if (data) existingPromotorasByEmail.set(correo, data as Record<string, unknown>);
        return 'created' as const;
      };

      let outcome: 'created' | 'updated';
      try {
        outcome = await applyDbWrite(extendedPayload);
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        if (isMissingOptionalColumnError(msg)) {
          hasRegionColumn = false;
          hasAuthUserIdColumn = false;
          hasRegionIdColumn = false;
          if (!warnedFallbackSchema) {
            warnedFallbackSchema = true;
            summary.advertencias.push(
              'Se guardaron los campos base porque la migración de columnas extendidas aún no fue ejecutada.'
            );
          }
          outcome = await applyDbWrite(basePayload);
        } else {
          throw dbErr;
        }
      }

      if (outcome === 'created') {
        summary.perfilesCreados += 1;
      } else {
        summary.perfilesActualizados += 1;
      }

      if (record.region === 'Occidente') {
        summary.perfilesOccidente += 1;
      } else {
        summary.perfilesValencia += 1;
      }
    } catch (err) {
      summary.errores.push({
        correo,
        fase: 'db',
        detalle: err instanceof Error ? err.message : 'Error guardando en public.promotoras.',
      });
    }

    await sleep(delayMs);
  }

  return summary;
}

function loadLocalEnvFilesSafe(): void {
  // Cargar `.env.local` y `.env` sin sobrescribir variables ya inyectadas por terminal
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const filename of ['.env.local', '.env']) {
    const filePath = path.join(rootDir, filename);
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
    }
  }
}

async function runCli(): Promise<void> {
  loadLocalEnvFilesSafe();

  const env = validateSeedEnv(process.env);
  const records = loadPromotorasSeedDataset();

  const adminClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  console.log('=== APROVISIONAMIENTO IDEMPOTENTE DE PROMOTORAS (CODIZULCA) ===');
  console.log(`Destino Supabase: ${new URL(env.supabaseUrl).hostname}`);
  console.log(`Registros en dataset oficial: ${records.length}`);

  const summary = await syncPromotorasCatalogAndAuth({
    client: adminClient,
    records,
    universalPassword: env.universalPassword,
    delayMs: 60,
  });

  console.log('\n--- RESUMEN DE SINCRONIZACIÓN ---');
  console.log(`Total procesados        : ${summary.totalProcesados}`);
  console.log(`Usuarios Auth creados   : ${summary.authCreados}`);
  console.log(`Usuarios Auth actualiz. : ${summary.authActualizados}`);
  console.log(`Perfiles BD creados     : ${summary.perfilesCreados}`);
  console.log(`Perfiles BD actualizados: ${summary.perfilesActualizados}`);
  console.log(`Perfiles en Occidente   : ${summary.perfilesOccidente}`);
  console.log(`Perfiles en Valencia    : ${summary.perfilesValencia}`);
  console.log(`Errores                 : ${summary.errores.length}`);

  if (summary.advertencias.length > 0) {
    console.log('\n--- ADVERTENCIAS ---');
    for (const warn of summary.advertencias) {
      console.warn(`- ${warn}`);
    }
  }

  if (summary.errores.length > 0) {
    console.log('\n--- DETALLE DE ERRORES ---');
    for (const item of summary.errores) {
      console.error(`- [${item.fase}] ${item.correo}: ${item.detalle}`);
    }
    process.exitCode = 1;
  }
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runCli().catch((err) => {
    console.error(
      `[ERROR] ${err instanceof Error ? err.message : 'Fallo inesperado ejecutando seed-promotoras.'}`
    );
    process.exit(1);
  });
}
