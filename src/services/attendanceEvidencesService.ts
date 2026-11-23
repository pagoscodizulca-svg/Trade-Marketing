import {
  type AsistenciaEvidenciaDbRow,
  type AsistenciaJornadaDbRow,
  type AttendanceComplianceSummary,
  type AttendanceSlotEvidenceItem,
  type DailyPromotoraAttendanceViewModel,
  evaluateAttendanceCompliance,
  formatServerTimestampCaracas,
  formatYmdToLongEs,
  formatYmdToSlash,
  type PerfilAsistencia,
  resolveEffectiveAttendanceProfile,
  sanitizeAttendanceText,
  type SlotFotoAsistencia,
  type UploadAttendanceEvidenceMetadata,
} from '../types/attendanceEvidences';
import { compressAttendancePhotoForMobileUpload } from '../utils/attendanceImageCompressor';
import { getActiveAccessToken } from './authService';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import {
  type AttendanceRecord,
  type AttendanceSlotEvent,
  normalizeStaffTextKey,
  type StaffMemberRecord,
} from './supabaseModule1';

export interface UploadAttendanceEvidenceResponse {
  ok: boolean;
  replaced: boolean;
  jornada: {
    id: string;
    fechaJornada: string;
    promotoraId: string;
    promotoraNombre: string;
    perfilAplicado: PerfilAsistencia;
    pdvNombre: string;
    zona: string;
  };
  evidencia: {
    id: string;
    asistenciaId: string;
    slotFoto: SlotFotoAsistencia;
    storagePath: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    sizeBytes: number;
    pdvNombre: string;
    capturadoEnServidorIso: string;
    horaCaracasFormateada: string;
    horaCaracasCompleta: string;
    fechaFormateada: string;
    lat: number | null;
    lng: number | null;
    gpsAccuracy: number | null;
    signedUrl: string;
    signedUrlExpiresAtIso: string;
  };
  compliance: AttendanceComplianceSummary;
}

// Caché en memoria de Signed URLs privadas con renovación preventiva 60s antes de vencer
const signedUrlMemoryCache = new Map<string, { url: string; expiresAtMs: number }>();
const SIGNED_URL_RENEW_SKEW_MS = 60_000;

export function getCachedEvidenceSignedUrl(evidenciaId: string): string | null {
  const entry = signedUrlMemoryCache.get(evidenciaId);
  if (!entry) return null;
  if (Date.now() + SIGNED_URL_RENEW_SKEW_MS >= entry.expiresAtMs) {
    signedUrlMemoryCache.delete(evidenciaId);
    return null;
  }
  return entry.url;
}

export function rememberEvidenceSignedUrl(
  evidenciaId: string,
  url: string,
  expiresAtIso: string
): void {
  if (!evidenciaId || !url) return;
  const parsedMs = new Date(expiresAtIso).getTime();
  const safeExpiresAt = Number.isFinite(parsedMs)
    ? parsedMs
    : Date.now() + 14 * 60 * 1000;
  signedUrlMemoryCache.set(evidenciaId, {
    url,
    expiresAtMs: safeExpiresAt,
  });
}

