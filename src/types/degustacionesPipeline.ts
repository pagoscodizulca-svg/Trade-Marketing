import type { OperationalSupplies, ShiftType } from './index';

// =============================================================================
// FASE 1: CONTRATOS DE DATOS Y MÁQUINA DE ESTADOS
// Ecosistema: Módulo 1 (Carga) -> Módulo 2 (Coordinación) -> App Promotoras (Ruta)
// =============================================================================

export type ArchivoPlanificacionExtension = 'xlsx' | 'xls' | 'csv' | 'pdf';

export type MetodoExtraccionArchivo = 'TABULAR_DETERMINISTA' | 'IA_ESTRUCTURADA';

/**
 * Estados oficiales del Cronograma de Degustaciones en Módulo 2.
 * Toda carga nueva entra obligatoriamente en `PENDIENTE_APROBACION`.
 */
export type EstadoCronogramaDegustacion =
  | 'PENDIENTE_APROBACION'
  | 'APROBADA'
  | 'NO_AUTORIZADA'
  | 'RECHAZADA'
  | 'CANCELADA'
  | 'EN_CURSO'
  | 'COMPLETADA';

/**
 * Estados del ítem dentro del Módulo de Ruta de la App de las Promotoras.
 */
export type EstadoRutaPromotora =
  | 'ASIGNADA'
  | 'EN_CURSO'
  | 'COMPLETADA'
  | 'CANCELADA';

/**
 * Semáforo visual de validación pre-volcado en la Bandeja del Módulo 1:
 * - `VALIDO` (Verde): datos completos y emparejados con catálogos reales (PDV + Promotora opcional activa).
 * - `ADVERTENCIA` (Amarillo): dato sugerido no reconocido en catálogo o duplicado detectado (corregible en fila).
 * - `ERROR` (Rojo): dato crítico faltante o fecha/cantidad inválida que impide volcar mientras no se corrija.
 */
export type NivelValidacionFilaCarga = 'VALIDO' | 'ADVERTENCIA' | 'ERROR';

export interface InsumosCalculadosDegustacion extends Partial<OperationalSupplies> {
  mortadelaQty?: number;
  espaldaQty?: number;
  arrozQty?: number;
  azucarGrams?: number;
  lecheGrams?: number;
}

/**
 * Registro persistido en `public.cargas_archivos` (trazabilidad por lote).
 */
