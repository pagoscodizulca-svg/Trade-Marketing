import type { Request, Response } from 'express';
import {
  type AllowedAttendanceImageMime,
  ASISTENCIA_PRIVATE_BUCKET_ID,
  type AsistenciaEvidenciaDbRow,
  type AsistenciaJornadaDbRow,
  BatchSignedUrlsRequestSchema,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  evaluateAttendanceCompliance,
  formatServerTimestampCaracas,
  formatYmdToSlash,
  getCaracasTodayYmd,
  isSlotAllowedForProfile,
  MAX_ATTENDANCE_EVIDENCE_BYTES,
  type PerfilAsistencia,
  sanitizeAttendanceText,
  type SlotFotoAsistencia,
  UploadAttendanceEvidenceMetadataSchema,
  validateSlotAgainstAppliedProfile,
} from '../types/attendanceEvidences';
import {
  assertSafeAttendanceStoragePath,
  AttendanceFileSecurityError,
  buildDeterministicAttendanceStoragePath,
  verifyAttendanceImageMagicBytes,
} from './imageMagicBytesValidator';
import { createLogger, type Logger } from './logger';
import {
  type AuthenticatedServerUser,
  createUserScopedSupabaseClient,
  extractRawActiveSucursalHeader,
  getAdminSupabaseClient,
  isCoordinatorOrAdminRole,
  isOperativeServerSucursal,
  normalizeOperativeServerSucursal,
  normalizeServerSucursal,
  type OperativeSucursal,
} from './supabaseAdminAuth';

export interface StaffProfileLookupResult {
  id: string;
  name: string;
  email: string;
  assignedStore: string;
  address: string;
  sucursal?: OperativeSucursal | null;
  active: boolean;
  isMerchandising: boolean;
  masterProfile: PerfilAsistencia;
}

/**
 * Error controlado de conflicto de concurrencia (bloqueo optimista / CAS fallido).
 * El handler responde siempre HTTP 409 Conflict tras ejecutar rollback en Storage.
 */
export class AttendanceConcurrencyConflictError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'EVIDENCE_CONCURRENCY_CONFLICT';
  public readonly currentVersion: number | null;
  public readonly currentId: string | null;

  constructor(
    message = 'La evidencia fotográfica fue modificada simultáneamente por otra operación. Recargue la vista y vuelva a intentarlo.',
    details?: { currentVersion?: number | null; currentId?: string | null }
  ) {
    super(message);
    this.name = 'AttendanceConcurrencyConflictError';
    this.currentVersion = details?.currentVersion ?? null;
    this.currentId = details?.currentId ?? null;
  }
}

export interface UpsertSlotEvidenceParams {
  asistenciaId: string;
  slotFoto: SlotFotoAsistencia;
  storageBucket: string;
  storagePath: string;
  mimeType: AllowedAttendanceImageMime;
  sizeBytes: number;
  sha256Hex: string;
  anchoPx: number | null;
  altoPx: number | null;
  pdvNombre: string;
  lat: number | null;
  lng: number | null;
  gpsAccuracy: number | null;
  sucursal?: OperativeSucursal | null;
  capturadoEnServidorIso: string;
  cargadoPorUid: string;
  cargadoPorRol: 'promotora' | 'coordinadora' | 'admin';
  /** ID de la evidencia previa esperada en reemplazos; `null` en alta inicial. */
  expectedEvidenceId?: string | null;
  /** Versión optimista esperada (`version`) en reemplazos; `null` en alta inicial. */
  expectedVersion?: number | null;
  /** Ruta Storage previa esperada (respaldo CAS si la columna `version` aún no existe en BD). */
  expectedStoragePath?: string | null;
  /** Timestamp previo de captura en servidor (respaldo CAS si `version` aún no existe en BD). */
  expectedCapturedAtIso?: string | null;
}

/**
 * Interfaz de persistencia y almacenamiento privado desacoplada para producción (Supabase)
 * y pruebas de integración deterministas sin efectos secundarios.
 */
export interface AttendancePersistenceGateway {
  lookupStaffProfile(promotoraId: string): Promise<StaffProfileLookupResult | null>;
  findJornadaByDateAndPromotora(
    fechaJornada: string,
    promotoraId: string
  ): Promise<AsistenciaJornadaDbRow | null>;
  createJornadaIfAbsent(params: {
    fechaJornada: string;
    promotoraId: string;
    promotoraNombre: string;
    perfilAplicado: PerfilAsistencia;
    pdvNombre: string;
    zona: string;
    sucursal?: OperativeSucursal | null;
    openedAtServerIso: string;
    openedByUid: string;
  }): Promise<AsistenciaJornadaDbRow>;
  listEvidencesByJornadaId(asistenciaId: string): Promise<AsistenciaEvidenciaDbRow[]>;
  upsertSlotEvidence(params: UpsertSlotEvidenceParams): Promise<AsistenciaEvidenciaDbRow>;
  uploadPrivateObject(params: {
    bucket: string;
    path: string;
    buffer: Buffer;
    mimeType: AllowedAttendanceImageMime;
  }): Promise<void>;
  deletePrivateObjects(bucket: string, paths: string[]): Promise<void>;
  createSignedUrls(
    bucket: string,
    paths: string[],
    ttlSeconds: number
  ): Promise<Record<string, string>>;
  findEvidencesWithOwnerByIds(evidenciaIds: string[]): Promise<
    Array<{
      evidencia: AsistenciaEvidenciaDbRow;
      promotoraId: string;
      sucursal?: OperativeSucursal | null;
    }>
  >;
}

const defaultAttendanceLogger: Logger = createLogger({
  base: { service: 'attendance-evidences' },
});

function getConfiguredBucketId(): string {
  const envBucket = String(process.env.ASISTENCIA_STORAGE_BUCKET || '').trim();
  return envBucket || ASISTENCIA_PRIVATE_BUCKET_ID;
}

