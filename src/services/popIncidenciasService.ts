import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getActiveAccessToken } from './authService';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import { OPERATIVE_SUCURSALES, type OperativeSucursal } from './userManagementService';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CategoriaMaterialPop =
  | 'EXHIBIDOR'
  | 'AFICHE'
  | 'HABLADOR'
  | 'UNIFORME'
  | 'STAND_BTL'
  | 'MERCHANDISING'
  | 'OTRO';

export type TipoMovimientoPop = 'ENTREGA_PDV' | 'REINGRESO_ALMACEN' | 'BAJA_DETERIORO';

export type TipoIncidenciaPdv =
  | 'QUIEBRE_STOCK'
  | 'PRECIO_INCORRECTO'
  | 'MATERIAL_POP_DANADO'
  | 'COMPETENCIA_AGRESIVA'
  | 'CALIDAD_PRODUCTO'
  | 'ACCESO_PDV'
  | 'OTRO';

export type SeveridadIncidenciaPdv = 'BAJA' | 'MEDIA' | 'ALTA' | 'CRITICA';

export type EstadoIncidenciaPdv = 'ABIERTA' | 'EN_PROCESO' | 'RESUELTA' | 'CERRADA';

export const SLA_HOURS_BY_SEVERIDAD: Readonly<Record<SeveridadIncidenciaPdv, number>> = {
  CRITICA: 4,
  ALTA: 12,
  MEDIA: 24,
  BAJA: 72,
};

export interface MaterialPopItem {
  id: string;
  sku: string;
  nombre: string;
  categoria: CategoriaMaterialPop;
  marca: 'ASTURIAS' | 'VENCAMPO' | 'GENERAL';
  unidad: string;
  stockDisponible: number;
  stockMinimo: number;
  activo: boolean;
  sucursal: OperativeSucursal | null;
  updatedAt: string;
}

export interface MaterialPopMovimiento {
  id: string;
  materialId: string;
  clienteId: string | null;
  pdvNombre: string;
  promotoraId: string | null;
  responsableNombre: string;
  tipoMovimiento: TipoMovimientoPop;
  cantidad: number;
  fechaMovimiento: string;
  observaciones: string;
  sucursal: OperativeSucursal | null;
  createdAt: string;
}

export interface IncidenciaPdv {
  id: string;
  codigoIncidencia: string;
  clienteId: string | null;
  pdvNombre: string;
  rutaId: string | null;
  reportadoPorUid: string;
  reportadoPorNombre: string;
  responsableNombre: string;
  tipoIncidencia: TipoIncidenciaPdv;
  severidad: SeveridadIncidenciaPdv;
  descripcion: string;
  estado: EstadoIncidenciaPdv;
  slaHoras: number;
  slaVenceEn: string;
  resueltaEn: string | null;
  notasResolucion: string;
  fotoStorageBucket: string | null;
  fotoStoragePath: string | null;
  fotoMimeType: string | null;
  fotoSha256Hex: string | null;
  sucursal: OperativeSucursal | null;
  createdAt: string;
}

export interface AlertaGeocercaAuditoria {
  id: string;
  rutaId: string;
  promotoraId: string;
  promotoraNombre: string;
  clienteNombre: string;
  accion: 'CHECKIN' | 'CHECKOUT';
  distanciaM: number;
  radioPermitidoM: number;
  motivo: string;
  sucursal: OperativeSucursal | null;
  createdAt: string;
}

export interface PopIncidenciasBundle {
  inventarioPop: MaterialPopItem[];
  movimientosPop: MaterialPopMovimiento[];
  incidenciasPdv: IncidenciaPdv[];
  alertasGeocerca: AlertaGeocercaAuditoria[];
}

export interface SlaEvaluationResult {
  isResolved: boolean;
  isOverdue: boolean;
  remainingMinutes: number;
  badgeLabel: string;
}

