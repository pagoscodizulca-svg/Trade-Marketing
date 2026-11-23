import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ScheduledVisit, ShiftType, Store, User } from '../types';
import {
  calculateMultiProductSupplies,
  calculateProductionSupplies,
  normalizeProductionShift,
} from '../utils/productionSuppliesCalculator';
import { matchesDateFilter, normalizeExcelDate } from '../utils/excelDateNormalizer';
import { canonicalStaffKey, formatDayLabelEs, getTodayVeYmd } from './supabaseModule1';
import { getSupabaseCoordinatorClient, isSupabaseConfigured } from './supabaseClient';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const UNASSIGNED_PROMOTORA_LABEL = 'POR ASIGNAR (Trade Marketing)';

export function isRealUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

/**
 * Normalización insensible a acentos/diacríticos (NFD) para búsquedas en matriz y maestros.
 */
export function normalizeSearchText(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Construye el catálogo unificado de `stores` dando prioridad absoluta a `public.clientes`
 * (`useMasterData`) y complementando sin duplicar con PDVs descubiertos en sincronizaciones operativas.
 */
export function mergeMasterStoresWithFallback(
  masterStores: readonly Store[],
  fallbackStores: readonly Store[]
): Store[] {
  const result: Store[] = [];
  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  const seenNames = new Set<string>();

  const register = (s: Store) => {
    const cleanName = String(s.name || '').trim();
    if (!cleanName || /^PDV SIN NOMBRE$/i.test(cleanName)) return;
    const normName = normalizeSearchText(cleanName);
    const normCode = String(s.clientCode || '').trim().toUpperCase();

    if (s.id && seenIds.has(s.id)) return;
    if (normCode && seenCodes.has(normCode)) return;
    if (seenNames.has(normName)) return;

    if (s.id) seenIds.add(s.id);
    if (normCode) seenCodes.add(normCode);
    seenNames.add(normName);
    result.push(s);
  };

  for (const ms of masterStores) register(ms);
  for (const fs of fallbackStores) register(fs);

  return result;
}

/**
 * Resuelve una promotora real con UUID válido a partir del padrón sincronizado `users`.
 * Jamás fabrica identificadores ficticios (`usr_prom_01`).
 */
export function resolveRealPromotoraForMatrix(
  users: readonly User[],
  requestedName?: string,
  occupiedKeys?: ReadonlySet<string>
): { promotoraId: string; promotoraName: string } {
  const activePromotoras = users.filter(
    (u) => u.role === 'promotora' && Boolean(u.name?.trim())
  );

  const rawReq = String(requestedName || '').trim();
  const isPlaceholder =
    !rawReq ||
    rawReq.toUpperCase().startsWith('POR ASIGNAR') ||
    rawReq.toUpperCase().startsWith('SIN ASIGNAR') ||
    rawReq.toUpperCase() === 'AUTO';

  if (!isPlaceholder) {
    const reqKey = canonicalStaffKey(rawReq);
    const exact = activePromotoras.find((u) => canonicalStaffKey(u.name) === reqKey);
    if (exact && (!occupiedKeys || !occupiedKeys.has(reqKey))) {
      return {
        promotoraId: isRealUuid(exact.id) ? exact.id : '',
        promotoraName: exact.name.trim(),
      };
    }
  }

  const free = activePromotoras.find(
    (u) => !occupiedKeys || !occupiedKeys.has(canonicalStaffKey(u.name))
  );
  if (free) {
    return {
      promotoraId: isRealUuid(free.id) ? free.id : '',
      promotoraName: free.name.trim(),
    };
  }

  return {
    promotoraId: '',
    promotoraName: UNASSIGNED_PROMOTORA_LABEL,
  };
}

export interface MatrixFilterCriteria {
  selectedDay: string;
  matrixDateFrom: string;
  matrixDateTo: string;
  selectedShift: string;
  selectedProduct: string;
  searchQuery: string;
  currentWeekBounds: { mondayYmd: string; sundayYmd: string };
  rollingWeekBounds: { mondayYmd: string; sundayYmd: string };
  currentYearMonth: string;
}

export function matchesMatrixDayFilter(
  rawDate: string | undefined,
  rawDayLabel: string | undefined,
  criteria: Pick<
    MatrixFilterCriteria,
    | 'selectedDay'
    | 'matrixDateFrom'
    | 'matrixDateTo'
    | 'currentWeekBounds'
    | 'rollingWeekBounds'
    | 'currentYearMonth'
  >
): boolean {
  const parsedRecord = normalizeExcelDate(rawDate);

  if (criteria.matrixDateFrom.trim() || criteria.matrixDateTo.trim()) {
    return matchesDateFilter(
      rawDate,
      { desde: criteria.matrixDateFrom, hasta: criteria.matrixDateTo },
      parsedRecord.fechaTimestamp
    );
  }

  if (criteria.selectedDay === 'TODOS') return true;
  const ymd = parsedRecord.fechaIso;

  if (criteria.selectedDay === 'SEMANA_ACTUAL') {
    return matchesDateFilter(
      rawDate,
      {
        desde: criteria.currentWeekBounds.mondayYmd,
        hasta: criteria.currentWeekBounds.sundayYmd,
      },
      parsedRecord.fechaTimestamp
    );
  }
  if (criteria.selectedDay === 'SEMANA_NAV') {
    return matchesDateFilter(
      rawDate,
      {
        desde: criteria.rollingWeekBounds.mondayYmd,
        hasta: criteria.rollingWeekBounds.sundayYmd,
      },
      parsedRecord.fechaTimestamp
    );
  }
  if (criteria.selectedDay === 'MES_ACTUAL') {
    return Boolean(ymd && ymd.slice(0, 7) === criteria.currentYearMonth);
  }
  if (/^\d{4}-\d{2}$/.test(criteria.selectedDay)) {
    return Boolean(ymd && ymd.slice(0, 7) === criteria.selectedDay);
  }
  const parsedSelectedSingle = normalizeExcelDate(criteria.selectedDay);
  if (parsedSelectedSingle.isValid) {
    return matchesDateFilter(
      rawDate,
      { fechaUnica: criteria.selectedDay },
      parsedRecord.fechaTimestamp
    );
  }
  return Boolean(
    rawDayLabel === criteria.selectedDay ||
      rawDate === criteria.selectedDay ||
      (rawDayLabel && rawDayLabel.includes(criteria.selectedDay))
  );
}

/**
 * Filtra las filas visibles de `ScheduleMatrixView` soportando rangos de fechas explícitos,
 * cualquier producto del catálogo y búsqueda insensible a tildes (NFD).
 */
export function filterMatrixVisits(
  visits: readonly ScheduledVisit[],
  criteria: MatrixFilterCriteria
): ScheduledVisit[] {
  const normProdFilter = normalizeSearchText(criteria.selectedProduct);
  const normQuery = normalizeSearchText(criteria.searchQuery);

  return visits.filter((v) => {
    if (!matchesMatrixDayFilter(v.date, v.dayLabel, criteria)) return false;
    if (criteria.selectedShift !== 'TODOS' && v.shift !== criteria.selectedShift) return false;
    if (criteria.selectedProduct !== 'TODOS' && normProdFilter) {
      const hay = normalizeSearchText(`${v.productFocus} ${v.fillProductSelection ?? ''}`);
      if (!hay.includes(normProdFilter)) return false;
    }
    if (normQuery) {
      const hay = normalizeSearchText(
        `${v.storeName} ${v.promotoraName} ${v.sellerName} ${v.zone} ${v.productFocus}`
      );
      if (!hay.includes(normQuery)) return false;
    }
    return true;
  });
}

// =============================================================================
// ESQUEMA ZOD Y PAYLOAD DE PERSISTENCIA HACIA `cronograma_degustaciones`
// =============================================================================

export const MatrixUpsertRowSchema = z.object({
  id: z.string().regex(UUID_REGEX).nullable().optional(),
  client_temp_id: z.string().max(120).optional(),
  fecha: z.string().regex(YMD_REGEX, 'La fecha debe tener formato YYYY-MM-DD.'),
  turno: z.enum(['MAÑANA', 'TARDE', 'COMPLETO']),
  hora_inicio: z.string().min(4).max(16).optional(),
  hora_fin: z.string().min(4).max(16).optional(),
  cliente_nombre: z.string().trim().min(2, 'El nombre del cliente / PDV es obligatorio.').max(200),
  cliente_codigo: z.string().trim().max(80).optional().default(''),
  zona_direccion: z.string().trim().max(240).optional().default(''),
  producto_resumen: z.string().trim().min(1, 'El producto es obligatorio.').max(160),
  productos: z.array(z.string().trim().min(1).max(160)).min(1),
  cantidad_kilos: z.number().finite().positive('La cantidad debe ser mayor a 0.'),
  personas_estimadas: z.number().int().min(0).max(50000).optional().default(0),
  insumos_calculados: z.record(z.string(), z.unknown()).optional().default({}),
  vendedor_fdv: z.string().trim().max(160).optional().default(''),
  promotora_id: z.string().regex(UUID_REGEX).nullable().optional(),
  promotora_nombre: z.string().trim().max(180).optional().default(''),
  promotora_email: z.string().trim().max(180).optional().default(''),
  sucursal: z.string().trim().max(40).optional().default(''),
  observaciones: z.string().trim().max(1000).optional().default(''),
  idempotency_hash: z.string().trim().max(128).optional(),
});

export type MatrixUpsertRowInput = z.infer<typeof MatrixUpsertRowSchema>;

export interface MatrixSavedRowResult {
  id: string;
  client_temp_id?: string | null;
  cliente_nombre: string;
  fecha: string;
  turno: ShiftType;
  estado: string;
  promotora_id: string | null;
  promotora_nombre: string | null;
  sucursal?: string | null;
}

export interface MatrixUpsertBatchResult {
  ok: boolean;
  insertadas: number;
  actualizadas: number;
  filas: MatrixSavedRowResult[];
}

export interface MatrixLogicalCancelResult {
  ok: boolean;
  canceladas: number;
  preservadas_historicas: number;
  ids_cancelados: string[];
}

function defaultWindowForShift(shift: ShiftType): { horaInicio: string; horaFin: string } {
  if (shift === 'TARDE') return { horaInicio: '14:00', horaFin: '18:00' };
  if (shift === 'COMPLETO') return { horaInicio: '09:00', horaFin: '17:00' };
  return { horaInicio: '09:00', horaFin: '13:00' };
}

export function buildMatrixUpsertRowFromVisit(
  visit: ScheduledVisit,
  options?: { clientCode?: string; clientTempId?: string; promotoraEmail?: string; sucursal?: string }
): MatrixUpsertRowInput {
  const shift = normalizeProductionShift(visit.shift);
  const { horaInicio, horaFin } = defaultWindowForShift(shift);
  const resolvedCronId = isRealUuid(visit.cronogramaId)
    ? visit.cronogramaId
    : isRealUuid(visit.id) && !visit.solicitudId
      ? visit.id
      : null;
  const resolvedPromotoraId = isRealUuid(visit.promotoraId) ? visit.promotoraId : null;
  const rawSelectedProducts = Array.isArray(visit.selectedProducts)
    ? Array.from(
        new Set(
          visit.selectedProducts
            .map((p) => String(p ?? '').trim().toUpperCase().slice(0, 160))
            .filter(Boolean)
        )
      )
    : [];
  const rawSummary = String(
    rawSelectedProducts.length > 0
      ? rawSelectedProducts.join(' + ')
      : visit.productFocus || visit.fillProductSelection || 'MORTADELA'
  )
    .trim()
    .toUpperCase();
  const productSummary =
    rawSummary.length > 160 ? `${rawSummary.slice(0, 157).trimEnd()}...` : rawSummary || 'MORTADELA';
  const productosArray = rawSelectedProducts.length > 0 ? rawSelectedProducts : [productSummary];
  const qtyNumeric = Math.max(
    0.1,
    Number(
      visit.plannedUnits ||
        visit.mortadelaQty ||
        visit.espaldaQty ||
        visit.arrozQty ||
        parseFloat(String(visit.fillQuantityInput || '1')) ||
        1
    )
  );

  return MatrixUpsertRowSchema.parse({
    id: resolvedCronId,
    client_temp_id: options?.clientTempId ?? visit.id,
    fecha: YMD_REGEX.test(visit.date) ? visit.date : getTodayVeYmd(),
    turno: shift,
    hora_inicio: horaInicio,
    hora_fin: horaFin,
    cliente_nombre: String(visit.storeName || '').trim(),
    cliente_codigo: String(options?.clientCode || '').trim().toUpperCase(),
    zona_direccion: String(visit.zone || '').trim(),
    producto_resumen: productSummary,
    productos: productosArray,
    cantidad_kilos: Number(qtyNumeric.toFixed(2)),
    personas_estimadas: Math.max(0, Math.round(visit.operationalSupplies?.estimatedPortions || 0)),
    insumos_calculados: {
      mortadela_qty: visit.mortadelaQty || 0,
      espalda_qty: visit.espaldaQty || 0,
      arroz_qty: visit.arrozQty || 0,
      azucar_grams: visit.azucarGrams || 0,
      leche_grams: visit.lecheGrams || 0,
      fill_product: visit.fillProductSelection || productSummary,
      fill_quantity: visit.fillQuantityInput || String(qtyNumeric),
      selected_products: productosArray,
      operational_supplies: visit.operationalSupplies ?? null,
    },
    vendedor_fdv: String(visit.sellerName || '').trim(),
    promotora_id: resolvedPromotoraId,
    promotora_nombre: String(visit.promotoraName || '').trim() || UNASSIGNED_PROMOTORA_LABEL,
    promotora_email: String(options?.promotoraEmail || '').trim().toLowerCase(),
    sucursal: String(options?.sucursal || '').trim().toUpperCase(),
    observaciones: String(visit.notes || '').trim(),
  });
}

/**
 * Planifica un llenado por lote en forma pura sin mutar arrays externos y sin IDs falsos (`usr_prom_01`).
 */
export function buildBatchFillPlan(params: {
  existingVisits: readonly ScheduledVisit[];
  stores: readonly Store[];
  users: readonly User[];
  storeIds: readonly string[];
  product: string;
  products?: readonly string[];
  quantityInput: string;
  shift: ShiftType;
  dayLabel: string;
  date?: string;
  promotoraName?: string;
  sellerName?: string;
  notes?: string;
}): {
  nextVisits: ScheduledVisit[];
  affectedVisits: ScheduledVisit[];
  countUpdated: number;
  countCreated: number;
} {
  const effectiveDate = params.date && YMD_REGEX.test(params.date) ? params.date : getTodayVeYmd();
  const effectiveDayLabel = params.dayLabel || formatDayLabelEs(effectiveDate);
  const effectiveProducts = Array.from(
    new Set(
      (params.products && params.products.length > 0 ? params.products : [params.product])
        .map((p) => String(p ?? '').trim())
        .filter(Boolean)
    )
  );
  const calc =
    effectiveProducts.length > 1
      ? calculateMultiProductSupplies(effectiveProducts, params.quantityInput)
      : calculateProductionSupplies(effectiveProducts[0] || params.product, params.quantityInput);
  const uniqueStoreIds = Array.from(new Set(params.storeIds));

  const sameSlot = (v: ScheduledVisit) =>
    v.shift === params.shift &&
    (v.date ? v.date === effectiveDate : v.dayLabel === effectiveDayLabel);

  const nextVisits = [...params.existingVisits];
  const affectedVisits: ScheduledVisit[] = [];
  const visitedStoreIds = new Set<string>();
  let countUpdated = 0;
  let countCreated = 0;

  for (let i = 0; i < nextVisits.length; i++) {
    const v = nextVisits[i]!;
    if (uniqueStoreIds.includes(v.storeId) && sameSlot(v)) {
      visitedStoreIds.add(v.storeId);
      const resolvedProm = params.promotoraName
        ? resolveRealPromotoraForMatrix(params.users, params.promotoraName)
        : null;
      const updated: ScheduledVisit = {
        ...v,
        date: effectiveDate,
        dayLabel: effectiveDayLabel,
        productFocus: calc.productFocus,
        selectedProducts: effectiveProducts,
        fillProductSelection: calc.fillProductSelection,
        fillQuantityInput: calc.fillQuantityInput,
        mortadelaQty: calc.mortadelaQty,
        espaldaQty: calc.espaldaQty,
        arrozQty: calc.arrozQty,
        azucarGrams: calc.azucarGrams,
        lecheGrams: calc.lecheGrams,
        plannedUnits: calc.plannedUnits,
        rowHighlight: calc.rowHighlight,
        promotoraId: resolvedProm ? resolvedProm.promotoraId : v.promotoraId,
        promotoraName: resolvedProm ? resolvedProm.promotoraName : v.promotoraName,
        sellerName: params.sellerName || v.sellerName,
        notes: params.notes !== undefined ? params.notes.trim() : v.notes,
        additionalGoods: calc.additionalGoods,
        operationalSupplies: calc.operationalSupplies,
      };
      nextVisits[i] = updated;
      affectedVisits.push(updated);
      countUpdated += 1;
    }
  }

  const occupiedPromotoraKeys = new Set<string>();
  for (const v of nextVisits) {
    if (
      sameSlot(v) &&
      v.promotoraName &&
      !v.promotoraName.toUpperCase().startsWith('POR ASIGNAR') &&
      !v.promotoraName.toUpperCase().startsWith('SIN ASIGNAR')
    ) {
      occupiedPromotoraKeys.add(canonicalStaffKey(v.promotoraName));
    }
  }

  for (const storeId of uniqueStoreIds) {
    if (visitedStoreIds.has(storeId)) continue;
    const storeObj = params.stores.find((s) => s.id === storeId);
    if (!storeObj) continue;

    const assigned = resolveRealPromotoraForMatrix(
      params.users,
      params.promotoraName,
      occupiedPromotoraKeys
    );
    if (assigned.promotoraName !== UNASSIGNED_PROMOTORA_LABEL) {
      occupiedPromotoraKeys.add(canonicalStaffKey(assigned.promotoraName));
    }

    const tempId = `vis_pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${storeObj.id}`;
    const newVisit: ScheduledVisit = {
      id: tempId,
      date: effectiveDate,
      dayLabel: effectiveDayLabel,
      shift: params.shift,
      storeId: storeObj.id,
      storeName: storeObj.name,
      zone: storeObj.zone,
      productFocus: calc.productFocus,
      selectedProducts: effectiveProducts,
      fillProductSelection: calc.fillProductSelection,
      fillQuantityInput: calc.fillQuantityInput,
      promotoraId: assigned.promotoraId,
      promotoraName: assigned.promotoraName,
      sellerName: params.sellerName || storeObj.sellerName || 'FDV Codizulca',
      plannedUnits: calc.plannedUnits,
      mortadelaQty: calc.mortadelaQty,
      espaldaQty: calc.espaldaQty,
      arrozQty: calc.arrozQty,
      azucarGrams: calc.azucarGrams,
      lecheGrams: calc.lecheGrams,
      rowHighlight: calc.rowHighlight,
      status: 'PENDIENTE',
      ...(params.notes?.trim() ? { notes: params.notes.trim() } : {}),
      additionalGoods: calc.additionalGoods,
      operationalSupplies: calc.operationalSupplies,
    };

    nextVisits.unshift(newVisit);
    affectedVisits.push(newVisit);
    countCreated += 1;
  }

  return { nextVisits, affectedVisits, countUpdated, countCreated };
}

/**
 * Clasifica registros seleccionados para cancelación lógica sin borrado físico.
 */
export function classifyVisitsForLogicalCancel(
  visits: readonly ScheduledVisit[],
  targetIds: readonly string[]
): {
  cancelableCronogramaIds: string[];
  localOnlyIds: string[];
  preservedHistoricalIds: string[];
} {
  const idSet = new Set(targetIds.filter(Boolean));
  const cancelableCronogramaIds: string[] = [];
  const localOnlyIds: string[] = [];
  const preservedHistoricalIds: string[] = [];

  for (const v of visits) {
    if (!idSet.has(v.id)) continue;
    if (v.enHistorial || v.status === 'COMPLETADA') {
      preservedHistoricalIds.push(v.id);
      continue;
    }
    const dbUuid = isRealUuid(v.cronogramaId)
      ? v.cronogramaId
      : isRealUuid(v.id)
        ? v.id
        : null;
    if (dbUuid) {
      cancelableCronogramaIds.push(dbUuid);
    } else {
      localOnlyIds.push(v.id);
    }
  }

  return {
    cancelableCronogramaIds: Array.from(new Set(cancelableCronogramaIds)),
    localOnlyIds,
    preservedHistoricalIds,
  };
}

function isMissingRpcError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim();
  const msg = String(err.message || '').toLowerCase();
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    (msg.includes('function') && (msg.includes('does not exist') || msg.includes('schema cache')))
  );
}

