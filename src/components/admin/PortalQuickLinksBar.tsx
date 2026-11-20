import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Copy, Smartphone, Truck } from 'lucide-react';

export const INTERNAL_ROUTES = {
  promotoras: '/portal',
  chofer: '/logistica/',
} as const;

export type InternalPortalRouteKey = keyof typeof INTERNAL_ROUTES;

const FEEDBACK_DURATION_MS = 2000;
const NOTICE_DURATION_MS = 4000;

const LOCAL_DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const PORTAL_BUTTON_CONFIG: ReadonlyArray<{
  key: InternalPortalRouteKey;
  label: string;
  copiedAnnouncement: string;
  testId: string;
}> = [
  {
    key: 'promotoras',
    label: 'Copiar Link App Promotoras',
    copiedAnnouncement: '¡Enlace copiado! App Promotoras.',
    testId: 'btn-copy-link-promotoras',
  },
  {
    key: 'chofer',
    label: 'Copiar Link App Chofer',
    copiedAnnouncement: '¡Enlace copiado! App Chofer.',
    testId: 'btn-copy-link-chofer',
  },
];

/**
 * Construye de forma segura la URL completa de una ruta interna permitida.
 * - Solo admite rutas estrictamente relativas definidas en `INTERNAL_ROUTES`.
 * - Usa exclusivamente `window.location.origin` (nunca `href`, `search` ni `hash`).
 * - Valida protocolo `http:`/`https:`, coincidencia exacta de origen y ausencia de query/hash.
 */
export function buildSafeInternalPortalUrl(
  routeKey: InternalPortalRouteKey,
  explicitOrigin?: string
): string {
  const path = INTERNAL_ROUTES[routeKey];
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Ruta interna no permitida.');
  }

  const rawOrigin =
    explicitOrigin !== undefined
      ? explicitOrigin
      : typeof window !== 'undefined'
        ? window.location.origin
        : '';

  if (!rawOrigin) {
    throw new Error('Origen actual no disponible.');
  }

  const parsedOrigin = new URL(rawOrigin);
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error('Protocolo de origen no permitido.');
  }

  const resolved = new URL(path, parsedOrigin.origin);
  if (
    (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
    resolved.origin !== parsedOrigin.origin ||
    resolved.search !== '' ||
    resolved.hash !== ''
  ) {
    throw new Error('La URL construida no cumple las reglas de seguridad.');
  }

  return resolved.toString();
}

function isLocalDevWithoutHttps(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.isSecureContext && LOCAL_DEV_HOSTNAMES.has(window.location.hostname);
}

/**
 * Copia una URL al portapapeles de forma segura y resiliente.
 * - Prioriza `navigator.clipboard.writeText` cuando `window.isSecureContext` está activo.
 * - Permite un fallback controlado exclusivamente en entornos locales de desarrollo sin HTTPS.
 */
async function copyUrlSafely(url: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  if (window.isSecureContext && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      if (!isLocalDevWithoutHttps()) {
        return false;
      }
    }
  }

  if (!isLocalDevWithoutHttps() || typeof document === 'undefined' || !document.body) {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = url;
  textarea.setAttribute('readonly', 'true');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (textarea.parentNode) {
      textarea.parentNode.removeChild(textarea);
    }
  }
}

