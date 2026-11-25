import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  Package,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import {
  createPortalInventoryLog,
  fetchPortalInventoryLogs,
  generateClientSubmissionId,
  savePortalActiveStore,
  type PortalClientOption,
  type PortalInventoryRecord,
  type PortalProductOption,
  type PortalPromotoraContext,
} from '../../services/promotoraCampoService';
import { PortalProductSelector, PortalStoreSelector } from './PortalCatalogSelectors';
import {
  enqueuePortalInventoryAction,
  isTransientOfflineOrNetworkError,
} from '../../services/portalOfflineQueueService';

interface PortalInventarioTabProps {
  context: PortalPromotoraContext;
  clients: PortalClientOption[];
  products: PortalProductOption[];
  activeStore: string;
  onActiveStoreChange: (store: string) => void;
  onNotify: (message: string) => void;
  onActionQueuedOffline?: () => void;
}

export const PortalInventarioTab: React.FC<PortalInventarioTabProps> = ({
  context,
  clients,
  products,
  activeStore,
  onActiveStoreChange,
  onNotify,
  onActionQueuedOffline,
}) => {
  const [selectedZona, setSelectedZona] = useState<string>(context.direccion || context.region);
  const [productName, setProductName] = useState<string>(products[0]?.nombre || '');
  const [initialStockInput, setInitialStockInput] = useState<string>('');
  const [salesInput, setSalesInput] = useState<string>('0');
  const [tastingsInput, setTastingsInput] = useState<string>('0');
  const [observations, setObservations] = useState<string>('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const clientSubmissionIdRef = useRef<string>(generateClientSubmissionId());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savedRecord, setSavedRecord] = useState<PortalInventoryRecord | null>(null);

  const [history, setHistory] = useState<PortalInventoryRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  useEffect(() => {
    if (!productName && products.length > 0) {
      setProductName(products[0].nombre);
    }
  }, [productName, products]);

  const loadHistory = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const rows = await fetchPortalInventoryLogs(context);
      setHistory(rows);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [context]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const initialStock = Number(initialStockInput.replace(',', '.')) || 0;
  const salesGenerated = Number(salesInput.replace(',', '.')) || 0;
  const tastingsGiven = Number(tastingsInput.replace(',', '.')) || 0;
  const totalOut = Number((salesGenerated + tastingsGiven).toFixed(2));
  const rawFinal = Number((initialStock - totalOut).toFixed(2));
  const finalStock = Math.max(0, rawFinal);
  const isOverflow = initialStock > 0 && rawFinal < 0;
  const rotationPct =
    initialStock > 0 ? Math.min(100, Math.round((totalOut / initialStock) * 100)) : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isSubmittingRef.current) return;
    setSubmitError(null);

    if (!activeStore.trim()) {
      setSubmitError('Selecciona el Punto de Venta (PDV).');
      return;
    }
    if (!productName.trim()) {
      setSubmitError('Selecciona el Producto / SKU a reportar.');
      return;
    }
    if (initialStock <= 0) {
      setSubmitError('Ingresa el Inventario Inicial (mayor a 0).');
      return;
    }
    if (isOverflow) {
      setSubmitError('Ventas + Degustaciones no pueden superar el Inventario Inicial.');
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      const created = await createPortalInventoryLog({
        context,
        store: activeStore.trim(),
        zona: selectedZona,
        product: productName.trim(),
        initialQuantity: initialStock,
        salesGenerated,
        degustations: tastingsGiven,
        comments: observations,
        clientSubmissionId: clientSubmissionIdRef.current,
      });

      setSavedRecord(created);
      onNotify(
        `Balance guardado en Supabase (${created.product} · Inv. Final: ${created.finalQuantity})`
      );
      await loadHistory();
    } catch (err) {
      if (isTransientOfflineOrNetworkError(err)) {
        try {
          const queued = await enqueuePortalInventoryAction({
            id: clientSubmissionIdRef.current,
            store: activeStore.trim(),
            zona: selectedZona,
            product: productName.trim(),
            initialQuantity: initialStock,
            salesGenerated,
            degustations: tastingsGiven,
            comments: observations,
          });
          setSavedRecord({
            id: queued.id,
            date: queued.createdAtIso,
            store: queued.store,
            product: queued.product,
            initialQuantity: queued.initialQuantity,
            finalQuantity: finalStock,
            degustations: queued.degustations,
            sales_generated: queued.salesGenerated,
            comments: queued.comments || '',
            promoter: context.nombre,
            promotora_id: context.promotoraId,
            region: context.region,
            zona: queued.zona || '',
          });
          clientSubmissionIdRef.current = generateClientSubmissionId();
          onActionQueuedOffline?.();
          onNotify(
            'Sin señal: balance guardado en cola offline del teléfono. Se sincronizará automáticamente al volver la red.'
          );
          return;
        } catch {
          // Si falló IndexedDB, mostrar error original
        }
      }
      setSubmitError(
        err instanceof Error ? err.message : 'No se pudo guardar el balance de inventario.'
      );
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    clientSubmissionIdRef.current = generateClientSubmissionId();
    setSavedRecord(null);
    setInitialStockInput('');
    setSalesInput('0');
    setTastingsInput('0');
    setObservations('');
    setSubmitError(null);
  };

  return (
    <div className="space-y-4 pb-6" data-testid="portal-inventario-tab">
      {/* Cabecera */}
      <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 shadow-xl space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-red-600/20 border border-red-500/40 text-red-500 flex items-center justify-center shrink-0">
              <Package className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-black text-white uppercase tracking-wider">
                Control de Inventario y Degustación
              </h2>
              <p className="text-[10px] text-neutral-400 font-mono">
                Sincronización Directa → Módulo 1 · Informes ({context.region})
              </p>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full bg-red-950/60 border border-red-500/30 text-red-300 text-[9px] font-bold font-mono">
            {products.length} SKUs
          </span>
        </div>

        <div className="pt-2 border-t border-neutral-800/80">
          <PortalStoreSelector
            value={activeStore}
            onChange={(storeName, client) => {
              savePortalActiveStore(storeName);
              onActiveStoreChange(storeName);
              if (client?.zona) setSelectedZona(client.zona);
            }}
            clients={clients}
            label="Punto de Venta / Comercio (PDV):"
            testIdPrefix="inventario-store"
          />
        </div>
      </div>

      {savedRecord ? (
        <div
          data-testid="portal-inventario-success"
          className="bg-[#0d0d0d] border border-emerald-500/40 rounded-2xl p-6 text-center space-y-4 shadow-xl"
        >
          <div className="w-14 h-14 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-base font-black text-white">¡Balance de Inventario Registrado!</h3>
            <p className="text-xs text-neutral-400 mt-1">
              Visible inmediatamente en Módulo 1 → Informe → Inventario y Degustación.
            </p>
          </div>
          <div className="p-3 bg-[#171717] rounded-xl border border-neutral-800 text-xs text-left space-y-1 font-mono">
            <p className="text-white font-bold">{savedRecord.product}</p>
            <p className="text-neutral-400">{savedRecord.store}</p>
            <div className="grid grid-cols-3 gap-2 pt-1.5 text-center">
              <div className="bg-black/60 rounded-lg p-1.5">
                <span className="text-[9px] text-neutral-500 block">Inicial</span>
                <strong className="text-white">{savedRecord.initialQuantity}</strong>
              </div>
              <div className="bg-black/60 rounded-lg p-1.5">
                <span className="text-[9px] text-neutral-500 block">Ventas / Muestras</span>
                <strong className="text-emerald-400">
                  {savedRecord.sales_generated} / {savedRecord.degustations}
                </strong>
              </div>
              <div className="bg-black/60 rounded-lg p-1.5">
                <span className="text-[9px] text-neutral-500 block">Inv. Final</span>
                <strong className="text-amber-400">{savedRecord.finalQuantity}</strong>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs uppercase tracking-wider cursor-pointer"
          >
            Registrar Otro Balance
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Producto SKU */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <PortalProductSelector
              value={productName}
              onChange={(name) => setProductName(name)}
              products={products}
              label="1. Producto / SKU Degustado o Auditado:"
              testIdPrefix="inventario-product"
            />
          </div>

          {/* Cantidades y Balance */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <span className="text-[10px] font-bold uppercase tracking-wider text-red-400 block">
              2. Movimientos de Inventario y Degustación:
            </span>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[9px] font-bold uppercase text-neutral-400 block mb-1">
                  Inv. Inicial *
                </label>
                <input
                  type="number"
                  step="any"
                  min={0}
                  required
                  data-testid="portal-inv-inicial"
                  value={initialStockInput}
                  onChange={(e) => setInitialStockInput(e.target.value)}
                  placeholder="Ej. 50"
                  className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl px-2.5 py-2 text-xs text-white font-mono font-bold focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-neutral-400 block mb-1">
                  Ventas (Unid/Kg)
                </label>
                <input
                  type="number"
                  step="any"
                  min={0}
                  data-testid="portal-inv-ventas"
                  value={salesInput}
                  onChange={(e) => setSalesInput(e.target.value)}
                  placeholder="0"
                  className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl px-2.5 py-2 text-xs text-emerald-400 font-mono font-bold focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-neutral-400 block mb-1">
                  Degustaciones
                </label>
                <input
                  type="number"
                  step="any"
                  min={0}
                  data-testid="portal-inv-muestras"
                  value={tastingsInput}
                  onChange={(e) => setTastingsInput(e.target.value)}
                  placeholder="0"
                  className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl px-2.5 py-2 text-xs text-purple-300 font-mono font-bold focus:outline-none"
                />
              </div>
            </div>

            {/* Panel de Cálculo Automático */}
            <div
              className={`p-3 rounded-xl border grid grid-cols-3 gap-2 text-center font-mono ${
                isOverflow
                  ? 'bg-red-950/50 border-red-500/60'
                  : 'bg-[#151515] border-neutral-800'
              }`}
            >
              <div>
                <span className="text-[9px] text-neutral-400 block">Inv. Final</span>
                <strong className={`text-sm ${isOverflow ? 'text-red-400' : 'text-amber-400'}`}>
                  {isOverflow ? rawFinal : finalStock}
                </strong>
              </div>
              <div>
                <span className="text-[9px] text-neutral-400 block">Rotación Neta</span>
                <strong className="text-sm text-emerald-400">{totalOut}</strong>
              </div>
              <div>
                <span className="text-[9px] text-neutral-400 block flex items-center justify-center gap-0.5">
                  <TrendingUp className="w-2.5 h-2.5 text-emerald-400" />
                  Desplaz.
                </span>
                <strong className="text-sm text-white">{rotationPct}%</strong>
              </div>
            </div>

            {isOverflow && (
              <p className="text-[11px] text-red-400 font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Las ventas + degustaciones exceden el inventario inicial.</span>
              </p>
            )}

            <div>
              <label className="text-[9px] font-bold uppercase text-neutral-400 block mb-1">
                Observaciones de la Actividad:
              </label>
              <textarea
                rows={2}
                data-testid="portal-inv-observaciones"
                value={observations}
                onChange={(e) => setObservations(e.target.value)}
                placeholder="Receptividad del cliente, reposición solicitada, quiebre de stock..."
                className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl p-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none resize-none"
              />
            </div>
          </div>

          {submitError && (
            <div
              role="alert"
              className="p-3 rounded-xl bg-red-950/70 border border-red-500/50 text-red-200 text-xs flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}

          <button
            type="submit"
            data-testid="portal-inv-submit"
            disabled={isSubmitting || isOverflow || initialStock <= 0 || !activeStore.trim() || !productName.trim()}
            className={`w-full py-4 rounded-xl font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg transition-all ${
              isSubmitting || isOverflow || initialStock <= 0 || !activeStore.trim() || !productName.trim()
                ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white shadow-red-600/30 cursor-pointer'
            }`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Guardando Balance...</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                <span>Guardar Balance de Inventario</span>
              </>
            )}
          </button>
        </form>
      )}

      {/* Historial Reciente */}
      <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2.5 shadow-xl">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-black uppercase tracking-wider text-neutral-300">
            Balances Recientes ({history.length})
          </span>
          <button
            type="button"
            onClick={() => void loadHistory()}
            disabled={isLoadingHistory}
            className="px-2 py-0.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] font-mono flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 text-emerald-400 ${isLoadingHistory ? 'animate-spin' : ''}`} />
            <span>Actualizar</span>
          </button>
        </div>

        {history.length === 0 ? (
          <p className="text-[11px] text-neutral-500 text-center py-3">
            Aún no hay balances de inventario registrados.
          </p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {history.slice(0, 15).map((item) => (
              <div
                key={item.id}
                className="p-2.5 rounded-xl bg-[#161616] border border-neutral-800/80 text-xs space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-white truncate">{item.product}</span>
                  <span className="text-[10px] font-mono text-emerald-400 shrink-0">
                    Final: {item.finalQuantity}
                  </span>
                </div>
                <p className="text-[10px] text-neutral-400 truncate">
                  {item.store} • Ini: {item.initialQuantity} • Ventas: {item.sales_generated} •
                  Muestras: {item.degustations}
                </p>
                {item.comments && (
                  <p className="text-[10px] text-neutral-500 italic truncate">{item.comments}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
