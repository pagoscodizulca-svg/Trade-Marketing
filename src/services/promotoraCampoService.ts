import {
  ASISTENCIA_PRIVATE_BUCKET_ID,
  type AllowedAttendanceImageMime,
  ALLOWED_ATTENDANCE_IMAGE_MIMES,
  type AsistenciaEvidenciaDbRow,
  type AsistenciaJornadaDbRow,
  MAX_ATTENDANCE_EVIDENCE_BYTES,
  type PerfilAsistencia,
  type SlotFotoAsistencia,
  getCaracasTodayYmd,
  isSlotAllowedForProfile,
} from '../types/attendanceEvidences';
import type { ClienteConVendedor, ProductoMaestro } from '../types/masterData';
import type { RutaPromotoraRecord } from '../types/degustacionesPipeline';
import type { VerifiedAuthProfile } from './authService';
import {
  obtenerProductosMaestros,
  obtenerPromotorasMaestras,
} from './masterCatalogSyncService';
import { obtenerClientesMaestros } from './masterDataSyncService';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import {
  normalizePriceSurveyBimonetary,
  type PriceCurrency,
} from '../utils/bimonetaryPriceMath';

export const PORTAL_ACTIVE_STORE_STORAGE_KEY = 'codizulca_portal_active_store_v2';

const CLIENT_SUBMISSION_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Genera un UUID v4 por borrador de captura para garantizar idempotencia estricta
 * (`client_submission_id`) ante doble clic o reintentos por microcortes de red.
 */
export function generateClientSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function normalizeOptionalClientSubmissionId(raw?: string | null): string | null {
  const clean = String(raw || '').trim();
  return CLIENT_SUBMISSION_UUID_REGEX.test(clean) ? clean : null;
}

/**
 * Devuelve el timestamp ISO exacto en huso horario de Venezuela (`America/Caracas`, `UTC-4`),
 * p. ej. `2026-11-23T20:41:47.758-04:00`.
 * Evita que los reportes enviados entre 8:00 p. m. y 11:59 p. m. hora Venezuela
 * cambien al día siguiente (`D+1`) al normalizar fechas en el Módulo de Informes.
 */
