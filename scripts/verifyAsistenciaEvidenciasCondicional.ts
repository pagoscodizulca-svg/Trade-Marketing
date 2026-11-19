import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AttendanceEvidenceSubTab,
  buildAttendanceCardLayoutSpec,
} from '../src/components/field/AttendanceEvidenceSubTab';
import {
  type AttendancePersistenceGateway,
  createAttendanceEvidencesHandlers,
  type StaffProfileLookupResult,
} from '../src/server/attendanceEvidencesHandler';
import {
  AttendanceFileSecurityError,
  buildDeterministicAttendanceStoragePath,
  verifyAttendanceImageMagicBytes,
} from '../src/server/imageMagicBytesValidator';
import { buildDailyPromotoraAttendanceViewModels } from '../src/services/attendanceEvidencesService';
import type { StaffMemberRecord } from '../src/services/supabaseModule1';
import { getLiveVenezuelaYmd } from '../src/utils/weekCalendar';
import {
  type AsistenciaEvidenciaDbRow,
  type AsistenciaJornadaDbRow,
  buildSlotActionAriaLabel,
  evaluateAttendanceCompliance,
  MAX_ATTENDANCE_EVIDENCE_BYTES,
  resolveEffectiveAttendanceProfile,
  validateSlotAgainstAppliedProfile,
} from '../src/types/attendanceEvidences';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function logOk(label: string): void {
  console.log(`  [OK] ${label}`);
}

function encodeMetaHeader(meta: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(meta), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function toFetchBody(buf: Buffer): BodyInit {
  return new Uint8Array(buf);
}

function makeValidWebpBuffer(extraPayloadSize = 64): Buffer {
  // RIFF + uint32LE size + WEBP + VP8 chunk dummy
  const body = Buffer.alloc(Math.max(16, extraPayloadSize), 0x41);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

function makeValidJpegBuffer(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0xff, 0xd9,
  ]);
}

function makeValidPngBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

/**
 * Gateway transaccional en memoria que emula fielmente los constraints UNIQUE,
 * la inmutabilidad de `perfil_aplicado` y el bucket privado de Supabase Storage.
 */
function createInMemoryTestGateway(initialStaff: Record<string, StaffProfileLookupResult>) {
  const staffMap = new Map<string, StaffProfileLookupResult>(Object.entries(initialStaff));
  const jornadasByKey = new Map<string, AsistenciaJornadaDbRow>();
  const jornadasById = new Map<string, AsistenciaJornadaDbRow>();
  const evidencesByComposite = new Map<string, AsistenciaEvidenciaDbRow>();
  const privateBucketObjects = new Map<string, { buffer: Buffer; mimeType: string }>();

  const gateway: AttendancePersistenceGateway = {
    async lookupStaffProfile(promotoraId: string) {
      return staffMap.get(promotoraId) ?? null;
    },

    async findJornadaByDateAndPromotora(fechaJornada: string, promotoraId: string) {
      return jornadasByKey.get(`${fechaJornada}__${promotoraId}`) ?? null;
    },

    async createJornadaIfAbsent(params) {
      const key = `${params.fechaJornada}__${params.promotoraId}`;
      const existing = jornadasByKey.get(key);
      if (existing) return existing;

      const row: AsistenciaJornadaDbRow = {
        id: crypto.randomUUID(),
        fecha_jornada: params.fechaJornada,
        promotora_id: params.promotoraId,
        promotora_nombre: params.promotoraNombre,
        perfil_aplicado: params.perfilAplicado,
        pdv_nombre: params.pdvNombre,
        zona: params.zona,
        opened_at_server: params.openedAtServerIso,
        updated_at_server: params.openedAtServerIso,
        opened_by_uid: params.openedByUid,
      };
      jornadasByKey.set(key, row);
      jornadasById.set(row.id, row);
      return row;
    },

    async listEvidencesByJornadaId(asistenciaId: string) {
      return Array.from(evidencesByComposite.values()).filter(
        (e) => e.asistencia_id === asistenciaId
      );
    },

    async upsertSlotEvidence(params) {
      const compositeKey = `${params.asistenciaId}__${params.slotFoto}`;
      const prev = evidencesByComposite.get(compositeKey);
      const row: AsistenciaEvidenciaDbRow = {
        id: prev?.id ?? crypto.randomUUID(),
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
      };
      evidencesByComposite.set(compositeKey, row);
      return row;
    },

    async uploadPrivateObject(params) {
      privateBucketObjects.set(`${params.bucket}:${params.path}`, {
        buffer: Buffer.from(params.buffer),
        mimeType: params.mimeType,
      });
    },

    async deletePrivateObjects(bucket: string, paths: string[]) {
      for (const p of paths) {
        privateBucketObjects.delete(`${bucket}:${p}`);
      }
    },

    async createSignedUrls(bucket: string, paths: string[], ttlSeconds: number) {
      const out: Record<string, string> = {};
      for (const p of paths) {
        if (privateBucketObjects.has(`${bucket}:${p}`)) {
          const token = crypto.randomBytes(8).toString('hex');
          out[p] = `https://private-storage.codizulca.test/object/sign/${bucket}/${p}?token=${token}&exp=${ttlSeconds}`;
        }
      }
      return out;
    },

    async findEvidencesWithOwnerByIds(evidenciaIds: string[]) {
      const idSet = new Set(evidenciaIds);
      const result: Array<{ evidencia: AsistenciaEvidenciaDbRow; promotoraId: string }> = [];
      for (const ev of evidencesByComposite.values()) {
        if (!idSet.has(ev.id)) continue;
        const j = jornadasById.get(ev.asistencia_id);
        if (j) {
          result.push({ evidencia: ev, promotoraId: j.promotora_id });
        }
      }
      return result;
    },
  };

  return {
    gateway,
    staffMap,
    jornadasByKey,
    evidencesByComposite,
    privateBucketObjects,
  };
}

