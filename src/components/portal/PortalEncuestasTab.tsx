import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardList, Loader2 } from 'lucide-react';
import {
  createPortalConsumerSurvey,
  generateClientSubmissionId,
  savePortalActiveStore,
  type PortalClientOption,
  type PortalProductOption,
  type PortalPromotoraContext,
} from '../../services/promotoraCampoService';
import { PortalProductSelector, PortalStoreSelector } from './PortalCatalogSelectors';

interface PortalEncuestasTabProps {
  context: PortalPromotoraContext;
  clients: PortalClientOption[];
  products: PortalProductOption[];
  activeStore: string;
  onActiveStoreChange: (store: string) => void;
  onNotify: (message: string) => void;
}

export const PortalEncuestasTab: React.FC<PortalEncuestasTabProps> = ({
  context,
  clients,
  products,
  activeStore,
  onActiveStoreChange,
  onNotify,
}) => {
  const [selectedProduct, setSelectedProduct] = useState<string>(products[0]?.nombre || '');
  const [sabor, setSabor] = useState<number>(5);
  const [textura, setTextura] = useState<number>(5);
  const [intencionCompra, setIntencionCompra] = useState<
    'Muy probable' | 'Probable' | 'Poco probable' | 'Nada probable'
  >('Muy probable');
  const [percepcionCalidad, setPercepcionCalidad] = useState<'Mejor' | 'Igual' | 'Peor'>('Mejor');
  const [relacionCalidadPrecio, setRelacionCalidadPrecio] = useState<
    'Excelente' | 'Buena' | 'Regular' | 'Mala'
  >('Excelente');
  const [recomendacion, setRecomendacion] = useState<number>(5);
  const [comments, setComments] = useState<string>('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const clientSubmissionIdRef = useRef<string>(generateClientSubmissionId());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedSuccess, setSubmittedSuccess] = useState(false);

  useEffect(() => {
    if (!selectedProduct && products.length > 0) {
      setSelectedProduct(products[0].nombre);
    }
  }, [products, selectedProduct]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isSubmittingRef.current) return;
    setSubmitError(null);

    if (!activeStore.trim()) {
      setSubmitError('Selecciona la tienda o punto de venta.');
      return;
    }
    if (!selectedProduct.trim()) {
      setSubmitError('Selecciona el producto degustado.');
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      await createPortalConsumerSurvey({
        context,
        store: activeStore.trim(),
        product: selectedProduct.trim(),
        sabor,
        textura,
        intencionCompra,
        percepcionCalidad,
        relacionCalidadPrecio,
        recomendacion,
        comments,
        clientSubmissionId: clientSubmissionIdRef.current,
      });
      setSubmittedSuccess(true);
      onNotify(`Encuesta de degustación sincronizada (${selectedProduct.trim()})`);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'No se pudo enviar la encuesta al servidor.'
      );
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 pb-6" data-testid="portal-encuestas-tab">
      {submittedSuccess ? (
        <div className="bg-[#0d0d0d] border border-emerald-500/40 rounded-2xl p-6 text-center space-y-4 shadow-xl">
          <div className="w-14 h-14 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-base font-black text-white">¡Encuesta Registrada Exitosamente!</h3>
            <p className="text-xs text-neutral-400 mt-1">
              Sincronizada en tiempo real con el servidor central de Trade Marketing.
            </p>
          </div>
          <div className="p-3 bg-[#171717] rounded-xl border border-neutral-800 text-xs font-mono space-y-1 text-left">
            <p className="text-white">
              <strong>Producto:</strong> <span className="text-amber-400">{selectedProduct}</span>
            </p>
            <p className="text-neutral-400">
              <strong>PDV:</strong> {activeStore}
            </p>
            <p className="text-emerald-400">
              Sabor {sabor}/5 • Textura {textura}/5 • Recomendación {recomendacion}/5
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              clientSubmissionIdRef.current = generateClientSubmissionId();
              setComments('');
              setSubmittedSuccess(false);
            }}
            className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-black text-xs uppercase tracking-wider cursor-pointer"
          >
            Aplicar Nueva Encuesta
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <PortalStoreSelector
              value={activeStore}
              onChange={(store) => {
                savePortalActiveStore(store);
                onActiveStoreChange(store);
              }}
              clients={clients}
              label="TIENDA / LOCAL:"
              testIdPrefix="encuestas-store"
            />
            <PortalProductSelector
              value={selectedProduct}
              onChange={(prod) => setSelectedProduct(prod)}
              products={products}
              label="PRODUCTO IMPULSADO:"
              testIdPrefix="encuestas-product"
            />
          </div>

          {/* Sabor */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2 shadow-xl">
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-300 block">
              CALIFICACIÓN DE SABOR (1 AL 5)
            </label>
            <p className="text-[11px] text-neutral-500">
              ¿Cómo califica el sabor del producto que acaba de probar?
            </p>
            <div className="grid grid-cols-5 gap-2 pt-1">
              {[1, 2, 3, 4, 5].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setSabor(num)}
                  className={`py-2.5 rounded-xl border text-center font-black text-sm transition-all cursor-pointer ${
                    sabor === num
                      ? 'bg-red-600 border-red-500 text-white shadow-lg'
                      : 'bg-black border-neutral-800 text-white hover:border-neutral-700'
                  }`}
                >
                  {num}
                </button>
              ))}
            </div>
          </div>

          {/* Textura */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2 shadow-xl">
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-300 block">
              CALIFICACIÓN DE TEXTURA (1 AL 5)
            </label>
            <div className="grid grid-cols-5 gap-2 pt-1">
              {[1, 2, 3, 4, 5].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setTextura(num)}
                  className={`py-2.5 rounded-xl border text-center font-black text-sm transition-all cursor-pointer ${
                    textura === num
                      ? 'bg-red-600 border-red-500 text-white shadow-lg'
                      : 'bg-black border-neutral-800 text-white hover:border-neutral-700'
                  }`}
                >
                  {num}
                </button>
              ))}
            </div>
          </div>

          {/* Intención de compra */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2 shadow-xl">
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-300 block">
              2. INTENCIÓN DE COMPRA
            </label>
            <div className="grid grid-cols-2 gap-2 pt-1">
              {(['Muy probable', 'Probable', 'Poco probable', 'Nada probable'] as const).map(
                (opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setIntencionCompra(opt)}
                    className={`py-2.5 px-3 rounded-xl border text-center text-xs font-black transition-all cursor-pointer ${
                      intencionCompra === opt
                        ? 'bg-red-600 border-red-500 text-white'
                        : 'bg-black border-neutral-800 text-neutral-300 hover:text-white'
                    }`}
                  >
                    {opt}
                  </button>
                )
              )}
            </div>
          </div>

          {/* Percepción de calidad */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2 shadow-xl">
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-300 block">
              3. PERCEPCIÓN DE CALIDAD
            </label>
            <div className="grid grid-cols-3 gap-2 pt-1">
              {(['Mejor', 'Igual', 'Peor'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setPercepcionCalidad(opt)}
                  className={`py-2.5 px-2 rounded-xl border text-center text-xs font-black transition-all cursor-pointer ${
                    percepcionCalidad === opt
                      ? 'bg-red-600 border-red-500 text-white'
                      : 'bg-black border-neutral-800 text-neutral-300 hover:text-white'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          {/* Relación calidad-precio */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2 shadow-xl">
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-300 block">
              4. RELACIÓN CALIDAD-PRECIO
            </label>
            <div className="grid grid-cols-2 gap-2 pt-1">
              {(['Excelente', 'Buena', 'Regular', 'Mala'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setRelacionCalidadPrecio(opt)}
                  className={`py-2.5 px-3 rounded-xl border text-center text-xs font-black transition-all cursor-pointer ${
                    relacionCalidadPrecio === opt
                      ? 'bg-red-600 border-red-500 text-white'
                      : 'bg-black border-neutral-800 text-neutral-300 hover:text-white'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          {/* Recomendación */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2 shadow-xl">
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-300 block">
              5. RECOMENDACIÓN (1 AL 5)
            </label>
            <div className="grid grid-cols-5 gap-2 pt-1">
              {[1, 2, 3, 4, 5].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setRecomendacion(num)}
                  className={`py-2.5 rounded-xl border text-center font-black text-sm transition-all cursor-pointer ${
                    recomendacion === num
                      ? 'bg-red-600 border-red-500 text-white shadow-lg'
                      : 'bg-black border-neutral-800 text-white hover:border-neutral-700'
                  }`}
                >
                  {num}
                </button>
              ))}
            </div>
          </div>

          {/* Comentarios */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2 shadow-xl">
            <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 block">
              COMENTARIOS (OPCIONAL)
            </label>
            <textarea
              rows={2}
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Observaciones adicionales del consumidor..."
              className="w-full bg-black border border-neutral-800 focus:border-red-500 rounded-xl p-3 text-xs text-white placeholder-neutral-600 focus:outline-none resize-none"
            />
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
            disabled={isSubmitting || !activeStore.trim() || !selectedProduct.trim()}
            className="w-full py-4 rounded-2xl bg-red-600 hover:bg-red-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg shadow-red-600/30 cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Enviando Encuesta...</span>
              </>
            ) : (
              <>
                <ClipboardList className="w-4 h-4" />
                <span>Enviar Encuesta Larga</span>
              </>
            )}
          </button>
        </form>
      )}
    </div>
  );
};
