interface DayTabsProps {
  dias: string[];
  dia: string;
  onChange: (d: string) => void;
  conteo: Record<string, { completadas: number; total: number }>;
}

export function DayTabs({ dias, dia, onChange, conteo }: DayTabsProps) {
  return (
    <div role="tablist" aria-label="Día" className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {dias.map((d) => {
        const activo = d === dia;
        const c = conteo[d];
        return (
          <button
            key={d}
            role="tab"
            aria-selected={activo}
            data-testid={`dia-${d}`}
            onClick={() => onChange(d)}
            className={`shrink-0 min-h-14 px-4 rounded-xl border-2 text-sm sm:text-base font-black leading-tight transition-colors ${
              activo
                ? 'bg-ink border-ink text-white'
                : 'bg-white border-zinc-300 text-zinc-800 hover:border-zinc-500'
            }`}
          >
            <span className="block">{d}</span>
            {c && (
              <span className={`block text-[11px] font-bold ${activo ? 'text-red-300' : 'text-zinc-500'}`}>
                {c.completadas}/{c.total}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type TurnoFiltro = 'TODOS' | 'MAÑANA' | 'TARDE';

interface TurnoFilterProps {
  turno: TurnoFiltro;
  onChange: (t: TurnoFiltro) => void;
}

export function TurnoFilter({ turno, onChange }: TurnoFilterProps) {
  const opciones: TurnoFiltro[] = ['TODOS', 'MAÑANA', 'TARDE'];
  return (
    <div role="group" aria-label="Turno" className="grid grid-cols-3 gap-1.5 bg-zinc-200 p-1 rounded-xl">
      {opciones.map((o) => (
        <button
          key={o}
          aria-pressed={turno === o}
          data-testid={`turno-${o}`}
          onClick={() => onChange(o)}
          className={`min-h-12 rounded-lg text-sm font-black transition-colors ${
            turno === o ? 'bg-white text-ink shadow' : 'text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
