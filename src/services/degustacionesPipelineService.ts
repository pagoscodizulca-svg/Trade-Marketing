import type { Store } from '../types';
import type {
  ArchivoPlanificacionExtension,
  CargaArchivoRecord,
  FilaDegustacionExtraida,
  InsumosCalculadosDegustacion,
  MetodoExtraccionArchivo,
  NivelValidacionFilaCarga,
  ResultadoVolcadoLoteCronograma,
} from '../types/degustacionesPipeline';
import {
  computeDegustacionIdempotencyHash,
  normalizeCanonicalToken,
  normalizeHora24,
} from '../utils/degustacionIdempotency';
import type { RawExtractedDegustacionRow } from '../utils/degustacionesTabularParser';
import {
  MAX_IMPORT_ROWS,
  parseFechaCronograma,
  resolveScheduleWindow,
  sanitizeCellText,
} from '../utils/degustacionesTabularParser';
import {
  excelDateParser,
  formatExcelRowDateError,
  isDangerousObjectKey,
} from '../utils/excelDateParser';
import { calculateProductionSupplies } from '../utils/productionSuppliesCalculator';
import {
  getSupabaseCoordinatorClient,
  isSupabaseConfigured,
} from './supabaseClient';
import type { StaffMemberRecord } from './supabaseModule1';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;

export interface CatalogPdvEntry {
  canonicalKey: string;
  name: string;
  clientCode: string;
  zone: string;
  address: string;
}

export interface ActivePromotoraOption {
  id: string;
  name: string;
  canonicalKey: string;
  email: string;
  assignedStore: string;
}

export interface PromotoraCatalogMatchResult {
  match: ActivePromotoraOption | null;
  isUnassignedPlaceholder: boolean;
  isAmbiguous: boolean;
  rawClean: string;
}

function normalizePromotoraSearchKey(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Construye el catálogo unificado de Puntos de Venta (PDV) reales sincronizados en la aplicación.
 * Nunca inyecta tiendas ficticias.
 */
export function buildKnownPdvCatalog(params: {
  stores?: Store[];
  syncedStoreNames?: Array<{
    name: string;
    clientCode?: string;
    zone?: string;
    address?: string;
  }>;
}): CatalogPdvEntry[] {
  const byKey = new Map<string, CatalogPdvEntry>();

  const register = (rawName?: string, clientCode?: string, zone?: string, address?: string) => {
    const cleanName = sanitizeCellText(rawName);
    if (!cleanName || /^PDV SIN NOMBRE$/i.test(cleanName)) return;
    const key = normalizeCanonicalToken(cleanName);
    if (!key) return;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        canonicalKey: key,
        name: cleanName,
        clientCode: sanitizeCellText(clientCode, 80),
        zone: sanitizeCellText(zone),
        address: sanitizeCellText(address),
      });
    } else {
      if (!existing.clientCode && clientCode) existing.clientCode = sanitizeCellText(clientCode, 80);
      if (!existing.zone && zone) existing.zone = sanitizeCellText(zone);
      if (!existing.address && address) existing.address = sanitizeCellText(address);
    }
  };

  for (const s of params.stores || []) {
    register(s.name, s.clientCode, s.zone, s.address);
  }
  for (const item of params.syncedStoreNames || []) {
    register(item.name, item.clientCode, item.zone, item.address);
  }

  return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/**
 * Construye el padrón de promotoras activas reales en `public.staff` (excluyendo inactivas y perfiles de merchandising).
 * Solo acepta registros con UUID válido para preservar integridad de llave foránea.
 */
