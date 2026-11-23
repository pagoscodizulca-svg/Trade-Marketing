import {
  assertSupabaseConfigured,
  getSupabaseClient,
  isSupabaseConfigured,
} from './supabaseClient';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const MIN_SUPABASE_PASSWORD_LENGTH = 8;

/**
 * Dominio único de roles en `public.profiles` (Hito 1 · N-02 / D6):
 *  - Los antiguos `supervisor` se normalizan y migran a `coordinacion`.
 *  - Incluye `promotora`, `cliente` y el rol técnico `chofer` (solo entregas).
 */
export type ManagedUserRole =
  | 'super_admin'
  | 'contraloria'
  | 'coordinacion'
  | 'vendedor'
  | 'promotora'
  | 'cliente'
  | 'chofer';

export const MANAGED_USER_ROLES: readonly ManagedUserRole[] = [
  'super_admin',
  'contraloria',
  'coordinacion',
  'vendedor',
  'promotora',
  'cliente',
  'chofer',
] as const;

export const MANAGED_USER_ROLE_LABELS: Record<ManagedUserRole, string> = {
  super_admin: 'Administrador General',
  contraloria: 'Contraloría Interna',
  coordinacion: 'Coordinación Trade',
  vendedor: 'Vendedor (FDV)',
  promotora: 'Promotora de Campo',
  cliente: 'Portal Cliente',
  chofer: 'Chofer / Logística',
};

/**
 * Código oficial de sede / región operativa (Compuerta G2 · 5 Hubs Nacionales + Global):
 *  - `GLOBAL` solo permitido para roles nacionales autorizados (`super_admin`, `contraloria`).
 *  - Los roles regionales exigen obligatoriamente uno de los 5 hubs operativos:
 *    `ZULIA`, `VALENCIA`, `CENTRO`, `ORIENTE` o `CAPITAL`.
 */
export const OPERATIVE_SUCURSALES = [
  'ZULIA',
  'VALENCIA',
  'CENTRO',
  'ORIENTE',
  'CAPITAL',
] as const;

export type OperativeSucursal = (typeof OPERATIVE_SUCURSALES)[number];

export type SucursalCodigo = OperativeSucursal | 'GLOBAL';

export const SUCURSAL_CODIGOS: readonly SucursalCodigo[] = [
  ...OPERATIVE_SUCURSALES,
  'GLOBAL',
] as const;

export const SUCURSAL_LABELS: Record<SucursalCodigo, string> = {
  ZULIA: 'Sucursal Zulia',
  VALENCIA: 'Sucursal Valencia',
  CENTRO: 'Sucursal Centro',
  ORIENTE: 'Sucursal Oriente',
  CAPITAL: 'Sucursal Capital',
  GLOBAL: 'Global · Nacional',
};

export interface ManagedUserProfile {
  id: string;
  email: string;
  fullName: string;
  role: ManagedUserRole;
  sucursal: SucursalCodigo;
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
  sucursal?: SucursalCodigo;
  mustChangePassword?: boolean;
}

export interface UpdateManagedUserAccessInput {
  targetUserId: string;
  fullName: string;
  role: ManagedUserRole;
  sucursal?: SucursalCodigo | null;
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
  sucursal?: unknown;
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
    value === 'contraloria' ||
    value === 'coordinacion' ||
    value === 'vendedor' ||
    value === 'promotora' ||
    value === 'cliente' ||
    value === 'chofer'
  );
}

export function normalizeManagedUserRole(rawRole: unknown): ManagedUserRole | null {
  const clean = String(rawRole ?? '').trim().toLowerCase();
  if (isManagedUserRole(clean)) return clean;
  if (
    clean === 'superadmin' ||
    clean === 'admin_general' ||
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
    clean === 'coordinador' ||
    clean === 'coordinadora_trade' ||
    clean === 'coordinador_trade' ||
    clean === 'coordinador_regional' ||
    clean === 'jefe_trade' ||
    clean === 'supervisor' ||
    clean === 'supervisora' ||
    clean === 'supervisor_trade'
  ) {
    return 'coordinacion';
  }
  if (clean === 'fdv' || clean === 'fuerza_ventas') {
    return 'vendedor';
  }
  return null;
}

