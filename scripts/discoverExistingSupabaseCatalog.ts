/**
 * Descubridor de Catálogo Remoto de Supabase — ESTRICTAMENTE SOLO LECTURA (Compuerta G1).
 *
 * REGLAS INQUEBRANTABLES DE SEGURIDAD (ZERO-TRUST):
 *  - JAMÁS importa `dotenv` ni accede al sistema de archivos local para leer configuraciones.
 *  - Lee credenciales ÚNICAMENTE de variables ya exportadas en la terminal (`process.env`).
 *  - Reutiliza `assertSafeEnvironment` y `redactSecrets` de `scripts/certifySchemaProduction.ts`
 *    y aborta con código de salida 2 ante cualquier violación o ausencia de credenciales.
 *  - Todas las salidas pasan por redacción de JWTs, llaves `sb_secret_*`, tokens `sbp_*` y URIs.
 *  - Cero DDL/DML: únicamente ejecuta consultas `SELECT` de solo lectura sobre catálogo/metadatos.
 */
import { pathToFileURL } from 'node:url';
import {
  assertSafeEnvironment,
  redactSecrets,
  SecurityEnvViolationError,
  type RemoteCatalogPayload,
} from './certifySchemaProduction';

export { assertSafeEnvironment, redactSecrets, SecurityEnvViolationError };

export const DEFAULT_SUPABASE_PROJECT_REF = 'apaxdgxtaoeyswlfblgi';

export const OFFICIAL_REGIONAL_HUBS = [
  'Zulia',
  'Valencia',
  'Centro',
  'Oriente',
  'Capital',
] as const;

export type OfficialRegionalHub = (typeof OFFICIAL_REGIONAL_HUBS)[number];

export const TARGET_DISCOVERY_TABLES = [
  'regiones',
  'clientes',
  'promotoras',
  'vendedores',
  'supervisores',
  'productos',
  'profiles',
  'staff',
  'cadenas_comerciales',
  'zonas',
  'reportes_trade',
  'surveys',
  'cronograma_degustaciones',
  'rutas_promotoras',
  'asistencias_jornada',
  'asistencia_evidencias',
  'solicitudes_contraloria',
  'entregas_degustacion',
] as const;

export const REGIONAL_LINK_COLUMNS = [
  'region_id',
  'region',
  'region_codigo',
  'sucursal',
  'sucursal_id',
  'zona_id',
  'zona',
  'ciudad',
  'estado',
  'email',
  'auth_user_id',
  'supervisor_id',
  'supervisor',
  'vendedor_id',
  'codigo_vendedor',
  'cadena_id',
] as const;

export interface CatalogColumnSummary {
  column_name: string;
  data_type: string;
  udt_name: string | null;
  is_nullable: boolean | null;
}

export interface SanitizedRegionRow {
  id: string | number | null;
  code: string | null;
  name: string | null;
  active: boolean | null;
}

export interface RegionalHubsVerification {
  expectedHubs: readonly OfficialRegionalHub[];
  confirmedHubs: OfficialRegionalHub[];
  missingHubs: OfficialRegionalHub[];
  inactiveHubs: OfficialRegionalHub[];
  extraActiveRows: string[];
  allFiveHubsPresentAndActive: boolean;
}

export interface DiscoveredPolicySummary {
  tablename: string;
  policyname: string;
  cmd: string | null;
  permissive: string | null;
  roles: string[];
}

export interface DiscoveredTableSummary {
  table_name: string;
  exists: boolean;
  columns: CatalogColumnSummary[];
  regionalLinkColumns: string[];
  rls_enabled: boolean | null;
  force_rls: boolean | null;
  policy_count: number | null;
  policies: DiscoveredPolicySummary[];
}

export interface RemoteAppliedMigration {
  version: string;
  name: string;
}

export interface MigrationRenameAction {
  from: string;
  to: string;
  originalVersion: string;
  targetVersion: string;
  keptAppliedEightDigitVersion: boolean;
}

export type DiscoverySource = 'management_api' | 'postgrest_fallback';

