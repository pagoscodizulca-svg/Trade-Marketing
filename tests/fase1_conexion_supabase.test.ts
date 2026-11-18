import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { buildMockJwt } from './antigravity_audit/localMockInfra';

const ROOT_DIR = process.cwd();
const URL_PROYECTO = 'https://apaxdgxtaoeyswlfblgi.supabase.co';
const LLAVE_PUBLICA_FICTICIA = 'sb_publishable_clave_ficticia_aceptacion_fase1';

function gitIgnora(ruta: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', ruta], { cwd: ROOT_DIR, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitRastrea(ruta: string): boolean {
  const salida = execFileSync('git', ['ls-files', '--', ruta], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  return salida.trim().length > 0;
}

test('FASE 1 — Conexión Segura Frontend JS + Supabase (Criterios de Aceptación)', async (t) => {
  const mod = await import('../src/lib/supabaseClient.js');
  const diag = await import('../src/diagnostics/checkSupabaseConnection.js');

  await t.test('a) normalizarSupabaseUrl corrige sufijos /rest/v1/ y exige https + .supabase.co', () => {
    assert.equal(mod.normalizarSupabaseUrl(`${URL_PROYECTO}/rest/v1/`), URL_PROYECTO);
    assert.equal(mod.normalizarSupabaseUrl(`  ${URL_PROYECTO}/rest/v1  `), URL_PROYECTO);
    assert.equal(mod.normalizarSupabaseUrl(`${URL_PROYECTO}///`), URL_PROYECTO);
    assert.equal(mod.normalizarSupabaseUrl(`${URL_PROYECTO}/rest/v1/rest/v1/`), URL_PROYECTO);
    assert.equal(mod.normalizarSupabaseUrl(`${URL_PROYECTO}/auth/v1`), URL_PROYECTO);

    assert.throws(
      () => mod.normalizarSupabaseUrl('http://apaxdgxtaoeyswlfblgi.supabase.co'),
      /https/
    );
    assert.throws(() => mod.normalizarSupabaseUrl('https://dominio-malicioso.com'), /supabase\.co/);
    assert.throws(
      () => mod.normalizarSupabaseUrl('https://apaxdgxtaoeyswlfblgi.supabase.co.evil.com'),
      /supabase\.co/
    );
    assert.throws(() => mod.normalizarSupabaseUrl(''), /VITE_SUPABASE_URL/);
  });

  await t.test('b) assertCredencialesSeguras bloquea sb_secret_* y service_role sin tocar la red', async () => {
    const secretos = [
      'sb_secret_abc123',
      'sb_secret_',
      buildMockJwt({ role: 'service_role', iss: 'supabase' }),
    ];

    for (const secreto of secretos) {
      assert.throws(
        () => mod.assertCredencialesSeguras(URL_PROYECTO, secreto),
        (err: Error) => err instanceof mod.ErrorSeguridadCredenciales && /SEGURIDAD CRÍTICA/.test(err.message)
      );
      // También bloqueado aunque la URL sea inválida (la seguridad se evalúa primero)
      assert.throws(
        () => mod.assertCredencialesSeguras('url-invalida', secreto),
        (err: Error) => err instanceof mod.ErrorSeguridadCredenciales
      );
    }

    // createClient jamás se alcanza: verificar que no ocurre ninguna petición de red
    const fetchOriginal = globalThis.fetch;
    let peticiones = 0;
    globalThis.fetch = (async () => {
      peticiones += 1;
      throw new Error('No debería invocarse la red');
    }) as typeof fetch;
    try {
      assert.throws(
        () => mod.crearClienteSupabase({ url: URL_PROYECTO, publishableKey: 'sb_secret_xyz789' }),
        (err: Error) => err instanceof mod.ErrorSeguridadCredenciales
      );
      const resultado = await diag.verificarConexionSupabase({
        url: URL_PROYECTO,
        publishableKey: 'sb_secret_xyz789',
      });
      assert.equal(resultado.ok, false);
      assert.match(resultado.mensaje, /bloqueada por seguridad/);
      assert.equal(JSON.stringify(resultado).includes('sb_secret_xyz789'), false);
      assert.equal(peticiones, 0, 'Cero peticiones de red con llave secreta');
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    // Placeholder o vacío: guía clara en consola sin imprimir llaves
    const avisos: string[] = [];
    const warnOriginal = console.warn;
    console.warn = (...args: unknown[]) => {
      avisos.push(args.map(String).join(' '));
    };
    try {
      assert.throws(
        () => mod.assertCredencialesSeguras(URL_PROYECTO, mod.PLACEHOLDER_PUBLISHABLE_KEY),
        (err: Error) => err instanceof mod.ErrorConfiguracionIncompleta
      );
      assert.throws(
        () => mod.assertCredencialesSeguras(URL_PROYECTO, ''),
        (err: Error) => err instanceof mod.ErrorConfiguracionIncompleta
      );
    } finally {
      console.warn = warnOriginal;
    }
    assert.equal(avisos.length, 2);
    assert.match(avisos[0]!, /\.env\.local/);
    assert.match(avisos[0]!, /VITE_SUPABASE_PUBLISHABLE_KEY/);

    // Llave pública válida
    const ok = mod.assertCredencialesSeguras(`${URL_PROYECTO}/rest/v1/`, LLAVE_PUBLICA_FICTICIA);
    assert.equal(ok.urlNormalizada, URL_PROYECTO);

    // Llaves que no son sb_publishable_ se rechazan
    assert.throws(
      () => mod.assertCredencialesSeguras(URL_PROYECTO, 'clave-cualquiera-no-publishable'),
      (err: Error) => err instanceof mod.ErrorSeguridadCredenciales
    );
  });

  await t.test('Diagnóstico: verificarConexionSupabase detecta 404, éxito y no filtra llaves (DOM con textContent)', async () => {
    let modo: 'ok' | '404' = 'ok';
    let apikeyRecibida = '';
    const servidor = http.createServer((req, res) => {
      apikeyRecibida = String(req.headers.apikey || '');
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.startsWith('/auth/v1/health')) {
        if (modo === '404') {
          res.statusCode = 404;
          res.end('{"error":"not found"}');
          return;
        }
        res.statusCode = 200;
        res.end('{"name":"GoTrue","version":"mock"}');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', () => r()));
    const puerto = (servidor.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${puerto}`;

    const memoria = new Map<string, string>();
    const almacenamiento = {
      getItem: (k: string) => memoria.get(k) ?? null,
      setItem: (k: string, v: string) => void memoria.set(k, v),
      removeItem: (k: string) => void memoria.delete(k),
    } as Storage;

    const cliente = mod.crearClienteSupabase({
      url: `${baseUrl}/rest/v1/`,
      publishableKey: LLAVE_PUBLICA_FICTICIA,
      storage: almacenamiento,
      permitirLoopbackPruebas: true,
    });

    const logsCapturados: string[] = [];
    const logOriginal = console.log;
    const errorOriginal = console.error;
    console.log = (...a: unknown[]) => void logsCapturados.push(a.map(String).join(' '));
    console.error = (...a: unknown[]) => void logsCapturados.push(a.map(String).join(' '));

    try {
      const exito = await diag.verificarConexionSupabase({
        url: `${baseUrl}/rest/v1/`,
        publishableKey: LLAVE_PUBLICA_FICTICIA,
        client: cliente,
        permitirLoopbackPruebas: true,
      });
      assert.deepEqual(Object.keys(exito).sort(), ['mensaje', 'ok', 'sesionActiva', 'urlNormalizada']);
      assert.equal(exito.ok, true);
      assert.equal(exito.urlNormalizada, baseUrl);
      assert.equal(exito.sesionActiva, false);
      assert.equal(apikeyRecibida, LLAVE_PUBLICA_FICTICIA);
      assert.equal(JSON.stringify(exito).includes(LLAVE_PUBLICA_FICTICIA), false);

      modo = '404';
      const fallo = await diag.verificarConexionSupabase({
        url: baseUrl,
        publishableKey: LLAVE_PUBLICA_FICTICIA,
        client: cliente,
        permitirLoopbackPruebas: true,
      });
      assert.equal(fallo.ok, false);
      assert.match(fallo.mensaje, /404/);

      const sinRed = await diag.verificarConexionSupabase({
        url: 'http://127.0.0.1:1',
        publishableKey: LLAVE_PUBLICA_FICTICIA,
        permitirLoopbackPruebas: true,
        timeoutMs: 1500,
      });
      assert.equal(sinRed.ok, false);
      assert.match(sinRed.mensaje, /red|tiempo/);
    } finally {
      console.log = logOriginal;
      console.error = errorOriginal;
      await new Promise<void>((r) => servidor.close(() => r()));
    }

    assert.equal(
      logsCapturados.some((l) => l.includes(LLAVE_PUBLICA_FICTICIA)),
      false,
      'Ninguna llave debe imprimirse en consola'
    );

    // Renderizado DOM seguro
    const hijos: Array<{ textContent?: string }> = [];
    const doc = {
      createElement: () => ({ className: '', textContent: '' }),
      createTextNode: (t: string) => ({ textContent: t }),
    };
    const contenedor = {
      ownerDocument: doc,
      replaceChildren: (...items: any[]) => void hijos.splice(0, hijos.length, ...items),
    } as unknown as HTMLElement;

    diag.pintarEstadoConexionDom(contenedor, {
      ok: false,
      urlNormalizada: URL_PROYECTO,
      sesionActiva: false,
      mensaje: '<img src=x onerror=alert(1)>',
    });
    assert.equal(hijos[0]?.textContent, 'Sin conexión');
    assert.equal(hijos[2]?.textContent, '<img src=x onerror=alert(1)>');
  });

  await t.test('c) Archivos privados ignorados por Git y código sin sumideros XSS ni llaves secretas', () => {
    assert.equal(gitIgnora('.env.local'), true, '.env.local debe estar ignorado');
    assert.equal(gitIgnora('.env'), true, '.env debe estar ignorado');
    assert.equal(gitIgnora('src/config/env.js'), true, 'src/config/env.js debe estar ignorado');
    assert.equal(gitIgnora('.env.example'), false, '.env.example debe ser versionable');
    assert.equal(gitRastrea('.env.local'), false, '.env.local no debe estar en el índice de Git');
    assert.equal(gitRastrea('src/config/env.js'), false);

    const estado = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    assert.equal(
      estado.split(/\r?\n/).some((l) => /(^|\s)\.env\.local$|src\/config\/env\.js$/.test(l.trim())),
      false,
      'git status no debe listar archivos privados de credenciales'
    );

    const envExample = fs.readFileSync(path.join(ROOT_DIR, '.env.example'), 'utf8');
    assert.match(envExample, /VITE_SUPABASE_URL=https:\/\/apaxdgxtaoeyswlfblgi\.supabase\.co\r?\n/);
    assert.match(envExample, /VITE_SUPABASE_PUBLISHABLE_KEY=PEGA_AQUI_TU_SB_PUBLISHABLE_KEY/);
    assert.doesNotMatch(envExample, /sb_secret_[A-Za-z0-9]/);
    assert.doesNotMatch(envExample, /eyJ[A-Za-z0-9_-]{10,}/);

    for (const archivo of [
      'src/lib/supabaseClient.js',
      'src/diagnostics/checkSupabaseConnection.js',
    ]) {
      const codigo = fs.readFileSync(path.join(ROOT_DIR, archivo), 'utf8');
      assert.doesNotMatch(codigo, /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/, archivo);
      assert.doesNotMatch(codigo, /SUPABASE_SERVICE_ROLE_KEY/, archivo);
      assert.doesNotMatch(codigo, /sb_secret_[A-Za-z0-9]{6,}/, archivo);
    }

    const reglas = fs.readFileSync(path.join(ROOT_DIR, 'rules', 'AGENTS.md'), 'utf8');
    assert.match(reglas, /sb_secret_/);
    assert.match(reglas, /service_role/);
    assert.match(reglas, /\/rest\/v1\//);
    assert.match(reglas, /RLS/);
  });
});