function formatChoferDeliveryDateLabel(ymd: string): string {
  const label = formatDayLabelEs(ymd).toUpperCase().trim();
  // formatDayLabelEs devuelve p.ej. "LUNES 23/11" -> normalizamos a "LUNES 23" para DayTabs de App Chofer
  const match = label.match(/^([A-ZÁÉÍÓÚÑ]+)\s+(\d{1,2})/);
  if (match) {
    return `${match[1]} ${match[2]!.padStart(2, '0')}`;
  }
  return ymd;
}

function resolveSafeSucursalCode(raw: string | null | undefined): string {
  const upper = String(raw || '').trim().toUpperCase();
  if (upper === 'ZULIA' || upper === 'VALENCIA' || upper === 'CENTRO' || upper === 'ORIENTE' || upper === 'CAPITAL') {
    return upper;
  }
  if (upper === 'OCCIDENTE' || upper === 'ANDES') return 'ZULIA';
  return 'ZULIA';
}

function generateClientUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatMatrixWriteError(
  error: { code?: string; message?: string; hint?: string; details?: string } | null | undefined,
  fallback: string
): Error {
  const code = String(error?.code ?? '').trim().toUpperCase();
  const message = String(error?.message ?? '').trim();
  const lower = message.toLowerCase();
  if (code === '42501' || lower.includes('permission denied') || lower.includes('row-level security')) {
    return new Error(
      `Permiso denegado por RLS al agendar en Supabase (${code || '42501'}). Verifica tu rol y las políticas de cronograma_degustaciones.`
    );
  }
  if (code === 'PGRST205' || code === '42P01' || lower.includes('could not find the table')) {
    return new Error(
      'La tabla cronograma_degustaciones no existe todavía en Supabase. Aplica la migración SQL de degustaciones y reintenta.'
    );
  }
  return new Error(message || fallback);
}

