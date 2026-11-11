import { MessageSquareWarning } from 'lucide-react';
import type { Entrega } from '../../types';
import { estiloProducto, etiquetaProducto } from '../../utils/format';

const TH = 'border border-zinc-700 border-b-2 border-b-brand bg-ink text-white text-left text-xs font-black uppercase tracking-wide px-2.5 py-2 whitespace-nowrap sticky top-0';
const TD = 'border border-zinc-400 px-2.5 py-1.5 text-sm align-middle';

export function EntregasTable({ entregas }: { entregas: Entrega[] }) {
  return (
    <div className="bg-white border-2 border-zinc-400 rounded-xl overflow-auto max-h-[70vh] shadow-sm">
      <table className="w-full border-collapse min-w-[860px]" data-testid="tabla-entregas">
        <thead>
          <tr>
            <th className={TH}>Fecha</th>
            <th className={TH}>Turno</th>
            <th className={TH}>Cliente</th>
            <th className={TH}>Producto</th>
            <th className={TH}>Vendedor</th>
            <th className={TH}>Promotora</th>
            <th className={TH}>Estado</th>
            <th className={TH}>Hora entrega</th>
          </tr>
        </thead>
        <tbody>
          {entregas.length === 0 ? (
            <tr>
              <td colSpan={8} className="text-center text-zinc-600 font-semibold py-10">
                No hay paradas que coincidan con los filtros.
              </td>
            </tr>
          ) : (
            entregas.map((e) => (
              <tr
                key={e.id}
                data-testid={`fila-${e.id}`}
                data-completado={e.completado}
                className={e.completado ? 'bg-[#A9D08E]' : 'bg-white'}
              >
                <td className={`${TD} whitespace-nowrap font-semibold`}>{e.fecha}</td>
                <td className={`${TD} whitespace-nowrap`}>{e.numero_grupo_turno}</td>
                <td className={`${TD} font-black`}>
                  <span className="inline-flex items-center gap-1.5">
                    {e.cliente}
                    {e.notas_chofer.trim() && (
                      <span title={`Nota del chofer: ${e.notas_chofer}`} className="text-red-700" data-testid={`nota-icono-${e.id}`}>
                        <MessageSquareWarning className="w-4 h-4" />
                        <span className="sr-only">Nota del chofer: {e.notas_chofer}</span>
                      </span>
                    )}
                  </span>
                </td>
                <td className={TD}>
                  <span className={`inline-block text-xs font-black px-2 py-0.5 rounded ${estiloProducto(e.producto).chip}`}>
                    {etiquetaProducto(e.producto)}
                  </span>
                </td>
                <td className={TD}>{e.vendedor}</td>
                <td className={TD}>{e.promotora}</td>
                <td className={`${TD} font-black whitespace-nowrap ${e.completado ? 'text-green-900' : 'text-red-700'}`}>
                  {e.completado ? 'COMPLETADO' : 'PENDIENTE'}
                </td>
                <td className={`${TD} whitespace-nowrap font-mono font-bold`}>{e.hora_entrega ?? '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
