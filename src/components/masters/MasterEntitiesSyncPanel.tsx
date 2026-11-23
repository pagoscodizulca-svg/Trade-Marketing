/**
 * Panel unificado de sincronización directa BD <-> Pantallas para las 5 Entidades Maestras:
 *   - `regiones`
 *   - `productos` (Catálogo Único Nacional Compartido: lectura global, edición solo `super_admin`)
 *   - `supervisores`
 *   - `promotoras`
 *   - `clientes` (con triage de Cuarentena `region_id IS NULL` exclusivo para `admin@codizulca.com`)
 *
 * Estética corporativa estricta: Negro Obsidiana (#09090B / #121215), Rojo (#DC2626) y Blanco (#FFFFFF).
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Edit3,
  Globe2,
  Lock,
  Package,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { useOptionalApp } from '../../context/AppContext';
import {
  cambiarEstadoProductoMaestro,
  cambiarEstadoPromotoraMaestra,
  cambiarEstadoRegionMaestra,
  cambiarEstadoSupervisorMaestro,
  guardarProductoMaestro,
  guardarPromotoraMaestra,
  guardarRegionMaestra,
  guardarSupervisorMaestro,
  reasignarRegionCliente,
  reasignarRegionPromotora,
  reasignarRegionSupervisor,
} from '../../services/masterCatalogSyncService';
import { isRecordQuarantined } from '../../hooks/useMasterEntitiesSync';
import {
  SUCURSAL_LABELS,
  isOperativeSucursal,
  normalizeSucursalCodigo,
  type ManagedUserRole,
  type OperativeSucursal,
  type SucursalCodigo,
} from '../../services/userManagementService';
import {
  canManageNationalProducts,
  canManageRegiones,
  canTriageQuarantinedRecords,
  isSuperAdminRole,
} from '../../utils/permissions';
import type {
  ClienteConVendedor,
  MasterRegionScopeFilter,
  ProductoMaestro,
  PromotoraCategoriaOficial,
  PromotoraMaestra,
  RegionMaestra,
  SucursalMaestro,
  SupervisorMaestro,
} from '../../types/masterData';
import {
  PROMOTORA_CATEGORIAS,
  classifyPromotoraCategoriaOficial,
  computePromotorasCategoryStats,
  isAllowedRegionCode,
  normalizeRegionName,
  type AllowedRegionCode,
} from '../../utils/regionalSyncClassifier';

export type FiveMasterEntityTab =
  | 'productos'
  | 'clientes'
  | 'promotoras'
  | 'supervisores'
  | 'regiones';

export interface MasterEntitiesSyncPanelQaOverride {
  iamRole: ManagedUserRole;
  userEmail?: string;
  sucursal: SucursalCodigo | null;
  regionId?: string | null;
  regiones: RegionMaestra[];
  productos: ProductoMaestro[];
  supervisores: SupervisorMaestro[];
  promotoras: PromotoraMaestra[];
  clientes: ClienteConVendedor[];
  isRealtimeConnected?: boolean;
  initialTab?: FiveMasterEntityTab;
  initialScope?: MasterRegionScopeFilter;
  onSaveProducto?: (input: {
    id?: string;
    codigo: string;
    nombre: string;
    categoria: string | null;
    marca: string | null;
    unidad_medida: string;
  }) => Promise<void> | void;
  onToggleProducto?: (id: string, nextActive: boolean) => Promise<void> | void;
  onReassignRegion?: (
    entity: 'clientes' | 'promotoras' | 'supervisores',
    id: string,
    regionId: string,
    sucursal: SucursalMaestro
  ) => Promise<void> | void;
}

export interface MasterEntitiesSyncPanelProps {
  qaOverride?: MasterEntitiesSyncPanelQaOverride;
}

function matchesCommercialSearchText(haystack: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
  if (norm(haystack).includes(norm(q))) return true;
  const compact = (s: string) => norm(s).replace(/[^A-Z0-9Ñ]+/g, '');
  const cq = compact(q);
  return cq.length >= 2 && compact(haystack).includes(cq);
}

function resolveRegionLabel(
  row: { region_id?: string | null; sucursal?: string | null; metadata?: Record<string, unknown> },
  regionesById: Map<string, RegionMaestra>
): string {
  if (row.region_id && regionesById.has(row.region_id)) {
    return regionesById.get(row.region_id)!.nombre;
  }
  const metaRegion = normalizeRegionName(row.metadata?.region_codigo);
  if (metaRegion) {
    return metaRegion;
  }
  if (row.sucursal && isOperativeSucursal(row.sucursal)) {
    return SUCURSAL_LABELS[row.sucursal];
  }
  return 'Sin Región (Cuarentena)';
}

function resolveRegionCode(
  row: { region_id?: string | null; sucursal?: string | null; metadata?: Record<string, unknown> },
  regionesById: Map<string, RegionMaestra>
): AllowedRegionCode | SucursalMaestro | null {
  if (row.region_id && regionesById.has(row.region_id)) {
    const rawCode = regionesById.get(row.region_id)!.codigo.trim().toUpperCase();
    if (isAllowedRegionCode(rawCode)) return rawCode;
    const norm = normalizeSucursalCodigo(rawCode);
    if (norm && isOperativeSucursal(norm)) return norm;
  }
  const metaRegion = normalizeRegionName(row.metadata?.region_codigo);
  if (metaRegion) return metaRegion;
  if (row.sucursal && isOperativeSucursal(row.sucursal)) {
    return row.sucursal;
  }
  return null;
}

const MASTER_TABLE_PAGE_SIZE = 100;

export const MasterEntitiesSyncPanel: React.FC<MasterEntitiesSyncPanelProps> = ({ qaOverride }) => {
  const appCtx = useOptionalApp();

  const iamRole: ManagedUserRole | null = qaOverride?.iamRole ?? appCtx?.verifiedIamRole ?? null;
  const verifiedSucursal: SucursalCodigo | null =
    qaOverride !== undefined ? qaOverride.sucursal : (appCtx?.verifiedSucursal ?? null);
  const verifiedRegionId: string | null =
    qaOverride !== undefined ? (qaOverride.regionId ?? null) : (appCtx?.verifiedRegionId ?? null);

  const isSuperAdmin = isSuperAdminRole(iamRole);
  const profileLike = { iamRole };
  const canEditProducts = canManageNationalProducts(profileLike);
  const canEditRegiones = canManageRegiones(profileLike);
  const canTriageQuarantine = canTriageQuarantinedRecords(profileLike);

  const regiones: RegionMaestra[] = qaOverride?.regiones ?? appCtx?.masterEntities.regiones ?? [];
  const productos: ProductoMaestro[] =
    qaOverride?.productos ?? appCtx?.masterEntities.productos ?? [];
  const supervisores: SupervisorMaestro[] =
    qaOverride?.supervisores ?? appCtx?.masterEntities.supervisores ?? [];
  const promotoras: PromotoraMaestra[] =
    qaOverride?.promotoras ?? appCtx?.masterEntities.promotoras ?? [];
  const clientes: ClienteConVendedor[] =
    qaOverride?.clientes ?? appCtx?.masterData.clientes ?? [];
  const isRealtimeConnected: boolean =
    qaOverride?.isRealtimeConnected ?? appCtx?.masterEntities.isRealtimeConnected ?? false;
  const syncError: string | null =
    qaOverride !== undefined
      ? null
      : appCtx?.masterEntities.error || appCtx?.masterData.error || null;
  const isSyncLoading: boolean =
    qaOverride !== undefined
      ? false
      : Boolean(appCtx?.masterEntities.isLoading || appCtx?.masterData.cargando);

  const [activeTab, setActiveTab] = useState<FiveMasterEntityTab>(
    qaOverride?.initialTab ?? 'productos'
  );
  const [scopeFilter, setScopeFilter] = useState<MasterRegionScopeFilter>(() => {
    if (qaOverride?.initialScope) return qaOverride.initialScope;
    if (isSuperAdmin) {
      return appCtx?.activeRegionScope ?? 'ALL';
    }
    const official = normalizeRegionName(verifiedSucursal);
    return official ?? ((verifiedSucursal as SucursalMaestro) || 'OCCIDENTE');
  });
  const [search, setSearch] = useState('');
  const [tablePage, setTablePage] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [assignDrafts, setAssignDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (qaOverride !== undefined || !isSuperAdmin) return;
    if (appCtx?.activeRegionScope && scopeFilter !== 'UNASSIGNED') {
      setScopeFilter(appCtx.activeRegionScope);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appCtx?.activeRegionScope, isSuperAdmin, qaOverride]);

  useEffect(() => {
    setTablePage(0);
  }, [activeTab, scopeFilter, search]);

  // Modal Producto Nacional (solo super_admin)
  const [prodModalOpen, setProdModalOpen] = useState(false);
  const [editingProdId, setEditingProdId] = useState<string | undefined>(undefined);
  const [prodCodigo, setProdCodigo] = useState('');
  const [prodNombre, setProdNombre] = useState('');
  const [prodCategoria, setProdCategoria] = useState('');
  const [prodMarca, setProdMarca] = useState('');
  const [prodUnidad, setProdUnidad] = useState('KG');

  // Modal Región (solo super_admin)
  const [regModalOpen, setRegModalOpen] = useState(false);
  const [editingRegId, setEditingRegId] = useState<string | undefined>(undefined);
  const [regCodigo, setRegCodigo] = useState('');
  const [regNombre, setRegNombre] = useState('');

  // Modal Supervisor
  const [supModalOpen, setSupModalOpen] = useState(false);
  const [editingSupId, setEditingSupId] = useState<string | undefined>(undefined);
  const [supCodigo, setSupCodigo] = useState('');
  const [supNombre, setSupNombre] = useState('');
  const [supEmail, setSupEmail] = useState('');
  const [supTelefono, setSupTelefono] = useState('');
  const [supZona, setSupZona] = useState('');
  const [supRegionId, setSupRegionId] = useState('');

  // Modal Promotora
  const [promModalOpen, setPromModalOpen] = useState(false);
  const [editingPromId, setEditingPromId] = useState<string | undefined>(undefined);
  const [promNombre, setPromNombre] = useState('');
  const [promEmail, setPromEmail] = useState('');
  const [promTelefono, setPromTelefono] = useState('');
  const [promCiudad, setPromCiudad] = useState('');
  const [promCategoria, setPromCategoria] = useState<PromotoraCategoriaOficial>('Fijas');
  const [promRegionId, setPromRegionId] = useState('');
  const [promSupervisorId, setPromSupervisorId] = useState('');
  const [promCategoryFilter, setPromCategoryFilter] = useState<
    'TODAS' | PromotoraCategoriaOficial
  >('TODAS');

  const regionesById = useMemo(
    () => new Map(regiones.map((r) => [r.id, r])),
    [regiones]
  );

  const lockedRegionalLabel = useMemo(() => {
    if (verifiedRegionId && regionesById.has(verifiedRegionId)) {
      return `Sucursal ${regionesById.get(verifiedRegionId)!.nombre}`;
    }
    if (verifiedSucursal && isOperativeSucursal(verifiedSucursal)) {
      return SUCURSAL_LABELS[verifiedSucursal];
    }
    return 'Sucursal Asignada';
  }, [verifiedRegionId, verifiedSucursal, regionesById]);

  const quarantinedCounts = useMemo(() => {
    const cliQ = clientes.filter((c) => isRecordQuarantined(c)).length;
    const promQ = promotoras.filter((p) => isRecordQuarantined(p)).length;
    const supQ = supervisores.filter((s) => isRecordQuarantined(s)).length;
    return {
      clientes: cliQ,
      promotoras: promQ,
      supervisores: supQ,
      total: cliQ + promQ + supQ,
    };
  }, [clientes, promotoras, supervisores]);

  const matchesRegionalScope = (row: {
    region_id?: string | null;
    sucursal?: string | null;
    metadata?: Record<string, unknown>;
  }): boolean => {
    // Regla fail-closed en defensa en profundidad: un usuario no-super_admin jamás ve filas sin región
    if (!isSuperAdmin) {
      if (isRecordQuarantined(row)) return false;
      if (verifiedRegionId && row.region_id) {
        return row.region_id === verifiedRegionId;
      }
      if (verifiedSucursal && isOperativeSucursal(verifiedSucursal)) {
        const code = resolveRegionCode(row, regionesById);
        if (code === verifiedSucursal) return true;
        const verifiedOfficial = normalizeRegionName(verifiedSucursal);
        const rowOfficial = normalizeRegionName(code);
        return Boolean(verifiedOfficial && rowOfficial && verifiedOfficial === rowOfficial);
      }
      return false;
    }

    if (scopeFilter === 'ALL') return true;
    if (scopeFilter === 'UNASSIGNED') return isRecordQuarantined(row);
    const code = resolveRegionCode(row, regionesById);
    if (code === scopeFilter) return true;
    const targetOfficial = normalizeRegionName(scopeFilter);
    const rowOfficial = normalizeRegionName(code);
    return Boolean(targetOfficial && rowOfficial && targetOfficial === rowOfficial);
  };

  const q = search.trim();

  const visibleProductos = useMemo(() => {
    return productos.filter((p) => {
      if (!q) return true;
      return matchesCommercialSearchText(
        `${p.codigo} ${p.nombre} ${p.categoria || ''} ${p.marca || ''} ${String(p.metadata?.regiones ?? '')}`,
        q
      );
    });
  }, [productos, q]);

  const visibleClientes = useMemo(() => {
    return clientes.filter((c) => {
      if (!matchesRegionalScope(c)) return false;
      if (!q) return true;
      return matchesCommercialSearchText(
        `${c.codigo_cliente} ${c.razon_social} ${c.nombre_comercial || ''} ${c.rif || ''} ${c.ciudad || ''} ${c.zona || ''} ${c.vendedor?.nombre_completo || ''}`,
        q
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientes, q, scopeFilter, isSuperAdmin, verifiedRegionId, verifiedSucursal, regionesById]);

  const scopedPromotoras = useMemo(() => {
    return promotoras.filter((p) => {
      if (!matchesRegionalScope(p)) return false;
      if (!q) return true;
      const cat = classifyPromotoraCategoriaOficial(p as unknown as Record<string, unknown>);
      return matchesCommercialSearchText(
        `${p.nombre_completo} ${p.email || ''} ${p.ciudad || ''} ${p.estado || ''} ${p.direccion || ''} ${cat}`,
        q
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promotoras, q, scopeFilter, isSuperAdmin, verifiedRegionId, verifiedSucursal, regionesById]);

  const promotoraCategoryStats = useMemo(
    () =>
      computePromotorasCategoryStats(
        scopedPromotoras as unknown as Array<Record<string, unknown>>
      ),
    [scopedPromotoras]
  );

  const visiblePromotoras = useMemo(() => {
    if (promCategoryFilter === 'TODAS') return scopedPromotoras;
    return scopedPromotoras.filter(
      (p) =>
        classifyPromotoraCategoriaOficial(p as unknown as Record<string, unknown>) ===
        promCategoryFilter
    );
  }, [scopedPromotoras, promCategoryFilter]);

  const visibleSupervisores = useMemo(() => {
    return supervisores.filter((s) => {
      if (!matchesRegionalScope(s)) return false;
      if (!q) return true;
      return matchesCommercialSearchText(
        `${s.codigo || ''} ${s.nombre} ${s.email || ''} ${s.telefono || ''} ${s.zona || ''}`,
        q
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supervisores, q, scopeFilter, isSuperAdmin, verifiedRegionId, verifiedSucursal, regionesById]);

  const visibleRegiones = useMemo(() => {
    const base = isSuperAdmin
      ? regiones
      : regiones.filter((r) => {
          if (verifiedRegionId) return r.id === verifiedRegionId;
          if (verifiedSucursal && isOperativeSucursal(verifiedSucursal)) {
            const officialReg = normalizeRegionName(r.codigo);
            const officialVer = normalizeRegionName(verifiedSucursal);
            return (
              normalizeSucursalCodigo(r.codigo) === verifiedSucursal ||
              Boolean(officialReg && officialVer && officialReg === officialVer)
            );
          }
          return false;
        });
    if (!q) return base;
    return base.filter((r) => matchesCommercialSearchText(`${r.codigo} ${r.nombre}`, q));
  }, [isSuperAdmin, regiones, verifiedRegionId, verifiedSucursal, q]);

  const pagedProductos = useMemo(
    () =>
      visibleProductos.slice(
        tablePage * MASTER_TABLE_PAGE_SIZE,
        (tablePage + 1) * MASTER_TABLE_PAGE_SIZE
      ),
    [visibleProductos, tablePage]
  );

  const pagedClientes = useMemo(
    () =>
      visibleClientes.slice(
        tablePage * MASTER_TABLE_PAGE_SIZE,
        (tablePage + 1) * MASTER_TABLE_PAGE_SIZE
      ),
    [visibleClientes, tablePage]
  );

  // Supervisores compatibles con la región elegida en el modal de Promotora (evita cruce en UI)
  const sameRegionSupervisores = useMemo(() => {
    const targetRegionId = isSuperAdmin ? promRegionId : verifiedRegionId;
    return supervisores.filter((s) => {
      if (!s.activo) return false;
      if (!targetRegionId) return false;
      return s.region_id === targetRegionId;
    });
  }, [supervisores, isSuperAdmin, promRegionId, verifiedRegionId]);

  const flashNotice = (kind: 'ok' | 'err', text: string) => {
    setNotice({ kind, text });
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        setNotice((cur) => (cur?.text === text ? null : cur));
      }, 5000);
    }
  };

  const handleRefreshNow = async () => {
    setBusyKey('refresh');
    try {
      const [entRes, dataRes] = await Promise.all([
        appCtx?.masterEntities.refresh(true),
        appCtx?.masterData.refrescar(),
      ]);
      const errors = [entRes?.error, dataRes?.error].filter(Boolean);
      if (errors.length > 0) {
        flashNotice('err', `Error revalidando Data Maestra: ${errors.join(' · ')}`);
      } else {
        flashNotice('ok', 'Entidades maestras sincronizadas en vivo desde Supabase.');
      }
    } catch (err) {
      flashNotice('err', err instanceof Error ? err.message : 'No se pudo refrescar.');
    } finally {
      setBusyKey(null);
    }
  };

  const openProductoModal = (prod?: ProductoMaestro) => {
    if (!canEditProducts) return;
    setEditingProdId(prod?.id);
    setProdCodigo(prod?.codigo || '');
    setProdNombre(prod?.nombre || '');
    setProdCategoria(prod?.categoria || '');
    setProdMarca(prod?.marca || '');
    setProdUnidad(prod?.unidad_medida || 'KG');
    setProdModalOpen(true);
  };

  const handleSubmitProducto = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEditProducts) return;
    setBusyKey('save_prod');
    try {
      if (qaOverride?.onSaveProducto) {
        await qaOverride.onSaveProducto({
          id: editingProdId,
          codigo: prodCodigo,
          nombre: prodNombre,
          categoria: prodCategoria || null,
          marca: prodMarca || null,
          unidad_medida: prodUnidad || 'KG',
        });
      } else {
        await guardarProductoMaestro({
          id: editingProdId,
          codigo: prodCodigo,
          nombre: prodNombre,
          categoria: prodCategoria || null,
          marca: prodMarca || null,
          unidad_medida: prodUnidad || 'KG',
        });
      }
      setProdModalOpen(false);
      flashNotice('ok', 'Catálogo nacional de productos actualizado y sincronizado.');
    } catch (err) {
      flashNotice('err', err instanceof Error ? err.message : 'No se pudo guardar el producto.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleProducto = async (prod: ProductoMaestro) => {
    if (!canEditProducts) return;
    setBusyKey(`prod:${prod.id}`);
    try {
      if (qaOverride?.onToggleProducto) {
        await qaOverride.onToggleProducto(prod.id, !prod.activo);
      } else {
        await cambiarEstadoProductoMaestro(prod.id, !prod.activo);
      }
      flashNotice('ok', `Producto ${prod.activo ? 'desactivado' : 'reactivado'} en catálogo nacional.`);
    } catch (err) {
      flashNotice('err', err instanceof Error ? err.message : 'Error actualizando producto.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSubmitRegion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEditRegiones) return;
    setBusyKey('save_reg');
    try {
      await guardarRegionMaestra({
        id: editingRegId,
        codigo: regCodigo,
        nombre: regNombre,
      });
      setRegModalOpen(false);
      flashNotice('ok', 'Catálogo de regiones actualizado en Supabase.');
    } catch (err) {
      flashNotice('err', err instanceof Error ? err.message : 'No se pudo guardar la región.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSubmitSupervisor = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyKey('save_sup');
    try {
      const targetRegion = regionesById.get(supRegionId);
      const sucursal = targetRegion
        ? (normalizeSucursalCodigo(targetRegion.codigo) as OperativeSucursal | null)
        : isOperativeSucursal(verifiedSucursal)
          ? verifiedSucursal
          : null;
      await guardarSupervisorMaestro({
        id: editingSupId,
        codigo: supCodigo || null,
        nombre: supNombre,
        email: supEmail || null,
        telefono: supTelefono || null,
        zona: supZona || null,
        region_id: isSuperAdmin ? supRegionId || null : verifiedRegionId,
        sucursal,
      });
      setSupModalOpen(false);
      flashNotice('ok', 'Supervisor guardado en la región correspondiente.');
    } catch (err) {
      flashNotice('err', err instanceof Error ? err.message : 'No se pudo guardar el supervisor.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSubmitPromotora = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyKey('save_prom');
    try {
      const targetRegion = regionesById.get(promRegionId);
      const sucursal = targetRegion
        ? (normalizeSucursalCodigo(targetRegion.codigo) as OperativeSucursal | null)
        : isOperativeSucursal(verifiedSucursal)
          ? verifiedSucursal
          : null;
      await guardarPromotoraMaestra({
        id: editingPromId,
        nombre_completo: promNombre,
        email: promEmail || null,
        telefono: promTelefono || null,
        ciudad: promCiudad || null,
        categoria: promCategoria,
        region_id: isSuperAdmin ? promRegionId || null : verifiedRegionId,
        sucursal,
        supervisor_id: promSupervisorId || null,
      });
      setPromModalOpen(false);
      flashNotice('ok', 'Promotora sincronizada correctamente.');
    } catch (err) {
      flashNotice('err', err instanceof Error ? err.message : 'No se pudo guardar la promotora.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleAssignQuarantinedRegion = async (
    entity: 'clientes' | 'promotoras' | 'supervisores',
    rowId: string
  ) => {
    if (!canTriageQuarantine) return;
    const selectedRegionId = assignDrafts[`${entity}:${rowId}`];
    if (!selectedRegionId) {
      flashNotice('err', 'Selecciona una región destino antes de asignar.');
      return;
    }
    const region = regionesById.get(selectedRegionId);
    const normSucursal = region ? normalizeSucursalCodigo(region.codigo) : null;
    if (!region || !normSucursal || !isOperativeSucursal(normSucursal)) {
      flashNotice('err', 'La región seleccionada no posee un código de sucursal válido.');
      return;
    }

    setBusyKey(`assign:${entity}:${rowId}`);
    try {
      if (qaOverride?.onReassignRegion) {
        await qaOverride.onReassignRegion(entity, rowId, region.id, normSucursal);
      } else if (entity === 'clientes') {
        await reasignarRegionCliente(rowId, region.id, normSucursal);
      } else if (entity === 'promotoras') {
        await reasignarRegionPromotora(rowId, region.id, normSucursal);
      } else {
        await reasignarRegionSupervisor(rowId, region.id, normSucursal);
      }
      flashNotice('ok', `Registro clasificado en ${region.nombre} y sincronizado en tiempo real.`);
    } catch (err) {
      flashNotice('err', err instanceof Error ? err.message : 'No se pudo reclasificar el registro.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section
      data-testid="master-entities-sync-panel"
      aria-label="Sincronización BD y Entidades Maestras por Región"
      className="rounded-2xl bg-[#121215] border border-zinc-800 p-5 space-y-4 text-white"
    >
      {/* Encabezado y estado Realtime */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#DC2626] text-white text-[10px] font-mono font-black uppercase tracking-wider">
              <Database className="w-3 h-3" />
              Sincronización Directa BD ↔ Pantallas
            </span>
            <span
              data-testid="master-realtime-status"
              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#09090B] border border-zinc-700 text-[10px] font-mono font-bold text-white"
            >
              <Radio
                className={`w-3 h-3 ${isRealtimeConnected ? 'text-red-500 animate-pulse' : 'text-zinc-400'}`}
              />
              {isRealtimeConnected ? 'Realtime Activo' : 'Sincronizado BD'}
            </span>
          </div>
          <h3 className="text-lg font-extrabold text-white tracking-tight">
            Entidades Maestras · Regiones, Supervisores, Promotoras, Clientes y Productos
          </h3>
          <p className="text-xs text-zinc-400">
            {isSuperAdmin
              ? 'Vista Global de Administrador General: gestiona todas las sucursales, el catálogo nacional de productos y clasifica registros históricos en cuarentena.'
              : 'Aislamiento estricto PostgreSQL RLS por región asignada. El catálogo nacional de productos es compartido en modo solo lectura.'}
          </p>
        </div>

        <button
          type="button"
          data-testid="btn-revalidar-bd"
          onClick={() => void handleRefreshNow()}
          disabled={busyKey === 'refresh' || isSyncLoading}
          className="px-3 py-2 rounded-xl bg-[#09090B] hover:bg-zinc-900 border border-zinc-700 text-xs font-bold text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 text-red-500 ${busyKey === 'refresh' || isSyncLoading ? 'animate-spin' : ''}`}
          />
          <span>{busyKey === 'refresh' || isSyncLoading ? 'Sincronizando...' : 'Revalidar BD'}</span>
        </button>
      </div>

      {/* Banner persistente de error real con botón Reintentar (cero silencios) */}
      {syncError && (
        <div
          role="alert"
          data-testid="master-sync-error-banner"
          className="rounded-xl px-3.5 py-3 text-xs font-semibold flex flex-wrap items-center justify-between gap-3 border bg-red-950/75 border-red-500 text-red-100"
        >
          <div className="flex items-start gap-2 min-w-0 flex-1">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span className="break-words">{syncError}</span>
          </div>
          <button
            type="button"
            data-testid="btn-retry-master-sync"
            onClick={() => void handleRefreshNow()}
            className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[11px] font-extrabold shrink-0 cursor-pointer"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Aviso de feedback */}
      {notice && (
        <div
          role="status"
          data-testid="master-sync-notice"
          className={`rounded-xl px-3.5 py-2.5 text-xs font-semibold flex items-center gap-2 border ${
            notice.kind === 'ok'
              ? 'bg-[#09090B] border-red-500/50 text-white'
              : 'bg-red-950/60 border-red-500 text-red-100'
          }`}
        >
          {notice.kind === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 text-red-500 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      {/* Barra de Alcance Regional por Rol */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#09090B] border border-zinc-800 p-3">
        {isSuperAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-mono font-bold uppercase text-zinc-400 inline-flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-red-500" />
              Alcance Regional:
            </span>
            <select
              data-testid="master-scope-select"
              aria-label="Filtrar entidades maestras por región"
              value={scopeFilter}
              onChange={(e) => {
                const next = e.target.value as MasterRegionScopeFilter;
                setScopeFilter(next);
                if (qaOverride === undefined && appCtx?.setActiveRegionScope) {
                  if (next === 'ALL' || isAllowedRegionCode(next)) {
                    appCtx.setActiveRegionScope(next);
                  } else if (next !== 'UNASSIGNED') {
                    const mapped = normalizeRegionName(next);
                    if (mapped) appCtx.setActiveRegionScope(mapped);
                  }
                }
              }}
              className="px-3 py-1.5 rounded-lg bg-[#121215] border border-zinc-700 text-xs font-bold text-white focus:outline-none focus:border-red-500 cursor-pointer"
            >
              <option value="ALL">Todas las Regiones</option>
              {regiones.map((reg) => {
                const rawUpper = reg.codigo.trim().toUpperCase();
                const norm = normalizeSucursalCodigo(reg.codigo);
                const val = isAllowedRegionCode(rawUpper)
                  ? rawUpper
                  : norm && isOperativeSucursal(norm)
                    ? norm
                    : reg.codigo;
                const optionLabel = isAllowedRegionCode(rawUpper)
                  ? `Región ${reg.nombre}`
                  : `Sucursal ${reg.nombre}`;
                return (
                  <option key={reg.id} value={val}>
                    {optionLabel}
                  </option>
                );
              })}
              <option value="UNASSIGNED">
                Sin Región Asignada ({quarantinedCounts.total})
              </option>
            </select>

            {canTriageQuarantine && quarantinedCounts.total > 0 && (
              <button
                type="button"
                data-testid="master-quarantine-badge"
                onClick={() => {
                  setScopeFilter('UNASSIGNED');
                  if (activeTab === 'productos' || activeTab === 'regiones') {
                    setActiveTab(
                      quarantinedCounts.clientes > 0
                        ? 'clientes'
                        : quarantinedCounts.promotoras > 0
                          ? 'promotoras'
                          : 'supervisores'
                    );
                  }
                }}
                className="px-2.5 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/35 border border-red-500/60 text-[11px] font-mono font-bold text-white inline-flex items-center gap-1.5 cursor-pointer"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                <span>
                  Cuarentena: {quarantinedCounts.total} sin región asignada
                </span>
              </button>
            )}
          </div>
        ) : (
          <div
            data-testid="master-locked-region-badge"
            className="inline-flex items-center gap-2 text-xs font-bold text-white"
          >
            <Lock className="w-3.5 h-3.5 text-red-500 shrink-0" />
            <span>{lockedRegionalLabel}</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#121215] border border-zinc-700 text-zinc-300">
              Aislamiento RLS estricto
            </span>
          </div>
        )}

        <div className="relative min-w-[220px] flex-1 sm:flex-initial">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar en entidad activa..."
            aria-label="Buscar en entidad maestra activa"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[#121215] border border-zinc-700 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500"
          />
        </div>
      </div>

      {/* Pestañas de las 5 Entidades Maestras */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Entidades Maestras" className="flex flex-wrap gap-1.5">
          {(
            [
              { id: 'productos', label: 'Productos (Nacional)', count: visibleProductos.length, icon: Package },
              { id: 'clientes', label: 'Clientes', count: visibleClientes.length, icon: Store },
              { id: 'promotoras', label: 'Promotoras', count: visiblePromotoras.length, icon: UserCheck },
              { id: 'supervisores', label: 'Supervisores', count: visibleSupervisores.length, icon: Users },
              { id: 'regiones', label: 'Regiones', count: visibleRegiones.length, icon: Globe2 },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`master-5-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 border transition cursor-pointer ${
                  selected
                    ? 'bg-[#DC2626] text-white border-red-500'
                    : 'bg-[#09090B] text-zinc-300 border-zinc-800 hover:border-zinc-600 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono ${
                    selected ? 'bg-black/30 text-white' : 'bg-zinc-900 text-zinc-400'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Botón Crear contextual (desmontado del DOM si el rol no tiene permiso de escritura) */}
        <div className="flex items-center gap-2">
          {activeTab === 'productos' && canEditProducts && (
            <button
              type="button"
              data-testid="btn-nuevo-producto"
              onClick={() => openProductoModal()}
              className="px-3 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-500 text-white text-xs font-extrabold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nuevo Producto Nacional</span>
            </button>
          )}
          {activeTab === 'productos' && !canEditProducts && (
            <span
              data-testid="productos-readonly-badge"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#09090B] border border-zinc-700 text-[11px] font-mono text-zinc-300"
            >
              <Lock className="w-3 h-3 text-red-500" />
              Catálogo Nacional · Solo Lectura
            </span>
          )}
          {activeTab === 'regiones' && canEditRegiones && (
            <button
              type="button"
              data-testid="btn-nueva-region"
              onClick={() => {
                setEditingRegId(undefined);
                setRegCodigo('');
                setRegNombre('');
                setRegModalOpen(true);
              }}
              className="px-3 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-500 text-white text-xs font-extrabold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nueva Región</span>
            </button>
          )}
          {activeTab === 'supervisores' && (
            <button
              type="button"
              data-testid="btn-nuevo-supervisor"
              onClick={() => {
                setEditingSupId(undefined);
                setSupCodigo('');
                setSupNombre('');
                setSupEmail('');
                setSupTelefono('');
                setSupZona('');
                setSupRegionId(verifiedRegionId || regiones[0]?.id || '');
                setSupModalOpen(true);
              }}
              className="px-3 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-500 text-white text-xs font-extrabold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nuevo Supervisor</span>
            </button>
          )}
          {activeTab === 'promotoras' && (
            <button
              type="button"
              data-testid="btn-nueva-promotora"
              onClick={() => {
                setEditingPromId(undefined);
                setPromNombre('');
                setPromEmail('');
                setPromTelefono('');
                setPromCiudad('');
                setPromCategoria('Fijas');
                setPromRegionId(verifiedRegionId || regiones[0]?.id || '');
                setPromSupervisorId('');
                setPromModalOpen(true);
              }}
              className="px-3 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-500 text-white text-xs font-extrabold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nueva Promotora</span>
            </button>
          )}
        </div>
      </div>

      {/* Tabla Activa */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-[#09090B]">
        {activeTab === 'productos' && (
          <table className="w-full text-left text-xs" data-testid="table-master-productos">
            <thead>
              <tr className="border-b border-zinc-800 text-[10px] uppercase font-mono text-zinc-400">
                <th className="px-3 py-2.5">Código</th>
                <th className="px-3 py-2.5">Producto</th>
                <th className="px-3 py-2.5">Categoría / Marca</th>
                <th className="px-3 py-2.5">Unidad</th>
                <th className="px-3 py-2.5">Estado</th>
                {canEditProducts && <th className="px-3 py-2.5 text-right">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {visibleProductos.length === 0 ? (
                <tr>
                  <td colSpan={canEditProducts ? 6 : 5} className="px-4 py-8 text-center text-zinc-500">
                    Sin productos sincronizados para este filtro.
                  </td>
                </tr>
              ) : (
                pagedProductos.map((prod) => (
                  <tr key={prod.id} className="hover:bg-[#121215]">
                    <td className="px-3 py-2.5 font-mono font-bold text-red-400">{prod.codigo || '—'}</td>
                    <td className="px-3 py-2.5 font-bold text-white">{prod.nombre}</td>
                    <td className="px-3 py-2.5 text-zinc-300">
                      {[prod.categoria, prod.marca].filter(Boolean).join(' · ') || 'General'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-zinc-300">{prod.unidad_medida}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                          prod.activo
                            ? 'bg-white text-[#09090B] border-white'
                            : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                        }`}
                      >
                        {prod.activo ? 'ACTIVO' : 'INACTIVO'}
                      </span>
                    </td>
                    {canEditProducts && (
                      <td className="px-3 py-2.5 text-right space-x-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          data-testid={`btn-edit-producto-${prod.id}`}
                          onClick={() => openProductoModal(prod)}
                          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-white cursor-pointer"
                          title="Editar producto nacional"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`btn-toggle-producto-${prod.id}`}
                          disabled={busyKey === `prod:${prod.id}`}
                          onClick={() => void handleToggleProducto(prod)}
                          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-red-950/70 border border-zinc-700 hover:border-red-500 text-zinc-200 cursor-pointer disabled:opacity-50"
                          title={prod.activo ? 'Desactivar producto' : 'Reactivar producto'}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeTab === 'clientes' && (
          <table className="w-full text-left text-xs" data-testid="table-master-clientes">
            <thead>
              <tr className="border-b border-zinc-800 text-[10px] uppercase font-mono text-zinc-400">
                <th className="px-3 py-2.5">Código</th>
                <th className="px-3 py-2.5">Cliente / PDV</th>
                <th className="px-3 py-2.5">Ubicación</th>
                <th className="px-3 py-2.5">Región</th>
                {canTriageQuarantine && <th className="px-3 py-2.5 text-right">Clasificación</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {visibleClientes.length === 0 ? (
                <tr>
                  <td colSpan={canTriageQuarantine ? 5 : 4} className="px-4 py-8 text-center text-zinc-500">
                    Sin clientes visibles en este alcance regional.
                  </td>
                </tr>
              ) : (
                pagedClientes.map((cli) => {
                  const quarantined = isRecordQuarantined(cli);
                  const draftKey = `clientes:${cli.id}`;
                  return (
                    <tr key={cli.id} className="hover:bg-[#121215]">
                      <td className="px-3 py-2.5 font-mono font-bold text-red-400">{cli.codigo_cliente}</td>
                      <td className="px-3 py-2.5 font-bold text-white">
                        {cli.nombre_comercial || cli.razon_social}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-400">
                        {[cli.ciudad, cli.zona].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                            quarantined
                              ? 'bg-red-600/25 text-red-200 border-red-500'
                              : 'bg-zinc-900 text-white border-zinc-700'
                          }`}
                        >
                          {resolveRegionLabel(cli, regionesById)}
                        </span>
                      </td>
                      {canTriageQuarantine && (
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {quarantined ? (
                            <div className="inline-flex items-center gap-1.5">
                              <select
                                data-testid={`select-assign-region-cliente-${cli.id}`}
                                value={assignDrafts[draftKey] || ''}
                                onChange={(e) =>
                                  setAssignDrafts((prev) => ({ ...prev, [draftKey]: e.target.value }))
                                }
                                className="px-2 py-1 rounded-lg bg-[#121215] border border-zinc-700 text-[11px] text-white"
                              >
                                <option value="">Elegir región...</option>
                                {regiones.map((reg) => (
                                  <option key={reg.id} value={reg.id}>
                                    {reg.nombre}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                data-testid={`btn-assign-region-cliente-${cli.id}`}
                                disabled={busyKey === `assign:${draftKey}`}
                                onClick={() => void handleAssignQuarantinedRegion('clientes', cli.id)}
                                className="px-2.5 py-1 rounded-lg bg-[#DC2626] hover:bg-red-500 text-white text-[11px] font-extrabold cursor-pointer disabled:opacity-50"
                              >
                                Asignar
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] font-mono text-zinc-500">Clasificado</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {activeTab === 'promotoras' && (
          <div className="space-y-3 p-3">
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Filtrar promotoras por categoría"
              data-testid="promotoras-category-filter-bar"
            >
              {(
                [
                  { id: 'TODAS', label: 'Todas', count: promotoraCategoryStats.total },
                  { id: 'Fijas', label: 'Fijas', count: promotoraCategoryStats.Fijas },
                  {
                    id: 'Eventuales',
                    label: 'Eventuales',
                    count: promotoraCategoryStats.Eventuales,
                  },
                  {
                    id: 'Merchandising',
                    label: 'Merchandising',
                    count: promotoraCategoryStats.Merchandising,
                  },
                ] as const
              ).map((pill) => {
                const active = promCategoryFilter === pill.id;
                return (
                  <button
                    key={pill.id}
                    type="button"
                    data-testid={`filter-promotoras-categoria-${pill.id}`}
                    onClick={() => setPromCategoryFilter(pill.id)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold inline-flex items-center gap-1.5 border transition cursor-pointer ${
                      active
                        ? 'bg-[#DC2626] text-white border-red-500'
                        : 'bg-[#121215] text-zinc-300 border-zinc-800 hover:border-zinc-600'
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

            <table className="w-full text-left text-xs" data-testid="table-master-promotoras">
              <thead>
                <tr className="border-b border-zinc-800 text-[10px] uppercase font-mono text-zinc-400">
                  <th className="px-3 py-2.5">Promotora</th>
                  <th className="px-3 py-2.5">Categoría</th>
                  <th className="px-3 py-2.5">Correo</th>
                  <th className="px-3 py-2.5">Ciudad / Estado</th>
                  <th className="px-3 py-2.5">Región</th>
                  <th className="px-3 py-2.5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {visiblePromotoras.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                      Sin promotoras registradas en este alcance regional y categoría.
                    </td>
                  </tr>
                ) : (
                  visiblePromotoras.map((prom) => {
                    const quarantined = isRecordQuarantined(prom);
                    const draftKey = `promotoras:${prom.id}`;
                    const cat = classifyPromotoraCategoriaOficial(
                      prom as unknown as Record<string, unknown>
                    );
                    const catBadgeClass =
                      cat === 'Fijas'
                        ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                        : cat === 'Eventuales'
                          ? 'bg-amber-500/15 text-amber-200 border-amber-500/40'
                          : 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40';
                    return (
                      <tr key={prom.id} className="hover:bg-[#121215]">
                        <td className="px-3 py-2.5 font-bold text-white">{prom.nombre_completo}</td>
                        <td className="px-3 py-2.5">
                          <span
                            data-testid={`badge-promotora-categoria-${prom.id}`}
                            className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${catBadgeClass}`}
                          >
                            {cat}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-zinc-300">{prom.email || '—'}</td>
                        <td className="px-3 py-2.5 text-zinc-400">
                          {[prom.ciudad, prom.estado].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                              quarantined
                                ? 'bg-red-600/25 text-red-200 border-red-500'
                                : 'bg-zinc-900 text-white border-zinc-700'
                            }`}
                          >
                            {resolveRegionLabel(prom, regionesById)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {quarantined && canTriageQuarantine ? (
                            <div className="inline-flex items-center gap-1.5">
                              <select
                                data-testid={`select-assign-region-promotora-${prom.id}`}
                                value={assignDrafts[draftKey] || ''}
                                onChange={(e) =>
                                  setAssignDrafts((prev) => ({
                                    ...prev,
                                    [draftKey]: e.target.value,
                                  }))
                                }
                                className="px-2 py-1 rounded-lg bg-[#121215] border border-zinc-700 text-[11px] text-white"
                              >
                                <option value="">Elegir región...</option>
                                {regiones.map((reg) => (
                                  <option key={reg.id} value={reg.id}>
                                    {reg.nombre}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                data-testid={`btn-assign-region-promotora-${prom.id}`}
                                disabled={busyKey === `assign:${draftKey}`}
                                onClick={() =>
                                  void handleAssignQuarantinedRegion('promotoras', prom.id)
                                }
                                className="px-2.5 py-1 rounded-lg bg-[#DC2626] hover:bg-red-500 text-white text-[11px] font-extrabold cursor-pointer disabled:opacity-50"
                              >
                                Asignar
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingPromId(prom.id);
                                  setPromNombre(prom.nombre_completo);
                                  setPromEmail(prom.email || '');
                                  setPromTelefono(prom.telefono || '');
                                  setPromCiudad(prom.ciudad || '');
                                  setPromCategoria(cat);
                                  setPromRegionId(
                                    prom.region_id || verifiedRegionId || regiones[0]?.id || ''
                                  );
                                  setPromSupervisorId(prom.supervisor_id || '');
                                  setPromModalOpen(true);
                                }}
                                className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-white cursor-pointer"
                                title="Editar promotora"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void cambiarEstadoPromotoraMaestra(prom.id, !prom.activo)
                                }
                                className="p-1.5 rounded-lg bg-zinc-900 hover:bg-red-950/70 border border-zinc-700 text-zinc-200 cursor-pointer"
                                title={prom.activo ? 'Desactivar promotora' : 'Reactivar promotora'}
                              >
                                <Power className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'supervisores' && (
          <table className="w-full text-left text-xs" data-testid="table-master-supervisores">
            <thead>
              <tr className="border-b border-zinc-800 text-[10px] uppercase font-mono text-zinc-400">
                <th className="px-3 py-2.5">Supervisor</th>
                <th className="px-3 py-2.5">Correo</th>
                <th className="px-3 py-2.5">Zona</th>
                <th className="px-3 py-2.5">Región</th>
                <th className="px-3 py-2.5 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {visibleSupervisores.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    Sin supervisores registrados en este alcance regional.
                  </td>
                </tr>
              ) : (
                visibleSupervisores.map((sup) => {
                  const quarantined = isRecordQuarantined(sup);
                  const draftKey = `supervisores:${sup.id}`;
                  return (
                    <tr key={sup.id} className="hover:bg-[#121215]">
                      <td className="px-3 py-2.5 font-bold text-white">{sup.nombre}</td>
                      <td className="px-3 py-2.5 font-mono text-zinc-300">{sup.email || '—'}</td>
                      <td className="px-3 py-2.5 text-zinc-400">{sup.zona || '—'}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                            quarantined
                              ? 'bg-red-600/25 text-red-200 border-red-500'
                              : 'bg-zinc-900 text-white border-zinc-700'
                          }`}
                        >
                          {resolveRegionLabel(sup, regionesById)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {quarantined && canTriageQuarantine ? (
                          <div className="inline-flex items-center gap-1.5">
                            <select
                              data-testid={`select-assign-region-supervisor-${sup.id}`}
                              value={assignDrafts[draftKey] || ''}
                              onChange={(e) =>
                                setAssignDrafts((prev) => ({ ...prev, [draftKey]: e.target.value }))
                              }
                              className="px-2 py-1 rounded-lg bg-[#121215] border border-zinc-700 text-[11px] text-white"
                            >
                              <option value="">Elegir región...</option>
                              {regiones.map((reg) => (
                                <option key={reg.id} value={reg.id}>
                                  {reg.nombre}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              data-testid={`btn-assign-region-supervisor-${sup.id}`}
                              disabled={busyKey === `assign:${draftKey}`}
                              onClick={() => void handleAssignQuarantinedRegion('supervisores', sup.id)}
                              className="px-2.5 py-1 rounded-lg bg-[#DC2626] hover:bg-red-500 text-white text-[11px] font-extrabold cursor-pointer disabled:opacity-50"
                            >
                              Asignar
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void cambiarEstadoSupervisorMaestro(sup.id, !sup.activo)}
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-red-950/70 border border-zinc-700 text-zinc-200 cursor-pointer"
                            title={sup.activo ? 'Desactivar supervisor' : 'Reactivar supervisor'}
                          >
                            <Power className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {activeTab === 'regiones' && (
          <table className="w-full text-left text-xs" data-testid="table-master-regiones">
            <thead>
              <tr className="border-b border-zinc-800 text-[10px] uppercase font-mono text-zinc-400">
                <th className="px-3 py-2.5">Código</th>
                <th className="px-3 py-2.5">Nombre de Región</th>
                <th className="px-3 py-2.5">Estado</th>
                {canEditRegiones && <th className="px-3 py-2.5 text-right">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {visibleRegiones.map((reg) => (
                <tr key={reg.id} className="hover:bg-[#121215]">
                  <td className="px-3 py-2.5 font-mono font-bold text-red-400">{reg.codigo}</td>
                  <td className="px-3 py-2.5 font-bold text-white">{reg.nombre}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                        reg.activo
                          ? 'bg-white text-[#09090B] border-white'
                          : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                      }`}
                    >
                      {reg.activo ? 'ACTIVA' : 'INACTIVA'}
                    </span>
                  </td>
                  {canEditRegiones && (
                    <td className="px-3 py-2.5 text-right space-x-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingRegId(reg.id);
                          setRegCodigo(reg.codigo);
                          setRegNombre(reg.nombre);
                          setRegModalOpen(true);
                        }}
                        className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-white cursor-pointer"
                        title="Editar región"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void cambiarEstadoRegionMaestra(reg.id, !reg.activo)}
                        className="p-1.5 rounded-lg bg-zinc-900 hover:bg-red-950/70 border border-zinc-700 text-zinc-200 cursor-pointer"
                        title={reg.activo ? 'Desactivar región' : 'Reactivar región'}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {(activeTab === 'productos' || activeTab === 'clientes') &&
          (activeTab === 'productos' ? visibleProductos.length : visibleClientes.length) >
            MASTER_TABLE_PAGE_SIZE && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-t border-zinc-800 bg-[#121215] text-[11px] font-mono text-zinc-400">
              <span>
                Mostrando {tablePage * MASTER_TABLE_PAGE_SIZE + 1}–
                {Math.min(
                  (tablePage + 1) * MASTER_TABLE_PAGE_SIZE,
                  activeTab === 'productos' ? visibleProductos.length : visibleClientes.length
                )}{' '}
                de {activeTab === 'productos' ? visibleProductos.length : visibleClientes.length}{' '}
                registros
              </span>
              <div className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={tablePage === 0}
                  onClick={() => setTablePage((p) => Math.max(0, p - 1))}
                  className="px-2.5 py-1 rounded-lg bg-[#09090B] border border-zinc-700 text-white disabled:opacity-40 cursor-pointer"
                >
                  Anterior
                </button>
                <button
                  type="button"
                  disabled={
                    (tablePage + 1) * MASTER_TABLE_PAGE_SIZE >=
                    (activeTab === 'productos' ? visibleProductos.length : visibleClientes.length)
                  }
                  onClick={() => setTablePage((p) => p + 1)}
                  className="px-2.5 py-1 rounded-lg bg-[#09090B] border border-zinc-700 text-white disabled:opacity-40 cursor-pointer"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
      </div>

      {/* Modal Producto Nacional (solo super_admin) */}
      {prodModalOpen && canEditProducts && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Gestionar Producto Nacional"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleSubmitProducto}
            className="w-full max-w-md rounded-2xl bg-[#121215] border border-zinc-700 p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">
                {editingProdId ? 'Editar Producto Nacional' : 'Nuevo Producto Nacional'}
              </h4>
              <button
                type="button"
                onClick={() => setProdModalOpen(false)}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              required
              data-testid="input-producto-codigo"
              value={prodCodigo}
              onChange={(e) => setProdCodigo(e.target.value)}
              placeholder="Código SKU (ej. PROD-001)"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <input
              required
              data-testid="input-producto-nombre"
              value={prodNombre}
              onChange={(e) => setProdNombre(e.target.value)}
              placeholder="Nombre del producto"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={prodCategoria}
                onChange={(e) => setProdCategoria(e.target.value)}
                placeholder="Categoría"
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              />
              <input
                value={prodMarca}
                onChange={(e) => setProdMarca(e.target.value)}
                placeholder="Marca"
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              />
            </div>
            <input
              value={prodUnidad}
              onChange={(e) => setProdUnidad(e.target.value)}
              placeholder="Unidad (KG, UN, CAJA)"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setProdModalOpen(false)}
                className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                data-testid="btn-submit-producto"
                className="px-4 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-500 text-white text-xs font-extrabold cursor-pointer"
              >
                Guardar Producto
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Región (solo super_admin) */}
      {regModalOpen && canEditRegiones && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Gestionar Región"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleSubmitRegion}
            className="w-full max-w-md rounded-2xl bg-[#121215] border border-zinc-700 p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">
                {editingRegId ? 'Editar Región' : 'Nueva Región'}
              </h4>
              <button
                type="button"
                onClick={() => setRegModalOpen(false)}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              required
              value={regCodigo}
              onChange={(e) => setRegCodigo(e.target.value)}
              placeholder="Código (ej. OCCIDENTE)"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <input
              required
              value={regNombre}
              onChange={(e) => setRegNombre(e.target.value)}
              placeholder="Nombre (ej. OCCIDENTE)"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRegModalOpen(false)}
                className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-500 text-white text-xs font-extrabold cursor-pointer"
              >
                Guardar Región
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Supervisor */}
      {supModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Gestionar Supervisor"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleSubmitSupervisor}
            className="w-full max-w-md rounded-2xl bg-[#121215] border border-zinc-700 p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">Nuevo Supervisor</h4>
              <button
                type="button"
                onClick={() => setSupModalOpen(false)}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              required
              value={supNombre}
              onChange={(e) => setSupNombre(e.target.value)}
              placeholder="Nombre completo"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={supCodigo}
                onChange={(e) => setSupCodigo(e.target.value)}
                placeholder="Código (opcional)"
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              />
              <input
                value={supZona}
                onChange={(e) => setSupZona(e.target.value)}
                placeholder="Zona"
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              />
            </div>
            <input
              type="email"
              value={supEmail}
              onChange={(e) => setSupEmail(e.target.value)}
              placeholder="Correo corporativo"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <input
              value={supTelefono}
              onChange={(e) => setSupTelefono(e.target.value)}
              placeholder="Teléfono"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            {isSuperAdmin && (
              <select
                required
                value={supRegionId}
                onChange={(e) => setSupRegionId(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              >
                <option value="">Selecciona región obligatoria...</option>
                {regiones.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nombre}
                  </option>
                ))}
              </select>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSupModalOpen(false)}
                className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-500 text-white text-xs font-extrabold cursor-pointer"
              >
                Guardar Supervisor
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Promotora (selector de supervisor acotado estrictamente a la misma región) */}
      {promModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Gestionar Promotora"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleSubmitPromotora}
            className="w-full max-w-md rounded-2xl bg-[#121215] border border-zinc-700 p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-extrabold text-white">
                {editingPromId ? 'Editar Promotora' : 'Nueva Promotora'}
              </h4>
              <button
                type="button"
                onClick={() => setPromModalOpen(false)}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              required
              value={promNombre}
              onChange={(e) => setPromNombre(e.target.value)}
              placeholder="Nombre completo"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <div>
              <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                Categoría de Promotora
              </label>
              <select
                required
                data-testid="select-promotora-categoria"
                value={promCategoria}
                onChange={(e) =>
                  setPromCategoria(e.target.value as PromotoraCategoriaOficial)
                }
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              >
                {PROMOTORA_CATEGORIAS.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
            <input
              type="email"
              value={promEmail}
              onChange={(e) => setPromEmail(e.target.value)}
              placeholder="Correo electrónico"
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={promTelefono}
                onChange={(e) => setPromTelefono(e.target.value)}
                placeholder="Teléfono"
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              />
              <input
                value={promCiudad}
                onChange={(e) => setPromCiudad(e.target.value)}
                placeholder="Ciudad"
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              />
            </div>
            {isSuperAdmin && (
              <select
                required
                value={promRegionId}
                onChange={(e) => {
                  setPromRegionId(e.target.value);
                  setPromSupervisorId('');
                }}
                className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
              >
                <option value="">Selecciona región obligatoria...</option>
                {regiones.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nombre}
                  </option>
                ))}
              </select>
            )}
            <select
              value={promSupervisorId}
              onChange={(e) => setPromSupervisorId(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-[#09090B] border border-zinc-700 text-xs text-white"
            >
              <option value="">Supervisor asignado (misma región, opcional)</option>
              {sameRegionSupervisores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nombre}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPromModalOpen(false)}
                className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-500 text-white text-xs font-extrabold cursor-pointer"
              >
                Guardar Promotora
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
};
