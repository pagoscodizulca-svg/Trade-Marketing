import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Camera,
  CheckCircle2,
  CloudCheck,
  ExternalLink,
  Flag,
  Image as ImageIcon,
  Loader2,
  LocateFixed,
  MapPin,
  MapPinCheckInside,
  MessageSquareWarning,
  Navigation,
  SmartphoneNfc,
  Truck,
  Undo2,
  User,
  UserCheck,
} from 'lucide-react';
import type { EntregaVista } from '../../types';
import type { OptimizedStop } from '../../lib/routeOptimizer';
import { estiloProducto, etiquetaProducto } from '../../utils/format';

interface EntregaCardProps {
  entrega: EntregaVista;
  routeStop?: OptimizedStop | null;
  hasDriverGps?: boolean;
  onSelectStartStop?: (id: string) => void;
  onPinCurrentGps?: (id: string) => void;
  onToggle: (id: string) => void;
  onConfirmarSalida: (id: string) => void;
  onConfirmarLlegada: (id: string) => void;
  onSubirEvidencia: (
    id: string,
    file: File
  ) => Promise<{ path: string; bucket: string; signedUrl: string | null }>;
  onObtenerUrlEvidencia: (path: string, bucket?: string | null) => Promise<string | null>;
  onNota: (id: string, nota: string) => void;
}

