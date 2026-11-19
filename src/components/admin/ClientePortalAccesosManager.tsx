import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Store,
  ToggleLeft,
  ToggleRight,
  UserCheck,
  X,
} from 'lucide-react';
import { getSupabaseClient, isSupabaseConfigured } from '../../services/supabaseClient';
import {
  SUCURSAL_LABELS,
  normalizeManagedUserEmail,
  normalizeManagedUserRole,
  normalizeSucursalCodigo,
  type OperativeSucursal,
} from '../../services/userManagementService';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PortalTargetType = 'PDV' | 'CADENA';

export interface PortalClienteUserOption {
  id: string;
  email: string;
  fullName?: string;
  full_name?: string;
  role?: string;
  sucursal?: OperativeSucursal | string | null;
  regionId?: string | null;
  region_id?: string | null;
  isActive?: boolean;
  is_active?: boolean;
}

export interface PortalClientePdvOption {
  id: string;
  codigoCliente?: string;
  codigo_cliente?: string;
  nombreComercial?: string;
  nombre_comercial?: string;
  razonSocial?: string;
  razon_social?: string;
  ciudad?: string | null;
  estado?: string | null;
  activo?: boolean;
  sucursal?: OperativeSucursal | string | null;
  regionId?: string | null;
  region_id?: string | null;
}

export interface PortalCadenaOption {
  id: string;
  codigo?: string;
  nombre: string;
  tipoCanal?: string | null;
  tipo_canal?: string | null;
  activo?: boolean;
  sucursal?: OperativeSucursal | string | null;
  regionId?: string | null;
  region_id?: string | null;
}