function getConfiguredSignedUrlTtlSeconds(): number {
  const parsed = Number.parseInt(
    String(process.env.ASISTENCIA_SIGNED_URL_TTL_SECONDS || ''),
    10
  );
  if (Number.isFinite(parsed) && parsed >= 60 && parsed <= 3600) {
    return parsed;
  }
  return DEFAULT_SIGNED_URL_TTL_SECONDS;
}

function normalizeActorDbRole(appRole: string): 'promotora' | 'coordinadora' | 'admin' {
  const clean = String(appRole || '').trim().toLowerCase();
  if (clean === 'super_admin' || clean === 'superadmin' || clean === 'admin' || clean === 'gerente_admin') {
    return 'admin';
  }
  if (isCoordinatorOrAdminRole(clean)) return 'coordinadora';
  return 'promotora';
}

function decodeMetadataHeader(req: Request): unknown {
  const rawHeader = req.headers['x-asistencia-meta'];
  const headerStr = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!headerStr || typeof headerStr !== 'string') {
    return null;
  }
  if (headerStr.length > 4096) {
    throw new Error('METADATA_HEADER_TOO_LARGE');
  }

  const normalizedB64 = headerStr.trim().replace(/-/g, '+').replace(/_/g, '/');
  const jsonText = Buffer.from(normalizedB64, 'base64').toString('utf8');
  const parsed = JSON.parse(jsonText) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  // Defensa anti-Prototype-Pollution
  const safeCopy: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    safeCopy[key] = val;
  }
  return safeCopy;
}

function normalizeRegionalSucursal(raw: unknown): OperativeSucursal | null {
  return normalizeOperativeServerSucursal(raw);
}

function isCrossBranchViolation(
  actorSucursal: string | null | undefined,
  recordSucursal: string | null | undefined
): boolean {
  const actorRegional = normalizeRegionalSucursal(actorSucursal);
  if (!actorRegional) return false; // GLOBAL sin hub explícito o entorno legado sin sede explícita
  const targetRegional = normalizeRegionalSucursal(recordSucursal);
  if (!targetRegional) return false;
  return actorRegional !== targetRegional;
}

function isMissingRpcError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim();
  const msg = String(err.message || '');
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    /Could not find the function/i.test(msg) ||
    /rpc_upsert_asistencia_evidencia_cas/i.test(msg)
  );
}

function isMissingVersionColumnError(
  err: { code?: string; message?: string } | null | undefined
): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim();
  const msg = String(err.message || '');
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    /column ["']?(version|updated_at)["']?.*does not exist/i.test(msg) ||
    /Could not find the '(version|updated_at)' column/i.test(msg)
  );
}

