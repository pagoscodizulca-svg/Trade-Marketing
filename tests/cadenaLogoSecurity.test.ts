import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import express from 'express';
import {
  CADENAS_LOGOS_PRIVATE_BUCKET_ID,
  MAX_CADENA_LOGO_BYTES,
  buildDeterministicCadenaLogoStoragePath,
  createDeleteCadenaLogoHandler,
  createGetCadenaLogoHandler,
  createUploadCadenaLogoHandler,
  verifyCadenaLogoMagicBytes,
  type CadenaComercialLogoDbRow,
  type CadenaLogoGateway,
} from '../src/server/cadenaLogoHandler';
import type { AuthenticatedServerUser, OperativeSucursal } from '../src/server/supabaseAdminAuth';

// 1x1 PNG real con firma 89 50 4E 47 0D 0A 1A 0A + chunk IHDR válido
const VALID_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

// 1x1 WebP real con firma RIFF....WEBP
const VALID_WEBP_BUFFER = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  'base64'
);

const CADENA_ZULIA_ID = '71000000-0000-4000-8000-000000000001';
const CADENA_VALENCIA_ID = '71000000-0000-4000-8000-000000000002';
const CADENA_CAPITAL_ID = '71000000-0000-4000-8000-000000000005';

function buildInMemoryLogoHarness(options?: { failDbUpdate?: boolean }) {
  const storage = new Map<string, Buffer>();
  const cadenas = new Map<string, CadenaComercialLogoDbRow>([
    [
      CADENA_ZULIA_ID,
      {
        id: CADENA_ZULIA_ID,
        codigo: 'CAD-ZULIA',
        nombre: 'Supermercados Enne Zulia',
        sucursal: 'ZULIA',
        region_id: '10000000-0000-4000-8000-000000000001',
        activo: true,
        logo_storage_path: null,
        logo_mime_type: null,
        logo_updated_at: null,
        logo_updated_by: null,
      },
    ],
    [
      CADENA_VALENCIA_ID,
      {
        id: CADENA_VALENCIA_ID,
        codigo: 'CAD-VALENCIA',
        nombre: 'Hiper Líder Valencia',
        sucursal: 'VALENCIA',
        region_id: '10000000-0000-4000-8000-000000000002',
        activo: true,
        logo_storage_path: null,
        logo_mime_type: null,
        logo_updated_at: null,
        logo_updated_by: null,
      },
    ],
    [
      CADENA_CAPITAL_ID,
      {
        id: CADENA_CAPITAL_ID,
        codigo: 'CAD-CAPITAL',
        nombre: 'Excelsior Gama Capital',
        sucursal: 'CAPITAL',
        region_id: '10000000-0000-4000-8000-000000000005',
        activo: true,
        logo_storage_path: null,
        logo_mime_type: null,
        logo_updated_at: null,
        logo_updated_by: null,
      },
    ],
  ]);

  const authorizedClienteLinks = new Set<string>([
    `cliente-zulia-linked::${CADENA_ZULIA_ID}::ZULIA`,
  ]);

  const gateway: CadenaLogoGateway = {
    async findCadenaById(id) {
      const row = cadenas.get(id.toLowerCase());
      return row ? { ...row } : null;
    },
    async hasClientePortalAccessToCadena(userId, cadenaId, sucursal) {
      return authorizedClienteLinks.has(`${userId}::${cadenaId.toLowerCase()}::${sucursal}`);
    },
    async uploadPrivateLogoObject({ bucket, path, buffer }) {
      storage.set(`${bucket}:${path}`, Buffer.from(buffer));
    },
    async downloadPrivateLogoObject(bucket, path) {
      return storage.get(`${bucket}:${path}`) ?? null;
    },
    async deletePrivateLogoObjects(bucket, paths) {
      for (const p of paths) {
        storage.delete(`${bucket}:${p}`);
      }
    },
    async updateCadenaLogoMetadata({
      cadenaId,
      logoStoragePath,
      logoMimeType,
      updatedAtIso,
      updatedByUid,
    }) {
      if (options?.failDbUpdate) {
        throw new Error('Simulated DB failure');
      }
      const existing = cadenas.get(cadenaId.toLowerCase());
      if (!existing) throw new Error('Not found');
      const updated: CadenaComercialLogoDbRow = {
        ...existing,
        logo_storage_path: logoStoragePath,
        logo_mime_type: logoMimeType,
        logo_updated_at: updatedAtIso,
        logo_updated_by: updatedByUid,
      };
      cadenas.set(cadenaId.toLowerCase(), updated);
      return { ...updated };
    },
  };

  const actors: Record<string, AuthenticatedServerUser> = {
    coord_zulia: {
      id: '22222222-2222-4222-8222-222222222201',
      email: 'coord.zulia@codizulca.local',
      appRole: 'coordinacion',
      sucursal: 'ZULIA',
      isCoordinatorOrAdmin: true,
    },
    coord_valencia: {
      id: '22222222-2222-4222-8222-222222222202',
      email: 'coord.valencia@codizulca.local',
      appRole: 'coordinacion',
      sucursal: 'VALENCIA',
      isCoordinatorOrAdmin: true,
    },
    super_admin: {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'superadmin@codizulca.local',
      appRole: 'super_admin',
      sucursal: 'GLOBAL',
      isCoordinatorOrAdmin: true,
    },
    cliente_zulia_linked: {
      id: 'cliente-zulia-linked',
      email: 'cliente.enne.zulia@codizulca.local',
      appRole: 'cliente',
      sucursal: 'ZULIA',
      isCoordinatorOrAdmin: false,
    },
    cliente_zulia_unlinked: {
      id: 'cliente-zulia-unlinked',
      email: 'cliente.otro.zulia@codizulca.local',
      appRole: 'cliente',
      sucursal: 'ZULIA',
      isCoordinatorOrAdmin: false,
    },
    cliente_valencia: {
      id: 'cliente-valencia',
      email: 'cliente.valencia@codizulca.local',
      appRole: 'cliente',
      sucursal: 'VALENCIA',
      isCoordinatorOrAdmin: false,
    },
  };

  const app = express();
  app.use((req, res, next) => {
    const actorKey = String(req.headers['x-test-actor'] || '');
    const baseActor = actors[actorKey];
    if (!baseActor) {
      res.status(401).json({ error: 'No autenticado', code: 'AUTH_TOKEN_MISSING' });
      return;
    }
    const rawSuc = String(req.headers['x-sucursal-activa'] || '').trim().toUpperCase();
    const validHubs: OperativeSucursal[] = ['ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'];
    req.authUser = {
      ...baseActor,
      activeSucursalHeader: validHubs.includes(rawSuc as OperativeSucursal)
        ? (rawSuc as OperativeSucursal)
        : null,
    };
    next();
  });

  app.post(
    '/api/cadenas-comerciales/:id/logo',
    express.raw({ type: '*/*', limit: '700kb' }),
    createUploadCadenaLogoHandler(gateway)
  );
  app.delete('/api/cadenas-comerciales/:id/logo', createDeleteCadenaLogoHandler(gateway));
  app.get('/api/cadenas-comerciales/:id/logo', createGetCadenaLogoHandler(gateway));

  return { app, storage, cadenas };
}

