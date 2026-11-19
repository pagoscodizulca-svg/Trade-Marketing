import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type {
  ControllerRequest,
  FiscalReceipt,
  InventoryReconciliation,
  RequestItem,
  RequisitionStatus,
} from '../types';
import type {
  CampanaTrade,
  CampanaTradeInput,
  CertificadoPazYSalvo,
  PazYSalvoVerificationResult,
  PresupuestoTrade,
  PresupuestoTradeInput,
  TarifarioCostoTrade,
  TarifarioCostoTradeInput,
} from '../types/contraloriaFinancial';
import {
  getCachedAccessToken,
  getSupabaseCoordinatorClient,
  isSupabaseConfigured,
} from './supabaseClient';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const YM_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export const CampanaTradeSchema = z.object({
  id: z.string().regex(UUID_REGEX).optional(),
  codigo: z
    .string()
    .trim()
    .min(2, 'El código de campaña debe tener al menos 2 caracteres.')
    .max(40)
    .transform((v) => v.toUpperCase()),
  nombre: z.string().trim().min(2, 'El nombre de la campaña es obligatorio.').max(160),
  marca: z.enum(['ASTURIAS', 'VENCAMPO', 'GENERAL']).default('GENERAL'),
  fecha_inicio: z.string().regex(YMD_REGEX, 'fecha_inicio debe tener formato YYYY-MM-DD.'),
  fecha_fin: z.string().regex(YMD_REGEX, 'fecha_fin debe tener formato YYYY-MM-DD.'),
  estado: z.enum(['PLANIFICADA', 'ACTIVA', 'CERRADA', 'CANCELADA']).optional().default('ACTIVA'),
  observaciones: z.string().trim().max(500).optional().default(''),
  sucursal: z.enum(['ZULIA', 'VALENCIA']).nullable().optional(),
});

export const PresupuestoTradeSchema = z.object({
  id: z.string().regex(UUID_REGEX).optional(),
  campana_id: z.string().regex(UUID_REGEX).nullable().optional(),
  periodo_ym: z.string().regex(YM_REGEX, 'periodo_ym debe tener formato YYYY-MM.'),
  categoria: z.string().trim().min(2, 'La categoría presupuestaria es obligatoria.').max(140),
  monto_asignado_usd: z.coerce.number().finite().min(0),
  monto_comprometido_usd: z.coerce.number().finite().min(0).optional().default(0),
  monto_ejecutado_usd: z.coerce.number().finite().min(0).optional().default(0),
  observaciones: z.string().trim().max(500).optional().default(''),
  activo: z.boolean().optional().default(true),
  sucursal: z.enum(['ZULIA', 'VALENCIA']).nullable().optional(),
});

export const TarifarioCostoTradeSchema = z.object({
  id: z.string().regex(UUID_REGEX).optional(),
  line_id: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .transform((v) => v.toLowerCase()),
  etiqueta: z.string().trim().min(2).max(160),
  marca: z.enum(['ASTURIAS', 'VENCAMPO', 'GENERAL']),
  unidad_medida: z.string().trim().min(1).max(60).optional().default('Piezas / Unid'),
  costo_unitario_usd: z.coerce.number().finite().positive('El costo unitario debe ser > 0.'),
  precio_referencia_usd: z.coerce.number().finite().min(0),
  vigente_desde: z.string().regex(YMD_REGEX).optional(),
  vigente_hasta: z.string().regex(YMD_REGEX).nullable().optional(),
  activo: z.boolean().optional().default(true),
  sucursal: z.enum(['ZULIA', 'VALENCIA']).nullable().optional(),
});

export function isRealUuid(val: unknown): val is string {
  return typeof val === 'string' && UUID_REGEX.test(val.trim());
}

/**
 * Construye un mapa indexado por `line_id` usando los costos vigentes más recientes de BD.
 */
