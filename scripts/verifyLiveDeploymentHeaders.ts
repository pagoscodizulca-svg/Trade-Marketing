/**
 * Verificador Zero-Trust de Cabeceras de Seguridad y CORS en Despliegue — Compuerta G4 (#3).
 *
 * REGLAS INQUEBRANTABLES DE SEGURIDAD:
 *  - JAMÁS importa `dotenv` ni abre/lee `.env`, `.env.local`, `.env.*`, `src/config/env.js`,
 *    `ruta-degustacion/.env*` ni `qa-sync-suite/.env.test`.
 *  - Lee configuración EXCLUSIVAMENTE desde `process.env` (`DEPLOY_BASE_URL` / `RENDER_EXTERNAL_URL`,
 *    `CORS_ALLOWED_ORIGINS` / `EXPECTED_ALLOWED_ORIGIN`) o parámetros explícitos en pruebas.
 *  - Ejecuta `assertSafeEnvironment` antes de cualquier operación y aborta (código 2) si detecta
 *    secretos bajo prefijo `VITE_*`.
 *  - Todas las salidas y detalles pasan por `redactSecrets`.
 */
import { pathToFileURL } from 'node:url';
import { parseAllowedOrigins } from '../src/server/securityMiddleware';
import {
  assertSafeEnvironment,
  redactSecrets,
  SecurityEnvViolationError,
} from './certifySchemaProduction';

export { assertSafeEnvironment, redactSecrets, SecurityEnvViolationError };

export const MIN_HSTS_MAX_AGE_SECONDS = 15_552_000;
export const UNAUTHORIZED_PROBE_ORIGIN = 'https://evil-probe.invalid';

export interface DeploymentHeaderCheck {
  id: string;
  passed: boolean;
  severity: 'error' | 'warning';
  detail: string;
}

