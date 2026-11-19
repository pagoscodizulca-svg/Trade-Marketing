import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Package, RefreshCw, ShieldAlert } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  createIncidenciaPdv,
  evaluateIncidenciaSlaStatus,
  fetchIncidenciasSignedUrls,
  fetchPopIncidenciasBundle,
  registerMovimientoPop,
  updateIncidenciaEstado,
  upsertMaterialPopInventario,
  type EstadoIncidenciaPdv,
  type PopIncidenciasBundle,
  type SeveridadIncidenciaPdv,
  type TipoIncidenciaPdv,
  type TipoMovimientoPop,
} from '../../services/popIncidenciasService';

type SubTab = 'pop' | 'incidencias';

const EMPTY: PopIncidenciasBundle = {
  inventarioPop: [],
  movimientosPop: [],
  incidenciasPdv: [],
  alertasGeocerca: [],
};

const SEVERIDADES: SeveridadIncidenciaPdv[] = ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'];
const TIPOS: TipoIncidenciaPdv[] = [
  'QUIEBRE_STOCK',
  'PRECIO_INCORRECTO',
  'MATERIAL_POP_DANADO',
  'COMPETENCIA_AGRESIVA',
  'CALIDAD_PRODUCTO',
  'ACCESO_PDV',
  'OTRO',
];

const inputCls = 'w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white';

