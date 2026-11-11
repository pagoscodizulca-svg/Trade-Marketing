export const PRODUCTOS = ['AHUMADO', 'ESTANDAR', 'MORTADELA', 'VENCAMPO', 'ESPALDA'] as const;
export type Producto = (typeof PRODUCTOS)[number];

export const TURNOS = ['MAÑANA', 'TARDE'] as const;
export type Turno = (typeof TURNOS)[number];

export type AppMode = 'chofer' | 'oficina';

export interface Entrega {
  id: string;
  /** Ej. "JUEVES 05", "VIERNES 06", "SÁBADO 07" */
  fecha: string;
  turno: Turno;
  /** Ej. "MAÑANA 6", "TARDE 4" */
  numero_grupo_turno: string;
  cliente: string;
  producto: Producto;
  vendedor: string;
  promotora: string;
  stand_entregado: boolean;
  producto_entregado: boolean;
  /** true cuando la entrega está lista */
  completado: boolean;
  /** Hora local "HH:mm" o null */
  hora_entrega: string | null;
  notas_chofer: string;
}

/**
 * Estado de la tarjeta respecto al servidor:
 *  - 'pendiente': el chofer la marcó sin conexión y está guardada en el teléfono, a la espera de red.
 *  - 'sincronizado_offline': estuvo pendiente y la cola ya la confirmó el servidor.
 *  - undefined: sin marca (datos tal como los tiene el servidor).
 */
export type EstadoSyncTarjeta = 'pendiente' | 'sincronizado_offline';

/** Entrega tal como la ve la UI: los datos del servidor + el estado de sincronización de la tarjeta. */
export interface EntregaVista extends Entrega {
  sync?: EstadoSyncTarjeta;
}

export type NuevaEntrega = Omit<
  Entrega,
  'id' | 'stand_entregado' | 'producto_entregado' | 'completado' | 'hora_entrega' | 'notas_chofer'
> &
  Partial<Pick<Entrega, 'notas_chofer'>>;
