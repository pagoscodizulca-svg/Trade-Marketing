import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Calendar, Eraser, PenTool, Plus, Trash2 } from 'lucide-react';
import {
  SolicitudContraloriaEstado,
  SolicitudProductoRowItem,
} from '../../types';
import { useApp } from '../../context/AppContext';
import { isoToDdMmYyyy } from '../../services/solicitudesContraloriaService';

export interface SolicitudProductosFormatSheetProps {
  mode: 'edit' | 'readonly';
  codigoCorrelativo: string;
  fechaSolicitud: string; // DD/MM/YYYY
  fechaIso?: string; // YYYY-MM-DD
  dirigidoA: string;
  paraSerUtilizado: string;
  rows: SolicitudProductoRowItem[];
  observacion: string;
  solicitadoPor: string;
  firmaDigitalTexto?: string;
  firmaDigitalImagen?: string;
  departamentoSolicitante?: string;
  estado?: SolicitudContraloriaEstado;
  notaContraloria?: string;
  resueltoPor?: string;
  resueltoAt?: string;
  onChangeFechaIso?: (nextIso: string, nextSlash: string) => void;
  onChangeDirigidoA?: (value: string) => void;
  onChangeParaSerUtilizado?: (value: string) => void;
  onChangeRow?: (index: number, field: 'producto' | 'cantidad', value: string) => void;
  onAddRow?: () => void;
  onRemoveExtraRow?: (index: number) => void;
  onChangeObservacion?: (value: string) => void;
  onChangeSolicitadoPor?: (value: string) => void;
  onChangeFirmaDigitalImagen?: (dataUrl: string | undefined) => void;
}

export const SolicitudProductosFormatSheet: React.FC<
  SolicitudProductosFormatSheetProps