export function mapTarifarioRowsToLookupMap(
  rows: readonly TarifarioCostoTrade[] | null | undefined
): Map<string, TarifarioCostoTrade> {
  const map = new Map<string, TarifarioCostoTrade>();
  if (!rows || rows.length === 0) return map;

  const sorted = [...rows]
    .filter((r) => r.activo !== false && Number(r.costo_unitario_usd) > 0)
    .sort((a, b) => String(b.vigente_desde || '').localeCompare(String(a.vigente_desde || '')));

  for (const row of sorted) {
    const key = String(row.line_id || '').trim().toLowerCase();
    if (!key || map.has(key)) continue;
    map.set(key, {
      ...row,
      costo_unitario_usd: Number(row.costo_unitario_usd),
      precio_referencia_usd: Number(row.precio_referencia_usd || 0),
    });
  }
  return map;
}

export function mapDbFacturaToFiscalReceipt(row: Record<string, unknown>): FiscalReceipt {
  return {
    id: String(row.id || ''),
    invoiceNumber: String(row.numero_factura || ''),
    supplierRif: String(row.rif_proveedor || ''),
    supplierName: String(row.razon_social_proveedor || ''),
    concept: String(row.concepto || ''),
    subtotalUsd: Number(row.subtotal_usd || 0),
    taxAmountUsd: Number(row.impuesto_usd || 0),
    totalUsd: Number(row.total_usd || 0),
    imageUrl: '',
    storagePath: row.storage_path ? String(row.storage_path) : null,
    mimeType: row.mime_type ? String(row.mime_type) : null,
    archivoSha256Hex: row.archivo_sha256_hex ? String(row.archivo_sha256_hex) : null,
    sizeBytes: row.tamano_bytes != null ? Number(row.tamano_bytes) : null,
    isValidatedByContraloria: Boolean(row.validada_contraloria),
    validationNotes: row.notas_validacion ? String(row.notas_validacion) : undefined,
  };
}

export function mapDbRequisicionToControllerRequest(row: Record<string, unknown>): ControllerRequest {
  const rawItems = Array.isArray(row.items) ? (row.items as Array<Record<string, unknown>>) : [];
  const items: RequestItem[] = rawItems.map((it, idx) => ({
    id: String(it.id || `item_${idx + 1}`),
    itemNumber: Number(it.itemNumber ?? it.item_number ?? idx + 1),
    productName: String(it.productName ?? it.producto ?? ''),
    category: (it.category as RequestItem['category']) || 'PRODUCTO_DEGUSTACION',
    quantityRequested: Number(it.quantityRequested ?? it.cantidad ?? 0),
    unitOfMeasure: String(it.unitOfMeasure ?? it.unidad ?? 'Unid'),
    unitCostUsd: Number(it.unitCostUsd ?? it.costo_unitario_usd ?? 0),
    totalCostUsd: Number(it.totalCostUsd ?? it.total_costo_usd ?? 0),
    lotNumber: it.lotNumber ? String(it.lotNumber) : undefined,
  }));

  const parseApprover = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as Record<string, unknown>;
    return {
      name: String(obj.name || ''),
      date: String(obj.date || ''),
      comments: obj.comments ? String(obj.comments) : undefined,
    };
  };

  return {
    id: String(row.id || ''),
    requestCode: String(row.codigo_correlativo || ''),
    requestDate: String(row.fecha_solicitud || ''),
    targetDepartment: String(row.departamento_destino || 'CONTRALORÍA'),
    campaignOrPurpose: String(row.proposito_campana || ''),
    applicantDepartment: String(row.departamento_solicitante || 'MERCADEO Y PUBLICIDAD'),
    applicantName: String(row.solicitante_nombre || ''),
    targetRecipient: String(row.destinatario_facturacion || ''),
    deliveryDestination: String(row.destino_despacho || ''),
    notesAndObservations: String(row.observaciones || ''),
    budgetCategory: String(row.categoria_presupuesto || 'Activación BTL - Trade Marketing'),
    approvedBudgetCapUsd: Number(row.tope_presupuesto_usd || 0),
    status: (String(row.estado || 'VALIDACION_COMERCIAL') as RequisitionStatus),
    items,
    totalUnits: Number(row.total_unidades || 0),
    estimatedCostUsd: Number(row.costo_estimado_usd || 0),
    commercialApprover: parseApprover(row.aprobador_comercial),
    financialAuditor: parseApprover(row.auditor_financiero),
    finalApprover: parseApprover(row.aprobador_final),
    rejectionReason: row.motivo_rechazo ? String(row.motivo_rechazo) : undefined,
    pazYSalvoCertificateId: row.paz_y_salvo_id ? String(row.paz_y_salvo_id) : undefined,
    campanaId: row.campana_id ? String(row.campana_id) : null,
    presupuestoId: row.presupuesto_id ? String(row.presupuesto_id) : null,
    solicitudOrigenId: row.solicitud_origen_id ? String(row.solicitud_origen_id) : null,
    sucursal: (row.sucursal as 'ZULIA' | 'VALENCIA' | null) ?? null,
  };
}