export function getCaracasIsoTimestamp(date: Date = new Date()): string {
  const utcMs = date.getTime();
  if (!Number.isFinite(utcMs)) return new Date().toISOString();
  // Venezuela es permanentemente UTC-4 (sin horario de verano desde 2016)
  const caracasMs = utcMs - 4 * 60 * 60 * 1000;
  const shifted = new Date(caracasMs);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}.${pad3(shifted.getUTCMilliseconds())}-04:00`;
}

function isMissingColumnError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return (
    err.code === 'PGRST204' ||
    err.code === '42703' ||
    /column .* does not exist|could not find the .* column/i.test(String(err.message || ''))
  );
}

function isUniqueViolationError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === '23505' || /duplicate key value violates unique constraint/i.test(String(err.message || ''));
}

export interface PortalPromotoraContext {
  promotoraId: string;
  promotoraRefId: number | null;
  authUserId: string;
  nombre: string;
  correo: string;
  telefono: string;
  direccion: string;
  categoria: 'Fijas' | 'Eventuales' | 'Merchandising';
  perfilAsistencia: PerfilAsistencia;
  region: 'Occidente' | 'Valencia';
  sucursal: 'ZULIA' | 'VALENCIA';
  isManagerOrAdmin: boolean;
  isMerchandisingRole: boolean;
}

export interface PortalClientOption {
  id: string;
  codigo: string;
  nombre: string;
  zona: string;
  cadena?: string;
  region: 'Occidente' | 'Valencia';
}

export interface PortalProductOption {
  id: string;
  codigo: string;
  nombre: string;
  categoria: string;
  presentacion: string;
}

export interface PortalInventoryRecord {
  id: string;
  date: string;
  store: string;
  product: string;
  initialQuantity: number;
  finalQuantity: number;
  degustations: number;
  sales_generated: number;
  comments: string;
  promoter: string;
  promotora_id?: string | null;
  region?: string | null;
  zona?: string | null;
  created_at?: string;
}

export interface PortalTodayAttendanceState {
  jornada: AsistenciaJornadaDbRow | null;
  evidencias: AsistenciaEvidenciaDbRow[];
  signedUrlsByEvidenceId: Record<string, string>;
}

export interface PortalScheduleClockInfo {
  formattedTime: string;
  formattedDate: string;
  hourFloat: number;
  status: 'puntual' | 'tolerancia' | 'retardo';
  shortLabel: string;
}

export const PORTAL_COMPETITOR_BRANDS = [
  'Plumrose',
  'Hermo',
  'Oscar Mayer',
  'Alibal',
  'Montserratina',
  'San Antonio',
  'Embutidos Arichuna',
  'El Corral',
  'Alimex',
  'Turza',
  'Leyenda',
  'Torondoy',
  'Primor',
  'Mary',
  'Montalbán',
  'Pantera',
  'Iberia',
  'Campestre',
  'Mazeite',
  'Vatel',
  'La Campiña',
] as const;

export const PORTAL_MERCHANDISING_ACTIVITIES = [
  'Exhibición y Ajuste de Planograma',
  'Limpieza y Organización de Anaquel',
  'Reposición de Frentes y Rotación (FIFO)',
  'Chequeo de Precios y Señalización',
  'Colocación de Material POP',
  'Verificación de Agotados / Quiebres de Stock',
] as const;

export const PORTAL_STORE_MANAGER_ROLES = [
  'Encargado de Tienda',
  'Pasillero Jefe',
  'Gerente de Sucursal',
  'Propietario / Dueño',
  'Jefe de Piso de Venta',
  'Supervisor de Compras',
] as const;

const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const PORTAL_STORAGE_PATH_REGEX =
  /^[A-Za-z0-9_-]{1,64}\/(asistencia|inventario|degustacion|precios|merchandising)\/[A-Za-z0-9_.-]{8,96}\.(jpg|jpeg|png|webp)$/;

export function getCaracasClockAndPunctuality(dateInput?: Date | string): PortalScheduleClockInfo {
  const dt = dateInput ? (dateInput instanceof Date ? dateInput : new Date(dateInput)) : new Date();
  const safeDt = Number.isNaN(dt.getTime()) ? new Date() : dt;

  const formattedTime = safeDt.toLocaleTimeString('es-VE', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const formattedDate = safeDt.toLocaleDateString('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const caracasMs = safeDt.getTime() - 4 * 60 * 60 * 1000;
  const cd = new Date(caracasMs);
  const hourFloat = cd.getUTCHours() + cd.getUTCMinutes() / 60;

  let status: 'puntual' | 'tolerancia' | 'retardo' = 'puntual';
  let shortLabel = 'Puntual';
  if (hourFloat > 9.25) {
    status = 'retardo';
    shortLabel = 'Fuera de tolerancia';
  } else if (hourFloat > 9.0) {
    status = 'tolerancia';
    shortLabel = 'En tolerancia';
  }

  return { formattedTime, formattedDate, hourFloat, status, shortLabel };
}

export function getSavedPortalActiveStore(): string {
  if (typeof window === 'undefined') return '';
  try {
    return (window.localStorage.getItem(PORTAL_ACTIVE_STORE_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function savePortalActiveStore(storeName: string): void {
  if (typeof window === 'undefined') return;
  const clean = String(storeName || '').trim();
  if (!clean) return;
  try {
    window.localStorage.setItem(PORTAL_ACTIVE_STORE_STORAGE_KEY, clean);
  } catch {
    // Ignorar error de cuota localStorage
  }
}

function inferRegionFromText(rawRegion?: string | null, rawSucursal?: string | null, direccion?: string | null): 'Occidente' | 'Valencia' {
  const reg = String(rawRegion || '').trim().toLowerCase();
  if (reg === 'valencia' || reg === 'centro') return 'Valencia';
  if (reg === 'occidente' || reg === 'zulia') return 'Occidente';
  const suc = String(rawSucursal || '').trim().toUpperCase();
  if (suc === 'VALENCIA' || suc === 'CENTRO') return 'Valencia';
  if (/valencia|carabobo|maracay|naguanagua|san diego|guacara/i.test(String(direccion || ''))) {
    return 'Valencia';
  }
  return 'Occidente';
}

function normalizeCategoria(raw?: string | null): 'Fijas' | 'Eventuales' | 'Merchandising' {
  const clean = String(raw || '').trim().toLowerCase();
  if (clean.includes('merch')) return 'Merchandising';
  if (clean.includes('event')) return 'Eventuales';
  return 'Fijas';
}

export function buildFallbackPromotoraContext(profile: VerifiedAuthProfile): PortalPromotoraContext {
  const region = inferRegionFromText(null, profile.sucursal, null);
  const isManagerOrAdmin = Boolean(profile.isCoordinatorOrAdmin);
  return {
    promotoraId: String(profile.staffId || profile.userId),
    promotoraRefId: null,
    authUserId: profile.userId,
    nombre: profile.displayName || profile.email,
    correo: profile.email,
    telefono: '',
    direccion: region,
    categoria: 'Fijas',
    perfilAsistencia: 'FIJA',
    region,
    sucursal: region === 'Valencia' ? 'VALENCIA' : 'ZULIA',
    isManagerOrAdmin,
    isMerchandisingRole: isManagerOrAdmin,
  };
}

/**
 * Resuelve la identidad real de la promotora autenticada contra `public.promotoras`
 * en nuestro Supabase Principal, sin usar listas hardcodeadas ni contraseñas en cliente.
 */
export async function resolvePortalPromotoraContext(
  profile: VerifiedAuthProfile
): Promise<PortalPromotoraContext> {
  const fallback = buildFallbackPromotoraContext(profile);
  if (!isSupabaseConfigured) return fallback;

  try {
    const promotoras = await obtenerPromotorasMaestras({ soloActivas: true }).catch(() => []);
    const emailLower = String(profile.email || '').trim().toLowerCase();
    const matched = promotoras.find((p) => {
      if (p.auth_user_id && p.auth_user_id === profile.userId) return true;
      if (emailLower && String(p.email || '').trim().toLowerCase() === emailLower) return true;
      if (profile.staffId && String(p.id) === String(profile.staffId)) return true;
      return false;
    });

    if (!matched) {
      return fallback;
    }

    const numericId = Number(matched.id);
    const categoria = normalizeCategoria(matched.categoria);
    const region = inferRegionFromText(
      matched.region || String(matched.metadata?.region_perfil || ''),
      matched.sucursal || profile.sucursal,
      matched.direccion
    );

    return {
      promotoraId: String(matched.id),
      promotoraRefId: Number.isInteger(numericId) ? numericId : null,
      authUserId: profile.userId,
      nombre: matched.nombre_completo || fallback.nombre,
      correo: matched.email || profile.email,
      telefono: matched.telefono || '',
      direccion: matched.direccion || region,
      categoria,
      perfilAsistencia: categoria === 'Eventuales' ? 'EVENTUAL' : 'FIJA',
      region,
      sucursal: region === 'Valencia' ? 'VALENCIA' : 'ZULIA',
      isManagerOrAdmin: Boolean(profile.isCoordinatorOrAdmin),
      isMerchandisingRole: categoria === 'Merchandising' || Boolean(profile.isCoordinatorOrAdmin),
    };
  } catch {
    return fallback;
  }
}

export async function fetchPortalClientsCatalog(
  regionFilter?: 'Occidente' | 'Valencia' | 'TODAS'
): Promise<PortalClientOption[]> {
  try {
    const raw: ClienteConVendedor[] = await obtenerClientesMaestros({ soloActivos: true });
    const mapped: PortalClientOption[] = raw
      .filter((c) => Boolean(c.nombre_comercial || c.razon_social))
      .map((c) => {
        const reg = inferRegionFromText(
          String((c.metadata as Record<string, unknown> | undefined)?.region || ''),
          c.sucursal,
          c.ciudad || c.direccion || c.estado || ''
        );
        return {
          id: String(c.id),
          codigo: String(c.codigo_cliente || '').trim(),
          nombre: String(c.nombre_comercial || c.razon_social || '').trim(),
          zona: String(c.zona_catalogo?.nombre || c.zona || c.ciudad || reg).trim(),
          cadena: String(c.cadena?.nombre || c.canal || '').trim() || undefined,
          region: reg,
        };
      });

    if (regionFilter && regionFilter !== 'TODAS') {
      const byRegion = mapped.filter((c) => c.region === regionFilter);
      if (byRegion.length > 0) return byRegion;
    }
    return mapped;
  } catch {
    return [];
  }
}

export async function fetchPortalProductsCatalog(): Promise<PortalProductOption[]> {
  try {
    const raw: ProductoMaestro[] = await obtenerProductosMaestros({ soloActivos: true });
    return raw
      .filter((p) => Boolean(p.nombre))
      .map((p) => ({
        id: String(p.id),
        codigo: String(p.codigo || '').trim(),
        nombre: String(p.nombre || '').trim(),
        categoria: String(p.categoria || 'General').trim(),
        presentacion: String(p.unidad_medida || p.marca || '').trim(),
      }));
  } catch {
    return [];
  }
}

export function validatePortalImageFile(file: File | Blob): {
  mimeType: AllowedAttendanceImageMime;
  ext: 'jpg' | 'png' | 'webp';
} {
  if (!file || file.size <= 0) {
    throw new Error('La imagen seleccionada está vacía.');
  }
  if (file.size > MAX_ATTENDANCE_EVIDENCE_BYTES) {
    throw new Error('La fotografía supera el límite máximo permitido de 5 MB.');
  }
  const mime = String(file.type || '').trim().toLowerCase() as AllowedAttendanceImageMime;
  if (!ALLOWED_ATTENDANCE_IMAGE_MIMES.includes(mime)) {
    throw new Error('Formato de imagen no permitido. Usa únicamente JPEG, PNG o WebP.');
  }
  const ext: 'jpg' | 'png' | 'webp' =
    mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { mimeType: mime, ext };
}

export function buildSanitizedPortalStoragePath(params: {
  promotoraId: string;
  modulo: 'asistencia' | 'inventario' | 'degustacion' | 'precios' | 'merchandising';
  ext: 'jpg' | 'png' | 'webp';
  prefix?: string;
}): string {
  const rawPromId = String(params.promotoraId || '').trim();
  if (
    !rawPromId ||
    rawPromId.includes('..') ||
    rawPromId.includes('/') ||
    rawPromId.includes('\\') ||
    rawPromId.includes('\0') ||
    !SAFE_SEGMENT_REGEX.test(rawPromId)
  ) {
    throw new Error('Identificador de promotora inválido o bloqueado por anti-path-traversal.');
  }
  const safePromId = rawPromId;
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().toLowerCase()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const safePrefix = params.prefix
    ? `${params.prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}_`
    : '';
  const path = `${safePromId}/${params.modulo}/${safePrefix}${uuid}.${params.ext}`;
  if (path.includes('..') || path.startsWith('/') || !PORTAL_STORAGE_PATH_REGEX.test(path)) {
    throw new Error('Ruta de archivo bloqueada por validación anti-path-traversal.');
  }
  return path;
}

async function computeSha256Hex(blob: Blob): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return '';
  }
  try {
    const ab = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', ab);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

export async function stampAndCompressImageBlob(params: {
  file: File | Blob;
  watermarkText: string;
  maxDimension?: number;
}): Promise<{
  blob: Blob;
  mimeType: AllowedAttendanceImageMime;
  ext: 'jpg' | 'png' | 'webp';
  width: number | null;
  height: number | null;
  sha256Hex: string;
}> {
  const validated = validatePortalImageFile(params.file);
  const maxDim = params.maxDimension ?? 1024;

  // En entornos headless o archivos pequeños PNG sintéticos de QA, si Canvas no está disponible devolvemos el original validado
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    const sha256Hex = await computeSha256Hex(params.file);
    return {
      blob: params.file,
      mimeType: validated.mimeType,
      ext: validated.ext,
      width: null,
      height: null,
      sha256Hex,
    };
  }

  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      reader.readAsDataURL(params.file);
    });

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('No se pudo decodificar la imagen.'));
      el.src = dataUrl;
    });

    let width = img.naturalWidth || img.width || 640;
    let height = img.naturalHeight || img.height || 480;
    // Evitar distorsionar imágenes diminutas de prueba QA (< 16px)
    if (width >= 32 && height >= 32) {
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.max(1, Math.round((height * maxDim) / width));
          width = maxDim;
        } else {
          width = Math.max(1, Math.round((width * maxDim) / height));
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        if (params.watermarkText && height >= 120) {
          const barH = Math.min(44, Math.max(26, Math.round(height * 0.08)));
          ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
          ctx.fillRect(0, height - barH, width, barH);
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.max(10, Math.round(barH * 0.36))}px monospace`;
          ctx.fillText(params.watermarkText.slice(0, 95), 10, height - Math.round(barH * 0.32));
        }

        const outMime: AllowedAttendanceImageMime =
          validated.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
        const outExt: 'jpg' | 'png' = outMime === 'image/png' ? 'png' : 'jpg';
        const outBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), outMime, 0.82)
        );
        if (outBlob && outBlob.size > 0 && outBlob.size <= MAX_ATTENDANCE_EVIDENCE_BYTES) {
          const sha256Hex = await computeSha256Hex(outBlob);
          return {
            blob: outBlob,
            mimeType: outMime,
            ext: outExt,
            width,
            height,
            sha256Hex,
          };
        }
      }
    }
  } catch {
    // Fallback seguro al blob original ya validado
  }

  const sha256Hex = await computeSha256Hex(params.file);
  return {
    blob: params.file,
    mimeType: validated.mimeType,
    ext: validated.ext,
    width: null,
    height: null,
    sha256Hex,
  };
}