export function EntregaCard({
  entrega: e,
  routeStop,
  hasDriverGps,
  onSelectStartStop,
  onPinCurrentGps,
  onToggle,
  onConfirmarSalida,
  onConfirmarLlegada,
  onSubirEvidencia,
  onObtenerUrlEvidencia,
  onNota,
}: EntregaCardProps) {
  const [confirmarDeshacer, setConfirmarDeshacer] = useState(false);
  const [notaAbierta, setNotaAbierta] = useState(e.notas_chofer.trim() !== '');
  const [borrador, setBorrador] = useState(e.notas_chofer);
  const [subiendoEvidencia, setSubiendoEvidencia] = useState(false);
  const [errorEvidencia, setErrorEvidencia] = useState('');
  const [evidenciaPreviewUrl, setEvidenciaPreviewUrl] = useState<string | null>(null);
  const editando = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mantiene la nota sincronizada si cambia desde otra pestaña/dispositivo.
  useEffect(() => {
    if (!editando.current) setBorrador(e.notas_chofer);
  }, [e.notas_chofer]);

  // Hidrata automáticamente la vista previa firmada de la evidencia persistida tras F5
  useEffect(() => {
    let active = true;
    if (!e.evidencia_path) {
      setEvidenciaPreviewUrl(null);
      return;
    }
    void onObtenerUrlEvidencia(e.evidencia_path, e.evidencia_bucket).then((url) => {
      if (active && url) setEvidenciaPreviewUrl(url);
    });
    return () => {
      active = false;
    };
  }, [e.evidencia_path, e.evidencia_bucket, onObtenerUrlEvidencia]);

  const guardarNota = () => {
    editando.current = false;
    if (borrador !== e.notas_chofer) onNota(e.id, borrador.trim());
  };

  const handleSeleccionarEvidencia = async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    setErrorEvidencia('');
    setSubiendoEvidencia(true);
    try {
      const res = await onSubirEvidencia(e.id, file);
      if (res.signedUrl) {
        setEvidenciaPreviewUrl(res.signedUrl);
      }
    } catch (err) {
      setErrorEvidencia(
        err instanceof Error ? err.message : 'No se pudo subir la evidencia fotográfica.'
      );
    } finally {
      setSubiendoEvidencia(false);
    }
  };

  const salidaConfirmada = Boolean(e.hora_salida) || e.estado_logistico === 'EN_RUTA';
  const horaLlegadaVisible = e.hora_llegada || e.hora_entrega;

  return (
    <article
      data-testid={`entrega-${e.id}`}
      data-completado={e.completado}
      data-estado-logistico={e.estado_logistico ?? (e.completado ? 'ENTREGADO' : 'PENDIENTE')}
      data-sync={e.sync ?? 'ninguno'}
      className={`rounded-2xl border-[3px] p-4 shadow-sm transition-colors ${
        e.completado
          ? 'bg-green-100 border-green-600'
          : salidaConfirmada
            ? 'bg-amber-50 border-amber-500'
            : 'bg-white border-zinc-300'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {!e.completado && routeStop && (
            <span
              data-testid={`orden-ruta-badge-${e.id}`}
              className={`text-xs font-black tracking-wide rounded-full px-2.5 py-0.5 border ${
                routeStop.orderIndex === 1
                  ? 'bg-amber-500 border-amber-700 text-zinc-950'
                  : 'bg-ink border-zinc-900 text-white'
              }`}
            >
              #{routeStop.orderIndex}
              {routeStop.isPinnedStart
                ? ' · Inicio elegido'
                : routeStop.orderIndex === 1
                  ? ' · Siguiente parada'
                  : routeStop.legDistanceKm != null && routeStop.legDistanceKm > 0
                    ? ` · +${routeStop.legDistanceKm.toFixed(1)} km (~${routeStop.legDurationMin ?? 0} min)`
                    : ' · Misma ubicación'}
            </span>
          )}
          <span className="text-[11px] font-black tracking-wide text-zinc-600 bg-zinc-100 border border-zinc-300 rounded px-1.5 py-0.5">
            {e.numero_grupo_turno}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {e.hora_salida && (
            <span
              data-testid={`salida-${e.id}`}
              className="text-xs font-black text-amber-900 bg-amber-200 border border-amber-600 rounded-full px-2.5 py-0.5"
            >
              🚚 Salida {e.hora_salida}
            </span>
          )}
          {e.completado && (
            <span
              data-testid={`hora-${e.id}`}
              className="text-sm font-black text-green-800 bg-green-200 border border-green-700 rounded-full px-2.5 py-0.5"
            >
              ✔ Llegada / Entregado {horaLlegadaVisible}
            </span>
          )}
        </div>
      </div>

      <h3 className="text-2xl font-black leading-tight text-ink break-words">{e.cliente}</h3>

      {e.zona_direccion && (
        <p className="mt-1 inline-flex items-center gap-1 text-xs font-extrabold text-zinc-700 bg-zinc-100 border border-zinc-300 rounded-md px-2 py-0.5">
          <MapPin className="w-3.5 h-3.5 text-brand shrink-0" />
          <span>{e.zona_direccion}</span>
        </p>
      )}

      {!e.completado && routeStop && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {onSelectStartStop && !routeStop.isPinnedStart && (
            <button
              type="button"
              data-testid={`card-iniciar-aqui-${e.id}`}
              onClick={() => onSelectStartStop(e.id)}
              className="min-h-9 px-3 rounded-lg border-2 border-amber-500 bg-amber-50 hover:bg-amber-100 text-amber-950 text-xs font-black inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Flag className="w-3.5 h-3.5" />
              Iniciar ruta aquí
            </button>
          )}
          <a
            href={routeStop.googleMapsStopUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`card-google-maps-${e.id}`}
            className="min-h-9 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-black inline-flex items-center gap-1.5"
          >
            <Navigation className="w-3.5 h-3.5" />
            Ir en Google Maps
            <ExternalLink className="w-3 h-3" />
          </a>
          {hasDriverGps && onPinCurrentGps && e.geo_precision !== 'exacta' && (
            <button
              type="button"
              data-testid={`card-fijar-gps-${e.id}`}
              onClick={() => onPinCurrentGps(e.id)}
              className="min-h-9 px-2.5 rounded-lg border border-sky-400 bg-sky-50 hover:bg-sky-100 text-sky-900 text-xs font-bold inline-flex items-center gap-1 cursor-pointer"
              title="Guardar mi posición GPS actual como coordenada exacta de este cliente (offline)"
            >
              <LocateFixed className="w-3.5 h-3.5" />
              Fijar mi GPS
            </button>
          )}
        </div>
      )}

      <div className="mt-2.5">
        <span
          className={`inline-block text-lg font-black tracking-wide px-3.5 py-1 rounded-lg ${estiloProducto(e.producto).chip}`}
        >
          {etiquetaProducto(e.producto)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-1 min-[420px]:grid-cols-2 gap-2 text-base">
        <div className="flex items-center gap-2 text-zinc-800">
          <User className="w-5 h-5 shrink-0 text-zinc-500" />
          <div>
            <dt className="text-[11px] font-bold uppercase text-zinc-500 leading-none">Vendedor</dt>
            <dd className="font-extrabold">{e.vendedor || '—'}</dd>
          </div>
        </div>
        <div className="flex items-center gap-2 text-zinc-800">
          <UserCheck className="w-5 h-5 shrink-0 text-zinc-500" />
          <div>
            <dt className="text-[11px] font-bold uppercase text-zinc-500 leading-none">Promotora que recibe</dt>
            <dd className="font-extrabold">{e.promotora || '—'}</dd>
          </div>
        </div>
      </dl>

      {/* Estado de sincronización de la tarjeta (solo si se marcó sin conexión) */}
      {e.sync === 'pendiente' && (
        <p
          data-testid={`sync-tag-${e.id}`}
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-amber-900 bg-amber-100 border border-amber-500 rounded-full px-2.5 py-1"
        >
          <SmartphoneNfc className="w-3.5 h-3.5" aria-hidden="true" />
          Guardado en teléfono (Pendiente de red)
        </p>
      )}
      {e.sync === 'sincronizado_offline' && (
        <p
          data-testid={`sync-tag-${e.id}`}
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-green-900 bg-green-200 border border-green-700 rounded-full px-2.5 py-1"
        >
          <CloudCheck className="w-3.5 h-3.5" aria-hidden="true" />
          Sincronizado en servidor
        </p>
      )}

      {/* Acciones logísticas del Chofer: 1) Confirmar Salida -> 2) Confirmar Llegada / Entregado */}
      <div className="mt-4 space-y-2.5">
        {!e.completado && (
          <button
            type="button"
            data-testid={`btn-confirmar-salida-${e.id}`}
            disabled={salidaConfirmada}
            onClick={() => onConfirmarSalida(e.id)}
            className={`w-full min-h-14 rounded-xl text-base font-black flex items-center justify-center gap-2.5 border-2 transition ${
              salidaConfirmada
                ? 'bg-amber-200 border-amber-600 text-amber-950 cursor-default'
                : 'bg-amber-500 hover:bg-amber-600 border-amber-700 text-white active:scale-[0.99] cursor-pointer'
            }`}
          >
            <Truck className="w-6 h-6" />
            {salidaConfirmada
              ? `Salida confirmada (${e.hora_salida || 'En ruta'})`
              : 'Confirmar Salida'}
          </button>
        )}

        {!e.completado ? (
          <button
            type="button"
            data-testid={`entrega-toggle-${e.id}`}
            onClick={() => onConfirmarLlegada(e.id)}
            className="w-full min-h-16 rounded-xl bg-ink text-white text-lg font-black flex items-center justify-center gap-3 active:scale-[0.99] hover:bg-zinc-800 transition cursor-pointer"
          >
            <MapPinCheckInside className="w-7 h-7 text-red-500" />
            Confirmar Llegada (Entregado)
          </button>
        ) : confirmarDeshacer ? (
          <div className="rounded-xl border-2 border-red-600 bg-red-50 p-3">
            <p className="font-bold text-ink mb-2">¿Deshacer esta entrega?</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                data-testid={`entrega-deshacer-si-${e.id}`}
                onClick={() => {
                  setConfirmarDeshacer(false);
                  onToggle(e.id);
                }}
                className="min-h-12 rounded-lg bg-red-700 text-white font-black cursor-pointer"
              >
                Sí, deshacer
              </button>
              <button
                type="button"
                onClick={() => setConfirmarDeshacer(false)}
                className="min-h-12 rounded-lg bg-white border-2 border-zinc-400 text-zinc-800 font-black cursor-pointer"
              >
                No
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <div className="flex-1 min-h-16 rounded-xl bg-green-700 text-white text-lg font-black flex items-center justify-center gap-3">
              <CheckCircle2 className="w-7 h-7" />
              Llegada / Entregado
            </div>
            <button
              type="button"
              data-testid={`entrega-deshacer-${e.id}`}
              onClick={() => setConfirmarDeshacer(true)}
              aria-label="Deshacer entrega"
              className="w-16 min-h-16 rounded-xl bg-white border-2 border-zinc-400 text-zinc-700 grid place-items-center hover:bg-zinc-50 cursor-pointer"
            >
              <Undo2 className="w-6 h-6" />
            </button>
          </div>
        )}
      </div>

      {/* Evidencia Fotográfica (Supabase Storage privado `entregas-evidencias`, JPG/PNG/WebP <= 5MB) */}
      <div
        data-testid={`evidencia-section-${e.id}`}
        className="mt-3 rounded-xl border-2 border-zinc-300 bg-zinc-50 p-3 space-y-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-black uppercase text-zinc-700 flex items-center gap-1.5">
            <ImageIcon className="w-4 h-4 text-red-600" />
            Evidencia Fotográfica
          </span>
          {e.evidencia_pendiente_offline ? (
            <span
              data-testid={`evidencia-offline-${e.id}`}
              className="text-[11px] font-black text-amber-900 bg-amber-100 border border-amber-500 rounded-full px-2 py-0.5"
            >
              📱 Guardada offline (subirá al volver señal)
            </span>
          ) : e.evidencia_path ? (
            <span
              data-testid={`evidencia-ok-${e.id}`}
              className="text-[11px] font-black text-green-800 bg-green-100 border border-green-500 rounded-full px-2 py-0.5"
            >
              ✓ Evidencia registrada
            </span>
          ) : null}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          data-testid={`input-evidencia-${e.id}`}
          onChange={(ev) => void handleSeleccionarEvidencia(ev)}
          className="hidden"
        />

        <button
          type="button"
          data-testid={`btn-subir-evidencia-${e.id}`}
          disabled={subiendoEvidencia}
          onClick={() => fileInputRef.current?.click()}
          className="min-h-12 w-full rounded-lg border-2 border-zinc-700 bg-white hover:bg-zinc-100 disabled:opacity-60 text-ink font-black text-sm flex items-center justify-center gap-2 cursor-pointer"
        >
          {subiendoEvidencia ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-red-600" />
              Subiendo evidencia a Supabase...
            </>
          ) : (
            <>
              <Camera className="w-4 h-4 text-red-600" />
              {e.evidencia_path ? 'Reemplazar Evidencia Fotográfica' : 'Subir Evidencia Fotográfica'}
            </>
          )}
        </button>

        {errorEvidencia && (
          <p
            role="alert"
            data-testid={`evidencia-error-${e.id}`}
            className="text-xs font-bold text-red-700 bg-red-50 border border-red-300 rounded-lg px-2.5 py-1.5"
          >
            {errorEvidencia}
          </p>
        )}

        {evidenciaPreviewUrl && (
          <div className="pt-1">
            <img
              data-testid={`evidencia-preview-${e.id}`}
              src={evidenciaPreviewUrl}
              alt={`Evidencia de entrega ${e.cliente}`}
              className="w-full max-h-48 object-cover rounded-lg border border-zinc-300 bg-white"
            />
          </div>
        )}
      </div>

      {/* Nota / incidencia */}
      <div className="mt-3">
        {!notaAbierta ? (
          <button
            type="button"
            data-testid={`nota-abrir-${e.id}`}
            onClick={() => setNotaAbierta(true)}
            className="min-h-12 w-full rounded-lg border-2 border-dashed border-zinc-400 text-zinc-700 font-bold flex items-center justify-center gap-2 hover:bg-zinc-50 cursor-pointer"
          >
            <MessageSquareWarning className="w-5 h-5" />
            Agregar nota / incidencia
          </button>
        ) : (
          <label className="block">
            <span className="text-xs font-black uppercase text-red-800 flex items-center gap-1.5 mb-1">
              <MessageSquareWarning className="w-4 h-4" />
              Nota / incidencia
            </span>
            <textarea
              data-testid={`nota-${e.id}`}
              value={borrador}
              rows={2}
              placeholder="Ej.: Cliente cerrado, se dejó con el encargado…"
              onFocus={() => (editando.current = true)}
              onChange={(ev) => setBorrador(ev.target.value)}
              onBlur={guardarNota}
              className="w-full rounded-lg border-2 border-red-600 bg-red-50 p-2.5 text-base font-semibold text-ink placeholder:text-zinc-500 focus:outline-none focus:ring-4 focus:ring-red-300"
            />
          </label>
        )}
      </div>
    </article>
  );
}
