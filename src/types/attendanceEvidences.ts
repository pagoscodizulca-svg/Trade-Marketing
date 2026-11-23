import { z } from 'zod';

// =============================================================================
// CONTRATOS DE DOMINIO Y ESQUEMAS ZOD: EVIDENCIAS DE ASISTENCIA POR PERFIL
// =============================================================================

export const PERFILES_ASISTENCIA = ['FIJA', 'EVENTUAL'] as const;
export type PerfilAsistencia = (typeof PERFILES_ASISTENCIA)[number];

export const SLOTS_FOTO_FIJA = ['JORNADA_INGRESO', 'JORNADA_SALIDA'] as const;
export type SlotFotoFija = (typeof SLOTS_FOTO_FIJA)[number];

export const SLOTS_FOTO_EVENTUAL = [
  'MANANA_INGRESO',
  'MANANA_SALIDA',
  'TARDE_INGRESO',
  'TARDE_SALIDA',
] as const;
export type SlotFotoEventual = (typeof SLOTS_FOTO_EVENTUAL)[number];

export const ALL_SLOTS_FOTO_ASISTENCIA = [
  ...SLOTS_FOTO_FIJA,
  ...SLOTS_FOTO_EVENTUAL,
] as const;
export type SlotFotoAsistencia = (typeof ALL_SLOTS_FOTO_ASISTENCIA)[number];

export const ALLOWED_ATTENDANCE_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type AllowedAttendanceImageMime = (typeof ALLOWED_ATTENDANCE_IMAGE_MIMES)[number];

export const MAX_ATTENDANCE_EVIDENCE_BYTES = 5 * 1024 * 1024; // 5 MB exactos (5_242_880 bytes)
export const ASISTENCIA_PRIVATE_BUCKET_ID = 'asistencia-evidencias';
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 900; // 15 minutos
export const VENEZUELA_TIMEZONE = 'America/Caracas';

export type EstadoCumplimientoAsistencia = 'COMPLETA' | 'INCOMPLETA' | 'SIN_REGISTRO';

export interface SlotFotoMetadata {
  slot: SlotFotoAsistencia;
  perfil: PerfilAsistencia;
  order: number;
  blockKey: 'JORNADA_UNICA' | 'MANANA' | 'TARDE';
  blockTitle: string | null; // null en FIJA para no renderizar referencias a mañana/tarde
  cardTitle: string;
  shortBadge: string;
  subtitle: string;
  emptyStateLabel: string;
  ariaActionPhrase: string; // ej. "foto de ingreso jornada de la mañana"
}

