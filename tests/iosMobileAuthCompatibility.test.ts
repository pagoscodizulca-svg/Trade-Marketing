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
      supabaseClientSrc.includes('lock: sharedSafeAuthLock') &&
      supabaseClientSrc.includes('fetchWithCompatibleTimeout'),
    'supabaseClient debe usar storage resiliente de triple capa, lock seguro iOS y fetch con timeout compatible con iOS',
  );
  assert.ok(
    swSrc.includes("SHELL_CACHE = 'codizulca-trade-shell-v334'") &&
      swSrc.includes('!res.redirected'),
    'public/sw.js debe invalidar caché viejo v322 y jamás cachear respuestas redirigidas en Safari',
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
