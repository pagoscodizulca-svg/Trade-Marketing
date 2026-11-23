import { z } from 'zod';
import {
  isOperativeSucursal,
  normalizeSucursalCodigo,
  type OperativeSucursal,
} from '../services/userManagementService';

// =============================================================================
// 1. CATÁLOGO ESTRICTO DE LAS 3 REGIONES OFICIALES EN SUPABASE (`"Regiones"`)
//    Orden de prioridad operativo: OCCIDENTE (1) -> CENTRO (2) -> ANDES (3)
// =============================================================================

export const ALLOWED_REGIONS = ['OCCIDENTE', 'CENTRO', 'ANDES'] as const;
export type AllowedRegionCode = (typeof ALLOWED_REGIONS)[number];

export const REGIONAL_SYNC_PRIORITY_QUEUE: readonly AllowedRegionCode[] = [
  'OCCIDENTE',
  'CENTRO',
  'ANDES',
] as const;

export const REGIONAL_PRIORITY_RANK: Record<AllowedRegionCode, 1 | 2 | 3> = {
  OCCIDENTE: 1,
  CENTRO: 2,
  ANDES: 3,
};

export const ALLOWED_REGION_LABELS: Record<AllowedRegionCode, string> = {
  OCCIDENTE: 'Occidente (Zulia)',
  CENTRO: 'Centro (Valencia)',
  ANDES: 'Andes',
};

export const AllowedRegionSchema = z.enum(ALLOWED_REGIONS);

export function isAllowedRegionCode(raw: unknown): raw is AllowedRegionCode {
  return (
    typeof raw === 'string' &&
    (raw === 'OCCIDENTE' || raw === 'CENTRO' || raw === 'ANDES')
  );
}

/**
 * Normalización estricta contra el catálogo oficial de `"Regiones"`:
 * acepta únicamente `OCCIDENTE`, `CENTRO` o `ANDES` (insensible a espacios/mayúsculas).
 * Rechaza cualquier otro valor devolviendo `null`.
 */
export function normalizeAllowedRegionStrict(raw: unknown): AllowedRegionCode | null {
  const clean = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
  if (isAllowedRegionCode(clean)) {
    return clean;
  }
  return null;
}

/**
 * Fuente Única de Verdad para normalización regional del sistema Trade Marketing:
 * Mapea exclusivamente al catálogo oficial de `public."Regiones"` (`OCCIDENTE`, `CENTRO`, `ANDES`)
 * traduciendo de forma segura alias legados o direcciones territoriales:
 *   - `OCCIDENTE` (Prioridad 1): Zulia, Maracaibo, San Francisco, Cabimas, Falcón, Coro, Punto Fijo, etc.
 *   - `CENTRO`    (Prioridad 2): Valencia, Carabobo, Aragua, Maracay, Distrito Capital, Caracas, Guárico, Cojedes.
 *   - `ANDES`     (Prioridad 3): Andes, Mérida, Táchira, Trujillo, San Cristóbal, Valera, Barinas.
 * Cualquier otro valor (`GLOBAL`, `TODAS`, `ORIENTE`, vacío, etc.) devuelve `null`.
 */
export function normalizeRegionName(raw: unknown): AllowedRegionCode | null {
  const strict = normalizeAllowedRegionStrict(raw);
  if (strict) return strict;

  const norm = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!norm) return null;

  const stripped = norm.replace(/^(REGION|SUCURSAL|SEDE|HUB|ESTADO|ZONA|OFICINA)\s+/, '').trim();
  if (isAllowedRegionCode(stripped)) {
    return stripped;
  }

  // Prioridad 1: OCCIDENTE (Zulia + Falcón + eje occidental, incluyendo zonas locales de Maracaibo/COL)
  if (
    stripped === 'ZULIA' ||
    /\b(OCCIDENTE|ZULIA|MARACAIBO|SAN FRANCISCO|CABIMAS|CIUDAD OJEDA|LAGUNILLAS|MACHIQUES|LA VILLA|MARA|MOJAN|CUATRICENTENARIO|VARILLAL|LA LIMPIA|LA POPULAR|EL SILENCIO|EL BAJO|SANTA MARIA|PLAZA DE LAS MADRES|DIA DE LAS MADRES|C2|FALCON|CORO|PUNTO FIJO|PARAGUANA|LARA|BARQUISIMETO)\b/.test(
      norm
    )
  ) {
    return 'OCCIDENTE';
  }

  // Prioridad 2: CENTRO (Carabobo/Valencia + Aragua/Maracay + Distrito Capital/Caracas según "Sucursales")
  if (
    stripped === 'VALENCIA' ||
    stripped === 'CENTRO' ||
    stripped === 'CAPITAL' ||
    /\b(CENTRO|VALENCIA|CARABOBO|NAGUANAGUA|SAN DIEGO|GUACARA|TOCUYITO|LOS GUAYOS|PARAPARAL|PUERTO CABELLO|LIBERTADOR|ARAGUA|MARACAY|TURMERO|CAGUA|LA VICTORIA|LA BARRACA|DISTRITO CAPITAL|CARACAS|MIRANDA|LA GUAIRA|EL PARAISO|MONTALBAN|PLAZA VENEZUELA|COJEDES|GUARICO)\b/.test(
      norm
    )
  ) {
    return 'CENTRO';
  }

  // Prioridad 3: ANDES
  if (/\b(ANDES|MERIDA|TACHIRA|TRUJILLO|SAN CRISTOBAL|VALERA|BARINAS)\b/.test(norm)) {
    return 'ANDES';
  }

  return null;
}

