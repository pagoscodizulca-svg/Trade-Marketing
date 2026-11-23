import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Store } from '../types';
import type {
  AllowedRegionCode,
  CadenaComercial,
  CadenaComercialInput,
  Cliente,
  ClienteConVendedor,
  ClienteCrudInput,
  ClienteSincronizacionInput,
  EntidadSincronizacion,
  ErrorFilaSincronizacion,
  EstadoLoteSincronizacion,
  FiltrosConsultaClientes,
  FiltrosConsultaVendedores,
  Json,
  LoteSincronizacion,
  MasterDataDatabase,
  RegionalActorProfile,
  RegionalClientSyncReport,
  RegionalClientSyncSummary,
  RegionalSyncBatchError,
  ResultadoSincronizacion,
  ResumenRpcSincronizacion,
  SucursalMaestro,
  SupabaseRegionCatalogRow,
  Vendedor,
  VendedorCrudInput,
  VendedorSincronizacionInput,
  ZonaComercial,
  ZonaComercialInput,
} from '../types/masterData';
import {
  getActiveClientSucursalHeader,
  getCachedAccessToken,
  getMasterDataSupabaseClient,
  registerSupabaseSessionResetCallback,
} from './supabaseClient';
import { isOperativeSucursal, normalizeSucursalCodigo } from './userManagementService';
import { registerMemoryCachePurgeCallback } from './sessionCacheHygiene';
import {
  LRUCache,
  resolvePositiveIntConfig,
  type LRUCacheMetrics,
} from '../utils/lruCache';
import {
  ALLOWED_REGIONS,
  REGIONAL_PRIORITY_RANK,
  REGIONAL_SYNC_PRIORITY_QUEUE,
  isAllowedRegionCode,
  mapAllowedRegionToLegacySucursal,
  normalizeAllowedRegionStrict,
  sortAllowedRegionsByPriority,
} from '../utils/regionalSyncClassifier';
import {
  filterNormalizedErpClientes,
  filterNormalizedErpVendedores,
  normalizeErpCadenasDataset,
  normalizeErpClientesDataset,
  normalizeErpVendedoresDataset,
  normalizeErpZonasDataset,
  type ErpCanalComercializacionRow,
  type ErpClienteRow,
  type ErpEstadoRow,
  type ErpForecastExcludedVendedoresRow,
  type ErpMunicipioRow,
  type ErpRegionRow,
  type ErpSucursalRow,
  type ErpSupervisorRow,
  type ErpTipificacionRow,
  type ErpVendedorRow,
} from '../utils/erpMasterAdapter';

export type {
  AllowedRegionCode,
  CadenaComercial,
  CadenaComercialInput,
  Cliente,
  ClienteConVendedor,
  ClienteCrudInput,
  ClienteSincronizacionInput,
  EntidadSincronizacion,
  ErrorFilaSincronizacion,
  EstadoLoteSincronizacion,
  FiltrosConsultaClientes,
  FiltrosConsultaVendedores,
  LoteSincronizacion,
  LRUCacheMetrics,
  MasterDataDatabase,
  RegionalActorProfile,
  RegionalClientSyncReport,
  RegionalClientSyncSummary,
  RegionalSyncBatchError,
  ResultadoSincronizacion,
  ResumenRpcSincronizacion,
  SucursalMaestro,
  SupabaseRegionCatalogRow,
  Vendedor,
  VendedorCrudInput,
  VendedorSincronizacionInput,
  ZonaComercial,
  ZonaComercialInput,
};

export { ALLOWED_REGIONS, REGIONAL_SYNC_PRIORITY_QUEUE };

/** Tamaño óptimo de lote para Supabase Plan Gratuito (entre 300 y 500 registros por RPC). */
export const MASTER_SYNC_CHUNK_SIZE = 400;

/** Tamaño máximo por página en lecturas PostgREST para superar el tope por defecto de 1,000 filas. */
export const POSTGREST_READ_PAGE_SIZE = 1000;

export const DEFAULT_MASTER_DATA_CACHE_MAX_ITEMS = 2000;
export const DEFAULT_MASTER_DATA_CACHE_TTL_MS = 5 * 60 * 1000; // 300000 ms (5 min)
export const DEFAULT_MASTER_DATA_SYNC_BATCH_SIZE = 400;

export function resolveMasterDataCacheMaxItems(
  envOverride?: Record<string, string | undefined>
): number {
  return resolvePositiveIntConfig({
    nodeEnvKey: 'MASTER_DATA_CACHE_MAX_ITEMS',
    viteEnvKey: 'VITE_MASTER_DATA_CACHE_MAX_ITEMS',
    fallback: DEFAULT_MASTER_DATA_CACHE_MAX_ITEMS,
    min: 10,
    max: 50_000,
    envOverride,
  });
}

export function resolveMasterDataCacheTtlMs(
  envOverride?: Record<string, string | undefined>
): number {
  return resolvePositiveIntConfig({
    nodeEnvKey: 'MASTER_DATA_CACHE_TTL_MS',
    viteEnvKey: 'VITE_MASTER_DATA_CACHE_TTL_MS',
    fallback: DEFAULT_MASTER_DATA_CACHE_TTL_MS,
    min: 1_000,
    max: 3_600_000,
    envOverride,
  });
}

export function resolveMasterDataSyncBatchSize(
  envOverride?: Record<string, string | undefined>
): number {
  return resolvePositiveIntConfig({
    nodeEnvKey: 'MASTER_DATA_SYNC_BATCH_SIZE',
    viteEnvKey: 'VITE_MASTER_DATA_SYNC_BATCH_SIZE',
    fallback: DEFAULT_MASTER_DATA_SYNC_BATCH_SIZE,
    min: 1,
    max: 1000,
    envOverride,
  });
}

const VALORES_NULOS_TABULARES = new Set([
  '',
  '#N/D',
  'N/D',
  '#N/A',
  'N/A',
  '#VALUE!',
  '#REF!',
  'NULL',
  'UNDEFINED',
  'SIN RIF',
  'S/R',
  '-',
  '--',
]);

// =============================================================================
// 1. FUNCIONES PURAS DE LIMPIEZA Y NORMALIZACIÓN
// =============================================================================

export function limpiarCeldaTexto(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  const crudo = String(valor)
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim();

  // Desenvolver comillas múltiples escapadas de exportaciones ERP (ej. """COMERCIAL X""")
  const sinComillasBorde = crudo
    .replace(/^"+|"+$/g, '')
    .replace(/""/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  if (VALORES_NULOS_TABULARES.has(sinComillasBorde.toUpperCase())) {
    return '';
  }
  return sinComillasBorde;
}

export function normalizarCodigoMaestro(valor: unknown): string {
  return limpiarCeldaTexto(valor).toUpperCase().trim();
}

export function normalizarSucursalMaestro(valor: unknown): SucursalMaestro | null {
  const limpio = limpiarCeldaTexto(valor);
  if (!limpio) return null;
  const norm = normalizeSucursalCodigo(limpio);
  return norm && isOperativeSucursal(norm) ? norm : null;
}

export function inferirSucursalDesdeTerritorio(campos: {
  sucursal?: unknown;
  zona?: unknown;
  ciudad?: unknown;
  estado?: unknown;
}): SucursalMaestro | null {
  return (
    normalizarSucursalMaestro(campos.sucursal) ??
    normalizarSucursalMaestro(campos.zona) ??
    normalizarSucursalMaestro(campos.ciudad) ??
    normalizarSucursalMaestro(campos.estado) ??
    null
  );
}

export function normalizarRifFiscal(valor: unknown): string | null {
  const limpio = limpiarCeldaTexto(valor).toUpperCase();
  if (!limpio) return null;

  const compactado = limpio.replace(/\s+/g, '');
  const matchSinGuion = compactado.match(/^([VEJGPC])-?([0-9]{5,12})$/);
  if (matchSinGuion) {
    return `${matchSinGuion[1]}-${matchSinGuion[2]}`;
  }
  return compactado;
}

export function normalizarTelefonoMaestro(valor: unknown): string | null {
  const limpio = limpiarCeldaTexto(valor);
  if (!limpio) return null;

  const tieneMas = limpio.startsWith('+');
  const soloDigitos = limpio.replace(/[^\d]/g, '');
  if (soloDigitos.length < 7) return null;

  return tieneMas ? `+${soloDigitos}` : soloDigitos;
}

export function normalizarCoordenada(
  valor: unknown,
  min: number,
  max: number
): number | null | 'INVALID' {
  const limpio = limpiarCeldaTexto(valor).replace(',', '.');
  if (!limpio) return null;
  const num = Number(limpio);
  if (!Number.isFinite(num) || num < min || num > max) {
    return 'INVALID';
  }
  return Number(num.toFixed(7));
}

export function extraerNombreComercialImplicito(razonSocial: string): string | null {
  const match = razonSocial.match(/\(([^()]{3,120})\)\s*$/);
  if (!match || !match[1]) return null;
  const extraido = match[1].trim();
  return extraido.length >= 3 ? extraido : null;
}

export function dividirEnLotes<T>(elementos: readonly T[], tamanoLote = MASTER_SYNC_CHUNK_SIZE): T[][] {
  const size = Math.max(1, Math.floor(tamanoLote));
  const resultado: T[][] = [];
  for (let i = 0; i < elementos.length; i += size) {
    resultado.push(elementos.slice(i, i + size));
  }
  return resultado;
}

// =============================================================================
// 2. ESQUEMAS ZOD ESTRICTOS PARA VENDEDORES Y CLIENTES
// =============================================================================

export const VendedorSincronizacionSchema = z.object({
  codigo_vendedor: z
    .string()
    .transform((v) => normalizarCodigoMaestro(v))
    .refine((v) => v.length > 0, { message: 'Falta codigo_vendedor obligatorio.' }),
  nombre_completo: z
    .string()
    .transform((v) => limpiarCeldaTexto(v))
    .refine((v) => v.length > 0, { message: 'Falta nombre_completo del vendedor.' }),
  documento_identidad: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      const c = limpiarCeldaTexto(v).toUpperCase();
      return c || null;
    }),
  telefono: z
    .string()
    .nullable()
    .optional()
    .transform((v) => normalizarTelefonoMaestro(v)),
  email: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      const c = limpiarCeldaTexto(v).toLowerCase();
      return c || null;
    })
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'Formato de email inválido.',
    }),
  zona: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  supervisor: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export const ClienteSincronizacionSchema = z.object({
  codigo_cliente: z
    .string()
    .transform((v) => normalizarCodigoMaestro(v))
    .refine((v) => v.length > 0, { message: 'Falta codigo_cliente obligatorio.' }),
  rif: z
    .string()
    .nullable()
    .optional()
    .transform((v) => normalizarRifFiscal(v)),
  razon_social: z
    .string()
    .transform((v) => limpiarCeldaTexto(v))
    .refine((v) => v.length > 0, { message: 'Falta razon_social obligatoria del cliente.' }),
  nombre_comercial: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  canal: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  segmento: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  zona: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  ruta: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  direccion: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  ciudad: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  estado: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  telefono: z
    .string()
    .nullable()
    .optional()
    .transform((v) => normalizarTelefonoMaestro(v)),
  latitud: z.number().min(-90).max(90).nullable().optional().default(null),
  longitud: z.number().min(-180).max(180).nullable().optional().default(null),
  codigo_vendedor: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      const c = normalizarCodigoMaestro(v);
      return c || null;
    }),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

// =============================================================================
// 3. PARSER INTELIGENTE DE ARCHIVOS MAESTROS (CSV ; / , / XLSX / JSON)
// =============================================================================

function normalizarClaveEncabezado(encabezado: unknown): string {
  return String(encabezado ?? '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^"+|"+$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const ALIAS_COLUMNAS = {
  codigo_cliente: ['codigo_cliente', 'cod_cliente', 'id_cliente', 'cliente_codigo', 'id', 'codigo_pdv', 'cod_pdv'],
  rif: ['rif', 'rif_cliente', 'identificacion_fiscal', 'nit', 'ruc'],
  razon_social: ['razon_social', 'razon_social_cliente', 'nombre_cliente', 'cliente', 'establecimiento', 'pdv'],
  nombre_comercial: ['nombre_comercial', 'comercial', 'fantasia', 'nombre_fantasia'],
  canal: ['canal', 'canal_comercial', 'tipo_canal'],
  segmento: ['segmento', 'subcanal', 'categoria_cliente'],
  zona: ['zona', 'zona_comercial', 'territorio', 'region'],
  ruta: ['ruta', 'codigo_ruta', 'ruta_venta'],
  direccion: ['direccion', 'direccion_fiscal', 'domicilio', 'ubicacion'],
  ciudad: ['ciudad', 'municipio', 'localidad'],
  estado: ['estado', 'departamento', 'provincia'],
  telefono: ['telefono', 'tlf', 'celular', 'telefono_cliente'],
  latitud: ['latitud', 'lat', 'latitude'],
  longitud: ['longitud', 'lng', 'lon', 'longitude'],
  codigo_vendedor: ['codigo_vendedor', 'id_vendedor', 'cod_vendedor', 'vendedor_codigo'],
  nombre_vendedor: ['nombre_completo', 'vendedor', 'nombre_vendedor', 'ejecutivo', 'asesor_comercial'],
  documento_identidad: ['documento_identidad', 'cedula', 'ci', 'documento'],
  telefono_vendedor: ['telefono_vendedor', 'celular_vendedor'],
  email_vendedor: ['email', 'correo', 'email_vendedor', 'correo_vendedor'],
  supervisor: ['supervisor', 'nombre_supervisor', 'coordinador', 'jefe_ventas'],
} as const;

type CampoCanonico = keyof typeof ALIAS_COLUMNAS;

/**
 * Divide una línea CSV respetando campos entrecomillados y comillas escapadas `""` o `"""`.
 */
export function dividirLineaCsvRespetandoComillas(linea: string, delimitador: string): string[] {
  const resultado: string[] = [];
  let actual = '';
  let enComillas = false;

  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i]!;
    if (ch === '"') {
      if (enComillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else {
        enComillas = !enComillas;
      }
    } else if (ch === delimitador && !enComillas) {
      resultado.push(actual);
      actual = '';
    } else {
      actual += ch;
    }
  }
  resultado.push(actual);
  return resultado;
}

