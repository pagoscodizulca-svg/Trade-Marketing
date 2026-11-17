import {
  CreateSolicitudContraloriaInput,
  SolicitudContraloriaEstado,
  SolicitudProductoContraloria,
  SolicitudProductoRowItem,
  SolicitudProductoValidItem,
} from '../types';
import {
  SUPABASE_ANON_KEY,
  SUPABASE_REST_URL,
  assertSupabaseConfigured,
  getCachedAccessToken,
} from './supabaseClient';

export const SOLICITUD_SURVEY_TYPE = 'SolicitudContraloria';
export const SOLICITUD_CONTRALORIA_LOCAL_EVENT = 'codizulca:solicitud-contraloria-event';
export const SOLICITUD_CONTRALORIA_BROADCAST_CHANNEL = 'codizulca_solicitudes_contraloria_v1';

// El correlativo corporativo arranca en MP-07-0072 cuando no existen solicitudes previas
const BASE_INITIAL_SEQUENCE = 71;
const CORRELATIVE_PREFIX = 'MP-07-';

type PersistenceBackendMode = 'unknown' | 'dedicated_table' | 'surveys_envelope';
let detectedBackendMode: PersistenceBackendMode = 'unknown';

interface RawDedicatedSolicitudRow {
  id: string;
  codigo_correlativo: string;
  fecha_solicitud: string;
  fecha_iso: string;
  dirigido_a: string;
  para_ser_utilizado: string;
  items: unknown;
  total_unidades: number | string;
  observacion: string | null;
  solicitado_por: string;
  firma_digital_texto?: string | null;
  firma_digital_imagen?: string | null;
  departamento_solicitante: string;
  estado: string;
  nota_contraloria?: string | null;
  resuelto_por?: string | null;
  resuelto_at?: string | null;
  leido_contraloria?: boolean | null;
  created_at: string;
  updated_at?: string | null;
}

interface RawSurveyEnvelopeRow {
  id: string;
  type: string;
  date?: string | null;
  store?: string | null;
  promoter?: string | null;
  product?: string | null;
  comments?: string | Record<string, unknown> | null;
  creatorId?: string | null;
  created_at?: string | null;
}

const supabaseHeaders = (extra?: Record<string, string>): Record<string, string> => {
  const activeJwt = getCachedAccessToken();
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${activeJwt || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
};

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 2
): Promise<Response> {
  assertSupabaseConfigured();
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(url, init);
      if (response.status >= 500 && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
        attempt += 1;
        continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries) break;
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      attempt += 1;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Error de red al conectar con Supabase');
}

function generateUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getTodayVenezuelaIso(): string {
  const now = new Date();
  const veMs = now.getTime() - 4 * 60 * 60 * 1000;
  return new Date(veMs).toISOString().slice(0, 10);
}

export function isoToDdMmYyyy(isoDate: string): string {
  const clean = (isoDate || '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const [yyyy, mm, dd] = clean.split('-');
    return `${dd}/${mm}/${yyyy}`;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(isoDate.trim())) {
    return isoDate.trim();
  }
  return isoToDdMmYyyy(getTodayVenezuelaIso());
}

export function ddMmYyyyToIso(slashDate: string): string {
  const clean = (slashDate || '').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(clean)) {
    const [dd, mm, yyyy] = clean.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean.slice(0, 10))) {
    return clean.slice(0, 10);
  }
  return getTodayVenezuelaIso();
}

export function createInitialSolicitudRows(count = 10): SolicitudProductoRowItem[] {
  return Array.from({ length: Math.max(10, count) }, (_, idx) => ({
    itemNumber: idx + 1,
    producto: '',
    cantidad: '',
  }));
}