export interface CatalogDiscoveryReport {
  discoveredAt: string;
  projectRef: string;
  targetHost: string | null;
  source: DiscoverySource;
  warnings: string[];
  regiones: {
    exists: boolean;
    columns: CatalogColumnSummary[];
    rows: SanitizedRegionRow[];
    hubVerification: RegionalHubsVerification;
  };
  tables: Record<string, DiscoveredTableSummary>;
  remoteSchemaMigrations: {
    reachable: boolean;
    applied: RemoteAppliedMigration[];
  };
}

export interface DiscoverCatalogOptions {
  fetchImpl?: typeof fetch;
  allowLocalhostForTest?: boolean;
  managementApiBaseUrl?: string;
}

/**
 * Extiende `redactSecrets` para cubrir también tokens personales de Management API (`sbp_*`),
 * cabeceras `Bearer` y cadenas de conexión PostgreSQL.
 */
export function redactCatalogOutput(input: unknown): string {
  return redactSecrets(input)
    .replace(/sbp_[A-Za-z0-9_-]+/gi, '[REDACTED_SBP_TOKEN]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_DB_URI]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED_TOKEN]');
}

/**
 * Valida que el entorno no exponga llaves secretas ni tokens de Management API bajo prefijo `VITE_*`.
 */
export function assertSafeCatalogEnvironment(
  env: Record<string, string | undefined>
): void {
  assertSafeEnvironment(env);

  for (const [key, rawVal] of Object.entries(env)) {
    if (!key.startsWith('VITE_')) continue;
    const val = String(rawVal ?? '').trim();
    if (!val) continue;

    if (/^sbp_/i.test(val) || /ACCESS_TOKEN/i.test(key)) {
      throw new SecurityEnvViolationError(
        'MANAGEMENT_TOKEN_IN_VITE_ENV',
        `BLOQUEO DE SEGURIDAD: la variable pública "${key}" expone un token administrativo de Management API.`
      );
    }

    if (/^postgres(?:ql)?:\/\//i.test(val)) {
      throw new SecurityEnvViolationError(
        'DB_URI_IN_VITE_ENV',
        `BLOQUEO DE SEGURIDAD: la variable pública "${key}" expone una cadena de conexión a base de datos.`
      );
    }
  }
}

/**
 * Defensa en profundidad: garantiza que únicamente se envíen sentencias `SELECT` puras de solo lectura.
 */
export function assertReadOnlySelectSql(sql: string): void {
  const trimmed = String(sql || '').trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error('Operación bloqueada: solo se permiten consultas SELECT de lectura.');
  }
  if (
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|EXECUTE|CALL|COPY|VACUUM)\b/i.test(
      trimmed
    )
  ) {
    throw new Error('Operación bloqueada: palabra clave mutante o DDL detectada en consulta de descubrimiento.');
  }
}

function normalizeHubToken(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function coerceNullableBoolean(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase();
    if (['true', 't', '1', 'activo', 'active', 'si', 'yes'].includes(clean)) return true;
    if (['false', 'f', '0', 'inactivo', 'inactive', 'no'].includes(clean)) return false;
  }
  return null;
}

/**
 * Proyecta únicamente metadatos no sensibles de una fila de `public.regiones`.
 */
export function sanitizeRegionRow(raw: unknown): SanitizedRegionRow {
  if (!raw || typeof raw !== 'object') {
    return { id: null, code: null, name: null, active: null };
  }
  const rec = raw as Record<string, unknown>;

  const rawId = rec.id ?? rec.region_id ?? null;
  const id =
    typeof rawId === 'string' || typeof rawId === 'number'
      ? typeof rawId === 'string'
        ? redactCatalogOutput(rawId.trim())
        : rawId
      : null;

  const rawCode = rec.codigo ?? rec.code ?? rec.slug ?? rec.sucursal ?? null;
  const code =
    typeof rawCode === 'string' && rawCode.trim().length > 0
      ? redactCatalogOutput(rawCode.trim())
      : null;

  const rawName = rec.nombre ?? rec.name ?? rec.descripcion ?? null;
  const name =
    typeof rawName === 'string' && rawName.trim().length > 0
      ? redactCatalogOutput(rawName.trim())
      : null;

  const active = coerceNullableBoolean(
    rec.activo ?? rec.active ?? rec.is_active ?? rec.estado ?? null
  );

  return { id, code, name, active };
}

