import type { ClientGeoRecord, Entrega, GeoPoint, GeoPrecision, GeoSource } from '../types';

export interface ResolvedDeliveryGeo {
  lat: number | null;
  lng: number | null;
  geo_source: GeoSource;
  geo_precision: GeoPrecision;
  matchedLabel?: string;
}

export interface AtlasEntry {
  key: string;
  tokens: string[];
  lat: number;
  lng: number;
  label: string;
  sucursalHint?: 'CENTRO' | 'OCCIDENTE';
}

/**
 * Límites geográficos válidos para Venezuela continental e insular.
 * Descarta coordenadas nulas, (0, 0), NaN o corruptas fuera del territorio operativo.
 */
export function isValidVenezuelaCoord(lat: unknown, lng: unknown): boolean {
  const nLat = typeof lat === 'number' ? lat : Number(lat);
  const nLng = typeof lng === 'number' ? lng : Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return false;
  if (Math.abs(nLat) < 0.001 && Math.abs(nLng) < 0.001) return false;
  return nLat >= 0.6 && nLat <= 12.6 && nLng >= -73.5 && nLng <= -59.5;
}

const COMPANY_NOISE_REGEX =
  /\b(C\.?\s*A\.?|S\.?\s*A\.?|S\.?\s*R\.?\s*L\.?|F\.?\s*P\.?|COMPANIA|ANONIMA|COMPAÑIA|SOCIEDAD|COMERCIALIZADORA|DISTRIBUIDORA|INVERSIONES|CORPORACION|ALIMENTOS|SUPERMERCADO|AUTOMERCADO|HYPER|HIPERMERCADO|DE|DEL|LA|EL|LOS|LAS|Y)\b/g;

