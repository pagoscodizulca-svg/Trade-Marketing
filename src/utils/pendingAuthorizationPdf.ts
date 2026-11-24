import type jsPDF from 'jspdf';
import type { TastingScheduleItem } from '../components/field/FieldPromotoraView';
import { resolveFdvRequestLifecycle } from '../services/fdvDegustacionesAdapter';
import { canonicalStaffKey } from '../services/supabaseModule1';
import { FEATURE_FLAGS } from '../config/featureFlags';
import {
  OFFICIAL_CARACAS_TIMEZONE,
  getCaracasWeekCycleBounds,
  isTastingBeforeTodayCaracas,
  isTastingInPastCaracasWeek,
  resolveTastingEventCaracasYmd,
} from './caracasWeekCycle';
import { formatToDdMmYyyy } from './excelDateNormalizer';
import {
  formatCanonicalSucursalBadge,
  inferCanonicalSucursalFromText,
  normalizeCanonicalSucursal,
  type CanonicalSucursal,
} from './regionalSyncClassifier';

export const AUTHORIZATION_TIMEZONE = OFFICIAL_CARACAS_TIMEZONE; // 'America/Caracas' (UTC-4)
export const MAX_AUTHORIZATION_PDF_ROWS = 500;

export const MAX_SELLER_CELL_LENGTH = 80;
export const MAX_CLIENT_CELL_LENGTH = 140;
export const MAX_PRODUCT_CELL_LENGTH = 160;
export const MAX_OBSERVATIONS_CELL_LENGTH = 280;
export const MAX_FILTER_SUMMARY_LENGTH = 160;
export const MAX_ISSUER_DISPLAY_LENGTH = 90;

export type AuthorizationReportScope = 'GENERAL' | 'FILTRADO';

export interface CaracasEmissionTimestampInfo {
  /** Ej: "13/11/2026 11:52:08 (America/Caracas, UTC-4)" */
  displayTimestamp: string;
  /** Ej: "2026-11-13_1152" */
  fileTimestampToken: string;
  /** Ej: "Solicitud_Autorizacion_Degustaciones_2026-11-13_1152.pdf" */
  fileName: string;
  /** Ej: "2026-11-13" */
  caracasYmd: string;
}

export interface PendingAuthorizationRow {
  index: number;
  requestId: string;
  eventDateYmd: string;
  dateFormatted: string;
  timeAndShiftLabel: string;
  dateTimeCellText: string;
  sortMinutesOfDay: number;
  sellerDisplay: string;
  sellerCanonicalKey: string;
  clientNameDisplay: string;
  clientCodeDisplay: string;
  zoneDisplay: string;
  clientCellText: string;
  clientCanonicalKey: string;
  productsCellText: string;
  estimatedQtyNumeric: number;
  estimatedSamplesNumeric: number;
  estimatedQtyCellText: string;
  sellerObservationsText: string;
  statusBadgeText: 'PENDIENTE DE ACEPTAR';
}

export interface PendingAuthorizationKpis {
  totalSolicitadas: number;
  uniqueSellersCount: number;
  uniqueClientsCount: number;
  totalEstimatedQty: number;
  totalEstimatedSamples: number;
}

export interface PendingAuthorizationReportModel {
  title: 'SOLICITUD DE AUTORIZACIÓN — CRONOGRAMA DE DEGUSTACIONES';
  preApprovalBadge: 'ESTADO: PRE-APROBACIÓN (PENDIENTE DE ACEPTAR)';
  periodSubtitle: string;
  scopeType: AuthorizationReportScope;
  scopeHeaderLabel: string;
  scopeDetailLabel: string;
  issuerDisplay: string;
  emission: CaracasEmissionTimestampInfo;
  fileName: string;
  kpis: PendingAuthorizationKpis;
  rows: PendingAuthorizationRow[];
  totalMatchedBeforeCap: number;
  wasTruncatedBySafetyCap: boolean;
  maxRowsCap: number;
}

export interface BuildPendingAuthorizationModelInput {
  items: ReadonlyArray<TastingScheduleItem | null | undefined>;
  filterPredicate?: (item: TastingScheduleItem) => boolean;
  hasActiveFilters?: boolean;
  filterSummaryLabel?: string | null;
  issuerName?: string | null;
  issuerRole?: string | null;
  /** Sucursal activa de la sesión ('CENTRO' | 'OCCIDENTE') para aislamiento estricto del PDF */
  activeSucursal?: CanonicalSucursal | string | null;
  now?: Date;
  maxRows?: number;
}

export interface RenderPendingAuthorizationPdfOptions {
  /** Permite inyectar data URL PNG en pruebas o reutilizar logo precargado */
  logoDataUrl?: string | null;
}

