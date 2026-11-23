/**
 * Aprovisionamiento Idempotente y Seguro — Coordinadora de Trade Centro y Andes
 *
 * Cuenta aprovisionada:
 *   - Email: maria01@codizulca.com
 *   - Rol autorizado (app_metadata + public.profiles): coordinador_trade
 *   - Regiones asignadas (estrictas): ['CENTRO', 'ANDES'] (scope: regional)
 *
 * Seguridad innegociable:
 *   - CERO contraseñas literales ni llaves secretas en el código.
 *   - Lee SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y MARIA_INITIAL_PASSWORD
 *     exclusivamente desde variables de entorno (`process.env`), abortando
 *     limpiamente si falta cualquiera.
 *   - Jamás imprime contraseñas ni `SUPABASE_SERVICE_ROLE_KEY` en consola.
 *
 * Uso local seguro:
 *   PowerShell:
 *     $env:MARIA_INITIAL_PASSWORD = "<CLAVE_SEGURA_MIN_8_CHARS>"
 *     npm run seed:coordinadora-centro-andes
 *     Remove-Item Env:MARIA_INITIAL_PASSWORD
 *
 *   Bash / macOS / Linux:
 *     MARIA_INITIAL_PASSWORD="<CLAVE_SEGURA_MIN_8_CHARS>" npm run seed:coordinadora-centro-andes
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

export const MARIA_EMAIL = 'maria01@codizulca.com';
export const MARIA_DEFAULT_DISPLAY_NAME = 'María';
export const MARIA_CARGO = 'Coordinadora de Trade Centro y Andes';
export const MARIA_ROLE = 'coordinador_trade';
export const MARIA_REGIONS = ['CENTRO', 'ANDES'];
export const MARIA_PRIMARY_REGION_LABEL = 'Centro';
export const MARIA_PRIMARY_SUCURSAL = 'CENTRO';
export const MARIA_SCOPE = 'regional';
export const MIN_PASSWORD_LENGTH = 8;

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CURRENT_DIR, '..');

export function loadLocalEnvFiles(projectRoot = PROJECT_ROOT) {
  const envLocalPath = path.join(projectRoot, '.env.local');
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: false, quiet: true });
  }
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

/**
 * Valida variables de entorno requeridas fail-fast sin exponer secretos.
 * @param {NodeJS.ProcessEnv} env
 */
export function readMariaSeedEnv(env = process.env) {
  const supabaseUrl = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim();
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const initialPassword = String(env.MARIA_INITIAL_PASSWORD || '').trim();
  const displayName =
    String(env.MARIA_DISPLAY_NAME || '').replace(/\s+/g, ' ').trim() ||
    MARIA_DEFAULT_DISPLAY_NAME;

  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!initialPassword) missing.push('MARIA_INITIAL_PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno obligatorias: ${missing.join(', ')}. ` +
        'Defínelas en tu shell o en `.env.local` (ignorado por Git) y vuelve a ejecutar el script.'
    );
  }

  if (!/^https?:\/\//i.test(supabaseUrl)) {
    throw new Error(
      'SUPABASE_URL inválida: debe iniciar con https:// (o http:// en entorno local).'
    );
  }

  if (initialPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `MARIA_INITIAL_PASSWORD debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`
    );
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    initialPassword,
    displayName,
  };
}

/**
 * Construye el payload de Supabase Auth Admin para María (Centro y Andes).
 * Autorización EXCLUSIVAMENTE en `app_metadata` (solo service_role).
 * `user_metadata` contiene únicamente información de presentación (jamás rol ni regiones).
 */
