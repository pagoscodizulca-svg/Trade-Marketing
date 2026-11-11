import type { Entrega } from '../types';

/** Campos que el chofer puede modificar. Una operación puede llevar solo algunos (p. ej. solo la nota). */
export interface OutboxPayload {
  completado?: boolean;
  stand_entregado?: boolean;
  producto_entregado?: boolean;
  notas_chofer?: string;
  /** Instante exacto (ISO) en que el chofer tocó «Entregado»; null al deshacer. */
  hora_entrega_real?: string | null;
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
  if (payload.notas_chofer !== undefined) out.notas_chofer = payload.notas_chofer;
  if (payload.hora_entrega_real !== undefined) {
    out.hora_entrega = payload.hora_entrega_real ? horaLocalHHmm(payload.hora_entrega_real) : null;
  }
  return out;
}

/** Columnas opcionales (requieren la migración 20261106_entregas_offline_sync.sql). */
export const COLUMNAS_EXTRA = ['hora_entrega_real', 'actualizado_chofer_at'] as const;

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
  if (incluirColumnasExtra) body.actualizado_chofer_at = createdAtIso;
  return body;
}