export function parseMp07SequenceNumber(code: string | undefined | null): number | null {
  if (!code) return null;
  const match = String(code).trim().toUpperCase().match(/^MP-07-(\d+)$/);
  if (!match) return null;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function computeNextSolicitudCorrelativeCode(
  existing: Array<Pick<SolicitudProductoContraloria, 'codigoCorrelativo'>>
): string {
  let maxSeq = BASE_INITIAL_SEQUENCE;
  for (const item of existing) {
    const seq = parseMp07SequenceNumber(item.codigoCorrelativo);
    if (seq !== null && seq > maxSeq) {
      maxSeq = seq;
    }
  }
  const nextSeq = maxSeq + 1;
  return `${CORRELATIVE_PREFIX}${String(nextSeq).padStart(4, '0')}`;
}

export interface ValidatedSolicitudDraftResult {
  valid: boolean;
  error?: string;
  validItems: SolicitudProductoValidItem[];
  totalUnidades: number;
  normalizedParaSerUtilizado: string;
  normalizedDirigidoA: string;
  normalizedObservacion: string;
}

export function validateSolicitudContraloriaDraft(params: {
  dirigidoA: string;
  paraSerUtilizado: string;
  items: SolicitudProductoRowItem[];
  observacion: string;
}): ValidatedSolicitudDraftResult {
  const normalizedDirigidoA = (params.dirigidoA || '').trim().toUpperCase() || 'CONTRALORÍA';
  const normalizedParaSerUtilizado = (params.paraSerUtilizado || '').trim().toUpperCase();
  const normalizedObservacion = (params.observacion || '').trim().toUpperCase();

  if (!normalizedParaSerUtilizado) {
    return {
      valid: false,
      error: 'El campo "PARA SER UTILIZADO" es obligatorio para enviar la solicitud a Contraloría.',
      validItems: [],
      totalUnidades: 0,
      normalizedParaSerUtilizado,
      normalizedDirigidoA,
      normalizedObservacion,
    };
  }

  const validItems: SolicitudProductoValidItem[] = [];

  for (let i = 0; i < params.items.length; i++) {
    const row = params.items[i];
    const rowLabel = row.itemNumber || i + 1;
    const prod = (row.producto || '').trim().toUpperCase();
    const rawQty = row.cantidad;
    const hasQtyInput =
      rawQty !== '' && rawQty !== null && rawQty !== undefined && String(rawQty).trim() !== '';
    const numQty = hasQtyInput ? Number(rawQty) : 0;

    if (!prod && !hasQtyInput) {
      continue;
    }

    if (!prod && hasQtyInput && numQty > 0) {
      return {
        valid: false,
        error: `En el ITEM ${rowLabel} ingresó una cantidad (${rawQty}) pero falta especificar el nombre del PRODUCTO.`,
        validItems: [],
        totalUnidades: 0,
        normalizedParaSerUtilizado,
        normalizedDirigidoA,
        normalizedObservacion,
      };
    }

    if (prod && (!hasQtyInput || !Number.isFinite(numQty) || numQty <= 0)) {
      return {
        valid: false,
        error: `En el ITEM ${rowLabel} ("${prod}") debe ingresar una CANTIDAD numérica mayor a 0.`,
        validItems: [],
        totalUnidades: 0,
        normalizedParaSerUtilizado,
        normalizedDirigidoA,
        normalizedObservacion,
      };
    }

    if (prod && numQty > 0) {
      validItems.push({
        itemNumber: validItems.length + 1,
        producto: prod,
        cantidad: Number(numQty.toFixed(2)),
      });
    }
  }

  if (validItems.length === 0) {
    return {
      valid: false,
      error:
        'Debe incluir al menos 1 producto con nombre válido y CANTIDAD mayor a 0 en el bloque SOLICITUD.',
      validItems: [],
      totalUnidades: 0,
      normalizedParaSerUtilizado,
      normalizedDirigidoA,
      normalizedObservacion,
    };
  }

  const totalUnidades = Number(
    validItems.reduce((sum, it) => sum + it.cantidad, 0).toFixed(2)
  );

  return {
    valid: true,
    validItems,
    totalUnidades,
    normalizedParaSerUtilizado,
    normalizedDirigidoA,
    normalizedObservacion,
  };
}

function normalizeEstado(raw: unknown): SolicitudContraloriaEstado {
  const upper = String(raw || '').trim().toUpperCase();
  if (upper === 'APROBADA' || upper === 'APROBADO') return 'APROBADA';
  if (upper === 'RECHAZADA' || upper === 'RECHAZADO') return 'RECHAZADA';
  return 'PENDIENTE_APROBACION';
}

function normalizeItemsArray(rawItems: unknown): SolicitudProductoValidItem[] {
  let arr: unknown[] = [];
  if (Array.isArray(rawItems)) {
    arr = rawItems;
  } else if (typeof rawItems === 'string') {
    try {
      const parsed = JSON.parse(rawItems);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }

  const result: SolicitudProductoValidItem[] = [];
  arr.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') return;
    const obj = entry as Record<string, unknown>;
    const producto = String(obj.producto ?? obj.productName ?? '').trim().toUpperCase();
    const cantidad = Number(obj.cantidad ?? obj.quantityRequested ?? 0);
    if (producto && Number.isFinite(cantidad) && cantidad > 0) {
      result.push({
        itemNumber: Number(obj.itemNumber) || idx + 1,
        producto,
        cantidad: Number(cantidad.toFixed(2)),
      });
    }
  });
  return result;
}