function encodeUtf8ToBase64Url(jsonText: string): string {
  const bytes = new TextEncoder().encode(jsonText);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function getInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'PR';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

/**
 * Comprime la foto en cliente (`<= 1600px`, calidad `0.80` WebP/JPEG) y la sube con
 * `XMLHttpRequest` reportando porcentaje real de avance (`0..100`) hacia el backend Zero Trust.
 */
export async function uploadCompressedAttendanceEvidence(params: {
  file: File | Blob;
  metadata: UploadAttendanceEvidenceMetadata;
  onProgress?: (percent: number) => void;
}): Promise<UploadAttendanceEvidenceResponse> {
  const token = await getActiveAccessToken();
  if (!token) {
    throw new Error(
      'Para cargar o reemplazar evidencias debe iniciar sesión autenticada (Coordinadora, Admin o Promotora).'
    );
  }

  params.onProgress?.(5);
  const compressed = await compressAttendancePhotoForMobileUpload(params.file);
  params.onProgress?.(18);

  const fullMeta: UploadAttendanceEvidenceMetadata = {
    ...params.metadata,
    anchoPx: compressed.width,
    altoPx: compressed.height,
  };

  const encodedHeader = encodeUtf8ToBase64Url(JSON.stringify(fullMeta));

  const responsePayload = await new Promise<UploadAttendanceEvidenceResponse>(
    (resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/asistencia/evidencias', true);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', compressed.mimeType);
      xhr.setRequestHeader('X-Asistencia-Meta', encodedHeader);

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && ev.total > 0) {
          const uploadFraction = ev.loaded / ev.total;
          const mappedPercent = Math.min(96, Math.max(18, Math.round(18 + uploadFraction * 78)));
          params.onProgress?.(mappedPercent);
        }
      };

      xhr.onerror = () => {
        reject(
          new Error(
            'Error de red al subir la fotografía. Verifique su conexión móvil e intente nuevamente.'
          )
        );
      };

      xhr.ontimeout = () => {
        reject(new Error('Tiempo de espera agotado durante la carga de la fotografía.'));
      };
      xhr.timeout = 45_000;

      xhr.onload = () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>;
        } catch {
          parsed = {};
        }

        if (xhr.status >= 200 && xhr.status < 300 && parsed.ok) {
          params.onProgress?.(100);
          resolve(parsed as unknown as UploadAttendanceEvidenceResponse);
          return;
        }

        const serverError =
          typeof parsed.error === 'string' && parsed.error.trim()
            ? parsed.error.trim()
            : `No se pudo registrar la evidencia fotográfica (HTTP ${xhr.status}).`;
        reject(new Error(serverError));
      };

      xhr.send(compressed.blob);
    }
  );

  if (
    responsePayload.evidencia?.id &&
    responsePayload.evidencia?.signedUrl &&
    responsePayload.evidencia?.signedUrlExpiresAtIso
  ) {
    rememberEvidenceSignedUrl(
      responsePayload.evidencia.id,
      responsePayload.evidencia.signedUrl,
      responsePayload.evidencia.signedUrlExpiresAtIso
    );
  }

  return responsePayload;
}

/**
 * Obtiene por lote URLs firmadas temporales (`Signed URLs`) para evidencias almacenadas
 * en el bucket privado `asistencia-evidencias`.
 * Usa primero `/api/asistencia/evidencias/signed-urls` y, ante ausencia de BFF o faltantes,
 * firma directamente con la sesión autenticada de Supabase Storage (`createSignedUrls`).
 */
