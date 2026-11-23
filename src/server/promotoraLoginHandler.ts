import type { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { serverLogger } from './logger';

const PromotoraLoginBodySchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Ingresa un correo electrónico válido.')
    .max(254),
  password: z.string().min(1, 'Ingresa tu contraseña.').max(256),
});

interface FailedAttemptBucket {
  count: number;
  resetAt: number;
}

export interface PromotoraLoginAuthResult {
  ok: boolean;
  status: number;
  session?: {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    expires_at?: number;
    token_type?: string;
  };
  error?: string;
}

export interface PromotoraLoginGateway {
  signInWithPassword(email: string, password: string): Promise<PromotoraLoginAuthResult>;
}

const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_BUCKETS = 5_000;

function extractClientIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
}

function createDefaultSupabasePasswordGateway(): PromotoraLoginGateway | null {
  const url = String(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const publicKey = String(
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      process.env.SUPABASE_PUBLISHABLE_KEY ??
      process.env.VITE_SUPABASE_ANON_KEY ??
      process.env.SUPABASE_ANON_KEY ??
      ''
  ).trim();

  if (!url || !publicKey) return null;

  return {
    async signInWithPassword(email, password) {
      const anonClient = createClient(url, publicKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
      if (error || !data.session?.access_token || !data.session?.refresh_token) {
        const status =
          typeof (error as { status?: number } | null)?.status === 'number' &&
          (error as { status?: number }).status === 429
            ? 429
            : 401;
        return {
          ok: false,
          status,
          error:
            status === 429
              ? 'Demasiados intentos de acceso. Espera unos minutos e intenta nuevamente.'
              : 'Credenciales inválidas. Verifica tu correo y contraseña.',
        };
      }

      return {
        ok: true,
        status: 200,
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_in: data.session.expires_in,
          expires_at: data.session.expires_at,
          token_type: data.session.token_type,
        },
      };
    },
  };
}

/**
 * Endpoint autenticado `POST /api/auth/promotora-login` con defensa anti-fuerza bruta:
 *   - Limita intentos fallidos por par `(IP, correo normalizado)` (default: 5 fallos / 15 min -> 429).
 *   - Delega la verificación criptográfica exclusivamente a Supabase Auth (`bcrypt` nativo).
 *   - Jamás registra contraseñas ni tokens en logs o respuestas de error.
 */
export function createPromotoraLoginHandler(options?: {
  gateway?: PromotoraLoginGateway | null;
  maxFailedAttempts?: number;
  windowMs?: number;
  now?: () => number;
}) {
  const maxFailedAttempts = options?.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
  const windowMs = options?.windowMs ?? DEFAULT_LOCKOUT_WINDOW_MS;
  const nowFn = options?.now ?? (() => Date.now());
  const failedBuckets = new Map<string, FailedAttemptBucket>();

  const pruneExpiredBuckets = (now: number) => {
    if (failedBuckets.size < MAX_TRACKED_BUCKETS) return;
    for (const [key, bucket] of failedBuckets.entries()) {
      if (bucket.resetAt <= now) failedBuckets.delete(key);
    }
    if (failedBuckets.size >= MAX_TRACKED_BUCKETS) {
      const oldestKey = failedBuckets.keys().next().value;
      if (oldestKey) failedBuckets.delete(oldestKey);
    }
  };

  return async (req: Request, res: Response): Promise<void> => {
    const parsed = PromotoraLoginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Correo y contraseña requeridos.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { email, password } = parsed.data;
    const ip = extractClientIp(req);
    const bucketKey = `${ip}::${email}`;
    const now = nowFn();

    const currentBucket = failedBuckets.get(bucketKey);
    if (currentBucket && currentBucket.resetAt > now && currentBucket.count >= maxFailedAttempts) {
      const retryAfterSec = Math.max(1, Math.ceil((currentBucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      serverLogger.warn('promotora_login_rate_limited', {
        ip,
        emailDomain: email.split('@')[1] || 'unknown',
        retryAfterSec,
      });
      res.status(429).json({
        error: `Demasiados intentos fallidos. Intenta nuevamente en ${Math.ceil(retryAfterSec / 60)} min.`,
        code: 'LOGIN_RATE_LIMITED',
        retryAfterSec,
      });
      return;
    }
    if (currentBucket && currentBucket.resetAt <= now) {
      failedBuckets.delete(bucketKey);
    }

    const gateway =
      options?.gateway !== undefined ? options.gateway : createDefaultSupabasePasswordGateway();
    if (!gateway) {
      res.status(503).json({
        error: 'Servicio de autenticación no configurado en el servidor.',
        code: 'AUTH_UNCONFIGURED',
      });
      return;
    }

    try {
      const authRes = await gateway.signInWithPassword(email, password);
      if (!authRes.ok || !authRes.session) {
        pruneExpiredBuckets(now);
        const prev = failedBuckets.get(bucketKey);
        const nextBucket: FailedAttemptBucket =
          prev && prev.resetAt > now
            ? { count: prev.count + 1, resetAt: prev.resetAt }
            : { count: 1, resetAt: now + windowMs };
        failedBuckets.set(bucketKey, nextBucket);

        const isNowLocked = nextBucket.count >= maxFailedAttempts;
        const status = authRes.status === 429 || isNowLocked ? 429 : 401;
        if (status === 429) {
          const retryAfterSec = Math.max(1, Math.ceil((nextBucket.resetAt - now) / 1000));
          res.setHeader('Retry-After', String(retryAfterSec));
        }

        serverLogger.warn('promotora_login_failed', {
          ip,
          emailDomain: email.split('@')[1] || 'unknown',
          attemptsInWindow: nextBucket.count,
          locked: isNowLocked,
        });

        res.status(status).json({
          error:
            status === 429
              ? 'Demasiados intentos fallidos. Espera 15 minutos antes de reintentar.'
              : authRes.error || 'Credenciales inválidas. Verifica tu correo y contraseña.',
          code: status === 429 ? 'LOGIN_RATE_LIMITED' : 'INVALID_CREDENTIALS',
        });
        return;
      }

      // Éxito: limpiar contador de intentos fallidos
      failedBuckets.delete(bucketKey);
      res.status(200).json({
        ok: true,
        session: authRes.session,
      });
    } catch {
      res.status(502).json({
        error: 'No se pudo completar la autenticación en este momento.',
        code: 'AUTH_UPSTREAM_ERROR',
      });
    }
  };
}
