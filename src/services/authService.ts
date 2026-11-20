import type { Session, SupabaseClient, User as SupabaseAuthUser } from '@supabase/supabase-js';
import type { UserRole } from '../types';
import {
  UNIFIED_SUPABASE_STORAGE_KEY,
  getSupabaseClient,
  isSupabaseConfigured,
  setActiveClientSucursalHeader,
} from './supabaseClient';
import { clearMasterDataCaches } from './masterDataSyncService';
import { purgeAllSessionCaches } from './sessionCacheHygiene';
import {
  isOperativeSucursal,
  isSucursalValidForRole,
  normalizeManagedUserRole,
  normalizeSucursalCodigo,
  type ManagedUserRole,
  type OperativeSucursal,
  type SucursalCodigo,
} from './userManagementService';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const GENERIC_INVALID_CREDENTIALS_MESSAGE = 'Correo o contraseña incorrectos';
export const PORTAL_UNAUTHORIZED_ACCESS_MESSAGE =
  'Acceso no habilitado: tu correo no figura como promotora activa en el registro de Personal.';
export const MENSAJE_PERFIL_NO_ACTIVO =
  'Tu correo no tiene perfil activo asignado. Contacta al Administrador General';

export type CanonicalAppRole =
  | 'admin'
  | 'contraloria'
  | 'coordinadora'
  | 'promotora'
  | 'fdv'
  | 'cliente'
  | 'chofer';

export interface VerifiedAuthProfile {
  userId: string;
  email: string;
  displayName: string;
  appRole: CanonicalAppRole | null;
  iamRole: ManagedUserRole | null;
  sucursal: SucursalCodigo | null;
  /** UUID verificado de `public.regiones` asignado al usuario (null en `super_admin` o sin región asignada) */
  regionId?: string | null;
  rawAppRole: string;
  legacyRole: UserRole;
  staffId: string | null;
  isCoordinatorOrAdmin: boolean;
  canAccessTorreControl: boolean;
  mustChangePassword: boolean;
}

export interface SesionPerfilUnificado {
  userId: string;
  email: string;
  rol: ManagedUserRole;
  sucursal: SucursalCodigo;
  nombreCompleto: string;
  staffId: string | null;
  etiquetaSede: string;
}

export function normalizePortalEmail(rawEmail: string): string {
  return String(rawEmail ?? '').trim().toLowerCase();
}

export function isValidPortalEmailFormat(rawEmail: string): boolean {
  const normalized = normalizePortalEmail(rawEmail);
  return normalized.length >= 5 && normalized.length <= 254 && STRICT_EMAIL_REGEX.test(normalized);
}

export function esUuidValido(valor: unknown): boolean {
  return UUID_REGEX.test(String(valor ?? '').trim());
}

export function sanitizarTextoEntrada(texto: unknown, maxLongitud = 500): string {
  const limite = Math.max(1, Math.min(Math.trunc(maxLongitud) || 500, 4000));
  return String(texto ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, limite);
}

/**
 * Etiqueta de sede oficial para el encabezado e insignias DOM seguras.
 */
export function obtenerEtiquetaSede(
  rol: ManagedUserRole | string,
  sucursal: SucursalCodigo | string | null | undefined
): string {
  const cleanRole = normalizeManagedUserRole(rol);
  const cleanSucursal = normalizeSucursalCodigo(sucursal);

  if (cleanRole === 'super_admin') {
    return 'Administración General - Nacional';
  }
  if (cleanSucursal === 'GLOBAL' && cleanRole === 'contraloria') {
    return 'Contraloría Nacional - Global';
  }
  if (cleanSucursal === 'ZULIA') {
    return 'Sucursal Zulia';
  }
  if (cleanSucursal === 'VALENCIA') {
    return 'Sucursal Valencia';
  }
  if (cleanSucursal === 'CENTRO') {
    return 'Sucursal Centro';
  }
  if (cleanSucursal === 'ORIENTE') {
    return 'Sucursal Oriente';
  }
  if (cleanSucursal === 'CAPITAL') {
    return 'Sucursal Capital';
  }
  throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
}

/**
 * Renderiza la insignia de sede activa en el DOM usando exclusivamente `createElement` y `textContent`
 * (cero sumideros de inyección HTML / cero XSS).
 */