// Carga bajo demanda de jsPDF y jsPDF-AutoTable (paquetes oficiales ya instalados)
const loadPdfLibs = async () => {
  const [{ default: jsPDFConstructor }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  return { jsPDF: jsPDFConstructor, autoTable };
};

const CARACAS_EMISSION_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: AUTHORIZATION_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Sanitiza estrictamente cualquier texto proveniente de usuarios/vendedores para uso seguro
 * en primitivas vectoriales PDF (sin HTML/XSS, sin caracteres de control ni desbordes).
 */
export function sanitizeAuthorizationText(
  input: unknown,
  maxLength = 160,
  options: { preserveLineBreaks?: boolean; fallback?: string } = {}
): string {
  const fallback = options.fallback ?? '';
  if (input === null || input === undefined) return fallback;
  if (typeof input === 'object') return fallback;

  let raw = String(input);
  try {
    raw = raw.normalize('NFC');
  } catch {
    // Mantener cadena original si algún par sustituto aislado impide normalizar
  }

  // 1. Eliminar bloques <script>/<style> y etiquetas HTML crudas para neutralizar ruido/inyección visual
  let cleaned = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s[^>]*)?>/gi, ' ')
    .replace(/javascript\s*:/gi, '');

  // 2. Eliminar caracteres de control ASCII/C1, zero-width, bidi overrides, sustitutos huérfanos y emojis fuera de métricas WinAnsi
  cleaned = cleaned
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[•]/g, '·')
    .replace(/…/g, '...')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/–/g, '-');

  // 3. Normalizar saltos de línea y espacios redundantes
  if (options.preserveLineBreaks) {
    cleaned = cleaned
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  } else {
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
  }

  if (!cleaned) return fallback;

  const safeLimit = Math.max(8, Math.floor(maxLength));
  if (cleaned.length <= safeLimit) {
    return cleaned;
  }

  // Truncamiento limpio en frontera de palabra + "..."
  const budget = safeLimit - 3;
  const sliced = cleaned.slice(0, budget);
  const lastSpace = sliced.lastIndexOf(' ');
  const base = lastSpace >= Math.floor(budget * 0.65) ? sliced.slice(0, lastSpace) : sliced;
  return `${base.trimEnd()}...`;
}

/**
 * Sanitiza estrictamente el token temporal y devuelve el nombre oficial del archivo:
 * `Solicitud_Autorizacion_Degustaciones_YYYY-MM-DD_HHmm.pdf`
 */
export function sanitizeAuthorizationFilename(rawTimestampToken: unknown): string {
  const cleanedToken = String(rawTimestampToken ?? '')
    .replace(/[^0-9_-]/g, '')
    .slice(0, 24);
  const validPattern = /^\d{4}-\d{2}-\d{2}_\d{4}$/;
  const safeToken = validPattern.test(cleanedToken) ? cleanedToken : '0000-00-00_0000';
  return `Solicitud_Autorizacion_Degustaciones_${safeToken}.pdf`;
}

/**
 * Calcula la marca exacta de fecha/hora y el nombre de archivo explícitamente
 * en zona horaria `America/Caracas` (UTC-4), sin depender del reloj local del navegador.
 */
export function formatCaracasEmissionTimestamp(
  now: Date = new Date()
): CaracasEmissionTimestampInfo {
  const safeDate =
    now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  const parts = CARACAS_EMISSION_FORMATTER.formatToParts(safeDate);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }

  const yyyy = map.year || '1970';
  const mm = map.month || '01';
  const dd = map.day || '01';
  const rawHour = Number(map.hour ?? 0);
  const hh = String(rawHour === 24 ? 0 : rawHour).padStart(2, '0');
  const min = map.minute || '00';
  const sec = map.second || '00';

  const caracasYmd = `${yyyy}-${mm}-${dd}`;
  const fileTimestampToken = `${yyyy}-${mm}-${dd}_${hh}${min}`;
  const fileName = sanitizeAuthorizationFilename(fileTimestampToken);
  const displayTimestamp = `${dd}/${mm}/${yyyy} ${hh}:${min}:${sec} (America/Caracas, UTC-4)`;

  return {
    displayTimestamp,
    fileTimestampToken,
    fileName,
    caracasYmd,
  };
}

const SYNTHETIC_SYSTEM_NOTES_RE =
  /^(Sincronizado con Base de Datos|Estado:\s*(PENDIENTE|SOLICITADA|PENDIENTE_APROBACION)|Degustaci[oó]n sincronizada)/i;

function extractCleanSellerName(item: TastingScheduleItem): string {
  const fromRaw =
    item.rawComments?.vendedor ||
    item.rawComments?.vendedorNombre ||
    item.rawComments?.salesRep ||
    item.rawComments?.solicitante;
  const candidate = String(item.sellerApplicant || fromRaw || '')
    .replace(/\s*\(Vendedor\s*FDV\)\s*/gi, '')
    .replace(/\s*\(FDV\)\s*/gi, '')
    .trim();

  return sanitizeAuthorizationText(candidate, MAX_SELLER_CELL_LENGTH, {
    fallback: 'Vendedor No Especificado',
  });
}

function extractCleanSellerObservations(item: TastingScheduleItem): string {
  const rawObj =
    item.rawComments && typeof item.rawComments === 'object' ? item.rawComments : undefined;

  const candidates: unknown[] = [
    rawObj?.observaciones,
    rawObj?.observacion,
    rawObj?.motivo,
    rawObj?.razon,
    rawObj?.originalComments,
    rawObj?.comentariosVendedor,
    item.notes,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (SYNTHETIC_SYSTEM_NOTES_RE.test(trimmed)) continue;
    const sanitized = sanitizeAuthorizationText(trimmed, MAX_OBSERVATIONS_CELL_LENGTH, {
      preserveLineBreaks: false,
    });
    if (sanitized) return sanitized;
  }

  return 'Sin observaciones';
}

function extractProductsLabel(item: TastingScheduleItem): string {
  if (Array.isArray(item.productsList) && item.productsList.length > 0) {
    const uniqueClean = Array.from(
      new Set(
        item.productsList
          .map((p) => sanitizeAuthorizationText(p, 90))
          .filter((p) => p.length > 0)
      )
    );
    if (uniqueClean.length > 0) {
      return sanitizeAuthorizationText(uniqueClean.join(', '), MAX_PRODUCT_CELL_LENGTH, {
        fallback: 'Producto por confirmar',
      });
    }
  }

  return sanitizeAuthorizationText(item.productName, MAX_PRODUCT_CELL_LENGTH, {
    fallback: 'Producto por confirmar',
  });
}

