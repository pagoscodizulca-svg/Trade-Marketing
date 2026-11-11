/// Service Worker de RutaDegustación (estrategia injectManifest de vite-plugin-pwa).
//
// - Precachea el App Shell (HTML, JS, CSS, íconos) para que la app abra completa sin cobertura.
// - NUNCA cachea Supabase ni peticiones de datos: siempre red (la copia offline vive en IndexedDB).
// - Background Sync: el evento `sync` con la etiqueta 'sync-deliveries-outbox' vacía la cola aunque la página esté cerrada.
//
// Se tipa de forma mínima (sin la librería "webworker") para no chocar con los tipos DOM del resto del proyecto.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { flushOutbox } from './lib/syncCore';
import { countOutbox } from './lib/offlineDb';

interface SwEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface SwSyncEvent extends SwEvent {
  tag: string;
  lastChance?: boolean;
}
interface SwMessageEvent extends SwEvent {
  data?: { type?: string };
}
interface SwScope {
  __WB_MANIFEST: Array<string | { url: string; revision?: string | null }>;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: string, listener: (event: never) => void): void;
}

declare const self: SwScope;

const BACKGROUND_SYNC_TAG = 'sync-deliveries-outbox';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// App de una sola página: cualquier navegación sin red se resuelve con el index.html precacheado.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

// Fuentes de Google (hoja CSS y archivos): se guardan al verlas por primera vez y se sirven offline.
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'rutadegustacion-fuentes',
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

// La nueva versión se activa solo cuando la app lo pide (no se recarga a mitad de una entrega).
self.addEventListener('message', (event: SwMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
self.addEventListener('activate', (event: SwEvent) => {
  event.waitUntil(self.clients.claim());
});

// Background Sync: vacía la cola de salida aunque la página esté cerrada.
self.addEventListener('sync', (event: SwSyncEvent) => {
  if (event.tag !== BACKGROUND_SYNC_TAG) return;
  event.waitUntil(
    (async () => {
      const res = await flushOutbox({ timeoutMs: 20_000, force: true });
      // Si quedaron operaciones por un fallo recuperable, se lanza un error para que el navegador reprograme el sync.
      if (res.remaining > 0 && (res.status === 'offline' || res.status === 'error' || (await countOutbox()) > 0)) {
        throw new Error(`Cola pendiente (${res.remaining}): ${res.lastError ?? res.status}`);
      }
    })(),
  );
});