function detectarDelimitadorCsv(lineasMuestra: string[]): string {
  const candidatos = [';', ',', '\t'];
  let mejor = ';';
  let mejorPuntaje = -1;

  for (const delim of candidatos) {
    let puntaje = 0;
    for (const l of lineasMuestra) {
      if (!l.trim()) continue;
      const partes = dividirLineaCsvRespetandoComillas(l, delim);
      if (partes.length > 1) {
        puntaje += partes.length;
      }
    }
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = delim;
    }
  }
  return mejor;
}

export function convertirTextoCsvAMatriz(contenidoCsv: string): string[][] {
  const limpio = contenidoCsv.replace(/^\uFEFF/, '');
  const lineas = limpio.split(/\r?\n/);
  const muestra = lineas.slice(0, 15);
  const delimitador = detectarDelimitadorCsv(muestra);
  return lineas.map((linea) => dividirLineaCsvRespetandoComillas(linea, delimitador));
}

export async function convertirWorkbookBufferAMatriz(
  buffer: ArrayBuffer | Uint8Array
): Promise<string[][]> {
  const { readFirstSheetAsStringMatrix } = await import('../utils/excelSheetShim');
  return readFirstSheetAsStringMatrix(buffer);
}

function resolverMapaIndicesColumnas(encabezados: string[]): Partial<Record<CampoCanonico, number>> {
  const normalizados = encabezados.map((h) => normalizarClaveEncabezado(h));
  const mapa: Partial<Record<CampoCanonico, number>> = {};

  const buscarIndice = (aliasList: readonly string[]): number | undefined => {
    for (const alias of aliasList) {
      const idx = normalizados.indexOf(alias);
      if (idx !== -1) return idx;
    }
    return undefined;
  };

  for (const campo of Object.keys(ALIAS_COLUMNAS) as CampoCanonico[]) {
    const idx = buscarIndice(ALIAS_COLUMNAS[campo]);
    if (idx !== undefined) {
      mapa[campo] = idx;
    }
  }

  // Si la tabla es exclusivamente de vendedores (sin razon_social) y tiene columna "id", usarla como codigo_vendedor
  if (
    mapa.razon_social === undefined &&
    mapa.codigo_vendedor === undefined &&
    mapa.codigo_cliente !== undefined &&
    mapa.nombre_vendedor !== undefined
  ) {
    mapa.codigo_vendedor = mapa.codigo_cliente;
    delete mapa.codigo_cliente;
  }

  return mapa;
}

function detectarFilaEncabezados(matriz: string[][]): {
  indiceFilaEncabezado: number;
  mapaColumnas: Partial<Record<CampoCanonico, number>>;
} {
  const limiteBusqueda = Math.min(matriz.length, 20);
  let mejorFila = 0;
  let mejorMapa: Partial<Record<CampoCanonico, number>> = {};
  let mejorCoincidencias = 0;

  for (let i = 0; i < limiteBusqueda; i++) {
    const fila = matriz[i] ?? [];
    const mapa = resolverMapaIndicesColumnas(fila);
    const coincidencias = Object.keys(mapa).length;
    const tieneClavePrimaria =
      mapa.codigo_cliente !== undefined ||
      mapa.razon_social !== undefined ||
      mapa.codigo_vendedor !== undefined;

    if (tieneClavePrimaria && coincidencias > mejorCoincidencias) {
      mejorCoincidencias = coincidencias;
      mejorFila = i;
      mejorMapa = mapa;
    }
  }

  return {
    indiceFilaEncabezado: mejorFila,
    mapaColumnas: mejorMapa,
  };
}

export interface ResultadoPreparacionMaestra {
  vendedoresValidos: VendedorSincronizacionInput[];
  clientesValidos: ClienteSincronizacionInput[];
  codigosClientesActivosTotales: string[];
  codigosVendedoresActivosTotales: string[];
  filasDatosRecibidas: number;
  filasOmitidasVacias: number;
  erroresDetalle: ErrorFilaSincronizacion[];
}

/**
 * Limpia, valida con Zod y deduplica una matriz tabular (CSV o Excel) generando
 * lotes limpios de vendedores y clientes listos para sincronizar en Supabase.
 */
export function prepararMatrizMaestraParaSincronizacion(
  matriz: string[][]
): ResultadoPreparacionMaestra {
  const erroresDetalle: ErrorFilaSincronizacion[] = [];
  const mapaVendedores = new Map<string, { fila: number; data: VendedorSincronizacionInput }>();
  const mapaClientes = new Map<string, { fila: number; data: ClienteSincronizacionInput }>();

  if (matriz.length === 0) {
    return {
      vendedoresValidos: [],
      clientesValidos: [],
      codigosClientesActivosTotales: [],
      codigosVendedoresActivosTotales: [],
      filasDatosRecibidas: 0,
      filasOmitidasVacias: 0,
      erroresDetalle: [
        {
          fila: 1,
          entidad: 'archivo',
          codigo: null,
          motivo: 'El archivo recibido está vacío.',
          severidad: 'error',
        },
      ],
    };
  }

  const { indiceFilaEncabezado, mapaColumnas } = detectarFilaEncabezados(matriz);
  const tieneColumnasCliente =
    mapaColumnas.codigo_cliente !== undefined || mapaColumnas.razon_social !== undefined;
  const tieneColumnasVendedor =
    mapaColumnas.codigo_vendedor !== undefined || mapaColumnas.nombre_vendedor !== undefined;

  if (!tieneColumnasCliente && !tieneColumnasVendedor) {
    return {
      vendedoresValidos: [],
      clientesValidos: [],
      codigosClientesActivosTotales: [],
      codigosVendedoresActivosTotales: [],
      filasDatosRecibidas: 0,
      filasOmitidasVacias: 0,
      erroresDetalle: [
        {
          fila: indiceFilaEncabezado + 1,
          entidad: 'archivo',
          codigo: null,
          motivo:
            'No se reconocieron encabezados válidos de Vendedores o Clientes (ej. Id, Razón Social, ID VENDEDOR, Vendedor).',
          severidad: 'error',
        },
      ],
    };
  }

  let filasDatosRecibidas = 0;
  let filasOmitidasVacias = 0;

  const leerCampo = (fila: string[], campo: CampoCanonico): string => {
    const idx = mapaColumnas[campo];
    if (idx === undefined || idx >= fila.length) return '';
    return limpiarCeldaTexto(fila[idx]);
  };

  for (let idxFila = indiceFilaEncabezado + 1; idxFila < matriz.length; idxFila++) {
    const filaCruda = matriz[idxFila] ?? [];
    const numeroFilaHumana = idxFila + 1;

    // Verificar si toda la fila está vacía o solo contiene fórmulas vacías (#N/D)
    const tieneAlgunValorUtil = filaCruda.some((celda) => limpiarCeldaTexto(celda).length > 0);
    if (!tieneAlgunValorUtil) {
      // Si la fila tenía separadores (ej. ;;;;;#N/D), se cuenta como fila vacía omitida
      if (filaCruda.some((c) => String(c ?? '').trim().length > 0)) {
        filasOmitidasVacias++;
      }
      continue;
    }

    filasDatosRecibidas++;

    const rawCodigoVendedor = leerCampo(filaCruda, 'codigo_vendedor');
    const rawNombreVendedor = leerCampo(filaCruda, 'nombre_vendedor');
    const rawSupervisor = leerCampo(filaCruda, 'supervisor');
    const rawZona = leerCampo(filaCruda, 'zona');

    // 1. Procesar Vendedor (si hay columnas de vendedor con datos en la fila)
    if (tieneColumnasVendedor && (rawCodigoVendedor || rawNombreVendedor)) {
      const parsedSeller = VendedorSincronizacionSchema.safeParse({
        codigo_vendedor: rawCodigoVendedor,
        nombre_completo: rawNombreVendedor,
        documento_identidad: leerCampo(filaCruda, 'documento_identidad') || null,
        telefono:
          leerCampo(filaCruda, 'telefono_vendedor') ||
          (!tieneColumnasCliente ? leerCampo(filaCruda, 'telefono') : '') ||
          null,
        email: leerCampo(filaCruda, 'email_vendedor') || null,
        zona: rawZona || null,
        supervisor: rawSupervisor || null,
        metadata: {},
      });

      if (!parsedSeller.success) {
        // Solo reportar error de vendedor si es archivo exclusivo de vendedores o falta la mitad del par
        const primerIssue = parsedSeller.error.issues[0];
        erroresDetalle.push({
          fila: numeroFilaHumana,
          entidad: 'vendedores',
          codigo: normalizarCodigoMaestro(rawCodigoVendedor) || null,
          campo: String(primerIssue?.path?.[0] ?? 'vendedor'),
          motivo: primerIssue?.message || 'Datos inválidos de vendedor en la fila.',
          severidad: tieneColumnasCliente ? 'advertencia' : 'error',
        });
      } else {
        const sellerData = parsedSeller.data;
        const previo = mapaVendedores.get(sellerData.codigo_vendedor);
        if (!tieneColumnasCliente && previo) {
          erroresDetalle.push({
            fila: numeroFilaHumana,
            entidad: 'vendedores',
            codigo: sellerData.codigo_vendedor,
            campo: 'codigo_vendedor',
            motivo: `Código de vendedor duplicado en el archivo (aparición previa en fila ${previo.fila}). Se conserva el registro más reciente.`,
            severidad: 'advertencia',
          });
        }
        mapaVendedores.set(sellerData.codigo_vendedor, {
          fila: numeroFilaHumana,
          data: {
            ...sellerData,
            zona: sellerData.zona ?? previo?.data.zona ?? null,
            supervisor: sellerData.supervisor ?? previo?.data.supervisor ?? null,
            telefono: sellerData.telefono ?? previo?.data.telefono ?? null,
            email: sellerData.email ?? previo?.data.email ?? null,
            documento_identidad:
              sellerData.documento_identidad ?? previo?.data.documento_identidad ?? null,
          },
        });
      }
    }

    // 2. Procesar Cliente (si el archivo incluye columnas de clientes)
    if (tieneColumnasCliente) {
      const rawCodigoCliente = leerCampo(filaCruda, 'codigo_cliente');
      const rawRazonSocial = leerCampo(filaCruda, 'razon_social');
      const rawNombreComercial =
        leerCampo(filaCruda, 'nombre_comercial') ||
        (rawRazonSocial ? extraerNombreComercialImplicito(rawRazonSocial) || '' : '');

      const latNorm = normalizarCoordenada(leerCampo(filaCruda, 'latitud'), -90, 90);
      const lngNorm = normalizarCoordenada(leerCampo(filaCruda, 'longitud'), -180, 180);

      if (latNorm === 'INVALID' || lngNorm === 'INVALID') {
        erroresDetalle.push({
          fila: numeroFilaHumana,
          entidad: 'clientes',
          codigo: normalizarCodigoMaestro(rawCodigoCliente) || null,
          campo: latNorm === 'INVALID' ? 'latitud' : 'longitud',
          motivo: 'Coordenada geográfica fuera de rango válido; se guardará como NULL.',
          severidad: 'advertencia',
        });
      }

      const parsedClient = ClienteSincronizacionSchema.safeParse({
        codigo_cliente: rawCodigoCliente,
        rif: leerCampo(filaCruda, 'rif') || null,
        razon_social: rawRazonSocial,
        nombre_comercial: rawNombreComercial || null,
        canal: leerCampo(filaCruda, 'canal') || null,
        segmento: leerCampo(filaCruda, 'segmento') || null,
        zona: rawZona || null,
        ruta: leerCampo(filaCruda, 'ruta') || null,
        direccion: leerCampo(filaCruda, 'direccion') || null,
        ciudad: leerCampo(filaCruda, 'ciudad') || null,
        estado: leerCampo(filaCruda, 'estado') || null,
        telefono: leerCampo(filaCruda, 'telefono') || null,
        latitud: latNorm === 'INVALID' ? null : latNorm,
        longitud: lngNorm === 'INVALID' ? null : lngNorm,
        codigo_vendedor: rawCodigoVendedor || null,
        metadata: rawSupervisor ? { supervisor_origen: rawSupervisor } : {},
      });

      if (!parsedClient.success) {
        const primerIssue = parsedClient.error.issues[0];
        erroresDetalle.push({
          fila: numeroFilaHumana,
          entidad: 'clientes',
          codigo: normalizarCodigoMaestro(rawCodigoCliente) || null,
          campo: String(primerIssue?.path?.[0] ?? 'cliente'),
          motivo: primerIssue?.message || 'Fila de cliente inválida.',
          severidad: 'error',
        });
      } else {
        const clientData = parsedClient.data;
        const previo = mapaClientes.get(clientData.codigo_cliente);
        if (previo) {
          erroresDetalle.push({
            fila: numeroFilaHumana,
            entidad: 'clientes',
            codigo: clientData.codigo_cliente,
            campo: 'codigo_cliente',
            motivo: `Código de cliente duplicado dentro del archivo (aparición previa en fila ${previo.fila}). Se consolida la última fila.`,
            severidad: 'advertencia',
          });
        }
        mapaClientes.set(clientData.codigo_cliente, {
          fila: numeroFilaHumana,
          data: clientData,
        });
      }
    }
  }

  const vendedoresValidos = Array.from(mapaVendedores.values()).map((v) => v.data);
  const clientesValidos = Array.from(mapaClientes.values()).map((c) => c.data);

  return {
    vendedoresValidos,
    clientesValidos,
    codigosClientesActivosTotales: clientesValidos.map((c) => c.codigo_cliente),
    codigosVendedoresActivosTotales: vendedoresValidos.map((v) => v.codigo_vendedor),
    filasDatosRecibidas,
    filasOmitidasVacias,
    erroresDetalle,
  };
}

