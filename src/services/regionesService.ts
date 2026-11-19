import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import {
  OPERATIVE_SUCURSALES,
  SUCURSAL_LABELS,
  isOperativeSucursal,
  normalizeSucursalCodigo,
  type OperativeSucursal,
} from './userManagementService';

export interface ActiveRegionItem {
  id: string;
  codigo: OperativeSucursal;
  rawCodigo: string;
  nombre: string;
  label: string;
  activo: boolean;
}

export interface RegionalComparisonParams {
  periodoInicio?: string | null;
  periodoFin?: string | null;
}

/**
 * Fila tipada exacta de las 24 columnas devueltas por
 * `public.rpc_comparativo_regiones_resumen(p_periodo_inicio, p_periodo_fin)`.
 */
export interface RegionalComparisonRow {
  region_id: string;
  region_codigo: OperativeSucursal;
  region_nombre: string;
  clientes_activos: number;
  promotoras_activas: number;
  vendedores_activos: number;
  rutas_programadas: number;
  rutas_completadas: number;
  cumplimiento_rutas_pct: number;
  degustaciones_programadas: number;
  degustaciones_ejecutadas: number;
  muestras_entregadas: number;
  ventas_asistidas: number;
  presupuesto_asignado_usd: number;
  presupuesto_ejecutado_usd: number;
  ejecucion_presupuestaria_pct: number;
  requisiciones_mp07_total: number;
  requisiciones_conciliadas: number;
  pop_items_activos: number;
  pop_stock_critico_count: number;
  incidencias_totales: number;
  incidencias_abiertas: number;
  incidencias_en_sla_count: number;
  cumplimiento_sla_pct: number;
}

export const DEFAULT_FIVE_REGIONES: readonly ActiveRegionItem[] = [
  {
    id: 'reg-default-zulia',
    codigo: 'ZULIA',
    rawCodigo: 'ZULIA',
    nombre: 'Zulia',
    label: SUCURSAL_LABELS.ZULIA,
    activo: true,
  },
  {
    id: 'reg-default-valencia',
    codigo: 'VALENCIA',
    rawCodigo: 'VALENCIA',
    nombre: 'Valencia',
    label: SUCURSAL_LABELS.VALENCIA,
    activo: true,
  },
  {
    id: 'reg-default-centro',
    codigo: 'CENTRO',
    rawCodigo: 'CENTRO',
    nombre: 'Centro',
    label: SUCURSAL_LABELS.CENTRO,
    activo: true,
  },
  {
    id: 'reg-default-oriente',
    codigo: 'ORIENTE',
    rawCodigo: 'ORIENTE',
    nombre: 'Oriente',
    label: SUCURSAL_LABELS.ORIENTE,
    activo: true,
  },
  {
    id: 'reg-default-capital',
    codigo: 'CAPITAL',
    rawCodigo: 'CAPITAL',
    nombre: 'Capital',
    label: SUCURSAL_LABELS.CAPITAL,
    activo: true,
  },
] as const;

const CANONICAL_SORT_RANK: Record<string, number> = {
  ZULIA: 1,
  VALENCIA: 2,
  CENTRO: 3,
  ORIENTE: 4,
  CAPITAL: 5,
};

const DEFAULT_NAMES_BY_CODE: Record<OperativeSucursal, string> = {
  ZULIA: 'Zulia',
  VALENCIA: 'Valencia',
  CENTRO: 'Centro',
  ORIENTE: 'Oriente',
  CAPITAL: 'Capital',
};

function toSafeNumber(value: unknown, decimals?: number): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed)) return 0;
  if (typeof decimals === 'number') {
    const factor = 10 ** decimals;
    return Math.round(parsed * factor) / factor;
  }
  return parsed;
}

function normalizeDateParam(raw?: string | null): string | null {
  const clean = String(raw ?? '').trim();
  if (!clean) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new Error(`Formato de fecha inválido (${clean}). Use YYYY-MM-DD.`);
  }
  return clean;
}

