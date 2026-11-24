import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Navigation,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import {
  SLOT_FOTO_CATALOG,
  SLOTS_FOTO_EVENTUAL,
  SLOTS_FOTO_FIJA,
  type AttendanceLocationSource,
  type SlotFotoAsistencia,
  evaluateAttendanceCompliance,
  formatServerTimestampCaracas,
  getCaracasTodayYmd,
} from '../../types/attendanceEvidences';
import {
  fetchPortalTodayAttendance,
  getCaracasClockAndPunctuality,
  savePortalActiveStore,
  submitPortalAttendanceEvidence,
  validatePortalImageFile,
  type PortalClientOption,
  type PortalPromotoraContext,
  type PortalTodayAttendanceState,
} from '../../services/promotoraCampoService';
import { useDirectLocation } from '../../hooks/useDirectLocation';
import {
  formatLocationSourceLabel,
  IOS_SAFARI_GPS_COMPACT_HINT,
} from '../../utils/directLocationEngine';
import { PortalStoreSelector } from './PortalCatalogSelectors';

interface PortalAsistenciaTabProps {
  context: PortalPromotoraContext;
  clients: PortalClientOption[];
  activeStore: string;
  onActiveStoreChange: (store: string) => void;
  onNotify: (message: string) => void;
}

interface CapturedGpsSummary {
  lat: number;
  lng: number;
  accuracy: number;
  locationSource: AttendanceLocationSource;
}

