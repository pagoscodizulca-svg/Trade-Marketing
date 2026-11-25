import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import type { BcvRateSnapshot, PriceOcrDetectionResult } from '../../types';
import {
  PORTAL_COMPETITOR_BRANDS,
  createPortalPriceSurvey,
  generateClientSubmissionId,
  savePortalActiveStore,
  validatePortalImageFile,
  type PortalClientOption,
  type PortalProductOption,
  type PortalPromotoraContext,
} from '../../services/promotoraCampoService';
import { fetchOfficialBcvRate } from '../../services/bcvRateService';
import { scanShelfPriceTagWithAi } from '../../services/priceOcrService';
import {
  computeBimonetaryGap,
  convertAmountBimonetary,
  getCaracasIsoDate,
  type PriceCurrency,
} from '../../utils/bimonetaryPriceMath';
import { PortalProductSelector, PortalStoreSelector } from './PortalCatalogSelectors';
import {
  enqueuePortalPriceAction,
  isTransientOfflineOrNetworkError,
} from '../../services/portalOfflineQueueService';

interface PortalPreciosTabProps {
  context: PortalPromotoraContext;
  clients: PortalClientOption[];
  products: PortalProductOption[];
  activeStore: string;
  onActiveStoreChange: (store: string) => void;
  onNotify: (message: string) => void;
  onActionQueuedOffline?: () => void;
}

interface CompetitorDraftRow {
  name: string;
  priceInput: string;
  currency: PriceCurrency;
}

const CURRENCY_OPTIONS: ReadonlyArray<{ id: PriceCurrency; label: string }> = [
  { id: 'USD', label: 'USD ($)' },
  { id: 'VES', label: 'Bs (VES)' },
];

