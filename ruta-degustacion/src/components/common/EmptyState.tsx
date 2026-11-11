import { PackageOpen, RefreshCw } from 'lucide-react';
import type { SyncState } from '../../services/entregasRepository';

interface EmptyStateProps {
  /** Estado de sincronización para ajustar la descripción por defecto. */
  sync?: SyncState;
  titulo?: string;
  descripcion?: string;
  /** Si se pasa, muestra el botón «Sincronizar ahora». */
  onRefresh?: () => void | Promise<void>;
  testId?: string;
}

export const TITULO_SIN_REGISTROS = 'No hay registros sincronizados en este momento';

/** Estado vacío reutilizable: solo informa, nunca muestra datos inventados. */
export function EmptyState({ sync, titulo = TITULO_SIN_REGISTROS, descripcion, onRefresh, testId = 'empty-state' }: EmptyStateProps) {
  const detalle =
    descripcion ??
    (sync?.offline
      ? 'Sin conexión y sin ruta guardada en el teléfono: conéctate una vez a internet para descargar tu ruta.'
      : sync?.status === 'error'
      ? `No se pudo consultar el servidor: ${sync.errorMessage ?? 'error desconocido'}`
      : sync?.status === 'sincronizando'
        ? 'Consultando el servidor…'
        : 'Cuando se importen o registren paradas en el servidor aparecerán aquí automáticamente.');

  return (
    <div
      className="bg-white border-2 border-dashed border-zinc-300 rounded-2xl p-8 text-center text-zinc-600"
      data-testid={testId}
    >
      <PackageOpen className="w-10 h-10 mx-auto mb-2 text-zinc-400" aria-hidden="true" />
      <p className="font-black text-lg text-zinc-800">{titulo}</p>
      <p className="text-sm mt-1">{detalle}</p>
      {onRefresh && (
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={sync?.status === 'sincronizando'}
          data-testid="empty-refresh"
          className="mt-4 min-h-11 px-4 rounded-lg bg-ink text-white font-black text-sm inline-flex items-center gap-2 disabled:opacity-60"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" /> Sincronizar ahora
        </button>
      )}
    </div>
  );
}