/**
 * Verifica que los 5 hubs oficiales (Zulia, Valencia, Centro, Oriente, Capital) estén presentes y activos.
 */
export function verifyOfficialRegionalHubs(
  rows: readonly SanitizedRegionRow[]
): RegionalHubsVerification {
  const confirmedHubs: OfficialRegionalHub[] = [];
  const missingHubs: OfficialRegionalHub[] = [];
  const inactiveHubs: OfficialRegionalHub[] = [];
  const matchedTokens = new Set<string>();

  for (const hub of OFFICIAL_REGIONAL_HUBS) {
    const targetToken = normalizeHubToken(hub);
    const matchingRows = rows.filter(
      (r) =>
        normalizeHubToken(r.name) === targetToken ||
        normalizeHubToken(r.code) === targetToken
    );

    if (matchingRows.length === 0) {
      missingHubs.push(hub);
      continue;
    }

    matchedTokens.add(targetToken);
    const hasActive = matchingRows.some((r) => r.active !== false);
    if (hasActive) {
      confirmedHubs.push(hub);
    } else {
      inactiveHubs.push(hub);
    }
  }

  const extraActiveRows: string[] = [];
  for (const r of rows) {
    if (r.active === false) continue;
    const nameTok = normalizeHubToken(r.name);
    const codeTok = normalizeHubToken(r.code);
    if (!matchedTokens.has(nameTok) && !matchedTokens.has(codeTok)) {
      const label = r.name ?? r.code ?? String(r.id ?? 'UNKNOWN');
      extraActiveRows.push(label);
    }
  }

  return {
    expectedHubs: OFFICIAL_REGIONAL_HUBS,
    confirmedHubs,
    missingHubs,
    inactiveHubs,
    extraActiveRows,
    allFiveHubsPresentAndActive:
      confirmedHubs.length === OFFICIAL_REGIONAL_HUBS.length &&
      missingHubs.length === 0 &&
      inactiveHubs.length === 0,
  };
}

function isRegionalOrLinkColumn(columnName: string): boolean {
  const clean = columnName.trim().toLowerCase();
  if ((REGIONAL_LINK_COLUMNS as readonly string[]).includes(clean)) {
    return true;
  }
  return /(region|sucursal|zona|ciudad|estado|hub|sede|email)/i.test(clean);
}

/**
 * Calcula el plan determinístico de reconciliación para prefijos de migración duplicados de 8 dígitos:
 *  - Si `schema_migrations` remoto NO registra la versión de 8 dígitos, asigna marcas de 14 dígitos
 *    (`AAAAMMDD000100`, `AAAAMMDD000200`, ...) preservando el orden lexicográfico exacto.
 *  - Si `schema_migrations` remoto SÍ registra la versión de 8 dígitos como aplicada, conserva esa
 *    versión exacta de 8 dígitos para el archivo aplicado (coincidiendo por `name` o el primero en orden)
 *    y asigna versiones de 14 dígitos a los demás archivos del mismo prefijo.
 */
