import { useMemo, useState } from 'react';
import { Plus, Search, Upload, X } from 'lucide-react';
import type { EntregaVista } from '../../types';
import type { EntregasRepository, SyncState } from '../../services/entregasRepository';
import { diasUnicos, normalizar, resumir } from '../../utils/format';
import { EmptyState } from '../common/EmptyState';
import { KpiCards } from './KpiCards';
import { EntregasTable } from './EntregasTable';
import { ImportModal } from './ImportModal';
import { AddStopModal } from './AddStopModal';

interface OficinaViewProps {
  entregas: EntregaVista[];
  repo: EntregasRepository;
  sync: SyncState;
}

export function OficinaView({ entregas, repo, sync }: OficinaViewProps) {
  const [dia, setDia] = useState('TODOS');
  const [turno, setTurno] = useState('TODOS');
  const [busqueda, setBusqueda] = useState('');
  const [modal, setModal] = useState<'importar' | 'agregar' | null>(null);
  const [aviso, setAviso] = useState('');

  const dias = useMemo(() => diasUnicos(entregas), [entregas]);

  // KPIs: siguen los filtros de día y turno.
  const porFiltros = useMemo(
    () => entregas.filter((e) => (dia === 'TODOS' || e.fecha === dia) && (turno === 'TODOS' || e.turno === turno)),
    [entregas, dia, turno],
  );
  const resumen = useMemo(() => resumir(porFiltros), [porFiltros]);

  // Tabla: además aplica el buscador (cliente, vendedor o promotora).
  const filas = useMemo(() => {
    const q = normalizar(busqueda);
    if (!q) return porFiltros;
    return porFiltros.filter((e) =>
      [e.cliente, e.vendedor, e.promotora].some((campo) => normalizar(campo).includes(q)),
    );
  }, [porFiltros, busqueda]);

  const avisar = (msg: string) => {
    setAviso(msg);
    window.setTimeout(() => setAviso(''), 4000);
  };

  const select =
    'min-h-11 rounded-lg border-2 border-zinc-300 bg-white px-3 text-sm font-bold text-zinc-800 focus:outline-none focus:border-ink';

  return (
    <div className="space-y-4" data-testid="vista-oficina">
      <KpiCards resumen={resumen} />

      <div className="bg-white border-2 border-zinc-300 rounded-2xl p-3 flex flex-col lg:flex-row gap-3 lg:items-center shadow-sm">
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Cliente, vendedor o promotora…"
            aria-label="Buscar por cliente, vendedor o promotora"
            data-testid="buscador"
            className="w-full min-h-11 pl-9 pr-9 rounded-lg border-2 border-zinc-300 font-semibold focus:outline-none focus:border-ink"
          />
          {busqueda && (
            <button
              onClick={() => setBusqueda('')}
              aria-label="Limpiar búsqueda"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 grid place-items-center rounded text-zinc-500 hover:bg-zinc-100"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <select value={dia} onChange={(e) => setDia(e.target.value)} className={select} aria-label="Filtrar por día" data-testid="filtro-dia">
            <option value="TODOS">Todos los días</option>
            {dias.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <select value={turno} onChange={(e) => setTurno(e.target.value)} className={select} aria-label="Filtrar por turno" data-testid="filtro-turno">
            <option value="TODOS">Todos los turnos</option>
            <option>MAÑANA</option>
            <option>TARDE</option>
          </select>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setModal('importar')}
            disabled={sync.offline}
            title={sync.offline ? 'Requiere conexión a internet' : undefined}
            data-testid="btn-importar"
            className="min-h-11 px-3.5 rounded-lg bg-ink text-white font-black text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className="w-4 h-4" /> Importar CSV/Excel
          </button>
          <button
            onClick={() => setModal('agregar')}
            disabled={sync.offline}
            title={sync.offline ? 'Requiere conexión a internet' : undefined}
            data-testid="btn-agregar"
            className="min-h-11 px-3.5 rounded-lg bg-brand text-white font-black text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" /> Nueva parada
          </button>
        </div>
      </div>

      {aviso && (
        <p role="status" className="text-sm font-bold text-green-900 bg-green-100 border border-green-600 rounded-lg px-3 py-2">
          {aviso}
        </p>
      )}

      <p className="text-xs font-bold text-zinc-600" data-testid="contador-filas">
        Mostrando {filas.length} de {entregas.length} paradas
      </p>
      {entregas.length === 0 ? (
        <EmptyState sync={sync} onRefresh={() => repo.refresh()} />
      ) : filas.length === 0 ? (
        <EmptyState
          testId="empty-state-filtro"
          titulo="Ninguna parada coincide con los filtros"
          descripcion="Ajusta el día, el turno o la búsqueda para ver más paradas."
        />
      ) : (
        <EntregasTable entregas={filas} />
      )}

      {modal === 'importar' && (
        <ImportModal
          onClose={() => setModal(null)}
          onConfirm={async (res, modo) => {
            await repo.importMany(res.rows, modo);
            avisar(`${res.rows.length} paradas importadas (${modo === 'reemplazar' ? 'cronograma reemplazado' : 'agregadas'}).`);
          }}
        />
      )}
      {modal === 'agregar' && (
        <AddStopModal
          dias={dias}
          onClose={() => setModal(null)}
          onSave={async (e) => {
            await repo.add(e);
            avisar(`Parada "${e.cliente}" agregada.`);
          }}
        />
      )}
    </div>
  );
}