export function buildMariaAuthPayload({ password, displayName, centroRegionId, andesRegionId }) {
  const regionIds = [centroRegionId, andesRegionId].filter(Boolean);
  return {
    email: MARIA_EMAIL,
    password,
    email_confirm: true,
    app_metadata: {
      role: MARIA_ROLE,
      app_role: MARIA_ROLE,
      regions: [...MARIA_REGIONS],
      region: MARIA_PRIMARY_REGION_LABEL,
      sucursal: MARIA_PRIMARY_SUCURSAL,
      scope: MARIA_SCOPE,
      display_name: displayName || MARIA_DEFAULT_DISPLAY_NAME,
      ...(centroRegionId ? { region_id: centroRegionId } : {}),
      ...(regionIds.length > 0 ? { region_ids: regionIds } : {}),
    },
    user_metadata: {
      nombre_completo: displayName || MARIA_DEFAULT_DISPLAY_NAME,
      cargo: MARIA_CARGO,
    },
  };
}

/**
 * Construye el registro de `public.profiles` enlazado a `auth.users.id`.
 */
export function buildMariaProfilePayload({
  authUserId,
  displayName,
  centroRegionId,
  includeRegionesAsignadas = true,
  includeRegionColumn = true,
}) {
  return {
    id: authUserId,
    email: MARIA_EMAIL,
    full_name: displayName || MARIA_DEFAULT_DISPLAY_NAME,
    role: MARIA_ROLE,
    sucursal: MARIA_PRIMARY_SUCURSAL,
    region_id: centroRegionId || null,
    is_active: true,
    ...(includeRegionColumn ? { region: MARIA_PRIMARY_REGION_LABEL } : {}),
    ...(includeRegionesAsignadas ? { regiones_asignadas: [...MARIA_REGIONS] } : {}),
  };
}

