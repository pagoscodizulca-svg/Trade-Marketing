import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_ANON_KEY,
  SUPABASE_PROJECT_URL,
  assertSupabaseConfigured,
  getSupabaseClient,
  isSupabaseConfigured,
} from './supabaseClient';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;

export type ManagedUserRole = 'super_admin' | 'coordinacion' | 'vendedor';

export const MANAGED_USER_ROLES: readonly ManagedUserRole[] = [
  'super_admin',
  'coordinacion',
  'vendedor',
] as const;

export const MANAGED_USER_ROLE_LABELS: Record<ManagedUserRole, string> = {
  super_admin: 'Administrador General',
  coordinacion: 'Coordinación',
  vendedor: 'Vendedor',
};

export interface ManagedUserProfile {
  id: string;
  email: string;
  fullName: string;
  role: ManagedUserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateManagedUserInput {
  fullName: string;
  email: string;
  password: string;
  role: ManagedUserRole;
  mustChangePassword?: boolean;
}

export interface UpdateManagedUserAccessInput {
  targetUserId: string;
  fullName: string;
  role: ManagedUserRole;
  isActive: boolean;
  mustChangePassword?: boolean | null;
}

export interface UserManagementAuditEntry {
  id: string;
  actorId: string;
  targetUserId: string | null;
  targetEmail: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

interface RawProfileRow {
  id: unknown;
  email: unknown;
  full_name: unknown;
  role: unknown;
  is_active: unknown;
  must_change_password: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface RawAuditRow {
  id: unknown;
  actor_id: unknown;
  target_user_id: unknown;
  target_email: unknown;
  action: unknown;
  details: unknown;
  created_at: unknown;
}

export function isManagedUserRole(value: unknown): value is ManagedUserRole {
  return (
    value === 'super_admin' ||
    value === 'coordinacion' ||
    value === 'vendedor'
  );
}

export function normalizeManagedUserEmail(rawEmail: string): string {
  return String(rawEmail ?? '').trim().toLowerCase();
}

function validateFullName(rawFullName: string): string {
  const clean = String(rawFullName ?? '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 160) {
    throw new Error('El nombre completo debe contener entre 2 y 160 caracteres.');
  }
  return clean;
}

function validateEmail(rawEmail: string): string {
  const clean = normalizeManagedUserEmail(rawEmail);
  if (clean.length < 5 || clean.length > 254 || !STRICT_EMAIL_REGEX.test(clean)) {
    throw new Error('Ingresa un correo electrónico corporativo válido.');
  }
  return clean;
}

function validateRole(rawRole: unknown): ManagedUserRole {
  const clean = String(rawRole ?? '').trim().toLowerCase();
  if (!isManagedUserRole(clean)) {
    throw new Error('Rol inválido. Selecciona super_admin, coordinacion o vendedor.');
  }
  return clean;
}

function validateUuid(rawId: string, fieldLabel: string): string {
  const clean = String(rawId ?? '').trim();
  if (!UUID_REGEX.test(clean)) {
    throw new Error(`Identificador inválido para ${fieldLabel}.`);
  }
  return clean;
}

function mapProfileRow(row: RawProfileRow): ManagedUserProfile {
  const rawRole = String(row.role ?? 'vendedor').trim().toLowerCase();
  const role: ManagedUserRole = isManagedUserRole(rawRole) ? rawRole : 'vendedor';

  return {
    id: String(row.id ?? ''),
    email: normalizeManagedUserEmail(String(row.email ?? '')),
    fullName: String(row.full_name ?? '').trim(),
    role,
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

function mapAuditRow(row: RawAuditRow): UserManagementAuditEntry {
  const rawDetails = row.details;
  const details =
    rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : {};

  return {
    id: String(row.id ?? ''),
    actorId: String(row.actor_id ?? ''),
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    targetEmail: normalizeManagedUserEmail(String(row.target_email ?? '')),
    action: String(row.action ?? ''),
    details,
    createdAt: String(row.created_at ?? ''),
  };
}

function formatSupabaseRpcError(error: { message?: string; code?: string } | null, fallback: string): string {
  const msg = String(error?.message ?? '').trim();
  if (!msg) return fallback;
  if (/acceso denegado/i.test(msg) || error?.code === '42501') {
    return 'Acceso denegado: esta acción es exclusiva del Administrador General activo.';
  }
  if (/anti auto-bloqueo/i.test(msg)) {
    return msg;
  }
  if (/al menos un usuario super_admin activo|cero usuarios super_admin/i.test(msg)) {
    return 'Operación bloqueada: el sistema debe conservar al menos un Administrador General activo.';
  }
  if (/already registered|user already exists/i.test(msg)) {
    return 'Ya existe un usuario registrado con ese correo electrónico.';
  }
  return msg;
}

/**
 * Crea un cliente público efímero estrictamente en memoria (sin persistencia en localStorage
 * ni auto-refresh) usando únicamente la llave pública validada por `assertSupabaseConfigured()`.
 * Garantiza que `auth.signUp()` no reemplace la sesión activa del `super_admin`.
 */
function createEphemeralPublicSignupClient(): SupabaseClient {
  assertSupabaseConfigured();
  const ephemeralKey = `codizulca.ephemeral.signup.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;

  return createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: ephemeralKey,
      storage: {
        getItem: () => null,
        setItem: () => {
          // Intencionalmente vacío: evita persistir cualquier token del nuevo usuario
        },
        removeItem: () => {
          // Intencionalmente vacío
        },
      },
    },
  });
}

async function requireAuthenticatedSuperAdminSessionId(): Promise<string> {
  assertSupabaseConfigured();
  const client = getSupabaseClient();
  const { data, error } = await client.auth.getUser();

  if (error || !data.user?.id) {
    throw new Error('Sesión no válida o expirada. Inicia sesión nuevamente como Administrador General.');
  }

  return data.user.id;
}

/**
 * Obtiene el perfil IAM propio del usuario autenticado actual desde `public.profiles`.
 */
export async function getCurrentUserAccessProfile(): Promise<ManagedUserProfile | null> {
  if (!isSupabaseConfigured) return null;
  const client = getSupabaseClient();
  const { data: authData, error: authError } = await client.auth.getUser();

  if (authError || !authData.user?.id) {
    return null;
  }

  const { data, error } = await client
    .from('profiles')
    .select('id, email, full_name, role, is_active, must_change_password, created_at, updated_at')
    .eq('id', authData.user.id)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return mapProfileRow(data as RawProfileRow);
}

/**
 * Verifica contra PostgreSQL (`public.is_active_super_admin()`) si el usuario actual
 * posee rol `super_admin` con `is_active = true`.
 */
export async function isCurrentUserActiveSuperAdmin(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const client = getSupabaseClient();
  const { data, error } = await client.rpc('is_active_super_admin');
  if (error) return false;
  return data === true;
}

/**
 * Lista todos los usuarios gestionados mediante la RPC `public.admin_list_profiles()`
 * (ordenada por jerarquía de rol y nombre completo).
 */
export async function listManagedUsers(): Promise<ManagedUserProfile[]> {
  await requireAuthenticatedSuperAdminSessionId();
  const client = getSupabaseClient();

  const { data, error } = await client.rpc('admin_list_profiles');
  if (error) {
    throw new Error(
      formatSupabaseRpcError(error, 'No se pudo cargar el listado de usuarios.')
    );
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return (data as RawProfileRow[]).map(mapProfileRow);
}

/**
 * Crea un usuario activo y confirmado de inmediato sin requerir verificación por correo
 * ni usar llaves administrativas secretas en frontend:
 *  1. Registra la identidad en `auth.users` con un cliente público efímero sin almacenamiento.
 *  2. Sella `email_confirmed_at`, crea/actualiza `public.profiles` y audita el alta mediante
 *     la RPC `public.admin_finalize_created_user` autenticada con la sesión del `super_admin`.
 */
export async function createManagedUser(
  input: CreateManagedUserInput
): Promise<ManagedUserProfile> {
  await requireAuthenticatedSuperAdminSessionId();

  const fullName = validateFullName(input.fullName);
  const email = validateEmail(input.email);
  const role = validateRole(input.role);
  const password = String(input.password ?? '');
  const mustChangePassword = input.mustChangePassword === true;

  if (password.trim().length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `La contraseña inicial debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`
    );
  }

  const ephemeralClient = createEphemeralPublicSignupClient();

  try {
    const { data: signUpData, error: signUpError } = await ephemeralClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
      },
    });

    if (signUpError) {
      throw new Error(
        formatSupabaseRpcError(signUpError, 'No se pudo registrar el usuario en Supabase Auth.')
      );
    }

    const createdUser = signUpData.user;
    if (!createdUser?.id || !UUID_REGEX.test(createdUser.id)) {
      throw new Error('Supabase Auth no devolvió un identificador de usuario válido.');
    }

    // Cuando la confirmación de correo está activa en Supabase, un email ya existente
    // retorna identities=[] sin error explícito para prevenir enumeración pública.
    if (Array.isArray(createdUser.identities) && createdUser.identities.length === 0) {
      throw new Error('Ya existe un usuario registrado con ese correo electrónico.');
    }

    const adminClient = getSupabaseClient();
    const { data: rpcRows, error: rpcError } = await adminClient.rpc(
      'admin_finalize_created_user',
      {
        p_target_user_id: createdUser.id,
        p_full_name: fullName,
        p_role: role,
        p_must_change_password: mustChangePassword,
      }
    );

    if (rpcError) {
      throw new Error(
        formatSupabaseRpcError(
          rpcError,
          'El usuario fue creado en Auth, pero falló la activación del perfil administrativo.'
        )
      );
    }

    const row = Array.isArray(rpcRows) ? (rpcRows[0] as RawProfileRow | undefined) : undefined;
    if (!row) {
      throw new Error('La base de datos no devolvió el perfil finalizado del usuario.');
    }

    return mapProfileRow(row);
  } finally {
    await ephemeralClient.auth.signOut({ scope: 'local' }).catch(() => {
      // Limpieza local silenciosa de la instancia efímera en memoria
    });
  }
}

/**
 * Actualiza el nombre completo, rol (`super_admin` | `coordinacion` | `vendedor`),
 * estado (`is_active`) y bandera opcional `must_change_password` de un usuario existente.
 */
export async function updateManagedUserAccess(
  input: UpdateManagedUserAccessInput
): Promise<ManagedUserProfile> {
  const actorUserId = await requireAuthenticatedSuperAdminSessionId();

  const targetUserId = validateUuid(input.targetUserId, 'usuario objetivo');
  const fullName = validateFullName(input.fullName);
  const role = validateRole(input.role);
  const isActive = Boolean(input.isActive);
  const mustChangePassword =
    typeof input.mustChangePassword === 'boolean' ? input.mustChangePassword : null;

  // Pre-validación de cortesía en cliente (la regla autoritativa reside en PostgreSQL)
  if (targetUserId === actorUserId) {
    if (!isActive) {
      throw new Error(
        'Operación bloqueada (anti auto-bloqueo): no puedes suspender tu propia cuenta de super_admin.'
      );
    }
    if (role !== 'super_admin') {
      throw new Error(
        'Operación bloqueada (anti auto-bloqueo): no puedes cambiar tu propio rol fuera de super_admin.'
      );
    }
  }

  const client = getSupabaseClient();
  const { data, error } = await client.rpc('admin_update_user_access', {
    p_target_user_id: targetUserId,
    p_full_name: fullName,
    p_role: role,
    p_is_active: isActive,
    p_must_change_password: mustChangePassword,
  });

  if (error) {
    throw new Error(
      formatSupabaseRpcError(error, 'No se pudo actualizar el acceso del usuario.')
    );
  }

  const row = Array.isArray(data) ? (data[0] as RawProfileRow | undefined) : undefined;
  if (!row) {
    throw new Error('La base de datos no devolvió el perfil actualizado.');
  }

  return mapProfileRow(row);
}

/**
 * Consulta la bitácora de auditoría IAM (`public.user_management_audit`).
 * Protegida por RLS de lectura exclusivo para `super_admin` activo.
 */
export async function listUserManagementAudit(
  limit = 50
): Promise<UserManagementAuditEntry[]> {
  await requireAuthenticatedSuperAdminSessionId();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);

  const client = getSupabaseClient();
  const { data, error } = await client
    .from('user_management_audit')
    .select('id, actor_id, target_user_id, target_email, action, details, created_at')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    throw new Error(
      formatSupabaseRpcError(error, 'No se pudo consultar el historial de auditoría de usuarios.')
    );
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return (data as RawAuditRow[]).map(mapAuditRow);
}

/**
 * Permite al usuario autenticado cambiar su propia contraseña cuando tenga activa
 * la bandera opcional `must_change_password` y limpiar dicha bandera en `public.profiles`.
 */
export async function completeOwnPasswordChange(newPassword: string): Promise<void> {
  assertSupabaseConfigured();
  const cleanPassword = String(newPassword ?? '');
  if (cleanPassword.trim().length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`
    );
  }

  const client = getSupabaseClient();
  const { error: updateError } = await client.auth.updateUser({
    password: cleanPassword,
  });

  if (updateError) {
    throw new Error(
      formatSupabaseRpcError(updateError, 'No se pudo actualizar la contraseña.')
    );
  }

  const { error: rpcError } = await client.rpc('complete_own_password_change');
  if (rpcError) {
    throw new Error(
      formatSupabaseRpcError(
        rpcError,
        'Contraseña actualizada, pero no se pudo confirmar el estado en el perfil.'
      )
    );
  }
}
