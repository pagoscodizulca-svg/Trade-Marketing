/**
 * Certificador de Esquema de Producción — SOLO LECTURA (Hito 2 / B-04).
 *
 * REGLAS ESTRICTAS DE SEGURIDAD:
 *  - JAMÁS abre ni lee archivos `.env`, `.env.*`, `src/config/env.js` ni `qa-sync-suite/.env.test`.
 *  - Toma variables EXCLUSIVAMENTE del entorno ya exportado en la terminal (`process.env`).
 *  - Se niega a ejecutarse (código de salida 2) si detecta una llave secreta (`sb_secret_*` o JWT
 *    `service_role`) en cualquier variable con prefijo `VITE_*`.
 *  - Redacta cualquier token o llave antes de escribir en stdout/stderr.
 *  - No ejecuta migraciones ni DML/DDL contra la base remota: únicamente consulta el analizador
 *    estático local (`--mode static`) y/o la RPC de solo lectura sobre `pg_catalog`
 *    `public.rpc_certificar_esquema_trade()` (`--mode remote`).
 *
 * Uso:
 *   npx tsx scripts/certifySchemaProduction.ts --mode static
 *   npx tsx scripts/certifySchemaProduction.ts --mode remote
 *   npx tsx scripts/certifySchemaProduction.ts --mode all
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  analyzeMigrations,
  formatIssues,
  type MigrationFile,
} from '../tests/support/sqlMigrationAnalyzer';

export type CertifierMode = 'static' | 'remote' | 'all';

export const EXPECTED_SUCURSAL_ENUM_LABELS = [
  'ZULIA',
  'VALENCIA',
  'CENTRO',
  'ORIENTE',
  'CAPITAL',
  'GLOBAL',
] as const;

export const EXPECTED_ACTIVE_REGIONAL_HUBS = [
  'ZULIA',
  'VALENCIA',
  'CENTRO',
  'ORIENTE',
  'CAPITAL',
] as const;

export const CRITICAL_SCHEMA_TABLES = [
  'regiones',
  'profiles',
  'clientes',
  'vendedores',
  'promotoras',
  'reportes_trade',
  'staff',
  'surveys',
  'cronograma_degustaciones',
  'rutas_promotoras',
  'asistencias_jornada',
  'asistencia_evidencias',
  'solicitudes_contraloria',
  'entregas_degustacion',
] as const;

export const REQUIRED_SCHEMA_FUNCTIONS = [
  'obtener_mi_correo_jwt',
  'obtener_mi_rol',
  'obtener_mi_sucursal',
  'obtener_mi_region_id',
  'obtener_sucursal_contexto_activo',
  'fn_resolver_region_id',
  'tiene_acceso_sucursal',
  'tiene_acceso_region',
  'is_super_admin',
  'is_coordinadora_or_admin',
  'is_torre_control_viewer',
  'is_chofer_or_logistics_ops',
  'fn_sellar_y_proteger_sucursal_operativa',
  'fn_surveys_sellar_autor',
  'fn_surveys_normalizar_degustacion_key',
  'rpc_listar_regiones_activas',
  'rpc_listar_personal_sucursal',
  'rpc_comparativo_regiones_resumen',
  'rpc_certificar_esquema_trade',
] as const;

export interface CertificationCheck {
  id: string;
  passed: boolean;
  severity: 'error' | 'warning';
  detail: string;
}

export interface StaticCertificationReport {
  mode: 'static';
  passed: boolean;
  migrationCount: number;
  checks: CertificationCheck[];
  duplicateVersionWarnings: string[];
}

export interface RemoteCatalogTableEntry {
  table_name: string;
  exists: boolean;
  rls_enabled: boolean;
  force_rls: boolean;
  has_sucursal_column: boolean;
  has_region_id_column?: boolean;
  sucursal_type: string | null;
  policy_count: number;
  anon_policy_count: number;
  unfiltered_legacy_policies: string[];
}

export interface RemoteRegionesCatalogSummary {
  exists?: boolean;
  has_codigo_column?: boolean;
  has_nombre_column?: boolean;
  has_activo_column?: boolean;
  active_hubs?: string[];
}

export interface RemoteCatalogPayload {
  certified_at?: string;
  schema?: string;
  sucursal_codigo_enum?: string[];
  regiones_catalog?: RemoteRegionesCatalogSummary;
  tables?: RemoteCatalogTableEntry[];
  legacy_tables?: {
    perfiles_acceso_exists?: boolean;
    perfiles_acceso_deprecado_exists?: boolean;
  };
  functions?: Record<string, boolean>;
  indexes?: Record<string, boolean>;
  surveys_columns?: Record<string, boolean>;
  anon_table_grants?: Array<{
    table_name: string;
    select?: boolean;
    insert?: boolean;
    update?: boolean;
    delete?: boolean;
  }>;
}

export interface RemoteCertificationReport {
  mode: 'remote';
  passed: boolean;
  targetHost: string;
  checks: CertificationCheck[];
}

export class SecurityEnvViolationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SecurityEnvViolationError';
    this.code = code;
  }
}

/**
 * Redacta JWTs y llaves Supabase antes de emitir cualquier salida por consola o error.
 */