export function parseDedicatedSolicitudRow(
  row: Partial<RawDedicatedSolicitudRow> | null | undefined
): SolicitudProductoContraloria | null {
  if (!row || !row.id || !row.codigo_correlativo) return null;
  const items = normalizeItemsArray(row.items);
  const totalUnidades =
    Number(row.total_unidades) > 0
      ? Number(Number(row.total_unidades).toFixed(2))
      : Number(items.reduce((acc, it) => acc + it.cantidad, 0).toFixed(2));
  const fechaIso = row.fecha_iso || ddMmYyyyToIso(row.fecha_solicitud || '');
  const fechaSolicitud = row.fecha_solicitud || isoToDdMmYyyy(fechaIso);

  return {
    id: String(row.id),
    codigoCorrelativo: String(row.codigo_correlativo).trim().toUpperCase(),
    fechaSolicitud,
    fechaIso,
    dirigidoA: String(row.dirigido_a || 'CONTRALORÍA').trim().toUpperCase(),
    paraSerUtilizado: String(row.para_ser_utilizado || '').trim().toUpperCase(),
    items,
    totalUnidades,
    observacion: String(row.observacion || '').trim().toUpperCase(),
    solicitadoPor: String(row.solicitado_por || 'MERCADEO Y PUBLICIDAD').trim(),
    firmaDigitalTexto: row.firma_digital_texto ? String(row.firma_digital_texto) : undefined,
    firmaDigitalImagen: row.firma_digital_imagen ? String(row.firma_digital_imagen) : undefined,
    departamentoSolicitante:
      String(row.departamento_solicitante || 'MERCADEO Y PUBLICIDAD').trim().toUpperCase(),
    estado: normalizeEstado(row.estado),
    notaContraloria: row.nota_contraloria ? String(row.nota_contraloria) : undefined,
    resueltoPor: row.resuelto_por ? String(row.resuelto_por) : undefined,
    resueltoAt: row.resuelto_at ? String(row.resuelto_at) : undefined,
    leidoContraloria: Boolean(row.leido_contraloria),
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || row.created_at || new Date().toISOString(),
  };
}