async function resolveCentroAndAndesRegionIds(supabase) {
  const { data, error } = await supabase
    .from('Regiones')
    .select('id_regi, regi_desd')
    .limit(50);

  if (error) {
    throw new Error(`No se pudo consultar public."Regiones": ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  const centroRow = rows.find(
    (r) => String(r?.regi_desd || '').trim().toUpperCase() === 'CENTRO'
  );
  const andesRow = rows.find(
    (r) => String(r?.regi_desd || '').trim().toUpperCase() === 'ANDES'
  );

  if (!centroRow?.id_regi || !andesRow?.id_regi) {
    throw new Error(
      'No se encontraron ambas regiones oficiales ("CENTRO" y "ANDES") en public."Regiones".'
    );
  }

  return {
    centroRegionId: String(centroRow.id_regi),
    andesRegionId: String(andesRow.id_regi),
  };
}

async function findAuthUserByEmail(supabase, targetEmail) {
  const normalizedTarget = targetEmail.trim().toLowerCase();
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`Error listando usuarios en Supabase Auth: ${error.message}`);
    }
    const users = Array.isArray(data?.users) ? data.users : [];
    const found = users.find(
      (u) => String(u?.email || '').trim().toLowerCase() === normalizedTarget
    );
    if (found) return found;
    if (users.length < perPage) break;
  }

  return null;
}

async function upsertMariaProfile(supabase, { authUserId, displayName, centroRegionId }) {
  const attempts = [
    buildMariaProfilePayload({
      authUserId,
      displayName,
      centroRegionId,
      includeRegionesAsignadas: true,
      includeRegionColumn: true,
    }),
    buildMariaProfilePayload({
      authUserId,
      displayName,
      centroRegionId,
      includeRegionesAsignadas: true,
      includeRegionColumn: false,
    }),
    buildMariaProfilePayload({
      authUserId,
      displayName,
      centroRegionId,
      includeRegionesAsignadas: false,
      includeRegionColumn: true,
    }),
    buildMariaProfilePayload({
      authUserId,
      displayName,
      centroRegionId,
      includeRegionesAsignadas: false,
      includeRegionColumn: false,
    }),
  ];

  let lastError = null;
  for (const payload of attempts) {
    const { data, error } = await supabase
      .from('profiles')
      .upsert(payload, { onConflict: 'id' })
      .select('id, email, full_name, role, sucursal, region_id, is_active')
      .single();

    if (!error) {
      return data;
    }

    lastError = error;
    const isMissingCol =
      /column .* does not exist|Could not find the '.*' column/i.test(error.message || '');
    if (!isMissingCol) {
      break;
    }
  }

  throw new Error(
    `Error realizando UPSERT en public.profiles: ${lastError?.message || 'error desconocido'}`
  );
}

export async function runSeedCoordinadoraCentroAndes(env = process.env) {
  const { supabaseUrl, serviceRoleKey, initialPassword, displayName } = readMariaSeedEnv(env);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { centroRegionId, andesRegionId } = await resolveCentroAndAndesRegionIds(supabase);
  const authPayload = buildMariaAuthPayload({
    password: initialPassword,
    displayName,
    centroRegionId,
    andesRegionId,
  });

  const existingUser = await findAuthUserByEmail(supabase, MARIA_EMAIL);
  let authAction = 'updated';
  let authUserId = '';

  if (existingUser?.id) {
    const existingAppMeta =
      existingUser.app_metadata && typeof existingUser.app_metadata === 'object'
        ? existingUser.app_metadata
        : {};
    const { data, error } = await supabase.auth.admin.updateUserById(existingUser.id, {
      email: authPayload.email,
      password: authPayload.password,
      email_confirm: true,
      app_metadata: {
        ...existingAppMeta,
        ...authPayload.app_metadata,
      },
      user_metadata: authPayload.user_metadata,
    });
    if (error || !data?.user?.id) {
      throw new Error(
        `Error actualizando cuenta en Supabase Auth: ${error?.message || 'respuesta sin usuario'}`
      );
    }
    authUserId = data.user.id;
    authAction = 'updated';
  } else {
    const { data, error } = await supabase.auth.admin.createUser(authPayload);
    if (error || !data?.user?.id) {
      throw new Error(
        `Error creando cuenta en Supabase Auth: ${error?.message || 'respuesta sin usuario'}`
      );
    }
    authUserId = data.user.id;
    authAction = 'created';
  }

  const profileRow = await upsertMariaProfile(supabase, {
    authUserId,
    displayName,
    centroRegionId,
  });

  return {
    authAction,
    authUserId,
    email: MARIA_EMAIL,
    displayName,
    role: MARIA_ROLE,
    regions: [...MARIA_REGIONS],
    scope: MARIA_SCOPE,
    centroRegionId,
    andesRegionId,
    profileActive: Boolean(profileRow?.is_active),
  };
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  loadLocalEnvFiles();
  runSeedCoordinadoraCentroAndes(process.env)
    .then((summary) => {
      console.log('\n====================================================================');
      console.log(' APROVISIONAMIENTO COORDINADORA CENTRO Y ANDES — RESUMEN LIMPIO');
      console.log('====================================================================');
      console.log(` Accion Auth      : ${summary.authAction === 'created' ? 'CUENTA CREADA' : 'CUENTA ACTUALIZADA (IDEMPOTENTE)'}`);
      console.log(` Auth User ID     : ${summary.authUserId}`);
      console.log(` Correo           : ${summary.email}`);
      console.log(` Nombre Perfil    : ${summary.displayName}`);
      console.log(` Rol (app_meta)   : ${summary.role}`);
      console.log(` Regiones (array) : ${summary.regions.join(', ')} (scope: ${summary.scope})`);
      console.log(` Region ID CENTRO : ${summary.centroRegionId}`);
      console.log(` Region ID ANDES  : ${summary.andesRegionId}`);
      console.log(` Perfil activo    : ${summary.profileActive ? 'true (UPSERT public.profiles OK)' : 'false'}`);
      console.log(' Seguridad        : Contrasena y SERVICE_ROLE_KEY omitidas de la salida.');
      console.log('====================================================================\n');
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[ERROR] Aprovisionamiento abortado: ${msg}\n`);
      process.exit(1);
    });
}