/**
 * Actualiza progreso de muestras entregadas, estado (`EN_CURSO` / `COMPLETADA`) o notas
 * directamente en `public.rutas_promotoras` validando filas afectadas con `.select('*')`.
 */
export async function updatePortalRutaProgress(params: {
  rutaId: string;
  estadoRuta?: 'ASIGNADA' | 'EN_CURSO' | 'COMPLETADA';
  muestrasEntregadas?: number;
  unidadesVendidas?: number;
  notasCampo?: string;
}): Promise<RutaPromotoraRecord> {
  const client = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { updated_at: nowIso };
  if (params.estadoRuta) {
    patch.estado_ruta = params.estadoRuta;
    if (params.estadoRuta === 'EN_CURSO') patch.checkin_at = nowIso;
    if (params.estadoRuta === 'COMPLETADA') patch.checkout_at = nowIso;
  }
  if (typeof params.muestrasEntregadas === 'number') {
    patch.muestras_entregadas = Math.max(0, Math.round(params.muestrasEntregadas));
  }
  if (typeof params.unidadesVendidas === 'number') {
    patch.unidades_vendidas = Math.max(0, Number(params.unidadesVendidas.toFixed(2)));
  }
  if (typeof params.notasCampo === 'string') {
    patch.notas_campo = params.notasCampo.trim().slice(0, 500);
  }

  let res = await client
    .from('rutas_promotoras')
    .update(patch)
    .eq('id', params.rutaId)
    .select('*');

  // Si alguna columna aditiva (`muestras_entregadas`, `notas_campo`) aún no se migró en BD, reintentar solo estado/timestamps
  if (res.error && (res.error.code === 'PGRST204' || res.error.code === '42703')) {
    const safePatch: Record<string, unknown> = { updated_at: nowIso };
    if (params.estadoRuta) {
      safePatch.estado_ruta = params.estadoRuta;
      if (params.estadoRuta === 'EN_CURSO') safePatch.checkin_at = nowIso;
      if (params.estadoRuta === 'COMPLETADA') safePatch.checkout_at = nowIso;
    }
    res = await client
      .from('rutas_promotoras')
      .update(safePatch)
      .eq('id', params.rutaId)
      .select('*');
  }

  if (res.error) {
    throw new Error(
      res.error.code === '42501'
        ? 'Permiso denegado por RLS al actualizar tu ruta. Verifica tu sesión.'
        : `No se pudo actualizar la degustación (${res.error.message}).`
    );
  }

  const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  if (rows.length === 0) {
    throw new Error(
      'Supabase devolvió 0 filas afectadas al actualizar la ruta (posible restricción RLS).'
    );
  }

  return rows[0] as RutaPromotoraRecord;
}