function parseSortMinutesOfDay(timeRange?: string, turnoRaw?: string, shift?: string): number {
  const combined = `${timeRange || ''} ${turnoRaw || ''}`.trim();
  const timeMatch = combined.match(/(\d{1,2}):(\d{2})\s*(AM|PM|A\.?\s*M\.?|P\.?\s*M\.?)?/i);
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const meridiem = (timeMatch[3] || '').toUpperCase().replace(/[^AP]/g, '');
    if (meridiem === 'P' && hour < 12) hour += 12;
    if (meridiem === 'A' && hour === 12) hour = 0;
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return hour * 60 + minute;
    }
  }

  const normShift = String(shift || turnoRaw || '')
    .toUpperCase()
    .trim();
  if (normShift.includes('MANANA') || normShift.includes('MAÑANA')) return 8 * 60 + 30;
  if (normShift.includes('COMPLETO') || normShift.includes('MIXTO')) return 9 * 60;
  if (normShift.includes('TARDE')) return 14 * 60;
  return 12 * 60;
}

function formatDecimalEs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

function formatRoleLabel(role?: string | null): string {
  const clean = sanitizeAuthorizationText(role, 40);
  if (!clean) return '';
  const map: Record<string, string> = {
    jefe_trade: 'Jefatura Trade Marketing',
    coordinador_trade: 'Coordinación Trade Marketing',
    supervisor: 'Supervisión Comercial',
    contraloria: 'Contraloría Interna',
    admin: 'Administración General',
    gerencia: 'Gerencia Comercial',
  };
  return map[clean.toLowerCase()] || clean;
}

/**
 * Construye de forma pura y determinista el modelo de datos para el Informe PDF
 * de Solicitud de Autorización:
 * - Filtra exclusivamente degustaciones en estado `PENDIENTE` del cronograma actual (semana ISO en `America/Caracas`).
 * - Excluye estrictamente degustaciones aceptadas (`PROGRAMADO`, `EN_CURSO`, `COMPLETADO`), rechazadas/canceladas e históricas.
 * - Respeta filtros activos en pantalla y sanitiza cada celda.
 */
