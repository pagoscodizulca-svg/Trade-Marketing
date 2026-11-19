import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildMockJwt,
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
} from './antigravity_audit/localMockInfra';
import {
  createRateLimiter,
  createUserScopedSupabaseClient,
  handleCreateCorporateUser,
  handleProvisionStaffAuth,
  normalizeCanonicalEmail,
  normalizeServerSucursal,
  OPERATIVE_SUCURSALES,
  requireAttendanceActorAuth,
  requireCoordinatorOrAdminAuth,
  requireFdvOrTradeAuth,
  requireIncidenciaActorAuth,
  requireSuperAdminAuth,
  requireTorreControlAuth,
  resolveEffectiveServerAppRole,
  type AuthenticatedServerUser,
  type OperativeSucursal,
} from '../src/server/supabaseAdminAuth';
import { buildCorsMiddleware } from '../src/server/securityMiddleware';
import {
  createFdvSolicitudesHandler,
  getCaracasTodayYmd,
  normalizeRequestedBranch,
  type FdvSolicitudesGateway,
  type PersistFdvSurveyRecord,
  type StoredFdvSurveyRow,
} from '../src/server/fdvSolicitudesHandler';
import {
  buildDeterministicIncidenciaStoragePath,
  createBatchIncidenciaSignedUrlsHandler,
  createUploadIncidenciaEvidenceHandler,
  INCIDENCIAS_PRIVATE_BUCKET_ID,
  type IncidenciaPdvDbRow,
  type IncidenciasEvidencesGateway,
} from '../src/server/incidenciasEvidencesHandler';
import {
  createContraloriaInvoicesHandlers,
  type ConciliacionLookupRow,
  type ContraloriaInvoiceDbRow,
  type ContraloriaInvoicesGateway,
} from '../src/server/contraloriaInvoicesHandler';
import {
  buildDeterministicInvoiceStoragePath,
  CONTRALORIA_FACTURAS_BUCKET_ID,
  FiscalDocumentSecurityError,
} from '../src/server/fiscalReceiptFileValidator';
import {
  createAttendanceEvidencesHandlers,
  type AttendancePersistenceGateway,
} from '../src/server/attendanceEvidencesHandler';
import {
  getAllowedSucursalesForRole,
  normalizeSucursalCodigo,
  OPERATIVE_SUCURSALES as USER_MGMT_OPERATIVE_SUCURSALES,
  SUCURSAL_CODIGOS,
  SUCURSAL_LABELS,
} from '../src/services/userManagementService';
import { obtenerEtiquetaSede, signOutSupabaseSession } from '../src/services/authService';
import {
  getActiveClientSucursalHeader,
  setActiveClientSucursalHeader,
} from '../src/services/supabaseClient';
import {
  clearMasterDataCaches,
  guardarClienteMaestro,
  inferirSucursalDesdeTerritorio,
  invalidarCacheMaestros,
  normalizarSucursalMaestro,
  obtenerCadenasComerciales,
  obtenerClientesMaestros,
  obtenerVendedoresMaestros,
  obtenerZonasComerciales,
} from '../src/services/masterDataSyncService';
import {
  fetchPresupuestosTrade,
  mapDbConciliacionToInventoryReconciliation,
  resolvePazYSalvoSha256,
  upsertPresupuestoTrade,
} from '../src/services/contraloriaFinancialService';
import type { MasterDataDatabase } from '../src/types/masterData';
import {
  formatSucursalLabel,
  normalizeRutaSucursal,
  verifyRutaProfileAccess,
} from '../ruta-degustacion/src/services/supabaseAuth';
import { OPERATIVE_SUCURSALES as RUTA_OPERATIVE_SUCURSALES } from '../ruta-degustacion/src/types';

const VALID_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(64, 0x11),
  Buffer.from([0xff, 0xd9]),
]);

const VALID_PDF = Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
  'utf8'
);

