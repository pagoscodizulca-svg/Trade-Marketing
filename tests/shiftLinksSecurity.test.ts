import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import type { Request, Response } from 'express';
import {
  buildSignedShiftUrl,
  createShiftLinksHandlers,
  inspectShiftOfflinePhotoBytes,
  sha256Hex,
  signShiftToken,
  verifyShiftTokenSignature,
  type ShiftLinksGateway,
  type StoredShiftSessionSummary,
  type VerifiedShiftSessionContext,
} from '../src/server/shiftLinksHandler';
import type { AuthenticatedServerUser, OperativeSucursal } from '../src/server/supabaseAdminAuth';

const TEST_SECRET = 'codizulca-v190-shift-link-secret-key-min-32-bytes-0123456789';

function createMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  } as unknown as Response;
  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body as Record<string, unknown>,
    getHeaders: () => headers,
  };
}

function createMockReq(params: {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  authUser?: AuthenticatedServerUser;
}): Request {
  return {
    body: params.body ?? {},
    headers: { host: 'trade-marketing-qi6j.onrender.com', ...(params.headers ?? {}) },
    query: params.query ?? {},
    protocol: 'https',
    authUser: params.authUser,
  } as unknown as Request;
}

function createInMemoryGateway(): {
  gateway: ShiftLinksGateway;
  sessionsById: Map<string, StoredShiftSessionSummary & { token_hash: string }>;
  appliedMutations: Set<string>;
} {
  const sessionsById = new Map<string, StoredShiftSessionSummary & { token_hash: string }>();
  const sessionsByHash = new Map<string, StoredShiftSessionSummary & { token_hash: string }>();
  const appliedMutations = new Set<string>();

  const regionIds: Record<OperativeSucursal, string> = {
    ZULIA: '11111111-1111-4111-8111-111111111111',
    VALENCIA: '22222222-2222-4222-8222-222222222222',
    CENTRO: '33333333-3333-4333-8333-333333333333',
    ORIENTE: '44444444-4444-4444-8444-444444444444',
    CAPITAL: '55555555-5555-4555-8555-555555555555',
  };

  const toPublic = (
    row: StoredShiftSessionSummary & { token_hash: string }
  ): StoredShiftSessionSummary => {
    const { token_hash: _omit, ...rest } = row;
    void _omit;
    return rest;
  };

  const toVerified = (
    row: StoredShiftSessionSummary & { token_hash: string }
  ): VerifiedShiftSessionContext => ({
    id: row.id,
    rol: row.rol,
    personal_id: row.personal_id,
    personal_nombre: row.personal_nombre,
    region_id: row.region_id,
    region_nombre: row.sucursal,
    sucursal: row.sucursal,
    ruta_codigo: row.ruta_codigo,
    duracion_horas: row.duracion_horas,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
  });

  const gateway: ShiftLinksGateway = {
    async resolveRegionBySucursal(sucursal) {
      return { id: regionIds[sucursal], codigo: sucursal, nombre: sucursal };
    },
    async resolvePersonalInSucursal(_rol, personalId, _sucursal) {
      return { id: personalId, name: 'Ana Promotora Zulia' };
    },
    async insertSession(record) {
      const full = {
        ...record,
        revoked_at: null,
        last_used_at: null,
        created_at: new Date().toISOString(),
      };
      sessionsById.set(record.id, full);
      sessionsByHash.set(record.token_hash, full);
      return toPublic(full);
    },
    async listSessionsBySucursal(sucursal) {
      return Array.from(sessionsById.values())
        .filter((s) => s.sucursal === sucursal)
        .map(toPublic);
    },
    async revokeSession({ sessionId, allowedSucursal }) {
      const row = sessionsById.get(sessionId);
      if (!row) return { ok: false, code: 'NOT_FOUND' };
      if (allowedSucursal !== 'GLOBAL' && row.sucursal !== allowedSucursal) {
        return { ok: false, code: 'FORBIDDEN_BRANCH' };
      }
      row.revoked_at = new Date().toISOString();
      return { ok: true, session: toPublic(row) };
    },
    async validateSessionRpc(tokenHash) {
      const row = sessionsByHash.get(tokenHash);
      if (!row) return { valid: false, code: 'SESSION_NOT_FOUND' };
      if (row.revoked_at) return { valid: false, code: 'SESSION_REVOKED' };
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        return { valid: false, code: 'SESSION_EXPIRED' };
      }
      row.last_used_at = new Date().toISOString();
      return { valid: true, session: toVerified(row) };
    },
    async bootstrapSessionRpc(tokenHash) {
      const val = await gateway.validateSessionRpc(tokenHash);
      if (!val.valid || !val.session) return val;
      return {
        valid: true,
        session: val.session,
        rutas: [{ id: 'ruta-zulia-1', sucursal: val.session.sucursal }],
        entregas: [{ id: 'ent-zulia-1', sucursal: val.session.sucursal }],
        clientes: [{ id: 'cli-zulia-1', nombre_comercial: 'PDV Zulia' }],
        productos: [{ id: 'prod-1', nombre: 'Mortadela Asturias' }],
        synced_at: new Date().toISOString(),
      };
    },
    async applyOfflineMutationRpc({ tokenHash, clientMutationId }) {
      const val = await gateway.validateSessionRpc(tokenHash);
      if (!val.valid) throw new Error(val.code || 'SESSION_INVALID');
      if (appliedMutations.has(clientMutationId)) {
        return { ok: true, idempotent_hit: true, client_mutation_id: clientMutationId };
      }
      appliedMutations.add(clientMutationId);
      return { ok: true, idempotent_hit: false, client_mutation_id: clientMutationId };
    },
    async uploadShiftIncidenciaPhoto({ sucursal, sessionId, clientMutationId, bytes, extension }) {
      return {
        storagePath: `shift/${sucursal.toLowerCase()}/${sessionId}/${clientMutationId}.${extension}`,
        sha256Hex: sha256Hex(bytes),
      };
    },
  };

  return { gateway, sessionsById, appliedMutations };
}