/**
 * Sincroniza de forma segura (best-effort, sin romper la escritura primaria) cada degustación agendada
 * hacia `public.rutas_promotoras` (App Promotoras `/portal`) y `public.entregas_degustacion` (App Chofer `/logistica/`).
 */
async function syncScheduledRowsToDownstreamApps(
  client: SupabaseClient,
  pairs: ReadonlyArray<{ row: MatrixUpsertRowInput; saved: MatrixSavedRowResult }>,
  options: { syncPromotoraRoute: boolean; syncChoferDelivery: boolean }
): Promise<void> {
  if (pairs.length === 0) return;

  for (const { row, saved } of pairs) {
    const cronogramaId = saved.id;
    if (!isRealUuid(cronogramaId)) continue;

    const cleanPromNombre =
      String(saved.promotora_nombre || row.promotora_nombre || '').trim() ||
      UNASSIGNED_PROMOTORA_LABEL;
    const cleanPromEmail = String(row.promotora_email || '').trim().toLowerCase() || null;
    const cleanSucursal = resolveSafeSucursalCode(saved.sucursal || row.sucursal);
    const shiftWindow = defaultWindowForShift(row.turno);
    const horaInicio = row.hora_inicio || shiftWindow.horaInicio;
    const horaFin = row.hora_fin || shiftWindow.horaFin;

    if (options.syncPromotoraRoute) {
      try {
        const existingRuta = await client
          .from('rutas_promotoras')
          .select('id')
          .eq('cronograma_id', cronogramaId)
          .limit(1);

        const rutaPayload: Record<string, unknown> = {
          cronograma_id: cronogramaId,
          fecha: row.fecha,
          turno: row.turno,
          hora_inicio: horaInicio,
          hora_fin: horaFin,
          cliente_nombre: row.cliente_nombre,
          cliente_codigo: row.cliente_codigo,
          zona_direccion: row.zona_direccion,
          producto_resumen: row.producto_resumen,
          productos: row.productos,
          cantidad_kilos: row.cantidad_kilos,
          vendedor_fdv: row.vendedor_fdv,
          promotora_id: row.promotora_id ?? null,
          promotora_nombre: cleanPromNombre,
          promotora_email: cleanPromEmail,
          estado_ruta: 'ASIGNADA',
          observaciones: row.observaciones,
          sucursal: cleanSucursal,
        };

        const existingId = Array.isArray(existingRuta.data) ? existingRuta.data[0]?.id : null;
        if (!existingRuta.error && existingId) {
          const updRuta = await client
            .from('rutas_promotoras')
            .update(rutaPayload)
            .eq('id', existingId)
            .select('id');
          if (updRuta.error) {
            console.warn('[syncScheduledRowsToDownstreamApps] Error actualizando rutas_promotoras:', {
              code: updRuta.error.code,
              message: updRuta.error.message,
              cronogramaId,
            });
          }
        } else if (!existingRuta.error) {
          const insRuta = await client
            .from('rutas_promotoras')
            .insert(rutaPayload)
            .select('id');
          if (insRuta.error) {
            console.warn('[syncScheduledRowsToDownstreamApps] Error insertando en rutas_promotoras:', {
              code: insRuta.error.code,
              message: insRuta.error.message,
              cronogramaId,
            });
          }
        }
      } catch (err) {
        console.warn('[syncScheduledRowsToDownstreamApps] Fallo best-effort en rutas_promotoras:', err);
      }
    }

    if (options.syncChoferDelivery) {
      try {
        const choferTurno = row.turno === 'TARDE' ? 'TARDE' : 'MAÑANA';
        const deliveryPayload: Record<string, unknown> = {
          cronograma_id: cronogramaId,
          fecha: formatChoferDeliveryDateLabel(row.fecha),
          turno: choferTurno,
          numero_grupo_turno: `${choferTurno} · ${row.fecha}`,
          cliente: row.cliente_nombre.toUpperCase(),
          producto: row.producto_resumen.toUpperCase().slice(0, 120),
          vendedor: (row.vendedor_fdv || 'TRADE MARKETING').toUpperCase(),
          promotora: cleanPromNombre.toUpperCase(),
          notas_chofer: row.observaciones || '',
          sucursal: cleanSucursal,
        };

        const existingEntrega = await client
          .from('entregas_degustacion')
          .select('id')
          .eq('cronograma_id', cronogramaId)
          .limit(1);

        const existingEntregaId = Array.isArray(existingEntrega.data)
          ? existingEntrega.data[0]?.id
          : null;

        if (!existingEntrega.error && existingEntregaId) {
          const updEnt = await client
            .from('entregas_degustacion')
            .update(deliveryPayload)
            .eq('id', existingEntregaId)
            .select('id');
          if (updEnt.error) {
            console.warn('[syncScheduledRowsToDownstreamApps] Error actualizando entregas_degustacion:', {
              code: updEnt.error.code,
              message: updEnt.error.message,
              cronogramaId,
            });
          }
        } else if (!existingEntrega.error) {
          const insEnt = await client
            .from('entregas_degustacion')
            .insert({
              id: generateClientUuid(),
              ...deliveryPayload,
              stand_entregado: false,
              producto_entregado: false,
              completado: false,
              estado_logistico: 'PENDIENTE',
              hora_entrega: null,
            })
            .select('id');
          if (insEnt.error) {
            console.warn('[syncScheduledRowsToDownstreamApps] Error insertando en entregas_degustacion:', {
              code: insEnt.error.code,
              message: insEnt.error.message,
              cronogramaId,
            });
          }
        }
      } catch (err) {
        console.warn('[syncScheduledRowsToDownstreamApps] Fallo best-effort en entregas_degustacion:', err);
      }
    }
  }
}