export function reconcileDuplicateMigrationPlan(
  localFileNames: readonly string[],
  remoteAppliedMigrations: readonly RemoteAppliedMigration[] = []
): MigrationRenameAction[] {
  const sqlFiles = [...localFileNames]
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const groupsByVersion = new Map<string, Array<{ fileName: string; slug: string }>>();
  for (const fileName of sqlFiles) {
    const match = /^(\d{8}|\d{14})_([a-z0-9_]+)\.sql$/i.exec(fileName);
    if (!match) continue;
    const version = match[1]!;
    const slug = match[2]!;
    const list = groupsByVersion.get(version) ?? [];
    list.push({ fileName, slug });
    groupsByVersion.set(version, list);
  }

  const remoteByVersion = new Map<string, RemoteAppliedMigration>();
  for (const entry of remoteAppliedMigrations) {
    const v = String(entry.version || '').trim();
    if (v) {
      remoteByVersion.set(v, { version: v, name: String(entry.name || '').trim() });
    }
  }

  const usedTargetVersions = new Set<string>();
  for (const version of groupsByVersion.keys()) {
    if ((groupsByVersion.get(version)?.length ?? 0) === 1) {
      usedTargetVersions.add(version);
    }
  }
  for (const v of remoteByVersion.keys()) {
    usedTargetVersions.add(v);
  }

  const actions: MigrationRenameAction[] = [];

  for (const [version, items] of groupsByVersion.entries()) {
    if (items.length <= 1 || version.length !== 8) continue;

    const remoteMatch = remoteByVersion.get(version);
    let keptIndex = -1;

    if (remoteMatch) {
      const normalizedRemoteName = remoteMatch.name
        .toLowerCase()
        .replace(/\.sql$/i, '')
        .replace(/^\d+_/, '');
      if (normalizedRemoteName) {
        keptIndex = items.findIndex(
          (item) => item.slug.toLowerCase() === normalizedRemoteName
        );
      }
      if (keptIndex < 0) {
        keptIndex = 0;
      }
    }

    let seq = 1;
    items.forEach((item, idx) => {
      if (idx === keptIndex) {
        actions.push({
          from: item.fileName,
          to: item.fileName,
          originalVersion: version,
          targetVersion: version,
          keptAppliedEightDigitVersion: true,
        });
        return;
      }

      let candidateVersion = `${version}${String(seq * 100).padStart(6, '0')}`;
      while (usedTargetVersions.has(candidateVersion)) {
        seq += 1;
        candidateVersion = `${version}${String(seq * 100).padStart(6, '0')}`;
      }
      usedTargetVersions.add(candidateVersion);
      seq += 1;

      actions.push({
        from: item.fileName,
        to: `${candidateVersion}_${item.slug}.sql`,
        originalVersion: version,
        targetVersion: candidateVersion,
        keptAppliedEightDigitVersion: false,
      });
    });
  }

  return actions;
}

interface ResolvedPostgrestCredentials {
  origin: string;
  host: string;
  apiKeyHeader: string;
  authHeader: string;
}

function resolvePostgrestCredentials(
  env: Record<string, string | undefined>,
  allowLocalhostForTest: boolean
): ResolvedPostgrestCredentials | null {
  const rawUrl = String(env.SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1\/?$/i, '');

  if (!rawUrl) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new SecurityEnvViolationError(
      'INVALID_SUPABASE_URL',
      'SUPABASE_URL no es una URL válida.'
    );
  }

  const isLocalHost =
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '[::1]';

  if (
    parsedUrl.protocol !== 'https:' &&
    !(allowLocalhostForTest && isLocalHost && parsedUrl.protocol === 'http:')
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

  if (serviceRoleKey) {
    return {
      origin: parsedUrl.origin,
      host: parsedUrl.host,
      apiKeyHeader: serviceRoleKey,
      authHeader: `Bearer ${serviceRoleKey}`,
    };
  }

  if (publicKey && bearerToken) {
    return {
      origin: parsedUrl.origin,
      host: parsedUrl.host,
      apiKeyHeader: publicKey,
      authHeader: `Bearer ${bearerToken}`,
    };
  }

  throw new SecurityEnvViolationError(
    'MISSING_REMOTE_CREDENTIALS',
    'SUPABASE_URL está definida pero faltan SUPABASE_SERVICE_ROLE_KEY o la dupla (SUPABASE_PUBLISHABLE_KEY + CERTIFIER_BEARER_TOKEN).'
  );
}

async function runManagementReadOnlyQuery(
  fetchFn: typeof fetch,
  endpoint: string,
  accessToken: string,
  sql: string
): Promise<Array<Record<string, unknown>>> {
  assertReadOnlySelectSql(sql);

  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      redactCatalogOutput(
        `Management API /database/query respondió HTTP ${response.status}: ${body.slice(0, 180)}`
      )
    );
  }

  const parsed = (await response.json()) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as Array<Record<string, unknown>>;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { result?: unknown }).result)) {
    return (parsed as { result: Array<Record<string, unknown>> }).result;
  }
  return [];
}

function buildEmptyTablesRecord(): Record<string, DiscoveredTableSummary> {
  const out: Record<string, DiscoveredTableSummary> = {};
  for (const tbl of TARGET_DISCOVERY_TABLES) {
    out[tbl] = {
      table_name: tbl,
      exists: false,
      columns: [],
      regionalLinkColumns: [],
      rls_enabled: null,
      force_rls: null,
      policy_count: null,
      policies: [],
    };
  }
  return out;
}

