import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  FileSpreadsheet,
  FileText,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  User,
  XCircle,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  SolicitudContraloriaEstado,
  SolicitudProductoContraloria,
} from '../../types';
import { SolicitudProductosFormatSheet } from '../requisition/SolicitudProductosFormatSheet';
import { exportSolicitudProductosPdf } from '../../utils/pdfExport';

interface ContraloriaSolicitudesInboxProps {
  onSelectApprovedRequisitionCode?: (requestCode: string) => void;
}

export const ContraloriaSolicitudesInbox: React.FC<
  ContraloriaSolicitudesInboxProps
> = ({ onSelectApprovedRequisitionCode }) => {
  const { currentUser, isContraloriaOrAdmin, solicitudesContraloria } = useApp();

  const auditorDisplayName = useMemo(() => {
    if (
      currentUser?.role === 'analista_contraloria' ||
      currentUser?.role === 'gerente_admin' ||
      currentUser?.role === 'jefe_trade'
    ) {
      return currentUser.name;
    }
    return 'Contraloría Interna Codizulca';
  }, [currentUser]);

  const [filterEstado, setFilterEstado] = useState<'TODAS' | SolicitudContraloriaEstado>(
    'TODAS'
  );
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [controllerNote, setControllerNote] = useState<string>('');
  const [isProcessingDecision, setIsProcessingDecision] = useState<
    'APROBADA' | 'RECHAZADA' | null
  >(null);
  const [actionBanner, setActionBanner] = useState<{
    text: string;
    isError?: boolean;
  } | null>(null);

  const filteredList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return solicitudesContraloria.solicitudes.filter((s) => {
      if (filterEstado !== 'TODAS' && s.estado !== filterEstado) return false;
      if (!q) return true;
      return (
        s.codigoCorrelativo.toLowerCase().includes(q) ||
        s.paraSerUtilizado.toLowerCase().includes(q) ||
        s.solicitadoPor.toLowerCase().includes(q) ||
        s.fechaSolicitud.toLowerCase().includes(q) ||
        s.items.some((it) => it.producto.toLowerCase().includes(q))
      );
    });
  }, [solicitudesContraloria.solicitudes, filterEstado, searchQuery]);

  // Seleccionar automáticamente la primera solicitud pendiente cuando entra un nuevo mensaje
  useEffect(() => {
    if (filteredList.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && filteredList.some((s) => s.id === selectedId)) {
      return;
    }
    const firstPending = filteredList.find((s) => s.estado === 'PENDIENTE_APROBACION');
    setSelectedId((firstPending || filteredList[0]).id);
  }, [filteredList, selectedId]);

  const selectedSolicitud: SolicitudProductoContraloria | null = useMemo(
    () =>
      solicitudesContraloria.solicitudes.find((s) => s.id === selectedId) || null,
    [solicitudesContraloria.solicitudes, selectedId]
  );

  const handleSelectMessage = (sol: SolicitudProductoContraloria) => {
    setSelectedId(sol.id);
    setControllerNote(sol.notaContraloria || '');
    setActionBanner(null);
  };

  const handleControllerAction = async (decision: 'APROBADA' | 'RECHAZADA') => {
    if (!selectedSolicitud || isProcessingDecision) return;
    if (!isContraloriaOrAdmin) {
      setActionBanner({
        text: 'Segregación de Funciones: solo Contraloría Interna o Administración General pueden aprobar o rechazar solicitudes de producto.',
        isError: true,
      });
      return;
    }

    setIsProcessingDecision(decision);
    setActionBanner(null);

    try {
      const fn =
        decision === 'APROBADA'
          ? solicitudesContraloria.approveSolicitud
          : solicitudesContraloria.rejectSolicitud;

      const res = await fn(
        selectedSolicitud.id,
        controllerNote.trim() || undefined,
        auditorDisplayName
      );

      if (!res.success || !res.solicitud) {
        setActionBanner({
          text:
            res.error || 'No se pudo registrar la decisión en Contraloría Interna.',
          isError: true,
        });
        return;
      }

      if (decision === 'APROBADA') {
        onSelectApprovedRequisitionCode?.(res.solicitud.codigoCorrelativo);
      }

      setActionBanner({
        text:
          decision === 'APROBADA'
            ? `✓ Solicitud ${res.solicitud.codigoCorrelativo} APROBADA en tiempo real y notificada a Trade Marketing.`
            : `✕ Solicitud ${res.solicitud.codigoCorrelativo} RECHAZADA en tiempo real y notificada a Trade Marketing.`,
        isError: false,
      });
    } finally {
      setIsProcessingDecision(null);
    }
  };

  const renderMessageBadge = (estado: SolicitudContraloriaEstado) => {
    if (estado === 'PENDIENTE_APROBACION') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-[#DC2626] text-[#FFFFFF] shadow-sm animate-pulse">
          <Clock className="w-3 h-3" />
          Pendiente por aprobar
        </span>
      );
    }
    if (estado === 'APROBADA') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/35">
          <CheckCircle2 className="w-3 h-3" />
          Aprobada
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-zinc-800 text-red-300 border border-red-500/40">
        <XCircle className="w-3 h-3" />
        Rechazada
      </span>
    );
  };

  return (
    <div className="space-y-5">
      {/* Banner de retroalimentación al aprobar o rechazar */}
      {actionBanner && (
        <div
          role="status"
          className={`p-4 rounded-xl border text-xs font-bold flex items-center justify-between gap-3 ${
            actionBanner.isError
              ? 'bg-red-950/50 border-[#DC2626] text-red-200'
              : 'bg-emerald-950/40 border-emerald-500/50 text-emerald-100'
          }`}
        >
          <span>{actionBanner.text}</span>
          <button
            type="button"
            onClick={() => setActionBanner(null)}
            className="text-zinc-300 hover:text-white cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Barra de Filtros y Estado Realtime de la Bandeja de Entrada */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-4 shadow-xl flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#DC2626]/15 border border-[#DC2626]/40 text-white text-xs font-black uppercase">
            <Inbox className="w-4 h-4 text-red-400" />
            <span>Bandeja de Entrada · Trade Marketing</span>
            {solicitudesContraloria.pendingCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-[#DC2626] text-[#FFFFFF] font-mono text-[10px]">
                {solicitudesContraloria.pendingCount} pendiente(s)
              </span>
            )}
          </div>

          <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-zinc-400">
            <span
              className={`w-2 h-2 rounded-full ${
                solicitudesContraloria.isRealtimeConnected
                  ? 'bg-emerald-400 animate-pulse'
                  : 'bg-amber-400'
              }`}
            />
            {solicitudesContraloria.isRealtimeConnected
              ? 'Escucha Realtime Activa'
              : 'Sincronización REST'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar MP-07-XXXX, motivo, solicitante..."
              className="pl-8 pr-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 w-60"
            />
          </div>

          {(
            [
              {
                id: 'TODAS',
                label: `Todas (${solicitudesContraloria.solicitudes.length})`,
              },
              {
                id: 'PENDIENTE_APROBACION',
                label: `Pendientes (${solicitudesContraloria.pendingCount})`,
              },
              { id: 'APROBADA', label: 'Aprobadas' },
              { id: 'RECHAZADA', label: 'Rechazadas' },
            ] as const
          ).map((tab) => {
            const active = filterEstado === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterEstado(tab.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                  active
                    ? 'bg-[#DC2626] text-[#FFFFFF]'
                    : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
                }`}
              >
                {tab.label}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => void solicitudesContraloria.refreshSolicitudes()}
            title="Refrescar Bandeja de Entrada"
            className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white transition cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${
                solicitudesContraloria.isLoading ? 'animate-spin' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {/* Layout Maestro-Detalle: Lista de Mensajes Entrantes (Izquierda) + Formato Oficial y Aprobación (Derecha) */}
      {filteredList.length === 0 ? (
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-12 text-center space-y-3 shadow-xl">
          <div className="w-14 h-14 rounded-2xl bg-red-600/15 border border-red-500/30 flex items-center justify-center mx-auto text-red-400">
            <FileSpreadsheet className="w-7 h-7" />
          </div>
          <h3 className="text-base font-black text-white uppercase tracking-wide">
            Bandeja de Entrada sin Solicitudes en este Filtro
          </h3>
          <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
            Cuando Trade Marketing envíe una nueva{' '}
            <strong className="text-white">SOLICITUD DE PRODUCTOS</strong> desde la pestaña de Degustaciones, aparecerá aquí automáticamente en tiempo real con estado{' '}
            <strong className="text-red-400">Pendiente por aprobar</strong>.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Columna Izquierda (4 cols): Lista de Mensajes / Solicitudes Entrantes */}
          <div className="xl:col-span-4 bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden shadow-xl">
            <div className="px-4 py-3 bg-black border-b border-zinc-900 flex items-center justify-between">
              <span className="text-xs font-black text-white uppercase tracking-wider">
                Mensajes Entrantes ({filteredList.length})
              </span>
              <span className="text-[10px] font-mono text-zinc-400">
                Clic para auditar formato
              </span>
            </div>

            <div className="divide-y divide-zinc-900 max-h-[780px] overflow-y-auto">
              {filteredList.map((sol) => {
                const isSelected = selectedSolicitud?.id === sol.id;
                const isPending = sol.estado === 'PENDIENTE_APROBACION';
                return (
                  <button
                    key={sol.id}
                    type="button"
                    onClick={() => handleSelectMessage(sol)}
                    className={`w-full text-left p-4 transition-all cursor-pointer block ${
                      isSelected
                        ? 'bg-red-950/30 border-l-4 border-l-[#DC2626]'
                        : isPending
                          ? 'bg-zinc-950 hover:bg-zinc-900/80 border-l-4 border-l-red-500/40'
                          : 'bg-zinc-950/60 hover:bg-zinc-900/60 border-l-4 border-l-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="font-mono text-sm font-black text-white">
                        {sol.codigoCorrelativo}
                      </span>
                      {renderMessageBadge(sol.estado)}
                    </div>

                    <p className="text-xs font-extrabold text-zinc-100 uppercase line-clamp-2 leading-snug mb-2">
                      {sol.paraSerUtilizado}
                    </p>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-400">
                      <span className="inline-flex items-center gap-1 font-semibold text-zinc-300">
                        <User className="w-3 h-3 text-red-400" />
                        {sol.solicitadoPor}
                      </span>
                      <span className="font-mono">{sol.fechaSolicitud}</span>
                    </div>

                    <div className="mt-2 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[10px] font-mono text-zinc-400">
                      <span>{sol.items.length} producto(s)</span>
                      <span className="font-bold text-red-300">
                        Total: {sol.totalUnidades} un
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Columna Derecha (8 cols): Vista Previa Exacta Modo Lectura + Botones del Contralor */}
          <div className="xl:col-span-8 space-y-4">
            {selectedSolicitud && (
              <>
                {/* Panel de Acción de Contraloría Interna */}
                <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-5 shadow-xl space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-900">
                    <div className="flex items-center gap-2.5">
                      <span className="p-2 rounded-xl bg-[#DC2626] text-white">
                        <ShieldCheck className="w-5 h-5" />
                      </span>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm sm:text-base font-black text-white uppercase">
                            Revisión de Solicitud {selectedSolicitud.codigoCorrelativo}
                          </h3>
                          {renderMessageBadge(selectedSolicitud.estado)}
                        </div>
                        <p className="text-xs text-zinc-400">
                          Solicitante: <strong className="text-white">{selectedSolicitud.solicitadoPor}</strong> ({selectedSolicitud.departamentoSolicitante}) • Fecha: {selectedSolicitud.fechaSolicitud}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void exportSolicitudProductosPdf(selectedSolicitud)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-bold text-white transition cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5 text-red-400" />
                      <span>Exportar PDF Oficial</span>
                    </button>
                  </div>

                  {selectedSolicitud.estado === 'PENDIENTE_APROBACION' ? (
                    isContraloriaOrAdmin ? (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                          Nota de Contraloría o Motivo de Rechazo (Opcional):
                        </label>
                        <textarea
                          rows={2}
                          value={controllerNote}
                          onChange={(e) => setControllerNote(e.target.value)}
                          placeholder="Ingrese observaciones de autorización, instrucciones de despacho o motivo de rechazo..."
                          className="w-full px-3.5 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#DC2626]"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                        <button
                          type="button"
                          disabled={isProcessingDecision !== null}
                          onClick={() => void handleControllerAction('APROBADA')}
                          className="py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs sm:text-sm font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/60 transition cursor-pointer"
                        >
                          {isProcessingDecision === 'APROBADA' ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-4 h-4" />
                          )}
                          <span>Aprobar Solicitud</span>
                        </button>

                        <button
                          type="button"
                          disabled={isProcessingDecision !== null}
                          onClick={() => void handleControllerAction('RECHAZADA')}
                          className="py-3 px-4 rounded-xl bg-[#DC2626] hover:bg-red-700 disabled:opacity-60 text-white text-xs sm:text-sm font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg shadow-red-950/60 transition cursor-pointer"
                        >
                          {isProcessingDecision === 'RECHAZADA' ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <XCircle className="w-4 h-4" />
                          )}
                          <span>Rechazar Solicitud</span>
                        </button>
                      </div>
                    </div>
                    ) : (
                      <div className="p-3.5 rounded-xl bg-amber-950/30 border border-amber-500/35 text-xs text-amber-200 flex items-center gap-2.5">
                        <ShieldCheck className="w-4 h-4 text-amber-300 shrink-0" />
                        <span>
                          <strong>Segregación de Funciones activa:</strong> solicitud radicada y en
                          espera de dictamen por Contraloría Interna o Administración General.
                        </span>
                      </div>
                    )
                  ) : (
                    <div
                      className={`p-3.5 rounded-xl border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                        selectedSolicitud.estado === 'APROBADA'
                          ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                          : 'bg-red-950/30 border-red-500/40 text-red-200'
                      }`}
                    >
                      <div>
                        <span className="font-black uppercase block">
                          {selectedSolicitud.estado === 'APROBADA'
                            ? '✓ Solicitud Aprobada por Contraloría Interna'
                            : '✕ Solicitud Rechazada por Contraloría Interna'}
                        </span>
                        {selectedSolicitud.notaContraloria && (
                          <span className="text-zinc-200 block mt-0.5">
                            Nota registrada: {selectedSolicitud.notaContraloria}
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-zinc-300 sm:text-right">
                        {selectedSolicitud.resueltoPor && (
                          <span className="block">{selectedSolicitud.resueltoPor}</span>
                        )}
                        {selectedSolicitud.resueltoAt && (
                          <span className="block">
                            {new Date(selectedSolicitud.resueltoAt).toLocaleString('es-VE')}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Vista Previa Exacta del Formato "SOLICITUD DE PRODUCTOS" en Modo Lectura */}
                <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-4 sm:p-6 shadow-2xl">
                  <SolicitudProductosFormatSheet
                    mode="readonly"
                    codigoCorrelativo={selectedSolicitud.codigoCorrelativo}
                    fechaSolicitud={selectedSolicitud.fechaSolicitud}
                    fechaIso={selectedSolicitud.fechaIso}
                    dirigidoA={selectedSolicitud.dirigidoA}
                    paraSerUtilizado={selectedSolicitud.paraSerUtilizado}
                    rows={selectedSolicitud.items.map((it, idx) => ({
                      itemNumber: idx + 1,
                      producto: it.producto,
                      cantidad: it.cantidad,
                    }))}
                    observacion={selectedSolicitud.observacion}
                    solicitadoPor={selectedSolicitud.solicitadoPor}
                    firmaDigitalTexto={selectedSolicitud.firmaDigitalTexto}
                    firmaDigitalImagen={selectedSolicitud.firmaDigitalImagen}
                    departamentoSolicitante={selectedSolicitud.departamentoSolicitante}
                    estado={selectedSolicitud.estado}
                    notaContraloria={selectedSolicitud.notaContraloria}
                    resueltoPor={selectedSolicitud.resueltoPor}
                    resueltoAt={selectedSolicitud.resueltoAt}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
