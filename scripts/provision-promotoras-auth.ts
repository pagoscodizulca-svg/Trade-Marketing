/**
 * Aprovisionamiento Masivo Idempotente 1:1 de Promotoras (Sin Fusión Regional)
 *
 * REGLAS INNEGOCIABLES:
 *   1. Lee la contraseña inicial EXCLUSIVAMENTE desde `process.env.INITIAL_PROMOTORA_PASSWORD`.
 *      Aborta con error claro si no está definida o no cumple longitud mínima (>= 8 caracteres).
 *      JAMÁS imprime ni persiste la contraseña en texto plano.
 *   2. Itera 1 a 1 sobre TODAS las filas existentes en `public.promotoras` por PK `id`.
 *      PROHIBIDO agrupar por nombre (`GROUP BY nombre`), deduplicar homónimos o mezclar regiones.
 *   3. Si una fila no tiene correo válido o colisiona con otra fila, asigna un login único
 *      determinístico vinculado a su `(id, region)`:
 *        `promotora.<region_slug>.id<id>@promotoras.codizulca.local`
 *      sin fusionar ni sobrescribir jamás su `region` ni `region_id`.
 *   4. Modo simulación `--dry-run` POR DEFECTO (cero escrituras). Solo aplica cambios con `--apply`.
 *   5. Soporta `must_change_password` configurable (`--must-change-password=true|false`, default `true`).
 *   6. 100% idempotente: ejecutarlo dos veces con `--apply` produce 0 duplicados y 100% paridad 1:1.
 *
 * Uso seguro:
 *   # 1) Simulación (por defecto — cero cambios en BD/Auth):
 *   npm run provision:promotoras
 *
 *   # 2) Aplicación real (tras revisar resumen `--dry-run`):
 *   npm run provision:promotoras -- --apply
 *
 *   # Opcional: desactivar cambio obligatorio de contraseña en primer ingreso:
 *   npm run provision:promotoras -- --apply --must-change-password=false
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type ProvisionExecutionMode = 'dry-run' | 'apply';
export type OfficialErpRegionCode = 'OCCIDENTE' | 'CENTRO' | 'ANDES';
export type OfficialSucursalCode = 'ZULIA' | 'VALENCIA';

export interface RawPromotoraDbRow {
  id: number | string;
  nombre_completo: string;
  direccion?: string | null;
  telefono?: string | null;
  correo?: string | null;
  activo?: boolean | null;
  categoria?: string | null;
  auth_user_id?: string | null;
  region?: string | null;
  region_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProvisionEnvConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  initialPassword: string;
}

export interface ProvisionCliOptions {
  mode: ProvisionExecutionMode;
  mustChangePassword: boolean;
  delayMs: number;
}

export interface PromotoraIdentityPlanItem {
  promotoraId: string;
  rawId: number | string;
  nombreCompleto: string;
  regionLabel: string;
  erpRegionCode: OfficialErpRegionCode;
  sucursalCode: OfficialSucursalCode;
  regionId: string | null;
  activo: boolean;
  categoria: string;
  existingAuthUserId: string | null;
  originalCorreo: string | null;
  loginEmail: string;
  loginEmailSource: 'existing_email' | 'deterministic_fallback';
  fallbackReason: 'missing_email' | 'invalid_email' | 'duplicate_email_collision' | null;
  shouldPersistCorreoToDb: boolean;
}

export interface PromotoraIdentityPlanResult {
  plans: PromotoraIdentityPlanItem[];
  interregionalHomonyms: Array<{
    normalizedName: string;
    entries: Array<{ promotoraId: string; regionLabel: string; loginEmail: string }>;
  }>;
  regionCountsInput: Record<string, number>;
  regionCountsPlanned: Record<string, number>;
}

export interface RegionalProvisionStats {
  leidos: number;
  credencialesPlanificadas: number;
  activos: number;
  inactivos: number;
  authCrear: number;
  authActualizar: number;
  perfilesSincronizados: number;
  vinculosActualizados: number;
  fallbacksDeterministicos: number;
  errores: number;
}

export interface PromotoraProvisionSummary {
  mode: ProvisionExecutionMode;
  mustChangePassword: boolean;
  totalLeidos: number;
  totalPlanificados: number;
  paridad1a1Porcentaje: number;
  fusionesDetectadas: number;
  authCreados: number;
  authActualizados: number;
  profilesUpserted: number;
  promotorasVinculadas: number;
  fallbacksDeterministicos: number;
  homonimosInterregionales: number;
  porRegion: Record<string, RegionalProvisionStats>;
  conteoRegionAntes: Record<string, number>;
  conteoRegionDespues: Record<string, number>;
  conteoRegionInvariable: boolean;
  advertencias: string[];
  errores: Array<{ promotoraId: string; region: string; loginEmail: string; fase: 'validation' | 'auth' | 'profiles' | 'promotoras'; detalle: string }>;
}

const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_INITIAL_PASSWORD_LENGTH = 8;

function stripDiacritics(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeLoginEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function normalizeRegionSlug(region: string): string {
  const slug = stripDiacritics(region)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'sin-region';
}

export function buildDeterministicPromotoraLoginEmail(
  id: number | string,
  region: string
): string {
  const safeId = String(id).trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const regionSlug = normalizeRegionSlug(region);
  return `promotora.${regionSlug}.id${safeId}@promotoras.codizulca.local`;
}

export function resolveRegionRoutingMetadata(rawRegion: unknown): {
  regionLabel: string;
  erpRegionCode: OfficialErpRegionCode;
  sucursalCode: OfficialSucursalCode;
} {
  const cleaned = String(rawRegion ?? '').trim();
  const norm = stripDiacritics(cleaned).toUpperCase();

  if (norm === 'ANDES' || norm === 'REGION ANDES' || norm.includes('MERIDA') || norm.includes('TACHIRA') || norm.includes('BARINAS')) {
    return { regionLabel: cleaned || 'Andes', erpRegionCode: 'ANDES', sucursalCode: 'VALENCIA' };
  }
  if (
    norm === 'VALENCIA' ||
    norm === 'CENTRO' ||
    norm === 'REGION CENTRO' ||
    norm === 'CARABOBO' ||
    norm === 'ARAGUA' ||
    norm === 'MARACAY' ||
    norm === 'CARACAS' ||
    norm === 'CAPITAL'
  ) {
    return { regionLabel: cleaned || 'Valencia', erpRegionCode: 'CENTRO', sucursalCode: 'VALENCIA' };
  }
  return { regionLabel: cleaned || 'Occidente', erpRegionCode: 'OCCIDENTE', sucursalCode: 'ZULIA' };
}

/**
 * Valida las variables de entorno obligatorias sin imprimir ni retornar jamás secretos en mensajes de error.
 */
