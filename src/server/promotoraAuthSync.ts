import type { SupabaseClient } from '@supabase/supabase-js';
import { getAdminSupabaseClient } from './supabaseAdminAuth';
import { serverLogger } from './logger';

const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CanonicalErpRegion = 'OCCIDENTE' | 'CENTRO' | 'ANDES';
export type CanonicalMultisedeSucursal = 'OCCIDENTE' | 'CENTRO';

export interface PromotoraAuthSyncTarget {
  id: string;
  nombre_completo: string;
  email: string | null;
  region?: string | null;
  region_id?: string | null;
  sucursal?: string | null;
  activo: boolean;
  auth_user_id?: string | null;
}

export interface AuthUserSnapshot {
  id: string;
  email: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

export interface ProfileSnapshot {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  sucursal: string | null;
  region: string | null;
  regiones_asignadas?: string[] | null;
  region_id?: string | null;
  is_active: boolean | null;
}

export interface PromotoraAuthSyncGateway {
  getAuthUserById(userId: string): Promise<AuthUserSnapshot | null>;
  findAuthUserByEmail(email: string): Promise<AuthUserSnapshot | null>;
  updateAuthUserById(
    userId: string,
    payload: {
      email?: string;
      email_confirm?: boolean;
      app_metadata?: Record<string, unknown>;
      user_metadata?: Record<string, unknown>;
    }
  ): Promise<AuthUserSnapshot>;
  getProfileById(userId: string): Promise<ProfileSnapshot | null>;
  upsertProfile(payload: Record<string, unknown>): Promise<void>;
  linkPromotoraAuthUserId(promotoraId: string, authUserId: string): Promise<void>;
}

export type PromotoraAuthSyncStatus =
  | 'synced'
  | 'unchanged'
  | 'unlinked_no_auth_account'
  | 'skipped_invalid_email'
  | 'skipped_no_admin_client'
  | 'conflict_email_in_use'
  | 'conflict_non_promotora_account'
  | 'error';

export interface PromotoraAuthSyncResult {
  synced: boolean;
  status: PromotoraAuthSyncStatus;
  authUserId: string | null;
  previousEmail: string | null;
  email: string | null;
  emailChanged: boolean;
  profileSynced: boolean;
  passwordPreserved: boolean;
  message?: string;
}

export interface EmailCollisionCheckResult {
  available: boolean;
  conflictRole?: string | null;
  conflictUserId?: string | null;
  message?: string;
}

function stripDiacritics(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeSyncEmail(raw: unknown): string | null {
  const clean = String(raw ?? '').trim().toLowerCase();
  if (!clean) return null;
  return STRICT_EMAIL_REGEX.test(clean) ? clean : null;
}

export function resolveSyncRegionMetadata(rawRegion: unknown, rawSucursal?: unknown): {
  erpRegion: CanonicalErpRegion;
  regionLabel: 'Occidente' | 'Valencia' | 'Andes';
  canonicalSucursal: CanonicalMultisedeSucursal;
  profileCompatSucursal: 'ZULIA' | 'VALENCIA';
} {
  const token = stripDiacritics(String(rawRegion ?? rawSucursal ?? ''))
    .trim()
    .toUpperCase();

  if (token === 'ANDES' || token.includes('MERIDA') || token.includes('TACHIRA') || token.includes('BARINAS')) {
    return {
      erpRegion: 'ANDES',
      regionLabel: 'Andes',
      canonicalSucursal: 'CENTRO',
      profileCompatSucursal: 'VALENCIA',
    };
  }
  if (
    token === 'CENTRO' ||
    token === 'VALENCIA' ||
    token === 'CAPITAL' ||
    token.includes('CARABOBO') ||
    token.includes('ARAGUA') ||
    token.includes('MARACAY') ||
    token.includes('CARACAS')
  ) {
    return {
      erpRegion: 'CENTRO',
      regionLabel: 'Valencia',
      canonicalSucursal: 'CENTRO',
      profileCompatSucursal: 'VALENCIA',
    };
  }
  return {
    erpRegion: 'OCCIDENTE',
    regionLabel: 'Occidente',
    canonicalSucursal: 'OCCIDENTE',
    profileCompatSucursal: 'ZULIA',
  };
}

function extractAuthUserRole(user: AuthUserSnapshot | null | undefined): string {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>;
  return String(appMeta.role ?? appMeta.app_role ?? '')
    .trim()
    .toLowerCase();
}

function extractAuthUserPromotoraId(user: AuthUserSnapshot | null | undefined): string {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>;
  return String(appMeta.promotora_id ?? '').trim();
}

export function createSupabasePromotoraAuthSyncGateway(
  customAdminClient?: SupabaseClient | null
): PromotoraAuthSyncGateway | null {
  const admin = customAdminClient ?? getAdminSupabaseClient();
  if (!admin) return null;

  return {
    async getAuthUserById(userId) {
      if (!UUID_REGEX.test(userId)) return null;
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      return {
        id: data.user.id,
        email: data.user.email ?? null,
        email_confirmed_at: data.user.email_confirmed_at ?? null,
        app_metadata: (data.user.app_metadata ?? {}) as Record<string, unknown>,
        user_metadata: (data.user.user_metadata ?? {}) as Record<string, unknown>,
      };
    },

    async findAuthUserByEmail(email) {
      const target = String(email ?? '').trim().toLowerCase();
      if (!target) return null;
      const perPage = 200;
      for (let page = 1; page <= 100; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
        if (error) {
          throw new Error(`No se pudo consultar auth.users (página ${page}): ${error.message}`);
        }
        const users = Array.isArray(data?.users) ? data.users : [];
        const match = users.find((u) => String(u.email ?? '').trim().toLowerCase() === target);
        if (match) {
          return {
            id: match.id,
            email: match.email ?? null,
            email_confirmed_at: match.email_confirmed_at ?? null,
            app_metadata: (match.app_metadata ?? {}) as Record<string, unknown>,
            user_metadata: (match.user_metadata ?? {}) as Record<string, unknown>,
          };
        }
        if (users.length < perPage) break;
      }
      return null;
    },

    async updateAuthUserById(userId, payload) {
      // Nunca aceptamos ni pasamos `password` aquí: la contraseña vigente de la promotora se preserva intacta.
      const { data, error } = await admin.auth.admin.updateUserById(userId, {
        ...(payload.email ? { email: payload.email } : {}),
        ...(payload.email_confirm !== undefined ? { email_confirm: payload.email_confirm } : {}),
        ...(payload.app_metadata ? { app_metadata: payload.app_metadata } : {}),
        ...(payload.user_metadata ? { user_metadata: payload.user_metadata } : {}),
      });
      if (error || !data?.user) {
        throw new Error(error?.message || 'Error actualizando usuario en Supabase Auth.');
      }
      return {
        id: data.user.id,
        email: data.user.email ?? null,
        email_confirmed_at: data.user.email_confirmed_at ?? null,
        app_metadata: (data.user.app_metadata ?? {}) as Record<string, unknown>,
        user_metadata: (data.user.user_metadata ?? {}) as Record<string, unknown>,
      };
    },

    async getProfileById(userId) {
      if (!UUID_REGEX.test(userId)) return null;
      const { data, error } = await admin
        .from('profiles')
        .select('id, email, full_name, role, sucursal, region, regiones_asignadas, region_id, is_active')
        .eq('id', userId)
        .maybeSingle();
      if (error || !data) return null;
      return data as ProfileSnapshot;
    },

    async upsertProfile(payload) {
      const { error } = await admin.from('profiles').upsert(payload, { onConflict: 'id' });
      if (error) {
        throw new Error(`No se pudo sincronizar public.profiles: ${error.message}`);
      }
    },

    async linkPromotoraAuthUserId(promotoraId, authUserId) {
      const eqId: string | number = /^\d+$/.test(promotoraId) ? Number(promotoraId) : promotoraId;
      const { error } = await admin
        .from('promotoras')
        .update({ auth_user_id: authUserId, updated_at: new Date().toISOString() })
        .eq('id', eqId);
      if (error) {
        throw new Error(`No se pudo vincular auth_user_id en public.promotoras: ${error.message}`);
      }
    },
  };
}

/**
 * Valida antes de persistir un cambio de correo que el nuevo correo no pertenezca ya a otra cuenta
 * en Supabase Auth (evitando colisiones y estados parcialmente desincronizados).
 */
export async function checkPromotoraEmailAvailability(params: {
  gateway: PromotoraAuthSyncGateway | null;
  promotoraId: string;
  currentAuthUserId?: string | null;
  newEmail: string | null;
}): Promise<EmailCollisionCheckResult> {
  const { gateway, promotoraId, currentAuthUserId, newEmail } = params;
  const normalized = normalizeSyncEmail(newEmail);
  if (!gateway || !normalized) {
    return { available: true };
  }

  const existingByEmail = await gateway.findAuthUserByEmail(normalized);
  if (!existingByEmail) {
    return { available: true };
  }

  if (currentAuthUserId && existingByEmail.id === currentAuthUserId) {
    return { available: true };
  }

  const existingRole = extractAuthUserRole(existingByEmail);
  const existingMetaPromId = extractAuthUserPromotoraId(existingByEmail);

  // Si la promotora aún no tenía auth_user_id, solo es reclamable si la cuenta pertenece exactamente a ella
  if (
    !currentAuthUserId &&
    (!existingRole || existingRole === 'promotora') &&
    (!existingMetaPromId || existingMetaPromId === String(promotoraId))
  ) {
    return { available: true };
  }

  if (existingRole && existingRole !== 'promotora') {
    return {
      available: false,
      conflictRole: existingRole,
      conflictUserId: existingByEmail.id,
      message: `El correo "${normalized}" ya está asignado a una cuenta con rol "${existingRole}".`,
    };
  }

  return {
    available: false,
    conflictRole: existingRole || 'promotora',
    conflictUserId: existingByEmail.id,
    message: `El correo "${normalized}" ya está registrado por otra promotora en Supabase Auth.`,
  };
}

/**
 * Sincroniza de forma 100 % idempotente y segura la identidad de una promotora
 * desde `public.promotoras` hacia `auth.users` y `public.profiles`:
 *  - Actualiza `auth.users.email` con `email_confirm: true` SIN modificar ni restablecer la contraseña.
 *  - Sincroniza `app_metadata` (`display_name`, `role`, `promotora_id`, `region`, `sucursal`, `region_id`)
 *    y `user_metadata.nombre_completo`.
 *  - Sincroniza `public.profiles` (`email`, `full_name`, `is_active`, región/sucursal).
 *  - Jamás toca cuentas de otros roles (`super_admin`, `coordinacion`, `contraloria`, `chofer`, etc.)
 *    ni de otras promotoras.
 */
export async function syncPromotoraIdentityToSupabaseAuth(params: {
  gateway: PromotoraAuthSyncGateway | null;
  promotora: PromotoraAuthSyncTarget;
  previousEmail?: string | null;
}): Promise<PromotoraAuthSyncResult> {
  const { gateway, promotora, previousEmail } = params;
  const normalizedNewEmail = normalizeSyncEmail(promotora.email);
  const normalizedPrevEmail = normalizeSyncEmail(previousEmail);
  const cleanName = String(promotora.nombre_completo ?? '').replace(/\s+/g, ' ').trim();
  const promotoraId = String(promotora.id ?? '').trim();

  if (!gateway) {
    return {
      synced: false,
      status: 'skipped_no_admin_client',
      authUserId: promotora.auth_user_id ?? null,
      previousEmail: normalizedPrevEmail,
      email: normalizedNewEmail,
      emailChanged: false,
      profileSynced: false,
      passwordPreserved: true,
      message: 'Sincronización Auth omitida: cliente administrativo no configurado en el servidor.',
    };
  }

  // 1) Resolver cuenta Auth 1:1 existente sin robar cuentas ajenas
  let authUser: AuthUserSnapshot | null = null;
  let needsAuthLinkBackfill = false;

  if (promotora.auth_user_id && UUID_REGEX.test(promotora.auth_user_id)) {
    authUser = await gateway.getAuthUserById(promotora.auth_user_id);
  }

  if (!authUser) {
    const candidates = [normalizedPrevEmail, normalizedNewEmail].filter(
      (e): e is string => Boolean(e)
    );
    for (const candidateEmail of candidates) {
      const hit = await gateway.findAuthUserByEmail(candidateEmail);
      if (!hit) continue;
      const role = extractAuthUserRole(hit);
      const metaPromId = extractAuthUserPromotoraId(hit);
      if (role && role !== 'promotora') {
        return {
          synced: false,
          status: 'conflict_non_promotora_account',
          authUserId: null,
          previousEmail: normalizedPrevEmail,
          email: normalizedNewEmail,
          emailChanged: false,
          profileSynced: false,
          passwordPreserved: true,
          message: `El correo "${candidateEmail}" pertenece a un usuario con rol "${role}".`,
        };
      }
      if (metaPromId && metaPromId !== promotoraId) {
        return {
          synced: false,
          status: 'conflict_email_in_use',
          authUserId: null,
          previousEmail: normalizedPrevEmail,
          email: normalizedNewEmail,
          emailChanged: false,
          profileSynced: false,
          passwordPreserved: true,
          message: `El correo "${candidateEmail}" ya está vinculado a otra promotora (id=${metaPromId}).`,
        };
      }
      authUser = hit;
      needsAuthLinkBackfill = true;
      break;
    }
  }

  if (!authUser) {
    return {
      synced: false,
      status: 'unlinked_no_auth_account',
      authUserId: null,
      previousEmail: normalizedPrevEmail,
      email: normalizedNewEmail,
      emailChanged: false,
      profileSynced: false,
      passwordPreserved: true,
      message:
        'La promotora aún no posee cuenta creada en Supabase Auth; requiere aprovisionamiento inicial con contraseña.',
    };
  }

  const currentRole = extractAuthUserRole(authUser);
  if (currentRole && currentRole !== 'promotora') {
    return {
      synced: false,
      status: 'conflict_non_promotora_account',
      authUserId: authUser.id,
      previousEmail: normalizeSyncEmail(authUser.email),
      email: normalizedNewEmail,
      emailChanged: false,
      profileSynced: false,
      passwordPreserved: true,
      message: `La cuenta Auth vinculada tiene rol "${currentRole}" (no promotora). Se aborta sincronización por seguridad.`,
    };
  }

  const currentAuthEmail = normalizeSyncEmail(authUser.email);
  const targetEmail = normalizedNewEmail ?? currentAuthEmail;
  if (!targetEmail) {
    return {
      synced: false,
      status: 'skipped_invalid_email',
      authUserId: authUser.id,
      previousEmail: currentAuthEmail,
      email: null,
      emailChanged: false,
      profileSynced: false,
      passwordPreserved: true,
      message: 'No existe un correo electrónico válido para sincronizar.',
    };
  }

  const emailChanged = Boolean(currentAuthEmail !== targetEmail);

  // 2) Verificar colisión de correo si cambió
  if (emailChanged) {
    const collision = await checkPromotoraEmailAvailability({
      gateway,
      promotoraId,
      currentAuthUserId: authUser.id,
      newEmail: targetEmail,
    });
    if (!collision.available) {
      return {
        synced: false,
        status:
          collision.conflictRole && collision.conflictRole !== 'promotora'
            ? 'conflict_non_promotora_account'
            : 'conflict_email_in_use',
        authUserId: authUser.id,
        previousEmail: currentAuthEmail,
        email: targetEmail,
        emailChanged: false,
        profileSynced: false,
        passwordPreserved: true,
        message: collision.message,
      };
    }
  }

  const regionMeta = resolveSyncRegionMetadata(promotora.region, promotora.sucursal);
  const existingProfile = await gateway.getProfileById(authUser.id);

  const existingAppMeta = authUser.app_metadata ?? {};
  const existingUserMeta = authUser.user_metadata ?? {};

  const currentDisplayName = String(existingAppMeta.display_name ?? '').trim();
  const currentUserMetaName = String(existingUserMeta.nombre_completo ?? '').trim();
  const currentAppRegion = String(existingAppMeta.region ?? '').trim().toUpperCase();
  const currentAppSucursal = String(existingAppMeta.sucursal ?? '').trim().toUpperCase();
  const currentAppPromId = String(existingAppMeta.promotora_id ?? '').trim();
  const currentAppRegionId = String(existingAppMeta.region_id ?? '').trim();
  const isConfirmed = Boolean(authUser.email_confirmed_at);

  const authNeedsUpdate =
    emailChanged ||
    !isConfirmed ||
    (Boolean(cleanName) && (currentDisplayName !== cleanName || currentUserMetaName !== cleanName)) ||
    currentAppRegion !== regionMeta.erpRegion ||
    currentAppSucursal !== regionMeta.canonicalSucursal ||
    currentAppPromId !== promotoraId ||
    (Boolean(promotora.region_id) && currentAppRegionId !== String(promotora.region_id));

  const profileEmail = normalizeSyncEmail(existingProfile?.email);
  const profileName = String(existingProfile?.full_name ?? '').trim();
  const profileActive = existingProfile?.is_active;
  const profileNeedsUpdate =
    !existingProfile ||
    profileEmail !== targetEmail ||
    (Boolean(cleanName) && profileName !== cleanName) ||
    Boolean(profileActive) !== Boolean(promotora.activo !== false) ||
    String(existingProfile.role ?? '').trim().toLowerCase() !== 'promotora' ||
    (Boolean(promotora.region_id) && String(existingProfile.region_id ?? '') !== String(promotora.region_id));

  if (!authNeedsUpdate && !profileNeedsUpdate && !needsAuthLinkBackfill) {
    return {
      synced: true,
      status: 'unchanged',
      authUserId: authUser.id,
      previousEmail: currentAuthEmail,
      email: targetEmail,
      emailChanged: false,
      profileSynced: true,
      passwordPreserved: true,
    };
  }

  // 3) Actualizar `auth.users` preservando contraseña actual
  if (authNeedsUpdate) {
    const nextAppMetadata: Record<string, unknown> = {
      ...existingAppMeta,
      role: 'promotora',
      app_role: 'promotora',
      rol_multisede: 'promotora',
      promotora_id: promotoraId,
      ...(cleanName ? { display_name: cleanName } : {}),
      region: regionMeta.erpRegion,
      region_label: regionMeta.regionLabel,
      regions: [regionMeta.erpRegion],
      sucursal: regionMeta.canonicalSucursal,
      ...(promotora.region_id ? { region_id: promotora.region_id } : {}),
    };

    const nextUserMetadata: Record<string, unknown> = {
      ...existingUserMeta,
      ...(cleanName ? { nombre_completo: cleanName } : {}),
      promotora_id: promotoraId,
      region: regionMeta.regionLabel,
      email_verified: true,
    };

    await gateway.updateAuthUserById(authUser.id, {
      email: targetEmail,
      email_confirm: true,
      app_metadata: nextAppMetadata,
      user_metadata: nextUserMetadata,
    });
  }

  // 4) Sincronizar `public.profiles`
  if (profileNeedsUpdate) {
    const existingRegionNorm = existingProfile
      ? resolveSyncRegionMetadata(existingProfile.region, existingProfile.sucursal).erpRegion
      : null;
    const preserveExistingSucursal =
      existingProfile?.sucursal && existingRegionNorm === regionMeta.erpRegion
        ? existingProfile.sucursal
        : regionMeta.profileCompatSucursal;

    await gateway.upsertProfile({
      id: authUser.id,
      email: targetEmail,
      full_name: cleanName || existingProfile?.full_name || `Promotora #${promotoraId}`,
      role: 'promotora',
      sucursal: preserveExistingSucursal,
      region: regionMeta.regionLabel,
      regiones_asignadas: [regionMeta.erpRegion],
      ...(promotora.region_id
        ? { region_id: promotora.region_id }
        : existingProfile?.region_id
          ? { region_id: existingProfile.region_id }
          : {}),
      is_active: promotora.activo !== false,
      updated_at: new Date().toISOString(),
    });
  }

  // 5) Vincular `auth_user_id` en `public.promotoras` si faltaba
  if (needsAuthLinkBackfill) {
    await gateway.linkPromotoraAuthUserId(promotoraId, authUser.id);
  }

  serverLogger.info('promotora_auth_identity_synced', {
    promotoraId,
    authUserId: authUser.id,
    emailChanged,
    region: regionMeta.erpRegion,
    activo: promotora.activo !== false,
    authUpdated: authNeedsUpdate,
    profileUpdated: profileNeedsUpdate,
  });

  return {
    synced: true,
    status: 'synced',
    authUserId: authUser.id,
    previousEmail: currentAuthEmail,
    email: targetEmail,
    emailChanged,
    profileSynced: true,
    passwordPreserved: true,
  };
}