export function redactSecrets(input: unknown): string {
  return String(input ?? '')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/gi, '[REDACTED_SB_SECRET]')
    .replace(/sb_publishable_[A-Za-z0-9_-]+/gi, '[REDACTED_SB_PUBLISHABLE]');
}

function decodeJwtRole(token: string): string | null {
  const trimmed = String(token || '').trim();
  if (!trimmed.startsWith('eyJ')) return null;
  const parts = trimmed.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    return typeof payload.role === 'string' ? payload.role.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Inspecciona el entorno de terminal y ABORTA si alguna variable `VITE_*` expone una llave secreta.
 */
export function assertSafeEnvironment(
  env: Record<string, string | undefined>
): void {
  for (const [key, rawVal] of Object.entries(env)) {
    if (!key.startsWith('VITE_')) continue;
    const val = String(rawVal ?? '').trim();
    if (!val) continue;

    if (/^sb_secret_/i.test(val)) {
      throw new SecurityEnvViolationError(
        'SECRET_IN_VITE_ENV',
        `BLOQUEO DE SEGURIDAD: la variable pública "${key}" contiene una llave secreta (sb_secret_*). Remuévala del prefijo VITE_ antes de continuar.`
      );
    }

    const jwtRole = decodeJwtRole(val);
    if (jwtRole === 'service_role') {
      throw new SecurityEnvViolationError(
        'SERVICE_ROLE_JWT_IN_VITE_ENV',
        `BLOQUEO DE SEGURIDAD: la variable pública "${key}" contiene un JWT con rol service_role. Jamás exponga service_role bajo prefijo VITE_.`
      );
    }

    if (/SERVICE_ROLE|SECRET_KEY/i.test(key) && !/placeholder|example|pega_aqui/i.test(val)) {
      throw new SecurityEnvViolationError(
        'FORBIDDEN_VITE_SECRET_NAME',
        `BLOQUEO DE SEGURIDAD: variable prohibida "${key}" presente en el entorno. Las llaves de servidor no pueden llevar prefijo VITE_.`
      );
    }
  }
}

function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(migrationsDir, name), 'utf8'),
    }));
}

/**
 * Modo ESTÁTICO: certifica toda la cadena `supabase/migrations/*.sql` mediante el analizador estático.
 */