export function parseSurveyEnvelopeSolicitudRow(
  row: Partial<RawSurveyEnvelopeRow> | null | undefined
): SolicitudProductoContraloria | null {
  if (!row || !row.id || row.type !== SOLICITUD_SURVEY_TYPE) return null;

  let env: Record<string, unknown> = {};
  if (typeof row.comments === 'string') {
    try {
      env = JSON.parse(row.comments) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (row.comments && typeof row.comments === 'object') {
    env = row.comments as Record<string, unknown>;
  }

  const codigoCorrelativo = String(
    env.codigoCorrelativo || row.creatorId || ''
  )
    .trim()
    .toUpperCase();
  if (!codigoCorrelativo) return null;

  const items = normalizeItemsArray(env.items);
  const totalUnidades =
    Number(env.totalUnidades) > 0
      ? Number(Number(env.totalUnidades).toFixed(2))
      : Number(items.reduce((acc, it) => acc + it.cantidad, 0).toFixed(2));
  const fechaIso = String(env.fechaIso || row.date || getTodayVenezuelaIso()).slice(0, 10);
  const fechaSolicitud = String(env.fechaSolicitud || isoToDdMmYyyy(fechaIso));

  return {
    id: String(row.id),
    codigoCorrelativo,
    fechaSolicitud,
    fechaIso,
    dirigidoA: String(env.dirigidoA || row.store || 'CONTRALORÍA').trim().toUpperCase(),
    paraSerUtilizado: String(env.paraSerUtilizado || row.product || '').trim().toUpperCase(),
    items,
    totalUnidades,
    observacion: String(env.observacion || '').trim().toUpperCase(),
    solicitadoPor: String(env.solicitadoPor || row.promoter || 'Trade Marketing').trim(),
    firmaDigitalTexto: env.firmaDigitalTexto ? String(env.firmaDigitalTexto) : undefined,
    firmaDigitalImagen: env.firmaDigitalImagen ? String(env.firmaDigitalImagen) : undefined,
    departamentoSolicitante:
      String(env.departamentoSolicitante || 'MERCADEO Y PUBLICIDAD').trim().toUpperCase(),
    estado: normalizeEstado(env.estado),
    notaContraloria: env.notaContraloria ? String(env.notaContraloria) : undefined,
    resueltoPor: env.resueltoPor ? String(env.resueltoPor) : undefined,
    resueltoAt: env.resueltoAt ? String(env.resueltoAt) : undefined,
    leidoContraloria: Boolean(env.leidoContraloria),
    createdAt: String(env.createdAt || row.created_at || new Date().toISOString()),
    updatedAt: String(env.updatedAt || env.createdAt || row.created_at || new Date().toISOString()),
  };
}

function buildSurveyEnvelopePayload(solicitud: SolicitudProductoContraloria) {
  return {
    id: solicitud.id,
    type: SOLICITUD_SURVEY_TYPE,
    date: solicitud.fechaIso,
    store: solicitud.dirigidoA,
    promoter: solicitud.solicitadoPor,
    product: solicitud.paraSerUtilizado.slice(0, 240),
    creatorId: solicitud.codigoCorrelativo,
    comments: JSON.stringify({
      schema: 'codizulca.solicitud_productos_contraloria.v1',
      id: solicitud.id,
      codigoCorrelativo: solicitud.codigoCorrelativo,
      fechaSolicitud: solicitud.fechaSolicitud,
      fechaIso: solicitud.fechaIso,
      dirigidoA: solicitud.dirigidoA,
      paraSerUtilizado: solicitud.paraSerUtilizado,
      items: solicitud.items,
      totalUnidades: solicitud.totalUnidades,
      observacion: solicitud.observacion,
      solicitadoPor: solicitud.solicitadoPor,
      firmaDigitalTexto: solicitud.firmaDigitalTexto || '',
      firmaDigitalImagen: solicitud.firmaDigitalImagen || '',
      departamentoSolicitante: solicitud.departamentoSolicitante,
      estado: solicitud.estado,
      notaContraloria: solicitud.notaContraloria || '',
      resueltoPor: solicitud.resueltoPor || '',
      resueltoAt: solicitud.resueltoAt || null,
      leidoContraloria: Boolean(solicitud.leidoContraloria),
      createdAt: solicitud.createdAt,
      updatedAt: solicitud.updatedAt || solicitud.createdAt,
    }),
  };
}


function emitSolicitudRealtimeBridge(
  eventType: 'INSERT' | 'UPDATE',
  solicitud: SolicitudProductoContraloria
): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(SOLICITUD_CONTRALORIA_LOCAL_EVENT, {
        detail: { eventType, solicitud },
      })
    );
  }
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel(SOLICITUD_CONTRALORIA_BROADCAST_CHANNEL);
      bc.postMessage({ eventType, solicitud });
      bc.close();
    }
  } catch {
    // BroadcastChannel optional
  }
}

