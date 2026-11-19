import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  Loader2,
  MapPin,
  ShieldAlert,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import {
  SLA_HOURS_BY_SEVERIDAD,
  createIncidenciaPdv,
  type IncidenciaPdv,
  type SeveridadIncidenciaPdv,
  type TipoIncidenciaPdv,
} from '../../services/popIncidenciasService';
import {
  enqueuePortalIncidenciaOffline,
  isTransientOfflineOrNetworkError,
  type AllowedIncidenciaPhotoMime,
} from '../../services/portalOfflineQueueService';
import {
  compressOfflineEvidencePhoto,
  MAX_OFFLINE_COMPRESSED_PHOTO_BYTES,
} from '../../utils/offlinePhotoCompressor';
import { syncShiftOfflineMutationsBatch } from '../../services/shiftLinksService';
import type { OperativeSucursal } from '../../services/userManagementService';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IncidenciaPdvSelectOption {
  id?: string | null;
  nombre: string;
}

export interface IncidenciaQuickModalResult {
  mode: 'online' | 'offline';
  message: string;
  incidencia?: IncidenciaPdv;
  offlineActionId?: string;
}

export interface IncidenciaQuickModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultPdvNombre?: string;
  defaultClienteId?: string | null;
  defaultRutaId?: string | null;
  pdvOptions?: IncidenciaPdvSelectOption[];
  sucursal?: OperativeSucursal | null;
  reportadoPorNombre?: string;
  defaultSeveridad?: SeveridadIncidenciaPdv;
  /** Token firmado de jornada temporal (`/portal?t=...`) para envío vía `/api/shift-links/sync` */
  shiftToken?: string | null;
  onSuccess?: (result: IncidenciaQuickModalResult) => void;
}

export const TIPO_INCIDENCIA_OPTIONS: ReadonlyArray<{
  value: TipoIncidenciaPdv;
  label: string;
}> = [
  { value: 'QUIEBRE_STOCK', label: 'Quiebre de Stock en Anaquel' },
  { value: 'PRECIO_INCORRECTO', label: 'Precio Incorrecto / Desactualizado' },
  { value: 'MATERIAL_POP_DANADO', label: 'Material POP Dañado o Faltante' },
  { value: 'COMPETENCIA_AGRESIVA', label: 'Actividad Agresiva de Competencia' },
  { value: 'CALIDAD_PRODUCTO', label: 'Novedad de Calidad / Empaque' },
  { value: 'ACCESO_PDV', label: 'Restricción de Acceso al PDV' },
  { value: 'OTRO', label: 'Otra Incidencia Operativa' },
];

export const SEVERIDAD_INCIDENCIA_OPTIONS: ReadonlyArray<{
  value: SeveridadIncidenciaPdv;
  label: string;
  slaLabel: '72h' | '24h' | '12h' | '4h';
  badgeClass: string;
}> = [
  {
    value: 'BAJA',
    label: 'Baja',
    slaLabel: '72h',
    badgeClass: 'bg-zinc-800 text-zinc-200 border-zinc-600',
  },
  {
    value: 'MEDIA',
    label: 'Media',
    slaLabel: '24h',
    badgeClass: 'bg-blue-950/70 text-blue-200 border-blue-500/50',
  },
  {
    value: 'ALTA',
    label: 'Alta',
    slaLabel: '12h',
    badgeClass: 'bg-amber-950/70 text-amber-200 border-amber-500/50',
  },
  {
    value: 'CRITICA',
    label: 'Crítica',
    slaLabel: '4h',
    badgeClass: 'bg-red-950/80 text-red-200 border-red-500/60',
  },
];

interface PreparedPhotoState {
  fileName: string;
  mimeType: AllowedIncidenciaPhotoMime;
  sizeBytes: number;
  base64: string;
  blob: Blob;
}