const coordZuliaUser: AuthenticatedServerUser = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'coord.zulia@codizulca.com',
  appRole: 'coordinacion',
  sucursal: 'ZULIA',
  isCoordinatorOrAdmin: true,
  activeSucursalHeader: 'ZULIA',
};

test('HMAC-SHA256 firma y verifica token opaco sin PII, rechaza manipulación y expiración', () => {
  const sid = crypto.randomUUID();
  const nowMs = Date.UTC(2026, 10, 19, 12, 0, 0);
  const expEpochSec = Math.floor((nowMs + 8 * 3600 * 1000) / 1000);

  const signed = signShiftToken({ sid, expEpochSec }, TEST_SECRET);
  assert.equal(signed.tokenHash.length, 64);
  assert.equal(signed.tokenHash, sha256Hex(signed.token));

  const url = buildSignedShiftUrl({
    origin: 'https://trade-marketing-qi6j.onrender.com',
    rol: 'promotora',
    token: signed.token,
  });
  const parsedUrl = new URL(url);
  assert.equal(parsedUrl.pathname, '/portal');
  assert.deepEqual(Array.from(parsedUrl.searchParams.keys()), ['t']);

  // Decodificar payload base64url: solo v, sid, nonce, exp — CERO PII
  const payloadSegment = signed.token.split('.')[0]!;
  const decoded = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(decoded).sort(), ['exp', 'nonce', 'sid', 'v']);

  // Verificación válida antes de expiración
  const okRes = verifyShiftTokenSignature(signed.token, TEST_SECRET, nowMs + 60_000);
  assert.equal(okRes.ok, true);

  // Manipulación de firma rechazada
  const tamperedSig = `${payloadSegment}.${'A'.repeat(43)}`;
  const badSig = verifyShiftTokenSignature(tamperedSig, TEST_SECRET, nowMs + 60_000);
  assert.equal(badSig.ok, false);
  if (!badSig.ok) assert.equal(badSig.code, 'INVALID_SIGNATURE');

  // Expiración estricta en UTC rechazada
  const expired = verifyShiftTokenSignature(signed.token, TEST_SECRET, expEpochSec * 1000 + 1000);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, 'TOKEN_EXPIRED');
});