export function buildActivePromotoraCatalog(
  staffMembers?: StaffMemberRecord[]
): ActivePromotoraOption[] {
  const list: ActivePromotoraOption[] = [];
  const seenIds = new Set<string>();

  for (const member of staffMembers || []) {
    if (member.status !== 'Activo') continue;
    if (member.roleCategory !== 'PROMOTORA') continue;
    const id = String(member.id || '').trim();
    const name = sanitizeCellText(member.name, 120);
    if (!id || !UUID_REGEX.test(id) || !name || seenIds.has(id)) continue;
    seenIds.add(id);

    list.push({
      id,
      name,
      canonicalKey: normalizePromotoraSearchKey(name),
      email: sanitizeCellText(member.email, 150),
      assignedStore: sanitizeCellText(member.assignedStore),
    });
  }

  return list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/**
 * Emparejamiento determinista contra el Catálogo Activo de promotoras (`matchPromotoraCatalogo`):
 * 1) Normaliza quitando tildes (`NFD`), mayúsculas y limpiando puntuación/espacios.
 * 2) Busca coincidencia exacta del nombre completo.
 * 3) Si no hay exacta, busca coincidencia ÚNICA por primer nombre o por tokens completos en el Catálogo Activo.
 * 4) Si está vacía, no existe o es ambigua entre homónimas, devuelve `match: null` para pase limpio "Por asignar" a Módulo 2.
 */
export function matchPromotoraCatalogo(
  rawPromotora: string | null | undefined,
  promotoraCatalog: ActivePromotoraOption[]
): PromotoraCatalogMatchResult {
  const sanitized = sanitizeCellText(rawPromotora, 120);
  const rawClean = normalizePromotoraSearchKey(sanitized);

  if (
    !rawClean ||
    /^(POR ASIGNAR|SIN ASIGNAR|PENDIENTE|POR DEFINIR|NA|N A|NINGUNA)$/.test(rawClean) ||
    rawClean.startsWith('POR ASIGNAR')
  ) {
    return {
      match: null,
      isUnassignedPlaceholder: true,
      isAmbiguous: false,
      rawClean: '',
    };
  }

  // 1. Coincidencia exacta de nombre completo normalizado
  const exactMatches = promotoraCatalog.filter(
    (p) => normalizePromotoraSearchKey(p.name) === rawClean
  );
  if (exactMatches.length === 1) {
    return {
      match: exactMatches[0]!,
      isUnassignedPlaceholder: false,
      isAmbiguous: false,
      rawClean,
    };
  }
  if (exactMatches.length > 1) {
    return {
      match: null,
      isUnassignedPlaceholder: false,
      isAmbiguous: true,
      rawClean,
    };
  }

  const inputTokens = rawClean.split(' ').filter((t) => t.length >= 2);
  if (inputTokens.length === 0) {
    return {
      match: null,
      isUnassignedPlaceholder: false,
      isAmbiguous: false,
      rawClean,
    };
  }

  // 2. Si viene 1 solo token (ej. "JULIANNYS", "MARIANGEL"), buscar primero por primer nombre exacto
  if (inputTokens.length === 1) {
    const singleToken = inputTokens[0]!;
    const firstNameMatches = promotoraCatalog.filter((p) => {
      const pTokens = normalizePromotoraSearchKey(p.name).split(' ').filter(Boolean);
      return pTokens[0] === singleToken;
    });

    if (firstNameMatches.length === 1) {
      return {
        match: firstNameMatches[0]!,
        isUnassignedPlaceholder: false,
        isAmbiguous: false,
        rawClean,
      };
    }
    if (firstNameMatches.length > 1) {
      return {
        match: null,
        isUnassignedPlaceholder: false,
        isAmbiguous: true,
        rawClean,
      };
    }

    // Fallback: coincidencia única en cualquier token completo del nombre
    const anyTokenMatches = promotoraCatalog.filter((p) => {
      const pTokens = normalizePromotoraSearchKey(p.name).split(' ').filter(Boolean);
      return pTokens.includes(singleToken);
    });

    if (anyTokenMatches.length === 1) {
      return {
        match: anyTokenMatches[0]!,
        isUnassignedPlaceholder: false,
        isAmbiguous: false,
        rawClean,
      };
    }
    if (anyTokenMatches.length > 1) {
      return {
        match: null,
        isUnassignedPlaceholder: false,
        isAmbiguous: true,
        rawClean,
      };
    }

    return {
      match: null,
      isUnassignedPlaceholder: false,
      isAmbiguous: false,
      rawClean,
    };
  }

  // 3. Si vienen 2+ tokens (ej. "SCARLETH PINA" o primer nombre + apellido), todos los tokens deben existir completos
  const subsetMatches = promotoraCatalog.filter((p) => {
    const pTokens = normalizePromotoraSearchKey(p.name).split(' ').filter(Boolean);
    return inputTokens.every((tok) => pTokens.includes(tok));
  });

  if (subsetMatches.length === 1) {
    return {
      match: subsetMatches[0]!,
      isUnassignedPlaceholder: false,
      isAmbiguous: false,
      rawClean,
    };
  }
  if (subsetMatches.length > 1) {
    return {
      match: null,
      isUnassignedPlaceholder: false,
      isAmbiguous: true,
      rawClean,
    };
  }

  return {
    match: null,
    isUnassignedPlaceholder: false,
    isAmbiguous: false,
    rawClean,
  };
}

function matchPdvFromCatalog(
  rawName: string,
  rawCode: string,
  pdvCatalog: CatalogPdvEntry[]
): CatalogPdvEntry | null {
  const cleanCode = normalizeCanonicalToken(rawCode);
  if (cleanCode) {
    const byCode = pdvCatalog.find(
      (p) => p.clientCode && normalizeCanonicalToken(p.clientCode) === cleanCode
    );
    if (byCode) return byCode;
  }

  const key = normalizeCanonicalToken(rawName);
  if (!key) return null;

  return pdvCatalog.find((p) => p.canonicalKey === key) ?? null;
}

function isValidIsoDateYmd(value: string): boolean {
  const match = String(value || '')
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const yyyy = Number(match[1]);
  const mm = Number(match[2]);
  const dd = Number(match[3]);
  if (yyyy < 2000 || yyyy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    d.getUTCFullYear() === yyyy && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd
  );
}

/**
 * Verifica mediante el SDK oficial parametrizado (`@supabase/supabase-js`) si un archivo con el
 * mismo hash binario SHA-256 ya fue procesado anteriormente en `public.cargas_archivos`.
 */
export async function checkDuplicateArchivoSha256(
  archivoSha256: string
): Promise<CargaArchivoRecord | null> {
  const cleanSha = String(archivoSha256 || '').trim().toLowerCase();
  if (!cleanSha || !SHA256_HEX_REGEX.test(cleanSha) || !isSupabaseConfigured) {
    return null;
  }

  try {
    const client = getSupabaseCoordinatorClient();
    const { data, error } = await client
      .from('cargas_archivos')
      .select('*')
      .eq('archivo_sha256', cleanSha)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return data as CargaArchivoRecord;
  } catch {
    return null;
  }
}

/**
 * Consulta en lote vía SDK oficial parametrizado cuáles `idempotency_hash` ya existen activos en
 * `public.cronograma_degustaciones` (excluyendo `RECHAZADA` y `CANCELADA`).
 */
export async function fetchActiveCronogramaHashes(
  hashes: string[]
): Promise<Set<string>> {
  const uniqueHashes = Array.from(
    new Set(
      hashes
        .map((h) => String(h || '').trim().toLowerCase())
        .filter((h) => SHA256_HEX_REGEX.test(h))
    )
  );
  const found = new Set<string>();
  if (uniqueHashes.length === 0 || !isSupabaseConfigured) {
    return found;
  }

  const chunkSize = 80;
  try {
    const client = getSupabaseCoordinatorClient();
    for (let i = 0; i < uniqueHashes.length; i += chunkSize) {
      const slice = uniqueHashes.slice(i, i + chunkSize);
      const { data, error } = await client
        .from('cronograma_degustaciones')
        .select('idempotency_hash')
        .in('idempotency_hash', slice)
        .neq('estado', 'RECHAZADA')
        .neq('estado', 'CANCELADA');

      if (error || !Array.isArray(data)) {
        return found;
      }

      for (const item of data as Array<{ idempotency_hash?: string }>) {
        if (item?.idempotency_hash) {
          found.add(item.idempotency_hash.toLowerCase());
        }
      }
    }
    return found;
  } catch {
    return found;
  }
}

export interface EditableRowDraft {
  rowIndex: number;
  excelRowNumber?: number;
  fecha: string;
  fechaFormateada?: string;
  fechaTimestamp?: number | null;
  rawFechaArchivo?: string;
  fechaErrorDetalle?: string | null;
  fechaOrigenParcial?: boolean;
  fechaEditadaManualmente?: boolean;
  horaInicio: string;
  horaFin: string;
  turno: FilaDegustacionExtraida['turno'];
  clienteNombre: string;
  clienteCodigo: string;
  zonaDireccion: string;
  productos: string[];
  productoResumen?: string;
  cantidadKilos: number;
  personasEstimadas: number;
  vendedorFdv: string;
  promotoraSugerida: string;
  rawPromotoraArchivo?: string;
  promotoraId?: string | null;
  observaciones: string;
}

/**
 * Evalúa, enriquece con catálogos reales y calcula hashes SHA-256 de idempotencia para todas las filas
 * en la Bandeja de Previsualización y Validación Pre-Volcado (Módulo 1).
 */
export async function validateAndEnrichExtractedRows(
  draftRows: EditableRowDraft[],
  context: {
    pdvCatalog: CatalogPdvEntry[];
    promotoraCatalog: ActivePromotoraOption[];
    existingDbHashes: Set<string>;
    baseYear?: number;
    baseMonth?: number;
  }
): Promise<FilaDegustacionExtraida[]> {
  if (draftRows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `El lote excede el máximo permitido de ${MAX_IMPORT_ROWS} filas por importación (${draftRows.length} recibidas).`
    );
  }

  const seenHashesInFile = new Set<string>();
  const enriched: FilaDegustacionExtraida[] = [];

  for (const draft of draftRows) {
    const effectiveExcelRow = draft.excelRowNumber ?? draft.rowIndex;
    const fechaEditadaManualmente = Boolean(draft.fechaEditadaManualmente);
    let resolvedFecha = '';
    let resolvedFechaFormateada = '';
    let resolvedFechaTimestamp: number | null = null;
    let fechaOrigenParcial = Boolean(draft.fechaOrigenParcial);
    let dateErrorMessage: string | null = null;

    if (fechaEditadaManualmente) {
      const manualCandidate = draft.fechaFormateada ?? draft.fecha ?? '';
      const manualParsed = excelDateParser(manualCandidate, {
        fallbackYear: context.baseYear,
        fallbackMonth: context.baseMonth,
        allowUsMmDdFallback: false,
      });
      if (manualParsed.ok && manualParsed.isoDate) {
        resolvedFecha = manualParsed.isoDate;
        resolvedFechaFormateada = manualParsed.displayDate;
        resolvedFechaTimestamp = manualParsed.timestampUtc;
      } else {
        dateErrorMessage = formatExcelRowDateError({
          excelRowNumber: effectiveExcelRow,
          rawValue: manualCandidate,
          parseResult: manualParsed,
        });
      }
      fechaOrigenParcial = false;
    } else {
      const candidateInput =
        fechaOrigenParcial && draft.rawFechaArchivo
          ? draft.rawFechaArchivo
          : draft.fecha || draft.fechaFormateada || draft.rawFechaArchivo || '';

      const parsedDate = parseFechaCronograma(
        candidateInput,
        context.baseYear,
        context.baseMonth,
        { excelRowNumber: effectiveExcelRow }
      );

      if (parsedDate.ymd) {
        resolvedFecha = parsedDate.ymd;
        resolvedFechaFormateada = parsedDate.fechaFormateada;
        resolvedFechaTimestamp = parsedDate.fechaTimestamp;
        fechaOrigenParcial = parsedDate.fechaOrigenParcial;
      } else {
        resolvedFecha = '';
        resolvedFechaFormateada = '';
        resolvedFechaTimestamp = null;
        fechaOrigenParcial = false;
        dateErrorMessage =
          draft.fechaErrorDetalle ||
          parsedDate.invalidCalendarMessage ||
          formatExcelRowDateError({
            excelRowNumber: effectiveExcelRow,
            rawValue: draft.rawFechaArchivo ?? candidateInput,
          });
      }
    }

    const schedule = resolveScheduleWindow({
      rawHoraInicio: sanitizeCellText(draft.horaInicio, 40),
      rawHoraFin: sanitizeCellText(draft.horaFin, 40),
      rawHorarioOrTurno: sanitizeCellText(draft.turno, 40),
    });

    const horaInicio = normalizeHora24(draft.horaInicio || schedule.horaInicio, '09:00');
    const horaFin = normalizeHora24(draft.horaFin || schedule.horaFin, '13:00');
    const turno = draft.turno || schedule.turno;

    const cleanProducts = (
      draft.productoResumen !== undefined
        ? sanitizeCellText(draft.productoResumen).split(/[,+/|;]+/)
        : draft.productos.map((p) => sanitizeCellText(p, 120))
    )
      .map((p) => sanitizeCellText(p, 120).toUpperCase())
      .filter(Boolean);

    const productoResumen = cleanProducts.join(' + ');

    const cleanClienteDraft = sanitizeCellText(draft.clienteNombre);
    const cleanCodigoDraft = sanitizeCellText(draft.clienteCodigo, 80);
    const cleanZonaDraft = sanitizeCellText(draft.zonaDireccion);

    const matchedPdv = matchPdvFromCatalog(
      cleanClienteDraft,
      cleanCodigoDraft,
      context.pdvCatalog
    );

    const effectiveClienteNombre = matchedPdv ? matchedPdv.name : cleanClienteDraft;
    const effectiveClienteCodigo = cleanCodigoDraft || matchedPdv?.clientCode || '';
    const effectiveZona =
      cleanZonaDraft || matchedPdv?.zone || matchedPdv?.address || '';

    // Emparejamiento determinista contra el Catálogo Activo (`matchPromotoraCatalogo`)
    const rawPromotoraArchivo = sanitizeCellText(
      draft.rawPromotoraArchivo ?? draft.promotoraSugerida,
      120
    );
    const fileMatchResult = matchPromotoraCatalogo(
      rawPromotoraArchivo,
      context.promotoraCatalog
    );

    let matchedPromotora: ActivePromotoraOption | null = null;
    if (draft.promotoraId === null) {
      // Seleccionado explícitamente "Por asignar (cargar en Módulo 2)"
      matchedPromotora = null;
    } else if (typeof draft.promotoraId === 'string' && draft.promotoraId.trim() !== '') {
      // Validar estrictamente contra el Catálogo Activo (integridad FK)
      matchedPromotora =
        context.promotoraCatalog.find((p) => p.id === draft.promotoraId) ?? null;
    } else {
      // Estado inicial al importar archivo: preselección automática si hubo 1 coincidencia única
      matchedPromotora = fileMatchResult.match;
    }

    const promotoraId = matchedPromotora ? matchedPromotora.id : null;
    const promotoraNombreResuelto = matchedPromotora ? matchedPromotora.name : null;
    const promotoraCoincidenciaArchivo = Boolean(
      matchedPromotora && fileMatchResult.match && matchedPromotora.id === fileMatchResult.match.id
    );

    const idempotencyHash = await computeDegustacionIdempotencyHash({
      fecha: resolvedFecha,
      clienteNombre: effectiveClienteNombre,
      horaInicio,
      productoResumen,
    });

    const hasValidDate = isValidIsoDateYmd(resolvedFecha);
    const esDuplicadoEnArchivo =
      Boolean(effectiveClienteNombre && productoResumen && hasValidDate) &&
      seenHashesInFile.has(idempotencyHash);
    if (!esDuplicadoEnArchivo && hasValidDate && effectiveClienteNombre && productoResumen) {
      seenHashesInFile.add(idempotencyHash);
    }

    const esDuplicadoEnBaseDatos = context.existingDbHashes.has(idempotencyHash.toLowerCase());

    const errors: string[] = [];
    const warnings: string[] = [];

    if (!hasValidDate) {
      errors.push(
        dateErrorMessage ||
          formatExcelRowDateError({
            excelRowNumber: effectiveExcelRow,
            rawValue: draft.rawFechaArchivo ?? draft.fechaFormateada ?? draft.fecha,
          })
      );
    }
    if (!effectiveClienteNombre) {
      errors.push('Cliente / Punto de Venta (PDV) es obligatorio.');
    }
    if (!productoResumen) {
      errors.push('Debe indicar al menos un producto a degustar.');
    }
    if (!Number.isFinite(draft.cantidadKilos) || draft.cantidadKilos <= 0) {
      errors.push('La cantidad / kilos debe ser mayor a 0.');
    }

    // Regla crítica Fase 2.2: `promotoraId === null` JAMÁS marca error rojo ni bloquea el volcado.
    if (errors.length === 0) {
      if (esDuplicadoEnArchivo) {
        warnings.push('Fila duplicada dentro de este mismo archivo (misma fecha, PDV, hora y producto).');
      }
      if (esDuplicadoEnBaseDatos) {
        warnings.push('Ya existe una degustación activa idéntica en el Cronograma de Módulo 2.');
      }
      if (!matchedPdv) {
        warnings.push('PDV no reconocido en el catálogo actual (puedes vincularlo con el selector o conservarlo como nuevo).');
      }
      if (!matchedPromotora && rawPromotoraArchivo && !fileMatchResult.isUnassignedPlaceholder) {
        warnings.push(
          fileMatchResult.isAmbiguous
            ? 'Coincidencia múltiple en catálogo activo; pasará por asignar a Módulo 2 salvo que elijas una.'
            : 'Promotora sugerida no figura en el catálogo activo; pasará por asignar a Módulo 2.'
        );
      }
    }

    let nivelValidacion: NivelValidacionFilaCarga = 'VALIDO';
    if (errors.length > 0) {
      nivelValidacion = 'ERROR';
    } else if (warnings.length > 0) {
      nivelValidacion = 'ADVERTENCIA';
    }

    enriched.push({
      rowIndex: draft.rowIndex,
      excelRowNumber: effectiveExcelRow,
      fecha: resolvedFecha,
      fechaFormateada: resolvedFechaFormateada,
      fechaTimestamp: resolvedFechaTimestamp,
      rawFechaRecibida: sanitizeCellText(draft.rawFechaArchivo, 120),
      fechaOrigenParcial,
      fechaEditadaManualmente,
      horaInicio,
      horaFin,
      turno,
      clienteNombre: effectiveClienteNombre,
      clienteCodigo: effectiveClienteCodigo,
      zonaDireccion: effectiveZona,
      productos: cleanProducts,
      productoResumen,
      cantidadKilos: Number.isFinite(draft.cantidadKilos) ? draft.cantidadKilos : 0,
      personasEstimadas:
        Number.isFinite(draft.personasEstimadas) && draft.personasEstimadas >= 0
          ? Math.round(draft.personasEstimadas)
          : 0,
      vendedorFdv: sanitizeCellText(draft.vendedorFdv, 120),
      promotoraSugerida: sanitizeCellText(draft.promotoraSugerida, 120),
      rawPromotoraArchivo,
      promotoraCoincidenciaArchivo,
      promotoraAmbigua: fileMatchResult.isAmbiguous,
      promotoraId,
      promotoraNombreResuelto,
      observaciones: sanitizeCellText(draft.observaciones),
      idempotencyHash,
      nivelValidacion,
      mensajesValidacion: errors.length > 0 ? errors : warnings,
      esDuplicadoEnArchivo,
      esDuplicadoEnBaseDatos,
    });
  }

  return enriched;
}

