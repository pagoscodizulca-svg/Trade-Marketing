export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type CanalClienteMaestro =
  | 'Mayorista'
  | 'Supermercado'
  | 'Farmacia'
  | 'Cuentas Claves'
  | 'Tradicional'
  | 'Minimarket'
  | (string & {});

export type EntidadSincronizacion =
  | 'vendedores'
  | 'clientes'
  | 'sincronizacion_completa';

export type EstadoLoteSincronizacion =
  | 'en_proceso'
  | 'completado'
  | 'con_observaciones'
  | 'fallido';

export interface Vendedor {
  id: string;
  codigo_vendedor: string;
  nombre_completo: string;
  documento_identidad: string | null;
  telefono: string | null;
  email: string | null;
  zona: string | null;
  supervisor: string | null;
  activo: boolean;
  metadata: Record<string, unknown>;
  ultima_sincronizacion: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendedorSincronizacionInput {
  codigo_vendedor: string;
  nombre_completo: string;
  documento_identidad?: string | null;
  telefono?: string | null;
  email?: string | null;
  zona?: string | null;
  supervisor?: string | null;
  metadata?: Record<string, unknown>;
}

export interface Cliente {
  id: string;
  codigo_cliente: string;
  rif: string | null;
  razon_social: string;
  nombre_comercial: string | null;
  canal: CanalClienteMaestro | null;
  segmento: string | null;
  zona: string | null;
  ruta: string | null;
  direccion: string | null;
  ciudad: string | null;
  estado: string | null;
  telefono: string | null;
  latitud: number | null;
  longitud: number | null;
  vendedor_id: string | null;
  codigo_vendedor: string | null;
  activo: boolean;
  metadata: Record<string, unknown>;
  ultima_sincronizacion: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClienteConVendedor extends Cliente {
  vendedor?: Pick<
    Vendedor,
    'id' | 'codigo_vendedor' | 'nombre_completo' | 'zona' | 'supervisor' | 'activo'
  > | null;
}

export interface ClienteSincronizacionInput {
  codigo_cliente: string;
  rif?: string | null;
  razon_social: string;
  nombre_comercial?: string | null;
  canal?: string | null;
  segmento?: string | null;
  zona?: string | null;
  ruta?: string | null;
  direccion?: string | null;
  ciudad?: string | null;
  estado?: string | null;
  telefono?: string | null;
  latitud?: number | null;
  longitud?: number | null;
  codigo_vendedor?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ErrorFilaSincronizacion {
  fila: number;
  entidad: 'vendedores' | 'clientes' | 'archivo';
  codigo: string | null;
  campo?: string;
  motivo: string;
  severidad: 'error' | 'advertencia';
}

export interface LoteSincronizacion {
  id: string;
  ejecutado_por: string | null;
  entidad: EntidadSincronizacion;
  nombre_archivo: string | null;
  registros_recibidos: number;
  registros_procesados: number;
  registros_desactivados: number;
  errores_detalle: ErrorFilaSincronizacion[];
  estado: EstadoLoteSincronizacion;
  created_at: string;
}

export interface ResumenRpcSincronizacion {
  procesados: number;
  sin_vendedor_asignado: number;
  desactivados: number;
  codigos_vendedor_faltantes?: string[];
}

export interface ResultadoSincronizacion {
  loteId: string | null;
  entidad: EntidadSincronizacion;
  nombreArchivo: string | null;
  estado: EstadoLoteSincronizacion;
  filasRecibidas: number;
  filasOmitidasVacias: number;
  vendedores: {
    recibidosUnicos: number;
    procesados: number;
    desactivados: number;
    lotesRpcEnviados: number;
  };
  clientes: {
    recibidosUnicos: number;
    procesados: number;
    sinVendedorAsignado: number;
    desactivados: number;
    codigosVendedorFaltantes: string[];
    lotesRpcEnviados: number;
  };
  erroresDetalle: ErrorFilaSincronizacion[];
  duracionMs: number;
}

export interface FiltrosConsultaVendedores {
  soloActivos?: boolean;
  zona?: string;
  supervisor?: string;
  busqueda?: string;
  forzarRefresco?: boolean;
}

export interface FiltrosConsultaClientes {
  soloActivos?: boolean;
  zona?: string;
  ruta?: string;
  vendedorId?: string;
  codigoVendedor?: string;
  canal?: string;
  busqueda?: string;
  incluirVendedor?: boolean;
  forzarRefresco?: boolean;
}

/**
 * Esquema oficial generado desde PostgreSQL 17 ("Trade Marketing", PostgREST 14.18)
 * para `SupabaseClient<MasterDataDatabase>` en `@supabase/supabase-js` v2.118+.
 */
export type MasterDataDatabase = {
  __InternalSupabase: {
    PostgrestVersion: '14.18';
  };
  public: {
    Tables: {
      clientes: {
        Row: {
          activo: boolean;
          canal: string | null;
          ciudad: string | null;
          codigo_cliente: string;
          codigo_vendedor: string | null;
          created_at: string;
          direccion: string | null;
          estado: string | null;
          id: string;
          latitud: number | null;
          longitud: number | null;
          metadata: Json;
          nombre_comercial: string | null;
          razon_social: string;
          rif: string | null;
          ruta: string | null;
          segmento: string | null;
          telefono: string | null;
          ultima_sincronizacion: string | null;
          updated_at: string;
          vendedor_id: string | null;
          zona: string | null;
        };
        Insert: {
          activo?: boolean;
          canal?: string | null;
          ciudad?: string | null;
          codigo_cliente: string;
          codigo_vendedor?: string | null;
          created_at?: string;
          direccion?: string | null;
          estado?: string | null;
          id?: string;
          latitud?: number | null;
          longitud?: number | null;
          metadata?: Json;
          nombre_comercial?: string | null;
          razon_social: string;
          rif?: string | null;
          ruta?: string | null;
          segmento?: string | null;
          telefono?: string | null;
          ultima_sincronizacion?: string | null;
          updated_at?: string;
          vendedor_id?: string | null;
          zona?: string | null;
        };
        Update: {
          activo?: boolean;
          canal?: string | null;
          ciudad?: string | null;
          codigo_cliente?: string;
          codigo_vendedor?: string | null;
          created_at?: string;
          direccion?: string | null;
          estado?: string | null;
          id?: string;
          latitud?: number | null;
          longitud?: number | null;
          metadata?: Json;
          nombre_comercial?: string | null;
          razon_social?: string;
          rif?: string | null;
          ruta?: string | null;
          segmento?: string | null;
          telefono?: string | null;
          ultima_sincronizacion?: string | null;
          updated_at?: string;
          vendedor_id?: string | null;
          zona?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'clientes_vendedor_id_fkey';
            columns: ['vendedor_id'];
            isOneToOne: false;
            referencedRelation: 'vendedores';
            referencedColumns: ['id'];
          },
        ];
      };
      lotes_sincronizacion: {
        Row: {
          created_at: string;
          ejecutado_por: string | null;
          entidad: string;
          errores_detalle: Json;
          estado: string;
          id: string;
          nombre_archivo: string | null;
          registros_desactivados: number;
          registros_procesados: number;
          registros_recibidos: number;
        };
        Insert: {
          created_at?: string;
          ejecutado_por?: string | null;
          entidad: string;
          errores_detalle?: Json;
          estado: string;
          id?: string;
          nombre_archivo?: string | null;
          registros_desactivados?: number;
          registros_procesados?: number;
          registros_recibidos?: number;
        };
        Update: {
          created_at?: string;
          ejecutado_por?: string | null;
          entidad?: string;
          errores_detalle?: Json;
          estado?: string;
          id?: string;
          nombre_archivo?: string | null;
          registros_desactivados?: number;
          registros_procesados?: number;
          registros_recibidos?: number;
        };
        Relationships: [];
      };
      vendedores: {
        Row: {
          activo: boolean;
          codigo_vendedor: string;
          created_at: string;
          documento_identidad: string | null;
          email: string | null;
          id: string;
          metadata: Json;
          nombre_completo: string;
          supervisor: string | null;
          telefono: string | null;
          ultima_sincronizacion: string | null;
          updated_at: string;
          zona: string | null;
        };
        Insert: {
          activo?: boolean;
          codigo_vendedor: string;
          created_at?: string;
          documento_identidad?: string | null;
          email?: string | null;
          id?: string;
          metadata?: Json;
          nombre_completo: string;
          supervisor?: string | null;
          telefono?: string | null;
          ultima_sincronizacion?: string | null;
          updated_at?: string;
          zona?: string | null;
        };
        Update: {
          activo?: boolean;
          codigo_vendedor?: string;
          created_at?: string;
          documento_identidad?: string | null;
          email?: string | null;
          id?: string;
          metadata?: Json;
          nombre_completo?: string;
          supervisor?: string | null;
          telefono?: string | null;
          ultima_sincronizacion?: string | null;
          updated_at?: string;
          zona?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      es_admin_trade: {
        Args: never;
        Returns: boolean;
      };
      rpc_sincronizar_clientes: {
        Args: {
          p_codigos_activos_totales?: string[] | null;
          p_registros: Json;
        };
        Returns: Json;
      };
      rpc_sincronizar_vendedores: {
        Args: {
          p_desactivar_ausentes?: boolean;
          p_registros: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type Database = MasterDataDatabase;