function ensureTableEntry(
  map: Record<string, DiscoveredTableSummary>,
  tableName: string
): DiscoveredTableSummary {
  if (!map[tableName]) {
    map[tableName] = {
      table_name: tableName,
      exists: false,
      columns: [],
      regionalLinkColumns: [],
      rls_enabled: null,
      force_rls: null,
      policy_count: null,
      policies: [],
    };
  }
  return map[tableName]!;
}

function parsePostgrestOpenApiSchemas(
  spec: Record<string, unknown>,
  tables: Record<string, DiscoveredTableSummary>
): void {
  const definitions =
    (spec.definitions as Record<string, unknown> | undefined) ??
    ((spec.components as { schemas?: Record<string, unknown> } | undefined)?.schemas ?? {});

  for (const [tableName, rawSchema] of Object.entries(definitions)) {
    if (!rawSchema || typeof rawSchema !== 'object') continue;
    const schemaObj = rawSchema as {
      properties?: Record<string, { type?: string; format?: string }>;
      required?: string[];
    };
    const requiredSet = new Set(Array.isArray(schemaObj.required) ? schemaObj.required : []);
    const props = schemaObj.properties ?? {};
    const entry = ensureTableEntry(tables, tableName);
    entry.exists = true;

    const cols: CatalogColumnSummary[] = [];
    for (const [colName, colMeta] of Object.entries(props)) {
      cols.push({
        column_name: colName,
        data_type: String(colMeta?.format || colMeta?.type || 'unknown'),
        udt_name: colMeta?.format ? String(colMeta.format) : null,
        is_nullable: !requiredSet.has(colName),
      });
    }
    entry.columns = cols;
    entry.regionalLinkColumns = cols
      .map((c) => c.column_name)
      .filter((name) => isRegionalOrLinkColumn(name));
  }
}

/**
 * Ejecuta el descubrimiento en modo ESTRICTAMENTE SOLO LECTURA sobre el catálogo de Supabase.
 */