/**
 * Invoca el servicio backend `POST /api/degustaciones/extract-pdf` para extraer filas estructuradas de un PDF.
 */
export async function extractPdfViaBackend(fileBuffer: ArrayBuffer, fileName: string): Promise<{
  provider: string;
  model: string;
  rows: RawExtractedDegustacionRow[];
}> {
  const res = await fetch('/api/degustaciones/extract-pdf', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent(sanitizeCellText(fileName, 180) || 'planificacion.pdf'),
    },
    body: fileBuffer,
  });

  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    provider?: string;
    model?: string;
    rows?: RawExtractedDegustacionRow[];
  };

  if (!res.ok) {
    throw new Error(
      payload.error || `Error al procesar el PDF en el servidor (HTTP ${res.status}).`
    );
  }

  return {
    provider: payload.provider || 'ai',
    model: payload.model || 'structured-json',
    rows: Array.isArray(payload.rows) ? payload.rows : [],
  };
}

function buildInsumosPayload(row: FilaDegustacionExtraida): InsumosCalculadosDegustacion {
  const calc = calculateProductionSupplies(
    row.productoResumen || 'MORTADELA',
    row.cantidadKilos > 0 ? row.cantidadKilos : 1,
    row.personasEstimadas > 0 ? row.personasEstimadas : undefined
  );
  return {
    ...calc.operationalSupplies,
    mortadelaQty: calc.mortadelaQty,
    espaldaQty: calc.espaldaQty,
    arrozQty: calc.arrozQty,
    azucarGrams: calc.azucarGrams,
    lecheGrams: calc.lecheGrams,
  };
}