function createSupabaseAttendanceGateway(
  authUser: AuthenticatedServerUser
): AttendancePersistenceGateway | null {
  const client =
    getAdminSupabaseClient() ||
    (authUser.accessToken
      ? createUserScopedSupabaseClient(authUser.accessToken, authUser.activeSucursalHeader)
      : null);

  if (!client) return null;

  return {
    async lookupStaffProfile(promotoraId: string): Promise<StaffProfileLookupResult | null> {
      const { data, error } = await client
        .from('staff')
        .select('id, name, role, email, status, sucursal')
        .eq('id', promotoraId)
        .maybeSingle();

      if (error || !data) return null;

      let statusObj: Record<string, unknown> = {};
      if (typeof data.status === 'string' && data.status.trim().startsWith('{')) {
        try {
          statusObj = JSON.parse(data.status) as Record<string, unknown>;
        } catch {
          statusObj = {};
        }
      }

      const statusLabel = String(statusObj.status || 'Activo').trim();
      const rawCategory = String(statusObj.category || '')
        .trim()
        .toLowerCase();
      const rawRoleLower = String(data.role || '')
        .trim()
        .toLowerCase();

      const active = statusLabel.toLowerCase() !== 'inactivo';
      const isMerchandising =
        rawCategory === 'merchandising' || rawRoleLower.includes('merchandising');
      const masterProfile: PerfilAsistencia =
        rawCategory === 'eventual' || rawRoleLower.includes('eventual')
          ? 'EVENTUAL'
          : 'FIJA';

      return {
        id: String(data.id),
        name: sanitizeAttendanceText(data.name, 160),
        email: sanitizeAttendanceText(data.email, 160),
        assignedStore: sanitizeAttendanceText(statusObj.assignedLocation, 180),
        address: sanitizeAttendanceText(statusObj.address, 180),
        sucursal: normalizeRegionalSucursal((data as { sucursal?: unknown }).sucursal),
        active,
        isMerchandising,
        masterProfile,
      };
    },

    async findJornadaByDateAndPromotora(
      fechaJornada: string,
      promotoraId: string
    ): Promise<AsistenciaJornadaDbRow | null> {
      const { data, error } = await client
        .from('asistencias_jornada')
        .select('*')
        .eq('fecha_jornada', fechaJornada)
        .eq('promotora_id', promotoraId)
        .maybeSingle();

      if (error) {
        throw new Error(`DB_READ_JORNADA_ERROR: ${error.message}`);
      }
      return (data as AsistenciaJornadaDbRow | null) ?? null;
    },

    async createJornadaIfAbsent(params): Promise<AsistenciaJornadaDbRow> {
      const { data, error } = await client
        .from('asistencias_jornada')
        .insert({
          fecha_jornada: params.fechaJornada,
          promotora_id: params.promotoraId,
          promotora_nombre: params.promotoraNombre,
          perfil_aplicado: params.perfilAplicado,
          pdv_nombre: params.pdvNombre,
          zona: params.zona,
          ...(params.sucursal ? { sucursal: params.sucursal } : {}),
          opened_at_server: params.openedAtServerIso,
          updated_at_server: params.openedAtServerIso,
          opened_by_uid: params.openedByUid,
        })
        .select('*')
        .single();

      if (error) {
        // Condición de carrera idempotente: otra petición abrió la misma jornada en paralelo
        if (error.code === '23505') {
          const existing = await this.findJornadaByDateAndPromotora(
            params.fechaJornada,
            params.promotoraId
          );
          if (existing) return existing;
        }
        throw new Error(`DB_CREATE_JORNADA_ERROR: ${error.message}`);
      }

      return data as AsistenciaJornadaDbRow;
    },

    async listEvidencesByJornadaId(asistenciaId: string): Promise<AsistenciaEvidenciaDbRow[]> {
      const { data, error } = await client
        .from('asistencia_evidencias')
        .select('*')
        .eq('asistencia_id', asistenciaId);

      if (error) {
        throw new Error(`DB_LIST_EVIDENCES_ERROR: ${error.message}`);
      }
      return Array.isArray(data) ? (data as AsistenciaEvidenciaDbRow[]) : [];
    },

    /**
     * Escritura atómica con bloqueo optimista (anti-TOCTOU):
     * 1. Intenta RPC transaccional `rpc_upsert_asistencia_evidencia_cas` (`FOR UPDATE` + versión).
     * 2. Si el RPC aún no está desplegado, aplica CAS atómico directo en PostgreSQL:
     *    - Alta inicial (`expectedEvidenceId == null`): `INSERT` estricto (`23505` -> 409 Conflict).
     *    - Reemplazo (`expectedEvidenceId != null`): `UPDATE ... WHERE id = $1 AND version = $expectedVersion`
     *      (con respaldo `storage_path` + `capturado_en_servidor` si la columna `version` aún no se migró).
     */
    async upsertSlotEvidence(params: UpsertSlotEvidenceParams): Promise<AsistenciaEvidenciaDbRow> {
      const safePath = assertSafeAttendanceStoragePath(params.storagePath);
      const isReplacement = Boolean(params.expectedEvidenceId);
      const expectedVersion = isReplacement
        ? Math.max(1, Math.trunc(params.expectedVersion ?? 1))
        : null;

      // 1. Camino preferente: RPC transaccional CAS en PostgreSQL
      const rpcResp = await client.rpc('rpc_upsert_asistencia_evidencia_cas', {
        p_asistencia_id: params.asistenciaId,
        p_slot_foto: params.slotFoto,
        p_storage_bucket: params.storageBucket,
        p_storage_path: safePath,
        p_mime_type: params.mimeType,
        p_tamano_bytes: params.sizeBytes,
        p_sha256_hex: params.sha256Hex,
        p_ancho_px: params.anchoPx,
        p_alto_px: params.altoPx,
        p_pdv_nombre: params.pdvNombre,
        p_lat: params.lat,
        p_lng: params.lng,
        p_gps_accuracy: params.gpsAccuracy,
        p_cargado_por_uid: params.cargadoPorUid,
        p_cargado_por_rol: params.cargadoPorRol,
        p_expected_evidence_id: params.expectedEvidenceId ?? null,
        p_expected_version: expectedVersion,
        p_sucursal: params.sucursal ?? null,
      });

      if (!rpcResp.error && rpcResp.data && typeof rpcResp.data === 'object') {
        const payload = rpcResp.data as {
          status?: string;
          evidencia?: AsistenciaEvidenciaDbRow;
          current_version?: number | null;
          current_id?: string | null;
        };
        if (payload.status === 'CONFLICT') {
          throw new AttendanceConcurrencyConflictError(undefined, {
            currentVersion: payload.current_version ?? null,
            currentId: payload.current_id ?? null,
          });
        }
        if ((payload.status === 'INSERTED' || payload.status === 'UPDATED') && payload.evidencia) {
          return payload.evidencia;
        }
      } else if (rpcResp.error && !isMissingRpcError(rpcResp.error)) {
        if (rpcResp.error.code === '23505') {
          throw new AttendanceConcurrencyConflictError();
        }
        throw new Error(`DB_UPSERT_EVIDENCE_ERROR: ${rpcResp.error.message}`);
      }

      // 2. Respaldo atómico PostgREST CAS (sin sobreescritura ciega `ON CONFLICT DO UPDATE`)
      const baseColumns = {
        storage_bucket: params.storageBucket,
        storage_path: safePath,
        mime_type: params.mimeType,
        tamano_bytes: params.sizeBytes,
        sha256_hex: params.sha256Hex,
        ancho_px: params.anchoPx,
        alto_px: params.altoPx,
        pdv_nombre: params.pdvNombre,
        lat: params.lat,
        lng: params.lng,
        gps_accuracy: params.gpsAccuracy,
        ...(params.sucursal ? { sucursal: params.sucursal } : {}),
        capturado_en_servidor: params.capturadoEnServidorIso,
        cargado_por_uid: params.cargadoPorUid,
        cargado_por_rol: params.cargadoPorRol,
      };

      if (!isReplacement) {
        const insertPayload = {
          asistencia_id: params.asistenciaId,
          slot_foto: params.slotFoto,
          ...baseColumns,
          version: 1,
          updated_at: params.capturadoEnServidorIso,
        };
        let insertRes = await client
          .from('asistencia_evidencias')
          .insert(insertPayload)
          .select('*')
          .single();

        if (insertRes.error && isMissingVersionColumnError(insertRes.error)) {
          insertRes = await client
            .from('asistencia_evidencias')
            .insert({
              asistencia_id: params.asistenciaId,
              slot_foto: params.slotFoto,
              ...baseColumns,
            })
            .select('*')
            .single();
        }

        if (insertRes.error) {
          if (insertRes.error.code === '23505') {
            throw new AttendanceConcurrencyConflictError(
              'Otro envío registró simultáneamente esta misma ranura de evidencia. Recargue la vista antes de reemplazarla.'
            );
          }
          throw new Error(`DB_UPSERT_EVIDENCE_ERROR: ${insertRes.error.message}`);
        }
        if (!insertRes.data) {
          throw new Error('DB_UPSERT_EVIDENCE_ERROR: sin respuesta al insertar evidencia');
        }
        return insertRes.data as AsistenciaEvidenciaDbRow;
      }

      // Reemplazo con bloqueo optimista estricto `WHERE id = $id AND version = $expectedVersion`
      const nextVersion = (expectedVersion ?? 1) + 1;
      const versionedUpdate = await client
        .from('asistencia_evidencias')
        .update({
          ...baseColumns,
          version: nextVersion,
          updated_at: params.capturadoEnServidorIso,
        })
        .eq('id', params.expectedEvidenceId!)
        .eq('asistencia_id', params.asistenciaId)
        .eq('slot_foto', params.slotFoto)
        .eq('version', expectedVersion!)
        .select('*')
        .maybeSingle();

      if (versionedUpdate.error && isMissingVersionColumnError(versionedUpdate.error)) {
        // Fallback CAS si la migración de columna `version` aún no se ha aplicado en remoto
        let legacyUpdateQuery = client
          .from('asistencia_evidencias')
          .update(baseColumns)
          .eq('id', params.expectedEvidenceId!)
          .eq('asistencia_id', params.asistenciaId)
          .eq('slot_foto', params.slotFoto);
        if (params.expectedStoragePath) {
          legacyUpdateQuery = legacyUpdateQuery.eq('storage_path', params.expectedStoragePath);
        }
        if (params.expectedCapturedAtIso) {
          legacyUpdateQuery = legacyUpdateQuery.eq(
            'capturado_en_servidor',
            params.expectedCapturedAtIso
          );
        }
        const legacyUpdate = await legacyUpdateQuery.select('*').maybeSingle();
        if (legacyUpdate.error) {
          throw new Error(`DB_UPSERT_EVIDENCE_ERROR: ${legacyUpdate.error.message}`);
        }
        if (!legacyUpdate.data) {
          throw new AttendanceConcurrencyConflictError();
        }
        return legacyUpdate.data as AsistenciaEvidenciaDbRow;
      }

      if (versionedUpdate.error) {
        throw new Error(`DB_UPSERT_EVIDENCE_ERROR: ${versionedUpdate.error.message}`);
      }

      if (!versionedUpdate.data) {
        throw new AttendanceConcurrencyConflictError();
      }

      return versionedUpdate.data as AsistenciaEvidenciaDbRow;
    },

    async uploadPrivateObject(params): Promise<void> {
      const safePath = assertSafeAttendanceStoragePath(params.path);
      const { error } = await client.storage.from(params.bucket).upload(safePath, params.buffer, {
        contentType: params.mimeType,
        upsert: false,
        cacheControl: '900',
      });

      if (error) {
        throw new Error(`STORAGE_UPLOAD_ERROR: ${error.message}`);
      }
    },

    async deletePrivateObjects(bucket: string, paths: string[]): Promise<void> {
      const cleanPaths = paths.map((p) => p.trim()).filter(Boolean);
      if (cleanPaths.length === 0) return;
      const { error } = await client.storage.from(bucket).remove(cleanPaths);
      if (error) {
        throw new Error(`STORAGE_DELETE_ERROR: ${error.message}`);
      }
    },

    async createSignedUrls(
      bucket: string,
      paths: string[],
      ttlSeconds: number
    ): Promise<Record<string, string>> {
      const cleanPaths = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (cleanPaths.length === 0) return {};

      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrls(cleanPaths, ttlSeconds);

      if (error || !Array.isArray(data)) {
        return {};
      }

      const map: Record<string, string> = {};
      for (const entry of data) {
        if (entry.path && entry.signedUrl && !entry.error) {
          map[entry.path] = entry.signedUrl;
        }
      }
      return map;
    },

    async findEvidencesWithOwnerByIds(evidenciaIds: string[]) {
      const { data: evidences, error: evError } = await client
        .from('asistencia_evidencias')
        .select('*')
        .in('id', evidenciaIds);

      if (evError || !Array.isArray(evidences) || evidences.length === 0) {
        return [];
      }

      const jornadaIds = Array.from(
        new Set(evidences.map((e) => String((e as AsistenciaEvidenciaDbRow).asistencia_id)))
      );

      const { data: jornadas, error: jorError } = await client
        .from('asistencias_jornada')
        .select('id, promotora_id, sucursal')
        .in('id', jornadaIds);

      if (jorError || !Array.isArray(jornadas)) {
        return [];
      }

      const ownerByJornadaId = new Map<
        string,
        { promotoraId: string; sucursal: OperativeSucursal | null }
      >();
      for (const j of jornadas) {
        ownerByJornadaId.set(String(j.id), {
          promotoraId: String(j.promotora_id),
          sucursal: normalizeRegionalSucursal((j as { sucursal?: unknown }).sucursal),
        });
      }

      const joined: Array<{
        evidencia: AsistenciaEvidenciaDbRow;
        promotoraId: string;
        sucursal?: OperativeSucursal | null;
      }> = [];
      for (const rawEv of evidences) {
        const ev = rawEv as AsistenciaEvidenciaDbRow;
        const owner = ownerByJornadaId.get(ev.asistencia_id);
        if (owner) {
          joined.push({
            evidencia: ev,
            promotoraId: owner.promotoraId,
            sucursal: normalizeRegionalSucursal(ev.sucursal) ?? owner.sucursal,
          });
        }
      }
      return joined;
    },
  };
}