export async function fetchBatchEvidenceSignedUrls(
  evidenciaIds: string[],
  storagePathByEvidenceId?: Record<string, string>
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const missingIds: string[] = [];

  for (const rawId of evidenciaIds) {
    const id = String(rawId || '').trim();
    if (!id || id.startsWith('legacy:')) continue;
    const cached = getCachedEvidenceSignedUrl(id);
    if (cached) {
      result[id] = cached;
    } else if (!missingIds.includes(id)) {
      missingIds.push(id);
    }
  }

  if (missingIds.length === 0) {
    return result;
  }

  const token = await getActiveAccessToken();
  if (token) {
    for (let idx = 0; idx < missingIds.length; idx += 60) {
      const chunk = missingIds.slice(idx, idx + 60);
      try {
        const res = await fetch('/api/asistencia/evidencias/signed-urls', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ evidenciaIds: chunk }),
        });

        if (!res.ok) continue;
        const payload = (await res.json().catch(() => ({}))) as {
          signedUrls?: Record<string, { url: string; expiresAtIso: string }>;
        };

        for (const [evId, info] of Object.entries(payload.signedUrls || {})) {
          if (info?.url) {
            rememberEvidenceSignedUrl(evId, info.url, info.expiresAtIso);
            result[evId] = info.url;
          }
        }
      } catch {
        // Respaldo directo con SDK autenticado abajo
      }
    }
  }

  // Respaldo autenticado directo contra Supabase Storage para cualquier evidencia aún sin URL
  const unresolvedWithPaths = missingIds
    .filter((id) => !result[id] && storagePathByEvidenceId?.[id])
    .map((id) => ({ id, path: String(storagePathByEvidenceId![id] || '').trim() }))
    .filter((item) => item.path.length > 0 && !item.path.includes('..'));

  if (unresolvedWithPaths.length > 0 && isSupabaseConfigured) {
    try {
      const client = getSupabaseClient();
      const { data, error } = await client.storage
        .from('asistencia-evidencias')
        .createSignedUrls(
          unresolvedWithPaths.map((x) => x.path),
          900
        );
      if (!error && Array.isArray(data)) {
        const expiresAtIso = new Date(Date.now() + 900 * 1000).toISOString();
        data.forEach((entry, index) => {
          const target = unresolvedWithPaths[index];
          if (target && entry?.signedUrl) {
            rememberEvidenceSignedUrl(target.id, entry.signedUrl, expiresAtIso);
            result[target.id] = entry.signedUrl;
          }
        });
      }
    } catch {
      // Silencioso si no hay sesión o Storage no está listo
    }
  }

  return result;
}

function mapLegacySlotEventToEvidenceItem(
  slotFoto: SlotFotoAsistencia,
  ev: AttendanceSlotEvent
): AttendanceSlotEvidenceItem {
  return {
    id: `legacy:${ev.checkinId}`,
    source: 'legacy_checkin',
    slotFoto,
    storagePath: null,
    legacyCheckinId: ev.checkinId,
    mimeType: 'image/jpeg',
    sizeBytes: 0,
    pdvNombre: ev.storeName || 'PDV',
    capturadoEnServidorIso: ev.isoDate,
    horaCaracasFormateada: ev.timeFormatted,
    horaCaracasCompleta: `${ev.fullTimeFormatted} (UTC-4)`,
    fechaFormateada: ev.dateFormatted,
    lat: ev.lat,
    lng: ev.lng,
    gpsAccuracy: ev.accuracy,
    mapsUrl: ev.mapsUrl,
  };
}

function mapDbEvidenceRowToItem(
  row: AsistenciaEvidenciaDbRow,
  fechaJornada: string
): AttendanceSlotEvidenceItem {
  const lat = typeof row.lat === 'number' ? row.lat : undefined;
  const lng = typeof row.lng === 'number' ? row.lng : undefined;
  const gpsAccuracy =
    typeof row.gps_accuracy === 'number' ? Math.round(row.gps_accuracy) : undefined;
  const mapsUrl =
    lat !== undefined && lng !== undefined
      ? `https://www.google.com/maps?q=${lat},${lng}`
      : undefined;

  return {
    id: row.id,
    source: 'storage_privado',
    slotFoto: row.slot_foto,
    storagePath: row.storage_path,
    legacyCheckinId: null,
    mimeType: row.mime_type,
    sizeBytes: row.tamano_bytes,
    pdvNombre: row.pdv_nombre || 'PDV',
    capturadoEnServidorIso: row.capturado_en_servidor,
    horaCaracasFormateada: formatServerTimestampCaracas(row.capturado_en_servidor),
    horaCaracasCompleta: `${formatServerTimestampCaracas(row.capturado_en_servidor, {
      includeSeconds: true,
    })} (UTC-4)`,
    fechaFormateada: formatYmdToSlash(fechaJornada),
    lat,
    lng,
    gpsAccuracy,
    mapsUrl,
    signedUrl: getCachedEvidenceSignedUrl(row.id) || undefined,
  };
}

