import { CheckCircle2, Clock, ListChecks, Percent } from 'lucide-react';
import type { Resumen } from '../../utils/format';
import { toFiniteNumber } from '../../utils/safeMath';

export function KpiCards({ resumen }: { resumen: Resumen | null | undefined }) {
  const total = toFiniteNumber(resumen?.total);
  const entregadas = toFiniteNumber(resumen?.entregadas);
  const pendientes = toFiniteNumber(resumen?.pendientes);
  const cumplimiento = toFiniteNumber(resumen?.cumplimiento);
  const cards = [
    {
      id: 'total',
      label: 'Total Programadas',
      valor: String(total),
      icon: <ListChecks className="w-6 h-6" />,
      clases: 'bg-white border-zinc-300 text-ink',
      icono: 'bg-zinc-100 text-zinc-700',
    },
    {
      id: 'entregadas',
      label: 'Entregadas',
      valor: String(entregadas),
      icon: <CheckCircle2 className="w-6 h-6" />,
      clases: 'bg-green-50 border-green-600 text-green-800',
      icono: 'bg-green-200 text-green-800',
    },
    {
      id: 'pendientes',
      label: 'Pendientes',
      valor: String(pendientes),
      icon: <Clock className="w-6 h-6" />,
      clases: 'bg-red-50 border-red-600 text-red-800',
      icono: 'bg-red-200 text-red-800',
    },
    {
      id: 'cumplimiento',
      label: '% Cumplimiento del Chofer',
      valor: `${cumplimiento}%`,
      icon: <Percent className="w-6 h-6" />,
      clases: 'bg-ink border-ink text-white',
      icono: 'bg-brand text-white',
    },
  ];

  return (
    <section aria-label="Indicadores" className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="kpis">
      {cards.map((c) => (
        <div key={c.id} className={`rounded-2xl border-2 p-3.5 flex items-center gap-3 shadow-sm ${c.clases}`}>
          <div className={`w-11 h-11 rounded-xl grid place-items-center shrink-0 ${c.icono}`}>{c.icon}</div>
          <div className="min-w-0">
            <p className="text-[11px] sm:text-xs font-bold uppercase tracking-wide opacity-80 leading-tight">
              {c.label}
            </p>
            <p className="text-3xl font-black leading-none mt-0.5" data-testid={`kpi-${c.id}`}>
              {c.valor}
            </p>
          </div>
        </div>
      ))}
    </section>
  );
}