export const IncidenciaQuickModal: React.FC<IncidenciaQuickModalProps> = ({
  isOpen,
  onClose,
  defaultPdvNombre = '',
  defaultClienteId = null,
  defaultRutaId = null,
  pdvOptions = [],
  sucursal = null,
  reportadoPorNombre,
  defaultSeveridad = 'MEDIA',
  shiftToken = null,
  onSuccess,
}) => {
  const [pdvNombre, setPdvNombre] = useState<string>(defaultPdvNombre);
  const [selectedClienteId, setSelectedClienteId] = useState<string | null>(defaultClienteId);
  const [tipoIncidencia, setTipoIncidencia] = useState<TipoIncidenciaPdv>('QUIEBRE_STOCK');
  const [severidad, setSeveridad] = useState<SeveridadIncidenciaPdv>(defaultSeveridad);
  const [descripcion, setDescripcion] = useState<string>('');
  const [preparedPhoto, setPreparedPhoto] = useState<PreparedPhotoState | null>(null);
  const [checkingPhoto, setCheckingPhoto] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPdvNombre(defaultPdvNombre);
    setSelectedClienteId(defaultClienteId ?? null);
    setTipoIncidencia('QUIEBRE_STOCK');
    setSeveridad(defaultSeveridad);
    setDescripcion('');
    setPreparedPhoto(null);
    setCheckingPhoto(false);
    setSubmitting(false);
    setErrorMsg(null);
  }, [isOpen, defaultPdvNombre, defaultClienteId, defaultSeveridad]);

  const normalizedPdvOptions = useMemo(() => {
    const map = new Map<string, IncidenciaPdvSelectOption>();
    for (const opt of pdvOptions) {
      const cleanName = String(opt.nombre ?? '').trim();
      if (!cleanName) continue;
      const key = cleanName.toLowerCase();
      if (!map.has(key)) {
        map.set(key, { id: opt.id ?? null, nombre: cleanName });
      }
    }
    return Array.from(map.values());
  }, [pdvOptions]);

  const activeSlaHours = SLA_HOURS_BY_SEVERIDAD[severidad];
  const activeSeveridadMeta =
    SEVERIDAD_INCIDENCIA_OPTIONS.find((opt) => opt.value === severidad) ??
    SEVERIDAD_INCIDENCIA_OPTIONS[1]!;

  if (!isOpen) return null;

  const isOfflineNow = typeof navigator !== 'undefined' && navigator.onLine === false;

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      setPreparedPhoto(null);
      return;
    }

    setErrorMsg(null);
    setCheckingPhoto(true);
    try {
      // Compresión en cliente Canvas -> WebP <= 350 KB antes de persistir en IndexedDB / enviar
      const compressed = await compressOfflineEvidencePhoto(
        file,
        MAX_OFFLINE_COMPRESSED_PHOTO_BYTES
      );
      const ext =
        compressed.mimeType === 'image/webp'
          ? 'webp'
          : compressed.mimeType === 'image/png'
            ? 'png'
            : 'jpg';

      setPreparedPhoto({
        fileName: file.name || `evidencia.${ext}`,
        mimeType: compressed.mimeType,
        sizeBytes: compressed.compressedBytes,
        base64: compressed.base64,
        blob: compressed.blob,
      });
    } catch (err) {
      setPreparedPhoto(null);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudo comprimir/validar la fotografía (solo JPEG, PNG o WebP <= 350 KB tras compresión).'
      );
      e.target.value = '';
    } finally {
      setCheckingPhoto(false);
    }
  };

  const enqueueFallbackOffline = async (
    cleanPdv: string,
    cleanDesc: string,
    validClienteId: string | null,
    validRutaId: string | null
  ) => {
    const queued = await enqueuePortalIncidenciaOffline({
      pdvNombre: cleanPdv,
      clienteId: validClienteId,
      rutaId: validRutaId,
      tipoIncidencia,
      severidad,
      descripcion: cleanDesc,
      sucursal: sucursal ?? null,
      reportadoPorNombre,
      photoBase64: preparedPhoto?.base64 ?? null,
      photoMimeType: preparedPhoto?.mimeType ?? null,
    });

    const msg = `Incidencia en ${cleanPdv} guardada en cola offline (${activeSlaHours}h SLA). Se sincronizará automáticamente al recuperar señal.`;
    onSuccess?.({
      mode: 'offline',
      message: msg,
      offlineActionId: queued.id,
    });
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting || checkingPhoto) return;

    const cleanPdv = pdvNombre.trim();
    const cleanDesc = descripcion.trim();

    if (cleanPdv.length < 2) {
      setErrorMsg('Indica o selecciona el nombre del Punto de Venta (mínimo 2 caracteres).');
      return;
    }
    if (cleanDesc.length < 5) {
      setErrorMsg('Describe la incidencia con al menos 5 caracteres.');
      return;
    }

    const validClienteId =
      selectedClienteId && UUID_REGEX.test(selectedClienteId.trim())
        ? selectedClienteId.trim()
        : null;
    const validRutaId =
      defaultRutaId && UUID_REGEX.test(defaultRutaId.trim()) ? defaultRutaId.trim() : null;

    setSubmitting(true);
    setErrorMsg(null);

    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        await enqueueFallbackOffline(cleanPdv, cleanDesc, validClienteId, validRutaId);
        return;
      }

      if (shiftToken) {
        const mutationId =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
        const syncRes = await syncShiftOfflineMutationsBatch(shiftToken, [
          {
            client_mutation_id: mutationId,
            tipo: 'PROMOTORA_INCIDENCIA',
            payload: {
              pdv_nombre: cleanPdv,
              cliente_id: validClienteId,
              ruta_id: validRutaId,
              tipo_incidencia: tipoIncidencia,
              severidad,
              descripcion: cleanDesc,
              reportado_por_nombre: reportadoPorNombre?.trim() || '',
            },
            photoBase64: preparedPhoto?.base64 ?? null,
          },
        ]);
        const first = syncRes.results[0];
        if (!first?.ok) {
          throw new Error(first?.error || 'No se pudo registrar la incidencia en la jornada.');
        }
        onSuccess?.({
          mode: 'online',
          message: `Incidencia registrada en ${cleanPdv} (SLA ${activeSlaHours}h · Jornada firmada).`,
        });
        onClose();
        return;
      }

      const created = await createIncidenciaPdv(
        {
          pdvNombre: cleanPdv,
          clienteId: validClienteId,
          rutaId: validRutaId,
          tipoIncidencia,
          severidad,
          descripcion: cleanDesc,
          ...(reportadoPorNombre && reportadoPorNombre.trim()
            ? { reportadoPorNombre: reportadoPorNombre.trim() }
            : {}),
          ...(sucursal ? { sucursal } : {}),
        },
        preparedPhoto?.blob ?? null
      );

      const msg = `Incidencia ${created.codigoIncidencia || 'PDV'} registrada en ${cleanPdv} (SLA ${activeSlaHours}h).`;
      onSuccess?.({
        mode: 'online',
        message: msg,
        incidencia: created,
      });
      onClose();
    } catch (err) {
      if (isTransientOfflineOrNetworkError(err)) {
        try {
          await enqueueFallbackOffline(cleanPdv, cleanDesc, validClienteId, validRutaId);
          return;
        } catch (queueErr) {
          setErrorMsg(
            queueErr instanceof Error
              ? queueErr.message
              : 'No se pudo encolar la incidencia offline.'
          );
        }
      } else {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'No se pudo registrar la incidencia en el Punto de Venta.'
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="incidencia-quick-modal-title"
      data-testid="incidencia-quick-modal"
    >
      <form
        onSubmit={handleSubmit}
        noValidate
        className="w-full max-w-lg rounded-2xl bg-zinc-950 border border-white/15 p-5 space-y-4 max-h-[92vh] overflow-y-auto shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3">
          <div className="flex items-start gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <h2
                id="incidencia-quick-modal-title"
                className="text-sm sm:text-base font-extrabold text-white"
              >
                Reportar Incidencia en PDV
              </h2>
              <p className="text-[11px] text-zinc-400">
                Alerta directa a Coordinación Trade con seguimiento SLA y respaldo offline.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar modal de incidencia"
            className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {isOfflineNow && (
          <div className="rounded-xl bg-amber-950/50 border border-amber-500/40 px-3.5 py-2 text-[11px] text-amber-200 flex items-center gap-2">
            <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>
              Sin conexión detectada: el reporte y la foto quedarán protegidos en cola offline (
              <span className="font-mono">codizulca_portal_offline_v1</span>).
            </span>
          </div>
        )}

        {/* 1. Punto de Venta */}
        <div className="space-y-1.5">
          <label
            htmlFor="incidencia-pdv-input"
            className="block text-xs font-bold text-zinc-200"
          >
            Punto de Venta (PDV)
          </label>
          {normalizedPdvOptions.length > 0 && !defaultPdvNombre && (
            <select
              aria-label="Seleccionar PDV de la ruta"
              value={pdvNombre}
              onChange={(e) => {
                const chosenName = e.target.value;
                setPdvNombre(chosenName);
                const found = normalizedPdvOptions.find((o) => o.nombre === chosenName);
                setSelectedClienteId(found?.id ?? null);
              }}
              className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer"
            >
              <option value="">Seleccionar PDV asignado...</option>
              {normalizedPdvOptions.map((opt) => (
                <option key={opt.nombre} value={opt.nombre}>
                  {opt.nombre}
                </option>
              ))}
            </select>
          )}
          <div className="relative">
            <MapPin className="w-3.5 h-3.5 text-red-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="incidencia-pdv-input"
              type="text"
              required
              maxLength={180}
              value={pdvNombre}
              onChange={(e) => setPdvNombre(e.target.value)}
              placeholder="Nombre del cliente o sucursal PDV..."
              className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-black border border-zinc-700 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500"
            />
          </div>
        </div>

        {/* 2. Tipo de Incidencia */}
        <div>
          <label
            htmlFor="incidencia-tipo-select"
            className="block text-xs font-bold text-zinc-200 mb-1.5"
          >
            Tipo de Incidencia
          </label>
          <select
            id="incidencia-tipo-select"
            value={tipoIncidencia}
            onChange={(e) => setTipoIncidencia(e.target.value as TipoIncidenciaPdv)}
            className="w-full px-3 py-2.5 rounded-xl bg-black border border-zinc-700 text-sm text-white focus:outline-none focus:border-red-500 cursor-pointer"
          >
            {TIPO_INCIDENCIA_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* 3. Severidad + Insignia SLA en vivo */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-zinc-200">Severidad y Compromiso SLA</span>
            <span
              data-testid="incidencia-sla-badge"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-extrabold border ${activeSeveridadMeta.badgeClass}`}
            >
              <Clock className="w-3 h-3" />
              <span>SLA: {activeSlaHours}h</span>
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {SEVERIDAD_INCIDENCIA_OPTIONS.map((opt) => {
              const selected = severidad === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`severidad-btn-${opt.value}`}
                  onClick={() => setSeveridad(opt.value)}
                  className={`px-2.5 py-2 rounded-xl border text-xs font-bold flex flex-col items-center gap-0.5 transition cursor-pointer ${
                    selected
                      ? 'bg-red-600/20 border-red-500 text-white shadow-sm'
                      : 'bg-black border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                  }`}
                >
                  <span>{opt.label}</span>
                  <span className="text-[10px] font-mono opacity-90">{opt.slaLabel}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 4. Descripción */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label
              htmlFor="incidencia-descripcion"
              className="block text-xs font-bold text-zinc-200"
            >
              Descripción detallada
            </label>
            <span className="text-[10px] font-mono text-zinc-500">
              {descripcion.trim().length}/1000 (mín. 5)
            </span>
          </div>
          <textarea
            id="incidencia-descripcion"
            rows={3}
            minLength={5}
            maxLength={1000}
            required
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            placeholder="Detalla el producto afectado, lote, anaquel o novedad observada en el PDV..."
            className="w-full px-3 py-2.5 rounded-xl bg-black border border-zinc-700 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500"
          />
        </div>

        {/* 5. Fotografía opcional / recomendada con verificación de magic bytes */}
        <div className="rounded-xl bg-black/70 border border-zinc-800 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="incidencia-photo-input"
              className="text-xs font-bold text-zinc-200 flex items-center gap-1.5 cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5 text-red-400" />
              <span>Evidencia fotográfica (recomendada · máx. 5 MB)</span>
            </label>
            <span className="text-[10px] font-mono text-zinc-500">JPEG · PNG · WebP</span>
          </div>

          <input
            id="incidencia-photo-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => void handlePhotoChange(e)}
            disabled={submitting || checkingPhoto}
            className="block w-full text-xs text-zinc-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-zinc-800 file:text-white hover:file:bg-zinc-700 cursor-pointer"
          />

          {checkingPhoto && (
            <p className="text-[11px] font-mono text-zinc-400 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-red-400" />
              <span>Verificando firma binaria de imagen...</span>
            </p>
          )}

          {preparedPhoto && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-emerald-950/40 border border-emerald-500/35 px-2.5 py-1.5 text-[11px] text-emerald-200">
              <span className="inline-flex items-center gap-1.5 truncate">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="truncate">{preparedPhoto.fileName}</span>
                <span className="font-mono text-[10px] text-emerald-300/80">
                  ({(preparedPhoto.sizeBytes / 1024).toFixed(1)} KB · {preparedPhoto.mimeType})
                </span>
              </span>
              <button
                type="button"
                onClick={() => setPreparedPhoto(null)}
                className="p-1 rounded hover:bg-white/10 text-emerald-200 cursor-pointer"
                aria-label="Quitar fotografía"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {errorMsg && (
          <div
            role="alert"
            data-testid="incidencia-modal-error"
            className="rounded-xl bg-red-950/60 border border-red-500/45 px-3.5 py-2.5 text-xs text-red-100 flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-bold text-zinc-200 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="submit"
            data-testid="btn-submit-incidencia"
            disabled={submitting || checkingPhoto}
            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-extrabold inline-flex items-center gap-1.5 shadow-md shadow-red-950/50 cursor-pointer"
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Enviando...</span>
              </>
            ) : (
              <>
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Registrar Incidencia ({activeSlaHours}h SLA)</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