export interface CargaArchivoRecord {
  id: string;
  nombre_archivo: string;
  extension: ArchivoPlanificacionExtension;
  mime_type: string;
  tamano_bytes: number;
  archivo_sha256: string;
  metodo_extraccion: MetodoExtraccionArchivo;
  total_filas_extraidas: number;
  total_filas_insertadas: number;
  total_filas_duplicadas: number;
  cargado_por: string;
  cargado_por_rol: string;
  notas: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Estructura normalizada común devuelta tanto por el parser determinista (Excel/CSV)
 * como por el extractor estructurado de PDF con IA antes de confirmar el volcado.
 */
export interface FilaDegustacionExtraida {
  rowIndex: number;
  excelRowNumber?: number; // Número real de fila 1-based en la hoja Excel o archivo CSV
  fecha: string; // Clave canónica interna aaaa-mm-dd (o '' si está vacía/inválida)
  fechaFormateada: string; // Representación visual exacta dd-mm-aaaa (ej. "05-03-2026", o '')
  fechaTimestamp: number | null; // Timestamp numérico UTC 00:00:00.000 comparable en memoria
  rawFechaRecibida?: string; // Valor original recibido desde la celda para diagnóstico de error
  fechaOrigenParcial?: boolean;
  fechaEditadaManualmente?: boolean;
  horaInicio: string; // HH:mm
  horaFin: string; // HH:mm
  turno: ShiftType;
  clienteNombre: string;
  clienteCodigo: string;
  zonaDireccion: string;
  productos: string[];
  productoResumen: string;
  cantidadKilos: number;
  personasEstimadas: number;
  vendedorFdv: string;
  promotoraSugerida: string;
  rawPromotoraArchivo?: string; // Nombre original extraído del archivo (ej. "JULIANNYS")
  promotoraCoincidenciaArchivo?: boolean; // true si coincidió unívocamente en Catálogo Activo desde el archivo
  promotoraAmbigua?: boolean; // true si hubo 2+ homónimas en Catálogo Activo
  promotoraId: string | null; // UUID emparejado en public.staff (o null si queda por asignar en Módulo 2)
  promotoraNombreResuelto: string | null;
  observaciones: string;
  idempotencyHash: string;
  nivelValidacion: NivelValidacionFilaCarga;
  mensajesValidacion: string[];
  esDuplicadoEnArchivo: boolean;
  esDuplicadoEnBaseDatos: boolean;
}

/**
 * Registro persistido en `public.cronograma_degustaciones` (Módulo 2).
 */
export interface CronogramaDegustacionRecord {
  id: string;
  carga_id: string | null;
  survey_origen_id: string | null;
  idempotency_hash: string;
  fecha: string; // YYYY-MM-DD
  hora_inicio: string;
  hora_fin: string;
  turno: ShiftType;
  cliente_nombre: string;
  cliente_codigo: string;
  zona_direccion: string;
  producto_resumen: string;
  productos: string[];
  cantidad_kilos: number;
  personas_estimadas: number;
  insumos_calculados: InsumosCalculadosDegustacion;
  vendedor_fdv: string;
  promotora_sugerida: string;
  promotora_id: string | null;
  promotora_nombre: string | null;
  promotora_email: string | null;
  observaciones: string;
  estado: EstadoCronogramaDegustacion;
  aprobado_por: string | null;
  fecha_aprobacion: string | null;
  rechazado_por: string | null;
  fecha_rechazo: string | null;
  motivo_rechazo: string | null;
  en_historial?: boolean;
  archivado_en?: string | null;
  motivo_archivo?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Registro sincronizado automáticamente en `public.rutas_promotoras` (App de las Promotoras).
 */
export interface RutaPromotoraRecord {
  id: string;
  cronograma_id: string;
  promotora_id: string;
  promotora_nombre: string;
  promotora_email: string;
  fecha: string; // YYYY-MM-DD
  hora_inicio: string;
  hora_fin: string;
  turno: ShiftType;
  cliente_nombre: string;
  cliente_codigo: string;
  zona_direccion: string;
  producto_resumen: string;
  productos: string[];
  cantidad_kilos: number;
  personas_estimadas: number;
  vendedor_fdv: string;
  observaciones: string;
  estado_ruta: EstadoRutaPromotora;
  checkin_at: string | null;
  checkout_at: string | null;
  checkin_lat?: number | null;
  checkin_lng?: number | null;
  checkin_accuracy_m?: number | null;
  checkin_distancia_m?: number | null;
  checkin_dentro_geocerca?: boolean | null;
  checkout_lat?: number | null;
  checkout_lng?: number | null;
  checkout_accuracy_m?: number | null;
  checkout_distancia_m?: number | null;
  checkout_dentro_geocerca?: boolean | null;
  pdv_lat_referencia?: number | null;
  pdv_lng_referencia?: number | null;
  pdv_radio_geocerca_m?: number | null;
  sucursal?: 'ZULIA' | 'VALENCIA' | 'GLOBAL' | null;
  aprobado_por: string | null;
  asignado_at: string;
  updated_at: string;
}

/**
 * Datos operativos de ejecución en PDV capturados en `/portal` al cerrar una degustación (`B-08`).
 */
export interface EjecucionPdvInput {
  lote_producto: string;
  fecha_vencimiento?: string | null;
  unidades_abiertas: number;
  muestras_entregadas: number;
  ventas_asistidas_unidades: number;
  observaciones: string;
}

export interface ResultadoEjecucionRutaPromotora {
  ok: boolean;
  ruta: RutaPromotoraRecord;
  distancia_m: number | null;
  radio_geocerca_m: number;
  dentro_geocerca: boolean | null;
  alerta_geocerca_registrada: boolean;
}

/**
 * Respuesta atómica de la RPC `public.volcar_lote_cronograma`.
 */
export interface ResultadoVolcadoLoteCronograma {
  carga_id: string;
  total_recibidas: number;
  total_insertadas: number;
  total_duplicadas: number;
  ids_insertados: string[];
}

/**
 * Respuesta atómica de la RPC `public.asignar_degustacion_aceptada_a_ruta`.
 */
export interface ResultadoAsignacionRutaDegustacion {
  ok: boolean;
  cronograma_id: string;
  ruta_id: string | null;
  promotora_id: string;
  promotora_nombre: string;
  promotora_email?: string;
  estado_ruta: EstadoRutaPromotora | null;
  ruta: RutaPromotoraRecord | null;
}
