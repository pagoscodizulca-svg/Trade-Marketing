import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ScheduledVisit, ShiftType, Store, User } from '../types';
import {
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
  options?: { clientCode?: string; clientTempId?: string }
): MatrixUpsertRowInput {
  const shift = normalizeProductionShift(visit.shift);
  const { horaInicio, horaFin } = defaultWindowForShift(shift);
  const resolvedCronId = isRealUuid(visit.cronogramaId)
    ? visit.cronogramaId
    : isRealUuid(visit.id) && !visit.solicitudId
      ? visit.id
      : null;
  const resolvedPromotoraId = isRealUuid(visit.promotoraId) ? visit.promotoraId : null;
  const productSummary = String(visit.fillProductSelection || visit.productFocus || 'MORTADELA')
    .trim()
    .toUpperCase();
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
    productos: [productSummary],
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
      operational_supplies: visit.operationalSupplies ?? null,
    },
    vendedor_fdv: String(visit.sellerName || '').trim(),
    promotora_id: resolvedPromotoraId,
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
  quantityInput: string;
  shift: ShiftType;
  dayLabel: string;
  date?: string;
  promotoraName?: string;
  sellerName?: string;
}): {
  nextVisits: ScheduledVisit[];
  affectedVisits: ScheduledVisit[];
  countUpdated: number;
  countCreated: number;
} {
  const effectiveDate = params.date && YMD_REGEX.test(params.date) ? params.date : getTodayVeYmd();
  const effectiveDayLabel = params.dayLabel || formatDayLabelEs(effectiveDate);
  const calc = calculateProductionSupplies(params.product, params.quantityInput);
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

/**
 * Persiste alta, edición o llenado por lote en `public.cronograma_degustaciones` mediante la RPC
 * `public.rpc_upsert_matriz_cronograma_lote`. Lanza error ante cualquier fallo para permitir reversión.
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
    return {
      ok: body.ok !== false,
      insertadas: Number(body.insertadas ?? 0),
      actualizadas: Number(body.actualizadas ?? 0),
      filas: Array.isArray(body.filas) ? body.filas : [],
    };
  }

  if (rpcRes.error && !isMissingRpcError(rpcRes.error)) {
    throw new Error(
      rpcRes.error.message || 'No se pudo persistir el lote en cronograma_degustaciones.'
    );
  }

  // Respaldo compatible mientras no se aplique la migración 20261118000600 en una base previa
  const savedRows: MatrixSavedRowResult[] = [];
  let insertadas = 0;
  let actualizadas = 0;

  for (const row of validatedRows) {
    const estado = row.promotora_id ? 'APROBADA' : 'PENDIENTE_APROBACION';
    const payload = {
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
      observaciones: row.observaciones,
      estado,
    };

    if (row.id) {
      const upd = await client
        .from('cronograma_degustaciones')
        .update(payload)
        .eq('id', row.id)
        .select('id, cliente_nombre, fecha, turno, estado, promotora_id, promotora_nombre')
        .single();
      if (upd.error || !upd.data) {
        throw new Error(upd.error?.message || `Error actualizando fila ${row.cliente_nombre}.`);
      }
      const saved = upd.data as unknown as MatrixSavedRowResult;
      savedRows.push({ ...saved, client_temp_id: row.client_temp_id });
      actualizadas += 1;
    } else {
      const ins = await client
        .from('cronograma_degustaciones')
        .insert({
          ...payload,
          idempotency_hash:
            row.idempotency_hash ||
            `${row.fecha}_${row.turno}_${normalizeSearchText(row.cliente_nombre)}_${normalizeSearchText(row.producto_resumen)}`.slice(
              0,
              120
            ),
        })
        .select('id, cliente_nombre, fecha, turno, estado, promotora_id, promotora_nombre')
        .single();
      if (ins.error || !ins.data) {
        throw new Error(ins.error?.message || `Error insertando fila ${row.cliente_nombre}.`);
      }
      const saved = ins.data as unknown as MatrixSavedRowResult;
      savedRows.push({ ...saved, client_temp_id: row.client_temp_id });
      insertadas += 1;
    }
  }

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