function isDedicatedTableMissing(status: number, bodyText: string): boolean {
  if (status === 404) return true;
  return /solicitudes_contraloria|PGRST205|42P01|relation .* does not exist/i.test(bodyText);
}

function sortAndDeduplicateSolicitudes(
  items: SolicitudProductoContraloria[]
): SolicitudProductoContraloria[] {
  const byId = new Map<string, SolicitudProductoContraloria>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    const existingTs = new Date(existing.updatedAt || existing.createdAt).getTime() || 0;
    const candidateTs = new Date(item.updatedAt || item.createdAt).getTime() || 0;
    if (candidateTs >= existingTs) {
      byId.set(item.id, item);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const tsB = new Date(b.createdAt).getTime() || 0;
    const tsA = new Date(a.createdAt).getTime() || 0;
    if (tsB !== tsA) return tsB - tsA;
    const seqB = parseMp07SequenceNumber(b.codigoCorrelativo) ?? 0;
    const seqA = parseMp07SequenceNumber(a.codigoCorrelativo) ?? 0;
    return seqB - seqA;
  });
}

export async function fetchSolicitudesContraloriaFromSupabase(): Promise<
  SolicitudProductoContraloria[]
> {
  const collected: SolicitudProductoContraloria[] = [];

  if (detectedBackendMode !== 'surveys_envelope') {
    const dedicatedRes = await fetchWithRetry(
      `${SUPABASE_REST_URL}/solicitudes_contraloria?select=*&order=created_at.desc&limit=500`,
      {
        method: 'GET',
        headers: supabaseHeaders(),
      }
    );

    if (dedicatedRes.ok) {
      detectedBackendMode = 'dedicated_table';
      const rows = (await dedicatedRes.json()) as RawDedicatedSolicitudRow[];
      rows.forEach((r) => {
        const parsed = parseDedicatedSolicitudRow(r);
        if (parsed) collected.push(parsed);
      });
    } else {
      const errBody = await dedicatedRes.text().catch(() => '');
      if (isDedicatedTableMissing(dedicatedRes.status, errBody)) {
        detectedBackendMode = 'surveys_envelope';
      } else {
        throw new Error(
          `Error consultando solicitudes_contraloria (${dedicatedRes.status}): ${errBody}`
        );
      }
    }
  }

  // Consultar también registros almacenados en `public.surveys` con `type = 'SolicitudContraloria'`
  // para garantizar continuidad total si hubo registros previos a la migración SQL dedicada.
  const surveysRes = await fetchWithRetry(
    `${SUPABASE_REST_URL}/surveys?type=eq.${encodeURIComponent(
      SOLICITUD_SURVEY_TYPE
    )}&select=id,type,date,store,promoter,product,comments,creatorId,created_at&order=created_at.desc&limit=500`,
    {
      method: 'GET',
      headers: supabaseHeaders(),
    }
  );

  if (surveysRes.ok) {
    const rows = (await surveysRes.json()) as RawSurveyEnvelopeRow[];
    rows.forEach((r) => {
      const parsed = parseSurveyEnvelopeSolicitudRow(r);
      if (parsed) collected.push(parsed);
    });
  } else if (detectedBackendMode === 'surveys_envelope') {
    const errText = await surveysRes.text().catch(() => '');
    throw new Error(`Error consultando solicitudes en Supabase (${surveysRes.status}): ${errText}`);
  }

  const normalized = sortAndDeduplicateSolicitudes(collected);
  return normalized;
}

