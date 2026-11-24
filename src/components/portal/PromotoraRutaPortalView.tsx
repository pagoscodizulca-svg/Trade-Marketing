import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckSquare,
  ClipboardList,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  Lock,
  LogOut,
  Package,
  RefreshCw,
  Route as RouteIcon,
  ShieldAlert,
  ShieldCheck,
  Tag,
  UserCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { usePromotoraRutaRealtime } from '../../hooks/usePromotoraRutaRealtime';
import {
  GENERIC_INVALID_CREDENTIALS_MESSAGE,
  isValidPortalEmailFormat,
  normalizePortalEmail,
  signInPromotoraPortalWithPassword,
  signOutSupabaseSession,
  verifyActivePromotoraPortalAccess,
  type VerifiedAuthProfile,
} from '../../services/authService';
import {
  completeOwnPasswordChange,
  MIN_SUPABASE_PASSWORD_LENGTH,
} from '../../services/userManagementService';
import {
  fetchPortalPdvGeofences,
  matchRutaPdvGeofence,
  submitPromotoraRouteExecution,
  type PortalPdvGeofenceRef,
} from '../../services/promotoraRutaPortalService';
import {
  decodeBase64ToBlob,
  enqueuePortalAction,
  isTransientOfflineOrNetworkError,
  loadPortalOfflineSnapshot,
  loadPortalShiftSession,
  purgePortalOfflineSensitiveData,
  savePortalOfflineSnapshot,
  savePortalShiftSession,
  type StoredPortalShiftSession,
} from '../../services/portalOfflineQueueService';
import {
  fetchShiftBootstrapData,
  syncShiftOfflineMutationsBatch,
  verifyShiftLinkToken,
} from '../../services/shiftLinksService';
import { useOfflineSync } from '../../hooks/useOfflineSync';
import { OfflineSyncBanner } from './OfflineSyncBanner';
import { createIncidenciaPdv } from '../../services/popIncidenciasService';
import {
  isOperativeSucursal,
  OPERATIVE_SUCURSALES,
  SUCURSAL_LABELS,
  type OperativeSucursal,
} from '../../services/userManagementService';
import {
  canBypassFieldGeofence,
  hasAssignedRegionalScope,
  isSuperAdminProfile,
} from '../../utils/permissions';
import { UnassignedRegionGate } from '../auth/UnassignedRegionGate';
import { IncidenciaQuickModal } from './IncidenciaQuickModal';
import { ControlRoomThemeToggle } from '../ui/ControlRoomThemeToggle';
import {
  evaluateGeofenceCheck,
  type CapturedGeolocationFix,
} from '../../utils/geofenceHaversine';
import {
  clearDirectLocationCache,
  prewarmBrowserGeolocationOnGesture,
  resolveDirectLocationCascade,
} from '../../utils/directLocationEngine';
import type { EjecucionPdvInput } from '../../types/degustacionesPipeline';
import {
  getSupabaseClient,
  isSupabaseConfigured,
  SUPABASE_NOT_CONFIGURED_MESSAGE,
} from '../../services/supabaseClient';
import type { RutaPromotoraRecord } from '../../types/degustacionesPipeline';
import { getCaracasTodayYmd } from '../../utils/caracasWeekCycle';
import {
  navigateTo,
  pathForPortalSubTab,
  resolvePortalSubTab,
  type PortalSubTab,
} from '../../utils/appRouter';
import {
  buildFallbackPromotoraContext,
  clearPortalAsistenciaDraft,
  fetchPortalClientsCatalog,
  fetchPortalProductsCatalog,
  getSavedPortalActiveStore,
  loadPortalAsistenciaDraft,
  resolvePortalPromotoraContext,
  savePortalActiveStore,
  type PortalClientOption,
  type PortalProductOption,
  type PortalPromotoraContext,
} from '../../services/promotoraCampoService';
import { PortalRutaTab } from './PortalRutaTab';
import { PortalAsistenciaTab } from './PortalAsistenciaTab';
import { PortalInventarioTab } from './PortalInventarioTab';
import { PortalEncuestasTab } from './PortalEncuestasTab';
import { PortalPreciosTab } from './PortalPreciosTab';
import { PortalMerchandisingTab } from './PortalMerchandisingTab';
import { PortalPerfilTab } from './PortalPerfilTab';
import { PublicTokenPdvView } from './PublicTokenPdvView';
import { extractPublicPdvTokenFromSearch } from '../../services/publicPdvLinksService';

type DateFilterMode = 'todas' | 'hoy' | 'proximas';

export interface PromotoraRutaPortalViewProps {
  /** Perfil verificado inicial opcional para pruebas SSR/QA determinísticas */
  initialProfile?: VerifiedAuthProfile | null;
  /** Rutas iniciales opcionales para pruebas SSR/QA determinísticas */
  initialRoutes?: RutaPromotoraRecord[] | null;
}

