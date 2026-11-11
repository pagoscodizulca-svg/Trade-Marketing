import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { ShiftType, Store } from '../../types';
import type {
  ArchivoPlanificacionExtension,
  CargaArchivoRecord,
  FilaDegustacionExtraida,
  MetodoExtraccionArchivo,
  ResultadoVolcadoLoteCronograma,
} from '../../types/degustacionesPipeline';
import { normalizeCanonicalToken, sha256HexFromBytes } from '../../utils/degustacionIdempotency';
import {
  MAX_IMPORT_ROWS,
  SheetSelectionReason,
  downloadDegustacionesCsvTemplate,
  extractTabularDegustacionFile,
  getCurrentVenezuelaYearMonth,
  inferInitialBasePeriod,
  sanitizeCellText,
  validateUploadFileMetadata,
} from '../../utils/degustacionesTabularParser';
import { excelDateParser } from '../../utils/excelDateParser';
import {
  formatToDdMmYyyy,
  matchesDateFilter,
  normalizeExcelDate,
} from '../../utils/excelDateNormalizer';
import {
  ActivePromotoraOption,
  CatalogPdvEntry,
  EditableRowDraft,
  PromotoraCatalogMatchResult,
  buildActivePromotoraCatalog,
  buildKnownPdvCatalog,
  checkDuplicateArchivoSha256,
  dumpValidatedBatchToCronograma,
  extractPdfViaBackend,
  fetchActiveCronogramaHashes,
  matchPromotoraCatalogo,
  validateAndEnrichExtractedRows,
} from '../../services/degustacionesPipelineService';
import type { StaffMemberRecord } from '../../services/supabaseModule1';

export interface MultiFormatTastingUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  stores: Store[];
  syncedStoreItems: Array<{
    name: string;
    clientCode?: string;
    zone?: string;
    address?: string;
  }>;
  staffMembers: StaffMemberRecord[];
  cargadoPor: string;
  cargadoPorRol: string;
  onBatchDumpedSuccess?: (result: ResultadoVolcadoLoteCronograma) => Promise<void> | void;
}

type FilterViewMode = 'TODAS' | 'VALIDO' | 'ADVERTENCIA' | 'ERROR' | 'DUPLICADAS';

/** Activa paginación ágil en cliente automáticamente cuando la vista supera 150 registros. */
const PAGINATION_THRESHOLD = 150;
const ROWS_PER_PAGE = 100;

interface LoadedFileContext {
  nombreArchivo: string;
  extension: ArchivoPlanificacionExtension;
  mimeType: string;
  tamanoBytes: number;
  archivoSha256: string;
  metodoExtraccion: MetodoExtraccionArchivo;
  aiModelLabel?: string;
  detectedColumns?: string[];
  selectedSheetName?: string;
  autoSelectedSheetName?: string;
  sheetSelectionReason?: SheetSelectionReason;
  availableSheets?: string[];
}

interface PreviewTableRowProps {
  row: FilaDegustacionExtraida;
  isChecked: boolean;
  isPdvMatched: boolean;
  pendingDateText: string | undefined;
  datalistId: string;
  pdvCatalog: CatalogPdvEntry[];
  promotoraCatalog: ActivePromotoraOption[];
  filePromMatch: PromotoraCatalogMatchResult | null;
  onToggleSelected: (rowIndex: number) => void;
  onUpdateDraftRow: (rowIndex: number, patch: Partial<EditableRowDraft>) => void;
  onRemoveRow: (rowIndex: number) => void;
  onDateTextChange: (rowIndex: number, rawVal: string) => void;
  onDateTextBlur: (rowIndex: number) => void;
  onCalendarDatePick: (rowIndex: number, isoValue: string) => void;
}

