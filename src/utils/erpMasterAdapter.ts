import type {
  AllowedRegionCode,
  CadenaComercial,
  CanalClienteMaestro,
  ClienteConVendedor,
  FiltrosConsultaClientes,
  FiltrosConsultaVendedores,
  ProductoMaestro,
  PromotoraMaestra,
  RegionMaestra,
  SucursalMaestro,
  SupervisorMaestro,
  Vendedor,
  ZonaComercial,
} from '../types/masterData';
import {
  ALLOWED_REGIONS,
  REGIONAL_PRIORITY_RANK,
  classifyPromotoraCategoriaOficial,
  formatPromotoraRoleForCategory,
  normalizeRegionName,
} from './regionalSyncClassifier';

export interface ErpRegionRow {
  id_regi: string;
  created_at?: string | null;
  regi_desd: string;
  regi_saba?: boolean | null;
}

export interface ErpSucursalRow {
  id_sucu: string;
  created_at?: string | null;
  sucu_desc: string;
  id_regi?: string | null;
}

export interface ErpEstadoRow {
  id_esta: string;
  created_at?: string | null;
  esta_desc: string;
  id_regi?: string | null;
}

export interface ErpMunicipioRow {
  id_muni: string;
  created_at?: string | null;
  muni_desc: string;
  id_esta?: string | null;
  id_regi?: string | null;
}

export interface ErpSupervisorRow {
  id_supe: string;
  created_at?: string | null;
  supe_nomb: string;
  supe_acti?: boolean | null;
  id_regi?: string | null;
  supe_cont?: string | null;
}

export interface ErpVendedorRow {
  id_vend: string;
  created_at?: string | null;
  vend_codi?: string | null;
  vend_nomb: string;
  vend_acti?: boolean | null;
  id_sucu?: string | null;
  id_supe?: string | null;
  vend_cont?: string | null;
}

export interface ErpTipificacionRow {
  id_tipi: string;
  created_at?: string | null;
  tipi_desc: string;
  id_cave?: string | null;
}

export interface ErpCanalComercializacionRow {
  id_cana: string;
  created_at?: string | null;
  cana_desc: string;
}

export interface ErpProductoRow {
  id_prod: string;
  created_at?: string | null;
  prod_codi?: string | null;
  prod_desc?: string | null;
  prod_unid?: string | null;
  prod_acti?: boolean | null;
}

export interface ErpVwProductoDetalleRow {
  id_prod: string;
  codigo?: string | null;
  producto?: string | null;
  orden?: number | null;
  activo?: boolean | null;
  marca?: string | null;
  marca_propia?: boolean | null;
  familia?: string | null;
  grupo?: string | null;
  regiones?: string | null;
  n_regiones?: number | null;
  created_at?: string | null;
}

export interface ErpPromotoraRow {
  id: string | number;
  nombre_completo?: string | null;
  nombre?: string | null;
  direccion?: string | null;
  telefono?: string | null;
  correo?: string | null;
  email?: string | null;
  region?: string | null;
  auth_user_id?: string | null;
  ciudad?: string | null;
  estado?: string | null;
  sucursal?: string | null;
  region_id?: string | null;
  supervisor_id?: string | null;
  categoria?: string | null;
  activo?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ErpForecastExcludedVendedoresRow {
  id_fove?: string;
  id_regi?: string | null;
  fove_vend?: string[] | null;
  updated_at?: string | null;
}

export interface ErpClienteRow {
  id_clie: string;
  created_at?: string | null;
  clie_rif?: string | null;
  clie_nomb: string;
  id_esta?: string | null;
  id_vend?: string | null;
  id_muni?: string | null;
  clie_regi?: string | null;
  clie_acti?: boolean | null;
  clie_lati?: number | string | null;
  clie_long?: number | string | null;
  id_tipi?: string | null;
  id_clie_prin?: string | null;
}

export interface ErpMasterDataset {
  regiones: ErpRegionRow[];
  sucursales: ErpSucursalRow[];
  estados: ErpEstadoRow[];
  municipios: ErpMunicipioRow[];
  supervisores: ErpSupervisorRow[];
  vendedores: ErpVendedorRow[];
  tipificaciones: ErpTipificacionRow[];
  clientes: ErpClienteRow[];
  vendedoresExcluidos?: ErpForecastExcludedVendedoresRow[];
  productos?: ErpProductoRow[];
  vwProductosDetalle?: ErpVwProductoDetalleRow[];
  promotoras?: ErpPromotoraRow[];
  canalesComercializacion?: ErpCanalComercializacionRow[];
}

export interface RegionEntitiesSummary {
  region: AllowedRegionCode;
  regionId: string | null;
  regiSaba: boolean;
  priority: 1 | 2 | 3;
  clientesTotal: number;
  clientesActivos: number;
  clientesConGps: number;
  promotoras: number;
  supervisores: number;
  vendedores: number;
  cadenas: number;
  zonas: number;
}

export type VendedorExclusionReason =
  | 'INACTIVO'
  | 'SIN_CODIGO'
  | 'CUENTA_ADMINISTRATIVA_O_VACANTE'
  | 'SIN_SUPERVISOR'
  | 'EXCLUIDO_FORECAST_ERP';

export interface VendedoresAuditSummary {
  totalErpRaw: number;
  activosRealesUnicos: number;
  rutasComercialesActivas: number;
  excluidosTotal: number;
  consolidadosDuplicados: number;
  excluidosPorMotivo: Record<VendedorExclusionReason, number>;
  porSede: Record<SucursalMaestro, number>;
}

export interface SedeClientCountSummary {
  sucursal: SucursalMaestro;
  total: number;
  activos: number;
  inactivos: number;
  vendedoresActivos?: number;
  zonas: string[];
}

const VENEZUELAN_RIF_REGEX = /^[JVEGPC]-?\d{6,10}$/i;

function normalizeToken(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFiniteCoord(raw: unknown, min: number, max: number): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(',', '.'));
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return Number(num.toFixed(7));
}

function extractCommercialAlias(razonSocial: string): string | null {
  const match = /\(([^()]{3,80})\)/.exec(razonSocial);
  if (!match?.[1]) return null;
  const candidate = cleanText(match[1]);
  if (!candidate || candidate.toUpperCase() === razonSocial.toUpperCase()) return null;
  return candidate;
}

/**
 * Mapea el territorio oficial del ERP Codizulca (`Sucursales.sucu_desc`, `Estados.esta_desc` y
 * `Regiones.regi_desd`) hacia las 5 sedes operativas de Trade Marketing:
 *   - `ZULIA`    (Hub Occidente: ZULIA, FALCON, TRUJILLO / región OCCIDENTE)
 *   - `VALENCIA` (Hub Carabobo: CARABOBO / VALENCIA)
 *   - `CAPITAL`  (Hub Capital: DISTRITO CAPITAL / MIRANDA / LA GUAIRA)
 *   - `CENTRO`   (Hub Centro: ARAGUA, GUARICO, COJEDES, LARA, YARACUY)
 *   - `ORIENTE`  (Hub Oriente: ANZOATEGUI, MONAGAS, SUCRE, BOLIVAR, NUEVA ESPARTA, DELTA AMACURO)
 */
