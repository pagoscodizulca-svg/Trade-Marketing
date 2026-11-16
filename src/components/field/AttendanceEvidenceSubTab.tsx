import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Camera,
  CheckCircle2,
  Clock,
  History,
  Loader2,
  Lock,
  MapPin,
  Maximize2,
  RefreshCw,
  Search,
  ShieldCheck,
  Store as StoreIcon,
  Sun,
  Sunset,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  type AsistenciaEvidenciaDbRow,
  type AsistenciaJornadaDbRow,
  type AttendanceSlotEvidenceItem,
  buildSlotActionAriaLabel,
  type DailyPromotoraAttendanceViewModel,
  getCaracasTodayYmd,
  type PerfilAsistencia,
  SLOT_FOTO_CATALOG,
  type SlotFotoAsistencia,
  type SlotFotoMetadata,
  SLOTS_FOTO_EVENTUAL,
  SLOTS_FOTO_FIJA,
} from '../../types/attendanceEvidences';
import {
  buildDailyPromotoraAttendanceViewModels,
  fetchBatchEvidenceSignedUrls,
  uploadCompressedAttendanceEvidence,
} from '../../services/attendanceEvidencesService';
import {
  type AttendanceRecord,
  fetchCheckinPhotoById,
  fetchCheckinPhotosBatch,
  type StaffMemberRecord,
} from '../../services/supabaseModule1';

export interface AttendanceVisualBlockSpec {
  blockKey: 'JORNADA_UNICA' | 'MANANA' | 'TARDE';
  blockTitle: string | null;
  slots: SlotFotoMetadata[];
}

export interface AttendanceCardLayoutSpec {
  perfilAplicado: PerfilAsistencia;
  totalSlots: 2 | 4;
  hasShiftSplitHeaders: boolean;
  blocks: AttendanceVisualBlockSpec[];
}

/**
 * Especificación pura y determinista del layout DOM por tarjeta diaria:
 * - `FIJA`: 1 bloque único sin encabezados de mañana/tarde ni almuerzo, exactamente 2 tarjetas (`JORNADA_INGRESO`, `JORNADA_SALIDA`).
 * - `EVENTUAL`: 2 bloques explícitos (`Jornada de la Mañana` y `Jornada de la Tarde`), exactamente 4 tarjetas (`MANANA_*`, `TARDE_*`).
 */
export function buildAttendanceCardLayoutSpec(
  perfilAplicado: PerfilAsistencia
): AttendanceCardLayoutSpec {
  if (perfilAplicado === 'FIJA') {
    return {
      perfilAplicado: 'FIJA',
      totalSlots: 2,
      hasShiftSplitHeaders: false,
      blocks: [
        {
          blockKey: 'JORNADA_UNICA',
          blockTitle: null,
          slots: SLOTS_FOTO_FIJA.map((s) => SLOT_FOTO_CATALOG[s]),
        },
      ],
    };
  }

  const morningSlots = SLOTS_FOTO_EVENTUAL.filter((s) => s.startsWith('MANANA_')).map(
    (s) => SLOT_FOTO_CATALOG[s]
  );
  const afternoonSlots = SLOTS_FOTO_EVENTUAL.filter((s) => s.startsWith('TARDE_')).map(
    (s) => SLOT_FOTO_CATALOG[s]
  );

  return {
    perfilAplicado: 'EVENTUAL',
    totalSlots: 4,
    hasShiftSplitHeaders: true,
    blocks: [
      {
        blockKey: 'MANANA',
        blockTitle: 'Jornada de la Mañana',
        slots: morningSlots,
      },
      {
        blockKey: 'TARDE',
        blockTitle: 'Jornada de la Tarde',
        slots: afternoonSlots,
      },
    ],
  };
}

interface AttendanceEvidenceSubTabProps {
  staffMembers: StaffMemberRecord[];
  asistenciaJornadas: AsistenciaJornadaDbRow[];
  asistenciaEvidencias: AsistenciaEvidenciaDbRow[];
  legacyAttendanceRecords: AttendanceRecord[];
  searchQuery: string;
  onSearchQueryChange: (nextQuery: string) => void;
  onRefreshData: () => Promise<void>;
  onNotifyToast: (msg: string) => void;
}

interface LightboxModalState {
  title: string;
  promotoraNombre: string;
  perfilAplicado: PerfilAsistencia;
  complianceLabel: string;
  pdvNombre: string;
  fechaFormateada: string;
  horaCaracasCompleta: string;
  imageUrl: string;
  mapsUrl?: string;
  gpsLabel?: string;
}