export const SLOT_FOTO_CATALOG: Record<SlotFotoAsistencia, SlotFotoMetadata> = {
  JORNADA_INGRESO: {
    slot: 'JORNADA_INGRESO',
    perfil: 'FIJA',
    order: 1,
    blockKey: 'JORNADA_UNICA',
    blockTitle: null,
    cardTitle: '1. Ingreso a la jornada laboral',
    shortBadge: 'INGRESO JORNADA',
    subtitle: 'Apertura oficial de jornada en PDV',
    emptyStateLabel: 'Sin evidencia de ingreso a la jornada laboral',
    ariaActionPhrase: 'foto de ingreso a la jornada laboral',
  },
  JORNADA_SALIDA: {
    slot: 'JORNADA_SALIDA',
    perfil: 'FIJA',
    order: 2,
    blockKey: 'JORNADA_UNICA',
    blockTitle: null,
    cardTitle: '2. Salida de la jornada laboral',
    shortBadge: 'SALIDA JORNADA',
    subtitle: 'Cierre oficial de jornada en PDV',
    emptyStateLabel: 'Sin evidencia de salida de la jornada laboral',
    ariaActionPhrase: 'foto de salida de la jornada laboral',
  },
  MANANA_INGRESO: {
    slot: 'MANANA_INGRESO',
    perfil: 'EVENTUAL',
    order: 1,
    blockKey: 'MANANA',
    blockTitle: 'Jornada de la Mañana',
    cardTitle: '1. Ingreso — Jornada de la mañana',
    shortBadge: 'MAÑANA · INGRESO',
    subtitle: 'Apertura del bloque matutino en PDV',
    emptyStateLabel: 'Sin evidencia de ingreso en jornada de la mañana',
    ariaActionPhrase: 'foto de ingreso jornada de la mañana',
  },
  MANANA_SALIDA: {
    slot: 'MANANA_SALIDA',
    perfil: 'EVENTUAL',
    order: 2,
    blockKey: 'MANANA',
    blockTitle: 'Jornada de la Mañana',
    cardTitle: '2. Salida — Jornada de la mañana',
    shortBadge: 'MAÑANA · SALIDA',
    subtitle: 'Cierre del bloque matutino en PDV',
    emptyStateLabel: 'Sin evidencia de salida en jornada de la mañana',
    ariaActionPhrase: 'foto de salida jornada de la mañana',
  },
  TARDE_INGRESO: {
    slot: 'TARDE_INGRESO',
    perfil: 'EVENTUAL',
    order: 3,
    blockKey: 'TARDE',
    blockTitle: 'Jornada de la Tarde',
    cardTitle: '3. Ingreso — Jornada de la tarde',
    shortBadge: 'TARDE · INGRESO',
    subtitle: 'Apertura del bloque vespertino en PDV',
    emptyStateLabel: 'Sin evidencia de ingreso en jornada de la tarde',
    ariaActionPhrase: 'foto de ingreso jornada de la tarde',
  },
  TARDE_SALIDA: {
    slot: 'TARDE_SALIDA',
    perfil: 'EVENTUAL',
    order: 4,
    blockKey: 'TARDE',
    blockTitle: 'Jornada de la Tarde',
    cardTitle: '4. Salida — Jornada de la tarde',
    shortBadge: 'TARDE · SALIDA',
    subtitle: 'Cierre del bloque vespertino en PDV',
    emptyStateLabel: 'Sin evidencia de salida en jornada de la tarde',
    ariaActionPhrase: 'foto de salida jornada de la tarde',
  },
};

export interface AsistenciaJornadaDbRow {
  id: string;
  fecha_jornada: string; // YYYY-MM-DD
  promotora_id: string;
  promotora_nombre: string;
  perfil_aplicado: PerfilAsistencia;
  pdv_nombre: string;
  zona: string;
  sucursal?: 'ZULIA' | 'VALENCIA' | 'CENTRO' | 'ORIENTE' | 'CAPITAL' | null;
  opened_at_server: string;
  updated_at_server: string;
  opened_by_uid: string | null;
}

export interface AsistenciaEvidenciaDbRow {
  id: string;
  asistencia_id: string;
  slot_foto: SlotFotoAsistencia;
  storage_bucket: string;
  storage_path: string;
  mime_type: AllowedAttendanceImageMime;
  tamano_bytes: number;
  sha256_hex: string;
  ancho_px: number | null;
  alto_px: number | null;
  pdv_nombre: string;
  lat: number | null;
  lng: number | null;
  gps_accuracy: number | null;
  sucursal?: 'ZULIA' | 'VALENCIA' | 'CENTRO' | 'ORIENTE' | 'CAPITAL' | null;
  capturado_en_servidor: string;
  cargado_por_uid: string | null;
  cargado_por_rol: 'promotora' | 'coordinadora' | 'admin';
  /** Versión de bloqueo optimista anti-TOCTOU (inicia en 1). */
  version?: number;
  /** Marca temporal de última actualización confirmada en servidor. */
  updated_at?: string;
}