export function mapDbConciliacionToInventoryReconciliation(
  row: Record<string, unknown>,
  receipts: FiscalReceipt[] = [],
  cert?: CertificadoPazYSalvo | null
): InventoryReconciliation {
  const delivered = Number(row.unidades_entregadas || 0);
  const degustated = Number(row.unidades_degustadas || 0);
  const returned = Number(row.unidades_devueltas || 0);
  const disc =
    row.discrepancia_unidades != null
      ? Number(row.discrepancia_unidades)
      : delivered - (degustated + returned);
  const totalExpenses =
    receipts.length > 0
      ? Number(receipts.reduce((s, r) => s + r.totalUsd, 0).toFixed(2))
      : Number(row.total_gastos_reportados_usd || 0);
  const pettyCash = Number(row.fondo_asignado_usd || 0);

  return {
    id: String(row.id || ''),
    requestId: String(row.requisicion_id || ''),
    requestCode: String(row.codigo_correlativo || ''),
    productName: String(row.producto_principal || ''),
    deliveredUnits: delivered,
    degustatedUnitsReported: degustated,
    returnedRemanentUnits: returned,
    discrepancyUnits: disc,
    discrepancyStatus:
      (row.estado_discrepancia as InventoryReconciliation['discrepancyStatus']) ||
      (disc === 0 ? 'CUADRADO' : Math.abs(disc) <= 1 ? 'DESVIACION_ACEPTABLE' : 'MERMA_NO_JUSTIFICADA'),
    returnWarehouseReceiptNumber: row.acta_devolucion_almacen
      ? String(row.acta_devolucion_almacen)
      : undefined,
    receipts,
    totalExpensesReportedUsd: totalExpenses,
    approvedPettyCashUsd: pettyCash,
    balanceDueCompanyOrPromotorUsd: Number((pettyCash - totalExpenses).toFixed(2)),
    auditNotes: String(row.notas_auditoria || ''),
    cerrada: Boolean(row.cerrada),
    pazYSalvoIssued: Boolean(row.cerrada || cert),
    pazYSalvoCertificateCode: cert?.codigo_certificado,
    pazYSalvoIssueDate: cert?.emitido_en || (row.cerrada_en ? String(row.cerrada_en) : undefined),
    pazYSalvoHash: cert?.sha256_hash ? `SHA256:${cert.sha256_hash}` : undefined,
  };
}

function resolveClient(override?: SupabaseClient): SupabaseClient {
  if (override) return override;
  if (!isSupabaseConfigured) {
    throw new Error('Supabase no está configurado para operar Contraloría.');
  }
  return getSupabaseCoordinatorClient();
}

// =============================================================================
// CAMPAÑAS, PRESUPUESTOS Y TARIFARIO DE COSTOS EN SUPABASE
// =============================================================================