/**
 * Puente explícito desde nombres de sucursal o territorio legado hacia las 3 regiones reales
 * de `"Regiones"` (`ZULIA -> OCCIDENTE`, `VALENCIA / CENTRO -> CENTRO`, `ANDES -> ANDES`).
 * Nota: Mantiene el contrato estricto donde `ORIENTE` / `GLOBAL` devuelven `null`.
 */
export function mapLegacySucursalToAllowedRegion(raw: unknown): AllowedRegionCode | null {
  const strict = normalizeAllowedRegionStrict(raw);
  if (strict) return strict;

  const norm = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
  if (!norm) return null;

  if (norm === 'CAPITAL' || norm === 'ORIENTE' || norm === 'GLOBAL') {
    return null;
  }

  return normalizeRegionName(norm);
}

export function mapAllowedRegionToLegacySucursal(
  region: AllowedRegionCode
): OperativeSucursal | null {
  if (region === 'OCCIDENTE') return 'ZULIA';
  if (region === 'CENTRO') return 'CENTRO';
  return null;
}

export function sortAllowedRegionsByPriority(
  regions: readonly AllowedRegionCode[]
): AllowedRegionCode[] {
  const unique = new Set<AllowedRegionCode>();
  for (const r of regions) {
    if (isAllowedRegionCode(r)) {
      unique.add(r);
    }
  }
  return Array.from(unique).sort(
    (a, b) => REGIONAL_PRIORITY_RANK[a] - REGIONAL_PRIORITY_RANK[b]
  );
}

// =============================================================================
// 2. DIVISIÓN OFICIAL DE PROMOTORAS (`Fijas` / `Eventuales` / `Merchandising`)
// =============================================================================

export const PROMOTORA_CATEGORIAS = ['Fijas', 'Eventuales', 'Merchandising'] as const;
export type PromotoraCategoriaOficial = (typeof PROMOTORA_CATEGORIAS)[number];

/** Clave interna legada conservada para compatibilidad con componentes previos. */
export type PromotoraCategoria = 'fija' | 'eventual' | 'merchandising';

export const PROMOTORA_CATEGORIA_ORDER: readonly PromotoraCategoria[] = [
  'fija',
  'eventual',
  'merchandising',
] as const;

export const PROMOTORA_CATEGORIA_LABELS: Record<PromotoraCategoria, string> = {
  fija: 'Plantilla Fija',
  eventual: 'Plantilla Eventual',
  merchandising: 'Merchandising',
};

export const PROMOTORA_CATEGORIA_SHORT_LABELS: Record<PromotoraCategoria, string> = {
  fija: 'Fijas',
  eventual: 'Eventuales',
  merchandising: 'Merchandising',
};

export const PROMOTORA_OFICIAL_UI_LABELS: Record<PromotoraCategoriaOficial, string> = {
  Fijas: 'Fijas',
  Eventuales: 'Eventuales',
  Merchandising: 'Merchandising',
};

export const PromotoraCategoriaStrictSchema = z.enum(PROMOTORA_CATEGORIAS, {
  error: 'Categoría de promotora inválida. Valores permitidos: Fijas, Eventuales o Merchandising.',
});

export const PromotoraCategoriaFilterSchema = z.enum(['TODAS', ...PROMOTORA_CATEGORIAS], {
  error: 'Filtro de categoría inválido. Use TODAS, Fijas, Eventuales o Merchandising.',
});

