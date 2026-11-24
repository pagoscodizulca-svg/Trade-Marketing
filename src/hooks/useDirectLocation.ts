import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DirectLocationFix,
  type FallbackLocationRequestContext,
  type LocationDiagnosticCode,
  FRESH_LOCATION_CACHE_TTL_MS,
  getCachedFreshLocationFix,
  resolveDirectLocationCascade,
} from '../utils/directLocationEngine';

export interface UseDirectLocationOptions extends FallbackLocationRequestContext {
  enabled?: boolean;
  autoPrewarm?: boolean;
}

export interface UseDirectLocationResult {
  location: DirectLocationFix | null;
  isCapturing: boolean;
  diagnosticCode: LocationDiagnosticCode;
  permissionDeniedHint: boolean;
  errorMessage: string | null;
  triggerDirectCapture: (options?: {
    forceFresh?: boolean;
    preferWarmCache?: boolean;
  }) => Promise<DirectLocationFix | null>;
  setManualFallbackLocation: (fix: DirectLocationFix) => void;
}

/**
 * Hook de ubicación directa en cascada (3 capas) con soporte iOS Safari / Android Chrome:
 * - Usa caché compartida en memoria (< 60s) para asignación instantánea al formulario.
 * - Pre-calienta al entrar al módulo y permite disparo síncrono desde gestos naturales
 *   (`INGRESO JORNADA`, `SALIDA JORNADA`, apertura de cámara).
 * - Auto-recupera GPS al volver desde Ajustes (`visibilitychange`, `focus` y
 *   `navigator.permissions.query` protegido con try/catch para Safari iOS).
 * - Aborta cualquier `watchPosition` activo al desmontar para cero drenaje de batería.
 */
