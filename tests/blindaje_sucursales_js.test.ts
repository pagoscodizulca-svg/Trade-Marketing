import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { buildMockJwt, MOCK_PUBLIC_ANON_KEY, MOCK_SERVICE_ROLE_KEY } from './antigravity_audit/localMockInfra';

const ROOT_DIR = process.cwd();

test('FASE 1 / HITO 1 MULTI-SUCURSAL (ZULIA / VALENCIA / GLOBAL) — Certificación SQL + Cliente TS Único', async (t) => {
  await t.test('Entregable 1: Integridad histórica no destructiva en 20261118000200_blindaje_trade_sucursales.sql', () => {
    const sqlPath = path.join(
      ROOT_DIR,
      'supabase',
      'migrations',
      '20261118000200_blindaje_trade_sucursales.sql'
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');

    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'PROHIBIDO DROP TABLE en migración');
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i, 'PROHIBIDO TRUNCATE en migración');
    assert.doesNotMatch(
      sql,
      /\bDELETE\s+FROM\s+public\.(promotoras|clientes)\b/i,
      'PROHIBIDO borrar registros en promotoras o clientes'
    );
  });

  await t.test('Entregable 2 (OWASP + N-03): Cliente único TS sin innerHTML ni service_role y con storageKey unificado', async () => {
    const clientCode = fs.readFileSync(
      path.join(ROOT_DIR, 'src', 'services', 'supabaseClient.ts'),
      'utf8'
    );
    const authCode = fs.readFileSync(
      path.join(ROOT_DIR, 'src', 'services', 'authService.ts'),
      'utf8'
    );

    for (const [nombre, codigo] of [
      ['supabaseClient.ts', clientCode],
      ['authService.ts', authCode],
    ] as const) {
      assert.doesNotMatch(
        codigo,
        /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/,
        `${nombre} no debe contener sumideros XSS de HTML`
      );
      assert.doesNotMatch(
        codigo,
        /SUPABASE_SERVICE_ROLE_KEY/,
        `${nombre} jamás debe leer SUPABASE_SERVICE_ROLE_KEY`
      );
    }

    const { UNIFIED_SUPABASE_STORAGE_KEY, validarClavePublicaNoSecreta } = await import(
      '../src/services/supabaseClient'
    );

    assert.equal(UNIFIED_SUPABASE_STORAGE_KEY, 'codizulca.supabase.auth.v1');
    assert.throws(
      () => validarClavePublicaNoSecreta('sb_secret_clave_prohibida_12345'),
      /SEGURIDAD CRÍTICA/
    );
    assert.throws(
      () => validarClavePublicaNoSecreta(MOCK_SERVICE_ROLE_KEY),
      /SEGURIDAD CRÍTICA/
    );
    assert.doesNotThrow(() => validarClavePublicaNoSecreta(MOCK_PUBLIC_ANON_KEY));
  });

  await t.test('Entregable 2 (E2E Local en public.profiles): iniciarSesionPorCorreo, storageKey unificado, signOut inmediato y DOM seguro', async () => {
    const UID_PROM_ZULIA = '11111111-1111-4111-8111-000000000101';
    const PROM_ZULIA_ID = '22222222-2222-4222-8222-000000001101';
    const UID_COORD_VAL = '11111111-1111-4111-8111-000000000202';
    const UID_ADMIN_GEN = '11111111-1111-4111-8111-000000000999';
    const UID_INTRUSO = '11111111-1111-4111-8111-000000000666';
    const UID_INACTIVO = '11111111-1111-4111-8111-000000000777';

    const usuariosAuth = new Map([
      [
        'maria.zulia@empresa.com',
        { id: UID_PROM_ZULIA, password: 'ClaveSegura123!', staffId: PROM_ZULIA_ID },
      ],
      ['coord.valencia@empresa.com', { id: UID_COORD_VAL, password: 'ClaveSegura123!', staffId: null }],
      ['admin.general@empresa.com', { id: UID_ADMIN_GEN, password: 'ClaveSegura123!', staffId: null }],
      ['intruso.externo@empresa.com', { id: UID_INTRUSO, password: 'ClaveSegura123!', staffId: null }],
      ['suspendida.zulia@empresa.com', { id: UID_INACTIVO, password: 'ClaveSegura123!', staffId: null }],
    ]);

    const profilesTable = new Map<
      string,
      {
        id: string;
        email: string;
        full_name: string;
        role: string;
        sucursal: string;
        is_active: boolean;
      }
    >([
      [
        UID_PROM_ZULIA,
        {
          id: UID_PROM_ZULIA,
          email: 'maria.zulia@empresa.com',
          full_name: 'María Alejandra · Zulia',
          role: 'promotora',
          sucursal: 'ZULIA',
          is_active: true,
        },
      ],
      [
        UID_COORD_VAL,
        {
          id: UID_COORD_VAL,
          email: 'coord.valencia@empresa.com',
          full_name: 'Coordinadora Sede Valencia',
          role: 'coordinacion',
          sucursal: 'VALENCIA',
          is_active: true,
        },
      ],
      [
        UID_ADMIN_GEN,
        {
          id: UID_ADMIN_GEN,
          email: 'admin.general@empresa.com',
          full_name: 'Dirección Nacional Trade',
          role: 'super_admin',
          sucursal: 'GLOBAL',
          is_active: true,
        },
      ],
      [
        UID_INACTIVO,
        {
          id: UID_INACTIVO,
          email: 'suspendida.zulia@empresa.com',
          full_name: 'Promotora Inactiva',
          role: 'promotora',
          sucursal: 'ZULIA',
          is_active: false,
        },
      ],
    ]);

    let llamadasLogout = 0;

    const mockServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : {};

      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
        const email = String(body.email || '');
        const found = usuariosAuth.get(email);
        if (!found || found.password !== body.password) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login' }));
          return;
        }
        const accessToken = buildMockJwt({
          sub: found.id,
          email,
          role: 'authenticated',
          app_metadata: found.staffId ? { staff_id: found.staffId } : {},
          exp: 2100000000,
        });
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'mock-refresh-token',
            user: {
              id: found.id,
              aud: 'authenticated',
              role: 'authenticated',
              email,
              app_metadata: found.staffId ? { staff_id: found.staffId } : {},
            },
          })
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
        llamadasLogout += 1;
        res.statusCode = 204;
        res.end();
        return;
      }

      const authHeader = String(req.headers.authorization || '');
      let jwtPayload: { sub?: string } = {};
      if (authHeader.startsWith('Bearer ')) {
        const parts = authHeader.slice(7).split('.');
        if (parts[1]) {
          jwtPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        }
      }

      if (req.method === 'GET' && url.pathname === '/rest/v1/profiles') {
        const uidBuscado = (url.searchParams.get('id') || '').replace(/^eq\./, '');
        const row = uidBuscado === jwtPayload.sub ? profilesTable.get(uidBuscado) ?? null : null;
        res.end(JSON.stringify(row));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const memoryMap = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => memoryMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memoryMap.set(k, v);
      },
      removeItem: (k: string) => {
        memoryMap.delete(k);
      },
    } as Storage;

    const { UNIFIED_SUPABASE_STORAGE_KEY, crearClienteSupabase } = await import(
      '../src/services/supabaseClient'
    );
    const {
      MENSAJE_PERFIL_NO_ACTIVO,
      iniciarSesionPorCorreo,
      renderizarInsigniaSedeSegura,
    } = await import('../src/services/authService');

    const testClient = crearClienteSupabase({
      url: baseUrl,
      publishableKey: 'sb_publishable_clave_ficticia_pruebas_locales',
      storage: mockStorage,
      permitirLoopbackPruebas: true,
    });

    try {
      // 1) Promotora Zulia -> lee de public.profiles y persiste bajo codizulca.supabase.auth.v1
      const sesionPromZulia = await iniciarSesionPorCorreo(
        '  MARIA.ZULIA@EMPRESA.COM  ',
        'ClaveSegura123!',
        { client: testClient }
      );
      assert.equal(sesionPromZulia.rol, 'promotora');
      assert.equal(sesionPromZulia.sucursal, 'ZULIA');
      assert.equal(sesionPromZulia.staffId, PROM_ZULIA_ID);
      assert.equal(sesionPromZulia.etiquetaSede, 'Sucursal Zulia');
      assert.equal(
        memoryMap.has(UNIFIED_SUPABASE_STORAGE_KEY),
        true,
        'Debe persistir la sesión bajo codizulca.supabase.auth.v1'
      );

      // 2) Coordinadora Valencia -> retorna VALENCIA
      const sesionCoordVal = await iniciarSesionPorCorreo(
        'coord.valencia@empresa.com',
        'ClaveSegura123!',
        { client: testClient }
      );
      assert.equal(sesionCoordVal.rol, 'coordinacion');
      assert.equal(sesionCoordVal.sucursal, 'VALENCIA');
      assert.equal(sesionCoordVal.etiquetaSede, 'Sucursal Valencia');

      // 3) Super Admin -> retorna GLOBAL y etiqueta nacional
      const sesionAdminGen = await iniciarSesionPorCorreo(
        'admin.general@empresa.com',
        'ClaveSegura123!',
        { client: testClient }
      );
      assert.equal(sesionAdminGen.rol, 'super_admin');
      assert.equal(sesionAdminGen.sucursal, 'GLOBAL');
      assert.equal(sesionAdminGen.etiquetaSede, 'Administración General - Nacional');

      // 4) Usuario sin fila en public.profiles -> signOut inmediato
      const logoutsAntesIntruso = llamadasLogout;
      await assert.rejects(
        () =>
          iniciarSesionPorCorreo('intruso.externo@empresa.com', 'ClaveSegura123!', {
            client: testClient,
          }),
        (err: Error) => err.message === MENSAJE_PERFIL_NO_ACTIVO
      );
      assert.ok(llamadasLogout > logoutsAntesIntruso);

      // 5) Usuario suspendido (`is_active: false`) -> signOut inmediato
      const logoutsAntesInactivo = llamadasLogout;
      await assert.rejects(
        () =>
          iniciarSesionPorCorreo('suspendida.zulia@empresa.com', 'ClaveSegura123!', {
            client: testClient,
          }),
        (err: Error) => err.message === MENSAJE_PERFIL_NO_ACTIVO
      );
      assert.ok(llamadasLogout > logoutsAntesInactivo);

      // 6) Prevención XSS en renderizado DOM con textContent y createElement
      const nodosHijos: Array<{ tag?: string; textContent?: string; dataset?: Record<string, string> }> = [];
      const mockDoc = {
        createElement(tag: string) {
          return {
            tag,
            className: '',
            dataset: {} as Record<string, string>,
            textContent: '',
          };
        },
        createTextNode(text: string) {
          return { textContent: text };
        },
      };
      const mockContenedor = {
        ownerDocument: mockDoc,
        replaceChildren(...items: any[]) {
          nodosHijos.splice(0, nodosHijos.length, ...items);
        },
      } as unknown as HTMLElement;

      renderizarInsigniaSedeSegura(mockContenedor, {
        rol: 'promotora',
        sucursal: 'ZULIA',
        nombreCompleto: '<img src=x onerror=alert(1)>Ana Zulia',
      });

      assert.equal(nodosHijos.length, 3);
      assert.equal(nodosHijos[0]?.textContent, 'Sucursal Zulia');
      assert.equal(nodosHijos[0]?.dataset?.sucursal, 'ZULIA');
      assert.equal(nodosHijos[2]?.textContent, '<img src=x onerror=alert(1)>Ana Zulia');
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});