export function buildPendingAuthorizationReportModel(
  input: BuildPendingAuthorizationModelInput
): PendingAuthorizationReportModel {
  const now =
    input.now instanceof Date && !Number.isNaN(input.now.getTime()) ? input.now : new Date();
  const maxRows =
    typeof input.maxRows === 'number' && input.maxRows > 0
      ? Math.min(Math.floor(input.maxRows), MAX_AUTHORIZATION_PDF_ROWS)
      : MAX_AUTHORIZATION_PDF_ROWS;

  const weekBounds = getCaracasWeekCycleBounds(now);
  const emission = formatCaracasEmissionTimestamp(now);

  const mondayDdMmYyyy = formatToDdMmYyyy(
    weekBounds.inicioSemanaActualYmd,
    weekBounds.inicioSemanaActualYmd
  );
  const sundayDdMmYyyy = formatToDdMmYyyy(
    weekBounds.finSemanaActualYmd,
    weekBounds.finSemanaActualYmd
  );
  const periodSubtitle = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
    ? `Cronograma Actual (Semana ISO: Lun ${mondayDdMmYyyy} al Dom ${sundayDdMmYyyy} · America/Caracas)`
    : `Bandeja de Entrada Vigente y Próxima · Desde ${formatToDdMmYyyy(emission.caracasYmd, emission.caracasYmd)} (America/Caracas, UTC-4)`;

  const activeBranch = normalizeCanonicalSucursal(input.activeSucursal);
  const activeBranchBadge = formatCanonicalSucursalBadge(activeBranch);
  const hasActiveFilters = Boolean(input.hasActiveFilters);
  const scopeType: AuthorizationReportScope = hasActiveFilters ? 'FILTRADO' : 'GENERAL';
  const cleanFilterDetail = sanitizeAuthorizationText(
    input.filterSummaryLabel,
    MAX_FILTER_SUMMARY_LENGTH,
    { fallback: 'Filtros activos en pantalla' }
  );
  const scopeHeaderLabel = activeBranchBadge
    ? `${activeBranchBadge} · ${scopeType === 'FILTRADO' ? 'Alcance: Filtrado' : 'Alcance: General de Pendientes'}`
    : scopeType === 'FILTRADO'
      ? 'Alcance: Filtrado'
      : 'Alcance: General de Pendientes';
  const scopeDetailLabel = activeBranchBadge
    ? scopeType === 'FILTRADO'
      ? `${activeBranchBadge} — Filtrado (${cleanFilterDetail})`
      : `${activeBranchBadge} — General de Pendientes (Solicitudes por aprobar de la sucursal)`
    : scopeType === 'FILTRADO'
      ? `Filtrado (${cleanFilterDetail})`
      : 'General de Pendientes (Todas las solicitudes por aprobar de la semana actual)';

  const cleanIssuerName = sanitizeAuthorizationText(input.issuerName, 55);
  const cleanIssuerRole = formatRoleLabel(input.issuerRole);
  const issuerDisplay = sanitizeAuthorizationText(
    cleanIssuerName && cleanIssuerRole
      ? `${cleanIssuerName} (${cleanIssuerRole})`
      : cleanIssuerName || cleanIssuerRole || 'Coordinación / Supervisión Trade Marketing',
    MAX_ISSUER_DISPLAY_LENGTH,
    { fallback: 'Coordinación / Supervisión Trade Marketing' }
  );

  const seenCanonicalIds = new Set<string>();
  const pendingCandidates: Omit<PendingAuthorizationRow, 'index'>[] = [];

  for (const rawItem of input.items || []) {
    if (!rawItem || typeof rawItem !== 'object') continue;

    // 1. Excluir cualquier solicitud rechazada/anulada/cancelada en origen
    const rawEstado =
      rawItem.rawComments && typeof rawItem.rawComments === 'object'
        ? (rawItem.rawComments.estado ?? rawItem.rawComments.status ?? null)
        : null;
    if (rawEstado) {
      const lifecycle = resolveFdvRequestLifecycle({
        rawEstado: String(rawEstado),
        isFromSellerApp: true,
        ymd: rawItem.date,
        todayYmd: emission.caracasYmd,
        enHistorial: Boolean(rawItem.enHistorial || rawItem.isArchived),
      });
      if (lifecycle.isRejectedOrCancelled) continue;
    }

    // 2. Exclusivamente degustaciones PENDIENTES DE ACEPTACIÓN (excluye PROGRAMADO, EN_CURSO, COMPLETADO)
    if (rawItem.status !== 'PENDIENTE') continue;

    // 3. Exclusivamente de la Bandeja de Entrada vigente/próxima (excluye archivadas o fechas vencidas en America/Caracas)
    if (rawItem.isArchived === true || rawItem.enHistorial === true) continue;
    const rawFallbackCreated =
      rawItem.rawComments && typeof rawItem.rawComments === 'object'
        ? rawItem.rawComments.date || rawItem.createdAt
        : rawItem.createdAt;
    const isExpired = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
      ? isTastingInPastCaracasWeek(rawItem.date, now, rawFallbackCreated)
      : isTastingBeforeTodayCaracas(rawItem.date, now, rawFallbackCreated);
    if (isExpired) continue;

    // 4. Aislar defensivamente por sucursal activa ('CENTRO' vs 'OCCIDENTE') y respetar predicado de filtros
    if (activeBranch) {
      const itemBranch = inferCanonicalSucursalFromText(
        `${rawItem.storeName ?? ''} ${rawItem.zone ?? ''} ${rawItem.rawComments?.sucursal ?? ''} ${rawItem.rawComments?.region ?? ''}`
      );
      if (itemBranch && itemBranch !== activeBranch) continue;
    }
    if (input.filterPredicate && !input.filterPredicate(rawItem)) continue;

    // 5. Deduplicar por clave canónica de solicitud
    const canonicalRequestId = sanitizeAuthorizationText(
      rawItem.degustacionId || rawItem.id,
      80
    );
    if (!canonicalRequestId || seenCanonicalIds.has(canonicalRequestId)) continue;
    seenCanonicalIds.add(canonicalRequestId);

    const eventDateYmd =
      resolveTastingEventCaracasYmd(rawItem.date, rawFallbackCreated) ||
      weekBounds.inicioSemanaActualYmd;
    const dateFormatted = formatToDdMmYyyy(eventDateYmd, eventDateYmd);

    const cleanShift = sanitizeAuthorizationText(rawItem.shift || rawItem.turnoRaw, 28, {
      fallback: 'JORNADA GENERAL',
    });
    const cleanTimeRange = sanitizeAuthorizationText(rawItem.timeRange, 36);
    const timeAndShiftLabel = cleanTimeRange
      ? `${cleanShift} · ${cleanTimeRange}`
      : cleanShift;
    const dateTimeCellText = `${dateFormatted}\n${timeAndShiftLabel}`;

    const sellerDisplay = extractCleanSellerName(rawItem);
    const sellerCanonicalKey =
      canonicalStaffKey(sellerDisplay) || sellerDisplay.toUpperCase();

    const clientNameDisplay = sanitizeAuthorizationText(
      rawItem.storeName,
      MAX_CLIENT_CELL_LENGTH,
      { fallback: 'Cliente / PDV por confirmar' }
    );
    const clientCodeDisplay = sanitizeAuthorizationText(rawItem.clienteCodigo, 24).replace(
      /^#+/,
      ''
    );
    const zoneDisplay = sanitizeAuthorizationText(rawItem.zone, 48);

    const clientMetaParts: string[] = [];
    if (clientCodeDisplay) clientMetaParts.push(`Cód: #${clientCodeDisplay}`);
    if (zoneDisplay && zoneDisplay.toUpperCase() !== 'ZONA GENERAL') {
      clientMetaParts.push(zoneDisplay);
    }
    const clientCellText =
      clientMetaParts.length > 0
        ? `${clientNameDisplay}\n${clientMetaParts.join(' · ')}`
        : clientNameDisplay;

    const clientCanonicalKey = clientCodeDisplay
      ? `COD:${clientCodeDisplay.toUpperCase()}`
      : `PDV:${clientNameDisplay
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, ' ')
          .trim()}`;

    const productsCellText = extractProductsLabel(rawItem);

    const rawQty = Number(rawItem.requestedQty ?? 0);
    const estimatedQtyNumeric =
      Number.isFinite(rawQty) && rawQty > 0 ? Math.round(rawQty * 100) / 100 : 0;

    const rawSamples = Number(rawItem.targetSamples ?? 0);
    const estimatedSamplesNumeric =
      Number.isFinite(rawSamples) && rawSamples > 0 ? Math.round(rawSamples) : 0;

    let estimatedQtyCellText =
      estimatedQtyNumeric > 0 ? `${formatDecimalEs(estimatedQtyNumeric)} unid./kg` : 'Por definir';
    if (estimatedSamplesNumeric > 0) {
      estimatedQtyCellText = `${estimatedQtyCellText}\n(${estimatedSamplesNumeric} muest.)`;
    }

    const sellerObservationsText = extractCleanSellerObservations(rawItem);

    pendingCandidates.push({
      requestId: canonicalRequestId,
      eventDateYmd,
      dateFormatted,
      timeAndShiftLabel,
      dateTimeCellText,
      sortMinutesOfDay: parseSortMinutesOfDay(
        rawItem.timeRange,
        rawItem.turnoRaw,
        rawItem.shift
      ),
      sellerDisplay,
      sellerCanonicalKey,
      clientNameDisplay,
      clientCodeDisplay,
      zoneDisplay,
      clientCellText,
      clientCanonicalKey,
      productsCellText,
      estimatedQtyNumeric,
      estimatedSamplesNumeric,
      estimatedQtyCellText,
      sellerObservationsText,
      statusBadgeText: 'PENDIENTE DE ACEPTAR',
    });
  }

  // Ordenamiento determinista: 1.º Fecha/Hora ascendente, 2.º Vendedor alfabético, 3.º Cliente alfabético
  pendingCandidates.sort((a, b) => {
    const byDate = a.eventDateYmd.localeCompare(b.eventDateYmd);
    if (byDate !== 0) return byDate;
    if (a.sortMinutesOfDay !== b.sortMinutesOfDay) {
      return a.sortMinutesOfDay - b.sortMinutesOfDay;
    }
    const bySeller = a.sellerDisplay.localeCompare(b.sellerDisplay, 'es', {
      sensitivity: 'base',
    });
    if (bySeller !== 0) return bySeller;
    return a.clientNameDisplay.localeCompare(b.clientNameDisplay, 'es', {
      sensitivity: 'base',
    });
  });

  const totalMatchedBeforeCap = pendingCandidates.length;
  const wasTruncatedBySafetyCap = totalMatchedBeforeCap > maxRows;
  const rows: PendingAuthorizationRow[] = pendingCandidates
    .slice(0, maxRows)
    .map((row, idx) => ({
      ...row,
      index: idx + 1,
    }));

  const uniqueSellerSet = new Set<string>();
  const uniqueClientSet = new Set<string>();
  let sumEstimatedQty = 0;
  let sumEstimatedSamples = 0;

  for (const row of rows) {
    if (row.sellerCanonicalKey) uniqueSellerSet.add(row.sellerCanonicalKey);
    if (row.clientCanonicalKey) uniqueClientSet.add(row.clientCanonicalKey);
    sumEstimatedQty += row.estimatedQtyNumeric;
    sumEstimatedSamples += row.estimatedSamplesNumeric;
  }

  return {
    title: 'SOLICITUD DE AUTORIZACIÓN — CRONOGRAMA DE DEGUSTACIONES',
    preApprovalBadge: 'ESTADO: PRE-APROBACIÓN (PENDIENTE DE ACEPTAR)',
    periodSubtitle,
    scopeType,
    scopeHeaderLabel,
    scopeDetailLabel,
    issuerDisplay,
    emission,
    fileName: activeBranch
      ? `Solicitud_Autorizacion_Degustaciones_${activeBranch}_${emission.fileTimestampToken}.pdf`
      : emission.fileName,
    kpis: {
      totalSolicitadas: rows.length,
      uniqueSellersCount: uniqueSellerSet.size,
      uniqueClientsCount: uniqueClientSet.size,
      totalEstimatedQty: Math.round(sumEstimatedQty * 100) / 100,
      totalEstimatedSamples: sumEstimatedSamples,
    },
    rows,
    totalMatchedBeforeCap,
    wasTruncatedBySafetyCap,
    maxRowsCap: maxRows,
  };
}

