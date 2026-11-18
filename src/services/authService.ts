import type { Session, User as SupabaseAuthUser } from '@supabase/supabase-js';
import type { UserRole } from '../types';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import { isManagedUserRole, type ManagedUserRole } from './userManagementService';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const GENERIC_INVALID_CREDENTIALS_MESSAGE = 'Correo o contraseña incorrectos';
export const PORTAL_UNAUTHORIZED_ACCESS_MESSAGE =
  'Acceso no habilitado: tu correo no figura como promotora activa en el registro de Personal.';

export type CanonicalAppRole =
  | 'admin'
  | 'contraloria'
  | 'coordinadora'
  | 'supervisor'
  | 'promotora'
  | 'fdv';

export interface VerifiedAuthProfile {
  userId: string;
  email: string;
  displayName: string;
  appRole: CanonicalAppRole | null;
  iamRole: ManagedUserRole | null;
  rawAppRole: string;
  legacyRole: UserRole;
  staffId: string | null;
  isCoordinatorOrAdmin: boolean;
  canAccessTorreControl: boolean;
  mustChangePassword: boolean;
}

/**
 * Normaliza estrictamente un correo electrónico (`email.trim().toLowerCase()`).
 */
export function normalizePortalEmail(rawEmail: string): string {
  return String(rawEmail ?? '').trim().toLowerCase();
}

/**
 * Valida formato sintáctico seguro de correo electrónico antes de invocar red.
 */
export function isValidPortalEmailFormat(rawEmail: string): boolean {
  const normalized = normalizePortalEmail(rawEmail);
  return normalized.length >= 5 && normalized.length <= 254 && STRICT_EMAIL_REGEX.test(normalized);
}

/**
 * Detecta de forma síncrona si el navegador almacena un token de sesión de Supabase Auth
 * (`sb-*-auth-token`), permitiendo a los Route Guards retener el renderizado administrativo
 * en el frame 0 mientras se verifica criptográficamente el rol de la sesión.
 */
export function hasStoredSupabaseAuthToken(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && (key === 'codizulca.supabase.auth.v1' || /^sb-.*-auth-token$/i.test(key))) {
        const val = storage.getItem(key);
        if (val && val.trim().length > 2) {
          return true;
        }
      }
    }
  } catch {
    // Entornos con almacenamiento restringido continúan a verificación asíncrona normal
  }
  return false;
}

/**
 * Normaliza un identificador de acceso administrativo/corporativo:
 * - Si contiene `@`, conserva el correo electrónico en minúsculas.
 * - Si es un identificador corporativo sin `@`, genera el correo sintético determinista
 *   `<slug>@promotoras.codizulca.local` usado en el aprovisionamiento interno.
 */
export function normalizeAuthLoginIdentifier(rawInput: string): string {
  const trimmed = String(rawInput || '').trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed;

  const slug = trimmed
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^\.+|\.+$/g, '');

  return slug ? `${slug}@promotoras.codizulca.local` : '';
}

export function normalizeCanonicalAppRole(rawRole: unknown): CanonicalAppRole | null {
  const clean = String(rawRole ?? '').trim().toLowerCase();
  if (!clean) return null;
  if (
    clean === 'super_admin' ||
    clean === 'admin' ||
    clean === 'gerencia' ||
    clean === 'gerente_admin' ||
    clean === 'superadmin'
  ) {
    return 'admin';
  }
  if (clean === 'contraloria' || clean === 'analista_contraloria' || clean === 'contralor') {
    return 'contraloria';
  }
  if (
    clean === 'coordinacion' ||
    clean === 'coordinadora' ||
    clean === 'coordinadora_trade' ||
    clean === 'jefe_trade'
  ) {
    return 'coordinadora';
  }
  if (clean === 'supervisor' || clean === 'supervisora' || clean === 'supervisor_trade') {
    return 'supervisor';
  }
  if (clean === 'promotora') {
    return 'promotora';
  }
  if (clean === 'fdv' || clean === 'vendedor' || clean === 'fuerza_ventas') {
    return 'fdv';
  }
  return null;
}

function mapToLegacyUserRole(rawRole: string, canonical: CanonicalAppRole | null): UserRole {
  if (canonical === 'contraloria' || rawRole === 'analista_contraloria') {
    return 'analista_contraloria';
  }
  if (canonical === 'supervisor' || rawRole === 'supervisor') {
    return 'supervisor';
  }
  if (canonical === 'admin') return 'gerente_admin';
  if (canonical === 'coordinadora') return 'jefe_trade';
  return 'promotora';
}

