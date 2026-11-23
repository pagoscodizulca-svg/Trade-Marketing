/**
 * Aprovisionamiento Idempotente y Seguro — Grecia (Coordinadora de Trade de Occidente)
 *
 * Cuenta aprovisionada:
 *   - Email: grecia01@codizulca.com
 *   - Rol autorizado (app_metadata + public.profiles): coordinador_trade
 *   - Región asignada (estricta): Occidente (sucursal legacy: ZULIA, scope: regional)
 *
 * Seguridad innegociable:
 *   - CERO contraseñas literales ni llaves secretas en el código.
 *   - Lee SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y GRECIA_INITIAL_PASSWORD
 *     exclusivamente desde variables de entorno (`process.env`), abortando
 *     limpiamente si falta cualquiera.
 *   - Jamás imprime contraseñas ni `SUPABASE_SERVICE_ROLE_KEY` en consola.
 *
 * Uso local seguro:
 *   PowerShell:
 *     $env:GRECIA_INITIAL_PASSWORD = "<CLAVE_SEGURA_MIN_8_CHARS>"
 *     npm run seed:coordinadora-occidente
 *
 *   Bash / macOS / Linux:
 *     GRECIA_INITIAL_PASSWORD="<CLAVE_SEGURA_MIN_8_CHARS>" npm run seed:coordinadora-occidente
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

export const COORDINADORA_EMAIL = 'grecia01@codizulca.com';
export const COORDINADORA_FULL_NAME = 'Grecia';
export const COORDINADORA_CARGO = 'Coordinadora de Trade Occidente';
export const COORDINADORA_ROLE = 'coordinador_trade';
export const COORDINADORA_REGION = 'Occidente';
export const COORDINADORA_SUCURSAL = 'ZULIA';
export const COORDINADORA_SCOPE = 'regional';
export const MIN_PASSWORD_LENGTH = 8;

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CURRENT_DIR, '..');

/**
 * Carga archivos `.env.local` y `.env` sin sobrescribir variables ya inyectadas en el shell.
 */
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
 * Valida las variables de entorno requeridas sin exponer secretos en mensajes de error.
 * @param {NodeJS.ProcessEnv} env
 */
export function readCoordinadoraSeedEnv(env = process.env) {
  const supabaseUrl = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim();
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const initialPassword = String(env.GRECIA_INITIAL_PASSWORD || '').trim();

  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!initialPassword) missing.push('GRECIA_INITIAL_PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno obligatorias: ${missing.join(', ')}. ` +
        'Defínelas en tu shell o en `.env.local` (ignorado por Git) y vuelve a ejecutar el script.'
    );
  }

  if (!/^https?:\/\//i.test(supabaseUrl)) {
    throw new Error('SUPABASE_URL inválida: debe iniciar con https:// (o http:// en entorno local).');
  }

  if (initialPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `GRECIA_INITIAL_PASSWORD debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`
    );
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    initialPassword,
  };
}

/**
 * Construye el payload de Supabase Auth Admin para Grecia.
 * Rol y región residen en `app_metadata` (solo modificable por service_role).
 * `user_metadata` contiene únicamente atributos informativos de perfil (jamás autorización).
 */
export function buildCoordinadoraAuthPayload({ password, regionId }) {
  return {
    email: COORDINADORA_EMAIL,
    password,
    email_confirm: true,
    app_metadata: {
      role: COORDINADORA_ROLE,
      app_role: COORDINADORA_ROLE,
      region: COORDINADORA_REGION,
      sucursal: COORDINADORA_SUCURSAL,
      scope: COORDINADORA_SCOPE,
      display_name: COORDINADORA_FULL_NAME,
      ...(regionId ? { region_id: regionId } : {}),
    },
    user_metadata: {
      nombre_completo: COORDINADORA_FULL_NAME,
      cargo: COORDINADORA_CARGO,
    },
  };
}

/**
 * Construye el registro de `public.profiles` enlazado a `auth.users.id`.
 */
export function buildCoordinadoraProfilePayload({ authUserId, regionId, includeRegionColumn = true }) {
  return {
    id: authUserId,
    email: COORDINADORA_EMAIL,
    full_name: COORDINADORA_FULL_NAME,
    role: COORDINADORA_ROLE,
    sucursal: COORDINADORA_SUCURSAL,
    region_id: regionId || null,
    is_active: true,
    ...(includeRegionColumn ? { region: COORDINADORA_REGION } : {}),
  };
}

