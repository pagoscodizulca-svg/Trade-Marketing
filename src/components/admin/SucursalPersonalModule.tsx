import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { provisionStaffAuthAccountViaBackend } from '../../services/authService';
import { getSupabaseClient, isSupabaseConfigured } from '../../services/supabaseClient';
import {
  MANAGED_USER_ROLE_LABELS,
  MIN_SUPABASE_PASSWORD_LENGTH,
  OPERATIVE_SUCURSALES,
  SUCURSAL_LABELS,
  generateSecureInitialPassword,
  isOperativeSucursal,
  normalizeManagedUserEmail,
  normalizeManagedUserRole,
  normalizeSucursalCodigo,
  type ManagedUserRole,
  type OperativeSucursal,
  type SucursalCodigo,
} from '../../services/userManagementService';
import {
  ClientePortalAccesosManager,
  type ClientePortalAccesoRecord,
  type PortalCadenaOption,
  type PortalClientePdvOption,
  type PortalClienteUserOption,
} from './ClientePortalAccesosManager';
import { PortalQuickLinksBar } from './PortalQuickLinksBar';
import { AnimatedTabContainer } from '../ui/AnimatedTabContainer';
import {
  PROMOTORA_CATEGORIAS,
  classifyPromotoraCategoriaOficial,
  computePromotorasCategoryStats,
  formatPromotoraRoleForCategory,
  type PromotoraCategoriaOficial,
} from '../../utils/regionalSyncClassifier';

export interface RegionActivaItem {
  id: string;
  codigo: OperativeSucursal;
  nombre: string;
  activo: boolean;
}

export interface SucursalStaffMemberRow {
  id: string;
  name: string;
  role: string;
  email: string;
  status: string;
  categoria?: PromotoraCategoriaOficial | string | null;
  auth_user_id?: string | null;
  sucursal?: OperativeSucursal | string | null;
  region_id?: string | null;
}

export interface SucursalCorporateProfileRow {
  id: string;
  email: string;
  full_name?: string;
  fullName?: string;
  role: ManagedUserRole | string;
  sucursal?: SucursalCodigo | string | null;
  region_id?: string | null;
  is_active?: boolean;
  isActive?: boolean;
}

export interface SucursalPersonalBundle {
  sucursal?: OperativeSucursal | string;
  region_id?: string | null;
  profiles?: SucursalCorporateProfileRow[];
  staff?: SucursalStaffMemberRow[];
  clientes?: PortalClientePdvOption[];
  cadenas?: PortalCadenaOption[];
  portal_accesos?: ClientePortalAccesoRecord[];
}

export interface SucursalPersonalModuleProps {
  regiones?: RegionActivaItem[];
  lockedSucursal?: OperativeSucursal | null;
  selectedSucursal?: OperativeSucursal | null;
  onSelectSucursal?: (sucursal: OperativeSucursal) => void;
  viewerIamRole?: ManagedUserRole | null;
  initialBundle?: SucursalPersonalBundle | null;
  customClient?: SupabaseClient;
}

export const FALLBACK_OFFICIAL_REGIONES: ReadonlyArray<RegionActivaItem> = [
  { id: 'hub-zulia', codigo: 'ZULIA', nombre: 'Zulia', activo: true },
  { id: 'hub-valencia', codigo: 'VALENCIA', nombre: 'Valencia', activo: true },
  { id: 'hub-centro', codigo: 'CENTRO', nombre: 'Centro', activo: true },
  { id: 'hub-oriente', codigo: 'ORIENTE', nombre: 'Oriente', activo: true },
  { id: 'hub-capital', codigo: 'CAPITAL', nombre: 'Capital', activo: true },
];

export const SUCURSAL_PERSONAL_MODULE_TITLES: Record<OperativeSucursal, string> = {
  ZULIA: 'Módulo Personal Zulia',
  VALENCIA: 'Módulo Personal Valencia',
  CENTRO: 'Módulo Personal Centro',
  ORIENTE: 'Módulo Personal Oriente',
  CAPITAL: 'Módulo Personal Capital',
};

function useOptionalApp() {
  try {
    return useApp();
  } catch {
    return null;
  }
}

function normalizeRegionesList(rawList: unknown): RegionActivaItem[] {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return [...FALLBACK_OFFICIAL_REGIONES];
  }

  const byHub = new Map<OperativeSucursal, RegionActivaItem>();
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    if (rec.activo === false) continue;
    const normalizedCode =
      normalizeSucursalCodigo(rec.codigo) ?? normalizeSucursalCodigo(rec.nombre);
    if (!normalizedCode || !isOperativeSucursal(normalizedCode)) continue;
    const fallbackName =
      FALLBACK_OFFICIAL_REGIONES.find((f) => f.codigo === normalizedCode)?.nombre ??
      normalizedCode;
    byHub.set(normalizedCode, {
      id: String(rec.id || `hub-${normalizedCode.toLowerCase()}`),
      codigo: normalizedCode,
      nombre: String(rec.nombre || fallbackName).trim() || fallbackName,
      activo: true,
    });
  }

  // Asegurar orden canónico de las 5 regiones oficiales
  const ordered: RegionActivaItem[] = [];
  for (const fallback of FALLBACK_OFFICIAL_REGIONES) {
    ordered.push(byHub.get(fallback.codigo) ?? fallback);
  }
  return ordered;
}

function parseStaffStatus(rawStatus: unknown): 'Activo' | 'Inactivo' {
  const str = String(rawStatus ?? 'Activo').trim();
  if (!str) return 'Activo';
  if (str.startsWith('{')) {
    try {
      const parsed = JSON.parse(str) as { status?: unknown };
      return String(parsed.status ?? 'Activo').trim().toLowerCase() === 'inactivo'
        ? 'Inactivo'
        : 'Activo';
    } catch {
      return 'Activo';
    }
  }
  return str.toLowerCase() === 'inactivo' ? 'Inactivo' : 'Activo';
}