export interface LiveDeploymentVerificationOptions {
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  expectedAllowedOrigin?: string;
  unauthorizedOrigin?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LiveDeploymentVerificationReport {
  passed: boolean;
  targetOrigin: string;
  checkedAtIso: string;
  checks: DeploymentHeaderCheck[];
}

export interface ResolvedDeploymentTarget {
  baseUrl: string;
  targetOrigin: string;
  expectedAllowedOrigin: string | null;
  unauthorizedOrigin: string;
}

function normalizeHttpBaseUrl(rawUrl: string): { baseUrl: string; origin: string } {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    throw new SecurityEnvViolationError(
      'MISSING_DEPLOY_BASE_URL',
      'Defina DEPLOY_BASE_URL o RENDER_EXTERNAL_URL en el entorno de terminal para verificar el despliegue.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SecurityEnvViolationError(
      'INVALID_DEPLOY_BASE_URL',
      `URL de despliegue inválida: ${redactSecrets(trimmed)}`
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SecurityEnvViolationError(
      'UNSUPPORTED_DEPLOY_PROTOCOL',
      `Protocolo no soportado en DEPLOY_BASE_URL (${parsed.protocol}). Use https:// o http://.`
    );
  }

  if (parsed.username || parsed.password) {
    throw new SecurityEnvViolationError(
      'CREDENTIALS_IN_DEPLOY_URL',
      'DEPLOY_BASE_URL no debe incluir credenciales embebidas en la URL.'
    );
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return {
    baseUrl: `${parsed.origin}${cleanPath}`,
    origin: parsed.origin,
  };
}

export function resolveDeploymentTargetConfig(
  options: LiveDeploymentVerificationOptions = {}
): ResolvedDeploymentTarget {
  const env = options.env ?? process.env;
  assertSafeEnvironment(env);

  const rawBase =
    options.baseUrl ?? env.DEPLOY_BASE_URL ?? env.RENDER_EXTERNAL_URL ?? '';
  const { baseUrl, origin } = normalizeHttpBaseUrl(rawBase);

  const rawExpectedOrigin =
    options.expectedAllowedOrigin ??
    env.EXPECTED_ALLOWED_ORIGIN ??
    env.CORS_ALLOWED_ORIGINS ??
    '';
  const parsedAllowed = parseAllowedOrigins(rawExpectedOrigin);
  const expectedAllowedOrigin = parsedAllowed[0] ?? null;

  const parsedUnauthorized = parseAllowedOrigins(
    options.unauthorizedOrigin ?? UNAUTHORIZED_PROBE_ORIGIN
  );
  const unauthorizedOrigin = parsedUnauthorized[0] ?? UNAUTHORIZED_PROBE_ORIGIN;

  return {
    baseUrl,
    targetOrigin: origin,
    expectedAllowedOrigin,
    unauthorizedOrigin,
  };
}

function extractCspDirectiveValues(csp: string, directiveName: string): string | null {
  const directives = csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  for (const entry of directives) {
    const [name, ...rest] = entry.split(/\s+/);
    if (name && name.toLowerCase() === directiveName.toLowerCase()) {
      return rest.join(' ');
    }
  }
  return null;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyLiveDeploymentHeaders(
  options: LiveDeploymentVerificationOptions = {}
): Promise<LiveDeploymentVerificationReport> {
  const target = resolveDeploymentTargetConfig(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.max(500, options.timeoutMs ?? 10_000);
  const healthUrl = `${target.baseUrl}/api/health`;
  const checks: DeploymentHeaderCheck[] = [];

  const pushCheck = (
    id: string,
    passed: boolean,
    detail: string,
    severity: 'error' | 'warning' = 'error'
  ) => {
    checks.push({
      id,
      passed,
      severity,
      detail: redactSecrets(detail),
    });
  };

  let healthRes: Response;
  try {
    healthRes = await fetchWithTimeout(
      fetchImpl,
      healthUrl,
      { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs
    );
  } catch (err) {
    pushCheck(
      'health.reachable',
      false,
      `No se pudo conectar a GET /api/health en ${target.targetOrigin}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return {
      passed: false,
      targetOrigin: target.targetOrigin,
      checkedAtIso: new Date().toISOString(),
      checks,
    };
  }

  // 1. GET /api/health -> HTTP 200, JSON {"status":"ok"}, Cache-Control: no-store
  const cacheControl = healthRes.headers.get('cache-control') ?? '';
  let parsedHealthJson: Record<string, unknown> | null = null;
  let rawHealthText = '';
  try {
    rawHealthText = await healthRes.text();
    parsedHealthJson = JSON.parse(rawHealthText) as Record<string, unknown>;
  } catch {
    parsedHealthJson = null;
  }

  const isStatusOk =
    healthRes.status === 200 &&
    parsedHealthJson !== null &&
    typeof parsedHealthJson === 'object' &&
    parsedHealthJson.status === 'ok' &&
    !('ports' in parsedHealthJson);
  const hasNoStore = /\bno-store\b/i.test(cacheControl);

  pushCheck(
    'health.status_and_no_store',
    isStatusOk && hasNoStore,
    isStatusOk && hasNoStore
      ? `GET /api/health respondió HTTP 200 {"status":"ok"} con Cache-Control: ${cacheControl}.`
      : `GET /api/health incumple contrato: HTTP ${healthRes.status}, Cache-Control="${cacheControl}", body=${rawHealthText.slice(0, 120)}`
  );

  // 2. Content-Security-Policy estricta
  const csp = healthRes.headers.get('content-security-policy') ?? '';
  const defaultSrc = extractCspDirectiveValues(csp, 'default-src');
  const scriptSrc = extractCspDirectiveValues(csp, 'script-src');
  const frameAncestors = extractCspDirectiveValues(csp, 'frame-ancestors');
  const objectSrc = extractCspDirectiveValues(csp, 'object-src');

  const cspOk =
    Boolean(csp) &&
    defaultSrc !== null &&
    defaultSrc.includes("'self'") &&
    scriptSrc !== null &&
    scriptSrc.includes("'self'") &&
    !scriptSrc.includes("'unsafe-inline'") &&
    !scriptSrc.includes("'unsafe-eval'") &&
    frameAncestors !== null &&
    frameAncestors.includes("'none'") &&
    objectSrc !== null &&
    objectSrc.includes("'none'");

  pushCheck(
    'headers.content_security_policy',
    cspOk,
    cspOk
      ? "Content-Security-Policy presente y estricta (default-src 'self'; script-src 'self'; frame-ancestors 'none'; object-src 'none')."
      : `Content-Security-Policy ausente o débil: "${csp || '<vacía>'}"`
  );

  // 3. Strict-Transport-Security (max-age >= 15552000)
  const hsts = healthRes.headers.get('strict-transport-security') ?? '';
  const maxAgeMatch = hsts.match(/max-age=(\d+)/i);
  const maxAgeSeconds = maxAgeMatch ? Number.parseInt(maxAgeMatch[1]!, 10) : NaN;
  const hstsOk =
    Number.isFinite(maxAgeSeconds) && maxAgeSeconds >= MIN_HSTS_MAX_AGE_SECONDS;

  pushCheck(
    'headers.strict_transport_security',
    hstsOk,
    hstsOk
      ? `Strict-Transport-Security activa (max-age=${maxAgeSeconds} >= ${MIN_HSTS_MAX_AGE_SECONDS}).`
      : `Strict-Transport-Security insuficiente o ausente: "${hsts || '<vacía>'}" (requerido max-age>=${MIN_HSTS_MAX_AGE_SECONDS}).`
  );

  // 4. X-Content-Type-Options: nosniff y X-Powered-By ausente
  const xcto = (healthRes.headers.get('x-content-type-options') ?? '').trim().toLowerCase();
  const xPoweredBy = healthRes.headers.get('x-powered-by');
  const nosniffAndNoPoweredBy = xcto === 'nosniff' && (xPoweredBy === null || xPoweredBy === '');

  pushCheck(
    'headers.nosniff_and_no_powered_by',
    nosniffAndNoPoweredBy,
    nosniffAndNoPoweredBy
      ? 'X-Content-Type-Options: nosniff presente y X-Powered-By ausente.'
      : `Cabeceras anti-fingerprinting inválidas: X-Content-Type-Options="${xcto || '<vacía>'}", X-Powered-By="${xPoweredBy ?? '<ausente>'}".`
  );

  // 5a. CORS_ALLOWED_ORIGINS: origen permitido recibe Access-Control-Allow-Origin exacto
  if (target.expectedAllowedOrigin) {
    const allowedRes = await fetchWithTimeout(
      fetchImpl,
      healthUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Origin: target.expectedAllowedOrigin,
        },
      },
      timeoutMs
    );
    const acao = allowedRes.headers.get('access-control-allow-origin');
    const allowedOriginOk =
      allowedRes.status === 200 && acao === target.expectedAllowedOrigin;

    pushCheck(
      'cors.allowed_origin_match',
      allowedOriginOk,
      allowedOriginOk
        ? `Origen autorizado (${target.expectedAllowedOrigin}) aceptado con Access-Control-Allow-Origin exacto.`
        : `Origen autorizado (${target.expectedAllowedOrigin}) falló: HTTP ${allowedRes.status}, Access-Control-Allow-Origin="${acao ?? '<ausente>'}".`
    );
  } else {
    pushCheck(
      'cors.allowed_origin_configured',
      true,
      'CORS_ALLOWED_ORIGINS / EXPECTED_ALLOWED_ORIGIN no especificado en el entorno; se omitió prueba positiva de origen externo.',
      'warning'
    );
  }

  // 5b. Origen no autorizado (https://evil-probe.invalid) bloqueado (403 o sin ACAO)
  const evilRes = await fetchWithTimeout(
    fetchImpl,
    healthUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Origin: target.unauthorizedOrigin,
      },
    },
    timeoutMs
  );
  const evilAcao = evilRes.headers.get('access-control-allow-origin');
  const evilBlocked =
    (evilRes.status === 403 || evilAcao === null || evilAcao === '') &&
    evilAcao !== target.unauthorizedOrigin &&
    evilAcao !== '*';

  pushCheck(
    'cors.unauthorized_origin_blocked',
    evilBlocked,
    evilBlocked
      ? `Origen no autorizado (${target.unauthorizedOrigin}) bloqueado (HTTP ${evilRes.status}, Access-Control-Allow-Origin ausente).`
      : `FUGA CORS: origen no autorizado (${target.unauthorizedOrigin}) recibió HTTP ${evilRes.status} y Access-Control-Allow-Origin="${evilAcao}".`
  );

  const passed = checks.every((c) => c.passed || c.severity === 'warning');

  return {
    passed,
    targetOrigin: target.targetOrigin,
    checkedAtIso: new Date().toISOString(),
    checks,
  };
}

function parseCliArgs(argv: string[]): { baseUrl?: string; expectedAllowedOrigin?: string } {
  let baseUrl: string | undefined;
  let expectedAllowedOrigin: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) {
      baseUrl = argv[i + 1];
      i += 1;
    } else if (arg === '--allowed-origin' && argv[i + 1]) {
      expectedAllowedOrigin = argv[i + 1];
      i += 1;
    }
  }

  return { baseUrl, expectedAllowedOrigin };
}

function writeReport(report: LiveDeploymentVerificationReport): void {
  process.stdout.write(
    `${redactSecrets(
      `\n=== [VERIFICADOR DE CABECERAS DE DESPLIEGUE — ${report.targetOrigin}] ===`
    )}\n`
  );
  for (const check of report.checks) {
    const tag = check.passed
      ? check.severity === 'warning'
        ? '[WARN]'
        : '[PASS]'
      : '[FAIL]';
    process.stdout.write(`  ${tag} ${check.id}: ${redactSecrets(check.detail)}\n`);
  }
  process.stdout.write(
    `Resultado global: ${report.passed ? 'PASS' : 'FAIL'} (${report.checkedAtIso})\n`
  );
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  (async () => {
    try {
      const cli = parseCliArgs(process.argv.slice(2));
      const report = await verifyLiveDeploymentHeaders({
        env: process.env,
        baseUrl: cli.baseUrl,
        expectedAllowedOrigin: cli.expectedAllowedOrigin,
      });
      writeReport(report);
      process.exit(report.passed ? 0 : 1);
    } catch (err) {
      if (err instanceof SecurityEnvViolationError) {
        process.stderr.write(
          `[SEGURIDAD/CONFIG][${err.code}] ${redactSecrets(err.message)}\n`
        );
        process.exit(2);
      }
      process.stderr.write(
        `[VERIFY_HEADERS_ERROR] ${redactSecrets(err instanceof Error ? err.message : err)}\n`
      );
      process.exit(1);
    }
  })();
}