/**
 * Consulta la jornada de asistencia de hoy (hora oficial Caracas) para la promotora activa
 * en `public.asistencias_jornada` + `public.asistencia_evidencias` con URLs firmadas.
 */
export async function fetchPortalTodayAttendance(params: {
  promotoraId: string;
  fechaJornada?: string;
}): Promise<PortalTodayAttendanceState> {
  if (!isSupabaseConfigured) {
    return { jornada: null, evidencias: [], signedUrlsByEvidenceId: {} };
  }
  const fecha = params.fechaJornada || getCaracasTodayYmd();
  const client = getSupabaseClient();

  const { data: jornadaData, error: jornadaErr } = await client
    .from('asistencias_jornada')
    .select('*')
    .eq('fecha_jornada', fecha)
    .eq('promotora_id', params.promotoraId)
    .maybeSingle();

  if (jornadaErr || !jornadaData) {
    return { jornada: null, evidencias: [], signedUrlsByEvidenceId: {} };
  }

  const jornada = jornadaData as AsistenciaJornadaDbRow;
  const { data: evData, error: evErr } = await client
    .from('asistencia_evidencias')
    .select('*')
    .eq('asistencia_id', jornada.id)
    .order('capturado_en_servidor', { ascending: true });

  if (evErr || !Array.isArray(evData)) {
    return { jornada, evidencias: [], signedUrlsByEvidenceId: {} };
  }

  const evidencias = evData as AsistenciaEvidenciaDbRow[];
  const signedUrlsByEvidenceId: Record<string, string> = {};

  const paths = evidencias
    .map((e) => String(e.storage_path || '').trim())
    .filter((p) => p.length > 0 && !p.includes('..'));

  if (paths.length > 0) {
    const { data: signedList } = await client.storage
      .from(ASISTENCIA_PRIVATE_BUCKET_ID)
      .createSignedUrls(paths, 900);
    if (Array.isArray(signedList)) {
      evidencias.forEach((ev, idx) => {
        const url = signedList[idx]?.signedUrl;
        if (url) signedUrlsByEvidenceId[ev.id] = url;
      });
    }
  }

  return { jornada, evidencias, signedUrlsByEvidenceId };
}

/**
 * Registra una evidencia de asistencia en el Supabase Principal:
 * 1) Valida MIME/tamaño (`<= 5 MB`), estampa marca de agua VE y sube al bucket privado `asistencia-evidencias`.
 * 2) Crea/obtiene la cabecera `public.asistencias_jornada` con perfil inmutable (`FIJA` / `EVENTUAL`) y `region`.
 * 3) Inserta/actualiza `public.asistencia_evidencias` validando con `.select('*')`.
 * 4) Si falla cualquier paso en BD, ejecuta rollback inmediato del archivo en Storage.
 */
