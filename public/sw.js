/* eslint-disable no-restricted-globals */
/**
 * Service Worker PWA Offline-First + Web Push (VAPID) — CODIZULCA C.A. Trade Marketing (`/` y `/portal`)
 *
 * Reglas de seguridad y privacidad:
 *  1. Precachea ÚNICAMENTE el App Shell público estático (HTML, assets inmutables, íconos y manifest).
 *  2. NUNCA cachea `/api/*`, `*.supabase.co`, ni respuestas con datos de negocio o credenciales:
 *     toda copia offline operativa reside exclusivamente en IndexedDB para garantizar purga determinista
 *     al expirar o revocarse una jornada.
 *  3. Responde al mensaje `PURGE_PRIVATE_CACHES` limpiando cachés dinámicas cuando se cierra o expira un enlace.
 *  4. Recibe notificaciones Web Push (VAPID) para nuevas degustaciones creadas desde FDV.
 */

const SHELL_CACHE = 'codizulca-trade-shell-v334';
const SHELL_URLS = [
  '/',
  '/portal',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/codizulca-logo.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('codizulca-trade-') && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (type === 'PURGE_PRIVATE_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && !k.startsWith('rutadegustacion-fuentes'))
            .map((k) => caches.delete(k))
        )
      )
    );
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Nunca interceptar llamadas API, Supabase, WebSockets ni el sub-PWA /logistica (tiene su propio SW)
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/logistica') ||
    url.pathname.endsWith('/sw.js')
  ) {
    return;
  }

  // Navegación SPA (Network-First con fallback offline seguro para iOS Safari y Android)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic' && !res.redirected && !url.searchParams.has('t')) {
            const clone = res.clone();
            const cacheKey = url.pathname === '/portal' ? '/portal' : '/';
            caches.open(SHELL_CACHE).then((cache) => cache.put(cacheKey, clone)).catch(() => undefined);
          }
          return res;
        })
        .catch(async () => {
          const fallback =
            (await caches.match(url.pathname === '/portal' ? '/portal' : '/')) ||
            (await caches.match('/'));
          return fallback || Response.error();
        })
    );
    return;
  }

  // Assets inmutables de Vite (`/assets/*`) e íconos: Cache-First con llenado progresivo
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/codizulca-logo.png' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, clone)).catch(() => undefined);
          }
          return res;
        });
      })
    );
  }
});

// Notificaciones Web Push (VAPID) de nuevas degustaciones FDV -> Trade Marketing
self.addEventListener('push', (event) => {
  let data = {
    title: 'CODIZULCA · Nueva Degustación FDV',
    body: 'Se recibió una nueva solicitud de degustación en Trade Marketing.',
    url: '/promotoras',
    tag: 'codizulca-degustacion-fdv',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        data = {
          title: typeof parsed.title === 'string' && parsed.title ? parsed.title : data.title,
          body: typeof parsed.body === 'string' && parsed.body ? parsed.body : data.body,
          url: typeof parsed.url === 'string' && parsed.url.startsWith('/') ? parsed.url : data.url,
          tag: typeof parsed.tag === 'string' && parsed.tag ? parsed.tag : data.tag,
        };
      }
    } catch {
      const text = event.data.text();
      if (text) data.body = text.slice(0, 240);
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag,
      renotify: true,
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl =
    (event.notification && event.notification.data && event.notification.data.url) || '/promotoras';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client && client.url.startsWith(self.location.origin)) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
