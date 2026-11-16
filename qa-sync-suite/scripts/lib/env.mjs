import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const QA_SUITE_ROOT = path.resolve(__dirname, '..', '..');
export const ENV_TEST_PATH = path.join(QA_SUITE_ROOT, '.env.test');
export const TMP_DIR_PATH = path.join(QA_SUITE_ROOT, '.tmp');
export const REPORTS_DIR_PATH = path.join(QA_SUITE_ROOT, 'reports');

const ALLOWED_ADMIN_CALLERS = new Set([
  'seed-qa-environment.mjs',
  'teardown-qa-environment.mjs',
  'verify-zero-residue.mjs',
]);

let envLoaded = false;

function ensureEnvLoaded() {
  if (envLoaded) return;
  if (fs.existsSync(ENV_TEST_PATH)) {
    dotenv.config({ path: ENV_TEST_PATH, override: false, quiet: true });
  }
  envLoaded = true;
}

/**
 * Redacta cualquier token JWT, llave de Supabase o credencial accidental en mensajes de error.
 */
export function redactSensitive(input) {
  const raw = String(input ?? '');
  return raw
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, '[REDACTED_SB_SECRET]')
    .replace(/sb_publishable_[A-Za-z0-9_-]+/g, '[REDACTED_SB_PUBLISHABLE]')
    .replace(/https:\/\/[a-z0-9-]+\.supabase\.co/gi, 'https://[REDACTED_PROJECT].supabase.co');
}

function normalizeUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1\/?$/, '');
}

function isPlaceholderValue(val) {
  const v = String(val || '').trim();
  if (!v) return true;
  return (
    v.includes('example-project-ref') ||
    v.includes('placeholder_do_not_commit') ||
    v === 'YOUR_SUPABASE_URL' ||
    v === 'YOUR_SUPABASE_ANON_KEY' ||
    v === 'YOUR_SUPABASE_SERVICE_ROLE_KEY'
  );
}

export function assertNotServiceRoleKey(key, varName = 'SUPABASE_ANON_KEY') {
  const trimmed = String(key || '').trim();
  if (!trimmed) return;
  if (trimmed.startsWith('sb_secret_')) {
    throw new Error(
      `VIOLACION DE SEGURIDAD: ${varName} contiene una llave secreta (sb_secret_*). Use exclusivamente la llave publica ANON.`
    );
  }
  if (trimmed.startsWith('eyJ')) {
    const parts = trimmed.split('.');
    if (parts.length === 3 && parts[1]) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload?.role === 'service_role') {
          throw new Error(
            `VIOLACION DE SEGURIDAD: ${varName} contiene un JWT con rol service_role.`
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('VIOLACION DE SEGURIDAD:')) {
          throw err;
        }
      }
    }
  }
}

export function checkEnvReadiness() {
  ensureEnvLoaded();
  const hasEnvFile = fs.existsSync(ENV_TEST_PATH);
  const supabaseUrl = normalizeUrl(process.env.SUPABASE_URL);
  const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  const supabaseServiceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  return {
    hasEnvFile,
    hasSupabaseUrl: !isPlaceholderValue(supabaseUrl) && supabaseUrl.startsWith('https://'),
    hasSupabaseAnonKey: !isPlaceholderValue(supabaseAnonKey),
    hasSupabaseServiceRoleKey: !isPlaceholderValue(supabaseServiceRoleKey),
  };
}

/**
 * Carga variables públicas para las pruebas funcionales (`tests/*.spec.*`).
 * JAMÁS expone ni retorna `SUPABASE_SERVICE_ROLE_KEY`.
 */
export function loadPublicQaEnv() {
  ensureEnvLoaded();
  const supabaseUrl = normalizeUrl(process.env.SUPABASE_URL);
  const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

  if (isPlaceholderValue(supabaseUrl) || !supabaseUrl.startsWith('https://')) {
    throw new Error(
      'Falta configurar SUPABASE_URL válido en qa-sync-suite/.env.test (ver .env.test.example).'
    );
  }
  if (isPlaceholderValue(supabaseAnonKey)) {
    throw new Error(
      'Falta configurar SUPABASE_ANON_KEY válido en qa-sync-suite/.env.test (ver .env.test.example).'
    );
  }

  assertNotServiceRoleKey(supabaseAnonKey, 'SUPABASE_ANON_KEY');

  const renderPlanificadorUrl = normalizeUrl(
    process.env.RENDER_PLANIFICADOR_URL || 'https://dashboard-fdv-planificador.onrender.com'
  );
  const tradeMarketingAppUrl = normalizeUrl(
    process.env.TRADE_MARKETING_APP_URL || 'http://localhost:3000'
  );
  const parsedRps = Number(process.env.QA_RATE_LIMIT_RPS || 1);
  const rateLimitRps = Number.isFinite(parsedRps)
    ? Math.min(2, Math.max(0.5, parsedRps))
    : 1;

  return Object.freeze({
    supabaseUrl,
    supabaseAnonKey,
    renderPlanificadorUrl,
    tradeMarketingAppUrl,
    rateLimitRps,
  });
}

/**
 * Carga variables administrativas con `SUPABASE_SERVICE_ROLE_KEY`.
 * Restringido estrictamente a los 3 scripts administrativos autorizados.
 */
export function loadAdminQaEnv(callerScriptName) {
  if (!ALLOWED_ADMIN_CALLERS.has(callerScriptName)) {
    throw new Error(
      `VIOLACION DE SEGREGACION DE LLAVES: "${callerScriptName}" no tiene permiso para leer SUPABASE_SERVICE_ROLE_KEY.`
    );
  }

  const publicEnv = loadPublicQaEnv();
  const supabaseServiceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (isPlaceholderValue(supabaseServiceRoleKey)) {
    throw new Error(
      'Falta configurar SUPABASE_SERVICE_ROLE_KEY válido en qa-sync-suite/.env.test para aprovisionamiento y purga Cero-Residuos.'
    );
  }

  if (supabaseServiceRoleKey === publicEnv.supabaseAnonKey) {
    throw new Error(
      'CONFIGURACION INVALIDA: SUPABASE_SERVICE_ROLE_KEY no puede ser idéntica a SUPABASE_ANON_KEY.'
    );
  }

  return Object.freeze({
    ...publicEnv,
    supabaseServiceRoleKey,
  });
}