export interface ClientePortalAccesoRecord {
  id: string;
  user_id: string;
  cliente_id?: string | null;
  cadena_id?: string | null;
  activo: boolean;
  notas?: string | null;
  sucursal?: OperativeSucursal | string | null;
  region_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ClientePortalAccesosInitialData {
  clienteUsers?: PortalClienteUserOption[];
  clientes?: PortalClientePdvOption[];
  cadenas?: PortalCadenaOption[];
  accesos?: ClientePortalAccesoRecord[];
}

export interface ClientePortalAccesosManagerProps {
  sucursal: OperativeSucursal;
  regionId?: string | null;
  readOnly?: boolean;
  initialData?: ClientePortalAccesosInitialData;
  onChanged?: () => void | Promise<void>;
  customClient?: SupabaseClient;
}

function matchesHub(rawSucursal: unknown, targetHub: OperativeSucursal): boolean {
  if (rawSucursal === undefined || rawSucursal === null || String(rawSucursal).trim() === '') {
    return true;
  }
  return normalizeSucursalCodigo(rawSucursal) === targetHub;
}

function resolveUserDisplayName(u: PortalClienteUserOption): string {
  const name = String(u.fullName ?? u.full_name ?? '').trim();
  return name || normalizeManagedUserEmail(u.email) || 'Cliente Portal';
}

function resolvePdvDisplayName(c: PortalClientePdvOption): string {
  const comercial = String(c.nombreComercial ?? c.nombre_comercial ?? '').trim();
  const razon = String(c.razonSocial ?? c.razon_social ?? '').trim();
  const code = String(c.codigoCliente ?? c.codigo_cliente ?? '').trim();
  const base = comercial || razon || 'Punto de Venta';
  return code ? `${base} (${code})` : base;
}

function filterInitialBundleForHub(
  raw: ClientePortalAccesosInitialData | undefined,
  sucursal: OperativeSucursal
): Required<ClientePortalAccesosInitialData> {
  const clienteUsers = (raw?.clienteUsers ?? []).filter((u) => {
    if (!matchesHub(u.sucursal, sucursal)) return false;
    if (u.role !== undefined && u.role !== null && String(u.role).trim() !== '') {
      return normalizeManagedUserRole(u.role) === 'cliente';
    }
    return true;
  });

  const clientes = (raw?.clientes ?? []).filter(
    (c) => matchesHub(c.sucursal, sucursal) && c.activo !== false
  );

  const cadenas = (raw?.cadenas ?? []).filter(
    (cad) => matchesHub(cad.sucursal, sucursal) && cad.activo !== false
  );

  const accesos = (raw?.accesos ?? []).filter((acc) => matchesHub(acc.sucursal, sucursal));

  return { clienteUsers, clientes, cadenas, accesos };
}

export const ClientePortalAccesosManager: React.FC<ClientePortalAccesosManagerProps> = ({
  sucursal,
  regionId = null,
  readOnly = false,
  initialData,
  onChanged,
  customClient,
}) => {
  const initialScoped = useMemo(
    () => (initialData ? filterInitialBundleForHub(initialData, sucursal) : null),
    [initialData, sucursal]
  );

  const [clienteUsers, setClienteUsers] = useState<PortalClienteUserOption[]>(
    () => initialScoped?.clienteUsers ?? []
  );
  const [clientes, setClientes] = useState<PortalClientePdvOption[]>(
    () => initialScoped?.clientes ?? []
  );
  const [cadenas, setCadenas] = useState<PortalCadenaOption[]>(
    () => initialScoped?.cadenas ?? []
  );
  const [accesos, setAccesos] = useState<ClientePortalAccesoRecord[]>(
    () => initialScoped?.accesos ?? []
  );

  const [loading, setLoading] = useState<boolean>(() => !initialScoped && isSupabaseConfigured);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  const [selectedUserId, setSelectedUserId] = useState<string>(
    () => initialScoped?.clienteUsers[0]?.id ?? ''
  );
  const [targetType, setTargetType] = useState<PortalTargetType>('PDV');
  const [selectedClienteId, setSelectedClienteId] = useState<string>(
    () => initialScoped?.clientes[0]?.id ?? ''
  );
  const [selectedCadenaId, setSelectedCadenaId] = useState<string>(
    () => initialScoped?.cadenas[0]?.id ?? ''
  );
  const [notas, setNotas] = useState<string>('');

  const sucursalLabel = SUCURSAL_LABELS[sucursal] ?? `Sucursal ${sucursal}`;

  const loadRegionalData = useCallback(async () => {
    if (initialScoped) {
      setClienteUsers(initialScoped.clienteUsers);
      setClientes(initialScoped.clientes);
      setCadenas(initialScoped.cadenas);
      setAccesos(initialScoped.accesos);
      setLoading(false);
      return;
    }

    if (!customClient && !isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    try {
      const client = customClient ?? getSupabaseClient();
      const { data, error } = await client.rpc('rpc_listar_personal_sucursal', {
        p_sucursal: sucursal,
      });

      if (error || !data || typeof data !== 'object') {
        throw new Error(
          error?.message || `No se pudo consultar los accesos de clientes para ${sucursalLabel}.`
        );
      }

      const payload = data as {
        profiles?: PortalClienteUserOption[];
        clientes?: PortalClientePdvOption[];
        cadenas?: PortalCadenaOption[];
        portal_accesos?: ClientePortalAccesoRecord[];
      };

      const scoped = filterInitialBundleForHub(
        {
          clienteUsers: Array.isArray(payload.profiles) ? payload.profiles : [],
          clientes: Array.isArray(payload.clientes) ? payload.clientes : [],
          cadenas: Array.isArray(payload.cadenas) ? payload.cadenas : [],
          accesos: Array.isArray(payload.portal_accesos) ? payload.portal_accesos : [],
        },
        sucursal
      );

      setClienteUsers(scoped.clienteUsers);
      setClientes(scoped.clientes);
      setCadenas(scoped.cadenas);
      setAccesos(scoped.accesos);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudo sincronizar la matriz de accesos del Portal Cliente.'
      );
    } finally {
      setLoading(false);
    }
  }, [customClient, initialScoped, sucursal, sucursalLabel]);

  useEffect(() => {
    void loadRegionalData();
  }, [loadRegionalData]);

  useEffect(() => {
    if (clienteUsers.length > 0 && !clienteUsers.some((u) => u.id === selectedUserId)) {
      setSelectedUserId(clienteUsers[0]!.id);
    } else if (clienteUsers.length === 0) {
      setSelectedUserId('');
    }
  }, [clienteUsers, selectedUserId]);

  useEffect(() => {
    if (clientes.length > 0 && !clientes.some((c) => c.id === selectedClienteId)) {
      setSelectedClienteId(clientes[0]!.id);
    } else if (clientes.length === 0) {
      setSelectedClienteId('');
    }
  }, [clientes, selectedClienteId]);

  useEffect(() => {
    if (cadenas.length > 0 && !cadenas.some((cad) => cad.id === selectedCadenaId)) {
      setSelectedCadenaId(cadenas[0]!.id);
    } else if (cadenas.length === 0) {
      setSelectedCadenaId('');
    }
  }, [cadenas, selectedCadenaId]);

  const usersById = useMemo(() => {
    const map = new Map<string, PortalClienteUserOption>();
    for (const u of clienteUsers) map.set(u.id, u);
    return map;
  }, [clienteUsers]);

  const clientesById = useMemo(() => {
    const map = new Map<string, PortalClientePdvOption>();
    for (const c of clientes) map.set(c.id, c);
    return map;
  }, [clientes]);

  const cadenasById = useMemo(() => {
    const map = new Map<string, PortalCadenaOption>();
    for (const cad of cadenas) map.set(cad.id, cad);
    return map;
  }, [cadenas]);

  const handleAssignAccess = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (readOnly || submitting) return;

    setErrorMsg(null);
    setFeedbackMsg(null);

    const userId = selectedUserId.trim();
    const targetId = targetType === 'PDV' ? selectedClienteId.trim() : selectedCadenaId.trim();
    const cleanNotas = notas.trim().slice(0, 300);

    if (!UUID_REGEX.test(userId) || !usersById.has(userId)) {
      setErrorMsg(
        `Selecciona un usuario con rol "cliente" perteneciente a ${sucursalLabel}.`
      );
      return;
    }

    if (targetType === 'PDV' && (!UUID_REGEX.test(targetId) || !clientesById.has(targetId))) {
      setErrorMsg(`Selecciona un Punto de Venta (PDV) válido de ${sucursalLabel}.`);
      return;
    }

    if (targetType === 'CADENA' && (!UUID_REGEX.test(targetId) || !cadenasById.has(targetId))) {
      setErrorMsg(`Selecciona una Cadena Comercial válida de ${sucursalLabel}.`);
      return;
    }

    if (!customClient && !isSupabaseConfigured) {
      setErrorMsg('Conexión a Supabase no disponible en este entorno.');
      return;
    }

    setSubmitting(true);
    try {
      const client = customClient ?? getSupabaseClient();
      const targetColumn = targetType === 'PDV' ? 'cliente_id' : 'cadena_id';

      const existingLocal = accesos.find(
        (row) =>
          row.user_id === userId &&
          (targetType === 'PDV' ? row.cliente_id === targetId : row.cadena_id === targetId)
      );

      let existingId = existingLocal?.id ?? null;
      if (!existingId) {
        const { data: existingRemote } = await client
          .from('cliente_portal_accesos')
          .select('id')
          .eq('user_id', userId)
          .eq(targetColumn, targetId)
          .eq('sucursal', sucursal)
          .maybeSingle();
        if (existingRemote && typeof existingRemote === 'object' && 'id' in existingRemote) {
          existingId = String((existingRemote as { id: unknown }).id || '');
        }
      }

      const validRegionId = regionId && UUID_REGEX.test(regionId) ? regionId : undefined;

      let savedRecord: ClientePortalAccesoRecord | null = null;
      if (existingId && UUID_REGEX.test(existingId)) {
        const { data, error } = await client
          .from('cliente_portal_accesos')
          .update({
            activo: true,
            notas: cleanNotas,
            sucursal,
            ...(validRegionId ? { region_id: validRegionId } : {}),
          })
          .eq('id', existingId)
          .eq('sucursal', sucursal)
          .select('*')
          .single();

        if (error || !data) {
          throw new Error(error?.message || 'No se pudo reactivar/actualizar el acceso del cliente.');
        }
        savedRecord = data as ClientePortalAccesoRecord;
      } else {
        const { data, error } = await client
          .from('cliente_portal_accesos')
          .insert({
            user_id: userId,
            cliente_id: targetType === 'PDV' ? targetId : null,
            cadena_id: targetType === 'CADENA' ? targetId : null,
            activo: true,
            notas: cleanNotas,
            sucursal,
            ...(validRegionId ? { region_id: validRegionId } : {}),
          })
          .select('*')
          .single();

        if (error || !data) {
          throw new Error(error?.message || 'No se pudo registrar el acceso en Portal Cliente.');
        }
        savedRecord = data as ClientePortalAccesoRecord;
      }

      setAccesos((prev) => {
        const filtered = prev.filter((item) => item.id !== savedRecord!.id);
        return [savedRecord!, ...filtered];
      });
      setNotas('');
      setFeedbackMsg(
        `Acceso autorizado en /cliente para ${resolveUserDisplayName(usersById.get(userId)!)} (${sucursalLabel}).`
      );
      await onChanged?.();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Error al guardar el acceso del Portal Cliente.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleAcceso = async (row: ClientePortalAccesoRecord) => {
    if (readOnly || togglingId) return;
    if (!UUID_REGEX.test(row.id)) return;

    if (!customClient && !isSupabaseConfigured) {
      setErrorMsg('Conexión a Supabase no disponible en este entorno.');
      return;
    }

    const nextActivo = !row.activo;
    setTogglingId(row.id);
    setErrorMsg(null);
    setFeedbackMsg(null);

    try {
      const client = customClient ?? getSupabaseClient();
      const { data, error } = await client
        .from('cliente_portal_accesos')
        .update({ activo: nextActivo })
        .eq('id', row.id)
        .eq('sucursal', sucursal)
        .select('*')
        .single();

      if (error || !data) {
        throw new Error(error?.message || 'No se pudo actualizar el estado del acceso.');
      }

      const updated = data as ClientePortalAccesoRecord;
      setAccesos((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setFeedbackMsg(
        nextActivo
          ? 'Acceso al Portal /cliente reactivado de inmediato.'
          : 'Acceso al Portal /cliente revocado de inmediato.'
      );
      await onChanged?.();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'No se pudo cambiar el estado del acceso.'
      );
    } finally {
      setTogglingId(null);
    }
  };

  const activeCount = accesos.filter((a) => a.activo).length;

  return (
    <section
      data-testid={`cliente-portal-accesos-${sucursal.toLowerCase()}`}
      className="rounded-2xl bg-zinc-950/95 border border-white/10 p-4 sm:p-5 space-y-4"
    >
      {/* Cabecera del Gestor Regional de Accesos /cliente */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-white/[0.07] pb-3.5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center shrink-0">
            <KeyRound className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm sm:text-base font-extrabold text-white">
                Accesos Portal /cliente · {sucursalLabel}
              </h3>
              <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-mono font-bold text-emerald-300">
                {activeCount} activos / {accesos.length} total
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Autoriza o revoca qué PDVs o Cadenas Comerciales de {sucursalLabel} puede auditar cada usuario cliente (sin SQL manual).
            </p>
          </div>
        </div>

        {!initialScoped && (
          <button
            type="button"
            onClick={() => void loadRegionalData()}
            disabled={loading}
            className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 self-start sm:self-auto"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-red-400' : ''}`} />
            <span>Recargar</span>
          </button>
        )}
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-xl bg-red-950/50 border border-red-500/35 px-3.5 py-2.5 text-xs text-red-200 flex items-center justify-between gap-2"
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
          className="rounded-xl bg-emerald-950/40 border border-emerald-500/30 px-3.5 py-2.5 text-xs text-emerald-200 flex items-center justify-between gap-2"
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

      {/* Formulario de Asignación Granular (PDV Individual vs Cadena Comercial) */}
      {!readOnly && (
        <form
          onSubmit={(e) => void handleAssignAccess(e)}
          noValidate
          className="rounded-xl bg-black/60 border border-white/[0.08] p-3.5 space-y-3"
        >
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            {/* Usuario rol cliente de la región */}
            <div className="md:col-span-4">
              <label
                htmlFor={`portal-acceso-user-${sucursal}`}
                className="block text-[11px] font-bold text-zinc-300 mb-1"
              >
                Usuario Cliente ({sucursal})
              </label>
              <select
                id={`portal-acceso-user-${sucursal}`}
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                disabled={submitting || clienteUsers.length === 0}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer disabled:opacity-60"
              >
                {clienteUsers.length === 0 ? (
                  <option value="">Sin usuarios rol cliente en {sucursalLabel}</option>
                ) : (
                  clienteUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {resolveUserDisplayName(u)} · {normalizeManagedUserEmail(u.email)}
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* Selector de Alcance: PDV Individual vs Cadena Comercial */}
            <div className="md:col-span-3">
              <span className="block text-[11px] font-bold text-zinc-300 mb-1">
                Tipo de Objetivo
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  data-testid="target-type-pdv"
                  onClick={() => setTargetType('PDV')}
                  className={`px-2.5 py-2 rounded-xl border text-[11px] font-bold inline-flex items-center justify-center gap-1 transition cursor-pointer ${
                    targetType === 'PDV'
                      ? 'bg-red-600/20 border-red-500 text-white'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-white'
                  }`}
                >
                  <Store className="w-3.5 h-3.5" />
                  <span>PDV Individual</span>
                </button>
                <button
                  type="button"
                  data-testid="target-type-cadena"
                  onClick={() => setTargetType('CADENA')}
                  className={`px-2.5 py-2 rounded-xl border text-[11px] font-bold inline-flex items-center justify-center gap-1 transition cursor-pointer ${
                    targetType === 'CADENA'
                      ? 'bg-red-600/20 border-red-500 text-white'
                      : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-white'
                  }`}
                >
                  <Building2 className="w-3.5 h-3.5" />
                  <span>Cadena Comercial</span>
                </button>
              </div>
            </div>

            {/* Objetivo Regional (Clientes o Cadenas Comerciales) */}
            <div className="md:col-span-5">
              <label
                htmlFor={`portal-acceso-target-${sucursal}`}
                className="block text-[11px] font-bold text-zinc-300 mb-1"
              >
                {targetType === 'PDV'
                  ? `Punto de Venta Autorizado (${sucursalLabel})`
                  : `Cadena Comercial Autorizada (${sucursalLabel})`}
              </label>
              {targetType === 'PDV' ? (
                <select
                  id={`portal-acceso-target-${sucursal}`}
                  value={selectedClienteId}
                  onChange={(e) => setSelectedClienteId(e.target.value)}
                  disabled={submitting || clientes.length === 0}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer disabled:opacity-60"
                >
                  {clientes.length === 0 ? (
                    <option value="">Sin PDVs activos en {sucursalLabel}</option>
                  ) : (
                    clientes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {resolvePdvDisplayName(c)}
                      </option>
                    ))
                  )}
                </select>
              ) : (
                <select
                  id={`portal-acceso-target-${sucursal}`}
                  value={selectedCadenaId}
                  onChange={(e) => setSelectedCadenaId(e.target.value)}
                  disabled={submitting || cadenas.length === 0}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer disabled:opacity-60"
                >
                  {cadenas.length === 0 ? (
                    <option value="">Sin cadenas comerciales activas en {sucursalLabel}</option>
                  ) : (
                    cadenas.map((cad) => (
                      <option key={cad.id} value={cad.id}>
                        {cad.nombre}
                        {cad.codigo ? ` (${cad.codigo})` : ''}
                      </option>
                    ))
                  )}
                </select>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            <input
              type="text"
              maxLength={300}
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              placeholder="Notas u observaciones de autorización (opcional)..."
              aria-label="Notas de autorización Portal Cliente"
              className="flex-1 px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500"
            />
            <button
              type="submit"
              data-testid="btn-grant-cliente-portal-access"
              disabled={
                submitting ||
                clienteUsers.length === 0 ||
                (targetType === 'PDV' ? clientes.length === 0 : cadenas.length === 0)
              }
              className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-xs font-extrabold text-white inline-flex items-center justify-center gap-1.5 transition cursor-pointer shrink-0"
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              <span>Autorizar Acceso /cliente</span>
            </button>
          </div>
        </form>
      )}

      {/* Tabla de Accesos Registrados en la Región */}
      <div className="rounded-xl border border-white/[0.07] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-zinc-900/70 text-[10px] font-extrabold uppercase tracking-wider text-zinc-400">
                <th className="py-2.5 px-3.5">Usuario Cliente</th>
                <th className="py-2.5 px-3.5">Alcance Autorizado</th>
                <th className="py-2.5 px-3.5">Notas</th>
                <th className="py-2.5 px-3.5">Estado</th>
                <th className="py-2.5 px-3.5 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-zinc-400 font-mono">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                      Sincronizando accesos de {sucursalLabel}...
                    </span>
                  </td>
                </tr>
              ) : accesos.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-7 text-center text-zinc-500">
                    No existen accesos asignados en <span className="font-mono">cliente_portal_accesos</span> para {sucursalLabel}.
                  </td>
                </tr>
              ) : (
                accesos.map((row) => {
                  const userObj = usersById.get(row.user_id);
                  const pdvObj = row.cliente_id ? clientesById.get(row.cliente_id) : undefined;
                  const cadObj = row.cadena_id ? cadenasById.get(row.cadena_id) : undefined;
                  const isRowBusy = togglingId === row.id;

                  return (
                    <tr key={row.id} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 px-3.5 align-middle">
                        <div className="flex items-center gap-1.5 font-semibold text-white">
                          <UserCheck className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          <span>
                            {userObj ? resolveUserDisplayName(userObj) : 'Usuario Cliente'}
                          </span>
                        </div>
                        <span className="text-[11px] font-mono text-zinc-400 block">
                          {userObj ? normalizeManagedUserEmail(userObj.email) : row.user_id}
                        </span>
                      </td>

                      <td className="py-2.5 px-3.5 align-middle">
                        {row.cliente_id ? (
                          <span className="inline-flex items-center gap-1.5 text-zinc-200">
                            <Store className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            <span>
                              PDV: {pdvObj ? resolvePdvDisplayName(pdvObj) : row.cliente_id}
                            </span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-zinc-200">
                            <Building2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                            <span>
                              Cadena: {cadObj ? cadObj.nombre : row.cadena_id || '—'}
                            </span>
                          </span>
                        )}
                      </td>

                      <td className="py-2.5 px-3.5 align-middle text-zinc-400">
                        {row.notas && row.notas.trim() ? row.notas : '—'}
                      </td>

                      <td className="py-2.5 px-3.5 align-middle">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                            row.activo
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                              : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                          }`}
                        >
                          <ShieldCheck className="w-3 h-3" />
                          {row.activo ? 'Activo' : 'Revocado'}
                        </span>
                      </td>

                      <td className="py-2.5 px-3.5 align-middle text-right">
                        {!readOnly && (
                          <button
                            type="button"
                            data-testid={`toggle-acceso-${row.id}`}
                            disabled={isRowBusy}
                            onClick={() => void handleToggleAcceso(row)}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border inline-flex items-center gap-1 transition cursor-pointer disabled:opacity-50 ${
                              row.activo
                                ? 'bg-zinc-900 hover:bg-red-950/60 border-white/10 hover:border-red-500/40 text-zinc-300 hover:text-red-200'
                                : 'bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/35 text-emerald-200'
                            }`}
                          >
                            {isRowBusy ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : row.activo ? (
                              <ToggleRight className="w-3.5 h-3.5 text-red-400" />
                            ) : (
                              <ToggleLeft className="w-3.5 h-3.5 text-emerald-400" />
                            )}
                            <span>{row.activo ? 'Revocar' : 'Reactivar'}</span>
                          </button>
                        )}
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
  );
};
