/**
 * Registro del Service Worker (solo en producción: en desarrollo no se cachea nada para no estorbar al programar).
 * La nueva versión NO se activa sola: se avisa al usuario y se aplica cuando él lo decide (no recargar a mitad de una entrega).
 */
export const EVENTO_ACTUALIZACION_SW = 'rd:sw-update';

let actualizacionSolicitada = false;

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  // Recarga SOLO cuando el usuario aceptó actualizar (la primera instalación también dispara controllerchange).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (actualizacionSolicitada) window.location.reload();
  });

  const registrar = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        const avisar = () => window.dispatchEvent(new CustomEvent(EVENTO_ACTUALIZACION_SW, { detail: reg }));
        if (reg.waiting && navigator.serviceWorker.controller) avisar();
        reg.addEventListener('updatefound', () => {
          const nuevo = reg.installing;
          nuevo?.addEventListener('statechange', () => {
            if (nuevo.state === 'installed' && navigator.serviceWorker.controller) avisar();
          });
        });
        // Busca versiones nuevas cada 30 min y al volver a la app.
        window.setInterval(() => void reg.update().catch(() => undefined), 30 * 60_000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
        });
      })
      .catch((err) => console.warn('[RutaDegustación] No se pudo registrar el Service Worker:', err));
  };

  if (document.readyState === 'complete') registrar();
  else window.addEventListener('load', registrar, { once: true });
}

/** Activa la versión nueva del Service Worker y recarga la página. */
export function aplicarActualizacion(reg: ServiceWorkerRegistration): void {
  actualizacionSolicitada = true;
  reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
}