export function evaluateIncidenciaSlaStatus(
  incidencia: Pick<IncidenciaPdv, 'estado' | 'slaVenceEn' | 'resueltaEn'>,
  nowMs: number = Date.now()
): SlaEvaluationResult {
  const isResolved = incidencia.estado === 'RESUELTA' || incidencia.estado === 'CERRADA';
  const deadlineMs = Date.parse(incidencia.slaVenceEn);
  if (!Number.isFinite(deadlineMs)) {
    return {
      isResolved,
      isOverdue: false,
      remainingMinutes: 0,
      badgeLabel: isResolved ? 'SLA cumplido' : 'SLA activo',
    };
  }

  const refMs =
    isResolved && incidencia.resueltaEn && Number.isFinite(Date.parse(incidencia.resueltaEn))
      ? Date.parse(incidencia.resueltaEn)
      : nowMs;

  const diffMinutes = Math.round((deadlineMs - refMs) / 60_000);
  const isOverdue = diffMinutes < 0;

  if (isResolved) {
    return {
      isResolved: true,
      isOverdue,
      remainingMinutes: diffMinutes,
      badgeLabel: isOverdue ? 'Cerrada fuera de SLA' : 'Resuelta en SLA',
    };
  }

  if (isOverdue) {
    const absHours = Math.max(1, Math.round(Math.abs(diffMinutes) / 60));
    return {
      isResolved: false,
      isOverdue: true,
      remainingMinutes: diffMinutes,
      badgeLabel: `Vencida hace ${absHours}h`,
    };
  }

  const hoursLeft = Math.floor(diffMinutes / 60);
  const minsLeft = diffMinutes % 60;
  return {
    isResolved: false,
    isOverdue: false,
    remainingMinutes: diffMinutes,
    badgeLabel: hoursLeft > 0 ? `${hoursLeft}h ${minsLeft}m restantes` : `${minsLeft}m restantes`,
  };
}

export const UpsertMaterialPopSchema = z.object({
  id: z.string().regex(UUID_REGEX).optional(),
  sku: z
    .string()
    .trim()
    .min(2, 'El SKU es obligatorio.')
    .max(40)
    .transform((v) => v.toUpperCase()),
  nombre: z.string().trim().min(2, 'El nombre del material POP es obligatorio.').max(160),
  categoria: z.enum([
    'EXHIBIDOR',
    'AFICHE',
    'HABLADOR',
    'UNIFORME',
    'STAND_BTL',
    'MERCHANDISING',
    'OTRO',
  ]),
  marca: z.enum(['ASTURIAS', 'VENCAMPO', 'GENERAL']),
  unidad: z.string().trim().min(1).max(20).default('UND'),
  stockDisponible: z.coerce.number().finite().min(0),
  stockMinimo: z.coerce.number().finite().min(0).default(0),
  activo: z.boolean().default(true),
  sucursal: z.enum(OPERATIVE_SUCURSALES).optional(),
});

export const MovimientoPopSchema = z.object({
  materialId: z.string().regex(UUID_REGEX, 'Seleccione un material POP válido.'),
  clienteId: z.string().regex(UUID_REGEX).optional().nullable(),
  pdvNombre: z.string().trim().min(2, 'Indique el PDV o destino.').max(180),
  promotoraId: z.string().regex(UUID_REGEX).optional().nullable(),
  responsableNombre: z.string().trim().min(2, 'Indique la persona responsable.').max(140),
  tipoMovimiento: z.enum(['ENTREGA_PDV', 'REINGRESO_ALMACEN', 'BAJA_DETERIORO']),
  cantidad: z.coerce.number().finite().positive('La cantidad debe ser mayor a 0.'),
  fechaMovimiento: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  observaciones: z.string().trim().max(500).optional().default(''),
});

export const CreateIncidenciaSchema = z.object({
  pdvNombre: z.string().trim().min(2, 'Indique el nombre del Punto de Venta.').max(180),
  clienteId: z.string().regex(UUID_REGEX).optional().nullable(),
  rutaId: z.string().regex(UUID_REGEX).optional().nullable(),
  tipoIncidencia: z.enum([
    'QUIEBRE_STOCK',
    'PRECIO_INCORRECTO',
    'MATERIAL_POP_DANADO',
    'COMPETENCIA_AGRESIVA',
    'CALIDAD_PRODUCTO',
    'ACCESO_PDV',
    'OTRO',
  ]),
  severidad: z.enum(['BAJA', 'MEDIA', 'ALTA', 'CRITICA']),
  descripcion: z
    .string()
    .trim()
    .min(5, 'Describa la incidencia con al menos 5 caracteres.')
    .max(1000),
  responsableNombre: z.string().trim().min(2).max(140).optional().default('Coordinación Trade'),
  reportadoPorNombre: z.string().trim().min(2).max(140).optional(),
  sucursal: z.enum(OPERATIVE_SUCURSALES).optional(),
});

