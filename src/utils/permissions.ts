import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveVerifiedProfileWithStaffFallback,
  type VerifiedAuthProfile,
} from '../services/authService';
import { getSupabaseClient, isSupabaseConfigured } from '../services/supabaseClient';
import { normalizeManagedUserRole, type ManagedUserRole } from '../services/userManagementService';

export type DashboardModuleId =
  | 'promotoras'
  | 'llenado_cronograma'
  | 'maestros'
  | 'pop_incidencias'
  | 'contraloria'
  | 'kpis_trazabilidad'
  | 'gestion_usuarios';

export const DASHBOARD_MODULE_ALLOWED_ROLES: Record<
  DashboardModuleId,
  readonly ManagedUserRole[]
> = {
  promotoras: ['super_admin', 'coordinacion'],
  llenado_cronograma: ['super_admin', 'coordinacion'],
  maestros: ['super_admin', 'coordinacion'],
  pop_incidencias: ['super_admin', 'coordinacion', 'contraloria'],
  contraloria: ['super_admin', 'contraloria', 'coordinacion'],
  kpis_trazabilidad: ['super_admin', 'contraloria', 'coordinacion'],
  gestion_usuarios: ['super_admin', 'coordinacion'],
};

/**
 * Única fuente de verdad para detectar `super_admin` verificado en cliente.
 * REGLA OWASP A01: Nunca decide autorización por correo aislado ni por `user_metadata`;
 * requiere rol `'super_admin'` verificado desde `public.profiles` o `app_metadata` firmado.
 */
export function isSuperAdminRole(
  iamRole: ManagedUserRole | string | null | undefined
): boolean {
  return normalizeManagedUserRole(iamRole) === 'super_admin';
}

export function isSuperAdminProfile(
  profile: Pick<VerifiedAuthProfile, 'iamRole'> | null | undefined
): boolean {
  return Boolean(profile && isSuperAdminRole(profile.iamRole));
}

/**
 * Evalúa si un perfil o rol IAM verificado puede acceder a un módulo del Dashboard.
 * `super_admin` posee acceso total e irrestricto a todos los módulos.
 */
export function canAccessModule(
  roleOrProfile:
    | ManagedUserRole
    | Pick<VerifiedAuthProfile, 'iamRole'>
    | null
    | undefined,
  moduleId: DashboardModuleId
): boolean {
  if (!roleOrProfile) return false;
  const iamRole =
    typeof roleOrProfile === 'string'
      ? normalizeManagedUserRole(roleOrProfile)
      : normalizeManagedUserRole(roleOrProfile.iamRole);

  if (!iamRole) return false;
  if (iamRole === 'super_admin') return true;
  return DASHBOARD_MODULE_ALLOWED_ROLES[moduleId].includes(iamRole);
}

/**
 * Evalúa si el perfil verificado puede ingresar al Portal de Promotoras (`/portal`).
 * Permite promotoras activas con registro verificado en `public.staff` o `super_admin`
 * en Modo Supervisión Global.
 */
export function canAccessPromotoraPortal(
  profile: Pick<VerifiedAuthProfile, 'iamRole' | 'appRole' | 'staffId'> | null | undefined
): boolean {
  if (!profile) return false;
  if (isSuperAdminProfile(profile)) return true;
  return profile.appRole === 'promotora' && Boolean(profile.staffId);
}

/**
 * Habilita bypass controlado de geocerca GPS / turno horario exclusivamente para
 * auditoría desde oficina ejecutada por una sesión verificada `super_admin`.
 */
export function canBypassFieldGeofence(
  profile: Pick<VerifiedAuthProfile, 'iamRole'> | null | undefined
): boolean {
  return isSuperAdminProfile(profile);
}

/**
 * Refresca el JWT de sesión (`supabase.auth.refreshSession`) y revalida el perfil
 * contra `public.profiles` / `app_metadata` firmado, útil inmediatamente después de
 * aplicar cambios de rol en BD sin obligar a cerrar sesión.
 */
export async function refreshVerifiedProfileSession(
  customClient?: SupabaseClient
): Promise<VerifiedAuthProfile | null> {
  if (!customClient && !isSupabaseConfigured) return null;
  const client = customClient ?? getSupabaseClient();
  try {
    const { data, error } = await client.auth.refreshSession();
    if (error || !data.session) {
      const { data: current } = await client.auth.getSession();
      if (!current.session) return null;
      return resolveVerifiedProfileWithStaffFallback(current.session);
    }
    client.realtime.setAuth(data.session.access_token);
    return resolveVerifiedProfileWithStaffFallback(data.session);
  } catch {
    return null;
  }
}
