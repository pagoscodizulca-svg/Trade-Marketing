/**
 * Registro del Service Worker PWA + Web Push de la app principal (`/` y `/portal`).
 *
 * Blindaje anti-caché obsoleta:
 *  - `updateViaCache: 'none'` impide que el navegador sirva un `sw.js` desde caché HTTP.
 *  - Activa inmediatamente cualquier SW en espera (`SKIP_WAITING`).
 *  - Al cambiar el controlador (`controllerchange`) después de un despliegue real,
 *    recarga limpiamente la aplicación (o avisa si el usuario está escribiendo en un campo).
 */

import {
  DEFAULT_TRADE_CACHE_PREFIXES,
  DEFAULT_VERSION_POLL_INTERVAL_MS,
  getCurrentBuildId,
  isUserActivelyEditingForm,
  notifyDeferredAppUpdate,
  performCleanVersionReload,
} from './appVersionGuard';

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let controllerChangeListenerBound = false;

export function registerTradeServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  const isSecureContext =
    window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';
  if (!isSecureContext) {
    return Promise.resolve(null);
  }

  if (swRegistrationPromise) return swRegistrationPromise;

  const hadControllerBeforeRegister = Boolean(navigator.serviceWorker.controller);

  if (!controllerChangeListenerBound) {
    controllerChangeListenerBound = true;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadControllerBeforeRegister) return;
      const signature = `sw-controllerchange:${getCurrentBuildId() || 'runtime'}`;
      if (isUserActivelyEditingForm()) {
        notifyDeferredAppUpdate({
          buildId: getCurrentBuildId() || 'nueva-version',
          reason: 'sw-controllerchange',
        });
        return;
      }
      void performCleanVersionReload({
        reason: 'sw-controllerchange',
        targetSignature: signature,
        cachePrefixes: DEFAULT_TRADE_CACHE_PREFIXES,
        swScope: '/',
      });
    });
  }

  swRegistrationPromise = navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((reg) => {
      const activateWaiting = (worker: ServiceWorker | null | undefined) => {
        if (worker) {
          worker.postMessage({ type: 'SKIP_WAITING' });
        }
      };

      if (reg.waiting) {
        activateWaiting(reg.waiting);
      }

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            activateWaiting(installing);
          }
        });
      });

      const triggerUpdate = () => {
        if (navigator.onLine !== false) {
          void reg.update().catch(() => undefined);
        }
      };

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          triggerUpdate();
        }
      });
      window.addEventListener('online', triggerUpdate);
      window.setInterval(() => {
        if (document.visibilityState === 'visible') {
          triggerUpdate();
        }
      }, DEFAULT_VERSION_POLL_INTERVAL_MS);

      return reg;
    })
    .catch(() => null);

  return swRegistrationPromise;
}

export async function requestSwPurgePrivateCaches(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    reg?.active?.postMessage({ type: 'PURGE_PRIVATE_CACHES' });
  } catch {
    /* ignorar si SW no está activo */
  }
}