const VALID_TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function futureCaracasDate(daysAhead = 4): string {
  const today = getCaracasTodayYmd();
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + daysAhead));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate()
  ).padStart(2, '0')}`;
}

function encodeBase64Json(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function hubUuid(prefixHex: string, hubIdx: number, itemIdx = 1): string {
  const p = prefixHex.padStart(8, '0').slice(0, 8);
  const h = String(hubIdx + 1).padStart(4, '0');
  const tail = String(itemIdx).padStart(12, '0');
  return `${p}-${h}-4000-8000-${tail}`;
}

const HUB_TERRITORY_SAMPLES: Record<OperativeSucursal, readonly string[]> = {
  ZULIA: [
    'ZULIA',
    '  Sucursal Zulia  ',
    'Maracaibo',
    'San Francisco',
    'Cabimas',
    'Ciudad Ojeda',
  ],
  VALENCIA: [
    'VALENCIA',
    '  Sucursal Valencia ',
    'Carabobo',
    'Naguanagua',
    'San Diego',
    'Puerto Cabello',
  ],
  CENTRO: [
    'CENTRO',
    '  Región Centro ',
    'Aragua',
    'Maracay',
    'Lara',
    'Barquisimeto',
  ],
  ORIENTE: [
    'ORIENTE',
    '  Anzoátegui  ',
    'Puerto La Cruz',
    '  Maturín ',
    'Margarita',
    'Puerto Ordaz',
    'Cumaná',
  ],
  CAPITAL: [
    'CAPITAL',
    '  Caracas ',
    'Distrito Capital',
    'Miranda',
    '  La Guaira  ',
    'Maiquetía',
  ],
};

test('COMPUERTA G2 — Aislamiento Multi-Región en 5 Hubs (ZULIA, VALENCIA, CENTRO, ORIENTE, CAPITAL) + GLOBAL', async (t) => {
  await t.test('1) Modelo de dominio, etiquetas, CORS x-sucursal-activa, rutas Storage y normalización NFD de territorios en los 5 hubs', async () => {
    const expectedHubs = ['ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'] as const;
    assert.deepEqual(OPERATIVE_SUCURSALES, expectedHubs);
    assert.deepEqual(USER_MGMT_OPERATIVE_SUCURSALES, expectedHubs);
    assert.deepEqual(RUTA_OPERATIVE_SUCURSALES, expectedHubs);
    assert.deepEqual(SUCURSAL_CODIGOS, [...expectedHubs, 'GLOBAL']);

    assert.deepEqual(SUCURSAL_LABELS, {
      ZULIA: 'Sucursal Zulia',
      VALENCIA: 'Sucursal Valencia',
      CENTRO: 'Sucursal Centro',
      ORIENTE: 'Sucursal Oriente',
      CAPITAL: 'Sucursal Capital',
      GLOBAL: 'Global · Nacional',
    });

    for (const role of ['coordinacion', 'vendedor', 'promotora', 'cliente', 'chofer'] as const) {
      assert.deepEqual(getAllowedSucursalesForRole(role), expectedHubs);
    }
    assert.deepEqual(getAllowedSucursalesForRole('super_admin'), ['GLOBAL']);
    assert.deepEqual(getAllowedSucursalesForRole('contraloria'), ['GLOBAL', ...expectedHubs]);

    assert.equal(obtenerEtiquetaSede('coordinacion', 'ZULIA'), 'Sucursal Zulia');
    assert.equal(obtenerEtiquetaSede('coordinacion', 'VALENCIA'), 'Sucursal Valencia');
    assert.equal(obtenerEtiquetaSede('coordinacion', 'CENTRO'), 'Sucursal Centro');
    assert.equal(obtenerEtiquetaSede('coordinacion', 'ORIENTE'), 'Sucursal Oriente');
    assert.equal(obtenerEtiquetaSede('coordinacion', 'CAPITAL'), 'Sucursal Capital');
    assert.equal(obtenerEtiquetaSede('super_admin', 'GLOBAL'), 'Administración General - Nacional');
    assert.equal(obtenerEtiquetaSede('contraloria', 'GLOBAL'), 'Contraloría Nacional - Global');

    // Normalización NFD + LOWER(TRIM(...)) para todos los territorios y alias de los 5 hubs
    for (const hub of expectedHubs) {
      for (const alias of HUB_TERRITORY_SAMPLES[hub]) {
        assert.equal(normalizeServerSucursal(alias), hub, `normalizeServerSucursal("${alias}") -> ${hub}`);
        assert.equal(normalizeSucursalCodigo(alias), hub, `normalizeSucursalCodigo("${alias}") -> ${hub}`);
        assert.equal(normalizeRequestedBranch(alias), hub, `normalizeRequestedBranch("${alias}") -> ${hub}`);
        assert.equal(normalizarSucursalMaestro(alias), hub, `normalizarSucursalMaestro("${alias}") -> ${hub}`);
        assert.equal(
          inferirSucursalDesdeTerritorio({ ciudad: alias }),
          hub,
          `inferirSucursalDesdeTerritorio("${alias}") -> ${hub}`
        );
      }

      // Rutas determinísticas de Storage para los 5 hubs
      const reqUuid = hubUuid('a1111111', expectedHubs.indexOf(hub), 1);
      const fileUuid = hubUuid('b2222222', expectedHubs.indexOf(hub), 2);
      assert.equal(
        buildDeterministicInvoiceStoragePath({
          sucursal: hub,
          requisicionId: reqUuid,
          extension: 'pdf',
          fileUuid,
        }),
        `facturas/${hub}/${reqUuid}/${fileUuid}.pdf`
      );
      assert.equal(
        buildDeterministicIncidenciaStoragePath({
          sucursal: hub,
          fechaYmd: '2026-11-19',
          extension: 'jpg',
          fileUuid,
        }),
        `incidencias/${hub}/2026-11-19/${fileUuid}.jpg`
      );
    }

    assert.throws(
      () =>
        buildDeterministicInvoiceStoragePath({
          sucursal: 'GLOBAL' as unknown as OperativeSucursal,
          requisicionId: crypto.randomUUID(),
          extension: 'pdf',
        }),
      (err: unknown) => err instanceof FiscalDocumentSecurityError && err.statusCode === 400
    );

    // Preflight CORS verifica que `x-sucursal-activa` y `x-factura-meta` están permitidos
    const corsApp = express();
    corsApp.use(
      '/api',
      buildCorsMiddleware({
        allowedOrigins: ['https://app.codizulca.com'],
        isProduction: true,
      })
    );
    corsApp.post('/api/ping', (_req, res) => res.json({ ok: true }));
    const corsServer = http.createServer(corsApp);
    await new Promise<void>((r) => corsServer.listen(0, '127.0.0.1', r));
    const corsPort = (corsServer.address() as AddressInfo).port;
    try {
      const preflight = await fetch(`http://127.0.0.1:${corsPort}/api/ping`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.codizulca.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization,x-sucursal-activa,x-factura-meta',
        },
      });
      assert.equal(preflight.status, 204);
      const allowHeaders = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase();
      assert.match(allowHeaders, /x-sucursal-activa/);
      assert.match(allowHeaders, /x-factura-meta/);
    } finally {
      corsServer.closeAllConnections?.();
      await new Promise<void>((r) => corsServer.close(() => r()));
    }
  });

  await t.test('2) Resolución canónica LOWER(TRIM(email)) -> Región (mayúsculas, espacios y territorios acentuados) para los 5 roles regionales en los 5 hubs', async () => {
    const regionalRoles = ['promotora', 'coordinacion', 'vendedor', 'cliente', 'chofer'] as const;
    const accentedByHub: Record<OperativeSucursal, string> = {
      ZULIA: '  Maracaibo  ',
      VALENCIA: '  Carabobo  ',
      CENTRO: '  Barquisimeto  ',
      ORIENTE: '  Anzoátegui  ',
      CAPITAL: '  Distrito Capital  ',
    };

    const profilesRows: Array<Record<string, unknown>> = [];
    const promotorasRows: Array<Record<string, unknown>> = [];
    const staffRows: Array<Record<string, unknown>> = [];

    // Sembrar perfiles cuyo `id` NO coincide con el `auth.uid()` de sesión (simulando pre-registro por correo)
    // con correos en MAYÚSCULAS + espacios y territorios con tildes
    for (let hIdx = 0; hIdx < OPERATIVE_SUCURSALES.length; hIdx += 1) {
      const hub = OPERATIVE_SUCURSALES[hIdx]!;
      const territoryLabel = accentedByHub[hub];

      for (const role of regionalRoles) {
        if (role === 'promotora' && hIdx % 2 === 1) {
          // Para índices impares (VALENCIA y ORIENTE), probar respaldo directo en `promotoras` / `staff` sin fila en `profiles`
          if (hub === 'ORIENTE') {
            promotorasRows.push({
              id: hubUuid('cc000001', hIdx, 10),
              nombre: `Promotora ${hub}`,
              email: `   PROMOTORA.${hub}@CODIZULCA.COM   `,
              ciudad: '  Maturín  ',
              estado: '  Anzoátegui ',
              activo: true,
            });
          } else {
            staffRows.push({
              id: hubUuid('cc000002', hIdx, 11),
              name: `Staff ${hub}`,
              role: 'Promotora Fija',
              email: `  PROMOTORA.${hub}@CODIZULCA.COM  `,
              status: JSON.stringify({ status: 'Activo', category: 'fija', address: territoryLabel }),
              sucursal: null,
            });
          }
          continue;
        }

        profilesRows.push({
          id: crypto.randomUUID(), // distinto al userId de Auth para ejercitar LOWER(TRIM(email))
          email: `   ${role.toUpperCase()}.${hub}@CODIZULCA.COM   `,
          full_name: `Actor ${role} ${hub}`,
          role,
          sucursal: territoryLabel,
          is_active: true,
        });
      }
    }

    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');

      const matchTable = (rows: Array<Record<string, unknown>>) => {
        const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
        if (idEq) {
          const found = rows.find((r) => String(r.id) === idEq) ?? null;
          res.end(JSON.stringify(found));
          return;
        }
        const emailIlike = url.searchParams.get('email') || '';
        if (emailIlike.startsWith('ilike.')) {
          const needle = emailIlike.slice(6).replace(/[%*]/g, '').toLowerCase();
          const filtered = rows.filter((r) => String(r.email || '').toLowerCase().includes(needle));
          res.end(JSON.stringify(filtered));
          return;
        }
        res.end(JSON.stringify(rows));
      };

      if (url.pathname === '/rest/v1/profiles') {
        matchTable(profilesRows);
        return;
      }
      if (url.pathname === '/rest/v1/staff') {
        matchTable(staffRows);
        return;
      }
      if (url.pathname === '/rest/v1/promotoras') {
        matchTable(promotorasRows);
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });

    await new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', r));
    const port = (mockServer.address() as AddressInfo).port;

    const prevEnv = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = MOCK_PUBLIC_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;

    try {
      for (const hub of OPERATIVE_SUCURSALES) {
        for (const role of regionalRoles) {
          const freshAuthUid = crypto.randomUUID();
          const messyLoginEmail = `  ${role.toUpperCase()}.${hub.toLowerCase()}@Codizulca.COM \t `;
          assert.equal(
            normalizeCanonicalEmail(messyLoginEmail),
            `${role}.${hub.toLowerCase()}@codizulca.com`
          );

          const token = buildMockJwt({
            sub: freshAuthUid,
            email: messyLoginEmail,
            role: 'authenticated',
          });

          const resolved = await resolveEffectiveServerAppRole(
            freshAuthUid,
            token,
            '',
            undefined,
            messyLoginEmail
          );

          assert.equal(resolved.isActive, true, `${role} en ${hub} debe estar activo`);
          assert.equal(resolved.role, role, `Rol resuelto por correo canónico para ${role} en ${hub}`);
          assert.equal(
            resolved.sucursal,
            hub,
            `Hub resuelto por correo canónico + territorio acentuado para ${role} debe ser ${hub}`
          );
        }
      }
    } finally {
      mockServer.closeAllConnections?.();
      await new Promise<void>((r) => mockServer.close(() => r()));
      if (prevEnv.SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevEnv.SUPABASE_URL;
      if (prevEnv.SUPABASE_PUBLISHABLE_KEY === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
      else process.env.SUPABASE_PUBLISHABLE_KEY = prevEnv.SUPABASE_PUBLISHABLE_KEY;
      if (prevEnv.SUPABASE_SERVICE_ROLE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = prevEnv.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  await t.test('3) Matriz completa 5 × 5 (los 20 pares cruzados hubA !== hubB + 5 propios) y reglas GLOBAL / Contraloría', async () => {
    interface HubFixture {
      hub: OperativeSucursal;
      coordId: string;
      coordToken: string;
      vendedorId: string;
      vendedorToken: string;
      promotoraUid: string;
      promotoraStaffId: string;
      promotoraToken: string;
      contraloriaRegId: string;
      contraloriaRegToken: string;
      clienteId: string;
      requisicionId: string;
      conciliacionId: string;
      facturaId: string;
      incidenciaId: string;
      evidenciaAsistenciaId: string;
      mp07Code: string;
    }

    const superAdminId = '90000000-0000-4000-8000-000000000001';
    const contraloriaGlobalId = '90000000-0000-4000-8000-000000000002';

    const mkJwt = (
      sub: string,
      email: string,
      role: string,
      sucursal: string,
      staffId?: string
    ) =>
      buildMockJwt({
        sub,
        email,
        role: 'authenticated',
        app_metadata: {
          role,
          app_role: role,
          sucursal,
          ...(staffId ? { staff_id: staffId } : {}),
        },
        exp: 2100000000,
      });

    const superAdminToken = mkJwt(superAdminId, 'root@codizulca.com', 'super_admin', 'GLOBAL');
    const contraloriaGlobalToken = mkJwt(
      contraloriaGlobalId,
      'contraloria.nacional@codizulca.com',
      'contraloria',
      'GLOBAL'
    );

    const fixtures = new Map<OperativeSucursal, HubFixture>();
    const authByToken = new Map<
      string,
      { id: string; email: string; role: string; sucursal: string; staffId?: string }
    >([
      [
        superAdminToken,
        { id: superAdminId, email: 'root@codizulca.com', role: 'super_admin', sucursal: 'GLOBAL' },
      ],
      [
        contraloriaGlobalToken,
        {
          id: contraloriaGlobalId,
          email: 'contraloria.nacional@codizulca.com',
          role: 'contraloria',
          sucursal: 'GLOBAL',
        },
      ],
    ]);

    const profilesById = new Map<
      string,
      { id: string; email: string; role: string; sucursal: string; is_active: boolean }
    >([
      [
        superAdminId,
        {
          id: superAdminId,
          email: 'root@codizulca.com',
          role: 'super_admin',
          sucursal: 'GLOBAL',
          is_active: true,
        },
      ],
      [
        contraloriaGlobalId,
        {
          id: contraloriaGlobalId,
          email: 'contraloria.nacional@codizulca.com',
          role: 'contraloria',
          sucursal: 'GLOBAL',
          is_active: true,
        },
      ],
    ]);

    const staffById = new Map<string, Record<string, unknown>>();
    const clientesTable = new Map<string, Record<string, unknown>>();
    const rutasTable: Array<Record<string, unknown>> = [];
    const presupuestosTable: Array<Record<string, unknown>> = [];
    const solicitudesMp07Table: Array<Record<string, unknown>> = [];
    const conciliacionesById = new Map<string, ConciliacionLookupRow>();
    const facturasById = new Map<string, ContraloriaInvoiceDbRow>();
    const incidenciasById = new Map<string, IncidenciaPdvDbRow>();
    const asistenciaById = new Map<
      string,
      { id: string; storage_path: string; promotoraId: string; sucursal: OperativeSucursal }
    >();
    const fdvSurveysByKey = new Map<string, StoredFdvSurveyRow>();

    // Conciliación legado sin sede asignada para validar 400 BRANCH_REQUIRED en GLOBAL sin hub explícito
    const unscopedReqId = '91000000-0000-4000-8000-000000000099';
    const unscopedConcId = '92000000-0000-4000-8000-000000000099';
    conciliacionesById.set(unscopedConcId, {
      id: unscopedConcId,
      requisicion_id: unscopedReqId,
      cerrada: false,
      sucursal: null,
    });

    OPERATIVE_SUCURSALES.forEach((hub, idx) => {
      const coordId = hubUuid('10000000', idx, 1);
      const vendedorId = hubUuid('20000000', idx, 2);
      const promotoraUid = hubUuid('30000000', idx, 3);
      const promotoraStaffId = hubUuid('40000000', idx, 4);
      const contraloriaRegId = hubUuid('50000000', idx, 5);
      const clienteId = hubUuid('60000000', idx, 6);
      const requisicionId = hubUuid('70000000', idx, 7);
      const conciliacionId = hubUuid('71000000', idx, 8);
      const facturaId = hubUuid('72000000', idx, 9);
      const incidenciaId = hubUuid('73000000', idx, 10);
      const evidenciaAsistenciaId = hubUuid('74000000', idx, 11);
      const mp07Code = `MP-07-090${idx + 1}`;

      const coordEmail = `coord.${hub.toLowerCase()}@codizulca.com`;
      const vendedorEmail = `fdv.${hub.toLowerCase()}@codizulca.com`;
      const promotoraEmail = `prom.${hub.toLowerCase()}@codizulca.com`;
      const contraloriaRegEmail = `audit.${hub.toLowerCase()}@codizulca.com`;

      const coordToken = mkJwt(coordId, coordEmail, 'coordinacion', hub);
      const vendedorToken = mkJwt(vendedorId, vendedorEmail, 'vendedor', hub);
      const promotoraToken = mkJwt(
        promotoraUid,
        promotoraEmail,
        'promotora',
        hub,
        promotoraStaffId
      );
      const contraloriaRegToken = mkJwt(
        contraloriaRegId,
        contraloriaRegEmail,
        'contraloria',
        hub
      );

      for (const actor of [
        { token: coordToken, id: coordId, email: coordEmail, role: 'coordinacion', sucursal: hub },
        { token: vendedorToken, id: vendedorId, email: vendedorEmail, role: 'vendedor', sucursal: hub },
        {
          token: promotoraToken,
          id: promotoraUid,
          email: promotoraEmail,
          role: 'promotora',
          sucursal: hub,
          staffId: promotoraStaffId,
        },
        {
          token: contraloriaRegToken,
          id: contraloriaRegId,
          email: contraloriaRegEmail,
          role: 'contraloria',
          sucursal: hub,
        },
      ]) {
        authByToken.set(actor.token, actor);
        profilesById.set(actor.id, {
          id: actor.id,
          email: actor.email,
          role: actor.role,
          sucursal: actor.sucursal,
          is_active: true,
        });
      }

      staffById.set(promotoraStaffId, {
        id: promotoraStaffId,
        name: `Promotora ${hub}`,
        role: 'Promotora Fija',
        email: promotoraEmail,
        auth_user_id: promotoraUid,
        sucursal: hub,
        status: JSON.stringify({ status: 'Activo', category: 'fija', assignedLocation: `PDV ${hub}` }),
      });

      clientesTable.set(clienteId, {
        id: clienteId,
        codigo_cliente: `CLI-${hub}-01`,
        rif: `J-4000000${idx + 1}-0`,
        razon_social: `AUTOMERCADOS ${hub} C.A.`,
        nombre_comercial: `PDV ${hub}`,
        canal: 'Supermercado',
        zona: hub,
        ciudad: HUB_TERRITORY_SAMPLES[hub][2],
        estado: hub,
        sucursal: hub,
        radio_geocerca_m: 150,
        activo: true,
        metadata: {},
        created_at: '2026-11-19T10:00:00Z',
        updated_at: '2026-11-19T10:00:00Z',
      });

      rutasTable.push({
        id: hubUuid('75000000', idx, 12),
        promotora_id: promotoraStaffId,
        cliente_nombre: `PDV ${hub}`,
        fecha: '2026-11-20',
        turno: 'MAÑANA',
        estado_ruta: 'ASIGNADA',
        sucursal: hub,
      });

      presupuestosTable.push({
        id: hubUuid('76000000', idx, 13),
        campana_id: null,
        periodo_ym: '2026-11',
        categoria: `Presupuesto BTL ${hub}`,
        monto_asignado_usd: 2500 + idx * 100,
        monto_comprometido_usd: 400,
        monto_ejecutado_usd: 150,
        activo: true,
        observaciones: `Hub ${hub}`,
        sucursal: hub,
        created_at: '2026-11-19T10:00:00Z',
        updated_at: '2026-11-19T10:00:00Z',
      });

      solicitudesMp07Table.push({
        id: hubUuid('77000000', idx, 14),
        codigo_correlativo: mp07Code,
        para_ser_utilizado: `DEGUSTACION ${hub}`,
        estado: 'PENDIENTE_APROBACION',
        sucursal: hub,
      });

      conciliacionesById.set(conciliacionId, {
        id: conciliacionId,
        requisicion_id: requisicionId,
        cerrada: false,
        sucursal: hub,
      });

      facturasById.set(facturaId, {
        id: facturaId,
        conciliacion_id: conciliacionId,
        requisicion_id: requisicionId,
        numero_factura: `FAC-${hub}-001`,
        rif_proveedor: `J-5000000${idx + 1}-1`,
        razon_social_proveedor: `Proveedor ${hub}`,
        concepto: 'Insumos BTL',
        subtotal_usd: 50,
        impuesto_usd: 8,
        total_usd: 58,
        storage_bucket: CONTRALORIA_FACTURAS_BUCKET_ID,
        storage_path: `facturas/${hub}/${requisicionId}/${facturaId}.pdf`,
        mime_type: 'application/pdf',
        tamano_bytes: VALID_PDF.byteLength,
        archivo_sha256_hex: 'a'.repeat(64),
        validada_contraloria: false,
        notas_validacion: null,
        sucursal: hub,
        created_at: '2026-11-19T10:00:00Z',
      });

      incidenciasById.set(incidenciaId, {
        id: incidenciaId,
        codigo_incidencia: `INC-${hub}-01`,
        cliente_id: clienteId,
        pdv_nombre: `PDV ${hub}`,
        ruta_id: null,
        reportado_por_uid: promotoraUid,
        reportado_por_nombre: `Promotora ${hub}`,
        responsable_uid: coordId,
        responsable_nombre: `Coordinación ${hub}`,
        tipo_incidencia: 'QUIEBRE_STOCK',
        severidad: 'ALTA',
        descripcion: `Quiebre en ${hub}`,
        estado: 'ABIERTA',
        sla_horas: 12,
        sla_vence_en: '2026-11-20T00:00:00Z',
        resuelta_en: null,
        notas_resolucion: '',
        foto_storage_bucket: INCIDENCIAS_PRIVATE_BUCKET_ID,
        foto_storage_path: `incidencias/${hub}/2026-11-19/${incidenciaId}.jpg`,
        foto_mime_type: 'image/jpeg',
        foto_sha256_hex: 'b'.repeat(64),
        sucursal: hub,
        created_at: '2026-11-19T10:00:00Z',
        updated_at: '2026-11-19T10:00:00Z',
      });

      asistenciaById.set(evidenciaAsistenciaId, {
        id: evidenciaAsistenciaId,
        storage_path: `asistencia/2026-11-19/${promotoraStaffId}/JORNADA_INGRESO.png`,
        promotoraId: promotoraStaffId,
        sucursal: hub,
      });

      fixtures.set(hub, {
        hub,
        coordId,
        coordToken,
        vendedorId,
        vendedorToken,
        promotoraUid,
        promotoraStaffId,
        promotoraToken,
        contraloriaRegId,
        contraloriaRegToken,
        clienteId,
        requisicionId,
        conciliacionId,
        facturaId,
        incidenciaId,
        evidenciaAsistenciaId,
        mp07Code,
      });
    });

    const recordedActiveHeaders: string[] = [];

    // Mock Supabase Server (Auth + PostgREST con RLS simulada por hub + x-sucursal-activa)
    const mockSupabase = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const rawText = Buffer.concat(chunks).toString('utf8');
      const body = rawText ? JSON.parse(rawText) : {};
      res.setHeader('Content-Type', 'application/json');

      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const activeHeaderRaw = String(req.headers['x-sucursal-activa'] || '').trim();
      if (activeHeaderRaw) {
        recordedActiveHeaders.push(activeHeaderRaw);
      }

      if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
        const actor = authByToken.get(bearer);
        if (!actor) {
          res.statusCode = 401;
          res.end(JSON.stringify({ message: 'Invalid JWT' }));
          return;
        }
        res.end(
          JSON.stringify({
            id: actor.id,
            email: actor.email,
            app_metadata: {
              role: actor.role,
              app_role: actor.role,
              sucursal: actor.sucursal,
              ...(actor.staffId ? { staff_id: actor.staffId } : {}),
            },
          })
        );
        return;
      }

      if (url.pathname === '/rest/v1/profiles') {
        const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
        res.end(JSON.stringify(profilesById.get(idEq) ?? null));
        return;
      }

      if (url.pathname === '/rest/v1/staff') {
        if (req.method === 'GET') {
          const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
          if (idEq) {
            res.end(JSON.stringify(staffById.get(idEq) ?? null));
            return;
          }
          const authEq = (url.searchParams.get('auth_user_id') || '').replace(/^eq\./, '');
          if (authEq) {
            const match =
              [...staffById.values()].find((r) => String(r.auth_user_id) === authEq) ?? null;
            res.end(JSON.stringify(match));
            return;
          }
        }
        if (req.method === 'PATCH') {
          const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
          const cur = staffById.get(idEq);
          if (cur) {
            const next = { ...cur, ...body };
            staffById.set(idEq, next);
            res.end(JSON.stringify(next));
            return;
          }
        }
        res.end('null');
        return;
      }

      if (url.pathname.startsWith('/auth/v1/admin/users')) {
        if (req.method === 'PUT' || req.method === 'POST') {
          const idFromPath = url.pathname.split('/').pop();
          const uid =
            idFromPath && idFromPath !== 'users' ? idFromPath : crypto.randomUUID();
          res.end(
            JSON.stringify({
              user: { id: uid, email: body.email, app_metadata: body.app_metadata },
            })
          );
          return;
        }
      }

      if (req.method === 'POST' && url.pathname === '/rest/v1/profiles') {
        res.statusCode = 201;
        res.end(JSON.stringify([body]));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/admin_finalize_created_user') {
        res.end(
          JSON.stringify([
            {
              id: body.p_target_user_id,
              email: 'corp@codizulca.com',
              full_name: body.p_full_name,
              role: body.p_role,
              sucursal: body.p_sucursal,
              is_active: true,
              must_change_password: Boolean(body.p_must_change_password),
              created_at: '2026-11-19T10:00:00Z',
              updated_at: '2026-11-19T10:00:00Z',
            },
          ])
        );
        return;
      }

      // Resolver contexto RLS `obtener_sucursal_contexto_activo()` para tablas operativas/maestras
      const caller = authByToken.get(bearer);
      if (!caller) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: '42501', message: 'JWT required' }));
        return;
      }

      const activeContextSucursal: string =
        caller.sucursal === 'GLOBAL'
          ? normalizeServerSucursal(activeHeaderRaw) ?? 'GLOBAL'
          : caller.sucursal;

      const canSeeRow = (rowSucursal: unknown) =>
        activeContextSucursal === 'GLOBAL' || String(rowSucursal) === activeContextSucursal;

      if (url.pathname === '/rest/v1/clientes') {
        if (req.method === 'GET') {
          const visible = [...clientesTable.values()].filter((r) => canSeeRow(r.sucursal));
          res.end(JSON.stringify(visible));
          return;
        }
        if (req.method === 'POST' || req.method === 'PATCH') {
          const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
          const existing = idEq ? clientesTable.get(idEq) : null;
          if (idEq && (!existing || !canSeeRow(existing.sucursal))) {
            res.statusCode = 403;
            res.end(
              JSON.stringify({
                code: '42501',
                message: 'RLS_CROSS_HUB_DENIED: new row violates row-level security policy for table "clientes"',
              })
            );
            return;
          }
          const targetBranch = String(body.sucursal ?? existing?.sucursal ?? activeContextSucursal);
          if (targetBranch === 'GLOBAL' || !canSeeRow(targetBranch)) {
            res.statusCode = 403;
            res.end(
              JSON.stringify({
                code: '42501',
                message: 'RLS_CROSS_HUB_DENIED: sucursal fuera del hub autorizado',
              })
            );
            return;
          }
          const saved = {
            ...(existing ?? { id: crypto.randomUUID(), activo: true, metadata: {} }),
            ...body,
            sucursal: targetBranch,
          };
          clientesTable.set(String(saved.id), saved);
          res.statusCode = req.method === 'POST' ? 201 : 200;
          res.end(JSON.stringify(saved));
          return;
        }
      }

      if (url.pathname === '/rest/v1/rutas_promotoras' && req.method === 'GET') {
        res.end(JSON.stringify(rutasTable.filter((r) => canSeeRow(r.sucursal))));
        return;
      }

      if (url.pathname === '/rest/v1/solicitudes_contraloria' && req.method === 'GET') {
        res.end(JSON.stringify(solicitudesMp07Table.filter((r) => canSeeRow(r.sucursal))));
        return;
      }

      if (url.pathname === '/rest/v1/presupuestos_trade') {
        if (req.method === 'GET') {
          res.end(JSON.stringify(presupuestosTable.filter((r) => canSeeRow(r.sucursal))));
          return;
        }
        if (req.method === 'POST' || req.method === 'PATCH') {
          if (caller.role === 'contraloria') {
            res.statusCode = 403;
            res.end(JSON.stringify({ code: '42501', message: 'FORBIDDEN_READ_ONLY_ROLE' }));
            return;
          }
          const targetBranch = String(body.sucursal ?? activeContextSucursal);
          if (targetBranch === 'GLOBAL' || !canSeeRow(targetBranch)) {
            res.statusCode = 403;
            res.end(JSON.stringify({ code: '42501', message: 'FORBIDDEN_BRANCH' }));
            return;
          }
          const row = {
            id: crypto.randomUUID(),
            ...body,
            sucursal: targetBranch,
            created_at: '2026-11-19T10:00:00Z',
            updated_at: '2026-11-19T10:00:00Z',
          };
          presupuestosTable.push(row);
          res.statusCode = 201;
          res.end(JSON.stringify(row));
          return;
        }
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not mocked' }));
    });

    await new Promise<void>((r) => mockSupabase.listen(0, '127.0.0.1', r));
    const supaPort = (mockSupabase.address() as AddressInfo).port;
    const supaUrl = `http://127.0.0.1:${supaPort}`;

    const prevEnv = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    process.env.SUPABASE_URL = supaUrl;
    process.env.SUPABASE_PUBLISHABLE_KEY = MOCK_PUBLIC_ANON_KEY;
    process.env.SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;

    // Gateways para los handlers Express bajo prueba
    const fdvGateway: FdvSolicitudesGateway = {
      async findActiveByKey(_user: AuthenticatedServerUser, key: string) {
        return fdvSurveysByKey.get(key) ?? null;
      },
      async insertSolicitud(_user: AuthenticatedServerUser, record: PersistFdvSurveyRecord) {
        if (fdvSurveysByKey.has(record.degustacion_key)) return { status: 'conflict' };
        const row: StoredFdvSurveyRow = { id: crypto.randomUUID(), ...record, en_historial: false };
        fdvSurveysByKey.set(record.degustacion_key, row);
        return { status: 'inserted', row };
      },
      async updateSolicitud(_user, id, record) {
        const row: StoredFdvSurveyRow = {
          id,
          autor_user_id: _user.id,
          ...record,
        };
        fdvSurveysByKey.set(record.degustacion_key, row);
        return row;
      },
    };

    const incidenciasGateway: IncidenciasEvidencesGateway = {
      async uploadPrivateObject() {},
      async deletePrivateObjects() {},
      async insertIncidenciaRow(params) {
        const row: IncidenciaPdvDbRow = {
          id: crypto.randomUUID(),
          codigo_incidencia: `INC-${params.sucursal}-NEW`,
          cliente_id: params.clienteId,
          pdv_nombre: params.pdvNombre,
          ruta_id: params.rutaId,
          reportado_por_uid: params.reportadoPorUid,
          reportado_por_nombre: params.reportadoPorNombre,
          responsable_uid: null,
          responsable_nombre: params.responsableNombre,
          tipo_incidencia: params.tipoIncidencia,
          severidad: params.severidad,
          descripcion: params.descripcion,
          estado: 'ABIERTA',
          sla_horas: params.slaHoras,
          sla_vence_en: params.slaVenceEnIso,
          resuelta_en: null,
          notas_resolucion: '',
          foto_storage_bucket: params.storageBucket,
          foto_storage_path: params.storagePath,
          foto_mime_type: params.mimeType,
          foto_sha256_hex: params.sha256Hex,
          sucursal: params.sucursal,
          created_at: '2026-11-19T12:00:00Z',
          updated_at: '2026-11-19T12:00:00Z',
        };
        incidenciasById.set(row.id, row);
        return row;
      },
      async findIncidenciasByIds(ids) {
        return ids
          .map((id) => incidenciasById.get(id))
          .filter((r): r is IncidenciaPdvDbRow => Boolean(r));
      },
      async createSignedUrls(_bucket, paths) {
        return Object.fromEntries(paths.map((p) => [p, `http://127.0.0.1/signed/${p}`]));
      },
    };

    const facturasGateway: ContraloriaInvoicesGateway = {
      async lookupConciliacion(concId) {
        return conciliacionesById.get(concId) ?? null;
      },
      async uploadPrivateInvoiceObject() {},
      async deletePrivateInvoiceObjects() {},
      async insertFiscalReceiptRow(params) {
        const row: ContraloriaInvoiceDbRow = {
          id: crypto.randomUUID(),
          conciliacion_id: params.conciliacionId,
          requisicion_id: params.requisicionId,
          numero_factura: params.numeroFactura,
          rif_proveedor: params.rifProveedor,
          razon_social_proveedor: params.razonSocialProveedor,
          concepto: params.concepto,
          subtotal_usd: params.subtotalUsd,
          impuesto_usd: params.impuestoUsd,
          total_usd: params.totalUsd,
          storage_bucket: params.storageBucket,
          storage_path: params.storagePath,
          mime_type: params.mimeType,
          tamano_bytes: params.tamanoBytes,
          archivo_sha256_hex: params.archivoSha256Hex,
          validada_contraloria: false,
          notas_validacion: null,
          sucursal: params.sucursal,
          created_at: '2026-11-19T12:00:00Z',
        };
        facturasById.set(row.id, row);
        return row;
      },
      async findInvoicesByIds(ids) {
        return ids
          .map((id) => facturasById.get(id))
          .filter((r): r is ContraloriaInvoiceDbRow => Boolean(r));
      },
      async createSignedUrls(_bucket, paths) {
        return Object.fromEntries(paths.map((p) => [p, `http://127.0.0.1/signed/${p}`]));
      },
    };

    const attendanceGateway: AttendancePersistenceGateway = {
      async lookupStaffProfile(promotoraId) {
        const s = staffById.get(promotoraId);
        if (!s) return null;
        return {
          id: String(s.id),
          name: String(s.name),
          email: String(s.email),
          assignedStore: `PDV ${s.sucursal}`,
          address: String(s.sucursal),
          sucursal: s.sucursal as OperativeSucursal,
          active: true,
          isMerchandising: false,
          masterProfile: 'FIJA',
        };
      },
      async findJornadaByDateAndPromotora() {
        return null;
      },
      async createJornadaIfAbsent(params) {
        return {
          id: crypto.randomUUID(),
          fecha_jornada: params.fechaJornada,
          promotora_id: params.promotoraId,
          promotora_nombre: params.promotoraNombre,
          perfil_aplicado: params.perfilAplicado,
          pdv_nombre: params.pdvNombre,
          zona: params.zona,
          sucursal: params.sucursal ?? null,
          opened_at_server: params.openedAtServerIso,
          updated_at_server: params.openedAtServerIso,
          opened_by_uid: params.openedByUid,
        };
      },
      async listEvidencesByJornadaId() {
        return [];
      },
      async upsertSlotEvidence(params) {
        return {
          id: crypto.randomUUID(),
          asistencia_id: params.asistenciaId,
          slot_foto: params.slotFoto,
          storage_bucket: params.storageBucket,
          storage_path: params.storagePath,
          mime_type: params.mimeType,
          tamano_bytes: params.sizeBytes,
          sha256_hex: params.sha256Hex,
          ancho_px: null,
          alto_px: null,
          pdv_nombre: params.pdvNombre,
          lat: null,
          lng: null,
          gps_accuracy: null,
          sucursal: params.sucursal ?? null,
          capturado_en_servidor: params.capturadoEnServidorIso,
          cargado_por_uid: params.cargadoPorUid,
          cargado_por_rol: params.cargadoPorRol,
        };
      },
      async uploadPrivateObject() {},
      async deletePrivateObjects() {},
      async createSignedUrls(_bucket, paths) {
        return Object.fromEntries(paths.map((p) => [p, `http://127.0.0.1/signed/${p}`]));
      },
      async findEvidencesWithOwnerByIds(ids) {
        return ids
          .map((id) => asistenciaById.get(id))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .map((item) => ({
            evidencia: {
              id: item.id,
              asistencia_id: crypto.randomUUID(),
              slot_foto: 'JORNADA_INGRESO' as const,
              storage_bucket: 'asistencia-evidencias',
              storage_path: item.storage_path,
              mime_type: 'image/png' as const,
              tamano_bytes: VALID_TINY_PNG.byteLength,
              sha256_hex: 'c'.repeat(64),
              ancho_px: null,
              alto_px: null,
              pdv_nombre: `PDV ${item.sucursal}`,
              lat: null,
              lng: null,
              gps_accuracy: null,
              sucursal: item.sucursal,
              capturado_en_servidor: '2026-11-19T12:00:00Z',
              cargado_por_uid: null,
              cargado_por_rol: 'promotora' as const,
            },
            promotoraId: item.promotoraId,
            sucursal: item.sucursal,
          }));
      },
    };

    const contraloriaHandlers = createContraloriaInvoicesHandlers({
      resolveGateway: () => facturasGateway,
    });
    const attendanceHandlers = createAttendanceEvidencesHandlers({
      resolveGateway: () => attendanceGateway,
      now: () => new Date('2026-11-19T15:00:00Z'),
    });

    const app = express();
    const highLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 5000 });
    app.post(
      '/api/admin/staff-auth',
      express.json(),
      requireCoordinatorOrAdminAuth,
      highLimit,
      handleProvisionStaffAuth
    );
    app.post(
      '/api/admin/corporate-users',
      express.json(),
      requireSuperAdminAuth,
      highLimit,
      handleCreateCorporateUser
    );
    app.post(
      '/api/fdv/solicitudes-degustacion',
      express.json(),
      requireFdvOrTradeAuth,
      highLimit,
      createFdvSolicitudesHandler(fdvGateway)
    );
    app.post(
      '/api/incidencias/evidencias',
      requireIncidenciaActorAuth,
      highLimit,
      express.raw({ type: '*/*', limit: '6mb' }),
      createUploadIncidenciaEvidenceHandler(() => incidenciasGateway)
    );
    app.post(
      '/api/incidencias/evidencias/signed-urls',
      express.json(),
      requireIncidenciaActorAuth,
      highLimit,
      createBatchIncidenciaSignedUrlsHandler(() => incidenciasGateway)
    );
    app.post(
      '/api/contraloria/facturas/upload',
      requireTorreControlAuth,
      highLimit,
      express.raw({ type: '*/*', limit: '11mb' }),
      contraloriaHandlers.handleUploadFiscalReceipt
    );
    app.post(
      '/api/contraloria/facturas/signed-urls',
      express.json(),
      requireTorreControlAuth,
      highLimit,
      contraloriaHandlers.handleBatchFiscalReceiptSignedUrls
    );
    app.post(
      '/api/asistencia/evidencias',
      requireAttendanceActorAuth,
      highLimit,
      express.raw({ type: '*/*', limit: '6mb' }),
      attendanceHandlers.handleUploadEvidence
    );
    app.post(
      '/api/asistencia/evidencias/signed-urls',
      express.json(),
      requireAttendanceActorAuth,
      highLimit,
      attendanceHandlers.handleBatchSignedUrls
    );

    const apiServer = http.createServer(app);
    await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
    const apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
    const validDate = futureCaracasDate(4);

    try {
      let crossPairsVerified = 0;

      // 3.A) Recorrido exhaustivo de los 25 pares (5 intra-hub + 20 pares cruzados hubA !== hubB)
      for (const hubA of OPERATIVE_SUCURSALES) {
        const fixA = fixtures.get(hubA)!;
        const scopedClientA = createUserScopedSupabaseClient(
          fixA.coordToken
        ) as unknown as SupabaseClient<MasterDataDatabase>;
        assert.ok(scopedClientA);

        // Lecturas de hubA aisladas estrictamente a su propia región
        invalidarCacheMaestros();
        const ownClients = await obtenerClientesMaestros(
          { incluirVendedor: false, forzarRefresco: true },
          scopedClientA
        );
        assert.equal(ownClients.length, 1);
        assert.equal(ownClients[0]!.sucursal, hubA);

        const { data: ownRutas } = await scopedClientA.from('rutas_promotoras' as never).select('*');
        assert.equal((ownRutas as Array<{ sucursal: string }>).length, 1);
        assert.equal((ownRutas as Array<{ sucursal: string }>)[0]!.sucursal, hubA);

        const ownBudgets = await fetchPresupuestosTrade(scopedClientA as unknown as SupabaseClient);
        assert.equal(ownBudgets.length, 1);
        assert.equal(ownBudgets[0]!.sucursal, hubA);

        const { data: ownMp07 } = await scopedClientA
          .from('solicitudes_contraloria' as never)
          .select('*');
        assert.equal((ownMp07 as Array<{ codigo_correlativo: string }>).length, 1);
        assert.equal(
          (ownMp07 as Array<{ codigo_correlativo: string }>)[0]!.codigo_correlativo,
          fixA.mp07Code
        );

        for (const hubB of OPERATIVE_SUCURSALES) {
          const fixB = fixtures.get(hubB)!;

          if (hubA === hubB) {
            // Operación legítima dentro del mismo hub -> PERMITIDA
            const okFdv = await fetch(`${apiBase}/api/fdv/solicitudes-degustacion`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${fixA.vendedorToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                degustacionId: `deg-own-${hubA.toLowerCase()}`,
                clienteNombre: `PDV ${hubA}`,
                fecha: validDate,
                productos: ['MORTADELA ASTURIAS'],
                sucursal: hubA,
              }),
            });
            assert.equal(okFdv.status, 201);
            continue;
          }

          crossPairsVerified += 1;

          // (1) Clientes / PDVs: sesión de hubA NO ve ni puede editar el cliente de hubB
          assert.equal(
            ownClients.some((c) => c.id === fixB.clienteId || c.sucursal === hubB),
            false,
            `${hubA} jamás debe leer clientes de ${hubB}`
          );
          await assert.rejects(
            () =>
              guardarClienteMaestro(
                {
                  id: fixB.clienteId,
                  codigo_cliente: `CLI-${hubB}-HACK`,
                  razon_social: 'Intento Cruce',
                  sucursal: hubB,
                },
                scopedClientA
              ),
            /RLS_CROSS_HUB_DENIED|No se pudo guardar/i
          );

          // (2) Promotoras (`POST /api/admin/staff-auth` y `/api/asistencia/evidencias*`): 403 FORBIDDEN_BRANCH
          const crossStaffAuth = await fetch(`${apiBase}/api/admin/staff-auth`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixA.coordToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              staffId: fixB.promotoraStaffId,
              name: `Promotora ${hubB}`,
              appRole: 'promotora',
            }),
          });
          assert.equal(crossStaffAuth.status, 403, `staff-auth ${hubA} -> ${hubB} debe ser 403`);
          assert.equal(((await crossStaffAuth.json()) as { code: string }).code, 'FORBIDDEN_BRANCH');

          const crossAsistSigned = await fetch(`${apiBase}/api/asistencia/evidencias/signed-urls`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixA.coordToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ evidenciaIds: [fixB.evidenciaAsistenciaId] }),
          });
          assert.equal(crossAsistSigned.status, 403);
          assert.equal(((await crossAsistSigned.json()) as { code: string }).code, 'FORBIDDEN_BRANCH');

          // (3) Rutas / Solicitudes FDV (`POST /api/fdv/solicitudes-degustacion`): 403 FORBIDDEN_BRANCH en body y header
          const crossFdvBody = await fetch(`${apiBase}/api/fdv/solicitudes-degustacion`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixA.vendedorToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              clienteNombre: `PDV ${hubB}`,
              fecha: validDate,
              productos: ['MORTADELA'],
              sucursal: hubB,
            }),
          });
          assert.equal(crossFdvBody.status, 403, `FDV body ${hubA} -> ${hubB} debe ser 403`);
          assert.equal(((await crossFdvBody.json()) as { code: string }).code, 'FORBIDDEN_BRANCH');

          const crossFdvHeader = await fetch(`${apiBase}/api/fdv/solicitudes-degustacion`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixA.vendedorToken}`,
              'Content-Type': 'application/json',
              'x-sucursal-activa': hubB,
            },
            body: JSON.stringify({
              clienteNombre: `PDV ${hubB}`,
              fecha: validDate,
              productos: ['MORTADELA'],
            }),
          });
          assert.equal(crossFdvHeader.status, 403, `FDV header ${hubA} -> ${hubB} debe ser 403`);
          assert.equal(((await crossFdvHeader.json()) as { code: string }).code, 'FORBIDDEN_BRANCH');

          // (4) Incidencias / Fotos firmadas (`/api/incidencias/evidencias*`): 403 en carga/header y 0 URLs cruzadas
          const crossIncUpload = await fetch(`${apiBase}/api/incidencias/evidencias`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixA.promotoraToken}`,
              'Content-Type': 'image/jpeg',
              'x-incidencia-meta': encodeBase64Json({
                pdvNombre: `PDV ${hubB}`,
                tipoIncidencia: 'QUIEBRE_STOCK',
                severidad: 'ALTA',
                descripcion: `Intento cruzado ${hubA} -> ${hubB}`,
                sucursal: hubB,
              }),
            },
            body: VALID_JPEG,
          });
          assert.equal(crossIncUpload.status, 403, `Incidencia ${hubA} -> ${hubB} debe ser 403`);
          assert.equal(((await crossIncUpload.json()) as { code: string }).code, 'FORBIDDEN_BRANCH');

          const crossIncSigned = await fetch(`${apiBase}/api/incidencias/evidencias/signed-urls`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixA.coordToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ incidenciaIds: [fixA.incidenciaId, fixB.incidenciaId] }),
          });
          assert.equal(crossIncSigned.status, 200);
          const incSignedBody = (await crossIncSigned.json()) as {
            signedUrls: Record<string, string>;
          };
          assert.ok(incSignedBody.signedUrls[fixA.incidenciaId], `${hubA} ve su propia incidencia`);
          assert.equal(
            incSignedBody.signedUrls[fixB.incidenciaId],
            undefined,
            `${hubA} recibe 0 URLs firmadas de incidencias de ${hubB}`
          );

          const crossIncHeaderSigned = await fetch(
            `${apiBase}/api/incidencias/evidencias/signed-urls`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${fixA.coordToken}`,
                'Content-Type': 'application/json',
                'x-sucursal-activa': hubB,
              },
              body: JSON.stringify({ incidenciaIds: [fixB.incidenciaId] }),
            }
          );
          assert.equal(crossIncHeaderSigned.status, 403);
          assert.equal(
            ((await crossIncHeaderSigned.json()) as { code: string }).code,
            'FORBIDDEN_BRANCH'
          );

          // (5) Comprobantes Fiscales, Presupuestos y MP-07-XXXX (`/api/contraloria/facturas/*`): 403 y 0 URLs cruzadas
          const crossInvoiceUpload = await fetch(`${apiBase}/api/contraloria/facturas/upload`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixA.coordToken}`,
              'Content-Type': 'application/pdf',
              'x-factura-meta': encodeBase64Json({
                requisicionId: fixB.requisicionId,
                conciliacionId: fixB.conciliacionId,
                invoiceNumber: `FAC-CROSS-${hubA}-${hubB}`,
                supplierRif: 'J-30111222-3',
                supplierName: 'Proveedor Externo',
                concept: 'Intento cruce fiscal',
                subtotalUsd: 40,
                taxAmountUsd: 6.4,
                totalUsd: 46.4,
              }),
            },
            body: VALID_PDF,
          });
          assert.equal(crossInvoiceUpload.status, 403, `Factura ${hubA} -> ${hubB} debe ser 403`);
          assert.equal(
            ((await crossInvoiceUpload.json()) as { code: string }).code,
            'FORBIDDEN_BRANCH'
          );

          const crossInvoiceSigned = await fetch(`${apiBase}/api/contraloria/facturas/signed-urls`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${fixA.contraloriaRegToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ facturaIds: [fixA.facturaId, fixB.facturaId] }),
          });
          assert.equal(crossInvoiceSigned.status, 200);
          const invSignedBody = (await crossInvoiceSigned.json()) as {
            urls: Record<string, string>;
          };
          assert.ok(invSignedBody.urls[fixA.facturaId], `${hubA} ve su propia factura`);
          assert.equal(
            invSignedBody.urls[fixB.facturaId],
            undefined,
            `${hubA} recibe 0 URLs firmadas de facturas de ${hubB}`
          );

          await assert.rejects(
            () =>
              upsertPresupuestoTrade(
                {
                  periodo_ym: '2026-11',
                  categoria: `Cruce ${hubA}->${hubB}`,
                  monto_asignado_usd: 1000,
                  sucursal: hubB,
                },
                scopedClientA as unknown as SupabaseClient
              ),
            /FORBIDDEN_BRANCH|No se pudo guardar/i
          );
        }
      }

      assert.equal(
        crossPairsVerified,
        20,
        'Deben haberse verificado exactamente los 20 pares cruzados hubA !== hubB'
      );

      // 3.B) Actores Nacionales (`super_admin` y `contraloria` con `GLOBAL`):
      //      - Bloqueo de escrituras operativas ambiguas sin hub activo (`400 BRANCH_REQUIRED`)
      const adminFdvAmbiguous = await fetch(`${apiBase}/api/fdv/solicitudes-degustacion`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clienteNombre: 'PDV NACIONAL SIN SEDE',
          fecha: validDate,
          productos: ['MORTADELA'],
        }),
      });
      assert.equal(adminFdvAmbiguous.status, 400);
      assert.equal(((await adminFdvAmbiguous.json()) as { code: string }).code, 'BRANCH_REQUIRED');

      const adminIncAmbiguous = await fetch(`${apiBase}/api/incidencias/evidencias`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          'Content-Type': 'image/jpeg',
          'x-incidencia-meta': encodeBase64Json({
            pdvNombre: 'PDV NACIONAL SIN SEDE',
            tipoIncidencia: 'QUIEBRE_STOCK',
            severidad: 'MEDIA',
            descripcion: 'Sin hub explícito',
          }),
        },
        body: VALID_JPEG,
      });
      assert.equal(adminIncAmbiguous.status, 400);
      assert.equal(((await adminIncAmbiguous.json()) as { code: string }).code, 'BRANCH_REQUIRED');

      for (const nationalTok of [superAdminToken, contraloriaGlobalToken]) {
        const invAmbiguous = await fetch(`${apiBase}/api/contraloria/facturas/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${nationalTok}`,
            'Content-Type': 'application/pdf',
            'x-factura-meta': encodeBase64Json({
              requisicionId: unscopedReqId,
              conciliacionId: unscopedConcId,
              invoiceNumber: 'FAC-AMBIGUA-01',
              supplierRif: 'J-30111222-3',
              supplierName: 'Proveedor Nacional',
              concept: 'Sin hub activo',
              subtotalUsd: 10,
              taxAmountUsd: 1.6,
              totalUsd: 11.6,
            }),
          },
          body: VALID_PDF,
        });
        assert.equal(invAmbiguous.status, 400);
        assert.equal(((await invAmbiguous.json()) as { code: string }).code, 'BRANCH_REQUIRED');
      }

      //      - Permitido para `super_admin` al seleccionar explícitamente cualquiera de los 5 hubs (`x-sucursal-activa` / `sucursal`)
      for (const hub of OPERATIVE_SUCURSALES) {
        const fix = fixtures.get(hub)!;

        // FDV vía cabecera `x-sucursal-activa`
        const fdvOk = await fetch(`${apiBase}/api/fdv/solicitudes-degustacion`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${superAdminToken}`,
            'Content-Type': 'application/json',
            'x-sucursal-activa': hub,
          },
          body: JSON.stringify({
            degustacionId: `deg-admin-hdr-${hub.toLowerCase()}`,
            clienteNombre: `PDV ${hub} NACIONAL`,
            fecha: validDate,
            productos: ['ESPALDA AHUMADA'],
          }),
        });
        assert.equal(fdvOk.status, 201, `super_admin con x-sucursal-activa=${hub} debe insertar FDV`);
        const fdvBody = (await fdvOk.json()) as { solicitud: StoredFdvSurveyRow };
        assert.equal(fdvBody.solicitud.sucursal, hub);

        // Incidencia vía `x-sucursal-activa`
        const incOk = await fetch(`${apiBase}/api/incidencias/evidencias`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${superAdminToken}`,
            'Content-Type': 'image/jpeg',
            'x-sucursal-activa': hub,
            'x-incidencia-meta': encodeBase64Json({
              pdvNombre: `PDV ${hub}`,
              tipoIncidencia: 'MATERIAL_POP_DANADO',
              severidad: 'BAJA',
              descripcion: `Reporte admin en ${hub}`,
            }),
          },
          body: VALID_JPEG,
        });
        assert.equal(incOk.status, 201);
        const incBody = (await incOk.json()) as { incidencia: IncidenciaPdvDbRow };
        assert.equal(incBody.incidencia.sucursal, hub);
        assert.match(String(incBody.incidencia.foto_storage_path), new RegExp(`^incidencias/${hub}/`));

        // Factura fiscal vía `x-sucursal-activa` (tanto super_admin como contraloria con hub explícito)
        const invOk = await fetch(`${apiBase}/api/contraloria/facturas/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${contraloriaGlobalToken}`,
            'Content-Type': 'application/pdf',
            'x-sucursal-activa': hub,
            'x-factura-meta': encodeBase64Json({
              requisicionId: fix.requisicionId,
              conciliacionId: fix.conciliacionId,
              invoiceNumber: `FAC-NAC-${hub}`,
              supplierRif: 'J-30999888-7',
              supplierName: `Proveedor Fiscal ${hub}`,
              concept: 'Soporte fiscal auditado',
              subtotalUsd: 25,
              taxAmountUsd: 4,
              totalUsd: 29,
            }),
          },
          body: VALID_PDF,
        });
        assert.equal(invOk.status, 201);
        const invBody = (await invOk.json()) as { factura: ContraloriaInvoiceDbRow };
        assert.equal(invBody.factura.sucursal, hub);
        assert.match(String(invBody.factura.storage_path), new RegExp(`^facturas/${hub}/`));

        // Creación de usuario corporativo en cualquiera de los 5 hubs
        const corpUserOk = await fetch(`${apiBase}/api/admin/corporate-users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${superAdminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fullName: `Coordinador ${hub}`,
            email: `nuevo.coord.${hub.toLowerCase()}@codizulca.com`,
            password: 'PasswordSegura123!',
            role: 'coordinacion',
            sucursal: HUB_TERRITORY_SAMPLES[hub][2], // alias territorial
          }),
        });
        assert.equal(corpUserOk.status, 201);
        const corpUserJson = (await corpUserOk.json()) as { profile: { sucursal: string } };
        assert.equal(corpUserJson.profile.sucursal, hub);

        // `createUserScopedSupabaseClient` con `x-sucursal-activa` acota consultas de GLOBAL a ese único hub
        const adminScopedToHub = createUserScopedSupabaseClient(
          superAdminToken,
          hub
        ) as unknown as SupabaseClient<MasterDataDatabase>;
        invalidarCacheMaestros();
        const hubOnlyClients = await obtenerClientesMaestros(
          { incluirVendedor: false, forzarRefresco: true },
          adminScopedToHub
        );
        assert.equal(hubOnlyClients.length, 1);
        assert.equal(hubOnlyClients[0]!.sucursal, hub);
      }

      assert.ok(
        OPERATIVE_SUCURSALES.every((h) => recordedActiveHeaders.includes(h)),
        'createUserScopedSupabaseClient debe propagar x-sucursal-activa para los 5 hubs'
      );

      // 3.C) Segregación de Funciones de `contraloria` (`GLOBAL`):
      //      bloqueada en mutaciones operativas (`403 FORBIDDEN_READ_ONLY_ROLE`) y autorizada en lectura de URLs firmadas (`200`)
      const contraloriaIncMut = await fetch(`${apiBase}/api/incidencias/evidencias`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${contraloriaGlobalToken}`,
          'Content-Type': 'image/jpeg',
          'x-sucursal-activa': 'CENTRO',
          'x-incidencia-meta': encodeBase64Json({
            pdvNombre: 'PDV CENTRO',
            tipoIncidencia: 'OTRO',
            severidad: 'BAJA',
            descripcion: 'Intento mutación contraloría',
            sucursal: 'CENTRO',
          }),
        },
        body: VALID_JPEG,
      });
      assert.equal(contraloriaIncMut.status, 403);
      assert.equal(
        ((await contraloriaIncMut.json()) as { code: string }).code,
        'FORBIDDEN_READ_ONLY_ROLE'
      );

      // Contraloría lee URLs firmadas de los 5 hubs sin 403
      const allIncidenciaIds = OPERATIVE_SUCURSALES.map((h) => fixtures.get(h)!.incidenciaId);
      const allFacturaIds = OPERATIVE_SUCURSALES.map((h) => fixtures.get(h)!.facturaId);
      const allAsistenciaIds = OPERATIVE_SUCURSALES.map(
        (h) => fixtures.get(h)!.evidenciaAsistenciaId
      );

      const contraloriaIncRead = await fetch(`${apiBase}/api/incidencias/evidencias/signed-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${contraloriaGlobalToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ incidenciaIds: allIncidenciaIds }),
      });
      assert.equal(contraloriaIncRead.status, 200);
      const contraloriaIncUrls = ((await contraloriaIncRead.json()) as {
        signedUrls: Record<string, string>;
      }).signedUrls;
      assert.equal(Object.keys(contraloriaIncUrls).length, 5);

      const contraloriaInvRead = await fetch(`${apiBase}/api/contraloria/facturas/signed-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${contraloriaGlobalToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ facturaIds: allFacturaIds }),
      });
      assert.equal(contraloriaInvRead.status, 200);
      const contraloriaInvUrls = ((await contraloriaInvRead.json()) as {
        urls: Record<string, string>;
      }).urls;
      assert.equal(Object.keys(contraloriaInvUrls).length, 5);

      const contraloriaAsistRead = await fetch(`${apiBase}/api/asistencia/evidencias/signed-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${contraloriaGlobalToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ evidenciaIds: allAsistenciaIds }),
      });
      assert.equal(contraloriaAsistRead.status, 200);
      const contraloriaAsistUrls = ((await contraloriaAsistRead.json()) as {
        signedUrls: Record<string, unknown>;
      }).signedUrls;
      assert.equal(Object.keys(contraloriaAsistUrls).length, 5);
    } finally {
      apiServer.closeAllConnections?.();
      mockSupabase.closeAllConnections?.();
      await new Promise<void>((r) => apiServer.close(() => r()));
      await new Promise<void>((r) => mockSupabase.close(() => r()));
      if (prevEnv.SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevEnv.SUPABASE_URL;
      if (prevEnv.SUPABASE_PUBLISHABLE_KEY === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
      else process.env.SUPABASE_PUBLISHABLE_KEY = prevEnv.SUPABASE_PUBLISHABLE_KEY;
      if (prevEnv.SUPABASE_ANON_KEY === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = prevEnv.SUPABASE_ANON_KEY;
      if (prevEnv.SUPABASE_SERVICE_ROLE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = prevEnv.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  await t.test('4) Chofer PWA (ruta-degustacion): normalizeRutaSucursal, formatSucursalLabel y verifyRutaProfileAccess en los 5 hubs', async () => {
    const expectedLabels: Record<OperativeSucursal, string> = {
      ZULIA: 'Sede Zulia',
      VALENCIA: 'Sede Valencia',
      CENTRO: 'Sede Centro',
      ORIENTE: 'Sede Oriente',
      CAPITAL: 'Sede Capital',
    };

    assert.equal(formatSucursalLabel('GLOBAL'), 'Nacional (Global)');
    assert.equal(normalizeRutaSucursal('GLOBAL', 'chofer'), null);
    assert.equal(normalizeRutaSucursal('GLOBAL', 'coordinacion'), null);
    assert.equal(normalizeRutaSucursal('GLOBAL', 'super_admin'), 'GLOBAL');

    for (const hub of OPERATIVE_SUCURSALES) {
      assert.equal(formatSucursalLabel(hub), expectedLabels[hub]);

      for (const sample of HUB_TERRITORY_SAMPLES[hub]) {
        assert.equal(normalizeRutaSucursal(sample, 'chofer'), hub);
        assert.equal(normalizeRutaSucursal(sample, 'coordinacion'), hub);
        assert.equal(normalizeRutaSucursal(sample, 'super_admin'), hub);
      }

      const choferUid = crypto.randomUUID();
      const userJwt = buildMockJwt({ sub: choferUid, role: 'authenticated' });
      const session = {
        access_token: userJwt,
        user: { id: choferUid, email: `  CHOFER.${hub}@CODIZULCA.COM  ` },
      } as unknown as Session;

      let signedOut = false;
      let realtimeAuthToken: string | null = null;

      // Probar tanto coincidencia por ID como respaldo por LOWER(TRIM(email)) con territorio acentuado
      const useEmailFallback = hub === 'ORIENTE' || hub === 'CAPITAL';
      const profileRow = {
        id: useEmailFallback ? crypto.randomUUID() : choferUid,
        email: `  chofer.${hub.toLowerCase()}@codizulca.com `,
        full_name: `Chofer ${hub}`,
        role: 'chofer',
        sucursal: HUB_TERRITORY_SAMPLES[hub][1],
        is_active: true,
      };

      const mockClient = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: useEmailFallback ? null : profileRow,
                error: null,
              }),
            }),
            ilike: () => ({
              limit: async () => ({
                data: [profileRow],
                error: null,
              }),
            }),
          }),
        }),
        auth: {
          signOut: async () => {
            signedOut = true;
            return { error: null };
          },
        },
        realtime: {
          setAuth: (tok: string) => {
            realtimeAuthToken = tok;
          },
        },
      } as unknown as Parameters<typeof verifyRutaProfileAccess>[0];

      const result = await verifyRutaProfileAccess(
        mockClient,
        session as unknown as Parameters<typeof verifyRutaProfileAccess>[1]
      );
      assert.equal(result.ok, true, `Chofer de ${hub} debe autenticar correctamente`);
      if (result.ok) {
        assert.equal(result.user.role, 'chofer');
        assert.equal(result.user.sucursal, hub);
        assert.equal(result.user.email, `chofer.${hub.toLowerCase()}@codizulca.com`);
      }
      assert.equal(signedOut, false);
      assert.equal(realtimeAuthToken, userJwt);
    }

    // Chofer con sucursal GLOBAL inválida -> INVALID_BRANCH + signOut inmediato
    let globalChoferSignedOut = false;
    const badChoferUid = crypto.randomUUID();
    const badClient = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: badChoferUid,
                email: 'chofer.global@codizulca.com',
                full_name: 'Chofer Mal Configurado',
                role: 'chofer',
                sucursal: 'GLOBAL',
                is_active: true,
              },
              error: null,
            }),
          }),
        }),
      }),
      auth: {
        signOut: async () => {
          globalChoferSignedOut = true;
          return { error: null };
        },
      },
      realtime: { setAuth: () => {} },
    } as unknown as Parameters<typeof verifyRutaProfileAccess>[0];

    const badRes = await verifyRutaProfileAccess(badClient, {
      access_token: buildMockJwt({ sub: badChoferUid, role: 'authenticated' }),
      user: { id: badChoferUid, email: 'chofer.global@codizulca.com' },
    } as unknown as Parameters<typeof verifyRutaProfileAccess>[1]);
    assert.equal(badRes.ok, false);
    if (!badRes.ok) {
      assert.equal(badRes.code, 'INVALID_BRANCH');
    }
    assert.equal(globalChoferSignedOut, true);
  });

  await t.test('5) Regresión G5 E2E: Cachés de Maestros acotados por activeSucursalHeader, purga en signOutSupabaseSession y fallback Paz y Salvo SHA-256', async () => {
    clearMasterDataCaches();
    setActiveClientSucursalHeader(null);

    const fetchCounts = {
      clientes: 0,
      vendedores: 0,
      cadenas_comerciales: 0,
      zonas: 0,
    };

    const makeChainableQuery = (table: keyof typeof fetchCounts) => {
      const execute = async () => {
        fetchCounts[table] += 1;
        const hub = getActiveClientSucursalHeader() || 'GLOBAL';
        if (table === 'clientes') {
          return {
            data: [
              {
                id: hub === 'ZULIA' ? '11111111-0001-4000-8000-000000000001' : '11111111-0005-4000-8000-000000000005',
                codigo_cliente: `CLI-${hub}-001`,
                razon_social: `CLIENTE ${hub} C.A.`,
                nombre_comercial: `PDV ${hub}`,
                activo: true,
                sucursal: hub === 'GLOBAL' ? 'ZULIA' : hub,
              },
            ],
            error: null,
          };
        }
        if (table === 'vendedores') {
          return {
            data: [
              {
                id: hub === 'ZULIA' ? '22222222-0001-4000-8000-000000000001' : '22222222-0005-4000-8000-000000000005',
                codigo_vendedor: `VEND-${hub}-001`,
                nombre_completo: `Vendedor ${hub}`,
                activo: true,
                sucursal: hub === 'GLOBAL' ? 'ZULIA' : hub,
              },
            ],
            error: null,
          };
        }
        if (table === 'cadenas_comerciales') {
          return {
            data: [
              {
                id: hub === 'ZULIA' ? '33333333-0001-4000-8000-000000000001' : '33333333-0005-4000-8000-000000000005',
                codigo: `CAD-${hub}`,
                nombre: `Cadena ${hub}`,
                tipo_canal: 'Supermercado',
                activo: true,
                sucursal: hub === 'GLOBAL' ? 'ZULIA' : hub,
              },
            ],
            error: null,
          };
        }
        return {
          data: [
            {
              id: hub === 'ZULIA' ? '44444444-0001-4000-8000-000000000001' : '44444444-0005-4000-8000-000000000005',
              codigo: `ZON-${hub}`,
              nombre: `Zona ${hub}`,
              activo: true,
              sucursal: hub === 'GLOBAL' ? 'ZULIA' : hub,
            },
          ],
          error: null,
        };
      };

      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        range: () => builder,
        eq: () => builder,
        ilike: () => builder,
        or: () => builder,
        then: (
          onFulfilled?: ((val: unknown) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null
        ) => execute().then(onFulfilled ?? undefined, onRejected ?? undefined),
      };
      return builder;
    };

    const mockMasterClient = {
      from: (table: keyof typeof fetchCounts) => makeChainableQuery(table),
    } as unknown as SupabaseClient<MasterDataDatabase>;

    try {
      // 1. Sesión ZULIA: puebla caché bajo prefijo "ZULIA::"
      setActiveClientSucursalHeader('ZULIA');
      assert.equal(getActiveClientSucursalHeader(), 'ZULIA');

      const zuliaCli1 = await obtenerClientesMaestros({ incluirVendedor: false }, mockMasterClient);
      const zuliaVend1 = await obtenerVendedoresMaestros({}, mockMasterClient);
      const zuliaCad1 = await obtenerCadenasComerciales({}, mockMasterClient);
      const zuliaZon1 = await obtenerZonasComerciales({}, mockMasterClient);

      assert.equal(zuliaCli1[0]?.codigo_cliente, 'CLI-ZULIA-001');
      assert.equal(zuliaVend1[0]?.codigo_vendedor, 'VEND-ZULIA-001');
      assert.equal(zuliaCad1[0]?.codigo, 'CAD-ZULIA');
      assert.equal(zuliaZon1[0]?.codigo, 'ZON-ZULIA');
      assert.deepEqual(fetchCounts, {
        clientes: 1,
        vendedores: 1,
        cadenas_comerciales: 1,
        zonas: 1,
      });

      // Segunda lectura en ZULIA sin forzarRefresco usa caché de ZULIA
      const zuliaCliCached = await obtenerClientesMaestros(
        { incluirVendedor: false },
        mockMasterClient
      );
      assert.equal(zuliaCliCached[0]?.codigo_cliente, 'CLI-ZULIA-001');
      assert.equal(fetchCounts.clientes, 1);

      // 2. Cambio de sesión/contexto a CAPITAL SIN forzarRefresco: jamás devuelve datos en caché de ZULIA
      setActiveClientSucursalHeader('CAPITAL');
      assert.equal(getActiveClientSucursalHeader(), 'CAPITAL');

      const capitalCli = await obtenerClientesMaestros(
        { incluirVendedor: false },
        mockMasterClient
      );
      const capitalVend = await obtenerVendedoresMaestros({}, mockMasterClient);
      const capitalCad = await obtenerCadenasComerciales({}, mockMasterClient);
      const capitalZon = await obtenerZonasComerciales({}, mockMasterClient);

      assert.equal(capitalCli[0]?.codigo_cliente, 'CLI-CAPITAL-001');
      assert.equal(capitalVend[0]?.codigo_vendedor, 'VEND-CAPITAL-001');
      assert.equal(capitalCad[0]?.codigo, 'CAD-CAPITAL');
      assert.equal(capitalZon[0]?.codigo, 'ZON-CAPITAL');
      assert.deepEqual(fetchCounts, {
        clientes: 2,
        vendedores: 2,
        cadenas_comerciales: 2,
        zonas: 2,
      });

      // 3. signOutSupabaseSession() limpia activeSucursalHeader y purga los 4 mapas de caché
      await signOutSupabaseSession();
      assert.equal(getActiveClientSucursalHeader(), null);

      setActiveClientSucursalHeader('ZULIA');
      const zuliaAfterSignOut = await obtenerClientesMaestros(
        { incluirVendedor: false },
        mockMasterClient
      );
      const vendAfterSignOut = await obtenerVendedoresMaestros({}, mockMasterClient);
      const cadAfterSignOut = await obtenerCadenasComerciales({}, mockMasterClient);
      const zonAfterSignOut = await obtenerZonasComerciales({}, mockMasterClient);

      assert.equal(zuliaAfterSignOut[0]?.codigo_cliente, 'CLI-ZULIA-001');
      assert.equal(vendAfterSignOut[0]?.codigo_vendedor, 'VEND-ZULIA-001');
      assert.equal(cadAfterSignOut[0]?.codigo, 'CAD-ZULIA');
      assert.equal(zonAfterSignOut[0]?.codigo, 'ZON-ZULIA');
      assert.deepEqual(
        fetchCounts,
        {
          clientes: 3,
          vendedores: 3,
          cadenas_comerciales: 3,
          zonas: 3,
        },
        'signOutSupabaseSession debe purgar los 4 cachés en memoria forzando lectura limpia en el siguiente login'
      );

      // 4. Resiliencia SHA-256 en Paz y Salvo ante sha256_hash vacío o fallback firma_sha256_hex
      const fallbackHash = 'f'.repeat(64);
      assert.equal(resolvePazYSalvoSha256({ firma_sha256_hex: fallbackHash }), fallbackHash);
      assert.equal(resolvePazYSalvoSha256({ sha256_hash: '' }), '');
      assert.equal(resolvePazYSalvoSha256(null), '');

      const mappedFallback = mapDbConciliacionToInventoryReconciliation(
        { id: 'c1', requisicion_id: 'r1', codigo_correlativo: 'MP-07-9999', cerrada: true },
        [],
        {
          id: 'cert1',
          codigo_certificado: 'PYS-MP-07-9999',
          requisicion_id: 'r1',
          conciliacion_id: 'c1',
          codigo_correlativo: 'MP-07-9999',
          payload_canonico: {},
          sha256_hash: '',
          firma_sha256_hex: fallbackHash,
          emitido_por_uid: 'u1',
          emitido_por_nombre: 'Auditoría',
          emitido_por_rol: 'contraloria',
          emitido_en: '2026-11-19T12:00:00Z',
          notas_cierre: 'Conforme',
          sucursal: 'CAPITAL',
        }
      );
      assert.equal(mappedFallback.pazYSalvoHash, `SHA256:${fallbackHash}`);
    } finally {
      clearMasterDataCaches();
      setActiveClientSucursalHeader(null);
    }
  });
});