function resolveRegionCodeAndMeta(rawRow: Record<string, unknown>): ActiveRegionItem | null {
  if (rawRow.activo === false) return null;

  const rawId = String(rawRow.id ?? '').trim();
  const rawCodigo = String(rawRow.codigo ?? '').trim();
  const rawNombre = String(rawRow.nombre ?? '').trim();
  if (!rawCodigo && !rawNombre) return null;

  const normFromCodigo = rawCodigo ? normalizeSucursalCodigo(rawCodigo) : null;
  const normFromNombre = rawNombre ? normalizeSucursalCodigo(rawNombre) : null;
  const candidateSucursal = normFromCodigo ?? normFromNombre;

  if (candidateSucursal === 'GLOBAL') {
    return null;
  }

  if (candidateSucursal && isOperativeSucursal(candidateSucursal)) {
    const cleanNombre = rawNombre || DEFAULT_NAMES_BY_CODE[candidateSucursal];
    return {
      id: rawId || `reg-${candidateSucursal.toLowerCase()}`,
      codigo: candidateSucursal,
      rawCodigo: rawCodigo || candidateSucursal,
      nombre: cleanNombre,
      label: SUCURSAL_LABELS[candidateSucursal],
      activo: true,
    };
  }

  // Preservar filas dinámicas adicionales provenientes de `public.regiones`
  const dynamicCode = (rawCodigo || rawNombre)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!dynamicCode) return null;

  const displayNombre = rawNombre || rawCodigo;
  const displayLabel = /^sucursal\b/i.test(displayNombre)
    ? displayNombre
    : `Sucursal ${displayNombre}`;

  return {
    id: rawId || `reg-dyn-${dynamicCode.toLowerCase()}`,
    codigo: dynamicCode as OperativeSucursal,
    rawCodigo: rawCodigo || dynamicCode,
    nombre: displayNombre,
    label: displayLabel,
    activo: true,
  };
}

function sortAndDedupeRegiones(items: ActiveRegionItem[]): ActiveRegionItem[] {
  const byCode = new Map<string, ActiveRegionItem>();
  for (const item of items) {
    const key = `${item.codigo}::${item.id}`;
    if (!byCode.has(item.codigo)) {
      byCode.set(item.codigo, item);
    } else if (!OPERATIVE_SUCURSALES.includes(item.codigo) && !byCode.has(key)) {
      byCode.set(key, item);
    }
  }

  return Array.from(byCode.values()).sort((a, b) => {
    const rankA = CANONICAL_SORT_RANK[a.codigo] ?? 99;
    const rankB = CANONICAL_SORT_RANK[b.codigo] ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    return a.nombre.localeCompare(b.nombre, 'es');
  });
}

function cloneDefaultRegiones(): ActiveRegionItem[] {
  return DEFAULT_FIVE_REGIONES.map((item) => ({ ...item }));
}

/**
 * Consulta las regiones activas desde `rpc_listar_regiones_activas()`, con respaldo
 * automático a `public.regiones` y a las 5 regiones oficiales si está sin conexión.
 */
export async function fetchActiveRegiones(
  customClient?: SupabaseClient | null
): Promise<ActiveRegionItem[]> {
  const client = customClient ?? (isSupabaseConfigured ? getSupabaseClient() : null);
  if (!client) {
    return cloneDefaultRegiones();
  }

  try {
    const rpcRes = await client.rpc('rpc_listar_regiones_activas');
    if (!rpcRes.error && Array.isArray(rpcRes.data) && rpcRes.data.length > 0) {
      const parsed = (rpcRes.data as Record<string, unknown>[])
        .map(resolveRegionCodeAndMeta)
        .filter((r): r is ActiveRegionItem => r !== null);
      if (parsed.length > 0) {
        return sortAndDedupeRegiones(parsed);
      }
    }
  } catch {
    // Continúa al respaldo sobre tabla `public.regiones`
  }

  try {
    const tableRes = await client
      .from('regiones')
      .select('id, codigo, nombre, activo');
    if (!tableRes.error && Array.isArray(tableRes.data) && tableRes.data.length > 0) {
      const parsed = (tableRes.data as Record<string, unknown>[])
        .map(resolveRegionCodeAndMeta)
        .filter((r): r is ActiveRegionItem => r !== null);
      if (parsed.length > 0) {
        return sortAndDedupeRegiones(parsed);
      }
    }
  } catch {
    // Continúa al respaldo estático de las 5 regiones oficiales
  }

  return cloneDefaultRegiones();
}