/** Normaliza texto para comparación tolerante a acentos, comillas y puntuación. */
export function normalizeGeoText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/["'`´.,;:()[\]{}\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeGeoCore(raw: unknown): string {
  return normalizeGeoText(raw)
    .replace(COMPANY_NOISE_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeClientCode(raw: unknown): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function canonicalBranchHint(raw: unknown): 'CENTRO' | 'OCCIDENTE' | null {
  const s = normalizeGeoText(raw);
  if (!s) return null;
  if (s.includes('ZULIA') || s.includes('OCCIDENTE') || s.includes('MARACAIBO')) return 'OCCIDENTE';
  if (
    s.includes('CENTRO') ||
    s.includes('VALENCIA') ||
    s.includes('CARABOBO') ||
    s.includes('ARAGUA') ||
    s.includes('MARACAY') ||
    s.includes('CARACAS') ||
    s.includes('CAPITAL')
  ) {
    return 'CENTRO';
  }
  return null;
}

/**
 * Atlas offline integrado de puntos retail frecuentes y localidades venezolanas de CODIZULCA.
 * Garantiza precisión de ruteo y mapa incluso cuando un PDV de cadena (p. ej. MAKRO) no posee
 * coordenada individual en `public."Clientes"` o cuando el chofer opera 100 % sin conexión.
 */
export const VENEZUELA_ZONE_ATLAS: readonly AtlasEntry[] = [
  // Puntos específicos de cadenas frecuentes (Centro / Aragua / Carabobo / Capital)
  {
    key: 'MAKRO_SAN_DIEGO',
    tokens: ['MAKRO', 'SAN DIEGO'],
    lat: 10.2238,
    lng: -67.9635,
    label: 'Makro San Diego, Carabobo',
    sucursalHint: 'CENTRO',
  },
  {
    key: 'MAKRO_MANANTIAL',
    tokens: ['MAKRO', 'MANANTIAL'],
    lat: 10.2512,
    lng: -68.0079,
    label: 'Makro / El Manantial, Naguanagua',
    sucursalHint: 'CENTRO',
  },
  {
    key: 'MAKRO_NAGUANAGUA',
    tokens: ['MAKRO', 'NAGUANAGUA'],
    lat: 10.2512,
    lng: -68.0079,
    label: 'Makro Naguanagua, Carabobo',
    sucursalHint: 'CENTRO',
  },
  {
    key: 'MAKRO_TURMERO',
    tokens: ['MAKRO', 'TURMERO'],
    lat: 10.2248,
    lng: -67.4981,
    label: 'Makro Intercomunal Turmero-Maracay',
    sucursalHint: 'CENTRO',
  },
  {
    key: 'MAKRO_EL_SAMAN',
    tokens: ['MAKRO', 'EL SAMAN'],
    lat: 10.2219,
    lng: -67.5718,
    label: 'Makro El Samán, Maracay',
    sucursalHint: 'CENTRO',
  },
  {
    key: 'MAKRO_VALENCIA',
    tokens: ['MAKRO', 'VALENCIA'],
    lat: 10.1816,
    lng: -67.9718,
    label: 'Makro Zona Industrial Valencia',
    sucursalHint: 'CENTRO',
  },
  {
    key: 'MAKRO_MARACAIBO',
    tokens: ['MAKRO', 'MARACAIBO'],
    lat: 10.6762,
    lng: -71.6358,
    label: 'Makro Maracaibo, Zulia',
    sucursalHint: 'OCCIDENTE',
  },

  // Zonas y sectores específicos de Carabobo y Aragua (Centro)
  { key: 'EL_SAMAN_MARACAY', tokens: ['EL SAMAN', 'MARACAY'], lat: 10.2219, lng: -67.5718, label: 'El Samán, Maracay', sucursalHint: 'CENTRO' },
  { key: 'TURMERO_MARACAY', tokens: ['TURMERO', 'MARACAY'], lat: 10.2286, lng: -67.4742, label: 'Intercomunal Turmero-Maracay', sucursalHint: 'CENTRO' },
  { key: 'MANANTIAL_NAGUANAGUA', tokens: ['MANANTIAL'], lat: 10.2512, lng: -68.0079, label: 'El Manantial, Naguanagua', sucursalHint: 'CENTRO' },
  { key: 'SAN_DIEGO', tokens: ['SAN DIEGO'], lat: 10.2564, lng: -67.9539, label: 'San Diego, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'NAGUANAGUA', tokens: ['NAGUANAGUA'], lat: 10.2588, lng: -68.0127, label: 'Naguanagua, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'GUACARA', tokens: ['GUACARA'], lat: 10.2261, lng: -67.8770, label: 'Guacara, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'LOS_GUAYOS', tokens: ['LOS GUAYOS'], lat: 10.1894, lng: -67.9372, label: 'Los Guayos, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'PARAPARAL', tokens: ['PARAPARAL'], lat: 10.1726, lng: -67.9439, label: 'Paraparal, Los Guayos', sucursalHint: 'CENTRO' },
  { key: 'TOCUYITO', tokens: ['TOCUYITO'], lat: 10.1140, lng: -68.0680, label: 'Tocuyito, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'PUERTO_CABELLO', tokens: ['PUERTO CABELLO'], lat: 10.4731, lng: -68.0125, label: 'Puerto Cabello, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'BEJUMA', tokens: ['BEJUMA'], lat: 10.1731, lng: -68.2594, label: 'Bejuma, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'MARIARA', tokens: ['MARIARA'], lat: 10.2962, lng: -67.7181, label: 'Mariara, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'VALENCIA', tokens: ['VALENCIA'], lat: 10.1620, lng: -68.0077, label: 'Valencia, Carabobo', sucursalHint: 'CENTRO' },
  { key: 'CARABOBO', tokens: ['CARABOBO'], lat: 10.1820, lng: -67.9977, label: 'Carabobo', sucursalHint: 'CENTRO' },
  { key: 'TURMERO', tokens: ['TURMERO'], lat: 10.2286, lng: -67.4742, label: 'Turmero, Aragua', sucursalHint: 'CENTRO' },
  { key: 'CAGUA', tokens: ['CAGUA'], lat: 10.1863, lng: -67.4594, label: 'Cagua, Aragua', sucursalHint: 'CENTRO' },
  { key: 'LA_VICTORIA', tokens: ['LA VICTORIA'], lat: 10.2278, lng: -67.3312, label: 'La Victoria, Aragua', sucursalHint: 'CENTRO' },
  { key: 'VILLA_DE_CURA', tokens: ['VILLA DE CURA'], lat: 10.0386, lng: -67.4894, label: 'Villa de Cura, Aragua', sucursalHint: 'CENTRO' },
  { key: 'LA_BARRACA', tokens: ['LA BARRACA'], lat: 10.2442, lng: -67.5815, label: 'La Barraca, Maracay', sucursalHint: 'CENTRO' },
  { key: 'MARACAY', tokens: ['MARACAY'], lat: 10.2469, lng: -67.5958, label: 'Maracay, Aragua', sucursalHint: 'CENTRO' },
  { key: 'ARAGUA', tokens: ['ARAGUA'], lat: 10.2350, lng: -67.5910, label: 'Aragua', sucursalHint: 'CENTRO' },

  // Gran Caracas / Miranda / La Guaira (Centro-Capital)
  { key: 'CARICUAO', tokens: ['CARICUAO'], lat: 10.4316, lng: -66.9794, label: 'Caricuao, Caracas', sucursalHint: 'CENTRO' },
  { key: 'LA_CANDELARIA', tokens: ['LA CANDELARIA'], lat: 10.5061, lng: -66.9039, label: 'La Candelaria, Caracas', sucursalHint: 'CENTRO' },
  { key: 'CHACAO', tokens: ['CHACAO'], lat: 10.4959, lng: -66.8535, label: 'Chacao, Caracas', sucursalHint: 'CENTRO' },
  { key: 'BARUTA', tokens: ['BARUTA'], lat: 10.4342, lng: -66.8756, label: 'Baruta, Caracas', sucursalHint: 'CENTRO' },
  { key: 'EL_HATILLO', tokens: ['EL HATILLO'], lat: 10.4240, lng: -66.8260, label: 'El Hatillo, Miranda', sucursalHint: 'CENTRO' },
  { key: 'PETARE', tokens: ['PETARE'], lat: 10.4767, lng: -66.8017, label: 'Petare, Miranda', sucursalHint: 'CENTRO' },
  { key: 'CATIA', tokens: ['CATIA'], lat: 10.5149, lng: -66.9436, label: 'Catia, Caracas', sucursalHint: 'CENTRO' },
  { key: 'GUARENAS', tokens: ['GUARENAS'], lat: 10.4703, lng: -66.6064, label: 'Guarenas, Miranda', sucursalHint: 'CENTRO' },
  { key: 'GUATIRE', tokens: ['GUATIRE'], lat: 10.4762, lng: -66.5427, label: 'Guatire, Miranda', sucursalHint: 'CENTRO' },
  { key: 'LOS_TEQUES', tokens: ['LOS TEQUES'], lat: 10.3445, lng: -67.0433, label: 'Los Teques, Miranda', sucursalHint: 'CENTRO' },
  { key: 'CHARALLAVE', tokens: ['CHARALLAVE'], lat: 10.2425, lng: -66.8572, label: 'Charallave, Miranda', sucursalHint: 'CENTRO' },
  { key: 'LA_GUAIRA', tokens: ['LA GUAIRA'], lat: 10.5990, lng: -66.9331, label: 'La Guaira', sucursalHint: 'CENTRO' },
  { key: 'CARACAS', tokens: ['CARACAS'], lat: 10.4806, lng: -66.9036, label: 'Caracas, Distrito Capital', sucursalHint: 'CENTRO' },

  // Occidente / Zulia / Falcón / Lara / Andes
  { key: 'MARACAIBO_NORTE', tokens: ['MARACAIBO', 'NORTE'], lat: 10.7065, lng: -71.6225, label: 'Maracaibo Norte, Zulia', sucursalHint: 'OCCIDENTE' },
  { key: 'SAN_FRANCISCO', tokens: ['SAN FRANCISCO'], lat: 10.5994, lng: -71.6327, label: 'San Francisco, Zulia', sucursalHint: 'OCCIDENTE' },
  { key: 'MARACAIBO', tokens: ['MARACAIBO'], lat: 10.6545, lng: -71.6373, label: 'Maracaibo, Zulia', sucursalHint: 'OCCIDENTE' },
  { key: 'CABIMAS', tokens: ['CABIMAS'], lat: 10.3910, lng: -71.4480, label: 'Cabimas, Zulia', sucursalHint: 'OCCIDENTE' },
  { key: 'CIUDAD_OJEDA', tokens: ['CIUDAD OJEDA'], lat: 10.2008, lng: -71.3082, label: 'Ciudad Ojeda, Zulia', sucursalHint: 'OCCIDENTE' },
  { key: 'LAGUNILLAS', tokens: ['LAGUNILLAS'], lat: 10.1301, lng: -71.2595, label: 'Lagunillas, Zulia', sucursalHint: 'OCCIDENTE' },
  { key: 'MACHIQUES', tokens: ['MACHIQUES'], lat: 10.0644, lng: -72.5450, label: 'Machiques, Zulia', sucursalHint: 'OCCIDENTE' },
  { key: 'ZULIA', tokens: ['ZULIA'], lat: 10.6427, lng: -71.6125, label: 'Zulia', sucursalHint: 'OCCIDENTE' },
  { key: 'PUNTO_FIJO', tokens: ['PUNTO FIJO'], lat: 11.6956, lng: -70.1996, label: 'Punto Fijo, Falcón', sucursalHint: 'OCCIDENTE' },
  { key: 'CORO', tokens: ['CORO'], lat: 11.4045, lng: -69.6734, label: 'Coro, Falcón', sucursalHint: 'OCCIDENTE' },
  { key: 'BARQUISIMETO', tokens: ['BARQUISIMETO'], lat: 10.0678, lng: -69.3474, label: 'Barquisimeto, Lara', sucursalHint: 'CENTRO' },
  { key: 'CABUDARE', tokens: ['CABUDARE'], lat: 10.0329, lng: -69.2617, label: 'Cabudare, Lara', sucursalHint: 'CENTRO' },
  { key: 'SAN_FELIPE', tokens: ['SAN FELIPE'], lat: 10.3399, lng: -68.7425, label: 'San Felipe, Yaracuy', sucursalHint: 'CENTRO' },
  { key: 'SAN_CARLOS', tokens: ['SAN CARLOS'], lat: 9.6612, lng: -68.5827, label: 'San Carlos, Cojedes', sucursalHint: 'CENTRO' },
  { key: 'VALERA', tokens: ['VALERA'], lat: 9.3178, lng: -70.6036, label: 'Valera, Trujillo', sucursalHint: 'OCCIDENTE' },
  { key: 'MERIDA', tokens: ['MERIDA'], lat: 8.5897, lng: -71.1561, label: 'Mérida', sucursalHint: 'OCCIDENTE' },
  { key: 'SAN_CRISTOBAL', tokens: ['SAN CRISTOBAL'], lat: 7.7669, lng: -72.2250, label: 'San Cristóbal, Táchira', sucursalHint: 'OCCIDENTE' },
  { key: 'BARINAS', tokens: ['BARINAS'], lat: 8.6226, lng: -70.2075, label: 'Barinas', sucursalHint: 'OCCIDENTE' },

  // Oriente
  { key: 'PUERTO_LA_CRUZ', tokens: ['PUERTO LA CRUZ'], lat: 10.2138, lng: -64.6328, label: 'Puerto La Cruz, Anzoátegui', sucursalHint: 'CENTRO' },
  { key: 'BARCELONA', tokens: ['BARCELONA'], lat: 10.1362, lng: -64.6862, label: 'Barcelona, Anzoátegui', sucursalHint: 'CENTRO' },
  { key: 'LECHERIA', tokens: ['LECHERIA'], lat: 10.1938, lng: -64.6946, label: 'Lechería, Anzoátegui', sucursalHint: 'CENTRO' },
  { key: 'MATURIN', tokens: ['MATURIN'], lat: 9.7457, lng: -63.1832, label: 'Maturín, Monagas', sucursalHint: 'CENTRO' },
  { key: 'PUERTO_ORDAZ', tokens: ['PUERTO ORDAZ'], lat: 8.2974, lng: -62.7115, label: 'Puerto Ordaz, Bolívar', sucursalHint: 'CENTRO' },
  { key: 'PORLAMAR', tokens: ['PORLAMAR'], lat: 10.9577, lng: -63.8491, label: 'Porlamar, Nueva Esparta', sucursalHint: 'CENTRO' },
];

export interface ClientGeoIndex {
  byCode: Map<string, ClientGeoRecord>;
  byExactName: Map<string, ClientGeoRecord[]>;
  byCoreName: Map<string, ClientGeoRecord[]>;
  all: Array<ClientGeoRecord & { normName: string; coreName: string; tokens: string[]; branch: 'CENTRO' | 'OCCIDENTE' | null }>;
}

/** Pre-indexa el catálogo offline de `Clientes` para resolver cientos de paradas en < 1 ms. */
export function buildClientGeoIndex(records: readonly ClientGeoRecord[]): ClientGeoIndex {
  const byCode = new Map<string, ClientGeoRecord>();
  const byExactName = new Map<string, ClientGeoRecord[]>();
  const byCoreName = new Map<string, ClientGeoRecord[]>();
  const all: ClientGeoIndex['all'] = [];

  for (const raw of records) {
    if (!raw || !isValidVenezuelaCoord(raw.clie_lati, raw.clie_long)) continue;
    const rec: ClientGeoRecord = {
      id_clie: String(raw.id_clie ?? ''),
      clie_nomb: String(raw.clie_nomb ?? ''),
      clie_rif: raw.clie_rif ?? null,
      clie_lati: Number(raw.clie_lati),
      clie_long: Number(raw.clie_long),
      sucursal: raw.sucursal ?? null,
    };

    const code = normalizeClientCode(rec.clie_rif);
    if (code && !byCode.has(code)) byCode.set(code, rec);

    const normName = normalizeGeoText(rec.clie_nomb);
    const coreName = normalizeGeoCore(rec.clie_nomb);
    const tokens = coreName.split(' ').filter((t) => t.length >= 2);
    const branch = canonicalBranchHint(rec.sucursal);

    if (normName) {
      const list = byExactName.get(normName) ?? [];
      list.push(rec);
      byExactName.set(normName, list);
    }
    if (coreName) {
      const list = byCoreName.get(coreName) ?? [];
      list.push(rec);
      byCoreName.set(coreName, list);
    }
    all.push({ ...rec, normName, coreName, tokens, branch });
  }

  return { byCode, byExactName, byCoreName, all };
}

function pickBestCandidate(
  candidates: readonly ClientGeoRecord[],
  targetBranch: 'CENTRO' | 'OCCIDENTE' | null,
): ClientGeoRecord {
  if (candidates.length === 1 || !targetBranch) return candidates[0];
  return (
    candidates.find((c) => canonicalBranchHint(c.sucursal) === targetBranch) ??
    candidates[0]
  );
}

/**
 * Resuelve la ubicación GPS más precisa disponible para una entrega sin requerir red:
 *   0) Pin GPS fijado manualmente por el chofer (IndexedDB).
 *   1) Match contra catálogo real `public."Clientes"` (código/RIF, nombre exacto o similitud de tokens).
 *   2) Atlas offline de cadenas/zonas de Venezuela (usa `cliente` + `zona_direccion`).
 *   3) Respaldo limpio `sin_gps` (nunca lanza error al seleccionar un cliente).
 */
export function resolveEntregaCoordinates(
  entrega: Pick<
    Entrega,
    'id' | 'cliente' | 'zona_direccion' | 'cliente_codigo' | 'sucursal' | 'region' | 'chofer_sede' | 'lat' | 'lng' | 'geo_source' | 'geo_precision'
  >,
  index: ClientGeoIndex | null,
  manualPins?: Readonly<Record<string, GeoPoint>>,
): ResolvedDeliveryGeo {
  // 0) Pin GPS manual del chofer
  const manual = manualPins?.[entrega.id];
  if (manual && isValidVenezuelaCoord(manual.lat, manual.lng)) {
    return {
      lat: manual.lat,
      lng: manual.lng,
      geo_source: 'manual_gps',
      geo_precision: 'manual',
      matchedLabel: 'GPS fijado por chofer',
    };
  }

  // Si la entrega ya trae una coordenada exacta válida persistida y no hay índice más nuevo
  if (
    entrega.geo_source === 'clientes_erp' &&
    isValidVenezuelaCoord(entrega.lat, entrega.lng)
  ) {
    return {
      lat: Number(entrega.lat),
      lng: Number(entrega.lng),
      geo_source: 'clientes_erp',
      geo_precision: 'exacta',
    };
  }

  const targetBranch = canonicalBranchHint(
    entrega.sucursal || entrega.region || entrega.chofer_sede,
  );
  const normCliente = normalizeGeoText(entrega.cliente);
  const coreCliente = normalizeGeoCore(entrega.cliente);
  const normZona = normalizeGeoText(entrega.zona_direccion);

  // 1) Coincidencia con catálogo ERP `public."Clientes"`
  if (index) {
    const code = normalizeClientCode(entrega.cliente_codigo);
    if (code) {
      const byCodeHit = index.byCode.get(code);
      if (byCodeHit) {
        return {
          lat: byCodeHit.clie_lati,
          lng: byCodeHit.clie_long,
          geo_source: 'clientes_erp',
          geo_precision: 'exacta',
          matchedLabel: byCodeHit.clie_nomb,
        };
      }
    }

    if (normCliente) {
      const exactHits = index.byExactName.get(normCliente);
      if (exactHits && exactHits.length > 0) {
        const hit = pickBestCandidate(exactHits, targetBranch);
        return {
          lat: hit.clie_lati,
          lng: hit.clie_long,
          geo_source: 'clientes_erp',
          geo_precision: 'exacta',
          matchedLabel: hit.clie_nomb,
        };
      }
    }

    if (coreCliente && coreCliente.length >= 4) {
      const coreHits = index.byCoreName.get(coreCliente);
      if (coreHits && coreHits.length > 0) {
        const hit = pickBestCandidate(coreHits, targetBranch);
        return {
          lat: hit.clie_lati,
          lng: hit.clie_long,
          geo_source: 'clientes_erp',
          geo_precision: 'exacta',
          matchedLabel: hit.clie_nomb,
        };
      }

      // Similitud controlada por tokens (evita falsos positivos con cadenas genéricas como "MAKRO")
      const queryTokens = coreCliente.split(' ').filter((t) => t.length >= 3);
      if (queryTokens.length > 0 && coreCliente !== 'MAKRO') {
        let bestScore = 0;
        let bestRec: ClientGeoRecord | null = null;
        for (const cand of index.all) {
          if (targetBranch && cand.branch && cand.branch !== targetBranch) continue;
          if (cand.tokens.length === 0) continue;

          // Match rápido por prefijo/subcadena para nombres truncados en cronograma (ej. "ALIMENTOS CORPOINDUSTRI")
          let score = 0;
          if (cand.coreName.startsWith(coreCliente) || coreCliente.startsWith(cand.coreName)) {
            const ratio =
              Math.min(cand.coreName.length, coreCliente.length) /
              Math.max(cand.coreName.length, coreCliente.length);
            score = Math.max(score, ratio >= 0.72 ? 0.85 + ratio * 0.1 : 0);
          }

          let matched = 0;
          for (const qt of queryTokens) {
            if (cand.tokens.some((ct) => ct === qt || (qt.length >= 5 && ct.startsWith(qt)))) {
              matched += 1;
            }
          }
          const overlap = matched / Math.max(queryTokens.length, cand.tokens.length);
          score = Math.max(score, overlap);

          if (score > bestScore) {
            bestScore = score;
            bestRec = cand;
          }
        }
        if (bestRec && bestScore >= 0.78) {
          return {
            lat: bestRec.clie_lati,
            lng: bestRec.clie_long,
            geo_source: 'clientes_erp',
            geo_precision: 'exacta',
            matchedLabel: bestRec.clie_nomb,
          };
        }
      }
    }
  }

  // 2) Atlas offline de puntos retail y zonas venezolanas (combina cliente + zona_direccion)
  const combined = `${normCliente} ${normZona}`.trim();
  if (combined) {
    let bestAtlas: AtlasEntry | null = null;
    let bestWeight = -1;

    for (const entry of VENEZUELA_ZONE_ATLAS) {
      const allMatch = entry.tokens.every((tok) => combined.includes(tok));
      if (!allMatch) continue;
      // Priorizar entradas más específicas (más tokens y mayor longitud de coincidencia) + misma sucursal
      const branchBonus = targetBranch && entry.sucursalHint === targetBranch ? 25 : 0;
      const specificity = entry.tokens.length * 100 + entry.tokens.join('').length + branchBonus;
      if (specificity > bestWeight) {
        bestWeight = specificity;
        bestAtlas = entry;
      }
    }

    if (bestAtlas) {
      return {
        lat: bestAtlas.lat,
        lng: bestAtlas.lng,
        geo_source: 'zona_atlas',
        geo_precision: 'zona',
        matchedLabel: bestAtlas.label,
      };
    }
  }

  // Si ya tenía alguna coordenada válida previa, preservarla antes de caer a sin_gps
  if (isValidVenezuelaCoord(entrega.lat, entrega.lng)) {
    return {
      lat: Number(entrega.lat),
      lng: Number(entrega.lng),
      geo_source: entrega.geo_source ?? 'zona_atlas',
      geo_precision: entrega.geo_precision ?? 'zona',
    };
  }

  return {
    lat: null,
    lng: null,
    geo_source: 'none',
    geo_precision: 'sin_gps',
  };
}

/** Normaliza filas crudas de `public."Clientes"` o de shift-link bootstrap hacia `ClientGeoRecord[]`. */
export function normalizeRawClientGeoRows(rows: readonly Record<string, unknown>[]): ClientGeoRecord[] {
  const out: ClientGeoRecord[] = [];
  for (const r of rows) {
    const lat = Number(r.clie_lati ?? r.latitud ?? r.lat);
    const lng = Number(r.clie_long ?? r.longitud ?? r.lng);
    if (!isValidVenezuelaCoord(lat, lng)) continue;
    out.push({
      id_clie: String(r.id_clie ?? r.id ?? ''),
      clie_nomb: String(r.clie_nomb ?? r.nombre ?? r.cliente ?? '').trim(),
      clie_rif: typeof r.clie_rif === 'string' ? r.clie_rif : typeof r.codigo === 'string' ? r.codigo : null,
      clie_lati: lat,
      clie_long: lng,
      sucursal: typeof r.sucursal === 'string' ? r.sucursal : null,
    });
  }
  return out;
}