export const PortalPreciosTab: React.FC<PortalPreciosTabProps> = ({
  context,
  clients,
  products,
  activeStore,
  onActiveStoreChange,
  onNotify,
  onActionQueuedOffline,
}) => {
  const [selectedProduct, setSelectedProduct] = useState<string>(products[0]?.nombre || '');
  const [ownPriceInput, setOwnPriceInput] = useState<string>('');
  const [ownCurrency, setOwnCurrency] = useState<PriceCurrency>('USD');
  const [bcvSnapshot, setBcvSnapshot] = useState<BcvRateSnapshot | null>(null);
  const [isLoadingBcv, setIsLoadingBcv] = useState<boolean>(false);

  const [competitors, setCompetitors] = useState<CompetitorDraftRow[]>([
    { name: PORTAL_COMPETITOR_BRANDS[0], priceInput: '', currency: 'USD' },
    { name: PORTAL_COMPETITOR_BRANDS[1], priceInput: '', currency: 'USD' },
  ]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [observations, setObservations] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const clientSubmissionIdRef = useRef<string>(generateClientSubmissionId());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Estado para Lectura Asistida con IA (Confirmación Humana Obligatoria)
  const [isScanningAi, setIsScanningAi] = useState<boolean>(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [pendingOcrResult, setPendingOcrResult] = useState<PriceOcrDetectionResult | null>(null);
  const [ocrAppliedMeta, setOcrAppliedMeta] = useState<{
    assisted: boolean;
    confidence: 'alta' | 'media' | 'baja' | null;
  }>({ assisted: false, confidence: null });

  useEffect(() => {
    if (!selectedProduct && products.length > 0) {
      setSelectedProduct(products[0].nombre);
    }
  }, [products, selectedProduct]);

  useEffect(() => {
    let active = true;
    setIsLoadingBcv(true);
    fetchOfficialBcvRate()
      .then((snap) => {
        if (active && snap) setBcvSnapshot(snap);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setIsLoadingBcv(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (photoPreviewUrl && photoPreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(photoPreviewUrl);
      }
    };
  }, [photoPreviewUrl]);

  const activeBcvRate = bcvSnapshot?.tasaUsdVes ?? null;

  const selectedClientMeta = useMemo(() => {
    const clean = activeStore.trim().toLowerCase();
    if (!clean) return null;
    return clients.find((c) => c.nombre.trim().toLowerCase() === clean) ?? null;
  }, [clients, activeStore]);

  const ownNumericInput = Number(ownPriceInput.replace(',', '.')) || 0;
  const ownConverted = useMemo(() => {
    try {
      return convertAmountBimonetary({
        amount: ownNumericInput,
        currency: ownCurrency,
        bcvRate: activeBcvRate,
      });
    } catch {
      return {
        originalPrice: ownNumericInput,
        currency: ownCurrency,
        priceUsd: 0,
        priceBs: ownCurrency === 'VES' ? ownNumericInput : null,
      };
    }
  }, [ownNumericInput, ownCurrency, activeBcvRate]);

  const hasAnyVesInput =
    (ownCurrency === 'VES' && ownNumericInput > 0) ||
    competitors.some((c) => c.currency === 'VES' && (Number(c.priceInput.replace(',', '.')) || 0) > 0);

  const addCompetitor = () => {
    if (competitors.length >= 3) return;
    const nextBrand =
      PORTAL_COMPETITOR_BRANDS.find((b) => !competitors.some((c) => c.name === b)) ||
      `Competidor ${competitors.length + 1}`;
    setCompetitors((prev) => [...prev, { name: nextBrand, priceInput: '', currency: 'USD' }]);
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSubmitError(null);
    setOcrError(null);
    setPendingOcrResult(null);
    try {
      validatePortalImageFile(file);
      if (photoPreviewUrl && photoPreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(photoPreviewUrl);
      }
      setPhotoFile(file);
      setPhotoPreviewUrl(URL.createObjectURL(file));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Foto inválida.');
    }
  };

  const handleScanWithAi = async () => {
    if (!photoFile || isScanningAi) return;
    setOcrError(null);
    setIsScanningAi(true);
    try {
      const resp = await scanShelfPriceTagWithAi(photoFile);
      setPendingOcrResult(resp.result);
    } catch (err) {
      setOcrError(
        err instanceof Error
          ? err.message
          : 'No se pudo leer el hablador con IA. Ingresa los datos manualmente.'
      );
    } finally {
      setIsScanningAi(false);
    }
  };

  const handleApplyOcrToOwn = () => {
    if (!pendingOcrResult) return;
    if (pendingOcrResult.monto_detectado !== null) {
      setOwnPriceInput(String(pendingOcrResult.monto_detectado));
    }
    if (pendingOcrResult.moneda_detectada) {
      setOwnCurrency(pendingOcrResult.moneda_detectada);
    }
    if (pendingOcrResult.producto_detectado) {
      const targetUpper = pendingOcrResult.producto_detectado.toUpperCase();
      const matched = products.find((p) => p.nombre.toUpperCase().includes(targetUpper));
      if (matched) setSelectedProduct(matched.nombre);
    }
    setOcrAppliedMeta({ assisted: true, confidence: pendingOcrResult.confianza });
    setPendingOcrResult(null);
    onNotify('Lectura IA aplicada a Precio Propio. Verifica los valores antes de guardar.');
  };

  const handleApplyOcrToCompetitor = (idx: number) => {
    if (!pendingOcrResult) return;
    setCompetitors((prev) =>
      prev.map((item, i) => {
        if (i !== idx) return item;
        return {
          ...item,
          name: pendingOcrResult.marca_detectada || item.name,
          priceInput:
            pendingOcrResult.monto_detectado !== null
              ? String(pendingOcrResult.monto_detectado)
              : item.priceInput,
          currency: pendingOcrResult.moneda_detectada ?? item.currency,
        };
      })
    );
    setOcrAppliedMeta({ assisted: true, confidence: pendingOcrResult.confianza });
    setPendingOcrResult(null);
    onNotify(`Lectura IA aplicada a Competidor ${idx + 1}. Verifica los valores antes de guardar.`);
  };

  const handleSave = async () => {
    if (isSubmitting || isSubmittingRef.current) return;
    setSubmitError(null);
    if (!activeStore.trim()) {
      setSubmitError('Selecciona el Punto de Venta (PDV).');
      return;
    }
    if (!selectedProduct.trim()) {
      setSubmitError('Selecciona el producto evaluado.');
      return;
    }
    if (ownNumericInput <= 0) {
      setSubmitError('Ingresa el precio en góndola de Codizulca (mayor a 0).');
      return;
    }
    if (hasAnyVesInput && (!activeBcvRate || activeBcvRate <= 10)) {
      setSubmitError(
        'No hay una tasa BCV válida disponible para convertir montos en Bs (VES). Captura en USD o espera a que se cargue la tasa BCV.'
      );
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      await createPortalPriceSurvey({
        context,
        store: activeStore.trim(),
        cadena: selectedClientMeta?.cadena,
        zona: selectedClientMeta?.zona || context.direccion,
        ourProduct: selectedProduct.trim(),
        ourPriceUsd: ownConverted.priceUsd > 0 ? ownConverted.priceUsd : ownNumericInput,
        ownCurrency,
        ownOriginalPrice: ownNumericInput,
        bcvRate: activeBcvRate ?? 0,
        bcvRateDate: bcvSnapshot?.fecha ?? getCaracasIsoDate(),
        competitors: competitors.map((c) => ({
          name: c.name,
          originalPrice: Number(c.priceInput.replace(',', '.')) || 0,
          currency: c.currency,
        })),
        photoFile,
        observations,
        ocrAsistido: ocrAppliedMeta.assisted,
        ocrConfianza: ocrAppliedMeta.confidence,
        clientSubmissionId: clientSubmissionIdRef.current,
      });
      setSaveSuccess(true);
      onNotify(`Monitoreo bimonetario guardado (${selectedProduct.trim()})`);
    } catch (err) {
      if (isTransientOfflineOrNetworkError(err)) {
        try {
          await enqueuePortalPriceAction({
            id: clientSubmissionIdRef.current,
            store: activeStore.trim(),
            cadena: selectedClientMeta?.cadena,
            zona: selectedClientMeta?.zona || context.direccion,
            ourProduct: selectedProduct.trim(),
            ourPriceUsd: ownConverted.priceUsd > 0 ? ownConverted.priceUsd : ownNumericInput,
            ownCurrency,
            ownOriginalPrice: ownNumericInput,
            bcvRate: activeBcvRate ?? 0,
            bcvRateDate: bcvSnapshot?.fecha ?? getCaracasIsoDate(),
            competitors: competitors.map((c) => ({
              name: c.name,
              originalPrice: Number(c.priceInput.replace(',', '.')) || 0,
              currency: c.currency,
            })),
            photoFile,
            observations,
            ocrAsistido: ocrAppliedMeta.assisted,
            ocrConfianza: ocrAppliedMeta.confidence,
          });
          clientSubmissionIdRef.current = generateClientSubmissionId();
          setSaveSuccess(true);
          onActionQueuedOffline?.();
          onNotify(
            'Sin señal: comparativa de precios guardada en cola offline del teléfono. Se sincronizará automáticamente.'
          );
          return;
        } catch {
          // Si falló IndexedDB, mostrar error original
        }
      }
      setSubmitError(err instanceof Error ? err.message : 'No se pudo guardar el monitoreo.');
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 pb-6" data-testid="portal-precios-tab">
      <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 shadow-xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-red-600/20 border border-red-500/40 text-red-500 flex items-center justify-center shrink-0">
              <Tag className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-black text-white uppercase tracking-wider">
                Monitoreo de Precios en Góndola
              </h2>
              <p className="text-[10px] text-neutral-400 font-mono">
                Bimonetario USD/Bs · Tasa BCV · Lectura IA
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span
              data-testid="portal-bcv-rate-badge"
              className={`px-2 py-0.5 rounded-full border text-[10px] font-mono font-bold inline-flex items-center gap-1 ${
                bcvSnapshot?.isFallback
                  ? 'bg-amber-950/60 border-amber-500/50 text-amber-300'
                  : 'bg-neutral-900 border-neutral-700 text-neutral-200'
              }`}
            >
              {isLoadingBcv ? (
                <RefreshCw className="w-3 h-3 animate-spin text-red-400" />
              ) : null}
              <span>
                BCV:{' '}
                {activeBcvRate !== null ? `${activeBcvRate.toFixed(2)} Bs/USD` : 'Sin conexión'}
              </span>
              {bcvSnapshot?.isFallback && (
                <span className="text-[9px] uppercase text-amber-400">· Respaldo</span>
              )}
            </span>
          </div>
        </div>

        <div className="pt-2 border-t border-neutral-800/80">
          <PortalStoreSelector
            value={activeStore}
            onChange={(store) => {
              savePortalActiveStore(store);
              onActiveStoreChange(store);
            }}
            clients={clients}
            label="Punto de Venta / Comercio:"
            testIdPrefix="precios-store"
          />
        </div>
      </div>

      {saveSuccess ? (
        <div className="bg-[#0d0d0d] border border-emerald-500/40 rounded-2xl p-6 text-center space-y-4 shadow-xl">
          <div className="w-14 h-14 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-base font-black text-white">¡Precios Registrados!</h3>
            <p className="text-xs text-neutral-400 mt-1">
              Montos originales y conversión BCV inmutable sincronizados con Trade Marketing.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setOwnPriceInput('');
              setOwnCurrency('USD');
              setCompetitors([
                { name: PORTAL_COMPETITOR_BRANDS[0], priceInput: '', currency: 'USD' },
                { name: PORTAL_COMPETITOR_BRANDS[1], priceInput: '', currency: 'USD' },
              ]);
              setPhotoFile(null);
              setPhotoPreviewUrl(null);
              setPendingOcrResult(null);
              setOcrAppliedMeta({ assisted: false, confidence: null });
              setObservations('');
              clientSubmissionIdRef.current = generateClientSubmissionId();
              setSaveSuccess(false);
            }}
            className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs uppercase tracking-wider cursor-pointer"
          >
            Registrar Otro Producto
          </button>
        </div>
      ) : (
        <>
          {/* BLOQUE 1: PRODUCTO PROPIO + MONEDA INDEPENDIENTE USD / BS */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <PortalProductSelector
              value={selectedProduct}
              onChange={(prod) => setSelectedProduct(prod)}
              products={products}
              label="1. Producto Evaluado (Catálogo Oficial):"
              testIdPrefix="precios-product"
            />

            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-bold uppercase text-neutral-400">
                Moneda del precio propio:
              </span>
              <div
                className="inline-flex rounded-lg bg-[#171717] border border-neutral-800 p-0.5"
                role="group"
                aria-label="Seleccionar moneda precio propio"
              >
                {CURRENCY_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`own-currency-${opt.id}`}
                    onClick={() => setOwnCurrency(opt.id)}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-mono font-bold transition cursor-pointer ${
                      ownCurrency === opt.id
                        ? 'bg-red-600 text-white shadow'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[9px] font-bold uppercase text-neutral-400 block mb-1">
                  Precio en Estante ({ownCurrency === 'VES' ? 'Bs' : 'USD'}):
                </label>
                <input
                  type="number"
                  step="any"
                  min={0}
                  data-testid="input-own-price"
                  value={ownPriceInput}
                  onChange={(e) => setOwnPriceInput(e.target.value)}
                  placeholder={ownCurrency === 'VES' ? 'Ej. 245.50' : 'Ej. 3.80'}
                  className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl px-3 py-2 text-xs text-white font-mono font-bold focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-neutral-400 block mb-1">
                  {ownCurrency === 'VES' ? 'Normalizado USD (BCV):' : 'Equivalente en Bs (BCV):'}
                </label>
                <div
                  data-testid="own-converted-preview"
                  className="w-full bg-[#171717] border border-neutral-800 rounded-xl px-3 py-2 text-xs text-emerald-400 font-mono font-bold"
                >
                  {ownCurrency === 'VES'
                    ? `$${ownConverted.priceUsd.toFixed(2)} USD`
                    : ownConverted.priceBs !== null
                      ? `Bs. ${ownConverted.priceBs.toFixed(2)}`
                      : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* BLOQUE 2: MATRIZ DE COMPETENCIA CON MONEDA INDEPENDIENTE POR COMPETIDOR */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300">
                2. Matriz de Competencia ({competitors.length}/3 marcas):
              </span>
              {competitors.length < 3 && (
                <button
                  type="button"
                  onClick={addCompetitor}
                  className="px-2.5 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white text-[10px] font-bold flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3 h-3 text-red-500" />
                  <span>Añadir</span>
                </button>
              )}
            </div>

            <div className="space-y-2.5">
              {competitors.map((comp, idx) => {
                const rawVal = Number(comp.priceInput.replace(',', '.')) || 0;
                let compUsd = 0;
                try {
                  compUsd = convertAmountBimonetary({
                    amount: rawVal,
                    currency: comp.currency,
                    bcvRate: activeBcvRate,
                  }).priceUsd;
                } catch {
                  compUsd = 0;
                }
                const { brechaPorcentaje } = computeBimonetaryGap(ownConverted.priceUsd, compUsd);
                // Positivo aquí significa competidor más caro que Codizulca para el badge rápido en campo
                const compVsOwnPct =
                  ownConverted.priceUsd > 0 && compUsd > 0
                    ? Number((((compUsd - ownConverted.priceUsd) / ownConverted.priceUsd) * 100).toFixed(1))
                    : 0;

                return (
                  <div
                    key={idx}
                    className="p-3 bg-[#171717] border border-neutral-800 rounded-xl space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <select
                        value={
                          (PORTAL_COMPETITOR_BRANDS as readonly string[]).includes(comp.name)
                            ? comp.name
                            : '__CUSTOM__'
                        }
                        onChange={(e) => {
                          if (e.target.value !== '__CUSTOM__') {
                            setCompetitors((prev) =>
                              prev.map((item, i) =>
                                i === idx ? { ...item, name: e.target.value } : item
                              )
                            );
                          }
                        }}
                        className="bg-neutral-900 border border-neutral-800 rounded-lg px-2 py-1 text-xs text-white font-bold max-w-[155px]"
                      >
                        {PORTAL_COMPETITOR_BRANDS.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                        {!(PORTAL_COMPETITOR_BRANDS as readonly string[]).includes(comp.name) && (
                          <option value="__CUSTOM__">Otra marca</option>
                        )}
                      </select>

                      <div className="inline-flex rounded-lg bg-neutral-900 border border-neutral-800 p-0.5">
                        {CURRENCY_OPTIONS.map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            data-testid={`comp-${idx}-currency-${opt.id}`}
                            onClick={() =>
                              setCompetitors((prev) =>
                                prev.map((item, i) =>
                                  i === idx ? { ...item, currency: opt.id } : item
                                )
                              )
                            }
                            className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold cursor-pointer ${
                              comp.currency === opt.id
                                ? 'bg-red-600 text-white'
                                : 'text-neutral-400 hover:text-white'
                            }`}
                          >
                            {opt.id === 'VES' ? 'Bs' : 'USD'}
                          </button>
                        ))}
                      </div>

                      {competitors.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setCompetitors((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="text-neutral-500 hover:text-red-400 p-1 cursor-pointer"
                          aria-label={`Eliminar competidor ${idx + 1}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={comp.name}
                        onChange={(e) =>
                          setCompetitors((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, name: e.target.value } : item
                            )
                          )
                        }
                        placeholder="Marca competidora"
                        className="bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs text-amber-300 font-bold focus:outline-none"
                      />
                      <input
                        type="number"
                        step="any"
                        min={0}
                        data-testid={`comp-${idx}-price`}
                        value={comp.priceInput}
                        onChange={(e) =>
                          setCompetitors((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, priceInput: e.target.value } : item
                            )
                          )
                        }
                        placeholder={comp.currency === 'VES' ? 'Precio Bs' : 'Precio USD'}
                        className="bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono font-bold focus:outline-none"
                      />
                    </div>

                    {rawVal > 0 && (
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono">
                        <span className="text-neutral-400">
                          Normalizado:{' '}
                          <strong className="text-white">${compUsd.toFixed(2)} USD</strong>
                        </span>
                        {ownConverted.priceUsd > 0 && compUsd > 0 && (
                          <span
                            className={`px-2 py-0.5 rounded font-bold ${
                              compVsOwnPct > 0
                                ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/30'
                                : compVsOwnPct < 0
                                  ? 'bg-rose-950/80 text-rose-400 border border-rose-500/30'
                                  : 'bg-neutral-800 text-neutral-300'
                            }`}
                            title={`Brecha Codizulca vs competidor: ${brechaPorcentaje}%`}
                          >
                            {compVsOwnPct > 0
                              ? `+${compVsOwnPct}% más caro`
                              : compVsOwnPct < 0
                                ? `${compVsOwnPct}% más barato`
                                : 'Paridad'}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* BLOQUE 3: FOTO FLEJE + LECTURA ASISTIDA CON IA (CONFIRMACIÓN HUMANA OBLIGATORIA) */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">
                3. Foto del Hablador / Fleje (JPG/PNG/WebP · Máx. 5 MB):
              </span>
              {ocrAppliedMeta.assisted && (
                <span className="px-2 py-0.5 rounded-full bg-red-600/20 border border-red-500/40 text-[9px] font-mono font-bold text-red-300 inline-flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5" />
                  Asistido IA
                </span>
              )}
            </div>

            {photoPreviewUrl ? (
              <div className="space-y-2.5">
                <div className="relative aspect-video rounded-xl overflow-hidden border border-neutral-700 bg-black">
                  <img
                    src={photoPreviewUrl}
                    alt="Fleje de precio"
                    className="w-full h-full object-contain"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setPhotoFile(null);
                      setPhotoPreviewUrl(null);
                      setPendingOcrResult(null);
                      setOcrError(null);
                    }}
                    className="absolute top-2 right-2 p-1.5 rounded-full bg-black/80 text-white hover:text-red-400 cursor-pointer"
                    aria-label="Eliminar foto del hablador"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <button
                  type="button"
                  data-testid="btn-ocr-hablador"
                  disabled={isScanningAi}
                  onClick={() => void handleScanWithAi()}
                  className="w-full py-2.5 px-3 rounded-xl bg-neutral-900 hover:bg-neutral-800 border border-red-500/45 text-white text-xs font-extrabold inline-flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
                >
                  {isScanningAi ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-red-400" />
                      <span>Leyendo hablador con IA...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 text-red-400" />
                      <span>Leer etiqueta con IA (Confirmación obligatoria)</span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="border-2 border-dashed border-neutral-800 rounded-xl p-4 space-y-3 text-center bg-[#171717]/50">
                <div className="flex flex-col items-center gap-1">
                  <Camera className="w-6 h-6 text-red-500" />
                  <span className="text-xs font-bold text-white">
                    Capturar Foto del Hablador / Fleje
                  </span>
                  <span className="text-[10px] text-neutral-400">
                    Luego podrás extraer marca, producto y precio automáticamente con IA
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="py-2 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-black text-[11px] uppercase flex items-center justify-center gap-1.5 cursor-pointer">
                    <Camera className="w-3.5 h-3.5" />
                    <span>Tomar Foto</span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handlePhotoChange}
                      className="hidden"
                    />
                  </label>
                  <label className="py-2 px-3 rounded-xl bg-[#0d0d0d] hover:bg-neutral-800 border border-neutral-700 text-white font-bold text-[11px] uppercase flex items-center justify-center gap-1.5 cursor-pointer">
                    <ImageIcon className="w-3.5 h-3.5 text-neutral-300" />
                    <span>Galería</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handlePhotoChange}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            )}

            {ocrError && (
              <div
                role="alert"
                data-testid="ocr-error-banner"
                className="rounded-xl bg-amber-950/60 border border-amber-500/50 px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                <span>{ocrError}</span>
              </div>
            )}

            {/* TARJETA DE CONFIRMACIÓN HUMANA OBLIGATORIA (JAMÁS GUARDA AUTOMÁTICAMENTE) */}
            {pendingOcrResult && (
              <div
                data-testid="ocr-confirmation-card"
                className="rounded-xl bg-[#121215] border border-red-500/55 p-3.5 space-y-3 shadow-lg"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-black uppercase tracking-wider text-white inline-flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-red-400" />
                    Revisa y confirma la lectura IA
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase border ${
                      pendingOcrResult.confianza === 'alta'
                        ? 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40'
                        : pendingOcrResult.confianza === 'media'
                          ? 'bg-amber-950/70 text-amber-300 border-amber-500/40'
                          : 'bg-rose-950/70 text-rose-300 border-rose-500/40'
                    }`}
                  >
                    Confianza: {pendingOcrResult.confianza}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px] bg-black/60 rounded-lg p-2.5 border border-neutral-800">
                  <div>
                    <span className="text-neutral-500 block text-[9px] uppercase">Marca</span>
                    <strong className="text-white">
                      {pendingOcrResult.marca_detectada || 'No detectada'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-neutral-500 block text-[9px] uppercase">Monto y Moneda</span>
                    <strong className="text-emerald-400 font-mono">
                      {pendingOcrResult.monto_detectado !== null
                        ? `${pendingOcrResult.moneda_detectada === 'VES' ? 'Bs.' : '$'} ${pendingOcrResult.monto_detectado.toFixed(2)} (${pendingOcrResult.moneda_detectada || '?'})`
                        : 'No detectado'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-neutral-500 block text-[9px] uppercase">Producto</span>
                    <span className="text-neutral-200">
                      {pendingOcrResult.producto_detectado || '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-neutral-500 block text-[9px] uppercase">Presentación</span>
                    <span className="text-neutral-200">
                      {pendingOcrResult.presentacion_detectada || '—'}
                    </span>
                  </div>
                </div>

                {pendingOcrResult.notas_lectura && (
                  <p className="text-[10px] text-neutral-400 italic">
                    Nota IA: {pendingOcrResult.notas_lectura}
                  </p>
                )}

                <div className="flex flex-wrap gap-1.5 pt-1">
                  <button
                    type="button"
                    data-testid="btn-ocr-apply-own"
                    onClick={handleApplyOcrToOwn}
                    className="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold cursor-pointer"
                  >
                    Aplicar a Precio Propio
                  </button>
                  {competitors.map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      data-testid={`btn-ocr-apply-comp-${idx}`}
                      onClick={() => handleApplyOcrToCompetitor(idx)}
                      className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-white text-[10px] font-bold cursor-pointer"
                    >
                      Aplicar a Comp. {idx + 1}
                    </button>
                  ))}
                  <button
                    type="button"
                    data-testid="btn-ocr-dismiss"
                    onClick={() => setPendingOcrResult(null)}
                    className="px-2.5 py-1.5 rounded-lg bg-black hover:bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white text-[10px] font-bold inline-flex items-center gap-1 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                    Descartar
                  </button>
                </div>
              </div>
            )}

            <textarea
              rows={2}
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              placeholder="Observaciones de promociones, ofertas relámpago o quiebre de competencia..."
              className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl px-3 py-2 text-xs text-white placeholder-neutral-600 focus:outline-none resize-none"
            />
          </div>

          {submitError && (
            <div
              role="alert"
              className="bg-red-950/60 border border-red-500/50 rounded-xl p-3 text-xs text-red-200 flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
              <span>{submitError}</span>
            </div>
          )}

          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleSave()}
            data-testid="btn-guardar-precios-portal"
            className="w-full py-3.5 rounded-2xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-black text-xs uppercase tracking-wider shadow-lg shadow-red-900/30 flex items-center justify-center gap-2 cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Guardando Comparativa Bimonetaria...</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                <span>Guardar Comparativa de Precios</span>
              </>
            )}
          </button>
        </>
      )}
    </div>
  );
};