export function normalizeRegionalComparisonRow(
  raw: Record<string, unknown>
): RegionalComparisonRow {
  const rawCode = String(raw.region_codigo ?? '').trim();
  const rawName = String(raw.region_nombre ?? '').trim();
  const normSucursal =
    normalizeSucursalCodigo(rawCode) ?? normalizeSucursalCodigo(rawName);
  const effectiveCode: OperativeSucursal =
    normSucursal && isOperativeSucursal(normSucursal)
      ? normSucursal
      : ((rawCode.toUpperCase() || 'ZULIA') as OperativeSucursal);

  const effectiveName =
    rawName ||
    (isOperativeSucursal(effectiveCode)
      ? DEFAULT_NAMES_BY_CODE[effectiveCode]
      : effectiveCode);

  return {
    region_id: String(raw.region_id ?? `reg-${effectiveCode.toLowerCase()}`),
    region_codigo: effectiveCode,
    region_nombre: effectiveName,
    clientes_activos: Math.trunc(toSafeNumber(raw.clientes_activos)),
    promotoras_activas: Math.trunc(toSafeNumber(raw.promotoras_activas)),
    vendedores_activos: Math.trunc(toSafeNumber(raw.vendedores_activos)),
    rutas_programadas: Math.trunc(toSafeNumber(raw.rutas_programadas)),
    rutas_completadas: Math.trunc(toSafeNumber(raw.rutas_completadas)),
    cumplimiento_rutas_pct: toSafeNumber(raw.cumplimiento_rutas_pct, 2),
    degustaciones_programadas: Math.trunc(toSafeNumber(raw.degustaciones_programadas)),
    degustaciones_ejecutadas: Math.trunc(toSafeNumber(raw.degustaciones_ejecutadas)),
    muestras_entregadas: Math.trunc(toSafeNumber(raw.muestras_entregadas)),
    ventas_asistidas: Math.trunc(toSafeNumber(raw.ventas_asistidas)),
    presupuesto_asignado_usd: toSafeNumber(raw.presupuesto_asignado_usd, 2),
    presupuesto_ejecutado_usd: toSafeNumber(raw.presupuesto_ejecutado_usd, 2),
    ejecucion_presupuestaria_pct: toSafeNumber(raw.ejecucion_presupuestaria_pct, 2),
    requisiciones_mp07_total: Math.trunc(toSafeNumber(raw.requisiciones_mp07_total)),
    requisiciones_conciliadas: Math.trunc(toSafeNumber(raw.requisiciones_conciliadas)),
    pop_items_activos: Math.trunc(toSafeNumber(raw.pop_items_activos)),
    pop_stock_critico_count: Math.trunc(toSafeNumber(raw.pop_stock_critico_count)),
    incidencias_totales: Math.trunc(toSafeNumber(raw.incidencias_totales)),
    incidencias_abiertas: Math.trunc(toSafeNumber(raw.incidencias_abiertas)),
    incidencias_en_sla_count: Math.trunc(toSafeNumber(raw.incidencias_en_sla_count)),
    cumplimiento_sla_pct: toSafeNumber(raw.cumplimiento_sla_pct, 2),
  };
}

/**
 * Consulta el comparativo ejecutivo consolidado multi-región (`rpc_comparativo_regiones_resumen`).
 * Exclusivo en BD para `super_admin` y `contraloria` (`SECURITY DEFINER`).
 */
export async function fetchComparativoRegionesResumen(
  params?: RegionalComparisonParams,
  customClient?: SupabaseClient | null
): Promise<RegionalComparisonRow[]> {
  const periodoInicio = normalizeDateParam(params?.periodoInicio);
  const periodoFin = normalizeDateParam(params?.periodoFin);

  if (periodoInicio && periodoFin && periodoFin < periodoInicio) {
    throw new Error('El período final no puede ser anterior al período inicial.');
  }

  const client = customClient ?? (isSupabaseConfigured ? getSupabaseClient() : null);
  if (!client) {
    return [];
  }

  const { data, error } = await client.rpc('rpc_comparativo_regiones_resumen', {
    p_periodo_inicio: periodoInicio,
    p_periodo_fin: periodoFin,
  });

  if (error) {
    throw new Error(
      error.message || 'No se pudo obtener el resumen comparativo por región.'
    );
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return (data as Record<string, unknown>[])
    .map(normalizeRegionalComparisonRow)
    .sort((a, b) => {
      const rankA = CANONICAL_SORT_RANK[a.region_codigo] ?? 99;
      const rankB = CANONICAL_SORT_RANK[b.region_codigo] ?? 99;
      if (rankA !== rankB) return rankA - rankB;
      return a.region_nombre.localeCompare(b.region_nombre, 'es');
    });
}