export function validateProvisionEnv(envSource: NodeJS.ProcessEnv = process.env): ProvisionEnvConfig {
  const supabaseUrl = String(envSource.SUPABASE_URL ?? envSource.VITE_SUPABASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const serviceRoleKey = String(envSource.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  const initialPassword = String(envSource.INITIAL_PROMOTORA_PASSWORD ?? '');

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!initialPassword.trim()) missing.push('INITIAL_PROMOTORA_PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `[ABORTADO] Faltan variables de entorno obligatorias: ${missing.join(', ')}. ` +
        'Define INITIAL_PROMOTORA_PASSWORD únicamente en tu entorno local/servidor (.env.local ignorado por Git) y nunca en código.'
    );
  }

  try {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Protocolo inválido');
    }
  } catch {
    throw new Error('[ABORTADO] SUPABASE_URL no tiene un formato de URL válido.');
  }

  if (initialPassword.trim().length < MIN_INITIAL_PASSWORD_LENGTH) {
    throw new Error(
      `[ABORTADO] INITIAL_PROMOTORA_PASSWORD debe tener al menos ${MIN_INITIAL_PASSWORD_LENGTH} caracteres.`
    );
  }

  return { supabaseUrl, serviceRoleKey, initialPassword };
}

export function parseProvisionCliArgs(
  argv: readonly string[],
  envSource: NodeJS.ProcessEnv = process.env
): ProvisionCliOptions {
  let mode: ProvisionExecutionMode = 'dry-run';
  let mustChangePassword =
    String(envSource.PROMOTORA_MUST_CHANGE_PASSWORD ?? 'true').trim().toLowerCase() !== 'false';
  let delayMs = 60;

  for (const arg of argv) {
    if (arg === '--apply') {
      mode = 'apply';
    } else if (arg === '--dry-run') {
      mode = 'dry-run';
    } else if (arg === '--must-change-password' || arg === '--must-change-password=true') {
      mustChangePassword = true;
    } else if (arg === '--no-must-change-password' || arg === '--must-change-password=false') {
      mustChangePassword = false;
    } else if (arg.startsWith('--delay-ms=')) {
      const parsed = Number(arg.slice('--delay-ms='.length));
      if (Number.isFinite(parsed) && parsed >= 0) delayMs = parsed;
    }
  }

  return { mode, mustChangePassword, delayMs };
}