export function renderizarInsigniaSedeSegura(
  nodoContenedor: HTMLElement,
  sesionPerfil: {
    rol: ManagedUserRole | string;
    sucursal: SucursalCodigo | string | null;
    nombreCompleto: string;
  }
): void {
  if (!nodoContenedor || typeof nodoContenedor.replaceChildren !== 'function') {
    throw new Error('Se requiere un nodo DOM válido para pintar la etiqueta de sede.');
  }

  const doc = nodoContenedor.ownerDocument;
  const rolNorm = normalizeManagedUserRole(sesionPerfil.rol);
  if (!rolNorm) {
    throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
  }
  const sucursalNorm =
    rolNorm === 'super_admin' ? 'GLOBAL' : normalizeSucursalCodigo(sesionPerfil.sucursal);
  if (!sucursalNorm || !isSucursalValidForRole(rolNorm, sucursalNorm)) {
    throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
  }

  const textoSede = obtenerEtiquetaSede(rolNorm, sucursalNorm);

  const badgeSede = doc.createElement('span');
  badgeSede.className = 'trade-sede-badge';
  badgeSede.dataset.rol = rolNorm;
  badgeSede.dataset.sucursal = sucursalNorm;
  badgeSede.textContent = textoSede;

  const etiquetaUsuario = doc.createElement('strong');
  etiquetaUsuario.className = 'trade-usuario-nombre';
  etiquetaUsuario.textContent = sanitizarTextoEntrada(sesionPerfil.nombreCompleto, 160);

  nodoContenedor.replaceChildren(badgeSede, doc.createTextNode(' · '), etiquetaUsuario);
}

/**
 * Detecta de forma síncrona si el navegador almacena un token de sesión de Supabase Auth
 * (`codizulca.supabase.auth.v1` o `sb-*-auth-token`).
 */
export function hasStoredSupabaseAuthToken(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && (key === UNIFIED_SUPABASE_STORAGE_KEY || /^sb-.*-auth-token$/i.test(key))) {
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
  const iamRole = normalizeManagedUserRole(rawRole);
  if (!iamRole) return null;
  if (iamRole === 'super_admin') return 'admin';
  if (iamRole === 'contraloria') return 'contraloria';
  if (iamRole === 'coordinacion') return 'coordinadora';
  if (iamRole === 'promotora') return 'promotora';
  if (iamRole === 'vendedor') return 'fdv';
  if (iamRole === 'cliente') return 'cliente';
  if (iamRole === 'chofer') return 'chofer';
  return null;
}

function mapToLegacyUserRole(rawRole: string, canonical: CanonicalAppRole | null): UserRole {
  if (canonical === 'contraloria' || rawRole === 'analista_contraloria') {
    return 'analista_contraloria';
  }
  if (canonical === 'admin') return 'gerente_admin';
  if (canonical === 'coordinadora') return 'jefe_trade';
  return 'promotora';
}

function isTradeCoordinatorOrAdminCanonical(role: CanonicalAppRole | null): boolean {
  return role === 'admin' || role === 'coordinadora';
}

function canCanonicalRoleAccessTorre(role: CanonicalAppRole | null): boolean {
  return role === 'admin' || role === 'contraloria' || role === 'coordinadora';
}

function resolveSucursalForIamRole(
  iamRole: ManagedUserRole | null,
  rawSucursal: unknown
): SucursalCodigo | null {
  if (!iamRole) return null;
  if (iamRole === 'super_admin') return 'GLOBAL';
  const normalized = normalizeSucursalCodigo(rawSucursal);
  if (normalized && isSucursalValidForRole(iamRole, normalized)) {
    return normalized;
  }
  return null;
}

/**
 * Extrae el perfil verificado EXCLUSIVAMENTE desde `app_metadata` (`raw_app_meta_data` firmado en servidor).
 * REGLA DE SEGURIDAD: Jamás lee roles, sucursal ni `staff_id` desde `user_metadata`.
 */
