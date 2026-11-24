import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  MessageCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  obtenerOCrearEnlacePdvMiSucursal,
  regenerarEnlacePdvMiSucursal,
  revocarEnlacePdvMiSucursal,
  type RegionalPdvLinkInfo,
} from '../../services/publicPdvLinksService';
import { buildPromotoraWhatsAppLink } from '../../utils/portalLinkSharing';
import {
  formatCanonicalSucursalBadge,
  type CanonicalSucursal,
} from '../../utils/regionalSyncClassifier';

export interface RegionalPdvLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeSucursal: CanonicalSucursal | null;
  canSwitchSucursal?: boolean;
}

export const RegionalPdvLinkModal: React.FC<RegionalPdvLinkModalProps> = ({
  isOpen,
  onClose,
  activeSucursal,
  canSwitchSucursal = false,
}) => {
  const [selectedSucursal, setSelectedSucursal] = useState<CanonicalSucursal>(
    () => activeSucursal ?? 'OCCIDENTE'
  );
  const [linkInfo, setLinkInfo] = useState<RegionalPdvLinkInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [mutating, setMutating] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    if (activeSucursal) {
      setSelectedSucursal(activeSucursal);
    }
  }, [activeSucursal]);

  const targetSucursal: CanonicalSucursal = canSwitchSucursal
    ? selectedSucursal
    : (activeSucursal ?? 'OCCIDENTE');

  const loadActiveLink = useCallback(
    async (forceRefresh = false) => {
      setLoading(true);
      setErrorMsg(null);
      setConfirmRegenerate(false);
      try {
        const info = await obtenerOCrearEnlacePdvMiSucursal({
          sucursalOverride: canSwitchSucursal ? targetSucursal : null,
          forceRefresh,
        });
        setLinkInfo(info);
      } catch (err) {
        setLinkInfo(null);
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'No se pudo consultar el enlace público de la sucursal.'
        );
      } finally {
        setLoading(false);
      }
    },
    [canSwitchSucursal, targetSucursal]
  );

  useEffect(() => {
    if (!isOpen) return;
    setStatusMsg(null);
    setCopied(false);
    void loadActiveLink(false);
  }, [isOpen, loadActiveLink]);

  if (!isOpen) return null;

  const badgeLabel = formatCanonicalSucursalBadge(linkInfo?.sucursal ?? targetSucursal) ?? 'SUCURSAL';

  const handleCopy = async () => {
    if (!linkInfo?.url) return;
    try {
      await navigator.clipboard.writeText(linkInfo.url);
      setCopied(true);
      setStatusMsg(`Enlace único de ${badgeLabel} copiado al portapapeles.`);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setErrorMsg('No se pudo copiar automáticamente. Selecciona y copia el enlace del recuadro.');
    }
  };

  const handleShareWhatsApp = () => {
    if (!linkInfo?.token) return;
    const waUrl = buildPromotoraWhatsAppLink({
      regionalToken: linkInfo.token,
      sucursalLabel: badgeLabel,
    });
    window.open(waUrl, '_blank', 'noopener,noreferrer');
  };

  const handleRegenerate = async () => {
    if (mutating) return;
    setMutating(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const fresh = await regenerarEnlacePdvMiSucursal({
        sucursalOverride: canSwitchSucursal ? targetSucursal : null,
      });
      setLinkInfo(fresh);
      setConfirmRegenerate(false);
      setStatusMsg(
        `Nuevo enlace emitido para ${badgeLabel}. El enlace anterior quedó revocado inmediatamente.`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'No se pudo regenerar el enlace público.'
      );
    } finally {
      setMutating(false);
    }
  };

  const handleRevokeOnly = async () => {
    if (mutating) return;
    setMutating(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await revocarEnlacePdvMiSucursal({
        sucursalOverride: canSwitchSucursal ? targetSucursal : null,
      });
      setLinkInfo(null);
      setConfirmRegenerate(false);
      setStatusMsg(
        `Enlace público de ${badgeLabel} revocado. Pulsa "Emitir Nuevo Enlace" cuando desees habilitarlo nuevamente.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo revocar el enlace.');
    } finally {
      setMutating(false);
    }
  };

  return (
    <div
      data-testid="regional-pdv-link-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Enlace Público PDV — ${badgeLabel}`}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="w-full max-w-xl rounded-2xl bg-zinc-950 border border-white/10 shadow-2xl overflow-hidden text-white">
        <div className="px-6 py-4 bg-zinc-900/90 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-red-600/20 border border-red-500/40 flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5 text-red-400" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm sm:text-base font-extrabold tracking-tight text-white">
                  Enlace Público PDV (Sin Login)
                </h2>
                <span
                  data-testid="modal-pdv-link-sucursal-badge"
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-black tracking-wide border ${
                    targetSucursal === 'CENTRO'
                      ? 'bg-amber-500/15 text-amber-300 border-amber-400/40'
                      : 'bg-red-600/20 text-red-300 border-red-500/45'
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" />
                  {badgeLabel}
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Exclusivo para promotoras y tiendas autorizadas de {badgeLabel} + catálogo nacional de productos.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar gestor de enlace público"
            className="p-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {canSwitchSucursal && (
            <div className="flex items-center justify-between gap-2 p-3 rounded-xl bg-zinc-900 border border-white/10">
              <span className="text-xs font-semibold text-zinc-300">
                Sucursal del enlace (Vista Admin Nacional):
              </span>
              <div className="inline-flex gap-1.5">
                {(['CENTRO', 'OCCIDENTE'] as const).map((suc) => (
                  <button
                    key={suc}
                    type="button"
                    onClick={() => setSelectedSucursal(suc)}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                      targetSucursal === suc
                        ? 'bg-red-600 text-white'
                        : 'bg-zinc-800 text-zinc-300 hover:text-white'
                    }`}
                  >
                    {suc}
                  </button>
                ))}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-red-950/60 border border-red-500/40 text-xs text-red-200 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {statusMsg && (
            <div className="p-3.5 rounded-xl bg-emerald-950/50 border border-emerald-500/35 text-xs text-emerald-200 flex items-start gap-2.5">
              <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>{statusMsg}</span>
            </div>
          )}

          {loading ? (
            <div className="py-10 flex flex-col items-center justify-center gap-2 text-zinc-400 text-xs font-mono">
              <Loader2 className="w-5 h-5 animate-spin text-red-500" />
              <span>Verificando token seguro de {badgeLabel}...</span>
            </div>
          ) : linkInfo ? (
            <>
              <div className="space-y-1.5">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                  URL Única de Reporte en PDV ({badgeLabel})
                </label>
                <div className="p-3 rounded-xl bg-zinc-900 border border-white/10 font-mono text-xs text-zinc-200 break-all select-all">
                  {linkInfo.url}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-400 pt-1">
                  <span>Huella: {linkInfo.tokenHint}</span>
                  <span>Accesos registrados: {linkInfo.usoContador}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  data-testid="btn-modal-copy-regional-link"
                  onClick={() => void handleCopy()}
                  className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  <span>{copied ? '¡Enlace Copiado!' : 'Copiar Enlace Público'}</span>
                </button>

                <button
                  type="button"
                  data-testid="btn-modal-whatsapp-regional-link"
                  onClick={handleShareWhatsApp}
                  className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <MessageCircle className="w-4 h-4" />
                  <span>Enviar por WhatsApp</span>
                </button>
              </div>

              <div className="pt-3 border-t border-white/10">
                {!confirmRegenerate ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] text-zinc-400">
                      ¿Se filtró el link o cambió el personal? Revócalo al instante:
                    </span>
                    <button
                      type="button"
                      data-testid="btn-modal-ask-regenerate-link"
                      onClick={() => setConfirmRegenerate(true)}
                      className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 flex items-center gap-1.5 transition cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
                      <span>Regenerar / Revocar Token</span>
                    </button>
                  </div>
                ) : (
                  <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/40 space-y-2.5">
                    <div className="flex items-start gap-2 text-xs text-amber-200">
                      <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <span>
                        El enlace anterior de <strong>{badgeLabel}</strong> dejará de funcionar de inmediato (el enlace de la otra sucursal no se verá afectado).
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmRegenerate(false)}
                        disabled={mutating}
                        className="px-3 py-1.5 rounded-lg bg-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white cursor-pointer"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRevokeOnly()}
                        disabled={mutating}
                        className="px-3 py-1.5 rounded-lg bg-red-950 hover:bg-red-900 border border-red-500/40 text-xs font-bold text-red-200 cursor-pointer"
                      >
                        Solo Revocar
                      </button>
                      <button
                        type="button"
                        data-testid="btn-modal-confirm-regenerate-link"
                        onClick={() => void handleRegenerate()}
                        disabled={mutating}
                        className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 text-xs font-extrabold flex items-center gap-1.5 cursor-pointer"
                      >
                        {mutating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <span>Emitir Nuevo Token</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="py-6 text-center space-y-3">
              <p className="text-xs text-zinc-300">
                Actualmente no hay un enlace público activo para <strong>{badgeLabel}</strong>.
              </p>
              <button
                type="button"
                onClick={() => void loadActiveLink(true)}
                disabled={mutating}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
              >
                <KeyRound className="w-4 h-4" />
                <span>Emitir Nuevo Enlace para {badgeLabel}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
