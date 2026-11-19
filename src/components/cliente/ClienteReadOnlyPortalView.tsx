import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react';
import {
  fetchClientePortalResumen,
  type ClientePortalResumen,
} from '../../services/clientePortalService';
import { downloadExecutiveWorkbookXlsx } from '../../utils/excelWordExport';

/** Portal de SOLO LECTURA para el rol `cliente`. No contiene controles de edición. */
export const ClienteReadOnlyPortalView: React.FC<{ onSignOut?: () => void }> = ({ onSignOut }) => {
  const [data, setData] = useState<ClientePortalResumen | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchClientePortalResumen());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando el portal.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exportXlsx = async () => {
    if (!data) return;
    await downloadExecutiveWorkbookXlsx(
      {
        title: 'Portal Cliente · Ejecución en Puntos de Venta',
        generatedBy: 'Portal Cliente',
        sheets: [
          {
            name: 'Activaciones',
            headers: ['Fecha', 'PDV', 'Producto', 'Estado', 'Muestras', 'Ventas asistidas'],
            rows: data.activaciones.map((a) => [
              a.fecha,
              a.clienteNombre,
              a.productoResumen,
              a.estado,
              a.muestrasEntregadas,
              a.ventasAsistidasUnidades,
            ]),
          },
        ],
      },
      'portal-cliente'
    );
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-white p-4 sm:p-8 space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold">Portal Cliente · CODIZULCA</h1>
          <p className="text-xs text-zinc-400">Vista de solo lectura de tus puntos de venta autorizados.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} title="Actualizar" className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 cursor-pointer">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" onClick={() => void exportXlsx()} disabled={!data} className="px-3 py-2 rounded-xl bg-red-600 text-xs font-bold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer">
            <FileSpreadsheet className="w-4 h-4" /> Excel
          </button>
          <button type="button" onClick={() => window.print()} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer">
            <Download className="w-4 h-4" /> PDF
          </button>
          {onSignOut && (
            <button type="button" onClick={onSignOut} className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-bold cursor-pointer">
              Salir
            </button>
          )}
        </div>
      </header>

      {error && <div role="alert" className="rounded-xl bg-red-950/50 border border-red-500/40 px-4 py-3 text-xs text-red-200">{error}</div>}
      {loading && <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="w-4 h-4 animate-spin" /> Cargando...</div>}

      {data && (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[
              ['PDV autorizados', data.kpis.totalPdvs],
              ['Activaciones', data.kpis.totalActivaciones],
              ['Completadas', data.kpis.completadas],
              ['Muestras entregadas', data.kpis.muestras],
              ['Ventas asistidas', data.kpis.ventasAsistidas],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-2xl bg-zinc-950 border border-white/10 p-4">
                <span className="text-[10px] uppercase font-mono text-zinc-500">{label}</span>
                <div className="text-2xl font-black">{value}</div>
              </div>
            ))}
          </section>

          <section className="rounded-2xl bg-zinc-950 border border-white/10 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-zinc-400 text-left">
                <tr>
                  {['Fecha', 'PDV', 'Producto', 'Estado', 'Muestras', 'Ventas'].map((h) => (
                    <th key={h} className="px-3 py-2 font-bold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.activaciones.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-zinc-500">Sin activaciones para tus PDV.</td></tr>
                )}
                {data.activaciones.map((a) => (
                  <tr key={a.id} className="border-t border-white/5">
                    <td className="px-3 py-2 font-mono">{a.fecha}</td>
                    <td className="px-3 py-2">{a.clienteNombre}</td>
                    <td className="px-3 py-2">{a.productoResumen}</td>
                    <td className="px-3 py-2">{a.estado}</td>
                    <td className="px-3 py-2">{a.muestrasEntregadas}</td>
                    <td className="px-3 py-2">{a.ventasAsistidasUnidades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
};