> = ({
  mode,
  codigoCorrelativo,
  fechaSolicitud,
  fechaIso,
  dirigidoA,
  paraSerUtilizado,
  rows,
  observacion,
  solicitadoPor,
  firmaDigitalTexto,
  firmaDigitalImagen,
  departamentoSolicitante = 'MERCADEO Y PUBLICIDAD',
  estado,
  notaContraloria,
  resueltoPor,
  resueltoAt,
  onChangeFechaIso,
  onChangeDirigidoA,
  onChangeParaSerUtilizado,
  onChangeRow,
  onAddRow,
  onRemoveExtraRow,
  onChangeObservacion,
  onChangeSolicitadoPor,
  onChangeFirmaDigitalImagen,
}) => {
  const isEdit = mode === 'edit';
  const datalistId = useId();
  const { module1Bundle } = useApp();
  // Sugerencias de productos derivadas SOLO de registros sincronizados (el texto libre sigue permitido)
  const productSuggestions = useMemo<string[]>(() => {
    const names = new Set<string>();
    (module1Bundle?.inventorySampling || []).forEach((i) => i.productName && names.add(String(i.productName).trim().toUpperCase()));
    (module1Bundle?.priceComparisons || []).forEach((p) => p.ownProduct && p.ownProduct !== 'Producto Codizulca' && names.add(String(p.ownProduct).trim().toUpperCase()));
    return Array.from(names).filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'));
  }, [module1Bundle]);
  const [isDrawingPadOpen, setIsDrawingPadOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);

  // Garantizar siempre mínimo 10 filas visibles numeradas del 1 al 10 (o más si se agregaron)
  const displayRows: SolicitudProductoRowItem[] =
    rows.length >= 10
      ? rows
      : [
          ...rows,
          ...Array.from({ length: 10 - rows.length }, (_, i) => ({
            itemNumber: rows.length + i + 1,
            producto: '',
            cantidad: '' as const,
          })),
        ];

  useEffect(() => {
    if (!isDrawingPadOpen || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, [isDrawingPadOpen]);

  const getCanvasPoint = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ('touches' in e) {
      const touch = e.touches[0] || e.changedTouches[0];
      return {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY,
      };
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handleStartDraw = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    isDrawingRef.current = true;
    const pt = getCanvasPoint(e);
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
  };

  const handleMoveDraw = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    if (!isDrawingRef.current) return;
    if ('touches' in e) e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const pt = getCanvasPoint(e);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
  };

  const handleEndDraw = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    if (canvasRef.current && onChangeFirmaDigitalImagen) {
      onChangeFirmaDigitalImagen(canvasRef.current.toDataURL('image/png'));
    }
  };

  const handleClearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    onChangeFirmaDigitalImagen?.(undefined);
  };

  const totalUnitsCalculated = displayRows.reduce((sum, r) => {
    const n = r.cantidad === '' ? 0 : Number(r.cantidad);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[680px] max-w-[860px] mx-auto bg-[#FFFFFF] text-[#000000] p-6 sm:p-9 rounded-md shadow-[0_20px_50px_rgba(0,0,0,0.65)] border-2 border-[#000000] font-sans select-text print:shadow-none print:border print:p-4">
        {/* Catálogo de productos Codizulca para sugerencia rápida sin bloquear texto libre */}
        {isEdit && (
          <datalist id={datalistId}>
            {productSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}

        {/* ================================================================= */}
        {/* ENCABEZADO SUPERIOR DERECHO: RECUADRO + CÓDIGO CORRELATIVO + FECHA */}
        {/* ================================================================= */}
        <div className="flex items-start justify-between gap-4 mb-5">
          {/* Identificador institucional sutil superior izquierdo */}
          <div className="pt-1">
            <div className="flex items-center gap-2">
              <img
                src="/codizulca-logo.png"
                alt="CODIZULCA C.A."
                className="w-9 h-9 object-contain"
              />
              <div>
                <span className="block text-sm font-black tracking-wider text-[#DC2626] leading-none">
                  CODIZULCA C.A.
                </span>
                <span className="block text-[9px] font-bold text-neutral-700 uppercase tracking-tight mt-0.5">
                  RIF: J-07011928-0 · Mercadeo y Publicidad
                </span>
              </div>
            </div>
          </div>

          {/* Recuadro corporativo con bordes negros */}
          <div className="flex flex-col items-end">
            <div className="w-64 sm:w-72 border-2 border-[#000000] bg-[#FFFFFF] text-center">
              <div className="py-1.5 px-3 border-b-2 border-[#000000] text-xs sm:text-sm font-black tracking-wide text-[#000000] uppercase">
                SOLICITUD DE PRODUCTOS
              </div>
              <div className="py-1.5 px-3 text-sm sm:text-base font-black tracking-widest text-[#000000] font-mono bg-[#FFFFFF]">
                {codigoCorrelativo}
              </div>
            </div>

            {/* Debajo del recuadro: FECHA: DD/MM/YYYY */}
            <div className="mt-2.5 w-64 sm:w-72 flex items-center justify-center gap-2 text-xs sm:text-sm font-black text-[#000000]">
              <span>FECHA:</span>
              {isEdit && onChangeFechaIso ? (
                <label className="inline-flex items-center gap-1.5 cursor-pointer group">
                  <span className="font-mono text-sm font-black underline decoration-dotted decoration-neutral-500 group-hover:text-[#DC2626]">
                    {fechaSolicitud}
                  </span>
                  <span className="relative inline-flex items-center justify-center w-6 h-6 rounded border border-neutral-400 bg-neutral-100 hover:border-[#DC2626] text-neutral-800 no-print">
                    <Calendar className="w-3.5 h-3.5" />
                    <input
                      type="date"
                      aria-label="Seleccionar fecha de solicitud"
                      value={fechaIso || ''}
                      onChange={(e) => {
                        const iso = e.target.value;
                        if (iso) {
                          onChangeFechaIso(iso, isoToDdMmYyyy(iso));
                        }
                      }}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                  </span>
                </label>
              ) : (
                <span className="font-mono text-sm font-black">{fechaSolicitud}</span>
              )}
            </div>
          </div>
        </div>

        {/* ================================================================= */}
        {/* ENCABEZADO SUPERIOR IZQUIERDO: DIRIGIDO A + PARA SER UTILIZADO    */}
        {/* ================================================================= */}
        <div className="space-y-2 mb-3 text-xs sm:text-[13px] text-[#000000]">
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
            <label className="font-black uppercase tracking-tight shrink-0">
              DIRIGIDO AL DEPARTAMENTO:
            </label>
            {isEdit ? (
              <input
                type="text"
                value={dirigidoA}
                onChange={(e) => onChangeDirigidoA?.(e.target.value.toUpperCase())}
                placeholder="CONTRALORÍA"
                className="flex-1 min-w-[180px] px-2 py-1 bg-[#FFFFFF] border-b-2 border-[#000000] focus:border-[#DC2626] focus:outline-none font-bold uppercase text-[#000000]"
              />
            ) : (
              <span className="font-bold uppercase">{dirigidoA || 'CONTRALORÍA'}</span>
            )}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2">
            <label className="font-black uppercase tracking-tight shrink-0">
              PARA SER UTILIZADO:
              {isEdit && <span className="text-[#DC2626] ml-0.5">*</span>}
            </label>
            {isEdit ? (
              <input
                type="text"
                value={paraSerUtilizado}
                onChange={(e) => onChangeParaSerUtilizado?.(e.target.value.toUpperCase())}
                placeholder="EJ. DEGUSTACIONES MARACAIBO DEL 15 AL 17 DE OCTUBRE DE 2026"
                className="flex-1 w-full px-2.5 py-1.5 bg-neutral-50 focus:bg-[#FFFFFF] border-2 border-[#000000] focus:border-[#DC2626] focus:outline-none font-extrabold uppercase text-[#000000] placeholder:text-neutral-400 placeholder:font-normal text-xs sm:text-[13px]"
              />
            ) : (
              <span className="font-extrabold uppercase leading-snug">
                {paraSerUtilizado}
              </span>
            )}
          </div>
        </div>

        {/* ================================================================= */}
        {/* BLOQUE DE TABLA "SOLICITUD"                                       */}
        {/* ================================================================= */}
        <div className="mt-3">
          {/* Barra de título roja (#DC2626) */}
          <div className="bg-[#DC2626] text-[#FFFFFF] font-black text-xs sm:text-sm text-center py-1.5 uppercase tracking-wider border-2 border-[#000000]">
            SOLICITUD
          </div>

          {/* Tabla de 3 columnas con subencabezado #FCA5A5 y bordes negros */}
          <table className="w-full border-collapse border-x-2 border-b-2 border-[#000000] table-fixed">
            <thead>
              <tr className="bg-[#FCA5A5] text-[#000000] text-xs font-black uppercase">
                <th className="w-16 py-1.5 px-2 text-center border-r-2 border-b-2 border-[#000000]">
                  ITEM
                </th>
                <th className="py-1.5 px-3 text-center border-r-2 border-b-2 border-[#000000]">
                  PRODUCTO
                </th>
                <th className="w-32 sm:w-36 py-1.5 px-2 text-center border-b-2 border-[#000000]">
                  CANTIDAD
                </th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, idx) => {
                const itemNum = idx + 1;
                const isExtraRow = idx >= 10;
                return (
                  <tr
                    key={itemNum}
                    className="border-b border-[#000000] last:border-b-2 text-xs sm:text-[13px] bg-[#FFFFFF] hover:bg-red-50/30 transition-colors"
                  >
                    {/* Columna 1: ITEM (ancho estrecho, centrado) */}
                    <td className="py-1 px-2 text-center font-black font-mono text-[#000000] border-r-2 border-[#000000] h-8">
                      {itemNum}
                    </td>

                    {/* Columna 2: PRODUCTO (ancho amplio) */}
                    <td className="p-0 border-r-2 border-[#000000] h-8">
                      {isEdit ? (
                        <input
                          type="text"
                          list={datalistId}
                          value={row.producto}
                          onChange={(e) =>
                            onChangeRow?.(idx, 'producto', e.target.value.toUpperCase())
                          }
                          placeholder={
                            idx === 0
                              ? 'ESCRIBA O SELECCIONE EL PRODUCTO EN MAYÚSCULAS...'
                              : ''
                          }
                          className="w-full h-8 px-2.5 bg-transparent text-[#000000] font-bold uppercase text-xs sm:text-[13px] placeholder:text-neutral-400 placeholder:font-normal focus:bg-red-50/40 focus:outline-none"
                        />
                      ) : (
                        <div className="px-2.5 py-1 font-bold uppercase text-[#000000] min-h-[30px] flex items-center">
                          {row.producto}
                        </div>
                      )}
                    </td>

                    {/* Columna 3: CANTIDAD (ancho medio, numérico) */}
                    <td className="p-0 h-8 relative">
                      {isEdit ? (
                        <div className="flex items-center h-8">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={row.cantidad}
                            onChange={(e) =>
                              onChangeRow?.(idx, 'cantidad', e.target.value)
                            }
                            placeholder={row.producto.trim() ? '0' : ''}
                            className="w-full h-8 px-2 bg-transparent text-center font-mono font-black text-[#000000] text-xs sm:text-[13px] placeholder:text-neutral-400 focus:bg-red-50/40 focus:outline-none"
                          />
                          {isExtraRow && onRemoveExtraRow && (
                            <button
                              type="button"
                              onClick={() => onRemoveExtraRow(idx)}
                              title={`Quitar fila ${itemNum}`}
                              className="px-1.5 h-8 text-neutral-500 hover:text-[#DC2626] transition-colors no-print cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="px-2 py-1 text-center font-mono font-black text-[#000000] min-h-[30px] flex items-center justify-center">
                          {row.cantidad !== '' && Number(row.cantidad) > 0
                            ? row.cantidad
                            : ''}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Barra auxiliar en modo edición para agregar más filas (> 10) y ver sumatoria */}
          <div className="flex items-center justify-between py-1.5 px-1 text-[11px] font-bold text-neutral-700">
            <div>
              {isEdit && onAddRow && (
                <button
                  type="button"
                  onClick={onAddRow}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-[#000000] bg-neutral-100 hover:bg-[#DC2626] hover:text-[#FFFFFF] hover:border-[#DC2626] text-[#000000] text-[11px] font-black uppercase transition-colors cursor-pointer no-print"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Agregar Fila ({displayRows.length + 1})</span>
                </button>
              )}
            </div>
            <div className="font-mono text-xs text-[#000000]">
              TOTAL CANTIDAD SOLICITADA:{' '}
              <span className="font-black text-[#DC2626]">
                {Number(totalUnitsCalculated.toFixed(2))}
              </span>
            </div>
          </div>
        </div>

        {/* ================================================================= */}
        {/* BLOQUE "OBSERVACIÓN"                                              */}
        {/* ================================================================= */}
        <div className="mt-1">
          {/* Barra de título roja (#DC2626) */}
          <div className="bg-[#DC2626] text-[#FFFFFF] font-black text-xs sm:text-sm text-center py-1.5 uppercase tracking-wider border-2 border-[#000000]">
            OBSERVACIÓN
          </div>

          {/* Área con borde negro grueso y texto centrado en mayúsculas */}
          {isEdit ? (
            <textarea
              rows={3}
              value={observacion}
              onChange={(e) => onChangeObservacion?.(e.target.value.toUpperCase())}
              placeholder="EJ. EL PRODUCTO SERÁ RETIRADO EL DÍA MIÉRCOLES EN LA MAÑANA POR EL SR. ARAMIS MORALES, PARA SER ENTREGADO AL DPTO DE MERCADEO"
              className="w-full p-3.5 bg-[#FFFFFF] border-x-2 border-b-2 border-[#000000] focus:outline-none focus:bg-red-50/20 text-center uppercase font-extrabold text-xs sm:text-[13px] text-[#000000] placeholder:text-neutral-400 placeholder:font-normal leading-relaxed resize-y"
            />
          ) : (
            <div className="w-full min-h-[76px] p-4 bg-[#FFFFFF] border-x-2 border-b-2 border-[#000000] flex items-center justify-center text-center uppercase font-extrabold text-xs sm:text-[13px] text-[#000000] leading-relaxed">
              {observacion || 'SIN OBSERVACIONES ADICIONALES'}
            </div>
          )}
        </div>

        {/* ================================================================= */}
        {/* PIE DE FIRMA: SOLICITADO + FIRMA DIGITAL + MERCADEO Y PUBLICIDAD  */}
        {/* ================================================================= */}
        <div className="mt-8 pt-2 flex flex-col items-center sm:items-end sm:pr-8">
          <div className="w-full max-w-md">
            {isEdit && (
              <div className="flex items-center justify-end gap-2 mb-1.5 no-print">
                <button
                  type="button"
                  onClick={() => setIsDrawingPadOpen((prev) => !prev)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-neutral-400 bg-neutral-100 hover:border-[#DC2626] hover:text-[#DC2626] text-[10px] font-bold text-neutral-800 transition-colors cursor-pointer"
                >
                  <PenTool className="w-3 h-3" />
                  <span>
                    {isDrawingPadOpen ? 'Ocultar trazo manual' : 'Firmar a mano (opcional)'}
                  </span>
                </button>
                {firmaDigitalImagen && (
                  <button
                    type="button"
                    onClick={handleClearCanvas}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-300 bg-red-50 text-[10px] font-bold text-[#DC2626] hover:bg-red-100 transition-colors cursor-pointer"
                  >
                    <Eraser className="w-3 h-3" />
                    <span>Limpiar trazo</span>
                  </button>
                )}
              </div>
            )}

            {isEdit && isDrawingPadOpen && (
              <div className="mb-2 p-2 rounded border border-dashed border-neutral-500 bg-neutral-50 no-print">
                <p className="text-[10px] font-bold text-neutral-600 text-center mb-1 uppercase">
                  Dibuje su firma digital con el cursor o pantalla táctil
                </p>
                <canvas
                  ref={canvasRef}
                  width={320}
                  height={80}
                  onMouseDown={handleStartDraw}
                  onMouseMove={handleMoveDraw}
                  onMouseUp={handleEndDraw}
                  onMouseLeave={handleEndDraw}
                  onTouchStart={handleStartDraw}
                  onTouchMove={handleMoveDraw}
                  onTouchEnd={handleEndDraw}
                  className="w-full h-20 bg-[#FFFFFF] border border-neutral-300 rounded cursor-crosshair touch-none"
                />
              </div>
            )}

            <div className="flex items-end gap-2.5">
              <span className="text-xs sm:text-[13px] font-black uppercase tracking-wide text-[#000000] pb-0.5 shrink-0">
                SOLICITADO
              </span>

              <div className="flex-1 flex flex-col items-center">
                {/* Espacio sobre la línea divisoria para firma digital o nombre del solicitante */}
                <div className="w-full min-h-[46px] flex flex-col items-center justify-end pb-1">
                  {firmaDigitalImagen ? (
                    <img
                      src={firmaDigitalImagen}
                      alt="Firma digital del solicitante"
                      className="max-h-12 object-contain mb-0.5"
                    />
                  ) : (
                    <span
                      className="text-lg sm:text-xl text-slate-800 italic font-serif tracking-wide select-none leading-none mb-1"
                      style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
                    >
                      {firmaDigitalTexto || solicitadoPor}
                    </span>
                  )}

                  {isEdit ? (
                    <input
                      type="text"
                      value={solicitadoPor}
                      onChange={(e) => onChangeSolicitadoPor?.(e.target.value)}
                      placeholder="Nombre del solicitante autenticado"
                      className="w-full text-center text-[11px] font-bold uppercase text-neutral-800 bg-transparent focus:bg-neutral-100 focus:outline-none rounded px-1"
                    />
                  ) : (
                    <span className="text-[11px] font-bold uppercase text-neutral-800">
                      {solicitadoPor}
                    </span>
                  )}
                </div>

                {/* Línea divisoria inferior + texto fijo MERCADEO Y PUBLICIDAD */}
                <div className="w-full border-t-2 border-[#000000] pt-1 text-center">
                  <span className="text-xs font-black uppercase tracking-wider text-[#000000]">
                    {departamentoSolicitante}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sello oficial de resolución de Contraloría Interna cuando está en modo lectura y ya fue procesada */}
        {!isEdit && estado && estado !== 'PENDIENTE_APROBACION' && (
          <div
            className={`mt-6 p-3.5 border-2 rounded-sm flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
              estado === 'APROBADA'
                ? 'border-emerald-700 bg-emerald-50 text-emerald-950'
                : 'border-[#DC2626] bg-red-50 text-red-950'
            }`}
          >
            <div>
              <span className="text-xs font-black uppercase tracking-wider block">
                {estado === 'APROBADA'
                  ? '✓ SOLICITUD APROBADA POR CONTRALORÍA INTERNA'
                  : '✕ SOLICITUD RECHAZADA POR CONTRALORÍA INTERNA'}
              </span>
              {notaContraloria && (
                <span className="text-xs font-bold block mt-0.5">
                  NOTA DE CONTRALORÍA: {notaContraloria}
                </span>
              )}
            </div>
            <div className="text-[11px] font-mono font-bold sm:text-right shrink-0">
              {resueltoPor && <span className="block uppercase">{resueltoPor}</span>}
              {resueltoAt && (
                <span className="block">
                  {new Date(resueltoAt).toLocaleString('es-VE')}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
