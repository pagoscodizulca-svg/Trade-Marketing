import type { Logger } from './logger';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60_000;

export type ShutdownTrigger =
  | 'SIGTERM'
  | 'SIGINT'
  | 'uncaughtException'
  | 'unhandledRejection';

export interface ClosableHttpServer {
  close(callback: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
}

export interface GracefulShutdownOptions {
  getServer: () => ClosableHttpServer | null;
  cleanup?: () => void | Promise<void>;
  logger: Logger;
  forceExitTimeoutMs?: number;
  exit?: (code: number) => void;
}

export interface GracefulShutdownController {
  isShuttingDown(): boolean;
  shutdown(trigger: ShutdownTrigger, errorOrReason?: unknown): Promise<number>;
}

export interface EnvValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function resolveShutdownTimeoutMs(
  overrideMs?: number,
  env: Record<string, string | undefined> = process.env
): number {
  if (overrideMs !== undefined) {
    if (Number.isFinite(overrideMs) && overrideMs > 0) {
      return Math.min(MAX_SHUTDOWN_TIMEOUT_MS, Math.max(1, Math.trunc(overrideMs)));
    }
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  const raw = (env.SHUTDOWN_TIMEOUT_MS || '').trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_SHUTDOWN_TIMEOUT_MS, parsed);
    }
  }
  return DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

function decodeJwtRoleUnsafe(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith('eyJ')) return null;
  const parts = trimmed.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    return typeof payload.role === 'string' ? payload.role.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Validación explícita al arranque del servidor sobre variables de entorno:
 *  - Jamás registra valores secretos en logs.
 *  - Bloquea exposición de llaves secretas (`sb_secret_*` / JWT `service_role`) en `VITE_*`.
 *  - Advierte URLs malformadas (`/rest/v1`) o parámetros de timeout no numéricos.
 */
