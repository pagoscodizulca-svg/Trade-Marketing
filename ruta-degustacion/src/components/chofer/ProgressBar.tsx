import { safePct, toFiniteNumber } from '../../utils/safeMath';

interface ProgressBarProps {
  completadas: number | null | undefined;
  total: number | null | undefined;
  etiquetaDia: string;
}

export function ProgressBar({ completadas: completadasProp, total: totalProp, etiquetaDia }: ProgressBarProps) {
  const completadas = toFiniteNumber(completadasProp);
  const total = toFiniteNumber(totalProp);
  const pct = Math.min(100, Math.max(0, safePct(completadas, total)));
  const listo = total > 0 && completadas === total;
  return (
    <section
      aria-label="Progreso del día"
      className="bg-white border-2 border-zinc-300 rounded-2xl p-3.5 shadow-sm"
      data-testid="chofer-progreso"
    >
      <div className="flex items-end justify-between gap-2 mb-2">
        <p className="text-base sm:text-lg font-black text-ink">
          <span data-testid="chofer-progreso-texto">
            {completadas} de {total} entregas completadas
          </span>
        </p>
        <span className={`text-xl font-black ${listo ? 'text-green-700' : 'text-zinc-700'}`}>{pct}%</span>
      </div>
      <div
        className="h-4 w-full bg-zinc-200 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Progreso ${etiquetaDia}`}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${listo ? 'bg-green-600' : 'bg-brand'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}