export async function submitPortalAttendanceEvidence(params: {
  context: PortalPromotoraContext;
  slotFoto: SlotFotoAsistencia;
  pdvNombre: string;
  zona?: string;
  lat: number;
  lng: number;
  gpsAccuracy?: number | null;
  imageFile: File | Blob;
  fechaJornada?: string;
  customFilePrefix?: string;
}): Promise<{
  jornada: AsistenciaJornadaDbRow;
  evidencia: AsistenciaEvidenciaDbRow;
  signedUrl: string | null;
}> {
  const { context, slotFoto } = params;
  const cleanPdv = String(params.pdvNombre || '').trim();
  if (!cleanPdv) {
    throw new Error('Selecciona el Punto de Venta (PDV) antes de certificar asistencia.');
  }
  if (!isSlotAllowedForProfile(context.perfilAsistencia, slotFoto)) {
    throw new Error(
      `El hito ${slotFoto} no corresponde al perfil ${context.perfilAsistencia} asignado.`
    );
  }

  const fechaJornada = params.fechaJornada || getCaracasTodayYmd();
  const clock = getCaracasClockAndPunctuality();
  const watermark = `CODIZULCA ASISTENCIA • ${slotFoto} • ${cleanPdv.slice(0, 26)} • ${clock.formattedDate} ${clock.formattedTime} • GPS ${params.lat.toFixed(4)},${params.lng.toFixed(4)}`;

  const processed = await stampAndCompressImageBlob({
    file: params.imageFile,
    watermarkText: watermark,
    maxDimension: 960,
  });

  const storagePath = buildSanitizedPortalStoragePath({
    promotoraId: context.promotoraId,
    modulo: 'asistencia',
    ext: processed.ext,
    prefix: params.customFilePrefix || slotFoto.toLowerCase(),
  });

  const client = getSupabaseClient();
  const uploadRes = await client.storage
    .from(ASISTENCIA_PRIVATE_BUCKET_ID)
    .upload(storagePath, processed.blob, {
      contentType: processed.mimeType,
      upsert: false,
      cacheControl: '900',
    });

  if (uploadRes.error) {
    throw new Error(
      `No se pudo subir la evidencia fotográfica al Storage seguro (${uploadRes.error.message}).`
    );
  }

  const rollbackUploadedPhoto = async () => {
    await client.storage
      .from(ASISTENCIA_PRIVATE_BUCKET_ID)
      .remove([storagePath])
      .catch(() => undefined);
  };

  try {
    const nowIso = new Date().toISOString();
    const zonaFinal = String(params.zona || context.direccion || context.region).trim();

    // 1. Buscar o abrir la jornada del día
    let jornada: AsistenciaJornadaDbRow | null = null;
    const findRes = await client
      .from('asistencias_jornada')
      .select('*')
      .eq('fecha_jornada', fechaJornada)
      .eq('promotora_id', context.promotoraId)
      .maybeSingle();

    if (findRes.error) {
      throw new Error(`No se pudo consultar la jornada de asistencia (${findRes.error.message}).`);
    }

    if (findRes.data) {
      jornada = findRes.data as AsistenciaJornadaDbRow;
      await client
        .from('asistencias_jornada')
        .update({
          pdv_nombre: cleanPdv,
          zona: zonaFinal,
          updated_at_server: nowIso,
        })
        .eq('id', jornada.id)
        .select('id');
    } else {
      const insertJornada = await client
        .from('asistencias_jornada')
        .insert({
          fecha_jornada: fechaJornada,
          promotora_id: context.promotoraId,
          promotora_ref_id: context.promotoraRefId,
          auth_user_id: context.authUserId,
          promotora_nombre: context.nombre,
          perfil_aplicado: context.perfilAsistencia,
          pdv_nombre: cleanPdv,
          zona: zonaFinal,
          region: context.region,
          sucursal: context.sucursal,
          opened_at_server: nowIso,
          updated_at_server: nowIso,
          opened_by_uid: context.authUserId,
        })
        .select('*');

      if (insertJornada.error) {
        throw new Error(
          insertJornada.error.code === '42501'
            ? 'Permiso denegado por RLS al abrir la jornada de asistencia. Verifica que el SQL esté aplicado.'
            : `No se pudo abrir la jornada de asistencia (${insertJornada.error.message}).`
        );
      }

      const jRows = Array.isArray(insertJornada.data)
        ? insertJornada.data
        : insertJornada.data
          ? [insertJornada.data]
          : [];
      if (jRows.length === 0) {
        throw new Error('Supabase devolvió 0 filas al abrir la jornada de asistencia.');
      }
      jornada = jRows[0] as AsistenciaJornadaDbRow;
    }

    // 2. Insertar o reemplazar la evidencia en el slot solicitado
    const existingSlot = await client
      .from('asistencia_evidencias')
      .select('id, storage_path, version')
      .eq('asistencia_id', jornada.id)
      .eq('slot_foto', slotFoto)
      .maybeSingle();

    const actorRol: 'promotora' | 'coordinadora' | 'admin' = context.isManagerOrAdmin
      ? 'admin'
      : 'promotora';

    let evidenciaRow: AsistenciaEvidenciaDbRow | null = null;
    let previousStoragePath: string | null = null;

    if (existingSlot.data) {
      const prev = existingSlot.data as { id: string; storage_path?: string; version?: number };
      previousStoragePath = prev.storage_path || null;
      const updEv = await client
        .from('asistencia_evidencias')
        .update({
          storage_bucket: ASISTENCIA_PRIVATE_BUCKET_ID,
          storage_path: storagePath,
          mime_type: processed.mimeType,
          tamano_bytes: processed.blob.size,
          sha256_hex: processed.sha256Hex,
          ancho_px: processed.width,
          alto_px: processed.height,
          pdv_nombre: cleanPdv,
          lat: params.lat,
          lng: params.lng,
          gps_accuracy: params.gpsAccuracy ?? null,
          region: context.region,
          sucursal: context.sucursal,
          capturado_en_servidor: nowIso,
          cargado_por_uid: context.authUserId,
          cargado_por_rol: actorRol,
          version: (prev.version || 1) + 1,
          updated_at: nowIso,
        })
        .eq('id', prev.id)
        .select('*');

      if (updEv.error) {
        throw new Error(`No se pudo reemplazar la evidencia (${updEv.error.message}).`);
      }
      const rows = Array.isArray(updEv.data) ? updEv.data : updEv.data ? [updEv.data] : [];
      if (rows.length === 0) {
        throw new Error('Supabase devolvió 0 filas al actualizar la evidencia de asistencia.');
      }
      evidenciaRow = rows[0] as AsistenciaEvidenciaDbRow;
    } else {
      const insEv = await client
        .from('asistencia_evidencias')
        .insert({
          asistencia_id: jornada.id,
          slot_foto: slotFoto,
          storage_bucket: ASISTENCIA_PRIVATE_BUCKET_ID,
          storage_path: storagePath,
          mime_type: processed.mimeType,
          tamano_bytes: processed.blob.size,
          sha256_hex: processed.sha256Hex,
          ancho_px: processed.width,
          alto_px: processed.height,
          pdv_nombre: cleanPdv,
          lat: params.lat,
          lng: params.lng,
          gps_accuracy: params.gpsAccuracy ?? null,
          region: context.region,
          sucursal: context.sucursal,
          capturado_en_servidor: nowIso,
          cargado_por_uid: context.authUserId,
          cargado_por_rol: actorRol,
          version: 1,
          updated_at: nowIso,
        })
        .select('*');

      if (insEv.error) {
        throw new Error(`No se pudo registrar la evidencia (${insEv.error.message}).`);
      }
      const rows = Array.isArray(insEv.data) ? insEv.data : insEv.data ? [insEv.data] : [];
      if (rows.length === 0) {
        throw new Error('Supabase devolvió 0 filas al insertar la evidencia de asistencia.');
      }
      evidenciaRow = rows[0] as AsistenciaEvidenciaDbRow;
    }

    // Limpiar foto anterior si fue reemplazo exitoso
    if (previousStoragePath && previousStoragePath !== storagePath) {
      await client.storage
        .from(ASISTENCIA_PRIVATE_BUCKET_ID)
        .remove([previousStoragePath])
        .catch(() => undefined);
    }

    const { data: signedData } = await client.storage
      .from(ASISTENCIA_PRIVATE_BUCKET_ID)
      .createSignedUrl(storagePath, 900);

    return {
      jornada,
      evidencia: evidenciaRow,
      signedUrl: signedData?.signedUrl || null,
    };
  } catch (err) {
    await rollbackUploadedPhoto();
    throw err;
  }
}

/**
 * Consulta los registros de inventario propios (o consolidados para coordinación/admin)
 * desde `public.inventory`.
 */
export async function fetchPortalInventoryLogs(
  context: PortalPromotoraContext
): Promise<PortalInventoryRecord[]> {
  if (!isSupabaseConfigured) return [];
  const client = getSupabaseClient();
  let query = client
    .from('inventory')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (!context.isManagerOrAdmin) {
    query = query.or(
      `auth_user_id.eq.${context.authUserId},promotora_id.eq.${context.promotoraId}`
    );
  }

  const { data, error } = await query;
  if (error || !Array.isArray(data)) return [];
  return data.map((row: Record<string, unknown>) => ({
    id: String(row.id || ''),
    date: String(row.date || row.created_at || ''),
    store: String(row.store || ''),
    product: String(row.product || ''),
    initialQuantity: Number(row.initialQuantity ?? 0),
    finalQuantity: Number(row.finalQuantity ?? 0),
    degustations: Number(row.degustations ?? 0),
    sales_generated: Number(row.sales_generated ?? 0),
    comments: String(row.comments || ''),
    promoter: String(row.promoter || ''),
    promotora_id: row.promotora_id ? String(row.promotora_id) : null,
    region: row.region ? String(row.region) : null,
    zona: row.zona ? String(row.zona) : null,
    created_at: row.created_at ? String(row.created_at) : undefined,
  }));
}

/**
 * Crea un balance de inventario y degustación en `public.inventory` vinculado
 * directamente al Módulo 1 -> Informes -> Inventario y Degustación.
 */