function resolveFallbackIamRole(rawAppRole: string): ManagedUserRole | null {
  const clean = String(rawAppRole ?? '').trim().toLowerCase();
  if (isManagedUserRole(clean)) {
    return clean;
  }
  if (
    clean === 'superadmin' ||
    clean === 'admin' ||
    clean === 'gerencia' ||
    clean === 'gerente_admin'
  ) {
    return 'super_admin';
  }
  if (clean === 'analista_contraloria' || clean === 'contralor') {
    return 'contraloria';
  }
  if (
    clean === 'coordinadora' ||
    clean === 'coordinadora_trade' ||
    clean === 'jefe_trade'
  ) {
    return 'coordinacion';
  }
  if (clean === 'supervisora' || clean === 'supervisor_trade') {
    return 'supervisor';
  }
  if (clean === 'fdv' || clean === 'fuerza_ventas') {
    return 'vendedor';
  }
  return null;
}

function isTradeCoordinatorOrAdminCanonical(role: CanonicalAppRole | null): boolean {
  return role === 'admin' || role === 'coordinadora' || role === 'supervisor';
}

function canCanonicalRoleAccessTorre(role: CanonicalAppRole | null): boolean {
  return (
    role === 'admin' ||
    role === 'contraloria' ||
    role === 'coordinadora' ||
    role === 'supervisor'
  );
}

/**
 * Extrae el perfil verificado EXCLUSIVAMENTE desde `app_metadata` (`raw_app_meta_data` firmado en servidor).
 * REGLA DE SEGURIDAD: Jamás lee roles ni `staff_id` desde `user_metadata` (editable por el cliente).
 */
export function extractVerifiedProfileFromAuthUser(
  user: SupabaseAuthUser | null | undefined
): VerifiedAuthProfile | null {
  if (!user || !user.id) return null;

  const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;
  const rawAppRole = String(appMeta.app_role ?? appMeta.role ?? '')
    .trim()
    .toLowerCase();
  const appRole = normalizeCanonicalAppRole(rawAppRole);

  const rawStaffId = String(appMeta.staff_id ?? '').trim();
  const staffId = UUID_REGEX.test(rawStaffId) ? rawStaffId : null;

  const email = normalizePortalEmail(user.email || '');
  const iamRole = resolveFallbackIamRole(rawAppRole);
  const safeNameFromMeta = String(appMeta.display_name ?? '').trim();
  const displayName =
    safeNameFromMeta ||
    (email ? email.split('@')[0]!.replace(/[._-]+/g, ' ').toUpperCase() : 'USUARIO VERIFICADO');

  return {
    userId: user.id,
    email,
    displayName,
    appRole,
    iamRole,
    rawAppRole,
    legacyRole: mapToLegacyUserRole(rawAppRole, appRole),
    staffId,
    isCoordinatorOrAdmin: isTradeCoordinatorOrAdminCanonical(appRole),
    canAccessTorreControl: canCanonicalRoleAccessTorre(appRole),
    mustChangePassword: appMeta.must_change_password === true,
  };
}

interface ActivePromotoraStaffMatch {
  staffId: string;
  name: string;
  email: string;
}

/**
 * Verifica en `public.staff` (Pestaña de Personal) que exista una promotora ACTIVA
 * para el correo normalizado (o `auth_user_id` con correo activo coincidente).
 */
async function findActivePromotoraInStaff(
  userId: string,
  normalizedEmail: string
): Promise<ActivePromotoraStaffMatch | null> {
  if (!isSupabaseConfigured) return null;
  const client = getSupabaseClient();

  if (normalizedEmail && STRICT_EMAIL_REGEX.test(normalizedEmail)) {
    try {
      const { data: rows, error: emailError } = await client
        .from('staff')
        .select('id, name, email, role, status')
        .ilike('email', normalizedEmail)
        .limit(5);

      if (!emailError && Array.isArray(rows) && rows.length > 0) {
        const matched = rows.find((row) => {
          const rowEmail = normalizePortalEmail(String(row.email || ''));
          const isInactive = String(row.status || 'Activo').trim().toLowerCase() === 'inactivo';
          const isMerch = /merchandising/i.test(String(row.role || ''));
          return (
            rowEmail === normalizedEmail &&
            !isInactive &&
            !isMerch &&
            UUID_REGEX.test(String(row.id || ''))
          );
        });

        if (matched) {
          return {
            staffId: String(matched.id),
            name: String(matched.name || '').trim(),
            email: normalizedEmail,
          };
        }
      }
    } catch {
      // Continúa a verificación de respaldo por auth_user_id
    }
  }

  if (userId && UUID_REGEX.test(userId)) {
    try {
      const { data, error } = await client
        .from('staff')
        .select('id, name, email, role, status')
        .eq('auth_user_id', userId)
        .maybeSingle();

      if (!error && data?.id && UUID_REGEX.test(String(data.id))) {
        const rowEmail = normalizePortalEmail(String(data.email || ''));
        const isInactive = String(data.status || 'Activo').trim().toLowerCase() === 'inactivo';
        const isMerch = /merchandising/i.test(String(data.role || ''));
        const emailConsistent = !rowEmail || !normalizedEmail || rowEmail === normalizedEmail;
        if (!isInactive && !isMerch && emailConsistent) {
          return {
            staffId: String(data.id),
            name: String(data.name || '').trim(),
            email: rowEmail || normalizedEmail,
          };
        }
      }
    } catch {
      // Sin coincidencia activa verificable
    }
  }

  return null;
}

