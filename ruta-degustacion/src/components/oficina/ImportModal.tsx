import { useRef, useState } from 'react';
import { AlertTriangle, Download, FileSpreadsheet, Upload } from 'lucide-react';
import { Modal } from '../common/Modal';
import { PLANTILLA_CSV, importarArchivo, matrizAEntregas, parseCsv, type ImportResult } from '../../utils/csvImport';

interface ImportModalProps {
  onClose: () => void;
  onConfirm: (result: ImportResult, modo: 'reemplazar' | 'agregar') => Promise<void>;
}

export function ImportModal({ onClose, onConfirm }: ImportModalProps) {
  const [resultado, setResultado] = useState<ImportResult | null>(null);
  const [nombre, setNombre] = useState('');
  const [pegado, setPegado] = useState('');
  const [modo, setModo] = useState<'reemplazar' | 'agregar'>('agregar');
  const [cargando, setCargando] = useState(false);
  const [errorGeneral, setErrorGeneral] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const descargarPlantilla = () => {
    const blob = new Blob(['\uFEFF' + PLANTILLA_CSV], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'plantilla_cronograma.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onArchivo = async (file?: File) => {
    if (!file) return;
    setCargando(true);
    setErrorGeneral('');
    setNombre(file.name);
    try {
      setResultado(await importarArchivo(file));
    } catch (err) {
      setResultado(null);
      setErrorGeneral(err instanceof Error ? err.message : 'No se pudo leer el archivo.');
    } finally {
      setCargando(false);
    }
  };

  const procesarTexto = () => {
    setErrorGeneral('');
    setNombre('Texto pegado');
    setResultado(matrizAEntregas(parseCsv(pegado)));
  };

  const confirmar = async () => {
    if (!resultado || resultado.rows.length === 0) return;
    setCargando(true);
    try {
      await onConfirm(resultado, modo);
      onClose();
    } catch (err) {
      setErrorGeneral(err instanceof Error ? err.message : 'No se pudo importar.');
      setCargando(false);
    }
  };

  return (
    <Modal titulo="Importar cronograma (CSV / Excel)" onClose={onClose} ancho="max-w-2xl">
      <div className="space-y-4" data-testid="modal-importar">
        <p className="text-sm text-zinc-700">
          Columnas: <b>FECHA, TURNO, GRUPO, CLIENTE, PRODUCTO, VENDEDOR, PROMOTORA</b> (opcionales: ESTADO, HORA ENTREGA).
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={descargarPlantilla}
            className="min-h-11 px-3.5 rounded-lg border-2 border-zinc-300 font-bold flex items-center gap-2 hover:bg-zinc-50"
          >
            <Download className="w-4 h-4" /> Descargar plantilla
          </button>
          <button
            onClick={() => inputRef.current?.click()}
            className="min-h-11 px-3.5 rounded-lg bg-ink text-white font-black flex items-center gap-2"
          >
            <Upload className="w-4 h-4" /> Elegir archivo
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.txt,.xlsx,text/csv"
            className="hidden"
            data-testid="input-archivo"
            onChange={(e) => {
              void onArchivo(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>

        <details className="rounded-lg border border-zinc-300 p-2.5">
          <summary className="font-bold text-sm cursor-pointer">…o pegar contenido CSV</summary>
          <textarea
            data-testid="texto-csv"
            value={pegado}
            onChange={(e) => setPegado(e.target.value)}
            rows={5}
            placeholder={'FECHA,TURNO,GRUPO,CLIENTE,PRODUCTO,VENDEDOR,PROMOTORA'}
            className="mt-2 w-full rounded-lg border-2 border-zinc-300 p-2 font-mono text-xs"
          />
          <button
            onClick={procesarTexto}
            disabled={!pegado.trim()}
            data-testid="procesar-texto"
            className="mt-2 min-h-10 px-3 rounded-lg bg-zinc-700 text-white font-bold text-sm disabled:opacity-50"
          >
            Procesar texto
          </button>
        </details>

        {cargando && <p className="text-sm font-bold text-zinc-600">Procesando…</p>}
        {errorGeneral && (
          <p role="alert" className="text-sm font-bold text-red-700 bg-red-50 border border-red-300 rounded-lg px-3 py-2">
            {errorGeneral}
          </p>
        )}

        {resultado && (
          <div className="space-y-3" data-testid="import-preview">
            <div className="flex items-center gap-2 text-sm font-bold text-zinc-800">
              <FileSpreadsheet className="w-4 h-4" /> {nombre}:{' '}
              <span className="text-green-700">{resultado.rows.length} válidas</span>
              {resultado.errors.length > 0 && <span className="text-red-700">· {resultado.errors.length} con error</span>}
            </div>

            {resultado.errors.length > 0 && (
              <ul className="max-h-32 overflow-auto text-xs bg-red-50 border border-red-300 rounded-lg p-2 space-y-0.5">
                {resultado.errors.map((er, i) => (
                  <li key={i} className="flex gap-1.5 text-red-800">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{er.fila > 0 && <b>Fila {er.fila}: </b>}{er.mensaje}</span>
                  </li>
                ))}
              </ul>
            )}

            {resultado.rows.length > 0 && (
              <div className="max-h-44 overflow-auto border border-zinc-300 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-100 sticky top-0">
                    <tr>
                      {['Fecha', 'Turno', 'Cliente', 'Producto', 'Vendedor', 'Promotora', 'Estado'].map((h) => (
                        <th key={h} className="text-left px-2 py-1 font-black">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.rows.slice(0, 50).map((r, i) => (
                      <tr key={i} className="border-t border-zinc-200">
                        <td className="px-2 py-1">{r.fecha}</td>
                        <td className="px-2 py-1">{r.numero_grupo_turno}</td>
                        <td className="px-2 py-1 font-bold">{r.cliente}</td>
                        <td className="px-2 py-1">{r.producto}</td>
                        <td className="px-2 py-1">{r.vendedor}</td>
                        <td className="px-2 py-1">{r.promotora}</td>
                        <td className="px-2 py-1">{r.completado ? 'COMPLETADO' : 'PENDIENTE'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <fieldset className="grid sm:grid-cols-2 gap-2">
              <legend className="text-xs font-black uppercase text-zinc-600 mb-1">Modo de importación</legend>
              {(
                [
                  ['agregar', 'Agregar al cronograma existente'],
                  ['reemplazar', 'Reemplazar todo el cronograma'],
                ] as const
              ).map(([v, label]) => (
                <label
                  key={v}
                  className={`flex items-center gap-2 rounded-lg border-2 px-3 min-h-11 font-bold text-sm cursor-pointer ${
                    modo === v ? 'border-ink bg-zinc-50' : 'border-zinc-300'
                  }`}
                >
                  <input type="radio" name="modo-import" checked={modo === v} onChange={() => setModo(v)} />
                  {label}
                </label>
              ))}
            </fieldset>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="min-h-11 px-4 rounded-lg border-2 border-zinc-300 font-bold">
            Cancelar
          </button>
          <button
            onClick={confirmar}
            disabled={!resultado || resultado.rows.length === 0 || cargando}
            data-testid="confirmar-importar"
            className="min-h-11 px-5 rounded-lg bg-ink text-white font-black disabled:opacity-50"
          >
            Importar {resultado?.rows.length ? `${resultado.rows.length} paradas` : ''}
          </button>
        </div>
      </div>
    </Modal>
  );
}
