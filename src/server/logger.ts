/**
 * Logger JSON estructurado con redacción de datos sensibles (M-05).
 * Una línea JSON por evento: apto para agregadores (Render, Loki, CloudWatch…).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_REGEX =
  /(authorization|cookie|password|passwd|secret|token|apikey|api_key|api-key|service_role|jwt|bearer|x-cron|signature|signedurl)/i;

const MAX_STRING_LEN = 500;
const MAX_DEPTH = 5;

/** Redacta JWT, llaves Supabase y credenciales embebidas en texto libre. */
export function redactString(input: string): string {
  return input
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]')
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/gi, '[REDACTED_SB_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&](?:token|apikey|access_token|signature)=)[^&\s]+/gi, '$1[REDACTED]');
}

export function redactValue(value: unknown, depth = 0, keyHint = ''): unknown {
  if (keyHint && SENSITIVE_KEY_REGEX.test(keyHint)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const clean = redactString(value);
    return clean.length > MAX_STRING_LEN ? `${clean.slice(0, MAX_STRING_LEN)}…[truncado]` : clean;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack).split('\n').slice(0, 6).join('\n') : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = redactValue(v, depth + 1, k);
    }
    return out;
  }
  return String(value);
}

export interface LoggerSink {
  write(line: string): void;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(options?: {
  minLevel?: LogLevel;
  sink?: LoggerSink;
  base?: Record<string, unknown>;
  now?: () => Date;
}): Logger {
  const minLevel = options?.minLevel ?? 'info';
  const sink: LoggerSink = options?.sink ?? {
    write: (line) => process.stdout.write(`${line}\n`),
  };
  const now = options?.now ?? (() => new Date());

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record = {
      ts: now().toISOString(),
      level,
      msg: redactString(msg),
      ...(options?.base ?? {}),
      ...((redactValue(fields ?? {}) as Record<string, unknown>) ?? {}),
    };
    sink.write(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const serverLogger = createLogger({
  minLevel: (process.env.LOG_LEVEL as LogLevel) || 'info',
  base: { service: 'codizulca-trade' },
});

/** Contadores mínimos de uso para observabilidad (sin PII). */
export interface UsageMetrics {
  startedAtIso: string;
  requests: number;
  errors5xx: number;
  errors4xx: number;
  rateLimited: number;
}

export const usageMetrics: UsageMetrics = {
  startedAtIso: new Date().toISOString(),
  requests: 0,
  errors5xx: 0,
  errors4xx: 0,
  rateLimited: 0,
};