/**
 * Persiste alta, edición o llenado por lote en `public.cronograma_degustaciones` mediante la RPC
 * `public.rpc_upsert_matriz_cronograma_lote` (o respaldo directo con cascada a App Promotoras y App Chofer).
 * Lanza error ante cualquier fallo para permitir reversión.
 */
export async function persistMatrixUpsertBatch(
  rows: readonly MatrixUpsertRowInput[],
  clientOverride?: SupabaseClient
): Promise<MatrixUpsertBatchResult> {
  if (rows.length === 0) {
    return { ok: true, insertadas: 0, actualizadas: 0, filas: [] };
  }

  const validatedRows = rows.map((r) => MatrixUpsertRowSchema.parse(r));

  if (!clientOverride && !isSupabaseConfigured) {
    throw new Error('Supabase no está configurado: no se pueden persistir cambios en la matriz.');
  }

  const client = clientOverride ?? getSupabaseCoordinatorClient();
  const rpcRes = await client.rpc('rpc_upsert_matriz_cronograma_lote', {
    p_filas: validatedRows,
  });

  if (!rpcRes.error && rpcRes.data) {
    const body = rpcRes.data as Partial<MatrixUpsertBatchResult>;
    const filas = Array.isArray(body.filas) ? body.filas : [];
    const pairs = filas
      .map((saved, idx) => ({
        saved,
        row:
          validatedRows.find((r) => r.client_temp_id && r.client_temp_id === saved.client_temp_id) ??
          validatedRows[idx],
      }))
      .filter((p): p is { row: MatrixUpsertRowInput; saved: MatrixSavedRowResult } => Boolean(p.row));
    // La RPC ya gestiona rutas_promotoras; propagamos entregas_degustacion (App Chofer) en best-effort
    await syncScheduledRowsToDownstreamApps(client, pairs, {
      syncPromotoraRoute: false,
      syncChoferDelivery: true,
    });
    return {
      ok: body.ok !== false,
      insertadas: Number(body.insertadas ?? 0),
      actualizadas: Number(body.actualizadas ?? 0),
      filas,
    };
  }

  if (rpcRes.error && !isMissingRpcError(rpcRes.error)) {
    console.error('[persistMatrixUpsertBatch] Error en RPC rpc_upsert_matriz_cronograma_lote', {
      code: rpcRes.error.code,
      message: rpcRes.error.message,
      hint: rpcRes.error.hint,
      details: rpcRes.error.details,
    });
    throw formatMatrixWriteError(
      rpcRes.error,
      'No se pudo persistir el lote en cronograma_degustaciones.'
    );
  }

  // Respaldo directo compatible con PostgREST + cascada a rutas_promotoras y entregas_degustacion
  const savedRows: MatrixSavedRowResult[] = [];
  const savedPairs: Array<{ row: MatrixUpsertRowInput; saved: MatrixSavedRowResult }> = [];
  let insertadas = 0;
  let actualizadas = 0;

  for (const row of validatedRows) {
    const cleanPromNombre =
      String(row.promotora_nombre || '').trim() || UNASSIGNED_PROMOTORA_LABEL;
    const cleanPromEmail = String(row.promotora_email || '').trim().toLowerCase() || null;
    const cleanSucursal = resolveSafeSucursalCode(row.sucursal);
    const payload: Record<string, unknown> = {
      fecha: row.fecha,
      turno: row.turno,
      hora_inicio: row.hora_inicio || defaultWindowForShift(row.turno).horaInicio,
      hora_fin: row.hora_fin || defaultWindowForShift(row.turno).horaFin,
      cliente_nombre: row.cliente_nombre,
      cliente_codigo: row.cliente_codigo,
      zona_direccion: row.zona_direccion,
      producto_resumen: row.producto_resumen,
      productos: row.productos,
      cantidad_kilos: row.cantidad_kilos,
      personas_estimadas: row.personas_estimadas,
      insumos_calculados: row.insumos_calculados,
      vendedor_fdv: row.vendedor_fdv,
      promotora_id: row.promotora_id ?? null,
      promotora_nombre: cleanPromNombre,
      promotora_email: cleanPromEmail,
      observaciones: row.observaciones,
      sucursal: cleanSucursal,
      // Agendamiento directo desde Trade Marketing (Módulo 2) queda APROBADA para persistir tras F5 y reflejarse en apps de campo
      estado: 'APROBADA',
    };

    if (row.id) {
      const upd = await client
        .from('cronograma_degustaciones')
        .update(payload)
        .eq('id', row.id)
        .select('id, cliente_nombre, fecha, turno, estado, promotora_id, promotora_nombre');
      if (upd.error) {
        console.error('[persistMatrixUpsertBatch] Error en UPDATE cronograma_degustaciones', {
          code: upd.error.code,
          message: upd.error.message,
          hint: upd.error.hint,
          details: upd.error.details,
          id: row.id,
        });
        throw formatMatrixWriteError(upd.error, `Error actualizando fila ${row.cliente_nombre}.`);
      }
      const rowsReturned = Array.isArray(upd.data) ? upd.data : upd.data ? [upd.data] : [];
      if (rowsReturned.length === 0) {
        console.error('[persistMatrixUpsertBatch] UPDATE devolvió 0 filas (posible RLS o ID inexistente)', {
          id: row.id,
          cliente: row.cliente_nombre,
        });
        throw new Error(
          `No se actualizó la degustación de ${row.cliente_nombre} en Supabase (0 filas afectadas). Verifica permisos RLS.`
        );
      }
      const saved = {
        ...(rowsReturned[0] as unknown as MatrixSavedRowResult),
        client_temp_id: row.client_temp_id,
        sucursal: cleanSucursal,
      };
      savedRows.push(saved);
      savedPairs.push({ row, saved });
      actualizadas += 1;
    } else {
      const ins = await client
        .from('cronograma_degustaciones')
        .insert({
          ...payload,
          idempotency_hash:
            row.idempotency_hash ||
            `${row.fecha}_${row.turno}_${normalizeSearchText(row.cliente_nombre)}_${normalizeSearchText(row.producto_resumen)}_${Date.now()}`.slice(
              0,
              120
            ),
        })
        .select('id, cliente_nombre, fecha, turno, estado, promotora_id, promotora_nombre');
      if (ins.error) {
        console.error('[persistMatrixUpsertBatch] Error en INSERT cronograma_degustaciones', {
          code: ins.error.code,
          message: ins.error.message,
          hint: ins.error.hint,
          details: ins.error.details,
          cliente: row.cliente_nombre,
        });
        throw formatMatrixWriteError(ins.error, `Error insertando fila ${row.cliente_nombre}.`);
      }
      const rowsReturned = Array.isArray(ins.data) ? ins.data : ins.data ? [ins.data] : [];
      if (rowsReturned.length === 0) {
        console.error('[persistMatrixUpsertBatch] INSERT devolvió 0 filas (posible RLS)', {
          cliente: row.cliente_nombre,
        });
        throw new Error(
          `No se pudo confirmar la creación de la degustación de ${row.cliente_nombre} en Supabase (0 filas devueltas).`
        );
      }
      const saved = {
        ...(rowsReturned[0] as unknown as MatrixSavedRowResult),
        client_temp_id: row.client_temp_id,
        sucursal: cleanSucursal,
      };
      savedRows.push(saved);
      savedPairs.push({ row, saved });
      insertadas += 1;
    }
  }

  await syncScheduledRowsToDownstreamApps(client, savedPairs, {
    syncPromotoraRoute: true,
    syncChoferDelivery: true,
  });

  return { ok: true, insertadas, actualizadas, filas: savedRows };
}

