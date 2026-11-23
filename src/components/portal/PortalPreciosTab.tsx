import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  Tag,
  Trash2,
} from 'lucide-react';
import {
  PORTAL_COMPETITOR_BRANDS,
  createPortalPriceSurvey,
  savePortalActiveStore,
  validatePortalImageFile,
  type PortalClientOption,
  type PortalProductOption,
  type PortalPromotoraContext,
} from '../../services/promotoraCampoService';
import { fetchLiveBcvRate } from '../../services/supabaseModule1';
import { PortalProductSelector, PortalStoreSelector } from './PortalCatalogSelectors';

interface PortalPreciosTabProps {
  context: PortalPromotoraContext;
  clients: PortalClientOption[];
  products: PortalProductOption[];
  activeStore: string;
  onActiveStoreChange: (store: string) => void;
  onNotify: (message: string) => void;
}

export const PortalPreciosTab: React.FC<PortalPreciosTabProps> = ({
  context,
  clients,
  products,
  activeStore,
  onActiveStoreChange,
  onNotify,
}) => {
  const [selectedProduct, setSelectedProduct] = useState<string>(products[0]?.nombre || '');
  const [ownPriceInput, setOwnPriceInput] = useState<string>('');
  const [bcvRate, setBcvRate] = useState<number>(60);
  const [competitors, setCompetitors] = useState<Array<{ name: string; priceInput: string }>>([
    { name: PORTAL_COMPETITOR_BRANDS[0], priceInput: '' },
    { name: PORTAL_COMPETITOR_BRANDS[1], priceInput: '' },
  ]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [observations, setObservations] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (!selectedProduct && products.length > 0) {
      setSelectedProduct(products[0].nombre);
    }
  }, [products, selectedProduct]);

  useEffect(() => {
    let active = true;
    fetchLiveBcvRate()
      .then((rate) => {
        if (active && rate && rate > 10) setBcvRate(Number(rate.toFixed(2)));
      })
      .catch(() => undefined);
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

  const ownPriceUsd = Number(ownPriceInput.replace(',', '.')) || 0;
  const ownPriceBs = Number((ownPriceUsd * bcvRate).toFixed(2));

  const addCompetitor = () => {
    if (competitors.length >= 3) return;
    const nextBrand =
      PORTAL_COMPETITOR_BRANDS.find((b) => !competitors.some((c) => c.name === b)) ||
      `Competidor ${competitors.length + 1}`;
    setCompetitors((prev) => [...prev, { name: nextBrand, priceInput: '' }]);
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSubmitError(null);
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

  const handleSave = async () => {
    if (isSubmitting) return;
    setSubmitError(null);
    if (!activeStore.trim()) {
      setSubmitError('Selecciona el Punto de Venta (PDV).');
      return;
    }
    if (!selectedProduct.trim()) {
      setSubmitError('Selecciona el producto evaluado.');
      return;
    }
    if (ownPriceUsd <= 0) {
      setSubmitError('Ingresa el precio en góndola de Codizulca (mayor a 0).');
      return;
    }

    setIsSubmitting(true);
    try {
      await createPortalPriceSurvey({
        context,
        store: activeStore.trim(),
        ourProduct: selectedProduct.trim(),
        ourPriceUsd: ownPriceUsd,
        bcvRate,
        competitors: competitors.map((c) => ({
          name: c.name,
          priceUsd: Number(c.priceInput.replace(',', '.')) || 0,
        })),
        photoFile,
        observations,
      });
      setSaveSuccess(true);
      onNotify(`Monitoreo de precios guardado (${selectedProduct.trim()})`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'No se pudo guardar el monitoreo.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 pb-6" data-testid="portal-precios-tab">
      <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 shadow-xl space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-red-600/20 border border-red-500/40 text-red-500 flex items-center justify-center shrink-0">
              <Tag className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-black text-white uppercase tracking-wider">
                Monitoreo de Precios en Góndola
              </h2>
              <p className="text-[10px] text-neutral-400 font-mono">
                Matriz Multicompetidor & Tasa Oficial BCV
              </p>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full bg-neutral-900 border border-neutral-700 text-neutral-300 text-[10px] font-mono font-bold">
            BCV: {bcvRate.toFixed(2)} Bs/USD
          </span>
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
              Sincronizado con la base central de Trade Marketing Codizulca.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setOwnPriceInput('');
              setPhotoFile(null);
              setPhotoPreviewUrl(null);
              setObservations('');
              setSaveSuccess(false);
            }}
            className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs uppercase tracking-wider cursor-pointer"
          >
            Registrar Otro Producto
          </button>
        </div>
      ) : (
        <>
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <PortalProductSelector
              value={selectedProduct}
              onChange={(prod) => setSelectedProduct(prod)}
              products={products}
              label="1. Producto Evaluado (Catálogo Oficial):"
              testIdPrefix="precios-product"
            />
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[9px] font-bold uppercase text-neutral-400 block mb-1">
                  Precio en Estante (USD):
                </label>
                <input
                  type="number"
                  step="any"
                  min={0}
                  value={ownPriceInput}
                  onChange={(e) => setOwnPriceInput(e.target.value)}
                  placeholder="Ej. 3.80"
                  className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl px-3 py-2 text-xs text-white font-mono font-bold focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold uppercase text-neutral-400 block mb-1">
                  Equivalente en Bs (BCV):
                </label>
                <div className="w-full bg-[#171717] border border-neutral-800 rounded-xl px-3 py-2 text-xs text-emerald-400 font-mono font-bold">
                  Bs. {ownPriceBs.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

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
                const cPrice = Number(comp.priceInput.replace(',', '.')) || 0;
                const diffPct =
                  ownPriceUsd > 0 && cPrice > 0
                    ? Number((((cPrice - ownPriceUsd) / ownPriceUsd) * 100).toFixed(1))
                    : 0;
                return (
                  <div
                    key={idx}
                    className="p-3 bg-[#171717] border border-neutral-800 rounded-xl space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
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

                      {cPrice > 0 && ownPriceUsd > 0 && (
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                            diffPct > 0
                              ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/30'
                              : diffPct < 0
                                ? 'bg-rose-950/80 text-rose-400 border border-rose-500/30'
                                : 'bg-neutral-800 text-neutral-300'
                          }`}
                        >
                          {diffPct > 0
                            ? `+${diffPct}% más caro`
                            : diffPct < 0
                              ? `${diffPct}% más barato`
                              : 'Igual'}
                        </span>
                      )}

                      {competitors.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setCompetitors((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="text-neutral-500 hover:text-red-400 p-1 cursor-pointer"
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
                        value={comp.priceInput}
                        onChange={(e) =>
                          setCompetitors((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, priceInput: e.target.value } : item
                            )
                          )
                        }
                        placeholder="Precio USD"
                        className="bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono font-bold focus:outline-none"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Foto fleje + observaciones */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 block">
              3. Foto de Soporte del Fleje (Opcional · JPG/PNG/WebP · Máx. 5 MB):
            </span>
            {photoPreviewUrl ? (
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
                  }}
                  className="absolute top-2 right-2 p-1.5 rounded-full bg-black/80 text-white hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <label className="border-2 border-dashed border-neutral-800 hover:border-neutral-700 rounded-xl p-4 flex flex-col items-center justify-center gap-1.5 cursor-pointer text-center bg-[#171717]/50">
                <Camera className="w-6 h-6 text-red-500" />
                <span className="text-xs font-bold text-white">Capturar Foto del Fleje</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  onChange={handlePhotoChange}
                  className="hidden"
                />
              </label>
            )}

            <textarea
              rows={2}
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              placeholder="Notas o promociones activas en anaquel..."
              className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl p-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none resize-none"
            />

            {submitError && (
              <div
                role="alert"
                className="p-2.5 rounded-xl bg-red-950/70 border border-red-500/50 text-red-200 text-xs flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSubmitting || ownPriceUsd <= 0 || !activeStore.trim() || !selectedProduct.trim()}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 disabled:bg-neutral-800 disabled:from-neutral-800 disabled:to-neutral-800 disabled:text-neutral-500 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Sincronizando Precios...</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>Guardar Monitoreo de Precios</span>
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