export function extractVerifiedProfileFromAuthUser(
  user: SupabaseAuthUser | null | undefined
): VerifiedAuthProfile | null {
  if (!user || !user.id) return null;

  const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;
  const rawAppRole = String(appMeta.app_role ?? appMeta.role ?? '')
    .trim()
    .toLowerCase();
  const iamRole = normalizeManagedUserRole(rawAppRole);
  const appRole = normalizeCanonicalAppRole(rawAppRole);
  const sucursal = resolveSucursalForIamRole(iamRole, appMeta.sucursal);

  const rawStaffId = String(appMeta.staff_id ?? '').trim();
  const staffId = UUID_REGEX.test(rawStaffId) ? rawStaffId : null;
  const rawRegionId = String(appMeta.region_id ?? '').trim();
  const regionId = UUID_REGEX.test(rawRegionId) ? rawRegionId : null;

  const email = normalizePortalEmail(user.email || '');
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
    sucursal,
    regionId,
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
  sucursal: SucursalCodigo | null;
}

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
        .select('id, name, email, role, status, sucursal')
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
            sucursal: normalizeSucursalCodigo((matched as { sucursal?: unknown }).sucursal),
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
        .select('id, name, email, role, status, sucursal')
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
            sucursal: normalizeSucursalCodigo((data as { sucursal?: unknown }).sucursal),
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
 * Resuelve el perfil verificado desde la fuente única `public.profiles` (con respaldo a
 * `public.staff` para promotoras activas en `/portal`).
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
      .select('role, sucursal, region_id, full_name, is_active, must_change_password')
      .eq('id', base.userId)
      .maybeSingle();

    if (!iamError && iamProfile) {
      if (iamProfile.is_active === false) {
        return null;
      }
      const rawIamRole = String(iamProfile.role ?? '').trim().toLowerCase();
      const iamRole = normalizeManagedUserRole(rawIamRole);
      const iamCanonical = normalizeCanonicalAppRole(rawIamRole);
      if (iamCanonical && iamRole) {
        const iamFullName = String(iamProfile.full_name ?? '').trim();
        const sucursal =
          resolveSucursalForIamRole(iamRole, (iamProfile as { sucursal?: unknown }).sucursal) ??
          base.sucursal;
        const rawProfileRegionId = String(
          (iamProfile as { region_id?: unknown }).region_id ?? ''
        ).trim();
        const regionId =
          iamRole === 'super_admin'
            ? null
            : UUID_REGEX.test(rawProfileRegionId)
              ? rawProfileRegionId
              : (base.regionId ?? null);

        if (iamRole === 'promotora') {
          const activeStaff = await findActivePromotoraInStaff(base.userId, normalizedEmail);
          return {
            ...base,
            email: activeStaff?.email || normalizedEmail,
            displayName: iamFullName || activeStaff?.name || base.displayName,
            appRole: 'promotora',
            iamRole: 'promotora',
            sucursal: sucursal ?? activeStaff?.sucursal ?? null,
            regionId,
            rawAppRole: 'promotora',
            legacyRole: 'promotora',
            staffId: activeStaff?.staffId ?? base.staffId,
            isCoordinatorOrAdmin: false,
            canAccessTorreControl: false,
            mustChangePassword: Boolean(iamProfile.must_change_password),
          };
        }

        return {
          ...base,
          email: normalizedEmail,
          displayName: iamFullName || base.displayName,
          appRole: iamCanonical,
          iamRole,
          sucursal,
          regionId,
          rawAppRole: iamRole,
          legacyRole: mapToLegacyUserRole(iamRole, iamCanonical),
          isCoordinatorOrAdmin: isTradeCoordinatorOrAdminCanonical(iamCanonical),
          canAccessTorreControl: canCanonicalRoleAccessTorre(iamCanonical),
          mustChangePassword: Boolean(iamProfile.must_change_password),
        };
      }
    }
  } catch {
    // Si public.profiles aún no está disponible, continúa con verificación JWT/staff
  }

  if (
    base.canAccessTorreControl ||
    base.appRole === 'fdv' ||
    base.appRole === 'cliente' ||
    base.appRole === 'chofer'
  ) {
    return { ...base, email: normalizedEmail };
  }

  const activeStaff = await findActivePromotoraInStaff(base.userId, normalizedEmail);
  if (activeStaff) {
    return {
      ...base,
      email: activeStaff.email || normalizedEmail,
      appRole: 'promotora',
      iamRole: 'promotora',
      sucursal: activeStaff.sucursal ?? base.sucursal,
      rawAppRole: base.rawAppRole || 'promotora',
      legacyRole: 'promotora',
      staffId: activeStaff.staffId,
      displayName: activeStaff.name || base.displayName,
      isCoordinatorOrAdmin: false,
      canAccessTorreControl: false,
      mustChangePassword: false,
    };
  }

  return {
    ...base,
    email: normalizedEmail,
    staffId: null,
  };
}