/**
 * Resuelve dinámicamente el UUID oficial de OCCIDENTE en `public."Regiones"`.
 */
async function resolveOccidenteRegionId(supabase) {
  const { data, error } = await supabase
    .from('Regiones')
    .select('id_regi, regi_desd')
    .limit(50);

  if (error) {
    throw new Error(`No se pudo consultar public."Regiones": ${error.message}`);
  }

  const matched = (Array.isArray(data) ? data : []).find(
    (row) => String(row?.regi_desd || '').trim().toUpperCase() === 'OCCIDENTE'
  );

  if (!matched?.id_regi) {
    throw new Error(
      'No se encontró la región oficial "OCCIDENTE" en public."Regiones". Verifica el catálogo maestro.'
    );
  }

  return String(matched.id_regi);
}

/**
 * Busca un usuario existente en Supabase Auth por correo normalizado (paginado).
 */
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

/**
 * Ejecuta UPSERT idempotente en `public.profiles` tolerando si la columna aditiva `region`
 * aún no fue aplicada antes de correr la migración SQL.
 */
async function upsertCoordinadoraProfile(supabase, { authUserId, regionId }) {
  const payloadWithRegion = buildCoordinadoraProfilePayload({
    authUserId,
    regionId,
    includeRegionColumn: true,
  });

  let { data, error } = await supabase
    .from('profiles')
    .upsert(payloadWithRegion, { onConflict: 'id' })
    .select('id, email, full_name, role, sucursal, region_id, is_active')
    .single();

  if (error && /column .*region.* does not exist|Could not find the 'region' column/i.test(error.message)) {
    const fallbackPayload = buildCoordinadoraProfilePayload({
      authUserId,
      regionId,
      includeRegionColumn: false,
    });
    const retry = await supabase
      .from('profiles')
      .upsert(fallbackPayload, { onConflict: 'id' })
      .select('id, email, full_name, role, sucursal, region_id, is_active')
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    throw new Error(`Error realizando UPSERT en public.profiles: ${error.message}`);
  }

  return data;
}

/**
 * Flujo principal idempotente de aprovisionamiento para Grecia (Occidente).
 */
export async function runSeedCoordinadoraOccidente(env = process.env) {
  const { supabaseUrl, serviceRoleKey, initialPassword } = readCoordinadoraSeedEnv(env);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const occidenteRegionId = await resolveOccidenteRegionId(supabase);
  const authPayload = buildCoordinadoraAuthPayload({
    password: initialPassword,
    regionId: occidenteRegionId,
  });

  const existingUser = await findAuthUserByEmail(supabase, COORDINADORA_EMAIL);
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

  const profileRow = await upsertCoordinadoraProfile(supabase, {
    authUserId,
    regionId: occidenteRegionId,
  });

  return {
    authAction,
    authUserId,
    email: COORDINADORA_EMAIL,
    role: COORDINADORA_ROLE,
    region: COORDINADORA_REGION,
    sucursal: COORDINADORA_SUCURSAL,
    scope: COORDINADORA_SCOPE,
    regionId: occidenteRegionId,
    profileActive: Boolean(profileRow?.is_active),
  };
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  loadLocalEnvFiles();
  runSeedCoordinadoraOccidente(process.env)
    .then((summary) => {
      console.log('\n====================================================================');
      console.log(' APROVISIONAMIENTO COORDINADORA OCCIDENTE — RESUMEN LIMPIO');
      console.log('====================================================================');
      console.log(` Accion Auth    : ${summary.authAction === 'created' ? 'CUENTA CREADA' : 'CUENTA ACTUALIZADA (IDEMPOTENTE)'}`);
      console.log(` Auth User ID   : ${summary.authUserId}`);
      console.log(` Correo         : ${summary.email}`);
      console.log(` Rol (app_meta) : ${summary.role}`);
      console.log(` Region         : ${summary.region} (sucursal: ${summary.sucursal}, scope: ${summary.scope})`);
      console.log(` Region ID ERP  : ${summary.regionId}`);
      console.log(` Perfil activo  : ${summary.profileActive ? 'true (UPSERT public.profiles OK)' : 'false'}`);
      console.log(' Seguridad      : Contrasena y SERVICE_ROLE_KEY omitidas de la salida.');
      console.log('====================================================================\n');
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[ERROR] Aprovisionamiento abortado: ${msg}\n`);
      process.exit(1);
    });
}
