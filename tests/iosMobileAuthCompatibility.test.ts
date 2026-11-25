import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createMobileSafeAuthLock,
  createMobileSafeAuthStorage,
  fetchWithCompatibleTimeout,
  isMobileNetworkAuthError,
  normalizeMobileLoginEmail,
  sanitizeMobileLoginPassword,
} from '../src/utils/mobileAuthCompat';
import { normalizePortalEmail } from '../src/services/authService';
import {
  isHeicHeaderBytes,
  validateClientImageHeaderBytes,
} from '../src/utils/attendanceImageCompressor';
import { validatePortalImageFile } from '../src/services/promotoraCampoService';
import {
  crearClienteSupabase,
  setActiveClientSucursalHeader,
} from '../src/services/supabaseClient';

test('mobileAuthCompat: limpia caracteres invisibles de WhatsApp/iOS en correo y comillas inteligentes en contraseña', () => {
  // Correo copiado desde WhatsApp iPhone con BOM + zero-width space + NBSP + mayúsculas
  assert.equal(
    normalizeMobileLoginEmail('\uFEFF\u200BMariaAlmarza16@gmail.com\u00A0 '),
    'mariaalmarza16@gmail.com',
  );
  assert.equal(
    normalizePortalEmail('  \u200BEneliAngela@GMAIL.com\uFEFF '),
    'eneliangela@gmail.com',
  );

  // Contraseña con comillas tipográficas de iOS y zero-width space sin alterar mayúsculas reales
  assert.equal(
    sanitizeMobileLoginPassword('\u200BCodi.123\uFEFF'),
    'Codi.123',
  );
  assert.equal(
    sanitizeMobileLoginPassword('Pass\u2019Word\u201C1\u201D'),
    'Pass\'Word"1"',
  );
});

test('mobileAuthCompat: almacenamiento Auth de triple capa sobrevive a Safari Private Mode / QuotaExceededError', () => {
  const brokenStorage = {
    length: 0,
    clear() {},
    key: () => null,
    getItem() {
      throw new Error('SecurityError: The operation is insecure');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  } as unknown as Storage;

  const adapter = createMobileSafeAuthStorage({
    localStorageImpl: brokenStorage,
    sessionStorageImpl: brokenStorage,
  });

  // Jamás debe lanzar y debe persistir en memoria para no expulsar a la promotora en iPhone Privado
  adapter.setItem('codizulca.supabase.auth.v1', '{"access_token":"tok"}');
  assert.equal(adapter.getItem('codizulca.supabase.auth.v1'), '{"access_token":"tok"}');
  adapter.removeItem('codizulca.supabase.auth.v1');
  assert.equal(adapter.getItem('codizulca.supabase.auth.v1'), null);
});

test('mobileAuthCompat: lock seguro serializa sin deadlock en WebKit/iOS y libera ante operación colgada', async () => {
  const lock = createMobileSafeAuthLock(200);
  const trace: string[] = [];

  // Operación 1 colgada simulando socket suspendido en iOS
  const stuck = lock('auth-key', 50, async () => {
    trace.push('start-1');
    await new Promise((r) => setTimeout(r, 400));
    trace.push('end-1');
    return 1;
  });

  // Operación 2 debe continuar tras el timeout corto (50ms) sin quedar colgada indefinidamente
  const t0 = Date.now();
  const secondResult = await lock('auth-key', 50, async () => {
    trace.push('start-2');
    return 2;
  });
  const elapsed = Date.now() - t0;

  assert.equal(secondResult, 2);
  assert.ok(elapsed < 300, `El lock debió destrabar antes de 300ms (tardó ${elapsed}ms)`);
  await stuck;
});

test('mobileAuthCompat: fetchWithCompatibleTimeout aborta peticiones colgadas y detecta errores de red Safari', async () => {
  const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    })) as typeof fetch;

  await assert.rejects(
    () => fetchWithCompatibleTimeout(hangingFetch, 'https://example.invalid', undefined, 40),
    (err: unknown) => isMobileNetworkAuthError(err),
  );

  assert.equal(isMobileNetworkAuthError(new TypeError('Load failed')), true);
  assert.equal(isMobileNetworkAuthError(new TypeError('Failed to fetch')), true);
  assert.equal(isMobileNetworkAuthError(new Error('Invalid login credentials')), false);
});