interface LoadedLogoAsset {
  dataUrl: string;
  aspectRatio: number;
}

/**
 * Precarga segura del logo institucional `/codizulca-logo.png` en navegador (mismo origen),
 * con timeout corto anti-bloqueo y fallback limpio en entornos sin DOM (Node/tests).
 */
async function loadLocalCorporateLogo(): Promise<LoadedLogoAsset | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof Image === 'undefined') {
    return null;
  }

  return new Promise<LoadedLogoAsset | null>((resolve) => {
    let settled = false;
    const finish = (val: LoadedLogoAsset | null) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    const timer = window.setTimeout(() => finish(null), 1500);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        window.clearTimeout(timer);
        try {
          const w = img.naturalWidth || img.width || 120;
          const h = img.naturalHeight || img.height || 120;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            finish(null);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/png');
          finish({
            dataUrl,
            aspectRatio: h > 0 ? w / h : 1,
          });
        } catch {
          finish(null);
        }
      };
      img.onerror = () => {
        window.clearTimeout(timer);
        finish(null);
      };
      img.src = '/codizulca-logo.png';
    } catch {
      window.clearTimeout(timer);
      finish(null);
    }
  });
}

function drawTopAccentBars(doc: jsPDF, pageWidth: number): void {
  // Franja institucional roja + línea grafito
  doc.setFillColor(220, 38, 38);
  doc.rect(0, 0, pageWidth, 3.2, 'F');
  doc.setFillColor(24, 24, 27);
  doc.rect(0, 3.2, pageWidth, 1.1, 'F');
}

function drawContinuationHeader(
  doc: jsPDF,
  model: PendingAuthorizationReportModel,
  pageWidth: number,
  marginX: number
): void {
  drawTopAccentBars(doc, pageWidth);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(15, 23, 42);
  doc.text(
    'CODIZULCA C.A. · SOLICITUD DE AUTORIZACIÓN — CRONOGRAMA DE DEGUSTACIONES (Continuación)',
    marginX,
    10.5
  );

  // Pastilla compacta de estado a la derecha
  const badgeW = 68;
  const badgeX = pageWidth - marginX - badgeW;
  doc.setFillColor(254, 243, 199);
  doc.setDrawColor(217, 119, 6);
  doc.setLineWidth(0.3);
  doc.roundedRect(badgeX, 6.6, badgeW, 5.4, 1.2, 1.2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.4);
  doc.setTextColor(146, 64, 14);
  doc.text(model.preApprovalBadge, badgeX + badgeW / 2, 10.1, { align: 'center' });

  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  doc.line(marginX, 13.5, pageWidth - marginX, 13.5);
}

/**
 * Construye el documento vectorial `jsPDF` en tamaño Carta (`Letter`) Horizontal (`landscape`)
 * sin tocar el DOM ni depender de plantillas HTML.
 */