export async function fetchTarifarioCostosTrade(
  clientOverride?: SupabaseClient
): Promise<TarifarioCostoTrade[]> {
  const client = resolveClient(clientOverride);
  const { data, error } = await client
    .from('tarifario_costos_trade')
    .select('*')
    .eq('activo', true)
    .order('vigente_desde', { ascending: false });
  if (error) throw new Error(`Error consultando tarifario de costos: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as TarifarioCostoTrade),
    costo_unitario_usd: Number(r.costo_unitario_usd || 0),
    precio_referencia_usd: Number(r.precio_referencia_usd || 0),
  }));
}

export async function upsertTarifarioCostoTrade(
  input: TarifarioCostoTradeInput,
  clientOverride?: SupabaseClient
): Promise<TarifarioCostoTrade> {
  const parsed = TarifarioCostoTradeSchema.parse(input);
  const client = resolveClient(clientOverride);
  const payload = {
    line_id: parsed.line_id,
    etiqueta: parsed.etiqueta,
    marca: parsed.marca,
    unidad_medida: parsed.unidad_medida,
    costo_unitario_usd: parsed.costo_unitario_usd,
    precio_referencia_usd: parsed.precio_referencia_usd,
    vigente_desde: parsed.vigente_desde || new Date().toISOString().slice(0, 10),
    vigente_hasta: parsed.vigente_hasta ?? null,
    activo: parsed.activo,
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
  };

  const res = parsed.id
    ? await client.from('tarifario_costos_trade').update(payload).eq('id', parsed.id).select('*').single()
    : await client.from('tarifario_costos_trade').insert(payload).select('*').single();

  if (res.error || !res.data) {
    throw new Error(res.error?.message || 'No se pudo guardar la tarifa en tarifario_costos_trade.');
  }
  const r = res.data as Record<string, unknown>;
  return {
    ...(r as unknown as TarifarioCostoTrade),
    costo_unitario_usd: Number(r.costo_unitario_usd || 0),
    precio_referencia_usd: Number(r.precio_referencia_usd || 0),
  };
}

export async function fetchCampanasTrade(
  clientOverride?: SupabaseClient
): Promise<CampanaTrade[]> {
  const client = resolveClient(clientOverride);
  const { data, error } = await client
    .from('campanas_trade')
    .select('*')
    .order('fecha_inicio', { ascending: false });
  if (error) throw new Error(`Error consultando campañas: ${error.message}`);
  return (data ?? []) as unknown as CampanaTrade[];
}

export async function upsertCampanaTrade(
  input: CampanaTradeInput,
  clientOverride?: SupabaseClient
): Promise<CampanaTrade> {
  const parsed = CampanaTradeSchema.parse(input);
  if (parsed.fecha_fin < parsed.fecha_inicio) {
    throw new Error('La fecha de fin de la campaña no puede ser anterior a la fecha de inicio.');
  }
  const client = resolveClient(clientOverride);
  const payload = {
    codigo: parsed.codigo,
    nombre: parsed.nombre,
    marca: parsed.marca,
    fecha_inicio: parsed.fecha_inicio,
    fecha_fin: parsed.fecha_fin,
    estado: parsed.estado,
    observaciones: parsed.observaciones,
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
  };

  const res = parsed.id
    ? await client.from('campanas_trade').update(payload).eq('id', parsed.id).select('*').single()
    : await client.from('campanas_trade').insert(payload).select('*').single();

  if (res.error || !res.data) {
    throw new Error(res.error?.message || 'No se pudo guardar la campaña Trade.');
  }
  return res.data as unknown as CampanaTrade;
}

export async function fetchPresupuestosTrade(
  clientOverride?: SupabaseClient
): Promise<PresupuestoTrade[]> {
  const client = resolveClient(clientOverride);
  const { data, error } = await client
    .from('presupuestos_trade')
    .select('*')
    .order('periodo_ym', { ascending: false });
  if (error) throw new Error(`Error consultando presupuestos: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as PresupuestoTrade),
    monto_asignado_usd: Number(r.monto_asignado_usd || 0),
    monto_comprometido_usd: Number(r.monto_comprometido_usd || 0),
    monto_ejecutado_usd: Number(r.monto_ejecutado_usd || 0),
  }));
}

