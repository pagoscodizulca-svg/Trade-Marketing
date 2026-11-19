/**
 * Registro del Service Worker PWA + Web Push de la app principal (`/` y `/portal`).
 * Se registra únicamente en producción o cuando el host soporta Service Workers con HTTPS/localhost.
 */

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

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

  swRegistrationPromise = navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void reg.update().catch(() => undefined);
        }
      });
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