export interface AttendanceSlotEvidenceItem {
  id: string; // UUID en asistencia_evidencias o `legacy:<checkinId>`
  source: 'storage_privado' | 'legacy_checkin';
  slotFoto: SlotFotoAsistencia;
  storagePath: string | null;
  legacyCheckinId: string | null;
  mimeType: AllowedAttendanceImageMime;
  sizeBytes: number;
  pdvNombre: string;
  capturadoEnServidorIso: string;
  horaCaracasFormateada: string; // ej. "08:42 a. m."
  horaCaracasCompleta: string; // ej. "08:42:15 a. m. (UTC-4)"
  fechaFormateada: string; // DD/MM/YYYY
  lat?: number;
  lng?: number;
  gpsAccuracy?: number;
  mapsUrl?: string;
  signedUrl?: string;
}

export interface AttendanceComplianceSummary {
  perfilAplicado: PerfilAsistencia;
  uploadedCount: number;
  requiredCount: 2 | 4;
  fractionLabel: string; // "2/2", "1/2", "0/2", "4/4", "3/4", etc.
  status: EstadoCumplimientoAsistencia;
  statusLabel: string; // "Completa" | "En curso / Incompleta" | "Parcial / Incompleta" | "Sin registro"
}

export interface DailyPromotoraAttendanceViewModel {
  key: string; // `${fechaJornada}__${promotoraId}`
  asistenciaId: string | null;
  fechaJornada: string; // YYYY-MM-DD
  fechaSlash: string; // DD/MM/YYYY
  fechaLongEs: string;
  promotoraId: string;
  promotoraNombre: string;
  promotoraInitials: string;
  promotoraEmail: string;
  pdvNombre: string;
  zona: string;
  perfilAplicado: PerfilAsistencia;
  perfilFuente: 'SNAPSHOT_HISTORICO' | 'PERFIL_MAESTRO_ACTUAL';
  compliance: AttendanceComplianceSummary;
  evidencesBySlot: Partial<Record<SlotFotoAsistencia, AttendanceSlotEvidenceItem>>;
  mapsUrl?: string;
}

// =============================================================================
// ESQUEMAS ESTRICTOS DE VALIDACIÓN CON ZOD
// =============================================================================