export async function upsertPresupuestoTrade(
  input: PresupuestoTradeInput,
  clientOverride?: SupabaseClient
): Promise<PresupuestoTrade> {
  const parsed = PresupuestoTradeSchema.parse(input);
  const client = resolveClient(clientOverride);
  const payload = {
    campana_id: parsed.campana_id ?? null,
    periodo_ym: parsed.periodo_ym,
    categoria: parsed.categoria,
    monto_asignado_usd: parsed.monto_asignado_usd,
    monto_comprometido_usd: parsed.monto_comprometido_usd,
    monto_ejecutado_usd: parsed.monto_ejecutado_usd,
    observaciones: parsed.observaciones,
    activo: parsed.activo,
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
  };

  const res = parsed.id
    ? await client.from('presupuestos_trade').update(payload).eq('id', parsed.id).select('*').single()
    : await client.from('presupuestos_trade').insert(payload).select('*').single();

  if (res.error || !res.data) {
    throw new Error(res.error?.message || 'No se pudo guardar el presupuesto Trade.');
  }
  const r = res.data as Record<string, unknown>;
  return {
    ...(r as unknown as PresupuestoTrade),
    monto_asignado_usd: Number(r.monto_asignado_usd || 0),
    monto_comprometido_usd: Number(r.monto_comprometido_usd || 0),
    monto_ejecutado_usd: Number(r.monto_ejecutado_usd || 0),
  };
}

// =============================================================================
// REQUISICIONES (8 ETAPAS EN BD), CONCILIACIONES, FACTURAS Y PAZ Y SALVO
// =============================================================================

export interface ContraloriaFinancialBundle {
  requisiciones: ControllerRequest[];
  conciliacionesByReqId: Record<string, InventoryReconciliation>;
  certificadosByReqId: Record<string, CertificadoPazYSalvo>;
  campanas: CampanaTrade[];
  presupuestos: PresupuestoTrade[];
  tarifario: TarifarioCostoTrade[];
}

export async function fetchContraloriaFinancialBundle(
  clientOverride?: SupabaseClient
): Promise<ContraloriaFinancialBundle> {
  const client = resolveClient(clientOverride);
  const [reqRes, concRes, factRes, certRes, campanas, presupuestos, tarifario] = await Promise.all([
    client.from('contraloria_requisiciones').select('*').order('created_at', { ascending: false }).limit(300),
    client.from('contraloria_conciliaciones').select('*').order('updated_at', { ascending: false }).limit(300),
    client.from('contraloria_facturas').select('*').order('created_at', { ascending: false }).limit(500),
    client.from('certificados_paz_y_salvo').select('*').order('emitido_en', { ascending: false }).limit(300),
    fetchCampanasTrade(client).catch(() => []),
    fetchPresupuestosTrade(client).catch(() => []),
    fetchTarifarioCostosTrade(client).catch(() => []),
  ]);

  if (reqRes.error) {
    throw new Error(`Error cargando contraloria_requisiciones: ${reqRes.error.message}`);
  }

  const requisiciones = ((reqRes.data ?? []) as Array<Record<string, unknown>>).map(
    mapDbRequisicionToControllerRequest
  );

  const certificadosByReqId: Record<string, CertificadoPazYSalvo> = {};
  for (const row of (certRes.data ?? []) as Array<Record<string, unknown>>) {
    const cert = row as unknown as CertificadoPazYSalvo;
    certificadosByReqId[cert.requisicion_id] = cert;
  }

  const receiptsByConcId = new Map<string, FiscalReceipt[]>();
  for (const row of (factRes.data ?? []) as Array<Record<string, unknown>>) {
    const cid = String(row.conciliacion_id || '');
    if (!cid) continue;
    const list = receiptsByConcId.get(cid) || [];
    list.push(mapDbFacturaToFiscalReceipt(row));
    receiptsByConcId.set(cid, list);
  }

  const conciliacionesByReqId: Record<string, InventoryReconciliation> = {};
  for (const row of (concRes.data ?? []) as Array<Record<string, unknown>>) {
    const reqId = String(row.requisicion_id || '');
    const concId = String(row.id || '');
    if (!reqId) continue;
    conciliacionesByReqId[reqId] = mapDbConciliacionToInventoryReconciliation(
      row,
      receiptsByConcId.get(concId) || [],
      certificadosByReqId[reqId] || null
    );
  }

  return {
    requisiciones,
    conciliacionesByReqId,
    certificadosByReqId,
    campanas,
    presupuestos,
    tarifario,
  };
}