/**
 * Resuelve el perfil verificado vinculando contra `public.staff`:
 * - Para `coordinadora`, `admin` o `fdv`, respeta el rol firmado en `app_metadata`.
 * - Para cuentas de campo / promotoras, verifica siempre estado activo en `public.staff`
 *   para impedir acceso de registros marcados como `Inactivo`.
 */
export async function resolveVerifiedProfileWithStaffFallback(
  session: Session | null
): Promise<VerifiedAuthProfile | null> {
  const base = extractVerifiedProfileFromAuthUser(session?.user);
  if (!base || !isSupabaseConfigured) return base;

  const normalizedEmail = normalizePortalEmail(base.email);

  try {
    const client = getSupabaseClient();
    const { data: iamProfile, error: iamError } = await client
      .from('profiles')
      .select('role, full_name, is_active, must_change_password')
      .eq('id', base.userId)
      .maybeSingle();

    if (!iamError && iamProfile) {
      if (iamProfile.is_active === false) {
        return null;
      }
      const rawIamRole = String(iamProfile.role ?? '').trim().toLowerCase();
      const iamCanonical = normalizeCanonicalAppRole(rawIamRole);
      if (iamCanonical) {
        const iamFullName = String(iamProfile.full_name ?? '').trim();
        return {
          ...base,
          email: normalizedEmail,
          displayName: iamFullName || base.displayName,
          appRole: iamCanonical,
          iamRole: resolveFallbackIamRole(rawIamRole),
          rawAppRole: rawIamRole,
          legacyRole: mapToLegacyUserRole(rawIamRole, iamCanonical),
          isCoordinatorOrAdmin: isTradeCoordinatorOrAdminCanonical(iamCanonical),
          canAccessTorreControl: canCanonicalRoleAccessTorre(iamCanonical),
          mustChangePassword: Boolean(iamProfile.must_change_password),
        };
      }
    }
  } catch {
    // Si public.profiles aún no está disponible, continúa con verificación JWT/staff
  }

  if (base.canAccessTorreControl || base.appRole === 'fdv') {
    return { ...base, email: normalizedEmail };
  }

  const activeStaff = await findActivePromotoraInStaff(base.userId, normalizedEmail);
  if (activeStaff) {
    return {
      ...base,
      email: activeStaff.email || normalizedEmail,
      appRole: 'promotora',
      rawAppRole: base.rawAppRole || 'promotora',
      legacyRole: 'promotora',
      staffId: activeStaff.staffId,
      displayName: activeStaff.name || base.displayName,
      isCoordinatorOrAdmin: false,
      canAccessTorreControl: false,
      mustChangePassword: false,
    };
  }

  // Si tenía rol promotora en JWT pero ya no existe o fue desactivada en Personal, limpia staffId
  return {
    ...base,
    email: normalizedEmail,
    staffId: null,
  };
}

/**
 * Valida post-login que la sesión activa en `/portal` pertenezca estrictamente a una promotora
 * cuyo correo normalizado exista y esté activo en el registro de Personal (`public.staff`).
 * Si el usuario no está autorizado o está inactivo, cierra la sesión de forma controlada.
 */
export async function verifyActivePromotoraPortalAccess(session: Session | null): Promise<{
  profile: VerifiedAuthProfile | null;
  unauthorizedReason: string | null;
}> {
  if (!session?.user || !isSupabaseConfigured) {
    return { profile: null, unauthorizedReason: null };
  }

  const base = extractVerifiedProfileFromAuthUser(session.user);
  if (!base) {
    await signOutSupabaseSession();
    return { profile: null, unauthorizedReason: PORTAL_UNAUTHORIZED_ACCESS_MESSAGE };
  }

  const normalizedEmail = normalizePortalEmail(base.email);
  const activeStaff = await findActivePromotoraInStaff(base.userId, normalizedEmail);

  if (!activeStaff) {
    await signOutSupabaseSession();
    return {
      profile: null,
      unauthorizedReason: PORTAL_UNAUTHORIZED_ACCESS_MESSAGE,
    };
  }

  const client = getSupabaseClient();
  client.realtime.setAuth(session.access_token);

  return {
    profile: {
      ...base,
      email: activeStaff.email || normalizedEmail,
      appRole: 'promotora',
      iamRole: null,
      rawAppRole: 'promotora',
      legacyRole: 'promotora',
      staffId: activeStaff.staffId,
      displayName: activeStaff.name || base.displayName,
      isCoordinatorOrAdmin: false,
      canAccessTorreControl: false,
      mustChangePassword: false,
    },
    unauthorizedReason: null,
  };
}