test('Coordinadora Zulia genera, verifica, sincroniza idempotentemente y revoca enlace sin guardar texto plano en BD', async () => {
  const { gateway, sessionsById } = createInMemoryGateway();
  const handlers = createShiftLinksHandlers({
    gateway,
    getSecret: () => TEST_SECRET,
  });

  // 1. Generar enlace 12h para Promotora Zulia
  const genRes = createMockRes();
  await handlers.handleGenerateShiftLink(
    createMockReq({
      authUser: coordZuliaUser,
      body: {
        rol: 'promotora',
        duracionHoras: 12,
        rutaCodigo: 'RUTA-MARACAIBO-NORTE',
        sucursal: 'ZULIA',
      },
    }),
    genRes.res
  );
  assert.equal(genRes.getStatus(), 201);
  assert.equal(genRes.getHeaders()['cache-control'], 'no-store');

  const genBody = genRes.getBody();
  const signedUrl = String(genBody.url);
  const sessionObj = genBody.session as StoredShiftSessionSummary;
  const token = new URL(signedUrl).searchParams.get('t')!;

  // En BD solo existe SHA-256 hash, jamás el token en texto plano
  const storedDbRow = sessionsById.get(sessionObj.id)!;
  assert.equal(storedDbRow.token_hash, sha256Hex(token));
  assert.notEqual(storedDbRow.token_hash, token);

  // 2. Verificar enlace activo
  const verRes = createMockRes();
  await handlers.handleVerifyShiftLink(createMockReq({ body: { token } }), verRes.res);
  assert.equal(verRes.getStatus(), 200);
  assert.equal(verRes.getBody().valid, true);

  // 3. Sincronización offline idempotente (2 envíos con mismo client_mutation_id -> 1º normal, 2º idempotentHit)
  const mutId = crypto.randomUUID();
  const sync1 = createMockRes();
  await handlers.handleSyncShiftOfflineBatch(
    createMockReq({
      headers: { 'x-shift-token': token },
      body: {
        mutations: [
          {
            client_mutation_id: mutId,
            tipo: 'PROMOTORA_RUTA_STEP',
            payload: { ruta_id: crypto.randomUUID(), accion: 'CHECKIN' },
          },
        ],
      },
    }),
    sync1.res
  );
  assert.equal(sync1.getStatus(), 200);
  assert.equal((sync1.getBody().results as Array<{ idempotentHit?: boolean }>)[0]?.idempotentHit, false);

  const sync2 = createMockRes();
  await handlers.handleSyncShiftOfflineBatch(
    createMockReq({
      headers: { 'x-shift-token': token },
      body: {
        mutations: [
          {
            client_mutation_id: mutId,
            tipo: 'PROMOTORA_RUTA_STEP',
            payload: { ruta_id: crypto.randomUUID(), accion: 'CHECKIN' },
          },
        ],
      },
    }),
    sync2.res
  );
  assert.equal(sync2.getStatus(), 200);
  assert.equal((sync2.getBody().results as Array<{ idempotentHit?: boolean }>)[0]?.idempotentHit, true);

  // 4. Revocación inmediata
  const revRes = createMockRes();
  await handlers.handleRevokeShiftLink(
    createMockReq({ authUser: coordZuliaUser, body: { sessionId: sessionObj.id } }),
    revRes.res
  );
  assert.equal(revRes.getStatus(), 200);

  // 5. Tras revocar, verify y sync deben retornar HTTP 401 SESSION_REVOKED
  const afterRev = createMockRes();
  await handlers.handleVerifyShiftLink(createMockReq({ body: { token } }), afterRev.res);
  assert.equal(afterRev.getStatus(), 401);
  assert.equal(afterRev.getBody().code, 'SESSION_REVOKED');
});

test('Bloquea cruce regional (Zulia intentando emitir para Valencia -> 403) y falla cerrado sin SHIFT_LINK_SECRET', async () => {
  const { gateway } = createInMemoryGateway();
  const handlers = createShiftLinksHandlers({ gateway, getSecret: () => TEST_SECRET });

  const crossRes = createMockRes();
  await handlers.handleGenerateShiftLink(
    createMockReq({
      authUser: coordZuliaUser,
      body: { rol: 'chofer', duracionHoras: 8, rutaCodigo: 'RUTA-VALENCIA', sucursal: 'VALENCIA' },
    }),
    crossRes.res
  );
  assert.equal(crossRes.getStatus(), 403);
  assert.equal(crossRes.getBody().code, 'FORBIDDEN_BRANCH');

  const unconfiguredHandlers = createShiftLinksHandlers({ gateway, getSecret: () => null });
  const failClosedRes = createMockRes();
  await unconfiguredHandlers.handleGenerateShiftLink(
    createMockReq({
      authUser: coordZuliaUser,
      body: { rol: 'promotora', duracionHoras: 8, rutaCodigo: 'TODAS', sucursal: 'ZULIA' },
    }),
    failClosedRes.res
  );
  assert.equal(failClosedRes.getStatus(), 503);
  assert.equal(failClosedRes.getBody().code, 'SHIFT_LINK_SECRET_UNCONFIGURED');
});

test('Inspección binaria offline de evidencias acepta WebP <= 350 KB y bloquea SVG y archivos > 350 KB', () => {
  const validWebp = Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    Buffer.alloc(32, 0x01),
  ]);
  const ok = inspectShiftOfflinePhotoBytes(validWebp.toString('base64'));
  assert.equal(ok.mimeType, 'image/webp');
  assert.equal(ok.extension, 'webp');

  const svgPayload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.throws(() => inspectShiftOfflinePhotoBytes(svgPayload.toString('base64')), /bloqueado por seguridad/i);

  const oversizedWebp = Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    Buffer.alloc(360 * 1024, 0x02),
  ]);
  assert.throws(() => inspectShiftOfflinePhotoBytes(oversizedWebp.toString('base64')), /350 KB/i);
});