export const PortalAsistenciaTab: React.FC<PortalAsistenciaTabProps> = ({
  context,
  clients,
  activeStore,
  onActiveStoreChange,
  onNotify,
}) => {
  const todayYmd = getCaracasTodayYmd();
  const [selectedZona, setSelectedZona] = useState<string>(context.direccion || context.region);
  const [todayState, setTodayState] = useState<PortalTodayAttendanceState>({
    jornada: null,
    evidencias: [],
    signedUrlsByEvidenceId: {},
  });
  const [isSyncing, setIsSyncing] = useState(false);

  const effectiveProfile = todayState.jornada?.perfil_aplicado || context.perfilAsistencia;
  const allowedSlots = useMemo<readonly SlotFotoAsistencia[]>(
    () => (effectiveProfile === 'EVENTUAL' ? SLOTS_FOTO_EVENTUAL : SLOTS_FOTO_FIJA),
    [effectiveProfile]
  );

  const [selectedSlot, setSelectedSlot] = useState<SlotFotoAsistencia>(
    effectiveProfile === 'EVENTUAL' ? 'MANANA_INGRESO' : 'JORNADA_INGRESO'
  );

  // Reloj VE en vivo
  const [clockInfo, setClockInfo] = useState(() => getCaracasClockAndPunctuality());
  useEffect(() => {
    const id = window.setInterval(() => setClockInfo(getCaracasClockAndPunctuality()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const selectedClientMeta = useMemo(() => {
    const clean = activeStore.trim().toLowerCase();
    if (!clean) return null;
    return clients.find((c) => c.nombre.trim().toLowerCase() === clean) ?? null;
  }, [clients, activeStore]);

  // Motor de ubicación directa en cascada (3 capas + caché <60s + auto-recuperación iOS/Android)
  const {
    location: gpsLocation,
    isCapturing: isCapturingGps,
    permissionDeniedHint,
    errorMessage: gpsError,
    triggerDirectCapture,
    setManualFallbackLocation,
  } = useDirectLocation({
    pdvNombre: activeStore,
    clienteId: selectedClientMeta?.id ?? null,
    region: context.region,
    sucursal: context.sucursal,
    enabled: true,
    autoPrewarm: true,
  });

  // Disparo síncrono por gesto natural de usuario (cumple política User Gesture de iOS Safari WebKit)
  const triggerGpsOnNaturalGesture = useCallback(() => {
    if (!gpsLocation || gpsLocation.locationSource === 'ip_fallback') {
      void triggerDirectCapture({ forceFresh: gpsLocation?.locationSource === 'ip_fallback' });
    }
  }, [gpsLocation, triggerDirectCapture]);

  const requestGps = useCallback(() => {
    void triggerDirectCapture({ forceFresh: true });
  }, [triggerDirectCapture]);

  // Estado cámara y archivo
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | Blob | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Envío
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savedSummary, setSavedSummary] = useState<{
    slot: SlotFotoAsistencia;
    store: string;
    timeVe: string;
    gps: CapturedGpsSummary;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl, stopCamera]);

  const syncTodayAttendance = useCallback(async () => {
    setIsSyncing(true);
    try {
      const data = await fetchPortalTodayAttendance({
        promotoraId: context.promotoraId,
        fechaJornada: todayYmd,
      });
      setTodayState(data);

      const profileNow = data.jornada?.perfil_aplicado || context.perfilAsistencia;
      const slotsNow = profileNow === 'EVENTUAL' ? SLOTS_FOTO_EVENTUAL : SLOTS_FOTO_FIJA;
      const uploadedSet = new Set(data.evidencias.map((e) => e.slot_foto));
      const nextMissing = slotsNow.find((s) => !uploadedSet.has(s)) || slotsNow[slotsNow.length - 1];
      setSelectedSlot(nextMissing);
    } finally {
      setIsSyncing(false);
    }
  }, [context.perfilAsistencia, context.promotoraId, todayYmd]);

  useEffect(() => {
    void syncTodayAttendance();
  }, [syncTodayAttendance]);

  const startInAppCamera = async (mode: 'user' | 'environment' = facingMode) => {
    setFileError(null);
    triggerGpsOnNaturalGesture();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      nativeCameraInputRef.current?.click();
      return;
    }
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: mode }, width: { ideal: 720 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      setIsCameraActive(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => undefined);
        }
      });
    } catch {
      nativeCameraInputRef.current?.click();
    }
  };

  const handleCaptureSelfie = async () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 960;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85)
    );
    if (!blob) {
      setFileError('No se pudo capturar la imagen desde la cámara.');
      return;
    }
    if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    setSelectedFile(blob);
    setPreviewUrl(URL.createObjectURL(blob));
    stopCamera();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileError(null);
    try {
      validatePortalImageFile(file);
      if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      stopCamera();
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Archivo de imagen inválido.');
    }
  };

  const handleSubmitAttendance = async () => {
    if (isSubmitting || isSubmittingRef.current) return;
    setSubmitError(null);

    if (!activeStore.trim()) {
      setSubmitError('Selecciona el Punto de Venta (PDV) antes de certificar asistencia.');
      return;
    }
    if (!selectedFile) {
      setSubmitError('Toma una fotografía o selecciona una evidencia válida (JPEG/PNG/WebP).');
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      const resolvedLoc = gpsLocation ?? (await triggerDirectCapture({ forceFresh: true }));
      if (!resolvedLoc) {
        setSubmitError(
          'No se pudo obtener ubicación (ni GPS ni respaldo de red). Verifica tu conexión y reintenta.'
        );
        return;
      }

      const result = await submitPortalAttendanceEvidence({
        context,
        slotFoto: selectedSlot,
        pdvNombre: activeStore.trim(),
        zona: selectedZona,
        lat: resolvedLoc.lat,
        lng: resolvedLoc.lng,
        gpsAccuracy: resolvedLoc.accuracyMeters,
        locationSource: resolvedLoc.locationSource,
        imageFile: selectedFile,
        fechaJornada: todayYmd,
      });

      const timeVe = formatServerTimestampCaracas(result.evidencia.capturado_en_servidor);
      setSavedSummary({
        slot: selectedSlot,
        store: activeStore.trim(),
        timeVe,
        gps: {
          lat: resolvedLoc.lat,
          lng: resolvedLoc.lng,
          accuracy: resolvedLoc.accuracyMeters,
          locationSource: resolvedLoc.locationSource,
        },
      });
      onNotify(
        `Asistencia registrada (${SLOT_FOTO_CATALOG[selectedSlot].shortBadge}) • ${timeVe} UTC-4`
      );
      await syncTodayAttendance();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'No se pudo certificar la asistencia en Supabase.'
      );
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const uploadedSlots = useMemo(
    () => todayState.evidencias.map((e) => e.slot_foto),
    [todayState.evidencias]
  );
  const compliance = useMemo(
    () => evaluateAttendanceCompliance(effectiveProfile, uploadedSlots),
    [effectiveProfile, uploadedSlots]
  );

  return (
    <div className="space-y-4 pb-6" data-testid="portal-asistencia-tab">
      {/* Encabezado y Selector de PDV */}
      <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 shadow-xl space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-red-600/20 border border-red-500/40 text-red-500 flex items-center justify-center shrink-0">
              <Navigation className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-black text-white uppercase tracking-wider">
                Marcaje de Asistencia en PDV
              </h2>
              <p className="text-[10px] text-neutral-400 font-mono">
                Evidencia Storage Privado • GPS + Hora VE ({context.region})
              </p>
            </div>
          </div>
          <span className="px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 text-[9px] font-bold font-mono">
            {effectiveProfile === 'FIJA' ? 'FIJA • 2 Fotos' : 'EVENTUAL • 4 Fotos'}
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
            label="Punto de Venta / Sucursal:"
            testIdPrefix="asistencia-store"
          />
        </div>
      </div>

      {savedSummary ? (
        <div
          data-testid="portal-asistencia-success"
          className="bg-[#0d0d0d] border border-emerald-500/40 rounded-2xl p-6 text-center space-y-4 shadow-xl"
        >
          <div className="w-14 h-14 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-base font-black text-white">¡Marcaje Registrado Exitosamente!</h3>
            <p className="text-xs text-neutral-400 mt-1">
              Sincronizado en tiempo real con Módulo 1 → Informe → Asistencia en PDV.
            </p>
          </div>
          <div className="p-3 bg-[#171717] rounded-xl border border-neutral-800 text-xs text-left space-y-1 font-mono">
            <p className="text-white">
              <strong>Hito:</strong>{' '}
              <span className="text-red-400">{SLOT_FOTO_CATALOG[savedSummary.slot].cardTitle}</span>
            </p>
            <p className="text-neutral-300">
              <strong>Comercio:</strong> {savedSummary.store}
            </p>
            <p className="text-emerald-400 text-[11px]">
              <strong>Hora VE:</strong> {savedSummary.timeVe} •{' '}
              <strong>{formatLocationSourceLabel(savedSummary.gps.locationSource)}:</strong>{' '}
              {savedSummary.gps.lat}, {savedSummary.gps.lng} (±{savedSummary.gps.accuracy}m)
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setSavedSummary(null);
              setSelectedFile(null);
              setPreviewUrl(null);
            }}
            className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs uppercase tracking-wider cursor-pointer"
          >
            Realizar Otro Marcaje
          </button>
        </div>
      ) : (
        <>
          {/* Horario Oficial y Puntualidad */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-3.5 space-y-2 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span className="text-[10px] font-black uppercase tracking-wider text-white">
                  Horario Oficial de Ingreso PDV
                </span>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full border text-[9px] font-black font-mono ${
                  clockInfo.status === 'puntual'
                    ? 'bg-emerald-950/70 border-emerald-500/40 text-emerald-300'
                    : clockInfo.status === 'tolerancia'
                      ? 'bg-sky-950/70 border-sky-500/40 text-sky-300'
                      : 'bg-amber-950/70 border-amber-500/40 text-amber-300'
                }`}
              >
                Hora VE: {clockInfo.formattedTime}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
              <div className="bg-[#151515] border border-neutral-800/80 rounded-xl px-2.5 py-1.5">
                <span className="text-neutral-400 block text-[9px]">Entrada Estándar:</span>
                <strong className="text-emerald-400">8:00 AM – 9:00 AM</strong>
              </div>
              <div className="bg-[#151515] border border-neutral-800/80 rounded-xl px-2.5 py-1.5">
                <span className="text-neutral-400 block text-[9px]">Límite Tolerancia:</span>
                <strong className="text-sky-400">Hasta las 9:15 AM</strong>
              </div>
            </div>
          </div>

          {/* Estado de Jornada de Hoy (Condicional FIJA=2 / EVENTUAL=4) */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-3.5 space-y-2.5 shadow-xl">
            <div className="flex items-center justify-between flex-wrap gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>
                  Jornada de Hoy ({todayYmd}):
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                <span className="px-2 py-0.5 rounded-md bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 text-[10px] font-mono font-bold">
                  {compliance.fractionLabel} • {compliance.statusLabel}
                </span>
                <button
                  type="button"
                  onClick={() => void syncTodayAttendance()}
                  disabled={isSyncing}
                  className="px-2 py-0.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] font-mono flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className={`w-3 h-3 text-emerald-400 ${isSyncing ? 'animate-spin' : ''}`} />
                  <span>Sincronizar</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {allowedSlots.map((slot) => {
                const meta = SLOT_FOTO_CATALOG[slot];
                const ev = todayState.evidencias.find((e) => e.slot_foto === slot);
                const isSelected = selectedSlot === slot;
                const thumbUrl = ev ? todayState.signedUrlsByEvidenceId[ev.id] : null;
                return (
                  <button
                    key={slot}
                    type="button"
                    data-testid={`slot-btn-${slot}`}
                    onClick={() => {
                      setSelectedSlot(slot);
                      triggerGpsOnNaturalGesture();
                    }}
                    className={`p-2 rounded-xl border text-left transition-all cursor-pointer flex items-center justify-between gap-2 ${
                      ev
                        ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                        : isSelected
                          ? 'bg-red-950/60 border-red-500 text-white'
                          : 'bg-[#171717] border-neutral-800 text-neutral-300 hover:border-neutral-700'
                    }`}
                  >
                    <div className="min-w-0">
                      <span className="text-[10px] font-black block truncate">
                        {meta.shortBadge}
                      </span>
                      <span className="text-[9px] font-mono block truncate opacity-80">
                        {ev
                          ? `✓ ${formatServerTimestampCaracas(ev.capturado_en_servidor)}`
                          : 'Pendiente • Tocar'}
                      </span>
                    </div>
                    {thumbUrl && (
                      <img
                        src={thumbUrl}
                        alt={meta.shortBadge}
                        className="w-8 h-8 rounded-lg object-cover border border-emerald-500/40 shrink-0"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 1. Selector de Hito */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-2.5 shadow-xl">
            <span className="text-[10px] font-bold uppercase tracking-wider text-red-400 block">
              1. Hito Fotográfico Activo ({SLOT_FOTO_CATALOG[selectedSlot].cardTitle}):
            </span>
            <div className="grid grid-cols-2 gap-2">
              {allowedSlots.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  onClick={() => {
                    setSelectedSlot(slot);
                    triggerGpsOnNaturalGesture();
                  }}
                  className={`py-2.5 px-2 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    selectedSlot === slot
                      ? 'bg-red-600 border-red-500 text-white shadow-lg shadow-red-950/60'
                      : 'bg-[#171717] border-neutral-800 text-neutral-400 hover:text-white'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{SLOT_FOTO_CATALOG[slot].shortBadge}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 2. Validación Satelital GPS */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300">
                2. Validación Satelital de Coordenadas (GPS):
              </span>
              <button
                type="button"
                onClick={requestGps}
                disabled={isCapturingGps}
                className="px-2 py-0.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] font-mono flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${isCapturingGps ? 'animate-spin' : ''}`} />
                <span>Actualizar</span>
              </button>
            </div>

            {gpsLocation ? (
              <div className="space-y-2">
                <div
                  data-testid="asistencia-gps-validated"
                  data-location-source={gpsLocation.locationSource}
                  className={`p-3 bg-[#171717] rounded-xl border flex items-center justify-between gap-2 ${
                    gpsLocation.locationSource === 'ip_fallback'
                      ? 'border-amber-500/45'
                      : 'border-emerald-500/40'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        gpsLocation.locationSource === 'ip_fallback'
                          ? 'bg-amber-950/70 text-amber-400'
                          : 'bg-emerald-950 text-emerald-400'
                      }`}
                    >
                      <ShieldCheck className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <span
                        className={`text-xs font-bold block font-mono truncate ${
                          gpsLocation.locationSource === 'ip_fallback'
                            ? 'text-amber-300'
                            : 'text-emerald-400'
                        }`}
                      >
                        {gpsLocation.locationSource === 'gps_high'
                          ? `GPS Validado (±${gpsLocation.accuracyMeters}m)`
                          : gpsLocation.locationSource === 'wifi_cell'
                            ? `Ubicación Wi-Fi / Red Validada (±${gpsLocation.accuracyMeters}m)`
                            : `Respaldo Auditado Activo (±${gpsLocation.accuracyMeters}m)`}
                      </span>
                      <span className="text-[10px] text-neutral-400 font-mono block truncate">
                        Lat: {gpsLocation.lat} • Lng: {gpsLocation.lng}
                        {gpsLocation.label ? ` • ${gpsLocation.label}` : ''}
                      </span>
                    </div>
                  </div>
                  <MapPin
                    className={`w-4 h-4 shrink-0 ${
                      gpsLocation.locationSource === 'ip_fallback'
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                    }`}
                  />
                </div>
                {permissionDeniedHint && gpsLocation.locationSource === 'ip_fallback' && (
                  <p
                    data-testid="asistencia-safari-gps-hint"
                    className="text-[10px] text-neutral-400 font-mono leading-snug px-1"
                  >
                    {IOS_SAFARI_GPS_COMPACT_HINT}
                  </p>
                )}
              </div>
            ) : isCapturingGps ? (
              <div className="p-3 bg-[#171717] rounded-xl border border-neutral-800 flex items-center justify-center gap-2 text-xs text-neutral-400 font-mono">
                <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                <span>Obteniendo coordenadas directas (GPS / Red)...</span>
              </div>
            ) : gpsError ? (
              <div className="p-3 bg-red-950/40 border border-red-500/40 rounded-xl space-y-2">
                <div className="flex items-center gap-2 text-red-300 text-xs">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{gpsError}</span>
                </div>
                {permissionDeniedHint && (
                  <p
                    data-testid="asistencia-safari-gps-hint"
                    className="text-[10px] text-neutral-300 font-mono leading-snug"
                  >
                    {IOS_SAFARI_GPS_COMPACT_HINT}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={requestGps}
                    className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold cursor-pointer"
                  >
                    Reintentar Captura GPS
                  </button>
                  {context.isManagerOrAdmin && (
                    <button
                      type="button"
                      data-testid="asistencia-gps-supervision-fallback"
                      onClick={() => {
                        setManualFallbackLocation({
                          lat: context.region === 'Valencia' ? 10.16202 : 10.65445,
                          lng: context.region === 'Valencia' ? -68.00765 : -71.64058,
                          accuracyMeters: 25,
                          locationSource: 'ip_fallback',
                          capturedAtMs: Date.now(),
                          capturedAtIso: new Date().toISOString(),
                          label: `Sede ${context.region}`,
                        });
                      }}
                      className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 text-neutral-200 rounded-lg text-[11px] font-bold cursor-pointer"
                    >
                      Usar GPS Sede ({context.region})
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-3 bg-[#171717] rounded-xl border border-neutral-800 flex items-center justify-center gap-2 text-xs text-neutral-400 font-mono">
                <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                <span>Obteniendo coordenadas satelitales...</span>
              </div>
            )}
          </div>

          {/* 3. Cámara In-App WebRTC + Cámara Nativa + Galería */}
          <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-300">
                3. Fotografía de Evidencia (JPG / PNG / WebP · Máx. 5 MB):
              </span>
              {isCameraActive && (
                <button
                  type="button"
                  onClick={() => {
                    const next = facingMode === 'user' ? 'environment' : 'user';
                    setFacingMode(next);
                    void startInAppCamera(next);
                  }}
                  className="px-2 py-0.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{facingMode === 'user' ? 'Trasera' : 'Frontal'}</span>
                </button>
              )}
            </div>

            <div className="relative aspect-[4/3] bg-black rounded-xl overflow-hidden border border-neutral-800 flex items-center justify-center">
              {isCameraActive ? (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`}
                  />
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="w-36 h-48 border-2 border-dashed border-red-500/70 rounded-[50%]" />
                  </div>
                </>
              ) : previewUrl ? (
                <div className="relative w-full h-full">
                  <img
                    src={previewUrl}
                    alt="Evidencia de asistencia"
                    className="w-full h-full object-contain bg-black"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFile(null);
                      setPreviewUrl(null);
                    }}
                    className="absolute top-2 right-2 p-1.5 rounded-full bg-black/80 text-white hover:text-red-400 cursor-pointer"
                    title="Repetir fotografía"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="text-center p-4 space-y-1.5 text-neutral-500">
                  <Camera className="w-9 h-9 mx-auto opacity-50 text-red-500" />
                  <p className="text-xs text-neutral-300 font-medium">
                    Cámara Biométrica Integrada o Archivo
                  </p>
                  <p className="text-[10px] text-neutral-500">
                    Sellado automático con fecha/hora VE y coordenadas GPS.
                  </p>
                </div>
              )}
            </div>

            {fileError && (
              <div className="p-2.5 rounded-xl bg-red-950/60 border border-red-500/40 text-red-200 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{fileError}</span>
              </div>
            )}

            <input
              ref={nativeCameraInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture={facingMode === 'user' ? 'user' : 'environment'}
              onChange={handleFileInputChange}
              className="hidden"
            />
            <input
              ref={galleryInputRef}
              data-testid="portal-asistencia-file-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileInputChange}
              className="hidden"
            />

            {!isCameraActive ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => void startInAppCamera()}
                  className="py-2.5 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-black text-[11px] uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>Cámara In-App</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    triggerGpsOnNaturalGesture();
                    nativeCameraInputRef.current?.click();
                  }}
                  className="py-2.5 px-3 rounded-xl bg-[#171717] hover:bg-neutral-800 border border-neutral-700 text-white font-bold text-[11px] uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Cámara Nativa</span>
                </button>
                <button
                  type="button"
                  data-testid="portal-asistencia-gallery-btn"
                  onClick={() => {
                    triggerGpsOnNaturalGesture();
                    galleryInputRef.current?.click();
                  }}
                  className="py-2.5 px-3 rounded-xl bg-[#171717] hover:bg-neutral-800 border border-neutral-700 text-neutral-200 font-bold text-[11px] uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <ImageIcon className="w-3.5 h-3.5 text-amber-400" />
                  <span>Galería</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleCaptureSelfie()}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                <span>Tomar Fotografía de Evidencia</span>
              </button>
            )}
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

          {/* Botón Final Certificar & Guardar Asistencia */}
          <button
            type="button"
            data-testid="portal-asistencia-submit"
            onClick={() => void handleSubmitAttendance()}
            disabled={!selectedFile || !activeStore.trim() || isSubmitting}
            className={`w-full py-4 rounded-xl font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg transition-all ${
              !selectedFile || !activeStore.trim() || isSubmitting
                ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white shadow-red-600/30 cursor-pointer'
            }`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Certificando Asistencia...</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                <span>Certificar & Guardar Asistencia</span>
              </>
            )}
          </button>
        </>
      )}
    </div>
  );
};