/**
 * Autenticación exclusiva y blindada para `/portal` (App de Promotoras):
 * 1. Normaliza correo con `email.trim().toLowerCase()` y valida formato antes de invocar red.
 * 2. Autentica únicamente vía `supabase.auth.signInWithPassword({ email, password })`.
 * 3. Previene enumeración de usuarios respondiendo siempre `"Correo o contraseña incorrectos"`
 *    ante cualquier fallo de credenciales.
 * 4. Verifica que el correo exista y esté activo en `public.staff` (Personal); de lo contrario,
 *    cierra la sesión (`signOut`) de forma controlada e informa acceso no habilitado.
 */
export async function signInPromotoraPortalWithPassword(
  rawEmail: string,
  rawPassword: string
): Promise<{ session: Session; profile: VerifiedAuthProfile }> {
  const email = normalizePortalEmail(rawEmail);
  const password = String(rawPassword ?? '');

  if (!isValidPortalEmailFormat(email) || password.trim().length === 0) {
    throw new Error('Ingresa un correo electrónico válido y tu contraseña.');
  }

  const client = getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.session || !data.user) {
    throw new Error(GENERIC_INVALID_CREDENTIALS_MESSAGE);
  }

  const verification = await verifyActivePromotoraPortalAccess(data.session);
  if (!verification.profile) {
    throw new Error(verification.unauthorizedReason || PORTAL_UNAUTHORIZED_ACCESS_MESSAGE);
  }

  return { session: data.session, profile: verification.profile };
}

export async function signInWithSupabaseCredentials(
  identifier: string,
  password: string
): Promise<{ session: Session; profile: VerifiedAuthProfile }> {
  const email = normalizeAuthLoginIdentifier(identifier);
  const cleanPassword = String(password || '');

  if (!email || !cleanPassword) {
    throw new Error('Ingrese su correo corporativo y contraseña.');
  }

  const client = getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: cleanPassword,
  });

  if (error || !data.session || !data.user) {
    throw new Error(GENERIC_INVALID_CREDENTIALS_MESSAGE);
  }

  const profile = await resolveVerifiedProfileWithStaffFallback(data.session);
  if (!profile || !profile.appRole) {
    await client.auth.signOut();
    throw new Error(
      'Tu cuenta autenticada no tiene un perfil operativo asignado. Contacta a Coordinación.'
    );
  }

  client.realtime.setAuth(data.session.access_token);
  return { session: data.session, profile };
}

export async function signOutSupabaseSession(): Promise<void> {
  if (!isSupabaseConfigured) return;
  const client = getSupabaseClient();
  await client.auth.signOut();
}

export async function getActiveAccessToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  const client = getSupabaseClient();
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Solicita al backend seguro (`POST /api/admin/staff-auth`) aprovisionar o actualizar
 * la credencial de una promotora/coordinadora en `auth.users` con `app_metadata` inmutable,
 * sin almacenar contraseñas en texto plano dentro de `public.staff`.
 */
export async function provisionStaffAuthAccountViaBackend(params: {
  staffId: string;
  name: string;
  email?: string;
  password?: string;
  appRole?: 'promotora' | 'coordinadora' | 'admin';
  active?: boolean;
}): Promise<{ authUserId: string; loginEmail: string }> {
  const token = await getActiveAccessToken();
  if (!token) {
    throw new Error('Sesión expirada. Inicie sesión nuevamente como Coordinadora o Admin.');
  }

  const res = await fetch('/api/admin/staff-auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      staffId: params.staffId,
      name: params.name,
      email: params.email || '',
      password: params.password || '',
      appRole: params.appRole || 'promotora',
      active: params.active !== false,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    authUserId?: string;
    loginEmail?: string;
  };

  if (!res.ok || !payload.authUserId) {
    throw new Error(
      payload.error || `No se pudo aprovisionar la cuenta en Supabase Auth (HTTP ${res.status}).`
    );
  }

  return {
    authUserId: payload.authUserId,
    loginEmail: payload.loginEmail || '',
  };
}
