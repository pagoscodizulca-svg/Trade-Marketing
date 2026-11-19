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

export type SucursalMaestro = 'ZULIA' | 'VALENCIA';

export interface CadenaComercial {
  id: string;
  codigo: string;
  nombre: string;
  tipo_canal: string;
  sucursal: SucursalMaestro | null;
  activo: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CadenaComercialInput {
  id?: string;
  codigo: string;
  nombre: string;
  tipo_canal?: string;
  sucursal?: SucursalMaestro | null;
  activo?: boolean;
}

export interface ZonaComercial {
  id: string;
  codigo: string;
  nombre: string;
  ciudad: string | null;
  estado: string | null;
  sucursal: SucursalMaestro | null;
  activo: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ZonaComercialInput {
  id?: string;
  codigo: string;
  nombre: string;
  ciudad?: string | null;
  estado?: string | null;
  sucursal?: SucursalMaestro | null;
  activo?: boolean;
}

export interface Vendedor {
  id: string;
  codigo_vendedor: string;
  nombre_completo: string;
  documento_identidad: string | null;
  telefono: string | null;
  email: string | null;
  zona: string | null;
  supervisor: string | null;
  sucursal?: SucursalMaestro | null;
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
  sucursal?: SucursalMaestro | null;
  metadata?: Record<string, unknown>;
}

export interface VendedorCrudInput extends VendedorSincronizacionInput {
  id?: string;
  activo?: boolean;
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
  cadena_id?: string | null;
  zona_id?: string | null;
  radio_geocerca_m?: number | null;
  sucursal?: SucursalMaestro | null;
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
  cadena?: Pick<CadenaComercial, 'id' | 'codigo' | 'nombre' | 'tipo_canal'> | null;
  zona_catalogo?: Pick<ZonaComercial, 'id' | 'codigo' | 'nombre' | 'ciudad' | 'estado'> | null;
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
  cadena_id?: string | null;
  zona_id?: string | null;
  radio_geocerca_m?: number | null;
  sucursal?: SucursalMaestro | null;
  codigo_vendedor?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ClienteCrudInput extends ClienteSincronizacionInput {
  id?: string;
  vendedor_id?: string | null;
  activo?: boolean;
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
      cadenas_comerciales: {
        Row: {
          activo: boolean;
          codigo: string;
          created_at: string;
          id: string;
          metadata: Json;
          nombre: string;
          sucursal: string | null;
          tipo_canal: string;
          updated_at: string;
        };
        Insert: {
          activo?: boolean;
          codigo: string;
          created_at?: string;
          id?: string;
          metadata?: Json;
          nombre: string;
          sucursal?: string | null;
          tipo_canal?: string;
          updated_at?: string;
        };
        Update: {
          activo?: boolean;
          codigo?: string;
          created_at?: string;
          id?: string;
          metadata?: Json;
          nombre?: string;
          sucursal?: string | null;
          tipo_canal?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      zonas: {
        Row: {
          activo: boolean;
          ciudad: string | null;
          codigo: string;
          created_at: string;
          estado: string | null;
          id: string;
          metadata: Json;
          nombre: string;
          sucursal: string | null;
          updated_at: string;
        };
        Insert: {
          activo?: boolean;
          ciudad?: string | null;
          codigo: string;
          created_at?: string;
          estado?: string | null;
          id?: string;
          metadata?: Json;
          nombre: string;
          sucursal?: string | null;
          updated_at?: string;
        };
        Update: {
          activo?: boolean;
          ciudad?: string | null;
          codigo?: string;
          created_at?: string;
          estado?: string | null;
          id?: string;
          metadata?: Json;
          nombre?: string;
          sucursal?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      clientes: {
        Row: {
          activo: boolean;
          cadena_id: string | null;
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
          radio_geocerca_m: number;
          razon_social: string;
          rif: string | null;
          ruta: string | null;
          segmento: string | null;
          sucursal: string | null;
          telefono: string | null;
          ultima_sincronizacion: string | null;
          updated_at: string;
          vendedor_id: string | null;
          zona: string | null;
          zona_id: string | null;
        };
        Insert: {
          activo?: boolean;
          cadena_id?: string | null;
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
          radio_geocerca_m?: number;
          razon_social: string;
          rif?: string | null;
          ruta?: string | null;
          segmento?: string | null;
          sucursal?: string | null;
          telefono?: string | null;
          ultima_sincronizacion?: string | null;
          updated_at?: string;
          vendedor_id?: string | null;
          zona?: string | null;
          zona_id?: string | null;
        };
        Update: {
          activo?: boolean;
          cadena_id?: string | null;
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
          radio_geocerca_m?: number;
          razon_social?: string;
          rif?: string | null;
          ruta?: string | null;
          segmento?: string | null;
          sucursal?: string | null;
          telefono?: string | null;
          ultima_sincronizacion?: string | null;
          updated_at?: string;
          vendedor_id?: string | null;
          zona?: string | null;
          zona_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'clientes_vendedor_id_fkey';
            columns: ['vendedor_id'];
            isOneToOne: false;
            referencedRelation: 'vendedores';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'clientes_cadena_id_fkey';
            columns: ['cadena_id'];
            isOneToOne: false;
            referencedRelation: 'cadenas_comerciales';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'clientes_zona_id_fkey';
            columns: ['zona_id'];
            isOneToOne: false;
            referencedRelation: 'zonas';
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
          sucursal: string | null;
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
          sucursal?: string | null;
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
          sucursal?: string | null;
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
