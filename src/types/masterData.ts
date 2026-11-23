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

export type SucursalMaestro = 'ZULIA' | 'VALENCIA' | 'CENTRO' | 'ORIENTE' | 'CAPITAL';

export interface CadenaComercial {
  id: string;
  codigo: string;
  nombre: string;
  tipo_canal: string;
  sucursal: SucursalMaestro | null;
  region_id?: string | null;
  activo: boolean;
  logo_storage_path?: string | null;
  logo_mime_type?: 'image/png' | 'image/webp' | string | null;
  logo_updated_at?: string | null;
  logo_updated_by?: string | null;
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
  region_id?: string | null;
  activo?: boolean;
}

export interface ZonaComercial {
  id: string;
  codigo: string;
  nombre: string;
  ciudad: string | null;
  estado: string | null;
  sucursal: SucursalMaestro | null;
  region_id?: string | null;
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
  region_id?: string | null;
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
  region_id?: string | null;
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
  region_id?: string | null;
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
  supervisor_id?: string | null;
  region_id?: string | null;
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
  supervisor_id?: string | null;
  region_id?: string | null;
  radio_geocerca_m?: number | null;
  sucursal?: SucursalMaestro | null;
  codigo_vendedor?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ClienteCrudInput extends ClienteSincronizacionInput {
  id?: string;
  vendedor_id?: string | null;
  supervisor_id?: string | null;
  region_id?: string | null;
  activo?: boolean;
}

export type MasterRegionScopeFilter = 'ALL' | 'UNASSIGNED' | AllowedRegionCode | SucursalMaestro;

export interface RegionMaestra {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  /** Indicador real `regi_saba` de `public."Regiones"` (OCCIDENTE = true, CENTRO/ANDES = false) */
  regi_saba?: boolean;
  /** Prioridad operativa: OCCIDENTE = 1, CENTRO = 2, ANDES = 3 */
  priority?: 1 | 2 | 3;
  created_at: string;
  updated_at: string;
}

export interface RegionMaestraInput {
  id?: string;
  codigo: string;
  nombre: string;
  activo?: boolean;
}

export interface ProductoMaestro {
  id: string;
  codigo: string;
  nombre: string;
  categoria: string | null;
  marca: string | null;
  unidad_medida: string;
  activo: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProductoMaestroInput {
  id?: string;
  codigo: string;
  nombre: string;
  categoria?: string | null;
  marca?: string | null;
  unidad_medida?: string | null;
  activo?: boolean;
}

export interface SupervisorMaestro {
  id: string;
  codigo: string | null;
  nombre: string;
  email: string | null;
  telefono: string | null;
  zona: string | null;
  sucursal: SucursalMaestro | null;
  region_id: string | null;
  activo: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SupervisorMaestroInput {
  id?: string;
  codigo?: string | null;
  nombre: string;
  email?: string | null;
  telefono?: string | null;
  zona?: string | null;
  sucursal?: SucursalMaestro | null;
  region_id?: string | null;
  activo?: boolean;
}

export type PromotoraCategoria = 'fija' | 'eventual' | 'merchandising';
export type PromotoraCategoriaOficial = 'Fijas' | 'Eventuales' | 'Merchandising';

export type AllowedRegionCode = 'OCCIDENTE' | 'CENTRO' | 'ANDES';

/** Registro exacto de la tabla `"Regiones"` en Supabase (`apaxdgxtaoeyswlfblgi`). */
export interface SupabaseRegionCatalogRow {
  id_regi: string;
  created_at: string;
  regi_desd: AllowedRegionCode;
  regi_saba: boolean;
  priority: 1 | 2 | 3;
}

export interface RegionalActorProfile {
  userId?: string | null;
  role: string;
  assignedRegion: AllowedRegionCode | null;
  isGlobalAdmin?: boolean;
}

export interface RegionalSyncBatchError {
  lote: number;
  motivo: string;
  codigosAfectados?: string[];
}

export interface RegionalClientSyncSummary {
  region: AllowedRegionCode;
  regionId: string;
  priority: 1 | 2 | 3;
  regiSaba: boolean;
  procesados: number;
  insertadosOActualizados: number;
  omitidos: number;
  errores: RegionalSyncBatchError[];
  duracionMs: number;
  lotesEjecutados: number;
}

export interface RegionalClientSyncReport {
  ordenPrioridadEjecutado: AllowedRegionCode[];
  regionesOmitidasNoPermitidas: string[];
  resumenPorRegion: RegionalClientSyncSummary[];
  totales: {
    procesados: number;
    insertadosOActualizados: number;
    omitidos: number;
    errores: number;
    duracionMs: number;
  };
}

export interface PromotoraMaestra {
  id: string;
  nombre_completo: string;
  email: string | null;
  telefono: string | null;
  ciudad: string | null;
  estado: string | null;
  direccion: string | null;
  sucursal: SucursalMaestro | null;
  region_id: string | null;
  supervisor_id: string | null;
  categoria?: PromotoraCategoriaOficial | PromotoraCategoria;
  tipo?: string | null;
  rol?: string | null;
  metadata?: Record<string, unknown>;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

export interface PromotoraMaestraInput {
  id?: string;
  nombre_completo: string;
  email?: string | null;
  telefono?: string | null;
  ciudad?: string | null;
  estado?: string | null;
  direccion?: string | null;
  sucursal?: SucursalMaestro | null;
  region_id?: string | null;
  supervisor_id?: string | null;
  categoria?: PromotoraCategoriaOficial | PromotoraCategoria;
  tipo?: string | null;
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
  sucursal?: SucursalMaestro | null;
  region?: AllowedRegionCode;
  regionId?: string;
  zona?: string;
  supervisor?: string;
  busqueda?: string;
  forzarRefresco?: boolean;
}

export interface FiltrosConsultaClientes {
  soloActivos?: boolean;
  sucursal?: SucursalMaestro | null;
  zona?: string;
  ruta?: string;
  vendedorId?: string;
  codigoVendedor?: string;
  canal?: string;
  region?: AllowedRegionCode;
  regionId?: string;
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
      Regiones: {
        Row: {
          id_regi: string;
          created_at: string;
          regi_desd: string;
          regi_saba: boolean;
        };
        Insert: {
          id_regi?: string;
          created_at?: string;
          regi_desd: string;
          regi_saba?: boolean;
        };
        Update: {
          id_regi?: string;
          created_at?: string;
          regi_desd?: string;
          regi_saba?: boolean;
        };
        Relationships: [];
      };
      Sucursales: {
        Row: {
          id_sucu: string;
          created_at: string;
          sucu_desc: string;
          id_regi: string | null;
        };
        Insert: {
          id_sucu?: string;
          created_at?: string;
          sucu_desc: string;
          id_regi?: string | null;
        };
        Update: {
          id_sucu?: string;
          created_at?: string;
          sucu_desc?: string;
          id_regi?: string | null;
        };
        Relationships: [];
      };
      Estados: {
        Row: {
          id_esta: string;
          created_at: string;
          esta_desc: string;
          id_regi: string | null;
        };
        Insert: {
          id_esta?: string;
          created_at?: string;
          esta_desc: string;
          id_regi?: string | null;
        };
        Update: {
          id_esta?: string;
          created_at?: string;
          esta_desc?: string;
          id_regi?: string | null;
        };
        Relationships: [];
      };
      Municipios: {
        Row: {
          id_muni: string;
          created_at: string;
          muni_desc: string;
          id_esta: string | null;
          id_regi: string | null;
        };
        Insert: {
          id_muni?: string;
          created_at?: string;
          muni_desc: string;
          id_esta?: string | null;
          id_regi?: string | null;
        };
        Update: {
          id_muni?: string;
          created_at?: string;
          muni_desc?: string;
          id_esta?: string | null;
          id_regi?: string | null;
        };
        Relationships: [];
      };
      Supervisores: {
        Row: {
          id_supe: string;
          created_at: string;
          supe_nomb: string;
          supe_acti: boolean | null;
          id_regi: string | null;
          supe_cont: string | null;
        };
        Insert: {
          id_supe?: string;
          created_at?: string;
          supe_nomb: string;
          supe_acti?: boolean | null;
          id_regi?: string | null;
          supe_cont?: string | null;
        };
        Update: {
          id_supe?: string;
          created_at?: string;
          supe_nomb?: string;
          supe_acti?: boolean | null;
          id_regi?: string | null;
          supe_cont?: string | null;
        };
        Relationships: [];
      };
      Tipificacion_Clientes: {
        Row: {
          id_tipi: string;
          created_at: string;
          tipi_desc: string;
          id_cave: string | null;
        };
        Insert: {
          id_tipi?: string;
          created_at?: string;
          tipi_desc: string;
          id_cave?: string | null;
        };
        Update: {
          id_tipi?: string;
          created_at?: string;
          tipi_desc?: string;
          id_cave?: string | null;
        };
        Relationships: [];
      };
      Canal_Comercializacion: {
        Row: {
          id_cana: string;
          created_at: string;
          cana_desc: string;
        };
        Insert: {
          id_cana?: string;
          created_at?: string;
          cana_desc: string;
        };
        Update: {
          id_cana?: string;
          created_at?: string;
          cana_desc?: string;
        };
        Relationships: [];
      };
      Forecast_Vendedores_Excluidos: {
        Row: {
          id_fove: string;
          created_at: string;
          updated_at: string | null;
          id_regi: string | null;
          fove_vend: string[] | null;
        };
        Insert: {
          id_fove?: string;
          created_at?: string;
          updated_at?: string | null;
          id_regi?: string | null;
          fove_vend?: string[] | null;
        };
        Update: {
          id_fove?: string;
          created_at?: string;
          updated_at?: string | null;
          id_regi?: string | null;
          fove_vend?: string[] | null;
        };
        Relationships: [];
      };
      Vendedores: {
        Row: {
          id_vend: string;
          created_at: string;
          vend_codi: string | null;
          vend_nomb: string;
          vend_acti: boolean | null;
          id_sucu: string | null;
          id_supe: string | null;
          vend_cont: string | null;
        };
        Insert: {
          id_vend?: string;
          created_at?: string;
          vend_codi?: string | null;
          vend_nomb: string;
          vend_acti?: boolean | null;
          id_sucu?: string | null;
          id_supe?: string | null;
          vend_cont?: string | null;
        };
        Update: {
          id_vend?: string;
          created_at?: string;
          vend_codi?: string | null;
          vend_nomb?: string;
          vend_acti?: boolean | null;
          id_sucu?: string | null;
          id_supe?: string | null;
          vend_cont?: string | null;
        };
        Relationships: [];
      };
      Clientes: {
        Row: {
          id_clie: string;
          created_at: string;
          clie_rif: string | null;
          clie_nomb: string;
          id_esta: string | null;
          id_vend: string | null;
          id_muni: string | null;
          clie_regi: string | null;
          clie_acti: boolean | null;
          clie_lati: number | null;
          clie_long: number | null;
          id_tipi: string | null;
        };
        Insert: {
          id_clie?: string;
          created_at?: string;
          clie_rif?: string | null;
          clie_nomb: string;
          id_esta?: string | null;
          id_vend?: string | null;
          id_muni?: string | null;
          clie_regi?: string | null;
          clie_acti?: boolean | null;
          clie_lati?: number | null;
          clie_long?: number | null;
          id_tipi?: string | null;
        };
        Update: {
          id_clie?: string;
          created_at?: string;
          clie_rif?: string | null;
          clie_nomb?: string;
          id_esta?: string | null;
          id_vend?: string | null;
          id_muni?: string | null;
          clie_regi?: string | null;
          clie_acti?: boolean | null;
          clie_lati?: number | null;
          clie_long?: number | null;
          id_tipi?: string | null;
        };
        Relationships: [];
      };
      cadenas_comerciales: {
        Row: {
          activo: boolean;
          codigo: string;
          created_at: string;
          id: string;
          metadata: Json;
          nombre: string;
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
          region_id?: string | null;
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