const ISO_DATE_YMD_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isValidCalendarYmd(ymd: string): boolean {
  if (!ISO_DATE_YMD_REGEX.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function sanitizeAttendanceText(raw: unknown, maxLen = 160): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function getCaracasTodayYmd(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: VENEZUELA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now);
}

export function formatServerTimestampCaracas(
  isoTimestamp: string | Date,
  options?: { includeSeconds?: boolean }
): string {
  const dt = isoTimestamp instanceof Date ? isoTimestamp : new Date(isoTimestamp);
  if (Number.isNaN(dt.getTime())) {
    return options?.includeSeconds ? '--:--:--' : '--:--';
  }
  return dt.toLocaleTimeString('es-VE', {
    timeZone: VENEZUELA_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    ...(options?.includeSeconds ? { second: '2-digit' } : {}),
    hour12: true,
  });
}

export function formatYmdToSlash(ymd: string): string {
  const parts = String(ymd || '').split('-');
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function formatYmdToLongEs(ymd: string): string {
  if (!isValidCalendarYmd(ymd)) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
  return utcNoon
    .toLocaleDateString('es-VE', {
      timeZone: VENEZUELA_TIMEZONE,
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    })
    .toUpperCase();
}

export const PerfilAsistenciaSchema = z.enum(PERFILES_ASISTENCIA);
export const SlotFotoAsistenciaSchema = z.enum(ALL_SLOTS_FOTO_ASISTENCIA);

export const UploadAttendanceEvidenceMetadataSchema = z.object({
  promotoraId: z.string().uuid('El identificador de la promotora debe ser un UUID válido.'),
  fechaJornada: z
    .string()
    .trim()
    .refine(isValidCalendarYmd, 'La fecha de la jornada debe tener formato válido YYYY-MM-DD.'),
  slotFoto: SlotFotoAsistenciaSchema,
  pdvNombre: z
    .string()
    .optional()
    .default('')
    .transform((val) => sanitizeAttendanceText(val, 180)),
  zona: z
    .string()
    .optional()
    .default('')
    .transform((val) => sanitizeAttendanceText(val, 180)),
  anchoPx: z.coerce.number().int().min(1).max(4096).optional().nullable(),
  altoPx: z.coerce.number().int().min(1).max(4096).optional().nullable(),
  lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  lng: z.coerce.number().min(-180).max(180).optional().nullable(),
  gpsAccuracy: z.coerce.number().min(0).max(100000).optional().nullable(),
  sucursal: z.string().trim().max(64).optional(),
  expectedVersion: z.coerce.number().int().min(1).max(1_000_000).optional().nullable(),
});

export type UploadAttendanceEvidenceMetadata = z.infer<
  typeof UploadAttendanceEvidenceMetadataSchema
>;

export const BatchSignedUrlsRequestSchema = z.object({
  evidenciaIds: z
    .array(z.string().uuid('Cada evidenciaId debe ser un UUID válido.'))
    .min(1, 'Debe solicitar al menos una evidencia.')
    .max(60, 'Máximo 60 evidencias por lote de Signed URLs.'),
});

// =============================================================================
// REGLAS PURAS DE NEGOCIO, SNAPSHOT HISTÓRICO Y CUMPLIMIENTO (2/2 vs 4/4)
// =============================================================================

export function getAllowedSlotsForProfile(
  perfil: PerfilAsistencia
): readonly SlotFotoAsistencia[] {
  return perfil === 'FIJA' ? SLOTS_FOTO_FIJA : SLOTS_FOTO_EVENTUAL;
}

export function getRequiredPhotoCountForProfile(perfil: PerfilAsistencia): 2 | 4 {
  return perfil === 'FIJA' ? 2 : 4;
}

export function isSlotAllowedForProfile(
  perfil: PerfilAsistencia,
  slot: SlotFotoAsistencia
): boolean {
  const allowed = getAllowedSlotsForProfile(perfil);
  return allowed.includes(slot);
}

/**
 * Valida de forma determinista que la ranura solicitada pertenezca al `perfil_aplicado`
 * y que no se supere el máximo estricto de fotos de la jornada (permitiendo reemplazo idempotente
 * si la ranura ya estaba ocupada).
 */
export function validateSlotAgainstAppliedProfile(params: {
  perfilAplicado: PerfilAsistencia;
  slotFoto: SlotFotoAsistencia;
  existingSlotsInJornada: readonly SlotFotoAsistencia[];
}): {
  ok: true;
  isReplacement: boolean;
} | {
  ok: false;
  code: 'SLOT_NOT_ALLOWED_FOR_PROFILE' | 'MAX_SLOTS_EXCEEDED';
  message: string;
} {
  const { perfilAplicado, slotFoto, existingSlotsInJornada } = params;

  if (!isSlotAllowedForProfile(perfilAplicado, slotFoto)) {
    const allowedText = getAllowedSlotsForProfile(perfilAplicado).join(', ');
    return {
      ok: false,
      code: 'SLOT_NOT_ALLOWED_FOR_PROFILE',
      message:
        perfilAplicado === 'FIJA'
          ? `El perfil FIJA solo permite exactamente 2 evidencias (${allowedText}). No se admite ${slotFoto}.`
          : `El perfil EVENTUAL solo permite las 4 evidencias de Mañana y Tarde (${allowedText}). No se admite ${slotFoto}.`,
    };
  }

  const uniqueExisting = new Set(
    existingSlotsInJornada.filter((s) => isSlotAllowedForProfile(perfilAplicado, s))
  );
  const isReplacement = uniqueExisting.has(slotFoto);
  const maxAllowed = getRequiredPhotoCountForProfile(perfilAplicado);

  if (!isReplacement && uniqueExisting.size >= maxAllowed) {
    return {
      ok: false,
      code: 'MAX_SLOTS_EXCEEDED',
      message: `La jornada de perfil ${perfilAplicado} ya alcanzó su máximo permitido de ${maxAllowed} evidencias fotográficas.`,
    };
  }

  return {
    ok: true,
    isReplacement,
  };
}

/**
 * Calcula el progreso (`0/2..2/2` o `0/4..4/4`) y el estado exacto de cumplimiento según `perfil_aplicado`:
 * - FIJA:     `2/2` = Completa | `1/2` = En curso / Incompleta | `0/2` = Sin registro
 * - EVENTUAL: `4/4` = Completa | `1/4..3/4` = Parcial / Incompleta | `0/4` = Sin registro
 */
export function evaluateAttendanceCompliance(
  perfilAplicado: PerfilAsistencia,
  presentSlots: Iterable<SlotFotoAsistencia>
): AttendanceComplianceSummary {
  const allowedSet = new Set(getAllowedSlotsForProfile(perfilAplicado));
  const validPresent = new Set<SlotFotoAsistencia>();

  for (const slot of presentSlots) {
    if (allowedSet.has(slot)) {
      validPresent.add(slot);
    }
  }

  const requiredCount = getRequiredPhotoCountForProfile(perfilAplicado);
  const uploadedCount = Math.min(requiredCount, validPresent.size);
  const fractionLabel = `${uploadedCount}/${requiredCount}`;

  if (uploadedCount === 0) {
    return {
      perfilAplicado,
      uploadedCount: 0,
      requiredCount,
      fractionLabel,
      status: 'SIN_REGISTRO',
      statusLabel: 'Sin registro',
    };
  }

  if (uploadedCount >= requiredCount) {
    return {
      perfilAplicado,
      uploadedCount: requiredCount,
      requiredCount,
      fractionLabel,
      status: 'COMPLETA',
      statusLabel: 'Completa',
    };
  }

  return {
    perfilAplicado,
    uploadedCount,
    requiredCount,
    fractionLabel,
    status: 'INCOMPLETA',
    statusLabel:
      perfilAplicado === 'FIJA' ? 'En curso / Incompleta' : 'Parcial / Incompleta',
  };
}

/**
 * Regla de Inmutabilidad Histórica (Snapshot de Perfil):
 * - Si existe registro de jornada para `(fecha, promotora)` con `perfil_aplicado` guardado,
 *   SIEMPRE prevalece ese snapshot histórico (aunque el perfil maestro haya cambiado después).
 * - Únicamente cuando aún no existe registro para la fecha seleccionada, se utiliza el perfil
 *   actual en la tabla maestra de promotoras.
 */
export function resolveEffectiveAttendanceProfile(params: {
  historicalSnapshotProfile?: PerfilAsistencia | null;
  currentMasterCategory?: 'fija' | 'eventual' | 'merchandising' | string | null;
}): {
  perfilAplicado: PerfilAsistencia;
  fuente: 'SNAPSHOT_HISTORICO' | 'PERFIL_MAESTRO_ACTUAL';
} {
  if (
    params.historicalSnapshotProfile === 'FIJA' ||
    params.historicalSnapshotProfile === 'EVENTUAL'
  ) {
    return {
      perfilAplicado: params.historicalSnapshotProfile,
      fuente: 'SNAPSHOT_HISTORICO',
    };
  }

  const normalized = String(params.currentMasterCategory || '')
    .trim()
    .toLowerCase();
  return {
    perfilAplicado: normalized === 'eventual' ? 'EVENTUAL' : 'FIJA',
    fuente: 'PERFIL_MAESTRO_ACTUAL',
  };
}

/**
 * Construye un `aria-label` descriptivo y accesible por ranura y promotora.
 * Ejemplo: `"Subir foto de ingreso jornada de la mañana para Camila Morales"`
 */
export function buildSlotActionAriaLabel(params: {
  slotFoto: SlotFotoAsistencia;
  promotoraNombre: string;
  isReplacement: boolean;
}): string {
  const meta = SLOT_FOTO_CATALOG[params.slotFoto];
  const cleanName = sanitizeAttendanceText(params.promotoraNombre, 120) || 'la promotora';
  const verb = params.isReplacement ? 'Reemplazar' : 'Subir';
  return `${verb} ${meta.ariaActionPhrase} para ${cleanName}`;
}