/**
 * Planifica identidades estrictamente 1 a 1 por `public.promotoras.id` (CERO fusiones).
 * - Jamás agrupa por nombre ni deduplica homónimos entre regiones.
 * - Si falta correo, es inválido o está repetido entre dos filas, genera un identificador
 *   único determinístico basado en `(id, region)` preservando la región original intacta.
 */
export function planPromotoraIdentities1To1(
  rawRows: readonly RawPromotoraDbRow[],
  erpRegionIdByCode?: ReadonlyMap<OfficialErpRegionCode, string>
): PromotoraIdentityPlanResult {
  // Orden determinístico por PK `id` (numérico cuando aplica)
  const ordered = [...rawRows].sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });

  // 1) Conteo de frecuencia de correos válidos para detectar colisiones sin fusionar filas
  const validEmailCounts = new Map<string, number>();
  for (const row of ordered) {
    const email = normalizeLoginEmail(row.correo);
    if (email && STRICT_EMAIL_REGEX.test(email)) {
      validEmailCounts.set(email, (validEmailCounts.get(email) ?? 0) + 1);
    }
  }

  const seenAssignedEmails = new Set<string>();
  const plans: PromotoraIdentityPlanItem[] = [];
  const regionCountsInput: Record<string, number> = {};
  const regionCountsPlanned: Record<string, number> = {};
  const nameRegistry = new Map<
    string,
    Array<{ promotoraId: string; regionLabel: string; loginEmail: string }>
  >();

  for (const row of ordered) {
    const promotoraId = String(row.id ?? '').trim();
    if (!promotoraId) {
      throw new Error('Se encontró una fila en public.promotoras sin llave primaria `id`.');
    }

    const routing = resolveRegionRoutingMetadata(row.region);
    regionCountsInput[routing.regionLabel] = (regionCountsInput[routing.regionLabel] ?? 0) + 1;

    const rawEmail = normalizeLoginEmail(row.correo);
    let loginEmail: string;
    let loginEmailSource: 'existing_email' | 'deterministic_fallback' = 'existing_email';
    let fallbackReason: PromotoraIdentityPlanItem['fallbackReason'] = null;
    let shouldPersistCorreoToDb = false;

    if (!rawEmail) {
      loginEmail = buildDeterministicPromotoraLoginEmail(row.id, routing.regionLabel);
      loginEmailSource = 'deterministic_fallback';
      fallbackReason = 'missing_email';
      shouldPersistCorreoToDb = true;
    } else if (!STRICT_EMAIL_REGEX.test(rawEmail)) {
      loginEmail = buildDeterministicPromotoraLoginEmail(row.id, routing.regionLabel);
      loginEmailSource = 'deterministic_fallback';
      fallbackReason = 'invalid_email';
      shouldPersistCorreoToDb = false; // No sobrescribir dato corrupto sin confirmación; solo asignar login Auth
    } else if ((validEmailCounts.get(rawEmail) ?? 0) > 1 || seenAssignedEmails.has(rawEmail)) {
      // Primera ocurrencia ya vinculada (o todas las colisiones si ninguna estaba vinculada):
      // Para máxima seguridad anti-mezcla, toda fila con correo duplicado recibe un login único determinístico por (id, region)
      loginEmail = buildDeterministicPromotoraLoginEmail(row.id, routing.regionLabel);
      loginEmailSource = 'deterministic_fallback';
      fallbackReason = 'duplicate_email_collision';
      shouldPersistCorreoToDb = false;
    } else {
      loginEmail = rawEmail;
    }

    if (seenAssignedEmails.has(loginEmail)) {
      throw new Error(
        `Colisión inesperada de loginEmail "${loginEmail}" al planificar promotora id=${promotoraId}.`
      );
    }
    seenAssignedEmails.add(loginEmail);

    const resolvedRegionId =
      (row.region_id && String(row.region_id).trim()) ||
      erpRegionIdByCode?.get(routing.erpRegionCode) ||
      null;

    const item: PromotoraIdentityPlanItem = {
      promotoraId,
      rawId: row.id,
      nombreCompleto: String(row.nombre_completo ?? '').replace(/\s+/g, ' ').trim() || `Promotora #${promotoraId}`,
      regionLabel: routing.regionLabel,
      erpRegionCode: routing.erpRegionCode,
      sucursalCode: routing.sucursalCode,
      regionId: resolvedRegionId,
      activo: row.activo !== false,
      categoria: String(row.categoria ?? 'Fijas').trim() || 'Fijas',
      existingAuthUserId: row.auth_user_id ? String(row.auth_user_id).trim() : null,
      originalCorreo: rawEmail || null,
      loginEmail,
      loginEmailSource,
      fallbackReason,
      shouldPersistCorreoToDb,
    };

    plans.push(item);
    regionCountsPlanned[routing.regionLabel] = (regionCountsPlanned[routing.regionLabel] ?? 0) + 1;

    const normName = stripDiacritics(item.nombreCompleto).toUpperCase().replace(/\s+/g, ' ').trim();
    const list = nameRegistry.get(normName) ?? [];
    list.push({ promotoraId, regionLabel: routing.regionLabel, loginEmail });
    nameRegistry.set(normName, list);
  }

  const interregionalHomonyms: PromotoraIdentityPlanResult['interregionalHomonyms'] = [];
  for (const [normalizedName, entries] of nameRegistry.entries()) {
    if (entries.length > 1) {
      const distinctRegions = new Set(entries.map((e) => e.regionLabel.toUpperCase()));
      if (distinctRegions.size > 1) {
        interregionalHomonyms.push({ normalizedName, entries });
      }
    }
  }

  return {
    plans,
    interregionalHomonyms,
    regionCountsInput,
    regionCountsPlanned,
  };
}