export function useDirectLocation(options: UseDirectLocationOptions): UseDirectLocationResult {
  const { pdvNombre, clienteId, region, sucursal, enabled = true, autoPrewarm = true } = options;

  const [location, setLocation] = useState<DirectLocationFix | null>(() =>
    getCachedFreshLocationFix(FRESH_LOCATION_CACHE_TTL_MS)
  );
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [diagnosticCode, setDiagnosticCode] = useState<LocationDiagnosticCode>('NONE');
  const [permissionDeniedHint, setPermissionDeniedHint] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mountedRef = useRef<boolean>(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const latestLocationRef = useRef<DirectLocationFix | null>(location);
  latestLocationRef.current = location;

  const fallbackCtxRef = useRef<FallbackLocationRequestContext>({
    pdvNombre,
    clienteId,
    region,
    sucursal,
  });
  fallbackCtxRef.current = { pdvNombre, clienteId, region, sucursal };

  const triggerDirectCapture = useCallback(
    async (opts?: {
      forceFresh?: boolean;
      preferWarmCache?: boolean;
    }): Promise<DirectLocationFix | null> => {
      if (!enabled) return latestLocationRef.current;

      // Si ya tenemos un fix real fresco (< 60s) y no se pide recarga forzada, devolvemos al instante
      if (!opts?.forceFresh) {
        const cached = getCachedFreshLocationFix(FRESH_LOCATION_CACHE_TTL_MS);
        if (cached) {
          if (mountedRef.current) {
            setLocation(cached);
            setDiagnosticCode('NONE');
            setPermissionDeniedHint(false);
            setErrorMessage(null);
            setIsCapturing(false);
          }
          return cached;
        }
      }

      if (inFlightRef.current && !opts?.forceFresh) {
        return latestLocationRef.current;
      }

      // Cancelar cualquier intento anterior / watchPosition huérfano antes de iniciar uno nuevo
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      inFlightRef.current = true;

      if (mountedRef.current) {
        setIsCapturing(true);
        setErrorMessage(null);
      }

      try {
        const outcome = await resolveDirectLocationCascade({
          forceFresh: opts?.forceFresh,
          preferWarmCache: opts?.preferWarmCache,
          fallbackContext: fallbackCtxRef.current,
          enableServerFallback: true,
          signal: controller.signal,
        });

        if (!mountedRef.current || controller.signal.aborted) {
          return latestLocationRef.current;
        }

        if (outcome.ok) {
          setLocation(outcome.fix);
          setDiagnosticCode(outcome.diagnosticCode);
          setPermissionDeniedHint(outcome.permissionDeniedHint);
          setErrorMessage(null);
          return outcome.fix;
        }

        setDiagnosticCode(outcome.diagnosticCode);
        setPermissionDeniedHint(outcome.permissionDeniedHint);
        setErrorMessage(outcome.errorMessage);
        return null;
      } finally {
        if (abortControllerRef.current === controller) {
          inFlightRef.current = false;
          if (mountedRef.current) {
            setIsCapturing(false);
          }
        }
      }
    },
    [enabled]
  );

  const setManualFallbackLocation = useCallback((fix: DirectLocationFix) => {
    setLocation(fix);
    setDiagnosticCode('NONE');
    setPermissionDeniedHint(false);
    setErrorMessage(null);
  }, []);

  // 1. Pre-calentamiento al entrar al módulo + limpieza garantizada al desmontar
  useEffect(() => {
    mountedRef.current = true;
    if (enabled && autoPrewarm) {
      void triggerDirectCapture({ preferWarmCache: true });
    }
    return () => {
      mountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      inFlightRef.current = false;
    };
  }, [enabled, autoPrewarm, triggerDirectCapture]);

  // 2. Si cambia el PDV activo y seguimos en respaldo ip_fallback, refrescar el respaldo al PDV correcto
  useEffect(() => {
    if (!enabled || !pdvNombre) return;
    if (latestLocationRef.current?.locationSource === 'ip_fallback') {
      void triggerDirectCapture({ forceFresh: true });
    }
  }, [enabled, pdvNombre, clienteId, triggerDirectCapture]);

  // 3. Auto-recuperación instantánea al volver desde Ajustes (visibilitychange, focus, permissions.query)
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') return;

    const shouldAutoUpgrade = () => {
      const current = latestLocationRef.current;
      if (!current) return true;
      if (current.locationSource === 'ip_fallback') return true;
      return Date.now() - current.capturedAtMs > FRESH_LOCATION_CACHE_TTL_MS;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && shouldAutoUpgrade()) {
        void triggerDirectCapture({ forceFresh: true });
      }
    };

    const handleWindowFocus = () => {
      if (shouldAutoUpgrade()) {
        void triggerDirectCapture({ forceFresh: true });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    // Permissions API protegida con try/catch (Safari iOS < 16 puede lanzar TypeError)
    let permissionStatus: PermissionStatus | null = null;
    const handlePermissionChange = () => {
      if (permissionStatus?.state === 'granted') {
        void triggerDirectCapture({ forceFresh: true });
      }
    };

    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.permissions &&
        typeof navigator.permissions.query === 'function'
      ) {
        void navigator.permissions
          .query({ name: 'geolocation' as PermissionName })
          .then((status) => {
            if (!mountedRef.current) return;
            permissionStatus = status;
            if (typeof status.addEventListener === 'function') {
              status.addEventListener('change', handlePermissionChange);
            } else {
              status.onchange = handlePermissionChange;
            }
          })
          .catch(() => {
            // Safari iOS puede rechazar el query sin afectar la captura directa
          });
      }
    } catch {
      // Silencioso en WebKit sin soporte de Permissions API
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      if (permissionStatus) {
        if (typeof permissionStatus.removeEventListener === 'function') {
          permissionStatus.removeEventListener('change', handlePermissionChange);
        } else if (permissionStatus.onchange === handlePermissionChange) {
          permissionStatus.onchange = null;
        }
      }
    };
  }, [enabled, triggerDirectCapture]);

  return {
    location,
    isCapturing,
    diagnosticCode,
    permissionDeniedHint,
    errorMessage,
    triggerDirectCapture,
    setManualFallbackLocation,
  };
}
