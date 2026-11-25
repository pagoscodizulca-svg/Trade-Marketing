import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import {
  DEFAULT_TRADE_CACHE_PREFIXES,
  PRELOAD_RELOAD_GUARD_KEY,
  getCurrentBuildId,
  isChunkLoadErrorMessage,
  performCleanVersionReload,
} from '../../lib/appVersionGuard';

interface ErrorBoundaryState {
  hasError: boolean;
  errorId: string;
}

/**
 * ErrorBoundary global (P-06): evita la pantalla en blanco ante un error de render y ofrece recuperación.
 * Nunca muestra el stack ni el mensaje técnico al usuario (solo un identificador de incidente).
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onError?: (error: Error, info: React.ErrorInfo, errorId: string) => void },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, errorId: '' };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return {
      hasError: true,
      errorId: `ERR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // El detalle técnico va a la consola del navegador (no a la interfaz).
    console.error('[ErrorBoundary]', this.state.errorId, error, info.componentStack);
    this.props.onError?.(error, info, this.state.errorId);
    if (isChunkLoadErrorMessage(error)) {
      void performCleanVersionReload({
        reason: 'preload-error',
        targetSignature: `eb-chunk:${getCurrentBuildId() || 'current'}`,
        guardKey: PRELOAD_RELOAD_GUARD_KEY,
        cachePrefixes: DEFAULT_TRADE_CACHE_PREFIXES,
        swScope: '/',
        cooldownMs: 30 * 1000,
      });
    }
  }

  private handleReload = () => {
    void performCleanVersionReload({
      reason: 'manual',
      targetSignature: `manual-eb:${Date.now()}`,
      cachePrefixes: DEFAULT_TRADE_CACHE_PREFIXES,
      swScope: '/',
    });
  };

  private handleRetry = () => {
    this.setState({ hasError: false, errorId: '' });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4"
      >
        <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-red-500/30 p-6 text-center space-y-4">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto" />
          <h1 className="text-lg font-extrabold">Ocurrió un error inesperado</h1>
          <p className="text-xs text-zinc-400">
            La aplicación encontró un problema al mostrar esta pantalla. Tus datos guardados no se
            han perdido. Si persiste, informa este código a soporte:
          </p>
          <code className="inline-block px-2 py-1 rounded bg-zinc-900 text-[11px] font-mono text-red-300">
            {this.state.errorId}
          </code>
          <div className="flex gap-2 justify-center">
            <button
              type="button"
              onClick={this.handleRetry}
              className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs font-bold cursor-pointer"
            >
              Reintentar
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-extrabold flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Recargar
            </button>
          </div>
        </div>
      </div>
    );
  }
}