function isTableMissing(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    msg.includes('could not find the table') ||
    (msg.includes('relation') && msg.includes('does not exist'))
  );
}

function mapMaterialPopRow(r: Record<string, unknown>): MaterialPopItem {
  return {
    id: String(r.id || ''),
    sku: String(r.sku || ''),
    nombre: String(r.nombre || ''),
    categoria: (r.categoria as CategoriaMaterialPop) || 'EXHIBIDOR',
    marca: (r.marca as 'ASTURIAS' | 'VENCAMPO' | 'GENERAL') || 'GENERAL',
    unidad: String(r.unidad || 'UND'),
    stockDisponible: Number(r.stock_disponible ?? 0),
    stockMinimo: Number(r.stock_minimo ?? 0),
    activo: r.activo !== false,
    sucursal: (r.sucursal as OperativeSucursal | null) ?? null,
    updatedAt: String(r.updated_at || r.created_at || ''),
  };
}

function mapMovimientoPopRow(r: Record<string, unknown>): MaterialPopMovimiento {
  return {
    id: String(r.id || ''),
    materialId: String(r.material_id || ''),
    clienteId: r.cliente_id ? String(r.cliente_id) : null,
    pdvNombre: String(r.pdv_nombre || ''),
    promotoraId: r.promotora_id ? String(r.promotora_id) : null,
    responsableNombre: String(r.responsable_nombre || ''),
    tipoMovimiento: (r.tipo_movimiento as TipoMovimientoPop) || 'ENTREGA_PDV',
    cantidad: Number(r.cantidad ?? 0),
    fechaMovimiento: String(r.fecha_movimiento || ''),
    observaciones: String(r.observaciones || ''),
    sucursal: (r.sucursal as OperativeSucursal | null) ?? null,
    createdAt: String(r.created_at || ''),
  };
}

export function mapIncidenciaPdvRow(r: Record<string, unknown>): IncidenciaPdv {
  return {
    id: String(r.id || ''),
    codigoIncidencia: String(r.codigo_incidencia || ''),
    clienteId: r.cliente_id ? String(r.cliente_id) : null,
    pdvNombre: String(r.pdv_nombre || ''),
    rutaId: r.ruta_id ? String(r.ruta_id) : null,
    reportadoPorUid: String(r.reportado_por_uid || ''),
    reportadoPorNombre: String(r.reportado_por_nombre || ''),
    responsableNombre: String(r.responsable_nombre || 'Coordinación Trade'),
    tipoIncidencia: (r.tipo_incidencia as TipoIncidenciaPdv) || 'OTRO',
    severidad: (r.severidad as SeveridadIncidenciaPdv) || 'MEDIA',
    descripcion: String(r.descripcion || ''),
    estado: (r.estado as EstadoIncidenciaPdv) || 'ABIERTA',
    slaHoras: Number(r.sla_horas ?? 24),
    slaVenceEn: String(r.sla_vence_en || ''),
    resueltaEn: r.resuelta_en ? String(r.resuelta_en) : null,
    notasResolucion: String(r.notas_resolucion || ''),
    fotoStorageBucket: r.foto_storage_bucket ? String(r.foto_storage_bucket) : null,
    fotoStoragePath: r.foto_storage_path ? String(r.foto_storage_path) : null,
    fotoMimeType: r.foto_mime_type ? String(r.foto_mime_type) : null,
    fotoSha256Hex: r.foto_sha256_hex ? String(r.foto_sha256_hex) : null,
    sucursal: (r.sucursal as OperativeSucursal | null) ?? null,
    createdAt: String(r.created_at || ''),
  };
}

function mapAlertaGeocercaRow(r: Record<string, unknown>): AlertaGeocercaAuditoria {
  return {
    id: String(r.id || ''),
    rutaId: String(r.ruta_id || ''),
    promotoraId: String(r.promotora_id || ''),
    promotoraNombre: String(r.promotora_nombre || ''),
    clienteNombre: String(r.cliente_nombre || ''),
    accion: r.accion === 'CHECKOUT' ? 'CHECKOUT' : 'CHECKIN',
    distanciaM: Number(r.distancia_m ?? 0),
    radioPermitidoM: Number(r.radio_permitido_m ?? 150),
    motivo: String(r.motivo || ''),
    sucursal: (r.sucursal as OperativeSucursal | null) ?? null,
    createdAt: String(r.created_at || ''),
  };
}

