import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Package,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Store as StoreIcon,
  UserCheck,
  WifiOff,
} from 'lucide-react';
import {
  createClientSubmissionId,
  obtenerDatosPdvPorToken,
  PublicPdvSecurityError,
  reportarEjecucionPdv,
  type PublicPdvBootstrapPayload,
} from '../../services/publicPdvLinksService';
import { formatCanonicalSucursalBadge } from '../../utils/regionalSyncClassifier';
import { getCaracasTodayYmd } from '../../utils/caracasWeekCycle';

export interface PublicTokenPdvViewProps {
  token: string;
  initialBootstrapForQa?: PublicPdvBootstrapPayload | null;
}

export const PublicTokenPdvView: React.FC<PublicTokenPdvViewProps> = ({
  token,
  initialBootstrapForQa = null,
}) => {
  const [loading, setLoading] = useState<boolean>(() => !initialBootstrapForQa);
  const [bootstrap, setBootstrap] = useState<PublicPdvBootstrapPayload | null>(
    () => initialBootstrapForQa
  );
  const [fatalError, setFatalError] = useState<string | null>(null);

  const [selectedDegustacionId, setSelectedDegustacionId] = useState<string>('');
  const [selectedPromotoraId, setSelectedPromotoraId] = useState<string>('');
  const [selectedClienteId, setSelectedClienteId] = useState<string>('');
  const [manualStoreName, setManualStoreName] = useState<string>('');
  const [selectedProductoNombre, setSelectedProductoNombre] = useState<string>('');
  const [muestrasEntregadas, setMuestrasEntregadas] = useState<string>('0');
  const [ventasAsistidas, setVentasAsistidas] = useState<string>('0');
  const [unidadesAbiertas, setUnidadesAbiertas] = useState<string>('1');
  const [loteProducto, setLoteProducto] = useState<string>('');
  const [observaciones, setObservaciones] = useState<string>('');
  const [fechaReporte, setFechaReporte] = useState<string>(() => getCaracasTodayYmd());

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitReceipt, setSubmitReceipt] = useState<{
    submissionId: string;
    store: string;
    product: string;
    muestras: number;
    ventas: number;
  } | null>(null);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    setFatalError(null);
    try {
      const data = await obtenerDatosPdvPorToken(token);
      setBootstrap(data);
    } catch (err) {
      setBootstrap(null);
      setFatalError(
        err instanceof Error
          ? err.message
          : 'Este enlace público PDV no está disponible. Solicita un enlace vigente a Coordinación.'
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (initialBootstrapForQa) return;
    void loadBootstrap();
  }, [initialBootstrapForQa, loadBootstrap]);

  const selectedDegustacion = useMemo(() => {
    if (!bootstrap || !selectedDegustacionId) return null;
    return (
      bootstrap.degustacionesAutorizadas.find(
        (d) => d.degustacion_id === selectedDegustacionId
      ) ?? null
    );
  }, [bootstrap, selectedDegustacionId]);

  useEffect(() => {
    if (!selectedDegustacion || !bootstrap) return;
    if (selectedDegustacion.promotora_id) {
      setSelectedPromotoraId(selectedDegustacion.promotora_id);
    }
    const matchedStore = bootstrap.tiendas.find(
      (t) =>
        t.nombre_comercial.trim().toUpperCase() ===
        selectedDegustacion.cliente_nombre.trim().toUpperCase()
    );
    if (matchedStore) {
      setSelectedClienteId(matchedStore.id);
      setManualStoreName(matchedStore.nombre_comercial);
    } else {
      setSelectedClienteId('');
      setManualStoreName(selectedDegustacion.cliente_nombre);
    }
    if (selectedDegustacion.producto_resumen) {
      setSelectedProductoNombre(selectedDegustacion.producto_resumen);
    }
    if (selectedDegustacion.fecha) {
      setFechaReporte(selectedDegustacion.fecha);
    }
  }, [selectedDegustacion, bootstrap]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex flex-col items-center justify-center p-6 gap-3">
        <Loader2 className="w-7 h-7 animate-spin text-red-500" />
        <p className="text-xs font-mono text-zinc-400">
          Validando enlace regional de punto de venta...
        </p>
      </div>
    );
  }

  if (fatalError || !bootstrap) {
    return (
      <div
        data-testid="public-pdv-blocked-screen"
        className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4"
      >
        <div className="w-full max-w-md rounded-2xl bg-zinc-950 border border-red-500/40 p-6 space-y-4 text-center shadow-2xl">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-red-600/20 border border-red-500/40 flex items-center justify-center">
            <ShieldAlert className="w-6 h-6 text-red-400" />
          </div>
          <h1 className="text-base font-extrabold text-white">
            Enlace Público PDV No Válido o Revocado
          </h1>
          <p className="text-xs text-zinc-300 leading-relaxed">
            {fatalError ||
              'Por seguridad multisede, solicita el enlace actualizado a la coordinadora de tu sucursal.'}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-1">
            <a
              href="/portal"
              data-testid="public-pdv-go-to-portal-login"
              className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-black uppercase tracking-wider text-white inline-flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-red-950/50"
            >
              <span>Ingresar a la App de Promotoras</span>
            </a>
            <button
              type="button"
              onClick={() => void loadBootstrap()}
              className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-bold text-zinc-200 inline-flex items-center justify-center gap-2 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reintentar validación</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const sucursalBadge =
    formatCanonicalSucursalBadge(bootstrap.sucursal) ?? `SUCURSAL ${bootstrap.sucursal}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    setSubmitReceipt(null);

    const storeObj = bootstrap.tiendas.find((t) => t.id === selectedClienteId) ?? null;
    const promObj = bootstrap.promotoras.find((p) => p.id === selectedPromotoraId) ?? null;
    const resolvedStoreName = (
      storeObj?.nombre_comercial ||
      selectedDegustacion?.cliente_nombre ||
      manualStoreName
    ).trim();
    const resolvedProduct = (
      selectedProductoNombre ||
      selectedDegustacion?.producto_resumen ||
      ''
    ).trim();

    if (!resolvedStoreName) {
      setSubmitError('Selecciona una degustación autorizada o una tienda de tu sucursal.');
      return;
    }
    if (!resolvedProduct) {
      setSubmitError('Selecciona el producto del catálogo nacional.');
      return;
    }

    const muestrasNum = Math.max(0, Math.trunc(Number(muestrasEntregadas) || 0));
    const ventasNum = Math.max(0, Math.trunc(Number(ventasAsistidas) || 0));
    const abiertasNum = Math.max(0, Math.trunc(Number(unidadesAbiertas) || 0));
    const submissionId = createClientSubmissionId();

    setSubmitting(true);
    try {
      const res = await reportarEjecucionPdv(token, {
        degustacionId: selectedDegustacionId || null,
        promotoraId: promObj?.id ?? null,
        promotoraNombre: promObj?.nombre_completo ?? selectedDegustacion?.promotora_nombre ?? null,
        clienteId: storeObj?.id ?? null,
        clienteNombre: resolvedStoreName,
        productoNombre: resolvedProduct,
        muestrasEntregadas: muestrasNum,
        ventasAsistidas: ventasNum,
        unidadesAbiertas: abiertasNum,
        loteProducto: loteProducto.trim() || null,
        observaciones: observaciones.trim() || null,
        fecha: fechaReporte,
        clientSubmissionId: submissionId,
      });

      setSubmitReceipt({
        submissionId: res.clientSubmissionId,
        store: resolvedStoreName,
        product: resolvedProduct,
        muestras: muestrasNum,
        ventas: ventasNum,
      });
      setMuestrasEntregadas('0');
      setVentasAsistidas('0');
      setLoteProducto('');
      setObservaciones('');
      void loadBootstrap();
    } catch (err) {
      if (err instanceof PublicPdvSecurityError && err.code === 'INVALID_TOKEN') {
        setFatalError(err.message);
      } else {
        setSubmitError(
          err instanceof Error
            ? err.message
            : 'No se pudo enviar el reporte PDV. Verifica tu conexión e intenta nuevamente.'
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="public-token-pdv-view"
      className="min-h-screen bg-[#09090b] text-white font-sans pb-12"
    >
      <header className="sticky top-0 z-20 bg-zinc-950/95 border-b border-white/10 backdrop-blur-md">
        <div className="max-w-xl mx-auto px-4 py-3.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-white p-1 flex items-center justify-center shrink-0">
              <img
                src="/codizulca-logo.png"
                alt="CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-extrabold tracking-tight text-white">
                  REPORTE PDV PROMOTORAS
                </span>
                <span
                  data-testid="public-pdv-sucursal-badge"
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black border ${
                    bootstrap.sucursal === 'CENTRO'
                      ? 'bg-amber-500/15 text-amber-300 border-amber-400/40'
                      : 'bg-red-600/20 text-red-300 border-red-500/45'
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" />
                  {sucursalBadge}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 truncate">
                {bootstrap.tiendas.length} tiendas · {bootstrap.promotoras.length} promotoras ·{' '}
                {bootstrap.degustacionesAutorizadas.length} degustaciones autorizadas
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadBootstrap()}
            title="Sincronizar catálogo de sucursal"
            className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-zinc-300 hover:text-white cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 pt-5 space-y-4">
        {bootstrap.fromOfflineCache && (
          <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-500/40 text-xs text-amber-200 flex items-center gap-2">
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Modo lectura en caché local (señal inestable). Reconecta antes de enviar.</span>
          </div>
        )}

        {submitReceipt && (
          <div
            data-testid="public-pdv-submit-success"
            className="p-4 rounded-2xl bg-emerald-950/50 border border-emerald-500/40 space-y-1.5"
          >
            <div className="flex items-center gap-2 text-xs font-extrabold text-emerald-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>¡Reporte registrado exitosamente en {sucursalBadge}!</span>
            </div>
            <p className="text-xs text-zinc-200">
              <strong>{submitReceipt.store}</strong> · {submitReceipt.product} ({submitReceipt.muestras}{' '}
              muestras / {submitReceipt.ventas} ventas)
            </p>
            <p className="text-[10px] font-mono text-zinc-400">
              Comprobante: {submitReceipt.submissionId}
            </p>
          </div>
        )}

        {submitError && (
          <div
            data-testid="public-pdv-submit-error"
            className="p-3.5 rounded-xl bg-red-950/60 border border-red-500/40 text-xs text-red-200 flex items-start gap-2.5"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{submitError}</span>
          </div>
        )}

        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="rounded-2xl bg-zinc-950 border border-white/10 p-5 space-y-4 shadow-xl"
        >
          <div>
            <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 mb-1.5">
              <ClipboardCheck className="w-3.5 h-3.5 text-red-400" />
              <span>1. Degustación Autorizada ({sucursalBadge})</span>
            </label>
            <select
              data-testid="select-pdv-degustacion"
              value={selectedDegustacionId}
              onChange={(e) => setSelectedDegustacionId(e.target.value)}
              className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2.5 text-xs text-white focus:outline-none focus:border-red-500"
            >
              <option value="">— Seleccionar degustación autorizada (o reporte directo PDV) —</option>
              {bootstrap.degustacionesAutorizadas.map((d) => (
                <option key={d.degustacion_id} value={d.degustacion_id}>
                  {d.fecha} · {d.cliente_nombre} · {d.producto_resumen} ({d.turno})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 mb-1.5">
                <UserCheck className="w-3.5 h-3.5 text-red-400" />
                <span>2. Promotora ({sucursalBadge})</span>
              </label>
              <select
                data-testid="select-pdv-promotora"
                value={selectedPromotoraId}
                onChange={(e) => setSelectedPromotoraId(e.target.value)}
                required={bootstrap.promotoras.length > 0}
                className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2.5 text-xs text-white focus:outline-none focus:border-red-500"
              >
                <option value="">Seleccionar promotora...</option>
                {bootstrap.promotoras.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre_completo} ({p.categoria})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 mb-1.5">
                <StoreIcon className="w-3.5 h-3.5 text-red-400" />
                <span>3. Tienda / PDV ({sucursalBadge})</span>
              </label>
              <select
                data-testid="select-pdv-tienda"
                value={selectedClienteId}
                onChange={(e) => {
                  setSelectedClienteId(e.target.value);
                  const hit = bootstrap.tiendas.find((t) => t.id === e.target.value);
                  if (hit) setManualStoreName(hit.nombre_comercial);
                }}
                required={!selectedDegustacion}
                className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2.5 text-xs text-white focus:outline-none focus:border-red-500"
              >
                <option value="">
                  {selectedDegustacion
                    ? `${selectedDegustacion.cliente_nombre} (Desde autorización)`
                    : 'Seleccionar tienda...'}
                </option>
                {bootstrap.tiendas.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre_comercial}
                    {t.ciudad ? ` — ${t.ciudad}` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 mb-1.5">
              <Package className="w-3.5 h-3.5 text-red-400" />
              <span>4. Producto Degustado (Catálogo Nacional)</span>
            </label>
            <select
              data-testid="select-pdv-producto-nacional"
              value={selectedProductoNombre}
              onChange={(e) => setSelectedProductoNombre(e.target.value)}
              required
              className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2.5 text-xs text-white focus:outline-none focus:border-red-500"
            >
              <option value="">Seleccionar producto...</option>
              {selectedDegustacion?.producto_resumen &&
                !bootstrap.productos.some(
                  (p) => p.nombre === selectedDegustacion.producto_resumen
                ) && (
                  <option value={selectedDegustacion.producto_resumen}>
                    {selectedDegustacion.producto_resumen}
                  </option>
                )}
              {bootstrap.productos.map((prod) => (
                <option key={prod.id} value={prod.nombre}>
                  {prod.nombre}
                  {prod.marca ? ` · ${prod.marca}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                Muestras
              </label>
              <input
                type="number"
                min={0}
                max={9999}
                value={muestrasEntregadas}
                onChange={(e) => setMuestrasEntregadas(e.target.value)}
                required
                className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2 text-sm font-mono text-white"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                Ventas (Unid.)
              </label>
              <input
                type="number"
                min={0}
                max={9999}
                value={ventasAsistidas}
                onChange={(e) => setVentasAsistidas(e.target.value)}
                required
                className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2 text-sm font-mono text-white"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                Unid. Abiertas
              </label>
              <input
                type="number"
                min={0}
                max={999}
                value={unidadesAbiertas}
                onChange={(e) => setUnidadesAbiertas(e.target.value)}
                className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2 text-sm font-mono text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                Fecha de Ejecución
              </label>
              <input
                type="date"
                value={fechaReporte}
                onChange={(e) => setFechaReporte(e.target.value)}
                required
                className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2 text-xs font-mono text-white"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                Lote de Producto (Opcional)
              </label>
              <input
                type="text"
                maxLength={60}
                placeholder="Ej. L-202611"
                value={loteProducto}
                onChange={(e) => setLoteProducto(e.target.value)}
                className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2 text-xs text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-zinc-300 mb-1">
              Observaciones de Ejecución en PDV
            </label>
            <textarea
              rows={2}
              maxLength={400}
              placeholder="Comentarios de aceptación, flujo de clientes o incidencias..."
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              className="w-full rounded-xl bg-zinc-900 border border-white/10 px-3 py-2 text-xs text-white resize-none"
            />
          </div>

          <button
            type="submit"
            data-testid="btn-submit-public-pdv-report"
            disabled={submitting}
            className="w-full py-3 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-xs font-extrabold uppercase tracking-wider flex items-center justify-center gap-2 transition cursor-pointer"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Enviando reporte a {sucursalBadge}...</span>
              </>
            ) : (
              <span>Enviar Reporte de Ejecución PDV</span>
            )}
          </button>
        </form>
      </main>
    </div>
  );
};