export function mapErpTerritoryToOperativeSucursal(input: {
  sucursalDesc?: string | null;
  estadoDesc?: string | null;
  regionDesc?: string | null;
}): SucursalMaestro | null {
  const classifyToken = (token: string): SucursalMaestro | null => {
    if (!token) return null;

    if (
      token === 'CARABOBO' ||
      token === 'VALENCIA' ||
      /\b(CARABOBO|VALENCIA|NAGUANAGUA|SAN DIEGO|GUACARA|TOCUYITO|PUERTO CABELLO)\b/.test(token)
    ) {
      return 'VALENCIA';
    }

    if (
      token === 'DISTRITO CAPITAL' ||
      token === 'CAPITAL' ||
      token === 'CARACAS' ||
      /\b(DISTRITO CAPITAL|CARACAS|MIRANDA|LA GUAIRA|VARGAS|CHACAO|BARUTA)\b/.test(token)
    ) {
      return 'CAPITAL';
    }

    if (
      token === 'ARAGUA' ||
      token === 'GUARICO' ||
      token === 'COJEDES' ||
      token === 'LARA' ||
      token === 'YARACUY' ||
      /\b(ARAGUA|MARACAY|GUARICO|COJEDES|LARA|BARQUISIMETO|YARACUY)\b/.test(token)
    ) {
      return 'CENTRO';
    }

    if (
      token === 'ZULIA' ||
      token === 'FALCON' ||
      token === 'TRUJILLO' ||
      token === 'OCCIDENTE' ||
      token === 'ANDES' ||
      /\b(ZULIA|MARACAIBO|SAN FRANCISCO|CABIMAS|CIUDAD OJEDA|FALCON|CORO|PARAGUANA|PUNTO FIJO|TRUJILLO|VALERA|MERIDA|TACHIRA|BARINAS)\b/.test(
        token
      )
    ) {
      return 'ZULIA';
    }

    if (
      token === 'ORIENTE' ||
      /\b(ORIENTE|ANZOATEGUI|BARCELONA|PUERTO LA CRUZ|MONAGAS|MATURIN|SUCRE|CUMANA|BOLIVAR|PUERTO ORDAZ|NUEVA ESPARTA|MARGARITA|DELTA AMACURO)\b/.test(
        token
      )
    ) {
      return 'ORIENTE';
    }

    if (token === 'CENTRO') {
      return 'CENTRO';
    }

    return null;
  };

  // 1. Prioridad: Sucursal oficial del vendedor en el ERP (`Sucursales.sucu_desc`)
  const bySucu = classifyToken(normalizeToken(input.sucursalDesc));
  if (bySucu) return bySucu;

  // 2. Respaldo: Estado del cliente (`Estados.esta_desc`)
  const byEsta = classifyToken(normalizeToken(input.estadoDesc));
  if (byEsta) return byEsta;

  // 3. Respaldo final: Región (`Regiones.regi_desd`)
  return classifyToken(normalizeToken(input.regionDesc));
}

export function normalizeErpRegionCode(raw: unknown): AllowedRegionCode | null {
  const token = normalizeToken(raw);
  if (token === 'OCCIDENTE' || token === 'CENTRO' || token === 'ANDES') {
    return token;
  }
  return null;
}

export function normalizeErpTipificacionToCanal(
  rawTipi: string | null | undefined
): CanalClienteMaestro | null {
  const clean = cleanText(rawTipi);
  if (!clean) return null;
  const upper = normalizeToken(clean);
  if (upper.includes('SUPERMERCADO') || upper.includes('CADENAS NACIONALES') || upper.includes('CADENAS REGIONALES')) {
    return 'Supermercado';
  }
  if (upper.includes('MINIMARKET') || upper.includes('MINI MARKET')) {
    return 'Minimarket';
  }
  if (upper.includes('FARMACIA')) {
    return 'Farmacia';
  }
  if (upper.includes('MAYORISTA')) {
    return 'Mayorista';
  }
  return clean;
}

const NON_SELLER_ACCOUNT_REGEX =
  /\b(OFICINA|VACANTE|GERENCIA|EMPLEADOS?|DUPLICADO|ZONA BAJA)\b/i;

const FOOD_SERVICE_ROUTE_REGEX = /\bFOOD SERVICE\b/i;

/**
 * Extrae el conjunto más reciente de UUIDs excluidos por región desde `Forecast_Vendedores_Excluidos`.
 */
export function extractExcludedErpVendorIds(
  rows?: readonly ErpForecastExcludedVendedoresRow[]
): Set<string> {
  const excluded = new Set<string>();
  if (!rows || rows.length === 0) return excluded;

  // Tomar la configuración más reciente por región (`id_regi`)
  const latestByRegion = new Map<string, ErpForecastExcludedVendedoresRow>();
  for (const row of rows) {
    const regionKey = String(row.id_regi ?? 'GLOBAL');
    const prev = latestByRegion.get(regionKey);
    const prevTs = prev?.updated_at ? Date.parse(prev.updated_at) : 0;
    const currTs = row.updated_at ? Date.parse(row.updated_at) : 0;
    if (!prev || currTs >= prevTs) {
      latestByRegion.set(regionKey, row);
    }
  }

  for (const row of latestByRegion.values()) {
    const ids = Array.isArray(row.fove_vend) ? row.fove_vend : [];
    for (const id of ids) {
      const cleanId = String(id ?? '').trim();
      if (cleanId) excluded.add(cleanId);
    }
  }
  return excluded;
}

/**
 * Clasifica si un registro crudo de `public."Vendedores"` corresponde a un vendedor comercial
 * activo real o a una cuenta administrativa / vacante / inactiva / sin supervisor / excluida.
 */
export function classifyErpVendedorEligibility(
  v: ErpVendedorRow,
  excludedIds: ReadonlySet<string>
): { eligible: true } | { eligible: false; reason: VendedorExclusionReason } {
  if (v.vend_acti !== true) {
    return { eligible: false, reason: 'INACTIVO' };
  }

  const code = cleanText(v.vend_codi);
  if (!code) {
    return { eligible: false, reason: 'SIN_CODIGO' };
  }

  const rawName = cleanText(v.vend_nomb);
  if (!rawName || NON_SELLER_ACCOUNT_REGEX.test(rawName)) {
    return { eligible: false, reason: 'CUENTA_ADMINISTRATIVA_O_VACANTE' };
  }

  if (!v.id_supe || !cleanText(v.id_supe)) {
    return { eligible: false, reason: 'SIN_SUPERVISOR' };
  }

  // Las rutas comerciales activas de Food Service (con supervisor asignado) se preservan
  // para no dejar huérfanos a sus clientes; el resto de excluidos del Forecast sí se depura.
  if (excludedIds.has(String(v.id_vend)) && !FOOD_SERVICE_ROUTE_REGEX.test(rawName)) {
    return { eligible: false, reason: 'EXCLUIDO_FORECAST_ERP' };
  }

  return { eligible: true };
}

/**
 * Extrae la identidad canónica de persona para consolidar vendedores que operan 2+ códigos de
 * ruta en el ERP dentro de la misma sede (p. ej.:
 *   - `J PABLO ARAUJO` (`031`) + `J PABLO ARAUJO - CAB/OJE` (`015`) -> `J PABLO ARAUJO`
 *   - `MIKELANGELO DIAZ` (`003`) + `MIKELANGELO DIAZ - VILLA DEL ROS` (`037`) -> `MIKELANGELO DIAZ`
 *   - `OSCAR ORTIZ- CORO` (`011`) + `OSCAR ORTIZ- LA COSTA` (`009`) -> `OSCAR ORTIZ`
 *   - `JUAN HERNANDEZ` (`024`) + `FOOD SERVICE SENIOR - JUAN HERNANDEZ` (`057`) -> `JUAN HERNANDEZ`
 * sin fusionar nunca cuentas distintas como `CUENTAS CLAVE 1 - MC` vs `CUENTAS CLAVE 2 - SV`).
 */
export function extractCanonicalSellerIdentity(rawName: string): {
  key: string;
  displayName: string;
} {
  const clean = cleanText(rawName);
  const norm = normalizeToken(clean);

  // Conservar cuentas corporativas numeradas o genéricas sin persona específica
  if (/^CUENTAS CLAVE\b/i.test(norm) || /^FOOD SERVICE (SUR|NORTE)$/i.test(norm)) {
    return { key: norm, displayName: clean };
  }

  // Prefijo de canal antes de guion: "FOOD SERVICE SENIOR - JUAN HERNANDEZ" -> "JUAN HERNANDEZ"
  const prefixMatch = /^FOOD SERVICE(?:\s+SENIOR)?\s*-\s*(.+)$/i.exec(clean);
  if (prefixMatch?.[1]) {
    const person = cleanText(prefixMatch[1]);
    return { key: normalizeToken(person), displayName: person };
  }

  // Sufijo geográfico o de canal después de guion:
  // "J PABLO ARAUJO - CAB/OJE", "OSCAR ORTIZ- CORO", "MIKELANGELO DIAZ - VILLA DEL ROS",
  // "JAIDER MEDINA - FOOD SERVICE NORTE"
  const dashIdx = clean.indexOf('-');
  if (dashIdx > 3) {
    const left = cleanText(clean.slice(0, dashIdx));
    const right = cleanText(clean.slice(dashIdx + 1));
    const leftWords = left.split(' ').filter(Boolean);
    if (leftWords.length >= 2 && right.length >= 2) {
      return { key: normalizeToken(left), displayName: left };
    }
  }

  return { key: norm, displayName: clean };
}