export const PortalQuickLinksBar: React.FC = () => {
  const [copiedByKey, setCopiedByKey] = useState<Record<InternalPortalRouteKey, boolean>>({
    promotoras: false,
    chofer: false,
  });
  const [liveMessage, setLiveMessage] = useState<string>('');
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);

  const timersRef = useRef<Record<InternalPortalRouteKey, ReturnType<typeof setTimeout> | null>>({
    promotoras: null,
    chofer: null,
  });
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const buttonTimers = timersRef.current;
    return () => {
      if (buttonTimers.promotoras !== null) clearTimeout(buttonTimers.promotoras);
      if (buttonTimers.chofer !== null) clearTimeout(buttonTimers.chofer);
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const showFriendlyNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
    }
    setClipboardNotice(message);
    setLiveMessage(message);
    noticeTimerRef.current = setTimeout(() => {
      setClipboardNotice(null);
      noticeTimerRef.current = null;
    }, NOTICE_DURATION_MS);
  }, []);

  const handleCopyLink = useCallback(
    async (routeKey: InternalPortalRouteKey, copiedAnnouncement: string) => {
      let targetUrl: string;
      try {
        targetUrl = buildSafeInternalPortalUrl(routeKey);
      } catch {
        showFriendlyNotice('No fue posible preparar el enlace en este navegador.');
        return;
      }

      const copied = await copyUrlSafely(targetUrl);
      if (!copied) {
        showFriendlyNotice(
          'El navegador bloqueó el acceso al portapapeles. Permite el permiso de portapapeles e inténtalo de nuevo.'
        );
        return;
      }

      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
      setClipboardNotice(null);

      if (timersRef.current[routeKey] !== null) {
        clearTimeout(timersRef.current[routeKey]!);
      }

      setCopiedByKey((prev) => ({ ...prev, [routeKey]: true }));
      setLiveMessage(copiedAnnouncement);

      timersRef.current[routeKey] = setTimeout(() => {
        setCopiedByKey((prev) => ({ ...prev, [routeKey]: false }));
        timersRef.current[routeKey] = null;
      }, FEEDBACK_DURATION_MS);
    },
    [showFriendlyNotice]
  );

  return (
    <div data-testid="portal-quick-links-bar" className="space-y-2.5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PORTAL_BUTTON_CONFIG.map(({ key, label, copiedAnnouncement, testId }) => {
          const isCopied = copiedByKey[key];
          const RoleIcon = key === 'promotoras' ? Smartphone : Truck;

          return (
            <button
              key={key}
              type="button"
              data-testid={testId}
              aria-label={isCopied ? copiedAnnouncement : label}
              onClick={() => void handleCopyLink(key, copiedAnnouncement)}
              className={`group w-full rounded-xl px-4 py-3.5 border text-left transition-all duration-150 cursor-pointer flex items-center justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#DC2626] focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
                isCopied
                  ? 'bg-red-950/35 border-[#DC2626] text-white shadow-[0_0_0_1px_rgba(220,38,38,0.35)]'
                  : 'bg-zinc-950/95 hover:bg-zinc-900 border-white/10 hover:border-red-500/50 text-zinc-100 hover:text-white'
              }`}
            >
              <span className="flex items-center gap-3 min-w-0">
                <span
                  className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 transition-colors ${
                    isCopied
                      ? 'bg-[#DC2626] border-[#DC2626] text-white'
                      : 'bg-red-600/15 border-red-500/35 text-red-400 group-hover:bg-[#DC2626] group-hover:border-[#DC2626] group-hover:text-white'
                  }`}
                >
                  <RoleIcon className="w-4 h-4" aria-hidden="true" />
                </span>
                <span className="text-xs sm:text-sm font-bold tracking-tight truncate">
                  {isCopied ? '¡Enlace copiado!' : label}
                </span>
              </span>

              <span
                className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 transition-colors ${
                  isCopied
                    ? 'bg-red-600/20 border-red-500/45 text-red-300'
                    : 'bg-zinc-900 border-white/10 text-zinc-400 group-hover:border-red-500/40 group-hover:text-white'
                }`}
                aria-hidden="true"
              >
                {isCopied ? (
                  <Check className="w-4 h-4 text-red-300" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </span>
            </button>
          );
        })}
      </div>

      {clipboardNotice && (
        <div
          role="alert"
          data-testid="portal-quick-links-notice"
          className="rounded-xl bg-red-950/45 border border-red-500/35 px-3.5 py-2 text-xs text-red-200 flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
          <span>{clipboardNotice}</span>
        </div>
      )}

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="portal-quick-links-live-region"
        className="sr-only"
      >
        {liveMessage}
      </div>
    </div>
  );
};
