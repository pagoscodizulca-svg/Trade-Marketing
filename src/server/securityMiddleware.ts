import cors, { type CorsOptions } from 'cors';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import { type Logger, usageMetrics } from './logger';

/** Normaliza una lista separada por comas a orígenes `https://host[:puerto]` válidos. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        const u = new URL(s);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
        return u.origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

const LOOPBACK_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function isOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
  isProduction: boolean
): boolean {
  if (!origin) return true; // misma origen / herramientas sin cabecera Origin
  if (allowed.includes(origin)) return true;
  if (!isProduction && LOOPBACK_ORIGIN_REGEX.test(origin)) return true;
  return false;
}

export function buildCorsMiddleware(options: {
  allowedOrigins: readonly string[];
  isProduction: boolean;
}): RequestHandler {
  const corsOptions: CorsOptions = {
    origin(origin, cb) {
      cb(null, isOriginAllowed(origin, options.allowedOrigins, options.isProduction));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'x-asistencia-meta',
      'x-incidencia-meta',
      'x-factura-meta',
      'x-sucursal-activa',
      'x-cron-secret',
      'x-shift-token',
      'x-webhook-token',
    ],
    credentials: false,
    maxAge: 600,
  };
  return cors(corsOptions);
}

/** Rechaza con 403 las solicitudes `/api` cuyo `Origin` de navegador no está autorizado. */
export function buildApiOriginGuard(options: {
  allowedOrigins: readonly string[];
  isProduction: boolean;
}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !isOriginAllowed(origin, options.allowedOrigins, options.isProduction)) {
      // mismo origen (el navegador envía Origin en POST same-origin): se acepta si coincide con Host
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === req.headers.host;
      } catch {
        sameHost = false;
      }
      if (!sameHost) {
        res.status(403).json({ error: 'Origen no autorizado.', code: 'ORIGIN_NOT_ALLOWED' });
        return;
      }
    }
    next();
  };
}

export function buildSecurityHeaders(options: {
  isProduction: boolean;
  extraConnectSrc?: readonly string[];
}): RequestHandler[] {
  const connectSrc = [
    "'self'",
    'https://*.supabase.co',
    'wss://*.supabase.co',
    'https://dashboard-fdv-planificador.onrender.com',
    'https://ve.dolarapi.com',
    ...(options.extraConnectSrc ?? []),
  ];

  const helmetMw = helmet({
    // En desarrollo, Vite inyecta scripts inline/HMR: la CSP solo se aplica en producción.
    contentSecurityPolicy: options.isProduction
      ? {
          useDefaults: false,
          directives: {
            'default-src': ["'self'"],
            'script-src': ["'self'"],
            'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
            'img-src': ["'self'", 'data:', 'blob:', 'https://*.supabase.co'],
            'connect-src': connectSrc,
            'worker-src': ["'self'", 'blob:'],
            'manifest-src': ["'self'"],
            'object-src': ["'none'"],
            'base-uri': ["'self'"],
            'form-action': ["'self'"],
            'frame-ancestors': ["'none'"],
            'upgrade-insecure-requests': [],
          },
        }
      : false,
    hsts: options.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  const permissionsPolicy: RequestHandler = (_req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
    next();
  };

  return [helmetMw, permissionsPolicy];
}

/** Log JSON por solicitud `/api` + métricas de uso (sin cuerpos ni cabeceras sensibles). */
export function buildRequestLogger(logger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint();
    usageMetrics.requests += 1;

    res.on('finish', () => {
      const status = res.statusCode;
      if (status >= 500) usageMetrics.errors5xx += 1;
      else if (status === 429) usageMetrics.rateLimited += 1;
      else if (status >= 400) usageMetrics.errors4xx += 1;

      if (!req.originalUrl.startsWith('/api')) return;
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logger[level]('http_request', {
        method: req.method,
        path: req.path,
        status,
        durationMs,
        userId: req.authUser?.id,
      });
    });
    next();
  };
}