/**
 * Guardia unificada de autenticación contra `public.profiles` (Hito 1 · N-02 / N-03):
 *  - Autentica por correo y contraseña usando el cliente único TS.
 *  - Verifica que exista fila activa en `public.profiles` con `sucursal` válida para el rol.
 *  - Si el usuario no tiene perfil en `public.profiles`, está suspendido (`is_active = false`) o
 *    carece de sede válida, ejecuta `signOut()` inmediatamente y falla de forma segura.
 */
export async function iniciarSesionPorCorreo(
  rawEmail: string,
  rawPassword: string,
  opciones: { client?: SupabaseClient } = {}
): Promise<SesionPerfilUnificado> {
  const email = normalizePortalEmail(rawEmail);
  if (!isValidPortalEmailFormat(email)) {
    throw new Error('Ingresa un correo electrónico válido.');
  }

  const clave = String(rawPassword ?? '');
  if (clave.trim().length === 0 || clave.length > 256) {
    throw new Error('Ingresa tu contraseña para continuar.');
  }

  clearMasterDataCaches();
  setActiveClientSucursalHeader(null);

  const client = opciones.client ?? getSupabaseClient();
  const { data: authData, error: authError } = await client.auth.signInWithPassword({
    email,
    password: clave,
  });

  if (authError || !authData?.user?.id || !esUuidValido(authData.user.id)) {
    throw new Error(GENERIC_INVALID_CREDENTIALS_MESSAGE);
  }

  try {
    const { data: filaPerfil, error: perfilError } = await client
      .from('profiles')
      .select('id, email, full_name, role, sucursal, is_active')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (perfilError || !filaPerfil || filaPerfil.is_active !== true) {
      await client.auth.signOut();
      clearMasterDataCaches();
      setActiveClientSucursalHeader(null);
      throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
    }

    const rol = normalizeManagedUserRole(filaPerfil.role);
    const sucursal =
      rol === 'super_admin'
        ? 'GLOBAL'
        : normalizeSucursalCodigo((filaPerfil as { sucursal?: unknown }).sucursal);

    if (!rol || !sucursal || !isSucursalValidForRole(rol, sucursal)) {
      await client.auth.signOut();
      clearMasterDataCaches();
      setActiveClientSucursalHeader(null);
      throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
    }

    const rawStaffId = String(
      ((authData.user.app_metadata ?? {}) as Record<string, unknown>).staff_id ?? ''
    ).trim();
    const staffId = esUuidValido(rawStaffId) ? rawStaffId : null;
    const nombreCompleto =
      sanitizarTextoEntrada(filaPerfil.full_name, 160) || 'Usuario Trade Marketing';

    setActiveClientSucursalHeader(isOperativeSucursal(sucursal) ? sucursal : null);
    clearMasterDataCaches();

    return {
      userId: authData.user.id,
      email: normalizePortalEmail(String(filaPerfil.email || email)),
      rol,
      sucursal,
      nombreCompleto,
      staffId,
      etiquetaSede: obtenerEtiquetaSede(rol, sucursal),
    };
  } catch (err) {
    if (err instanceof Error && err.message === MENSAJE_PERFIL_NO_ACTIVO) {
      throw err;
    }
    await client.auth.signOut().catch(() => {});
    clearMasterDataCaches();
    setActiveClientSucursalHeader(null);
    throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
  }
}

export async function verificarSesionActiva(
  opciones: { client?: SupabaseClient } = {}
): Promise<SesionPerfilUnificado | null> {
  const client = opciones.client ?? getSupabaseClient();
  const { data: userData, error: userErr } = await client.auth.getUser();

  if (userErr || !userData?.user?.id || !esUuidValido(userData.user.id)) {
    return null;
  }

  const { data: filaPerfil, error: perfilError } = await client
    .from('profiles')
    .select('id, email, full_name, role, sucursal, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (perfilError || !filaPerfil || filaPerfil.is_active !== true) {
    await client.auth.signOut().catch(() => {});
    return null;
  }

  const rol = normalizeManagedUserRole(filaPerfil.role);
  const sucursal =
    rol === 'super_admin'
      ? 'GLOBAL'
      : normalizeSucursalCodigo((filaPerfil as { sucursal?: unknown }).sucursal);

  if (!rol || !sucursal || !isSucursalValidForRole(rol, sucursal)) {
    await client.auth.signOut().catch(() => {});
    return null;
  }

  const rawStaffId = String(
    ((userData.user.app_metadata ?? {}) as Record<string, unknown>).staff_id ?? ''
  ).trim();

  return {
    userId: userData.user.id,
    email: normalizePortalEmail(String(filaPerfil.email || userData.user.email || '')),
    rol,
    sucursal,
    nombreCompleto:
      sanitizarTextoEntrada(filaPerfil.full_name, 160) || 'Usuario Trade Marketing',
    staffId: esUuidValido(rawStaffId) ? rawStaffId : null,
    etiquetaSede: obtenerEtiquetaSede(rol, sucursal),
  };
}