export async function createRequisitionInSupabase(
  req: Partial<ControllerRequest>,
  clientOverride?: SupabaseClient
): Promise<{ requisicion: ControllerRequest; conciliacion: InventoryReconciliation }> {
  const client = resolveClient(clientOverride);
  const items = req.items || [];
  const totalUnits = items.reduce((acc, it) => acc + (Number(it.quantityRequested) || 0), 0);
  const estimatedCostUsd = Number(
    items.reduce((acc, it) => acc + (Number(it.totalCostUsd) || 0), 0).toFixed(2)
  );

  const { data, error } = await client.rpc('rpc_crear_requisicion_contraloria', {
    p_payload: {
      codigo_correlativo: req.requestCode?.trim() || 'AUTO',
      solicitud_origen_id: req.solicitudOrigenId ?? null,
      campana_id: req.campanaId ?? null,
      presupuesto_id: req.presupuestoId ?? null,
      fecha_solicitud: req.requestDate || new Date().toLocaleDateString('es-VE'),
      fecha_iso: new Date().toISOString().slice(0, 10),
      departamento_destino: req.targetDepartment || 'CONTRALORÍA',
      proposito_campana: req.campaignOrPurpose || 'Degustación y activación comercial',
      departamento_solicitante: req.applicantDepartment || 'MERCADEO Y PUBLICIDAD',
      solicitante_nombre: req.applicantName || 'Trade Marketing',
      destinatario_facturacion: req.targetRecipient || 'Facturación / Almacén Codizulca',
      destino_despacho: req.deliveryDestination || 'Despacho Operativo Trade Marketing',
      observaciones: req.notesAndObservations || '',
      categoria_presupuesto: req.budgetCategory || 'Activación BTL - Trade Marketing',
      tope_presupuesto_usd: req.approvedBudgetCapUsd ?? estimatedCostUsd,
      estado: req.status === 'BORRADOR' ? 'BORRADOR' : 'VALIDACION_COMERCIAL',
      items,
      total_unidades: totalUnits,
      costo_estimado_usd: estimatedCostUsd,
      sucursal: req.sucursal ?? null,
    },
  });

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo radicar la requisición en Supabase.');
  }

  const body = data as {
    requisicion: Record<string, unknown>;
    conciliacion: Record<string, unknown>;
  };

  return {
    requisicion: mapDbRequisicionToControllerRequest(body.requisicion),
    conciliacion: mapDbConciliacionToInventoryReconciliation(body.conciliacion, [], null),
  };
}

export async function transitionRequisitionInSupabase(
  params: {
    requisicionId: string;
    nextStatus: RequisitionStatus;
    justification?: string;
    comments?: string;
  },
  clientOverride?: SupabaseClient
): Promise<ControllerRequest> {
  if (!isRealUuid(params.requisicionId)) {
    throw new Error('Identificador de requisición inválido.');
  }
  const client = resolveClient(clientOverride);
  const { data, error } = await client.rpc('rpc_transicionar_requisicion_contraloria', {
    p_requisicion_id: params.requisicionId,
    p_estado_destino: params.nextStatus,
    p_justificacion: params.justification || '',
    p_comentarios: params.comments || '',
  });

  if (error || !data) {
    throw new Error(error?.message || 'Transición rechazada por las reglas de Contraloría en BD.');
  }
  const body = data as { requisicion: Record<string, unknown> };
  return mapDbRequisicionToControllerRequest(body.requisicion);
}