interface AuthUserLite {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

async function listAllAuthUsersPaginated(client: SupabaseClient, perPage = 200) {
  const byEmail = new Map<string, AuthUserLite>();
  const byId = new Map<string, AuthUserLite>();

  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`No se pudo listar auth.users (página ${page}): ${error.message}`);
    }
    const users = Array.isArray(data?.users) ? (data.users as AuthUserLite[]) : [];
    for (const u of users) {
      if (u.id) byId.set(u.id, u);
      const email = normalizeLoginEmail(u.email);
      if (email && u.id) byEmail.set(email, u);
    }
    if (users.length < perPage) break;
  }

  return { byEmail, byId };
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
      throw new Error(`No se pudo consultar public.promotoras: ${error.message}`);
    }
    const page = Array.isArray(data) ? (data as RawPromotoraDbRow[]) : [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function resolveErpRegionsMap(
  client: SupabaseClient
): Promise<Map<OfficialErpRegionCode, string>> {
  const out = new Map<OfficialErpRegionCode, string>();
  try {
    const { data, error } = await client.from('Regiones').select('id_regi, regi_desd');
    if (error || !Array.isArray(data)) return out;
    for (const row of data as Array<Record<string, unknown>>) {
      const code = String(row.regi_desd ?? '').trim().toUpperCase();
      const id = String(row.id_regi ?? '').trim();
      if ((code === 'OCCIDENTE' || code === 'CENTRO' || code === 'ANDES') && id) {
        out.set(code, id);
      }
    }
  } catch {
    // Tabla opcional en entornos de prueba mínimos
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingMustChangePasswordColError(msg: string): boolean {
  return /must_change_password/i.test(msg) && /does not exist|Could not find/i.test(msg);
}

function ensureRegionStats(
  map: Record<string, RegionalProvisionStats>,
  region: string
): RegionalProvisionStats {
  if (!map[region]) {
    map[region] = {
      leidos: 0,
      credencialesPlanificadas: 0,
      activos: 0,
      inactivos: 0,
      authCrear: 0,
      authActualizar: 0,
      perfilesSincronizados: 0,
      vinculosActualizados: 0,
      fallbacksDeterministicos: 0,
      errores: 0,
    };
  }
  return map[region]!;
}

/**
 * Ejecuta el aprovisionamiento 1:1 (en modo `dry-run` por defecto o `apply`).
 * Garantiza 0 fusiones, idempotencia total y preservación exacta del conteo por región.
 */
export async function provisionPromotoras1To1(params: {
  client: SupabaseClient;
  initialPassword: string;
  mode?: ProvisionExecutionMode;
  mustChangePassword?: boolean;
  delayMs?: number;
}): Promise<PromotoraProvisionSummary> {
  const {
    client,
    initialPassword,
    mode = 'dry-run',
    mustChangePassword = true,
    delayMs = 60,
  } = params;

  if (!initialPassword || initialPassword.trim().length < MIN_INITIAL_PASSWORD_LENGTH) {
    throw new Error(
      `INITIAL_PROMOTORA_PASSWORD es obligatorio y debe tener al menos ${MIN_INITIAL_PASSWORD_LENGTH} caracteres.`
    );
  }

  const [rawRows, erpRegionIdByCode, authMaps] = await Promise.all([
    fetchAllPromotorasOrdered(client),
    resolveErpRegionsMap(client),
    listAllAuthUsersPaginated(client),
  ]);

  const planResult = planPromotoraIdentities1To1(rawRows, erpRegionIdByCode);

  const summary: PromotoraProvisionSummary = {
    mode,
    mustChangePassword,
    totalLeidos: rawRows.length,
    totalPlanificados: planResult.plans.length,
    paridad1a1Porcentaje:
      rawRows.length === 0 ? 100 : Math.round((planResult.plans.length / rawRows.length) * 10000) / 100,
    fusionesDetectadas: Math.max(0, rawRows.length - new Set(planResult.plans.map((p) => p.loginEmail)).size),
    authCreados: 0,
    authActualizados: 0,
    profilesUpserted: 0,
    promotorasVinculadas: 0,
    fallbacksDeterministicos: 0,
    homonimosInterregionales: planResult.interregionalHomonyms.length,
    porRegion: {},
    conteoRegionAntes: { ...planResult.regionCountsInput },
    conteoRegionDespues: { ...planResult.regionCountsPlanned },
    conteoRegionInvariable: true,
    advertencias: [],
    errores: [],
  };

  if (planResult.interregionalHomonyms.length > 0) {
    for (const h of planResult.interregionalHomonyms) {
      summary.advertencias.push(
        `Homónimo interregional preservado sin fusión (${h.normalizedName}): ${h.entries
          .map((e) => `id=${e.promotoraId} [${e.regionLabel}] -> ${e.loginEmail}`)
          .join(' | ')}`
      );
    }
  }

  // Mapa de auth_user_id ya reservados por otra promotora para impedir colisión 1:N
  const ownerPromotoraByAuthUid = new Map<string, string>();
  for (const row of rawRows) {
    if (row.auth_user_id) {
      ownerPromotoraByAuthUid.set(String(row.auth_user_id), String(row.id));
    }
  }

  let profilesSupportMustChangePassword = true;
  let warnedMissingMustChangeCol = false;

  for (const item of planResult.plans) {
    const regStats = ensureRegionStats(summary.porRegion, item.regionLabel);
    regStats.leidos += 1;
    regStats.credencialesPlanificadas += 1;
    if (item.activo) regStats.activos += 1;
    else regStats.inactivos += 1;

    if (item.loginEmailSource === 'deterministic_fallback') {
      summary.fallbacksDeterministicos += 1;
      regStats.fallbacksDeterministicos += 1;
      summary.advertencias.push(
        `Promotora id=${item.promotoraId} (${item.nombreCompleto}, ${item.regionLabel}) recibió login determinístico "${item.loginEmail}" (motivo: ${item.fallbackReason}).`
      );
    }

    // Resolver cuenta Auth existente para ESTE perfil 1:1 (sin robar cuenta ajena)
    let existingAuth: AuthUserLite | undefined;
    if (item.existingAuthUserId) {
      existingAuth = authMaps.byId.get(item.existingAuthUserId);
    }
    if (!existingAuth) {
      const candidateByEmail = authMaps.byEmail.get(item.loginEmail);
      if (candidateByEmail) {
        const existingOwnerPromotoraId = ownerPromotoraByAuthUid.get(candidateByEmail.id);
        const existingRole = String(
          candidateByEmail.app_metadata?.role ?? candidateByEmail.app_metadata?.app_role ?? ''
        )
          .trim()
          .toLowerCase();
        const existingMetaPromotoraId = String(candidateByEmail.app_metadata?.promotora_id ?? '').trim();

        const belongsToOtherPromotora =
          (existingOwnerPromotoraId && existingOwnerPromotoraId !== item.promotoraId) ||
          (existingMetaPromotoraId && existingMetaPromotoraId !== item.promotoraId);
        const belongsToNonPromotoraRole = Boolean(existingRole && existingRole !== 'promotora');

        if (belongsToOtherPromotora || belongsToNonPromotoraRole) {
          regStats.errores += 1;
          summary.errores.push({
            promotoraId: item.promotoraId,
            region: item.regionLabel,
            loginEmail: item.loginEmail,
            fase: 'validation',
            detalle: belongsToNonPromotoraRole
              ? `El correo "${item.loginEmail}" ya pertenece a un usuario Auth con rol "${existingRole}". Se aborta para impedir cruce de cuentas.`
              : `El correo "${item.loginEmail}" ya está vinculado a otra promotora (id=${existingOwnerPromotoraId || existingMetaPromotoraId}).`,
          });
          continue;
        }
        existingAuth = candidateByEmail;
      }
    }

    if (mode === 'dry-run') {
      if (existingAuth) {
        summary.authActualizados += 1;
        regStats.authActualizar += 1;
      } else {
        summary.authCreados += 1;
        regStats.authCrear += 1;
      }
      summary.profilesUpserted += 1;
      regStats.perfilesSincronizados += 1;
      if (!item.existingAuthUserId || item.shouldPersistCorreoToDb) {
        summary.promotorasVinculadas += 1;
        regStats.vinculosActualizados += 1;
      }
      continue;
    }

    // === MODO APPLY: ESCRITURA 1:1 IDEMPOTENTE ===
    const nextAppMetadata: Record<string, unknown> = {
      ...(existingAuth?.app_metadata ?? {}),
      role: 'promotora',
      app_role: 'promotora',
      promotora_id: item.promotoraId,
      region: item.erpRegionCode,
      region_label: item.regionLabel,
      regions: [item.erpRegionCode],
      sucursal: item.sucursalCode,
      ...(item.regionId ? { region_id: item.regionId } : {}),
      must_change_password: mustChangePassword,
    };

    const nextUserMetadata: Record<string, unknown> = {
      ...(existingAuth?.user_metadata ?? {}),
      nombre_completo: item.nombreCompleto,
      region: item.regionLabel,
      promotora_id: item.promotoraId,
      must_change_password: mustChangePassword,
    };

    let authUserId: string;
    try {
      if (existingAuth) {
        const { data: updated, error: updateErr } = await client.auth.admin.updateUserById(
          existingAuth.id,
          {
            email: item.loginEmail,
            password: initialPassword,
            email_confirm: true,
            app_metadata: nextAppMetadata,
            user_metadata: nextUserMetadata,
          }
        );
        if (updateErr || !updated?.user?.id) {
          throw new Error(updateErr?.message || 'Respuesta vacía al actualizar usuario Auth.');
        }
        authUserId = updated.user.id;
        summary.authActualizados += 1;
        regStats.authActualizar += 1;
      } else {
        const { data: created, error: createErr } = await client.auth.admin.createUser({
          email: item.loginEmail,
          password: initialPassword,
          email_confirm: true,
          app_metadata: nextAppMetadata,
          user_metadata: nextUserMetadata,
        });
        if (createErr || !created?.user?.id) {
          throw new Error(createErr?.message || 'Respuesta vacía al crear usuario Auth.');
        }
        authUserId = created.user.id;
        summary.authCreados += 1;
        regStats.authCrear += 1;
      }

      authMaps.byId.set(authUserId, {
        id: authUserId,
        email: item.loginEmail,
        app_metadata: nextAppMetadata,
        user_metadata: nextUserMetadata,
      });
      authMaps.byEmail.set(item.loginEmail, authMaps.byId.get(authUserId)!);
      ownerPromotoraByAuthUid.set(authUserId, item.promotoraId);
    } catch (err) {
      regStats.errores += 1;
      summary.errores.push({
        promotoraId: item.promotoraId,
        region: item.regionLabel,
        loginEmail: item.loginEmail,
        fase: 'auth',
        detalle: err instanceof Error ? err.message : 'Error aprovisionando cuenta Auth.',
      });
      await sleep(delayMs);
      continue;
    }

    // 2) Upsert 1:1 en `public.profiles` (autorización RLS y estado activo)
    try {
      const baseProfilePayload: Record<string, unknown> = {
        id: authUserId,
        email: item.loginEmail,
        full_name: item.nombreCompleto,
        role: 'promotora',
        sucursal: item.sucursalCode,
        region: item.regionLabel,
        regiones_asignadas: [item.erpRegionCode],
        ...(item.regionId ? { region_id: item.regionId } : {}),
        is_active: item.activo,
        updated_at: new Date().toISOString(),
      };

      const fullProfilePayload = profilesSupportMustChangePassword
        ? { ...baseProfilePayload, must_change_password: mustChangePassword }
        : baseProfilePayload;

      let { error: profErr } = await client
        .from('profiles')
        .upsert(fullProfilePayload, { onConflict: 'id' });

      if (profErr && profilesSupportMustChangePassword && isMissingMustChangePasswordColError(profErr.message)) {
        profilesSupportMustChangePassword = false;
        if (!warnedMissingMustChangeCol) {
          warnedMissingMustChangeCol = true;
          summary.advertencias.push(
            'La columna `public.profiles.must_change_password` aún no existe en BD. Ejecuta la migración `sql/promotoras_auth_1a1_aislamiento_estricto.sql` para persistirla en profiles (se guardó mientras tanto en `app_metadata`).'
          );
        }
        const retry = await client
          .from('profiles')
          .upsert(baseProfilePayload, { onConflict: 'id' });
        profErr = retry.error;
      }

      if (profErr) {
        throw new Error(profErr.message);
      }

      summary.profilesUpserted += 1;
      regStats.perfilesSincronizados += 1;
    } catch (err) {
      regStats.errores += 1;
      summary.errores.push({
        promotoraId: item.promotoraId,
        region: item.regionLabel,
        loginEmail: item.loginEmail,
        fase: 'profiles',
        detalle: err instanceof Error ? err.message : 'Error sincronizando public.profiles.',
      });
      await sleep(delayMs);
      continue;
    }

    // 3) Vincular `auth_user_id` estrictamente por PK `id` en `public.promotoras` (SIN tocar region/categoria/activo)
    try {
      const needsLinkUpdate = item.existingAuthUserId !== authUserId || item.shouldPersistCorreoToDb;
      if (needsLinkUpdate) {
        const patchPayload: Record<string, unknown> = {
          auth_user_id: authUserId,
          updated_at: new Date().toISOString(),
          ...(item.shouldPersistCorreoToDb ? { correo: item.loginEmail } : {}),
        };
        const { error: linkErr } = await client
          .from('promotoras')
          .update(patchPayload)
          .eq('id', item.rawId);
        if (linkErr) {
          throw new Error(linkErr.message);
        }
        summary.promotorasVinculadas += 1;
        regStats.vinculosActualizados += 1;
      }
    } catch (err) {
      regStats.errores += 1;
      summary.errores.push({
        promotoraId: item.promotoraId,
        region: item.regionLabel,
        loginEmail: item.loginEmail,
        fase: 'promotoras',
        detalle: err instanceof Error ? err.message : 'Error vinculando auth_user_id en public.promotoras.',
      });
    }

    await sleep(delayMs);
  }

  // Verificación post-apply de invariancia de conteos por región
  if (mode === 'apply') {
    const postRows = await fetchAllPromotorasOrdered(client);
    const postCounts: Record<string, number> = {};
    for (const r of postRows) {
      const label = resolveRegionRoutingMetadata(r.region).regionLabel;
      postCounts[label] = (postCounts[label] ?? 0) + 1;
    }
    summary.conteoRegionDespues = postCounts;
    const allKeys = new Set([
      ...Object.keys(summary.conteoRegionAntes),
      ...Object.keys(summary.conteoRegionDespues),
    ]);
    summary.conteoRegionInvariable = [...allKeys].every(
      (k) => (summary.conteoRegionAntes[k] ?? 0) === (summary.conteoRegionDespues[k] ?? 0)
    );
  }

  return summary;
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

  const cli = parseProvisionCliArgs(process.argv.slice(2), process.env);
  const env = validateProvisionEnv(process.env);

  const adminClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  console.log('======================================================================');
  console.log(
    cli.mode === 'dry-run'
      ? '  SIMULACIÓN (--dry-run) · APROVISIONAMIENTO 1:1 DE PROMOTORAS'
      : '  APLICACIÓN REAL (--apply) · APROVISIONAMIENTO 1:1 DE PROMOTORAS'
  );
  console.log('======================================================================');
  console.log(`Destino Supabase     : ${new URL(env.supabaseUrl).hostname}`);
  console.log(`Modo                 : ${cli.mode}`);
  console.log(`must_change_password : ${cli.mustChangePassword}`);
  console.log('Contraseña inicial   : [PROTEGIDA — leída desde INITIAL_PROMOTORA_PASSWORD]');

  const summary = await provisionPromotoras1To1({
    client: adminClient,
    initialPassword: env.initialPassword,
    mode: cli.mode,
    mustChangePassword: cli.mustChangePassword,
    delayMs: cli.delayMs,
  });

  console.log('\n--- RESUMEN POR REGIÓN (PARIDAD 1:1, CERO FUSIONES) ---');
  console.table(summary.porRegion);

  console.log('\n--- TOTALES GLOBALES ---');
  console.log(`Perfiles leídos             : ${summary.totalLeidos}`);
  console.log(`Credenciales planificadas   : ${summary.totalPlanificados}`);
  console.log(`Paridad 1:1                 : ${summary.paridad1a1Porcentaje}%`);
  console.log(`Fusiones detectadas         : ${summary.fusionesDetectadas}`);
  console.log(`Auth a crear / creados      : ${summary.authCreados}`);
  console.log(`Auth a actualizar / actual. : ${summary.authActualizados}`);
  console.log(`Profiles sincronizados      : ${summary.profilesUpserted}`);
  console.log(`Vínculos auth_user_id       : ${summary.promotorasVinculadas}`);
  console.log(`Fallbacks determinísticos   : ${summary.fallbacksDeterministicos}`);
  console.log(`Homónimos interregionales   : ${summary.homonimosInterregionales}`);
  console.log(`Conteo regional invariable  : ${summary.conteoRegionInvariable}`);
  console.log(`Errores                     : ${summary.errores.length}`);

  if (summary.advertencias.length > 0) {
    console.log('\n--- ADVERTENCIAS ---');
    for (const w of summary.advertencias) {
      console.warn(`- ${w}`);
    }
  }

  if (summary.errores.length > 0) {
    console.log('\n--- ERRORES ---');
    for (const e of summary.errores) {
      console.error(`- [${e.fase}] id=${e.promotoraId} (${e.region}) ${e.loginEmail}: ${e.detalle}`);
    }
    process.exitCode = 1;
  }

  if (cli.mode === 'dry-run') {
    console.log('\n[DRY-RUN] No se escribió ningún cambio en Auth ni en PostgreSQL.');
    console.log('Para aplicar los cambios reales, ejecuta: npm run provision:promotoras -- --apply');
  }
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runCli().catch((err) => {
    console.error(`[ERROR] ${err instanceof Error ? err.message : 'Fallo inesperado.'}`);
    process.exit(1);
  });
}