export function toPromotoraCategoriaOficial(
  cat: PromotoraCategoria | PromotoraCategoriaOficial
): PromotoraCategoriaOficial {
  if (cat === 'Fijas' || cat === 'Eventuales' || cat === 'Merchandising') {
    return cat;
  }
  if (cat === 'eventual') return 'Eventuales';
  if (cat === 'merchandising') return 'Merchandising';
  return 'Fijas';
}

export function toLegacyPromotoraCategoria(
  cat: PromotoraCategoriaOficial | PromotoraCategoria
): PromotoraCategoria {
  if (cat === 'fija' || cat === 'eventual' || cat === 'merchandising') {
    return cat;
  }
  if (cat === 'Eventuales') return 'eventual';
  if (cat === 'Merchandising') return 'merchandising';
  return 'fija';
}

/**
 * Valida estrictamente con Zod que la categoría sea exactamente `Fijas`, `Eventuales` o `Merchandising`.
 */
export function parsePromotoraCategoriaStrict(raw: unknown): PromotoraCategoriaOficial {
  return PromotoraCategoriaStrictSchema.parse(raw);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PromotoraUpsertSchema = z.object({
  id: z.string().regex(UUID_REGEX, 'ID de promotora inválido.').optional(),
  nombre_completo: z
    .string()
    .trim()
    .min(2, 'El nombre completo de la promotora debe tener al menos 2 caracteres.')
    .max(180, 'El nombre completo excede 180 caracteres.'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Correo electrónico inválido.')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  telefono: z.string().trim().max(40).nullable().optional(),
  ciudad: z.string().trim().max(100).nullable().optional(),
  estado: z.string().trim().max(100).nullable().optional(),
  direccion: z.string().trim().max(260).nullable().optional(),
  categoria: PromotoraCategoriaStrictSchema,
  region: AllowedRegionSchema.optional(),
  region_id: z.string().regex(UUID_REGEX, 'region_id debe ser un UUID válido.').nullable().optional(),
  supervisor_id: z
    .string()
    .regex(UUID_REGEX, 'supervisor_id debe ser un UUID válido.')
    .nullable()
    .optional(),
  activo: z.boolean().optional().default(true),
});

export type ValidatedPromotoraUpsertInput = z.output<typeof PromotoraUpsertSchema>;

export const PromotoraFilterSchema = z.object({
  categoria: PromotoraCategoriaFilterSchema.optional().default('TODAS'),
  region: z.union([AllowedRegionSchema, z.literal('TODAS')]).optional().default('TODAS'),
  regionId: z.string().regex(UUID_REGEX, 'regionId inválido.').optional(),
  soloActivas: z.boolean().optional(),
  busqueda: z
    .string()
    .max(120)
    .optional()
    .transform((v) => (v ? v.trim() : '')),
});

export type ValidatedPromotoraFilter = z.output<typeof PromotoraFilterSchema>;

export interface RegionLookupLike {
  id: string;
  codigo: string;
  nombre: string;
}

export interface RegionalRowLike {
  region_id?: string | null;
  sucursal?: string | null;
  region?: string | null;
  region_codigo?: string | null;
  sede?: string | null;
}

function normalizeTokenNfd(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonObjectSafe(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
    }
  }
  return {};
}

function detectCategoryFromToken(token: string): PromotoraCategoria | null {
  if (!token) return null;

  if (
    token === 'merchandising' ||
    token === 'merch' ||
    /\b(merchandising|mercaderista|mercader|mercadeo|merch|anaquel|gondola)\b/.test(token)
  ) {
    return 'merchandising';
  }

  if (
    token === 'eventual' ||
    token === 'eventuales' ||
    /\b(eventual|eventuales|temporal|suplente|apoyo|freelance|fin de semana)\b/.test(token)
  ) {
    return 'eventual';
  }

  if (
    token === 'fija' ||
    token === 'fijo' ||
    token === 'fijas' ||
    /\b(fija|fijas|fijo|planta|permanente|plantilla fija)\b/.test(token)
  ) {
    return 'fija';
  }

  return null;
}

/**
 * Clasifica determinísticamente cualquier registro de promotora o personal de campo
 * (proveniente de `public.promotoras` o `public.staff`) en una de las 3 categorías internas:
 *  - `'fija'` (`Fijas`)
 *  - `'eventual'` (`Eventuales`)
 *  - `'merchandising'` (`Merchandising`)
 */
export function classifyPromotoraCategoria(raw: Record<string, unknown>): PromotoraCategoria {
  const statusObj = parseJsonObjectSafe(raw.status);
  const metadataObj = parseJsonObjectSafe(raw.metadata);

  const candidates: unknown[] = [
    raw.categoria,
    raw.category,
    raw.tipo_promotora,
    raw.modalidad,
    raw.tipo,
    raw.plantilla,
    raw.perfil,
    raw.subtipo,
    raw.clasificacion,
    statusObj.category,
    statusObj.categoria,
    statusObj.modalidad,
    statusObj.tipo,
    metadataObj.categoria,
    metadataObj.category,
    metadataObj.tipo_promotora,
    metadataObj.modalidad,
    metadataObj.tipo,
    metadataObj.perfil,
    raw.role,
    raw.rol,
    raw.cargo,
    metadataObj.role,
    metadataObj.rol,
    metadataObj.cargo,
    statusObj.assignedLocation,
    raw.assignedStore,
    raw.assigned_location,
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const hit = detectCategoryFromToken(normalizeTokenNfd(candidate));
    if (hit) return hit;
  }

  return 'fija';
}

export function classifyPromotoraCategoriaOficial(
  raw: Record<string, unknown>
): PromotoraCategoriaOficial {
  return toPromotoraCategoriaOficial(classifyPromotoraCategoria(raw));
}

export function formatPromotoraRoleForCategory(
  category: PromotoraCategoria | PromotoraCategoriaOficial,
  existingRole?: string | null
): string {
  const legacy = toLegacyPromotoraCategoria(category);
  const clean = String(existingRole ?? '').trim();
  if (legacy === 'merchandising') {
    return 'Promotor Merchandising';
  }
  if (legacy === 'eventual') {
    return clean && /eventual/i.test(clean) ? clean : 'Promotora Eventual';
  }
  return clean && /fija/i.test(clean) ? clean : 'Promotora Fija';
}

export interface GroupedPromotoras<T> {
  fija: T[];
  eventual: T[];
  merchandising: T[];
}

export function groupPromotorasByCategoria<T>(
  items: readonly T[],
  getCategory: (item: T) => PromotoraCategoria,
  getSortName?: (item: T) => string
): GroupedPromotoras<T> {
  const grouped: GroupedPromotoras<T> = {
    fija: [],
    eventual: [],
    merchandising: [],
  };

  for (const item of items) {
    const cat = getCategory(item);
    grouped[cat].push(item);
  }

  if (getSortName) {
    const cmp = (a: T, b: T) => getSortName(a).localeCompare(getSortName(b), 'es');
    grouped.fija.sort(cmp);
    grouped.eventual.sort(cmp);
    grouped.merchandising.sort(cmp);
  }

  return grouped;
}

export interface PromotorasCategoryBucketCounts {
  total: number;
  Fijas: number;
  Eventuales: number;
  Merchandising: number;
}

export interface PromotorasCategoryStats extends PromotorasCategoryBucketCounts {
  porRegion: Record<AllowedRegionCode, PromotorasCategoryBucketCounts>;
}

export function computePromotorasCategoryStats<T extends Record<string, unknown>>(
  items: readonly T[],
  resolveRegion?: (item: T) => AllowedRegionCode | null
): PromotorasCategoryStats {
  const stats: PromotorasCategoryStats = {
    total: 0,
    Fijas: 0,
    Eventuales: 0,
    Merchandising: 0,
    porRegion: {
      OCCIDENTE: { total: 0, Fijas: 0, Eventuales: 0, Merchandising: 0 },
      CENTRO: { total: 0, Fijas: 0, Eventuales: 0, Merchandising: 0 },
      ANDES: { total: 0, Fijas: 0, Eventuales: 0, Merchandising: 0 },
    },
  };

  for (const item of items) {
    const cat = classifyPromotoraCategoriaOficial(item);
    stats.total += 1;
    stats[cat] += 1;

    const region = resolveRegion
      ? resolveRegion(item)
      : mapLegacySucursalToAllowedRegion(
          item.region ?? item.region_codigo ?? item.sucursal ?? item.estado ?? item.ciudad
        );
    if (region && isAllowedRegionCode(region)) {
      stats.porRegion[region].total += 1;
      stats.porRegion[region][cat] += 1;
    }
  }

  return stats;
}

/**
 * Filtra una colección de promotoras validando estrictamente con Zod (`PromotoraFilterSchema`)
 * tanto la categoría (`Fijas` / `Eventuales` / `Merchandising`) como la región oficial
 * (`OCCIDENTE` / `CENTRO` / `ANDES`), estado activo y búsqueda textual.
 */
export function filterPromotorasByRegionAndCategory<T extends Record<string, unknown>>(
  items: readonly T[],
  rawFilters: z.input<typeof PromotoraFilterSchema>,
  options?: {
    resolveRegion?: (item: T) => AllowedRegionCode | null;
    getSearchableText?: (item: T) => string;
  }
): T[] {
  const parsed = PromotoraFilterSchema.parse(rawFilters);
  const qNorm = normalizeTokenNfd(parsed.busqueda);

  return items.filter((item) => {
    if (parsed.soloActivas && item.activo === false) {
      return false;
    }

    const cat = classifyPromotoraCategoriaOficial(item);
    if (parsed.categoria !== 'TODAS' && cat !== parsed.categoria) {
      return false;
    }

    if (parsed.regionId) {
      const rowRegId = String(item.region_id ?? '').trim();
      if (!rowRegId || rowRegId.toLowerCase() !== parsed.regionId.toLowerCase()) {
        return false;
      }
    }

    if (parsed.region !== 'TODAS') {
      const itemRegion = options?.resolveRegion
        ? options.resolveRegion(item)
        : mapLegacySucursalToAllowedRegion(
            item.region ?? item.region_codigo ?? item.sucursal ?? item.estado ?? item.ciudad
          );
      if (itemRegion !== parsed.region) {
        return false;
      }
    }

    if (qNorm) {
      const haystack = normalizeTokenNfd(
        options?.getSearchableText
          ? options.getSearchableText(item)
          : `${item.nombre_completo ?? item.name ?? ''} ${item.email ?? ''} ${item.ciudad ?? ''} ${item.estado ?? ''} ${cat}`
      );
      if (!haystack.includes(qNorm)) {
        return false;
      }
    }

    return true;
  });
}

// =============================================================================
// 3. HELPERS DE AISLAMIENTO REGIONAL LEGADO (5 HUBS OPERATIVOS)
// =============================================================================

export function resolveRowRegionCode(
  row: RegionalRowLike | null | undefined,
  regionesById?: ReadonlyMap<string, RegionLookupLike>
): OperativeSucursal | null {
  if (!row) return null;

  const regionId = String(row.region_id ?? '').trim();
  if (regionId && regionesById && regionesById.has(regionId)) {
    const regionMeta = regionesById.get(regionId)!;
    const fromMeta =
      normalizeSucursalCodigo(regionMeta.codigo) ?? normalizeSucursalCodigo(regionMeta.nombre);
    if (fromMeta && isOperativeSucursal(fromMeta)) {
      return fromMeta;
    }
  }

  for (const candidate of [row.sucursal, row.region_codigo, row.region, row.sede]) {
    const norm = normalizeSucursalCodigo(candidate);
    if (norm && isOperativeSucursal(norm)) {
      return norm;
    }
  }

  return null;
}

const REAL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function matchesActiveRegionalProfile(
  row: RegionalRowLike | null | undefined,
  activeSucursal: OperativeSucursal | null | undefined,
  activeRegionId?: string | null,
  regionesById?: ReadonlyMap<string, RegionLookupLike>
): boolean {
  if (!row || !activeSucursal || !isOperativeSucursal(activeSucursal)) {
    return false;
  }

  const rowRegionId = String(row.region_id ?? '').trim();
  const targetRegionId = String(activeRegionId ?? '').trim();
  const resolvedCode = resolveRowRegionCode(row, regionesById);

  if (!rowRegionId && !resolvedCode) {
    return false;
  }

  if (REAL_UUID_REGEX.test(targetRegionId) && REAL_UUID_REGEX.test(rowRegionId)) {
    return rowRegionId.toLowerCase() === targetRegionId.toLowerCase();
  }

  if (resolvedCode) {
    return resolvedCode === activeSucursal;
  }

  return false;
}

export function filterRowsByActiveRegion<T extends RegionalRowLike>(
  rows: readonly T[],
  activeSucursal: OperativeSucursal | null | undefined,
  activeRegionId?: string | null,
  regionesById?: ReadonlyMap<string, RegionLookupLike>
): T[] {
  if (!activeSucursal || !isOperativeSucursal(activeSucursal)) {
    return [];
  }
  return rows.filter((row) =>
    matchesActiveRegionalProfile(row, activeSucursal, activeRegionId, regionesById)
  );
}