/**
 * Valida y deduplica arreglos programáticos de vendedores y clientes mediante Zod.
 */
export function validarColeccionesMaestrasProgramaticas(params: {
  vendedores?: Record<string, unknown>[];
  clientes?: Record<string, unknown>[];
}): ResultadoPreparacionMaestra {
  const erroresDetalle: ErrorFilaSincronizacion[] = [];
  const mapaVendedores = new Map<string, { fila: number; data: VendedorSincronizacionInput }>();
  const mapaClientes = new Map<string, { fila: number; data: ClienteSincronizacionInput }>();

  const listaVend = params.vendedores ?? [];
  const listaCli = params.clientes ?? [];

  listaVend.forEach((raw, idx) => {
    const fila = idx + 1;
    const res = VendedorSincronizacionSchema.safeParse({
      codigo_vendedor: String(raw.codigo_vendedor ?? ''),
      nombre_completo: String(raw.nombre_completo ?? ''),
      documento_identidad: raw.documento_identidad != null ? String(raw.documento_identidad) : null,
      telefono: raw.telefono != null ? String(raw.telefono) : null,
      email: raw.email != null ? String(raw.email) : null,
      zona: raw.zona != null ? String(raw.zona) : null,
      supervisor: raw.supervisor != null ? String(raw.supervisor) : null,
      metadata:
        raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
          ? (raw.metadata as Record<string, unknown>)
          : {},
    });

    if (!res.success) {
      const issue = res.error.issues[0];
      erroresDetalle.push({
        fila,
        entidad: 'vendedores',
        codigo: normalizarCodigoMaestro(raw.codigo_vendedor) || null,
        campo: String(issue?.path?.[0] ?? 'vendedor'),
        motivo: issue?.message || 'Vendedor inválido.',
        severidad: 'error',
      });
      return;
    }

    if (mapaVendedores.has(res.data.codigo_vendedor)) {
      erroresDetalle.push({
        fila,
        entidad: 'vendedores',
        codigo: res.data.codigo_vendedor,
        campo: 'codigo_vendedor',
        motivo: `Vendedor duplicado en lote programático (fila previa ${mapaVendedores.get(res.data.codigo_vendedor)!.fila}).`,
        severidad: 'advertencia',
      });
    }
    mapaVendedores.set(res.data.codigo_vendedor, { fila, data: res.data });
  });

  listaCli.forEach((raw, idx) => {
    const fila = idx + 1;
    const latNorm =
      typeof raw.latitud === 'number'
        ? raw.latitud >= -90 && raw.latitud <= 90
          ? Number(raw.latitud.toFixed(7))
          : 'INVALID'
        : normalizarCoordenada(raw.latitud, -90, 90);
    const lngNorm =
      typeof raw.longitud === 'number'
        ? raw.longitud >= -180 && raw.longitud <= 180
          ? Number(raw.longitud.toFixed(7))
          : 'INVALID'
        : normalizarCoordenada(raw.longitud, -180, 180);

    const razonLimpia = limpiarCeldaTexto(raw.razon_social);
    const res = ClienteSincronizacionSchema.safeParse({
      codigo_cliente: String(raw.codigo_cliente ?? ''),
      rif: raw.rif != null ? String(raw.rif) : null,
      razon_social: razonLimpia,
      nombre_comercial:
        raw.nombre_comercial != null
          ? String(raw.nombre_comercial)
          : extraerNombreComercialImplicito(razonLimpia),
      canal: raw.canal != null ? String(raw.canal) : null,
      segmento: raw.segmento != null ? String(raw.segmento) : null,
      zona: raw.zona != null ? String(raw.zona) : null,
      ruta: raw.ruta != null ? String(raw.ruta) : null,
      direccion: raw.direccion != null ? String(raw.direccion) : null,
      ciudad: raw.ciudad != null ? String(raw.ciudad) : null,
      estado: raw.estado != null ? String(raw.estado) : null,
      telefono: raw.telefono != null ? String(raw.telefono) : null,
      latitud: latNorm === 'INVALID' ? null : latNorm,
      longitud: lngNorm === 'INVALID' ? null : lngNorm,
      codigo_vendedor: raw.codigo_vendedor != null ? String(raw.codigo_vendedor) : null,
      metadata:
        raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
          ? (raw.metadata as Record<string, unknown>)
          : {},
    });

    if (!res.success) {
      const issue = res.error.issues[0];
      erroresDetalle.push({
        fila,
        entidad: 'clientes',
        codigo: normalizarCodigoMaestro(raw.codigo_cliente) || null,
        campo: String(issue?.path?.[0] ?? 'cliente'),
        motivo: issue?.message || 'Cliente inválido.',
        severidad: 'error',
      });
      return;
    }

    if (mapaClientes.has(res.data.codigo_cliente)) {
      erroresDetalle.push({
        fila,
        entidad: 'clientes',
        codigo: res.data.codigo_cliente,
        campo: 'codigo_cliente',
        motivo: `Cliente duplicado en lote programático (fila previa ${mapaClientes.get(res.data.codigo_cliente)!.fila}).`,
        severidad: 'advertencia',
      });
    }
    mapaClientes.set(res.data.codigo_cliente, { fila, data: res.data });
  });

  const vendedoresValidos = Array.from(mapaVendedores.values()).map((v) => v.data);
  const clientesValidos = Array.from(mapaClientes.values()).map((c) => c.data);

  return {
    vendedoresValidos,
    clientesValidos,
    codigosClientesActivosTotales: clientesValidos.map((c) => c.codigo_cliente),
    codigosVendedoresActivosTotales: vendedoresValidos.map((v) => v.codigo_vendedor),
    filasDatosRecibidas: listaVend.length + listaCli.length,
    filasOmitidasVacias: 0,
    erroresDetalle,
  };
}

// =============================================================================
// 4. MOTOR DE SINCRONIZACIÓN POR LOTES (400 REGISTROS) + AUDITORÍA EN SUPABASE
// =============================================================================

export interface OpcionesSincronizacionMaestra {
  nombreArchivo?: string;
  reconciliarCarteraClientes?: boolean;
  desactivarVendedoresAusentes?: boolean;
  tamanoLote?: number;
  supabaseClient?: SupabaseClient<MasterDataDatabase>;
  onProgress?: (evento: {
    fase: 'validando' | 'vendedores' | 'clientes' | 'auditoria';
    loteActual: number;
    totalLotes: number;
  }) => void;
}

export async function ejecutarSincronizacionMaestraPreparada(
  preparado: ResultadoPreparacionMaestra,
  opciones: OpcionesSincronizacionMaestra = {}
): Promise<ResultadoSincronizacion> {
  const inicioMs = Date.now();
  const client = opciones.supabaseClient ?? getMasterDataSupabaseClient();
  const tamanoLote = opciones.tamanoLote ?? MASTER_SYNC_CHUNK_SIZE;

  const tieneVendedores = preparado.vendedoresValidos.length > 0;
  const tieneClientes = preparado.clientesValidos.length > 0;
  const entidad: EntidadSincronizacion =
    tieneVendedores && tieneClientes
      ? 'sincronizacion_completa'
      : tieneVendedores
        ? 'vendedores'
        : 'clientes';

  const erroresAcumulados: ErrorFilaSincronizacion[] = [...preparado.erroresDetalle];

  // Obtener usuario autenticado actual para trazabilidad en ejecutado_por
  let ejecutadoPor: string | null = null;
  try {
    const { data: userRes } = await client.auth.getUser();
    ejecutadoPor = userRes?.user?.id ?? null;
  } catch {
    ejecutadoPor = null;
  }

  // 1. Abrir registro de auditoría en public.lotes_sincronizacion
  let loteId: string | null = null;
  const { data: loteCreado, error: errorAperturaLote } = await client
    .from('lotes_sincronizacion')
    .insert({
      ejecutado_por: ejecutadoPor,
      entidad,
      nombre_archivo: opciones.nombreArchivo ?? null,
      registros_recibidos: preparado.filasDatosRecibidas,
      registros_procesados: 0,
      registros_desactivados: 0,
      errores_detalle: erroresAcumulados as unknown as Json,
      estado: 'en_proceso',
    })
    .select('id')
    .single();

  if (errorAperturaLote) {
    throw new Error(
      `No se pudo iniciar el lote de auditoría en Supabase (verifique rol admin/gerencia en app_metadata): ${errorAperturaLote.message}`
    );
  }
  loteId = loteCreado?.id ?? null;

  let vendedoresProcesados = 0;
  let vendedoresDesactivados = 0;
  let lotesVendedoresEnviados = 0;

  let clientesProcesados = 0;
  let clientesSinVendedor = 0;
  let clientesDesactivados = 0;
  let lotesClientesEnviados = 0;
  const codigosVendedorFaltantesSet = new Set<string>();

  try {
    // 2. Sincronizar primero VENDEDORES en lotes de 400 registros
    const chunksVendedores = dividirEnLotes(preparado.vendedoresValidos, tamanoLote);
    for (let i = 0; i < chunksVendedores.length; i++) {
      opciones.onProgress?.({
        fase: 'vendedores',
        loteActual: i + 1,
        totalLotes: chunksVendedores.length,
      });

      const esUnicoLoteVendedores = chunksVendedores.length === 1;
      const desactivarEnRpc =
        Boolean(opciones.desactivarVendedoresAusentes) && esUnicoLoteVendedores;

      const { data: rpcVendData, error: rpcVendErr } = await client.rpc(
        'rpc_sincronizar_vendedores',
        {
          p_registros: chunksVendedores[i] as unknown as Json,
          p_desactivar_ausentes: desactivarEnRpc,
        }
      );

      if (rpcVendErr) {
        throw new Error(
          `Error en rpc_sincronizar_vendedores (lote ${i + 1}/${chunksVendedores.length}): ${rpcVendErr.message}`
        );
      }

      const resumen = (rpcVendData ?? {
        procesados: 0,
        sin_vendedor_asignado: 0,
        desactivados: 0,
      }) as unknown as ResumenRpcSincronizacion;

      vendedoresProcesados += Number(resumen.procesados ?? 0);
      vendedoresDesactivados += Number(resumen.desactivados ?? 0);
      lotesVendedoresEnviados++;
    }

    // Si hubo >1 lote de vendedores y se pidió desactivar ausentes, reconciliar al cierre sin borrar filas
    if (
      opciones.desactivarVendedoresAusentes &&
      chunksVendedores.length > 1 &&
      preparado.codigosVendedoresActivosTotales.length > 0
    ) {
      const codigosSet = new Set(preparado.codigosVendedoresActivosTotales);
      const { data: activosActuales, error: errFetchVend } = await client
        .from('vendedores')
        .select('id, codigo_vendedor')
        .eq('activo', true);

      if (errFetchVend) {
        throw new Error(`Error verificando vendedores ausentes: ${errFetchVend.message}`);
      }

      const idsADesactivar = (activosActuales ?? [])
        .filter((v) => !codigosSet.has(v.codigo_vendedor))
        .map((v) => v.id);

      for (const idsChunk of dividirEnLotes(idsADesactivar, tamanoLote)) {
        const { error: errDeactVend } = await client
          .from('vendedores')
          .update({ activo: false })
          .in('id', idsChunk);
        if (errDeactVend) {
          throw new Error(`Error desactivando vendedores ausentes: ${errDeactVend.message}`);
        }
        vendedoresDesactivados += idsChunk.length;
      }
    }

    // 3. Sincronizar luego CLIENTES en lotes de 400 registros
    const chunksClientes = dividirEnLotes(preparado.clientesValidos, tamanoLote);
    for (let i = 0; i < chunksClientes.length; i++) {
      opciones.onProgress?.({
        fase: 'clientes',
        loteActual: i + 1,
        totalLotes: chunksClientes.length,
      });

      const esUltimoLote = i === chunksClientes.length - 1;
      const listaActivosTotales =
        opciones.reconciliarCarteraClientes &&
        esUltimoLote &&
        preparado.codigosClientesActivosTotales.length > 0
          ? preparado.codigosClientesActivosTotales
          : null;

      const { data: rpcCliData, error: rpcCliErr } = await client.rpc(
        'rpc_sincronizar_clientes',
        {
          p_registros: chunksClientes[i] as unknown as Json,
          p_codigos_activos_totales: listaActivosTotales,
        }
      );

      if (rpcCliErr) {
        throw new Error(
          `Error en rpc_sincronizar_clientes (lote ${i + 1}/${chunksClientes.length}): ${rpcCliErr.message}`
        );
      }

      const resumen = (rpcCliData ?? {
        procesados: 0,
        sin_vendedor_asignado: 0,
        desactivados: 0,
      }) as unknown as ResumenRpcSincronizacion;

      clientesProcesados += Number(resumen.procesados ?? 0);
      clientesSinVendedor += Number(resumen.sin_vendedor_asignado ?? 0);
      clientesDesactivados += Number(resumen.desactivados ?? 0);
      for (const codFaltante of resumen.codigos_vendedor_faltantes ?? []) {
        codigosVendedorFaltantesSet.add(codFaltante);
      }
      lotesClientesEnviados++;
    }

    const codigosVendedorFaltantes = Array.from(codigosVendedorFaltantesSet);
    if (codigosVendedorFaltantes.length > 0) {
      erroresAcumulados.push({
        fila: 0,
        entidad: 'clientes',
        codigo: codigosVendedorFaltantes.join(', '),
        campo: 'codigo_vendedor',
        motivo: `${clientesSinVendedor} cliente(s) quedaron con vendedor_id = NULL porque su codigo_vendedor aún no existe en public.vendedores: ${codigosVendedorFaltantes.join(', ')}.`,
        severidad: 'advertencia',
      });
    }

    const estadoFinal: EstadoLoteSincronizacion =
      erroresAcumulados.length > 0 ? 'con_observaciones' : 'completado';

    // 4. Cerrar auditoría en public.lotes_sincronizacion
    opciones.onProgress?.({ fase: 'auditoria', loteActual: 1, totalLotes: 1 });
    if (loteId) {
      await client
        .from('lotes_sincronizacion')
        .update({
          registros_procesados: vendedoresProcesados + clientesProcesados,
          registros_desactivados: vendedoresDesactivados + clientesDesactivados,
          errores_detalle: erroresAcumulados as unknown as Json,
          estado: estadoFinal,
        })
        .eq('id', loteId);
    }

    invalidarCacheMaestros();

    return {
      loteId,
      entidad,
      nombreArchivo: opciones.nombreArchivo ?? null,
      estado: estadoFinal,
      filasRecibidas: preparado.filasDatosRecibidas,
      filasOmitidasVacias: preparado.filasOmitidasVacias,
      vendedores: {
        recibidosUnicos: preparado.vendedoresValidos.length,
        procesados: vendedoresProcesados,
        desactivados: vendedoresDesactivados,
        lotesRpcEnviados: lotesVendedoresEnviados,
      },
      clientes: {
        recibidosUnicos: preparado.clientesValidos.length,
        procesados: clientesProcesados,
        sinVendedorAsignado: clientesSinVendedor,
        desactivados: clientesDesactivados,
        codigosVendedorFaltantes,
        lotesRpcEnviados: lotesClientesEnviados,
      },
      erroresDetalle: erroresAcumulados,
      duracionMs: Date.now() - inicioMs,
    };
  } catch (err) {
    const mensajeError = err instanceof Error ? err.message : String(err);
    erroresAcumulados.push({
      fila: 0,
      entidad: 'archivo',
      codigo: null,
      motivo: mensajeError,
      severidad: 'error',
    });

    if (loteId) {
      await client
        .from('lotes_sincronizacion')
        .update({
          registros_procesados: vendedoresProcesados + clientesProcesados,
          registros_desactivados: vendedoresDesactivados + clientesDesactivados,
          errores_detalle: erroresAcumulados as unknown as Json,
          estado: 'fallido',
        })
        .eq('id', loteId);
    }

    throw err;
  }
}

