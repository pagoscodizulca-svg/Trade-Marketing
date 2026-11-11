import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CloudCheck, Circle, MessageSquareWarning, SmartphoneNfc, Undo2, User, UserCheck } from 'lucide-react';
import type { EntregaVista } from '../../types';
import { estiloProducto, etiquetaProducto } from '../../utils/format';

interface EntregaCardProps {
  entrega: EntregaVista;
  onToggle: (id: string) => void;
  onNota: (id: string, nota: string) => void;
}

export function EntregaCard({ entrega: e, onToggle, onNota }: EntregaCardProps) {
  const [confirmarDeshacer, setConfirmarDeshacer] = useState(false);
  const [notaAbierta, setNotaAbierta] = useState(e.notas_chofer.trim() !== '');
  const [borrador, setBorrador] = useState(e.notas_chofer);
  const editando = useRef(false);

  // Mantiene la nota sincronizada si cambia desde otra pestaña/dispositivo.
  useEffect(() => {
    if (!editando.current) setBorrador(e.notas_chofer);
  }, [e.notas_chofer]);

  const guardarNota = () => {
    editando.current = false;
    if (borrador !== e.notas_chofer) onNota(e.id, borrador.trim());
  };

  return (
    <article
      data-testid={`entrega-${e.id}`}
      data-completado={e.completado}
      data-sync={e.sync ?? 'ninguno'}
      className={`rounded-2xl border-[3px] p-4 shadow-sm transition-colors ${
        e.completado ? 'bg-green-100 border-green-600' : 'bg-white border-zinc-300'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[11px] font-black tracking-wide text-zinc-600 bg-zinc-100 border border-zinc-300 rounded px-1.5 py-0.5">
          {e.numero_grupo_turno}
        </span>
        {e.completado && (
          <span
            data-testid={`hora-${e.id}`}
            className="text-sm font-black text-green-800 bg-green-200 border border-green-700 rounded-full px-2.5 py-0.5"
          >
            ✔ Entregado {e.hora_entrega}
          </span>
        )}
      </div>

      <h3 className="text-2xl font-black leading-tight text-ink break-words">{e.cliente}</h3>

      <div className="mt-2.5">
        <span
          className={`inline-block text-lg font-black tracking-wide px-3.5 py-1 rounded-lg ${estiloProducto(e.producto).chip}`}
        >
          {etiquetaProducto(e.producto)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-1 min-[420px]:grid-cols-2 gap-2 text-base">
        <div className="flex items-center gap-2 text-zinc-800">
          <User className="w-5 h-5 shrink-0 text-zinc-500" />
          <div>
            <dt className="text-[11px] font-bold uppercase text-zinc-500 leading-none">Vendedor</dt>
            <dd className="font-extrabold">{e.vendedor || '—'}</dd>
          </div>
        </div>
        <div className="flex items-center gap-2 text-zinc-800">
          <UserCheck className="w-5 h-5 shrink-0 text-zinc-500" />
          <div>
            <dt className="text-[11px] font-bold uppercase text-zinc-500 leading-none">Promotora que recibe</dt>
            <dd className="font-extrabold">{e.promotora || '—'}</dd>
          </div>
        </div>
      </dl>

      {/* Estado de sincronización de la tarjeta (solo si se marcó sin conexión) */}
      {e.sync === 'pendiente' && (
        <p
          data-testid={`sync-tag-${e.id}`}
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-amber-900 bg-amber-100 border border-amber-500 rounded-full px-2.5 py-1"
        >
          <SmartphoneNfc className="w-3.5 h-3.5" aria-hidden="true" />
          Guardado en teléfono (Pendiente de red)
        </p>
      )}
      {e.sync === 'sincronizado_offline' && (
        <p
          data-testid={`sync-tag-${e.id}`}
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-green-900 bg-green-200 border border-green-700 rounded-full px-2.5 py-1"
        >
          <CloudCheck className="w-3.5 h-3.5" aria-hidden="true" />
          Sincronizado en servidor
        </p>
      )}

      {/* Acción principal */}
      {!e.completado ? (
        <button
          data-testid={`entrega-toggle-${e.id}`}
          onClick={() => onToggle(e.id)}
          className="mt-4 w-full min-h-16 rounded-xl bg-ink text-white text-lg font-black flex items-center justify-center gap-3 active:scale-[0.99] hover:bg-zinc-800 transition"
        >
          <Circle className="w-7 h-7 text-red-500" />
          Stand + Producto Entregado
        </button>
      ) : confirmarDeshacer ? (
        <div className="mt-4 rounded-xl border-2 border-red-600 bg-red-50 p-3">
          <p className="font-bold text-ink mb-2">¿Deshacer esta entrega?</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              data-testid={`entrega-deshacer-si-${e.id}`}
              onClick={() => {
                setConfirmarDeshacer(false);
                onToggle(e.id);
              }}
              className="min-h-12 rounded-lg bg-red-700 text-white font-black"
            >
              Sí, deshacer
            </button>
            <button
              onClick={() => setConfirmarDeshacer(false)}
              className="min-h-12 rounded-lg bg-white border-2 border-zinc-400 text-zinc-800 font-black"
            >
              No
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex gap-2">
          <div className="flex-1 min-h-16 rounded-xl bg-green-700 text-white text-lg font-black flex items-center justify-center gap-3">
            <CheckCircle2 className="w-7 h-7" />
            Entregado
          </div>
          <button
            data-testid={`entrega-deshacer-${e.id}`}
            onClick={() => setConfirmarDeshacer(true)}
            aria-label="Deshacer entrega"
            className="w-16 min-h-16 rounded-xl bg-white border-2 border-zinc-400 text-zinc-700 grid place-items-center hover:bg-zinc-50"
          >
            <Undo2 className="w-6 h-6" />
          </button>
        </div>
      )}

      {/* Nota / incidencia */}
      <div className="mt-3">
        {!notaAbierta ? (
          <button
            data-testid={`nota-abrir-${e.id}`}
            onClick={() => setNotaAbierta(true)}
            className="min-h-12 w-full rounded-lg border-2 border-dashed border-zinc-400 text-zinc-700 font-bold flex items-center justify-center gap-2 hover:bg-zinc-50"
          >
            <MessageSquareWarning className="w-5 h-5" />
            Agregar nota / incidencia
          </button>
        ) : (
          <label className="block">
            <span className="text-xs font-black uppercase text-red-800 flex items-center gap-1.5 mb-1">
              <MessageSquareWarning className="w-4 h-4" />
              Nota / incidencia
            </span>
            <textarea
              data-testid={`nota-${e.id}`}
              value={borrador}
              rows={2}
              placeholder="Ej.: Cliente cerrado, se dejó con el encargado…"
              onFocus={() => (editando.current = true)}
              onChange={(ev) => setBorrador(ev.target.value)}
              onBlur={guardarNota}
              className="w-full rounded-lg border-2 border-red-600 bg-red-50 p-2.5 text-base font-semibold text-ink placeholder:text-zinc-500 focus:outline-none focus:ring-4 focus:ring-red-300"
            />
          </label>
        )}
      </div>
    </article>
  );
}