export async function createPortalInventoryLog(params: {
  context: PortalPromotoraContext;
  store: string;
  zona?: string;
  product: string;
  initialQuantity: number;
  salesGenerated: number;
  degustations: number;
  comments?: string;
  cronogramaId?: string | null;
  clientSubmissionId?: string | null;
}): Promise<PortalInventoryRecord> {
  const cleanStore = String(params.store || '').trim();
  const cleanProduct = String(params.product || '').trim();
  const init = Number(params.initialQuantity);
  const sales = Number(params.salesGenerated);
  const samples = Number(params.degustations);

  if (!cleanStore) throw new Error('Selecciona el Punto de Venta (PDV).');
  if (!cleanProduct) throw new Error('Selecciona el Producto SKU.');
  if (!Number.isFinite(init) || init <= 0) {
    throw new Error('El Inventario Inicial debe ser mayor a cero.');
  }
  if (!Number.isFinite(sales) || sales < 0 || !Number.isFinite(samples) || samples < 0) {
    throw new Error('Las ventas y degustaciones no pueden ser negativas.');
  }
  const finalQuantity = Number((init - sales - samples).toFixed(2));
  if (finalQuantity < 0) {
    throw new Error(
      'Las Ventas + Degustaciones superan el Inventario Inicial. Verifica las cantidades.'
    );
  }

  const client = getSupabaseClient();
  const nowCaracasIso = getCaracasIsoTimestamp();
  const submissionId = normalizeOptionalClientSubmissionId(params.clientSubmissionId);

  const baseRow = {
    date: nowCaracasIso,
    store: cleanStore,
    product: cleanProduct,
    initialQuantity: Number(init.toFixed(2)),
    finalQuantity,
    degustations: Number(samples.toFixed(2)),
    sales_generated: Number(sales.toFixed(2)),
    comments: String(params.comments || '').trim().slice(0, 600),
    creatorId: params.context.correo || params.context.nombre,
    promoter: params.context.nombre,
    promotora_id: params.context.promotoraId,
    auth_user_id: params.context.authUserId,
    region: params.context.region,
    zona: String(params.zona || params.context.direccion || params.context.region).trim(),
    cronograma_id: params.cronogramaId || null,
  };

  const payload = submissionId ? { ...baseRow, client_submission_id: submissionId } : baseRow;
  let { data, error } = await client.from('inventory').insert(payload).select('*');

  if (error && submissionId && isMissingColumnError(error)) {
    const retry = await client.from('inventory').insert(baseRow).select('*');
    data = retry.data;
    error = retry.error;
  } else if (error && submissionId && isUniqueViolationError(error)) {
    const existing = await client
      .from('inventory')
      .select('*')
      .eq('client_submission_id', submissionId)
      .limit(1);
    if (!existing.error && Array.isArray(existing.data) && existing.data.length > 0) {
      data = existing.data;
      error = null;
    }
  }

  if (error) {
    throw new Error(
      error.code === '42501'
        ? 'Permiso denegado por RLS al guardar inventario. Verifica tu sesión.'
        : `No se pudo guardar el balance de inventario (${error.message}).`
    );
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) {
    throw new Error('Supabase devolvió 0 filas al insertar el balance de inventario.');
  }

  const saved = rows[0] as Record<string, unknown>;
  return {
    id: String(saved.id),
    date: String(saved.date || nowCaracasIso),
    store: String(saved.store || cleanStore),
    product: String(saved.product || cleanProduct),
    initialQuantity: Number(saved.initialQuantity ?? init),
    finalQuantity: Number(saved.finalQuantity ?? finalQuantity),
    degustations: Number(saved.degustations ?? samples),
    sales_generated: Number(saved.sales_generated ?? sales),
    comments: String(saved.comments || ''),
    promoter: String(saved.promoter || params.context.nombre),
    promotora_id: saved.promotora_id ? String(saved.promotora_id) : params.context.promotoraId,
    region: saved.region ? String(saved.region) : params.context.region,
    zona: saved.zona ? String(saved.zona) : params.zona || '',
    created_at: saved.created_at ? String(saved.created_at) : nowCaracasIso,
  };
}

/**
 * Registra una encuesta larga de degustación al consumidor en `public.surveys`.
 */
export async function createPortalConsumerSurvey(params: {
  context: PortalPromotoraContext;
  store: string;
  product: string;
  sabor: number;
  textura: number;
  intencionCompra: 'Muy probable' | 'Probable' | 'Poco probable' | 'Nada probable';
  percepcionCalidad: 'Mejor' | 'Igual' | 'Peor';
  relacionCalidadPrecio: 'Excelente' | 'Buena' | 'Regular' | 'Mala';
  recomendacion: number;
  comments?: string;
  clientSubmissionId?: string | null;
}): Promise<{ id: string }> {
  const cleanStore = String(params.store || '').trim();
  const cleanProduct = String(params.product || '').trim();
  if (!cleanStore) throw new Error('Selecciona el Punto de Venta (PDV).');
  if (!cleanProduct) throw new Error('Selecciona el producto degustado.');

  const client = getSupabaseClient();
  const nowCaracasIso = getCaracasIsoTimestamp();
  const submissionId = normalizeOptionalClientSubmissionId(params.clientSubmissionId);

  const baseRow = {
    type: 'Profunda',
    date: nowCaracasIso,
    store: cleanStore,
    promoter: params.context.nombre,
    product: cleanProduct,
    rating: params.recomendacion,
    intent: params.intencionCompra,
    comments: JSON.stringify({
      isTasting: true,
      acceptance: params.recomendacion >= 4 ? 'Alta' : params.recomendacion === 3 ? 'Media' : 'Baja',
      sensoryRatings: { sabor: params.sabor, textura: params.textura },
      percepcionCalidad: params.percepcionCalidad,
      relacionCalidadPrecio: params.relacionCalidadPrecio,
      intencionCompra: params.intencionCompra,
      originalComments: String(params.comments || '').trim().slice(0, 500),
    }),
    creatorId: params.context.correo || params.context.nombre,
    promotora_id: params.context.promotoraId,
    auth_user_id: params.context.authUserId,
    region: params.context.region,
  };

  const payload = submissionId ? { ...baseRow, client_submission_id: submissionId } : baseRow;
  let { data, error } = await client.from('surveys').insert(payload).select('id');

  if (error && submissionId && isMissingColumnError(error)) {
    const retry = await client.from('surveys').insert(baseRow).select('id');
    data = retry.data;
    error = retry.error;
  } else if (error && submissionId && isUniqueViolationError(error)) {
    const existing = await client
      .from('surveys')
      .select('id')
      .eq('client_submission_id', submissionId)
      .limit(1);
    if (!existing.error && Array.isArray(existing.data) && existing.data.length > 0) {
      data = existing.data;
      error = null;
    }
  }

  if (error) {
    throw new Error(`No se pudo registrar la encuesta (${error.message}).`);
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) {
    throw new Error('Supabase devolvió 0 filas al guardar la encuesta.');
  }
  return { id: String((rows[0] as { id: string }).id) };
}

/**
 * Registra un monitoreo comparativo de precios bimonetario en `public.prices` con foto opcional en Storage.
 * Preserva intactos los montos originales (`ourPrice` / `competitor*Price`) junto con el snapshot inmutable
 * de la tasa BCV del día y los montos normalizados en USD (`precio_propio_usd`, `precio_competencia_usd`, `competitors_meta`).
 */