/**
 * Construye los modelos diarios de asistencia unificando:
 * 1. Registros oficiales en `public.asistencias_jornada` + `public.asistencia_evidencias`
 *    (obedeciendo SIEMPRE su snapshot histórico `perfil_aplicado`).
 * 2. Proyección no destructiva de registros previos en `public.checkins` cuando no exista
 *    aún cabecera en `asistencias_jornada` para esa `(fecha, promotora)` (`2` slots para FIJA,
 *    `4` slots para EVENTUAL).
 * 3. Al seleccionar una fecha específica (`selectedDateYmd`), incluye a todas las promotoras
 *    activas (`fija` y `eventual`) mostrando `0/2 · Sin registro` o `0/4 · Sin registro` usando
 *    el perfil maestro actual ÚNICAMENTE si esa promotora aún no tiene jornada abierta ese día.
 */
export function buildDailyPromotoraAttendanceViewModels(params: {
  staffMembers: StaffMemberRecord[];
  asistenciaJornadas: AsistenciaJornadaDbRow[];
  asistenciaEvidencias: AsistenciaEvidenciaDbRow[];
  legacyAttendanceRecords: AttendanceRecord[];
  selectedDateYmd?: string | null; // null o '' = modo "Todas las fechas con registro"
}): DailyPromotoraAttendanceViewModel[] {
  const eligibleStaff = params.staffMembers.filter(
    (s) => s.status === 'Activo' && (s.category === 'fija' || s.category === 'eventual')
  );

  const staffById = new Map<string, StaffMemberRecord>();
  const staffByNameKey = new Map<string, StaffMemberRecord>();
  for (const s of eligibleStaff) {
    staffById.set(s.id, s);
    const nameKey = normalizeStaffTextKey(s.name);
    if (nameKey && !staffByNameKey.has(nameKey)) {
      staffByNameKey.set(nameKey, s);
    }
  }

  const evidencesByJornadaId = new Map<string, AsistenciaEvidenciaDbRow[]>();
  for (const ev of params.asistenciaEvidencias) {
    const list = evidencesByJornadaId.get(ev.asistencia_id) || [];
    list.push(ev);
    evidencesByJornadaId.set(ev.asistencia_id, list);
  }

  const byDateAndPromotoraKey = new Map<string, DailyPromotoraAttendanceViewModel>();
  const cleanSelectedDate = String(params.selectedDateYmd || '').trim();

  // 1. Primero: cabeceras oficiales con `perfil_aplicado` histórico inmutable
  const resolveRegionLabel = (
    rawRegion?: string | null,
    rawSucursal?: string | null,
    staffRegion?: 'Occidente' | 'Valencia' | string | null
  ): 'Occidente' | 'Valencia' => {
    const cleanReg = String(rawRegion || '').trim().toLowerCase();
    if (cleanReg === 'valencia' || cleanReg === 'centro') return 'Valencia';
    if (cleanReg === 'occidente' || cleanReg === 'zulia') return 'Occidente';
    const cleanSuc = String(rawSucursal || '').trim().toUpperCase();
    if (cleanSuc === 'VALENCIA' || cleanSuc === 'CENTRO') return 'Valencia';
    if (staffRegion === 'Valencia') return 'Valencia';
    return 'Occidente';
  };

  for (const j of params.asistenciaJornadas) {
    if (cleanSelectedDate && j.fecha_jornada !== cleanSelectedDate) continue;

    const staff =
      staffById.get(j.promotora_id) ||
      (j.promotora_ref_id != null ? staffById.get(String(j.promotora_ref_id)) : undefined) ||
      staffByNameKey.get(normalizeStaffTextKey(j.promotora_nombre));
    const resolved = resolveEffectiveAttendanceProfile({
      historicalSnapshotProfile: j.perfil_aplicado,
      currentMasterCategory: staff?.category ?? null,
    });

    const rawEvs = evidencesByJornadaId.get(j.id) || [];
    const evidencesBySlot: Partial<Record<SlotFotoAsistencia, AttendanceSlotEvidenceItem>> = {};
    let latestMapsUrl: string | undefined;

    for (const evRow of rawEvs) {
      const mapped = mapDbEvidenceRowToItem(evRow, j.fecha_jornada);
      evidencesBySlot[evRow.slot_foto] = mapped;
      if (mapped.mapsUrl) latestMapsUrl = mapped.mapsUrl;
    }

    const compliance = evaluateAttendanceCompliance(
      resolved.perfilAplicado,
      Object.keys(evidencesBySlot) as SlotFotoAsistencia[]
    );

    const promotoraNombre =
      sanitizeAttendanceText(j.promotora_nombre, 160) ||
      staff?.name ||
      'Promotora Verificada';
    const canonicalPromotoraId = staff?.id || j.promotora_id;
    const key = `${j.fecha_jornada}__${canonicalPromotoraId}`;

    byDateAndPromotoraKey.set(key, {
      key,
      asistenciaId: j.id,
      fechaJornada: j.fecha_jornada,
      fechaSlash: formatYmdToSlash(j.fecha_jornada),
      fechaLongEs: formatYmdToLongEs(j.fecha_jornada),
      promotoraId: canonicalPromotoraId,
      promotoraNombre,
      promotoraInitials: getInitials(promotoraNombre),
      promotoraEmail: staff?.email || '',
      pdvNombre: j.pdv_nombre || staff?.assignedStore || 'PDV por definir',
      zona: j.zona || staff?.address || 'Zona operativa',
      region: resolveRegionLabel(j.region, j.sucursal, staff?.region),
      perfilAplicado: resolved.perfilAplicado,
      perfilFuente: resolved.fuente,
      compliance,
      evidencesBySlot,
      mapsUrl: latestMapsUrl,
    });
  }

  // 2. Segundo: proyectar registros históricos de `public.checkins` que no tengan cabecera en `asistencias_jornada`
  for (const legacy of params.legacyAttendanceRecords) {
    if (cleanSelectedDate && legacy.date !== cleanSelectedDate) continue;

    const matchedStaff =
      (legacy.promotoraId ? staffById.get(legacy.promotoraId) : undefined) ||
      staffByNameKey.get(normalizeStaffTextKey(legacy.promotora));

    // Excluir perfiles de merchandising o dados de baja
    if (!matchedStaff) continue;

    const key = `${legacy.date}__${matchedStaff.id}`;
    if (byDateAndPromotoraKey.has(key)) continue;

    const resolved = resolveEffectiveAttendanceProfile({
      historicalSnapshotProfile: null,
      currentMasterCategory: matchedStaff.category,
    });

    const evidencesBySlot: Partial<Record<SlotFotoAsistencia, AttendanceSlotEvidenceItem>> = {};
    if (resolved.perfilAplicado === 'FIJA') {
      if (legacy.ingresoEvent) {
        evidencesBySlot.JORNADA_INGRESO = mapLegacySlotEventToEvidenceItem(
          'JORNADA_INGRESO',
          legacy.ingresoEvent
        );
      }
      if (legacy.salidaEvent) {
        evidencesBySlot.JORNADA_SALIDA = mapLegacySlotEventToEvidenceItem(
          'JORNADA_SALIDA',
          legacy.salidaEvent
        );
      }
    } else {
      if (legacy.ingresoEvent) {
        evidencesBySlot.MANANA_INGRESO = mapLegacySlotEventToEvidenceItem(
          'MANANA_INGRESO',
          legacy.ingresoEvent
        );
      }
      if (legacy.salidaAlmorzarEvent) {
        evidencesBySlot.MANANA_SALIDA = mapLegacySlotEventToEvidenceItem(
          'MANANA_SALIDA',
          legacy.salidaAlmorzarEvent
        );
      }
      if (legacy.llegadaAlmorzarEvent) {
        evidencesBySlot.TARDE_INGRESO = mapLegacySlotEventToEvidenceItem(
          'TARDE_INGRESO',
          legacy.llegadaAlmorzarEvent
        );
      }
      if (legacy.salidaEvent) {
        evidencesBySlot.TARDE_SALIDA = mapLegacySlotEventToEvidenceItem(
          'TARDE_SALIDA',
          legacy.salidaEvent
        );
      }
    }

    const compliance = evaluateAttendanceCompliance(
      resolved.perfilAplicado,
      Object.keys(evidencesBySlot) as SlotFotoAsistencia[]
    );

    byDateAndPromotoraKey.set(key, {
      key,
      asistenciaId: null,
      fechaJornada: legacy.date,
      fechaSlash: legacy.dateSlash || formatYmdToSlash(legacy.date),
      fechaLongEs: legacy.dateLongEs || formatYmdToLongEs(legacy.date),
      promotoraId: matchedStaff.id,
      promotoraNombre: matchedStaff.name,
      promotoraInitials: getInitials(matchedStaff.name),
      promotoraEmail: matchedStaff.email || legacy.email,
      pdvNombre: legacy.storeName || matchedStaff.assignedStore || 'PDV',
      zona: legacy.zone || matchedStaff.address || 'PDV Verificado',
      region: matchedStaff.region === 'Valencia' ? 'Valencia' : 'Occidente',
      perfilAplicado: resolved.perfilAplicado,
      perfilFuente: resolved.fuente,
      compliance,
      evidencesBySlot,
      mapsUrl: legacy.mapsUrl,
    });
  }

  // 3. Tercero: si hay una fecha seleccionada, completar la plantilla activa sin registro ese día (`0/2` o `0/4`)
  if (cleanSelectedDate) {
    for (const staff of eligibleStaff) {
      const key = `${cleanSelectedDate}__${staff.id}`;
      if (byDateAndPromotoraKey.has(key)) continue;

      const resolved = resolveEffectiveAttendanceProfile({
        historicalSnapshotProfile: null,
        currentMasterCategory: staff.category,
      });

      const compliance = evaluateAttendanceCompliance(resolved.perfilAplicado, []);

      byDateAndPromotoraKey.set(key, {
        key,
        asistenciaId: null,
        fechaJornada: cleanSelectedDate,
        fechaSlash: formatYmdToSlash(cleanSelectedDate),
        fechaLongEs: formatYmdToLongEs(cleanSelectedDate),
        promotoraId: staff.id,
        promotoraNombre: staff.name,
        promotoraInitials: getInitials(staff.name),
        promotoraEmail: staff.email,
        pdvNombre: staff.assignedStore || 'PDV por definir',
        zona: staff.address || 'Zona operativa',
        region: staff.region === 'Valencia' ? 'Valencia' : 'Occidente',
        perfilAplicado: resolved.perfilAplicado,
        perfilFuente: resolved.fuente,
        compliance,
        evidencesBySlot: {},
      });
    }
  }

  // Ordenar: Fecha descendente -> Jornadas con actividad primero -> FIJA antes que EVENTUAL -> Nombre A-Z
  return Array.from(byDateAndPromotoraKey.values()).sort((a, b) => {
    if (a.fechaJornada !== b.fechaJornada) {
      return b.fechaJornada.localeCompare(a.fechaJornada);
    }
    const aActive = a.compliance.uploadedCount > 0 ? 1 : 0;
    const bActive = b.compliance.uploadedCount > 0 ? 1 : 0;
    if (aActive !== bActive) {
      return bActive - aActive;
    }
    if (a.perfilAplicado !== b.perfilAplicado) {
      return a.perfilAplicado === 'FIJA' ? -1 : 1;
    }
    return a.promotoraNombre.localeCompare(b.promotoraNombre, 'es');
  });
}