/**
 * Verifica que el ID de promotora sea estrictamente un UUID real presente en el Catálogo Activo o `null`.
 * Jamás permite enviar strings libres hacia `public.cronograma_degustaciones`.
 */
export function enforceSafePromotoraFkId(
  candidateId: string | null | undefined,
  allowedActiveIds?: ReadonlySet<string>
): string | null {
  const clean = String(candidateId ?? '').trim();
  if (!clean || !UUID_REGEX.test(clean)) return null;
  if (allowedActiveIds && !allowedActiveIds.has(clean)) return null;
  return clean;
}

/**
 * Ejecuta el volcado masivo transaccional hacia `public.cronograma_degustaciones` mediante la RPC
 * `public.volcar_lote_cronograma`, insertando todas las filas con `estado = 'PENDIENTE_APROBACION'`
 * y trazabilidad completa al lote `carga_id`.
 */
export async function dumpValidatedBatchToCronograma(params: {
  fileMeta: {
    nombreArchivo: string;
    extension: ArchivoPlanificacionExtension;
    mimeType: string;
    tamanoBytes: number;
    archivoSha256: string;
    metodoExtraccion: MetodoExtraccionArchivo;
    metadata?: Record<string, unknown>;
  };
  rows: FilaDegustacionExtraida[];
  allowedPromotoraIds?: ReadonlySet<string>;
  cargadoPor: string;
  cargadoPorRol: string;
  notas?: string;
}): Promise<ResultadoVolcadoLoteCronograma> {
  if (params.rows.length === 0) {
    throw new Error('No hay filas seleccionadas para volcar al Cronograma.');
  }

  if (params.rows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `El lote excede el máximo permitido de ${MAX_IMPORT_ROWS} registros por confirmación (${params.rows.length} seleccionados).`
    );
  }

  const rowsWithErrors = params.rows.filter((r) => r.nivelValidacion === 'ERROR');
  if (rowsWithErrors.length > 0) {
    throw new Error(
      `Existen ${rowsWithErrors.length} fila(s) en rojo con errores críticos. Corrígelas o desmárcalas antes de confirmar.`
    );
  }

  const safeMetadata: Record<string, unknown> = {};
  if (params.fileMeta.metadata && typeof params.fileMeta.metadata === 'object') {
    for (const [key, val] of Object.entries(params.fileMeta.metadata)) {
      if (!isDangerousObjectKey(key)) {
        safeMetadata[key] = val;
      }
    }
  }

  const p_carga = {
    nombre_archivo: sanitizeCellText(params.fileMeta.nombreArchivo, 180) || 'planificacion.xlsx',
    extension: params.fileMeta.extension,
    mime_type: sanitizeCellText(params.fileMeta.mimeType, 120) || 'application/octet-stream',
    tamano_bytes: Math.max(1, Math.round(params.fileMeta.tamanoBytes)),
    archivo_sha256: sanitizeCellText(params.fileMeta.archivoSha256, 80),
    metodo_extraccion: params.fileMeta.metodoExtraccion,
    cargado_por: sanitizeCellText(params.cargadoPor, 120) || 'Trade Marketing',
    cargado_por_rol: sanitizeCellText(params.cargadoPorRol, 80) || 'jefe_trade',
    notas: sanitizeCellText(params.notas),
    metadata: safeMetadata,
  };

  const p_filas = params.rows.map((r) => {
    const verifiedDate = excelDateParser(r.fecha, { allowUsMmDdFallback: false });
    if (!verifiedDate.ok || !verifiedDate.isoDate) {
      const rowLabel = r.excelRowNumber ?? r.rowIndex;
      throw new Error(
        `Fila Excel #${rowLabel}: La fecha "${r.fecha}" no cumple el formato calendario ISO YYYY-MM-DD requerido por la base de datos.`
      );
    }

    const safePromotoraId = enforceSafePromotoraFkId(
      r.promotoraId,
      params.allowedPromotoraIds
    );
    return {
      idempotency_hash: r.idempotencyHash,
      fecha: verifiedDate.isoDate,
      hora_inicio: r.horaInicio,
      hora_fin: r.horaFin,
      turno: r.turno,
      cliente_nombre: sanitizeCellText(r.clienteNombre),
      cliente_codigo: sanitizeCellText(r.clienteCodigo, 80),
      zona_direccion: sanitizeCellText(r.zonaDireccion),
      producto_resumen: sanitizeCellText(r.productoResumen),
      productos: r.productos.map((p) => sanitizeCellText(p, 120)).filter(Boolean),
      cantidad_kilos: r.cantidadKilos,
      personas_estimadas: r.personasEstimadas,
      insumos_calculados: buildInsumosPayload(r),
      vendedor_fdv: sanitizeCellText(r.vendedorFdv, 120),
      promotora_sugerida: sanitizeCellText(
        r.promotoraNombreResuelto || r.rawPromotoraArchivo || r.promotoraSugerida,
        120
      ),
      promotora_id: safePromotoraId,
      observaciones: sanitizeCellText(r.observaciones),
    };
  });

  const client = getSupabaseCoordinatorClient();
  const { data, error } = await client.rpc('volcar_lote_cronograma', {
    p_carga,
    p_filas,
  });

  if (error || !data) {
    throw new Error(
      `No se pudo completar el volcado al Cronograma${error?.code ? ` (código ${error.code})` : ''}. Verifica la conexión e intenta nuevamente.`
    );
  }

  const result = data as ResultadoVolcadoLoteCronograma;
  return {
    carga_id: result.carga_id,
    total_recibidas: Number(result.total_recibidas ?? params.rows.length),
    total_insertadas: Number(result.total_insertadas ?? 0),
    total_duplicadas: Number(result.total_duplicadas ?? 0),
    ids_insertados: Array.isArray(result.ids_insertados) ? result.ids_insertados : [],
  };
}

/**
 * Permite actualizar vía SDK oficial parametrizado la promotora asignada (`promotora_id` UUID válido o `null`)
 * en una fila ya volcada a `public.cronograma_degustaciones` desde la bandeja de coordinación en Módulo 2.
 */
export async function updateCronogramaPromotoraIdInSupabase(params: {
  cronogramaId: string;
  promotoraId: string | null;
  allowedPromotoraIds?: ReadonlySet<string>;
}): Promise<boolean> {
  const cleanRowId = String(params.cronogramaId || '').trim();
  if (!UUID_REGEX.test(cleanRowId) || !isSupabaseConfigured) return false;

  const safePromotoraId = enforceSafePromotoraFkId(
    params.promotoraId,
    params.allowedPromotoraIds
  );

  try {
    const client = getSupabaseCoordinatorClient();
    const { error } = await client
      .from('cronograma_degustaciones')
      .update({ promotora_id: safePromotoraId })
      .eq('id', cleanRowId);
    return !error;
  } catch {
    return false;
  }
}