export async function createSolicitudContraloriaInSupabase(
  input: CreateSolicitudContraloriaInput
): Promise<SolicitudProductoContraloria> {
  const validation = validateSolicitudContraloriaDraft({
    dirigidoA: input.dirigidoA,
    paraSerUtilizado: input.paraSerUtilizado,
    items: input.items,
    observacion: input.observacion,
  });

  if (!validation.valid) {
    throw new Error(validation.error || 'Datos de solicitud inválidos.');
  }

  // Consultar estado actual en BD para evitar colisión de código correlativo MP-07-XXXX
  // Sin respaldo local: si no se puede verificar el correlativo en el servidor, no se crea la solicitud.
  const currentRemote: SolicitudProductoContraloria[] = await fetchSolicitudesContraloriaFromSupabase();

  const existingCodes = new Set(
    currentRemote.map((s) => s.codigoCorrelativo.trim().toUpperCase())
  );

  let finalCode = (input.codigoCorrelativo || '').trim().toUpperCase();
  if (!finalCode || existingCodes.has(finalCode)) {
    finalCode = computeNextSolicitudCorrelativeCode(currentRemote);
  }

  const nowIso = new Date().toISOString();
  const fechaIso = input.fechaIso ? ddMmYyyyToIso(input.fechaIso) : getTodayVenezuelaIso();
  const fechaSolicitud = input.fechaSolicitud
    ? isoToDdMmYyyy(input.fechaSolicitud)
    : isoToDdMmYyyy(fechaIso);

  const newSolicitud: SolicitudProductoContraloria = {
    id: generateUuidV4(),
    codigoCorrelativo: finalCode,
    fechaSolicitud,
    fechaIso,
    dirigidoA: validation.normalizedDirigidoA,
    paraSerUtilizado: validation.normalizedParaSerUtilizado,
    items: validation.validItems,
    totalUnidades: validation.totalUnidades,
    observacion: validation.normalizedObservacion,
    solicitadoPor: (input.solicitadoPor || '').trim() || 'Jefatura Trade Marketing',
    firmaDigitalTexto: (input.firmaDigitalTexto || input.solicitadoPor || '').trim(),
    firmaDigitalImagen: input.firmaDigitalImagen || undefined,
    departamentoSolicitante:
      (input.departamentoSolicitante || 'MERCADEO Y PUBLICIDAD').trim().toUpperCase(),
    estado: 'PENDIENTE_APROBACION',
    leidoContraloria: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (detectedBackendMode !== 'surveys_envelope') {
    const dedicatedPayload = {
      id: newSolicitud.id,
      codigo_correlativo: newSolicitud.codigoCorrelativo,
      fecha_solicitud: newSolicitud.fechaSolicitud,
      fecha_iso: newSolicitud.fechaIso,
      dirigido_a: newSolicitud.dirigidoA,
      para_ser_utilizado: newSolicitud.paraSerUtilizado,
      items: newSolicitud.items,
      total_unidades: newSolicitud.totalUnidades,
      observacion: newSolicitud.observacion,
      solicitado_por: newSolicitud.solicitadoPor,
      firma_digital_texto: newSolicitud.firmaDigitalTexto || null,
      firma_digital_imagen: newSolicitud.firmaDigitalImagen || null,
      departamento_solicitante: newSolicitud.departamentoSolicitante,
      estado: 'PENDIENTE_APROBACION',
      leido_contraloria: false,
      created_at: newSolicitud.createdAt,
    };

    const dedicatedRes = await fetchWithRetry(`${SUPABASE_REST_URL}/solicitudes_contraloria`, {
      method: 'POST',
      headers: supabaseHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify(dedicatedPayload),
    });

    if (dedicatedRes.ok) {
      detectedBackendMode = 'dedicated_table';
      const createdRows = (await dedicatedRes.json()) as RawDedicatedSolicitudRow[];
      const confirmed = parseDedicatedSolicitudRow(createdRows[0]) || newSolicitud;
      emitSolicitudRealtimeBridge('INSERT', confirmed);
      return confirmed;
    }

    const errText = await dedicatedRes.text().catch(() => '');
    if (isDedicatedTableMissing(dedicatedRes.status, errText)) {
      detectedBackendMode = 'surveys_envelope';
    } else {
      throw new Error(`No se pudo radicar la solicitud (${dedicatedRes.status}): ${errText}`);
    }
  }

  // Persistencia en vivo sobre `public.surveys` con `type = 'SolicitudContraloria'`
  const envelopePayload = buildSurveyEnvelopePayload(newSolicitud);
  const surveyRes = await fetchWithRetry(`${SUPABASE_REST_URL}/surveys`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(envelopePayload),
  });

  if (!surveyRes.ok) {
    const errText = await surveyRes.text().catch(() => '');
    throw new Error(`Error al guardar la solicitud en Supabase (${surveyRes.status}): ${errText}`);
  }

  const insertedRows = (await surveyRes.json()) as RawSurveyEnvelopeRow[];
  const confirmed = parseSurveyEnvelopeSolicitudRow(insertedRows[0]) || newSolicitud;
  emitSolicitudRealtimeBridge('INSERT', confirmed);
  return confirmed;
}