function formatDisplayDate(ymd: string): string {
  const parts = String(ymd || '').split('-');
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'Pendiente';
  try {
    return new Date(iso).toLocaleTimeString('es-VE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return 'Sincronizado';
  }
}

export const PromotoraRutaPortalView: React.FC<PromotoraRutaPortalViewProps> = ({
  initialProfile = null,
  initialRoutes = null,
}) => {
  const [authChecking, setAuthChecking] = useState<boolean>(() => !initialProfile);
  const [profile, setProfile] = useState<VerifiedAuthProfile | null>(() => initialProfile);
  const [shiftSessionState, setShiftSessionState] = useState<StoredPortalShiftSession | null>(null);
  const [shiftRoutes, setShiftRoutes] = useState<RutaPromotoraRecord[]>([]);
  const [cachedOfflineRoutes, setCachedOfflineRoutes] = useState<RutaPromotoraRecord[]>(
    () => initialRoutes ?? []
  );
  const [geofenceCatalog, setGeofenceCatalog] = useState<PortalPdvGeofenceRef[]>([]);
  const [cachedProductsCount, setCachedProductsCount] = useState<number>(0);
  const [shiftSyncedAt, setShiftSyncedAt] = useState<string | null>(null);
  const [shiftRefreshing, setShiftRefreshing] = useState<boolean>(false);

  const [emailInput, setEmailInput] = useState<string>('');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Estado para cambio obligatorio de contraseña en primer ingreso (`must_change_password = true`)
  const [newPasswordInput, setNewPasswordInput] = useState<string>('');
  const [confirmNewPasswordInput, setConfirmNewPasswordInput] = useState<string>('');
  const [showNewPassword, setShowNewPassword] = useState<boolean>(false);
  const [changingPassword, setChangingPassword] = useState<boolean>(false);
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(null);

  const [dateFilter, setDateFilter] = useState<DateFilterMode>(() =>
    initialProfile && isSuperAdminProfile(initialProfile) ? 'todas' : 'proximas'
  );
  const [supervisionSucursal, setSupervisionSucursal] = useState<'TODAS' | OperativeSucursal>(
    'TODAS'
  );
  const [supervisionPromotora, setSupervisionPromotora] = useState<string>('TODAS');
  const [liveBanner, setLiveBanner] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [processingRutaId, setProcessingRutaId] = useState<string | null>(null);

  // Estado de navegación multi-módulo `/portal/*` (paridad total con `codizulca-dashboard-4` + recuperación de cámara nativa Android)
  const [activePortalTab, setActivePortalTab] = useState<PortalSubTab>(() => {
    if (typeof window === 'undefined') return 'ruta';
    const path = window.location.pathname;
    const resolved = resolvePortalSubTab(path);
    if (path === '/portal' || path === '/portal/' || path === '/portal/ruta') {
      const draft = loadPortalAsistenciaDraft();
      if (draft?.activeTab === 'asistencia') return 'asistencia';
    }
    return resolved;
  });
  const [portalContext, setPortalContext] = useState<PortalPromotoraContext | null>(() =>
    initialProfile ? buildFallbackPromotoraContext(initialProfile) : null
  );
  const [portalClients, setPortalClients] = useState<PortalClientOption[]>([]);
  const [portalProducts, setPortalProducts] = useState<PortalProductOption[]>([]);
  const [activeStore, setActiveStore] = useState<string>(() => {
    const draft = loadPortalAsistenciaDraft();
    return draft?.activeStore || getSavedPortalActiveStore();
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => setActivePortalTab(resolvePortalSubTab(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const handleSelectPortalTab = useCallback((tab: PortalSubTab) => {
    // Disparo directo dentro del gesto de usuario (iOS Safari Safe) al abrir Asistencia o Ruta
    if (tab === 'asistencia' || tab === 'ruta') {
      prewarmBrowserGeolocationOnGesture();
    }
    if (tab !== 'asistencia') {
      clearPortalAsistenciaDraft();
    }
    setActivePortalTab(tab);
    navigateTo(pathForPortalSubTab(tab));
  }, []);

  const handleJumpToModule = useCallback(
    (target: 'asistencia' | 'inventario' | 'precios', storeName: string) => {
      if (storeName.trim()) {
        savePortalActiveStore(storeName.trim());
        setActiveStore(storeName.trim());
      }
      handleSelectPortalTab(target);
    },
    [handleSelectPortalTab]
  );

  // Hidratar ficha real de promotora (`public.promotoras`) + catálogos maestros reales (`Clientes`, `Productos`)
  useEffect(() => {
    if (!profile) return;
    let active = true;
    const fallback = buildFallbackPromotoraContext(profile);
    setPortalContext((prev) => prev || fallback);

    void resolvePortalPromotoraContext(profile).then((resolved) => {
      if (!active) return;
      setPortalContext(resolved);
      const regionScope = resolved.isManagerOrAdmin ? 'TODAS' : resolved.region;
      void Promise.all([
        fetchPortalClientsCatalog(regionScope),
        fetchPortalProductsCatalog(),
      ]).then(([cls, prods]) => {
        if (!active) return;
        setPortalClients(cls);
        setPortalProducts(prods);
        setActiveStore((prev) => prev || cls[0]?.nombre || '');
      });
    });

    return () => {
      active = false;
    };
  }, [profile]);

  // Candados síncronos contra envíos múltiples en dispositivos móviles
  const inFlightLoginRef = useRef<boolean>(false);
  const inFlightStepIdsRef = useRef<Set<string>>(new Set());

  const showBanner = useCallback((msg: string) => {
    setLiveBanner(msg);
  }, []);

  useEffect(() => {
    if (!liveBanner) return;
    const t = window.setTimeout(() => setLiveBanner(null), 5000);
    return () => window.clearTimeout(t);
  }, [liveBanner]);

  const hydrateShiftBootstrap = useCallback(
    async (token: string): Promise<boolean> => {
      setShiftRefreshing(true);
      try {
        const boot = await fetchShiftBootstrapData(token);
        const storedRecord: StoredPortalShiftSession = {
          token,
          session: boot.session,
          savedAtIso: new Date().toISOString(),
        };
        const bootRoutes = (boot.rutas as RutaPromotoraRecord[]) || [];
        await savePortalShiftSession(storedRecord);
        await savePortalOfflineSnapshot({
          routes: bootRoutes,
          clients: boot.clientes,
          products: boot.productos,
          syncedAtIso: boot.syncedAt,
        });
        setShiftSessionState(storedRecord);
        setShiftRoutes(bootRoutes);
        setGeofenceCatalog(
          boot.clientes.map((c) => ({
            id: c.id,
            codigoCliente: c.codigo_cliente,
            nombreComercial: c.nombre_comercial,
            latitud: typeof c.latitud === 'number' ? c.latitud : null,
            longitud: typeof c.longitud === 'number' ? c.longitud : null,
            radioGeocercaM: typeof c.radio_geocerca_m === 'number' ? c.radio_geocerca_m : 150,
          }))
        );
        setCachedProductsCount(boot.productos.length);
        setShiftSyncedAt(boot.syncedAt);
        setActionError(null);
        return true;
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 401 || status === 403) {
          await purgePortalOfflineSensitiveData();
          setShiftSessionState(null);
          setShiftRoutes([]);
          setLoginError(
            err instanceof Error
              ? err.message
              : 'Tu enlace dinámico de jornada expiró o fue revocado.'
          );
          return false;
        }
        if (isTransientOfflineOrNetworkError(err)) {
          const snap = await loadPortalOfflineSnapshot();
          setShiftRoutes(snap.routes);
          setCachedProductsCount(snap.products.length);
          setShiftSyncedAt(snap.syncedAtIso);
          return true;
        }
        setActionError(
          err instanceof Error ? err.message : 'No se pudo actualizar la jornada firmada.'
        );
        return false;
      } finally {
        setShiftRefreshing(false);
      }
    },
    []
  );

  // Verificación criptográfica de Enlace Dinámico (`?t=...`) O sesión Supabase Auth
  useEffect(() => {
    if (initialProfile) {
      return;
    }
    let active = true;

    const bootstrapAuthOrShift = async () => {
      // 1. Detectar token opaco firmado `?t=...` en la URL y limpiar query string inmediatamente (Regla 3)
      const urlParams =
        typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
      const rawUrlToken = urlParams?.get('t')?.trim() || '';

      if (rawUrlToken) {
        try {
          window.history.replaceState({}, '', '/portal');
        } catch {
          /* ignorar */
        }

        const verified = await verifyShiftLinkToken(rawUrlToken);
        if (!active) return;

        if (!verified.ok) {
          await purgePortalOfflineSensitiveData();
          setShiftSessionState(null);
          setProfile(null);
          setLoginError(verified.error);
          setAuthChecking(false);
          return;
        }

        if (verified.session.rol !== 'promotora') {
          await purgePortalOfflineSensitiveData();
          setShiftSessionState(null);
          setLoginError('Este enlace firmado corresponde al portal de Choferes (/logistica).');
          setAuthChecking(false);
          return;
        }

        await hydrateShiftBootstrap(rawUrlToken);
        if (active) setAuthChecking(false);
        return;
      }

      // 2. Rehidratar sesión de enlace temporal previa (permite abrir la PWA 100 % offline)
      const storedShift = await loadPortalShiftSession().catch(() => null);
      if (!active) return;
      if (storedShift && storedShift.session?.rol === 'promotora') {
        const expMs = new Date(storedShift.session.expires_at).getTime();
        if (!Number.isFinite(expMs) || expMs <= Date.now()) {
          await purgePortalOfflineSensitiveData();
          setShiftSessionState(null);
          setLoginError(
            'Tu enlace de jornada expiró. Los datos locales fueron purgados automáticamente.'
          );
        } else {
          const snap = await loadPortalOfflineSnapshot().catch(() => ({
            routes: [],
            clients: [],
            products: [],
            syncedAtIso: null,
          }));
          if (!active) return;
          setShiftSessionState(storedShift);
          setShiftRoutes(snap.routes);
          setGeofenceCatalog(
            snap.clients.map((c) => ({
              id: c.id,
              codigoCliente: c.codigo_cliente,
              nombreComercial: c.nombre_comercial,
              latitud: typeof c.latitud === 'number' ? c.latitud : null,
              longitud: typeof c.longitud === 'number' ? c.longitud : null,
              radioGeocercaM: typeof c.radio_geocerca_m === 'number' ? c.radio_geocerca_m : 150,
            }))
          );
          setCachedProductsCount(snap.products.length);
          setShiftSyncedAt(snap.syncedAtIso);
          setAuthChecking(false);
          if (typeof navigator === 'undefined' || navigator.onLine !== false) {
            void hydrateShiftBootstrap(storedShift.token);
          }
          return;
        }
      }

      // 3. Sesión estándar Supabase Auth por correo electrónico
      if (!isSupabaseConfigured) {
        setAuthChecking(false);
        return;
      }

      const client = getSupabaseClient();
      const { data } = await client.auth.getSession();
      if (!active) return;
      if (!data.session) {
        setProfile(null);
        setAuthChecking(false);
        return;
      }

      const { profile: verified, unauthorizedReason } = await verifyActivePromotoraPortalAccess(
        data.session
      );
      if (!active) return;
      setProfile(verified);
      if (unauthorizedReason) {
        setLoginError(unauthorizedReason);
      }
      setAuthChecking(false);
    };

    void bootstrapAuthOrShift();

    if (!isSupabaseConfigured) {
      return () => {
        active = false;
      };
    }

    const client = getSupabaseClient();
    const { data: listener } = client.auth.onAuthStateChange(async (event, session) => {
      if (!active || inFlightLoginRef.current) return;
      if (event === 'SIGNED_OUT' || !session) {
        setProfile(null);
        setAuthChecking(false);
        return;
      }

      const { profile: verified, unauthorizedReason } =
        await verifyActivePromotoraPortalAccess(session);
      if (!active) return;
      setProfile(verified);
      if (unauthorizedReason) {
        setLoginError(unauthorizedReason);
      }
      setAuthChecking(false);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [hydrateShiftBootstrap, initialProfile]);

  const isSuperAdminMode = !shiftSessionState && isSuperAdminProfile(profile);
  const allowGeofenceBypass = !shiftSessionState && canBypassFieldGeofence(profile);

  useEffect(() => {
    if (isSuperAdminMode) {
      setDateFilter((prev) => (prev === 'proximas' ? 'todas' : prev));
    }
  }, [isSuperAdminMode]);

  const {
    routes,
    isLoading,
    isRefreshing,
    isRealtimeConnected,
    lastSyncedAt,
    error: routeFetchError,
    refreshRoutes,
    applyOptimisticRouteUpdate,
  } = usePromotoraRutaRealtime({
    profile: shiftSessionState || initialProfile ? null : profile,
    supervisorFilterPromotoraId: null,
    onLiveBanner: showBanner,
  });

  // Persistir instantánea offline también en sesiones Auth estándar
  useEffect(() => {
    if (shiftSessionState || !profile) return;
    if (routes.length > 0) {
      setCachedOfflineRoutes(routes);
      void savePortalOfflineSnapshot({
        routes,
        clients: geofenceCatalog.map((g) => ({
          id: g.id,
          codigo_cliente: g.codigoCliente,
          nombre_comercial: g.nombreComercial,
          latitud: g.latitud,
          longitud: g.longitud,
          radio_geocerca_m: g.radioGeocercaM,
        })),
        products: [],
        syncedAtIso: lastSyncedAt ?? new Date().toISOString(),
      }).catch(() => undefined);
    } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      void loadPortalOfflineSnapshot()
        .then((snap) => {
          if (snap.routes.length > 0) setCachedOfflineRoutes(snap.routes);
        })
        .catch(() => undefined);
    }
  }, [geofenceCatalog, lastSyncedAt, profile, routes, shiftSessionState]);

  const activeRoutesList = useMemo(
    () => (shiftSessionState ? shiftRoutes : routes.length > 0 ? routes : cachedOfflineRoutes),
    [cachedOfflineRoutes, routes, shiftRoutes, shiftSessionState]
  );

  const supervisionPromotorasOptions = useMemo(() => {
    if (!isSuperAdminMode) return [];
    const seen = new Map<string, string>();
    for (const r of activeRoutesList) {
      const key = String(r.promotora_id || r.promotora_email || r.promotora_nombre || '').trim();
      const label = String(r.promotora_nombre || r.promotora_email || 'Sin promotora').trim();
      if (key && !seen.has(key)) {
        seen.set(key, label);
      }
    }
    return Array.from(seen.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  }, [activeRoutesList, isSuperAdminMode]);

  const todayYmd = getCaracasTodayYmd();

  const filteredRoutes = useMemo(() => {
    return activeRoutesList.filter((r) => {
      if (isSuperAdminMode) {
        if (supervisionSucursal !== 'TODAS') {
          const rowSuc = String((r as { sucursal?: unknown }).sucursal || '')
            .trim()
            .toUpperCase();
          if (rowSuc && rowSuc !== supervisionSucursal) return false;
        }
        if (supervisionPromotora !== 'TODAS') {
          const rowKey = String(r.promotora_id || r.promotora_email || r.promotora_nombre || '').trim();
          if (rowKey !== supervisionPromotora) return false;
        }
        if (dateFilter === 'hoy') return r.fecha === todayYmd;
        if (dateFilter === 'proximas') return r.fecha >= todayYmd;
        return true;
      }

      if (dateFilter === 'hoy') return r.fecha === todayYmd;
      return r.fecha >= todayYmd;
    });
  }, [
    activeRoutesList,
    dateFilter,
    isSuperAdminMode,
    supervisionPromotora,
    supervisionSucursal,
    todayYmd,
  ]);

  const handleLoginSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting || inFlightLoginRef.current) return;

    const normalizedEmail = normalizePortalEmail(emailInput);
    if (!isValidPortalEmailFormat(normalizedEmail)) {
      setLoginError('Ingresa un correo electrónico con formato válido.');
      return;
    }
    if (passwordInput.trim().length === 0) {
      setLoginError('Ingresa tu contraseña.');
      return;
    }

    inFlightLoginRef.current = true;
    setLoginError(null);
    setIsSubmitting(true);

    try {
      const { profile: verifiedProfile } = await signInPromotoraPortalWithPassword(
        normalizedEmail,
        passwordInput
      );
      setPasswordInput('');
      setShowPassword(false);
      setProfile(verifiedProfile);
    } catch (err) {
      setPasswordInput('');
      setLoginError(
        err instanceof Error && err.message
          ? err.message
          : GENERIC_INVALID_CREDENTIALS_MESSAGE
      );
    } finally {
      inFlightLoginRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    clearDirectLocationCache();
    clearPortalAsistenciaDraft();
    if (shiftSessionState) {
      await purgePortalOfflineSensitiveData();
      setShiftSessionState(null);
      setShiftRoutes([]);
      setLoginError(null);
      return;
    }
    await signOutSupabaseSession();
    await purgePortalOfflineSensitiveData();
    setProfile(null);
    setCachedOfflineRoutes([]);
    setPasswordInput('');
    setShowPassword(false);
    setLoginError(null);
  };

  // ---- Hito 5 (B-08) + v1.9.0: GPS + geocerca + ejecución PDV + hook reactivo useOfflineSync ----
  const [geoFeedback, setGeoFeedback] = useState<Record<string, string>>({});
  const [executionTarget, setExecutionTarget] = useState<RutaPromotoraRecord | null>(null);
  const [execForm, setExecForm] = useState({
    lote: '',
    vencimiento: '',
    abiertas: '0',
    muestras: '0',
    ventas: '0',
    observaciones: '',
    motivoFuera: '',
  });
  const [execError, setExecError] = useState<string | null>(null);
  const [incidenciaModalOpen, setIncidenciaModalOpen] = useState<boolean>(false);
  const [incidenciaRutaTarget, setIncidenciaRutaTarget] = useState<RutaPromotoraRecord | null>(
    null
  );

  const openIncidenciaModalForRuta = useCallback((ruta: RutaPromotoraRecord | null) => {
    setIncidenciaRutaTarget(ruta);
    setIncidenciaModalOpen(true);
  }, []);

  const offlineSync = useOfflineSync({
    enabled: Boolean(profile || shiftSessionState),
    shiftExpiresAtIso: shiftSessionState?.session.expires_at ?? null,
    executeAction: async (action) => {
      if (shiftSessionState) {
        const mut =
          action.kind === 'INCIDENCIA_PDV'
            ? {
                client_mutation_id: action.id,
                tipo: 'PROMOTORA_INCIDENCIA' as const,
                payload: {
                  pdv_nombre: action.pdvNombre,
                  cliente_id: action.clienteId ?? null,
                  ruta_id: action.rutaId ?? null,
                  tipo_incidencia: action.tipoIncidencia,
                  severidad: action.severidad,
                  descripcion: action.descripcion,
                  reportado_por_nombre:
                    action.reportadoPorNombre || shiftSessionState.session.personal_nombre || '',
                },
                photoBase64: action.photoBase64 ?? null,
              }
            : {
                client_mutation_id: action.id,
                tipo: 'PROMOTORA_RUTA_STEP' as const,
                payload: {
                  ruta_id: action.rutaId,
                  accion: action.accion,
                  lat: action.lat,
                  lng: action.lng,
                  accuracy_m: action.accuracyMeters,
                  motivo_fuera_geocerca: action.motivoFueraGeocerca ?? '',
                  ejecucion: action.ejecucion ?? null,
                },
              };
        const res = await syncShiftOfflineMutationsBatch(shiftSessionState.token, [mut]);
        const first = res.results[0];
        if (!first?.ok) {
          throw new Error(first?.error || 'No se pudo sincronizar el registro offline.');
        }
        return;
      }

      if (action.kind === 'INCIDENCIA_PDV') {
        const photoBlob = action.photoBase64
          ? decodeBase64ToBlob(action.photoBase64, action.photoMimeType)
          : null;
        await createIncidenciaPdv(
          {
            pdvNombre: action.pdvNombre,
            clienteId: action.clienteId ?? null,
            rutaId: action.rutaId ?? null,
            tipoIncidencia: action.tipoIncidencia,
            severidad: action.severidad,
            descripcion: action.descripcion,
            ...(action.reportadoPorNombre
              ? { reportadoPorNombre: action.reportadoPorNombre }
              : {}),
            ...(action.sucursal ? { sucursal: action.sucursal } : {}),
          },
          photoBlob
        );
        return;
      }

      await submitPromotoraRouteExecution({
        rutaId: action.rutaId,
        accion: action.accion,
        clientSubmissionId: action.id,
        lat: action.lat,
        lng: action.lng,
        accuracyMeters: action.accuracyMeters,
        motivoFueraGeocerca: action.motivoFueraGeocerca,
        ejecucion: action.ejecucion ?? null,
        superAdminBypass: allowGeofenceBypass,
      });
    },
    onSynced: (count) => {
      showBanner(`${count} registro(s) offline sincronizado(s) con el servidor.`);
      if (shiftSessionState) {
        void hydrateShiftBootstrap(shiftSessionState.token);
      } else {
        void refreshRoutes();
      }
    },
    onShiftInvalidated: (reason) => {
      setShiftSessionState(null);
      setShiftRoutes([]);
      setLoginError(reason);
    },
  });

  const {
    isOnline,
    pendingActions: pendingOffline,
    refreshPending,
    syncNow: flushOfflineQueue,
  } = offlineSync;

  useEffect(() => {
    if (!profile || shiftSessionState) return;
    let active = true;
    void fetchPortalPdvGeofences().then((rows) => {
      if (active) setGeofenceCatalog(rows);
    });
    void refreshPending();
    return () => {
      active = false;
    };
  }, [profile, refreshPending, shiftSessionState]);

  const performRouteStep = async (
    item: RutaPromotoraRecord,
    accion: 'CHECKIN' | 'CHECKOUT',
    ejecucion: EjecucionPdvInput | null,
    motivoFuera: string
  ) => {
    if (!item.id || inFlightStepIdsRef.current.has(item.id)) return;
    inFlightStepIdsRef.current.add(item.id);
    setProcessingRutaId(item.id);
    setActionError(null);

    const pdv = matchRutaPdvGeofence(item, geofenceCatalog);
    let fix: CapturedGeolocationFix | null = null;
    let gpsWarning = '';
    const locOutcome = await resolveDirectLocationCascade({
      fallbackContext: {
        pdvNombre: item.cliente_nombre,
        clienteId: pdv?.id ?? null,
        region: portalContext?.region ?? null,
        sucursal: shiftSessionState?.session.sucursal ?? profile?.sucursal ?? null,
      },
      enableServerFallback: !shiftSessionState,
    });
    if (locOutcome.ok) {
      fix = {
        lat: locOutcome.fix.lat,
        lng: locOutcome.fix.lng,
        accuracyMeters: locOutcome.fix.accuracyMeters,
        capturedAtIso: locOutcome.fix.capturedAtIso,
        locationSource: locOutcome.fix.locationSource,
      };
    } else {
      gpsWarning = locOutcome.errorMessage || 'GPS no disponible.';
    }

    const evaluation = fix
      ? evaluateGeofenceCheck({
          capturedLat: fix.lat,
          capturedLng: fix.lng,
          accuracyMeters: fix.accuracyMeters,
          pdvLat: pdv?.latitud,
          pdvLng: pdv?.longitud,
          allowedRadiusMeters: pdv?.radioGeocercaM,
        })
      : null;

    if (evaluation?.requiresAuditJustification && !motivoFuera.trim() && accion === 'CHECKIN') {
      // Se permite continuar, pero queda auditado con motivo por defecto en servidor
    }

    const feedback = allowGeofenceBypass
      ? evaluation?.hasPdvCoordinates && evaluation.insideGeofence
        ? `Super Admin · Dentro de geocerca (${evaluation.distanceMeters} m / ${evaluation.allowedRadiusMeters} m).`
        : 'Modo Supervisión Global (Super Admin): bypass controlado de geocerca GPS habilitado para auditoría.'
      : evaluation?.hasPdvCoordinates
        ? evaluation.insideGeofence
          ? `Dentro de geocerca (${evaluation.distanceMeters} m / ${evaluation.allowedRadiusMeters} m).`
          : `FUERA de geocerca: ${evaluation.distanceMeters} m (máx. ${evaluation.allowedRadiusMeters} m). Alerta auditada.`
        : gpsWarning || 'PDV sin coordenadas maestras: no se valida geocerca.';
    setGeoFeedback((prev) => ({ ...prev, [item.id]: feedback }));

    const effectiveMotivoFuera =
      allowGeofenceBypass && !motivoFuera.trim()
        ? 'Supervisión Global Super Admin (auditoría operativa)'
        : motivoFuera;

    const submissionId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');

    const enqueueLocalAndApplyOptimistic = async () => {
      await enqueuePortalAction({
        id: submissionId,
        rutaId: item.id,
        accion,
        clienteNombre: item.cliente_nombre,
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
        accuracyMeters: fix?.accuracyMeters ?? null,
        motivoFueraGeocerca: motivoFuera,
        ejecucion,
      });
      const optimisticStatus = accion === 'CHECKIN' ? 'EN_CURSO' : 'COMPLETADA';
      if (shiftSessionState) {
        setShiftRoutes((prev) =>
          prev.map((r) => (r.id === item.id ? { ...r, estado_ruta: optimisticStatus } : r))
        );
      } else {
        applyOptimisticRouteUpdate({ ...item, estado_ruta: optimisticStatus });
      }
      await refreshPending();
      showBanner('Sin conexión: el registro quedó en cola offline y se sincronizará automáticamente.');
      if (accion === 'CHECKOUT') setExecutionTarget(null);
    };

    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        await enqueueLocalAndApplyOptimistic();
        return;
      }

      if (shiftSessionState) {
        const res = await syncShiftOfflineMutationsBatch(shiftSessionState.token, [
          {
            client_mutation_id: submissionId,
            tipo: 'PROMOTORA_RUTA_STEP',
            payload: {
              ruta_id: item.id,
              accion,
              lat: fix?.lat ?? null,
              lng: fix?.lng ?? null,
              accuracy_m: fix?.accuracyMeters ?? null,
              motivo_fuera_geocerca: motivoFuera,
              ejecucion,
            },
          },
        ]);
        const first = res.results[0];
        if (!first?.ok) {
          throw new Error(first?.error || 'No se pudo actualizar la ruta de jornada.');
        }
        const nextStatus = accion === 'CHECKIN' ? 'EN_CURSO' : 'COMPLETADA';
        setShiftRoutes((prev) =>
          prev.map((r) => (r.id === item.id ? { ...r, estado_ruta: nextStatus } : r))
        );
        showBanner(
          accion === 'CHECKIN'
            ? `Check-in registrado en ${item.cliente_nombre}.`
            : `Degustación completada en ${item.cliente_nombre}.`
        );
        if (accion === 'CHECKOUT') setExecutionTarget(null);
        return;
      }

      const result = await submitPromotoraRouteExecution({
        rutaId: item.id,
        accion,
        clientSubmissionId: submissionId,
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
        accuracyMeters: fix?.accuracyMeters ?? null,
        motivoFueraGeocerca: effectiveMotivoFuera,
        ejecucion,
        superAdminBypass: allowGeofenceBypass,
      });
      applyOptimisticRouteUpdate(result.ruta);
      showBanner(
        accion === 'CHECKIN'
          ? `Check-in registrado en ${item.cliente_nombre}.`
          : `Degustación completada en ${item.cliente_nombre}.`
      );
      if (accion === 'CHECKOUT') setExecutionTarget(null);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (shiftSessionState && (status === 401 || status === 403)) {
        await offlineSync.purgeAndCloseShift(
          err instanceof Error ? err.message : 'Tu enlace de jornada expiró o fue revocado.'
        );
        return;
      }
      if (isTransientOfflineOrNetworkError(err)) {
        await enqueueLocalAndApplyOptimistic();
      } else {
        const message =
          err instanceof Error ? err.message : 'No se pudo actualizar el estado de la ruta.';
        setActionError(message);
        setExecError(message);
      }
    } finally {
      inFlightStepIdsRef.current.delete(item.id);
      setProcessingRutaId((prev) => (prev === item.id ? null : prev));
    }
  };

  const handleRouteStep = async (item: RutaPromotoraRecord, accion: 'CHECKIN' | 'CHECKOUT') => {
    if (accion === 'CHECKOUT') {
      setExecError(null);
      setExecForm({
        lote: '',
        vencimiento: '',
        abiertas: '0',
        muestras: String(item.personas_estimadas || 0),
        ventas: '0',
        observaciones: '',
        motivoFuera: '',
      });
      setExecutionTarget(item);
      return;
    }
    await performRouteStep(item, 'CHECKIN', null, '');
  };

  const handleSubmitExecution = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!executionTarget) return;
    const abiertas = Number(execForm.abiertas);
    const muestras = Number(execForm.muestras);
    const ventas = Number(execForm.ventas);
    if (![abiertas, muestras, ventas].every((n) => Number.isFinite(n) && n >= 0)) {
      setExecError('Unidades abiertas, muestras y ventas deben ser números iguales o mayores a 0.');
      return;
    }
    if (execForm.lote.trim().length < 2) {
      setExecError('Indica el lote del producto degustado.');
      return;
    }
    if (execForm.vencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(execForm.vencimiento)) {
      setExecError('La fecha de vencimiento no es válida.');
      return;
    }
    setExecError(null);
    await performRouteStep(
      executionTarget,
      'CHECKOUT',
      {
        lote_producto: execForm.lote.trim(),
        fecha_vencimiento: execForm.vencimiento || null,
        unidades_abiertas: abiertas,
        muestras_entregadas: Math.trunc(muestras),
        ventas_asistidas_unidades: Math.trunc(ventas),
        observaciones: execForm.observaciones.trim(),
      },
      execForm.motivoFuera
    );
  };

  if (!isSupabaseConfigured && !shiftSessionState && !authChecking && !initialProfile) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-red-500/35 p-6 text-center space-y-3">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto" />
          <h1 className="text-lg font-extrabold">
            {loginError ? 'Acceso de Jornada Finalizado' : 'Portal de Promotoras sin conexión'}
          </h1>
          {loginError ? (
            <div
              role="alert"
              data-testid="shift-invalid-alert"
              className="rounded-xl bg-red-950/60 border border-red-500/45 px-3.5 py-2.5 text-xs text-red-100 text-left"
            >
              {loginError}
            </div>
          ) : (
            <p className="text-xs text-zinc-400">{SUPABASE_NOT_CONFIGURED_MESSAGE}</p>
          )}
        </div>
      </div>
    );
  }

  const publicPdvToken =
    typeof window !== 'undefined' ? extractPublicPdvTokenFromSearch(window.location.search) : null;
  if (publicPdvToken) {
    return <PublicTokenPdvView token={publicPdvToken} />;
  }

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-white p-2 flex items-center justify-center shadow-[0_6px_28px_rgba(220,38,38,0.3)] border border-white/90">
            <img
              src="/codizulca-logo.png"
              alt="Logo CODIZULCA C.A."
              className="w-full h-full object-contain"
            />
          </div>
          <div className="flex items-center gap-2.5 text-sm font-mono text-zinc-300">
            <Loader2 className="w-4 h-4 text-red-500 animate-spin" />
            <span>Verificando acceso seguro CODIZULCA...</span>
          </div>
        </div>
      </div>
    );
  }

  // 1. Pantalla Minimalista de Login Exclusivo (Solo Correo Electrónico y Contraseña)
  if (!profile && !shiftSessionState) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center px-4 py-8 font-sans selection:bg-red-600 selection:text-white">
        <div className="w-full max-w-sm rounded-2xl bg-zinc-950 border border-white/15 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.9)] p-6 sm:p-8 space-y-6">
          {/* Encabezado limpio de identificación del Portal de Promotoras */}
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-white p-2 flex items-center justify-center shadow-[0_4px_20px_rgba(220,38,38,0.28)] border border-white/90">
              <img
                src="/codizulca-logo.png"
                alt="CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-red-600/15 text-red-400 border border-red-500/30">
                <Lock className="w-3 h-3" /> Portal de Promotoras
              </span>
              <h1 className="text-xl font-extrabold tracking-tight text-white">
                Módulo de Ruta
              </h1>
              <p className="text-xs text-zinc-400">
                Ingresa con tu correo electrónico y contraseña
              </p>
            </div>
          </div>

          <form onSubmit={handleLoginSubmit} noValidate className="space-y-4">
            <div>
              <label
                htmlFor="portal-promotora-email"
                className="block text-xs font-bold text-zinc-200 mb-1.5"
              >
                Correo electrónico
              </label>
              <input
                id="portal-promotora-email"
                name="email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="email"
                spellCheck={false}
                required
                disabled={isSubmitting}
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="nombre@correo.com"
                className="w-full px-3.5 py-3 rounded-xl bg-black border border-zinc-700 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/40 disabled:opacity-60 transition"
              />
            </div>

            <div>
              <label
                htmlFor="portal-promotora-password"
                className="block text-xs font-bold text-zinc-200 mb-1.5"
              >
                Contraseña
              </label>
              <div className="relative">
                <input
                  id="portal-promotora-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  disabled={isSubmitting}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-3.5 pr-11 py-3 rounded-xl bg-black border border-zinc-700 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/40 disabled:opacity-60 transition"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={isSubmitting}
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  className="absolute inset-y-0 right-0 px-3 flex items-center justify-center text-zinc-400 hover:text-white disabled:opacity-50 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {loginError && (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-xl bg-red-950/60 border border-red-500/45 px-3.5 py-2.5 text-xs text-red-100 flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3 px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-55 disabled:cursor-not-allowed text-white font-extrabold text-sm flex items-center justify-center gap-2 transition cursor-pointer shadow-lg shadow-red-950/60"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verificando acceso...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Iniciar Sesión</span>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 1.B. Cambio obligatorio de contraseña en primer ingreso (`must_change_password = true`)
  if (profile && profile.mustChangePassword && !shiftSessionState) {
    const handlePortalPasswordChangeSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (changingPassword) return;
      setPasswordChangeError(null);

      if (
        newPasswordInput.trim().length === 0 ||
        newPasswordInput.length < MIN_SUPABASE_PASSWORD_LENGTH
      ) {
        setPasswordChangeError(
          `La nueva contraseña debe tener al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres.`
        );
        return;
      }
      if (newPasswordInput !== confirmNewPasswordInput) {
        setPasswordChangeError('Las contraseñas no coinciden. Verifícalas e intenta nuevamente.');
        return;
      }

      setChangingPassword(true);
      try {
        await completeOwnPasswordChange(newPasswordInput);
        setNewPasswordInput('');
        setConfirmNewPasswordInput('');
        setShowNewPassword(false);
        setProfile((prev) => (prev ? { ...prev, mustChangePassword: false } : null));
      } catch (err) {
        setPasswordChangeError(
          err instanceof Error ? err.message : 'No se pudo actualizar tu contraseña.'
        );
      } finally {
        setChangingPassword(false);
      }
    };

    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center px-4 py-8 font-sans selection:bg-red-600 selection:text-white">
        <div className="w-full max-w-sm rounded-2xl bg-zinc-950 border border-white/15 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.9)] p-6 sm:p-8 space-y-6">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-white p-2 flex items-center justify-center shadow-[0_4px_20px_rgba(220,38,38,0.28)] border border-white/90">
              <img
                src="/codizulca-logo.png"
                alt="Logo CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                <Lock className="w-3 h-3" /> Cambio Obligatorio
              </span>
              <h1 className="text-xl font-extrabold tracking-tight text-white">
                Actualiza tu Contraseña
              </h1>
              <p className="text-xs text-zinc-400">
                Por seguridad, define una contraseña personal antes de ingresar a tu ruta.
              </p>
            </div>
          </div>

          <form onSubmit={handlePortalPasswordChangeSubmit} noValidate className="space-y-4">
            <div>
              <label
                htmlFor="portal-new-password"
                className="block text-xs font-bold text-zinc-200 mb-1.5"
              >
                Nueva contraseña (mín. {MIN_SUPABASE_PASSWORD_LENGTH} caracteres)
              </label>
              <div className="relative">
                <input
                  id="portal-new-password"
                  type={showNewPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  disabled={changingPassword}
                  value={newPasswordInput}
                  onChange={(e) => setNewPasswordInput(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-3.5 pr-11 py-3 rounded-xl bg-black border border-zinc-700 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/40 disabled:opacity-60 transition"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white transition cursor-pointer"
                  aria-label={showNewPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="portal-confirm-new-password"
                className="block text-xs font-bold text-zinc-200 mb-1.5"
              >
                Confirmar nueva contraseña
              </label>
              <input
                id="portal-confirm-new-password"
                type={showNewPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                disabled={changingPassword}
                value={confirmNewPasswordInput}
                onChange={(e) => setConfirmNewPasswordInput(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-3 rounded-xl bg-black border border-zinc-700 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/40 disabled:opacity-60 transition"
              />
            </div>

            {passwordChangeError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl bg-red-950/60 border border-red-500/40 px-3.5 py-2.5 text-xs text-red-200"
              >
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{passwordChangeError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={changingPassword}
              className="w-full py-3 px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-55 text-white font-extrabold text-sm flex items-center justify-center gap-2 transition cursor-pointer shadow-lg shadow-red-950/60"
            >
              {changingPassword ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Guardando contraseña...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Guardar y Continuar</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="w-full py-2.5 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Cerrar sesión</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  const activeDisplayName = shiftSessionState
    ? shiftSessionState.session.personal_nombre || 'Promotora en Jornada'
    : (profile?.displayName ?? 'Promotora');
  const activePortalSucursal: OperativeSucursal | null = shiftSessionState
    ? shiftSessionState.session.sucursal
    : isOperativeSucursal(profile?.sucursal)
      ? profile.sucursal
      : isSuperAdminMode
        ? isOperativeSucursal((incidenciaRutaTarget as { sucursal?: unknown } | null)?.sucursal)
          ? ((incidenciaRutaTarget as { sucursal?: OperativeSucursal }).sucursal ?? 'ZULIA')
          : supervisionSucursal !== 'TODAS'
            ? supervisionSucursal
            : 'ZULIA'
        : null;
  const effectiveLastSyncedAt = shiftSessionState ? shiftSyncedAt : lastSyncedAt;
  const effectiveIsRefreshing = shiftSessionState ? shiftRefreshing : isRefreshing;
  const effectiveIsLoading = shiftSessionState
    ? shiftRefreshing && shiftRoutes.length === 0
    : initialProfile
      ? false
      : isLoading;
  const handleManualRefresh = () => {
    if (shiftSessionState) {
      void hydrateShiftBootstrap(shiftSessionState.token);
    } else {
      void refreshRoutes();
    }
  };

  // 1b. Fail-closed: usuario regional autenticado sin región asignada -> 0 datos expuestos
  if (!shiftSessionState && profile && !hasAssignedRegionalScope(profile)) {
    return <UnassignedRegionGate profile={profile} onSignOut={handleSignOut} />;
  }

  const resolvedPortalContext: PortalPromotoraContext = (() => {
    if (portalContext) return portalContext;
    if (profile) return buildFallbackPromotoraContext(profile);
    const shiftSucursal = shiftSessionState?.session.sucursal === 'VALENCIA' ? 'VALENCIA' : 'ZULIA';
    const shiftRegion = shiftSucursal === 'VALENCIA' ? 'Valencia' : 'Occidente';
    return {
      promotoraId: shiftSessionState?.session.personal_id || 'shift-user',
      promotoraRefId: null,
      authUserId: shiftSessionState?.session.personal_id || 'shift-user',
      nombre: activeDisplayName,
      correo: '',
      telefono: '',
      direccion: shiftSessionState?.session.region_nombre || shiftRegion,
      categoria: 'Fijas',
      perfilAsistencia: 'FIJA',
      region: shiftRegion,
      sucursal: shiftSucursal,
      isManagerOrAdmin: false,
      isMerchandisingRole: false,
    };
  })();

  const portalNavTabs: Array<{
    id: PortalSubTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    isSpecial?: boolean;
  }> = [
    { id: 'ruta', label: 'Ruta', icon: RouteIcon },
    { id: 'asistencia', label: 'Asistencia', icon: CheckSquare },
    { id: 'encuestas', label: 'Encuestas', icon: ClipboardList },
    { id: 'precios', label: 'Precios', icon: Tag },
    { id: 'inventario', label: 'Inventario', icon: Package },
    ...(resolvedPortalContext.isMerchandisingRole || isSuperAdminMode
      ? [{ id: 'merchandising' as PortalSubTab, label: 'Merch.', icon: Layers, isSpecial: true }]
      : []),
  ];

  // 2. Vista Operativa Unificada Mobile-First (Paridad 100% con /portal/ruta de codizulca-dashboard-4)
  return (
    <div className="min-h-screen bg-[#000000] text-white flex flex-col font-sans selection:bg-red-600 selection:text-white">
      {/* Header Sticky Mobile-First */}
      <header className="sticky top-0 z-40 bg-[#0d0d0d]/95 backdrop-blur-xl border-b border-[#262626] px-3 py-2.5">
        <div className="max-w-[512px] mx-auto flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-white p-0.5 flex items-center justify-center shrink-0 border border-red-600/60">
              <img
                src="/codizulca-logo.png"
                alt="CODIZULCA"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="text-xs font-black tracking-tight text-white uppercase truncate">
                  Codizulca <span className="text-red-500">Campo</span>
                </h1>
                <span className="px-1.5 py-0.5 rounded bg-red-600/20 border border-red-500/40 text-red-400 text-[9px] font-black uppercase font-mono">
                  {resolvedPortalContext.isManagerOrAdmin
                    ? 'Coordinación'
                    : resolvedPortalContext.categoria}
                </span>
              </div>
              <p className="text-[10px] text-neutral-400 font-mono truncate flex items-center gap-1">
                {isOnline ? (
                  <Wifi className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                ) : (
                  <WifiOff className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                )}
                <span>{isOnline ? 'En línea' : 'Offline'}</span>
                <span>•</span>
                <span>{resolvedPortalContext.region}</span>
                <span>•</span>
                <span>{formatSyncTime(effectiveLastSyncedAt)}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <ControlRoomThemeToggle compact />
            <button
              type="button"
              data-testid="portal-nav-perfil"
              onClick={() => handleSelectPortalTab('perfil')}
              title="Mi Ficha de Promotora"
              className={`px-2 py-1 rounded-xl border text-[10px] font-bold flex items-center gap-1 cursor-pointer max-w-[115px] ${
                activePortalTab === 'perfil'
                  ? 'bg-red-600 border-red-500 text-white'
                  : 'bg-[#171717] border-neutral-800 text-neutral-200 hover:border-neutral-600'
              }`}
            >
              <UserCheck className="w-3 h-3 text-red-400 shrink-0" />
              <span className="truncate">{activeDisplayName.split(' ')[0]}</span>
            </button>
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={effectiveIsRefreshing}
              title="Sincronizar datos desde Supabase"
              className="p-1.5 rounded-xl bg-[#171717] hover:bg-neutral-800 border border-neutral-800 text-neutral-300 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${effectiveIsRefreshing ? 'animate-spin text-red-400' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              title={shiftSessionState ? 'Cerrar jornada y purgar datos locales' : 'Cerrar sesión'}
              className="p-1.5 rounded-xl bg-[#171717] hover:bg-red-950/60 border border-neutral-800 hover:border-red-700 text-neutral-300 hover:text-red-300 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Banner de Perfil / Acceso rápido */}
      <div className="bg-[#121212] border-b border-neutral-900 px-3 py-1.5">
        <div className="max-w-[512px] mx-auto flex items-center justify-between gap-2 text-[10px]">
          <span className="text-neutral-400 truncate">
            <strong className="text-white">{resolvedPortalContext.nombre}</strong> ·{' '}
            {resolvedPortalContext.perfilAsistencia === 'EVENTUAL' ? 'Eventual (4 fotos)' : 'Fija (2 fotos)'}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {(isSuperAdminMode || resolvedPortalContext.isManagerOrAdmin) && (
              <a
                href="/promotoras"
                className="px-2 py-0.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[10px] font-black transition-colors"
              >
                Panel Trade ↗
              </a>
            )}
            <button
              type="button"
              onClick={() => handleSelectPortalTab('perfil')}
              className="px-2 py-0.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white text-[10px] font-bold cursor-pointer"
            >
              Mi Ficha
            </button>
          </div>
        </div>
      </div>

      {/* Barra de Pestañas Adaptativa (5 o 6 módulos) */}
      <nav
        aria-label="Navegación App de Promotoras"
        className="sticky top-[53px] z-30 bg-[#0d0d0d] border-b border-[#262626] px-1.5 py-1.5 shadow-md"
      >
        <div
          className={`max-w-[512px] mx-auto grid ${
            portalNavTabs.length === 6 ? 'grid-cols-6' : 'grid-cols-5'
          } gap-0.5 sm:gap-1`}
        >
          {portalNavTabs.map((tab) => {
            const isActive = activePortalTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`portal-tab-${tab.id}`}
                onClick={() => handleSelectPortalTab(tab.id)}
                className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl text-center transition-all duration-200 cursor-pointer ${
                  isActive
                    ? tab.isSpecial
                      ? 'bg-gradient-to-b from-red-600 to-rose-700 text-white font-black shadow-lg shadow-red-600/30'
                      : 'bg-red-600 text-white font-black shadow-md shadow-red-600/25'
                    : 'text-neutral-400 hover:text-white hover:bg-neutral-900/60'
                }`}
              >
                <tab.icon className="w-4 h-4 mb-0.5" />
                <span className="text-[10px] font-bold tracking-tight leading-none truncate max-w-full">
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Contenedor Principal Mobile-First (512px) */}
      <main className="flex-1 w-full max-w-[512px] mx-auto p-3 sm:p-4 space-y-3.5">
        <OfflineSyncBanner
          visualState={offlineSync.visualState}
          pendingCount={offlineSync.pendingCount}
          isSyncing={offlineSync.isSyncing}
          isOnline={offlineSync.isOnline}
          lastError={offlineSync.lastError}
          cachedClientsCount={geofenceCatalog.length}
          cachedProductsCount={cachedProductsCount}
          shiftLabel={
            shiftSessionState
              ? `${shiftSessionState.session.region_nombre} · Ruta ${shiftSessionState.session.ruta_codigo}`
              : null
          }
          shiftExpiresAtIso={shiftSessionState?.session.expires_at ?? null}
          onRetryNow={() => void flushOfflineQueue(true)}
          onCloseShiftPurge={
            shiftSessionState
              ? () =>
                  void offlineSync.purgeAndCloseShift(
                    'Jornada cerrada manualmente. Se purgaron todos los datos locales de IndexedDB.'
                  )
              : undefined
          }
        />

        {liveBanner && (
          <div className="rounded-xl bg-[#121215] border border-emerald-500/50 px-3.5 py-2 text-xs text-emerald-100 font-semibold flex items-center justify-between gap-2">
            <span>{liveBanner}</span>
            <button
              type="button"
              onClick={() => setLiveBanner(null)}
              className="text-emerald-300 hover:text-white text-[11px] font-mono font-bold cursor-pointer"
            >
              OK
            </button>
          </div>
        )}

        {(routeFetchError || actionError) && (
          <div className="rounded-xl bg-red-950/50 border border-red-500/40 px-3.5 py-2.5 text-xs text-red-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{actionError || routeFetchError}</span>
            </div>
            <button
              type="button"
              onClick={() => void refreshRoutes()}
              className="px-2.5 py-1 rounded-lg bg-red-600 text-white font-bold text-[11px] shrink-0 cursor-pointer"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Controles de Modo Supervisión Global (preservados íntegros para Super Admin & QA) */}
        {isSuperAdminMode && (
          <section
            data-testid="portal-super-admin-banner"
            aria-label="Controles de Modo Supervisión Global"
            className="rounded-2xl bg-[#121215] border border-red-600/50 p-3.5 space-y-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#DC2626] text-white text-[10px] font-mono font-black uppercase tracking-wider">
                <ShieldCheck className="w-3 h-3" />
                Modo Supervisión Global · Super Admin
              </span>
              <a
                href="/promotoras"
                className="text-[11px] font-bold text-red-400 hover:text-red-300 underline underline-offset-2"
              >
                Volver al Dashboard
              </a>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block text-[10px] font-bold text-zinc-300">
                Sucursal / Sede
                <select
                  data-testid="portal-supervision-sucursal-select"
                  value={supervisionSucursal}
                  onChange={(e) =>
                    setSupervisionSucursal(e.target.value as 'TODAS' | OperativeSucursal)
                  }
                  className="mt-1 w-full px-2.5 py-1.5 rounded-xl bg-black border border-white/15 text-xs text-white font-semibold focus:outline-none focus:border-red-500 cursor-pointer"
                >
                  <option value="TODAS">Todas las Sedes (Nacional)</option>
                  {OPERATIVE_SUCURSALES.map((hub) => (
                    <option key={hub} value={hub}>
                      {SUCURSAL_LABELS[hub]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[10px] font-bold text-zinc-300">
                Promotora asignada
                <select
                  data-testid="portal-supervision-promotora-select"
                  value={supervisionPromotora}
                  onChange={(e) => setSupervisionPromotora(e.target.value)}
                  className="mt-1 w-full px-2.5 py-1.5 rounded-xl bg-black border border-white/15 text-xs text-white font-semibold focus:outline-none focus:border-red-500 cursor-pointer"
                >
                  <option value="TODAS">
                    Todas las Promotoras ({supervisionPromotorasOptions.length})
                  </option>
                  {supervisionPromotorasOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        )}

        {/* Renderizado del Módulo Activo */}
        {activePortalTab === 'ruta' && (
          <div className="space-y-3">
            {/* Filtro de horizonte + Reporte rápido de incidencia */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="inline-flex rounded-xl bg-[#0d0d0d] border border-neutral-800 p-0.5 gap-0.5">
                {(isSuperAdminMode
                  ? ([
                      { id: 'todas', label: 'Todas' },
                      { id: 'proximas', label: 'Próximas' },
                      { id: 'hoy', label: 'Solo Hoy' },
                    ] as const)
                  : ([
                      { id: 'proximas', label: 'Hoy y Próximas' },
                      { id: 'hoy', label: 'Solo Hoy' },
                    ] as const)
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setDateFilter(tab.id)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                      dateFilter === tab.id
                        ? 'bg-red-600 text-white'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                data-testid="btn-open-incidencia-general"
                onClick={() => openIncidenciaModalForRuta(null)}
                className="px-2.5 py-1 rounded-xl bg-[#171717] hover:bg-red-950/70 border border-red-500/45 text-white text-[11px] font-extrabold inline-flex items-center gap-1 cursor-pointer"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-red-500" />
                <span>Incidencia</span>
              </button>
            </div>

            <PortalRutaTab
              context={resolvedPortalContext}
              routes={filteredRoutes}
              isLoading={effectiveIsLoading}
              isRefreshing={effectiveIsRefreshing}
              isSuperAdminMode={isSuperAdminMode}
              onRefresh={handleManualRefresh}
              onRouteUpdated={(updated) => {
                if (shiftSessionState) {
                  setShiftRoutes((prev) =>
                    prev.map((r) => (r.id === updated.id ? updated : r))
                  );
                } else {
                  applyOptimisticRouteUpdate(updated);
                }
              }}
              onStartRouteStep={(ruta) => void handleRouteStep(ruta, 'CHECKIN')}
              onCompleteRouteStep={(ruta) => void handleRouteStep(ruta, 'CHECKOUT')}
              onOpenIncidencia={(ruta) => openIncidenciaModalForRuta(ruta)}
              onJumpToModule={handleJumpToModule}
              onNotify={showBanner}
            />
          </div>
        )}

        {activePortalTab === 'asistencia' && (
          <PortalAsistenciaTab
            context={resolvedPortalContext}
            clients={portalClients}
            activeStore={activeStore}
            onActiveStoreChange={setActiveStore}
            onNotify={showBanner}
          />
        )}

        {activePortalTab === 'inventario' && (
          <PortalInventarioTab
            context={resolvedPortalContext}
            clients={portalClients}
            products={portalProducts}
            activeStore={activeStore}
            onActiveStoreChange={setActiveStore}
            onNotify={showBanner}
          />
        )}

        {activePortalTab === 'encuestas' && (
          <PortalEncuestasTab
            context={resolvedPortalContext}
            clients={portalClients}
            products={portalProducts}
            activeStore={activeStore}
            onActiveStoreChange={setActiveStore}
            onNotify={showBanner}
          />
        )}

        {activePortalTab === 'precios' && (
          <PortalPreciosTab
            context={resolvedPortalContext}
            clients={portalClients}
            products={portalProducts}
            activeStore={activeStore}
            onActiveStoreChange={setActiveStore}
            onNotify={showBanner}
          />
        )}

        {activePortalTab === 'merchandising' && (
          <PortalMerchandisingTab
            context={resolvedPortalContext}
            clients={portalClients}
            activeStore={activeStore}
            onActiveStoreChange={setActiveStore}
            onNotify={showBanner}
          />
        )}

        {activePortalTab === 'perfil' && (
          <PortalPerfilTab
            context={resolvedPortalContext}
            routes={filteredRoutes}
            onGoToRuta={() => handleSelectPortalTab('ruta')}
            onSignOut={() => void handleSignOut()}
          />
        )}
      </main>

      {executionTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-3"
          role="dialog"
          aria-modal="true"
          aria-label="Formulario de ejecución en punto de venta"
        >
          <form
            onSubmit={handleSubmitExecution}
            noValidate
            className="w-full max-w-lg rounded-2xl bg-zinc-950 border border-white/15 p-5 space-y-3 max-h-[92vh] overflow-y-auto"
          >
            <h2 className="text-base font-extrabold text-white">
              Ejecución en PDV · {executionTarget.cliente_nombre}
            </h2>
            <p className="text-[11px] text-zinc-400">
              Completa el reporte antes de finalizar. Se registrará tu ubicación GPS y la distancia al PDV.
            </p>

            <label className="block text-xs font-bold text-zinc-200">
              Lote del producto
              <input
                value={execForm.lote}
                maxLength={60}
                onChange={(e) => setExecForm((p) => ({ ...p, lote: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
              />
            </label>
            <label className="block text-xs font-bold text-zinc-200">
              Fecha de vencimiento
              <input
                type="date"
                value={execForm.vencimiento}
                onChange={(e) => setExecForm((p) => ({ ...p, vencimiento: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['abiertas', 'Unid. abiertas'],
                  ['muestras', 'Muestras'],
                  ['ventas', 'Ventas asist.'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="block text-[11px] font-bold text-zinc-200">
                  {label}
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={execForm[key]}
                    onChange={(e) => setExecForm((p) => ({ ...p, [key]: e.target.value }))}
                    className="mt-1 w-full px-2 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
                  />
                </label>
              ))}
            </div>
            <label className="block text-xs font-bold text-zinc-200">
              Observaciones
              <textarea
                rows={2}
                maxLength={500}
                value={execForm.observaciones}
                onChange={(e) => setExecForm((p) => ({ ...p, observaciones: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
              />
            </label>
            <label className="block text-xs font-bold text-zinc-200">
              Justificación si estás fuera de la geocerca (opcional)
              <input
                value={execForm.motivoFuera}
                maxLength={200}
                onChange={(e) => setExecForm((p) => ({ ...p, motivoFuera: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
              />
            </label>

            {execError && (
              <div role="alert" className="rounded-xl bg-red-950/60 border border-red-500/45 px-3 py-2 text-xs text-red-100">
                {execError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setExecutionTarget(null)}
                className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs font-bold text-zinc-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={processingRutaId === executionTarget.id}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-extrabold cursor-pointer"
              >
                {processingRutaId === executionTarget.id ? 'Enviando...' : 'Finalizar y enviar'}
              </button>
            </div>
          </form>
        </div>
      )}

      <IncidenciaQuickModal
        isOpen={incidenciaModalOpen}
        onClose={() => {
          setIncidenciaModalOpen(false);
          setIncidenciaRutaTarget(null);
        }}
        defaultPdvNombre={incidenciaRutaTarget?.cliente_nombre || ''}
        defaultClienteId={
          incidenciaRutaTarget
            ? (matchRutaPdvGeofence(incidenciaRutaTarget, geofenceCatalog)?.id ?? null)
            : null
        }
        defaultRutaId={incidenciaRutaTarget?.id ?? null}
        pdvOptions={activeRoutesList.map((r) => ({
          id: matchRutaPdvGeofence(r, geofenceCatalog)?.id ?? null,
          nombre: r.cliente_nombre,
        }))}
        sucursal={activePortalSucursal}
        reportadoPorNombre={activeDisplayName}
        shiftToken={shiftSessionState?.token ?? null}
        onSuccess={(res) => {
          showBanner(res.message);
          void refreshPending();
        }}
      />
    </div>
  );
};
