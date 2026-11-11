import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  X,
  XCircle,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  SolicitudContraloriaEstado,
  SolicitudProductoContraloria,
  SolicitudProductoRowItem,
} from '../../types';
import {
  createInitialSolicitudRows,
  getTodayVenezuelaIso,
  isoToDdMmYyyy,
  validateSolicitudContraloriaDraft,
} from '../../services/solicitudesContraloriaService';
import { SolicitudProductosFormatSheet } from '../requisition/SolicitudProductosFormatSheet';
import { exportSolicitudProductosPdf } from '../../utils/pdfExport';

export const TradeContraloriaSolicitudesTab: React.FC = () => {
  const { currentUser, solicitudesContraloria } = useApp();

  const defaultApplicantName = useMemo(() => {
    if (
      currentUser?.role === 'jefe_trade' ||
      currentUser?.role === 'supervisor' ||
      currentUser?.role === 'gerente_admin'
    ) {
      return currentUser.name;
    }
    return 'Jefatura Trade Marketing';
  }, [currentUser]);

  const [fechaIso, setFechaIso] = useState<string>(() => getTodayVenezuelaIso());
  const [fechaSolicitud, setFechaSolicitud] = useState<string>(() =>
    isoToDdMmYyyy(getTodayVenezuelaIso())
  );
  const [dirigidoA, setDirigidoA] = useState<string>('CONTRALORÍA');
  const [paraSerUtilizado, setParaSerUtilizado] = useState<string>('');
  const [rows, setRows] = useState<SolicitudProductoRowItem[]>(() =>
    createInitialSolicitudRows(10)
  );
  const [observacion, setObservacion] = useState<string>('');
  const [solicitadoPor, setSolicitadoPor] = useState<string>(defaultApplicantName);
  const [firmaDigitalImagen, setFirmaDigitalImagen] = useState<string | undefined>(
    undefined
  );

  useEffect(() => {
    setSolicitadoPor((prev) => (prev.trim() ? prev : defaultApplicantName));
  }, [defaultApplicantName]);

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [successFeedback, setSuccessFeedback] = useState<string | null>(null);

  // Filtros del Historial en Tiempo Real
  const [historyFilter, setHistoryFilter] = useState<'TODAS' | SolicitudContraloriaEstado>(
    'TODAS'
  );
  const [historySearch, setHistorySearch] = useState<string>('');
  const [previewSolicitud, setPreviewSolicitud] =
    useState<SolicitudProductoContraloria | null>(null);

  // Mantener sincronizada la vista previa abierta si Contraloría aprueba/rechaza en tiempo real
  useEffect(() => {
    if (!previewSolicitud) return;
    const latest = solicitudesContraloria.solicitudes.find(
      (s) => s.id === previewSolicitud.id
    );
    if (latest && latest !== previewSolicitud) {
      setPreviewSolicitud(latest);
    }
  }, [solicitudesContraloria.solicitudes, previewSolicitud]);

  const handleRowChange = (
    index: number,
    field: 'producto' | 'cantidad',
    value: string
  ) => {
    setValidationError(null);
    setRows((prev) => {
      const base =
        prev.length >= 10
          ? [...prev]
          : [
              ...prev,
              ...Array.from({ length: 10 - prev.length }, (_, i) => ({
                itemNumber: prev.length + i + 1,
                producto: '',
                cantidad: '' as const,
              })),
            ];
      const current = base[index] || {
        itemNumber: index + 1,
        producto: '',
        cantidad: '',
      };
      if (field === 'producto') {
        base[index] = { ...current, producto: value.toUpperCase() };
      } else {
        const cleaned = value.trim();
        base[index] = {
          ...current,
          cantidad: cleaned === '' ? '' : Number(cleaned),
        };
      }
      return base;
    });
  };

  const handleAddRow = () => {
    setRows((prev) => [
      ...prev,
      {
        itemNumber: prev.length + 1,
        producto: '',
        cantidad: '',
      },
    ]);
  };

  const handleRemoveExtraRow = (index: number) => {
    if (index < 10) return;
    setRows((prev) =>
      prev
        .filter((_, idx) => idx !== index)
        .map((r, idx) => ({ ...r, itemNumber: idx + 1 }))
    );
  };

  const handleResetForm = () => {
    const todayIso = getTodayVenezuelaIso();
    setFechaIso(todayIso);
    setFechaSolicitud(isoToDdMmYyyy(todayIso));
    setDirigidoA('CONTRALORÍA');
    setParaSerUtilizado('');
    setRows(createInitialSolicitudRows(10));
    setObservacion('');
    setFirmaDigitalImagen(undefined);
    setValidationError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setValidationError(null);
    setSuccessFeedback(null);

    const check = validateSolicitudContraloriaDraft({
      dirigidoA,
      paraSerUtilizado,
      items: rows,
      observacion,
    });

    if (!check.valid) {
      setValidationError(check.error || 'Verifique los campos obligatorios del formato.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await solicitudesContraloria.submitSolicitud({
        codigoCorrelativo: solicitudesContraloria.nextCorrelativeCode,
        fechaSolicitud,
        fechaIso,
        dirigidoA,
        paraSerUtilizado,
        items: rows,
        observacion,
        solicitadoPor: solicitadoPor.trim() || defaultApplicantName,
        firmaDigitalTexto: solicitadoPor.trim() || defaultApplicantName,
        firmaDigitalImagen,
        departamentoSolicitante: 'MERCADEO Y PUBLICIDAD',
      });

      if (!res.success || !res.solicitud) {
        setValidationError(
          res.error || 'No se pudo enviar la solicitud a Contraloría Interna.'
        );
        return;
      }

      handleResetForm();
      setSuccessFeedback(
        `Solicitud ${res.solicitud.codigoCorrelativo} enviada exitosamente a la Bandeja de Entrada de Contraloría Interna (Estado: PENDIENTE POR APROBAR).`
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const approvedCount = useMemo(
    () =>
      solicitudesContraloria.solicitudes.filter((s) => s.estado === 'APROBADA').length,
    [solicitudesContraloria.solicitudes]
  );

  const rejectedCount = useMemo(
    () =>
      solicitudesContraloria.solicitudes.filter((s) => s.estado === 'RECHAZADA').length,
    [solicitudesContraloria.solicitudes]
  );

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return solicitudesContraloria.solicitudes.filter((s) => {
      if (historyFilter !== 'TODAS' && s.estado !== historyFilter) return false;
      if (!q) return true;
      return (
        s.codigoCorrelativo.toLowerCase().includes(q) ||
        s.paraSerUtilizado.toLowerCase().includes(q) ||
        s.solicitadoPor.toLowerCase().includes(q) ||
        s.fechaSolicitud.toLowerCase().includes(q) ||
        s.items.some((it) => it.producto.toLowerCase().includes(q))
      );
    });
  }, [solicitudesContraloria.solicitudes, historyFilter, historySearch]);

  const renderStatusBadge = (estado: SolicitudContraloriaEstado) => {
    if (estado === 'APROBADA') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/35">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Aprobada
        </span>
      );
    }
    if (estado === 'RECHAZADA') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-red-600/20 text-red-300 border border-red-500/40">
          <XCircle className="w-3.5 h-3.5" />
          Rechazada
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-[#DC2626] text-[#FFFFFF] shadow-sm">
        <Clock className="w-3.5 h-3.5" />
        Pendiente por aprobar
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Cabecera Ejecutiva del Submódulo */}
      <div className="bg-zinc-950 border border-white/10 rounded-2xl p-5 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-[#DC2626] text-[#FFFFFF] flex items-center justify-center shadow-lg shadow-red-950/60 shrink-0">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base sm:text-lg font-black text-white uppercase tracking-tight">
                  Solicitudes a Contraloría
                </h3>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-zinc-900 border border-white/10 text-zinc-200">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      solicitudesContraloria.isRealtimeConnected
                        ? 'bg-emerald-400 animate-pulse'
                        : 'bg-amber-400'
                    }`}
                  />
                  {solicitudesContraloria.isRealtimeConnected
                    ? 'Realtime Conectado con Contraloría'
                    : 'Sincronización REST Activa'}
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Formato oficial corporativo <strong className="text-white">SOLICITUD DE PRODUCTOS</strong> conectado en tiempo real con la Bandeja de Entrada de Contraloría Interna.
              </p>
            </div>
          </div>

          {/* Tarjetas rápidas de estado */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 shrink-0">
            <div className="px-3.5 py-2 rounded-xl bg-black border border-white/10">
              <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                Correlativo Actual
              </span>
              <span className="text-sm font-black font-mono text-white">
                {solicitudesContraloria.nextCorrelativeCode}
              </span>
            </div>
            <div className="px-3.5 py-2 rounded-xl bg-black border border-red-500/35">
              <span className="text-[10px] text-red-300 uppercase font-bold block">
                Pendientes
              </span>
              <span className="text-sm font-black font-mono text-red-400">
                {solicitudesContraloria.pendingCount}
              </span>
            </div>
            <div className="px-3.5 py-2 rounded-xl bg-black border border-emerald-500/30">
              <span className="text-[10px] text-emerald-300 uppercase font-bold block">
                Aprobadas
              </span>
              <span className="text-sm font-black font-mono text-emerald-400">
                {approvedCount}
              </span>
            </div>
            <div className="px-3.5 py-2 rounded-xl bg-black border border-zinc-800">
              <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                Rechazadas
              </span>
              <span className="text-sm font-black font-mono text-zinc-200">
                {rejectedCount}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Mensajes de Validación o Confirmación Real de Envío */}
      {validationError && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-red-950/60 border-2 border-[#DC2626] text-white flex items-start justify-between gap-3 shadow-lg"
        >
          <div className="flex items-start gap-2.5 text-xs">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-black uppercase tracking-wider block text-red-300">
                Validación Requerida Antes de Enviar
              </span>
              <span className="font-semibold text-white mt-0.5 block">
                {validationError}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setValidationError(null)}
            className="text-red-300 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successFeedback && (
        <div
          role="status"
          className="p-4 rounded-xl bg-emerald-950/50 border border-emerald-500/50 text-emerald-100 flex items-start justify-between gap-3 shadow-lg"
        >
          <div className="flex items-start gap-2.5 text-xs">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-black uppercase tracking-wider block text-emerald-300">
                Solicitud Radicada en Contraloría Interna
              </span>
              <span className="font-semibold text-white mt-0.5 block">
                {successFeedback}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSuccessFeedback(null)}
            className="text-emerald-300 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Formulario Interactivo Oficial "SOLICITUD DE PRODUCTOS" */}
      <form
        onSubmit={handleSubmit}
        className="bg-zinc-950/90 border border-white/10 rounded-2xl p-4 sm:p-6 shadow-2xl space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div>
            <span className="text-[10px] font-black uppercase tracking-widest text-red-400 block">
              Formato Oficial Mercadeo y Publicidad → Contraloría
            </span>
            <h4 className="text-sm font-bold text-white">
              Complete los productos destinados a degustaciones y envíe para aprobación
            </h4>
          </div>
          <button
            type="button"
            onClick={handleResetForm}
            disabled={isSubmitting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-300 hover:text-white transition cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Limpiar Formato</span>
          </button>
        </div>

        <SolicitudProductosFormatSheet
          mode="edit"
          codigoCorrelativo={solicitudesContraloria.nextCorrelativeCode}
          fechaSolicitud={fechaSolicitud}
          fechaIso={fechaIso}
          dirigidoA={dirigidoA}
          paraSerUtilizado={paraSerUtilizado}
          rows={rows}
          observacion={observacion}
          solicitadoPor={solicitadoPor}
          firmaDigitalTexto={solicitadoPor}
          firmaDigitalImagen={firmaDigitalImagen}
          departamentoSolicitante="MERCADEO Y PUBLICIDAD"
          onChangeFechaIso={(nextIso, nextSlash) => {
            setFechaIso(nextIso);
            setFechaSolicitud(nextSlash);
          }}
          onChangeDirigidoA={setDirigidoA}
          onChangeParaSerUtilizado={(val) => {
            setValidationError(null);
            setParaSerUtilizado(val);
          }}
          onChangeRow={handleRowChange}
          onAddRow={handleAddRow}
          onRemoveExtraRow={handleRemoveExtraRow}
          onChangeObservacion={setObservacion}
          onChangeSolicitadoPor={setSolicitadoPor}
          onChangeFirmaDigitalImagen={setFirmaDigitalImagen}
        />

        {/* Botón de Acción Principal */}
        <div className="pt-3 border-t border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-[11px] text-zinc-400">
            Al enviar, el documento se registrará con estado{' '}
            <code className="text-red-300 font-mono font-bold">PENDIENTE_APROBACION</code>{' '}
            y notificará de inmediato a Contraloría Interna.
          </p>

          <button
            type="submit"
            disabled={isSubmitting}
            className="px-6 py-3 rounded-xl bg-[#DC2626] hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed text-[#FFFFFF] text-xs sm:text-sm font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-[0_8px_24px_-4px_rgba(220,38,38,0.6)] border border-red-400/30 transition cursor-pointer shrink-0"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Enviando a Contraloría...</span>
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span>Enviar Solicitud a Contraloría</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* ===================================================================== */}
      {/* HISTORIAL EN TIEMPO REAL DE SOLICITUDES ENVIADAS A CONTRALORÍA        */}
      {/* ===================================================================== */}
      <div className="bg-zinc-950 border border-white/10 rounded-2xl p-5 shadow-xl space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div>
            <h4 className="text-sm sm:text-base font-black text-white uppercase tracking-wide">
              Historial de Solicitudes y Estado en Tiempo Real
            </h4>
            <p className="text-xs text-zinc-400">
              Las aprobaciones o rechazos emitidos desde Contraloría Interna actualizan esta tabla al instante.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Buscar código, motivo o producto..."
                className="pl-8 pr-3 py-1.5 rounded-xl bg-black border border-white/10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 w-56"
              />
            </div>

            {(
              [
                { id: 'TODAS', label: 'Todas' },
                { id: 'PENDIENTE_APROBACION', label: 'Pendientes' },
                { id: 'APROBADA', label: 'Aprobadas' },
                { id: 'RECHAZADA', label: 'Rechazadas' },
              ] as const
            ).map((f) => {
              const active = historyFilter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setHistoryFilter(f.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                    active
                      ? 'bg-[#DC2626] text-white'
                      : 'bg-zinc-900 text-zinc-400 hover:text-white border border-white/10'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => void solicitudesContraloria.refreshSolicitudes()}
              title="Sincronizar historial con Supabase"
              className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-zinc-300 hover:text-white transition cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  solicitudesContraloria.isLoading ? 'animate-spin' : ''
                }`}
              />
            </button>
          </div>
        </div>

        {filteredHistory.length === 0 ? (
          <div className="py-10 text-center text-xs text-zinc-400 bg-black/50 rounded-xl border border-zinc-900">
            No hay solicitudes registradas con el filtro seleccionado.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-black border-b border-zinc-800 text-[10px] font-black uppercase tracking-wider text-zinc-400">
                  <th className="p-3">CÓDIGO</th>
                  <th className="p-3">FECHA</th>
                  <th className="p-3">PARA SER UTILIZADO</th>
                  <th className="p-3">PRODUCTOS / CANT.</th>
                  <th className="p-3">SOLICITANTE</th>
                  <th className="p-3">ESTADO / NOTA CONTRALORÍA</th>
                  <th className="p-3 text-right">ACCIONES</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {filteredHistory.map((sol) => (
                  <tr
                    key={sol.id}
                    className="hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="p-3 font-mono font-black text-white whitespace-nowrap">
                      {sol.codigoCorrelativo}
                    </td>
                    <td className="p-3 font-mono text-zinc-300 whitespace-nowrap">
                      {sol.fechaSolicitud}
                    </td>
                    <td className="p-3 max-w-xs">
                      <span className="font-bold text-white uppercase block line-clamp-2">
                        {sol.paraSerUtilizado}
                      </span>
                      {sol.observacion && (
                        <span className="text-[10px] text-zinc-400 block truncate mt-0.5">
                          Obs: {sol.observacion}
                        </span>
                      )}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      <span className="font-bold text-white font-mono">
                        {sol.items.length} ítem(s)
                      </span>
                      <span className="text-[11px] text-red-400 font-mono font-bold block">
                        Total: {sol.totalUnidades} un
                      </span>
                    </td>
                    <td className="p-3 text-zinc-200 font-semibold whitespace-nowrap">
                      {sol.solicitadoPor}
                    </td>
                    <td className="p-3">
                      <div className="space-y-1">
                        {renderStatusBadge(sol.estado)}
                        {sol.notaContraloria && (
                          <p className="text-[11px] text-zinc-300 bg-black/70 border border-white/10 rounded px-2 py-1 max-w-xs">
                            <strong className="text-red-400">Contraloría:</strong>{' '}
                            {sol.notaContraloria}
                          </p>
                        )}
                        {sol.resueltoAt && (
                          <span className="block text-[10px] font-mono text-zinc-500">
                            Resuelto: {new Date(sol.resueltoAt).toLocaleString('es-VE')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setPreviewSolicitud(sol)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white border border-white/10 text-[11px] font-bold transition cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5 text-red-400" />
                          <span>Ver Formato</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void exportSolicitudProductosPdf(sol)}
                          title="Descargar Formato Oficial en PDF"
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#DC2626] hover:bg-red-700 text-white text-[11px] font-bold transition cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>PDF</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal de Vista Previa en Modo Lectura del Formato Oficial */}
      {previewSolicitud && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm overflow-y-auto">
          <div className="relative w-full max-w-5xl bg-zinc-950 border border-white/15 rounded-2xl shadow-2xl overflow-hidden my-8">
            <div className="px-6 py-4 bg-black border-b border-zinc-900 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {renderStatusBadge(previewSolicitud.estado)}
                <div>
                  <h4 className="text-sm sm:text-base font-black text-white uppercase">
                    Vista Previa Oficial · {previewSolicitud.codigoCorrelativo}
                  </h4>
                  <p className="text-[11px] text-zinc-400">
                    Emitida el {previewSolicitud.fechaSolicitud} por{' '}
                    {previewSolicitud.solicitadoPor}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void exportSolicitudProductosPdf(previewSolicitud)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#DC2626] hover:bg-red-700 text-white text-xs font-black uppercase transition cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Descargar PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewSolicitud(null)}
                  className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-4 sm:p-8 bg-zinc-900/80 max-h-[78vh] overflow-y-auto">
              <SolicitudProductosFormatSheet
                mode="readonly"
                codigoCorrelativo={previewSolicitud.codigoCorrelativo}
                fechaSolicitud={previewSolicitud.fechaSolicitud}
                fechaIso={previewSolicitud.fechaIso}
                dirigidoA={previewSolicitud.dirigidoA}
                paraSerUtilizado={previewSolicitud.paraSerUtilizado}
                rows={previewSolicitud.items.map((it, idx) => ({
                  itemNumber: idx + 1,
                  producto: it.producto,
                  cantidad: it.cantidad,
                }))}
                observacion={previewSolicitud.observacion}
                solicitadoPor={previewSolicitud.solicitadoPor}
                firmaDigitalTexto={previewSolicitud.firmaDigitalTexto}
                firmaDigitalImagen={previewSolicitud.firmaDigitalImagen}
                departamentoSolicitante={previewSolicitud.departamentoSolicitante}
                estado={previewSolicitud.estado}
                notaContraloria={previewSolicitud.notaContraloria}
                resueltoPor={previewSolicitud.resueltoPor}
                resueltoAt={previewSolicitud.resueltoAt}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
