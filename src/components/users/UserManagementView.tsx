import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  History,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserCheck,
  UserPlus,
  UserX,
  Users,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  MANAGED_USER_ROLES,
  MANAGED_USER_ROLE_LABELS,
  MIN_SUPABASE_PASSWORD_LENGTH,
  createManagedUser,
  generateSecureInitialPassword,
  listManagedUsers,
  listUserManagementAudit,
  normalizeManagedUserEmail,
  updateManagedUserAccess,
  type ManagedUserProfile,
  type ManagedUserRole,
  type UserManagementAuditEntry,
} from '../../services/userManagementService';

type RoleFilterValue = 'ALL' | ManagedUserRole;
type StatusFilterValue = 'ALL' | 'ACTIVE' | 'SUSPENDED';

interface PendingRoleConfirmation {
  user: ManagedUserProfile;
  nextRole: ManagedUserRole;
}

interface PendingStatusConfirmation {
  user: ManagedUserProfile;
  nextIsActive: boolean;
}

function normalizeSearchToken(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function formatAuditTimestamp(iso: string): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('es-VE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function describeAuditAction(entry: UserManagementAuditEntry): {
  label: string;
  badgeClass: string;
  summary: string;
} {
  const details = entry.details ?? {};
  const prev =
    details.previous && typeof details.previous === 'object'
      ? (details.previous as Record<string, unknown>)
      : null;
  const next =
    details.next && typeof details.next === 'object'
      ? (details.next as Record<string, unknown>)
      : null;

  switch (entry.action) {
    case 'USER_CREATED': {
      const roleKey = String(details.role ?? 'vendedor') as ManagedUserRole;
      const roleLabel = MANAGED_USER_ROLE_LABELS[roleKey] ?? roleKey;
      return {
        label: 'Alta de usuario',
        badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
        summary: `Creado activo con rol ${roleLabel}`,
      };
    }
    case 'USER_SUSPENDED':
      return {
        label: 'Cuenta suspendida',
        badgeClass: 'bg-red-500/15 text-red-300 border-red-500/30',
        summary: 'Estado cambiado de Activo a Suspendido',
      };
    case 'USER_REACTIVATED':
      return {
        label: 'Cuenta reactivada',
        badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
        summary: 'Estado cambiado de Suspendido a Activo',
      };
    case 'USER_ROLE_CHANGED': {
      const prevRole = String(prev?.role ?? '') as ManagedUserRole;
      const nextRole = String(next?.role ?? '') as ManagedUserRole;
      return {
        label: 'Cambio de rol',
        badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
        summary: `${MANAGED_USER_ROLE_LABELS[prevRole] ?? prevRole} → ${MANAGED_USER_ROLE_LABELS[nextRole] ?? nextRole}`,
      };
    }
    default: {
      const changes: string[] = [];
      if (prev && next) {
        if (prev.full_name !== next.full_name) {
          changes.push(`Nombre: "${String(next.full_name ?? '')}"`);
        }
        if (prev.must_change_password !== next.must_change_password) {
          changes.push(
            next.must_change_password
              ? 'Activó pedir cambio de clave'
              : 'Desactivó pedir cambio de clave'
          );
        }
      }
      return {
        label: 'Acceso actualizado',
        badgeClass: 'bg-zinc-800 text-zinc-200 border-white/10',
        summary: changes.length > 0 ? changes.join(' · ') : 'Actualización de parámetros de acceso',
      };
    }
  }
}

function getRoleBadgeStyle(role: ManagedUserRole): string {
  if (role === 'super_admin') {
    return 'bg-red-500/15 text-red-200 border-red-500/35';
  }
  if (role === 'contraloria') {
    return 'bg-cyan-500/15 text-cyan-200 border-cyan-500/35';
  }
  if (role === 'coordinacion') {
    return 'bg-amber-500/15 text-amber-200 border-amber-500/30';
  }
  if (role === 'supervisor') {
    return 'bg-blue-500/15 text-blue-200 border-blue-500/30';
  }
  return 'bg-zinc-800/90 text-zinc-200 border-white/10';
}

export const UserManagementView: React.FC = () => {
  const { currentUser } = useApp();

  const [users, setUsers] = useState<ManagedUserProfile[]>([]);
  const [auditEntries, setAuditEntries] = useState<UserManagementAuditEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<string | null>(null);

  // Filtros instantáneos
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [roleFilter, setRoleFilter] = useState<RoleFilterValue>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('ALL');

  // Edición rápida de nombre completo por fila
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingNameDraft, setEditingNameDraft] = useState<string>('');
  const [busyRowId, setBusyRowId] = useState<string | null>(null);

  // Diálogos de confirmación obligatorios
  const [pendingRoleChange, setPendingRoleChange] = useState<PendingRoleConfirmation | null>(null);
  const [pendingStatusChange, setPendingStatusChange] = useState<PendingStatusConfirmation | null>(
    null
  );
  const [confirmSubmitting, setConfirmSubmitting] = useState<boolean>(false);

  // Modal minimalista de creación rápida
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [createFullName, setCreateFullName] = useState<string>('');
  const [createEmail, setCreateEmail] = useState<string>('');
  const [createPassword, setCreatePassword] = useState<string>('');
  const [showCreatePassword, setShowCreatePassword] = useState<boolean>(false);
  const [createRole, setCreateRole] = useState<ManagedUserRole>('vendedor');
  const [createMustChangePassword, setCreateMustChangePassword] = useState<boolean>(false);
  const [createSubmitting, setCreateSubmitting] = useState<boolean>(false);
  const [createModalError, setCreateModalError] = useState<string | null>(null);
  const [copiedCredentials, setCopiedCredentials] = useState<boolean>(false);

  const loadAllData = useCallback(async (isSilentRefresh = false) => {
    if (isSilentRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setErrorBanner(null);

    try {
      const [profilesList, auditList] = await Promise.all([
        listManagedUsers(),
        listUserManagementAudit(25),
      ]);
      setUsers(profilesList);
      setAuditEntries(auditList);
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'No se pudo cargar la gestión de usuarios.'
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadAllData(false);
  }, [loadAllData]);

  useEffect(() => {
    if (!feedbackBanner) return;
    const timer = window.setTimeout(() => setFeedbackBanner(null), 4200);
    return () => window.clearTimeout(timer);
  }, [feedbackBanner]);

  const summaryCounts = useMemo(() => {
    let superAdmins = 0;
    let contraloria = 0;
    let coordinacion = 0;
    let supervisores = 0;
    let vendedores = 0;
    let suspended = 0;

    for (const u of users) {
      if (u.role === 'super_admin') superAdmins += 1;
      else if (u.role === 'contraloria') contraloria += 1;
      else if (u.role === 'coordinacion') coordinacion += 1;
      else if (u.role === 'supervisor') supervisores += 1;
      else if (u.role === 'vendedor') vendedores += 1;

      if (!u.isActive) suspended += 1;
    }

    return {
      total: users.length,
      superAdmins,
      contraloria,
      coordinacion,
      supervisores,
      vendedores,
      suspended,
    };
  }, [users]);

  const filteredUsers = useMemo(() => {
    const normalizedQuery = normalizeSearchToken(searchQuery);

    return users.filter((row) => {
      if (roleFilter !== 'ALL' && row.role !== roleFilter) {
        return false;
      }
      if (statusFilter === 'ACTIVE' && !row.isActive) {
        return false;
      }
      if (statusFilter === 'SUSPENDED' && row.isActive) {
        return false;
      }
      if (normalizedQuery) {
        const nameMatch = normalizeSearchToken(row.fullName).includes(normalizedQuery);
        const emailMatch = normalizeSearchToken(row.email).includes(normalizedQuery);
        if (!nameMatch && !emailMatch) {
          return false;
        }
      }
      return true;
    });
  }, [users, searchQuery, roleFilter, statusFilter]);

  const startEditingName = (row: ManagedUserProfile) => {
    setEditingUserId(row.id);
    setEditingNameDraft(row.fullName);
    setErrorBanner(null);
  };

  const cancelEditingName = () => {
    setEditingUserId(null);
    setEditingNameDraft('');
  };

  const handleSaveName = async (row: ManagedUserProfile) => {
    const trimmed = editingNameDraft.trim().replace(/\s+/g, ' ');
    if (trimmed === row.fullName) {
      cancelEditingName();
      return;
    }

    setBusyRowId(row.id);
    setErrorBanner(null);
    try {
      const updated = await updateManagedUserAccess({
        targetUserId: row.id,
        fullName: trimmed,
        role: row.role,
        isActive: row.isActive,
        mustChangePassword: row.mustChangePassword,
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      cancelEditingName();
      setFeedbackBanner(`Nombre actualizado para ${updated.email}.`);
      const latestAudit = await listUserManagementAudit(25).catch(() => null);
      if (latestAudit) setAuditEntries(latestAudit);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'No se pudo actualizar el nombre.');
    } finally {
      setBusyRowId(null);
    }
  };

  const handleConfirmRoleChange = async () => {
    if (!pendingRoleChange || confirmSubmitting) return;
    const { user, nextRole } = pendingRoleChange;

    setConfirmSubmitting(true);
    setBusyRowId(user.id);
    setErrorBanner(null);

    try {
      const updated = await updateManagedUserAccess({
        targetUserId: user.id,
        fullName: user.fullName,
        role: nextRole,
        isActive: user.isActive,
        mustChangePassword: user.mustChangePassword,
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setPendingRoleChange(null);
      setFeedbackBanner(
        `Rol de ${updated.fullName} actualizado a ${MANAGED_USER_ROLE_LABELS[updated.role]}.`
      );
      const latestAudit = await listUserManagementAudit(25).catch(() => null);
      if (latestAudit) setAuditEntries(latestAudit);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'No se pudo cambiar el rol.');
      setPendingRoleChange(null);
    } finally {
      setConfirmSubmitting(false);
      setBusyRowId(null);
    }
  };

  const handleConfirmStatusChange = async () => {
    if (!pendingStatusChange || confirmSubmitting) return;
    const { user, nextIsActive } = pendingStatusChange;

    setConfirmSubmitting(true);
    setBusyRowId(user.id);
    setErrorBanner(null);

    try {
      const updated = await updateManagedUserAccess({
        targetUserId: user.id,
        fullName: user.fullName,
        role: user.role,
        isActive: nextIsActive,
        mustChangePassword: user.mustChangePassword,
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setPendingStatusChange(null);
      setFeedbackBanner(
        updated.isActive
          ? `Acceso reactivado para ${updated.fullName}.`
          : `Cuenta suspendida inmediatamente para ${updated.fullName}.`
      );
      const latestAudit = await listUserManagementAudit(25).catch(() => null);
      if (latestAudit) setAuditEntries(latestAudit);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'No se pudo cambiar el estado.');
      setPendingStatusChange(null);
    } finally {
      setConfirmSubmitting(false);
      setBusyRowId(null);
    }
  };

  const handleToggleMustChangePassword = async (row: ManagedUserProfile) => {
    const nextValue = !row.mustChangePassword;
    setBusyRowId(row.id);
    setErrorBanner(null);

    try {
      const updated = await updateManagedUserAccess({
        targetUserId: row.id,
        fullName: row.fullName,
        role: row.role,
        isActive: row.isActive,
        mustChangePassword: nextValue,
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setFeedbackBanner(
        updated.mustChangePassword
          ? `Se solicitará cambio de clave al iniciar sesión a ${updated.fullName}.`
          : `Se desactivó la solicitud de cambio de clave para ${updated.fullName}.`
      );
      const latestAudit = await listUserManagementAudit(25).catch(() => null);
      if (latestAudit) setAuditEntries(latestAudit);
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'No se pudo actualizar la preferencia de contraseña.'
      );
    } finally {
      setBusyRowId(null);
    }
  };

  const resetCreateModal = () => {
    setCreateFullName('');
    setCreateEmail('');
    setCreatePassword('');
    setShowCreatePassword(false);
    setCreateRole('vendedor');
    setCreateMustChangePassword(false);
    setCreateModalError(null);
    setCopiedCredentials(false);
  };

  const handleGenerateSecurePassword = () => {
    const generated = generateSecureInitialPassword(12);
    setCreatePassword(generated);
    setShowCreatePassword(true);
    setCreateModalError(null);
    setCopiedCredentials(false);
  };

  const handleCopyCredentials = async () => {
    const normalizedEmail = normalizeManagedUserEmail(createEmail);
    setCreateEmail(normalizedEmail);

    if (!normalizedEmail) {
      setCreateModalError('Ingresa primero el correo electrónico antes de copiar los accesos.');
      return;
    }
    if (createPassword.trim().length === 0 || createPassword.length < MIN_SUPABASE_PASSWORD_LENGTH) {
      setCreateModalError(
        `Ingresa o genera una contraseña de al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres antes de copiar.`
      );
      return;
    }

    setCreateModalError(null);
    const shareText = [
      'CODIZULCA C.A. — Accesos Corporativos',
      `Correo: ${normalizedEmail}`,
      `Contraseña inicial: ${createPassword}`,
    ].join('\n');

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareText);
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    }

    setCopiedCredentials(true);
    window.setTimeout(() => setCopiedCredentials(false), 2600);
  };

  const handleCreateUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createSubmitting) return;
    setCreateModalError(null);

    const normalizedEmail = normalizeManagedUserEmail(createEmail);
    setCreateEmail(normalizedEmail);

    if (createFullName.trim().length < 2) {
      setCreateModalError('El nombre completo es obligatorio (mínimo 2 caracteres).');
      return;
    }
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
      setCreateModalError('Ingresa un correo electrónico corporativo válido.');
      return;
    }
    if (createPassword.trim().length === 0 || createPassword.length < MIN_SUPABASE_PASSWORD_LENGTH) {
      setCreateModalError(
        `La contraseña inicial es demasiado corta: debe tener al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres.`
      );
      return;
    }

    setCreateSubmitting(true);

    try {
      const created = await createManagedUser({
        fullName: createFullName,
        email: normalizedEmail,
        password: createPassword,
        role: createRole,
        mustChangePassword: createMustChangePassword,
      });

      setIsCreateModalOpen(false);
      resetCreateModal();
      setFeedbackBanner(
        `Usuario ${created.fullName} (${created.email}) creado y activado de inmediato.`
      );
      await loadAllData(true);
    } catch (err) {
      setCreateModalError(
        err instanceof Error ? err.message : 'No se pudo registrar el nuevo usuario.'
      );
    } finally {
      setCreateSubmitting(false);
    }
  };

  const hasActiveFilters =
    searchQuery.trim().length > 0 || roleFilter !== 'ALL' || statusFilter !== 'ALL';

  return (
    <div className="space-y-5" data-testid="user-management-view">
      {/* Cabecera Ejecutiva */}
      <div className="rounded-2xl bg-zinc-950/90 border border-white/[0.08] p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight">
                Gestión de Usuarios
              </h2>
              <span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded-md bg-red-500/15 text-red-300 border border-red-500/25">
                Exclusivo Super Admin
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Control centralizado de identidad, roles corporativos y acceso inmediato sin fricción.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => void loadAllData(true)}
            disabled={loading || refreshing}
            className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 inline-flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-red-400' : ''}`} />
            <span>Actualizar</span>
          </button>

          <button
            type="button"
            data-testid="btn-new-user"
            onClick={() => {
              resetCreateModal();
              setIsCreateModalOpen(true);
            }}
            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-bold text-white inline-flex items-center gap-1.5 shadow-sm transition cursor-pointer"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>+ Nuevo Usuario</span>
          </button>
        </div>
      </div>

      {/* Mensajes de estado */}
      {errorBanner && (
        <div
          role="alert"
          className="rounded-xl bg-red-950/50 border border-red-500/35 px-4 py-3 flex items-center justify-between gap-3 text-xs text-red-200"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="p-1 rounded-lg hover:bg-white/10 text-red-200 cursor-pointer"
            aria-label="Cerrar alerta"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {feedbackBanner && (
        <div
          role="status"
          className="rounded-xl bg-emerald-950/40 border border-emerald-500/30 px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-emerald-200"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{feedbackBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedbackBanner(null)}
            className="p-1 rounded-lg hover:bg-white/10 text-emerald-200 cursor-pointer"
            aria-label="Cerrar confirmación"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 1. Tarjetas Compactas de Resumen */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-xl bg-zinc-950/90 border border-white/[0.07] px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-zinc-400">Total</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {summaryCounts.total}
            </p>
          </div>
          <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 flex items-center justify-center">
            <Users className="w-4 h-4 text-zinc-300" />
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950/90 border border-red-500/20 px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-red-300/90">Admin General</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {summaryCounts.superAdmins}
            </p>
          </div>
          <div className="w-8 h-8 rounded-lg bg-red-500/15 border border-red-500/25 flex items-center justify-center">
            <Shield className="w-4 h-4 text-red-400" />
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950/90 border border-cyan-500/20 px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-cyan-300/90">Contraloría</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {summaryCounts.contraloria}
            </p>
          </div>
          <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/25 flex items-center justify-center">
            <ShieldCheck className="w-4 h-4 text-cyan-300" />
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950/90 border border-amber-500/20 px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-amber-300/90">Coordinación / Sup.</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {summaryCounts.coordinacion + summaryCounts.supervisores}
            </p>
          </div>
          <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center">
            <UserCheck className="w-4 h-4 text-amber-300" />
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950/90 border border-white/[0.07] px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-zinc-400">Vendedores</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {summaryCounts.vendedores}
            </p>
          </div>
          <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 flex items-center justify-center">
            <Users className="w-4 h-4 text-zinc-400" />
          </div>
        </div>

        <div className="rounded-xl bg-zinc-950/90 border border-white/[0.07] px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-zinc-400">Suspendidos</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {summaryCounts.suspended}
            </p>
          </div>
          <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 flex items-center justify-center">
            <UserX className="w-4 h-4 text-red-400" />
          </div>
        </div>
      </div>

      {/* Barra de Búsqueda Instantánea + Filtros por Rol y Estado */}
      <div className="rounded-2xl bg-zinc-950/90 border border-white/[0.08] p-3.5 flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por nombre completo o correo electrónico..."
            aria-label="Buscar usuarios por nombre o correo"
            className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as RoleFilterValue)}
            aria-label="Filtrar por rol"
            className="px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-red-500 cursor-pointer"
          >
            <option value="ALL">Todos los roles</option>
            {MANAGED_USER_ROLES.map((roleOpt) => (
              <option key={roleOpt} value={roleOpt}>
                {MANAGED_USER_ROLE_LABELS[roleOpt]} ({roleOpt})
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilterValue)}
            aria-label="Filtrar por estado"
            className="px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-red-500 cursor-pointer"
          >
            <option value="ALL">Todos los estados</option>
            <option value="ACTIVE">Activos</option>
            <option value="SUSPENDED">Suspendidos</option>
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setRoleFilter('ALL');
                setStatusFilter('ALL');
              }}
              className="px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-300 cursor-pointer"
            >
              Limpiar
            </button>
          )}
        </div>
      </div>

      {/* 2. Tabla Minimalista Estricta (5 Columnas Exactas) */}
      <div className="rounded-2xl bg-zinc-950/90 border border-white/[0.08] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                <th className="py-3.5 px-4">Nombre completo</th>
                <th className="py-3.5 px-4">Correo electrónico</th>
                <th className="py-3.5 px-4">Rol</th>
                <th className="py-3.5 px-4">Estado</th>
                <th className="py-3.5 px-4 text-right">Pedir cambio de clave al iniciar</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-white/[0.06] text-xs">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-14 text-center text-zinc-400">
                    <span className="inline-flex items-center gap-2 font-mono">
                      <Loader2 className="w-4 h-4 text-red-500 animate-spin" />
                      Cargando directorio de usuarios...
                    </span>
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-zinc-400">
                    No se encontraron usuarios que coincidan con los filtros actuales.
                  </td>
                </tr>
              ) : (
                filteredUsers.map((row) => {
                  const isSelfRow = Boolean(currentUser?.id && currentUser.id === row.id);
                  const isEditingThisRow = editingUserId === row.id;
                  const isRowBusy = busyRowId === row.id;

                  return (
                    <tr
                      key={row.id}
                      data-testid={`user-row-${row.email}`}
                      className={`transition-colors ${
                        isSelfRow
                          ? 'bg-red-950/10 hover:bg-red-950/15'
                          : 'hover:bg-white/[0.025]'
                      }`}
                    >
                      {/* Columna 1: Nombre completo + edición rápida + etiqueta cuenta protegida */}
                      <td className="py-3.5 px-4 align-middle">
                        {isEditingThisRow ? (
                          <div className="flex items-center gap-1.5 max-w-xs">
                            <input
                              type="text"
                              value={editingNameDraft}
                              onChange={(e) => setEditingNameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleSaveName(row);
                                if (e.key === 'Escape') cancelEditingName();
                              }}
                              autoFocus
                              maxLength={160}
                              aria-label={`Editar nombre completo de ${row.email}`}
                              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-black border border-red-500/60 text-xs text-white focus:outline-none"
                            />
                            <button
                              type="button"
                              disabled={isRowBusy}
                              onClick={() => void handleSaveName(row)}
                              title="Guardar nombre"
                              className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={isRowBusy}
                              onClick={cancelEditingName}
                              title="Cancelar edición"
                              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-white">{row.fullName}</span>
                            <button
                              type="button"
                              disabled={isRowBusy}
                              onClick={() => startEditingName(row)}
                              title={`Editar nombre completo de ${row.fullName}`}
                              aria-label={`Editar nombre completo de ${row.fullName}`}
                              className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition cursor-pointer disabled:opacity-40"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            {isSelfRow && (
                              <span
                                data-testid="self-protected-badge"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/35 text-[10px] font-bold text-red-200"
                              >
                                <ShieldAlert className="w-3 h-3 text-red-400" />
                                Cuenta actual protegida
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Columna 2: Correo electrónico */}
                      <td className="py-3.5 px-4 align-middle font-mono text-zinc-300">
                        {row.email}
                      </td>

                      {/* Columna 3: Selector de Rol con confirmación previa */}
                      <td className="py-3.5 px-4 align-middle">
                        <select
                          value={row.role}
                          disabled={isSelfRow || isRowBusy}
                          aria-label={`Rol de ${row.fullName}`}
                          onChange={(e) => {
                            const nextRole = e.target.value as ManagedUserRole;
                            if (nextRole !== row.role) {
                              setPendingRoleChange({ user: row, nextRole });
                            }
                          }}
                          className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold focus:outline-none transition ${getRoleBadgeStyle(
                            row.role
                          )} ${
                            isSelfRow || isRowBusy
                              ? 'opacity-60 cursor-not-allowed'
                              : 'cursor-pointer hover:border-white/25'
                          }`}
                        >
                          {MANAGED_USER_ROLES.map((roleOpt) => (
                            <option
                              key={roleOpt}
                              value={roleOpt}
                              className="bg-zinc-950 text-white"
                            >
                              {MANAGED_USER_ROLE_LABELS[roleOpt]} ({roleOpt})
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Columna 4: Estado (Activo / Suspendido) + acción con confirmación */}
                      <td className="py-3.5 px-4 align-middle">
                        <div className="inline-flex items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                              row.isActive
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                row.isActive ? 'bg-emerald-400' : 'bg-zinc-500'
                              }`}
                            />
                            {row.isActive ? 'Activo' : 'Suspendido'}
                          </span>

                          <button
                            type="button"
                            disabled={isSelfRow || isRowBusy}
                            onClick={() =>
                              setPendingStatusChange({
                                user: row,
                                nextIsActive: !row.isActive,
                              })
                            }
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition ${
                              isSelfRow || isRowBusy
                                ? 'bg-zinc-900/60 border-white/5 text-zinc-500 cursor-not-allowed'
                                : row.isActive
                                  ? 'bg-zinc-900 hover:bg-red-950/60 border-white/10 hover:border-red-500/40 text-zinc-300 hover:text-red-200 cursor-pointer'
                                  : 'bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/35 text-emerald-200 cursor-pointer'
                            }`}
                          >
                            {row.isActive ? 'Suspender' : 'Activar'}
                          </button>
                        </div>
                      </td>

                      {/* Columna 5: Interruptor opcional must_change_password */}
                      <td className="py-3.5 px-4 align-middle text-right">
                        <div className="inline-flex items-center justify-end gap-2">
                          <span className="text-[11px] text-zinc-400">
                            {row.mustChangePassword ? 'Sí' : 'No'}
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={row.mustChangePassword}
                            aria-label={`Pedir cambio de clave al iniciar para ${row.fullName}`}
                            disabled={isRowBusy}
                            onClick={() => void handleToggleMustChangePassword(row)}
                            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition cursor-pointer disabled:opacity-50 ${
                              row.mustChangePassword
                                ? 'bg-red-600 border-red-500'
                                : 'bg-zinc-800 border-white/10'
                            }`}
                          >
                            <span
                              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${
                                row.mustChangePassword ? 'translate-x-4' : 'translate-x-0.5'
                              }`}
                            />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. Panel Compacto Inferior: Historial Reciente (public.user_management_audit) */}
      <div className="rounded-2xl bg-zinc-950/90 border border-white/[0.08] p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-red-400" />
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-200">
              Historial Reciente de Auditoría IAM
            </h3>
          </div>
          <span className="text-[11px] font-mono text-zinc-500">
            Últimos {auditEntries.length} eventos
          </span>
        </div>

        {auditEntries.length === 0 ? (
          <p className="text-xs text-zinc-500 py-3">
            Aún no hay movimientos registrados en la bitácora de auditoría.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.05] max-h-60 overflow-y-auto pr-1">
            {auditEntries.map((entry) => {
              const info = describeAuditAction(entry);
              return (
                <div
                  key={entry.id}
                  className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span
                      className={`px-2 py-0.5 rounded-md border text-[10px] font-bold ${info.badgeClass}`}
                    >
                      {info.label}
                    </span>
                    <span className="font-mono text-zinc-200 truncate">{entry.targetEmail}</span>
                    <span className="text-zinc-500 hidden sm:inline">·</span>
                    <span className="text-zinc-400">{info.summary}</span>
                  </div>

                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-500 shrink-0">
                    <Clock className="w-3 h-3" />
                    {formatAuditTimestamp(entry.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal: Confirmación de Cambio de Rol */}
      {typeof document !== 'undefined' &&
        pendingRoleChange &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-role-title"
              className="w-full max-w-md rounded-2xl bg-zinc-950 border border-white/10 p-6 shadow-2xl space-y-4"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <Shield className="w-5 h-5 text-amber-300" />
                </div>
                <div>
                  <h3 id="confirm-role-title" className="text-sm font-extrabold text-white">
                    Confirmar cambio de rol
                  </h3>
                  <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                    Vas a modificar los privilegios de{' '}
                    <strong className="text-white">{pendingRoleChange.user.fullName}</strong> (
                    <span className="font-mono">{pendingRoleChange.user.email}</span>):
                  </p>
                </div>
              </div>

              <div className="rounded-xl bg-black/70 border border-white/10 px-3.5 py-2.5 text-xs flex items-center justify-between">
                <span className="text-zinc-400">
                  {MANAGED_USER_ROLE_LABELS[pendingRoleChange.user.role]}
                </span>
                <span className="text-red-400 font-bold">→</span>
                <span className="font-bold text-white">
                  {MANAGED_USER_ROLE_LABELS[pendingRoleChange.nextRole]}
                </span>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={confirmSubmitting}
                  onClick={() => setPendingRoleChange(null)}
                  className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={confirmSubmitting}
                  onClick={() => void handleConfirmRoleChange()}
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-bold text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {confirmSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Confirmar cambio</span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Modal: Confirmación de Suspensión / Reactivación */}
      {typeof document !== 'undefined' &&
        pendingStatusChange &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-status-title"
              className="w-full max-w-md rounded-2xl bg-zinc-950 border border-white/10 p-6 shadow-2xl space-y-4"
            >
              <div className="flex items-start gap-3">
                <div
                  className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                    pendingStatusChange.nextIsActive
                      ? 'bg-emerald-500/15 border-emerald-500/30'
                      : 'bg-red-500/15 border-red-500/30'
                  }`}
                >
                  {pendingStatusChange.nextIsActive ? (
                    <UserCheck className="w-5 h-5 text-emerald-300" />
                  ) : (
                    <UserX className="w-5 h-5 text-red-400" />
                  )}
                </div>
                <div>
                  <h3 id="confirm-status-title" className="text-sm font-extrabold text-white">
                    {pendingStatusChange.nextIsActive
                      ? 'Confirmar reactivación de usuario'
                      : 'Confirmar suspensión de usuario'}
                  </h3>
                  <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                    {pendingStatusChange.nextIsActive ? (
                      <>
                        El usuario{' '}
                        <strong className="text-white">{pendingStatusChange.user.fullName}</strong>{' '}
                        recuperará de inmediato el acceso activo con su rol{' '}
                        <strong>{MANAGED_USER_ROLE_LABELS[pendingStatusChange.user.role]}</strong>.
                      </>
                    ) : (
                      <>
                        El usuario{' '}
                        <strong className="text-white">{pendingStatusChange.user.fullName}</strong>{' '}
                        (<span className="font-mono">{pendingStatusChange.user.email}</span>) será
                        suspendido de inmediato y no podrá iniciar sesión ni operar en el sistema.
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={confirmSubmitting}
                  onClick={() => setPendingStatusChange(null)}
                  className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={confirmSubmitting}
                  onClick={() => void handleConfirmStatusChange()}
                  className={`px-4 py-2 rounded-xl text-xs font-bold text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                    pendingStatusChange.nextIsActive
                      ? 'bg-emerald-600 hover:bg-emerald-500'
                      : 'bg-red-600 hover:bg-red-500'
                  }`}
                >
                  {confirmSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>
                    {pendingStatusChange.nextIsActive ? 'Sí, activar cuenta' : 'Sí, suspender cuenta'}
                  </span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Modal Minimalista: Nuevo Usuario (Acceso Inmediato sin Fricción) */}
      {typeof document !== 'undefined' &&
        isCreateModalOpen &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-user-title"
              className="w-full max-w-md rounded-2xl bg-zinc-950 border border-white/10 p-6 shadow-2xl space-y-4"
            >
              <div className="flex items-center justify-between border-b border-white/[0.07] pb-3.5">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center">
                    <Plus className="w-4 h-4 text-red-400" />
                  </div>
                  <div>
                    <h3 id="create-user-title" className="text-sm font-extrabold text-white">
                      Nuevo Usuario Corporativo
                    </h3>
                    <p className="text-[11px] text-zinc-400">
                      Quedará activo y confirmado de inmediato.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
                  aria-label="Cerrar modal"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {createModalError && (
                <div
                  role="alert"
                  data-testid="create-user-error"
                  className="rounded-xl bg-red-950/50 border border-red-500/35 px-3.5 py-2.5 text-xs text-red-200 flex items-center gap-2"
                >
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{createModalError}</span>
                </div>
              )}

              <form onSubmit={handleCreateUserSubmit} noValidate className="space-y-3.5">
                {/* 1. Nombre completo */}
                <div>
                  <label
                    htmlFor="create-user-fullname"
                    className="block text-xs font-bold text-zinc-300 mb-1"
                  >
                    Nombre completo
                  </label>
                  <input
                    id="create-user-fullname"
                    type="text"
                    required
                    maxLength={160}
                    value={createFullName}
                    onChange={(e) => setCreateFullName(e.target.value)}
                    placeholder="Ej. María Fernanda Gómez"
                    className="w-full px-3.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500"
                  />
                </div>

                {/* 2. Correo electrónico (siempre normalizado .trim().toLowerCase()) */}
                <div>
                  <label
                    htmlFor="create-user-email"
                    className="block text-xs font-bold text-zinc-300 mb-1"
                  >
                    Correo electrónico
                  </label>
                  <input
                    id="create-user-email"
                    type="email"
                    required
                    value={createEmail}
                    onChange={(e) => {
                      setCreateEmail(e.target.value);
                      setCopiedCredentials(false);
                    }}
                    onBlur={() => setCreateEmail((prev) => normalizeManagedUserEmail(prev))}
                    placeholder="usuario@codizulca.com"
                    className="w-full px-3.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-500"
                  />
                </div>

                {/* 3. Rol inicial (por defecto 'vendedor') */}
                <div>
                  <label
                    htmlFor="create-user-role"
                    className="block text-xs font-bold text-zinc-300 mb-1"
                  >
                    Rol inicial
                  </label>
                  <select
                    id="create-user-role"
                    value={createRole}
                    onChange={(e) => setCreateRole(e.target.value as ManagedUserRole)}
                    className="w-full px-3.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer"
                  >
                    {MANAGED_USER_ROLES.map((roleOpt) => (
                      <option key={roleOpt} value={roleOpt}>
                        {MANAGED_USER_ROLE_LABELS[roleOpt]} ({roleOpt})
                      </option>
                    ))}
                  </select>
                </div>

                {/* 4. Contraseña inicial (>= 6 caracteres + Generar clave segura + Copiar accesos) */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="create-user-password"
                      className="block text-xs font-bold text-zinc-300"
                    >
                      Contraseña inicial
                    </label>
                    <span className="text-[10px] font-mono text-zinc-500">
                      Mínimo {MIN_SUPABASE_PASSWORD_LENGTH} caracteres
                    </span>
                  </div>

                  <div className="relative">
                    <KeyRound className="w-3.5 h-3.5 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="create-user-password"
                      type={showCreatePassword ? 'text' : 'password'}
                      required
                      minLength={MIN_SUPABASE_PASSWORD_LENGTH}
                      autoComplete="new-password"
                      value={createPassword}
                      onChange={(e) => {
                        setCreatePassword(e.target.value);
                        setCopiedCredentials(false);
                      }}
                      placeholder={`Mínimo ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres`}
                      className="w-full pl-9 pr-9 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCreatePassword((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white cursor-pointer"
                      aria-label={
                        showCreatePassword ? 'Ocultar contraseña' : 'Mostrar contraseña'
                      }
                    >
                      {showCreatePassword ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid="btn-generate-password"
                      onClick={handleGenerateSecurePassword}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-[11px] font-semibold text-zinc-200 inline-flex items-center justify-center gap-1.5 transition cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-red-400" />
                      <span>Generar clave segura</span>
                    </button>

                    <button
                      type="button"
                      data-testid="btn-copy-credentials"
                      onClick={() => void handleCopyCredentials()}
                      className={`flex-1 px-3 py-1.5 rounded-lg border text-[11px] font-semibold inline-flex items-center justify-center gap-1.5 transition cursor-pointer ${
                        copiedCredentials
                          ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200'
                          : 'bg-zinc-900 hover:bg-zinc-800 border-white/10 text-zinc-200'
                      }`}
                    >
                      {copiedCredentials ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span>¡Accesos copiados!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-zinc-400" />
                          <span>Copiar accesos</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* 5. Casilla opcional (desmarcada false por defecto) */}
                <label className="flex items-start justify-between gap-3 rounded-xl bg-black/60 border border-white/[0.07] px-3.5 py-2.5 cursor-pointer">
                  <span className="text-xs text-zinc-300 leading-snug">
                    Solicitar cambio de contraseña en el primer inicio de sesión
                  </span>
                  <input
                    id="create-user-must-change-password"
                    type="checkbox"
                    checked={createMustChangePassword}
                    onChange={(e) => setCreateMustChangePassword(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-red-600 cursor-pointer"
                  />
                </label>

                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    disabled={createSubmitting}
                    onClick={() => setIsCreateModalOpen(false)}
                    className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    data-testid="btn-submit-create-user"
                    disabled={createSubmitting}
                    className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-bold text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {createSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>Crear y activar</span>
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export const UserManagementPage = UserManagementView;