export function validateServerEnvConfig(
  env: Record<string, string | undefined>,
  options: { isProduction: boolean; logger: Logger }
): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [key, rawVal] of Object.entries(env)) {
    if (!key.startsWith('VITE_')) continue;
    const val = String(rawVal ?? '').trim();
    if (!val) continue;

    if (/^sb_secret_/i.test(val)) {
      errors.push(`Variable pública "${key}" contiene una llave secreta (sb_secret_*).`);
    } else if (decodeJwtRoleUnsafe(val) === 'service_role') {
      errors.push(`Variable pública "${key}" contiene un JWT con rol service_role.`);
    }
  }

  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim();
  if (supabaseUrl) {
    try {
      const parsed = new URL(supabaseUrl);
      if (/\/rest\/v1\/?$/i.test(parsed.pathname)) {
        warnings.push('La URL de Supabase no debe incluir el sufijo "/rest/v1".');
      }
    } catch {
      warnings.push('La variable SUPABASE_URL / VITE_SUPABASE_URL no tiene formato de URL válido.');
    }
  } else if (options.isProduction) {
    warnings.push('Falta configurar SUPABASE_URL / VITE_SUPABASE_URL en producción.');
  }

  const positiveIntVars = [
    'PORT',
    'TRUST_PROXY_HOPS',
    'BCV_FETCH_TIMEOUT_MS',
    'AI_EXTRACTOR_TIMEOUT_MS',
    'SHUTDOWN_TIMEOUT_MS',
  ];
  for (const varName of positiveIntVars) {
    const raw = (env[varName] || '').trim();
    if (!raw) continue;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw) {
      warnings.push(`Variable "${varName}" inválida; se aplicará valor seguro por defecto.`);
    }
  }

  for (const warn of warnings) {
    options.logger.warn('server_env_warning', { detail: warn });
  }
  for (const err of errors) {
    options.logger.error('server_env_violation', { detail: err });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Controlador de apagado ordenado (Graceful Shutdown):
 *  - Protegido contra doble invocación mediante bandera `shuttingDown`.
 *  - Registra errores estructurados sin exponer secretos (vía `Logger` con redacción).
 *  - Deja de aceptar nuevas conexiones (`server.close()`), libera recursos/timers vía `cleanup()`
 *    y aplica un timeout de salida forzada con `.unref()` para evitar cuelgues.
 */
export function createGracefulShutdownController(
  options: GracefulShutdownOptions
): GracefulShutdownController {
  let shuttingDown = false;
  let activeShutdownPromise: Promise<number> | null = null;
  const timeoutMs = resolveShutdownTimeoutMs(options.forceExitTimeoutMs);
  const exitFn = options.exit ?? ((code: number) => process.exit(code));

  const shutdown = (
    trigger: ShutdownTrigger,
    errorOrReason?: unknown
  ): Promise<number> => {
    if (shuttingDown && activeShutdownPromise) {
      options.logger.warn('graceful_shutdown_duplicate_ignored', { trigger });
      return activeShutdownPromise;
    }

    shuttingDown = true;
    const isFatal = trigger === 'uncaughtException' || trigger === 'unhandledRejection';
    const plannedExitCode = isFatal ? 1 : 0;

    if (isFatal) {
      options.logger.error('fatal_process_error_initiating_shutdown', {
        trigger,
        err: errorOrReason,
      });
    } else {
      options.logger.info('graceful_shutdown_started', { trigger });
    }

    activeShutdownPromise = new Promise<number>((resolve) => {
      let finalized = false;

      const finish = (code: number) => {
        if (finalized) return;
        finalized = true;
        clearTimeout(forceTimer);
        exitFn(code);
        resolve(code);
      };

      const forceTimer = setTimeout(() => {
        options.logger.error('graceful_shutdown_forced_exit', {
          trigger,
          timeoutMs,
        });
        finish(1);
      }, timeoutMs);
      forceTimer.unref?.();

      const runCleanupAndClose = async () => {
        let hadCloseError = false;

        try {
          const httpServer = options.getServer();
          if (httpServer) {
            await new Promise<void>((resolveClose) => {
              try {
                httpServer.close((err) => {
                  if (err) {
                    hadCloseError = true;
                    options.logger.error('http_server_close_error', { trigger, err });
                  }
                  resolveClose();
                });
                httpServer.closeIdleConnections?.();
              } catch (syncErr) {
                hadCloseError = true;
                options.logger.error('http_server_close_error', { trigger, err: syncErr });
                resolveClose();
              }
            });
          }
        } catch (err) {
          hadCloseError = true;
          options.logger.error('http_server_close_error', { trigger, err });
        }

        if (options.cleanup) {
          try {
            await options.cleanup();
          } catch (cleanupErr) {
            hadCloseError = true;
            options.logger.error('graceful_shutdown_cleanup_error', {
              trigger,
              err: cleanupErr,
            });
          }
        }

        const exitCode = hadCloseError ? 1 : plannedExitCode;
        options.logger.info('graceful_shutdown_completed', { trigger, exitCode });
        finish(exitCode);
      };

      void runCleanupAndClose();
    });

    return activeShutdownPromise;
  };

  return {
    isShuttingDown: () => shuttingDown,
    shutdown,
  };
}

export function registerProcessShutdownHandlers(
  controller: GracefulShutdownController,
  proc: NodeJS.EventEmitter = process
): () => void {
  const onUncaughtException = (err: unknown) => {
    void controller.shutdown('uncaughtException', err);
  };
  const onUnhandledRejection = (reason: unknown) => {
    void controller.shutdown('unhandledRejection', reason);
  };
  const onSigTerm = () => {
    void controller.shutdown('SIGTERM');
  };
  const onSigInt = () => {
    void controller.shutdown('SIGINT');
  };

  proc.on('uncaughtException', onUncaughtException);
  proc.on('unhandledRejection', onUnhandledRejection);
  proc.on('SIGTERM', onSigTerm);
  proc.on('SIGINT', onSigInt);

  return () => {
    proc.off('uncaughtException', onUncaughtException);
    proc.off('unhandledRejection', onUnhandledRejection);
    proc.off('SIGTERM', onSigTerm);
    proc.off('SIGINT', onSigInt);
  };
}