const PreviewTableRow = React.memo<PreviewTableRowProps>(
  ({
    row,
    isChecked,
    isPdvMatched,
    pendingDateText,
    datalistId,
    pdvCatalog,
    promotoraCatalog,
    filePromMatch,
    onToggleSelected,
    onUpdateDraftRow,
    onRemoveRow,
    onDateTextChange,
    onDateTextBlur,
    onCalendarDatePick,
  }) => {
    const isValidYmd = /^\d{4}-\d{2}-\d{2}$/.test(row.fecha);
    const matchedFromFileOption = filePromMatch?.match ?? null;
    const remainingPromotoras = useMemo(
      () =>
        matchedFromFileOption
          ? promotoraCatalog.filter((p) => p.id !== matchedFromFileOption.id)
          : promotoraCatalog,
      [matchedFromFileOption, promotoraCatalog]
    );

    const mapsQuery = [row.clienteNombre, row.zonaDireccion].filter(Boolean).join(', ');
    const mapsHref = mapsQuery
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`
      : '';

    const rowBg =
      row.nivelValidacion === 'ERROR'
        ? 'bg-red-950/20'
        : row.esDuplicadoEnArchivo || row.esDuplicadoEnBaseDatos
          ? 'bg-orange-950/15'
          : row.nivelValidacion === 'ADVERTENCIA'
            ? 'bg-amber-950/10'
            : 'bg-emerald-950/5';

    return (
      <tr className={`${rowBg} hover:bg-zinc-900/70 transition-colors`}>
        {/* Selección */}
        <td className="p-3 text-center align-top w-11 min-w-[44px]">
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => onToggleSelected(row.rowIndex)}
            className="accent-red-600 cursor-pointer mt-1"
          />
        </td>

        {/* Semáforo + fila exacta Excel */}
        <td className="p-3 align-top min-w-[180px]">
          <div className="flex flex-col gap-1.5">
            {row.nivelValidacion === 'VALIDO' && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-bold text-[10px] w-fit whitespace-nowrap">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                VÁLIDO
              </span>
            )}
            {row.nivelValidacion === 'ADVERTENCIA' && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-300 font-bold text-[10px] w-fit whitespace-nowrap">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                ADVERTENCIA
              </span>
            )}
            {row.nivelValidacion === 'ERROR' && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-red-500/20 border border-red-500/50 text-red-300 font-bold text-[10px] w-fit whitespace-nowrap">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                ERROR
              </span>
            )}
            <div className="flex items-center gap-1.5 whitespace-nowrap tabular-nums">
              <span
                className="text-[10px] text-zinc-300 font-mono bg-zinc-900 px-1.5 py-0.5 rounded border border-white/10"
                title={`Fila exacta en el archivo origen: #${row.excelRowNumber ?? row.rowIndex}`}
              >
                Fila #{row.excelRowNumber ?? row.rowIndex}
              </span>
              <span
                className="text-[10px] text-zinc-500 font-mono"
                title={`Hash SHA-256 de idempotencia: ${row.idempotencyHash}`}
              >
                #{row.idempotencyHash.slice(0, 8)}
              </span>
            </div>
            {row.mensajesValidacion.length > 0 && (
              <div className="text-[10px] leading-snug text-zinc-300 space-y-0.5 max-w-[225px]">
                {row.mensajesValidacion.map((m, idx) => (
                  <div
                    key={idx}
                    className={
                      row.nivelValidacion === 'ERROR' ? 'text-red-300' : 'text-amber-200/90'
                    }
                  >
                    • {m}
                  </div>
                ))}
              </div>
            )}
          </div>
        </td>

        {/* FECHA (min-w-[168px]) — Formato estricto dd-mm-aaaa */}
        <td className="p-3 align-top min-w-[168px] whitespace-nowrap">
          <div className="relative flex items-center">
            <input
              type="text"
              inputMode="numeric"
              placeholder="dd-mm-aaaa"
              value={pendingDateText ?? row.fechaFormateada}
              title={
                isValidYmd
                  ? `Fecha programada: ${row.fechaFormateada} (ISO BD: ${row.fecha})`
                  : 'Ingresa una fecha válida (dd-mm-aaaa)'
              }
              onChange={(e) => onDateTextChange(row.rowIndex, e.target.value)}
              onBlur={() => onDateTextBlur(row.rowIndex)}
              className={`w-full pl-2.5 pr-7 py-1.5 rounded-lg bg-zinc-900 border text-xs font-mono tabular-nums text-white placeholder-zinc-500 focus:outline-none ${
                !isValidYmd ? 'border-red-500' : 'border-zinc-800 focus:border-red-500'
              }`}
            />
            <label
              className="absolute right-2 inline-flex items-center text-zinc-400 hover:text-white cursor-pointer"
              title="Seleccionar en calendario"
            >
              <Calendar className="w-3.5 h-3.5 pointer-events-none" />
              <input
                type="date"
                tabIndex={-1}
                aria-hidden="true"
                value={isValidYmd ? row.fecha : ''}
                onChange={(e) => onCalendarDatePick(row.rowIndex, e.target.value)}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </label>
          </div>
        </td>

        {/* TURNO / HORARIO (min-w-[200px]) */}
        <td className="p-3 align-top min-w-[200px] space-y-1.5 whitespace-nowrap">
          <select
            value={row.turno}
            title={`Turno: ${row.turno} (${row.horaInicio} - ${row.horaFin})`}
            onChange={(e) => {
              const nextTurno = e.target.value as ShiftType;
              onUpdateDraftRow(row.rowIndex, {
                turno: nextTurno,
                horaInicio: nextTurno === 'TARDE' ? '14:00' : '09:00',
                horaFin:
                  nextTurno === 'COMPLETO'
                    ? '18:00'
                    : nextTurno === 'TARDE'
                      ? '18:00'
                      : '13:00',
              });
            }}
            className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500"
          >
            <option value="MAÑANA">MAÑANA</option>
            <option value="TARDE">TARDE</option>
            <option value="COMPLETO">COMPLETO</option>
          </select>
          <div className="grid grid-cols-2 gap-1.5 tabular-nums">
            <input
              type="time"
              value={row.horaInicio}
              title={`Hora de inicio: ${row.horaInicio}`}
              onChange={(e) => onUpdateDraftRow(row.rowIndex, { horaInicio: e.target.value })}
              className="w-full px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-red-500"
            />
            <input
              type="time"
              value={row.horaFin}
              title={`Hora de cierre: ${row.horaFin}`}
              onChange={(e) => onUpdateDraftRow(row.rowIndex, { horaFin: e.target.value })}
              className="w-full px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-red-500"
            />
          </div>
        </td>

        {/* CLIENTE / PDV Y ZONA (min-w-[330px]) */}
        <td className="p-3 align-top min-w-[330px] space-y-1.5">
          <input
            type="text"
            list={datalistId}
            value={row.clienteNombre}
            title={row.clienteNombre || 'Nombre del Punto de Venta (PDV)'}
            placeholder="Nombre del Punto de Venta..."
            onChange={(e) =>
              onUpdateDraftRow(row.rowIndex, {
                clienteNombre: sanitizeCellText(e.target.value),
              })
            }
            className={`w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border text-xs font-medium text-white focus:outline-none ${
              !row.clienteNombre
                ? 'border-red-500'
                : isPdvMatched
                  ? 'border-emerald-500/40 focus:border-emerald-400'
                  : 'border-amber-500/50 focus:border-amber-400'
            }`}
          />
          {!isPdvMatched && pdvCatalog.length > 0 && (
            <select
              value=""
              title={`Vincular "${row.clienteNombre || 'este PDV'}" con un cliente existente del catálogo`}
              onChange={(e) => {
                const chosen = pdvCatalog.find((p) => p.canonicalKey === e.target.value);
                if (chosen) {
                  onUpdateDraftRow(row.rowIndex, {
                    clienteNombre: chosen.name,
                    clienteCodigo: chosen.clientCode || row.clienteCodigo,
                    zonaDireccion: chosen.zone || chosen.address || row.zonaDireccion,
                  });
                }
              }}
              className="w-full px-2 py-1 rounded-lg bg-amber-950/30 border border-amber-500/40 text-[11px] text-amber-200 focus:outline-none"
            >
              <option value="">⚡ Vincular con PDV existente del catálogo...</option>
              {pdvCatalog.map((pdv) => (
                <option
                  key={pdv.canonicalKey}
                  value={pdv.canonicalKey}
                  title={`${pdv.name}${pdv.zone ? ` (${pdv.zone})` : ''}`}
                >
                  {pdv.name} {pdv.zone ? `(${pdv.zone})` : ''}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={row.zonaDireccion}
              title={row.zonaDireccion || 'Zona o dirección del PDV'}
              placeholder="Zona / Dirección..."
              onChange={(e) =>
                onUpdateDraftRow(row.rowIndex, {
                  zonaDireccion: sanitizeCellText(e.target.value),
                })
              }
              className="flex-1 min-w-0 px-2.5 py-1 rounded bg-zinc-900/70 border border-zinc-800 text-[11px] text-zinc-300 focus:outline-none focus:border-red-500"
            />
            {mapsHref && (
              <a
                href={mapsHref}
                target="_blank"
                rel="noopener noreferrer"
                title={`Abrir ubicación en Google Maps: ${mapsQuery}`}
                className="p-1.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-red-400 shrink-0 transition"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </td>

        {/* PRODUCTO(S) (min-w-[240px]) */}
        <td className="p-3 align-top min-w-[240px]">
          <input
            type="text"
            value={row.productoResumen}
            title={row.productoResumen || 'Producto(s) a degustar'}
            placeholder="Ej. MORTADELA + ESPALDA"
            onChange={(e) =>
              onUpdateDraftRow(row.rowIndex, {
                productoResumen: sanitizeCellText(e.target.value),
              })
            }
            className={`w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border text-xs text-white focus:outline-none ${
              !row.productoResumen ? 'border-red-500' : 'border-zinc-800 focus:border-red-500'
            }`}
          />
        </td>

        {/* KILOS (min-w-[96px]) */}
        <td className="p-3 align-top min-w-[96px] whitespace-nowrap">
          <input
            type="number"
            min="0.1"
            step="0.5"
            value={row.cantidadKilos}
            title={`Cantidad planificada: ${row.cantidadKilos} Kg`}
            onChange={(e) =>
              onUpdateDraftRow(row.rowIndex, {
                cantidadKilos: Number(e.target.value),
              })
            }
            className={`w-full px-2.5 py-1.5 text-center rounded-lg bg-zinc-900 border text-xs text-white font-mono tabular-nums focus:outline-none ${
              row.cantidadKilos <= 0 ? 'border-red-500' : 'border-zinc-800 focus:border-red-500'
            }`}
          />
        </td>

        {/* FDV / VENDEDOR (min-w-[195px]) */}
        <td className="p-3 align-top min-w-[195px]">
          <input
            type="text"
            value={row.vendedorFdv}
            title={row.vendedorFdv || 'Vendedor / Fuerza de Ventas'}
            placeholder="Vendedor FDV..."
            onChange={(e) =>
              onUpdateDraftRow(row.rowIndex, {
                vendedorFdv: sanitizeCellText(e.target.value, 120),
              })
            }
            className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-red-500"
          />
        </td>

        {/* PROMOTORA (CATÁLOGO ACTIVO) (min-w-[265px]) */}
        <td className="p-3 align-top min-w-[265px] space-y-1">
          <select
            value={row.promotoraId || ''}
            title={
              row.promotoraNombreResuelto
                ? `Promotora activa seleccionada: ${row.promotoraNombreResuelto}`
                : 'Sin promotora asignada: se cargará como Por asignar en Módulo 2'
            }
            onChange={(e) => {
              const selectedId = e.target.value ? e.target.value : null;
              const found = selectedId
                ? promotoraCatalog.find((p) => p.id === selectedId)
                : null;
              onUpdateDraftRow(row.rowIndex, {
                promotoraId: found ? found.id : null,
                promotoraSugerida: found ? found.name : '',
              });
            }}
            className={`w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border text-xs text-white focus:outline-none ${
              row.promotoraId
                ? 'border-emerald-500/50'
                : row.rawPromotoraArchivo && !filePromMatch?.isUnassignedPlaceholder
                  ? 'border-amber-500/60'
                  : 'border-zinc-800 focus:border-red-500'
            }`}
          >
            {matchedFromFileOption ? (
              <>
                <option value={matchedFromFileOption.id}>
                  ✓ {matchedFromFileOption.name} (Asignada en archivo)
                </option>
                {remainingPromotoras.map((prom) => (
                  <option key={prom.id} value={prom.id}>
                    {prom.name}
                  </option>
                ))}
                <option value="">— Por asignar en Módulo 2 —</option>
              </>
            ) : (
              <>
                <option value="">— Por asignar (cargar en Módulo 2) —</option>
                {promotoraCatalog.map((prom) => (
                  <option key={prom.id} value={prom.id}>
                    {prom.name}
                  </option>
                ))}
              </>
            )}
          </select>

          {row.promotoraCoincidenciaArchivo && matchedFromFileOption ? (
            <div className="text-[10px] text-emerald-400 leading-snug whitespace-nowrap">
              ✓ Asignada desde catálogo activo
            </div>
          ) : !row.promotoraId ? (
            <div className="text-[10px] text-zinc-400 leading-snug whitespace-nowrap">
              Pasará por asignar a Módulo 2
            </div>
          ) : null}
        </td>

        {/* OBSERVACIONES (min-w-[250px]) */}
        <td className="p-3 align-top min-w-[250px]">
          <input
            type="text"
            value={row.observaciones}
            title={row.observaciones || 'Observaciones operativas de la degustación'}
            placeholder="Notas u observaciones..."
            onChange={(e) =>
              onUpdateDraftRow(row.rowIndex, {
                observaciones: sanitizeCellText(e.target.value),
              })
            }
            className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-red-500"
          />
        </td>

        {/* QUITAR (min-w-[60px]) */}
        <td className="p-3 w-14 min-w-[60px] text-center align-top">
          <button
            type="button"
            onClick={() => onRemoveRow(row.rowIndex)}
            title="Descartar fila del lote"
            className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-950/30 cursor-pointer transition inline-flex items-center justify-center"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </td>
      </tr>
    );
  }
);
PreviewTableRow.displayName = 'PreviewTableRow';

export const MultiFormatTastingUploadModal: React.FC<MultiFormatTastingUploadModalProps> = ({
  isOpen,
  onClose,
  stores,
  syncedStoreItems,
  staffMembers,
  cargadoPor,
  cargadoPorRol,
  onBatchDumpedSuccess,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedBufferRef = useRef<ArrayBuffer | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isDumping, setIsDumping] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [fileContext, setFileContext] = useState<LoadedFileContext | null>(null);
  const [priorDuplicateUpload, setPriorDuplicateUpload] = useState<CargaArchivoRecord | null>(null);

  const [basePeriod, setBasePeriod] = useState<{ year: number; month: number }>(() =>
    getCurrentVenezuelaYearMonth()
  );

  const [draftRows, setDraftRows] = useState<EditableRowDraft[]>([]);
  const [validatedRows, setValidatedRows] = useState<FilaDegustacionExtraida[]>([]);
  const [existingDbHashes, setExistingDbHashes] = useState<Set<string>>(() => new Set());
  const [selectedRowIndices, setSelectedRowIndices] = useState<Set<number>>(() => new Set());

  const [filterMode, setFilterMode] = useState<FilterViewMode>('TODAS');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [editingDateByRow, setEditingDateByRow] = useState<Record<number, string>>({});
  const [loteNotas, setLoteNotas] = useState('');
  const [dumpSuccessResult, setDumpSuccessResult] =
    useState<ResultadoVolcadoLoteCronograma | null>(null);

  const editingDateRef = useRef<Record<number, string>>({});
  editingDateRef.current = editingDateByRow;

  const basePeriodRef = useRef(basePeriod);
  basePeriodRef.current = basePeriod;

  const pdvCatalog = useMemo<CatalogPdvEntry[]>(
    () => buildKnownPdvCatalog({ stores, syncedStoreNames: syncedStoreItems }),
    [stores, syncedStoreItems]
  );

  const pdvKeySet = useMemo(
    () => new Set(pdvCatalog.map((p) => p.canonicalKey)),
    [pdvCatalog]
  );

  const promotoraCatalog = useMemo<ActivePromotoraOption[]>(
    () => buildActivePromotoraCatalog(staffMembers),
    [staffMembers]
  );

  const activePromotoraIdSet = useMemo<ReadonlySet<string>>(
    () => new Set(promotoraCatalog.map((p) => p.id)),
    [promotoraCatalog]
  );

  // Mapa precalculado de coincidencias de promotoras para evitar búsquedas repetidas por fila
  const promotoraMatchByRaw = useMemo(() => {
    const map = new Map<string, PromotoraCatalogMatchResult>();
    for (const row of validatedRows) {
      if (row.rawPromotoraArchivo && !map.has(row.rawPromotoraArchivo)) {
        map.set(
          row.rawPromotoraArchivo,
          matchPromotoraCatalogo(row.rawPromotoraArchivo, promotoraCatalog)
        );
      }
    }
    return map;
  }, [validatedRows, promotoraCatalog]);

  const resetModalState = useCallback(() => {
    loadedBufferRef.current = null;
    setIsDragging(false);
    setIsExtracting(false);
    setIsDumping(false);
    setFileError(null);
    setFileContext(null);
    setPriorDuplicateUpload(null);
    setBasePeriod(getCurrentVenezuelaYearMonth());
    setDraftRows([]);
    setValidatedRows([]);
    setExistingDbHashes(new Set());
    setSelectedRowIndices(new Set());
    setFilterMode('TODAS');
    setFilterDateFrom('');
    setFilterDateTo('');
    setCurrentPage(1);
    setEditingDateByRow({});
    setLoteNotas('');
    setDumpSuccessResult(null);
  }, []);

  // Revalidar el lote completo en memoria cuando se editan celdas o cambian los catálogos
  useEffect(() => {
    let cancelled = false;
    if (draftRows.length === 0) {
      setValidatedRows([]);
      return;
    }

    void validateAndEnrichExtractedRows(draftRows, {
      pdvCatalog,
      promotoraCatalog,
      existingDbHashes,
      baseYear: basePeriod.year,
      baseMonth: basePeriod.month,
    }).then((result) => {
      if (!cancelled) {
        setValidatedRows(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [draftRows, pdvCatalog, promotoraCatalog, existingDbHashes, basePeriod.year, basePeriod.month]);

  const populateValidatedBatchState = useCallback(
    async (params: {
      rawRows: Awaited<ReturnType<typeof extractTabularDegustacionFile>>['rows'];
      initialPeriod: { year: number; month: number };
      nextContext: LoadedFileContext;
    }) => {
      const drafts: EditableRowDraft[] = params.rawRows.map((r, idx) => ({
        rowIndex: idx + 1,
        excelRowNumber: r.excelRowNumber ?? idx + 1,
        fecha: r.fecha,
        fechaFormateada: r.fechaFormateada,
        fechaTimestamp: r.fechaTimestamp,
        rawFechaArchivo: r.rawFecha,
        fechaErrorDetalle: r.fechaErrorDetalle,
        fechaOrigenParcial: Boolean(r.fechaOrigenParcial),
        fechaEditadaManualmente: false,
        horaInicio: r.horaInicio,
        horaFin: r.horaFin,
        turno: r.turno,
        clienteNombre: r.clienteNombre,
        clienteCodigo: r.clienteCodigo,
        zonaDireccion: r.zonaDireccion,
        productos: r.productos,
        productoResumen: r.productos.join(' + '),
        cantidadKilos: r.cantidadKilos,
        personasEstimadas: r.personasEstimadas,
        vendedorFdv: r.vendedorFdv,
        promotoraSugerida: r.promotoraSugerida,
        rawPromotoraArchivo: r.promotoraSugerida,
        promotoraId: undefined,
        observaciones: r.observaciones,
      }));

      const firstPass = await validateAndEnrichExtractedRows(drafts, {
        pdvCatalog,
        promotoraCatalog,
        existingDbHashes: new Set(),
        baseYear: params.initialPeriod.year,
        baseMonth: params.initialPeriod.month,
      });

      const activeDbHashes = await fetchActiveCronogramaHashes(
        firstPass.map((item) => item.idempotencyHash)
      );
      setExistingDbHashes(activeDbHashes);

      const finalPass = await validateAndEnrichExtractedRows(drafts, {
        pdvCatalog,
        promotoraCatalog,
        existingDbHashes: activeDbHashes,
        baseYear: params.initialPeriod.year,
        baseMonth: params.initialPeriod.month,
      });

      const initialSelection = new Set<number>();
      for (const item of finalPass) {
        if (!item.esDuplicadoEnArchivo && !item.esDuplicadoEnBaseDatos) {
          initialSelection.add(item.rowIndex);
        }
      }

      setBasePeriod(params.initialPeriod);
      setFileContext(params.nextContext);
      setDraftRows(drafts);
      setValidatedRows(finalPass);
      setSelectedRowIndices(initialSelection);
      setEditingDateByRow({});
      setFilterMode('TODAS');
      setCurrentPage(1);
    },
    [pdvCatalog, promotoraCatalog]
  );

  const handleProcessFile = useCallback(
    async (file: File) => {
      setFileError(null);
      setDumpSuccessResult(null);

      const metaCheck = validateUploadFileMetadata(file);
      if (!metaCheck.valid || !metaCheck.extension) {
        setFileError(metaCheck.error || 'Archivo inválido.');
        return;
      }

      setIsExtracting(true);
      try {
        const buffer = await file.arrayBuffer();
        const sha256 = await sha256HexFromBytes(new Uint8Array(buffer));

        // 1. Verificar huella SHA-256 de archivo repetido en cargas_archivos vía SDK parametrizado
        const priorUpload = await checkDuplicateArchivoSha256(sha256);
        setPriorDuplicateUpload(priorUpload);

        // 2. Extraer filas según formato: Tabular Determinista (con selección 2 niveles de pestaña más reciente) vs PDF IA
        let metodoExtraccion: MetodoExtraccionArchivo = 'TABULAR_DETERMINISTA';
        let aiModelLabel: string | undefined;
        let detectedColumns: string[] | undefined;
        let selectedSheetName: string | undefined;
        let autoSelectedSheetName: string | undefined;
        let sheetSelectionReason: SheetSelectionReason | undefined;
        let availableSheets: string[] | undefined;
        let rawRows: Awaited<ReturnType<typeof extractTabularDegustacionFile>>['rows'] = [];
        let initialPeriod = inferInitialBasePeriod(file.name, []);

        if (metaCheck.extension === 'pdf') {
          loadedBufferRef.current = null;
          metodoExtraccion = 'IA_ESTRUCTURADA';
          const pdfOut = await extractPdfViaBackend(buffer, file.name);
          rawRows = pdfOut.rows;
          aiModelLabel = `${pdfOut.provider.toUpperCase()} (${pdfOut.model})`;
          initialPeriod = inferInitialBasePeriod(
            file.name,
            rawRows.map((r) => r.rawFecha || r.fecha)
          );
        } else {
          loadedBufferRef.current =
            metaCheck.extension === 'xlsx' || metaCheck.extension === 'xls' ? buffer : null;
          const tabOut = await extractTabularDegustacionFile(buffer, metaCheck.extension, {
            fileName: file.name,
          });
          rawRows = tabOut.rows;
          detectedColumns = tabOut.detectedColumns;
          initialPeriod = tabOut.inferredPeriod;
          selectedSheetName = tabOut.selectedSheetName;
          autoSelectedSheetName = tabOut.autoSelectedSheetName;
          sheetSelectionReason = tabOut.sheetSelectionReason;
          availableSheets = tabOut.availableSheets;

          if (rawRows.length === 0 && tabOut.warning) {
            throw new Error(tabOut.warning);
          }
        }

        if (rawRows.length === 0) {
          throw new Error(
            'No se encontraron filas de degustaciones en el archivo cargado. Verifica que contenga columnas o datos de planificación.'
          );
        }

        await populateValidatedBatchState({
          rawRows,
          initialPeriod,
          nextContext: {
            nombreArchivo: sanitizeCellText(file.name, 180) || 'planificacion.xlsx',
            extension: metaCheck.extension,
            mimeType: file.type || 'application/octet-stream',
            tamanoBytes: file.size,
            archivoSha256: sha256,
            metodoExtraccion,
            aiModelLabel,
            detectedColumns,
            selectedSheetName,
            autoSelectedSheetName,
            sheetSelectionReason,
            availableSheets,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'No se pudo procesar el archivo.';
        setFileError(msg);
      } finally {
        setIsExtracting(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [populateValidatedBatchState]
  );

  // Cambio manual de pestaña sobre el ArrayBuffer ya cargado en memoria (Lazy Parsing de la nueva pestaña)
  const handleSwitchExcelSheet = useCallback(
    async (targetSheetName: string) => {
      if (
        !fileContext ||
        !loadedBufferRef.current ||
        (fileContext.extension !== 'xlsx' && fileContext.extension !== 'xls') ||
        targetSheetName === fileContext.selectedSheetName
      ) {
        return;
      }

      setFileError(null);
      setIsExtracting(true);
      try {
        const tabOut = await extractTabularDegustacionFile(
          loadedBufferRef.current,
          fileContext.extension,
          {
            fileName: fileContext.nombreArchivo,
            targetSheetName,
          }
        );

        if (tabOut.rows.length === 0) {
          throw new Error(
            tabOut.warning ||
              `La pestaña "${targetSheetName}" no contiene registros válidos de degustaciones.`
          );
        }

        await populateValidatedBatchState({
          rawRows: tabOut.rows,
          initialPeriod: tabOut.inferredPeriod,
          nextContext: {
            ...fileContext,
            detectedColumns: tabOut.detectedColumns,
            selectedSheetName: tabOut.selectedSheetName ?? targetSheetName,
            autoSelectedSheetName:
              tabOut.autoSelectedSheetName ?? fileContext.autoSelectedSheetName,
            sheetSelectionReason: tabOut.sheetSelectionReason ?? 'MANUAL',
            availableSheets: tabOut.availableSheets ?? fileContext.availableSheets,
          },
        });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'No se pudo leer la pestaña seleccionada.';
        setFileError(msg);
      } finally {
        setIsExtracting(false);
      }
    },
    [fileContext, populateValidatedBatchState]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const droppedFile = e.dataTransfer.files?.[0];
      if (droppedFile) {
        void handleProcessFile(droppedFile);
      }
    },
    [handleProcessFile]
  );

  const updateDraftRow = useCallback((rowIndex: number, patch: Partial<EditableRowDraft>) => {
    setDraftRows((prev) =>
      prev.map((row) => (row.rowIndex === rowIndex ? { ...row, ...patch } : row))
    );
  }, []);

  const removeDraftRow = useCallback((rowIndex: number) => {
    setDraftRows((prev) => prev.filter((r) => r.rowIndex !== rowIndex));
    setSelectedRowIndices((prev) => {
      const next = new Set(prev);
      next.delete(rowIndex);
      return next;
    });
  }, []);

  const toggleRowSelected = useCallback((rowIndex: number) => {
    setSelectedRowIndices((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  }, []);

  const handleDateTextChange = useCallback(
    (rowIndex: number, rawVal: string) => {
      setEditingDateByRow((prev) => ({
        ...prev,
        [rowIndex]: rawVal,
      }));
      if (!rawVal.trim()) {
        updateDraftRow(rowIndex, {
          fecha: '',
          fechaFormateada: '',
          fechaTimestamp: null,
          fechaEditadaManualmente: true,
          fechaOrigenParcial: false,
        });
      }
    },
    [updateDraftRow]
  );

  const handleDateTextBlur = useCallback(
    (rowIndex: number) => {
      const pending = editingDateRef.current[rowIndex];
      if (pending === undefined) return;
      const period = basePeriodRef.current;
      const parsed = excelDateParser(pending, {
        fallbackYear: period.year,
        fallbackMonth: period.month,
        allowUsMmDdFallback: false,
      });
      updateDraftRow(rowIndex, {
        fecha: parsed.isoDate ?? '',
        fechaFormateada: parsed.ok ? parsed.displayDate : sanitizeCellText(pending, 40),
        fechaTimestamp: parsed.timestampUtc,
        fechaEditadaManualmente: true,
        fechaOrigenParcial: false,
      });
      setEditingDateByRow((prev) => {
        const next = { ...prev };
        delete next[rowIndex];
        return next;
      });
    },
    [updateDraftRow]
  );

  const handleCalendarDatePick = useCallback(
    (rowIndex: number, isoValue: string) => {
      const parsed = normalizeExcelDate(isoValue);
      setEditingDateByRow((prev) => {
        const next = { ...prev };
        delete next[rowIndex];
        return next;
      });
      updateDraftRow(rowIndex, {
        fecha: parsed.fechaIso ?? '',
        fechaFormateada: parsed.fechaFormateada,
        fechaTimestamp: parsed.fechaTimestamp,
        fechaEditadaManualmente: true,
        fechaOrigenParcial: false,
      });
    },
    [updateDraftRow]
  );

  const counts = useMemo(() => {
    let validas = 0;
    let advertencias = 0;
    let errores = 0;
    let duplicadas = 0;

    for (const r of validatedRows) {
      if (r.nivelValidacion === 'VALIDO') validas++;
      else if (r.nivelValidacion === 'ADVERTENCIA') advertencias++;
      else errores++;

      if (r.esDuplicadoEnArchivo || r.esDuplicadoEnBaseDatos) duplicadas++;
    }

    return {
      total: validatedRows.length,
      validas,
      advertencias,
      errores,
      duplicadas,
    };
  }, [validatedRows]);

  const filteredRows = useMemo(() => {
    const byMode =
      filterMode === 'TODAS'
        ? validatedRows
        : filterMode === 'DUPLICADAS'
          ? validatedRows.filter((r) => r.esDuplicadoEnArchivo || r.esDuplicadoEnBaseDatos)
          : validatedRows.filter((r) => r.nivelValidacion === filterMode);

    if (!filterDateFrom.trim() && !filterDateTo.trim()) {
      return byMode;
    }

    return byMode.filter((r) =>
      matchesDateFilter(
        r.fecha,
        { desde: filterDateFrom, hasta: filterDateTo },
        r.fechaTimestamp
      )
    );
  }, [validatedRows, filterMode, filterDateFrom, filterDateTo]);

  // Paginación ágil automática cuando filteredRows > 150 (conservando el 100% del lote en memoria)
  const isPaginationActive = filteredRows.length > PAGINATION_THRESHOLD;
  const totalPages = isPaginationActive
    ? Math.max(1, Math.ceil(filteredRows.length / ROWS_PER_PAGE))
    : 1;
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  const visibleRows = useMemo(() => {
    if (!isPaginationActive) return filteredRows;
    const startIdx = (safePage - 1) * ROWS_PER_PAGE;
    return filteredRows.slice(startIdx, startIdx + ROWS_PER_PAGE);
  }, [filteredRows, isPaginationActive, safePage]);

  const selectedValidatedRows = useMemo(
    () => validatedRows.filter((r) => selectedRowIndices.has(r.rowIndex)),
    [validatedRows, selectedRowIndices]
  );

  const selectedErrorCount = useMemo(
    () => selectedValidatedRows.filter((r) => r.nivelValidacion === 'ERROR').length,
    [selectedValidatedRows]
  );

  const handleConfirmDump = useCallback(async () => {
    if (!fileContext || selectedValidatedRows.length === 0 || selectedErrorCount > 0) return;
    setFileError(null);
    setIsDumping(true);

    try {
      const result = await dumpValidatedBatchToCronograma({
        fileMeta: {
          nombreArchivo: fileContext.nombreArchivo,
          extension: fileContext.extension,
          mimeType: fileContext.mimeType,
          tamanoBytes: fileContext.tamanoBytes,
          archivoSha256: fileContext.archivoSha256,
          metodoExtraccion: fileContext.metodoExtraccion,
          metadata: {
            aiModelLabel: fileContext.aiModelLabel || null,
            detectedColumns: fileContext.detectedColumns || [],
            selectedSheetName: fileContext.selectedSheetName || null,
            sheetSelectionReason: fileContext.sheetSelectionReason || null,
            periodoBase: `${basePeriod.year}-${String(basePeriod.month).padStart(2, '0')}`,
          },
        },
        rows: selectedValidatedRows,
        allowedPromotoraIds: activePromotoraIdSet,
        cargadoPor,
        cargadoPorRol,
        notas: loteNotas,
      });

      setDumpSuccessResult(result);
      if (onBatchDumpedSuccess) {
        await onBatchDumpedSuccess(result);
      }
    } catch (err) {
      setFileError(
        err instanceof Error ? err.message : 'Error al volcar las degustaciones al Módulo 2.'
      );
    } finally {
      setIsDumping(false);
    }
  }, [
    fileContext,
    selectedValidatedRows,
    selectedErrorCount,
    basePeriod,
    activePromotoraIdSet,
    cargadoPor,
    cargadoPorRol,
    loteNotas,
    onBatchDumpedSuccess,
  ]);

  if (!isOpen || typeof document === 'undefined') return null;

  const datalistId = 'codizulca-pdv-catalog-datalist';
  const showTrayView = Boolean(fileContext && !dumpSuccessResult);
  const hasMultipleExcelSheets = Boolean(
    fileContext?.availableSheets && fileContext.availableSheets.length > 1
  );
  const isMostRecentAutoTab = Boolean(
    hasMultipleExcelSheets &&
      fileContext?.selectedSheetName &&
      fileContext.selectedSheetName === fileContext.autoSelectedSheetName
  );

  const pageRangeStart =
    filteredRows.length === 0 ? 0 : (safePage - 1) * ROWS_PER_PAGE + 1;
  const pageRangeEnd = isPaginationActive
    ? Math.min(safePage * ROWS_PER_PAGE, filteredRows.length)
    : filteredRows.length;

  const modalNode = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Carga Multiformato de Degustaciones (Módulo 1 a Módulo 2)"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4 overflow-hidden"
    >
      <datalist id={datalistId}>
        {pdvCatalog.map((pdv) => (
          <option key={pdv.canonicalKey} value={pdv.name}>
            {pdv.zone ? `${pdv.zone} ${pdv.clientCode ? `• ${pdv.clientCode}` : ''}` : pdv.clientCode}
          </option>
        ))}
      </datalist>

      <div className="w-[96vw] max-w-[1600px] max-h-[92vh] min-w-0 flex flex-col overflow-hidden rounded-2xl bg-zinc-950 border border-white/15 shadow-2xl">
        {/* Cabecera Fija (shrink-0) */}
        <div className="shrink-0 px-4 sm:px-6 py-3.5 bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-xl bg-red-600/20 border border-red-500/40 flex items-center justify-center">
              <Upload className="w-5 h-5 text-red-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-base font-black text-white tracking-wide uppercase truncate">
                Carga Multiformato de Degustaciones (Módulo 1 → Módulo 2)
              </h2>
              <p className="text-[11px] sm:text-xs text-zinc-400 truncate">
                Soporta Excel (<code className="text-zinc-200">.xlsx</code>,{' '}
                <code className="text-zinc-200">.xls</code>), CSV (
                <code className="text-zinc-200">.csv</code>) y PDF con IA estructurada (
                <code className="text-zinc-200">.pdf</code>) • Volcado automático en{' '}
                <span className="text-amber-300 font-semibold">PENDIENTE_APROBACION</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={downloadDegustacionesCsvTemplate}
              className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-semibold border border-white/10 flex items-center gap-1.5 cursor-pointer transition"
              title="Descargar encabezados estándar en CSV"
            >
              <Download className="w-3.5 h-3.5 text-red-400" />
              <span>Plantilla CSV</span>
            </button>

            {fileContext && !dumpSuccessResult && (
              <button
                type="button"
                onClick={resetModalState}
                className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold border border-white/10 flex items-center gap-1.5 cursor-pointer transition"
              >
                <RefreshCw className="w-3.5 h-3.5 text-zinc-400" />
                <span>Cambiar archivo</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                resetModalState();
                onClose();
              }}
              className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-white/10 cursor-pointer transition"
              aria-label="Cerrar modal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Banners Operativos (Error de archivo / SHA-256 repetido) */}
        {(fileError || (showTrayView && priorDuplicateUpload)) && (
          <div className="shrink-0 px-4 sm:px-6 pt-3 space-y-2">
            {fileError && (
              <div className="p-3 rounded-xl bg-red-950/50 border border-red-500/50 flex items-start gap-2.5 text-xs text-red-200">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 break-words">{fileError}</div>
                <button
                  type="button"
                  onClick={() => setFileError(null)}
                  className="text-red-300 hover:text-white cursor-pointer shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {showTrayView && priorDuplicateUpload && (
              <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-500/50 flex items-start gap-2.5 text-xs text-amber-100">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <span className="font-bold text-amber-300">
                    Advertencia de Archivo Repetido (SHA-256 idéntico):
                  </span>{' '}
                  Este mismo archivo (<strong>{priorDuplicateUpload.nombre_archivo}</strong>) ya fue
                  cargado el{' '}
                  {new Date(priorDuplicateUpload.created_at).toLocaleString('es-VE')} por{' '}
                  <strong>{priorDuplicateUpload.cargado_por}</strong> (
                  {priorDuplicateUpload.total_filas_insertadas} insertadas). Las filas ya activas en
                  el Cronograma fueron desmarcadas automáticamente.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Contenido Central */}
        {dumpSuccessResult ? (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
            <div className="p-6 rounded-2xl bg-emerald-950/25 border border-emerald-500/40 text-center space-y-4">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-black text-white uppercase">
                  ¡Lote Volcado Exitosamente al Módulo 2!
                </h3>
                <p className="text-xs text-zinc-300 max-w-xl mx-auto">
                  Las degustaciones quedaron registradas en el{' '}
                  <strong>Cronograma de Degustaciones (Módulo 2)</strong> bajo el estado{' '}
                  <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
                    PENDIENTE_APROBACION
                  </span>
                  , incluyendo las filas pendientes de promotora para su asignación directa en
                  Módulo 2.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl mx-auto pt-2 tabular-nums">
                <div className="p-3 rounded-xl bg-zinc-900/90 border border-white/10">
                  <div className="text-[11px] text-zinc-400 uppercase font-semibold">
                    Filas Enviadas
                  </div>
                  <div className="text-xl font-black text-white">
                    {dumpSuccessResult.total_recibidas}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30">
                  <div className="text-[11px] text-emerald-300 uppercase font-semibold">
                    Insertadas en Cronograma
                  </div>
                  <div className="text-xl font-black text-emerald-400">
                    {dumpSuccessResult.total_insertadas}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/30">
                  <div className="text-[11px] text-amber-300 uppercase font-semibold">
                    Omitidas por Idempotencia
                  </div>
                  <div className="text-xl font-black text-amber-400">
                    {dumpSuccessResult.total_duplicadas}
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-zinc-400 font-mono">
                ID de Lote (carga_id): {dumpSuccessResult.carga_id}
              </div>

              <div className="flex items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={resetModalState}
                  className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-bold border border-white/10 cursor-pointer"
                >
                  Cargar Otro Archivo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resetModalState();
                    onClose();
                  }}
                  className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold cursor-pointer shadow-lg shadow-red-950/50"
                >
                  Finalizar y Volver a Módulo 1
                </button>
              </div>
            </div>
          </div>
        ) : !fileContext ? (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => !isExtracting && fileInputRef.current?.click()}
              className={`p-10 sm:p-14 rounded-2xl border-2 border-dashed transition-all text-center cursor-pointer ${
                isDragging
                  ? 'border-red-500 bg-red-950/20'
                  : 'border-zinc-700 hover:border-red-500/60 bg-zinc-900/40 hover:bg-zinc-900/70'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (picked) void handleProcessFile(picked);
                }}
              />

              {isExtracting ? (
                <div className="space-y-3 py-4">
                  <Loader2 className="w-10 h-10 text-red-400 animate-spin mx-auto" />
                  <p className="text-sm font-bold text-white">
                    Seleccionando pestaña más reciente, sanitizando y validando registros...
                  </p>
                  <p className="text-xs text-zinc-400">
                    Verificando huella SHA-256 de idempotencia, fechas UTC, PDVs y padrón activo de
                    promotoras
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                      <FileSpreadsheet className="w-6 h-6 text-emerald-400" />
                    </div>
                    <div className="w-12 h-12 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                      <FileText className="w-6 h-6 text-red-400" />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <p className="text-base font-bold text-white">
                      Arrastra y suelta tu archivo aquí o haz clic para seleccionarlo
                    </p>
                    <p className="text-xs text-zinc-400">
                      Formatos soportados: <strong>.xlsx</strong>, <strong>.xls</strong> (selección
                      automática de pestaña más reciente), <strong>.csv</strong> y{' '}
                      <strong>.pdf</strong> (vía IA estructurada) • Máximo 10 MB • Hasta{' '}
                      {MAX_IMPORT_ROWS.toLocaleString('es-VE')} filas por lote
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] text-zinc-400 pt-1">
                    <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-white/10">
                      Catálogo actual: <strong className="text-white">{pdvCatalog.length}</strong>{' '}
                      PDVs reales
                    </span>
                    <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-white/10">
                      Padrón activo:{' '}
                      <strong className="text-white">{promotoraCatalog.length}</strong> promotoras
                      activas
                    </span>
                    <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-white/10 flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      Sanitización & Control SHA-256 activos
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Bandeja Amplia de Previsualización: Barra Superior + Tabla Amplia con Scroll Encapsulado */
          <div className="flex-1 min-h-0 min-w-0 flex flex-col px-4 sm:px-6 py-3 gap-2.5 overflow-hidden">
            {/* Barra de Archivo, Pestaña Activa, Rango de Fechas y Píldoras de Semáforo (shrink-0) */}
            <div className="shrink-0 p-3 rounded-xl bg-zinc-900/80 border border-white/10 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
                <span
                  className="px-2.5 py-1 rounded-lg bg-black border border-white/10 font-bold text-white max-w-[260px] truncate"
                  title={fileContext.nombreArchivo}
                >
                  {fileContext.nombreArchivo}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-zinc-800 text-zinc-300 font-mono tabular-nums text-[11px] whitespace-nowrap">
                  {(fileContext.tamanoBytes / 1024).toFixed(1)} KB
                </span>

                {/* Etiqueta discreta de Pestaña Activa + Selector Manual (solo libros Excel) */}
                {fileContext.selectedSheetName && (
                  <div className="inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-950/35 border border-emerald-500/35 text-[11px] text-emerald-200">
                    <Layers className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="whitespace-nowrap">
                      Pestaña activa:{' '}
                      <strong className="text-white">{fileContext.selectedSheetName}</strong>
                      {isMostRecentAutoTab ? (
                        <span className="text-emerald-300 font-semibold"> (más reciente)</span>
                      ) : null}
                    </span>

                    {hasMultipleExcelSheets && fileContext.availableSheets && (
                      <select
                        aria-label="Cambiar pestaña del Excel"
                        disabled={isExtracting || isDumping}
                        value={fileContext.selectedSheetName}
                        onChange={(e) => void handleSwitchExcelSheet(e.target.value)}
                        title="Cambiar manualmente a otra pestaña válida del libro Excel"
                        className="ml-1 px-2 py-0.5 rounded bg-zinc-950 border border-emerald-500/40 text-[11px] text-white font-semibold focus:outline-none focus:border-emerald-400 cursor-pointer"
                      >
                        {fileContext.availableSheets.map((sheetName) => (
                          <option key={sheetName} value={sheetName}>
                            {sheetName}
                            {sheetName === fileContext.autoSelectedSheetName
                              ? ' (más reciente)'
                              : ''}
                          </option>
                        ))}
                      </select>
                    )}

                    {isExtracting && (
                      <Loader2 className="w-3 h-3 text-emerald-400 animate-spin shrink-0" />
                    )}
                  </div>
                )}

                <span className="px-2.5 py-0.5 rounded-md bg-red-500/15 border border-red-500/30 text-red-300 font-semibold text-[11px] flex items-center gap-1 whitespace-nowrap">
                  {fileContext.metodoExtraccion === 'IA_ESTRUCTURADA' ? (
                    <>
                      <Sparkles className="w-3 h-3" />
                      <span>IA Estructurada • {fileContext.aiModelLabel}</span>
                    </>
                  ) : (
                    <span>Parser Tabular Determinista</span>
                  )}
                </span>

                {/* Filtro de Rango de Fechas (dd-mm-aaaa) */}
                <div className="inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-950 border border-white/15 text-[11px]">
                  <Calendar className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  <span className="text-zinc-300 font-semibold whitespace-nowrap">Fecha:</span>
                  <div className="relative inline-flex items-center">
                    <input
                      type="text"
                      aria-label="Filtrar desde fecha"
                      value={filterDateFrom}
                      placeholder="Desde dd-mm-aaaa"
                      onChange={(e) => {
                        setFilterDateFrom(e.target.value);
                        setCurrentPage(1);
                      }}
                      onBlur={() => {
                        if (!filterDateFrom.trim()) return;
                        const normalized = formatToDdMmYyyy(filterDateFrom);
                        if (normalized) setFilterDateFrom(normalized);
                      }}
                      className="w-[126px] pl-2 pr-6 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-white font-mono tabular-nums text-[11px] placeholder-zinc-500 focus:outline-none focus:border-red-500"
                    />
                    <label
                      className="absolute right-1.5 inline-flex items-center text-zinc-400 hover:text-white cursor-pointer"
                      title="Seleccionar fecha inicial"
                    >
                      <Calendar className="w-3 h-3 pointer-events-none" />
                      <input
                        type="date"
                        tabIndex={-1}
                        aria-hidden="true"
                        value={normalizeExcelDate(filterDateFrom).fechaIso || ''}
                        onChange={(e) => {
                          const formatted = formatToDdMmYyyy(e.target.value);
                          setFilterDateFrom(formatted);
                          setCurrentPage(1);
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                    </label>
                  </div>
                  <span className="text-zinc-500">—</span>
                  <div className="relative inline-flex items-center">
                    <input
                      type="text"
                      aria-label="Filtrar hasta fecha"
                      value={filterDateTo}
                      placeholder="Hasta dd-mm-aaaa"
                      onChange={(e) => {
                        setFilterDateTo(e.target.value);
                        setCurrentPage(1);
                      }}
                      onBlur={() => {
                        if (!filterDateTo.trim()) return;
                        const normalized = formatToDdMmYyyy(filterDateTo);
                        if (normalized) setFilterDateTo(normalized);
                      }}
                      className="w-[126px] pl-2 pr-6 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-white font-mono tabular-nums text-[11px] placeholder-zinc-500 focus:outline-none focus:border-red-500"
                    />
                    <label
                      className="absolute right-1.5 inline-flex items-center text-zinc-400 hover:text-white cursor-pointer"
                      title="Seleccionar fecha final"
                    >
                      <Calendar className="w-3 h-3 pointer-events-none" />
                      <input
                        type="date"
                        tabIndex={-1}
                        aria-hidden="true"
                        value={normalizeExcelDate(filterDateTo).fechaIso || ''}
                        onChange={(e) => {
                          const formatted = formatToDdMmYyyy(e.target.value);
                          setFilterDateTo(formatted);
                          setCurrentPage(1);
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                    </label>
                  </div>
                  {(filterDateFrom.trim() || filterDateTo.trim()) && (
                    <button
                      type="button"
                      onClick={() => {
                        setFilterDateFrom('');
                        setFilterDateTo('');
                        setCurrentPage(1);
                      }}
                      title="Limpiar filtro de fechas"
                      className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* Píldoras de Filtro por Semáforo */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs tabular-nums">
                <button
                  type="button"
                  onClick={() => {
                    setFilterMode('TODAS');
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer whitespace-nowrap ${
                    filterMode === 'TODAS'
                      ? 'bg-white text-black'
                      : 'bg-zinc-950 text-zinc-300 border border-white/10 hover:border-white/30'
                  }`}
                >
                  Todas ({counts.total})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFilterMode('VALIDO');
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                    filterMode === 'VALIDO'
                      ? 'bg-emerald-500 text-black'
                      : 'bg-emerald-950/40 text-emerald-300 border border-emerald-500/30 hover:border-emerald-400'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  Válidas ({counts.validas})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFilterMode('ADVERTENCIA');
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                    filterMode === 'ADVERTENCIA'
                      ? 'bg-amber-400 text-black'
                      : 'bg-amber-950/40 text-amber-300 border border-amber-500/30 hover:border-amber-400'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  Advertencias ({counts.advertencias})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFilterMode('ERROR');
                    setCurrentPage(1);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                    filterMode === 'ERROR'
                      ? 'bg-red-500 text-white'
                      : 'bg-red-950/40 text-red-300 border border-red-500/30 hover:border-red-400'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  Errores ({counts.errores})
                </button>
                {counts.duplicadas > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilterMode('DUPLICADAS');
                      setCurrentPage(1);
                    }}
                    className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer whitespace-nowrap ${
                      filterMode === 'DUPLICADAS'
                        ? 'bg-orange-500 text-black'
                        : 'bg-orange-950/40 text-orange-300 border border-orange-500/30'
                    }`}
                  >
                    Duplicadas ({counts.duplicadas})
                  </button>
                )}
              </div>
            </div>

            {/* Contenedor Amplio de la Tabla con Scroll X/Y Suave y Encabezado Sticky */}
            <div className="flex-1 min-h-[380px] lg:min-h-[440px] max-h-[65vh] min-w-0 overflow-auto scroll-smooth rounded-xl border border-white/10 bg-zinc-950">
              <table className="w-full min-w-[1720px] border-collapse text-left text-xs">
                <thead className="bg-zinc-950/95 backdrop-blur-sm text-zinc-300 uppercase text-[10px] font-bold tracking-wider sticky top-0 z-10 border-b border-white/15 shadow-sm whitespace-nowrap">
                  <tr>
                    <th className="p-3 w-11 min-w-[44px] text-center">
                      <input
                        type="checkbox"
                        checked={
                          validatedRows.length > 0 &&
                          selectedRowIndices.size === validatedRows.length
                        }
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedRowIndices(new Set(validatedRows.map((r) => r.rowIndex)));
                          } else {
                            setSelectedRowIndices(new Set());
                          }
                        }}
                        title="Seleccionar / deseleccionar todas las filas del lote"
                        className="accent-red-600 cursor-pointer"
                      />
                    </th>
                    <th className="p-3 min-w-[180px]">Semáforo / Fila</th>
                    <th className="p-3 min-w-[168px]">Fecha</th>
                    <th className="p-3 min-w-[200px]">Turno / Horario</th>
                    <th className="p-3 min-w-[330px]">Cliente / Punto de Venta y Zona</th>
                    <th className="p-3 min-w-[240px]">Producto(s)</th>
                    <th className="p-3 min-w-[96px] text-center">Kilos</th>
                    <th className="p-3 min-w-[195px]">FDV / Vendedor</th>
                    <th className="p-3 min-w-[265px]">Promotora (Catálogo Activo)</th>
                    <th className="p-3 min-w-[250px]">Observaciones</th>
                    <th className="p-3 w-14 min-w-[60px] text-center">Quitar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="p-10 text-center text-xs text-zinc-400">
                        No hay registros que coincidan con el filtro seleccionado.
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => (
                      <PreviewTableRow
                        key={row.rowIndex}
                        row={row}
                        isChecked={selectedRowIndices.has(row.rowIndex)}
                        isPdvMatched={pdvKeySet.has(normalizeCanonicalToken(row.clienteNombre))}
                        pendingDateText={editingDateByRow[row.rowIndex]}
                        datalistId={datalistId}
                        pdvCatalog={pdvCatalog}
                        promotoraCatalog={promotoraCatalog}
                        filePromMatch={
                          row.rawPromotoraArchivo
                            ? promotoraMatchByRaw.get(row.rawPromotoraArchivo) ?? null
                            : null
                        }
                        onToggleSelected={toggleRowSelected}
                        onUpdateDraftRow={updateDraftRow}
                        onRemoveRow={removeDraftRow}
                        onDateTextChange={handleDateTextChange}
                        onDateTextBlur={handleDateTextBlur}
                        onCalendarDatePick={handleCalendarDatePick}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Barra de Paginación Ágil en Cliente (activa automáticamente cuando filteredRows > 150) */}
            {isPaginationActive && (
              <div className="shrink-0 px-3 py-2 rounded-xl bg-zinc-900/80 border border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-300 tabular-nums">
                <div>
                  Mostrando <strong className="text-white">{pageRangeStart}</strong>–
                  <strong className="text-white">{pageRangeEnd}</strong> de{' '}
                  <strong className="text-white">{filteredRows.length}</strong> registros filtrados{' '}
                  <span className="text-zinc-400">
                    (100% del lote activo en memoria para validación y guardado)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed border border-white/10 text-zinc-200 font-semibold flex items-center gap-1 cursor-pointer transition"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Anterior</span>
                  </button>
                  <select
                    aria-label="Seleccionar página"
                    value={safePage}
                    onChange={(e) => setCurrentPage(Number(e.target.value))}
                    className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-white/15 text-white font-semibold cursor-pointer"
                  >
                    {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((pageNum) => (
                      <option key={pageNum} value={pageNum}>
                        Página {pageNum} de {totalPages}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    className="px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed border border-white/10 text-zinc-200 font-semibold flex items-center gap-1 cursor-pointer transition"
                  >
                    <span>Siguiente</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Nota de Auditoría del Lote (shrink-0) */}
            <div className="shrink-0">
              <input
                type="text"
                value={loteNotas}
                onChange={(e) => setLoteNotas(sanitizeCellText(e.target.value))}
                placeholder="Nota opcional de auditoría para este lote (ej. Planificación Semana 46 enviada por FDV Maracaibo)..."
                className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500"
              />
            </div>
          </div>
        )}

        {/* Pie Fijo de Confirmación y Volcado Transaccional (shrink-0) */}
        {showTrayView && (
          <div className="shrink-0 px-4 sm:px-6 py-3 bg-zinc-900/95 border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-zinc-300 min-w-0 tabular-nums">
              Seleccionadas para volcar:{' '}
              <strong className="text-white">{selectedValidatedRows.length}</strong> de{' '}
              {validatedRows.length} filas
              {selectedErrorCount > 0 && (
                <span className="ml-2 text-red-400 font-semibold">
                  • Bloqueado: corrige o desmarca {selectedErrorCount} fila(s) en rojo
                </span>
              )}
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => {
                  resetModalState();
                  onClose();
                }}
                disabled={isDumping}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold border border-white/10 cursor-pointer"
              >
                Cancelar
              </button>

              <button
                type="button"
                disabled={
                  isDumping || selectedValidatedRows.length === 0 || selectedErrorCount > 0
                }
                onClick={() => void handleConfirmDump()}
                className="px-4 sm:px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-black uppercase tracking-wide flex items-center gap-2 shadow-lg shadow-red-950/50 cursor-pointer transition"
              >
                {isDumping ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Volcando Lote a Módulo 2...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>
                      Confirmar y Volcar ({selectedValidatedRows.length}) en PENDIENTE_APROBACION
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modalNode, document.body);
};