export function runStaticCertification(
  migrationsDir: string = path.join(process.cwd(), 'supabase', 'migrations')
): StaticCertificationReport {
  const files = loadMigrationFiles(migrationsDir);
  const analysis = analyzeMigrations(files);
  const checks: CertificationCheck[] = [];

  checks.push({
    id: 'static.zero_errors',
    passed: analysis.errors.length === 0,
    severity: 'error',
    detail:
      analysis.errors.length === 0
        ? `0 errores en ${files.length} migraciones SQL.`
        : `Se detectaron ${analysis.errors.length} error(es):\n${formatIssues(analysis.errors)}`,
  });

  const destructive = analysis.issues.filter((i) => i.code.startsWith('DESTRUCTIVE_'));
  checks.push({
    id: 'static.no_destructive_ddl',
    passed: destructive.length === 0,
    severity: 'error',
    detail:
      destructive.length === 0
        ? 'Sin comandos destructivos prohibidos en ninguna migración.'
        : `Comandos destructivos detectados: ${formatIssues(destructive)}`,
  });

  const staticEnumSet = analysis.enumValues.get('sucursal_codigo') ?? new Set<string>();
  const missingEnumLabels = EXPECTED_SUCURSAL_ENUM_LABELS.filter(
    (lbl) => !staticEnumSet.has(lbl)
  );
  const staticEnumOk =
    analysis.types.has('sucursal_codigo') && missingEnumLabels.length === 0;
  checks.push({
    id: 'static.sucursal_enum',
    passed: staticEnumOk,
    severity: 'error',
    detail: staticEnumOk
      ? `Tipo ENUM public.sucursal_codigo presente con las 6 etiquetas (${EXPECTED_SUCURSAL_ENUM_LABELS.join(', ')}).`
      : `Tipo ENUM public.sucursal_codigo ausente o incompleto (faltan: ${missingEnumLabels.join(', ') || 'DEFINICIÓN'}).`,
  });

  const missingTables: string[] = [];
  const missingSucursal: string[] = [];
  for (const tbl of CRITICAL_SCHEMA_TABLES) {
    const cols = analysis.tables.get(tbl);
    if (!cols) {
      missingTables.push(tbl);
      continue;
    }
    if (tbl === 'regiones') {
      if (!cols.has('codigo') || !cols.has('nombre') || !cols.has('activo')) {
        missingSucursal.push('regiones(codigo/nombre/activo)');
      }
      continue;
    }
    if (!cols.has('sucursal') || !cols.has('region_id')) {
      missingSucursal.push(
        `${tbl}(sucursal=${cols.has('sucursal')},region_id=${cols.has('region_id')})`
      );
    }
  }

  checks.push({
    id: 'static.critical_tables',
    passed: missingTables.length === 0,
    severity: 'error',
    detail:
      missingTables.length === 0
        ? `Las ${CRITICAL_SCHEMA_TABLES.length} tablas críticas existen en el esquema resultante.`
        : `Tablas faltantes: ${missingTables.join(', ')}`,
  });

  checks.push({
    id: 'static.sucursal_columns',
    passed: missingSucursal.length === 0,
    severity: 'error',
    detail:
      missingSucursal.length === 0
        ? 'Catálogo regiones (codigo/nombre/activo) y columnas sucursal + region_id presentes en todas las tablas críticas.'
        : `Columnas regionales faltantes: ${missingSucursal.join(', ')}`,
  });

  const surveysCols = analysis.tables.get('surveys');
  const requiredSurveyCols = ['autor_user_id', 'sucursal', 'region_id', 'degustacion_key'];
  const missingSurveyCols = requiredSurveyCols.filter((c) => !surveysCols?.has(c));
  checks.push({
    id: 'static.surveys_audit_and_idempotency',
    passed: missingSurveyCols.length === 0,
    severity: 'error',
    detail:
      missingSurveyCols.length === 0
        ? 'public.surveys posee autor_user_id, sucursal, region_id y degustacion_key.'
        : `Columnas faltantes en public.surveys: ${missingSurveyCols.join(', ')}`,
  });

  const cadenasCols = analysis.tables.get('cadenas_comerciales');
  const requiredCadenaLogoCols = [
    'sucursal',
    'region_id',
    'logo_storage_path',
    'logo_mime_type',
    'logo_updated_at',
    'logo_updated_by',
  ];
  const missingCadenaLogoCols = requiredCadenaLogoCols.filter((c) => !cadenasCols?.has(c));
  checks.push({
    id: 'static.cadenas_cobranding_columns',
    passed: missingCadenaLogoCols.length === 0,
    severity: 'error',
    detail:
      missingCadenaLogoCols.length === 0
        ? 'public.cadenas_comerciales posee metadatos idempotentes de Co-Branding (logo_storage_path, logo_mime_type, logo_updated_at, logo_updated_by).'
        : `Columnas faltantes en public.cadenas_comerciales: ${missingCadenaLogoCols.join(', ')}`,
  });

  const legacyDeprecatedOk =
    !analysis.tables.has('perfiles_acceso') &&
    analysis.tables.has('perfiles_acceso_deprecado_hito1');
  checks.push({
    id: 'static.perfiles_acceso_deprecated',
    passed: legacyDeprecatedOk,
    severity: 'error',
    detail: legacyDeprecatedOk
      ? 'public.perfiles_acceso deprecada de forma no destructiva (perfiles_acceso_deprecado_hito1).'
      : 'public.perfiles_acceso sigue activa o no fue renombrada a perfiles_acceso_deprecado_hito1.',
  });

  const missingFns = REQUIRED_SCHEMA_FUNCTIONS.filter(
    (fn) => !analysis.functions.has(`public.${fn}`)
  );
  checks.push({
    id: 'static.required_functions',
    passed: missingFns.length === 0,
    severity: 'error',
    detail:
      missingFns.length === 0
        ? `Las ${REQUIRED_SCHEMA_FUNCTIONS.length} funciones/RPCs críticas están definidas.`
        : `Funciones faltantes: ${missingFns.join(', ')}`,
  });

  const leakedLegacyPolicies: string[] = [];
  for (const [tbl, pols] of analysis.policies.entries()) {
    for (const pol of pols) {
      if (/^(rbac_coordinadora_ops_|rbac_super_admin_all_)/.test(pol)) {
        leakedLegacyPolicies.push(`${tbl}.${pol}`);
      }
    }
  }
  checks.push({
    id: 'static.no_unfiltered_legacy_policies',
    passed: leakedLegacyPolicies.length === 0,
    severity: 'error',
    detail:
      leakedLegacyPolicies.length === 0
        ? 'Cero políticas legacy sin filtro de sucursal (rbac_coordinadora_ops_* / rbac_super_admin_all_*).'
        : `Políticas legacy activas detectadas: ${leakedLegacyPolicies.join(', ')}`,
  });

  const duplicateVersionIssues = analysis.issues
    .filter((i) => i.code === 'DUPLICATE_VERSION')
    .map((i) => `${i.file}: ${i.message}`);

  checks.push({
    id: 'static.unique_migration_versions',
    passed: duplicateVersionIssues.length === 0,
    severity: 'error',
    detail:
      duplicateVersionIssues.length === 0
        ? '0 versiones de migración duplicadas; todas las marcas son únicas para Supabase CLI.'
        : `Versiones de migración duplicadas detectadas (${duplicateVersionIssues.length}): ${duplicateVersionIssues.join(' | ')}`,
  });

  const duplicateVersionWarnings = analysis.warnings
    .filter((w) => w.code === 'DUPLICATE_VERSION')
    .map((w) => `${w.file}: ${w.message}`);

  const passed = checks.every((c) => c.severity === 'warning' || c.passed);

  return {
    mode: 'static',
    passed,
    migrationCount: files.length,
    checks,
    duplicateVersionWarnings,
  };
}