/** Material POP e Incidencias en PDV. `contraloria` opera en solo lectura. */
export const PopAndIncidenciasView: React.FC = () => {
  const { verifiedIamRole } = useApp();
  const readOnly = verifiedIamRole === 'contraloria';
  const [tab, setTab] = useState<SubTab>('pop');
  const [bundle, setBundle] = useState<PopIncidenciasBundle>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  const [newItem, setNewItem] = useState({ sku: '', nombre: '', stock: '0', minimo: '0' });
  const [mov, setMov] = useState({
    materialId: '',
    tipo: 'ENTREGA_PDV' as TipoMovimientoPop,
    cantidad: '1',
    pdv: '',
    responsable: '',
  });
  const [inc, setInc] = useState({
    pdv: '',
    tipo: 'QUIEBRE_STOCK' as TipoIncidenciaPdv,
    severidad: 'MEDIA' as SeveridadIncidenciaPdv,
    descripcion: '',
  });
  const [photo, setPhoto] = useState<File | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const b = await fetchPopIncidenciasBundle();
      setBundle(b);
      const withPhoto = b.incidenciasPdv.filter((i) => i.fotoStoragePath).map((i) => i.id);
      setSignedUrls(withPhoto.length ? await fetchIncidenciasSignedUrls(withPhoto) : {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando datos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>, okMsg: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(okMsg);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operación fallida.');
    } finally {
      setBusy(false);
    }
  };

  const lowStock = useMemo(
    () => bundle.inventarioPop.filter((i) => i.activo && i.stockDisponible <= i.stockMinimo),
    [bundle.inventarioPop]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex rounded-xl bg-zinc-950 border border-white/10 p-1 gap-1">
          {(
            [
              ['pop', 'Inventario y Entregas POP'],
              ['incidencias', 'Incidencias y SLA'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${tab === id ? 'bg-red-600 text-white' : 'text-zinc-400'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void load()} className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 cursor-pointer" title="Actualizar">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {readOnly && <div className="text-xs text-amber-200 bg-amber-950/40 border border-amber-700/40 rounded-xl px-3 py-2">Modo solo lectura (Contraloría).</div>}
      {error && <div role="alert" className="rounded-xl bg-red-950/50 border border-red-500/40 px-4 py-2 text-xs text-red-200 flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0" />{error}</div>}
      {notice && <div className="rounded-xl bg-emerald-950/50 border border-emerald-500/40 px-4 py-2 text-xs text-emerald-200">{notice}</div>}
      {loading && <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="w-4 h-4 animate-spin" />Cargando...</div>}

      {tab === 'pop' && (
        <div className="space-y-4">
          {lowStock.length > 0 && (
            <div className="text-xs text-red-200 bg-red-950/40 border border-red-600/40 rounded-xl px-3 py-2">
              <Package className="w-3.5 h-3.5 inline mr-1" />
              Stock bajo: {lowStock.map((i) => i.nombre).join(', ')}
            </div>
          )}

          {!readOnly && (
            <div className="grid md:grid-cols-2 gap-4">
              <form
                className="rounded-2xl bg-zinc-950 border border-white/10 p-4 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await upsertMaterialPopInventario({
                      sku: newItem.sku,
                      nombre: newItem.nombre,
                      categoria: 'EXHIBIDOR',
                      marca: 'GENERAL',
                      unidad: 'UND',
                      stockDisponible: Number(newItem.stock),
                      stockMinimo: Number(newItem.minimo),
                      activo: true,
                    });
                    setNewItem({ sku: '', nombre: '', stock: '0', minimo: '0' });
                  }, 'Material POP guardado.');
                }}
              >
                <h3 className="text-sm font-extrabold">Nuevo material POP</h3>
                <input className={inputCls} placeholder="SKU" value={newItem.sku} onChange={(e) => setNewItem((p) => ({ ...p, sku: e.target.value }))} />
                <input className={inputCls} placeholder="Nombre" value={newItem.nombre} onChange={(e) => setNewItem((p) => ({ ...p, nombre: e.target.value }))} />
                <div className="grid grid-cols-2 gap-2">
                  <input className={inputCls} type="number" min={0} placeholder="Stock" value={newItem.stock} onChange={(e) => setNewItem((p) => ({ ...p, stock: e.target.value }))} />
                  <input className={inputCls} type="number" min={0} placeholder="Mínimo" value={newItem.minimo} onChange={(e) => setNewItem((p) => ({ ...p, minimo: e.target.value }))} />
                </div>
                <button disabled={busy} className="px-4 py-2 rounded-xl bg-red-600 text-xs font-bold disabled:opacity-50 cursor-pointer">Guardar</button>
              </form>

              <form
                className="rounded-2xl bg-zinc-950 border border-white/10 p-4 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await registerMovimientoPop({
                      materialId: mov.materialId,
                      tipoMovimiento: mov.tipo,
                      cantidad: Number(mov.cantidad),
                      pdvNombre: mov.pdv,
                      responsableNombre: mov.responsable,
                    });
                  }, 'Movimiento registrado.');
                }}
              >
                <h3 className="text-sm font-extrabold">Registrar movimiento</h3>
                <select className={inputCls} value={mov.materialId} onChange={(e) => setMov((p) => ({ ...p, materialId: e.target.value }))}>
                  <option value="">Material...</option>
                  {bundle.inventarioPop.map((i) => (
                    <option key={i.id} value={i.id}>{i.sku} · {i.nombre} ({i.stockDisponible})</option>
                  ))}
                </select>
                <select className={inputCls} value={mov.tipo} onChange={(e) => setMov((p) => ({ ...p, tipo: e.target.value as TipoMovimientoPop }))}>
                  <option value="ENTREGA_PDV">Entrega a PDV</option>
                  <option value="REINGRESO_ALMACEN">Reingreso a almacén</option>
                  <option value="BAJA_DETERIORO">Baja por deterioro</option>
                </select>
                <input className={inputCls} type="number" min={1} value={mov.cantidad} onChange={(e) => setMov((p) => ({ ...p, cantidad: e.target.value }))} />
                <input className={inputCls} placeholder="PDV / destino" value={mov.pdv} onChange={(e) => setMov((p) => ({ ...p, pdv: e.target.value }))} />
                <input className={inputCls} placeholder="Responsable" value={mov.responsable} onChange={(e) => setMov((p) => ({ ...p, responsable: e.target.value }))} />
                <button disabled={busy} className="px-4 py-2 rounded-xl bg-red-600 text-xs font-bold disabled:opacity-50 cursor-pointer">Registrar</button>
              </form>
            </div>
          )}

          <div className="rounded-2xl bg-zinc-950 border border-white/10 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-zinc-400 text-left"><tr>{['SKU', 'Material', 'Stock', 'Mínimo', 'Sede'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
              <tbody>
                {bundle.inventarioPop.map((i) => (
                  <tr key={i.id} className="border-t border-white/5">
                    <td className="px-3 py-2 font-mono">{i.sku}</td>
                    <td className="px-3 py-2">{i.nombre}</td>
                    <td className="px-3 py-2">{i.stockDisponible}</td>
                    <td className="px-3 py-2">{i.stockMinimo}</td>
                    <td className="px-3 py-2">{i.sucursal ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'incidencias' && (
        <div className="space-y-4">
          {!readOnly && (
            <form
              className="rounded-2xl bg-zinc-950 border border-white/10 p-4 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await createIncidenciaPdv(
                    {
                      pdvNombre: inc.pdv,
                      tipoIncidencia: inc.tipo,
                      severidad: inc.severidad,
                      descripcion: inc.descripcion,
                    },
                    photo
                  );
                  setInc({ pdv: '', tipo: 'QUIEBRE_STOCK', severidad: 'MEDIA', descripcion: '' });
                  setPhoto(null);
                }, 'Incidencia registrada.');
              }}
            >
              <h3 className="text-sm font-extrabold flex items-center gap-1.5"><ShieldAlert className="w-4 h-4 text-red-400" />Reportar incidencia</h3>
              <input className={inputCls} placeholder="Punto de venta" value={inc.pdv} onChange={(e) => setInc((p) => ({ ...p, pdv: e.target.value }))} />
              <div className="grid grid-cols-2 gap-2">
                <select className={inputCls} value={inc.tipo} onChange={(e) => setInc((p) => ({ ...p, tipo: e.target.value as TipoIncidenciaPdv }))}>
                  {TIPOS.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                </select>
                <select className={inputCls} value={inc.severidad} onChange={(e) => setInc((p) => ({ ...p, severidad: e.target.value as SeveridadIncidenciaPdv }))}>
                  {SEVERIDADES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <textarea className={inputCls} rows={2} maxLength={1000} placeholder="Descripción" value={inc.descripcion} onChange={(e) => setInc((p) => ({ ...p, descripcion: e.target.value }))} />
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} className="text-xs" />
              <button disabled={busy} className="px-4 py-2 rounded-xl bg-red-600 text-xs font-bold disabled:opacity-50 cursor-pointer">Registrar</button>
            </form>
          )}

          <div className="space-y-2">
            {bundle.incidenciasPdv.map((i) => {
              const sla = evaluateIncidenciaSlaStatus(i);
              return (
                <article key={i.id} className="rounded-2xl bg-zinc-950 border border-white/10 p-3 text-xs space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-bold">{i.codigoIncidencia}</span>
                    <span className="px-2 py-0.5 rounded bg-zinc-900">{i.severidad}</span>
                    <span className="px-2 py-0.5 rounded bg-zinc-900">{i.estado}</span>
                    <span className={sla.isOverdue ? 'text-red-400 font-bold' : 'text-zinc-400'}>{sla.badgeLabel}</span>
                  </div>
                  <div className="font-bold">{i.pdvNombre} · {i.tipoIncidencia.replace(/_/g, ' ')}</div>
                  <p className="text-zinc-300">{i.descripcion}</p>
                  {signedUrls[i.id] && (
                    <a href={signedUrls[i.id]} target="_blank" rel="noopener noreferrer" className="text-red-400 underline">Ver foto (enlace temporal)</a>
                  )}
                  {!readOnly && i.estado !== 'CERRADA' && (
                    <div className="flex gap-2 pt-1">
                      {(['EN_PROCESO', 'RESUELTA', 'CERRADA'] as EstadoIncidenciaPdv[]).map((st) => (
                        <button
                          key={st}
                          type="button"
                          disabled={busy || i.estado === st}
                          onClick={() => void run(async () => { await updateIncidenciaEstado({ id: i.id, estado: st }); }, `Incidencia ${st}.`)}
                          className="px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-700 disabled:opacity-40 cursor-pointer"
                        >
                          {st.replace('_', ' ')}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
            {bundle.incidenciasPdv.length === 0 && !loading && <p className="text-xs text-zinc-500">Sin incidencias registradas.</p>}
          </div>
        </div>
      )}
    </div>
  );
};