export async function createPortalPriceSurvey(params: {
  context: PortalPromotoraContext;
  store: string;
  cadena?: string;
  zona?: string;
  ourProduct: string;
  /** Retrocompatible: monto propio (en USD o en `ownCurrency` si se especifica). */
  ourPriceUsd: number;
  ownCurrency?: PriceCurrency;
  ownOriginalPrice?: number;
  bcvRate: number;
  bcvRateDate?: string;
  competitors: Array<{
    name: string;
    priceUsd?: number;
    originalPrice?: number;
    currency?: PriceCurrency;
  }>;
  photoFile?: File | Blob | null;
  observations?: string;
  ocrAsistido?: boolean;
  ocrConfianza?: 'alta' | 'media' | 'baja' | null;
  clientSubmissionId?: string | null;
}): Promise<{ id: string }> {
  const cleanStore = String(params.store || '').trim();
  const cleanProduct = String(params.ourProduct || '').trim();
  const ownCurrency: PriceCurrency = params.ownCurrency ?? 'USD';
  const ownRawPrice =
    params.ownOriginalPrice !== undefined ? Number(params.ownOriginalPrice) : Number(params.ourPriceUsd);

  if (!cleanStore) throw new Error('Selecciona el Punto de Venta (PDV).');
  if (!cleanProduct) throw new Error('Selecciona el producto evaluado.');
  if (!Number.isFinite(ownRawPrice) || ownRawPrice <= 0) {
    throw new Error('Ingresa un precio de góndola propio mayor a cero.');
  }

  const normalized = normalizePriceSurveyBimonetary({
    ownPrice: ownRawPrice,
    ownCurrency,
    bcvRate: params.bcvRate,
    competitors: params.competitors.map((c) => ({
      name: c.name,
      price: c.originalPrice !== undefined ? Number(c.originalPrice) : Number(c.priceUsd ?? 0),
      currency: c.currency ?? 'USD',
    })),
  });

  const client = getSupabaseClient();
  const submissionId = normalizeOptionalClientSubmissionId(params.clientSubmissionId);
  let uploadedPhotoPath: string | null = null;

  if (params.photoFile) {
    const processed = await stampAndCompressImageBlob({
      file: params.photoFile,
      watermarkText: `CODIZULCA PRECIOS • ${cleanStore.slice(0, 26)} • ${getCaracasTodayYmd()}`,
      maxDimension: 960,
    });
    const path = buildSanitizedPortalStoragePath({
      promotoraId: params.context.promotoraId,
      modulo: 'precios',
      ext: processed.ext,
      prefix: 'fleje',
    });
    const up = await client.storage
      .from(ASISTENCIA_PRIVATE_BUCKET_ID)
      .upload(path, processed.blob, { contentType: processed.mimeType, upsert: false });
    if (up.error) {
      throw new Error(`No se pudo subir la foto del fleje (${up.error.message}).`);
    }
    uploadedPhotoPath = path;
  }

  try {
    const validComps = normalized.competitorsMeta;
    const todayYmd = params.bcvRateDate || getCaracasTodayYmd();
    const basePayload = {
      date: getCaracasIsoTimestamp(),
      store: cleanStore,
      ourProduct: cleanProduct,
      // Conservamos monto original exacto en ourPrice / competitor*Price para trazabilidad contable
      ourPrice: Number(normalized.ownOriginalPrice.toFixed(2)),
      competitor1Brand: validComps[0]?.brand || null,
      competitor1Price: validComps[0] ? Number(validComps[0].originalPrice.toFixed(2)) : null,
      competitor2Brand: validComps[1]?.brand || null,
      competitor2Price: validComps[1] ? Number(validComps[1].originalPrice.toFixed(2)) : null,
      competitor3Brand: validComps[2]?.brand || null,
      competitor3Price: validComps[2] ? Number(validComps[2].originalPrice.toFixed(2)) : null,
      competitorBrand: validComps[0]?.brand || null,
      competitorPrice: validComps[0] ? Number(validComps[0].originalPrice.toFixed(2)) : null,
      bcv_rate: normalized.bcvRateApplied ? Number(normalized.bcvRateApplied.toFixed(4)) : null,
      photo_storage_path: uploadedPhotoPath,
      comments: String(params.observations || '').trim().slice(0, 500),
      creatorId: params.context.correo || params.context.nombre,
      promoter: params.context.nombre,
      promotora_id: params.context.promotoraId,
      auth_user_id: params.context.authUserId,
      region: params.context.region,
    };

    const extendedPayload = {
      ...basePayload,
      ...(submissionId ? { client_submission_id: submissionId } : {}),
      cadena: params.cadena ? String(params.cadena).trim().slice(0, 120) : null,
      zona: params.zona ? String(params.zona).trim().slice(0, 120) : params.context.direccion || null,
      moneda_propia: normalized.ownCurrency,
      moneda_competencia: normalized.primaryCompetitorCurrency,
      tasa_bcv_aplicada: normalized.bcvRateApplied,
      tasa_bcv_fecha: todayYmd,
      precio_propio_usd: normalized.ownPriceUsd,
      precio_competencia_usd:
        normalized.primaryCompetitorPriceUsd > 0 ? normalized.primaryCompetitorPriceUsd : null,
      brecha_usd: validComps.length > 0 ? normalized.brechaUsd : null,
      brecha_porcentaje: validComps.length > 0 ? normalized.brechaPorcentaje : null,
      competitors_meta: validComps,
      ocr_asistido: Boolean(params.ocrAsistido),
      ocr_confianza: params.ocrAsistido ? (params.ocrConfianza ?? 'media') : null,
    };

    let { data, error } = await client.from('prices').insert(extendedPayload).select('id');

    // Retrocompatibilidad segura si el entorno aún no ejecutó la migración aditiva de columnas bimonetarias
    if (error && isMissingColumnError(error)) {
      const legacyPayloadBase = {
        ...basePayload,
        ourPrice: Number(normalized.ownPriceUsd.toFixed(2)),
        competitor1Price: validComps[0] ? Number(validComps[0].priceUsd.toFixed(2)) : null,
        competitor2Price: validComps[1] ? Number(validComps[1].priceUsd.toFixed(2)) : null,
        competitor3Price: validComps[2] ? Number(validComps[2].priceUsd.toFixed(2)) : null,
        competitorPrice: validComps[0] ? Number(validComps[0].priceUsd.toFixed(2)) : null,
      };
      const legacyWithSub = submissionId
        ? { ...legacyPayloadBase, client_submission_id: submissionId }
        : legacyPayloadBase;
      const retry = await client.from('prices').insert(legacyWithSub).select('id');
      data = retry.data;
      error = retry.error;

      if (error && submissionId && isMissingColumnError(error)) {
        const retryPlain = await client.from('prices').insert(legacyPayloadBase).select('id');
        data = retryPlain.data;
        error = retryPlain.error;
      }
    }

    if (error && submissionId && isUniqueViolationError(error)) {
      const existing = await client
        .from('prices')
        .select('id')
        .eq('client_submission_id', submissionId)
        .limit(1);
      if (!existing.error && Array.isArray(existing.data) && existing.data.length > 0) {
        data = existing.data;
        error = null;
        if (uploadedPhotoPath) {
          await client.storage
            .from(ASISTENCIA_PRIVATE_BUCKET_ID)
            .remove([uploadedPhotoPath])
            .catch(() => undefined);
          uploadedPhotoPath = null;
        }
      }
    }

    if (error) {
      throw new Error(`No se pudo guardar el monitoreo de precios (${error.message}).`);
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (rows.length === 0) {
      throw new Error('Supabase devolvió 0 filas al guardar precios.');
    }
    return { id: String((rows[0] as { id: string }).id) };
  } catch (err) {
    if (uploadedPhotoPath) {
      await client.storage
        .from(ASISTENCIA_PRIVATE_BUCKET_ID)
        .remove([uploadedPhotoPath])
        .catch(() => undefined);
    }
    throw err;
  }
}

/**
 * Registra un informe/acta de Merchandising o Escaneo de Góndola en `public.surveys`
 * (`type = 'Merchandising'`) subiendo evidencias al bucket privado `asistencia-evidencias`.
 */
export async function createPortalMerchandisingReport(params: {
  context: PortalPromotoraContext;
  mode: 'escaneo_gondola' | 'certificacion_visita';
  store: string;
  address?: string;
  date: string;
  time: string;
  activities: string[];
  productDetail: string;
  observations?: string;
  storeManagerName?: string;
  storeManagerRole?: string;
  storeManagerPhone?: string;
  photoFiles: Array<File | Blob>;
  signatureBlob?: Blob | null;
  shelfMetrics?: {
    category: string;
    ourFacings: number;
    competitorFacings: number;
    totalFacings: number;
    shareOfShelfPercent: number;
    outOfStockDetected: boolean;
    popDetected: boolean;
  };
  clientSubmissionId?: string | null;
}): Promise<{ id: string }> {
  const cleanStore = String(params.store || '').trim();
  if (!cleanStore) throw new Error('Selecciona el Punto de Venta (PDV).');
  if (params.photoFiles.length > 6) {
    throw new Error('Máximo 6 fotografías permitidas por informe de merchandising.');
  }

  const client = getSupabaseClient();
  const submissionId = normalizeOptionalClientSubmissionId(params.clientSubmissionId);
  const uploadedPaths: string[] = [];

  try {
    for (let idx = 0; idx < params.photoFiles.length; idx++) {
      const processed = await stampAndCompressImageBlob({
        file: params.photoFiles[idx],
        watermarkText: `CODIZULCA MERCH • ${cleanStore.slice(0, 24)} • ${params.date} ${params.time}`,
        maxDimension: 1200,
      });
      const path = buildSanitizedPortalStoragePath({
        promotoraId: params.context.promotoraId,
        modulo: 'merchandising',
        ext: processed.ext,
        prefix: `foto${idx + 1}`,
      });
      const up = await client.storage
        .from(ASISTENCIA_PRIVATE_BUCKET_ID)
        .upload(path, processed.blob, { contentType: processed.mimeType, upsert: false });
      if (up.error) {
        throw new Error(`No se pudo subir la foto #${idx + 1} (${up.error.message}).`);
      }
      uploadedPaths.push(path);
    }

    let signaturePath: string | null = null;
    if (params.signatureBlob) {
      const sigPath = buildSanitizedPortalStoragePath({
        promotoraId: params.context.promotoraId,
        modulo: 'merchandising',
        ext: 'png',
        prefix: 'firma',
      });
      const upSig = await client.storage
        .from(ASISTENCIA_PRIVATE_BUCKET_ID)
        .upload(sigPath, params.signatureBlob, { contentType: 'image/png', upsert: false });
      if (upSig.error) {
        throw new Error(`No se pudo guardar la firma digital (${upSig.error.message}).`);
      }
      signaturePath = sigPath;
      uploadedPaths.push(sigPath);
    }

    const baseMerchRow = {
      type: 'Merchandising',
      date: params.date,
      store: cleanStore,
      promoter: params.context.nombre,
      product: params.productDetail || 'Línea General Codizulca',
      comments: JSON.stringify({
        mode: params.mode,
        date: params.date,
        time: params.time,
        address: params.address || '',
        activities: params.activities,
        observations: String(params.observations || '').trim(),
        storeManagerName: params.storeManagerName || '',
        storeManagerRole: params.storeManagerRole || 'Encargado de Tienda',
        storeManagerPhone: params.storeManagerPhone || '',
        certified: Boolean(signaturePath),
        signedAt: getCaracasIsoTimestamp(),
        photoStoragePaths: uploadedPaths.filter((p) => p !== signaturePath),
        signatureStoragePath: signaturePath,
        ...(params.shelfMetrics ? { category: params.shelfMetrics.category, metrics: params.shelfMetrics } : {}),
      }),
      creatorId: params.context.correo || params.context.nombre,
      promotora_id: params.context.promotoraId,
      auth_user_id: params.context.authUserId,
      region: params.context.region,
    };

    const merchPayload = submissionId
      ? { ...baseMerchRow, client_submission_id: submissionId }
      : baseMerchRow;
    let { data, error } = await client.from('surveys').insert(merchPayload).select('id');

    if (error && submissionId && isMissingColumnError(error)) {
      const retry = await client.from('surveys').insert(baseMerchRow).select('id');
      data = retry.data;
      error = retry.error;
    } else if (error && submissionId && isUniqueViolationError(error)) {
      const existing = await client
        .from('surveys')
        .select('id')
        .eq('client_submission_id', submissionId)
        .limit(1);
      if (!existing.error && Array.isArray(existing.data) && existing.data.length > 0) {
        data = existing.data;
        error = null;
        if (uploadedPaths.length > 0) {
          await client.storage
            .from(ASISTENCIA_PRIVATE_BUCKET_ID)
            .remove(uploadedPaths)
            .catch(() => undefined);
          uploadedPaths.length = 0;
        }
      }
    }

    if (error) {
      throw new Error(`No se pudo guardar el informe de merchandising (${error.message}).`);
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (rows.length === 0) {
      throw new Error('Supabase devolvió 0 filas al guardar el informe de merchandising.');
    }
    return { id: String((rows[0] as { id: string }).id) };
  } catch (err) {
    if (uploadedPaths.length > 0) {
      await client.storage
        .from(ASISTENCIA_PRIVATE_BUCKET_ID)
        .remove(uploadedPaths)
        .catch(() => undefined);
    }
    throw err;
  }
}