export interface AttendanceHandlersDependencies {
  resolveGateway?: (authUser: AuthenticatedServerUser) => AttendancePersistenceGateway | null;
  now?: () => Date;
  bucketId?: string;
  signedUrlTtlSeconds?: number;
  logger?: Pick<Logger, 'warn' | 'error'>;
}

export function createAttendanceEvidencesHandlers(deps?: AttendanceHandlersDependencies) {
  const getNow = deps?.now ?? (() => new Date());
  const resolveGateway = deps?.resolveGateway ?? createSupabaseAttendanceGateway;
  const logger = deps?.logger ?? defaultAttendanceLogger;

  const handleUploadEvidence = async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({
        error: 'Autenticación requerida.',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    // 0. Los roles de supervisión de solo lectura (p. ej. contraloría) jamás cargan ni reemplazan
    //    evidencias: se rechazan ANTES de procesar el cuerpo binario.
    if (authUser.isReadOnlyViewer) {
      res.status(403).json({
        error: 'Acceso denegado: su rol es de solo lectura y no puede cargar ni reemplazar evidencias.',
        code: 'READ_ONLY_ROLE',
      });
      return;
    }

    // 1. Verificar firma binaria (magic bytes) y tamaño <= 5 MB antes de tocar BD o Storage
    let verifiedImage;
    try {
      const rawBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      verifiedImage = verifyAttendanceImageMagicBytes(rawBuffer, MAX_ATTENDANCE_EVIDENCE_BYTES);
    } catch (err) {
      if (err instanceof AttendanceFileSecurityError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      res.status(400).json({
        error: 'No se pudo procesar el archivo binario de la evidencia.',
        code: 'INVALID_BINARY_PAYLOAD',
      });
      return;
    }

    // 2. Decodificar y validar metadatos estrictamente con Zod (ignorando reloj y filename del cliente)
    let rawMeta: unknown;
    try {
      rawMeta = decodeMetadataHeader(req);
    } catch {
      res.status(400).json({
        error: 'Cabecera de metadatos x-asistencia-meta inválida o malformada.',
        code: 'INVALID_METADATA_HEADER',
      });
      return;
    }

    const parsedMeta = UploadAttendanceEvidenceMetadataSchema.safeParse(rawMeta);
    if (!parsedMeta.success) {
      const firstIssue = parsedMeta.error.issues[0];
      res.status(400).json({
        error: firstIssue?.message || 'Datos de evidencia inválidos.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const meta = parsedMeta.data;

    const rawMetaBranch = meta.sucursal ? meta.sucursal.trim() : '';
    const metaBranch = rawMetaBranch ? normalizeServerSucursal(rawMetaBranch) : null;
    if (rawMetaBranch && !metaBranch) {
      res.status(400).json({
        error:
          'Sucursal inválida en x-asistencia-meta. Hubs operativos permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
        code: 'INVALID_BRANCH',
      });
      return;
    }

    const rawHeaderBranch = extractRawActiveSucursalHeader(req);
    const headerBranch = rawHeaderBranch ? normalizeServerSucursal(rawHeaderBranch) : null;
    if (rawHeaderBranch && !headerBranch) {
      res.status(400).json({
        error:
          'Cabecera x-sucursal-activa inválida. Hubs operativos permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
        code: 'INVALID_BRANCH',
      });
      return;
    }

    if (isOperativeServerSucursal(authUser.sucursal)) {
      if (metaBranch && metaBranch !== authUser.sucursal) {
        res.status(403).json({
          error: `Acceso denegado por aislamiento multi-sede: tu perfil pertenece a ${authUser.sucursal} y no puede registrar asistencia en ${metaBranch}.`,
          code: 'FORBIDDEN_BRANCH',
        });
        return;
      }
      if (headerBranch && headerBranch !== authUser.sucursal) {
        res.status(403).json({
          error: `Acceso denegado por aislamiento multi-sede: tu perfil pertenece a ${authUser.sucursal} y no puede operar bajo ${headerBranch}.`,
          code: 'FORBIDDEN_BRANCH',
        });
        return;
      }
    } else if (authUser.sucursal === 'GLOBAL') {
      if (metaBranch === 'GLOBAL' || headerBranch === 'GLOBAL') {
        res.status(400).json({
          error:
            'Un perfil GLOBAL debe seleccionar explícitamente un hub operativo (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) y no GLOBAL.',
          code: 'BRANCH_REQUIRED',
        });
        return;
      }
      if (metaBranch && headerBranch && metaBranch !== headerBranch) {
        res.status(400).json({
          error: `Conflicto entre meta.sucursal (${metaBranch}) y x-sucursal-activa (${headerBranch}).`,
          code: 'INVALID_BRANCH',
        });
        return;
      }
    }

    const explicitHub: OperativeSucursal | null =
      (metaBranch && isOperativeServerSucursal(metaBranch) ? metaBranch : null) ??
      (headerBranch && isOperativeServerSucursal(headerBranch) ? headerBranch : null);

    const effectiveActorScope: OperativeSucursal | null = isOperativeServerSucursal(authUser.sucursal)
      ? authUser.sucursal
      : explicitHub;

    const scopedUser: AuthenticatedServerUser = {
      ...authUser,
      activeSucursalHeader: effectiveActorScope,
    };

    // 3. Control de Acceso RBAC y Propiedad (Anti-IDOR)
    if (!authUser.isCoordinatorOrAdmin) {
      if (authUser.appRole !== 'promotora' || authUser.staffId !== meta.promotoraId) {
        res.status(403).json({
          error: 'Acceso denegado: no está autorizado para cargar o reemplazar evidencias de otra promotora.',
          code: 'FORBIDDEN_OWNERSHIP',
        });
        return;
      }
    }

    // 4. Fuente de tiempo oficial del servidor normalizada a America/Caracas (UTC-4)
    const serverNow = getNow();
    const serverNowIso = serverNow.toISOString();
    const todayCaracasYmd = getCaracasTodayYmd(serverNow);

    if (meta.fechaJornada > todayCaracasYmd) {
      res.status(422).json({
        error: `No se permite registrar evidencias en fechas futuras (${meta.fechaJornada} > ${todayCaracasYmd} America/Caracas).`,
        code: 'FUTURE_DATE_NOT_ALLOWED',
      });
      return;
    }

    const gateway = resolveGateway(scopedUser);
    if (!gateway) {
      res.status(503).json({
        error: 'Servicio de almacenamiento seguro no configurado en el servidor.',
        code: 'STORAGE_GATEWAY_UNAVAILABLE',
      });
      return;
    }

    const bucketId = deps?.bucketId ?? getConfiguredBucketId();
    const signedUrlTtlSeconds = deps?.signedUrlTtlSeconds ?? getConfiguredSignedUrlTtlSeconds();

    try {
      // 5. Resolver o abrir cabecera diaria respetando inmutabilidad histórica de `perfil_aplicado`
      let jornada = await gateway.findJornadaByDateAndPromotora(
        meta.fechaJornada,
        meta.promotoraId
      );

      if (jornada && isCrossBranchViolation(effectiveActorScope ?? authUser.sucursal, jornada.sucursal)) {
        res.status(403).json({
          error: `Acceso denegado por aislamiento multi-sede: tu perfil pertenece a ${effectiveActorScope ?? authUser.sucursal} y no puede operar jornadas de ${jornada.sucursal}.`,
          code: 'FORBIDDEN_BRANCH',
        });
        return;
      }

      if (!jornada) {
        const staffProfile = await gateway.lookupStaffProfile(meta.promotoraId);
        if (!staffProfile) {
          res.status(404).json({
            error: 'La promotora indicada no existe en el padrón oficial.',
            code: 'PROMOTORA_NOT_FOUND',
          });
          return;
        }

        if (isCrossBranchViolation(effectiveActorScope ?? authUser.sucursal, staffProfile.sucursal)) {
          res.status(403).json({
            error: `Acceso denegado por aislamiento multi-sede: tu perfil pertenece a ${effectiveActorScope ?? authUser.sucursal} y no puede cargar evidencias para personal de ${staffProfile.sucursal}.`,
            code: 'FORBIDDEN_BRANCH',
          });
          return;
        }

        if (authUser.sucursal === 'GLOBAL' && !staffProfile.sucursal && !explicitHub) {
          res.status(400).json({
            error:
              'Un perfil GLOBAL debe indicar explícitamente un hub operativo (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL).',
            code: 'BRANCH_REQUIRED',
          });
          return;
        }

        if (!staffProfile.active || staffProfile.isMerchandising) {
          res.status(422).json({
            error: 'Solo las promotoras activas (FIJA o EVENTUAL) pueden registrar asistencia fotográfica.',
            code: 'PROMOTORA_INELIGIBLE',
          });
          return;
        }

        // Validar que la ranura corresponda al perfil maestro antes de abrir la cabecera
        if (!isSlotAllowedForProfile(staffProfile.masterProfile, meta.slotFoto)) {
          const check = validateSlotAgainstAppliedProfile({
            perfilAplicado: staffProfile.masterProfile,
            slotFoto: meta.slotFoto,
            existingSlotsInJornada: [],
          });
          res.status(422).json({
            error: !check.ok ? check.message : 'Ranura de foto no permitida para este perfil.',
            code: !check.ok ? check.code : 'SLOT_NOT_ALLOWED_FOR_PROFILE',
          });
          return;
        }

        jornada = await gateway.createJornadaIfAbsent({
          fechaJornada: meta.fechaJornada,
          promotoraId: meta.promotoraId,
          promotoraNombre: staffProfile.name,
          perfilAplicado: staffProfile.masterProfile,
          pdvNombre: meta.pdvNombre || staffProfile.assignedStore || 'PDV',
          zona: meta.zona || staffProfile.address || '',
          sucursal:
            staffProfile.sucursal ?? effectiveActorScope ?? normalizeRegionalSucursal(authUser.sucursal),
          openedAtServerIso: serverNowIso,
          openedByUid: authUser.id,
        });
      }

      // 6. Validar ranura y tope máximo contra el `perfil_aplicado` INMUTABLE de esa jornada
      const existingEvidences = await gateway.listEvidencesByJornadaId(jornada.id);
      const slotCheck = validateSlotAgainstAppliedProfile({
        perfilAplicado: jornada.perfil_aplicado,
        slotFoto: meta.slotFoto,
        existingSlotsInJornada: existingEvidences.map((e) => e.slot_foto),
      });

      if (!slotCheck.ok) {
        res.status(422).json({
          error: slotCheck.message,
          code: slotCheck.code,
        });
        return;
      }

      const previousEvidence =
        existingEvidences.find((e) => e.slot_foto === meta.slotFoto) ?? null;

      // 6.B Validación temprana de bloqueo optimista si el cliente declaró `expectedVersion`
      const currentObservedVersion = previousEvidence ? (previousEvidence.version ?? 1) : null;
      if (
        meta.expectedVersion !== undefined &&
        meta.expectedVersion !== null &&
        currentObservedVersion !== meta.expectedVersion
      ) {
        res.status(409).json({
          ok: false,
          error:
            'La evidencia ya fue actualizada por otra operación. Recargue la vista y vuelva a intentarlo.',
          code: 'EVIDENCE_CONCURRENCY_CONFLICT',
          currentVersion: currentObservedVersion,
          retryable: true,
        });
        return;
      }

      // 7. Generar clave Storage inmutable y única (`<slot>_<uuid>-<timestamp>.<ext>`),
      //    ignorando cualquier nombre del cliente y jamás sobrescribiendo en sitio (`upsert: false`).
      const storagePath = assertSafeAttendanceStoragePath(
        buildDeterministicAttendanceStoragePath({
          fechaJornada: jornada.fecha_jornada,
          promotoraId: jornada.promotora_id,
          slotFoto: meta.slotFoto,
          extension: verifiedImage.extension,
          timestampMs: serverNow.getTime(),
        })
      );

      // 8. Subir binario verificado al bucket privado ANTES de confirmar en PostgreSQL
      await gateway.uploadPrivateObject({
        bucket: bucketId,
        path: storagePath,
        buffer: req.body as Buffer,
        mimeType: verifiedImage.mimeType,
      });

      // 9. Escritura atómica CAS (Compare-And-Swap) en PostgreSQL con rollback inmediato en Storage
      //    si ocurre conflicto concurrente (409) o cualquier error de BD.
      let savedEvidence: AsistenciaEvidenciaDbRow;
      try {
        savedEvidence = await gateway.upsertSlotEvidence({
          asistenciaId: jornada.id,
          slotFoto: meta.slotFoto,
          storageBucket: bucketId,
          storagePath,
          mimeType: verifiedImage.mimeType,
          sizeBytes: verifiedImage.sizeBytes,
          sha256Hex: verifiedImage.sha256Hex,
          anchoPx: meta.anchoPx ?? null,
          altoPx: meta.altoPx ?? null,
          pdvNombre: meta.pdvNombre || jornada.pdv_nombre || 'PDV',
          lat: meta.lat ?? null,
          lng: meta.lng ?? null,
          gpsAccuracy: meta.gpsAccuracy ?? null,
          sucursal:
            normalizeRegionalSucursal(jornada.sucursal) ??
            effectiveActorScope ??
            normalizeRegionalSucursal(authUser.sucursal),
          capturadoEnServidorIso: serverNowIso,
          cargadoPorUid: authUser.id,
          cargadoPorRol: normalizeActorDbRole(authUser.appRole),
          expectedEvidenceId: previousEvidence?.id ?? null,
          expectedVersion: currentObservedVersion,
          expectedStoragePath: previousEvidence?.storage_path ?? null,
          expectedCapturedAtIso: previousEvidence?.capturado_en_servidor ?? null,
        });
      } catch (dbErr) {
        // Rollback inmediato del objeto temporal recién subido (NUNCA toca el objeto anterior ni el ganador)
        await gateway.deletePrivateObjects(bucketId, [storagePath]).catch((rollbackErr) => {
          logger.warn('attendance_storage_rollback_failed', {
            bucketId,
            storagePath,
            asistenciaId: jornada.id,
            slotFoto: meta.slotFoto,
            err: rollbackErr,
          });
        });

        if (dbErr instanceof AttendanceConcurrencyConflictError) {
          res.status(409).json({
            ok: false,
            error: dbErr.message,
            code: dbErr.code,
            currentVersion: dbErr.currentVersion,
            retryable: true,
          });
          return;
        }
        throw dbErr;
      }

      // 10. Limpieza post-commit del archivo anterior en Storage (ÚNICAMENTE tras confirmar BD).
      //     Si falla la eliminación del objeto viejo, se registra advertencia estructurada sin
      //     marcar como fallido el reemplazo ya confirmado.
      if (
        previousEvidence &&
        previousEvidence.storage_path &&
        previousEvidence.storage_path !== savedEvidence.storage_path
      ) {
        await gateway
          .deletePrivateObjects(bucketId, [previousEvidence.storage_path])
          .catch((cleanupErr) => {
            logger.warn('attendance_previous_storage_cleanup_failed', {
              bucketId,
              previousStoragePath: previousEvidence.storage_path,
              activeStoragePath: savedEvidence.storage_path,
              evidenciaId: savedEvidence.id,
              asistenciaId: jornada.id,
              slotFoto: meta.slotFoto,
              err: cleanupErr,
            });
          });
      }

      // 11. Emitir Signed URL temporal de corta duración y resumen actualizado de cumplimiento
      const signedMap = await gateway.createSignedUrls(
        bucketId,
        [savedEvidence.storage_path],
        signedUrlTtlSeconds
      );

      const updatedSlotSet = new Set<SlotFotoAsistencia>(
        existingEvidences.map((e) => e.slot_foto)
      );
      updatedSlotSet.add(savedEvidence.slot_foto);

      const compliance = evaluateAttendanceCompliance(
        jornada.perfil_aplicado,
        updatedSlotSet
      );

      const signedUrl = signedMap[savedEvidence.storage_path] || '';
      const signedUrlExpiresAtIso = new Date(
        serverNow.getTime() + signedUrlTtlSeconds * 1000
      ).toISOString();

      res.status(slotCheck.isReplacement ? 200 : 201).json({
        ok: true,
        replaced: slotCheck.isReplacement,
        jornada: {
          id: jornada.id,
          fechaJornada: jornada.fecha_jornada,
          promotoraId: jornada.promotora_id,
          promotoraNombre: jornada.promotora_nombre,
          perfilAplicado: jornada.perfil_aplicado,
          pdvNombre: savedEvidence.pdv_nombre || jornada.pdv_nombre,
          zona: jornada.zona,
        },
        evidencia: {
          id: savedEvidence.id,
          asistenciaId: savedEvidence.asistencia_id,
          slotFoto: savedEvidence.slot_foto,
          storagePath: savedEvidence.storage_path,
          version: savedEvidence.version ?? 1,
          mimeType: savedEvidence.mime_type,
          sizeBytes: savedEvidence.tamano_bytes,
          pdvNombre: savedEvidence.pdv_nombre,
          capturadoEnServidorIso: savedEvidence.capturado_en_servidor,
          horaCaracasFormateada: formatServerTimestampCaracas(
            savedEvidence.capturado_en_servidor
          ),
          horaCaracasCompleta: `${formatServerTimestampCaracas(
            savedEvidence.capturado_en_servidor,
            { includeSeconds: true }
          )} (UTC-4)`,
          fechaFormateada: formatYmdToSlash(jornada.fecha_jornada),
          lat: savedEvidence.lat,
          lng: savedEvidence.lng,
          gpsAccuracy: savedEvidence.gps_accuracy,
          signedUrl,
          signedUrlExpiresAtIso,
        },
        compliance,
      });
    } catch (err) {
      if (err instanceof AttendanceFileSecurityError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
        });
        return;
      }

      const msg = err instanceof Error ? err.message : '';
      if (
        msg.includes('22P02') ||
        msg.includes('PGRST205') ||
        msg.includes('relation "public.asistencias_jornada" does not exist') ||
        msg.includes('Could not find the table')
      ) {
        res.status(503).json({
          error:
            'Las tablas de evidencias de asistencia aún no han sido creadas en Supabase. Ejecute la migración SQL 20261112_asistencia_evidencias_perfil_condicional.sql.',
          code: 'MIGRATION_PENDING',
        });
        return;
      }

      res.status(500).json({
        error: 'No se pudo completar el registro seguro de la evidencia fotográfica.',
        code: 'ATTENDANCE_UPLOAD_INTERNAL_ERROR',
      });
    }
  };

  const handleBatchSignedUrls = async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({
        error: 'Autenticación requerida.',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const rawHeaderBranch = extractRawActiveSucursalHeader(req);
    const headerBranch = rawHeaderBranch ? normalizeServerSucursal(rawHeaderBranch) : null;
    if (rawHeaderBranch && !headerBranch) {
      res.status(400).json({
        error:
          'Cabecera x-sucursal-activa inválida. Hubs operativos permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
        code: 'INVALID_BRANCH',
      });
      return;
    }

    if (
      isOperativeServerSucursal(authUser.sucursal) &&
      headerBranch &&
      headerBranch !== authUser.sucursal
    ) {
      res.status(403).json({
        error: `Acceso denegado por aislamiento multi-sede: tu perfil pertenece a ${authUser.sucursal} y no puede consultar evidencias bajo ${headerBranch}.`,
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

    const activeHeaderHub =
      headerBranch && isOperativeServerSucursal(headerBranch) ? headerBranch : null;
    const effectiveActorScope = isOperativeServerSucursal(authUser.sucursal)
      ? authUser.sucursal
      : activeHeaderHub;

    const scopedUser: AuthenticatedServerUser = {
      ...authUser,
      activeSucursalHeader: effectiveActorScope,
    };

    const parsed = BatchSignedUrlsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      res.status(400).json({
        error: firstIssue?.message || 'Solicitud de URLs firmadas inválida.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const gateway = resolveGateway(scopedUser);
    if (!gateway) {
      res.status(503).json({
        error: 'Servicio de almacenamiento seguro no disponible.',
        code: 'STORAGE_GATEWAY_UNAVAILABLE',
      });
      return;
    }

    const bucketId = deps?.bucketId ?? getConfiguredBucketId();
    const ttlSeconds = deps?.signedUrlTtlSeconds ?? getConfiguredSignedUrlTtlSeconds();

    try {
      const uniqueIds = Array.from(new Set(parsed.data.evidenciaIds));
      const records = await gateway.findEvidencesWithOwnerByIds(uniqueIds);

      // Verificación estricta de aislamiento multi-sede (5 hubs; GLOBAL ve todas salvo x-sucursal-activa explícita)
      const crossBranch = records.some((r) =>
        isCrossBranchViolation(
          effectiveActorScope ?? authUser.sucursal,
          r.sucursal ?? r.evidencia.sucursal
        )
      );
      if (crossBranch) {
        res.status(403).json({
          error: `Acceso denegado por aislamiento multi-sede: tu perfil pertenece a ${authUser.sucursal} y no puede consultar evidencias de otra sucursal.`,
          code: 'FORBIDDEN_BRANCH',
        });
        return;
      }

      // Verificación estricta de propiedad por fila (anti-IDOR).
      // Coordinación/Admin y los visores de solo lectura (contraloría) consultan evidencias de cualquier promotora de su sede.
      if (!authUser.isCoordinatorOrAdmin && !authUser.isReadOnlyViewer) {
        const unauthorized = records.some((r) => r.promotoraId !== authUser.staffId);
        if (unauthorized) {
          res.status(403).json({
            error: 'Acceso denegado: no puede visualizar evidencias pertenecientes a otra promotora.',
            code: 'FORBIDDEN_OWNERSHIP',
          });
          return;
        }
      }

      const paths = records.map((r) => r.evidencia.storage_path);
      const signedByPath = await gateway.createSignedUrls(bucketId, paths, ttlSeconds);
      const expiresAtIso = new Date(getNow().getTime() + ttlSeconds * 1000).toISOString();

      const signedUrls: Record<string, { url: string; expiresAtIso: string }> = {};
      for (const { evidencia } of records) {
        const url = signedByPath[evidencia.storage_path];
        if (url) {
          signedUrls[evidencia.id] = { url, expiresAtIso };
        }
      }

      res.status(200).json({
        ok: true,
        ttlSeconds,
        signedUrls,
      });
    } catch {
      res.status(500).json({
        error: 'No se pudieron generar las URLs firmadas temporales.',
        code: 'SIGNED_URLS_INTERNAL_ERROR',
      });
    }
  };

  return {
    handleUploadEvidence,
    handleBatchSignedUrls,
  };
}

const defaultHandlers = createAttendanceEvidencesHandlers();
export const handleUploadAttendanceEvidence = defaultHandlers.handleUploadEvidence;
export const handleBatchAttendanceSignedUrls = defaultHandlers.handleBatchSignedUrls;