/**
 * Punto de entrada de alto nivel para sincronizar un archivo CSV (texto) o Excel (ArrayBuffer).
 */
export async function sincronizarArchivoMaestroTrade(
  contenidoArchivo: string | ArrayBuffer | Uint8Array,
  opciones: OpcionesSincronizacionMaestra = {}
): Promise<ResultadoSincronizacion> {
  opciones.onProgress?.({ fase: 'validando', loteActual: 0, totalLotes: 1 });
  const matriz =
    typeof contenidoArchivo === 'string'
      ? convertirTextoCsvAMatriz(contenidoArchivo)
      : await convertirWorkbookBufferAMatriz(contenidoArchivo);

  const preparado = prepararMatrizMaestraParaSincronizacion(matriz);
  return ejecutarSincronizacionMaestraPreparada(preparado, opciones);
}

/**
 * Punto de entrada de alto nivel para sincronizar colecciones JSON de vendedores y clientes.
 */
export async function sincronizarColeccionesMaestrasTrade(
  colecciones: {
    vendedores?: Record<string, unknown>[];
    clientes?: Record<string, unknown>[];
  },
  opciones: OpcionesSincronizacionMaestra = {}
): Promise<ResultadoSincronizacion> {
  opciones.onProgress?.({ fase: 'validando', loteActual: 0, totalLotes: 1 });
  const preparado = validarColeccionesMaestrasProgramaticas(colecciones);
  return ejecutarSincronizacionMaestraPreparada(preparado, opciones);
}

// =============================================================================
// 5. CAPA DE CONSULTA PAGINADA, CACHÉ LRU ACOTADA Y BÚSQUEDA SEGURA (", C.A.")
// =============================================================================

const initialCacheMaxItems = resolveMasterDataCacheMaxItems();
const initialCacheTtlMs = resolveMasterDataCacheTtlMs();

const cacheVendedores = new LRUCache<string, Vendedor[]>({
  maxItems: initialCacheMaxItems,
  ttlMs: initialCacheTtlMs,
});
const cacheClientes = new LRUCache<string, ClienteConVendedor[]>({
  maxItems: initialCacheMaxItems,
  ttlMs: initialCacheTtlMs,
});
const cacheCadenas = new LRUCache<string, CadenaComercial[]>({
  maxItems: Math.min(initialCacheMaxItems, 500),
  ttlMs: initialCacheTtlMs,
});
const cacheZonas = new LRUCache<string, ZonaComercial[]>({
  maxItems: Math.min(initialCacheMaxItems, 500),
  ttlMs: initialCacheTtlMs,
});
const cacheRegionesOficiales = new LRUCache<
  string,
  Map<AllowedRegionCode, SupabaseRegionCatalogRow>
>({
  maxItems: 16,
  ttlMs: initialCacheTtlMs,
});
const suscriptoresLocales = new Set<() => void>();

export interface MasterDataCacheMetricsSnapshot {
  clientes: LRUCacheMetrics;
  vendedores: LRUCacheMetrics;
  cadenas: LRUCacheMetrics;
  zonas: LRUCacheMetrics;
  regiones: LRUCacheMetrics;
  total: {
    size: number;
    hits: number;
    misses: number;
    evictions: number;
  };
}

export function getMasterDataCacheMetrics(): MasterDataCacheMetricsSnapshot {
  const clientes = cacheClientes.getMetrics();
  const vendedores = cacheVendedores.getMetrics();
  const cadenas = cacheCadenas.getMetrics();
  const zonas = cacheZonas.getMetrics();
  const regiones = cacheRegionesOficiales.getMetrics();
  return {
    clientes,
    vendedores,
    cadenas,
    zonas,
    regiones,
    total: {
      size: clientes.size + vendedores.size + cadenas.size + zonas.size + regiones.size,
      hits: clientes.hits + vendedores.hits + cadenas.hits + zonas.hits + regiones.hits,
      misses: clientes.misses + vendedores.misses + cadenas.misses + zonas.misses + regiones.misses,
      evictions:
        clientes.evictions +
        vendedores.evictions +
        cadenas.evictions +
        zonas.evictions +
        regiones.evictions,
    },
  };
}

export function configureMasterDataCaches(options: {
  maxItems?: number;
  ttlMs?: number;
}): void {
  cacheClientes.reconfigure(options);
  cacheVendedores.reconfigure(options);
  cacheCadenas.reconfigure({
    ...(options.maxItems !== undefined ? { maxItems: Math.min(options.maxItems, 500) } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });
  cacheZonas.reconfigure({
    ...(options.maxItems !== undefined ? { maxItems: Math.min(options.maxItems, 500) } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });
  if (options.ttlMs !== undefined) {
    cacheRegionesOficiales.reconfigure({ ttlMs: options.ttlMs });
  }
}

export function clearMasterDataCaches(): void {
  cacheVendedores.clear();
  cacheClientes.clear();
  cacheCadenas.clear();
  cacheZonas.clear();
  cacheRegionesOficiales.clear();
}

registerSupabaseSessionResetCallback(clearMasterDataCaches);
registerMemoryCachePurgeCallback(clearMasterDataCaches);

function buildScopedMasterCacheKey(
  params: Record<string, unknown>,
  explicitScope?: string | null
): string {
  const scope = (explicitScope || getActiveClientSucursalHeader() || 'GLOBAL').trim().toUpperCase();
  return `${scope}::${JSON.stringify(params)}`;
}

/**
 * Invalida toda la caché de maestros o únicamente las entradas asociadas a una región específica
 * (además de vistas `GLOBAL::` afectadas para mantener consistencia en perfiles administrativos).
 */
export function invalidarCacheMaestros(regionScope?: string): void {
  const cleanScope = regionScope?.trim().toUpperCase();
  if (!cleanScope || cleanScope === 'GLOBAL' || cleanScope === 'ALL') {
    clearMasterDataCaches();
  } else {
    const matchesScope = (key: string) =>
      key.startsWith(`${cleanScope}::`) ||
      key.startsWith('GLOBAL::') ||
      key.includes(`"region":"${cleanScope}"`);
    cacheVendedores.deleteWhere(matchesScope);
    cacheClientes.deleteWhere(matchesScope);
    cacheCadenas.deleteWhere(matchesScope);
    cacheZonas.deleteWhere(matchesScope);
  }
  for (const listener of suscriptoresLocales) {
    try {
      listener();
    } catch {
      // Aísla fallos de oyentes individuales
    }
  }
}

export function suscribirInvalidacionCacheMaestros(listener: () => void): () => void {
  suscriptoresLocales.add(listener);
  return () => {
    suscriptoresLocales.delete(listener);
  };
}

/**
 * Detecta y neutraliza intentos de inyección de cláusulas PostgREST (ej. `,activo.eq.false`,
 * `,id.neq.0`, `,razon_social.ilike.%x%`) preservando intactas comas comerciales legítimas
 * como `", C.A."`, `", S.A."` o `", S.R.L."`.
 */
const POSTGREST_INJECTION_CLAUSE_REGEX =
  /,\s*[a-z_][a-z0-9_]*\.(?:not\.)?(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|cs|cd|ov|fts|plfts|phfts|wfts|match|imatch)\.[^,]*/gi;

const STANDALONE_POSTGREST_OP_REGEX =
  /\b[a-z_][a-z0-9_]*\.(?:not\.)?(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|cs|cd|ov)\.[a-z0-9_%-]*\b/gi;

const VENEZUELAN_CORP_SUFFIX_REGEX =
  /^(.*?)(?:,\s*|\s+)(C\.?\s*A\.?|S\.?\s*A\.?|S\.?\s*R\.?\s*L\.?)$/i;

/**
 * Sanitiza un término de búsqueda comercial para PostgREST conservando comas y puntos
 * legítimos de razones sociales venezolanas (`", C.A."`, `", S.A."`) mientras neutraliza
 * paréntesis, comillas no balanceadas, operadores inyectados y comodines LIKE.
 */
export function sanitizarTerminoBusquedaComercial(busqueda: string, maxLen = 120): string {
  const withoutControl = String(busqueda ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(POSTGREST_INJECTION_CLAUSE_REGEX, ' ')
    .replace(STANDALONE_POSTGREST_OP_REGEX, ' ')
    // Bloquear ruptura de delimitadores PostgREST `"..."` y grupos `(...)`
    .replace(/[()"';*\\]/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLen);

  if (!withoutControl) return '';
  // Escapar comodines SQL LIKE (`%`, `_`)
  return withoutControl.replace(/([%_])/g, '\\$1');
}

function formatPostgrestIlikeOperand(escapedPattern: string): string {
  // En la gramática de PostgREST `.or(...)`, cualquier operando con `,` o `.`
  // debe ir encerrado en comillas dobles `"..."` para tratarse como texto literal.
  if (/[,.]/.test(escapedPattern)) {
    return `"${escapedPattern}"`;
  }
  return escapedPattern;
}

function buildCommercialPatternVariants(sanitizedTerm: string): string[] {
  const variants = new Set<string>([`%${sanitizedTerm}%`]);
  const suffixMatch = VENEZUELAN_CORP_SUFFIX_REGEX.exec(sanitizedTerm);
  if (suffixMatch) {
    const stem = suffixMatch[1]!.trim();
    const rawSuffix = suffixMatch[2]!.replace(/[.\s]+/g, '').toUpperCase();
    const flexibleSuffix = rawSuffix.split('').join('%');
    if (stem) {
      // Permite que `"DISTRIBUIDORA Z CA"` encuentre `"DISTRIBUIDORA Z, C.A."` y viceversa
      variants.add(`%${stem}%${flexibleSuffix}%`);
    } else if (rawSuffix) {
      variants.add(`%${flexibleSuffix}%`);
    }
  }
  return Array.from(variants);
}

export function construirFiltroOrBusquedaClientes(busqueda: string): string {
  const safeTerm = sanitizarTerminoBusquedaComercial(busqueda);
  if (!safeTerm) return '';

  const patterns = buildCommercialPatternVariants(safeTerm);
  const primaryOperand = formatPostgrestIlikeOperand(patterns[0]!);
  const clauses: string[] = [
    `codigo_cliente.ilike.${primaryOperand}`,
    `razon_social.ilike.${primaryOperand}`,
    `nombre_comercial.ilike.${primaryOperand}`,
    `rif.ilike.${primaryOperand}`,
  ];

  for (let i = 1; i < patterns.length; i++) {
    const altOperand = formatPostgrestIlikeOperand(patterns[i]!);
    clauses.push(`razon_social.ilike.${altOperand}`);
    clauses.push(`nombre_comercial.ilike.${altOperand}`);
  }

  return clauses.join(',');
}

export function construirFiltroOrBusquedaGenerica(
  busqueda: string,
  columnas: readonly string[]
): string {
  const safeTerm = sanitizarTerminoBusquedaComercial(busqueda);
  if (!safeTerm || columnas.length === 0) return '';
  const operand = formatPostgrestIlikeOperand(`%${safeTerm}%`);
  return columnas.map((col) => `${col}.ilike.${operand}`).join(',');
}

/**
 * Comparador local tolerante a comas, puntos y tildes para razones sociales venezolanas
 * (`"DISTRIBUIDORA Z, C.A."`, `"DISTRIBUIDORA Z CA"`, `", C.A."`).
 */
export function coincideBusquedaComercialNormalizada(
  textoObjetivo: string | null | undefined,
  busqueda: string | null | undefined
): boolean {
  const rawQuery = String(busqueda ?? '').trim();
  if (!rawQuery) return true;
  const target = String(textoObjetivo ?? '');
  if (!target) return false;

  const lowerTarget = target.toLowerCase();
  const lowerQuery = rawQuery.toLowerCase();
  if (lowerTarget.includes(lowerQuery)) return true;

  const compact = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9Ñ]+/g, '');

  const compactQuery = compact(rawQuery);
  if (compactQuery.length < 2) return false;
  return compact(target).includes(compactQuery);
}

function normalizeReturnedMasterSucursal(raw: Record<string, unknown>): SucursalMaestro | null {
  return (
    normalizarSucursalMaestro(raw.sucursal) ??
    normalizarSucursalMaestro(raw.region_codigo) ??
    normalizarSucursalMaestro(raw.region) ??
    normalizarSucursalMaestro(raw.sede) ??
    null
  );
}

function normalizeReturnedClienteRow(raw: Record<string, unknown>): ClienteConVendedor {
  const row = raw as unknown as ClienteConVendedor;
  const sucursalNorm = normalizeReturnedMasterSucursal(raw);
  return {
    ...row,
    codigo_cliente: String(raw.codigo_cliente ?? raw.codigo ?? raw.id ?? '').trim(),
    razon_social:
      limpiarCeldaTexto(raw.razon_social ?? raw.nombre_comercial ?? raw.nombre ?? '') || 'Sin nombre',
    nombre_comercial: limpiarCeldaTexto(raw.nombre_comercial ?? raw.nombre ?? '') || row.nombre_comercial || null,
    sucursal: sucursalNorm,
    region_id: raw.region_id ? String(raw.region_id).trim() : null,
    activo: raw.activo !== false,
  };
}

function normalizeReturnedVendedorRow(raw: Record<string, unknown>): Vendedor {
  const row = raw as unknown as Vendedor;
  return {
    ...row,
    sucursal: normalizeReturnedMasterSucursal(raw),
    region_id: raw.region_id ? String(raw.region_id).trim() : null,
    activo: raw.activo !== false,
  };
}

function normalizeReturnedCadenaRow(raw: Record<string, unknown>): CadenaComercial {
  const row = raw as unknown as CadenaComercial;
  return {
    ...row,
    sucursal: normalizeReturnedMasterSucursal(raw),
    region_id: raw.region_id ? String(raw.region_id).trim() : null,
    activo: raw.activo !== false,
  };
}

function normalizeReturnedZonaRow(raw: Record<string, unknown>): ZonaComercial {
  const row = raw as unknown as ZonaComercial;
  return {
    ...row,
    sucursal: normalizeReturnedMasterSucursal(raw),
    region_id: raw.region_id ? String(raw.region_id).trim() : null,
    activo: raw.activo !== false,
  };
}

function isPostgrestSchemaMismatchError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? '').toUpperCase();
  const msg = String(err.message ?? '').toLowerCase();
  return (
    code === 'PGRST200' ||
    code === 'PGRST204' ||
    code === '42703' ||
    msg.includes('could not find a relationship') ||
    msg.includes('does not exist')
  );
}

function isMissingRelationPostgrestError(
  err: { code?: string; message?: string } | null | undefined
): boolean {
  if (!err) return false;
  const code = String(err.code ?? '').toUpperCase();
  const msg = String(err.message ?? '').toLowerCase();
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    msg.includes('could not find the table') ||
    (msg.includes('relation') && msg.includes('does not exist'))
  );
}

