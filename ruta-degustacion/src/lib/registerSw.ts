/**
 * Registro del Service Worker (solo en producción: en desarrollo no se cachea nada para no estorbar al programar).
 *
 * Política de actualización automática sin pérdida de datos:
 *  - Usa `updateViaCache: 'none'` para evitar que el navegador sirva un `sw.js` viejo de caché HTTP.
 *  - Si el chofer NO está escribiendo en un formulario, la nueva versión se activa y recarga sola.
 *  - Si está llenando una entrega, avisa con `UpdateToast` para que decida cuándo aplicarla (o se aplica al salir).
 */

import {
  EVENTO_ACTUALIZACION_SW,
  isRutaUserEditingForm,
  performCleanRutaReload,
} from './appVersionGuard';

export { EVENTO_ACTUALIZACION_SW };

let actualizacionSolicitada = false;

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const hadControllerBeforeRegister = Boolean(navigator.serviceWorker.controller);

  // Recarga cuando el SW cambia tras una actualización solicitada o automática (no en primera instalación).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadControllerBeforeRegister) return;
    if (actualizacionSolicitada || !isRutaUserEditingForm()) {
      window.location.reload();
    }
  });

  const registrar = () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
        updateViaCache: 'none',
      })
      .then((reg) => {
        const manejarVersionLista = () => {
          if (!isRutaUserEditingForm()) {
            aplicarActualizacion(reg);
            return;
          }
          window.dispatchEvent(new CustomEvent(EVENTO_ACTUALIZACION_SW, { detail: reg }));
        };

        if (reg.waiting && navigator.serviceWorker.controller) manejarVersionLista();
        reg.addEventListener('updatefound', () => {
          const nuevo = reg.installing;
          nuevo?.addEventListener('statechange', () => {
            if (nuevo.state === 'installed' && navigator.serviceWorker.controller) {
              manejarVersionLista();
            }
          });
        });

        const buscarActualizacion = () => {
          if (navigator.onLine !== false) {
            void reg.update().catch(() => undefined);
          }
        };

        // Busca versiones nuevas cada 5 min, al volver a la app y al recuperar conexión.
        window.setInterval(() => {
          if (document.visibilityState === 'visible') buscarActualizacion();
        }, 5 * 60_000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') buscarActualizacion();
        });
        window.addEventListener('online', buscarActualizacion);
      })
      .catch((err) => console.warn('[RutaDegustación] No se pudo registrar el Service Worker:', err));
  };

  if (document.readyState === 'complete') registrar();
  else window.addEventListener('load', registrar, { once: true });
}

/** Activa la versión nueva del Service Worker (o limpia cachés estáticas) y recarga la página. */
export function aplicarActualizacion(reg?: ServiceWorkerRegistration | null): void {
  actualizacionSolicitada = true;
  if (reg?.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  void performCleanRutaReload({
    signature: `ruta-manual:${Date.now()}`,
    manual: true,
  });
}