/**
 * Ejecuta cancelación 100% LÓGICA sobre `public.cronograma_degustaciones` y `public.rutas_promotoras`
 * (jamás `DELETE` físico), respetando el candado histórico.
 */
export async function persistMatrixLogicalCancel(
  cronogramaIds: readonly string[],
  motivo = 'CANCELADO_DESDE_MATRIZ',
  clientOverride?: SupabaseClient
): Promise<MatrixLogicalCancelResult> {
  const validUuids = Array.from(new Set(cronogramaIds.filter(isRealUuid)));
  if (validUuids.length === 0) {
    return { ok: true, canceladas: 0, preservadas_historicas: 0, ids_cancelados: [] };
  }

  if (!clientOverride && !isSupabaseConfigured) {
    throw new Error('Supabase no está configurado: no se puede cancelar lógicamente en BD.');
  }

  const client = clientOverride ?? getSupabaseCoordinatorClient();
  const rpcRes = await client.rpc('rpc_cancelar_matriz_cronograma_lote', {
    p_ids: validUuids,
    p_motivo: motivo,
  });

  if (!rpcRes.error && rpcRes.data) {
    const body = rpcRes.data as Partial<MatrixLogicalCancelResult>;
    return {
      ok: body.ok !== false,
      canceladas: Number(body.canceladas ?? 0),
      preservadas_historicas: Number(body.preservadas_historicas ?? 0),
      ids_cancelados: Array.isArray(body.ids_cancelados) ? body.ids_cancelados : [],
    };
  }

  if (rpcRes.error && !isMissingRpcError(rpcRes.error)) {
    throw new Error(
      rpcRes.error.message || 'No se pudo completar la cancelación lógica en cronograma_degustaciones.'
    );
  }

  // Respaldo lógico (UPDATE, jamás DELETE)
  const nowIso = new Date().toISOString();
  const upd = await client
    .from('cronograma_degustaciones')
    .update({
      estado: 'CANCELADA',
      motivo_rechazo: motivo,
      fecha_rechazo: nowIso,
      en_historial: true,
      archivado_en: nowIso,
      motivo_archivo: 'CANCELACION_MATRIZ',
    })
    .in('id', validUuids)
    .eq('en_historial', false)
    .neq('estado', 'COMPLETADA')
    .select('id');

  if (upd.error) {
    throw new Error(upd.error.message || 'No se pudo cancelar lógicamente el lote.');
  }

  const canceledIds = ((upd.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (canceledIds.length > 0) {
    await client
      .from('rutas_promotoras')
      .update({ estado_ruta: 'CANCELADA', updated_at: nowIso })
      .in('cronograma_id', canceledIds)
      .neq('estado_ruta', 'COMPLETADA');
  }

  return {
    ok: true,
    canceladas: canceledIds.length,
    preservadas_historicas: Math.max(0, validUuids.length - canceledIds.length),
    ids_cancelados: canceledIds,
  };
}