export function isOperativeSucursal(value: unknown): value is OperativeSucursal {
  return (
    value === 'ZULIA' ||
    value === 'VALENCIA' ||
    value === 'CENTRO' ||
    value === 'ORIENTE' ||
    value === 'CAPITAL'
  );
}

export function normalizeSucursalCodigo(raw: unknown): SucursalCodigo | null {
  const nfdLower = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  if (!nfdLower) return null;

  const tokensText = nfdLower.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!tokensText) return null;

  if (
    tokensText === 'global' ||
    tokensText === 'nacional' ||
    tokensText === 'admin general' ||
    tokensText === 'global nacional' ||
    tokensText === 'administracion general nacional' ||
    tokensText === 'contraloria nacional global'
  ) {
    return 'GLOBAL';
  }

  const strippedPrefix = tokensText.replace(
    /^(sucursal|sede|region|hub|estado|zona|oficina)\s+/,
    ''
  );
  if (strippedPrefix === 'zulia' || strippedPrefix === 'occidente') return 'ZULIA';
  if (strippedPrefix === 'valencia') return 'VALENCIA';
  if (strippedPrefix === 'centro') return 'CENTRO';
  if (strippedPrefix === 'oriente') return 'ORIENTE';
  if (strippedPrefix === 'capital') return 'CAPITAL';

  if (
    /\b(occidente|zulia|maracaibo|san francisco|cabimas|ciudad ojeda|lagunillas|machiques|costa oriental|mara|guajira|coro|punto fijo|la villa)\b/.test(
      tokensText
    ) ||
    tokensText === 'col'
  ) {
    return 'ZULIA';
  }

  if (
    /\b(valencia|carabobo|naguanagua|san diego|guacara|tocuyito|puerto cabello|los guayos|mariara|bejuma)\b/.test(
      tokensText
    )
  ) {
    return 'VALENCIA';
  }

  if (
    /\b(centro|aragua|maracay|turmero|cagua|la victoria|villa de cura|lara|barquisimeto|cabudare|carora|quibor|yaracuy|san felipe|yaritagua|cojedes|san carlos|tinaquillo)\b/.test(
      tokensText
    )
  ) {
    return 'CENTRO';
  }

  if (
    /\b(oriente|anzoategui|barcelona|puerto la cruz|lecheria|el tigre|anaco|cantaura|monagas|maturin|punta de mata|nueva esparta|margarita|porlamar|pampatar|juan griego|sucre|cumana|carupano|puerto ordaz|ciudad guayana|ciudad bolivar|san felix|upata|estado bolivar|delta amacuro|tucupita)\b/.test(
      tokensText
    ) ||
    tokensText === 'bolivar'
  ) {
    return 'ORIENTE';
  }

  if (
    /\b(capital|caracas|distrito capital|dtto capital|gran caracas|miranda|chacao|baruta|el hatillo|petare|los teques|guarenas|guatire|charallave|cua|ocumare del tuy|valles del tuy|higuerote|la guaira|vargas|maiquetia|catia la mar|caraballeda)\b/.test(
      tokensText
    )
  ) {
    return 'CAPITAL';
  }

  return null;
}

export function getAllowedSucursalesForRole(role: ManagedUserRole): readonly SucursalCodigo[] {
  if (role === 'super_admin') {
    return ['GLOBAL'];
  }
  if (role === 'contraloria') {
    return ['GLOBAL', ...OPERATIVE_SUCURSALES];
  }
  return OPERATIVE_SUCURSALES;
}

export function isSucursalValidForRole(
  role: ManagedUserRole,
  sucursal: SucursalCodigo | null | undefined
): sucursal is SucursalCodigo {
  if (!sucursal) return false;
  return getAllowedSucursalesForRole(role).includes(sucursal);
}

export function resolveDefaultSucursalForRole(role: ManagedUserRole): SucursalCodigo {
  if (role === 'super_admin' || role === 'contraloria') {
    return 'GLOBAL';
  }
  return 'ZULIA';
}

export function normalizeManagedUserEmail(rawEmail: string): string {
  return String(rawEmail ?? '').trim().toLowerCase();
}

function getCryptoRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    const maxUnbiased = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    let value = 0;
    do {
      cryptoObj.getRandomValues(buf);
      value = buf[0] ?? 0;
    } while (value >= maxUnbiased);
    return value % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

export function generateSecureInitialPassword(length = 12): string {
  const safeLength = Math.max(MIN_SUPABASE_PASSWORD_LENGTH, Math.min(Math.trunc(length) || 12, 32));
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*+-=';
  const all = upper + lower + digits + symbols;

  const chars: string[] = [
    upper[getCryptoRandomInt(upper.length)]!,
    lower[getCryptoRandomInt(lower.length)]!,
    digits[getCryptoRandomInt(digits.length)]!,
    symbols[getCryptoRandomInt(symbols.length)]!,
  ];

  while (chars.length < safeLength) {
    chars.push(all[getCryptoRandomInt(all.length)]!);
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = getCryptoRandomInt(i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }

  return chars.join('');
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
  const normalized = normalizeManagedUserRole(rawRole);
  if (!normalized) {
    throw new Error(
      'Rol inválido. Selecciona super_admin, contraloria, coordinacion, vendedor, promotora, cliente o chofer.'
    );
  }
  return normalized;
}

function validateSucursalForRole(
  role: ManagedUserRole,
  rawSucursal: unknown,
  options?: { allowImplicitDefault?: boolean }
): SucursalCodigo {
  if (role === 'super_admin') {
    return 'GLOBAL';
  }

  if (rawSucursal === undefined || rawSucursal === null || String(rawSucursal).trim() === '') {
    if (role === 'contraloria' || options?.allowImplicitDefault) {
      return resolveDefaultSucursalForRole(role);
    }
    throw new Error(
      `Debes seleccionar una sucursal operativa (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) para el rol ${role}.`
    );
  }

  const normalized = normalizeSucursalCodigo(rawSucursal);
  if (!normalized || !isSucursalValidForRole(role, normalized)) {
    throw new Error(
      normalized === 'GLOBAL'
        ? `La sucursal GLOBAL está reservada únicamente para super_admin y contraloria.`
        : 'Sucursal inválida. Selecciona ZULIA, VALENCIA, CENTRO, ORIENTE, CAPITAL o GLOBAL.'
    );
  }
  return normalized;
}

function validateUuid(rawId: string, fieldLabel: string): string {
  const clean = String(rawId ?? '').trim();
  if (!UUID_REGEX.test(clean)) {
    throw new Error(`Identificador inválido para ${fieldLabel}.`);
  }
  return clean;
}

function mapProfileRow(row: RawProfileRow): ManagedUserProfile {
  const role: ManagedUserRole = normalizeManagedUserRole(row.role) ?? 'vendedor';
  const rawSucursal = normalizeSucursalCodigo(row.sucursal);
  const sucursal: SucursalCodigo =
    rawSucursal && isSucursalValidForRole(role, rawSucursal)
      ? rawSucursal
      : resolveDefaultSucursalForRole(role);

  return {
    id: String(row.id ?? ''),
    email: normalizeManagedUserEmail(String(row.email ?? '')),
    fullName: String(row.full_name ?? '').trim(),
    role,
    sucursal,
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

function formatSupabaseRpcError(
  error: { message?: string; code?: string } | null,
  fallback: string
): string {
  const msg = String(error?.message ?? '').trim();
  const code = String(error?.code ?? '').trim().toLowerCase();
  if (!msg) return fallback;
  if (/acceso denegado/i.test(msg) || code === '42501') {
    return 'Acceso denegado: esta acción es exclusiva del Administrador General activo.';
  }
  if (/anti auto-bloqueo/i.test(msg)) {
    return msg;
  }
  if (/al menos un usuario super_admin activo|cero usuarios super_admin/i.test(msg)) {
    return 'Operación bloqueada: el sistema debe conservar al menos un Administrador General activo.';
  }
  if (
    /already registered|user already exists|already been registered/i.test(msg) ||
    code === 'user_already_exists' ||
    code === 'email_exists'
  ) {
    return 'Este correo electrónico ya está registrado en el sistema.';
  }
  if (
    /at least 6 characters|password is too short|weak_password|password should be at least/i.test(
      msg
    ) ||
    code === 'weak_password'
  ) {
    return `La contraseña inicial es demasiado corta: debe tener al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres.`;
  }
  if (/invalid email|unable to validate email/i.test(msg)) {
    return 'Ingresa un correo electrónico corporativo válido.';
  }
  if (/rate limit|too many requests/i.test(msg) || code === 'over_email_send_rate_limit') {
    return 'Se alcanzó el límite temporal de solicitudes en Supabase Auth. Espera unos segundos e inténtalo nuevamente.';
  }
  return msg;
}

async function requireAuthenticatedSuperAdminSession(): Promise<{
  userId: string;
  accessToken: string;
}> {
  assertSupabaseConfigured();
  const client = getSupabaseClient();
  const [{ data: userData, error: userErr }, { data: sessionData }] = await Promise.all([
    client.auth.getUser(),
    client.auth.getSession(),
  ]);

  const token = String(sessionData.session?.access_token ?? '').trim();
  if (userErr || !userData.user?.id || !token) {
    throw new Error(
      'Sesión no válida o expirada. Inicia sesión nuevamente como Administrador General.'
    );
  }

  return {
    userId: userData.user.id,
    accessToken: token,
  };
}

async function requireAuthenticatedSuperAdminSessionId(): Promise<string> {
  const session = await requireAuthenticatedSuperAdminSession();
  return session.userId;
}

export async function getCurrentUserAccessProfile(): Promise<ManagedUserProfile | null> {
  if (!isSupabaseConfigured) return null;
  const client = getSupabaseClient();
  const { data: authData, error: authError } = await client.auth.getUser();

  if (authError || !authData.user?.id) {
    return null;
  }

  const { data, error } = await client
    .from('profiles')
    .select(
      'id, email, full_name, role, sucursal, is_active, must_change_password, created_at, updated_at'
    )
    .eq('id', authData.user.id)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return mapProfileRow(data as RawProfileRow);
}

export async function isCurrentUserActiveSuperAdmin(): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const client = getSupabaseClient();
  const { data, error } = await client.rpc('is_active_super_admin');
  if (error) return false;
  return data === true;
}

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

export async function createManagedUser(
  input: CreateManagedUserInput
): Promise<ManagedUserProfile> {
  const { accessToken } = await requireAuthenticatedSuperAdminSession();

  const fullName = validateFullName(input.fullName);
  const email = validateEmail(input.email);
  const role = validateRole(input.role);
  const sucursal = validateSucursalForRole(role, input.sucursal);
  const password = String(input.password ?? '');
  const mustChangePassword = input.mustChangePassword === true;

  if (password.trim().length === 0 || password.length < MIN_SUPABASE_PASSWORD_LENGTH) {
    throw new Error(
      `La contraseña inicial es demasiado corta: debe tener al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres.`
    );
  }

  const res = await fetch('/api/admin/corporate-users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      fullName,
      email,
      password,
      role,
      sucursal,
      mustChangePassword,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    code?: string;
    profile?: RawProfileRow;
  };

  if (!res.ok || !payload.profile) {
    throw new Error(
      formatSupabaseRpcError(
        { message: payload.error, code: payload.code },
        `No se pudo crear el usuario corporativo (HTTP ${res.status}).`
      )
    );
  }

  return mapProfileRow(payload.profile);
}

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
  const sucursal =
    input.sucursal !== undefined && input.sucursal !== null
      ? validateSucursalForRole(role, input.sucursal)
      : role === 'super_admin'
        ? 'GLOBAL'
        : null;

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
    ...(sucursal ? { p_sucursal: sucursal } : {}),
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

export async function completeOwnPasswordChange(newPassword: string): Promise<void> {
  assertSupabaseConfigured();
  const cleanPassword = String(newPassword ?? '');
  if (cleanPassword.trim().length === 0 || cleanPassword.length < MIN_SUPABASE_PASSWORD_LENGTH) {
    throw new Error(
      `La nueva contraseña debe tener al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres.`
    );
  }

  const client = getSupabaseClient();
  const { error: updateError } = await client.auth.updateUser({
    password: cleanPassword,
    data: { must_change_password: false },
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

  await client.auth.refreshSession().catch(() => {});
}