export async function verifyActivePromotoraPortalAccess(session: Session | null): Promise<{
  profile: VerifiedAuthProfile | null;
  unauthorizedReason: string | null;
}> {
  if (!session?.user || !isSupabaseConfigured) {
    return { profile: null, unauthorizedReason: null };
  }

  // 1. Verificar primero identidad IAM corporativa (`public.profiles` + `app_metadata` firmado):
  //    Si corresponde a `super_admin` activo, concede ingreso inmediato a `/portal` en
  //    Modo Supervisión Global sin exigir fila en `public.staff` ni cerrar su sesión.
  const resolvedCorporate = await resolveVerifiedProfileWithStaffFallback(session);
  if (resolvedCorporate && resolvedCorporate.iamRole === 'super_admin') {
    const client = getSupabaseClient();
    client.realtime.setAuth(session.access_token);
    return {
      profile: {
        ...resolvedCorporate,
        appRole: 'admin',
        iamRole: 'super_admin',
        sucursal: 'GLOBAL',
        rawAppRole: 'super_admin',
        legacyRole: 'gerente_admin',
        staffId: null,
        isCoordinatorOrAdmin: true,
        canAccessTorreControl: true,
        mustChangePassword: false,
      },
      unauthorizedReason: null,
    };
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
      iamRole: 'promotora',
      sucursal: activeStaff.sucursal ?? base.sucursal,
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

export async function signInPromotoraPortalWithPassword(
  rawEmail: string,
  rawPassword: string
): Promise<{ session: Session; profile: VerifiedAuthProfile }> {
  const email = normalizePortalEmail(rawEmail);
  const password = String(rawPassword ?? '');

  if (!isValidPortalEmailFormat(email) || password.trim().length === 0) {
    throw new Error('Ingresa un correo electrónico válido y tu contraseña.');
  }

  clearMasterDataCaches();
  setActiveClientSucursalHeader(null);

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

  setActiveClientSucursalHeader(
    verification.profile.sucursal && isOperativeSucursal(verification.profile.sucursal)
      ? verification.profile.sucursal
      : null
  );
  clearMasterDataCaches();

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

  clearMasterDataCaches();
  setActiveClientSucursalHeader(null);

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
    clearMasterDataCaches();
    setActiveClientSucursalHeader(null);
    throw new Error(
      'Tu cuenta autenticada no tiene un perfil operativo asignado. Contacta a Coordinación.'
    );
  }

  setActiveClientSucursalHeader(
    profile.sucursal && isOperativeSucursal(profile.sucursal) ? profile.sucursal : null
  );
  await purgeAllSessionCaches({ reason: 'user_switch', preserveAuthSession: true });
  clearMasterDataCaches();
  client.realtime.setAuth(data.session.access_token);
  return { session: data.session, profile };
}

export async function signOutSupabaseSession(): Promise<void> {
  clearMasterDataCaches();
  setActiveClientSucursalHeader(null);
  await purgeAllSessionCaches({ reason: 'sign_out', preserveAuthSession: false });
  if (!isSupabaseConfigured) return;
  const client = getSupabaseClient();
  try {
    await client.auth.signOut();
  } finally {
    clearMasterDataCaches();
    setActiveClientSucursalHeader(null);
    await purgeAllSessionCaches({ reason: 'sign_out', preserveAuthSession: false });
  }
}

export async function getActiveAccessToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  const client = getSupabaseClient();
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function provisionStaffAuthAccountViaBackend(params: {
  staffId: string;
  name: string;
  email?: string;
  password?: string;
  appRole?: 'promotora' | 'coordinadora' | 'admin';
  sucursal?: OperativeSucursal;
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
      ...(params.sucursal ? { sucursal: params.sucursal } : {}),
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
