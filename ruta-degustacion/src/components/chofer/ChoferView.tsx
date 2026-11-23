import { useMemo, useState } from 'react';
import { ArrowDownToLine, Filter } from 'lucide-react';
import type { EntregaVista } from '../../types';
import type { EntregasRepository, SyncState } from '../../services/entregasRepository';
import { diasUnicos, resumir } from '../../utils/format';
import { EmptyState } from '../common/EmptyState';
import { SyncStatusBanner } from '../common/SyncStatusBanner';
import { DayTabs, TurnoFilter, type TurnoFiltro } from './DayTabs';
import { ProgressBar } from './ProgressBar';
import { EntregaCard } from './EntregaCard';

interface ChoferViewProps {
  entregas: EntregaVista[];
  repo: EntregasRepository;
  sync: SyncState;
}

export function ChoferView({ entregas, repo, sync }: ChoferViewProps) {
  const dias = useMemo(() => diasUnicos(entregas), [entregas]);
  const [diaSel, setDiaSel] = useState<string>('');
  const [turno, setTurno] = useState<TurnoFiltro>('TODOS');
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [completadasAlFinal, setCompletadasAlFinal] = useState(true);
  const [errorAccion, setErrorAccion] = useState('');

  // Si el día elegido ya no existe (p. ej. tras importar), cae al primero disponible.
  const dia = dias.includes(diaSel) ? diaSel : dias[0] ?? '';

  const conteoPorDia = useMemo(() => {
    const out: Record<string, { completadas: number; total: number }> = {};
    for (const d of dias) {
      const r = resumir(entregas.filter((e) => e.fecha === d));
      out[d] = { completadas: r.entregadas, total: r.total };
    }
    return out;
  }, [entregas, dias]);

  const delDia = useMemo(() => entregas.filter((e) => e.fecha === dia), [entregas, dia]);
  const progreso = resumir(delDia);

  const visibles = useMemo(() => {
    let lista = delDia.filter((e) => turno === 'TODOS' || e.turno === turno);
    if (soloPendientes) lista = lista.filter((e) => !e.completado);
    if (completadasAlFinal) {
      // Orden estable: pendientes primero, completadas al final.
      lista = [...lista].sort((a, b) => Number(a.completado) - Number(b.completado));
    }
    return lista;
  }, [delDia, turno, soloPendientes, completadasAlFinal]);

  const gestionar = (fn: () => Promise<void>) => {
    setErrorAccion('');
    fn().catch((err) => {
      console.error('[RutaDegustación]', err);
      setErrorAccion(err instanceof Error ? err.message : 'No se pudo completar la acción.');
    });
  };

  return (
    <div className="space-y-3.5 max-w-3xl mx-auto" data-testid="vista-chofer">
      {/* Siempre visible: queda fijo justo debajo de la cabecera mientras el chofer recorre su ruta */}
      <div
        className="sticky z-30 -mx-3 sm:-mx-6 px-3 sm:px-6 pt-1.5 pb-1.5 bg-zinc-100/95 backdrop-blur"
        style={{ top: 'var(--hdr-h, 0px)' }}
      >
        <SyncStatusBanner sync={sync} onRetry={() => repo.flushNow()} />
      </div>
      <DayTabs dias={dias} dia={dia} onChange={setDiaSel} conteo={conteoPorDia} />
      <TurnoFilter turno={turno} onChange={setTurno} />
      <ProgressBar completadas={progreso.entregadas} total={progreso.total} etiquetaDia={dia} />

      <div className="flex flex-wrap gap-2">
        <button
          aria-pressed={soloPendientes}
          data-testid="filtro-solo-pendientes"
          onClick={() => setSoloPendientes((v) => !v)}
          className={`min-h-12 px-4 rounded-xl border-2 font-black text-sm flex items-center gap-2 ${
            soloPendientes ? 'bg-brand border-brand text-white' : 'bg-white border-zinc-300 text-zinc-700'
          }`}
        >
          <Filter className="w-4 h-4" />
          Solo pendientes
        </button>
        <button
          aria-pressed={completadasAlFinal}
          data-testid="orden-completadas-al-final"
          onClick={() => setCompletadasAlFinal((v) => !v)}
          className={`min-h-12 px-4 rounded-xl border-2 font-black text-sm flex items-center gap-2 ${
            completadasAlFinal ? 'bg-ink border-ink text-white' : 'bg-white border-zinc-300 text-zinc-700'
          }`}
        >
          <ArrowDownToLine className="w-4 h-4" />
          Completadas al final
        </button>
      </div>

      {errorAccion && (
        <p role="alert" data-testid="chofer-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-300 rounded-lg px-3 py-2">
          {errorAccion}
        </p>
      )}

      {entregas.length === 0 ? (
        <EmptyState sync={sync} onRefresh={() => repo.refresh()} />
      ) : visibles.length === 0 ? (
        <EmptyState
          testId="empty-state-filtro"
          titulo={soloPendientes && progreso.total > 0 ? '¡Todo entregado!' : 'No hay paradas para este filtro'}
          descripcion={
            soloPendientes && progreso.total > 0
              ? 'No quedan entregas pendientes con este filtro.'
              : 'Cambia el día o el turno para ver más paradas.'
          }
        />
      ) : (
        <ul className="space-y-3.5" data-testid="lista-entregas">
          {visibles.map((e) => (
            <li key={e.id}>
              <EntregaCard
                entrega={e}
                onToggle={(id) => gestionar(() => repo.toggleEntrega(id))}
                onConfirmarSalida={(id) => gestionar(() => repo.confirmarSalida(id))}
                onConfirmarLlegada={(id) => gestionar(() => repo.confirmarLlegada(id))}
                onSubirEvidencia={(id, file) => repo.subirEvidencia(id, file)}
                onObtenerUrlEvidencia={(path, bucket) => repo.obtenerUrlEvidencia(path, bucket)}
                onNota={(id, nota) => gestionar(() => repo.setNota(id, nota))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