export async function updateReconciliationInSupabase(
  conciliacionId: string,
  updates: Partial<InventoryReconciliation>,
  clientOverride?: SupabaseClient
): Promise<InventoryReconciliation> {
  if (!isRealUuid(conciliacionId)) {
    throw new Error('Identificador de conciliación inválido.');
  }
  const client = resolveClient(clientOverride);
  const payload: Record<string, unknown> = {};
  if (updates.deliveredUnits !== undefined) payload.unidades_entregadas = Math.max(0, Number(updates.deliveredUnits) || 0);
  if (updates.degustatedUnitsReported !== undefined) payload.unidades_degustadas = Math.max(0, Number(updates.degustatedUnitsReported) || 0);
  if (updates.returnedRemanentUnits !== undefined) payload.unidades_devueltas = Math.max(0, Number(updates.returnedRemanentUnits) || 0);
  if (updates.returnWarehouseReceiptNumber !== undefined) payload.acta_devolucion_almacen = updates.returnWarehouseReceiptNumber;
  if (updates.approvedPettyCashUsd !== undefined) payload.fondo_asignado_usd = Math.max(0, Number(updates.approvedPettyCashUsd) || 0);
  if (updates.auditNotes !== undefined) payload.notas_auditoria = updates.auditNotes;
  if (updates.productName !== undefined) payload.producto_principal = updates.productName;

  const { data, error } = await client
    .from('contraloria_conciliaciones')
    .update(payload)
    .eq('id', conciliacionId)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar la conciliación en Supabase.');
  }
  return mapDbConciliacionToInventoryReconciliation(data as Record<string, unknown>);
}

export async function createFiscalReceiptMetadataInSupabase(
  params: {
    conciliacionId: string;
    requisicionId: string;
    receipt: Omit<FiscalReceipt, 'id' | 'isValidatedByContraloria'>;
  },
  clientOverride?: SupabaseClient
): Promise<FiscalReceipt> {
  const client = resolveClient(clientOverride);
  const { data, error } = await client
    .from('contraloria_facturas')
    .insert({
      conciliacion_id: params.conciliacionId,
      requisicion_id: params.requisicionId,
      numero_factura: params.receipt.invoiceNumber.trim().toUpperCase(),
      rif_proveedor: params.receipt.supplierRif.trim().toUpperCase(),
      razon_social_proveedor: params.receipt.supplierName.trim(),
      concepto: params.receipt.concept.trim(),
      subtotal_usd: params.receipt.subtotalUsd,
      impuesto_usd: params.receipt.taxAmountUsd,
      total_usd: params.receipt.totalUsd,
      validada_contraloria: false,
    })
    .select('*')
    .single();

  if (error || !data) {
    if (error?.code === '23505' || /uq_contraloria_facturas_rif_numero/i.test(error?.message || '')) {
      throw new Error(
        'ERROR CRÍTICO ANTIFRAUDE: La factura ya existe para ese RIF en la base de datos. Prohibida la doble rendición.'
      );
    }
    throw new Error(error?.message || 'No se pudo registrar el comprobante fiscal.');
  }
  return mapDbFacturaToFiscalReceipt(data as Record<string, unknown>);
}