function matchesHubStrict(rawSucursal: unknown, hub: OperativeSucursal): boolean {
  if (rawSucursal === undefined || rawSucursal === null || String(rawSucursal).trim() === '') {
    return true;
  }
  return normalizeSucursalCodigo(rawSucursal) === hub;
}

function normalizeScopedBundle(
  raw: SucursalPersonalBundle | null | undefined,
  hub: OperativeSucursal
): Required<Omit<SucursalPersonalBundle, 'sucursal'>> & { sucursal: OperativeSucursal } {
  const profiles = (raw?.profiles ?? []).filter((p) => matchesHubStrict(p.sucursal, hub));
  const staff = (raw?.staff ?? []).filter((s) => matchesHubStrict(s.sucursal, hub));
  const clientes = (raw?.clientes ?? []).filter(
    (c) => matchesHubStrict(c.sucursal, hub) && c.activo !== false
  );
  const cadenas = (raw?.cadenas ?? []).filter(
    (cad) => matchesHubStrict(cad.sucursal, hub) && cad.activo !== false
  );
  const portal_accesos = (raw?.portal_accesos ?? []).filter((acc) =>
    matchesHubStrict(acc.sucursal, hub)
  );

  return {
    sucursal: hub,
    region_id: raw?.region_id ? String(raw.region_id) : null,
    profiles,
    staff,
    clientes,
    cadenas,
    portal_accesos,
  };
}

