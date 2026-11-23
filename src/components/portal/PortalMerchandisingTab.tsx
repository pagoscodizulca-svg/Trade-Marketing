import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  Loader2,
  PenTool,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { getCaracasTodayYmd } from '../../types/attendanceEvidences';
import {
  PORTAL_MERCHANDISING_ACTIVITIES,
  PORTAL_STORE_MANAGER_ROLES,
  createPortalMerchandisingReport,
  savePortalActiveStore,
  validatePortalImageFile,
  type PortalClientOption,
  type PortalPromotoraContext,
} from '../../services/promotoraCampoService';
import { PortalStoreSelector } from './PortalCatalogSelectors';

interface PortalMerchandisingTabProps {
  context: PortalPromotoraContext;
  clients: PortalClientOption[];
  activeStore: string;
  onActiveStoreChange: (store: string) => void;
  onNotify: (message: string) => void;
}

export const PortalMerchandisingTab: React.FC<PortalMerchandisingTabProps> = ({
  context,
  clients,
  activeStore,
  onActiveStoreChange,
  onNotify,
}) => {
  const [subTab, setSubTab] = useState<'escaneo_gondola' | 'certificacion_visita'>(
    'certificacion_visita'
  );
  const [address, setAddress] = useState('Pasillo Charcutería / Anaquel Principal');
  const [selectedActivities, setSelectedActivities] = useState<string[]>([
    PORTAL_MERCHANDISING_ACTIVITIES[0],
    PORTAL_MERCHANDISING_ACTIVITIES[1],
    PORTAL_MERCHANDISING_ACTIVITIES[2],
    PORTAL_MERCHANDISING_ACTIVITIES[3],
  ]);
  const [productDetail, setProductDetail] = useState(
    'Línea Embutidos Cocidos, Jamón Superior, Salchichas'
  );
  const [observations, setObservations] = useState('');
  const [storeManagerName, setStoreManagerName] = useState('');
  const [storeManagerRole, setStoreManagerRole] = useState<string>(PORTAL_STORE_MANAGER_ROLES[0]);
  const [storeManagerPhone, setStoreManagerPhone] = useState('');

  // Escaneo góndola
  const [shelfCategory, setShelfCategory] = useState('Embutidos Cocidos & Refrigerados');
  const [ourFacings, setOurFacings] = useState(14);
  const [compFacings, setCompFacings] = useState(18);
  const [outOfStockDetected, setOutOfStockDetected] = useState(false);
  const [popDetected, setPopDetected] = useState(true);

  // Fotos (hasta 6)
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);

  // Firma táctil Canvas
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    return () => {
      photoPreviews.forEach((url) => {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      });
    };
  }, [photoPreviews]);

  const initSignatureCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = '#ffffff';
    }
  }, []);

  useEffect(() => {
    if (subTab === 'certificacion_visita' && !savedSuccess) {
      requestAnimationFrame(initSignatureCanvas);
    }
  }, [initSignatureCanvas, savedSuccess, subTab]);

  const getCoords = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e && e.touches[0]) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    const me = e as React.MouseEvent<HTMLCanvasElement>;
    return { x: me.clientX - rect.left, y: me.clientY - rect.top };
  };

  const handleClearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleAddPhotos = (e: React.ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files || []);
    e.target.value = '';
    if (incoming.length === 0) return;
    setSubmitError(null);
    const remaining = 6 - photoFiles.length;
    if (remaining <= 0) {
      setSubmitError('Máximo 6 fotos permitidas por informe.');
      return;
    }
    const validFiles: File[] = [];
    const validUrls: string[] = [];
    for (const file of incoming.slice(0, remaining)) {
      try {
        validatePortalImageFile(file);
        validFiles.push(file);
        validUrls.push(URL.createObjectURL(file));
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Imagen no válida.');
      }
    }
    setPhotoFiles((prev) => [...prev, ...validFiles]);
    setPhotoPreviews((prev) => [...prev, ...validUrls]);
  };

  const totalFacings = ourFacings + compFacings;
  const shareOfShelfPercent = totalFacings > 0 ? Math.round((ourFacings / totalFacings) * 100) : 0;

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setSubmitError(null);
    if (!activeStore.trim()) {
      setSubmitError('Selecciona el Punto de Venta (PDV).');
      return;
    }
    if (subTab === 'certificacion_visita' && selectedActivities.length === 0) {
      setSubmitError('Selecciona al menos una labor ejecutada en anaquel.');
      return;
    }

    setIsSubmitting(true);
    try {
      let signatureBlob: Blob | null = null;
      if (subTab === 'certificacion_visita' && hasSignature && canvasRef.current) {
        signatureBlob = await new Promise<Blob | null>((resolve) =>
          canvasRef.current?.toBlob((b) => resolve(b), 'image/png')
        );
      }

      const nowTime = new Date().toLocaleTimeString('es-VE', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'America/Caracas',
      });

      await createPortalMerchandisingReport({
        context,
        mode: subTab,
        store: activeStore.trim(),
        address,
        date: getCaracasTodayYmd(),
        time: nowTime,
        activities:
          subTab === 'escaneo_gondola'
            ? ['Escaneo Inteligente de Góndolas', 'Medición de Share of Shelf']
            : selectedActivities,
        productDetail,
        observations,
        storeManagerName,
        storeManagerRole,
        storeManagerPhone,
        photoFiles,
        signatureBlob,
        shelfMetrics:
          subTab === 'escaneo_gondola'
            ? {
                category: shelfCategory,
                ourFacings,
                competitorFacings: compFacings,
                totalFacings,
                shareOfShelfPercent,
                outOfStockDetected,
                popDetected,
              }
            : undefined,
      });

      setSavedSuccess(true);
      onNotify('Informe de Merchandising sincronizado con Módulo 1 → Merchandising');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'No se pudo guardar el informe.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 pb-6" data-testid="portal-merchandising-tab">
      {/* Selector superior */}
      <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-2 shadow-xl flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setSubTab('escaneo_gondola')}
          className={`flex-1 py-2.5 px-2 rounded-xl text-[11px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            subTab === 'escaneo_gondola'
              ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-lg'
              : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
          <span>1. Escaneo Góndola</span>
        </button>
        <button
          type="button"
          onClick={() => setSubTab('certificacion_visita')}
          className={`flex-1 py-2.5 px-2 rounded-xl text-[11px] font-black uppercase tracking-wider flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            subTab === 'certificacion_visita'
              ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-lg'
              : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
          }`}
        >
          <PenTool className="w-3.5 h-3.5" />
          <span>2. Certificación & Firma</span>
        </button>
      </div>

      {savedSuccess ? (
        <div className="bg-[#0d0d0d] border border-emerald-500/40 rounded-2xl p-6 text-center space-y-4 shadow-xl">
          <div className="w-14 h-14 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-base font-black text-white">¡Informe de Merchandising Guardado!</h3>
            <p className="text-xs text-neutral-400 mt-1">
              Visible inmediatamente en Módulo 1 → Pestaña Merchandising.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setPhotoFiles([]);
              setPhotoPreviews([]);
              setObservations('');
              setStoreManagerName('');
              setHasSignature(false);
              setSavedSuccess(false);
            }}
            className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs uppercase tracking-wider cursor-pointer"
          >
            Registrar Nueva Visita
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <PortalStoreSelector
              value={activeStore}
              onChange={(store) => {
                savePortalActiveStore(store);
                onActiveStoreChange(store);
              }}
              clients={clients}
              label="Punto de Venta (PDV):"
              testIdPrefix="merch-store"
            />
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Ubicación / Pasillo en tienda..."
              className="w-full bg-[#171717] border border-neutral-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
            />
          </div>

          {subTab === 'escaneo_gondola' ? (
            <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
              <label className="text-[10px] font-bold uppercase text-neutral-400 block">
                Categoría de Anaquel & Share of Shelf:
              </label>
              <input
                type="text"
                value={shelfCategory}
                onChange={(e) => setShelfCategory(e.target.value)}
                className="w-full bg-[#171717] border border-neutral-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
              />
              <div className="grid grid-cols-3 gap-2 text-center font-mono">
                <div className="bg-[#171717] rounded-xl p-2.5 border border-neutral-800">
                  <span className="text-[9px] text-neutral-400 block">Frentes Propios</span>
                  <div className="flex items-center justify-center gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => setOurFacings((v) => Math.max(0, v - 1))}
                      className="w-6 h-6 rounded bg-neutral-800 text-white font-bold cursor-pointer"
                    >
                      -
                    </button>
                    <strong className="text-sm text-white">{ourFacings}</strong>
                    <button
                      type="button"
                      onClick={() => setOurFacings((v) => v + 1)}
                      className="w-6 h-6 rounded bg-red-600 text-white font-bold cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="bg-[#171717] rounded-xl p-2.5 border border-neutral-800">
                  <span className="text-[9px] text-neutral-400 block">Competencia</span>
                  <div className="flex items-center justify-center gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => setCompFacings((v) => Math.max(0, v - 1))}
                      className="w-6 h-6 rounded bg-neutral-800 text-white font-bold cursor-pointer"
                    >
                      -
                    </button>
                    <strong className="text-sm text-amber-400">{compFacings}</strong>
                    <button
                      type="button"
                      onClick={() => setCompFacings((v) => v + 1)}
                      className="w-6 h-6 rounded bg-neutral-700 text-white font-bold cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="bg-[#171717] rounded-xl p-2.5 border border-emerald-500/30">
                  <span className="text-[9px] text-neutral-400 block">Share of Shelf</span>
                  <strong className="text-lg text-emerald-400 block mt-0.5">
                    {shareOfShelfPercent}%
                  </strong>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="flex items-center gap-2 p-2 rounded-xl bg-[#171717] border border-neutral-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={popDetected}
                    onChange={(e) => setPopDetected(e.target.checked)}
                    className="accent-red-600"
                  />
                  <span>Material POP visible</span>
                </label>
                <label className="flex items-center gap-2 p-2 rounded-xl bg-[#171717] border border-neutral-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={outOfStockDetected}
                    onChange={(e) => setOutOfStockDetected(e.target.checked)}
                    className="accent-red-600"
                  />
                  <span>Quiebre de Stock</span>
                </label>
              </div>
            </div>
          ) : (
            <>
              {/* Checklist */}
              <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2.5 shadow-xl">
                <span className="text-[10px] font-bold uppercase tracking-wider text-red-400 block">
                  Labores Ejecutadas en PDV:
                </span>
                <div className="space-y-1.5">
                  {PORTAL_MERCHANDISING_ACTIVITIES.map((act) => {
                    const checked = selectedActivities.includes(act);
                    return (
                      <button
                        key={act}
                        type="button"
                        onClick={() =>
                          setSelectedActivities((prev) =>
                            prev.includes(act) ? prev.filter((a) => a !== act) : [...prev, act]
                          )
                        }
                        className={`w-full text-left px-3 py-2 rounded-xl border text-xs flex items-center justify-between gap-2 cursor-pointer ${
                          checked
                            ? 'bg-red-950/40 border-red-500/50 text-white font-bold'
                            : 'bg-[#171717] border-neutral-800 text-neutral-400'
                        }`}
                      >
                        <span>{act}</span>
                        {checked && <Check className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  value={productDetail}
                  onChange={(e) => setProductDetail(e.target.value)}
                  placeholder="Líneas / SKUs trabajados..."
                  className="w-full bg-[#171717] border border-neutral-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                />
              </div>

              {/* Encargado y Firma */}
              <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
                <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300 block">
                  Certificación y Firma del Encargado de Tienda:
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={storeManagerName}
                    onChange={(e) => setStoreManagerName(e.target.value)}
                    placeholder="Nombre del encargado"
                    className="bg-[#171717] border border-neutral-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                  />
                  <select
                    value={storeManagerRole}
                    onChange={(e) => setStoreManagerRole(e.target.value)}
                    className="bg-[#171717] border border-neutral-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                  >
                    {PORTAL_STORE_MANAGER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  type="text"
                  value={storeManagerPhone}
                  onChange={(e) => setStoreManagerPhone(e.target.value)}
                  placeholder="Teléfono del encargado (opcional)"
                  className="w-full bg-[#171717] border border-neutral-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                />

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[10px] text-neutral-400">
                    <span>Firma táctil (opcional):</span>
                    <button
                      type="button"
                      onClick={handleClearSignature}
                      className="text-red-400 hover:text-red-300 flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Limpiar firma</span>
                    </button>
                  </div>
                  <canvas
                    ref={canvasRef}
                    onMouseDown={(e) => {
                      isDrawingRef.current = true;
                      const ctx = canvasRef.current?.getContext('2d');
                      const { x, y } = getCoords(e);
                      ctx?.beginPath();
                      ctx?.moveTo(x, y);
                    }}
                    onMouseMove={(e) => {
                      if (!isDrawingRef.current) return;
                      const ctx = canvasRef.current?.getContext('2d');
                      const { x, y } = getCoords(e);
                      ctx?.lineTo(x, y);
                      ctx?.stroke();
                      setHasSignature(true);
                    }}
                    onMouseUp={() => {
                      isDrawingRef.current = false;
                    }}
                    onMouseLeave={() => {
                      isDrawingRef.current = false;
                    }}
                    onTouchStart={(e) => {
                      isDrawingRef.current = true;
                      const ctx = canvasRef.current?.getContext('2d');
                      const { x, y } = getCoords(e);
                      ctx?.beginPath();
                      ctx?.moveTo(x, y);
                    }}
                    onTouchMove={(e) => {
                      if (!isDrawingRef.current) return;
                      const ctx = canvasRef.current?.getContext('2d');
                      const { x, y } = getCoords(e);
                      ctx?.lineTo(x, y);
                      ctx?.stroke();
                      setHasSignature(true);
                    }}
                    onTouchEnd={() => {
                      isDrawingRef.current = false;
                    }}
                    className="w-full h-28 bg-black border border-neutral-700 rounded-xl touch-none cursor-crosshair"
                  />
                </div>
              </div>
            </>
          )}

          {/* Evidencia fotográfica (hasta 6 fotos) */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300">
                Evidencia Fotográfica ({photoFiles.length}/6 · Máx. 5 MB c/u):
              </span>
              {photoFiles.length < 6 && (
                <label className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold flex items-center gap-1 cursor-pointer">
                  <Camera className="w-3 h-3" />
                  <span>Agregar Fotos</span>
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleAddPhotos}
                    className="hidden"
                  />
                </label>
              )}
            </div>

            {photoPreviews.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {photoPreviews.map((url, idx) => (
                  <div
                    key={url}
                    className="relative aspect-square rounded-xl overflow-hidden border border-neutral-800 bg-black"
                  >
                    <img src={url} alt={`Evidencia ${idx + 1}`} className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => {
                        setPhotoFiles((prev) => prev.filter((_, i) => i !== idx));
                        setPhotoPreviews((prev) => prev.filter((_, i) => i !== idx));
                      }}
                      className="absolute top-1 right-1 p-1 rounded-full bg-black/80 text-white hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              rows={2}
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              placeholder="Observaciones y hallazgos en góndola..."
              className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl p-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none resize-none"
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
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || !activeStore.trim()}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 disabled:bg-neutral-800 disabled:from-neutral-800 disabled:to-neutral-800 disabled:text-neutral-500 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Guardando Informe...</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                <span>Guardar Informe de Merchandising</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