async function withTestServer<T>(
  app: express.Express,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('v1.8.0 Compuerta G3 — Blindaje Binario y Aislamiento Regional de Logos de Cadenas', () => {
  it('acepta PNG y WebP reales por magic bytes y genera rutas determinísticas sin nombre de usuario', () => {
    const png = verifyCadenaLogoMagicBytes(VALID_PNG_BUFFER);
    assert.equal(png.mimeType, 'image/png');
    assert.equal(png.extension, 'png');
    assert.equal(png.sha256Hex.length, 64);

    const webp = verifyCadenaLogoMagicBytes(VALID_WEBP_BUFFER);
    assert.equal(webp.mimeType, 'image/webp');
    assert.equal(webp.extension, 'webp');

    const pathZulia = buildDeterministicCadenaLogoStoragePath({
      sucursal: 'ZULIA',
      cadenaId: CADENA_ZULIA_ID,
      extension: 'png',
    });
    assert.match(
      pathZulia,
      /^cadenas-logos\/ZULIA\/71000000-0000-4000-8000-000000000001\/logo_[0-9a-f-]{36}\.png$/
    );
  });

  it('bloquea con 415 archivos SVG maliciosos renombrados a .png, HTML, JPEG, ejecutables y supera 512 KB con 413', async () => {
    const { app, storage } = buildInMemoryLogoHarness();

    await withTestServer(app, async (baseUrl) => {
      const maliciousSvg = Buffer.from(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"><rect width="10" height="10"/></svg>',
        'utf8'
      );
      const svgRes = await fetch(`${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`, {
        method: 'POST',
        headers: {
          'x-test-actor': 'coord_zulia',
          'Content-Type': 'image/png',
        },
        body: maliciousSvg,
      });
      assert.equal(svgRes.status, 415);
      const svgJson = (await svgRes.json()) as { code?: string };
      assert.equal(svgJson.code, 'DANGEROUS_CONTENT_DETECTED');

      const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0)]);
      const jpgRes = await fetch(`${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`, {
        method: 'POST',
        headers: { 'x-test-actor': 'coord_zulia', 'Content-Type': 'image/jpeg' },
        body: fakeJpeg,
      });
      assert.equal(jpgRes.status, 415);

      const oversized = Buffer.concat([
        VALID_PNG_BUFFER,
        Buffer.alloc(MAX_CADENA_LOGO_BYTES + 128, 0),
      ]);
      const bigRes = await fetch(`${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`, {
        method: 'POST',
        headers: { 'x-test-actor': 'coord_zulia', 'Content-Type': 'image/png' },
        body: oversized,
      });
      assert.equal(bigRes.status, 413);
      const bigJson = (await bigRes.json()) as { code?: string };
      assert.equal(bigJson.code, 'FILE_TOO_LARGE');

      assert.equal(storage.size, 0, 'Ningún binario rechazado debe escribirse en Storage');
    });
  });

  it('aísla estrictamente regiones (Zulia vs Valencia/Capital), reemplaza y elimina logos, y sirve GET con nosniff a cliente autorizado', async () => {
    const { app, storage } = buildInMemoryLogoHarness();

    await withTestServer(app, async (baseUrl) => {
      const crossHubRes = await fetch(
        `${baseUrl}/api/cadenas-comerciales/${CADENA_VALENCIA_ID}/logo`,
        {
          method: 'POST',
          headers: { 'x-test-actor': 'coord_zulia', 'Content-Type': 'image/png' },
          body: VALID_PNG_BUFFER,
        }
      );
      assert.equal(crossHubRes.status, 403);
      assert.equal(((await crossHubRes.json()) as { code?: string }).code, 'FORBIDDEN_BRANCH');

      const adminWrongHubRes = await fetch(
        `${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`,
        {
          method: 'POST',
          headers: {
            'x-test-actor': 'super_admin',
            'x-sucursal-activa': 'CAPITAL',
            'Content-Type': 'image/png',
          },
          body: VALID_PNG_BUFFER,
        }
      );
      assert.equal(adminWrongHubRes.status, 403);

      const okPngRes = await fetch(`${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`, {
        method: 'POST',
        headers: { 'x-test-actor': 'coord_zulia', 'Content-Type': 'image/png' },
        body: VALID_PNG_BUFFER,
      });
      assert.equal(okPngRes.status, 200);
      assert.equal(storage.size, 1);

      const okWebpRes = await fetch(`${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`, {
        method: 'POST',
        headers: { 'x-test-actor': 'coord_zulia', 'Content-Type': 'image/webp' },
        body: VALID_WEBP_BUFFER,
      });
      assert.equal(okWebpRes.status, 200);
      assert.equal(storage.size, 1);

      const cliGetOk = await fetch(`${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`, {
        headers: { 'x-test-actor': 'cliente_zulia_linked' },
      });
      assert.equal(cliGetOk.status, 200);
      assert.equal(cliGetOk.headers.get('content-type'), 'image/webp');
      assert.equal(cliGetOk.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(cliGetOk.headers.get('cache-control'), 'private, max-age=3600');
      const downloaded = Buffer.from(await cliGetOk.arrayBuffer());
      assert.deepEqual(downloaded, VALID_WEBP_BUFFER);

      const cliUnlinkedRes = await fetch(
        `${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`,
        { headers: { 'x-test-actor': 'cliente_zulia_unlinked' } }
      );
      assert.equal(cliUnlinkedRes.status, 403);
      assert.equal(
        ((await cliUnlinkedRes.json()) as { code?: string }).code,
        'FORBIDDEN_CADENA_ACCESS'
      );

      const cliCrossHubRes = await fetch(
        `${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`,
        { headers: { 'x-test-actor': 'cliente_valencia' } }
      );
      assert.equal(cliCrossHubRes.status, 403);

      const cliDeleteRes = await fetch(
        `${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`,
        { method: 'DELETE', headers: { 'x-test-actor': 'cliente_zulia_linked' } }
      );
      assert.equal(cliDeleteRes.status, 403);

      const delOk = await fetch(`${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`, {
        method: 'DELETE',
        headers: { 'x-test-actor': 'coord_zulia' },
      });
      assert.equal(delOk.status, 200);
      assert.equal(storage.size, 0);
    });
  });

  it('ejecuta rollback inmediato del objeto en Storage cuando falla el UPDATE en PostgreSQL', async () => {
    const { app, storage } = buildInMemoryLogoHarness({ failDbUpdate: true });

    await withTestServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/cadenas-comerciales/${CADENA_ZULIA_ID}/logo`, {
        method: 'POST',
        headers: { 'x-test-actor': 'coord_zulia', 'Content-Type': 'image/png' },
        body: VALID_PNG_BUFFER,
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'DB_UPDATE_ROLLED_BACK');
      assert.equal(
        storage.size,
        0,
        `El objeto huérfano en ${CADENAS_LOGOS_PRIVATE_BUCKET_ID} debió revertirse`
      );
    });
  });
});