async function resolveBearerTokenForMasterApi(
  client: SupabaseClient<MasterDataDatabase>
): Promise<string> {
  const cached = getCachedAccessToken();
  if (cached && cached.length >= 20) return cached;
  try {
    const { data } = await client.auth.getSession();
    return data?.session?.access_token?.trim() || '';
  } catch {
    return '';
  }
}

async function fetchErpTablePagesDirect<T>(
  client: SupabaseClient<MasterDataDatabase>,
  tableName:
    | 'Regiones'
    | 'Sucursales'
    | 'Estados'
    | 'Municipios'
    | 'Supervisores'
    | 'Tipificacion_Clientes'
    | 'Canal_Comercializacion'
    | 'Forecast_Vendedores_Excluidos'
    | 'Vendedores'
    | 'Clientes',
  selectExpr: string,
  optional = false
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += POSTGREST_READ_PAGE_SIZE) {
    const { data, error } = await client
      .from(tableName)
      .select(selectExpr)
      .range(from, from + POSTGREST_READ_PAGE_SIZE - 1);

    if (error) {
      if (optional) return [];
      throw new Error(`Error consultando tabla ERP "${tableName}": ${error.message}`);
    }

    const page = Array.isArray(data) ? (data as unknown as T[]) : [];
    rows.push(...page);
    if (page.length < POSTGREST_READ_PAGE_SIZE) {
      break;
    }
  }
  return rows;
}

