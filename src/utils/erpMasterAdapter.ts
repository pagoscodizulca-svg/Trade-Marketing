import type {
  AllowedRegionCode,
  CanalClienteMaestro,
  ClienteConVendedor,
  FiltrosConsultaClientes,
  FiltrosConsultaVendedores,
  SucursalMaestro,
  Vendedor,
} from '../types/masterData';

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
}

export interface SedeClientCountSummary {
  sucursal: SucursalMaestro;
  total: number;
  activos: number;
  inactivos: number;
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

/**
 * Transforma la tabla real `"Vendedores"` (y sus tablas relacionadas `"Sucursales"`,
 * `"Supervisores"`, `"Regiones"`) al modelo canónico `Vendedor[]` de Trade Marketing.
 */
export function normalizeErpVendedoresDataset(dataset: Pick<
  ErpMasterDataset,
  'regiones' | 'sucursales' | 'supervisores' | 'vendedores'
>): Vendedor[] {
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

  const result: Vendedor[] = [];
  for (const v of dataset.vendedores) {
    if (!v?.id_vend) continue;
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

    const nombre = cleanText(v.vend_nomb) || `Vendedor ${cleanText(v.vend_codi) || v.id_vend.slice(0, 6)}`;
    const codigo = cleanText(v.vend_codi) || v.id_vend.slice(0, 8).toUpperCase();
    const createdAt = v.created_at || new Date().toISOString();

    result.push({
      id: String(v.id_vend),
      codigo_vendedor: codigo,
      nombre_completo: nombre,
      documento_identidad: null,
      telefono: cleanText(v.vend_cont) || null,
      email: null,
      zona: sucuDesc || regionDesc || null,
      supervisor: supeName,
      sucursal: operativeSucursal,
      region_id: regionId ? String(regionId) : null,
      activo: v.vend_acti !== false,
      metadata: {
        source: 'supabase_erp_vendedores',
        sucursal_erp: sucuDesc || null,
        region_codigo: normalizeErpRegionCode(regionDesc),
        supervisor_id: v.id_supe ?? null,
      },
      ultima_sincronizacion: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  result.sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es'));
  return result;
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

    const latitud = parseFiniteCoord(c.clie_lati, -90, 90);
    const longitud = parseFiniteCoord(c.clie_long, -180, 180);
    const createdAt = c.created_at || new Date().toISOString();

    const vendCode = cleanText(vend?.vend_codi) || null;
    const vendName = cleanText(vend?.vend_nomb) || null;

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
      cadena_id: null,
      zona_id: null,
      supervisor_id: vend?.id_supe ? String(vend.id_supe) : null,
      region_id: regionId ? String(regionId) : null,
      radio_geocerca_m: 150,
      sucursal: operativeSucursal,
      vendedor_id: c.id_vend ? String(c.id_vend) : null,
      codigo_vendedor: vendCode,
      activo: c.clie_acti !== false,
      metadata: {
        source: 'supabase_erp_clientes',
        region_codigo: normalizeErpRegionCode(regDesc),
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
    if (regionFiltro) {
      const metaRegion = normalizeErpRegionCode(c.metadata?.region_codigo);
      if (metaRegion && metaRegion !== regionFiltro) return false;
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
  const zonaFiltro = normalizeToken(filtros.zona);
  const supervisorFiltro = normalizeToken(filtros.supervisor);
  const busqueda = cleanText(filtros.busqueda);

  return vendedores.filter((v) => {
    if (soloActivos && v.activo !== true) return false;
    if (sucursalFiltro && v.sucursal !== sucursalFiltro) return false;
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

export function computeClientesSummaryBySede(
  clientes: readonly ClienteConVendedor[]
): SedeClientCountSummary[] {
  const sedes: SucursalMaestro[] = ['ZULIA', 'VALENCIA', 'CENTRO', 'CAPITAL', 'ORIENTE'];
  const map = new Map<
    SucursalMaestro,
    { total: number; activos: number; inactivos: number; zonas: Set<string> }
  >();
  for (const s of sedes) {
    map.set(s, { total: 0, activos: 0, inactivos: 0, zonas: new Set<string>() });
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

  return sedes.map((sucursal) => {
    const b = map.get(sucursal)!;
    return {
      sucursal,
      total: b.total,
      activos: b.activos,
      inactivos: b.inactivos,
      zonas: Array.from(b.zonas).sort((a, bZona) => a.localeCompare(bZona, 'es')),
    };
  });
}