function encodeBase64Utf8(jsonText: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(jsonText, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(jsonText);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export async function uploadFiscalReceiptWithBinary(params: {
  conciliacionId: string;
  requisicionId: string;
  receipt: Omit<FiscalReceipt, 'id' | 'isValidatedByContraloria'>;
  file: File | Blob;
  apiBaseUrl?: string;
}): Promise<{ receipt: FiscalReceipt; signedUrl: string | null }> {
  const token = getCachedAccessToken();
  if (!token) {
    throw new Error('Sesión expirada: inicie sesión para subir comprobantes fiscales.');
  }

  const metaHeader = encodeBase64Utf8(
    JSON.stringify({
      requisicionId: params.requisicionId,
      conciliacionId: params.conciliacionId,
      invoiceNumber: params.receipt.invoiceNumber.trim(),
      supplierRif: params.receipt.supplierRif.trim().toUpperCase(),
      supplierName: params.receipt.supplierName.trim(),
      concept: params.receipt.concept.trim(),
      subtotalUsd: params.receipt.subtotalUsd,
      taxAmountUsd: params.receipt.taxAmountUsd,
      totalUsd: params.receipt.totalUsd,
    })
  );

  const arrayBuf = await params.file.arrayBuffer();
  const base = params.apiBaseUrl ? params.apiBaseUrl.replace(/\/+$/, '') : '';
  const res = await fetch(`${base}/api/contraloria/facturas/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': params.file.type || 'application/octet-stream',
      'x-factura-meta': metaHeader,
    },
    body: arrayBuf,
  });

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    factura?: Record<string, unknown>;
    signedUrl?: string | null;
  };

  if (!res.ok || !body.factura) {
    throw new Error(body.error || `Error cargando comprobante fiscal (HTTP ${res.status}).`);
  }

  const mapped = mapDbFacturaToFiscalReceipt(body.factura);
  mapped.imageUrl = body.signedUrl || '';
  return { receipt: mapped, signedUrl: body.signedUrl || null };
}

export async function fetchFiscalReceiptSignedUrls(
  facturaIds: string[],
  apiBaseUrl = ''
): Promise<Record<string, string>> {
  const validIds = facturaIds.filter(isRealUuid);
  if (validIds.length === 0) return {};
  const token = getCachedAccessToken();
  if (!token) return {};

  const base = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, '') : '';
  const res = await fetch(`${base}/api/contraloria/facturas/signed-urls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ facturaIds: validIds }),
  });

  if (!res.ok) return {};
  const body = (await res.json().catch(() => ({}))) as { urls?: Record<string, string> };
  return body.urls || {};
}

export async function validateFiscalReceiptInSupabase(
  facturaId: string,
  isValid: boolean,
  notes?: string,
  validatorName?: string,
  clientOverride?: SupabaseClient
): Promise<FiscalReceipt> {
  if (!isRealUuid(facturaId)) {
    throw new Error('Identificador de factura inválido.');
  }
  const client = resolveClient(clientOverride);
  const { data, error } = await client
    .from('contraloria_facturas')
    .update({
      validada_contraloria: isValid,
      validada_por_nombre: validatorName || 'Contraloría Interna',
      notas_validacion:
        notes || (isValid ? 'Conforme fiscalmente.' : 'Rechazada por inconformidad.'),
    })
    .eq('id', facturaId)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar la validación fiscal en Supabase.');
  }
  return mapDbFacturaToFiscalReceipt(data as Record<string, unknown>);
}

export async function issuePazYSalvoInSupabase(
  requisicionId: string,
  notes: string,
  clientOverride?: SupabaseClient
): Promise<{
  certificado: CertificadoPazYSalvo;
  requisicion: ControllerRequest;
  conciliacion: InventoryReconciliation;
}> {
  if (!isRealUuid(requisicionId)) {
    throw new Error('Identificador de requisición inválido para emitir Paz y Salvo.');
  }
  const client = resolveClient(clientOverride);
  const { data, error } = await client.rpc('rpc_emitir_paz_y_salvo', {
    p_requisicion_id: requisicionId,
    p_notas_cierre: notes,
  });

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo emitir el Paz y Salvo en el servidor.');
  }

  const body = data as {
    certificado: CertificadoPazYSalvo;
    requisicion: Record<string, unknown>;
    conciliacion: Record<string, unknown>;
  };

  return {
    certificado: body.certificado,
    requisicion: mapDbRequisicionToControllerRequest(body.requisicion),
    conciliacion: mapDbConciliacionToInventoryReconciliation(
      body.conciliacion,
      [],
      body.certificado
    ),
  };
}

export async function verifyPazYSalvoInSupabase(
  codigoCertificado: string,
  clientOverride?: SupabaseClient
): Promise<PazYSalvoVerificationResult> {
  const client = resolveClient(clientOverride);
  const { data, error } = await client.rpc('rpc_verificar_paz_y_salvo', {
    p_codigo_certificado: codigoCertificado.trim().toUpperCase(),
  });
  if (error || !data) {
    throw new Error(error?.message || 'Error verificando la firma criptográfica del Paz y Salvo.');
  }
  return data as PazYSalvoVerificationResult;
}