async function fetchMasterEntityFromBackendApi<T>(
  endpoint:
    | '/api/maestros/vendedores'
    | '/api/maestros/clientes'
    | '/api/maestros/cadenas'
    | '/api/maestros/zonas',
  params: URLSearchParams,
  client: SupabaseClient<MasterDataDatabase>,
  effectiveSucursal: SucursalMaestro | null
): Promise<T[] | null> {
  if (typeof fetch !== 'function' || typeof window === 'undefined') {
    return null;
  }

  const token = await resolveBearerTokenForMasterApi(client);
  if (!token) return null;

  const queryStr = params.toString();
  const url = `${endpoint}${queryStr ? `?${queryStr}` : ''}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(effectiveSucursal ? { 'x-sucursal-activa': effectiveSucursal } : {}),
    },
  });

  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    let serverMsg = '';
    try {
      const errJson = (await res.json()) as { error?: string };
      serverMsg = errJson?.error ? String(errJson.error) : '';
    } catch {
      // Cuerpo no JSON
    }
    throw new Error(
      serverMsg || `Error HTTP ${res.status} consultando ${endpoint} en el servidor.`
    );
  }
  const payload = (await res.json()) as { data?: unknown };
  if (!Array.isArray(payload?.data)) {
    throw new Error(`Formato de respuesta inesperado desde ${endpoint}.`);
  }
  return payload.data as T[];
}

async function fetchVendedoresFromBackendApi(
  filtros: FiltrosConsultaVendedores,
  client: SupabaseClient<MasterDataDatabase>,
  effectiveSucursal: SucursalMaestro | null
): Promise<Vendedor[] | null> {
  const params = new URLSearchParams();
  if (filtros.soloActivos === false) params.set('soloActivos', 'false');
  if (filtros.region) {
    params.set('region', filtros.region);
  } else if (effectiveSucursal) {
    params.set('sucursal', effectiveSucursal);
  }
  if (filtros.regionId?.trim()) params.set('regionId', filtros.regionId.trim());
  if (filtros.zona?.trim()) params.set('zona', filtros.zona.trim());
  if (filtros.supervisor?.trim()) params.set('supervisor', filtros.supervisor.trim());
  if (filtros.busqueda?.trim()) params.set('busqueda', filtros.busqueda.trim());
  if (filtros.forzarRefresco) params.set('forzarRefresco', '1');
  return fetchMasterEntityFromBackendApi<Vendedor>(
    '/api/maestros/vendedores',
    params,
    client,
    filtros.region ? null : effectiveSucursal
  );
}

async function fetchClientesFromBackendApi(
  filtros: FiltrosConsultaClientes,
  client: SupabaseClient<MasterDataDatabase>,
  effectiveSucursal: SucursalMaestro | null
): Promise<ClienteConVendedor[] | null> {
  const params = new URLSearchParams();
  if (filtros.soloActivos === false) params.set('soloActivos', 'false');
  if (filtros.region) {
    params.set('region', filtros.region);
  } else if (effectiveSucursal) {
    params.set('sucursal', effectiveSucursal);
  }
  if (filtros.regionId?.trim()) params.set('regionId', filtros.regionId.trim());
  if (filtros.zona?.trim()) params.set('zona', filtros.zona.trim());
  if (filtros.ruta?.trim()) params.set('ruta', filtros.ruta.trim());
  if (filtros.vendedorId?.trim()) params.set('vendedorId', filtros.vendedorId.trim());
  if (filtros.codigoVendedor?.trim()) params.set('codigoVendedor', filtros.codigoVendedor.trim());
  if (filtros.canal?.trim()) params.set('canal', filtros.canal.trim());
  if (filtros.busqueda?.trim()) params.set('busqueda', filtros.busqueda.trim());
  if (filtros.forzarRefresco) params.set('forzarRefresco', '1');
  return fetchMasterEntityFromBackendApi<ClienteConVendedor>(
    '/api/maestros/clientes',
    params,
    client,
    filtros.region ? null : effectiveSucursal
  );
}

async function fetchVendedoresFromSupabaseErpTables(
  client: SupabaseClient<MasterDataDatabase>,
  filtros: FiltrosConsultaVendedores,
  effectiveSucursal: SucursalMaestro | null
): Promise<Vendedor[]> {
  const [regiones, sucursales, supervisores, vendedoresRaw, vendedoresExcluidos, clientesMin] =
    await Promise.all([
      fetchErpTablePagesDirect<ErpRegionRow>(client, 'Regiones', 'id_regi,created_at,regi_desd,regi_saba', false),
      fetchErpTablePagesDirect<ErpSucursalRow>(client, 'Sucursales', 'id_sucu,created_at,sucu_desc,id_regi', true),
      fetchErpTablePagesDirect<ErpSupervisorRow>(client, 'Supervisores', 'id_supe,created_at,supe_nomb,supe_acti,id_regi,supe_cont', true),
      fetchErpTablePagesDirect<ErpVendedorRow>(client, 'Vendedores', 'id_vend,created_at,vend_codi,vend_nomb,vend_acti,id_sucu,id_supe,vend_cont', false),
      fetchErpTablePagesDirect<ErpForecastExcludedVendedoresRow>(
        client,
        'Forecast_Vendedores_Excluidos',
        'id_fove,id_regi,fove_vend,updated_at',
        true
      ),
      fetchErpTablePagesDirect<ErpClienteRow>(client, 'Clientes', 'id_clie,id_vend,clie_acti', true),
    ]);

  const normalized = normalizeErpVendedoresDataset({
    regiones,
    sucursales,
    supervisores,
    vendedores: vendedoresRaw,
    vendedoresExcluidos,
    clientes: clientesMin,
  });

  return filterNormalizedErpVendedores(normalized, {
    ...filtros,
    sucursal: effectiveSucursal ?? undefined,
  });
}

async function fetchClientesFromSupabaseErpTables(
  client: SupabaseClient<MasterDataDatabase>,
  filtros: FiltrosConsultaClientes,
  effectiveSucursal: SucursalMaestro | null
): Promise<ClienteConVendedor[]> {
  const [
    regiones,
    sucursales,
    estados,
    municipios,
    supervisores,
    vendedoresRaw,
    tipificaciones,
    clientesRaw,
  ] = await Promise.all([
    fetchErpTablePagesDirect<ErpRegionRow>(client, 'Regiones', 'id_regi,created_at,regi_desd,regi_saba', true),
    fetchErpTablePagesDirect<ErpSucursalRow>(client, 'Sucursales', 'id_sucu,created_at,sucu_desc,id_regi', true),
    fetchErpTablePagesDirect<ErpEstadoRow>(client, 'Estados', 'id_esta,created_at,esta_desc,id_regi', true),
    fetchErpTablePagesDirect<ErpMunicipioRow>(client, 'Municipios', 'id_muni,created_at,muni_desc,id_esta,id_regi', true),
    fetchErpTablePagesDirect<ErpSupervisorRow>(client, 'Supervisores', 'id_supe,created_at,supe_nomb,supe_acti,id_regi,supe_cont', true),
    fetchErpTablePagesDirect<ErpVendedorRow>(client, 'Vendedores', 'id_vend,created_at,vend_codi,vend_nomb,vend_acti,id_sucu,id_supe,vend_cont', true),
    fetchErpTablePagesDirect<ErpTipificacionRow>(client, 'Tipificacion_Clientes', 'id_tipi,created_at,tipi_desc,id_cave', true),
    fetchErpTablePagesDirect<ErpClienteRow>(
      client,
      'Clientes',
      'id_clie,created_at,clie_rif,clie_nomb,id_esta,id_vend,id_muni,clie_regi,clie_acti,clie_lati,clie_long,id_tipi',
      false
    ),
  ]);

  const normalized = normalizeErpClientesDataset({
    regiones,
    sucursales,
    estados,
    municipios,
    supervisores,
    vendedores: vendedoresRaw,
    tipificaciones,
    clientes: clientesRaw,
  });

  return filterNormalizedErpClientes(normalized, {
    ...filtros,
    sucursal: effectiveSucursal ?? undefined,
  });
}

/**
 * Consulta la Fuente Única de Verdad de Vendedores en Supabase (por defecto `activo = true`).
 * Soporta tanto el esquema normalizado (`public.vendedores`) como las tablas ERP de Codizulca
 * (`public."Vendedores"` + `"Sucursales"` + `"Supervisores"` + `"Regiones"`), acotado por sede.
 */
export async function obtenerVendedoresMaestros(
  filtros: FiltrosConsultaVendedores = {},
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<Vendedor[]> {
  const soloActivos = filtros.soloActivos !== false;
  const effectiveSucursal = filtros.sucursal ?? getActiveClientSucursalHeader() ?? null;
  const claveCache = buildScopedMasterCacheKey({
    soloActivos,
    sucursal: effectiveSucursal || '',
    zona: filtros.zona?.trim().toUpperCase() || '',
    supervisor: filtros.supervisor?.trim().toUpperCase() || '',
    busqueda: filtros.busqueda?.trim().toUpperCase() || '',
  });

  if (!filtros.forzarRefresco) {
    const enCache = cacheVendedores.get(claveCache);
    if (enCache !== undefined) {
      return enCache;
    }
  }

  const client = supabaseClient ?? getMasterDataSupabaseClient();

  if (!supabaseClient) {
    const fromApi = await fetchVendedoresFromBackendApi(filtros, client, effectiveSucursal);
    if (fromApi !== null) {
      cacheVendedores.set(claveCache, fromApi);
      return fromApi;
    }
  }

  const acumulado: Vendedor[] = [];
  let desde = 0;
  let missingLowercaseTable = false;

  while (true) {
    let query = client
      .from('vendedores')
      .select('*')
      .order('nombre_completo', { ascending: true })
      .range(desde, desde + POSTGREST_READ_PAGE_SIZE - 1);

    if (soloActivos) {
      query = query.eq('activo', true);
    }
    if (filtros.zona?.trim()) {
      query = query.ilike('zona', filtros.zona.trim());
    }
    if (filtros.supervisor?.trim()) {
      query = query.ilike('supervisor', filtros.supervisor.trim());
    }
    if (filtros.busqueda?.trim()) {
      const orFilter = construirFiltroOrBusquedaGenerica(filtros.busqueda, [
        'codigo_vendedor',
        'nombre_completo',
      ]);
      if (orFilter) {
        query = query.or(orFilter);
      }
    }

    const { data, error } = await query;
    if (error) {
      if (desde === 0 && isMissingRelationPostgrestError(error)) {
        missingLowercaseTable = true;
        break;
      }
      throw new Error(`Error consultando vendedores maestros: ${error.message}`);
    }

    const pagina = ((data ?? []) as unknown as Record<string, unknown>[]).map(
      normalizeReturnedVendedorRow
    );
    acumulado.push(...pagina);
    if (pagina.length < POSTGREST_READ_PAGE_SIZE) {
      break;
    }
    desde += POSTGREST_READ_PAGE_SIZE;
  }

  if (missingLowercaseTable || (acumulado.length === 0 && !supabaseClient)) {
    const fromApi = !supabaseClient
      ? await fetchVendedoresFromBackendApi(filtros, client, effectiveSucursal)
      : null;
    if (fromApi !== null) {
      cacheVendedores.set(claveCache, fromApi);
      return fromApi;
    }
    if (missingLowercaseTable) {
      const fromErp = await fetchVendedoresFromSupabaseErpTables(client, filtros, effectiveSucursal);
      cacheVendedores.set(claveCache, fromErp);
      return fromErp;
    }
  }

  const resultado = effectiveSucursal
    ? acumulado.filter((v) => !v.sucursal || v.sucursal === effectiveSucursal)
    : acumulado;

  cacheVendedores.set(claveCache, resultado);
  return resultado;
}

/**
 * Consulta la Fuente Única de Verdad de Clientes en Supabase paginando bloques de 1,000
 * registros automáticamente para soportar carteras > 2,700 clientes sin truncamiento.
 * Soporta tanto `public.clientes` como las tablas ERP de Codizulca (`public."Clientes"` +
 * `"Vendedores"` + `"Sucursales"` + `"Estados"` + `"Regiones"`), aislando estrictamente por sede.
 */
export async function obtenerClientesMaestros(
  filtros: FiltrosConsultaClientes = {},
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<ClienteConVendedor[]> {
  const soloActivos = filtros.soloActivos !== false;
  const incluirVendedor = filtros.incluirVendedor !== false;
  const effectiveSucursal = filtros.sucursal ?? getActiveClientSucursalHeader() ?? null;
  const claveCache = buildScopedMasterCacheKey(
    {
      soloActivos,
      incluirVendedor,
      sucursal: effectiveSucursal || '',
      zona: filtros.zona?.trim().toUpperCase() || '',
      ruta: filtros.ruta?.trim().toUpperCase() || '',
      vendedorId: filtros.vendedorId?.trim() || '',
      codigoVendedor: filtros.codigoVendedor?.trim().toUpperCase() || '',
      canal: filtros.canal?.trim().toUpperCase() || '',
      region: filtros.region || '',
      regionId: filtros.regionId?.trim() || '',
      busqueda: filtros.busqueda?.trim().toUpperCase() || '',
    },
    filtros.region ?? null
  );

  if (!filtros.forzarRefresco) {
    const enCache = cacheClientes.get(claveCache);
    if (enCache !== undefined) {
      return enCache;
    }
  }

  const client = supabaseClient ?? getMasterDataSupabaseClient();

  if (!supabaseClient) {
    const fromApi = await fetchClientesFromBackendApi(filtros, client, effectiveSucursal);
    if (fromApi !== null) {
      cacheClientes.set(claveCache, fromApi);
      return fromApi;
    }
  }

  let useJoinVendedor = incluirVendedor;
  let useOrderByRazon = true;
  let missingLowercaseTable = false;

  const acumulado: ClienteConVendedor[] = [];
  let desde = 0;

  while (true) {
    const runPage = async (withJoin: boolean, withOrder: boolean) => {
      const selectExpr = withJoin
        ? '*, vendedor:vendedores(id, codigo_vendedor, nombre_completo, zona, supervisor, activo)'
        : '*';
      let query = client.from('clientes').select(selectExpr);
      if (withOrder) {
        query = query.order('razon_social', { ascending: true });
      }
      query = query.range(desde, desde + POSTGREST_READ_PAGE_SIZE - 1);

      if (soloActivos) {
        query = query.eq('activo', true);
      }
      if (filtros.regionId?.trim()) {
        query = query.eq('region_id', filtros.regionId.trim());
      }
      if (filtros.zona?.trim()) {
        query = query.ilike('zona', filtros.zona.trim());
      }
      if (filtros.ruta?.trim()) {
        query = query.ilike('ruta', filtros.ruta.trim());
      }
      if (filtros.vendedorId?.trim()) {
        query = query.eq('vendedor_id', filtros.vendedorId.trim());
      }
      if (filtros.codigoVendedor?.trim()) {
        query = query.eq('codigo_vendedor', normalizarCodigoMaestro(filtros.codigoVendedor));
      }
      if (filtros.canal?.trim()) {
        query = query.ilike('canal', filtros.canal.trim());
      }
      if (filtros.busqueda?.trim()) {
        const orFilter = construirFiltroOrBusquedaClientes(filtros.busqueda);
        if (orFilter) {
          query = query.or(orFilter);
        }
      }

      return query;
    };

    let { data, error } = await runPage(useJoinVendedor, useOrderByRazon);
    if (error && desde === 0 && isMissingRelationPostgrestError(error)) {
      missingLowercaseTable = true;
      break;
    }
    if (error && useJoinVendedor && isPostgrestSchemaMismatchError(error)) {
      useJoinVendedor = false;
      ({ data, error } = await runPage(false, useOrderByRazon));
      if (error && desde === 0 && isMissingRelationPostgrestError(error)) {
        missingLowercaseTable = true;
        break;
      }
    }
    if (error && useOrderByRazon && isPostgrestSchemaMismatchError(error)) {
      useOrderByRazon = false;
      ({ data, error } = await runPage(useJoinVendedor, false));
      if (error && desde === 0 && isMissingRelationPostgrestError(error)) {
        missingLowercaseTable = true;
        break;
      }
    }
    if (error) {
      throw new Error(`Error consultando clientes maestros: ${error.message}`);
    }

    const pagina = ((data ?? []) as unknown as Record<string, unknown>[]).map(
      normalizeReturnedClienteRow
    );
    acumulado.push(...pagina);
    if (pagina.length < POSTGREST_READ_PAGE_SIZE) {
      break;
    }
    desde += POSTGREST_READ_PAGE_SIZE;
  }

  if (missingLowercaseTable || (acumulado.length === 0 && !supabaseClient)) {
    const fromApi = !supabaseClient
      ? await fetchClientesFromBackendApi(filtros, client, effectiveSucursal)
      : null;
    if (fromApi !== null) {
      cacheClientes.set(claveCache, fromApi);
      return fromApi;
    }
    if (missingLowercaseTable) {
      const fromErp = await fetchClientesFromSupabaseErpTables(client, filtros, effectiveSucursal);
      cacheClientes.set(claveCache, fromErp);
      return fromErp;
    }
  }

  const resultado = effectiveSucursal
    ? acumulado.filter((c) => {
        const sucu = c.sucursal ?? inferirSucursalDesdeTerritorio(c);
        return !sucu || sucu === effectiveSucursal;
      })
    : acumulado;

  cacheClientes.set(claveCache, resultado);
  return resultado;
}

/**
 * Consulta el historial reciente de lotes de sincronización (exclusivo para admin/gerencia por RLS).
 */
export async function obtenerHistorialLotesSincronizacion(
  limite = 25,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<LoteSincronizacion[]> {
  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const { data, error } = await client
    .from('lotes_sincronizacion')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(200, limite)));

  if (error) {
    throw new Error(`Error consultando lotes_sincronizacion: ${error.message}`);
  }
  return (data ?? []) as unknown as LoteSincronizacion[];
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SucursalMaestroCrudSchema = z
  .string()
  .nullable()
  .optional()
  .transform((val, ctx) => {
    if (val === null || val === undefined) return val;
    const limpio = limpiarCeldaTexto(val);
    if (!limpio) return null;
    const norm = normalizarSucursalMaestro(limpio);
    if (!norm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Sucursal inválida. Valores permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
      });
      return z.NEVER;
    }
    return norm;
  });

export const CadenaComercialCrudSchema = z.object({
  id: z.string().regex(UUID_V4_REGEX).optional(),
  codigo: z
    .string()
    .transform((v) => normalizarCodigoMaestro(v))
    .refine((v) => v.length >= 2 && v.length <= 40, {
      message: 'El código de cadena debe tener entre 2 y 40 caracteres.',
    }),
  nombre: z
    .string()
    .transform((v) => limpiarCeldaTexto(v))
    .refine((v) => v.length >= 2 && v.length <= 160, {
      message: 'El nombre de la cadena comercial es obligatorio (2-160 caracteres).',
    }),
  tipo_canal: z
    .string()
    .optional()
    .default('Supermercado')
    .transform((v) => limpiarCeldaTexto(v) || 'Supermercado'),
  sucursal: SucursalMaestroCrudSchema,
  region_id: z.string().regex(UUID_V4_REGEX).nullable().optional(),
  activo: z.boolean().optional().default(true),
});

export const ZonaComercialCrudSchema = z.object({
  id: z.string().regex(UUID_V4_REGEX).optional(),
  codigo: z
    .string()
    .transform((v) => normalizarCodigoMaestro(v))
    .refine((v) => v.length >= 2 && v.length <= 40, {
      message: 'El código de zona debe tener entre 2 y 40 caracteres.',
    }),
  nombre: z
    .string()
    .transform((v) => limpiarCeldaTexto(v))
    .refine((v) => v.length >= 2 && v.length <= 160, {
      message: 'El nombre de la zona es obligatorio (2-160 caracteres).',
    }),
  ciudad: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  estado: z
    .string()
    .nullable()
    .optional()
    .transform((v) => limpiarCeldaTexto(v) || null),
  sucursal: SucursalMaestroCrudSchema,
  region_id: z.string().regex(UUID_V4_REGEX).nullable().optional(),
  activo: z.boolean().optional().default(true),
});

export const ClienteCrudSchema = ClienteSincronizacionSchema.extend({
  id: z.string().regex(UUID_V4_REGEX).optional(),
  vendedor_id: z.string().regex(UUID_V4_REGEX).nullable().optional(),
  cadena_id: z.string().regex(UUID_V4_REGEX).nullable().optional(),
  zona_id: z.string().regex(UUID_V4_REGEX).nullable().optional(),
  region_id: z.string().regex(UUID_V4_REGEX).nullable().optional(),
  radio_geocerca_m: z.coerce
    .number()
    .int()
    .min(25, 'El radio de geocerca mínimo es 25 m.')
    .max(5000, 'El radio de geocerca máximo es 5000 m.')
    .optional()
    .default(150),
  sucursal: SucursalMaestroCrudSchema,
  activo: z.boolean().optional().default(true),
});

export const VendedorCrudSchema = VendedorSincronizacionSchema.extend({
  id: z.string().regex(UUID_V4_REGEX).optional(),
  sucursal: SucursalMaestroCrudSchema,
  region_id: z.string().regex(UUID_V4_REGEX).nullable().optional(),
  activo: z.boolean().optional().default(true),
});

export interface FiltrosCatalogoSimple {
  soloActivos?: boolean;
  region?: AllowedRegionCode;
  busqueda?: string;
  forzarRefresco?: boolean;
}

export async function obtenerCadenasComerciales(
  filtros: FiltrosCatalogoSimple = {},
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<CadenaComercial[]> {
  const soloActivos = filtros.soloActivos !== false;
  const effectiveSucursal = getActiveClientSucursalHeader() ?? null;
  const claveCache = buildScopedMasterCacheKey(
    {
      soloActivos,
      region: filtros.region || '',
      busqueda: filtros.busqueda?.trim().toUpperCase() || '',
    },
    filtros.region ?? null
  );
  if (!filtros.forzarRefresco) {
    const cached = cacheCadenas.get(claveCache);
    if (cached !== undefined) return cached;
  }

  const client = supabaseClient ?? getMasterDataSupabaseClient();

  if (!supabaseClient) {
    const params = new URLSearchParams();
    if (!soloActivos) params.set('soloActivos', 'false');
    if (filtros.region) params.set('region', filtros.region);
    if (filtros.busqueda?.trim()) params.set('busqueda', filtros.busqueda.trim());
    if (filtros.forzarRefresco) params.set('forzarRefresco', '1');
    const fromApi = await fetchMasterEntityFromBackendApi<CadenaComercial>(
      '/api/maestros/cadenas',
      params,
      client,
      filtros.region ? null : effectiveSucursal
    );
    if (fromApi !== null) {
      cacheCadenas.set(claveCache, fromApi);
      return fromApi;
    }
  }

  const acumulado: CadenaComercial[] = [];
  let missingLowercaseTable = false;
  for (let desde = 0; ; desde += POSTGREST_READ_PAGE_SIZE) {
    let query = client
      .from('cadenas_comerciales')
      .select('*')
      .order('nombre', { ascending: true })
      .range(desde, desde + POSTGREST_READ_PAGE_SIZE - 1);

    if (soloActivos) query = query.eq('activo', true);
    if (filtros.busqueda?.trim()) {
      const orFilter = construirFiltroOrBusquedaGenerica(filtros.busqueda, ['codigo', 'nombre']);
      if (orFilter) query = query.or(orFilter);
    }

    const { data, error } = await query;
    if (error) {
      if (desde === 0 && isMissingRelationPostgrestError(error)) {
        missingLowercaseTable = true;
        break;
      }
      throw new Error(`Error consultando cadenas comerciales: ${error.message}`);
    }
    const page = ((data ?? []) as unknown as Record<string, unknown>[]).map(normalizeReturnedCadenaRow);
    acumulado.push(...page);
    if (page.length < POSTGREST_READ_PAGE_SIZE) break;
  }

  if (missingLowercaseTable) {
    const [regiones, tipificaciones, canales, clientes] = await Promise.all([
      fetchErpTablePagesDirect<ErpRegionRow>(client, 'Regiones', 'id_regi,created_at,regi_desd,regi_saba', false),
      fetchErpTablePagesDirect<ErpTipificacionRow>(client, 'Tipificacion_Clientes', 'id_tipi,created_at,tipi_desc,id_cave', true),
      fetchErpTablePagesDirect<ErpCanalComercializacionRow>(client, 'Canal_Comercializacion', 'id_cana,created_at,cana_desc', true),
      fetchErpTablePagesDirect<ErpClienteRow>(client, 'Clientes', 'id_clie,clie_nomb,id_clie_prin,id_tipi,clie_regi,clie_acti', false),
    ]);
    let rows = normalizeErpCadenasDataset({
      regiones,
      tipificaciones,
      canalesComercializacion: canales,
      clientes,
    });
    if (soloActivos) rows = rows.filter((c) => c.activo);
    cacheCadenas.set(claveCache, rows);
    return rows;
  }

  cacheCadenas.set(claveCache, acumulado);
  return acumulado;
}

export async function guardarCadenaComercial(
  input: CadenaComercialInput,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<CadenaComercial> {
  const parsed = CadenaComercialCrudSchema.parse(input);
  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const payload = {
    codigo: parsed.codigo,
    nombre: parsed.nombre,
    tipo_canal: parsed.tipo_canal,
    activo: parsed.activo,
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
    ...(parsed.region_id ? { region_id: parsed.region_id } : {}),
  };

  const res = parsed.id
    ? await client
        .from('cadenas_comerciales')
        .update(payload)
        .eq('id', parsed.id)
        .select('*')
        .single()
    : await client.from('cadenas_comerciales').insert(payload).select('*').single();

  if (res.error || !res.data) {
    throw new Error(res.error?.message || 'No se pudo guardar la cadena comercial.');
  }
  invalidarCacheMaestros();
  return res.data as unknown as CadenaComercial;
}

export async function cambiarEstadoCadenaComercial(
  id: string,
  activo: boolean,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<CadenaComercial> {
  if (!UUID_V4_REGEX.test(id)) throw new Error('Identificador de cadena inválido.');
  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const { data, error } = await client
    .from('cadenas_comerciales')
    .update({ activo })
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar el estado de la cadena comercial.');
  }
  invalidarCacheMaestros();
  return data as unknown as CadenaComercial;
}

export async function obtenerZonasComerciales(
  filtros: FiltrosCatalogoSimple = {},
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<ZonaComercial[]> {
  const soloActivos = filtros.soloActivos !== false;
  const effectiveSucursal = getActiveClientSucursalHeader() ?? null;
  const claveCache = buildScopedMasterCacheKey(
    {
      soloActivos,
      region: filtros.region || '',
      busqueda: filtros.busqueda?.trim().toUpperCase() || '',
    },
    filtros.region ?? null
  );
  if (!filtros.forzarRefresco) {
    const cached = cacheZonas.get(claveCache);
    if (cached !== undefined) return cached;
  }

  const client = supabaseClient ?? getMasterDataSupabaseClient();

  if (!supabaseClient) {
    const params = new URLSearchParams();
    if (!soloActivos) params.set('soloActivos', 'false');
    if (filtros.region) params.set('region', filtros.region);
    if (filtros.busqueda?.trim()) params.set('busqueda', filtros.busqueda.trim());
    if (filtros.forzarRefresco) params.set('forzarRefresco', '1');
    const fromApi = await fetchMasterEntityFromBackendApi<ZonaComercial>(
      '/api/maestros/zonas',
      params,
      client,
      filtros.region ? null : effectiveSucursal
    );
    if (fromApi !== null) {
      cacheZonas.set(claveCache, fromApi);
      return fromApi;
    }
  }

  const acumulado: ZonaComercial[] = [];
  let missingLowercaseTable = false;
  for (let desde = 0; ; desde += POSTGREST_READ_PAGE_SIZE) {
    let query = client
      .from('zonas')
      .select('*')
      .order('nombre', { ascending: true })
      .range(desde, desde + POSTGREST_READ_PAGE_SIZE - 1);

    if (soloActivos) query = query.eq('activo', true);
    if (filtros.busqueda?.trim()) {
      const orFilter = construirFiltroOrBusquedaGenerica(filtros.busqueda, [
        'codigo',
        'nombre',
        'ciudad',
      ]);
      if (orFilter) query = query.or(orFilter);
    }

    const { data, error } = await query;
    if (error) {
      if (desde === 0 && isMissingRelationPostgrestError(error)) {
        missingLowercaseTable = true;
        break;
      }
      throw new Error(`Error consultando zonas: ${error.message}`);
    }
    const page = ((data ?? []) as unknown as Record<string, unknown>[]).map(normalizeReturnedZonaRow);
    acumulado.push(...page);
    if (page.length < POSTGREST_READ_PAGE_SIZE) break;
  }

  if (missingLowercaseTable) {
    const [regiones, sucursales, estados, municipios, clientes] = await Promise.all([
      fetchErpTablePagesDirect<ErpRegionRow>(client, 'Regiones', 'id_regi,created_at,regi_desd,regi_saba', false),
      fetchErpTablePagesDirect<ErpSucursalRow>(client, 'Sucursales', 'id_sucu,created_at,sucu_desc,id_regi', true),
      fetchErpTablePagesDirect<ErpEstadoRow>(client, 'Estados', 'id_esta,created_at,esta_desc,id_regi', true),
      fetchErpTablePagesDirect<ErpMunicipioRow>(client, 'Municipios', 'id_muni,created_at,muni_desc,id_esta,id_regi', true),
      fetchErpTablePagesDirect<ErpClienteRow>(client, 'Clientes', 'id_clie,id_esta,id_muni,clie_regi,clie_acti', false),
    ]);
    let rows = normalizeErpZonasDataset({
      regiones,
      sucursales,
      estados,
      municipios,
      clientes,
    });
    if (soloActivos) rows = rows.filter((z) => z.activo);
    cacheZonas.set(claveCache, rows);
    return rows;
  }

  cacheZonas.set(claveCache, acumulado);
  return acumulado;
}

export async function guardarZonaComercial(
  input: ZonaComercialInput,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<ZonaComercial> {
  const parsed = ZonaComercialCrudSchema.parse(input);
  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const payload = {
    codigo: parsed.codigo,
    nombre: parsed.nombre,
    ciudad: parsed.ciudad,
    estado: parsed.estado,
    activo: parsed.activo,
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
    ...(parsed.region_id ? { region_id: parsed.region_id } : {}),
  };

  const res = parsed.id
    ? await client.from('zonas').update(payload).eq('id', parsed.id).select('*').single()
    : await client.from('zonas').insert(payload).select('*').single();

  if (res.error || !res.data) {
    throw new Error(res.error?.message || 'No se pudo guardar la zona comercial.');
  }
  invalidarCacheMaestros();
  return res.data as unknown as ZonaComercial;
}

export async function cambiarEstadoZonaComercial(
  id: string,
  activo: boolean,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<ZonaComercial> {
  if (!UUID_V4_REGEX.test(id)) throw new Error('Identificador de zona inválido.');
  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const { data, error } = await client
    .from('zonas')
    .update({ activo })
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar el estado de la zona.');
  }
  invalidarCacheMaestros();
  return data as unknown as ZonaComercial;
}

export async function guardarClienteMaestro(
  input: ClienteCrudInput,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<Cliente> {
  const parsed = ClienteCrudSchema.parse({
    ...input,
    latitud: input.latitud ?? null,
    longitud: input.longitud ?? null,
  });
  const client = supabaseClient ?? getMasterDataSupabaseClient();

  const payload = {
    codigo_cliente: parsed.codigo_cliente,
    rif: parsed.rif ?? null,
    razon_social: parsed.razon_social,
    nombre_comercial: parsed.nombre_comercial ?? null,
    canal: parsed.canal ?? null,
    segmento: parsed.segmento ?? null,
    zona: parsed.zona ?? null,
    ruta: parsed.ruta ?? null,
    direccion: parsed.direccion ?? null,
    ciudad: parsed.ciudad ?? null,
    estado: parsed.estado ?? null,
    telefono: parsed.telefono ?? null,
    latitud: parsed.latitud ?? null,
    longitud: parsed.longitud ?? null,
    cadena_id: parsed.cadena_id ?? null,
    zona_id: parsed.zona_id ?? null,
    radio_geocerca_m: parsed.radio_geocerca_m,
    vendedor_id: parsed.vendedor_id ?? null,
    codigo_vendedor: parsed.codigo_vendedor ?? null,
    activo: parsed.activo,
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
    ...(parsed.region_id ? { region_id: parsed.region_id } : {}),
  };

  const res = parsed.id
    ? await client.from('clientes').update(payload).eq('id', parsed.id).select('*').single()
    : await client.from('clientes').insert(payload).select('*').single();

  if (res.error || !res.data) {
    throw new Error(res.error?.message || 'No se pudo guardar el cliente / PDV.');
  }
  invalidarCacheMaestros();
  return res.data as unknown as Cliente;
}

export async function cambiarEstadoClienteMaestro(
  id: string,
  activo: boolean,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<Cliente> {
  if (!UUID_V4_REGEX.test(id)) throw new Error('Identificador de cliente inválido.');
  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const { data, error } = await client
    .from('clientes')
    .update({ activo })
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar el estado del cliente.');
  }
  invalidarCacheMaestros();
  return data as unknown as Cliente;
}

export async function guardarVendedorMaestro(
  input: VendedorCrudInput,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<Vendedor> {
  const parsed = VendedorCrudSchema.parse(input);
  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const payload = {
    codigo_vendedor: parsed.codigo_vendedor,
    nombre_completo: parsed.nombre_completo,
    documento_identidad: parsed.documento_identidad ?? null,
    telefono: parsed.telefono ?? null,
    email: parsed.email ?? null,
    zona: parsed.zona ?? null,
    supervisor: parsed.supervisor ?? null,
    activo: parsed.activo,
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
    ...(parsed.region_id ? { region_id: parsed.region_id } : {}),
  };

  const res = parsed.id
    ? await client.from('vendedores').update(payload).eq('id', parsed.id).select('*').single()
    : await client.from('vendedores').insert(payload).select('*').single();

  if (res.error || !res.data) {
    throw new Error(res.error?.message || 'No se pudo guardar el vendedor.');
  }
  invalidarCacheMaestros();
  return res.data as unknown as Vendedor;
}

export async function cambiarEstadoVendedorMaestro(
  id: string,
  activo: boolean,
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<Vendedor> {
  if (!UUID_V4_REGEX.test(id)) throw new Error('Identificador de vendedor inválido.');
  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const { data, error } = await client
    .from('vendedores')
    .update({ activo })
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar el estado del vendedor.');
  }
  invalidarCacheMaestros();
  return data as unknown as Vendedor;
}

/**
 * Adaptador directo desde `ClienteConVendedor` hacia el tipo `Store` usado en vistas operativas.
 */
export function mapearClienteMaestroAStore(
  cliente: Cliente | ClienteConVendedor,
  extras?: { cadenaNombre?: string; zonaNombre?: string }
): Store {
  const conVend = cliente as ClienteConVendedor;
  const canalNormalizado = (() => {
    const c = (cliente.canal ?? '').trim().toLowerCase();
    if (c.includes('super')) return 'Supermercado';
    if (c.includes('mayor')) return 'Mayorista';
    if (c.includes('farma')) return 'Farmacia';
    if (c.includes('mini')) return 'Minimarket';
    return '';
  })();

  const radioConfigurado =
    typeof cliente.radio_geocerca_m === 'number' &&
    Number.isFinite(cliente.radio_geocerca_m) &&
    cliente.radio_geocerca_m >= 25
      ? Math.round(cliente.radio_geocerca_m)
      : 150;

  return {
    id: cliente.id,
    name: cliente.nombre_comercial || cliente.razon_social,
    clientCode: cliente.codigo_cliente,
    address: cliente.direccion || '',
    zone: extras?.zonaNombre || cliente.zona || conVend.vendedor?.zona || '',
    city: cliente.ciudad || '',
    latitude: cliente.latitud,
    longitude: cliente.longitud,
    geofenceRadiusMeters:
      cliente.latitud !== null && cliente.longitud !== null ? radioConfigurado : 0,
    sellerName: conVend.vendedor?.nombre_completo || cliente.codigo_vendedor || '',
    channel: canalNormalizado,
    cadenaId: cliente.cadena_id ?? null,
    cadenaName: extras?.cadenaNombre || conVend.cadena?.nombre,
    zonaId: cliente.zona_id ?? null,
    sucursal:
      normalizarSucursalMaestro(cliente.sucursal) ??
      inferirSucursalDesdeTerritorio(cliente) ??
      null,
  };
}

// =============================================================================
// 6. SINCRONIZACIÓN REGIONAL IDEMPOTENTE POR PERFILES (SOLO 3 REGIONES REALES:
//    "Regiones" -> OCCIDENTE [P1, regi_saba=TRUE], CENTRO [P2], ANDES [P3])
// =============================================================================

const GLOBAL_REGIONAL_ADMIN_ROLES = new Set([
  'super_admin',
  'superadmin',
  'admin',
  'gerencia',
  'gerente_admin',
]);

export class RegionalAuthorizationError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'FORBIDDEN_REGION_ACCESS';

  constructor(message: string) {
    super(message);
    this.name = 'RegionalAuthorizationError';
  }
}

export function isGlobalRegionalSyncRole(actor: RegionalActorProfile): boolean {
  if (actor.isGlobalAdmin) return true;
  const cleanRole = String(actor.role ?? '').trim().toLowerCase();
  return GLOBAL_REGIONAL_ADMIN_ROLES.has(cleanRole);
}

/**
 * Valida la autorización del perfil regional antes de cualquier lectura o sincronización:
 *  - Perfiles con rol administrador/gerencia global pueden consultar/sincronizar una o varias
 *    regiones del catálogo oficial (`OCCIDENTE`, `CENTRO`, `ANDES`) siempre ordenadas por prioridad.
 *  - Perfiles restringidos a una región SOLO pueden operar sobre su `assignedRegion` asignada.
 */
export function assertRegionalProfileAccess(
  actor: RegionalActorProfile,
  requestedRegions?: readonly AllowedRegionCode[]
): AllowedRegionCode[] {
  const isGlobal = isGlobalRegionalSyncRole(actor);
  const cleanRequested = (requestedRegions ?? []).filter((r): r is AllowedRegionCode =>
    isAllowedRegionCode(r)
  );

  if (!isGlobal) {
    const assigned = normalizeAllowedRegionStrict(actor.assignedRegion);
    if (!assigned) {
      throw new RegionalAuthorizationError(
        'Perfil regional sin región oficial asignada (OCCIDENTE, CENTRO o ANDES). Acceso denegado.'
      );
    }

    if (cleanRequested.length === 0) {
      return [assigned];
    }

    const unauthorized = cleanRequested.filter((r) => r !== assigned);
    if (unauthorized.length > 0 || new Set(cleanRequested).size > 1) {
      throw new RegionalAuthorizationError(
        `Acceso denegado: el perfil regional de ${assigned} no tiene autorización para operar sobre ${unauthorized.join(', ')}.`
      );
    }

    return [assigned];
  }

  if (cleanRequested.length === 0) {
    return [...REGIONAL_SYNC_PRIORITY_QUEUE];
  }

  return sortAllowedRegionsByPriority(cleanRequested);
}

/**
 * Resuelve dinámicamente el catálogo oficial `regi_desd -> id_regi` (y flag `regi_saba`)
 * desde la tabla `"Regiones"` en Supabase sin hardcodear UUIDs.
 * Almacena el resultado en caché LRU acotada con TTL.
 */
export async function obtenerCatalogoRegionesOficiales(
  supabaseClient?: SupabaseClient<MasterDataDatabase>,
  options: { forzarRefresco?: boolean; cacheScopeKey?: string } = {}
): Promise<Map<AllowedRegionCode, SupabaseRegionCatalogRow>> {
  const cacheKey = options.cacheScopeKey || 'SUPABASE_REGIONES_OFICIALES';
  if (!options.forzarRefresco) {
    const cached = cacheRegionesOficiales.get(cacheKey);
    if (cached !== undefined) {
      return new Map(cached);
    }
  }

  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const { data, error } = await client
    .from('Regiones')
    .select('id_regi, created_at, regi_desd, regi_saba');

  if (error) {
    throw new Error(`No se pudo resolver la tabla "Regiones" en Supabase: ${error.message}`);
  }

  const resolvedEntries: SupabaseRegionCatalogRow[] = [];
  for (const rawRow of (data ?? []) as Array<Record<string, unknown>>) {
    const code = normalizeAllowedRegionStrict(rawRow.regi_desd);
    const idRegi = String(rawRow.id_regi ?? '').trim();
    if (!code || !idRegi) continue;
    resolvedEntries.push({
      id_regi: idRegi,
      created_at: String(rawRow.created_at ?? ''),
      regi_desd: code,
      regi_saba: Boolean(rawRow.regi_saba),
      priority: REGIONAL_PRIORITY_RANK[code],
    });
  }

  resolvedEntries.sort((a, b) => a.priority - b.priority);

  const catalogMap = new Map<AllowedRegionCode, SupabaseRegionCatalogRow>();
  for (const entry of resolvedEntries) {
    if (!catalogMap.has(entry.regi_desd)) {
      catalogMap.set(entry.regi_desd, entry);
    }
  }

  cacheRegionesOficiales.set(cacheKey, catalogMap);
  return new Map(catalogMap);
}

/**
 * Sincroniza de forma idempotente (por lotes con `upsert`) los clientes por perfil regional
 * respetando exclusivamente las 3 regiones reales de `"Regiones"` en orden estricto de prioridad:
 *   1. `OCCIDENTE` (`regi_saba = TRUE`)
 *   2. `CENTRO` (`regi_saba = FALSE`)
 *   3. `ANDES` (`regi_saba = FALSE`)
 *
 * - Controla errores parciales por lote sin abortar el resto de lotes/regiones.
 * - Valida autorización por perfil regional antes de escribir en Supabase.
 * - Invalida selectivamente la caché de cada región al concluir su sincronización.
 */
export async function sincronizarClientesPorPerfilRegional(
  params: {
    actorProfile: RegionalActorProfile;
    clientesPorRegion: Partial<Record<string, ClienteSincronizacionInput[]>>;
    regionesObjetivo?: string[];
    batchSize?: number;
    forzarRefrescoCatalogo?: boolean;
    onRegionStart?: (region: AllowedRegionCode, meta: SupabaseRegionCatalogRow) => void;
  },
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<RegionalClientSyncReport> {
  const startedAllMs = Date.now();
  const regionesOmitidasNoPermitidas: string[] = [];
  const validRegionsSet = new Set<AllowedRegionCode>();

  const candidateKeys =
    params.regionesObjetivo && params.regionesObjetivo.length > 0
      ? params.regionesObjetivo
      : Object.keys(params.clientesPorRegion);

  for (const rawRegionKey of candidateKeys) {
    const strictCode = normalizeAllowedRegionStrict(rawRegionKey);
    if (!strictCode) {
      regionesOmitidasNoPermitidas.push(rawRegionKey);
      continue;
    }
    validRegionsSet.add(strictCode);
  }

  // También registrar claves inválidas presentes en `clientesPorRegion` si se filtró por `regionesObjetivo`
  for (const rawKey of Object.keys(params.clientesPorRegion)) {
    if (!normalizeAllowedRegionStrict(rawKey) && !regionesOmitidasNoPermitidas.includes(rawKey)) {
      regionesOmitidasNoPermitidas.push(rawKey);
    }
  }

  // Autorización estricta por perfil y ordenamiento de prioridad `OCCIDENTE -> CENTRO -> ANDES`
  const orderedAuthorizedRegions = assertRegionalProfileAccess(
    params.actorProfile,
    Array.from(validRegionsSet)
  );

  const client = supabaseClient ?? getMasterDataSupabaseClient();
  const catalogoRegiones = await obtenerCatalogoRegionesOficiales(client, {
    forzarRefresco: params.forzarRefrescoCatalogo,
  });

  const effectiveBatchSize =
    params.batchSize && Number.isFinite(params.batchSize) && params.batchSize >= 1
      ? Math.min(1000, Math.trunc(params.batchSize))
      : resolveMasterDataSyncBatchSize();

  const resumenPorRegion: RegionalClientSyncSummary[] = [];

  for (const regionCode of orderedAuthorizedRegions) {
    const regionStartMs = Date.now();
    const regionMeta = catalogoRegiones.get(regionCode);

    // Extraer lista de clientes de la región (soportando claves con distinta capitalización)
    const rawList: ClienteSincronizacionInput[] = [];
    for (const [k, list] of Object.entries(params.clientesPorRegion)) {
      if (normalizeAllowedRegionStrict(k) === regionCode && Array.isArray(list)) {
        rawList.push(...list);
      }
    }

    if (!regionMeta) {
      resumenPorRegion.push({
        region: regionCode,
        regionId: '',
        priority: REGIONAL_PRIORITY_RANK[regionCode],
        regiSaba: regionCode === 'OCCIDENTE',
        procesados: 0,
        insertadosOActualizados: 0,
        omitidos: rawList.length,
        errores: [
          {
            lote: 0,
            motivo: `La región ${regionCode} no existe en la tabla "Regiones" de Supabase.`,
          },
        ],
        duracionMs: Date.now() - regionStartMs,
        lotesEjecutados: 0,
      });
      continue;
    }

    params.onRegionStart?.(regionCode, regionMeta);

    // Deduplicación idempotente por `codigo_cliente` normalizado dentro de la región
    const dedupMap = new Map<string, Record<string, unknown>>();
    let omitidos = 0;
    const syncIso = new Date().toISOString();
    const legacySucursal = mapAllowedRegionToLegacySucursal(regionCode);

    for (const item of rawList) {
      const codigo = normalizarCodigoMaestro(item.codigo_cliente);
      const razon = limpiarCeldaTexto(item.razon_social);
      if (!codigo || !razon) {
        omitidos += 1;
        continue;
      }

      if (dedupMap.has(codigo)) {
        omitidos += 1;
      }

      dedupMap.set(codigo, {
        codigo_cliente: codigo,
        rif: normalizarRifFiscal(item.rif),
        razon_social: razon,
        nombre_comercial: limpiarCeldaTexto(item.nombre_comercial) || null,
        canal: limpiarCeldaTexto(item.canal) || null,
        segmento: limpiarCeldaTexto(item.segmento) || null,
        zona: limpiarCeldaTexto(item.zona) || null,
        ruta: limpiarCeldaTexto(item.ruta) || null,
        direccion: limpiarCeldaTexto(item.direccion) || null,
        ciudad: limpiarCeldaTexto(item.ciudad) || null,
        estado: limpiarCeldaTexto(item.estado) || null,
        telefono: normalizarTelefonoMaestro(item.telefono),
        latitud: normalizarCoordenada(item.latitud, -90, 90),
        longitud: normalizarCoordenada(item.longitud, -180, 180),
        codigo_vendedor: item.codigo_vendedor
          ? normalizarCodigoMaestro(item.codigo_vendedor)
          : null,
        region_id: regionMeta.id_regi,
        ...(legacySucursal ? { sucursal: legacySucursal } : {}),
        activo: true,
        ultima_sincronizacion: syncIso,
        metadata: {
          ...(item.metadata ?? {}),
          regi_desd: regionMeta.regi_desd,
          regi_saba: regionMeta.regi_saba,
        } as unknown as Json,
      });
    }

    const dedupRecords = Array.from(dedupMap.values());
    const lotes = dividirEnLotes(dedupRecords, effectiveBatchSize);
    const errores: RegionalSyncBatchError[] = [];
    let insertadosOActualizados = 0;

    for (let i = 0; i < lotes.length; i++) {
      const lote = lotes[i]!;
      try {
        const { error } = await client
          .from('clientes')
          .upsert(lote as unknown as MasterDataDatabase['public']['Tables']['clientes']['Insert'][], {
            onConflict: 'codigo_cliente',
          });

        if (error) {
          errores.push({
            lote: i + 1,
            motivo: error.message,
            codigosAfectados: lote.map((r) => String(r.codigo_cliente ?? '')),
          });
        } else {
          insertadosOActualizados += lote.length;
        }
      } catch (err) {
        errores.push({
          lote: i + 1,
          motivo: err instanceof Error ? err.message : String(err),
          codigosAfectados: lote.map((r) => String(r.codigo_cliente ?? '')),
        });
      }
    }

    // Invalidación dirigida de caché para esta región al finalizar su sincronización
    invalidarCacheMaestros(regionCode);

    resumenPorRegion.push({
      region: regionCode,
      regionId: regionMeta.id_regi,
      priority: regionMeta.priority,
      regiSaba: regionMeta.regi_saba,
      procesados: dedupRecords.length,
      insertadosOActualizados,
      omitidos,
      errores,
      duracionMs: Date.now() - regionStartMs,
      lotesEjecutados: lotes.length,
    });
  }

  return {
    ordenPrioridadEjecutado: orderedAuthorizedRegions,
    regionesOmitidasNoPermitidas,
    resumenPorRegion,
    totales: {
      procesados: resumenPorRegion.reduce((acc, r) => acc + r.procesados, 0),
      insertadosOActualizados: resumenPorRegion.reduce(
        (acc, r) => acc + r.insertadosOActualizados,
        0
      ),
      omitidos: resumenPorRegion.reduce((acc, r) => acc + r.omitidos, 0),
      errores: resumenPorRegion.reduce((acc, r) => acc + r.errores.length, 0),
      duracionMs: Date.now() - startedAllMs,
    },
  };
}

/**
 * Consulta clientes aplicando estrictamente la autorización por perfil regional,
 * resolviendo `id_regi` dinámicamente desde `"Regiones"` y reutilizando la caché LRU
 * acotada + búsqueda segura de razones sociales `", C.A."`.
 */
export async function obtenerClientesPorPerfilRegional(
  actorProfile: RegionalActorProfile,
  filtros: FiltrosConsultaClientes = {},
  supabaseClient?: SupabaseClient<MasterDataDatabase>
): Promise<ClienteConVendedor[]> {
  const requestedList = filtros.region ? [filtros.region] : [];
  const allowed = assertRegionalProfileAccess(actorProfile, requestedList);
  const client = supabaseClient ?? getMasterDataSupabaseClient();

  if (allowed.length === 1) {
    const targetRegion = allowed[0]!;
    const catalog = await obtenerCatalogoRegionesOficiales(client);
    const meta = catalog.get(targetRegion);
    if (!meta) {
      throw new Error(`No se encontró la región ${targetRegion} en la tabla "Regiones".`);
    }
    return obtenerClientesMaestros(
      {
        ...filtros,
        region: targetRegion,
        regionId: meta.id_regi,
      },
      client
    );
  }

  // Perfil administrador global solicitando todas las regiones en orden de prioridad
  const catalog = await obtenerCatalogoRegionesOficiales(client);
  const combined: ClienteConVendedor[] = [];
  const seenIds = new Set<string>();

  for (const regionCode of allowed) {
    const meta = catalog.get(regionCode);
    if (!meta) continue;
    const rows = await obtenerClientesMaestros(
      {
        ...filtros,
        region: regionCode,
        regionId: meta.id_regi,
      },
      client
    );
    for (const row of rows) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        combined.push(row);
      }
    }
  }
  return combined;
}