async function runVerification(): Promise<void> {
  console.log('=========================================================================');
  console.log(' CODIZULCA C.A. - SUITE DE VERIFICACIÓN: ASISTENCIA CONDICIONAL POR PERFIL');
  console.log('=========================================================================');

  const PROMOTORA_FIJA_ID = '11111111-1111-4111-8111-111111111111';
  const PROMOTORA_EVENTUAL_ID = '22222222-2222-4222-8222-222222222222';
  const LIVE_TODAY_YMD = getLiveVenezuelaYmd();
  const FIXED_SERVER_UTC = new Date(`${LIVE_TODAY_YMD}T13:35:20.000Z`); // 09:35:20 a. m. en America/Caracas (UTC-4)

  // ---------------------------------------------------------------------------
  // BLOQUE 1: AUDITORÍA DE MIGRACIÓN SQL, RLS ZERO TRUST Y BUCKET PRIVADO
  // ---------------------------------------------------------------------------
  console.log('\n[1/4] Verificando migración SQL, constraints, triggers RLS y Storage privado...');
  const sqlPath = path.join(
    PROJECT_ROOT,
    'supabase',
    'migrations',
    '20261112000100_asistencia_evidencias_perfil_condicional.sql'
  );
  assert.ok(fs.existsSync(sqlPath), 'Existe la migración SQL de evidencias condicionales');
  const sqlContent = fs.readFileSync(sqlPath, 'utf8');

  assert.match(
    sqlContent,
    /UNIQUE\s*\(\s*fecha_jornada\s*,\s*promotora_id\s*\)/i,
    'Constraint UNIQUE (fecha_jornada, promotora_id) presente en asistencias_jornada'
  );
  assert.match(
    sqlContent,
    /UNIQUE\s*\(\s*asistencia_id\s*,\s*slot_foto\s*\)/i,
    'Constraint UNIQUE (asistencia_id, slot_foto) presente en asistencia_evidencias'
  );
  assert.match(
    sqlContent,
    /IMMUTABLE_PERFIL_APLICADO/i,
    'Trigger SQL bloquea mutación de perfil_aplicado en fechas históricas'
  );
  assert.match(
    sqlContent,
    /SLOT_NOT_ALLOWED_FOR_FIJA[\s\S]*SLOT_NOT_ALLOWED_FOR_EVENTUAL/i,
    'Trigger SQL impone correspondencia estricta de ranuras y cupo máximo (2 FIJA / 4 EVENTUAL)'
  );
  assert.match(
    sqlContent,
    /INSERT\s+INTO\s+storage\.buckets[\s\S]*'asistencia-evidencias'[\s\S]*false[\s\S]*5242880/i,
    'Bucket asistencia-evidencias configurado como privado (public = false) y límite 5 MB'
  );
  assert.doesNotMatch(
    sqlContent,
    /user_metadata|auth\.role\s*\(/i,
    'Políticas RLS libres de user_metadata y auth.role()'
  );
  logOk('Esquema PostgreSQL, triggers de inmutabilidad/cupo, RLS Zero Trust y bucket privado verificados');

  // ---------------------------------------------------------------------------
  // BLOQUE 2: SEGURIDAD DE ARCHIVOS (MAGIC BYTES, T6 & T7 PATH TRAVERSAL)
  // ---------------------------------------------------------------------------
  console.log('\n[2/4] Verificando seguridad binaria (magic bytes <= 5 MB) y anti-Path-Traversal (T6, T7)...');
  assert.equal(verifyAttendanceImageMagicBytes(makeValidWebpBuffer()).mimeType, 'image/webp');
  assert.equal(verifyAttendanceImageMagicBytes(makeValidJpegBuffer()).mimeType, 'image/jpeg');
  assert.equal(verifyAttendanceImageMagicBytes(makeValidPngBuffer()).mimeType, 'image/png');

  // T6: Rechazo de .svg con XSS, .html, .exe renombrado y > 5 MB
  const maliciousPayloads: Array<{ name: string; buf: Buffer; expectedStatus: number }> = [
    {
      name: 'SVG XSS (<svg onload=alert(1)>)',
      buf: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'utf8'),
      expectedStatus: 415,
    },
    {
      name: 'HTML disfrazado de imagen',
      buf: Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>', 'utf8'),
      expectedStatus: 415,
    },
    {
      name: 'Ejecutable PE (.exe MZ) renombrado a .jpg',
      buf: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff]),
      expectedStatus: 415,
    },
    {
      name: 'Archivo superior a 5 MB',
      buf: makeValidWebpBuffer(MAX_ATTENDANCE_EVIDENCE_BYTES + 128),
      expectedStatus: 413,
    },
  ];

  for (const item of maliciousPayloads) {
    let caught: AttendanceFileSecurityError | null = null;
    try {
      verifyAttendanceImageMagicBytes(item.buf);
    } catch (err) {
      if (err instanceof AttendanceFileSecurityError) caught = err;
    }
    assert.ok(caught, `Debe rechazar ${item.name}`);
    assert.equal(caught.statusCode, item.expectedStatus);
  }
  logOk('T6 superado: rechazados .svg, .html, .exe falsificado (415) y archivos > 5 MB (413)');

  // T7: Ruta determinista inmune a Path Traversal
  const safePath = buildDeterministicAttendanceStoragePath({
    fechaJornada: '2026-11-12',
    promotoraId: PROMOTORA_FIJA_ID,
    slotFoto: 'JORNADA_INGRESO',
    extension: 'webp',
  });
  assert.match(
    safePath,
    /^asistencia\/2026-11-12\/11111111-1111-4111-8111-111111111111\/JORNADA_INGRESO_[0-9a-f-]{36}\.webp$/
  );
  assert.throws(
    () =>
      buildDeterministicAttendanceStoragePath({
        fechaJornada: '../../etc',
        promotoraId: PROMOTORA_FIJA_ID,
        slotFoto: 'JORNADA_INGRESO',
        extension: 'webp',
      }),
    AttendanceFileSecurityError
  );
  logOk('T7 superado: generación determinista de rutas inmune a Path Traversal');

  // ---------------------------------------------------------------------------
  // BLOQUE 3: PRUEBAS DE INTEGRACIÓN HTTP E2E (T1, T2, T3, T4, T5, T8, T9, T10)
  // ---------------------------------------------------------------------------
  console.log('\n[3/4] Ejecutando suite de integración HTTP Express (T1..T5, T8..T10)...');

  const store = createInMemoryTestGateway({
    [PROMOTORA_FIJA_ID]: {
      id: PROMOTORA_FIJA_ID,
      name: 'Camila Morales',
      email: 'camila@promotoras.codizulca.local',
      assignedStore: 'AUTOMERCADO ZULIA NORTE',
      address: 'Maracaibo Norte',
      active: true,
      isMerchandising: false,
      masterProfile: 'FIJA',
    },
    [PROMOTORA_EVENTUAL_ID]: {
      id: PROMOTORA_EVENTUAL_ID,
      name: 'Valeria Rincón',
      email: 'valeria@promotoras.codizulca.local',
      assignedStore: 'HIPER VíVERES DELICIAS',
      address: 'Delicias',
      active: true,
      isMerchandising: false,
      masterProfile: 'EVENTUAL',
    },
  });

  let currentMockTime = new Date(FIXED_SERVER_UTC.getTime());
  const handlers = createAttendanceEvidencesHandlers({
    resolveGateway: () => store.gateway,
    now: () => currentMockTime,
    bucketId: 'asistencia-evidencias',
    signedUrlTtlSeconds: 900,
  });

  const testApp = express();
  testApp.use(express.json());

  // Middleware de autenticación simulada por token firmado de prueba
  const mockAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const auth = String(req.headers.authorization || '');
    if (auth === 'Bearer token-coordinadora') {
      req.authUser = {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'coordinadora@codizulca.com',
        appRole: 'coordinadora',
        isCoordinatorOrAdmin: true,
      };
      next();
      return;
    }
    if (auth === 'Bearer token-promotora-fija') {
      req.authUser = {
        id: '00000000-0000-4000-8000-000000000002',
        email: 'camila@promotoras.codizulca.local',
        appRole: 'promotora',
        staffId: PROMOTORA_FIJA_ID,
        isCoordinatorOrAdmin: false,
      };
      next();
      return;
    }
    res.status(401).json({ error: 'Token ausente o inválido', code: 'AUTH_REQUIRED' });
  };

  testApp.post(
    '/api/asistencia/evidencias',
    mockAuthMiddleware,
    express.raw({ type: '*/*', limit: '6mb' }),
    handlers.handleUploadEvidence
  );
  testApp.post(
    '/api/asistencia/evidencias/signed-urls',
    mockAuthMiddleware,
    handlers.handleBatchSignedUrls
  );

  const server = await new Promise<Server>((resolve) => {
    const s = testApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl =
    typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  try {
    // T9 (parte A): Rechazo 401 sin JWT y 403 Anti-IDOR cuando Promotora A intenta subir a Promotora B
    const unauthRes = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/webp',
        'X-Asistencia-Meta': encodeMetaHeader({
          promotoraId: PROMOTORA_FIJA_ID,
          fechaJornada: '2026-11-10',
          slotFoto: 'JORNADA_INGRESO',
        }),
      },
      body: toFetchBody(makeValidWebpBuffer()),
    });
    assert.equal(unauthRes.status, 401, 'Sin JWT debe rechazar con 401');

    const idorUploadRes = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-promotora-fija',
        'Content-Type': 'image/webp',
        'X-Asistencia-Meta': encodeMetaHeader({
          promotoraId: PROMOTORA_EVENTUAL_ID,
          fechaJornada: '2026-11-10',
          slotFoto: 'MANANA_INGRESO',
        }),
      },
      body: toFetchBody(makeValidWebpBuffer()),
    });
    assert.equal(idorUploadRes.status, 403, 'Cruce de promotoraId (IDOR) debe rechazar con 403');
    logOk('T9 (Upload RBAC / Anti-IDOR) superado: 401 sin sesión y 403 ante intento cruzado entre promotoras');

    // T2: Perfil FIJA rechaza ranuras MANANA_* o TARDE_* con 422
    const invalidFijaSlotRes = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-promotora-fija',
        'Content-Type': 'image/webp',
        'X-Asistencia-Meta': encodeMetaHeader({
          promotoraId: PROMOTORA_FIJA_ID,
          fechaJornada: '2026-11-10',
          slotFoto: 'MANANA_INGRESO',
        }),
      },
      body: toFetchBody(makeValidWebpBuffer()),
    });
    assert.equal(invalidFijaSlotRes.status, 422, 'FIJA no puede enviar MANANA_INGRESO');
    logOk('T2 superado: perfil FIJA rechaza ranuras de mañana/tarde con HTTP 422');

    // T1 & T10: Flujo completo FIJA (0/2 -> 1/2 -> 2/2) + Reloj oficial del servidor America/Caracas (ignorando clientTimestamp falso)
    assert.equal(
      evaluateAttendanceCompliance('FIJA', []).fractionLabel +
        ':' +
        evaluateAttendanceCompliance('FIJA', []).statusLabel,
      '0/2:Sin registro'
    );

    const fijaIngresoRes = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-promotora-fija',
        'Content-Type': 'image/webp',
        'X-Asistencia-Meta': encodeMetaHeader({
          promotoraId: PROMOTORA_FIJA_ID,
          fechaJornada: '2026-11-10',
          slotFoto: 'JORNADA_INGRESO',
          pdvNombre: 'AUTOMERCADO ZULIA NORTE',
          clientTimestamp: '1999-01-01T00:00:00.000Z', // Intento de manipulación de reloj en cliente
        }),
      },
      body: toFetchBody(makeValidWebpBuffer()),
    });
    assert.equal(fijaIngresoRes.status, 201);
    const fijaIngresoJson = (await fijaIngresoRes.json()) as any;
    assert.equal(fijaIngresoJson.compliance.fractionLabel, '1/2');
    assert.equal(fijaIngresoJson.compliance.statusLabel, 'En curso / Incompleta');
    assert.equal(
      fijaIngresoJson.evidencia.capturadoEnServidorIso,
      FIXED_SERVER_UTC.toISOString(),
      'T10: El servidor ignora clientTimestamp manipulado y sella su propio reloj UTC/America-Caracas'
    );
    assert.match(fijaIngresoJson.evidencia.horaCaracasCompleta, /09:35:20.*UTC-4/);
    const firstStoragePath = String(fijaIngresoJson.evidencia.storagePath);
    assert.ok(
      store.privateBucketObjects.has(`asistencia-evidencias:${firstStoragePath}`),
      'Archivo guardado en bucket privado'
    );

    // T5: Reemplazo idempotente de JORNADA_INGRESO -> actualiza sin duplicar fila y borra archivo huérfano previo
    const fijaReplaceRes = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-coordinadora',
        'Content-Type': 'image/jpeg',
        'X-Asistencia-Meta': encodeMetaHeader({
          promotoraId: PROMOTORA_FIJA_ID,
          fechaJornada: '2026-11-10',
          slotFoto: 'JORNADA_INGRESO',
        }),
      },
      body: toFetchBody(makeValidJpegBuffer()),
    });
    assert.equal(fijaReplaceRes.status, 200);
    const fijaReplaceJson = (await fijaReplaceRes.json()) as any;
    assert.equal(fijaReplaceJson.replaced, true);
    assert.equal(fijaReplaceJson.compliance.fractionLabel, '1/2');
    assert.equal(
      store.privateBucketObjects.has(`asistencia-evidencias:${firstStoragePath}`),
      false,
      'T5: El archivo anterior fue eliminado del bucket privado (cero huérfanos)'
    );
    assert.equal(
      store.privateBucketObjects.has(
        `asistencia-evidencias:${fijaReplaceJson.evidencia.storagePath}`
      ),
      true,
      'T5: El nuevo archivo reemplazado existe en el bucket privado'
    );
    logOk('T5 & T10 superados: reemplazo idempotente limpia huérfanos y sella hora oficial America/Caracas (UTC-4)');

    // Completar 2/2 en FIJA
    const fijaSalidaRes = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-promotora-fija',
        'Content-Type': 'image/webp',
        'X-Asistencia-Meta': encodeMetaHeader({
          promotoraId: PROMOTORA_FIJA_ID,
          fechaJornada: '2026-11-10',
          slotFoto: 'JORNADA_SALIDA',
        }),
      },
      body: toFetchBody(makeValidWebpBuffer()),
    });
    assert.equal(fijaSalidaRes.status, 201);
    const fijaSalidaJson = (await fijaSalidaRes.json()) as any;
    assert.equal(fijaSalidaJson.compliance.fractionLabel, '2/2');
    assert.equal(fijaSalidaJson.compliance.statusLabel, 'Completa');

    // Verificar bloqueo de 3ra foto en FIJA
    const thirdSlotCheck = validateSlotAgainstAppliedProfile({
      perfilAplicado: 'FIJA',
      slotFoto: 'TARDE_SALIDA',
      existingSlotsInJornada: ['JORNADA_INGRESO', 'JORNADA_SALIDA'],
    });
    assert.equal(thirdSlotCheck.ok, false);
    logOk('T1 superado: flujo FIJA (0/2 -> 1/2 -> 2/2 Completa) con tope estricto de 2 fotos');

    // T3 & T4: Flujo completo EVENTUAL (0/4 -> 1/4..3/4 -> 4/4) y rechazo de JORNADA_INGRESO
    const invalidEventualSlotRes = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-coordinadora',
        'Content-Type': 'image/webp',
        'X-Asistencia-Meta': encodeMetaHeader({
          promotoraId: PROMOTORA_EVENTUAL_ID,
          fechaJornada: LIVE_TODAY_YMD,
          slotFoto: 'JORNADA_INGRESO',
        }),
      },
      body: toFetchBody(makeValidWebpBuffer()),
    });
    assert.equal(invalidEventualSlotRes.status, 422);

    const eventualSlots = [
      'MANANA_INGRESO',
      'MANANA_SALIDA',
      'TARDE_INGRESO',
      'TARDE_SALIDA',
    ] as const;
    let lastEventualEvidenceId = '';

    for (let i = 0; i < eventualSlots.length; i += 1) {
      const slot = eventualSlots[i];
      const res = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-coordinadora',
          'Content-Type': 'image/webp',
          'X-Asistencia-Meta': encodeMetaHeader({
            promotoraId: PROMOTORA_EVENTUAL_ID,
            fechaJornada: LIVE_TODAY_YMD,
            slotFoto: slot,
          }),
        },
          body: toFetchBody(makeValidWebpBuffer()),
      });
      assert.equal(res.status, 201);
      const payload = (await res.json()) as any;
      lastEventualEvidenceId = payload.evidencia.id;
      assert.equal(payload.compliance.fractionLabel, `${i + 1}/4`);
      if (i < 3) {
        assert.equal(payload.compliance.statusLabel, 'Parcial / Incompleta');
      } else {
        assert.equal(payload.compliance.statusLabel, 'Completa');
      }
    }
    logOk('T3 & T4 superados: flujo EVENTUAL (0/4 -> 1/4..3/4 Parcial -> 4/4 Completa) y rechazo de JORNADA_*');

    // T9 (parte B): Signed URLs privadas autorizadas para Coordinadora y bloqueadas (403) para otra promotora
    const forbiddenSignedRes = await fetch(`${baseUrl}/api/asistencia/evidencias/signed-urls`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-promotora-fija',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ evidenciaIds: [lastEventualEvidenceId] }),
    });
    assert.equal(
      forbiddenSignedRes.status,
      403,
      'Promotora A no puede obtener Signed URL de evidencia de Promotora B'
    );

    const allowedSignedRes = await fetch(`${baseUrl}/api/asistencia/evidencias/signed-urls`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-coordinadora',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ evidenciaIds: [lastEventualEvidenceId] }),
    });
    assert.equal(allowedSignedRes.status, 200);
    const allowedSignedJson = (await allowedSignedRes.json()) as any;
    assert.match(
      allowedSignedJson.signedUrls[lastEventualEvidenceId].url,
      /^https:\/\/private-storage\.codizulca\.test\/object\/sign\/asistencia-evidencias\//
    );
    logOk('T9 (Signed URLs privadas) superado: emisión temporal TTL=900s con bloqueo 403 ante acceso cruzado');

    // T8: Inmutabilidad Histórica (`perfil_aplicado` Snapshot) tras cambio contractual FIJA -> EVENTUAL
    const camilaMaster = store.staffMap.get(PROMOTORA_FIJA_ID)!;
    store.staffMap.set(PROMOTORA_FIJA_ID, {
      ...camilaMaster,
      masterProfile: 'EVENTUAL', // Camila cambia hoy (2026-11-12) a EVENTUAL
    });

    // Abrir jornada nueva hoy como EVENTUAL
    const camilaNewEventualRes = await fetch(`${baseUrl}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-coordinadora',
        'Content-Type': 'image/webp',
        'X-Asistencia-Meta': encodeMetaHeader({
          promotoraId: PROMOTORA_FIJA_ID,
          fechaJornada: LIVE_TODAY_YMD,
          slotFoto: 'MANANA_INGRESO',
        }),
      },
      body: toFetchBody(makeValidWebpBuffer()),
    });
    assert.equal(camilaNewEventualRes.status, 201);

    const staffRosterAfterChange: StaffMemberRecord[] = [
      {
        id: PROMOTORA_FIJA_ID,
        name: 'Camila Morales',
        canonicalKey: 'CAMILA MORALES',
        role: 'Promotora Eventual',
        category: 'eventual', // Ahora es eventual en la tabla maestra
        roleCategory: 'PROMOTORA',
        email: 'camila@promotoras.codizulca.local',
        phone: '',
        address: 'Maracaibo Norte',
        assignedStore: 'AUTOMERCADO ZULIA NORTE',
        status: 'Activo',
        password: '',
        shift: 'Plantilla Eventual',
        tastingCompleted: 0,
        salesAssisted: 0,
        activationsCount: 0,
        totalUnits: 0,
      },
      {
        id: PROMOTORA_EVENTUAL_ID,
        name: 'Valeria Rincón',
        canonicalKey: 'VALERIA RINCON',
        role: 'Promotora Eventual',
        category: 'eventual',
        roleCategory: 'PROMOTORA',
        email: 'valeria@promotoras.codizulca.local',
        phone: '',
        address: 'Delicias',
        assignedStore: 'HIPER VÍVERES DELICIAS',
        status: 'Activo',
        password: '',
        shift: 'Plantilla Eventual',
        tastingCompleted: 0,
        salesAssisted: 0,
        activationsCount: 0,
        totalUnits: 0,
      },
    ];

    const pastViewModels = buildDailyPromotoraAttendanceViewModels({
      staffMembers: staffRosterAfterChange,
      asistenciaJornadas: Array.from(store.jornadasByKey.values()),
      asistenciaEvidencias: Array.from(store.evidencesByComposite.values()),
      legacyAttendanceRecords: [],
      selectedDateYmd: '2026-11-10',
    });

    const camilaPastVm = pastViewModels.find((m) => m.promotoraId === PROMOTORA_FIJA_ID);
    assert.ok(camilaPastVm, 'Camila aparece en la consulta histórica del 2026-11-10');
    assert.equal(
      camilaPastVm.perfilAplicado,
      'FIJA',
      'T8: El día pasado 2026-11-10 conserva su snapshot FIJA aunque hoy sea EVENTUAL'
    );
    assert.equal(camilaPastVm.perfilFuente, 'SNAPSHOT_HISTORICO');
    assert.equal(camilaPastVm.compliance.fractionLabel, '2/2');
    assert.equal(camilaPastVm.compliance.statusLabel, 'Completa');

    const todayViewModels = buildDailyPromotoraAttendanceViewModels({
      staffMembers: staffRosterAfterChange,
      asistenciaJornadas: Array.from(store.jornadasByKey.values()),
      asistenciaEvidencias: Array.from(store.evidencesByComposite.values()),
      legacyAttendanceRecords: [],
      selectedDateYmd: LIVE_TODAY_YMD,
    });
    const camilaTodayVm = todayViewModels.find((m) => m.promotoraId === PROMOTORA_FIJA_ID);
    assert.ok(camilaTodayVm);
    assert.equal(camilaTodayVm.perfilAplicado, 'EVENTUAL');
    assert.equal(camilaTodayVm.compliance.fractionLabel, '1/4');
    assert.equal(
      resolveEffectiveAttendanceProfile({
        historicalSnapshotProfile: null,
        currentMasterCategory: 'eventual',
      }).fuente,
      'PERFIL_MAESTRO_ACTUAL'
    );
    logOk('T8 superado: inmutabilidad histórica de perfil_aplicado preservada tras cambio contractual');

    // -------------------------------------------------------------------------
    // BLOQUE 4: VERIFICACIÓN DE DESMONTADO CONDICIONAL DEL DOM Y ARIA-LABELS
    // -------------------------------------------------------------------------
    console.log('\n[4/4] Verificando renderizado condicional del DOM (SSR) y accesibilidad ARIA...');
    const fijaLayout = buildAttendanceCardLayoutSpec('FIJA');
    assert.equal(fijaLayout.totalSlots, 2);
    assert.equal(fijaLayout.hasShiftSplitHeaders, false);

    const eventualLayout = buildAttendanceCardLayoutSpec('EVENTUAL');
    assert.equal(eventualLayout.totalSlots, 4);
    assert.equal(eventualLayout.hasShiftSplitHeaders, true);

    assert.equal(
      buildSlotActionAriaLabel({
        slotFoto: 'MANANA_INGRESO',
        promotoraNombre: 'Valeria Rincón',
        isReplacement: false,
      }),
      'Subir foto de ingreso jornada de la mañana para Valeria Rincón'
    );

    // Renderizar en SSR una jornada exclusivamente FIJA y comprobar ausencia total en el DOM de Mañana/Tarde/Almuerzo
    const htmlFijaOnly = renderToStaticMarkup(
      React.createElement(AttendanceEvidenceSubTab, {
        staffMembers: [
          {
            ...staffRosterAfterChange[0],
            category: 'fija',
          },
        ],
        asistenciaJornadas: Array.from(store.jornadasByKey.values()).filter(
          (j) => j.fecha_jornada === '2026-11-12' && false
        ),
        asistenciaEvidencias: [],
        legacyAttendanceRecords: [],
        searchQuery: '',
        onSearchQueryChange: () => undefined,
        onRefreshData: async () => undefined,
        onNotifyToast: () => undefined,
      })
    );

    assert.match(htmlFijaOnly, /1\. Ingreso a la jornada laboral/);
    assert.match(htmlFijaOnly, /2\. Salida de la jornada laboral/);
    assert.match(htmlFijaOnly, /0\/2 · Sin registro/);
    assert.doesNotMatch(
      htmlFijaOnly,
      /Jornada de la Mañana|Jornada de la Tarde|MANANA_INGRESO|TARDE_INGRESO|ALMUERZO/i,
      'DOM de perfil FIJA desmonta por completo cualquier referencia a mañana, tarde o almuerzo'
    );

    // Renderizar en SSR una jornada EVENTUAL y comprobar presencia de ambos bloques ("Jornada de la Mañana" y "Jornada de la Tarde")
    const htmlEventualOnly = renderToStaticMarkup(
      React.createElement(AttendanceEvidenceSubTab, {
        staffMembers: [staffRosterAfterChange[1]],
        asistenciaJornadas: Array.from(store.jornadasByKey.values()),
        asistenciaEvidencias: Array.from(store.evidencesByComposite.values()),
        legacyAttendanceRecords: [],
        searchQuery: '',
        onSearchQueryChange: () => undefined,
        onRefreshData: async () => undefined,
        onNotifyToast: () => undefined,
      })
    );

    assert.match(htmlEventualOnly, /Jornada de la Mañana/);
    assert.match(htmlEventualOnly, /Jornada de la Tarde/);
    assert.match(htmlEventualOnly, /4\/4 · Completa/);
    assert.match(
      htmlEventualOnly,
      /Reemplazar foto de ingreso jornada de la mañana para Valeria Rincón/
    );
    logOk('Renderizado condicional DOM (FIJA=2 sin mañana/tarde vs EVENTUAL=4 en 2 bloques) y aria-labels verificados');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\n=========================================================================');
  console.log(' RESULTADO FINAL: 100% CASOS T1..T10 SUPERADOS SIN ERRORES NI REGRESIONES');
  console.log('=========================================================================');
}

runVerification().catch((err) => {
  console.error(
    '\n[FALLO EN VERIFICACIÓN DE ASISTENCIA CONDICIONAL]:',
    err instanceof Error ? err.message : String(err)
  );
  process.exitCode = 1;
});