export async function resolveSolicitudContraloriaInSupabase(params: {
  solicitud: SolicitudProductoContraloria;
  decision: 'APROBADA' | 'RECHAZADA';
  notaContraloria?: string;
  auditorName?: string;
}): Promise<SolicitudProductoContraloria> {
  const nowIso = new Date().toISOString();
  const cleanNote = (params.notaContraloria || '').trim();
  const cleanAuditor = (params.auditorName || 'Contraloría Interna Codizulca').trim();

  const updatedSolicitud: SolicitudProductoContraloria = {
    ...params.solicitud,
    estado: params.decision,
    notaContraloria: cleanNote || undefined,
    resueltoPor: cleanAuditor,
    resueltoAt: nowIso,
    leidoContraloria: true,
    updatedAt: nowIso,
  };

  let updatedInDedicated = false;

  if (detectedBackendMode !== 'surveys_envelope') {
    const dedicatedRes = await fetchWithRetry(
      `${SUPABASE_REST_URL}/solicitudes_contraloria?id=eq.${encodeURIComponent(
        params.solicitud.id
      )}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({
          estado: params.decision,
          nota_contraloria: cleanNote || null,
          resuelto_por: cleanAuditor,
          resuelto_at: nowIso,
          leido_contraloria: true,
        }),
      }
    );

    if (dedicatedRes.ok) {
      detectedBackendMode = 'dedicated_table';
      const rows = (await dedicatedRes.json()) as RawDedicatedSolicitudRow[];
      if (rows.length > 0) {
        updatedInDedicated = true;
        const confirmed = parseDedicatedSolicitudRow(rows[0]) || updatedSolicitud;
        emitSolicitudRealtimeBridge('UPDATE', confirmed);
        return confirmed;
      }
    } else {
      const errText = await dedicatedRes.text().catch(() => '');
      if (isDedicatedTableMissing(dedicatedRes.status, errText)) {
        detectedBackendMode = 'surveys_envelope';
      } else {
        throw new Error(
          `No se pudo actualizar la solicitud en Contraloría (${dedicatedRes.status}): ${errText}`
        );
      }
    }
  }

  if (!updatedInDedicated) {
    const envelopePayload = buildSurveyEnvelopePayload(updatedSolicitud);
    const surveyRes = await fetchWithRetry(
      `${SUPABASE_REST_URL}/surveys?id=eq.${encodeURIComponent(params.solicitud.id)}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({
          comments: envelopePayload.comments,
        }),
      }
    );

    if (!surveyRes.ok) {
      const errText = await surveyRes.text().catch(() => '');
      throw new Error(
        `Error al actualizar estado en Supabase (${surveyRes.status}): ${errText}`
      );
    }

    const rows = (await surveyRes.json()) as RawSurveyEnvelopeRow[];
    const confirmed = parseSurveyEnvelopeSolicitudRow(rows[0]) || updatedSolicitud;
    emitSolicitudRealtimeBridge('UPDATE', confirmed);
    return confirmed;
  }

  return updatedSolicitud;
}