/**
 * Evalúa la respuesta JSONB de `public.rpc_certificar_esquema_trade()` (solo lectura sobre `pg_catalog`).
 */
export function evaluateRemoteCatalogReport(
  payload: RemoteCatalogPayload,
  targetHost: string
): RemoteCertificationReport {
  const checks: CertificationCheck[] = [];

  const enumLabels = Array.isArray(payload.sucursal_codigo_enum)
    ? payload.sucursal_codigo_enum
    : [];
  const missingRemoteEnumLabels = EXPECTED_SUCURSAL_ENUM_LABELS.filter(
    (lbl) => !enumLabels.includes(lbl)
  );
  const enumOk = missingRemoteEnumLabels.length === 0;
  checks.push({
    id: 'remote.sucursal_enum',
    passed: enumOk,
    severity: 'error',
    detail: enumOk
      ? `ENUM public.sucursal_codigo verificado con 6 etiquetas (${enumLabels.join(', ')}).`
      : `ENUM public.sucursal_codigo incompleto o ausente (${enumLabels.join(', ') || 'vacío'}; faltan: ${missingRemoteEnumLabels.join(', ')}).`,
  });

  const regCat = payload.regiones_catalog;
  const activeHubs = Array.isArray(regCat?.active_hubs)
    ? regCat!.active_hubs!.map((h) => String(h).toUpperCase())
    : [];
  const missingHubs = EXPECTED_ACTIVE_REGIONAL_HUBS.filter(
    (hub) => !activeHubs.includes(hub)
  );
  const regionesCatalogOk =
    regCat?.exists === true &&
    regCat?.has_codigo_column === true &&
    regCat?.has_nombre_column === true &&
    regCat?.has_activo_column === true &&
    missingHubs.length === 0;

  checks.push({
    id: 'remote.regiones_five_hubs',
    passed: regionesCatalogOk,
    severity: 'error',
    detail: regionesCatalogOk
      ? `Catálogo public.regiones activo con los 5 hubs (${EXPECTED_ACTIVE_REGIONAL_HUBS.join(', ')}).`
      : `Catálogo public.regiones incompleto (faltan hubs activos: ${missingHubs.join(', ') || 'catálogo no verificado'}).`,
  });

  const tableMap = new Map<string, RemoteCatalogTableEntry>();
  for (const t of payload.tables ?? []) {
    tableMap.set(t.table_name, t);
  }

  const missingOrUnprotected: string[] = [];
  const missingSucursal: string[] = [];
  const anonPoliciesFound: string[] = [];
  const legacyPoliciesFound: string[] = [];

  for (const tbl of CRITICAL_SCHEMA_TABLES) {
    const entry = tableMap.get(tbl);
    if (!entry || !entry.exists) {
      missingOrUnprotected.push(`${tbl}(NO_EXISTE)`);
      continue;
    }
    if (!entry.rls_enabled || !entry.force_rls || entry.policy_count <= 0) {
      missingOrUnprotected.push(
        `${tbl}(rls=${entry.rls_enabled},force=${entry.force_rls},pols=${entry.policy_count})`
      );
    }
    if (tbl === 'regiones') {
      if (regCat && (!regCat.has_codigo_column || !regCat.has_nombre_column)) {
        missingSucursal.push('regiones(codigo/nombre)');
      }
    } else {
      const cleanType = String(entry.sucursal_type || '').replace(/^public\./, '');
      if (
        !entry.has_sucursal_column ||
        cleanType !== 'sucursal_codigo' ||
        entry.has_region_id_column === false
      ) {
        missingSucursal.push(
          `${tbl}(tipo=${entry.sucursal_type ?? 'NULL'},region_id=${entry.has_region_id_column ?? 'N/A'})`
        );
      }
    }
    if (entry.anon_policy_count > 0) {
      anonPoliciesFound.push(`${tbl}(${entry.anon_policy_count})`);
    }
    if (Array.isArray(entry.unfiltered_legacy_policies) && entry.unfiltered_legacy_policies.length > 0) {
      legacyPoliciesFound.push(`${tbl}:[${entry.unfiltered_legacy_policies.join(',')}]`);
    }
  }

  checks.push({
    id: 'remote.tables_rls_and_force_rls',
    passed: missingOrUnprotected.length === 0,
    severity: 'error',
    detail:
      missingOrUnprotected.length === 0
        ? `Todas las ${CRITICAL_SCHEMA_TABLES.length} tablas críticas existen con RLS y FORCE RLS activos.`
        : `Tablas faltantes o sin RLS/FORCE RLS: ${missingOrUnprotected.join(', ')}`,
  });

  checks.push({
    id: 'remote.tables_sucursal_column',
    passed: missingSucursal.length === 0,
    severity: 'error',
    detail:
      missingSucursal.length === 0
        ? 'Columna sucursal (public.sucursal_codigo) verificada en todas las tablas críticas.'
        : `Tablas sin sucursal_codigo: ${missingSucursal.join(', ')}`,
  });

  checks.push({
    id: 'remote.zero_anon_policies',
    passed: anonPoliciesFound.length === 0,
    severity: 'error',
    detail:
      anonPoliciesFound.length === 0
        ? '0 políticas RLS otorgadas al rol anon.'
        : `Políticas RLS abiertas a anon: ${anonPoliciesFound.join(', ')}`,
  });

  const anonGrants = Array.isArray(payload.anon_table_grants) ? payload.anon_table_grants : [];
  checks.push({
    id: 'remote.zero_anon_table_grants',
    passed: anonGrants.length === 0,
    severity: 'error',
    detail:
      anonGrants.length === 0
        ? '0 privilegios de tabla otorgados al rol anon.'
        : `Tablas con GRANT activo para anon: ${anonGrants.map((g) => g.table_name).join(', ')}`,
  });

  checks.push({
    id: 'remote.no_unfiltered_legacy_policies',
    passed: legacyPoliciesFound.length === 0,
    severity: 'error',
    detail:
      legacyPoliciesFound.length === 0
        ? '0 políticas legacy sin aislamiento de sucursal.'
        : `Políticas legacy activas en remoto: ${legacyPoliciesFound.join('; ')}`,
  });

  const perfilesDeprecatedOk = payload.legacy_tables?.perfiles_acceso_exists === false;
  checks.push({
    id: 'remote.perfiles_acceso_deprecated',
    passed: perfilesDeprecatedOk,
    severity: 'error',
    detail: perfilesDeprecatedOk
      ? 'public.perfiles_acceso ya no está activa como tabla paralela.'
      : 'public.perfiles_acceso sigue activa en el esquema remoto.',
  });

  const fnMap = payload.functions ?? {};
  const missingFns = REQUIRED_SCHEMA_FUNCTIONS.filter((fn) => fnMap[fn] !== true);
  const legacyVincularPresent = fnMap.vincular_mi_usuario_auth === true;
  checks.push({
    id: 'remote.required_functions',
    passed: missingFns.length === 0 && !legacyVincularPresent,
    severity: 'error',
    detail:
      missingFns.length === 0 && !legacyVincularPresent
        ? `Todas las ${REQUIRED_SCHEMA_FUNCTIONS.length} funciones críticas presentes y vincular_mi_usuario_auth eliminada.`
        : `Faltantes=[${missingFns.join(', ')}] | vincular_mi_usuario_auth_activa=${legacyVincularPresent}`,
  });

  const idxMap = payload.indexes ?? {};
  const requiredIdx = [
    'uq_surveys_degustacion_key_active',
    'idx_surveys_autor_user_id',
    'idx_clientes_vendedor_id',
    'idx_clientes_codigo_vendedor',
  ];
  const missingIdx = requiredIdx.filter((idx) => idxMap[idx] !== true);
  checks.push({
    id: 'remote.required_indexes',
    passed: missingIdx.length === 0,
    severity: 'error',
    detail:
      missingIdx.length === 0
        ? 'Índices de idempotencia (uq_surveys_degustacion_key_active), autoría y maestros presentes.'
        : `Índices faltantes: ${missingIdx.join(', ')}`,
  });

  const sCols = payload.surveys_columns ?? {};
  const missingSCols = ['autor_user_id', 'sucursal', 'degustacion_key'].filter(
    (c) => sCols[c] !== true
  );
  checks.push({
    id: 'remote.surveys_columns',
    passed: missingSCols.length === 0,
    severity: 'error',
    detail:
      missingSCols.length === 0
        ? 'Columnas autor_user_id, sucursal y degustacion_key verificadas en public.surveys.'
        : `Columnas faltantes en public.surveys: ${missingSCols.join(', ')}`,
  });

  return {
    mode: 'remote',
    passed: checks.every((c) => c.severity === 'warning' || c.passed),
    targetHost,
    checks,
  };
}