export const SucursalPersonalModule: React.FC<SucursalPersonalModuleProps> = ({
  regiones: controlledRegiones,
  lockedSucursal: propLockedSucursal,
  selectedSucursal: controlledSelectedSucursal,
  onSelectSucursal,
  viewerIamRole: propViewerIamRole,
  initialBundle,
  customClient,
}) => {
  const app = useOptionalApp();

  const effectiveIamRole: ManagedUserRole | null =
    propViewerIamRole ?? app?.verifiedIamRole ?? null;

  const effectiveAppActiveSucursal: OperativeSucursal | null = useMemo(() => {
    const dynamicActive = (
      app as unknown as { activeSucursal?: OperativeSucursal | null } | null
    )?.activeSucursal;
    if (isOperativeSucursal(dynamicActive)) return dynamicActive;
    if (isOperativeSucursal(app?.verifiedSucursal)) return app.verifiedSucursal;
    return null;
  }, [app]);

  // Coordinadora queda estrictamente bloqueada a su única sucursal asignada
  const effectiveLockedSucursal: OperativeSucursal | null = useMemo(() => {
    if (isOperativeSucursal(propLockedSucursal)) return propLockedSucursal;
    if (effectiveIamRole === 'coordinacion') {
      if (isOperativeSucursal(app?.verifiedSucursal)) return app.verifiedSucursal;
      if (effectiveAppActiveSucursal) return effectiveAppActiveSucursal;
    }
    return null;
  }, [app?.verifiedSucursal, effectiveAppActiveSucursal, effectiveIamRole, propLockedSucursal]);

  const isCoordinatorWithoutBranch =
    effectiveIamRole === 'coordinacion' && !effectiveLockedSucursal;

  const isHubLocked = Boolean(effectiveLockedSucursal);

  const [regiones, setRegiones] = useState<RegionActivaItem[]>(() =>
    normalizeRegionesList(controlledRegiones)
  );

  const [internalSelectedHub, setInternalSelectedHub] = useState<OperativeSucursal>(() => {
    if (effectiveLockedSucursal) return effectiveLockedSucursal;
    if (isOperativeSucursal(controlledSelectedSucursal)) return controlledSelectedSucursal;
    if (effectiveAppActiveSucursal) return effectiveAppActiveSucursal;
    const initialHub = normalizeSucursalCodigo(initialBundle?.sucursal);
    if (isOperativeSucursal(initialHub)) return initialHub;
    return 'ZULIA';
  });

  // Sincronizar hub activo cuando cambia el selector global de región de Torre de Control
  useEffect(() => {
    if (effectiveLockedSucursal) {
      setInternalSelectedHub(effectiveLockedSucursal);
      return;
    }
    if (isOperativeSucursal(controlledSelectedSucursal)) {
      setInternalSelectedHub(controlledSelectedSucursal);
      return;
    }
    if (effectiveAppActiveSucursal) {
      setInternalSelectedHub(effectiveAppActiveSucursal);
    }
  }, [controlledSelectedSucursal, effectiveAppActiveSucursal, effectiveLockedSucursal]);

  useEffect(() => {
    if (controlledRegiones) {
      setRegiones(normalizeRegionesList(controlledRegiones));
      return;
    }
    if (!customClient && !isSupabaseConfigured) return;

    let active = true;
    const client = customClient ?? getSupabaseClient();
    void Promise.resolve(client.rpc('rpc_listar_regiones_activas'))
      .then(({ data, error }) => {
        if (!active || error || !Array.isArray(data)) return;
        setRegiones(normalizeRegionesList(data));
      })
      .catch(() => {
        // Conserva las 5 regiones oficiales de respaldo
      });

    return () => {
      active = false;
    };
  }, [controlledRegiones, customClient]);

  const activeHub: OperativeSucursal = effectiveLockedSucursal ?? internalSelectedHub;
  const activeRegionMeta = useMemo(
    () =>
      regiones.find((r) => r.codigo === activeHub) ??
      FALLBACK_OFFICIAL_REGIONES.find((r) => r.codigo === activeHub)!,
    [activeHub, regiones]
  );

  const scopedInitialBundle = useMemo(
    () => (initialBundle ? normalizeScopedBundle(initialBundle, activeHub) : null),
    [activeHub, initialBundle]
  );

  const [bundle, setBundle] = useState(() =>
    normalizeScopedBundle(initialBundle, activeHub)
  );
  const [loading, setLoading] = useState<boolean>(
    () => !scopedInitialBundle && Boolean(customClient || isSupabaseConfigured)
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // Filtros rápidos locales
  const [staffSearch, setStaffSearch] = useState<string>('');
  const [staffCategoryFilter, setStaffCategoryFilter] = useState<
    'TODAS' | PromotoraCategoriaOficial
  >('TODAS');
  const [clientSearch, setClientSearch] = useState<string>('');

  // Modal Crear / Editar Promotora en public.staff
  const [staffFormOpen, setStaffFormOpen] = useState<boolean>(false);
  const [editingStaffRow, setEditingStaffRow] = useState<SucursalStaffMemberRow | null>(null);
  const [staffNameInput, setStaffNameInput] = useState<string>('');
  const [staffEmailInput, setStaffEmailInput] = useState<string>('');
  const [staffCategoryInput, setStaffCategoryInput] = useState<PromotoraCategoriaOficial>('Fijas');
  const [staffStatusInput, setStaffStatusInput] = useState<'Activo' | 'Inactivo'>('Activo');
  const [staffSaving, setStaffSaving] = useState<boolean>(false);
  const [staffFormError, setStaffFormError] = useState<string | null>(null);

  // Modal Aprovisionar Credenciales Auth (/portal) vía provisionStaffAuthAccountViaBackend
  const [authTargetStaff, setAuthTargetStaff] = useState<SucursalStaffMemberRow | null>(null);
  const [authEmailInput, setAuthEmailInput] = useState<string>('');
  const [authPasswordInput, setAuthPasswordInput] = useState<string>('');
  const [showAuthPassword, setShowAuthPassword] = useState<boolean>(false);
  const [authSubmitting, setAuthSubmitting] = useState<boolean>(false);
  const [authModalError, setAuthModalError] = useState<string | null>(null);
  const [copiedPortalCreds, setCopiedPortalCreds] = useState<boolean>(false);

  const loadSucursalBundle = useCallback(async () => {
    if (isCoordinatorWithoutBranch) {
      setLoading(false);
      return;
    }

    if (scopedInitialBundle) {
      setBundle(scopedInitialBundle);
      setLoading(false);
      return;
    }

    if (!customClient && !isSupabaseConfigured) {
      setBundle(normalizeScopedBundle(null, activeHub));
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    try {
      const client = customClient ?? getSupabaseClient();
      const { data, error } = await client.rpc('rpc_listar_personal_sucursal', {
        p_sucursal: activeHub,
      });

      if (error || !data || typeof data !== 'object') {
        throw new Error(
          error?.message ||
            `No se pudo sincronizar el padrón de ${SUCURSAL_PERSONAL_MODULE_TITLES[activeHub]}.`
        );
      }

      setBundle(normalizeScopedBundle(data as SucursalPersonalBundle, activeHub));
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Error al cargar el módulo regional de personal.'
      );
    } finally {
      setLoading(false);
    }
  }, [activeHub, customClient, isCoordinatorWithoutBranch, scopedInitialBundle]);

  useEffect(() => {
    void loadSucursalBundle();
  }, [loadSucursalBundle]);

  const handleSelectHub = (hub: OperativeSucursal) => {
    if (isHubLocked) return;
    setInternalSelectedHub(hub);
    onSelectSucursal?.(hub);
  };

  const resolvedRegionUuid = useMemo(() => {
    const candidate = bundle.region_id || activeRegionMeta.id;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
      ? candidate
      : null;
  }, [activeRegionMeta.id, bundle.region_id]);

  const staffCategoryStats = useMemo(
    () =>
      computePromotorasCategoryStats(
        bundle.staff as unknown as Array<Record<string, unknown>>
      ),
    [bundle.staff]
  );

  const filteredStaff = useMemo(() => {
    const q = staffSearch.trim().toLowerCase();
    return bundle.staff.filter((s) => {
      const cat = classifyPromotoraCategoriaOficial(s as unknown as Record<string, unknown>);
      if (staffCategoryFilter !== 'TODAS' && cat !== staffCategoryFilter) {
        return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        normalizeManagedUserEmail(s.email).includes(q) ||
        String(s.role || '').toLowerCase().includes(q) ||
        cat.toLowerCase().includes(q)
      );
    });
  }, [bundle.staff, staffSearch, staffCategoryFilter]);

  const filteredClientes = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return bundle.clientes;
    return bundle.clientes.filter((c) => {
      const comercial = String(c.nombreComercial ?? c.nombre_comercial ?? '').toLowerCase();
      const razon = String(c.razonSocial ?? c.razon_social ?? '').toLowerCase();
      const codigo = String(c.codigoCliente ?? c.codigo_cliente ?? '').toLowerCase();
      const ciudad = String(c.ciudad ?? '').toLowerCase();
      return (
        comercial.includes(q) ||
        razon.includes(q) ||
        codigo.includes(q) ||
        ciudad.includes(q)
      );
    });
  }, [bundle.clientes, clientSearch]);

  const kpis = useMemo(() => {
    const activePromotoras = bundle.staff.filter(
      (s) => parseStaffStatus(s.status) === 'Activo'
    ).length;
    const portalLinked = bundle.staff.filter((s) => Boolean(s.auth_user_id)).length;
    const activeClients = bundle.clientes.length;
    const clienteUsersCount = bundle.profiles.filter(
      (p) => normalizeManagedUserRole(p.role) === 'cliente' && p.is_active !== false
    ).length;
    const portalAccesosActivos = bundle.portal_accesos.filter((a) => a.activo).length;
    return {
      activePromotoras,
      totalStaff: bundle.staff.length,
      portalLinked,
      activeClients,
      clienteUsersCount,
      portalAccesosActivos,
    };
  }, [bundle]);

  const openCreateStaffModal = () => {
    setEditingStaffRow(null);
    setStaffNameInput('');
    setStaffEmailInput('');
    setStaffCategoryInput('Fijas');
    setStaffStatusInput('Activo');
    setStaffFormError(null);
    setStaffFormOpen(true);
  };

  const openEditStaffModal = (row: SucursalStaffMemberRow) => {
    setEditingStaffRow(row);
    setStaffNameInput(row.name);
    setStaffEmailInput(normalizeManagedUserEmail(row.email));
    setStaffCategoryInput(
      classifyPromotoraCategoriaOficial(row as unknown as Record<string, unknown>)
    );
    setStaffStatusInput(parseStaffStatus(row.status));
    setStaffFormError(null);
    setStaffFormOpen(true);
  };

  const handleSaveStaffSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (staffSaving) return;

    const cleanName = staffNameInput.trim().replace(/\s+/g, ' ');
    const cleanEmail = normalizeManagedUserEmail(staffEmailInput);

    if (cleanName.length < 2) {
      setStaffFormError('El nombre de la promotora debe tener al menos 2 caracteres.');
      return;
    }
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
      setStaffFormError('Ingresa un correo electrónico válido.');
      return;
    }
    if (!customClient && !isSupabaseConfigured) {
      setStaffFormError('Conexión a Supabase no configurada.');
      return;
    }

    setStaffSaving(true);
    setStaffFormError(null);
    try {
      const client = customClient ?? getSupabaseClient();
      const canonicalRole = formatPromotoraRoleForCategory(staffCategoryInput);
      const baseStaffPayload = {
        name: cleanName,
        email: cleanEmail,
        role: canonicalRole,
        status: staffStatusInput,
        sucursal: activeHub,
        ...(resolvedRegionUuid ? { region_id: resolvedRegionUuid } : {}),
      };

      if (editingStaffRow) {
        let { data, error } = await client
          .from('staff')
          .update({ ...baseStaffPayload, categoria: staffCategoryInput })
          .eq('id', editingStaffRow.id)
          .eq('sucursal', activeHub)
          .select('*')
          .single();

        if (error && /column .*categoria|PGRST204|42703/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
          ({ data, error } = await client
            .from('staff')
            .update(baseStaffPayload)
            .eq('id', editingStaffRow.id)
            .eq('sucursal', activeHub)
            .select('*')
            .single());
        }

        if (error || !data) {
          throw new Error(error?.message || 'No se pudo actualizar el registro de personal.');
        }

        const updated: SucursalStaffMemberRow = {
          ...(data as SucursalStaffMemberRow),
          categoria: staffCategoryInput,
        };
        setBundle((prev) => ({
          ...prev,
          staff: prev.staff.map((s) => (s.id === updated.id ? updated : s)),
        }));
        setFeedbackMsg(
          `Promotora ${updated.name} (${staffCategoryInput}) actualizada en ${SUCURSAL_LABELS[activeHub]}.`
        );
      } else {
        let { data, error } = await client
          .from('staff')
          .insert({ ...baseStaffPayload, categoria: staffCategoryInput })
          .select('*')
          .single();

        if (error && /column .*categoria|PGRST204|42703/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
          ({ data, error } = await client
            .from('staff')
            .insert(baseStaffPayload)
            .select('*')
            .single());
        }

        if (error || !data) {
          throw new Error(error?.message || 'No se pudo registrar la promotora en public.staff.');
        }

        const inserted: SucursalStaffMemberRow = {
          ...(data as SucursalStaffMemberRow),
          categoria: staffCategoryInput,
        };
        setBundle((prev) => ({
          ...prev,
          staff: [inserted, ...prev.staff],
        }));
        setFeedbackMsg(
          `Promotora ${inserted.name} (${staffCategoryInput}) incorporada a ${SUCURSAL_LABELS[activeHub]}.`
        );
      }

      setStaffFormOpen(false);
      await app?.refreshSupabaseData().catch(() => {});
    } catch (err) {
      setStaffFormError(
        err instanceof Error ? err.message : 'Error guardando el registro de personal.'
      );
    } finally {
      setStaffSaving(false);
    }
  };

  const openProvisionAuthModal = (row: SucursalStaffMemberRow) => {
    setAuthTargetStaff(row);
    setAuthEmailInput(normalizeManagedUserEmail(row.email));
    setAuthPasswordInput('');
    setShowAuthPassword(false);
    setAuthModalError(null);
    setCopiedPortalCreds(false);
  };

  const handleGeneratePortalPassword = () => {
    const generated = generateSecureInitialPassword(12);
    setAuthPasswordInput(generated);
    setShowAuthPassword(true);
    setAuthModalError(null);
    setCopiedPortalCreds(false);
  };

  const handleCopyPortalCredentials = async () => {
    const cleanEmail = normalizeManagedUserEmail(authEmailInput);
    setAuthEmailInput(cleanEmail);
    if (!cleanEmail) {
      setAuthModalError('Indica primero el correo de acceso al /portal.');
      return;
    }
    if (authPasswordInput.length < MIN_SUPABASE_PASSWORD_LENGTH) {
      setAuthModalError(
        `Genera o ingresa una clave de al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres.`
      );
      return;
    }

    const text = [
      `CODIZULCA C.A. — Acceso Portal Promotoras (${SUCURSAL_LABELS[activeHub]})`,
      `Correo: ${cleanEmail}`,
      `Contraseña: ${authPasswordInput}`,
      'Ruta: /portal',
    ].join('\n');

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedPortalCreds(true);
      window.setTimeout(() => setCopiedPortalCreds(false), 2500);
    } catch {
      // Sin acceso al portapapeles en entorno restringido
    }
  };

  const handleProvisionAuthSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!authTargetStaff || authSubmitting) return;

    const cleanEmail = normalizeManagedUserEmail(authEmailInput);
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
      setAuthModalError('Ingresa un correo electrónico válido para el Portal de Promotoras.');
      return;
    }
    if (authPasswordInput && authPasswordInput.length < MIN_SUPABASE_PASSWORD_LENGTH) {
      setAuthModalError(
        `La contraseña debe tener al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres.`
      );
      return;
    }

    setAuthSubmitting(true);
    setAuthModalError(null);
    try {
      const result = await provisionStaffAuthAccountViaBackend({
        staffId: authTargetStaff.id,
        name: authTargetStaff.name,
        email: cleanEmail,
        password: authPasswordInput || undefined,
        appRole: 'promotora',
        sucursal: activeHub,
        active: parseStaffStatus(authTargetStaff.status) === 'Activo',
      });

      setBundle((prev) => ({
        ...prev,
        staff: prev.staff.map((row) =>
          row.id === authTargetStaff.id
            ? {
                ...row,
                email: result.loginEmail || cleanEmail,
                auth_user_id: result.authUserId,
                sucursal: activeHub,
              }
            : row
        ),
      }));

      setFeedbackMsg(
        `Credenciales /portal habilitadas para ${authTargetStaff.name} (${result.loginEmail || cleanEmail}) en ${SUCURSAL_LABELS[activeHub]}.`
      );
      setAuthTargetStaff(null);
    } catch (err) {
      setAuthModalError(
        err instanceof Error
          ? err.message
          : 'No se pudo aprovisionar el acceso al Portal de Promotoras.'
      );
    } finally {
      setAuthSubmitting(false);
    }
  };

  if (isCoordinatorWithoutBranch) {
    return (
      <div
        role="alert"
        data-testid="coordinator-missing-branch-alert"
        className="rounded-2xl bg-red-950/50 border border-red-500/40 p-6 text-xs text-red-200 flex items-center gap-3"
      >
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
        <span>
          Tu perfil de Coordinación no tiene una sucursal operativa asignada en{' '}
          <code className="font-mono">public.profiles</code>. Contacta al Administrador General.
        </span>
      </div>
    );
  }

  const moduleTitle = SUCURSAL_PERSONAL_MODULE_TITLES[activeHub];
  const sucursalLabel = SUCURSAL_LABELS[activeHub];

  return (
    <div
      className="space-y-5"
      data-testid={`sucursal-personal-module-${activeHub.toLowerCase()}`}
    >
      {/* Selector de los 5 Módulos Independientes por Sucursal (EXCLUSIVO cuando NO está bloqueado a Coordinación) */}
      {!isHubLocked && (
        <div
          data-testid="sucursal-modules-switcher"
          className="rounded-2xl bg-zinc-950/90 border border-white/[0.08] p-3.5 space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-red-400" />
              <span>Módulos Independientes de Personal por Sucursal (5 Regiones)</span>
            </span>
            <span className="text-[11px] font-mono text-zinc-400">
              Aislamiento estricto Zero-Mixing · {OPERATIVE_SUCURSALES.length} hubs activos
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            {regiones.map((reg) => {
              const isSelected = reg.codigo === activeHub;
              return (
                <button
                  key={reg.codigo}
                  type="button"
                  data-testid={`hub-module-tab-${reg.codigo.toLowerCase()}`}
                  onClick={() => handleSelectHub(reg.codigo)}
                  className={`relative overflow-hidden px-3 py-2.5 rounded-xl border text-left transition cursor-pointer ${
                    isSelected
                      ? 'bg-red-600/15 border-red-500 text-white'
                      : 'bg-black/70 border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-white'
                  }`}
                >
                  <span className="text-[10px] font-mono font-bold uppercase block text-red-400">
                    {reg.codigo}
                  </span>
                  <span className="text-xs font-extrabold block truncate">
                    {SUCURSAL_PERSONAL_MODULE_TITLES[reg.codigo]}
                  </span>
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-[#DC2626]"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Cabecera del Módulo Independiente de la Sucursal Activa */}
      <AnimatedTabContainer tabKey={activeHub} className="space-y-5">
      <div className="rounded-2xl bg-zinc-950/95 border border-white/10 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="w-11 h-11 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight">
                {moduleTitle}
              </h2>
              {isHubLocked ? (
                <span
                  data-testid="locked-sucursal-badge"
                  className="inline-flex items-center gap-1 text-[10px] font-mono font-bold uppercase px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-200 border border-amber-500/35"
                >
                  <Lock className="w-3 h-3 text-amber-400" />
                  <span>Sede exclusiva · {sucursalLabel}</span>
                </span>
              ) : (
                <span className="text-[10px] font-mono font-bold uppercase px-2.5 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30">
                  {sucursalLabel}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Gestión aislada de promotoras, credenciales <code className="font-mono">/portal</code>, cartera regional de clientes y accesos <code className="font-mono">/cliente</code> en {sucursalLabel}.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {!scopedInitialBundle && (
            <button
              type="button"
              onClick={() => void loadSucursalBundle()}
              disabled={loading}
              className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-red-400' : ''}`} />
              <span>Actualizar</span>
            </button>
          )}

          <button
            type="button"
            data-testid={`btn-new-promotora-${activeHub.toLowerCase()}`}
            onClick={openCreateStaffModal}
            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-extrabold text-white inline-flex items-center gap-1.5 shadow-sm cursor-pointer"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>+ Nueva Promotora ({activeRegionMeta.nombre})</span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-xl bg-red-950/50 border border-red-500/35 px-4 py-3 text-xs text-red-200 flex items-center justify-between gap-2"
        >
          <span className="inline-flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMsg}</span>
          </span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            aria-label="Cerrar alerta"
            className="p-1 rounded hover:bg-white/10 text-red-200 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {feedbackMsg && (
        <div
          role="status"
          className="rounded-xl bg-emerald-950/40 border border-emerald-500/30 px-4 py-2.5 text-xs text-emerald-200 flex items-center justify-between gap-2"
        >
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{feedbackMsg}</span>
          </span>
          <button
            type="button"
            onClick={() => setFeedbackMsg(null)}
            aria-label="Cerrar confirmación"
            className="p-1 rounded hover:bg-white/10 text-emerald-200 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Indicadores Operativos del Hub */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl bg-zinc-950/90 border border-white/[0.08] px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-zinc-400">Promotoras Activas</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {kpis.activePromotoras}
              <span className="text-xs text-zinc-500 font-normal"> / {kpis.totalStaff}</span>
            </p>
          </div>
          <Users className="w-4 h-4 text-red-400" />
        </div>

        <div className="rounded-xl bg-zinc-950/90 border border-emerald-500/25 px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-emerald-300/90">Acceso /portal</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {kpis.portalLinked}
            </p>
          </div>
          <KeyRound className="w-4 h-4 text-emerald-400" />
        </div>

        <div className="rounded-xl bg-zinc-950/90 border border-white/[0.08] px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-zinc-400">Clientes Regionales</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {kpis.activeClients}
            </p>
          </div>
          <Store className="w-4 h-4 text-amber-400" />
        </div>

        <div className="rounded-xl bg-zinc-950/90 border border-cyan-500/25 px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-cyan-300/90">Accesos /cliente</p>
            <p className="text-xl font-extrabold text-white font-mono mt-0.5">
              {kpis.portalAccesosActivos}
            </p>
          </div>
          <UserCheck className="w-4 h-4 text-cyan-400" />
        </div>
      </div>

      {/* 0. Accesos rápidos de copiado de enlace para App Promotoras (/portal) y App Chofer (/logistica/) */}
      <PortalQuickLinksBar />

      {/* 1. Padrón Regional de Promotoras (public.staff) + Aprovisionamiento /portal */}
      <section className="rounded-2xl bg-zinc-950/95 border border-white/10 p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold text-white">
              Promotoras de Campo y Credenciales /portal · {sucursalLabel}
            </h3>
            <p className="text-xs text-zinc-400">
              Padrón regional en <code className="font-mono">public.staff</code> con vinculación directa a Supabase Auth.
            </p>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={staffSearch}
              onChange={(e) => setStaffSearch(e.target.value)}
              placeholder={`Buscar promotora en ${activeRegionMeta.nombre}...`}
              aria-label={`Buscar promotora en ${activeRegionMeta.nombre}`}
              className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500"
            />
          </div>
        </div>

        {/* Filtros y contadores por categoría oficial: Fijas / Eventuales / Merchandising */}
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Filtrar personal por categoría"
          data-testid="sucursal-staff-category-filter-bar"
        >
          {(
            [
              { id: 'TODAS', label: 'Todas', count: staffCategoryStats.total },
              { id: 'Fijas', label: 'Fijas', count: staffCategoryStats.Fijas },
              { id: 'Eventuales', label: 'Eventuales', count: staffCategoryStats.Eventuales },
              {
                id: 'Merchandising',
                label: 'Merchandising',
                count: staffCategoryStats.Merchandising,
              },
            ] as const
          ).map((pill) => {
            const active = staffCategoryFilter === pill.id;
            return (
              <button
                key={pill.id}
                type="button"
                data-testid={`sucursal-filter-categoria-${pill.id}`}
                onClick={() => setStaffCategoryFilter(pill.id)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold inline-flex items-center gap-1.5 border transition cursor-pointer ${
                  active
                    ? 'bg-red-600 text-white border-red-500'
                    : 'bg-black text-zinc-300 border-zinc-800 hover:border-zinc-600'
                }`}
              >
                <span>{pill.label}</span>
                <span
                  className={`px-1.5 py-0.2 rounded font-mono text-[10px] ${
                    active ? 'bg-black/30 text-white' : 'bg-zinc-900 text-zinc-400'
                  }`}
                >
                  {pill.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="rounded-xl border border-white/[0.07] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-zinc-900/70 text-[10px] font-extrabold uppercase tracking-wider text-zinc-400">
                  <th className="py-2.5 px-3.5">Promotora</th>
                  <th className="py-2.5 px-3.5">Correo Electrónico</th>
                  <th className="py-2.5 px-3.5">Categoría</th>
                  <th className="py-2.5 px-3.5">Estado</th>
                  <th className="py-2.5 px-3.5">Credencial /portal</th>
                  <th className="py-2.5 px-3.5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-zinc-400 font-mono">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                        Cargando personal de {sucursalLabel}...
                      </span>
                    </td>
                  </tr>
                ) : filteredStaff.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-zinc-500">
                      No hay promotoras registradas para {sucursalLabel} con el filtro actual.
                    </td>
                  </tr>
                ) : (
                  filteredStaff.map((row) => {
                    const statusNorm = parseStaffStatus(row.status);
                    const hasAuth = Boolean(row.auth_user_id);
                    const rowCat = classifyPromotoraCategoriaOficial(
                      row as unknown as Record<string, unknown>
                    );
                    const rowCatClass =
                      rowCat === 'Fijas'
                        ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/35'
                        : rowCat === 'Eventuales'
                          ? 'bg-amber-500/15 text-amber-200 border-amber-500/35'
                          : 'bg-cyan-500/15 text-cyan-200 border-cyan-500/35';
                    return (
                      <tr key={row.id} className="hover:bg-white/[0.02]">
                        <td className="py-2.5 px-3.5 font-semibold text-white">{row.name}</td>
                        <td className="py-2.5 px-3.5 font-mono text-zinc-300">
                          {normalizeManagedUserEmail(row.email) || '—'}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <span
                            data-testid={`sucursal-staff-cat-${row.id}`}
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${rowCatClass}`}
                          >
                            {rowCat}
                          </span>
                        </td>
                        <td className="py-2.5 px-3.5">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                              statusNorm === 'Activo'
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                            }`}
                          >
                            {statusNorm}
                          </span>
                        </td>
                        <td className="py-2.5 px-3.5">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                              hasAuth
                                ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/35'
                                : 'bg-amber-500/15 text-amber-200 border-amber-500/35'
                            }`}
                          >
                            <KeyRound className="w-3 h-3" />
                            {hasAuth ? 'Vinculada' : 'Sin clave Auth'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3.5 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEditStaffModal(row)}
                              className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-[11px] font-semibold text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Edit3 className="w-3 h-3" />
                              <span>Editar</span>
                            </button>
                            <button
                              type="button"
                              data-testid={`btn-provision-portal-${row.id}`}
                              onClick={() => openProvisionAuthModal(row)}
                              className="px-2.5 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 text-[11px] font-bold text-red-200 inline-flex items-center gap-1 cursor-pointer"
                            >
                              <KeyRound className="w-3 h-3 text-red-400" />
                              <span>Acceso /portal</span>
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
      </section>

      {/* 2. Cartera Activa de Clientes y Equipo Regional */}
      <section className="rounded-2xl bg-zinc-950/95 border border-white/10 p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold text-white">
              Clientes Activos y Directorio Operativo · {sucursalLabel}
            </h3>
            <p className="text-xs text-zinc-400">
              Puntos de Venta activos (<code className="font-mono">{bundle.clientes.length}</code>) y perfiles corporativos (<code className="font-mono">{bundle.profiles.length}</code>) asignados a {sucursalLabel}.
            </p>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              placeholder={`Filtrar PDVs de ${activeRegionMeta.nombre}...`}
              aria-label={`Filtrar PDVs de ${activeRegionMeta.nombre}`}
              className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500"
            />
          </div>
        </div>

        {bundle.profiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {bundle.profiles.slice(0, 12).map((p) => {
              const roleNorm = normalizeManagedUserRole(p.role) ?? 'vendedor';
              const fullName = String(p.full_name ?? p.fullName ?? '').trim() || p.email;
              return (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black border border-zinc-800 text-[11px] text-zinc-300"
                >
                  <UserCheck className="w-3 h-3 text-red-400 shrink-0" />
                  <strong className="text-white">{fullName}</strong>
                  <span className="text-zinc-500">·</span>
                  <span className="font-mono text-[10px] text-zinc-400">
                    {MANAGED_USER_ROLE_LABELS[roleNorm]}
                  </span>
                </span>
              );
            })}
          </div>
        )}

        <div className="rounded-xl border border-white/[0.07] overflow-hidden">
          <div className="overflow-x-auto max-h-64">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-zinc-900/70 text-[10px] font-extrabold uppercase tracking-wider text-zinc-400">
                  <th className="py-2 px-3.5">Código</th>
                  <th className="py-2 px-3.5">Nombre Comercial / Razón Social</th>
                  <th className="py-2 px-3.5">Ubicación</th>
                  <th className="py-2 px-3.5">Sede</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {filteredClientes.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-zinc-500">
                      Sin clientes activos registrados en {sucursalLabel}.
                    </td>
                  </tr>
                ) : (
                  filteredClientes.slice(0, 50).map((c) => {
                    const code = String(c.codigoCliente ?? c.codigo_cliente ?? '—');
                    const name =
                      String(c.nombreComercial ?? c.nombre_comercial ?? '').trim() ||
                      String(c.razonSocial ?? c.razon_social ?? '').trim() ||
                      'PDV';
                    const loc = [c.ciudad, c.estado].filter(Boolean).join(', ') || activeRegionMeta.nombre;
                    return (
                      <tr key={c.id} className="hover:bg-white/[0.02]">
                        <td className="py-2 px-3.5 font-mono text-zinc-300">{code}</td>
                        <td className="py-2 px-3.5 font-semibold text-white">{name}</td>
                        <td className="py-2 px-3.5 text-zinc-400">
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="w-3 h-3 text-red-400 shrink-0" />
                            <span>{loc}</span>
                          </span>
                        </td>
                        <td className="py-2 px-3.5 font-mono text-[11px] text-zinc-300">
                          {activeHub}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 3. Gestor Granular de Accesos Portal /cliente para esta Región */}
      <ClientePortalAccesosManager
        sucursal={activeHub}
        regionId={resolvedRegionUuid}
        customClient={customClient}
        initialData={{
          clienteUsers: bundle.profiles as PortalClienteUserOption[],
          clientes: bundle.clientes,
          cadenas: bundle.cadenas,
          accesos: bundle.portal_accesos,
        }}
        onChanged={() => {
          if (!scopedInitialBundle) {
            void loadSucursalBundle();
          }
        }}
      />

      {/* Modal: Alta / Edición de Promotora en public.staff */}
      {staffFormOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="staff-modal-title"
        >
          <form
            onSubmit={(e) => void handleSaveStaffSubmit(e)}
            noValidate
            className="w-full max-w-md rounded-2xl bg-zinc-950 border border-white/15 p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center">
                  <Plus className="w-4 h-4 text-red-400" />
                </div>
                <div>
                  <h3 id="staff-modal-title" className="text-sm font-extrabold text-white">
                    {editingStaffRow ? 'Editar Promotora Regional' : 'Registrar Nueva Promotora'}
                  </h3>
                  <p className="text-[11px] text-zinc-400">{sucursalLabel}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setStaffFormOpen(false)}
                className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
                aria-label="Cerrar modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {staffFormError && (
              <div
                role="alert"
                className="rounded-xl bg-red-950/50 border border-red-500/35 px-3.5 py-2.5 text-xs text-red-200 flex items-center gap-2"
              >
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{staffFormError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1">
                Nombre completo
              </label>
              <input
                type="text"
                required
                maxLength={160}
                value={staffNameInput}
                onChange={(e) => setStaffNameInput(e.target.value)}
                placeholder="Ej. Daniela Morales"
                className="w-full px-3.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1">
                Correo electrónico
              </label>
              <input
                type="email"
                value={staffEmailInput}
                onChange={(e) => setStaffEmailInput(e.target.value)}
                onBlur={() => setStaffEmailInput((prev) => normalizeManagedUserEmail(prev))}
                placeholder="promotora@codizulca.com"
                className="w-full px-3.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-zinc-300 mb-1">Categoría</label>
                <select
                  data-testid="sucursal-select-staff-categoria"
                  value={staffCategoryInput}
                  onChange={(e) =>
                    setStaffCategoryInput(e.target.value as PromotoraCategoriaOficial)
                  }
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer"
                >
                  {PROMOTORA_CATEGORIAS.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-300 mb-1">Estado</label>
                <select
                  value={staffStatusInput}
                  onChange={(e) =>
                    setStaffStatusInput(e.target.value as 'Activo' | 'Inactivo')
                  }
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer"
                >
                  <option value="Activo">Activo</option>
                  <option value="Inactivo">Inactivo</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={staffSaving}
                onClick={() => setStaffFormOpen(false)}
                className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={staffSaving}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-xs font-extrabold text-white inline-flex items-center gap-1.5 cursor-pointer"
              >
                {staffSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{editingStaffRow ? 'Guardar cambios' : 'Registrar en sucursal'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Aprovisionar Credenciales /portal vía Backend */}
      {authTargetStaff && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="portal-auth-modal-title"
        >
          <form
            onSubmit={(e) => void handleProvisionAuthSubmit(e)}
            noValidate
            className="w-full max-w-md rounded-2xl bg-zinc-950 border border-white/15 p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center">
                  <KeyRound className="w-4 h-4 text-red-400" />
                </div>
                <div>
                  <h3 id="portal-auth-modal-title" className="text-sm font-extrabold text-white">
                    Credenciales /portal · {authTargetStaff.name}
                  </h3>
                  <p className="text-[11px] text-zinc-400">
                    Aprovisionamiento directo en Supabase Auth ({sucursalLabel})
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAuthTargetStaff(null)}
                className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
                aria-label="Cerrar modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {authModalError && (
              <div
                role="alert"
                className="rounded-xl bg-red-950/50 border border-red-500/35 px-3.5 py-2.5 text-xs text-red-200 flex items-center gap-2"
              >
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{authModalError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1">
                Correo de inicio de sesión en /portal
              </label>
              <input
                type="email"
                required
                value={authEmailInput}
                onChange={(e) => setAuthEmailInput(e.target.value)}
                onBlur={() => setAuthEmailInput((prev) => normalizeManagedUserEmail(prev))}
                placeholder="promotora@codizulca.com"
                className="w-full px-3.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-500"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-zinc-300">
                  Contraseña de acceso
                </label>
                <span className="text-[10px] font-mono text-zinc-500">
                  Mínimo {MIN_SUPABASE_PASSWORD_LENGTH} caracteres
                </span>
              </div>

              <div className="relative">
                <input
                  type={showAuthPassword ? 'text' : 'password'}
                  minLength={MIN_SUPABASE_PASSWORD_LENGTH}
                  value={authPasswordInput}
                  onChange={(e) => {
                    setAuthPasswordInput(e.target.value);
                    setCopiedPortalCreds(false);
                  }}
                  placeholder={
                    authTargetStaff.auth_user_id
                      ? 'Dejar vacío para conservar clave actual o escribir nueva'
                      : `Mínimo ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres`
                  }
                  className="w-full pl-3.5 pr-9 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-500"
                />
                <button
                  type="button"
                  onClick={() => setShowAuthPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white cursor-pointer"
                  aria-label={showAuthPassword ? 'Ocultar clave' : 'Mostrar clave'}
                >
                  {showAuthPassword ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleGeneratePortalPassword}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-[11px] font-semibold text-zinc-200 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5 text-red-400" />
                  <span>Generar clave segura</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyPortalCredentials()}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-[11px] font-semibold text-zinc-200 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {copiedPortalCreds ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>¡Copiado!</span>
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

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={authSubmitting}
                onClick={() => setAuthTargetStaff(null)}
                className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={authSubmitting}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-xs font-extrabold text-white inline-flex items-center gap-1.5 cursor-pointer"
              >
                {authSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Aprovisionar /portal</span>
              </button>
            </div>
          </form>
        </div>
      )}
      </AnimatedTabContainer>
    </div>
  );
};