export async function discoverExistingSupabaseCatalog(
  env: Record<string, string | undefined>,
  options: DiscoverCatalogOptions = {}
): Promise<CatalogDiscoveryReport> {
  assertSafeCatalogEnvironment(env);

  const allowLocalhost = Boolean(options.allowLocalhostForTest);
  const accessToken = String(env.SUPABASE_ACCESS_TOKEN || '').trim();
  const projectRef =
    String(env.SUPABASE_PROJECT_REF || '').trim() || DEFAULT_SUPABASE_PROJECT_REF;

  if (!/^[a-z0-9-]+$/i.test(projectRef)) {
    throw new SecurityEnvViolationError(
      'INVALID_SUPABASE_PROJECT_REF',
      'SUPABASE_PROJECT_REF contiene caracteres inválidos.'
    );
  }

  const postgrestCreds = resolvePostgrestCredentials(env, allowLocalhost);

  if (!accessToken && !postgrestCreds) {
    throw new SecurityEnvViolationError(
      'MISSING_DISCOVERY_CREDENTIALS',
      'Faltan credenciales en process.env: exporte SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_PUBLISHABLE_KEY + CERTIFIER_BEARER_TOKEN) y/o SUPABASE_ACCESS_TOKEN (este script jamás lee archivos .env*).'
    );
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const warnings: string[] = [];
  const tables = buildEmptyTablesRecord();

  // ---------------------------------------------------------------------------
  // RUTA 1: Management API (`POST /v1/projects/{ref}/database/query`) — Read-Only SQL
  // ---------------------------------------------------------------------------
  if (accessToken) {
    const mgmtBase = String(
      options.managementApiBaseUrl || 'https://api.supabase.com'
    ).replace(/\/+$/, '');
    const queryEndpoint = `${mgmtBase}/v1/projects/${projectRef}/database/query`;

    try {
      const tableRows = await runManagementReadOnlyQuery(
        fetchFn,
        queryEndpoint,
        accessToken,
        `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         ORDER BY c.relname`
      );

      for (const row of tableRows) {
        const tblName = String(row.table_name || '').trim();
        if (!tblName) continue;
        const entry = ensureTableEntry(tables, tblName);
        entry.exists = true;
        entry.rls_enabled = Boolean(row.rls_enabled);
        entry.force_rls = Boolean(row.force_rls);
      }

      const columnRows = await runManagementReadOnlyQuery(
        fetchFn,
        queryEndpoint,
        accessToken,
        `SELECT table_name, column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public'
         ORDER BY table_name, ordinal_position`
      );

      for (const col of columnRows) {
        const tblName = String(col.table_name || '').trim();
        const colName = String(col.column_name || '').trim();
        if (!tblName || !colName) continue;
        const entry = ensureTableEntry(tables, tblName);
        entry.exists = true;
        entry.columns.push({
          column_name: colName,
          data_type: String(col.data_type || 'unknown'),
          udt_name: col.udt_name ? String(col.udt_name) : null,
          is_nullable: String(col.is_nullable || '').toUpperCase() === 'YES',
        });
      }

      for (const entry of Object.values(tables)) {
        entry.regionalLinkColumns = entry.columns
          .map((c) => c.column_name)
          .filter((name) => isRegionalOrLinkColumn(name));
      }

      const policyRows = await runManagementReadOnlyQuery(
        fetchFn,
        queryEndpoint,
        accessToken,
        `SELECT tablename, policyname, cmd, permissive, roles
         FROM pg_catalog.pg_policies
         WHERE schemaname = 'public'
         ORDER BY tablename, policyname`
      );

      for (const pol of policyRows) {
        const tblName = String(pol.tablename || '').trim();
        if (!tblName) continue;
        const entry = ensureTableEntry(tables, tblName);
        const rawRoles = pol.roles;
        const roles = Array.isArray(rawRoles)
          ? rawRoles.map((r) => String(r))
          : typeof rawRoles === 'string'
            ? rawRoles
                .replace(/^\{|\}$/g, '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
        entry.policies.push({
          tablename: tblName,
          policyname: String(pol.policyname || ''),
          cmd: pol.cmd ? String(pol.cmd) : null,
          permissive: pol.permissive ? String(pol.permissive) : null,
          roles,
        });
      }

      for (const entry of Object.values(tables)) {
        if (entry.exists) {
          entry.policy_count = entry.policies.length;
        }
      }

      let sanitizedRegionesRows: SanitizedRegionRow[] = [];
      if (tables.regiones?.exists) {
        const rawRegiones = await runManagementReadOnlyQuery(
          fetchFn,
          queryEndpoint,
          accessToken,
          `SELECT to_jsonb(r) AS row_data FROM public.regiones r LIMIT 100`
        );
        sanitizedRegionesRows = rawRegiones.map((item) =>
          sanitizeRegionRow(item.row_data ?? item)
        );
      }

      let migrationsReachable = false;
      const appliedMigrations: RemoteAppliedMigration[] = [];
      try {
        const migRows = await runManagementReadOnlyQuery(
          fetchFn,
          queryEndpoint,
          accessToken,
          `SELECT version, COALESCE(name, '') AS name
           FROM supabase_migrations.schema_migrations
           ORDER BY version`
        );
        migrationsReachable = true;
        for (const m of migRows) {
          const v = String(m.version || '').trim();
          if (v) {
            appliedMigrations.push({
              version: v,
              name: String(m.name || '').trim(),
            });
          }
        }
      } catch (migErr) {
        warnings.push(
          redactCatalogOutput(
            `supabase_migrations.schema_migrations no disponible: ${migErr instanceof Error ? migErr.message : migErr}`
          )
        );
      }

      return {
        discoveredAt: new Date().toISOString(),
        projectRef,
        targetHost: postgrestCreds?.host ?? `${projectRef}.supabase.co`,
        source: 'management_api',
        warnings,
        regiones: {
          exists: Boolean(tables.regiones?.exists),
          columns: tables.regiones?.columns ?? [],
          rows: sanitizedRegionesRows,
          hubVerification: verifyOfficialRegionalHubs(sanitizedRegionesRows),
        },
        tables,
        remoteSchemaMigrations: {
          reachable: migrationsReachable,
          applied: appliedMigrations,
        },
      };
    } catch (mgmtErr) {
      const safeMsg = redactCatalogOutput(
        mgmtErr instanceof Error ? mgmtErr.message : mgmtErr
      );
      if (!postgrestCreds) {
        throw new Error(`Fallo en Management API y sin credenciales PostgREST de respaldo: ${safeMsg}`);
      }
      warnings.push(`Management API no disponible (${safeMsg}); degradando a PostgREST solo lectura.`);
    }
  }

  // ---------------------------------------------------------------------------
  // RUTA 2: Fallback PostgREST OpenAPI (`/rest/v1/`) + `/rest/v1/regiones` + `rpc_certificar_esquema_trade`
  // ---------------------------------------------------------------------------
  const creds = postgrestCreds!;
  const baseHeaders = {
    apikey: creds.apiKeyHeader,
    Authorization: creds.authHeader,
  };

  // 2.a OpenAPI `/rest/v1/` para descubrir tablas y tipos expuestos en `public`
  try {
    const openApiRes = await fetchFn(`${creds.origin}/rest/v1/`, {
      method: 'GET',
      headers: {
        ...baseHeaders,
        Accept: 'application/openapi+json, application/json',
      },
    });
    if (openApiRes.ok) {
      const spec = (await openApiRes.json()) as Record<string, unknown>;
      parsePostgrestOpenApiSchemas(spec, tables);
    } else {
      warnings.push(
        redactCatalogOutput(`OpenAPI /rest/v1/ respondió HTTP ${openApiRes.status}.`)
      );
    }
  } catch (err) {
    warnings.push(
      redactCatalogOutput(
        `No se pudo inspeccionar OpenAPI /rest/v1/: ${err instanceof Error ? err.message : err}`
      )
    );
  }

  // 2.b Filas activas y metadatos no sensibles de `/rest/v1/regiones`
  let sanitizedRegionesRows: SanitizedRegionRow[] = [];
  try {
    const regRes = await fetchFn(`${creds.origin}/rest/v1/regiones?select=*&limit=100`, {
      method: 'GET',
      headers: {
        ...baseHeaders,
        Accept: 'application/json',
      },
    });
    if (regRes.ok) {
      const rawRows = (await regRes.json()) as unknown[];
      if (Array.isArray(rawRows)) {
        tables.regiones!.exists = true;
        sanitizedRegionesRows = rawRows.map((r) => sanitizeRegionRow(r));
        if (tables.regiones!.columns.length === 0 && rawRows.length > 0 && rawRows[0] && typeof rawRows[0] === 'object') {
          tables.regiones!.columns = Object.entries(rawRows[0] as Record<string, unknown>).map(
            ([colName, val]) => ({
              column_name: colName,
              data_type: val === null ? 'nullable' : typeof val,
              udt_name: null,
              is_nullable: null,
            })
          );
          tables.regiones!.regionalLinkColumns = tables.regiones!.columns
            .map((c) => c.column_name)
            .filter((name) => isRegionalOrLinkColumn(name));
        }
      }
    } else {
      const body = await regRes.text().catch(() => '');
      warnings.push(
        redactCatalogOutput(
          `GET /rest/v1/regiones respondió HTTP ${regRes.status}: ${body.slice(0, 140)}`
        )
      );
    }
  } catch (err) {
    warnings.push(
      redactCatalogOutput(
        `Error consultando /rest/v1/regiones: ${err instanceof Error ? err.message : err}`
      )
    );
  }

  // 2.c Enriquecimiento mediante `rpc_certificar_esquema_trade()` (RLS, FORCE RLS, sucursal_type, policy_count)
  try {
    const rpcRes = await fetchFn(`${creds.origin}/rest/v1/rpc/rpc_certificar_esquema_trade`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (rpcRes.ok) {
      const rpcPayload = (await rpcRes.json()) as RemoteCatalogPayload;
      for (const tblEntry of rpcPayload.tables ?? []) {
        const target = ensureTableEntry(tables, tblEntry.table_name);
        target.exists = target.exists || Boolean(tblEntry.exists);
        target.rls_enabled = tblEntry.rls_enabled;
        target.force_rls = tblEntry.force_rls;
        target.policy_count = tblEntry.policy_count;

        if (tblEntry.has_sucursal_column) {
          if (!target.columns.some((c) => c.column_name === 'sucursal')) {
            target.columns.push({
              column_name: 'sucursal',
              data_type: tblEntry.sucursal_type ?? 'sucursal_codigo',
              udt_name: tblEntry.sucursal_type,
              is_nullable: true,
            });
          }
          if (!target.regionalLinkColumns.includes('sucursal')) {
            target.regionalLinkColumns.push('sucursal');
          }
        }
      }
    } else {
      warnings.push(
        redactCatalogOutput(
          `POST /rest/v1/rpc/rpc_certificar_esquema_trade respondió HTTP ${rpcRes.status}.`
        )
      );
    }
  } catch (err) {
    warnings.push(
      redactCatalogOutput(
        `No se pudo invocar rpc_certificar_esquema_trade: ${err instanceof Error ? err.message : err}`
      )
    );
  }

  warnings.push(
    'supabase_migrations.schema_migrations requiere SUPABASE_ACCESS_TOKEN (Management API) al no exponerse en PostgREST público.'
  );

  return {
    discoveredAt: new Date().toISOString(),
    projectRef,
    targetHost: creds.host,
    source: 'postgrest_fallback',
    warnings,
    regiones: {
      exists: Boolean(tables.regiones?.exists),
      columns: tables.regiones?.columns ?? [],
      rows: sanitizedRegionesRows,
      hubVerification: verifyOfficialRegionalHubs(sanitizedRegionesRows),
    },
    tables,
    remoteSchemaMigrations: {
      reachable: false,
      applied: [],
    },
  };
}

function writeSafeStdout(line: string): void {
  process.stdout.write(`${redactCatalogOutput(line)}\n`);
}

function writeSafeStderr(line: string): void {
  process.stderr.write(`${redactCatalogOutput(line)}\n`);
}

export function formatDiscoverySummary(report: CatalogDiscoveryReport): string {
  const lines: string[] = [];
  lines.push('=== [DESCUBRIMIENTO DE CATÁLOGO SUPABASE — SOLO LECTURA (G1)] ===');
  lines.push(`Proyecto Ref: ${report.projectRef}`);
  lines.push(`Host: ${report.targetHost ?? 'N/A'} | Fuente: ${report.source}`);
  lines.push(
    `public.regiones: exists=${report.regiones.exists} | columnas=[${report.regiones.columns
      .map((c) => `${c.column_name}:${c.data_type}`)
      .join(', ')}]`
  );
  lines.push(
    `Hubs oficiales (5): allActive=${report.regiones.hubVerification.allFiveHubsPresentAndActive} | confirmados=[${report.regiones.hubVerification.confirmedHubs.join(
      ', '
    )}] | faltantes=[${report.regiones.hubVerification.missingHubs.join(', ')}]`
  );
  for (const r of report.regiones.rows) {
    lines.push(
      `  - region id=${r.id ?? 'null'} code=${r.code ?? 'null'} name=${r.name ?? 'null'} active=${r.active ?? 'null'}`
    );
  }
  lines.push('Tablas y columnas de enlace regional:');
  for (const tblName of TARGET_DISCOVERY_TABLES) {
    const t = report.tables[tblName];
    if (!t) continue;
    lines.push(
      `  - ${t.table_name}: exists=${t.exists} | links=[${t.regionalLinkColumns.join(
        ', '
      )}] | rls=${t.rls_enabled ?? 'unknown'} | policies=${t.policy_count ?? 'unknown'}`
    );
  }
  lines.push(
    `schema_migrations remoto: reachable=${report.remoteSchemaMigrations.reachable} | versiones_aplicadas=${report.remoteSchemaMigrations.applied.length}`
  );
  if (report.warnings.length > 0) {
    lines.push(`Advertencias (${report.warnings.length}):`);
    for (const w of report.warnings) {
      lines.push(`  [WARN] ${w}`);
    }
  }
  return redactCatalogOutput(lines.join('\n'));
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  (async () => {
    try {
      const report = await discoverExistingSupabaseCatalog(process.env);
      writeSafeStdout(formatDiscoverySummary(report));
      process.exit(0);
    } catch (err) {
      if (err instanceof SecurityEnvViolationError) {
        writeSafeStderr(`[SEGURIDAD/CONFIG][${err.code}] ${err.message}`);
        process.exit(2);
      }
      writeSafeStderr(
        `[DISCOVERY ERROR] ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
  })();
}