export async function fetchPopIncidenciasBundle(
  customClient?: SupabaseClient
): Promise<PopIncidenciasBundle> {
  if (!customClient && !isSupabaseConfigured) {
    return {
      inventarioPop: [],
      movimientosPop: [],
      incidenciasPdv: [],
      alertasGeocerca: [],
    };
  }

  const client = customClient ?? getSupabaseClient();
  const [invRes, movRes, incRes, geoRes] = await Promise.all([
    client
      .from('material_pop_inventario')
      .select('*')
      .order('nombre', { ascending: true })
      .limit(500),
    client
      .from('material_pop_entregas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200),
    client
      .from('incidencias_pdv')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200),
    client
      .from('alertas_geocerca_auditoria')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  if (invRes.error && !isTableMissing(invRes.error)) {
    throw new Error(invRes.error.message || 'Error consultando inventario POP.');
  }
  if (movRes.error && !isTableMissing(movRes.error)) {
    throw new Error(movRes.error.message || 'Error consultando entregas POP.');
  }
  if (incRes.error && !isTableMissing(incRes.error)) {
    throw new Error(incRes.error.message || 'Error consultando incidencias PDV.');
  }

  return {
    inventarioPop: Array.isArray(invRes.data)
      ? invRes.data.map((r) => mapMaterialPopRow(r as Record<string, unknown>))
      : [],
    movimientosPop: Array.isArray(movRes.data)
      ? movRes.data.map((r) => mapMovimientoPopRow(r as Record<string, unknown>))
      : [],
    incidenciasPdv: Array.isArray(incRes.data)
      ? incRes.data.map((r) => mapIncidenciaPdvRow(r as Record<string, unknown>))
      : [],
    alertasGeocerca: Array.isArray(geoRes.data)
      ? geoRes.data.map((r) => mapAlertaGeocercaRow(r as Record<string, unknown>))
      : [],
  };
}

export async function upsertMaterialPopInventario(
  rawInput: z.input<typeof UpsertMaterialPopSchema>,
  customClient?: SupabaseClient
): Promise<MaterialPopItem> {
  const parsed = UpsertMaterialPopSchema.parse(rawInput);
  const client = customClient ?? getSupabaseClient();

  const rowPayload: Record<string, unknown> = {
    sku: parsed.sku,
    nombre: parsed.nombre,
    categoria: parsed.categoria,
    marca: parsed.marca,
    unidad: parsed.unidad,
    stock_disponible: parsed.stockDisponible,
    stock_minimo: parsed.stockMinimo,
    activo: parsed.activo,
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
  };
  if (parsed.id) {
    rowPayload.id = parsed.id;
  }

  const { data, error } = await client
    .from('material_pop_inventario')
    .upsert(rowPayload, { onConflict: 'sku' })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo guardar el ítem de Material POP.');
  }
  return mapMaterialPopRow(data as Record<string, unknown>);
}

export async function registerMovimientoPop(
  rawInput: z.input<typeof MovimientoPopSchema>,
  customClient?: SupabaseClient
): Promise<{ inventario: MaterialPopItem; movimiento: MaterialPopMovimiento }> {
  const parsed = MovimientoPopSchema.parse(rawInput);
  const client = customClient ?? getSupabaseClient();

  const { data, error } = await client.rpc('rpc_registrar_movimiento_pop', {
    p_payload: {
      material_id: parsed.materialId,
      cliente_id: parsed.clienteId ?? null,
      pdv_nombre: parsed.pdvNombre,
      promotora_id: parsed.promotoraId ?? null,
      responsable_nombre: parsed.responsableNombre,
      tipo_movimiento: parsed.tipoMovimiento,
      cantidad: parsed.cantidad,
      fecha_movimiento: parsed.fechaMovimiento ?? null,
      observaciones: parsed.observaciones || '',
    },
  });

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo registrar el movimiento de Material POP.');
  }

  const payload = data as {
    inventario: Record<string, unknown>;
    movimiento: Record<string, unknown>;
  };
  return {
    inventario: mapMaterialPopRow(payload.inventario),
    movimiento: mapMovimientoPopRow(payload.movimiento),
  };
}