export async function renderPendingAuthorizationPdfDocument(
  model: PendingAuthorizationReportModel,
  options: RenderPendingAuthorizationPdfOptions = {}
): Promise<{ doc: jsPDF; fileName: string; pageCount: number }> {
  if (!model || !Array.isArray(model.rows) || model.rows.length === 0) {
    throw new Error('NO_PENDING_TASTINGS');
  }

  const [{ jsPDF: JsPDFClass, autoTable }, loadedLogo] = await Promise.all([
    loadPdfLibs(),
    options.logoDataUrl !== undefined
      ? Promise.resolve(
          options.logoDataUrl
            ? { dataUrl: options.logoDataUrl, aspectRatio: 1 }
            : null
        )
      : loadLocalCorporateLogo(),
  ]);

  // Formato explícito: Tamaño Carta (Letter: 279.4 mm x 215.9 mm) en orientación Horizontal (landscape)
  const doc: jsPDF = new JsPDFClass({
    orientation: 'landscape',
    unit: 'mm',
    format: 'letter',
    compress: true,
  });

  // Metadatos limpios (cero secretos, variables .env, JWT ni UUIDs internos)
  doc.setProperties({
    title: 'Solicitud de Autorizacion - Cronograma de Degustaciones',
    subject: 'Informe Detallado de Pre-Aprobacion para Gerencia',
    author: 'CODIZULCA C.A. - Coordinacion de Trade Marketing',
    creator: 'CODIZULCA Sistema Corporativo',
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // 279.4 mm
  const pageHeight = doc.internal.pageSize.getHeight(); // 215.9 mm
  const marginX = 12;
  const contentWidth = pageWidth - marginX * 2; // 255.4 mm

  // ===========================================================================
  // 1. ENCABEZADO CORPORATIVO (PÁGINA 1)
  // ===========================================================================
  drawTopAccentBars(doc, pageWidth);

  const logoBoxX = marginX;
  const logoBoxY = 7.5;
  const logoBoxSize = 16.5;

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.35);
  doc.roundedRect(logoBoxX, logoBoxY, logoBoxSize, logoBoxSize, 2, 2, 'FD');

  if (loadedLogo?.dataUrl) {
    try {
      const innerMax = logoBoxSize - 2.4;
      let drawW = innerMax;
      let drawH = innerMax;
      if (loadedLogo.aspectRatio > 1) {
        drawH = innerMax / loadedLogo.aspectRatio;
      } else if (loadedLogo.aspectRatio > 0 && loadedLogo.aspectRatio < 1) {
        drawW = innerMax * loadedLogo.aspectRatio;
      }
      const imgX = logoBoxX + (logoBoxSize - drawW) / 2;
      const imgY = logoBoxY + (logoBoxSize - drawH) / 2;
      doc.addImage(loadedLogo.dataUrl, 'PNG', imgX, imgY, drawW, drawH, undefined, 'FAST');
    } catch {
      doc.setFillColor(220, 38, 38);
      doc.roundedRect(logoBoxX + 1.5, logoBoxY + 1.5, logoBoxSize - 3, logoBoxSize - 3, 1.5, 1.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(255, 255, 255);
      doc.text('CZ', logoBoxX + logoBoxSize / 2, logoBoxY + 10.2, { align: 'center' });
    }
  } else {
    doc.setFillColor(220, 38, 38);
    doc.roundedRect(logoBoxX + 1.5, logoBoxY + 1.5, logoBoxSize - 3, logoBoxSize - 3, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(255, 255, 255);
    doc.text('CZ', logoBoxX + logoBoxSize / 2, logoBoxY + 10.2, { align: 'center' });
  }

  const titleStartX = logoBoxX + logoBoxSize + 3.8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(100, 116, 139);
  doc.text(
    'CODIZULCA C.A. · COMERCIALIZADORA Y DISTRIBUIDORA DEL ZULIA C.A. · RIF: J-07011928-0',
    titleStartX,
    10.6
  );

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text(model.title, titleStartX, 16.2);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(51, 65, 85);
  doc.text(model.periodSubtitle, titleStartX, 20.8);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  if (model.scopeType === 'FILTRADO') {
    doc.setTextColor(180, 83, 9);
  } else {
    doc.setTextColor(30, 64, 175);
  }
  doc.text(`Tipo de Reporte: ${model.scopeDetailLabel}`, titleStartX, 25.1);

  // Etiqueta destacada de Pre-Aprobación (arriba a la derecha)
  const rightEdgeX = pageWidth - marginX;
  const preBadgeW = 79;
  const preBadgeH = 6.8;
  const preBadgeX = rightEdgeX - preBadgeW;
  const preBadgeY = 7.4;

  doc.setFillColor(254, 243, 199); // Amber-100
  doc.setDrawColor(217, 119, 6); // Amber-600
  doc.setLineWidth(0.4);
  doc.roundedRect(preBadgeX, preBadgeY, preBadgeW, preBadgeH, 1.5, 1.5, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(146, 64, 14); // Amber-800
  doc.text(model.preApprovalBadge, preBadgeX + preBadgeW / 2, preBadgeY + 4.5, {
    align: 'center',
  });

  // Usuario emisor + Fecha/Hora exacta America/Caracas
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.4);
  doc.setTextColor(30, 41, 59);
  doc.text(`Emitido por: ${model.issuerDisplay}`, rightEdgeX, 18.4, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.2);
  doc.setTextColor(71, 85, 105);
  doc.text(`Fecha/Hora Emisión: ${model.emission.displayTimestamp}`, rightEdgeX, 22.6, {
    align: 'right',
  });

  if (model.wasTruncatedBySafetyCap) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.6);
    doc.setTextColor(185, 28, 28);
    doc.text(
      `Nota de seguridad: mostrando primeras ${model.maxRowsCap} de ${model.totalMatchedBeforeCap} solicitudes.`,
      rightEdgeX,
      26.2,
      { align: 'right' }
    );
  }

  // Línea divisoria del encabezado
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.35);
  doc.line(marginX, 28.2, rightEdgeX, 28.2);

  // ===========================================================================
  // 2. RESUMEN EJECUTIVO SUPERIOR (4 TARJETAS KPI)
  // ===========================================================================
  const kpiTopY = 30.8;
  const kpiHeight = 16.5;
  const kpiGap = 3.8;
  const kpiCardWidth = (contentWidth - kpiGap * 3) / 4; // 61.0 mm exactos

  const kpiCards: Array<{
    label: string;
    value: string;
    sublabel: string;
    accentRgb: [number, number, number];
  }> = [
    {
      label: 'DEGUSTACIONES SOLICITADAS',
      value: String(model.kpis.totalSolicitadas),
      sublabel: 'Pendientes de aceptación gerencial',
      accentRgb: [220, 38, 38],
    },
    {
      label: 'VENDEDORES SOLICITANTES ÚNICOS',
      value: String(model.kpis.uniqueSellersCount),
      sublabel: 'Fuerza de Ventas con solicitudes',
      accentRgb: [37, 99, 235],
    },
    {
      label: 'CLIENTES / PDV ÚNICOS',
      value: String(model.kpis.uniqueClientsCount),
      sublabel: 'Puntos de venta planificados',
      accentRgb: [5, 150, 105],
    },
    {
      label: 'TOTAL ESTIMADO (UNIDADES / KG)',
      value: `${formatDecimalEs(model.kpis.totalEstimatedQty)} unid./kg`,
      sublabel:
        model.kpis.totalEstimatedSamples > 0
          ? `${model.kpis.totalEstimatedSamples} muestras estimadas en PDV`
          : 'Acumulado según solicitudes FDV',
      accentRgb: [217, 119, 6],
    },
  ];

  kpiCards.forEach((card, idx) => {
    const x = marginX + idx * (kpiCardWidth + kpiGap);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, kpiTopY, kpiCardWidth, kpiHeight, 1.8, 1.8, 'FD');

    // Barra lateral de acento
    doc.setFillColor(card.accentRgb[0], card.accentRgb[1], card.accentRgb[2]);
    doc.roundedRect(x, kpiTopY, 2.2, kpiHeight, 1, 1, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    doc.text(card.label, x + 4.5, kpiTopY + 4.3);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text(card.value, x + 4.5, kpiTopY + 10.6);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(71, 85, 105);
    doc.text(card.sublabel, x + 4.5, kpiTopY + 14.5);
  });

  // ===========================================================================
  // 3. TABLA DETALLADA AUTO-PAGINADA (Encabezado repetido en cada salto de hoja)
  // ===========================================================================
  const tableStartY = kpiTopY + kpiHeight + 4.2; // 51.5 mm

  autoTable(doc, {
    startY: tableStartY,
    margin: {
      top: 17,
      bottom: 15,
      left: marginX,
      right: marginX,
    },
    showHead: 'everyPage',
    rowPageBreak: 'avoid',
    head: [
      [
        '#',
        'Fecha / Hora',
        'Vendedor',
        'Cliente / Punto de Venta',
        'Producto(s) a Degustar',
        'Cant. Estimada',
        'Observaciones del Vendedor',
        'Estado',
      ],
    ],
    body: model.rows.map((row) => [
      String(row.index),
      row.dateTimeCellText,
      row.sellerDisplay,
      row.clientCellText,
      row.productsCellText,
      row.estimatedQtyCellText,
      row.sellerObservationsText,
      row.statusBadgeText,
    ]),
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 7.3,
      cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.25,
      overflow: 'linebreak',
      valign: 'middle',
    },
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.4,
      halign: 'left',
      valign: 'middle',
      cellPadding: { top: 2.5, right: 2, bottom: 2.5, left: 2 },
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    // Anchos exactos que suman 255.4 mm = ancho útil de Carta Horizontal
    columnStyles: {
      0: { cellWidth: 8, halign: 'center', fontStyle: 'bold' },
      1: { cellWidth: 27, halign: 'left' },
      2: { cellWidth: 34, halign: 'left', fontStyle: 'bold' },
      3: { cellWidth: 48, halign: 'left' },
      4: { cellWidth: 44, halign: 'left' },
      5: { cellWidth: 22, halign: 'right', fontStyle: 'bold' },
      6: { cellWidth: 48.4, halign: 'left' },
      7: {
        cellWidth: 24,
        halign: 'center',
        fontStyle: 'bold',
        fillColor: [255, 251, 235],
        textColor: [146, 64, 14],
      },
    },
    didDrawPage: (data) => {
      if (data.pageNumber > 1) {
        drawContinuationHeader(doc, model, pageWidth, marginX);
      }
    },
  });

  // ===========================================================================
  // 4. BLOQUE FORMAL INDIVISIBLE DE FIRMAS PARA AUTORIZACIÓN (SIN CORTARSE)
  // ===========================================================================
  const signatureBlockHeight = 44;
  const footerReservedHeight = 14;
  const lastTableY = Number((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? tableStartY + 12);
  let sigBlockTopY = lastTableY + 6;

  // Si el bloque completo de firmas no cabe íntegro antes del pie de página, saltar a página nueva
  if (sigBlockTopY + signatureBlockHeight > pageHeight - footerReservedHeight) {
    doc.addPage();
    drawContinuationHeader(doc, model, pageWidth, marginX);
    sigBlockTopY = 18.5;
  }

  const boxGap = 3.7;
  const box1Width = 82;
  const box2Width = 82;
  const box3Width = contentWidth - box1Width - box2Width - boxGap * 2; // 84.0 mm exactos
  const boxHeight = 42.5;

  const box1X = marginX;
  const box2X = box1X + box1Width + boxGap;
  const box3X = box2X + box2Width + boxGap;

  const drawSignatureCardFrame = (
    x: number,
    y: number,
    w: number,
    h: number,
    headerMain: string,
    headerSub: string
  ) => {
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.35);
    doc.roundedRect(x, y, w, h, 1.6, 1.6, 'FD');

    // Cabecera gris ejecutiva del recuadro
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(x + 0.2, y + 0.2, w - 0.4, 9.2, 1.4, 1.4, 'F');
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.25);
    doc.line(x, y + 9.4, x + w, y + 9.4);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.1);
    doc.setTextColor(15, 23, 42);
    doc.text(headerMain, x + 3, y + 4.3);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(71, 85, 105);
    doc.text(headerSub, x + 3, y + 7.9);
  };

  // --- RECUADRO 1: SOLICITADO / REVISADO POR (Coordinación / Supervisión) ---
  drawSignatureCardFrame(
    box1X,
    sigBlockTopY,
    box1Width,
    boxHeight,
    'SOLICITADO / REVISADO POR',
    '(Coordinación / Supervisión)'
  );

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.8);
  doc.setTextColor(51, 65, 85);
  doc.text('Nombre:', box1X + 3, sigBlockTopY + 15.5);
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.25);
  doc.line(box1X + 14.5, sigBlockTopY + 15.8, box1X + box1Width - 3.5, sigBlockTopY + 15.8);

  doc.text('Firma:', box1X + 3, sigBlockTopY + 28.5);
  doc.line(box1X + 12.5, sigBlockTopY + 28.8, box1X + box1Width - 3.5, sigBlockTopY + 28.8);

  doc.text('Fecha:', box1X + 3, sigBlockTopY + 38.2);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text('____ / ____ / ________', box1X + 13, sigBlockTopY + 38.2);

  // --- RECUADRO 2: AUTORIZADO POR (Gerencia Comercial / Dirección) ---
  drawSignatureCardFrame(
    box2X,
    sigBlockTopY,
    box2Width,
    boxHeight,
    'AUTORIZADO POR',
    '(Gerencia Comercial / Dirección)'
  );

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.8);
  doc.setTextColor(51, 65, 85);
  doc.text('Nombre:', box2X + 3, sigBlockTopY + 15.5);
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.25);
  doc.line(box2X + 14.5, sigBlockTopY + 15.8, box2X + box2Width - 25, sigBlockTopY + 15.8);

  doc.text('Firma:', box2X + 3, sigBlockTopY + 28.5);
  doc.line(box2X + 12.5, sigBlockTopY + 28.8, box2X + box2Width - 25, sigBlockTopY + 28.8);

  doc.text('Fecha:', box2X + 3, sigBlockTopY + 38.2);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text('____ / ____ / ________', box2X + 13, sigBlockTopY + 38.2);

  // Espacio formal demarcado para Sello Húmedo en Recuadro 2
  const stampX = box2X + box2Width - 22.5;
  const stampY = sigBlockTopY + 12.2;
  doc.setDrawColor(180, 190, 205);
  doc.setLineWidth(0.25);
  doc.roundedRect(stampX, stampY, 19, 27, 1.2, 1.2, 'S');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6);
  doc.setTextColor(148, 163, 184);
  doc.text('SELLO', stampX + 9.5, stampY + 14.2, { align: 'center' });

  // --- RECUADRO 3: Observaciones de Autorización (Líneas manuales limpias) ---
  drawSignatureCardFrame(
    box3X,
    sigBlockTopY,
    box3Width,
    boxHeight,
    'Observaciones de Autorización',
    '(Decisión y anotaciones manuales de Gerencia)'
  );

  doc.setDrawColor(180, 190, 205);
  doc.setLineWidth(0.22);
  const lineStartX = box3X + 3.5;
  const lineEndX = box3X + box3Width - 3.5;
  [16.8, 23.6, 30.4, 37.2].forEach((offsetY) => {
    doc.line(lineStartX, sigBlockTopY + offsetY, lineEndX, sigBlockTopY + offsetY);
  });

  // ===========================================================================
  // 5. PIE DE PÁGINA EN TODAS LAS HOJAS ("Página X de Y")
  // ===========================================================================
  const totalPages = doc.getNumberOfPages();
  const footerLineY = pageHeight - 10.2;
  const footerTextY = pageHeight - 6.2;

  for (let p = 1; p <= totalPages; p += 1) {
    doc.setPage(p);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.25);
    doc.line(marginX, footerLineY, rightEdgeX, footerLineY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(100, 116, 139);
    doc.text(
      'CODIZULCA C.A. · Documento Interno de Control Previo a Aprobación en Sistema (Modo Solo Lectura · Prohibida su alteración)',
      marginX,
      footerTextY
    );

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(30, 41, 59);
    doc.text(`Página ${p} de ${totalPages}`, rightEdgeX, footerTextY, {
      align: 'right',
    });
  }

  return {
    doc,
    fileName: model.fileName,
    pageCount: totalPages,
  };
}

/**
 * Cede brevemente el hilo principal para mantener receptiva la UI, genera el PDF ejecutivo
 * de Solicitud de Autorización y dispara la descarga directa con el nombre estandarizado.
 */
export async function exportPendingTastingAuthorizationPdf(
  model: PendingAuthorizationReportModel,
  options: RenderPendingAuthorizationPdfOptions = {}
): Promise<{ fileName: string; exportedRows: number; pageCount: number }> {
  // Ceder un macrotask antes de compilar el documento para que React pinte "Generando PDF..."
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });

  const { doc, fileName, pageCount } = await renderPendingAuthorizationPdfDocument(model, options);
  doc.save(fileName);

  return {
    fileName,
    exportedRows: model.rows.length,
    pageCount,
  };
}
