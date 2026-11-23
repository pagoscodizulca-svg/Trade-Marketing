import type { Entrega, EstadoLogistico } from '../types';

/** Campos que el chofer puede modificar. Una operación puede llevar solo algunos (p. ej. solo la nota). */
export interface OutboxPayload {
  completado?: boolean;
  stand_entregado?: boolean;
  producto_entregado?: boolean;
  estado_logistico?: EstadoLogistico;
  notas_chofer?: string;
  /** Instante exacto (ISO) en que el chofer confirmó salida; null al limpiar. */
  hora_salida_real?: string | null;
  /** Instante exacto (ISO) en que el chofer confirmó llegada / «Entregado»; null al deshacer. */
  hora_llegada_real?: string | null;
  /** Instante exacto (ISO) en que el chofer tocó «Entregado»; null al deshacer. */
  hora_entrega_real?: string | null;
  evidencia_path?: string | null;
  evidencia_bucket?: string | null;
  evidencia_subida_at?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Hora local «HH:mm» de un instante ISO (la hora del teléfono en el momento del toque). */
export function horaLocalHHmm(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Aplica una operación sobre una entrega (para la UI optimista y para superponer la cola sobre datos del servidor). */
export function applyPayload<T extends Entrega>(entrega: T, payload: OutboxPayload): T {
  const out: T = { ...entrega };
  if (payload.completado !== undefined) out.completado = payload.completado;
  if (payload.stand_entregado !== undefined) out.stand_entregado = payload.stand_entregado;
  if (payload.producto_entregado !== undefined) out.producto_entregado = payload.producto_entregado;
  if (payload.estado_logistico !== undefined) out.estado_logistico = payload.estado_logistico;
  if (payload.notas_chofer !== undefined) out.notas_chofer = payload.notas_chofer;
  if (payload.hora_salida_real !== undefined) {
    out.hora_salida_real = payload.hora_salida_real;
    out.hora_salida = payload.hora_salida_real ? horaLocalHHmm(payload.hora_salida_real) : null;
  }
  if (payload.hora_llegada_real !== undefined) {
    out.hora_llegada = payload.hora_llegada_real ? horaLocalHHmm(payload.hora_llegada_real) : null;
  }
  if (payload.hora_entrega_real !== undefined) {
    out.hora_entrega = payload.hora_entrega_real ? horaLocalHHmm(payload.hora_entrega_real) : null;
    if (payload.hora_llegada_real === undefined) {
      out.hora_llegada = out.hora_entrega;
    }
  }
  if (payload.evidencia_path !== undefined) out.evidencia_path = payload.evidencia_path;
  if (payload.evidencia_bucket !== undefined) out.evidencia_bucket = payload.evidencia_bucket;
  if (payload.evidencia_subida_at !== undefined) out.evidencia_subida_at = payload.evidencia_subida_at;
  return out;
}

/** Columnas opcionales (requieren la migración de sincronización offline y logística del chofer). */
export const COLUMNAS_EXTRA = [
  'hora_entrega_real',
  'actualizado_chofer_at',
  'estado_logistico',
  'hora_salida',
  'hora_salida_real',
  'hora_llegada',
  'evidencia_path',
  'evidencia_bucket',
  'evidencia_subida_at',
] as const;

/** Cuerpo del PATCH a Supabase con valores ABSOLUTOS (idempotente: repetirlo no cambia el resultado). */
export function construirCuerpoServidor(
  payload: OutboxPayload,
  createdAtIso: string,
  incluirColumnasExtra: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (payload.completado !== undefined) body.completado = payload.completado;
  if (payload.stand_entregado !== undefined) body.stand_entregado = payload.stand_entregado;
  if (payload.producto_entregado !== undefined) body.producto_entregado = payload.producto_entregado;
  if (payload.notas_chofer !== undefined) body.notas_chofer = payload.notas_chofer;
  if (payload.hora_entrega_real !== undefined) {
    body.hora_entrega = payload.hora_entrega_real ? horaLocalHHmm(payload.hora_entrega_real) : null;
    if (incluirColumnasExtra) body.hora_entrega_real = payload.hora_entrega_real;
  }
  if (incluirColumnasExtra) {
    if (payload.estado_logistico !== undefined) body.estado_logistico = payload.estado_logistico;
    if (payload.hora_salida_real !== undefined) {
      body.hora_salida_real = payload.hora_salida_real;
      body.hora_salida = payload.hora_salida_real ? horaLocalHHmm(payload.hora_salida_real) : null;
    }
    if (payload.hora_llegada_real !== undefined) {
      body.hora_llegada = payload.hora_llegada_real ? horaLocalHHmm(payload.hora_llegada_real) : null;
    } else if (payload.hora_entrega_real !== undefined) {
      body.hora_llegada = payload.hora_entrega_real ? horaLocalHHmm(payload.hora_entrega_real) : null;
    }
    if (payload.evidencia_path !== undefined) body.evidencia_path = payload.evidencia_path;
    if (payload.evidencia_bucket !== undefined) body.evidencia_bucket = payload.evidencia_bucket;
    if (payload.evidencia_subida_at !== undefined) body.evidencia_subida_at = payload.evidencia_subida_at;
    body.actualizado_chofer_at = createdAtIso;
  }
  return body;
}
