import { useState, type FormEvent } from 'react';
import { PRODUCTOS, TURNOS, type Entrega, type Turno } from '../../types';
import { PRODUCTO_LABEL } from '../../utils/format';
import { Modal } from '../common/Modal';

interface AddStopModalProps {
  dias: string[];
  onClose: () => void;
  onSave: (e: Omit<Entrega, 'id'>) => Promise<void>;
}

const INPUT =
  'w-full min-h-11 rounded-lg border-2 border-zinc-300 px-3 text-base font-semibold focus:outline-none focus:border-ink focus:ring-4 focus:ring-red-200';

const DIAS_SEMANA_ES = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'] as const;

function normalizeStopDateInput(raw: string): string | null {
  const clean = raw.trim().toUpperCase();
  if (/^[A-ZÁÉÍÓÚÑ]+ \d{1,2}$/.test(clean)) {
    return clean.replace(/(\d+)$/, (n) => n.padStart(2, '0'));
  }
  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const dt = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    if (!Number.isNaN(dt.getTime())) {
      const dayName = DIAS_SEMANA_ES[dt.getDay()] ?? 'DÍA';
      return `${dayName} ${isoMatch[3]}`;
    }
  }
  return null;
}

export function AddStopModal({ dias, onClose, onSave }: AddStopModalProps) {
  const [fecha, setFecha] = useState('');
  const [turno, setTurno] = useState<Turno | ''>('');
  const [grupo, setGrupo] = useState('');
  const [cliente, setCliente] = useState('');
  const [producto, setProducto] = useState<string>('');
  const [vendedor, setVendedor] = useState('');
  const [promotora, setPromotora] = useState('');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const fechaNorm = normalizeStopDateInput(fecha);
    if (!fechaNorm) {
      return setError('La fecha debe tener el formato "JUEVES 12" o "YYYY-MM-DD".');
    }
    if (!turno) return setError('Seleccione el turno.');
    if (!cliente.trim()) return setError('El cliente es obligatorio.');
    if (!producto.trim()) return setError('Seleccione o ingrese el producto.');
    setError('');
    setGuardando(true);
    try {
      await onSave({
        fecha: fechaNorm,
        turno,
        numero_grupo_turno: grupo.trim().toUpperCase() || turno,
        cliente: cliente.trim().toUpperCase(),
        producto: producto.trim().toUpperCase(),
        vendedor: vendedor.trim().toUpperCase(),
        promotora: promotora.trim().toUpperCase(),
        stand_entregado: false,
        producto_entregado: false,
        completado: false,
        estado_logistico: 'PENDIENTE',
        hora_entrega: null,
        notas_chofer: '',
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la parada.');
      setGuardando(false);
    }
  };

  const campo = (label: string, el: React.ReactNode) => (
    <label className="block">
      <span className="text-xs font-black uppercase text-zinc-600">{label}</span>
      {el}
    </label>
  );

  return (
    <Modal titulo="Agregar nueva parada" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" data-testid="form-agregar-parada">
        <div className="grid grid-cols-2 gap-3">
          {campo(
            'Fecha',
            <input
              className={INPUT}
              list="dias-existentes"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              placeholder="DÍA NN"
              name="fecha"
            />,
          )}
          <datalist id="dias-existentes">
            {dias.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          {campo(
            'Turno',
            <select className={INPUT} value={turno} onChange={(e) => setTurno(e.target.value as Turno | '')} name="turno">
              <option value="">Seleccione…</option>
              {TURNOS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>,
          )}
        </div>
        {campo(
          'Grupo del turno (opcional)',
          <input className={INPUT} value={grupo} onChange={(e) => setGrupo(e.target.value)} name="grupo" />,
        )}
        {campo(
          'Cliente',
          <input className={INPUT} value={cliente} onChange={(e) => setCliente(e.target.value)} name="cliente" autoFocus />,
        )}
        {campo(
          'Producto',
          <>
            <input
              className={INPUT}
              list="productos-preset"
              value={producto}
              onChange={(e) => setProducto(e.target.value)}
              placeholder="Ej: MORTADELA, VENCAMPO o producto del catálogo"
              name="producto"
            />
            <datalist id="productos-preset">
              {PRODUCTOS.map((p) => (
                <option key={p} value={p}>
                  {PRODUCTO_LABEL[p]}
                </option>
              ))}
            </datalist>
          </>,
        )}
        <div className="grid grid-cols-2 gap-3">
          {campo('Vendedor', <input className={INPUT} value={vendedor} onChange={(e) => setVendedor(e.target.value)} name="vendedor" />)}
          {campo('Promotora', <input className={INPUT} value={promotora} onChange={(e) => setPromotora(e.target.value)} name="promotora" />)}
        </div>
        {error && (
          <p role="alert" className="text-sm font-bold text-red-700 bg-red-50 border border-red-300 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="min-h-11 px-4 rounded-lg border-2 border-zinc-300 font-bold">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={guardando}
            data-testid="guardar-parada"
            className="min-h-11 px-5 rounded-lg bg-ink text-white font-black disabled:opacity-60"
          >
            Guardar parada
          </button>
        </div>
      </form>
    </Modal>
  );
}
