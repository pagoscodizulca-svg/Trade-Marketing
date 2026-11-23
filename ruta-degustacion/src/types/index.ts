export const PRODUCTOS = ['AHUMADO', 'ESTANDAR', 'MORTADELA', 'VENCAMPO', 'ESPALDA'] as const;
export type Producto = (typeof PRODUCTOS)[number];

export const TURNOS = ['MAÑANA', 'TARDE'] as const;
export type Turno = (typeof TURNOS)[number];

export type EstadoLogistico = 'PENDIENTE' | 'EN_RUTA' | 'ENTREGADO';

export type AppMode = 'chofer' | 'oficina';

export const OPERATIVE_SUCURSALES = [
  'ZULIA',
  'VALENCIA',
  'CENTRO',
  'ORIENTE',
  'CAPITAL',
] as const;
export type OperativeSucursal = (typeof OPERATIVE_SUCURSALES)[number];

export type RutaAppRole = 'super_admin' | 'coordinacion' | 'chofer';
export type SucursalCodigo = OperativeSucursal | 'GLOBAL';

export interface RutaAuthUser {
  id: string;
  email: string;
  fullName: string;
  role: RutaAppRole;
  sucursal: SucursalCodigo;
}

export interface Entrega {
  id: string;
  /** Ej. "JUEVES 05", "VIERNES 06", "SÁBADO 07" */
  fecha: string;
  turno: Turno;
  /** Ej. "MAÑANA 6", "TARDE 4" */
  numero_grupo_turno: string;
  cliente: string;
  producto: string;
  vendedor: string;
  promotora: string;
  stand_entregado: boolean;
  producto_entregado: boolean;
  /** true cuando la entrega está lista */
  completado: boolean;
  /** Estado logístico del viaje del chofer */
  estado_logistico?: EstadoLogistico;
  /** Hora local "HH:mm" de confirmación de salida o null */
  hora_salida?: string | null;
  /** Timestamp ISO exacto de salida o null */
  hora_salida_real?: string | null;
  /** Hora local "HH:mm" de llegada al PDV o null */
  hora_llegada?: string | null;
  /** Hora local "HH:mm" o null */
  hora_entrega: string | null;
  /** Path privado en Supabase Storage (bucket `entregas-evidencias`) */
  evidencia_path?: string | null;
  evidencia_bucket?: string | null;
  evidencia_subida_at?: string | null;
  /** Referencia opcional al registro origen en `cronograma_degustaciones` */
  cronograma_id?: string | null;
  notas_chofer: string;
  /** Sucursal operativa propietaria del registro (usada para filtro global de Super Admin) */
  sucursal?: OperativeSucursal;
  /** Región operativa de origen ('Occidente' | 'Centro' | 'Andes') */
  region?: string;
  /** Sede del chofer responsable ('OCCIDENTE' | 'VALENCIA') */
  chofer_sede?: 'OCCIDENTE' | 'VALENCIA';
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
  'id' | 'stand_entregado' | 'producto_entregado' | 'completado' | 'hora_entrega' | 'notas_chofer' | 'sucursal'
> &
  Partial<Pick<Entrega, 'notas_chofer' | 'sucursal'>>;
