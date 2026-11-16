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
  AttendanceFileSecurityError,
  buildDeterministicAttendanceStoragePath,
  verifyAttendanceImageMagicBytes,
} from './imageMagicBytesValidator';
import {
  type AuthenticatedServerUser,
  createUserScopedSupabaseClient,
  getAdminSupabaseClient,
  isCoordinatorOrAdminRole,
} from './supabaseAdminAuth';

export interface StaffProfileLookupResult {
  id: string;
  name: string;
  email: string;
  assignedStore: string;
  address: string;
  active: boolean;
  isMerchandising: boolean;
  masterProfile: PerfilAsistencia;
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
    openedAtServerIso: string;
    openedByUid: string;
  }): Promise<AsistenciaJornadaDbRow>;
  listEvidencesByJornadaId(asistenciaId: string): Promise<AsistenciaEvidenciaDbRow[]>;
  upsertSlotEvidence(params: {
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
    capturadoEnServidorIso: string;
    cargadoPorUid: string;
    cargadoPorRol: 'promotora' | 'coordinadora' | 'admin';
  }): Promise<AsistenciaEvidenciaDbRow>;
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
    }>
  >;
}

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
  if (clean === 'admin' || clean === 'gerente_admin') return 'admin';
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

function createSupabaseAttendanceGateway(
  authUser: AuthenticatedServerUser
): AttendancePersistenceGateway | null {
  const client =
    getAdminSupabaseClient() ||
    (authUser.accessToken ? createUserScopedSupabaseClient(authUser.accessToken) : null);

  if (!client) return null;

  return {
    async lookupStaffProfile(promotoraId: string): Promise<StaffProfileLookupResult | null> {
      const { data, error } = await client
        .from('staff')
        .select('id, name, role, email, status')
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

    async upsertSlotEvidence(params): Promise<AsistenciaEvidenciaDbRow> {
      const { data, error } = await client
        .from('asistencia_evidencias')
        .upsert(
          {
            asistencia_id: params.asistenciaId,
            slot_foto: params.slotFoto,
            storage_bucket: params.storageBucket,
            storage_path: params.storagePath,
            mime_type: params.mimeType,
            tamano_bytes: params.sizeBytes,
            sha256_hex: params.sha256Hex,
            ancho_px: params.anchoPx,
            alto_px: params.altoPx,
            pdv_nombre: params.pdvNombre,
            lat: params.lat,
            lng: params.lng,
            gps_accuracy: params.gpsAccuracy,
            capturado_en_servidor: params.capturadoEnServidorIso,
            cargado_por_uid: params.cargadoPorUid,
            cargado_por_rol: params.cargadoPorRol,
          },
          { onConflict: 'asistencia_id,slot_foto' }
        )
        .select('*')
        .single();

      if (error || !data) {
        throw new Error(`DB_UPSERT_EVIDENCE_ERROR: ${error?.message || 'sin respuesta'}`);
      }

      return data as AsistenciaEvidenciaDbRow;
    },

    async uploadPrivateObject(params): Promise<void> {
      const { error } = await client.storage.from(params.bucket).upload(params.path, params.buffer, {
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
      await client.storage.from(bucket).remove(cleanPaths);
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
        .select('id, promotora_id')
        .in('id', jornadaIds);

      if (jorError || !Array.isArray(jornadas)) {
        return [];
      }

      const ownerByJornadaId = new Map<string, string>();
      for (const j of jornadas) {
        ownerByJornadaId.set(String(j.id), String(j.promotora_id));
      }

      const joined: Array<{ evidencia: AsistenciaEvidenciaDbRow; promotoraId: string }> = [];
      for (const rawEv of evidences) {
        const ev = rawEv as AsistenciaEvidenciaDbRow;
        const ownerId = ownerByJornadaId.get(ev.asistencia_id);
        if (ownerId) {
          joined.push({ evidencia: ev, promotoraId: ownerId });
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
}

export function createAttendanceEvidencesHandlers(deps?: AttendanceHandlersDependencies) {
  const getNow = deps?.now ?? (() => new Date());
  const resolveGateway = deps?.resolveGateway ?? createSupabaseAttendanceGateway;

  const handleUploadEvidence = async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({
        error: 'Autenticación requerida.',
        code: 'AUTH_REQUIRED',
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

    const gateway = resolveGateway(authUser);
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

      if (!jornada) {
        const staffProfile = await gateway.lookupStaffProfile(meta.promotoraId);
        if (!staffProfile) {
          res.status(404).json({
            error: 'La promotora indicada no existe en el padrón oficial.',
            code: 'PROMOTORA_NOT_FOUND',
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

      // 7. Generar ruta determinística en servidor (ignora cualquier nombre de archivo del usuario)
      const storagePath = buildDeterministicAttendanceStoragePath({
        fechaJornada: jornada.fecha_jornada,
        promotoraId: jornada.promotora_id,
        slotFoto: meta.slotFoto,
        extension: verifiedImage.extension,
      });

      // 8. Subir binario verificado al bucket privado
      await gateway.uploadPrivateObject({
        bucket: bucketId,
        path: storagePath,
        buffer: req.body as Buffer,
        mimeType: verifiedImage.mimeType,
      });

      // 9. Upsert transaccional por (asistencia_id, slot_foto) con rollback compensatorio si falla BD
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
          capturadoEnServidorIso: serverNowIso,
          cargadoPorUid: authUser.id,
          cargadoPorRol: normalizeActorDbRole(authUser.appRole),
        });
      } catch (dbErr) {
        await gateway.deletePrivateObjects(bucketId, [storagePath]).catch(() => undefined);
        throw dbErr;
      }

      // 10. Limpieza de archivo huérfano en Storage cuando se reemplaza una ranura ocupada
      if (
        previousEvidence &&
        previousEvidence.storage_path &&
        previousEvidence.storage_path !== storagePath
      ) {
        await gateway
          .deletePrivateObjects(bucketId, [previousEvidence.storage_path])
          .catch(() => undefined);
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

    const parsed = BatchSignedUrlsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      res.status(400).json({
        error: firstIssue?.message || 'Solicitud de URLs firmadas inválida.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const gateway = resolveGateway(authUser);
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

      // Verificación estricta de propiedad por fila (anti-IDOR)
      if (!authUser.isCoordinatorOrAdmin) {
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