/**
 * Modo REMOTO (SOLO LECTURA): lee credenciales ÚNICAMENTE de variables ya exportadas en terminal
 * (jamás abre archivos `.env` ni usa variables `VITE_*`) e invoca `rpc_certificar_esquema_trade()`.
 */
export async function runRemoteCertification(
  env: Record<string, string | undefined>,
  options: { fetchImpl?: typeof fetch; allowLocalhostForTest?: boolean } = {}
): Promise<RemoteCertificationReport> {
  assertSafeEnvironment(env);

  const rawUrl = String(env.SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1\/?$/i, '');

  if (!rawUrl) {
    throw new SecurityEnvViolationError(
      'MISSING_SUPABASE_URL',
      'Falta exportar SUPABASE_URL en la terminal (este certificador nunca lee archivos .env ni variables VITE_*).'
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new SecurityEnvViolationError('INVALID_SUPABASE_URL', 'SUPABASE_URL no es una URL válida.');
  }

  const isLocalHost =
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '[::1]';

  if (
    parsedUrl.protocol !== 'https:' &&
    !(options.allowLocalhostForTest && isLocalHost && parsedUrl.protocol === 'http:')
  ) {
    throw new SecurityEnvViolationError(
      'INSECURE_SUPABASE_URL',
      'SUPABASE_URL debe usar protocolo https://.'
    );
  }

  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const publicKey = String(
    env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || ''
  ).trim();
  const bearerToken = String(env.CERTIFIER_BEARER_TOKEN || '').trim();

  let apiKeyHeader = '';
  let authHeader = '';

  if (serviceRoleKey) {
    apiKeyHeader = serviceRoleKey;
    authHeader = `Bearer ${serviceRoleKey}`;
  } else if (publicKey && bearerToken) {
    apiKeyHeader = publicKey;
    authHeader = `Bearer ${bearerToken}`;
  } else {
    throw new SecurityEnvViolationError(
      'MISSING_REMOTE_CREDENTIALS',
      'Faltan credenciales exportadas en la terminal: exporte SUPABASE_SERVICE_ROLE_KEY o la dupla (SUPABASE_PUBLISHABLE_KEY + CERTIFIER_BEARER_TOKEN de un super_admin).'
    );
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const endpoint = `${parsedUrl.origin}/rest/v1/rpc/rpc_certificar_esquema_trade`;
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      apikey: apiKeyHeader,
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    return {
      mode: 'remote',
      passed: false,
      targetHost: parsedUrl.host,
      checks: [
        {
          id: 'remote.rpc_reachable',
          passed: false,
          severity: 'error',
          detail: redactSecrets(
            `rpc_certificar_esquema_trade() respondió HTTP ${response.status}: ${rawBody.slice(0, 200)}`
          ),
        },
      ],
    };
  }

  const catalog = (await response.json()) as RemoteCatalogPayload;
  return evaluateRemoteCatalogReport(catalog, parsedUrl.host);
}

function parseCliMode(argv: string[]): CertifierMode {
  const idx = argv.indexOf('--mode');
  const value = idx >= 0 ? String(argv[idx + 1] || '').toLowerCase() : 'static';
  if (value === 'static' || value === 'remote' || value === 'all') {
    return value;
  }
  return 'static';
}

function printReport(report: StaticCertificationReport | RemoteCertificationReport): void {
  console.log(`\n=== [CERTIFICADOR DE ESQUEMA — MODO ${report.mode.toUpperCase()}] ===`);
  if (report.mode === 'remote') {
    console.log(`Destino: ${report.targetHost}`);
  } else {
    console.log(`Migraciones analizadas: ${report.migrationCount}`);
  }
  for (const check of report.checks) {
    const tag = check.passed
      ? check.severity === 'warning'
        ? '[WARN]'
        : '[PASS]'
      : '[FAIL]';
    console.log(`  ${tag} ${check.id}: ${redactSecrets(check.detail)}`);
  }
  console.log(`Resultado ${report.mode}: ${report.passed ? 'PASS' : 'FAIL'}`);
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  (async () => {
    try {
      assertSafeEnvironment(process.env);
      const mode = parseCliMode(process.argv.slice(2));
      let allPassed = true;

      if (mode === 'static' || mode === 'all') {
        const staticReport = runStaticCertification();
        printReport(staticReport);
        if (!staticReport.passed) allPassed = false;
      }

      if (mode === 'remote' || mode === 'all') {
        const remoteReport = await runRemoteCertification(process.env);
        printReport(remoteReport);
        if (!remoteReport.passed) allPassed = false;
      }

      process.exit(allPassed ? 0 : 1);
    } catch (err) {
      if (err instanceof SecurityEnvViolationError) {
        console.error(`[SEGURIDAD/CONFIG][${err.code}] ${redactSecrets(err.message)}`);
        process.exit(2);
      }
      console.error(
        `[CERTIFICADOR ERROR] ${redactSecrets(err instanceof Error ? err.message : err)}`
      );
      process.exit(1);
    }
  })();
}
