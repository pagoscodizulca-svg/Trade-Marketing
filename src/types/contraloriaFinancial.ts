export type SucursalFinanciera = 'ZULIA' | 'VALENCIA' | 'CENTRO' | 'ORIENTE' | 'CAPITAL';

export interface CampanaTrade {
  id: string;
  codigo: string;
  nombre: string;
  marca: 'ASTURIAS' | 'VENCAMPO' | 'GENERAL';
  fecha_inicio: string;
  fecha_fin: string;
  estado: 'PLANIFICADA' | 'ACTIVA' | 'CERRADA' | 'CANCELADA';
  responsable_uid?: string | null;
  observaciones: string;
  sucursal: SucursalFinanciera | null;
  created_at: string;
  updated_at: string;
}

export interface CampanaTradeInput {
  id?: string;
  codigo: string;
  nombre: string;
  marca: 'ASTURIAS' | 'VENCAMPO' | 'GENERAL';
  fecha_inicio: string;
  fecha_fin: string;
  estado?: 'PLANIFICADA' | 'ACTIVA' | 'CERRADA' | 'CANCELADA';
  observaciones?: string;
  sucursal?: SucursalFinanciera | null;
}

export interface PresupuestoTrade {
  id: string;
  campana_id: string | null;
  periodo_ym: string;
  categoria: string;
  monto_asignado_usd: number;
  monto_comprometido_usd: number;
  monto_ejecutado_usd: number;
  activo: boolean;
  observaciones: string;
  sucursal: SucursalFinanciera | null;
  created_at: string;
  updated_at: string;
}

export interface PresupuestoTradeInput {
  id?: string;
  campana_id?: string | null;
  periodo_ym: string;
  categoria: string;
  monto_asignado_usd: number;
  monto_comprometido_usd?: number;
  monto_ejecutado_usd?: number;
  observaciones?: string;
  activo?: boolean;
  sucursal?: SucursalFinanciera | null;
}

export interface TarifarioCostoTrade {
  id: string;
  line_id: string;
  etiqueta: string;
  marca: 'ASTURIAS' | 'VENCAMPO' | 'GENERAL';
  unidad_medida: string;
  costo_unitario_usd: number;
  precio_referencia_usd: number;
  vigente_desde: string;
  vigente_hasta: string | null;
  activo: boolean;
  sucursal: SucursalFinanciera | null;
  created_at: string;
  updated_at: string;
}

export interface TarifarioCostoTradeInput {
  id?: string;
  line_id: string;
  etiqueta: string;
  marca: 'ASTURIAS' | 'VENCAMPO' | 'GENERAL';
  unidad_medida?: string;
  costo_unitario_usd: number;
  precio_referencia_usd: number;
  vigente_desde?: string;
  vigente_hasta?: string | null;
  activo?: boolean;
  sucursal?: SucursalFinanciera | null;
}

export interface CertificadoPazYSalvo {
  id: string;
  codigo_certificado: string;
  requisicion_id: string;
  conciliacion_id: string;
  codigo_correlativo: string;
  payload_canonico: Record<string, unknown>;
  sha256_hash: string;
  emitido_por_uid: string;
  emitido_por_nombre: string;
  emitido_por_rol: 'contraloria' | 'super_admin';
  emitido_en: string;
  notas_cierre: string;
  sucursal: SucursalFinanciera | null;
}

export interface PazYSalvoVerificationResult {
  found: boolean;
  valid: boolean;
  codigo_certificado?: string;
  stored_sha256?: string;
  recomputed_sha256?: string;
  emitido_en?: string;
  emitido_por_nombre?: string;
}
