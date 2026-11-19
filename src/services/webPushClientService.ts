import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import { registerTradeServiceWorker } from '../lib/registerTradeSw';

export type WebPushClientStatus =
  | 'unsupported'
  | 'unconfigured'
  | 'prompt'
  | 'subscribed'
  | 'denied';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function getBearerToken(): Promise<string> {
  if (!isSupabaseConfigured) throw new Error('Supabase no configurado.');
  const { data } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token?.trim() || '';
  if (!token) throw new Error('Inicia sesión para activar notificaciones Web Push.');
  return token;
}

export async function getWebPushClientState(): Promise<{
  status: WebPushClientStatus;
  publicKey: string | null;
}> {
  if (
    typeof window === 'undefined' ||
    typeof Notification === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return { status: 'unsupported', publicKey: null };
  }

  if (Notification.permission === 'denied') {
    return { status: 'denied', publicKey: null };
  }

  try {
    const res = await fetch('/api/notifications/web-push/public-key');
    const data = (await res.json().catch(() => ({}))) as {
      configured?: boolean;
      publicKey?: string | null;
    };
    if (!res.ok || !data.configured || !data.publicKey) {
      return { status: 'unconfigured', publicKey: null };
    }

    const reg = await registerTradeServiceWorker();
    const existing = await reg?.pushManager.getSubscription();
    return {
      status: existing ? 'subscribed' : 'prompt',
      publicKey: data.publicKey,
    };
  } catch {
    return { status: 'unconfigured', publicKey: null };
  }
}

export async function subscribeBrowserToWebPush(): Promise<void> {
  const state = await getWebPushClientState();
  if (state.status === 'unsupported') {
    throw new Error('Este navegador no soporta notificaciones Web Push.');
  }
  if (state.status === 'unconfigured' || !state.publicKey) {
    throw new Error('Las llaves VAPID aún no están configuradas en el servidor.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Permiso de notificaciones bloqueado en el navegador.');
  }

  const reg = await registerTradeServiceWorker();
  if (!reg) {
    throw new Error('No se pudo registrar el Service Worker de notificaciones.');
  }

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.publicKey),
    });
  }

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Suscripción Web Push incompleta devuelta por el navegador.');
  }

  const token = await getBearerToken();
  const res = await fetch('/api/notifications/web-push/subscribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
    }),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error || 'No se pudo registrar la suscripción Web Push.');
  }
}

export async function unsubscribeBrowserFromWebPush(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;

  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);

  try {
    const token = await getBearerToken();
    await fetch('/api/notifications/web-push/subscribe', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    /* limpieza remota opcional si cerró sesión */
  }
}
