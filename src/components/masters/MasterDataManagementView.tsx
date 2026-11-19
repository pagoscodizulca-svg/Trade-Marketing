import React, { useMemo, useRef, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Database,
  Edit3,
  FileSpreadsheet,
  Loader2,
  MapPin,
  Plus,
  Power,
  RefreshCw,
  Search,
  Store as StoreIcon,
  Upload,
  Users,
  X,
  AlertTriangle,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  cambiarEstadoCadenaComercial,
  cambiarEstadoClienteMaestro,
  cambiarEstadoVendedorMaestro,
  cambiarEstadoZonaComercial,
  guardarCadenaComercial,
  guardarClienteMaestro,
  guardarVendedorMaestro,
  guardarZonaComercial,
} from '../../services/masterDataSyncService';
import { normalizeSearchText } from '../../services/scheduleMatrixService';
import type {
  CadenaComercial,
  ClienteConVendedor,
  ResultadoSincronizacion,
  SucursalMaestro,
  Vendedor,
  ZonaComercial,
} from '../../types/masterData';

type MasterSubTab = 'clientes' | 'cadenas' | 'zonas' | 'vendedores';

export const MasterDataManagementView: React.FC = () => {
  const { masterData, verifiedSucursal } = useApp();
  const isGlobalUser = verifiedSucursal === 'GLOBAL';
  const defaultRegionalBranch: SucursalMaestro =
    verifiedSucursal === 'VALENCIA' ? 'VALENCIA' : 'ZULIA';

  const [subTab, setSubTab] = useState<MasterSubTab>('clientes');
  const [searchTerm, setSearchTerm] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [filterCadenaId, setFilterCadenaId] = useState('TODAS');
  const [filterZonaId, setFilterZonaId] = useState('TODAS');
  const [filterCanal, setFilterCanal] = useState('TODOS');

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  // Importación masiva CSV/Excel
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [reconciliarClientes, setReconciliarClientes] = useState(false);
  const [desactivarVendedores, setDesactivarVendedores] = useState(false);
  const [importResult, setImportResult] = useState<ResultadoSincronizacion | null>(null);

  // Modal Cliente / PDV
  const [clienteModalOpen, setClienteModalOpen] = useState(false);
  const [editingClienteId, setEditingClienteId] = useState<string | undefined>(undefined);
  const [cliCodigo, setCliCodigo] = useState('');
  const [cliRazon, setCliRazon] = useState('');
  const [cliComercial, setCliComercial] = useState('');
  const [cliRif, setCliRif] = useState('');
  const [cliCanal, setCliCanal] = useState('Supermercado');
  const [cliCadenaId, setCliCadenaId] = useState('');
  const [cliZonaId, setCliZonaId] = useState('');
  const [cliZonaTexto, setCliZonaTexto] = useState('');
  const [cliRuta, setCliRuta] = useState('');
  const [cliDireccion, setCliDireccion] = useState('');
  const [cliCiudad, setCliCiudad] = useState('');
  const [cliTelefono, setCliTelefono] = useState('');
  const [cliLat, setCliLat] = useState('');
  const [cliLng, setCliLng] = useState('');
  const [cliRadio, setCliRadio] = useState('150');
  const [cliVendedorCode, setCliVendedorCode] = useState('');
  const [cliSucursal, setCliSucursal] = useState<SucursalMaestro>(defaultRegionalBranch);

  // Modal Cadena Comercial
  const [cadenaModalOpen, setCadenaModalOpen] = useState(false);
  const [editingCadenaId, setEditingCadenaId] = useState<string | undefined>(undefined);
  const [cadCodigo, setCadCodigo] = useState('');
  const [cadNombre, setCadNombre] = useState('');
  const [cadCanal, setCadCanal] = useState('Supermercado');
  const [cadSucursal, setCadSucursal] = useState<SucursalMaestro>(defaultRegionalBranch);

  // Modal Zona
  const [zonaModalOpen, setZonaModalOpen] = useState(false);
  const [editingZonaId, setEditingZonaId] = useState<string | undefined>(undefined);
  const [zonCodigo, setZonCodigo] = useState('');
  const [zonNombre, setZonNombre] = useState('');
  const [zonCiudad, setZonCiudad] = useState('');
  const [zonEstado, setZonEstado] = useState('');
  const [zonSucursal, setZonSucursal] = useState<SucursalMaestro>(defaultRegionalBranch);

  // Modal Vendedor
  const [vendedorModalOpen, setVendedorModalOpen] = useState(false);
  const [editingVendedorId, setEditingVendedorId] = useState<string | undefined>(undefined);
  const [vendCodigo, setVendCodigo] = useState('');
  const [vendNombre, setVendNombre] = useState('');
  const [vendTelefono, setVendTelefono] = useState('');
  const [vendEmail, setVendEmail] = useState('');
  const [vendZona, setVendZona] = useState('');
  const [vendSupervisor, setVendSupervisor] = useState('');
  const [vendSucursal, setVendSucursal] = useState<SucursalMaestro>(defaultRegionalBranch);

  const notify = (type: 'ok' | 'error', text: string) => {
    setFeedback({ type, text });
    window.setTimeout(() => {
      setFeedback((cur) => (cur?.text === text ? null : cur));
    }, 5500);
  };

  const cadenasById = useMemo(
    () => new Map(masterData.cadenas.map((c) => [c.id, c])),
    [masterData.cadenas]
  );
  const zonasById = useMemo(
    () => new Map(masterData.zonas.map((z) => [z.id, z])),
    [masterData.zonas]
  );

  const normQuery = normalizeSearchText(searchTerm);

  const filteredClientes = useMemo(() => {
    return masterData.clientes.filter((c) => {
      if (!showInactive && !c.activo) return false;
      if (filterCadenaId !== 'TODAS' && (c.cadena_id || '') !== filterCadenaId) return false;
      if (filterZonaId !== 'TODAS' && (c.zona_id || '') !== filterZonaId) return false;
      if (filterCanal !== 'TODOS' && (c.canal || '').toLowerCase() !== filterCanal.toLowerCase()) {
        return false;
      }
      if (!normQuery) return true;
      const cadName = c.cadena_id ? cadenasById.get(c.cadena_id)?.nombre || '' : '';
      const zonName = c.zona_id ? zonasById.get(c.zona_id)?.nombre || '' : '';
      const hay = normalizeSearchText(
        `${c.codigo_cliente} ${c.razon_social} ${c.nombre_comercial || ''} ${c.rif || ''} ${c.zona || ''} ${zonName} ${cadName} ${c.ruta || ''} ${c.codigo_vendedor || ''} ${c.vendedor?.nombre_completo || ''}`
      );
      return hay.includes(normQuery);
    });
  }, [
    masterData.clientes,
    showInactive,
    filterCadenaId,
    filterZonaId,
    filterCanal,
    normQuery,
    cadenasById,
    zonasById,
  ]);

  const filteredCadenas = useMemo(() => {
    return masterData.cadenas.filter((c) => {
      if (!showInactive && !c.activo) return false;
      if (!normQuery) return true;
      return normalizeSearchText(`${c.codigo} ${c.nombre} ${c.tipo_canal}`).includes(normQuery);
    });
  }, [masterData.cadenas, showInactive, normQuery]);

  const filteredZonas = useMemo(() => {
    return masterData.zonas.filter((z) => {
      if (!showInactive && !z.activo) return false;
      if (!normQuery) return true;
      return normalizeSearchText(
        `${z.codigo} ${z.nombre} ${z.ciudad || ''} ${z.estado || ''}`
      ).includes(normQuery);
    });
  }, [masterData.zonas, showInactive, normQuery]);

  const filteredVendedores = useMemo(() => {
    return masterData.vendedores.filter((v) => {
      if (!showInactive && !v.activo) return false;
      if (!normQuery) return true;
      return normalizeSearchText(
        `${v.codigo_vendedor} ${v.nombre_completo} ${v.zona || ''} ${v.supervisor || ''} ${v.email || ''}`
      ).includes(normQuery);
    });
  }, [masterData.vendedores, showInactive, normQuery]);

  const geofencedCount = useMemo(
    () => masterData.clientes.filter((c) => c.activo && c.latitud !== null && c.longitud !== null).length,
    [masterData.clientes]
  );

  // Abrir modales (crear / editar)
  const openClienteModal = (cliente?: ClienteConVendedor) => {
    setEditingClienteId(cliente?.id);
    setCliCodigo(cliente?.codigo_cliente || '');
    setCliRazon(cliente?.razon_social || '');
    setCliComercial(cliente?.nombre_comercial || '');
    setCliRif(cliente?.rif || '');
    setCliCanal(cliente?.canal || 'Supermercado');
    setCliCadenaId(cliente?.cadena_id || '');
    setCliZonaId(cliente?.zona_id || '');
    setCliZonaTexto(cliente?.zona || '');
    setCliRuta(cliente?.ruta || '');
    setCliDireccion(cliente?.direccion || '');
    setCliCiudad(cliente?.ciudad || '');
    setCliTelefono(cliente?.telefono || '');
    setCliLat(cliente?.latitud != null ? String(cliente.latitud) : '');
    setCliLng(cliente?.longitud != null ? String(cliente.longitud) : '');
    setCliRadio(String(cliente?.radio_geocerca_m ?? 150));
    setCliVendedorCode(cliente?.codigo_vendedor || '');
    setCliSucursal(cliente?.sucursal || defaultRegionalBranch);
    setClienteModalOpen(true);
  };

  const openCadenaModal = (cadena?: CadenaComercial) => {
    setEditingCadenaId(cadena?.id);
    setCadCodigo(cadena?.codigo || '');
    setCadNombre(cadena?.nombre || '');
    setCadCanal(cadena?.tipo_canal || 'Supermercado');
    setCadSucursal(cadena?.sucursal || defaultRegionalBranch);
    setCadenaModalOpen(true);
  };

  const openZonaModal = (zona?: ZonaComercial) => {
    setEditingZonaId(zona?.id);
    setZonCodigo(zona?.codigo || '');
    setZonNombre(zona?.nombre || '');
    setZonCiudad(zona?.ciudad || '');
    setZonEstado(zona?.estado || '');
    setZonSucursal(zona?.sucursal || defaultRegionalBranch);
    setZonaModalOpen(true);
  };

  const openVendedorModal = (vendedor?: Vendedor) => {
    setEditingVendedorId(vendedor?.id);
    setVendCodigo(vendedor?.codigo_vendedor || '');
    setVendNombre(vendedor?.nombre_completo || '');
    setVendTelefono(vendedor?.telefono || '');
    setVendEmail(vendedor?.email || '');
    setVendZona(vendedor?.zona || '');
    setVendSupervisor(vendedor?.supervisor || '');
    setVendSucursal(vendedor?.sucursal || defaultRegionalBranch);
    setVendedorModalOpen(true);
  };

  const handleSaveCliente = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction('save_cliente');
    try {
      const parsedLat = cliLat.trim() ? Number(cliLat.replace(',', '.')) : null;
      const parsedLng = cliLng.trim() ? Number(cliLng.replace(',', '.')) : null;
      if ((cliLat.trim() && !Number.isFinite(parsedLat)) || (cliLng.trim() && !Number.isFinite(parsedLng))) {
        throw new Error('Latitud y longitud deben ser valores numéricos válidos.');
      }
      const selectedZona = cliZonaId ? zonasById.get(cliZonaId) : undefined;
      const matchedVend = cliVendedorCode.trim()
        ? masterData.vendedores.find(
            (v) => v.codigo_vendedor.toUpperCase() === cliVendedorCode.trim().toUpperCase()
          )
        : undefined;

      await guardarClienteMaestro({
        id: editingClienteId,
        codigo_cliente: cliCodigo,
        razon_social: cliRazon,
        nombre_comercial: cliComercial || null,
        rif: cliRif || null,
        canal: cliCanal || null,
        cadena_id: cliCadenaId || null,
        zona_id: cliZonaId || null,
        zona: cliZonaTexto || selectedZona?.nombre || null,
        ruta: cliRuta || null,
        direccion: cliDireccion || null,
        ciudad: cliCiudad || selectedZona?.ciudad || null,
        telefono: cliTelefono || null,
        latitud: parsedLat,
        longitud: parsedLng,
        radio_geocerca_m: Number(cliRadio) || 150,
        vendedor_id: matchedVend?.id ?? null,
        codigo_vendedor: cliVendedorCode.trim() ? cliVendedorCode.trim().toUpperCase() : null,
        sucursal: isGlobalUser ? cliSucursal : defaultRegionalBranch,
      });
      setClienteModalOpen(false);
      notify('ok', editingClienteId ? 'PDV / Cliente actualizado en Supabase.' : 'Nuevo PDV / Cliente creado en Supabase.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'No se pudo guardar el cliente.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveCadena = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction('save_cadena');
    try {
      await guardarCadenaComercial({
        id: editingCadenaId,
        codigo: cadCodigo,
        nombre: cadNombre,
        tipo_canal: cadCanal,
        sucursal: isGlobalUser ? cadSucursal : defaultRegionalBranch,
      });
      setCadenaModalOpen(false);
      notify('ok', editingCadenaId ? 'Cadena comercial actualizada.' : 'Cadena comercial registrada.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'No se pudo guardar la cadena comercial.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveZona = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction('save_zona');
    try {
      await guardarZonaComercial({
        id: editingZonaId,
        codigo: zonCodigo,
        nombre: zonNombre,
        ciudad: zonCiudad || null,
        estado: zonEstado || null,
        sucursal: isGlobalUser ? zonSucursal : defaultRegionalBranch,
      });
      setZonaModalOpen(false);
      notify('ok', editingZonaId ? 'Zona actualizada.' : 'Zona registrada.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'No se pudo guardar la zona.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveVendedor = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction('save_vendedor');
    try {
      await guardarVendedorMaestro({
        id: editingVendedorId,
        codigo_vendedor: vendCodigo,
        nombre_completo: vendNombre,
        telefono: vendTelefono || null,
        email: vendEmail || null,
        zona: vendZona || null,
        supervisor: vendSupervisor || null,
        sucursal: isGlobalUser ? vendSucursal : defaultRegionalBranch,
      });
      setVendedorModalOpen(false);
      notify('ok', editingVendedorId ? 'Vendedor actualizado.' : 'Vendedor registrado.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'No se pudo guardar el vendedor.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleActivo = async (
    entity: MasterSubTab,
    id: string,
    nextActive: boolean,
    label: string
  ) => {
    setBusyAction(`${entity}:${id}`);
    try {
      if (entity === 'clientes') await cambiarEstadoClienteMaestro(id, nextActive);
      else if (entity === 'cadenas') await cambiarEstadoCadenaComercial(id, nextActive);
      else if (entity === 'zonas') await cambiarEstadoZonaComercial(id, nextActive);
      else await cambiarEstadoVendedorMaestro(id, nextActive);
      notify('ok', `${label} ${nextActive ? 'reactivado' : 'desactivado lógicamente'} correctamente.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'No se pudo cambiar el estado del registro.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    try {
      const res = await masterData.sincronizarArchivo(file, {
        nombreArchivo: file.name,
        reconciliarCarteraClientes: reconciliarClientes,
        desactivarVendedoresAusentes: desactivarVendedores,
      });
      setImportResult(res);
      notify(
        'ok',
        `Importación finalizada (${res.estado}): ${res.clientes.procesados} cliente(s) y ${res.vendedores.procesados} vendedor(es) sincronizados.`
      );
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Error importando archivo maestro.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openCreateForActiveTab = () => {
    if (subTab === 'clientes') openClienteModal();
    else if (subTab === 'cadenas') openCadenaModal();
    else if (subTab === 'zonas') openZonaModal();
    else openVendedorModal();
  };

  return (
    <div className="space-y-6">
      {/* Feedback flotante */}
      {feedback && (
        <div
          role="status"
          className={`fixed top-20 right-6 z-50 max-w-md px-4 py-3 rounded-xl border text-xs font-bold shadow-2xl flex items-center gap-2.5 ${
            feedback.type === 'ok'
              ? 'bg-emerald-950/95 border-emerald-500/50 text-emerald-100'
              : 'bg-red-950/95 border-red-500/60 text-red-100'
          }`}
        >
          {feedback.type === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Encabezado y KPIs */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-red-600/20 text-red-400 uppercase tracking-wider border border-red-500/30">
                FUENTE ÚNICA DE VERDAD · DATA MAESTRA
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-zinc-900 text-zinc-300 border border-white/10">
                Sede activa: {verifiedSucursal || 'GLOBAL'}
              </span>
            </div>
            <h2 className="text-2xl font-black text-white tracking-tight flex items-center gap-2.5">
              <Database className="w-6 h-6 text-red-500" />
              <span>Gestión de Maestros (PDVs, Cadenas, Zonas y FDV)</span>
            </h2>
            <p className="text-xs text-zinc-400 mt-1 max-w-3xl">
              Administra la cartera real de clientes en PostgreSQL/Supabase con geocercas GPS configurables,
              cadenas comerciales y zonas territoriales aisladas por sucursal (Zulia / Valencia).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void masterData.refrescar()}
              disabled={masterData.cargando}
              className="px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-bold text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${masterData.cargando ? 'animate-spin' : ''}`} />
              <span>Actualizar</span>
            </button>

            <button
              type="button"
              onClick={openCreateForActiveTab}
              data-testid="btn-nuevo-maestro"
              className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold inline-flex items-center gap-1.5 border border-red-500/60 shadow cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>
                {subTab === 'clientes'
                  ? 'Nuevo PDV / Cliente'
                  : subTab === 'cadenas'
                    ? 'Nueva Cadena'
                    : subTab === 'zonas'
                      ? 'Nueva Zona'
                      : 'Nuevo Vendedor'}
              </span>
            </button>
          </div>
        </div>

        {/* KPIs rápidos */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-4 border-t border-white/[0.08]">
          <div className="rounded-xl bg-zinc-950/90 border border-white/10 p-3.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Clientes / PDVs</div>
            <div className="text-2xl font-black text-white mt-1 font-mono">{masterData.clientes.length}</div>
            <div className="text-[11px] text-emerald-400 mt-0.5">{geofencedCount} con coordenadas GPS</div>
          </div>
          <div className="rounded-xl bg-zinc-950/90 border border-white/10 p-3.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Cadenas Comerciales</div>
            <div className="text-2xl font-black text-white mt-1 font-mono">{masterData.cadenas.length}</div>
            <div className="text-[11px] text-zinc-400 mt-0.5">Catálogo relacional normalizado</div>
          </div>
          <div className="rounded-xl bg-zinc-950/90 border border-white/10 p-3.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Zonas Geográficas</div>
            <div className="text-2xl font-black text-white mt-1 font-mono">{masterData.zonas.length}</div>
            <div className="text-[11px] text-zinc-400 mt-0.5">Territorios por sucursal</div>
          </div>
          <div className="rounded-xl bg-zinc-950/90 border border-white/10 p-3.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Fuerza de Ventas</div>
            <div className="text-2xl font-black text-white mt-1 font-mono">{masterData.vendedores.length}</div>
            <div className="text-[11px] text-zinc-400 mt-0.5">Vendedores activos en catálogo</div>
          </div>
        </div>

        {/* Barra de importación masiva CSV / Excel */}
        <div className="rounded-xl bg-zinc-950/80 border border-white/10 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-600/15 border border-red-500/30 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-4 h-4 text-red-400" />
            </div>
            <div>
              <h3 className="text-xs font-extrabold text-white">
                Importación Masiva por Lotes (CSV / Excel → RPC Transaccional)
              </h3>
              <p className="text-[11px] text-zinc-400">
                Normaliza códigos, RIF y coordenadas con Zod y sincroniza en lotes de 400 registros auditados en{' '}
                <code className="text-zinc-300">lotes_sincronizacion</code>.
              </p>
              <div className="flex flex-wrap items-center gap-4 mt-2 text-[11px] text-zinc-300">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reconciliarClientes}
                    onChange={(e) => setReconciliarClientes(e.target.checked)}
                    className="accent-red-600"
                  />
                  <span>Desactivar clientes ausentes del archivo (baja lógica)</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={desactivarVendedores}
                    onChange={(e) => setDesactivarVendedores(e.target.checked)}
                    className="accent-red-600"
                  />
                  <span>Desactivar vendedores ausentes</span>
                </label>
              </div>
            </div>
          </div>

          <div className="shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => void handleFileImport(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={masterData.sincronizando}
              className="px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-red-600 border border-white/15 hover:border-red-500 text-xs font-bold text-white inline-flex items-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              {masterData.sincronizando ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 text-red-400" />
              )}
              <span>{masterData.sincronizando ? 'Sincronizando lotes...' : 'Importar CSV / Excel'}</span>
            </button>
          </div>
        </div>

        {importResult && (
          <div className="rounded-xl bg-zinc-950 border border-emerald-500/30 p-3.5 text-xs space-y-1">
            <div className="font-bold text-emerald-300">
              Lote {importResult.loteId || 'local'} · Estado: {importResult.estado.toUpperCase()} ({importResult.duracionMs} ms)
            </div>
            <div className="text-zinc-300 font-mono text-[11px]">
              Clientes procesados: {importResult.clientes.procesados} (desactivados: {importResult.clientes.desactivados}) ·
              Vendedores procesados: {importResult.vendedores.procesados} ·
              Observaciones: {importResult.erroresDetalle.length}
            </div>
          </div>
        )}
      </div>

      {/* Sub-pestañas + barra de filtros */}
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-zinc-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Entidades Maestras">
            {(
              [
                { id: 'clientes', label: 'Clientes / PDVs', count: filteredClientes.length, icon: <StoreIcon className="w-3.5 h-3.5" /> },
                { id: 'cadenas', label: 'Cadenas Comerciales', count: filteredCadenas.length, icon: <Building2 className="w-3.5 h-3.5" /> },
                { id: 'zonas', label: 'Zonas', count: filteredZonas.length, icon: <MapPin className="w-3.5 h-3.5" /> },
                { id: 'vendedores', label: 'Vendedores', count: filteredVendedores.length, icon: <Users className="w-3.5 h-3.5" /> },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={subTab === t.id}
                onClick={() => setSubTab(t.id)}
                className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer ${
                  subTab === t.id
                    ? 'bg-red-600 text-white shadow'
                    : 'bg-zinc-900 text-zinc-400 hover:text-white border border-white/5'
                }`}
              >
                {t.icon}
                <span>{t.label}</span>
                <span className="px-1.5 py-0.5 rounded-md bg-black/30 font-mono text-[10px]">
                  {t.count}
                </span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[210px]">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Buscar por código, nombre, RIF, zona..."
                className="w-full pl-8 pr-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500"
              />
            </div>

            {subTab === 'clientes' && (
              <>
                <select
                  value={filterCadenaId}
                  onChange={(e) => setFilterCadenaId(e.target.value)}
                  className="px-2.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-red-500"
                >
                  <option value="TODAS">Todas las cadenas</option>
                  {masterData.cadenas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
                <select
                  value={filterZonaId}
                  onChange={(e) => setFilterZonaId(e.target.value)}
                  className="px-2.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-red-500"
                >
                  <option value="TODAS">Todas las zonas</option>
                  {masterData.zonas.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.nombre}
                    </option>
                  ))}
                </select>
                <select
                  value={filterCanal}
                  onChange={(e) => setFilterCanal(e.target.value)}
                  className="px-2.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-red-500"
                >
                  <option value="TODOS">Todos los canales</option>
                  <option value="Supermercado">Supermercado</option>
                  <option value="Mayorista">Mayorista</option>
                  <option value="Farmacia">Farmacia</option>
                  <option value="Minimarket">Minimarket</option>
                  <option value="Tradicional">Tradicional</option>
                </select>
              </>
            )}

            <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 px-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="accent-red-600"
              />
              <span>Ver inactivos</span>
            </label>
          </div>
        </div>

        {/* Tabla dinámica según sub-pestaña */}
        <div className="overflow-x-auto">
          {subTab === 'clientes' && (
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-black border-b border-zinc-800 text-zinc-400 uppercase text-[10px] tracking-wider">
                  <th className="p-3">Código</th>
                  <th className="p-3">PDV / Razón Social</th>
                  <th className="p-3">Cadena / Canal</th>
                  <th className="p-3">Zona / Ruta</th>
                  <th className="p-3">Geocerca GPS</th>
                  <th className="p-3">Vendedor</th>
                  <th className="p-3">Sede</th>
                  <th className="p-3 text-center">Estado</th>
                  <th className="p-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900 text-zinc-200">
                {filteredClientes.length === 0 && (
                  <tr>
                    <td colSpan={9} className="p-8 text-center text-zinc-500 font-mono">
                      Sin clientes que coincidan con los filtros actuales.
                    </td>
                  </tr>
                )}
                {filteredClientes.slice(0, 200).map((c) => {
                  const cadena = c.cadena_id ? cadenasById.get(c.cadena_id) : null;
                  const zonaCat = c.zona_id ? zonasById.get(c.zona_id) : null;
                  const busy = busyAction === `clientes:${c.id}`;
                  return (
                    <tr key={c.id} className="hover:bg-zinc-900/50 transition">
                      <td className="p-3 font-mono font-bold text-white whitespace-nowrap">{c.codigo_cliente}</td>
                      <td className="p-3">
                        <div className="font-bold text-white">{c.nombre_comercial || c.razon_social}</div>
                        <div className="text-[10px] text-zinc-400">
                          {c.razon_social} {c.rif ? `· ${c.rif}` : ''}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="text-zinc-200 font-semibold">{cadena?.nombre || '—'}</div>
                        <div className="text-[10px] text-zinc-400">{c.canal || 'Sin canal'}</div>
                      </td>
                      <td className="p-3">
                        <div className="text-zinc-200">{zonaCat?.nombre || c.zona || '—'}</div>
                        <div className="text-[10px] text-zinc-500 font-mono">{c.ruta || ''}</div>
                      </td>
                      <td className="p-3 font-mono text-[11px]">
                        {c.latitud !== null && c.longitud !== null ? (
                          <div>
                            <span className="text-emerald-400">{c.radio_geocerca_m ?? 150} m</span>
                            <div className="text-[10px] text-zinc-500">
                              {c.latitud.toFixed(4)}, {c.longitud.toFixed(4)}
                            </div>
                          </div>
                        ) : (
                          <span className="text-zinc-500">Sin GPS ({c.radio_geocerca_m ?? 150} m)</span>
                        )}
                      </td>
                      <td className="p-3 text-zinc-300">
                        {c.vendedor?.nombre_completo || c.codigo_vendedor || '—'}
                      </td>
                      <td className="p-3 font-mono text-[10px]">
                        <span className="px-2 py-0.5 rounded bg-zinc-900 border border-white/10 text-zinc-200">
                          {c.sucursal || 'SIN SEDE'}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            c.activo
                              ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/50'
                              : 'bg-zinc-900 text-zinc-500 border-zinc-700'
                          }`}
                        >
                          {c.activo ? 'ACTIVO' : 'INACTIVO'}
                        </span>
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openClienteModal(c)}
                            title="Editar PDV"
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/10 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleToggleActivo('clientes', c.id, !c.activo, c.razon_social)}
                            title={c.activo ? 'Desactivar lógicamente' : 'Reactivar'}
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-red-950 text-zinc-400 hover:text-red-300 border border-white/10 cursor-pointer disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {subTab === 'cadenas' && (
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-black border-b border-zinc-800 text-zinc-400 uppercase text-[10px] tracking-wider">
                  <th className="p-3">Código</th>
                  <th className="p-3">Cadena Comercial</th>
                  <th className="p-3">Tipo Canal</th>
                  <th className="p-3">Sede</th>
                  <th className="p-3 text-center">Estado</th>
                  <th className="p-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900 text-zinc-200">
                {filteredCadenas.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-zinc-500 font-mono">
                      No hay cadenas comerciales registradas todavía.
                    </td>
                  </tr>
                )}
                {filteredCadenas.map((c) => {
                  const busy = busyAction === `cadenas:${c.id}`;
                  return (
                    <tr key={c.id} className="hover:bg-zinc-900/50 transition">
                      <td className="p-3 font-mono font-bold text-white">{c.codigo}</td>
                      <td className="p-3 font-bold text-white">{c.nombre}</td>
                      <td className="p-3 text-zinc-300">{c.tipo_canal}</td>
                      <td className="p-3 font-mono text-[10px]">{c.sucursal || 'SIN SEDE'}</td>
                      <td className="p-3 text-center">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            c.activo
                              ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/50'
                              : 'bg-zinc-900 text-zinc-500 border-zinc-700'
                          }`}
                        >
                          {c.activo ? 'ACTIVA' : 'INACTIVA'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openCadenaModal(c)}
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/10 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleToggleActivo('cadenas', c.id, !c.activo, c.nombre)}
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-red-950 text-zinc-400 hover:text-red-300 border border-white/10 cursor-pointer disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {subTab === 'zonas' && (
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-black border-b border-zinc-800 text-zinc-400 uppercase text-[10px] tracking-wider">
                  <th className="p-3">Código</th>
                  <th className="p-3">Zona</th>
                  <th className="p-3">Ciudad / Estado</th>
                  <th className="p-3">Sede</th>
                  <th className="p-3 text-center">Estado</th>
                  <th className="p-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900 text-zinc-200">
                {filteredZonas.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-zinc-500 font-mono">
                      No hay zonas geográficas registradas todavía.
                    </td>
                  </tr>
                )}
                {filteredZonas.map((z) => {
                  const busy = busyAction === `zonas:${z.id}`;
                  return (
                    <tr key={z.id} className="hover:bg-zinc-900/50 transition">
                      <td className="p-3 font-mono font-bold text-white">{z.codigo}</td>
                      <td className="p-3 font-bold text-white">{z.nombre}</td>
                      <td className="p-3 text-zinc-300">
                        {[z.ciudad, z.estado].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="p-3 font-mono text-[10px]">{z.sucursal || 'SIN SEDE'}</td>
                      <td className="p-3 text-center">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            z.activo
                              ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/50'
                              : 'bg-zinc-900 text-zinc-500 border-zinc-700'
                          }`}
                        >
                          {z.activo ? 'ACTIVA' : 'INACTIVA'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openZonaModal(z)}
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/10 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleToggleActivo('zonas', z.id, !z.activo, z.nombre)}
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-red-950 text-zinc-400 hover:text-red-300 border border-white/10 cursor-pointer disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {subTab === 'vendedores' && (
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-black border-b border-zinc-800 text-zinc-400 uppercase text-[10px] tracking-wider">
                  <th className="p-3">Código</th>
                  <th className="p-3">Nombre Completo</th>
                  <th className="p-3">Contacto</th>
                  <th className="p-3">Zona / Supervisor</th>
                  <th className="p-3">Sede</th>
                  <th className="p-3 text-center">Estado</th>
                  <th className="p-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900 text-zinc-200">
                {filteredVendedores.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-zinc-500 font-mono">
                      Sin vendedores que coincidan con el filtro actual.
                    </td>
                  </tr>
                )}
                {filteredVendedores.map((v) => {
                  const busy = busyAction === `vendedores:${v.id}`;
                  return (
                    <tr key={v.id} className="hover:bg-zinc-900/50 transition">
                      <td className="p-3 font-mono font-bold text-white">{v.codigo_vendedor}</td>
                      <td className="p-3 font-bold text-white">{v.nombre_completo}</td>
                      <td className="p-3 text-zinc-300">
                        <div>{v.email || '—'}</div>
                        <div className="text-[10px] text-zinc-500 font-mono">{v.telefono || ''}</div>
                      </td>
                      <td className="p-3 text-zinc-300">
                        <div>{v.zona || '—'}</div>
                        <div className="text-[10px] text-zinc-500">{v.supervisor || ''}</div>
                      </td>
                      <td className="p-3 font-mono text-[10px]">{v.sucursal || 'SIN SEDE'}</td>
                      <td className="p-3 text-center">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            v.activo
                              ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/50'
                              : 'bg-zinc-900 text-zinc-500 border-zinc-700'
                          }`}
                        >
                          {v.activo ? 'ACTIVO' : 'INACTIVO'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openVendedorModal(v)}
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/10 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void handleToggleActivo('vendedores', v.id, !v.activo, v.nombre_completo)
                            }
                            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-red-950 text-zinc-400 hover:text-red-300 border border-white/10 cursor-pointer disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Modal Cliente / PDV */}
      {clienteModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={(e) => void handleSaveCliente(e)}
            className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-sm font-black uppercase tracking-wider text-white">
                {editingClienteId ? 'Editar Cliente / PDV' : 'Nuevo Cliente / PDV'}
              </h3>
              <button type="button" onClick={() => setClienteModalOpen(false)} className="text-zinc-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Código Cliente *</label>
                <input
                  required
                  value={cliCodigo}
                  onChange={(e) => setCliCodigo(e.target.value)}
                  placeholder="CLI-0001"
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono uppercase"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">RIF Fiscal</label>
                <input
                  value={cliRif}
                  onChange={(e) => setCliRif(e.target.value)}
                  placeholder="J-12345678-0"
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono uppercase"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block font-bold text-zinc-300 mb-1">Razón Social *</label>
                <input
                  required
                  value={cliRazon}
                  onChange={(e) => setCliRazon(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Nombre Comercial</label>
                <input
                  value={cliComercial}
                  onChange={(e) => setCliComercial(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Canal</label>
                <select
                  value={cliCanal}
                  onChange={(e) => setCliCanal(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                >
                  <option value="Supermercado">Supermercado</option>
                  <option value="Mayorista">Mayorista</option>
                  <option value="Farmacia">Farmacia</option>
                  <option value="Minimarket">Minimarket</option>
                  <option value="Cuentas Claves">Cuentas Claves</option>
                  <option value="Tradicional">Tradicional</option>
                </select>
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Cadena Comercial</label>
                <select
                  value={cliCadenaId}
                  onChange={(e) => setCliCadenaId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                >
                  <option value="">Sin cadena asignada</option>
                  {masterData.cadenas.filter((c) => c.activo).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre} ({c.codigo})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Zona (Catálogo)</label>
                <select
                  value={cliZonaId}
                  onChange={(e) => setCliZonaId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                >
                  <option value="">Sin zona de catálogo</option>
                  {masterData.zonas.filter((z) => z.activo).map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.nombre} ({z.codigo})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Zona / Sector (Texto)</label>
                <input
                  value={cliZonaTexto}
                  onChange={(e) => setCliZonaTexto(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Ruta</label>
                <input
                  value={cliRuta}
                  onChange={(e) => setCliRuta(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block font-bold text-zinc-300 mb-1">Dirección</label>
                <input
                  value={cliDireccion}
                  onChange={(e) => setCliDireccion(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Ciudad</label>
                <input
                  value={cliCiudad}
                  onChange={(e) => setCliCiudad(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Teléfono</label>
                <input
                  value={cliTelefono}
                  onChange={(e) => setCliTelefono(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Latitud GPS</label>
                <input
                  value={cliLat}
                  onChange={(e) => setCliLat(e.target.value)}
                  placeholder="10.654000"
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Longitud GPS</label>
                <input
                  value={cliLng}
                  onChange={(e) => setCliLng(e.target.value)}
                  placeholder="-71.634000"
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Radio Geocerca (metros, 25-5000)</label>
                <input
                  type="number"
                  min={25}
                  max={5000}
                  value={cliRadio}
                  onChange={(e) => setCliRadio(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Código Vendedor FDV</label>
                <input
                  value={cliVendedorCode}
                  onChange={(e) => setCliVendedorCode(e.target.value)}
                  list="master-vendedores-codes"
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono uppercase"
                />
                <datalist id="master-vendedores-codes">
                  {masterData.vendedores.map((v) => (
                    <option key={v.id} value={v.codigo_vendedor}>
                      {v.nombre_completo}
                    </option>
                  ))}
                </datalist>
              </div>
              {isGlobalUser && (
                <div>
                  <label className="block font-bold text-zinc-300 mb-1">Sucursal Operativa *</label>
                  <select
                    value={cliSucursal}
                    onChange={(e) => setCliSucursal(e.target.value as SucursalMaestro)}
                    className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                  >
                    <option value="ZULIA">ZULIA</option>
                    <option value="VALENCIA">VALENCIA</option>
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => setClienteModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busyAction === 'save_cliente'}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-black text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {busyAction === 'save_cliente' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Guardar PDV</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Cadena Comercial */}
      {cadenaModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={(e) => void handleSaveCadena(e)}
            className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 text-xs"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-sm font-black uppercase text-white">
                {editingCadenaId ? 'Editar Cadena Comercial' : 'Nueva Cadena Comercial'}
              </h3>
              <button type="button" onClick={() => setCadenaModalOpen(false)} className="text-zinc-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block font-bold text-zinc-300 mb-1">Código *</label>
              <input
                required
                value={cadCodigo}
                onChange={(e) => setCadCodigo(e.target.value)}
                placeholder="CAD-FIOR"
                className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono uppercase"
              />
            </div>
            <div>
              <label className="block font-bold text-zinc-300 mb-1">Nombre *</label>
              <input
                required
                value={cadNombre}
                onChange={(e) => setCadNombre(e.target.value)}
                placeholder="Supermercados Fiorella"
                className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
              />
            </div>
            <div>
              <label className="block font-bold text-zinc-300 mb-1">Tipo Canal</label>
              <select
                value={cadCanal}
                onChange={(e) => setCadCanal(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
              >
                <option value="Supermercado">Supermercado</option>
                <option value="Mayorista">Mayorista</option>
                <option value="Farmacia">Farmacia</option>
                <option value="Minimarket">Minimarket</option>
                <option value="Cuentas Claves">Cuentas Claves</option>
              </select>
            </div>
            {isGlobalUser && (
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Sucursal Operativa *</label>
                <select
                  value={cadSucursal}
                  onChange={(e) => setCadSucursal(e.target.value as SucursalMaestro)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                >
                  <option value="ZULIA">ZULIA</option>
                  <option value="VALENCIA">VALENCIA</option>
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => setCadenaModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 font-bold text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busyAction === 'save_cadena'}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 font-black text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {busyAction === 'save_cadena' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Guardar Cadena</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Zona */}
      {zonaModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={(e) => void handleSaveZona(e)}
            className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 text-xs"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-sm font-black uppercase text-white">
                {editingZonaId ? 'Editar Zona' : 'Nueva Zona Geográfica'}
              </h3>
              <button type="button" onClick={() => setZonaModalOpen(false)} className="text-zinc-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block font-bold text-zinc-300 mb-1">Código *</label>
              <input
                required
                value={zonCodigo}
                onChange={(e) => setZonCodigo(e.target.value)}
                placeholder="ZON-MCBO-N"
                className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono uppercase"
              />
            </div>
            <div>
              <label className="block font-bold text-zinc-300 mb-1">Nombre *</label>
              <input
                required
                value={zonNombre}
                onChange={(e) => setZonNombre(e.target.value)}
                placeholder="Maracaibo Norte"
                className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Ciudad</label>
                <input
                  value={zonCiudad}
                  onChange={(e) => setZonCiudad(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Estado</label>
                <input
                  value={zonEstado}
                  onChange={(e) => setZonEstado(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
            </div>
            {isGlobalUser && (
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Sucursal Operativa *</label>
                <select
                  value={zonSucursal}
                  onChange={(e) => setZonSucursal(e.target.value as SucursalMaestro)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                >
                  <option value="ZULIA">ZULIA</option>
                  <option value="VALENCIA">VALENCIA</option>
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => setZonaModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 font-bold text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busyAction === 'save_zona'}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 font-black text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {busyAction === 'save_zona' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Guardar Zona</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal Vendedor */}
      {vendedorModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={(e) => void handleSaveVendedor(e)}
            className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 text-xs"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <h3 className="text-sm font-black uppercase text-white">
                {editingVendedorId ? 'Editar Vendedor FDV' : 'Nuevo Vendedor FDV'}
              </h3>
              <button type="button" onClick={() => setVendedorModalOpen(false)} className="text-zinc-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block font-bold text-zinc-300 mb-1">Código Vendedor *</label>
              <input
                required
                value={vendCodigo}
                onChange={(e) => setVendCodigo(e.target.value)}
                placeholder="VEN-01"
                className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono uppercase"
              />
            </div>
            <div>
              <label className="block font-bold text-zinc-300 mb-1">Nombre Completo *</label>
              <input
                required
                value={vendNombre}
                onChange={(e) => setVendNombre(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Teléfono</label>
                <input
                  value={vendTelefono}
                  onChange={(e) => setVendTelefono(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Email</label>
                <input
                  type="email"
                  value={vendEmail}
                  onChange={(e) => setVendEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Zona</label>
                <input
                  value={vendZona}
                  onChange={(e) => setVendZona(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Supervisor</label>
                <input
                  value={vendSupervisor}
                  onChange={(e) => setVendSupervisor(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                />
              </div>
            </div>
            {isGlobalUser && (
              <div>
                <label className="block font-bold text-zinc-300 mb-1">Sucursal Operativa *</label>
                <select
                  value={vendSucursal}
                  onChange={(e) => setVendSucursal(e.target.value as SucursalMaestro)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white"
                >
                  <option value="ZULIA">ZULIA</option>
                  <option value="VALENCIA">VALENCIA</option>
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => setVendedorModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 font-bold text-zinc-300 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busyAction === 'save_vendedor'}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 font-black text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {busyAction === 'save_vendedor' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Guardar Vendedor</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
