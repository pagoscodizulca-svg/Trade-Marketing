import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { buildMockJwt, MOCK_PUBLIC_ANON_KEY, MOCK_SERVICE_ROLE_KEY } from './antigravity_audit/localMockInfra';

const ROOT_DIR = process.cwd();

test('FASE 1 MULTI-SUCURSAL (ZULIA / VALENCIA / ADMIN_GENERAL) — Certificación SQL + JS ES6+ OWASP', async (t) => {
  await t.test('Entregable 1: Integridad no destructiva, FORCE RLS y aislamiento en 001_blindaje_trade_sucursales.sql', () => {
    const sqlPath = path.join(
      ROOT_DIR,
      'supabase',
      'migrations',
      '001_blindaje_trade_sucursales.sql'
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // 1. Regla de oro: prohibición absoluta de comandos destructivos de tabla o borrado de datos
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, 'PROHIBIDO DROP TABLE en migración');
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i, 'PROHIBIDO TRUNCATE en migración');
    assert.doesNotMatch(
      sql,
      /\bDELETE\s+FROM\s+public\.(promotoras|clientes)\b/i,
      'PROHIBIDO borrar registros en promotoras o clientes'
    );

    // 2. ENUMs controlados
    assert.match(sql, /CREATE TYPE public\.sucursal_tipo AS ENUM\s*\('Zulia',\s*'Valencia'\)/i);
    assert.match(
      sql,
      /CREATE TYPE public\.rol_trade AS ENUM\s*\('promotora',\s*'coordinadora',\s*'admin_general'\)/i
    );
    assert.match(sql, /EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+NULL/i);

    // 3. ENABLE + FORCE ROW LEVEL SECURITY en las 4 tablas
    for (const tabla of ['promotoras', 'clientes', 'perfiles_acceso', 'reportes_trade']) {
      assert.match(
        sql,
        new RegExp(`ALTER TABLE public\\.${tabla} ENABLE ROW LEVEL SECURITY`, 'i'),
        `Falta ENABLE RLS en ${tabla}`
      );
      assert.match(
        sql,
        new RegExp(`ALTER TABLE public\\.${tabla} FORCE ROW LEVEL SECURITY`, 'i'),
        `Falta FORCE RLS en ${tabla}`
      );
      assert.match(
        sql,
        new RegExp(`REVOKE ALL ON TABLE public\\.${tabla} FROM PUBLIC,\\s*anon`, 'i'),
        `Falta REVOKE anon en ${tabla}`
      );
    }

    // 4. Restricciones, funciones anti-recursión, lista blanca y triggers
    assert.match(
      sql,
      /CHECK\s*\(\(rol\s*=\s*'admin_general'\)\s*OR\s*\(sucursal\s+IS\s+NOT\s+NULL\)\)/i
    );
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.vincular_mi_usuario_auth\(\)/i);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.obtener_mi_rol\(\)/i);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.obtener_mi_sucursal\(\)/i);
    assert.match(sql, /CREATE TRIGGER trg_sync_promotora_a_perfil_acceso/i);
    assert.match(sql, /CREATE TRIGGER trg_vincular_nuevo_auth_user_perfil/i);
    assert.match(sql, /CREATE TRIGGER trg_forzar_integridad_reporte_trade/i);

    // 5. Bloque comentado de verificación para los 5 perfiles
    assert.match(sql, /1_promotora_zulia_clientes_valencia/);
    assert.match(sql, /2_promotora_valencia_reportes_zulia/);
    assert.match(sql, /3_coord_zulia_ve_valencia/);
    assert.match(sql, /4_coord_valencia_ve_zulia/);
    assert.match(sql, /5_admin_general_consolidado/);
  });

  await t.test('Entregable 2 (OWASP): Cero innerHTML / service_role y bloqueo de llaves secretas en supabaseClient.js', async () => {
    const clientCode = fs.readFileSync(
      path.join(ROOT_DIR, 'src', 'lib', 'supabaseClient.js'),
      'utf8'
    );
    const guardCode = fs.readFileSync(
      path.join(ROOT_DIR, 'src', 'auth', 'authGuard.js'),
      'utf8'
    );

    for (const [nombre, codigo] of [
      ['supabaseClient.js', clientCode],
      ['authGuard.js', guardCode],
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

    assert.match(clientCode, /persistSession:\s*true/);
    assert.match(clientCode, /autoRefreshToken:\s*true/);

    const { validarClavePublicaNoSecreta } = await import('../src/lib/supabaseClient.js');

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

  await t.test('Entregable 2 (E2E Local): iniciarSesionPorCorreo, vinculación RPC, signOut fuera de lista blanca y DOM seguro', async () => {
    const UID_PROM_ZULIA = '11111111-1111-4111-8111-000000000101';
    const PROM_ZULIA_ID = '22222222-2222-4222-8222-000000001101';
    const UID_COORD_VAL = '11111111-1111-4111-8111-000000000202';
    const UID_ADMIN_GEN = '11111111-1111-4111-8111-000000000999';
    const UID_INTRUSO = '11111111-1111-4111-8111-000000000666';
    const UID_INACTIVO = '11111111-1111-4111-8111-000000000777';

    const usuariosAuth = new Map([
      ['maria.zulia@empresa.com', { id: UID_PROM_ZULIA, password: 'ClaveSegura123!' }],
      ['coord.valencia@empresa.com', { id: UID_COORD_VAL, password: 'ClaveSegura123!' }],
      ['admin.general@empresa.com', { id: UID_ADMIN_GEN, password: 'ClaveSegura123!' }],
      ['intruso.externo@empresa.com', { id: UID_INTRUSO, password: 'ClaveSegura123!' }],
      ['suspendida.zulia@empresa.com', { id: UID_INACTIVO, password: 'ClaveSegura123!' }],
    ]);

    const perfilesTabla = new Map<
      string,
      {
        id: string;
        auth_user_id: string | null;
        email: string;
        nombre_completo: string;
        rol: string;
        sucursal: string | null;
        promotora_id: string | null;
        activo: boolean;
      }
    >([
      [
        'maria.zulia@empresa.com',
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
          auth_user_id: null, // Se vinculará automáticamente vía RPC al iniciar sesión
          email: 'maria.zulia@empresa.com',
          nombre_completo: 'María Alejandra · Zulia',
          rol: 'promotora',
          sucursal: 'Zulia',
          promotora_id: PROM_ZULIA_ID,
          activo: true,
        },
      ],
      [
        'coord.valencia@empresa.com',
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
          auth_user_id: null,
          email: 'coord.valencia@empresa.com',
          nombre_completo: 'Coordinadora Sede Valencia',
          rol: 'coordinadora',
          sucursal: 'Valencia',
          promotora_id: null,
          activo: true,
        },
      ],
      [
        'admin.general@empresa.com',
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003',
          auth_user_id: UID_ADMIN_GEN,
          email: 'admin.general@empresa.com',
          nombre_completo: 'Dirección Nacional Trade',
          rol: 'admin_general',
          sucursal: null,
          promotora_id: null,
          activo: true,
        },
      ],
      [
        'suspendida.zulia@empresa.com',
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004',
          auth_user_id: UID_INACTIVO,
          email: 'suspendida.zulia@empresa.com',
          nombre_completo: 'Promotora Inactiva',
          rol: 'promotora',
          sucursal: 'Zulia',
          promotora_id: null,
          activo: false,
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

      // 1. Login Supabase Auth: POST /auth/v1/token?grant_type=password
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
            },
          })
        );
        return;
      }

      // 2. Logout Supabase Auth: POST /auth/v1/logout
      if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
        llamadasLogout += 1;
        res.statusCode = 204;
        res.end();
        return;
      }

      // Extraer identidad del JWT enviado en Authorization
      const authHeader = String(req.headers.authorization || '');
      let jwtPayload: { sub?: string; email?: string } = {};
      if (authHeader.startsWith('Bearer ')) {
        const parts = authHeader.slice(7).split('.');
        if (parts[1]) {
          jwtPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        }
      }

      // 3. RPC POST /rest/v1/rpc/vincular_mi_usuario_auth
      if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/vincular_mi_usuario_auth') {
        const emailNorm = String(jwtPayload.email || '').trim().toLowerCase();
        const perfil = perfilesTabla.get(emailNorm);
        if (perfil && perfil.activo && !perfil.auth_user_id && jwtPayload.sub) {
          perfil.auth_user_id = jwtPayload.sub;
          res.end(JSON.stringify({ vinculado: true, rol: perfil.rol, sucursal: perfil.sucursal }));
          return;
        }
        res.end(JSON.stringify({ vinculado: Boolean(perfil?.activo && perfil.auth_user_id === jwtPayload.sub) }));
        return;
      }

      // 4. PostgREST GET /rest/v1/perfiles_acceso (simulando RLS estricto por auth_user_id y activo=true)
      if (req.method === 'GET' && url.pathname === '/rest/v1/perfiles_acceso') {
        const uidBuscado = (url.searchParams.get('auth_user_id') || '').replace(/^eq\./, '');
        let encontrado = null;
        for (const p of perfilesTabla.values()) {
          if (p.auth_user_id === uidBuscado && p.auth_user_id === jwtPayload.sub) {
            encontrado = p;
            break;
          }
        }
        res.end(JSON.stringify(encontrado));
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

    const { crearClienteSupabase } = await import('../src/lib/supabaseClient.js');
    const {
      MENSAJE_PERFIL_NO_ACTIVO,
      iniciarSesionPorCorreo,
      renderizarInsigniaSedeSegura,
    } = await import('../src/auth/authGuard.js');

    const testClient = crearClienteSupabase({
      url: baseUrl,
      publishableKey: 'sb_publishable_clave_ficticia_pruebas_locales',
      storage: mockStorage,
      permitirLoopbackPruebas: true,
    });

    try {
      // 1) Promotora Zulia con mayúsculas y espacios laterales -> sanitiza, vincula auth_user_id y retorna Zulia
      const sesionPromZulia = await iniciarSesionPorCorreo(
        '  MARIA.ZULIA@EMPRESA.COM  ',
        'ClaveSegura123!',
        { client: testClient }
      );
      assert.equal(sesionPromZulia.rol, 'promotora');
      assert.equal(sesionPromZulia.sucursal, 'Zulia');
      assert.equal(sesionPromZulia.promotoraId, PROM_ZULIA_ID);
      assert.equal(sesionPromZulia.etiquetaSede, 'Sucursal Zulia');
      assert.equal(perfilesTabla.get('maria.zulia@empresa.com')?.auth_user_id, UID_PROM_ZULIA);

      // 2) Coordinadora Valencia -> retorna Sucursal Valencia
      const sesionCoordVal = await iniciarSesionPorCorreo(
        'coord.valencia@empresa.com',
        'ClaveSegura123!',
        { client: testClient }
      );
      assert.equal(sesionCoordVal.rol, 'coordinadora');
      assert.equal(sesionCoordVal.sucursal, 'Valencia');
      assert.equal(sesionCoordVal.promotoraId, null);
      assert.equal(sesionCoordVal.etiquetaSede, 'Sucursal Valencia');

      // 3) Administrador General -> sucursal null y etiqueta nacional
      const sesionAdminGen = await iniciarSesionPorCorreo(
        'admin.general@empresa.com',
        'ClaveSegura123!',
        { client: testClient }
      );
      assert.equal(sesionAdminGen.rol, 'admin_general');
      assert.equal(sesionAdminGen.sucursal, null);
      assert.equal(sesionAdminGen.etiquetaSede, 'Administración General - Nacional');

      // 4) Usuario autenticado en Auth pero NO pre-registrado en lista blanca -> signOut inmediato
      const logoutsAntesIntruso = llamadasLogout;
      await assert.rejects(
        () =>
          iniciarSesionPorCorreo('intruso.externo@empresa.com', 'ClaveSegura123!', {
            client: testClient,
          }),
        (err: Error) => err.message === MENSAJE_PERFIL_NO_ACTIVO
      );
      assert.ok(
        llamadasLogout > logoutsAntesIntruso,
        'Debe invocar supabase.auth.signOut() inmediatamente si el correo no está en perfiles_acceso'
      );

      // 5) Usuario pre-registrado pero con `activo: false` -> signOut inmediato
      const logoutsAntesInactivo = llamadasLogout;
      await assert.rejects(
        () =>
          iniciarSesionPorCorreo('suspendida.zulia@empresa.com', 'ClaveSegura123!', {
            client: testClient,
          }),
        (err: Error) => err.message === MENSAJE_PERFIL_NO_ACTIVO
      );
      assert.ok(
        llamadasLogout > logoutsAntesInactivo,
        'Debe invocar supabase.auth.signOut() inmediatamente si activo === false'
      );

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
        sucursal: 'Zulia',
        nombreCompleto: '<img src=x onerror=alert(1)>Ana Zulia',
      });

      assert.equal(nodosHijos.length, 3);
      assert.equal(nodosHijos[0]?.textContent, 'Sucursal Zulia');
      assert.equal(nodosHijos[0]?.dataset?.sucursal, 'Zulia');
      assert.equal(nodosHijos[2]?.textContent, '<img src=x onerror=alert(1)>Ana Zulia');
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});