function encodeMetaBase64(meta: Record<string, unknown>): string {
  const json = JSON.stringify(meta);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function createIncidenciaPdv(
  rawInput: z.input<typeof CreateIncidenciaSchema>,
  photoFile?: File | Blob | null,
  customClient?: SupabaseClient
): Promise<IncidenciaPdv> {
  const parsed = CreateIncidenciaSchema.parse(rawInput);

  if (photoFile) {
    const token = await getActiveAccessToken();
    if (!token) {
      throw new Error('Sesión expirada. Inicie sesión nuevamente para adjuntar evidencia.');
    }

    const buffer = await photoFile.arrayBuffer();
    const metaB64 = encodeMetaBase64({
      pdvNombre: parsed.pdvNombre,
      clienteId: parsed.clienteId ?? null,
      rutaId: parsed.rutaId ?? null,
      tipoIncidencia: parsed.tipoIncidencia,
      severidad: parsed.severidad,
      descripcion: parsed.descripcion,
      responsableNombre: parsed.responsableNombre,
      reportadoPorNombre: parsed.reportadoPorNombre,
      ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
    });

    const res = await fetch('/api/incidencias/evidencias', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': photoFile.type || 'application/octet-stream',
        'x-incidencia-meta': metaB64,
      },
      body: buffer,
    });

    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      incidencia?: Record<string, unknown>;
    };
    if (!res.ok || !body.incidencia) {
      throw new Error(
        body.error || `No se pudo registrar la incidencia con fotografía (HTTP ${res.status}).`
      );
    }
    return mapIncidenciaPdvRow(body.incidencia);
  }

  const client = customClient ?? getSupabaseClient();
  const { data: userData } = await client.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) {
    throw new Error('Sesión autenticada requerida para reportar incidencias.');
  }

  const slaHoras = SLA_HOURS_BY_SEVERIDAD[parsed.severidad];
  const slaVenceEn = new Date(Date.now() + slaHoras * 3600 * 1000).toISOString();

  const { data, error } = await client
    .from('incidencias_pdv')
    .insert({
      codigo_incidencia: 'AUTO',
      cliente_id: parsed.clienteId ?? null,
      pdv_nombre: parsed.pdvNombre,
      ruta_id: parsed.rutaId ?? null,
      reportado_por_uid: uid,
      reportado_por_nombre:
        parsed.reportadoPorNombre || userData?.user?.email || 'Operador Trade',
      responsable_nombre: parsed.responsableNombre || 'Coordinación Trade',
      tipo_incidencia: parsed.tipoIncidencia,
      severidad: parsed.severidad,
      descripcion: parsed.descripcion,
      estado: 'ABIERTA',
      sla_horas: slaHoras,
      sla_vence_en: slaVenceEn,
      ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
    })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo registrar la incidencia operativa.');
  }

  return mapIncidenciaPdvRow(data as Record<string, unknown>);
}

export async function updateIncidenciaEstado(
  params: {
    id: string;
    estado: EstadoIncidenciaPdv;
    responsableNombre?: string;
    notasResolucion?: string;
  },
  customClient?: SupabaseClient
): Promise<IncidenciaPdv> {
  if (!UUID_REGEX.test(params.id)) {
    throw new Error('Identificador de incidencia inválido.');
  }

  const client = customClient ?? getSupabaseClient();
  const patch: Record<string, unknown> = {
    estado: params.estado,
  };
  if (params.responsableNombre !== undefined) {
    patch.responsable_nombre = params.responsableNombre.trim();
  }
  if (params.notasResolucion !== undefined) {
    patch.notas_resolucion = params.notasResolucion.trim();
  }
  if (params.estado === 'RESUELTA' || params.estado === 'CERRADA') {
    patch.resuelta_en = new Date().toISOString();
  }

  const { data, error } = await client
    .from('incidencias_pdv')
    .update(patch)
    .eq('id', params.id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar el estado de la incidencia.');
  }
  return mapIncidenciaPdvRow(data as Record<string, unknown>);
}

export async function fetchIncidenciasSignedUrls(
  incidenciaIds: string[]
): Promise<Record<string, string>> {
  const validIds = incidenciaIds.filter((id) => UUID_REGEX.test(id));
  if (validIds.length === 0) return {};

  const token = await getActiveAccessToken();
  if (!token) return {};

  const res = await fetch('/api/incidencias/evidencias/signed-urls', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ incidenciaIds: validIds }),
  });

  if (!res.ok) return {};
  const payload = (await res.json().catch(() => ({}))) as {
    signedUrls?: Record<string, string>;
  };
  return payload.signedUrls ?? {};
}