export const AttendanceEvidenceSubTab: React.FC<AttendanceEvidenceSubTabProps> = ({
  staffMembers,
  asistenciaJornadas,
  asistenciaEvidencias,
  legacyAttendanceRecords,
  searchQuery,
  onSearchQueryChange,
  onRefreshData,
  onNotifyToast,
}) => {
  const todayCaracasYmd = useMemo(() => getCaracasTodayYmd(), []);

  // Por defecto abrimos en la jornada de hoy (America/Caracas), con conmutador de 1 clic hacia Historial Registrado
  const [dateFilterMode, setDateFilterMode] = useState<'fecha' | 'historial'>('fecha');
  const [selectedDateYmd, setSelectedDateYmd] = useState<string>(todayCaracasYmd);
  const [profileFilter, setProfileFilter] = useState<'TODOS' | PerfilAsistencia>('TODOS');
  const [cardLimit, setCardLimit] = useState<number>(30);

  // Estado optimista local tras subidas/reemplazos inmediatos
  const [optimisticJornadas, setOptimisticJornadas] = useState<
    Record<string, AsistenciaJornadaDbRow>
  >({});
  const [optimisticEvidencias, setOptimisticEvidencias] = useState<
    Record<string, AsistenciaEvidenciaDbRow>
  >({});

  // URLs resueltas: Signed URLs privadas (bucket asistencia-evidencias) + base64 legacy (public.checkins)
  const [signedUrlsByEvidenceId, setSignedUrlsByEvidenceId] = useState<Record<string, string>>(
    {}
  );
  const [legacyPhotosByCheckinId, setLegacyPhotosByCheckinId] = useState<
    Record<string, string>
  >({});
  const [isSyncingPhotos, setIsSyncingPhotos] = useState<boolean>(false);

  // Control de carga por ranura: anti-double-submit, porcentaje XHR y errores legibles
  const inFlightSlotKeysRef = useRef<Set<string>>(new Set());
  const fileInputsRef = useRef<Record<string, HTMLInputElement | null>>({});
  const [uploadProgressBySlotKey, setUploadProgressBySlotKey] = useState<
    Record<string, number>
  >({});
  const [slotErrorsBySlotKey, setSlotErrorsBySlotKey] = useState<Record<string, string>>({});

  // Modal Lightbox accesible
  const [lightboxState, setLightboxState] = useState<LightboxModalState | null>(null);

  useEffect(() => {
    if (!lightboxState) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setLightboxState(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightboxState]);

  const mergedJornadas = useMemo<AsistenciaJornadaDbRow[]>(() => {
    const map = new Map<string, AsistenciaJornadaDbRow>();
    for (const j of asistenciaJornadas) {
      map.set(j.id, j);
    }
    for (const j of Object.values(optimisticJornadas)) {
      map.set(j.id, j);
    }
    return Array.from(map.values());
  }, [asistenciaJornadas, optimisticJornadas]);

  const mergedEvidencias = useMemo<AsistenciaEvidenciaDbRow[]>(() => {
    const map = new Map<string, AsistenciaEvidenciaDbRow>();
    for (const e of asistenciaEvidencias) {
      map.set(`${e.asistencia_id}__${e.slot_foto}`, e);
    }
    for (const e of Object.values(optimisticEvidencias)) {
      map.set(`${e.asistencia_id}__${e.slot_foto}`, e);
    }
    return Array.from(map.values());
  }, [asistenciaEvidencias, optimisticEvidencias]);

  const allViewModels = useMemo<DailyPromotoraAttendanceViewModel[]>(() => {
    return buildDailyPromotoraAttendanceViewModels({
      staffMembers,
      asistenciaJornadas: mergedJornadas,
      asistenciaEvidencias: mergedEvidencias,
      legacyAttendanceRecords,
      selectedDateYmd: dateFilterMode === 'fecha' ? selectedDateYmd : null,
    });
  }, [
    staffMembers,
    mergedJornadas,
    mergedEvidencias,
    legacyAttendanceRecords,
    dateFilterMode,
    selectedDateYmd,
  ]);

  // Métricas KPI superiores basadas en el universo de la vista activa (sin "Pausas de Almuerzo")
  const kpiStats = useMemo(() => {
    const fijas = allViewModels.filter((m) => m.perfilAplicado === 'FIJA');
    const eventuales = allViewModels.filter((m) => m.perfilAplicado === 'EVENTUAL');
    const fijasCompletas = fijas.filter((m) => m.compliance.status === 'COMPLETA').length;
    const eventualesCompletas = eventuales.filter(
      (m) => m.compliance.status === 'COMPLETA'
    ).length;
    const totalEvidencias = allViewModels.reduce(
      (acc, m) => acc + m.compliance.uploadedCount,
      0
    );

    return {
      totalJornadas: allViewModels.length,
      fijasTotal: fijas.length,
      fijasCompletas,
      eventualesTotal: eventuales.length,
      eventualesCompletas,
      totalEvidencias,
    };
  }, [allViewModels]);

  const filteredViewModels = useMemo(() => {
    const cleanQ = searchQuery.trim().toLowerCase();
    return allViewModels
      .filter((item) => {
        if (profileFilter !== 'TODOS' && item.perfilAplicado !== profileFilter) {
          return false;
        }
        if (!cleanQ) return true;
        return (
          item.promotoraNombre.toLowerCase().includes(cleanQ) ||
          item.pdvNombre.toLowerCase().includes(cleanQ) ||
          item.zona.toLowerCase().includes(cleanQ) ||
          item.fechaJornada.includes(cleanQ) ||
          item.fechaSlash.includes(cleanQ) ||
          item.perfilAplicado.toLowerCase().includes(cleanQ)
        );
      })
      .slice(0, cardLimit);
  }, [allViewModels, profileFilter, searchQuery, cardLimit]);

  const groupedByDay = useMemo(() => {
    const groups: Array<{
      fechaJornada: string;
      fechaSlash: string;
      fechaLongEs: string;
      items: DailyPromotoraAttendanceViewModel[];
      totalFotosDia: number;
    }> = [];
    const byDate = new Map<string, (typeof groups)[number]>();

    for (const item of filteredViewModels) {
      let grp = byDate.get(item.fechaJornada);
      if (!grp) {
        grp = {
          fechaJornada: item.fechaJornada,
          fechaSlash: item.fechaSlash,
          fechaLongEs: item.fechaLongEs,
          items: [],
          totalFotosDia: 0,
        };
        byDate.set(item.fechaJornada, grp);
        groups.push(grp);
      }
      grp.items.push(item);
      grp.totalFotosDia += item.compliance.uploadedCount;
    }

    return groups;
  }, [filteredViewModels]);

  // Carga automática de Signed URLs (Storage privado) y fotos legacy por lote para las tarjetas visibles
  useEffect(() => {
    const privateIdsToFetch: string[] = [];
    const legacyIdsToFetch: string[] = [];

    for (const vm of filteredViewModels) {
      for (const ev of Object.values(vm.evidencesBySlot)) {
        if (!ev) continue;
        if (ev.source === 'storage_privado') {
          if (!ev.signedUrl && signedUrlsByEvidenceId[ev.id] === undefined) {
            privateIdsToFetch.push(ev.id);
          }
        } else if (
          ev.legacyCheckinId &&
          legacyPhotosByCheckinId[ev.legacyCheckinId] === undefined
        ) {
          legacyIdsToFetch.push(ev.legacyCheckinId);
        }
      }
    }

    if (privateIdsToFetch.length === 0 && legacyIdsToFetch.length === 0) {
      return;
    }

    let cancelled = false;
    setIsSyncingPhotos(true);

    Promise.all([
      privateIdsToFetch.length > 0
        ? fetchBatchEvidenceSignedUrls(privateIdsToFetch).catch(
            (): Record<string, string> => ({})
          )
        : Promise.resolve<Record<string, string>>({}),
      legacyIdsToFetch.length > 0
        ? fetchCheckinPhotosBatch(legacyIdsToFetch).catch(
            (): Record<string, string> => ({})
          )
        : Promise.resolve<Record<string, string>>({}),
    ])
      .then(([signedBatch, legacyBatch]) => {
        if (cancelled) return;

        if (privateIdsToFetch.length > 0) {
          setSignedUrlsByEvidenceId((prev) => {
            const next = { ...prev };
            for (const id of privateIdsToFetch) {
              next[id] = signedBatch[id] || '';
            }
            return next;
          });
        }

        if (legacyIdsToFetch.length > 0) {
          setLegacyPhotosByCheckinId((prev) => {
            const next = { ...prev };
            for (const id of legacyIdsToFetch) {
              next[id] = legacyBatch[id] || '';
            }
            return next;
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsSyncingPhotos(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filteredViewModels, signedUrlsByEvidenceId, legacyPhotosByCheckinId]);

  const resolvePreviewUrl = useCallback(
    (ev?: AttendanceSlotEvidenceItem): string => {
      if (!ev) return '';
      if (ev.source === 'storage_privado') {
        return signedUrlsByEvidenceId[ev.id] || ev.signedUrl || '';
      }
      if (ev.legacyCheckinId) {
        return legacyPhotosByCheckinId[ev.legacyCheckinId] || '';
      }
      return '';
    },
    [signedUrlsByEvidenceId, legacyPhotosByCheckinId]
  );

  const handleReloadSlotPreview = useCallback(
    async (ev: AttendanceSlotEvidenceItem) => {
      try {
        if (ev.source === 'storage_privado') {
          const fresh = await fetchBatchEvidenceSignedUrls([ev.id]);
          if (fresh[ev.id]) {
            setSignedUrlsByEvidenceId((prev) => ({ ...prev, [ev.id]: fresh[ev.id] }));
            onNotifyToast('✓ URL firmada temporal renovada correctamente.');
          } else {
            onNotifyToast('Inicie sesión autenticada para solicitar la URL firmada del bucket privado.');
          }
          return;
        }

        if (ev.legacyCheckinId) {
          const base64 = await fetchCheckinPhotoById(ev.legacyCheckinId);
          if (base64) {
            setLegacyPhotosByCheckinId((prev) => ({
              ...prev,
              [ev.legacyCheckinId!]: base64,
            }));
            onNotifyToast('✓ Fotografía sincronizada desde Supabase.');
          }
        }
      } catch {
        onNotifyToast('No se pudo sincronizar la fotografía en este momento.');
      }
    },
    [onNotifyToast]
  );

  const handleOpenLightbox = useCallback(
    async (
      vm: DailyPromotoraAttendanceViewModel,
      slotMeta: SlotFotoMetadata,
      ev: AttendanceSlotEvidenceItem
    ) => {
      let imageUrl = resolvePreviewUrl(ev);

      if (!imageUrl) {
        if (ev.source === 'storage_privado') {
          const fresh = await fetchBatchEvidenceSignedUrls([ev.id]).catch(
            (): Record<string, string> => ({})
          );
          imageUrl = fresh[ev.id] || '';
          if (imageUrl) {
            setSignedUrlsByEvidenceId((prev) => ({ ...prev, [ev.id]: imageUrl }));
          }
        } else if (ev.legacyCheckinId) {
          const base64 = await fetchCheckinPhotoById(ev.legacyCheckinId).catch(() => null);
          imageUrl = base64 || '';
          if (imageUrl) {
            setLegacyPhotosByCheckinId((prev) => ({
              ...prev,
              [ev.legacyCheckinId!]: imageUrl,
            }));
          }
        }
      }

      if (!imageUrl) {
        onNotifyToast('No se pudo obtener la imagen ampliada. Verifique su sesión activa.');
        return;
      }

      setLightboxState({
        title: slotMeta.cardTitle,
        promotoraNombre: vm.promotoraNombre,
        perfilAplicado: vm.perfilAplicado,
        complianceLabel: `${vm.compliance.fractionLabel} · ${vm.compliance.statusLabel}`,
        pdvNombre: ev.pdvNombre || vm.pdvNombre,
        fechaFormateada: ev.fechaFormateada || vm.fechaSlash,
        horaCaracasCompleta: ev.horaCaracasCompleta,
        imageUrl,
        mapsUrl: ev.mapsUrl || vm.mapsUrl,
        gpsLabel:
          ev.lat !== undefined && ev.lng !== undefined
            ? `${ev.lat.toFixed(6)}, ${ev.lng.toFixed(6)}${
                ev.gpsAccuracy !== undefined ? ` (±${ev.gpsAccuracy}m)` : ''
              }`
            : undefined,
      });
    },
    [resolvePreviewUrl, onNotifyToast]
  );

  const handleSlotFileSelected = useCallback(
    async (
      vm: DailyPromotoraAttendanceViewModel,
      slotFoto: SlotFotoAsistencia,
      fileList: FileList | null
    ) => {
      const file = fileList?.[0];
      const slotOpKey = `${vm.fechaJornada}__${vm.promotoraId}__${slotFoto}`;

      // Limpiar valor del input para permitir re-seleccionar el mismo archivo si hubo error
      if (fileInputsRef.current[slotOpKey]) {
        fileInputsRef.current[slotOpKey]!.value = '';
      }

      if (!file) return;

      // Bloqueo síncrono anti-double-submit
      if (inFlightSlotKeysRef.current.has(slotOpKey)) {
        return;
      }

      inFlightSlotKeysRef.current.add(slotOpKey);
      setSlotErrorsBySlotKey((prev) => {
        const next = { ...prev };
        delete next[slotOpKey];
        return next;
      });
      setUploadProgressBySlotKey((prev) => ({ ...prev, [slotOpKey]: 1 }));

      try {
        const resp = await uploadCompressedAttendanceEvidence({
          file,
          metadata: {
            promotoraId: vm.promotoraId,
            fechaJornada: vm.fechaJornada,
            slotFoto,
            pdvNombre: vm.pdvNombre,
            zona: vm.zona,
          },
          onProgress: (pct) => {
            setUploadProgressBySlotKey((prev) => ({ ...prev, [slotOpKey]: pct }));
          },
        });

        // Actualizar estado optimista inmediato con la respuesta oficial del servidor
        setOptimisticJornadas((prev) => ({
          ...prev,
          [resp.jornada.id]: {
            id: resp.jornada.id,
            fecha_jornada: resp.jornada.fechaJornada,
            promotora_id: resp.jornada.promotoraId,
            promotora_nombre: resp.jornada.promotoraNombre,
            perfil_aplicado: resp.jornada.perfilAplicado,
            pdv_nombre: resp.jornada.pdvNombre,
            zona: resp.jornada.zona,
            opened_at_server: resp.evidencia.capturadoEnServidorIso,
            updated_at_server: resp.evidencia.capturadoEnServidorIso,
            opened_by_uid: null,
          },
        }));

        const compositeKey = `${resp.jornada.id}__${resp.evidencia.slotFoto}`;
        setOptimisticEvidencias((prev) => ({
          ...prev,
          [compositeKey]: {
            id: resp.evidencia.id,
            asistencia_id: resp.jornada.id,
            slot_foto: resp.evidencia.slotFoto,
            storage_bucket: 'asistencia-evidencias',
            storage_path: resp.evidencia.storagePath,
            mime_type: resp.evidencia.mimeType,
            tamano_bytes: resp.evidencia.sizeBytes,
            sha256_hex: '',
            ancho_px: null,
            alto_px: null,
            pdv_nombre: resp.evidencia.pdvNombre,
            lat: resp.evidencia.lat,
            lng: resp.evidencia.lng,
            gps_accuracy: resp.evidencia.gpsAccuracy,
            capturado_en_servidor: resp.evidencia.capturadoEnServidorIso,
            cargado_por_uid: null,
            cargado_por_rol: 'coordinadora',
          },
        }));

        if (resp.evidencia.signedUrl) {
          setSignedUrlsByEvidenceId((prev) => ({
            ...prev,
            [resp.evidencia.id]: resp.evidencia.signedUrl,
          }));
        }

        onNotifyToast(
          resp.replaced
            ? `✓ Evidencia reemplazada (${resp.compliance.fractionLabel} · ${resp.compliance.statusLabel}) — ${resp.evidencia.horaCaracasFormateada}`
            : `✓ Evidencia registrada (${resp.compliance.fractionLabel} · ${resp.compliance.statusLabel}) — ${resp.evidencia.horaCaracasFormateada}`
        );

        void onRefreshData();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'No se pudo cargar la evidencia fotográfica.';
        setSlotErrorsBySlotKey((prev) => ({ ...prev, [slotOpKey]: message }));
      } finally {
        inFlightSlotKeysRef.current.delete(slotOpKey);
        setUploadProgressBySlotKey((prev) => {
          const next = { ...prev };
          delete next[slotOpKey];
          return next;
        });
      }
    },
    [onNotifyToast, onRefreshData]
  );

  const renderSlotCard = (
    vm: DailyPromotoraAttendanceViewModel,
    slotMeta: SlotFotoMetadata
  ) => {
    const ev = vm.evidencesBySlot[slotMeta.slot];
    const hasEvidence = Boolean(ev);
    const slotOpKey = `${vm.fechaJornada}__${vm.promotoraId}__${slotMeta.slot}`;
    const activeProgress = uploadProgressBySlotKey[slotOpKey];
    const isUploading = typeof activeProgress === 'number';
    const slotError = slotErrorsBySlotKey[slotOpKey];
    const previewUrl = resolvePreviewUrl(ev);

    const actionAriaLabel = buildSlotActionAriaLabel({
      slotFoto: slotMeta.slot,
      promotoraNombre: vm.promotoraNombre,
      isReplacement: hasEvidence,
    });

    const triggerFilePicker = () => {
      if (isUploading) return;
      fileInputsRef.current[slotOpKey]?.click();
    };

    return (
      <div
        key={slotMeta.slot}
        data-slot-foto={slotMeta.slot}
        className="bg-zinc-900/80 border border-zinc-800/90 rounded-2xl p-3.5 flex flex-col justify-between gap-3 shadow-inner"
      >
        <input
          ref={(el) => {
            fileInputsRef.current[slotOpKey] = el;
          }}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          aria-label={actionAriaLabel}
          disabled={isUploading}
          onChange={(e) => void handleSlotFileSelected(vm, slotMeta.slot, e.target.files)}
          className="sr-only"
        />

        {/* Cabecera de la ranura */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <span className="text-xs font-black text-white tracking-tight block">
              {slotMeta.cardTitle}
            </span>
            <span className="text-[11px] text-zinc-400 block mt-0.5">{slotMeta.subtitle}</span>
          </div>

          {hasEvidence && ev ? (
            <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-black bg-emerald-950/90 text-emerald-300 border border-emerald-700/80 shrink-0">
              {ev.horaCaracasFormateada}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-zinc-950 text-zinc-400 border border-zinc-800 shrink-0">
              Sin foto
            </span>
          )}
        </div>

        {/* Estado de carga con barra de progreso accesible */}
        {isUploading ? (
          <div className="rounded-xl bg-zinc-950 border border-red-500/40 h-56 flex flex-col items-center justify-center p-4 text-center space-y-3">
            <Loader2 className="w-7 h-7 text-red-500 animate-spin" />
            <div className="w-full max-w-[220px] space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-200">
                <span>Optimizando y subiendo...</span>
                <span className="font-bold text-red-400">{activeProgress}%</span>
              </div>
              <div
                role="progressbar"
                aria-label={`Progreso de carga para ${slotMeta.cardTitle}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={activeProgress}
                className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden"
              >
                <div
                  className="h-full bg-gradient-to-r from-red-600 to-emerald-500 transition-all duration-200"
                  style={{ width: `${activeProgress}%` }}
                />
              </div>
            </div>
            <span className="text-[10px] text-zinc-400 font-mono">
              Validando firma binaria y hora oficial UTC-4
            </span>
          </div>
        ) : hasEvidence && ev ? (
          /* Tarjeta con miniatura + acciones táctiles >= 44px */
          <div className="space-y-2.5">
            <div className="relative group rounded-xl overflow-hidden bg-black border border-zinc-800 h-56 flex items-center justify-center">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt={`${vm.promotoraNombre} — ${slotMeta.cardTitle}`}
                  loading="lazy"
                  onClick={() => void handleOpenLightbox(vm, slotMeta, ev)}
                  className="w-full h-full object-cover cursor-pointer group-hover:scale-[1.02] transition-transform duration-300"
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
                  <Lock className="w-5 h-5 text-zinc-400" />
                  <span className="text-[11px] text-zinc-300 font-medium max-w-[190px]">
                    Evidencia protegida en almacenamiento privado
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleReloadSlotPreview(ev)}
                    className="min-h-[40px] px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-red-600 text-xs text-white font-bold border border-zinc-700 transition cursor-pointer"
                  >
                    Cargar vista previa segura
                  </button>
                </div>
              )}

              {/* Leyenda inferior de trazabilidad oficial */}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/80 to-transparent p-2.5 pt-6 pointer-events-none">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-red-600/90 text-white">
                    {slotMeta.shortBadge}
                  </span>
                  {ev.source === 'storage_privado' && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-emerald-950/90 text-emerald-300 border border-emerald-700/70">
                      Signed URL
                    </span>
                  )}
                </div>
                <p className="text-[10px] font-bold text-zinc-100 truncate">
                  {ev.pdvNombre || vm.pdvNombre} • {ev.horaCaracasCompleta}
                </p>
              </div>
            </div>

            {/* Botonera táctil accesible (Ampliar + Reemplazar idempotente) */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleOpenLightbox(vm, slotMeta, ev)}
                aria-label={`Ampliar ${slotMeta.ariaActionPhrase} de ${vm.promotoraNombre}`}
                className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 text-xs font-bold transition cursor-pointer"
              >
                <Maximize2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Ampliar</span>
              </button>

              <button
                type="button"
                onClick={triggerFilePicker}
                disabled={isUploading}
                aria-label={actionAriaLabel}
                className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-950 hover:bg-red-950/70 text-zinc-200 hover:text-red-200 border border-zinc-800 hover:border-red-700/70 text-xs font-bold transition disabled:opacity-50 cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span>Reemplazar</span>
              </button>
            </div>
          </div>
        ) : (
          /* Estado limpio sin evidencia registrada + botón táctil >= 44px */
          <div className="rounded-xl bg-zinc-950/90 border border-dashed border-zinc-800 h-56 flex flex-col items-center justify-center p-4 text-center space-y-3">
            <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400">
              <UploadCloud className="w-5 h-5 text-red-500" />
            </div>
            <p className="text-xs text-zinc-400 font-medium max-w-[200px]">
              {slotMeta.emptyStateLabel}
            </p>
            <button
              type="button"
              onClick={triggerFilePicker}
              disabled={isUploading}
              aria-label={actionAriaLabel}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-extrabold shadow-lg shadow-red-950/50 transition disabled:opacity-50 cursor-pointer"
            >
              <Camera className="w-4 h-4 shrink-0" />
              <span>Subir evidencia</span>
            </button>
          </div>
        )}

        {/* Alerta de error legible por ranura */}
        {slotError && (
          <div
            role="alert"
            className="rounded-xl bg-red-950/80 border border-red-700/80 px-3 py-2 flex items-start justify-between gap-2 text-[11px] text-red-200"
          >
            <div className="flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <span>{slotError}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                setSlotErrorsBySlotKey((prev) => {
                  const next = { ...prev };
                  delete next[slotOpKey];
                  return next;
                })
              }
              aria-label="Cerrar mensaje de error"
              className="text-red-300 hover:text-white p-0.5 shrink-0 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {/* 1. 4 TARJETAS KPI ALINEADAS A REGLAS CONTRACTUALES FIJA (2/2) vs EVENTUAL (4/4) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-900 shadow-lg">
          <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block mb-1">
            JORNADAS EVALUADAS
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-black text-white font-mono">
              {kpiStats.totalJornadas}
            </span>
            <span className="text-xs text-zinc-400 font-medium">
              {dateFilterMode === 'fecha' ? `día ${selectedDateYmd}` : 'en historial'}
            </span>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-900 shadow-lg">
          <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block mb-1">
            CUMPLIMIENTO FIJAS (2/2)
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-black text-emerald-400 font-mono">
              {kpiStats.fijasCompletas}/{kpiStats.fijasTotal}
            </span>
            <span className="text-xs text-zinc-400 font-medium">jornadas completas</span>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-900 shadow-lg">
          <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block mb-1">
            CUMPLIMIENTO EVENTUALES (4/4)
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-black text-amber-400 font-mono">
              {kpiStats.eventualesCompletas}/{kpiStats.eventualesTotal}
            </span>
            <span className="text-xs text-zinc-400 font-medium">mañana + tarde</span>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-900 shadow-lg">
          <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block mb-1">
            EVIDENCIAS VERIFICADAS (UTC-4)
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-black text-red-400 font-mono">
              {kpiStats.totalEvidencias}
            </span>
            <span className="text-xs text-zinc-400 font-medium">hora servidor Caracas</span>
          </div>
        </div>
      </div>

      {/* 2. BARRA DE FILTROS: FECHA DE JORNADA, PERFIL (FIJA / EVENTUAL) Y BUSCADOR */}
      <div className="p-3.5 rounded-2xl bg-zinc-950 border border-zinc-900 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Selector de modo fecha vs historial registrado */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl bg-black border border-zinc-800 p-1">
              <button
                type="button"
                onClick={() => setDateFilterMode('fecha')}
                className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer ${
                  dateFilterMode === 'fecha'
                    ? 'bg-red-600 text-white shadow'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Calendar className="w-3.5 h-3.5" />
                <span>Jornada por Fecha</span>
              </button>
              <button
                type="button"
                onClick={() => setDateFilterMode('historial')}
                className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer ${
                  dateFilterMode === 'historial'
                    ? 'bg-red-600 text-white shadow'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                <span>Todas las Fechas Registradas</span>
              </button>
            </div>

            {dateFilterMode === 'fecha' && (
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={selectedDateYmd}
                  max={todayCaracasYmd}
                  aria-label="Seleccionar fecha de jornada de asistencia"
                  onChange={(e) => {
                    if (e.target.value) setSelectedDateYmd(e.target.value);
                  }}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs font-mono text-white focus:outline-none focus:border-red-600"
                />
                {selectedDateYmd !== todayCaracasYmd && (
                  <button
                    type="button"
                    onClick={() => setSelectedDateYmd(todayCaracasYmd)}
                    className="min-h-[38px] px-2.5 py-1 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-[11px] font-bold text-zinc-200 transition cursor-pointer"
                  >
                    Ir a Hoy
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Filtro por modalidad contractual */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'TODOS', label: 'Todos los perfiles' },
                { id: 'FIJA', label: 'Fijas · 2 fotos' },
                { id: 'EVENTUAL', label: 'Eventuales · 4 fotos' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setProfileFilter(opt.id)}
                className={`min-h-[36px] px-3 py-1 rounded-xl text-xs font-bold border transition cursor-pointer ${
                  profileFilter === opt.id
                    ? 'bg-zinc-100 text-zinc-950 border-white'
                    : 'bg-black text-zinc-300 border-zinc-800 hover:border-zinc-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Buscador y límite de visualización */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-zinc-900">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Buscar promotora, PDV, zona o fecha..."
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              className="w-full min-h-[38px] pl-9 pr-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600 font-medium"
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-mono">
              <span>Tarjetas:</span>
              <select
                value={cardLimit}
                onChange={(e) => setCardLimit(Number(e.target.value))}
                aria-label="Cantidad de tarjetas de asistencia a mostrar"
                className="min-h-[36px] px-2.5 py-1 rounded-lg bg-black border border-zinc-800 text-white text-xs font-mono"
              >
                <option value={15}>15 promotoras</option>
                <option value={30}>30 promotoras</option>
                <option value={80}>80 promotoras</option>
                <option value={500}>Todas ({allViewModels.length})</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => void onRefreshData()}
              className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-bold text-zinc-200 transition cursor-pointer"
              title="Sincronizar jornadas y evidencias desde Supabase"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-emerald-400 ${
                  isSyncingPhotos ? 'animate-spin' : ''
                }`}
              />
              <span className="hidden sm:inline">Sincronizar</span>
            </button>
          </div>
        </div>
      </div>

      {/* 3. LISTADO AGRUPADO POR DÍA CON RENDERIZADO CONDICIONAL ESTRICTO (FIJA=2 vs EVENTUAL=4) */}
      {groupedByDay.length === 0 ? (
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-10 text-center space-y-2">
          <Clock className="w-8 h-8 text-zinc-600 mx-auto" />
          <p className="text-sm font-bold text-zinc-200">
            No se encontraron jornadas de asistencia con los filtros seleccionados.
          </p>
          <p className="text-xs text-zinc-400">
            Puede cambiar la fecha de consulta o conmutar a &ldquo;Todas las Fechas Registradas&rdquo;.
          </p>
        </div>
      ) : (
        groupedByDay.map((dayGroup) => (
          <div key={dayGroup.fechaJornada} className="space-y-4">
            {/* Cabecera del día */}
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 shadow-lg">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-red-950/60 border border-red-500/40 flex items-center justify-center text-red-500">
                  <Calendar className="w-4 h-4" />
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-xs sm:text-sm font-black text-white uppercase tracking-wide">
                    {dayGroup.fechaLongEs}
                  </span>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 font-bold">
                    {dayGroup.fechaSlash}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="px-2.5 py-1 rounded-lg bg-red-950/70 border border-red-800/80 text-red-300 font-bold">
                  {dayGroup.items.length} promotora(s)
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 font-bold">
                  {dayGroup.totalFotosDia} evidencia(s)
                </span>
              </div>
            </div>

            {/* Tarjetas por promotora */}
            <div className="space-y-5">
              {dayGroup.items.map((vm) => {
                const layoutSpec = buildAttendanceCardLayoutSpec(vm.perfilAplicado);
                const statusColors =
                  vm.compliance.status === 'COMPLETA'
                    ? 'bg-emerald-950/85 text-emerald-300 border-emerald-700/80'
                    : vm.compliance.status === 'INCOMPLETA'
                      ? 'bg-amber-950/85 text-amber-300 border-amber-700/80'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800';

                const profileBadgeColors =
                  vm.perfilAplicado === 'FIJA'
                    ? 'bg-sky-950/80 text-sky-300 border-sky-700/70'
                    : 'bg-purple-950/80 text-purple-300 border-purple-700/70';

                return (
                  <article
                    key={vm.key}
                    data-perfil-aplicado={vm.perfilAplicado}
                    className="bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden shadow-2xl"
                  >
                    {/* Cabecera de la promotora + Snapshot de Perfil + Progreso (2/2 o 4/4) */}
                    <div className="px-5 py-4 border-b border-zinc-900 flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-gradient-to-r from-zinc-950 via-zinc-900/70 to-zinc-950">
                      <div className="flex items-start sm:items-center gap-3.5">
                        <div className="w-11 h-11 rounded-full bg-red-600 text-white font-black text-sm flex items-center justify-center border-2 border-red-400/80 shadow-lg shadow-red-950/70 shrink-0">
                          {vm.promotoraInitials}
                        </div>

                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h5 className="text-sm sm:text-base font-black text-white uppercase tracking-tight">
                              {vm.promotoraNombre}
                            </h5>

                            {/* Insignia de Perfil Aplicado */}
                            <span
                              className={`px-2.5 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider border ${profileBadgeColors}`}
                              title={
                                vm.perfilFuente === 'SNAPSHOT_HISTORICO'
                                  ? 'Perfil sellado de forma inmutable al abrir esta jornada histórica'
                                  : 'Perfil contractual actual en plantilla activa'
                              }
                            >
                              {vm.perfilAplicado === 'FIJA'
                                ? 'PERFIL FIJA · 2 FOTOS'
                                : 'PERFIL EVENTUAL · 4 FOTOS'}
                            </span>

                            {/* Insignia de Progreso (2/2 o 4/4) + Estado */}
                            <span
                              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-[10px] font-mono font-black uppercase tracking-wider border ${statusColors}`}
                            >
                              {vm.compliance.status === 'COMPLETA' && (
                                <CheckCircle2 className="w-3 h-3 shrink-0" />
                              )}
                              <span>
                                {vm.compliance.fractionLabel} · {vm.compliance.statusLabel}
                              </span>
                            </span>

                            {vm.perfilFuente === 'SNAPSHOT_HISTORICO' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono text-emerald-300 bg-emerald-950/50 border border-emerald-800/60">
                                <ShieldCheck className="w-3 h-3 shrink-0" />
                                <span>Snapshot sellado</span>
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                            <StoreIcon className="w-3.5 h-3.5 text-red-500 shrink-0" />
                            <span className="font-semibold text-zinc-200">{vm.pdvNombre}</span>
                            {vm.zona && (
                              <span className="text-zinc-500 font-mono text-[11px]">
                                • {vm.zona}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2.5 text-xs font-mono">
                        <span className="px-2.5 py-1 rounded-lg bg-black border border-zinc-800 text-zinc-300">
                          Jornada: <strong className="text-white">{vm.fechaSlash}</strong>
                        </span>

                        {vm.mapsUrl && (
                          <a
                            href={vm.mapsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="min-h-[34px] inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-950/60 hover:bg-emerald-900/70 text-emerald-300 border border-emerald-800/80 text-[11px] font-bold transition"
                          >
                            <MapPin className="w-3.5 h-3.5 shrink-0" />
                            <span>Ver GPS</span>
                          </a>
                        )}
                      </div>
                    </div>

                    {/* CUERPO CONDICIONAL ESTRICTO:
                        - FIJA: 1 solo grid de 2 columnas (Ingreso y Salida de la jornada laboral), CERO referencias a mañana/tarde.
                        - EVENTUAL: 2 secciones diferenciadas ("Jornada de la Mañana" y "Jornada de la Tarde") con 2 tarjetas cada una (total 4). */}
                    {!layoutSpec.hasShiftSplitHeaders ? (
                      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                        {layoutSpec.blocks[0].slots.map((slotMeta) =>
                          renderSlotCard(vm, slotMeta)
                        )}
                      </div>
                    ) : (
                      <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                        {layoutSpec.blocks.map((block) => {
                          const isMorning = block.blockKey === 'MANANA';
                          return (
                            <section
                              key={block.blockKey}
                              aria-label={`${block.blockTitle} — ${vm.promotoraNombre}`}
                              className="rounded-2xl bg-black/50 border border-zinc-800/90 p-3.5 space-y-3"
                            >
                              <div className="flex items-center justify-between gap-2 pb-2 border-b border-zinc-800/80">
                                <div className="flex items-center gap-2">
                                  {isMorning ? (
                                    <Sun className="w-4 h-4 text-amber-400 shrink-0" />
                                  ) : (
                                    <Sunset className="w-4 h-4 text-purple-400 shrink-0" />
                                  )}
                                  <h6 className="text-xs font-black uppercase tracking-wider text-white">
                                    {block.blockTitle}
                                  </h6>
                                </div>
                                <span className="text-[10px] font-mono text-zinc-400">
                                  2 evidencias requeridas
                                </span>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                {block.slots.map((slotMeta) => renderSlotCard(vm, slotMeta))}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        ))
      )}

      {/* 4. MODAL LIGHTBOX ACCESIBLE */}
      {lightboxState && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${lightboxState.title} — ${lightboxState.promotoraNombre}`}
          onClick={() => setLightboxState(null)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-w-3xl w-full rounded-2xl bg-zinc-950 border border-zinc-800 overflow-hidden shadow-2xl"
          >
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-black text-white uppercase">
                    {lightboxState.title}
                  </h4>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-950 text-red-300 border border-red-800">
                    {lightboxState.perfilAplicado} · {lightboxState.complianceLabel}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {lightboxState.promotoraNombre} • {lightboxState.pdvNombre} •{' '}
                  {lightboxState.fechaFormateada} {lightboxState.horaCaracasCompleta}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setLightboxState(null)}
                aria-label="Cerrar vista ampliada de evidencia"
                className="min-h-[40px] min-w-[40px] rounded-xl bg-zinc-900 hover:bg-red-600 text-zinc-200 hover:text-white border border-zinc-800 flex items-center justify-center transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-black flex items-center justify-center max-h-[72vh] overflow-hidden">
              <img
                src={lightboxState.imageUrl}
                alt={`${lightboxState.promotoraNombre} — ${lightboxState.title}`}
                className="max-h-[72vh] w-auto object-contain"
              />
            </div>

            {lightboxState.gpsLabel && (
              <div className="px-5 py-3 border-t border-zinc-900 flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-zinc-300">
                <span>Coordenadas verificadas: {lightboxState.gpsLabel}</span>
                {lightboxState.mapsUrl && (
                  <a
                    href={lightboxState.mapsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 font-bold"
                  >
                    Abrir en Google Maps →
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