test('invariantes iOS Safari: sin async directo en onAuthStateChange, inputs anti-zoom 16px y SW actualizado', () => {
  const portalSrc = fs.readFileSync(
    path.resolve('src/components/portal/PromotoraRutaPortalView.tsx'),
    'utf8',
  );
  const tradeGateSrc = fs.readFileSync(
    path.resolve('src/components/auth/TradeAuthGate.tsx'),
    'utf8',
  );
  const supabaseClientSrc = fs.readFileSync(path.resolve('src/services/supabaseClient.ts'), 'utf8');
  const swSrc = fs.readFileSync(path.resolve('public/sw.js'), 'utf8');

  assert.equal(
    /onAuthStateChange\s*\(\s*async\s*\(/.test(portalSrc),
    false,
    'PromotoraRutaPortalView no debe usar async directamente dentro de onAuthStateChange (deadlock iOS WebKit)',
  );
  assert.equal(
    /onAuthStateChange\s*\(\s*async\s*\(/.test(tradeGateSrc),
    false,
    'TradeAuthGate no debe usar async directamente dentro de onAuthStateChange (deadlock iOS WebKit)',
  );
  assert.ok(
    portalSrc.includes('text-base sm:text-sm'),
    'Los inputs de login en /portal deben usar 16px en móvil para evitar auto-zoom de iOS Safari',
  );
  assert.ok(
    supabaseClientSrc.includes('storage: sharedSafeAuthStorage') &&
      !supabaseClientSrc.includes('lock: sharedSafeAuthLock') &&
      supabaseClientSrc.includes('fetchWithCompatibleTimeout') &&
      supabaseClientSrc.includes('isSupabaseAuthEndpoint'),
    'supabaseClient debe usar storage resiliente de triple capa, modo lockless nativo de @supabase/auth-js v2.119+, timeout compatible con iOS y omitir x-sucursal-activa en /auth/v1/',
  );
  assert.ok(
    swSrc.includes("APP_BUILD_ID = '__APP_BUILD_ID__'") &&
      swSrc.includes("SHELL_CACHE_PREFIX = 'codizulca-trade-shell-'") &&
      !swSrc.includes('codizulca-trade-shell-v334') &&
      swSrc.includes('!res.redirected'),
    'public/sw.js debe invalidar automáticamente cachés viejos por buildId y jamás cachear respuestas redirigidas en Safari',
  );
});

test('regresión rebote iPhone: createMobileSafeAuthStorage jamás lee sesión vencida de localStorage si setItem falla o se silencia', () => {
  // Caso 1: localStorage conserva sesión vieja (8:33 AM) y lanza QuotaExceededError al escribir la nueva (9:17 AM)
  const staleData = new Map<string, string>([
    ['codizulca.supabase.auth.v1', '{"access_token":"old-833am","refresh_token":"dead"}'],
  ]);
  const quotaLocal = {
    length: 1,
    clear() {},
    key: () => 'codizulca.supabase.auth.v1',
    getItem: (k: string) => staleData.get(k) ?? null,
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      // Simula WebView iOS donde incluso removeItem falla y deja el valor viejo congelado
      throw new Error('SecurityError');
    },
  } as unknown as Storage;

  const sessionMap = new Map<string, string>();
  const okSession = {
    get length() {
      return sessionMap.size;
    },
    clear: () => sessionMap.clear(),
    key: (i: number) => Array.from(sessionMap.keys())[i] ?? null,
    getItem: (k: string) => sessionMap.get(k) ?? null,
    setItem: (k: string, v: string) => sessionMap.set(k, v),
    removeItem: (k: string) => sessionMap.delete(k),
  } as unknown as Storage;

  const adapter = createMobileSafeAuthStorage({
    localStorageImpl: quotaLocal,
    sessionStorageImpl: okSession,
  });

  adapter.setItem('codizulca.supabase.auth.v1', '{"access_token":"fresh-917am"}');
  assert.equal(
    adapter.getItem('codizulca.supabase.auth.v1'),
    '{"access_token":"fresh-917am"}',
    'Debe devolver la sesión fresca y jamás retroceder a la sesión vencida en localStorage',
  );

  // Caso 2: localStorage no lanza excepción pero silencia la escritura devolviendo siempre el valor antiguo
  const silentFailLocal = {
    length: 1,
    clear() {},
    key: () => 'codizulca.supabase.auth.v1',
    getItem: () => '{"access_token":"stale-silent"}',
    setItem() {
      // No persiste nada (comportamiento documentado en ciertos WebViews iOS)
    },
    removeItem() {},
  } as unknown as Storage;

  const adapter2 = createMobileSafeAuthStorage({
    localStorageImpl: silentFailLocal,
    sessionStorageImpl: null,
  });
  adapter2.setItem('codizulca.supabase.auth.v1', '{"access_token":"fresh-memory-only"}');
  assert.equal(
    adapter2.getItem('codizulca.supabase.auth.v1'),
    '{"access_token":"fresh-memory-only"}',
    'Al detectar fallo silencioso de persistencia, debe usar memoria autoritativa en vez del valor obsoleto',
  );
});

test('regresión rebote iPhone: crearClienteSupabase opera en modo lockless sin deprecation warning de GoTrueClient', () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const client = crearClienteSupabase({
      url: 'http://127.0.0.1:54321',
      publishableKey: 'sb_publishable_ios_lockless_check_1234567890',
      permitirLoopbackPruebas: true,
    });
    assert.ok(client);
    assert.equal(
      warnings.some((w) => /"lock" option is deprecated/i.test(w)),
      false,
      `No debe activar la ruta legada de lock en @supabase/auth-js v2.119+: ${warnings.join(' | ')}`,
    );
  } finally {
    console.warn = origWarn;
  }
});

test('regresión rebote iPhone: x-sucursal-activa se envía a /rest/v1/ pero se omite en /auth/v1/ para evitar preflight CORS extra', async () => {
  const captured: Array<{ url: string; hasSucursalHeader: boolean }> = [];
  const spyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    captured.push({ url, hasSucursalHeader: headers.has('x-sucursal-activa') });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  setActiveClientSucursalHeader('ZULIA');
  try {
    const client = crearClienteSupabase({
      url: 'http://127.0.0.1:54321',
      publishableKey: 'sb_publishable_ios_cors_check_1234567890',
      permitirLoopbackPruebas: true,
      fetch: spyFetch,
    });
    await client.auth.getUser('fake-jwt-token').catch(() => undefined);
    await client.from('promotoras').select('id').limit(1);

    const authCall = captured.find((c) => c.url.includes('/auth/v1/'));
    const restCall = captured.find((c) => c.url.includes('/rest/v1/'));
    assert.ok(authCall, 'Debe registrar llamada a /auth/v1/');
    assert.ok(restCall, 'Debe registrar llamada a /rest/v1/');
    assert.equal(
      authCall.hasSucursalHeader,
      false,
      '/auth/v1/* no debe enviar x-sucursal-activa (evita CORS preflight en iPhone/4G)',
    );
    assert.equal(
      restCall.hasSucursalHeader,
      true,
      '/rest/v1/* debe conservar x-sucursal-activa para el aislamiento regional',
    );
  } finally {
    setActiveClientSucursalHeader(null);
  }
});

test('regresión rebote iPhone: blindaje de carreras en PromotoraRutaPortalView, TradeAuthGate y authService', () => {
  const portalSrc = fs.readFileSync(
    path.resolve('src/components/portal/PromotoraRutaPortalView.tsx'),
    'utf8',
  );
  const tradeGateSrc = fs.readFileSync(
    path.resolve('src/components/auth/TradeAuthGate.tsx'),
    'utf8',
  );
  const authServiceSrc = fs.readFileSync(path.resolve('src/services/authService.ts'), 'utf8');

  // 1. PromotoraRutaPortalView: protege sesión activa contra INITIAL_SESSION(null), ecos same-user y SIGNED_OUT rezagado
  assert.ok(
    portalSrc.includes('authenticatedUserIdRef.current = verifiedProfile.userId') &&
      portalSrc.includes("event === 'INITIAL_SESSION' && !session") &&
      portalSrc.includes('authenticatedUserIdRef.current === session.user.id') &&
      portalSrc.includes('manualSignOutRef'),
    'PromotoraRutaPortalView debe blindar la sesión activa contra rebotes silenciosos tras el login en iOS',
  );

  // 2. TradeAuthGate: jamás purga tokens de localStorage en INITIAL_SESSION vacío (solo en SIGNED_OUT explícito)
  assert.ok(
    tradeGateSrc.includes("if (event === 'SIGNED_OUT') {") &&
      !tradeGateSrc.includes("reason: event === 'SIGNED_OUT' ? 'sign_out' : 'token_expired'"),
    'TradeAuthGate solo debe purgar cachés/tokens de sesión en evento SIGNED_OUT explícito',
  );

  // 3. authService: verifica desactivación explícita y evita signOut destructivo si la promotora quedó sin señal
  assert.ok(
    authServiceSrc.includes('if (!resolvedCorporate)') &&
      authServiceSrc.includes('appMeta.is_active === false') &&
      authServiceSrc.includes('navigator.onLine === false'),
    'verifyActivePromotoraPortalAccess debe mantener bloqueo Zero Trust para cuentas inactivas y evitar cierre destructivo offline',
  );
});

test('iOS HEIC/HEIF: acepta fotos nativas de iPhone para transcodificar a JPEG y mantiene bloqueo contra SVG/HTML/EXE', async () => {
  // Cabecera ISO-BMFF real `....ftypheic` (iPhone High Efficiency)
  const heicBytes = new Uint8Array([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70, // ftyp
    0x68, 0x65, 0x69, 0x63, // heic
    0x00, 0x00, 0x00, 0x00,
  ]);
  assert.equal(isHeicHeaderBytes(heicBytes), true);

  const heicBlob = new Blob([heicBytes], { type: 'image/heic' });
  const detectedMime = await validateClientImageHeaderBytes(heicBlob);
  assert.equal(detectedMime, 'image/jpeg');
  assert.deepEqual(validatePortalImageFile(heicBlob), { mimeType: 'image/jpeg', ext: 'jpg' });

  // SVG / HTML / ejecutable MZ deben seguir bloqueados de inmediato
  const svgBlob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], {
    type: 'image/svg+xml',
  });
  await assert.rejects(() => validateClientImageHeaderBytes(svgBlob), /Formato bloqueado/);
  assert.throws(() => validatePortalImageFile(svgBlob), /Formato de imagen no permitido/);
});
