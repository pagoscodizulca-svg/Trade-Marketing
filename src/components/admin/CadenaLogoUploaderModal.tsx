import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Monitor,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  computeCadenaInitials,
  deleteCadenaSecondaryLogo,
  fetchCadenaSecondaryLogoBlobUrl,
  isSafeLocalLogoSrc,
  revokeLogoBlobUrl,
  uploadCadenaSecondaryLogo,
  validateClientCadenaLogoFile,
} from '../../services/cadenaLogoService';
import { SUCURSAL_LABELS, normalizeSucursalCodigo } from '../../services/userManagementService';

export interface CadenaLogoTargetInfo {
  id: string;
  codigo?: string | null;
  nombre: string;
  sucursal?: string | null;
  hasLogo?: boolean;
  logoMimeType?: string | null;
}

export interface CadenaLogoUploaderModalProps {
  isOpen: boolean;
  cadena: CadenaLogoTargetInfo | null;
  onClose: () => void;
  onUpdated?: (result: { id: string; hasLogo: boolean; logoMimeType: string | null }) => void | Promise<void>;
  /** Permite renderizado directo en SSR (`renderToStaticMarkup`) sin depender de `document.body` */
  inlineForSsr?: boolean;
  initialPreviewSrc?: string | null;
}

export const CadenaLogoUploaderModal: React.FC<CadenaLogoUploaderModalProps> = ({
  isOpen,
  cadena,
  onClose,
  onUpdated,
  inlineForSsr = false,
  initialPreviewSrc = null,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [localFilePreviewUrl, setLocalFilePreviewUrl] = useState<string | null>(null);
  const [remoteLogoBlobUrl, setRemoteLogoBlobUrl] = useState<string | null>(
    isSafeLocalLogoSrc(initialPreviewSrc) ? initialPreviewSrc : null
  );
  const [loadingCurrent, setLoadingCurrent] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [hasStoredLogo, setHasStoredLogo] = useState<boolean>(() => Boolean(cadena?.hasLogo));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Sincronizar logo remoto actual al abrir el modal y liberar Blob URL al cerrar/desmontar
  useEffect(() => {
    setSelectedFile(null);
    setErrorMsg(null);
    setSuccessMsg(null);
    setHasStoredLogo(Boolean(cadena?.hasLogo));

    if (!isOpen || !cadena) {
      return;
    }

    if (isSafeLocalLogoSrc(initialPreviewSrc)) {
      setRemoteLogoBlobUrl(initialPreviewSrc);
      return;
    }

    if (!cadena.hasLogo) {
      setRemoteLogoBlobUrl(null);
      return;
    }

    const controller = new AbortController();
    let mounted = true;
    let fetchedUrl: string | null = null;
    setLoadingCurrent(true);

    void fetchCadenaSecondaryLogoBlobUrl(cadena.id, controller.signal)
      .then((url) => {
        if (!mounted) {
          revokeLogoBlobUrl(url);
          return;
        }
        fetchedUrl = url;
        setRemoteLogoBlobUrl(url);
        if (url) setHasStoredLogo(true);
      })
      .finally(() => {
        if (mounted) setLoadingCurrent(false);
      });

    return () => {
      mounted = false;
      controller.abort();
      revokeLogoBlobUrl(fetchedUrl);
    };
  }, [cadena?.id, cadena?.hasLogo, initialPreviewSrc, isOpen]);

  // Liberar Blob URL temporal del archivo seleccionado localmente
  useEffect(() => {
    return () => {
      revokeLogoBlobUrl(localFilePreviewUrl);
    };
  }, [localFilePreviewUrl]);

  if (!isOpen || !cadena) return null;

  const activePreviewUrl = isSafeLocalLogoSrc(localFilePreviewUrl)
    ? localFilePreviewUrl
    : isSafeLocalLogoSrc(remoteLogoBlobUrl)
      ? remoteLogoBlobUrl
      : null;

  const initials = computeCadenaInitials(cadena.nombre, cadena.codigo);
  const normalizedHub = normalizeSucursalCodigo(cadena.sucursal);
  const sucursalLabel = normalizedHub ? SUCURSAL_LABELS[normalizedHub] : cadena.sucursal || 'Regional';

  const handleSelectFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!file) return;

    const validationErr = validateClientCadenaLogoFile(file);
    if (validationErr) {
      setErrorMsg(validationErr);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    revokeLogoBlobUrl(localFilePreviewUrl);
    const nextObjectUrl = URL.createObjectURL(file);
    setSelectedFile(file);
    setLocalFilePreviewUrl(nextObjectUrl);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || submitting || deleting) return;

    setSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const summary = await uploadCadenaSecondaryLogo(cadena.id, selectedFile);
      setHasStoredLogo(true);

      // Promover vista previa al logo activo guardado
      const freshRemoteUrl = await fetchCadenaSecondaryLogoBlobUrl(cadena.id);
      revokeLogoBlobUrl(remoteLogoBlobUrl);
      setRemoteLogoBlobUrl(freshRemoteUrl ?? localFilePreviewUrl);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

      setSuccessMsg(
        `Logotipo secundario de "${cadena.nombre}" validado por magic bytes y publicado para /cliente.`
      );
      await onUpdated?.({
        id: cadena.id,
        hasLogo: true,
        logoMimeType: summary.logoMimeType,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo cargar el logotipo.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!hasStoredLogo || submitting || deleting) return;

    setDeleting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      await deleteCadenaSecondaryLogo(cadena.id);
      revokeLogoBlobUrl(remoteLogoBlobUrl);
      revokeLogoBlobUrl(localFilePreviewUrl);
      setRemoteLogoBlobUrl(null);
      setLocalFilePreviewUrl(null);
      setSelectedFile(null);
      setHasStoredLogo(false);
      if (fileInputRef.current) fileInputRef.current.value = '';

      setSuccessMsg(`Logotipo secundario retirado. /cliente mostrará la insignia tipográfica "${initials}".`);
      await onUpdated?.({
        id: cadena.id,
        hasLogo: false,
        logoMimeType: null,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo eliminar el logotipo.');
    } finally {
      setDeleting(false);
    }
  };

  const renderCobrandHeaderPreview = (themeVariant: 'default' | 'control-room') => {
    const isDark = themeVariant === 'control-room';
    return (
      <div
        data-theme-preview={themeVariant}
        data-testid={`cobrand-preview-${themeVariant}`}
        className={`rounded-xl border p-3.5 space-y-2.5 ${
          isDark
            ? 'bg-[#09090B] border-[#27272A] text-[#FAFAFA]'
            : 'bg-[#F8F9FA] border-[#E4E4E7] text-[#09090B]'
        }`}
      >
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider">
          <span className="inline-flex items-center gap-1.5 font-bold">
            {isDark ? (
              <Monitor className="w-3 h-3 text-[#EF4444]" />
            ) : (
              <Sun className="w-3 h-3 text-[#DC2626]" />
            )}
            {isDark ? 'Vista Sala de Control (#09090B)' : 'Vista Día Ejecutivo (#F8F9FA)'}
          </span>
          <span className={isDark ? 'text-[#A1A1AA]' : 'text-[#52525B]'}>/cliente</span>
        </div>

        <div
          className={`rounded-xl border px-3.5 py-2.5 flex items-center gap-3 ${
            isDark ? 'bg-[#121215] border-[#27272A]' : 'bg-[#FFFFFF] border-[#E4E4E7]'
          }`}
        >
          {/* Logo Corporativo Principal CODIZULCA */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="cz-logo-badge w-8 h-8 rounded-lg bg-[#FFFFFF] border border-[#E4E4E7] p-1 flex items-center justify-center">
              <img
                src="/codizulca-logo.png"
                alt="CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>
            <span className="text-[11px] font-black tracking-tight">CODIZULCA</span>
          </div>

          {/* Divisor arquitectónico 1px */}
          <span
            aria-hidden="true"
            className={`h-7 w-px shrink-0 ${isDark ? 'bg-[#27272A]' : 'bg-[#E4E4E7]'}`}
          />

          {/* Cápsula adaptativa del logotipo secundario o respaldo tipográfico */}
          {activePreviewUrl ? (
            <div className="cz-cobrand-capsule h-9 max-w-[160px] px-2.5 py-1 rounded-lg flex items-center justify-center shrink-0">
              <img
                src={activePreviewUrl}
                alt={`Logotipo secundario ${cadena.nombre}`}
                className="h-full max-w-full object-contain"
              />
            </div>
          ) : (
            <div
              className={`h-9 px-2.5 rounded-lg border flex items-center gap-2 min-w-0 ${
                isDark
                  ? 'bg-[#18181B] border-[#27272A] text-[#FAFAFA]'
                  : 'bg-[#F8F9FA] border-[#E4E4E7] text-[#09090B]'
              }`}
            >
              <span className="w-6 h-6 rounded bg-[#DC2626] text-[#FFFFFF] text-[10px] font-mono font-black flex items-center justify-center shrink-0">
                {initials}
              </span>
              <span className="text-[11px] font-bold truncate max-w-[110px]">
                {cadena.nombre}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs overflow-y-auto"
      data-testid="cadena-logo-uploader-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cadena-logo-modal-title"
        className="w-full max-w-2xl rounded-2xl bg-zinc-950 border border-zinc-800 p-6 shadow-2xl space-y-5"
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 pb-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-red-600/15 text-red-400 border border-red-500/30">
                  Co-Branding B2B · /cliente
                </span>
                <span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-zinc-900 text-zinc-300 border border-zinc-700">
                  {sucursalLabel}
                </span>
              </div>
              <h3 id="cadena-logo-modal-title" className="text-base font-extrabold text-white mt-1">
                Logotipo Secundario — {cadena.nombre}
              </h3>
              <p className="text-xs text-zinc-400 mt-0.5">
                Formatos rasterizados permitidos: <strong className="text-white">PNG o WebP</strong> (máx.{' '}
                <span className="font-mono">512 KB</span>). Archivos SVG y enlaces externos están bloqueados.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar gestor de logotipo"
            className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Vista previa dual instantánea: Día Ejecutivo vs Sala de Control */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-zinc-300">
              Previsualización Instantánea en Cabecera /cliente
            </span>
            {loadingCurrent && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-zinc-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-red-500" />
                Cargando logo actual...
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {renderCobrandHeaderPreview('default')}
            {renderCobrandHeaderPreview('control-room')}
          </div>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="rounded-xl bg-red-950/50 border border-red-500/40 px-3.5 py-2.5 text-xs text-red-200 flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div
            role="status"
            className="rounded-xl bg-emerald-950/50 border border-emerald-500/40 px-3.5 py-2.5 text-xs text-emerald-200 flex items-start gap-2"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={(e) => void handleUpload(e)} className="space-y-4">
          <div className="rounded-xl bg-zinc-900/70 border border-zinc-800 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center shrink-0">
                <ImageIcon className="w-4 h-4 text-red-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-white truncate">
                  {selectedFile
                    ? `${selectedFile.name} (${Math.ceil(selectedFile.size / 1024)} KB)`
                    : hasStoredLogo
                      ? 'Logotipo oficial activo en almacén privado'
                      : 'Sin archivo seleccionado (usando insignia tipográfica)'}
                </p>
                <p className="text-[11px] text-zinc-400 flex items-center gap-1 mt-0.5">
                  <ShieldCheck className="w-3 h-3 text-red-400 shrink-0" />
                  <span>Verificación binaria de magic bytes + X-Content-Type-Options: nosniff</span>
                </p>
              </div>
            </div>

            <div className="shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/webp"
                onChange={handleSelectFile}
                data-testid="cadena-logo-file-input"
                className="hidden"
              />
              <button
                type="button"
                disabled={submitting || deleting}
                onClick={() => fileInputRef.current?.click()}
                data-testid="btn-pick-cadena-logo"
                className="px-3.5 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 border border-zinc-700 text-xs font-bold text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5 text-red-400" />
                <span>Seleccionar PNG / WebP</span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-800">
            <div>
              {hasStoredLogo && (
                <button
                  type="button"
                  disabled={submitting || deleting}
                  onClick={() => void handleDelete()}
                  data-testid="btn-delete-cadena-logo"
                  className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-red-950/60 border border-zinc-700 hover:border-red-600 text-xs font-bold text-red-300 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {deleting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  <span>Eliminar Logotipo</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={submitting || deleting}
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-bold text-zinc-200 cursor-pointer"
              >
                Cerrar
              </button>
              <button
                type="submit"
                disabled={!selectedFile || submitting || deleting}
                data-testid="btn-upload-cadena-logo"
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-45 text-xs font-extrabold text-white inline-flex items-center gap-1.5 cursor-pointer"
              >
                {submitting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Upload className="w-3.5 h-3.5" />
                )}
                <span>Guardar Logotipo</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );

  if (inlineForSsr || typeof document === 'undefined') {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
};