/**
 * Transforma, depura y consolida la tabla real `"Vendedores"` (y sus catálogos ERP
 * `"Sucursales"`, `"Supervisores"`, `"Regiones"`, `"Forecast_Vendedores_Excluidos"`)
 * devolviendo exclusivamente los vendedores comerciales activos reales (sin oficinas,
 * vacantes, duplicados ni supervisores sin código) junto con el reporte de auditoría.
 */
export function buildAuditedErpVendedoresDataset(dataset: Pick<
  ErpMasterDataset,
  'regiones' | 'sucursales' | 'supervisores' | 'vendedores' | 'vendedoresExcluidos'
> & {
  clientes?: readonly ErpClienteRow[];
}): { vendedores: Vendedor[]; auditoria: VendedoresAuditSummary } {
  const regById = new Map<string, ErpRegionRow>();
  for (const r of dataset.regiones) {
    if (r?.id_regi) regById.set(String(r.id_regi), r);
  }

  const sucuById = new Map<string, ErpSucursalRow>();
  for (const s of dataset.sucursales) {
    if (s?.id_sucu) sucuById.set(String(s.id_sucu), s);
  }

  const supeById = new Map<string, ErpSupervisorRow>();
  for (const sp of dataset.supervisores) {
    if (sp?.id_supe) supeById.set(String(sp.id_supe), sp);
  }

  const activeClientsByVendorId = new Map<string, number>();
  for (const c of dataset.clientes ?? []) {
    if (c?.clie_acti === true && c.id_vend) {
      const k = String(c.id_vend);
      activeClientsByVendorId.set(k, (activeClientsByVendorId.get(k) ?? 0) + 1);
    }
  }

  const excludedIds = extractExcludedErpVendorIds(dataset.vendedoresExcluidos);
  const excluidosPorMotivo: Record<VendedorExclusionReason, number> = {
    INACTIVO: 0,
    SIN_CODIGO: 0,
    CUENTA_ADMINISTRATIVA_O_VACANTE: 0,
    SIN_SUPERVISOR: 0,
    EXCLUIDO_FORECAST_ERP: 0,
  };

  interface EligibleEntry {
    raw: ErpVendedorRow;
    code: string;
    sucuDesc: string;
    supeName: string | null;
    regionId: string | null;
    regionDesc: string;
    operativeSucursal: SucursalMaestro | null;
    canonicalKey: string;
    displayName: string;
    activeClients: number;
  }

  const eligibleEntries: EligibleEntry[] = [];
  for (const v of dataset.vendedores) {
    if (!v?.id_vend) continue;
    const check = classifyErpVendedorEligibility(v, excludedIds);
    if (!check.eligible) {
      excluidosPorMotivo[check.reason] += 1;
      continue;
    }

    const sucu = v.id_sucu ? sucuById.get(String(v.id_sucu)) : undefined;
    const supe = v.id_supe ? supeById.get(String(v.id_supe)) : undefined;
    const regionId = sucu?.id_regi || supe?.id_regi || null;
    const regionRow = regionId ? regById.get(String(regionId)) : undefined;

    const sucuDesc = cleanText(sucu?.sucu_desc);
    const supeName = cleanText(supe?.supe_nomb) || null;
    const regionDesc = cleanText(regionRow?.regi_desd);
    const operativeSucursal = mapErpTerritoryToOperativeSucursal({
      sucursalDesc: sucuDesc,
      regionDesc,
    });

    const identity = extractCanonicalSellerIdentity(v.vend_nomb);
    eligibleEntries.push({
      raw: v,
      code: cleanText(v.vend_codi),
      sucuDesc,
      supeName,
      regionId: regionId ? String(regionId) : null,
      regionDesc,
      operativeSucursal,
      canonicalKey: identity.key,
      displayName: identity.displayName,
      activeClients: activeClientsByVendorId.get(String(v.id_vend)) ?? 0,
    });
  }

  // Consolidar múltiples códigos de ruta de un mismo vendedor dentro de la misma sede
  const grouped = new Map<string, EligibleEntry[]>();
  for (const entry of eligibleEntries) {
    const groupKey = `${entry.operativeSucursal ?? 'NONE'}::${entry.canonicalKey}`;
    const list = grouped.get(groupKey);
    if (list) list.push(entry);
    else grouped.set(groupKey, [entry]);
  }

  const porSede: Record<SucursalMaestro, number> = {
    ZULIA: 0,
    VALENCIA: 0,
    CENTRO: 0,
    CAPITAL: 0,
    ORIENTE: 0,
  };

  const result: Vendedor[] = [];
  let consolidadosDuplicados = 0;

  for (const entries of grouped.values()) {
    // Ordenar para elegir como primario el registro con más clientes activos (desempate por código)
    entries.sort(
      (a, b) =>
        b.activeClients - a.activeClients || a.code.localeCompare(b.code, 'es')
    );

    if (entries.length > 1) {
      consolidadosDuplicados += entries.length - 1;
    }

    const primary = entries[0]!;
    const uniqueCodes = Array.from(new Set(entries.map((e) => e.code).filter(Boolean)));
    const uniqueZones = Array.from(
      new Set(entries.map((e) => e.sucuDesc || e.regionDesc).filter(Boolean))
    );
    const uniqueVendorIds = entries.map((e) => String(e.raw.id_vend));
    const totalActiveClients = entries.reduce((acc, e) => acc + e.activeClients, 0);
    const phone = entries.map((e) => cleanText(e.raw.vend_cont)).find(Boolean) || null;
    const createdAt = primary.raw.created_at || new Date().toISOString();

    // Si el vendedor tiene una sola ruta y es Food Service con nombre específico (ej. JAIDER MEDINA - FOOD SERVICE NORTE),
    // conservar el descriptor completo; si consolidó 2+ rutas, usar el nombre canónico limpio.
    const nombreCompleto =
      entries.length > 1 ? primary.displayName : cleanText(primary.raw.vend_nomb) || primary.displayName;

    if (primary.operativeSucursal) {
      porSede[primary.operativeSucursal] += 1;
    }

    result.push({
      id: String(primary.raw.id_vend),
      codigo_vendedor: uniqueCodes.join(' / '),
      nombre_completo: nombreCompleto,
      documento_identidad: null,
      telefono: phone,
      email: null,
      zona: uniqueZones.join(' / ') || null,
      supervisor: primary.supeName,
      sucursal: primary.operativeSucursal,
      region_id: primary.regionId,
      activo: true,
      metadata: {
        source: 'supabase_erp_vendedores',
        sucursal_erp: primary.sucuDesc || null,
        region_codigo: normalizeErpRegionCode(primary.regionDesc),
        supervisor_id: primary.raw.id_supe ?? null,
        codigos_ruta: uniqueCodes,
        erp_vendor_ids: uniqueVendorIds,
        rutas_consolidadas: entries.length,
        clientes_activos: totalActiveClients,
      },
      ultima_sincronizacion: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  result.sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es'));

  const excluidosTotal = Object.values(excluidosPorMotivo).reduce((acc, n) => acc + n, 0);
  return {
    vendedores: result,
    auditoria: {
      totalErpRaw: dataset.vendedores.length,
      activosRealesUnicos: result.length,
      rutasComercialesActivas: eligibleEntries.length,
      excluidosTotal,
      consolidadosDuplicados,
      excluidosPorMotivo,
      porSede,
    },
  };
}

/**
 * Transforma la tabla real `"Vendedores"` (y sus tablas relacionadas `"Sucursales"`,
 * `"Supervisores"`, `"Regiones"`, `"Forecast_Vendedores_Excluidos"`) al modelo canónico
 * depurado y consolidado `Vendedor[]` de Trade Marketing.
 */
export function normalizeErpVendedoresDataset(dataset: Pick<
  ErpMasterDataset,
  'regiones' | 'sucursales' | 'supervisores' | 'vendedores' | 'vendedoresExcluidos'
> & {
  clientes?: readonly ErpClienteRow[];
}): Vendedor[] {
  return buildAuditedErpVendedoresDataset(dataset).vendedores;
}

/**
 * Transforma la tabla real `"Clientes"` (y sus catálogos ERP `"Vendedores"`, `"Sucursales"`,
 * `"Estados"`, `"Municipios"`, `"Supervisores"`, `"Regiones"`, `"Tipificacion_Clientes"`)
 * al modelo canónico `ClienteConVendedor[]` usado por Cronograma, Data Maestra y Reportes.
 */
export function normalizeErpClientesDataset(dataset: ErpMasterDataset): ClienteConVendedor[] {
  const regById = new Map<string, ErpRegionRow>();
  for (const r of dataset.regiones) {
    if (r?.id_regi) regById.set(String(r.id_regi), r);
  }

  const sucuById = new Map<string, ErpSucursalRow>();
  for (const s of dataset.sucursales) {
    if (s?.id_sucu) sucuById.set(String(s.id_sucu), s);
  }

  const estaById = new Map<string, ErpEstadoRow>();
  for (const e of dataset.estados) {
    if (e?.id_esta) estaById.set(String(e.id_esta), e);
  }

  const muniById = new Map<string, ErpMunicipioRow>();
  for (const m of dataset.municipios) {
    if (m?.id_muni) muniById.set(String(m.id_muni), m);
  }

  const supeById = new Map<string, ErpSupervisorRow>();
  for (const sp of dataset.supervisores) {
    if (sp?.id_supe) supeById.set(String(sp.id_supe), sp);
  }

  const vendById = new Map<string, ErpVendedorRow>();
  for (const v of dataset.vendedores) {
    if (v?.id_vend) vendById.set(String(v.id_vend), v);
  }

  const tipiById = new Map<string, ErpTipificacionRow>();
  for (const t of dataset.tipificaciones) {
    if (t?.id_tipi) tipiById.set(String(t.id_tipi), t);
  }

  const result: ClienteConVendedor[] = [];
  for (const c of dataset.clientes) {
    if (!c?.id_clie) continue;

    const vend = c.id_vend ? vendById.get(String(c.id_vend)) : undefined;
    const sucu = vend?.id_sucu ? sucuById.get(String(vend.id_sucu)) : undefined;
    const supe = vend?.id_supe ? supeById.get(String(vend.id_supe)) : undefined;
    const esta = c.id_esta ? estaById.get(String(c.id_esta)) : undefined;
    const muni = c.id_muni ? muniById.get(String(c.id_muni)) : undefined;
    const tipi = c.id_tipi ? tipiById.get(String(c.id_tipi)) : undefined;

    const regionId = c.clie_regi || sucu?.id_regi || esta?.id_regi || null;
    const reg = regionId ? regById.get(String(regionId)) : undefined;

    const sucuDesc = cleanText(sucu?.sucu_desc);
    const estaDesc = cleanText(esta?.esta_desc);
    const muniDesc = cleanText(muni?.muni_desc);
    const regDesc = cleanText(reg?.regi_desd);
    const supeName = cleanText(supe?.supe_nomb) || null;
    const tipiDesc = cleanText(tipi?.tipi_desc) || null;

    const operativeSucursal = mapErpTerritoryToOperativeSucursal({
      sucursalDesc: sucuDesc,
      estadoDesc: estaDesc,
      regionDesc: regDesc,
    });

    const rawCode = cleanText(c.clie_rif);
    const codigoCliente = rawCode || String(c.id_clie).slice(0, 8).toUpperCase();
    const rif = VENEZUELAN_RIF_REGEX.test(rawCode) ? rawCode.toUpperCase() : null;
    const razonSocial = cleanText(c.clie_nomb) || `Cliente ${codigoCliente}`;
    const nombreComercial = extractCommercialAlias(razonSocial);

    // Zona legible y filtrable en el selector "Todas las Zonas" del Cronograma
    const zona =
      estaDesc && muniDesc
        ? `${estaDesc} · ${muniDesc}`
        : estaDesc || sucuDesc || regDesc || null;

    const rawLat = parseFiniteCoord(c.clie_lati, -90, 90);
    const rawLng = parseFiniteCoord(c.clie_long, -180, 180);
    const hasValidGps =
      rawLat !== null && rawLng !== null && !(Math.abs(rawLat) < 0.0001 && Math.abs(rawLng) < 0.0001);
    const latitud = hasValidGps ? rawLat : null;
    const longitud = hasValidGps ? rawLng : null;
    const createdAt = c.created_at || new Date().toISOString();

    const vendCode = cleanText(vend?.vend_codi) || null;
    const vendName = cleanText(vend?.vend_nomb) || null;
    const canonicalRegion = normalizeErpRegionCode(regDesc);
    const derivedCadenaId = c.id_clie_prin
      ? `erp-prin-${String(c.id_clie_prin)}`
      : c.id_tipi
        ? `erp-tipi-${String(c.id_tipi)}`
        : null;
    const derivedZonaId = c.id_muni
      ? `erp-muni-${String(c.id_muni)}`
      : c.id_esta
        ? `erp-esta-${String(c.id_esta)}`
        : sucu?.id_sucu
          ? `erp-sucu-${String(sucu.id_sucu)}`
          : null;

    result.push({
      id: String(c.id_clie),
      codigo_cliente: codigoCliente,
      rif,
      razon_social: razonSocial,
      nombre_comercial: nombreComercial,
      canal: normalizeErpTipificacionToCanal(tipiDesc),
      segmento: tipiDesc,
      zona,
      ruta: vendCode ? `RUTA-${vendCode}` : null,
      direccion: muniDesc && estaDesc ? `${muniDesc}, ${estaDesc}` : estaDesc || null,
      ciudad: muniDesc || sucuDesc || null,
      estado: estaDesc || null,
      telefono: null,
      latitud,
      longitud,
      cadena_id: derivedCadenaId,
      zona_id: derivedZonaId,
      supervisor_id: vend?.id_supe ? String(vend.id_supe) : null,
      region_id: regionId ? String(regionId) : null,
      radio_geocerca_m: 150,
      sucursal: operativeSucursal,
      vendedor_id: c.id_vend ? String(c.id_vend) : null,
      codigo_vendedor: vendCode,
      activo: c.clie_acti !== false,
      metadata: {
        source: 'supabase_erp_clientes',
        region_codigo: canonicalRegion,
        sucursal_erp: sucuDesc || null,
        estado_erp: estaDesc || null,
        municipio_erp: muniDesc || null,
        supervisor_erp: supeName,
      },
      ultima_sincronizacion: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
      vendedor: vend
        ? {
            id: String(vend.id_vend),
            codigo_vendedor: vendCode || String(vend.id_vend).slice(0, 8),
            nombre_completo: vendName || 'Sin vendedor',
            zona: sucuDesc || null,
            supervisor: supeName,
            activo: vend.vend_acti !== false,
          }
        : null,
    });
  }

  result.sort((a, b) => a.razon_social.localeCompare(b.razon_social, 'es'));
  return result;
}

function matchesCommercialSearch(target: string | null | undefined, query: string): boolean {
  const q = cleanText(query);
  if (!q) return true;
  const t = cleanText(target);
  if (!t) return false;

  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();

  if (norm(t).includes(norm(q))) return true;

  const compact = (s: string) => norm(s).replace(/[^A-Z0-9Ñ]+/g, '');
  const cq = compact(q);
  return cq.length >= 2 && compact(t).includes(cq);
}

/**
 * Filtra colecciones normalizadas de clientes respetando sede (`sucursal`), región (`OCCIDENTE` /
 * `CENTRO` / `ANDES`), estado activo, zona, vendedor, canal y búsqueda comercial (`", C.A."`).
 */
export function filterNormalizedErpClientes(
  clientes: readonly ClienteConVendedor[],
  filtros: FiltrosConsultaClientes = {}
): ClienteConVendedor[] {
  const soloActivos = filtros.soloActivos !== false;
  const sucursalFiltro = filtros.sucursal ?? null;
  const regionFiltro = filtros.region ?? null;
  const regionsFiltro =
    Array.isArray(filtros.regions) && filtros.regions.length > 0 ? filtros.regions : null;
  const regionIdFiltro = cleanText(filtros.regionId);
  const zonaFiltro = normalizeToken(filtros.zona);
  const rutaFiltro = normalizeToken(filtros.ruta);
  const vendedorIdFiltro = cleanText(filtros.vendedorId);
  const codigoVendedorFiltro = normalizeToken(filtros.codigoVendedor);
  const canalFiltro = normalizeToken(filtros.canal);
  const busqueda = cleanText(filtros.busqueda);

  return clientes.filter((c) => {
    if (soloActivos && c.activo !== true) return false;
    if (sucursalFiltro && c.sucursal !== sucursalFiltro) return false;
    if (regionIdFiltro && c.region_id !== regionIdFiltro) return false;
    if (regionFiltro || regionsFiltro) {
      const metaRegion =
        normalizeErpRegionCode(c.metadata?.region_codigo) ?? normalizeRegionName(c.sucursal ?? c.estado);
      if (regionFiltro && metaRegion !== regionFiltro) return false;
      if (regionsFiltro && (!metaRegion || !regionsFiltro.includes(metaRegion))) return false;
    }
    if (zonaFiltro && !normalizeToken(c.zona).includes(zonaFiltro)) return false;
    if (rutaFiltro && !normalizeToken(c.ruta).includes(rutaFiltro)) return false;
    if (vendedorIdFiltro && c.vendedor_id !== vendedorIdFiltro) return false;
    if (codigoVendedorFiltro && normalizeToken(c.codigo_vendedor) !== codigoVendedorFiltro) {
      return false;
    }
    if (canalFiltro && !normalizeToken(c.canal).includes(canalFiltro)) return false;
    if (busqueda) {
      const hit =
        matchesCommercialSearch(c.razon_social, busqueda) ||
        matchesCommercialSearch(c.nombre_comercial, busqueda) ||
        matchesCommercialSearch(c.codigo_cliente, busqueda) ||
        matchesCommercialSearch(c.rif, busqueda) ||
        matchesCommercialSearch(c.vendedor?.nombre_completo, busqueda) ||
        matchesCommercialSearch(c.zona, busqueda);
      if (!hit) return false;
    }
    return true;
  });
}

export function filterNormalizedErpVendedores(
  vendedores: readonly Vendedor[],
  filtros: FiltrosConsultaVendedores = {}
): Vendedor[] {
  const soloActivos = filtros.soloActivos !== false;
  const sucursalFiltro = filtros.sucursal ?? null;
  const regionFiltro = filtros.region ?? null;
  const regionsFiltro =
    Array.isArray(filtros.regions) && filtros.regions.length > 0 ? filtros.regions : null;
  const regionIdFiltro = cleanText(filtros.regionId);
  const zonaFiltro = normalizeToken(filtros.zona);
  const supervisorFiltro = normalizeToken(filtros.supervisor);
  const busqueda = cleanText(filtros.busqueda);

  return vendedores.filter((v) => {
    if (soloActivos && v.activo !== true) return false;
    if (sucursalFiltro && v.sucursal !== sucursalFiltro) return false;
    if (regionIdFiltro && v.region_id !== regionIdFiltro) return false;
    if (regionFiltro || regionsFiltro) {
      const metaRegion =
        normalizeErpRegionCode(v.metadata?.region_codigo) ?? normalizeRegionName(v.sucursal ?? v.zona);
      if (regionFiltro && metaRegion !== regionFiltro) return false;
      if (regionsFiltro && (!metaRegion || !regionsFiltro.includes(metaRegion))) return false;
    }
    if (zonaFiltro && !normalizeToken(v.zona).includes(zonaFiltro)) return false;
    if (supervisorFiltro && !normalizeToken(v.supervisor).includes(supervisorFiltro)) return false;
    if (busqueda) {
      const hit =
        matchesCommercialSearch(v.nombre_completo, busqueda) ||
        matchesCommercialSearch(v.codigo_vendedor, busqueda) ||
        matchesCommercialSearch(v.supervisor, busqueda) ||
        matchesCommercialSearch(v.zona, busqueda);
      if (!hit) return false;
    }
    return true;
  });
}

// =============================================================================
// ADAPTADORES COMPLETOS DE LAS 9 ENTIDADES MAESTRAS (ESQUEMA REAL SUPABASE)
// =============================================================================

function mapAllowedRegionToSucursalCompat(region: AllowedRegionCode | null): SucursalMaestro | null {
  if (region === 'OCCIDENTE') return 'ZULIA';
  if (region === 'CENTRO') return 'CENTRO';
  return null;
}

function buildRegionLookupMaps(regiones: readonly ErpRegionRow[]): {
  byId: Map<string, { row: ErpRegionRow; code: AllowedRegionCode }>;
  byCode: Map<AllowedRegionCode, ErpRegionRow>;
} {
  const byId = new Map<string, { row: ErpRegionRow; code: AllowedRegionCode }>();
  const byCode = new Map<AllowedRegionCode, ErpRegionRow>();
  for (const r of regiones) {
    if (!r?.id_regi) continue;
    const code = normalizeErpRegionCode(r.regi_desd);
    if (!code) continue;
    byId.set(String(r.id_regi), { row: r, code });
    byCode.set(code, r);
  }
  return { byId, byCode };
}

/**
 * 1. Normaliza `public."Regiones"` garantizando estrictamente las 3 regiones reales
 * (`OCCIDENTE` [P1, `regi_saba=true`], `CENTRO` [P2], `ANDES` [P3]) ordenadas por prioridad.
 */
export function normalizeErpRegionesDataset(regiones: readonly ErpRegionRow[]): RegionMaestra[] {
  const out: RegionMaestra[] = [];
  const seen = new Set<AllowedRegionCode>();
  for (const r of regiones) {
    if (!r?.id_regi) continue;
    const code = normalizeErpRegionCode(r.regi_desd);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const createdAt = r.created_at || new Date().toISOString();
    out.push({
      id: String(r.id_regi),
      codigo: code,
      nombre: code,
      activo: true,
      regi_saba: r.regi_saba === true,
      priority: REGIONAL_PRIORITY_RANK[code],
      created_at: createdAt,
      updated_at: createdAt,
    });
  }
  out.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  return out;
}

/**
 * 2. Normaliza el Catálogo Nacional de Productos desde `"vw_productos_detalle"` + `"Productos"`.
 */
export function normalizeErpProductosDataset(
  productos: readonly ErpProductoRow[] = [],
  vwDetalle: readonly ErpVwProductoDetalleRow[] = []
): ProductoMaestro[] {
  const prodById = new Map<string, ErpProductoRow>();
  for (const p of productos) {
    if (p?.id_prod) prodById.set(String(p.id_prod), p);
  }

  const result: ProductoMaestro[] = [];
  const seen = new Set<string>();

  for (const v of vwDetalle) {
    if (!v?.id_prod) continue;
    const id = String(v.id_prod);
    if (seen.has(id)) continue;
    seen.add(id);

    const rawProd = prodById.get(id);
    const codigo = cleanText(v.codigo ?? rawProd?.prod_codi).toUpperCase();
    const nombre = cleanText(v.producto ?? rawProd?.prod_desc) || codigo || 'Sin nombre';
    const unidad = cleanText(rawProd?.prod_unid || 'KG').toUpperCase() || 'KG';
    const categoriaParts = [cleanText(v.grupo), cleanText(v.familia)].filter(Boolean);
    const createdAt = v.created_at || rawProd?.created_at || new Date().toISOString();

    result.push({
      id,
      codigo,
      nombre,
      categoria: categoriaParts.length > 0 ? categoriaParts.join(' · ') : null,
      marca: cleanText(v.marca) || null,
      unidad_medida: unidad,
      activo: v.activo !== false && rawProd?.prod_acti !== false,
      metadata: {
        source: 'supabase_erp_productos',
        familia: cleanText(v.familia) || null,
        grupo: cleanText(v.grupo) || null,
        marca_propia: v.marca_propia === true,
        regiones: cleanText(v.regiones) || null,
        n_regiones: typeof v.n_regiones === 'number' ? v.n_regiones : null,
        orden: typeof v.orden === 'number' ? v.orden : null,
      },
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  // Completar con cualquier fila presente solo en `"Productos"`
  for (const p of productos) {
    if (!p?.id_prod) continue;
    const id = String(p.id_prod);
    if (seen.has(id)) continue;
    seen.add(id);

    const codigo = cleanText(p.prod_codi).toUpperCase();
    const nombre = cleanText(p.prod_desc) || codigo || 'Sin nombre';
    const createdAt = p.created_at || new Date().toISOString();

    result.push({
      id,
      codigo,
      nombre,
      categoria: null,
      marca: null,
      unidad_medida: cleanText(p.prod_unid || 'KG').toUpperCase() || 'KG',
      activo: p.prod_acti !== false,
      metadata: { source: 'supabase_erp_productos' },
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  result.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return result;
}

/**
 * 3. Normaliza `public."Supervisores"` resolviendo su región real dinámicamente vía `id_regi`.
 */
export function normalizeErpSupervisoresDataset(
  supervisores: readonly ErpSupervisorRow[],
  regiones: readonly ErpRegionRow[]
): SupervisorMaestro[] {
  const { byId } = buildRegionLookupMaps(regiones);
  const out: SupervisorMaestro[] = [];

  for (const s of supervisores) {
    if (!s?.id_supe) continue;
    const regInfo = s.id_regi ? byId.get(String(s.id_regi)) : undefined;
    const regionCode = regInfo?.code ?? null;
    const createdAt = s.created_at || new Date().toISOString();

    out.push({
      id: String(s.id_supe),
      codigo: null,
      nombre: cleanText(s.supe_nomb) || 'Sin nombre',
      email: null,
      telefono: cleanText(s.supe_cont) || null,
      zona: regionCode,
      sucursal: mapAllowedRegionToSucursalCompat(regionCode),
      region_id: s.id_regi ? String(s.id_regi) : null,
      activo: s.supe_acti !== false,
      metadata: {
        source: 'supabase_erp_supervisores',
        region_codigo: regionCode,
      },
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return out;
}

export type PromotoraRegionPerfil = 'Occidente' | 'Valencia' | 'Centro' | 'Andes';

export function normalizePromotoraRegionPerfil(raw: unknown): PromotoraRegionPerfil | null {
  const token = normalizeToken(raw);
  if (!token) return null;
  if (token === 'OCCIDENTE' || token === 'ZULIA') return 'Occidente';
  if (token === 'VALENCIA') return 'Valencia';
  if (token === 'CENTRO' || token === 'CAPITAL') return 'Centro';
  if (
    token === 'ANDES' ||
    token === 'LOS ANDES' ||
    token === 'MERIDA' ||
    token === 'TACHIRA' ||
    token === 'TRUJILLO' ||
    token === 'BARINAS'
  ) {
    return 'Andes';
  }
  return null;
}

/**
 * 4. Normaliza `public.promotoras` (leyendo `correo ?? email`, `region` explícita
 * `'Occidente' | 'Valencia' | 'Centro' | 'Andes'`, `auth_user_id`, clasificación estricta
 * `Fijas`/`Eventuales`/`Merchandising`, y resolución dinámica de `region_id` desde `"Regiones"`).
 */
export function normalizeErpPromotorasDataset(
  promotoras: readonly ErpPromotoraRow[],
  regiones: readonly ErpRegionRow[]
): PromotoraMaestra[] {
  const { byId, byCode } = buildRegionLookupMaps(regiones);
  const out: PromotoraMaestra[] = [];

  for (const p of promotoras) {
    if (p?.id === undefined || p?.id === null || String(p.id).trim() === '') continue;

    const rawRecord = p as unknown as Record<string, unknown>;
    const categoria = classifyPromotoraCategoriaOficial(rawRecord);
    const nombre = cleanText(p.nombre_completo ?? p.nombre) || 'Sin nombre';
    const emailRaw = cleanText(p.email ?? p.correo).toLowerCase() || null;
    const direccion = cleanText(p.direccion) || null;
    const ciudad = cleanText(p.ciudad) || direccion;
    const estado = cleanText(p.estado) || null;
    const authUserId = cleanText(p.auth_user_id) || null;

    let regionId = cleanText(p.region_id) || null;
    let regionCode: AllowedRegionCode | null = regionId ? byId.get(regionId)?.code ?? null : null;
    const explicitRegionPerfil = normalizePromotoraRegionPerfil(p.region);

    if (!regionCode && explicitRegionPerfil) {
      regionCode =
        explicitRegionPerfil === 'Andes'
          ? 'ANDES'
          : explicitRegionPerfil === 'Valencia' || explicitRegionPerfil === 'Centro'
            ? 'CENTRO'
            : 'OCCIDENTE';
      const matchedReg = byCode.get(regionCode);
      if (matchedReg?.id_regi) {
        regionId = String(matchedReg.id_regi);
      }
    }

    if (!regionCode && emailRaw === 'joseabraham.barroso@gmail.com') {
      regionCode = 'OCCIDENTE';
      const matchedReg = byCode.get('OCCIDENTE');
      if (matchedReg?.id_regi) {
        regionId = String(matchedReg.id_regi);
      }
    }

    if (!regionCode) {
      const inferred =
        normalizeRegionName(p.sucursal) ??
        normalizeRegionName(estado) ??
        normalizeRegionName(ciudad) ??
        normalizeRegionName(direccion);
      if (inferred) {
        regionCode = inferred;
        const matchedReg = byCode.get(inferred);
        if (matchedReg?.id_regi) {
          regionId = String(matchedReg.id_regi);
        }
      }
    }

    const regionPerfil: PromotoraRegionPerfil | null =
      explicitRegionPerfil ??
      (regionCode === 'OCCIDENTE'
        ? 'Occidente'
        : regionCode === 'CENTRO'
          ? 'Valencia'
          : regionCode === 'ANDES'
            ? 'Andes'
            : null);

    const createdAt = p.created_at || new Date().toISOString();
    const updatedAt = p.updated_at || createdAt;

    out.push({
      id: String(p.id),
      nombre_completo: nombre,
      email: emailRaw,
      telefono: cleanText(p.telefono) || null,
      ciudad,
      estado,
      direccion,
      region: regionPerfil,
      auth_user_id: authUserId,
      sucursal:
        regionPerfil === 'Valencia'
          ? 'VALENCIA'
          : mapAllowedRegionToSucursalCompat(regionCode),
      region_id: regionId,
      supervisor_id: cleanText(p.supervisor_id) || null,
      categoria,
      tipo: formatPromotoraRoleForCategory(categoria),
      rol: categoria,
      metadata: {
        source: 'supabase_promotoras',
        region_codigo: regionCode,
        region_perfil: regionPerfil,
        region_inferred_from_address: !p.region_id && !p.region && Boolean(regionCode),
      },
      activo: p.activo !== false,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }

  out.sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es'));
  return out;
}

/**
 * 5. Construye el catálogo relacional de `CADENAS COMERCIALES` desde las tablas reales ERP:
 *   - Cadenas matrices multi-sucursal (`Clientes.id_clie_prin`: p. ej. ALKOSTO, FAMILIA CENTER).
 *   - Tipificaciones con PDVs activos (`Tipificacion_Clientes`: Tiendas Cadenas Regionales,
 *     Cadena de Farmacias, Supermercados Independientes, etc.).
 *   - Canales de comercialización (`Canal_Comercializacion`) cuando no existen tipificaciones.
 */
export function normalizeErpCadenasDataset(dataset: Pick<
  ErpMasterDataset,
  'regiones' | 'clientes' | 'tipificaciones' | 'canalesComercializacion'
>): CadenaComercial[] {
  const { byId } = buildRegionLookupMaps(dataset.regiones);
  const clieById = new Map<string, ErpClienteRow>();
  for (const c of dataset.clientes) {
    if (c?.id_clie) clieById.set(String(c.id_clie), c);
  }

  const out: CadenaComercial[] = [];
  const seenNames = new Set<string>();
  const nowIso = new Date().toISOString();

  // A. Cadenas matrices explícitas por `id_clie_prin`
  const prinGroups = new Map<
    string,
    { name: string; activeCount: number; totalCount: number; regionId: string | null; regionCode: AllowedRegionCode | null }
  >();
  for (const c of dataset.clientes) {
    if (!c?.id_clie_prin) continue;
    const pid = String(c.id_clie_prin);
    const parent = clieById.get(pid);
    const regInfo = c.clie_regi ? byId.get(String(c.clie_regi)) : undefined;
    const cur = prinGroups.get(pid) ?? {
      name: cleanText(parent?.clie_nomb ?? c.clie_nomb) || `CADENA ${pid.slice(0, 6).toUpperCase()}`,
      activeCount: 0,
      totalCount: 0,
      regionId: regInfo?.row.id_regi ?? (c.clie_regi ? String(c.clie_regi) : null),
      regionCode: regInfo?.code ?? null,
    };
    cur.totalCount += 1;
    if (c.clie_acti !== false) cur.activeCount += 1;
    prinGroups.set(pid, cur);
  }

  let seq = 1;
  for (const [pid, g] of prinGroups.entries()) {
    const normKey = normalizeToken(g.name);
    seenNames.add(normKey);
    out.push({
      id: `erp-prin-${pid}`,
      codigo: `CAD-${String(seq++).padStart(3, '0')}`,
      nombre: g.name,
      tipo_canal: 'Cadena Matriz',
      sucursal: mapAllowedRegionToSucursalCompat(g.regionCode),
      region_id: g.regionId,
      activo: g.activeCount > 0,
      metadata: {
        source: 'supabase_erp_clientes_principal',
        region_codigo: g.regionCode,
        clientes_activos: g.activeCount,
        clientes_total: g.totalCount,
      },
      created_at: nowIso,
      updated_at: nowIso,
    });
  }

  // B. Tipificaciones comerciales reales (`Tipificacion_Clientes`) con clientes asignados
  const tipiStats = new Map<
    string,
    { active: number; total: number; regionCounts: Map<string, number> }
  >();
  for (const c of dataset.clientes) {
    if (!c?.id_tipi) continue;
    const tid = String(c.id_tipi);
    const stat = tipiStats.get(tid) ?? { active: 0, total: 0, regionCounts: new Map<string, number>() };
    stat.total += 1;
    if (c.clie_acti !== false) {
      stat.active += 1;
      if (c.clie_regi) {
        const rid = String(c.clie_regi);
        stat.regionCounts.set(rid, (stat.regionCounts.get(rid) ?? 0) + 1);
      }
    }
    tipiStats.set(tid, stat);
  }

  for (const t of dataset.tipificaciones) {
    if (!t?.id_tipi) continue;
    const nombre = cleanText(t.tipi_desc);
    if (!nombre) continue;
    const normKey = normalizeToken(nombre);
    if (seenNames.has(normKey)) continue;

    const stat = tipiStats.get(String(t.id_tipi));
    const isChainCategory = /CADENA|SUPERMERCADO|FARMACIA|MAYORISTA|MINIMARKET|BODEGON/i.test(normKey);
    if (!isChainCategory && (!stat || stat.active === 0)) continue;

    let dominantRegionId: string | null = null;
    let dominantCount = -1;
    if (stat) {
      for (const [rid, cnt] of stat.regionCounts.entries()) {
        if (cnt > dominantCount) {
          dominantCount = cnt;
          dominantRegionId = rid;
        }
      }
    }
    const regionCode = dominantRegionId ? byId.get(dominantRegionId)?.code ?? null : null;
    seenNames.add(normKey);

    out.push({
      id: `erp-tipi-${String(t.id_tipi)}`,
      codigo: `TIP-${String(seq++).padStart(3, '0')}`,
      nombre,
      tipo_canal: normalizeErpTipificacionToCanal(nombre) || 'Cuentas Claves',
      sucursal: mapAllowedRegionToSucursalCompat(regionCode),
      region_id: dominantRegionId,
      activo: true,
      metadata: {
        source: 'supabase_erp_tipificacion_clientes',
        region_codigo: regionCode,
        clientes_activos: stat?.active ?? 0,
        clientes_total: stat?.total ?? 0,
      },
      created_at: t.created_at || nowIso,
      updated_at: t.created_at || nowIso,
    });
  }

  // C. Canales de comercialización si no hubo suficientes registros
  for (const ch of dataset.canalesComercializacion ?? []) {
    if (!ch?.id_cana) continue;
    const nombre = cleanText(ch.cana_desc);
    if (!nombre) continue;
    const normKey = normalizeToken(nombre);
    if (seenNames.has(normKey)) continue;
    seenNames.add(normKey);
    out.push({
      id: `erp-cana-${String(ch.id_cana)}`,
      codigo: `CAN-${String(seq++).padStart(3, '0')}`,
      nombre,
      tipo_canal: 'Canal Comercial',
      sucursal: null,
      region_id: null,
      activo: true,
      metadata: {
        source: 'supabase_erp_canal_comercializacion',
        region_codigo: null,
      },
      created_at: ch.created_at || nowIso,
      updated_at: ch.created_at || nowIso,
    });
  }

  out.sort((a, b) => {
    const aCount = Number(a.metadata?.clientes_activos ?? 0);
    const bCount = Number(b.metadata?.clientes_activos ?? 0);
    return bCount - aCount || a.nombre.localeCompare(b.nombre, 'es');
  });
  return out;
}

/**
 * 6. Construye el catálogo de `ZONAS GEOGRÁFICAS` reales desde `"Sucursales"`, `"Estados"`
 * y `"Municipios"` con clientes activos, enlazado por `id_regi` a `OCCIDENTE` / `CENTRO` / `ANDES`.
 */
export function normalizeErpZonasDataset(dataset: Pick<
  ErpMasterDataset,
  'regiones' | 'sucursales' | 'estados' | 'municipios' | 'clientes'
>): ZonaComercial[] {
  const { byId } = buildRegionLookupMaps(dataset.regiones);
  const estaById = new Map<string, ErpEstadoRow>();
  for (const e of dataset.estados) {
    if (e?.id_esta) estaById.set(String(e.id_esta), e);
  }
  const muniById = new Map<string, ErpMunicipioRow>();
  for (const m of dataset.municipios) {
    if (m?.id_muni) muniById.set(String(m.id_muni), m);
  }

  const out: ZonaComercial[] = [];
  const seenKeys = new Set<string>();
  const nowIso = new Date().toISOString();

  // Contar PDVs activos por municipio y por estado
  const activeByMuni = new Map<string, { count: number; regionId: string | null }>();
  const activeByEsta = new Map<string, { count: number; regionId: string | null }>();
  for (const c of dataset.clientes) {
    if (c?.clie_acti === false) continue;
    const rid = c.clie_regi ? String(c.clie_regi) : null;
    if (c.id_muni) {
      const k = String(c.id_muni);
      const prev = activeByMuni.get(k);
      activeByMuni.set(k, { count: (prev?.count ?? 0) + 1, regionId: prev?.regionId ?? rid });
    }
    if (c.id_esta) {
      const k = String(c.id_esta);
      const prev = activeByEsta.get(k);
      activeByEsta.set(k, { count: (prev?.count ?? 0) + 1, regionId: prev?.regionId ?? rid });
    }
  }

  // A. Municipios con cartera activa real
  for (const [muniId, info] of activeByMuni.entries()) {
    const muni = muniById.get(muniId);
    if (!muni) continue;
    const esta = muni.id_esta ? estaById.get(String(muni.id_esta)) : undefined;
    const regionId = info.regionId || muni.id_regi || esta?.id_regi || null;
    const regionCode = regionId ? byId.get(String(regionId))?.code ?? null : null;
    const estaDesc = cleanText(esta?.esta_desc) || null;
    const muniDesc = cleanText(muni.muni_desc);
    const nombre = estaDesc ? `${estaDesc} · ${muniDesc}` : muniDesc;
    const key = normalizeToken(nombre);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    out.push({
      id: `erp-muni-${muniId}`,
      codigo: `ZON-${muniDesc.slice(0, 6).replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'MUN'}`,
      nombre,
      ciudad: muniDesc,
      estado: estaDesc,
      sucursal: mapAllowedRegionToSucursalCompat(regionCode),
      region_id: regionId ? String(regionId) : null,
      activo: true,
      metadata: {
        source: 'supabase_erp_municipios',
        region_codigo: regionCode,
        clientes_activos: info.count,
      },
      created_at: muni.created_at || nowIso,
      updated_at: muni.created_at || nowIso,
    });
  }

  // B. Estados con cartera activa o región asignada
  for (const esta of dataset.estados) {
    if (!esta?.id_esta) continue;
    const eid = String(esta.id_esta);
    const stat = activeByEsta.get(eid);
    const regionId = stat?.regionId || esta.id_regi || null;
    if (!stat && !regionId) continue;
    const regionCode = regionId ? byId.get(String(regionId))?.code ?? null : null;
    const estaDesc = cleanText(esta.esta_desc);
    const key = normalizeToken(estaDesc);
    if (!estaDesc || seenKeys.has(key)) continue;
    seenKeys.add(key);

    out.push({
      id: `erp-esta-${eid}`,
      codigo: `EST-${estaDesc.slice(0, 6).replace(/[^A-Z0-9]/gi, '').toUpperCase()}`,
      nombre: estaDesc,
      ciudad: null,
      estado: estaDesc,
      sucursal: mapAllowedRegionToSucursalCompat(regionCode),
      region_id: regionId ? String(regionId) : null,
      activo: true,
      metadata: {
        source: 'supabase_erp_estados',
        region_codigo: regionCode,
        clientes_activos: stat?.count ?? 0,
      },
      created_at: esta.created_at || nowIso,
      updated_at: esta.created_at || nowIso,
    });
  }

  // C. Sucursales ERP aún no cubiertas
  for (const s of dataset.sucursales) {
    if (!s?.id_sucu) continue;
    const desc = cleanText(s.sucu_desc);
    const key = normalizeToken(desc);
    if (!desc || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const regionId = s.id_regi ? String(s.id_regi) : null;
    const regionCode = regionId ? byId.get(regionId)?.code ?? null : null;

    out.push({
      id: `erp-sucu-${String(s.id_sucu)}`,
      codigo: `SUC-${desc.slice(0, 6).replace(/[^A-Z0-9]/gi, '').toUpperCase()}`,
      nombre: desc,
      ciudad: desc,
      estado: desc,
      sucursal: mapAllowedRegionToSucursalCompat(regionCode),
      region_id: regionId,
      activo: true,
      metadata: {
        source: 'supabase_erp_sucursales',
        region_codigo: regionCode,
        clientes_activos: 0,
      },
      created_at: s.created_at || nowIso,
      updated_at: s.created_at || nowIso,
    });
  }

  out.sort((a, b) => {
    const aCount = Number(a.metadata?.clientes_activos ?? 0);
    const bCount = Number(b.metadata?.clientes_activos ?? 0);
    return bCount - aCount || a.nombre.localeCompare(b.nombre, 'es');
  });
  return out;
}

/**
 * 7. Resumen consolidado por las 3 regiones reales (`OCCIDENTE` -> `CENTRO` -> `ANDES`)
 * para KPIs ejecutivos y auditoría de conteos exactos.
 */
export function computeMasterEntitiesSummaryByRegion(params: {
  regiones: readonly RegionMaestra[];
  clientes: readonly ClienteConVendedor[];
  promotoras: readonly PromotoraMaestra[];
  supervisores: readonly SupervisorMaestro[];
  vendedores: readonly Vendedor[];
  cadenas: readonly CadenaComercial[];
  zonas: readonly ZonaComercial[];
}): RegionEntitiesSummary[] {
  const regByCode = new Map<AllowedRegionCode, RegionMaestra>();
  const codeByRegId = new Map<string, AllowedRegionCode>();
  for (const r of params.regiones) {
    const code = normalizeErpRegionCode(r.codigo);
    if (code) {
      regByCode.set(code, r);
      codeByRegId.set(r.id, code);
    }
  }

  const resolveCode = (row: {
    region_id?: string | null;
    sucursal?: string | null;
    metadata?: Record<string, unknown>;
  }): AllowedRegionCode | null => {
    if (row.region_id && codeByRegId.has(row.region_id)) {
      return codeByRegId.get(row.region_id)!;
    }
    return (
      normalizeErpRegionCode(row.metadata?.region_codigo) ??
      normalizeRegionName(row.sucursal)
    );
  };

  const buckets = new Map<AllowedRegionCode, RegionEntitiesSummary>();
  for (const code of ALLOWED_REGIONS) {
    const reg = regByCode.get(code);
    buckets.set(code, {
      region: code,
      regionId: reg?.id ?? null,
      regiSaba: reg?.regi_saba === true || code === 'OCCIDENTE',
      priority: REGIONAL_PRIORITY_RANK[code],
      clientesTotal: 0,
      clientesActivos: 0,
      clientesConGps: 0,
      promotoras: 0,
      supervisores: 0,
      vendedores: 0,
      cadenas: 0,
      zonas: 0,
    });
  }

  for (const c of params.clientes) {
    const code = resolveCode(c);
    if (!code) continue;
    const b = buckets.get(code)!;
    b.clientesTotal += 1;
    if (c.activo) {
      b.clientesActivos += 1;
      if (c.latitud !== null && c.longitud !== null) {
        b.clientesConGps += 1;
      }
    }
  }
  for (const p of params.promotoras) {
    if (!p.activo) continue;
    const code = resolveCode(p);
    if (code) buckets.get(code)!.promotoras += 1;
  }
  for (const s of params.supervisores) {
    if (!s.activo) continue;
    const code = resolveCode(s);
    if (code) buckets.get(code)!.supervisores += 1;
  }
  for (const v of params.vendedores) {
    if (!v.activo) continue;
    const code = resolveCode(v);
    if (code) buckets.get(code)!.vendedores += 1;
  }
  for (const cad of params.cadenas) {
    if (!cad.activo) continue;
    const code = resolveCode(cad);
    if (code) buckets.get(code)!.cadenas += 1;
  }
  for (const z of params.zonas) {
    if (!z.activo) continue;
    const code = resolveCode(z);
    if (code) buckets.get(code)!.zonas += 1;
  }

  return ALLOWED_REGIONS.map((code) => buckets.get(code)!);
}

export function computeClientesSummaryBySede(
  clientes: readonly ClienteConVendedor[],
  vendedores?: readonly Vendedor[]
): SedeClientCountSummary[] {
  const sedes: SucursalMaestro[] = ['ZULIA', 'VALENCIA', 'CENTRO', 'CAPITAL', 'ORIENTE'];
  const map = new Map<
    SucursalMaestro,
    { total: number; activos: number; inactivos: number; vendedoresActivos: number; zonas: Set<string> }
  >();
  for (const s of sedes) {
    map.set(s, { total: 0, activos: 0, inactivos: 0, vendedoresActivos: 0, zonas: new Set<string>() });
  }

  for (const c of clientes) {
    if (!c.sucursal) continue;
    const bucket = map.get(c.sucursal);
    if (!bucket) continue;
    bucket.total += 1;
    if (c.activo) {
      bucket.activos += 1;
      if (c.zona) bucket.zonas.add(c.zona);
    } else {
      bucket.inactivos += 1;
    }
  }

  for (const v of vendedores ?? []) {
    if (!v.sucursal || !v.activo) continue;
    const bucket = map.get(v.sucursal);
    if (bucket) bucket.vendedoresActivos += 1;
  }

  return sedes.map((sucursal) => {
    const b = map.get(sucursal)!;
    return {
      sucursal,
      total: b.total,
      activos: b.activos,
      inactivos: b.inactivos,
      ...(vendedores ? { vendedoresActivos: b.vendedoresActivos } : {}),
      zonas: Array.from(b.zonas).sort((a, bZona) => a.localeCompare(bZona, 'es')),
    };
  });
}
