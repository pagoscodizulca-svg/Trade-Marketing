import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import {
  ShieldCheck,
  CheckCircle2,
  AlertOctagon,
  Receipt,
  Scale,
  Upload,
  Lock,
  FileCheck,
  Plus,
  FileSpreadsheet,
  X,
  Inbox,
} from 'lucide-react';
import { RequisitionStatus } from '../../types';
import { ExportPdfButton } from '../common/ExportPdfButton';
import { exportContraloriaPdf } from '../../utils/pdfExport';
import { PrintSupportHeader, PrintSignatureBlock } from '../common/PrintSupportHeader';
import { ContraloriaSolicitudesInbox } from './ContraloriaSolicitudesInbox';

export type ContraloriaSubTab = 'bandeja_entrada' | 'conciliacion_auditoria';

export const ContraloriaView: React.FC = () => {
  const {
    currentRole,
    requests,
    reconciliation,
    solicitudesContraloria,
    advanceRequisitionWorkflow,
    createRequisition,
    addFiscalReceipt,
    validateFiscalReceipt,
    updateReconciliation,
    closeReconciliationAndIssuePazYSalvo,
  } = useApp();

  const [activeSubTab, setActiveSubTab] =
    useState<ContraloriaSubTab>('bandeja_entrada');

  const [selectedReqCode, setSelectedReqCode] = useState<string>('');
  const activeReq = requests.find((r) => r.requestCode === selectedReqCode) || requests[0];

  // Estado de transiciones del flujo
  const [justificationText, setJustificationText] = useState<string>('');
  const [transitionMsg, setTransitionMsg] = useState<{ text: string; isError?: boolean } | null>(
    null
  );

  // Modal: Radicar Nueva Requisición Oficial
  const [isNewReqModalOpen, setIsNewReqModalOpen] = useState<boolean>(false);
  const [newReqCode, setNewReqCode] = useState<string>('');
  const [newReqDate, setNewReqDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [newReqPurpose, setNewReqPurpose] = useState<string>('');
  const [newReqRecipient, setNewReqRecipient] = useState<string>('');
  const [newReqDestination, setNewReqDestination] = useState<string>('');
  const [newReqNotes, setNewReqNotes] = useState<string>('');
  const [newReqProduct, setNewReqProduct] = useState<string>('');
  const [newReqQty, setNewReqQty] = useState<number>(1);
  const [newReqUnit, setNewReqUnit] = useState<string>('Pieza (1kg)');
  const [newReqUnitCost, setNewReqUnitCost] = useState<number>(0);
  const [newReqBudgetCap, setNewReqBudgetCap] = useState<number>(0);

  // Modal: Cargar Comprobante Fiscal real (sin valores prellenados ficticios)
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState<boolean>(false);
  const [invoiceNumber, setInvoiceNumber] = useState<string>('');
  const [supplierRif, setSupplierRif] = useState<string>('');
  const [supplierName, setSupplierName] = useState<string>('');
  const [invoiceConcept, setInvoiceConcept] = useState<string>('');
  const [invoiceTotal, setInvoiceTotal] = useState<string>('');

  // Notas de cierre Paz y Salvo
  const [pazYSalvoNotes, setPazYSalvoNotes] = useState<string>('');

  const handleOpenNewReqModal = () => {
    const seq = String(requests.length + 1).padStart(4, '0');
    setNewReqCode(`MP-${new Date().getFullYear()}-${seq}`);
    setNewReqDate(new Date().toISOString().slice(0, 10));
    setNewReqPurpose('');
    setNewReqRecipient('');
    setNewReqDestination('');
    setNewReqNotes('');
    setNewReqProduct('');
    setNewReqQty(1);
    setNewReqUnit('Pieza (1kg)');
    setNewReqUnitCost(0);
    setNewReqBudgetCap(0);
    setIsNewReqModalOpen(true);
  };

  const handleCreateRequisitionSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const [yyyy, mm, dd] = newReqDate.split('-');
    const formattedDate = yyyy && mm && dd ? `${dd}/${mm}/${yyyy}` : newReqDate;
    const qty = Math.max(1, Number(newReqQty) || 1);
    const unitCost = Math.max(0, Number(newReqUnitCost) || 0);
    const totalCost = +(qty * unitCost).toFixed(2);
    const code = newReqCode.trim() || `MP-${new Date().getFullYear()}-${String(requests.length + 1).padStart(4, '0')}`;

    createRequisition({
      requestCode: code,
      requestDate: formattedDate,
      campaignOrPurpose: newReqPurpose.trim(),
      targetRecipient: newReqRecipient.trim() || 'Facturación / Almacén Codizulca',
      deliveryDestination: newReqDestination.trim() || 'Despacho Operativo Trade Marketing',
      notesAndObservations: newReqNotes.trim(),
      approvedBudgetCapUsd: Math.max(totalCost, Number(newReqBudgetCap) || totalCost),
      status: 'VALIDACION_COMERCIAL',
      items: [
        {
          id: `item_${Date.now()}`,
          itemNumber: 1,
          productName: newReqProduct.trim(),
          category: 'PRODUCTO_DEGUSTACION',
          quantityRequested: qty,
          unitOfMeasure: newReqUnit.trim() || 'Unid',
          unitCostUsd: unitCost,
          totalCostUsd: totalCost,
        },
      ],
    });

    setSelectedReqCode(code);
    updateReconciliation({
      requestCode: code,
      productName: newReqProduct.trim(),
      deliveredUnits: qty,
      degustatedUnitsReported: 0,
      returnedRemanentUnits: 0,
      pazYSalvoIssued: false,
    });
    setIsNewReqModalOpen(false);
    setTransitionMsg({ text: `Requisición ${code} radicada correctamente en Contraloría.` });
  };

  const handleSelectRequisition = (code: string) => {
    setSelectedReqCode(code);
    const found = requests.find((r) => r.requestCode === code);
    if (found && reconciliation.requestCode !== found.requestCode) {
      updateReconciliation({
        requestId: found.id,
        requestCode: found.requestCode,
        productName: found.items[0]?.productName || found.campaignOrPurpose,
        deliveredUnits: found.totalUnits,
        degustatedUnitsReported: 0,
        returnedRemanentUnits: 0,
        pazYSalvoIssued: false,
      });
    }
  };

  const handleAdvance = (nextStatus: RequisitionStatus) => {
    if (!activeReq) return;
    const res = advanceRequisitionWorkflow(activeReq.id, nextStatus, justificationText);
    setTransitionMsg({ text: res.message, isError: !res.success });
    setJustificationText('');
  };

  const handleCreateReceipt = (e: React.FormEvent) => {
    e.preventDefault();
    const totalNum = Math.max(0, parseFloat(invoiceTotal) || 0);
    if (!invoiceNumber.trim() || !supplierRif.trim() || totalNum <= 0) return;

    const res = addFiscalReceipt({
      invoiceNumber: invoiceNumber.trim(),
      supplierRif: supplierRif.trim().toUpperCase(),
      supplierName: supplierName.trim(),
      concept: invoiceConcept.trim(),
      subtotalUsd: +(totalNum / 1.16).toFixed(2),
      taxAmountUsd: +(totalNum - totalNum / 1.16).toFixed(2),
      totalUsd: totalNum,
      imageUrl: '',
    });
    setTransitionMsg({ text: res.message, isError: !res.success });
    if (res.success) {
      setInvoiceNumber('');
      setSupplierRif('');
      setSupplierName('');
      setInvoiceConcept('');
      setInvoiceTotal('');
      setIsReceiptModalOpen(false);
    }
  };

  const handleIssuePazYSalvo = () => {
    const notes =
      pazYSalvoNotes.trim() ||
      `Conciliación conforme para solicitud ${activeReq?.requestCode || reconciliation.requestCode}.`;
    const res = closeReconciliationAndIssuePazYSalvo(notes);
    setTransitionMsg({ text: res.message, isError: !res.success });
  };

  const workflowStages: { key: RequisitionStatus; label: string; roleAuth: string }[] = [
    { key: 'BORRADOR', label: '1. Creación', roleAuth: 'Supervisor' },
    { key: 'VALIDACION_COMERCIAL', label: '2. Validación Trade', roleAuth: 'Jefe Trade' },
    { key: 'REVISION_FINANCIERA', label: '3. Revisión Contraloría', roleAuth: 'Analista' },
    { key: 'APROBADO_CONTRALORIA', label: '4. Aprobación Final', roleAuth: 'Gerencia' },
    { key: 'DESPACHADO_ALMACEN', label: '5. Despacho Almacén', roleAuth: 'Almacén' },
    { key: 'EN_EJECUCION', label: '6. En PDVs', roleAuth: 'Promotoras' },
    { key: 'RENDICION_PENDIENTE', label: '7. En Rendición', roleAuth: 'Supervisor' },
    { key: 'CONCILIADO_CERRADO', label: '8. Paz y Salvo', roleAuth: 'Contraloría' },
  ];

  const currentStageIndex = activeReq
    ? workflowStages.findIndex((s) => s.key === activeReq.status)
    : -1;

  const varianceUnits =
    reconciliation.deliveredUnits -
    (reconciliation.degustatedUnitsReported + reconciliation.returnedRemanentUnits);

  return (
    <div className="space-y-6">
      {/* Membrete oficial exclusivo para soporte impreso / PDF */}
      <PrintSupportHeader
        moduleTitle="MÓDULO 3: CONTRALORÍA - ACTA DE CONCILIACIÓN Y PAZ Y SALVO"
        documentSubtitle={
          activeReq
            ? `Auditoría de Requisición N° ${activeReq.requestCode} • Conciliación Trípode de Inventarios`
            : 'Control de Requisiciones, Rendiciones Fiscales y Conciliación de Inventarios'
        }
        documentCode={activeReq ? `CZ-MOD3-${activeReq.requestCode}` : 'CZ-MOD3-CONTRALORIA'}
      />

      {/* Cabecera Contraloría (CODIZULCA - Negro, Blanco y Rojo) */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-red-600/20 text-red-400 uppercase tracking-wider border border-red-500/30">
                CODIZULCA · Contraloría & Auditoría Interna
              </span>
              <span className="text-xs text-slate-400 font-mono">Trazabilidad Fiscal Inmutable</span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Control de Requisiciones, Rendiciones y Paz y Salvo
            </h2>
            <p className="text-xs text-slate-300 mt-1">
              Cotejo de inventario de degustaciones, validación fiscal de facturas y cierre administrativo definitivo.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleOpenNewReqModal}
              className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-black uppercase tracking-wider flex items-center gap-1.5 shadow-md transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nueva Requisición</span>
            </button>

            {activeSubTab === 'conciliacion_auditoria' && activeReq && (
              <>
                <ExportPdfButton
                  label="Exportar a PDF"
                  documentTitle={`Acta de Contraloría - ${activeReq.requestCode}`}
                  onExportPdf={() => exportContraloriaPdf(activeReq, reconciliation, requests)}
                />

                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 font-semibold">Solicitud Activa:</span>
                  <select
                    value={activeReq.requestCode}
                    onChange={(e) => handleSelectRequisition(e.target.value)}
                    className="px-3.5 py-2 rounded-xl bg-slate-950 border border-red-500/60 text-xs font-bold text-red-400 font-mono tracking-wide focus:outline-none focus:border-red-400 shadow-sm"
                  >
                    {requests.map((r) => (
                      <option key={r.id} value={r.requestCode}>
                        {r.requestCode} - {r.totalUnits} un ({r.status})
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Barra de Navegación Interna de Contraloría: Bandeja de Entrada vs Conciliación & Paz y Salvo */}
        <div className="mt-5 pt-4 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap items-center bg-slate-950/90 p-1 rounded-xl border border-white/[0.08] gap-1">
            <button
              type="button"
              onClick={() => setActiveSubTab('bandeja_entrada')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
                activeSubTab === 'bandeja_entrada'
                  ? 'bg-[#DC2626] text-[#FFFFFF] shadow-md'
                  : 'text-zinc-300 hover:text-white hover:bg-white/[0.05]'
              }`}
            >
              <Inbox className="w-3.5 h-3.5" />
              <span>Bandeja de Entrada · Solicitudes de Productos</span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-black ${
                  activeSubTab === 'bandeja_entrada'
                    ? 'bg-[#FFFFFF] text-[#DC2626]'
                    : solicitudesContraloria.pendingCount > 0
                      ? 'bg-[#DC2626] text-[#FFFFFF] animate-pulse'
                      : 'bg-zinc-900 text-zinc-400 border border-white/10'
                }`}
              >
                {solicitudesContraloria.pendingCount > 0
                  ? `${solicitudesContraloria.pendingCount} Pendiente(s)`
                  : solicitudesContraloria.solicitudes.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab('conciliacion_auditoria')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
                activeSubTab === 'conciliacion_auditoria'
                  ? 'bg-[#DC2626] text-[#FFFFFF] shadow-md'
                  : 'text-zinc-300 hover:text-white hover:bg-white/[0.05]'
              }`}
            >
              <Scale className="w-3.5 h-3.5" />
              <span>Conciliación de Inventario, Facturas y Paz y Salvo</span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                  activeSubTab === 'conciliacion_auditoria'
                    ? 'bg-black/30 text-white'
                    : 'bg-zinc-900 text-zinc-400 border border-white/10'
                }`}
              >
                {requests.length}
              </span>
            </button>
          </div>

          {solicitudesContraloria.pendingCount > 0 && (
            <span className="text-xs font-bold text-red-400 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#DC2626] animate-ping" />
              Tiene {solicitudesContraloria.pendingCount} solicitud(es) de degustación pendiente(s) por aprobar
            </span>
          )}
        </div>

        {activeSubTab === 'conciliacion_auditoria' && activeReq && (
          <div className="mt-8 pt-6 border-t border-slate-800/80">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-300">
                Ciclo de Vida de la Requisición ({activeReq.requestCode}):
              </span>
              <span className="text-xs font-bold text-red-400 font-mono px-2.5 py-0.5 rounded-md bg-slate-950 border border-slate-800">
                {activeReq.status}
              </span>
            </div>

            <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
              {workflowStages.map((stage, idx) => {
                const isPast = idx < currentStageIndex;
                const isCurrent = idx === currentStageIndex;
                return (
                  <div
                    key={stage.key}
                    className={`p-2.5 rounded-xl border text-center transition-all ${
                      isCurrent
                        ? 'bg-gradient-to-br from-red-600 to-rose-600 text-white border-red-400/50 shadow-md shadow-red-950/70'
                        : isPast
                        ? 'bg-slate-900 border-slate-700 text-slate-200 font-medium'
                        : 'bg-slate-950/70 border-slate-800/80 text-slate-500'
                    }`}
                  >
                    <span className="text-[10px] font-bold block truncate">{stage.label}</span>
                    <span className="text-[9px] text-slate-400 block mt-0.5">{stage.roleAuth}</span>
                    {isPast && (
                      <span className="text-[10px] text-emerald-400 block mt-0.5 font-bold">✓</span>
                    )}
                    {isCurrent && (
                      <span className="text-[10px] text-white block mt-0.5 font-black">● ACTIVO</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {transitionMsg && (
        <div
          className={`p-4 rounded-xl text-xs flex items-center justify-between border ${
            transitionMsg.isError
              ? 'bg-red-950/40 text-red-300 border-red-600'
              : 'bg-zinc-900 text-white border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2">
            <AlertOctagon className="w-4 h-4 text-red-500 shrink-0" />
            <span className="font-bold">{transitionMsg.text}</span>
          </div>
          <button
            onClick={() => setTransitionMsg(null)}
            className="text-zinc-400 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* Vista 1: Bandeja de Entrada en Tiempo Real de Solicitudes de Productos (Trade Marketing -> Contraloría) */}
      {activeSubTab === 'bandeja_entrada' && (
        <ContraloriaSolicitudesInbox
          onSelectApprovedRequisitionCode={(code) => {
            setSelectedReqCode(code);
          }}
        />
      )}

      {/* Vista 2: Conciliación de Inventario de 3 Vías, Facturas y Paz y Salvo */}
      {activeSubTab === 'conciliacion_auditoria' && (
        <>
      {/* Estado limpio cuando no hay requisiciones registradas aún */}
      {!activeReq ? (
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-10 text-center shadow-xl space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-red-600/15 border border-red-500/30 flex items-center justify-center mx-auto text-red-500">
            <FileSpreadsheet className="w-7 h-7" />
          </div>
          <div className="max-w-lg mx-auto space-y-1.5">
            <h3 className="text-base font-black text-white uppercase tracking-wide">
              Sin Requisiciones Radicadas en Contraloría
            </h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              El módulo se encuentra limpio de datos de prueba. Radique una solicitud real de productos o insumos de degustación para iniciar el flujo de aprobación, conciliación de inventario, carga de comprobantes fiscales y emisión de Paz y Salvo.
            </p>
          </div>
          <div>
            <button
              type="button"
              onClick={handleOpenNewReqModal}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-black uppercase tracking-wider shadow-lg shadow-red-950/60 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Radicar Primera Requisición Real</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Columna Izquierda: Revisión Documental y Flujo de Aprobación */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 shadow-xl">
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-zinc-900">
                <h3 className="text-sm font-black text-white flex items-center gap-2 uppercase tracking-wide">
                  <FileCheck className="w-4 h-4 text-red-500" />
                  Validación Documental ({activeReq.requestCode})
                </h3>
                <span className="text-xs px-2 py-0.5 rounded bg-black text-zinc-300 font-mono border border-zinc-800">
                  {activeReq.requestDate}
                </span>
              </div>

              <div className="space-y-3 text-xs mb-6">
                <div>
                  <span className="text-zinc-400 block font-medium">Propósito de Campaña:</span>
                  <span className="font-bold text-white text-sm">
                    {activeReq.campaignOrPurpose}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-zinc-400 block font-medium">Solicitante:</span>
                    <span className="font-semibold text-zinc-200">{activeReq.applicantName}</span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block font-medium">
                      Destinatario / Facturación:
                    </span>
                    <span className="font-semibold text-zinc-200">{activeReq.targetRecipient}</span>
                  </div>
                </div>
                <div>
                  <span className="text-zinc-400 block font-medium">Destino de Despacho:</span>
                  <span className="font-semibold text-zinc-200">
                    {activeReq.deliveryDestination}
                  </span>
                </div>
                {activeReq.notesAndObservations && (
                  <div className="p-3 rounded-lg bg-black border border-red-900/50">
                    <span className="text-[10px] text-red-500 block uppercase font-black tracking-wider">
                      Observación Oficial:
                    </span>
                    <span className="text-xs text-white font-bold leading-relaxed">
                      {activeReq.notesAndObservations}
                    </span>
                  </div>
                )}
              </div>

              {/* Ítems Solicitados */}
              <div className="border border-zinc-900 rounded-xl p-3 bg-black mb-6">
                <span className="text-xs font-black text-white block mb-2 uppercase tracking-wider">
                  Ítems Registrados
                </span>
                <div className="space-y-2">
                  {activeReq.items.map((it) => (
                    <div
                      key={it.id}
                      className="p-2.5 rounded bg-zinc-950 border border-zinc-900 flex items-center justify-between"
                    >
                      <div>
                        <span className="font-bold text-white block">{it.productName}</span>
                        <span className="text-[10px] text-zinc-400">
                          {it.unitOfMeasure}
                          {it.lotNumber ? (
                            <>
                              {' '}
                              • Lote:{' '}
                              <span className="font-mono text-red-400 font-bold">
                                {it.lotNumber}
                              </span>
                            </>
                          ) : null}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-sm font-black text-white font-mono">
                          {it.quantityRequested} un
                        </span>
                        <span className="text-[10px] text-zinc-400 block font-mono">
                          ${it.totalCostUsd.toFixed(2)} USD
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Botones de Flujo de Aprobación */}
              <div className="p-4 rounded-xl bg-black border border-zinc-900">
                <span className="text-xs font-black text-white block mb-2 uppercase tracking-wider">
                  Aprobaciones Escalonadas (Rol: {currentRole}):
                </span>

                <div className="space-y-2 mb-3">
                  <input
                    type="text"
                    placeholder="Justificación formal de Contraloría / Trade..."
                    value={justificationText}
                    onChange={(e) => setJustificationText(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {activeReq.status === 'BORRADOR' && (
                    <button
                      onClick={() => handleAdvance('VALIDACION_COMERCIAL')}
                      className="col-span-2 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase tracking-wider"
                    >
                      Radicar a Trade Marketing
                    </button>
                  )}

                  {activeReq.status === 'VALIDACION_COMERCIAL' && (
                    <>
                      <button
                        onClick={() => handleAdvance('REVISION_FINANCIERA')}
                        className="py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase"
                      >
                        ✓ Validar Trade
                      </button>
                      <button
                        onClick={() => handleAdvance('AJUSTE_SOLICITADO')}
                        className="py-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white font-bold text-xs border border-zinc-800 uppercase"
                      >
                        Solicitar Ajuste
                      </button>
                    </>
                  )}

                  {activeReq.status === 'REVISION_FINANCIERA' && (
                    <>
                      <button
                        onClick={() => handleAdvance('APROBADO_CONTRALORIA')}
                        className="py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase"
                      >
                        ✓ Conforme Contraloría
                      </button>
                      <button
                        onClick={() => handleAdvance('RECHAZADO')}
                        className="py-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-red-500 font-bold text-xs border border-zinc-800 uppercase"
                      >
                        ✕ Rechazar
                      </button>
                    </>
                  )}

                  {activeReq.status === 'APROBADO_CONTRALORIA' && (
                    <button
                      onClick={() => handleAdvance('DESPACHADO_ALMACEN')}
                      className="col-span-2 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase tracking-wider"
                    >
                      Confirmar Despacho de Almacén
                    </button>
                  )}

                  {activeReq.status === 'DESPACHADO_ALMACEN' && (
                    <button
                      onClick={() => handleAdvance('EN_EJECUCION')}
                      className="col-span-2 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase tracking-wider"
                    >
                      Iniciar Activación en PDVs
                    </button>
                  )}

                  {activeReq.status === 'EN_EJECUCION' && (
                    <button
                      onClick={() => handleAdvance('RENDICION_PENDIENTE')}
                      className="col-span-2 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase tracking-wider"
                    >
                      Cerrar Activación e Iniciar Rendición
                    </button>
                  )}

                  {activeReq.status === 'RENDICION_PENDIENTE' && (
                    <button
                      onClick={() => handleAdvance('CONCILIADO_CERRADO')}
                      className="col-span-2 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase tracking-wider"
                    >
                      Aprobar Cierre Administrativo
                    </button>
                  )}

                  {activeReq.status === 'CONCILIADO_CERRADO' && (
                    <div className="col-span-2 text-center py-2.5 bg-black text-white font-black text-xs rounded-lg border border-red-600 uppercase tracking-wider">
                      ✓ Proceso Conciliado y Cerrado Definitivamente
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Columna Derecha: Conciliación de 3 Vías, Facturas y Paz y Salvo */}
          <div className="lg:col-span-7 space-y-6">
            {/* Ecuación de 3 Vías de Inventario (Editable con datos reales) */}
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 shadow-xl">
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-zinc-900">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-red-600 text-white">
                    <Scale className="w-5 h-5" />
                  </span>
                  <div>
                    <h3 className="text-sm font-black text-white uppercase tracking-wider">
                      Conciliación de Inventario (Ecuación de 3 Vías)
                    </h3>
                    <p className="text-xs text-zinc-400">
                      [Producto Entregado] vs [Producto Degustado] vs [Remanente Devuelto a Stock]
                    </p>
                  </div>
                </div>
                <span
                  className={`text-xs font-black px-2.5 py-0.5 rounded bg-black border uppercase ${
                    varianceUnits === 0
                      ? 'text-emerald-400 border-emerald-600'
                      : 'text-red-500 border-red-600'
                  }`}
                >
                  {varianceUnits === 0 ? 'Cuadrado (0 Merma)' : `Desviación: ${varianceUnits} un`}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
                <div className="p-4 rounded-xl bg-black border border-zinc-900 text-center">
                  <label className="text-[11px] text-zinc-400 block mb-2 font-bold">
                    1. Despachado / Entregado
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={reconciliation.deliveredUnits}
                    onChange={(e) =>
                      updateReconciliation({
                        requestId: activeReq.id,
                        requestCode: activeReq.requestCode,
                        deliveredUnits: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    className="w-24 text-center text-2xl font-black text-white font-mono bg-zinc-950 border border-zinc-800 rounded-lg py-1 focus:outline-none focus:border-red-500"
                  />
                  <span className="text-[10px] text-zinc-400 block mt-1.5 truncate">
                    {activeReq.items[0]?.productName || reconciliation.productName || 'Unidades'}
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-black border border-zinc-900 text-center">
                  <label className="text-[11px] text-zinc-400 block mb-2 font-bold">
                    2. Degustado en PDV
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={reconciliation.degustatedUnitsReported}
                    onChange={(e) =>
                      updateReconciliation({
                        requestId: activeReq.id,
                        requestCode: activeReq.requestCode,
                        degustatedUnitsReported: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    className="w-24 text-center text-2xl font-black text-red-500 font-mono bg-zinc-950 border border-zinc-800 rounded-lg py-1 focus:outline-none focus:border-red-500"
                  />
                  <span className="text-[10px] text-zinc-400 block mt-1.5">
                    Reportadas en ejecución
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-black border border-zinc-900 text-center">
                  <label className="text-[11px] text-zinc-400 block mb-2 font-bold">
                    3. Devuelto a Almacén
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={reconciliation.returnedRemanentUnits}
                    onChange={(e) =>
                      updateReconciliation({
                        requestId: activeReq.id,
                        requestCode: activeReq.requestCode,
                        returnedRemanentUnits: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    className="w-24 text-center text-2xl font-black text-white font-mono bg-zinc-950 border border-zinc-800 rounded-lg py-1 focus:outline-none focus:border-red-500"
                  />
                  <input
                    type="text"
                    placeholder="N° Acta devolución (opcional)"
                    value={reconciliation.returnWarehouseReceiptNumber || ''}
                    onChange={(e) =>
                      updateReconciliation({ returnWarehouseReceiptNumber: e.target.value })
                    }
                    className="mt-1.5 w-full text-center text-[10px] font-mono text-zinc-300 bg-transparent border-b border-zinc-800 focus:outline-none focus:border-red-500"
                  />
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-black border border-red-600/60 flex items-center justify-between text-xs text-white">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-red-500 shrink-0" />
                  <span className="font-bold">
                    Balance Físico: {reconciliation.deliveredUnits} Entregadas ={' '}
                    {reconciliation.degustatedUnitsReported} Degustadas +{' '}
                    {reconciliation.returnedRemanentUnits} Devueltas
                  </span>
                </div>
                <span className="font-mono font-black text-red-500 text-sm">
                  Diferencia: {varianceUnits} un
                </span>
              </div>
            </div>

            {/* Comprobantes Fiscales y Fondo Operativo */}
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 shadow-xl">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3 border-b border-zinc-900">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-red-600 text-white">
                    <Receipt className="w-5 h-5" />
                  </span>
                  <div>
                    <h3 className="text-sm font-black text-white uppercase tracking-wider">
                      Rendición de Gastos y Facturas Fiscales
                    </h3>
                    <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
                      <span>Fondo asignado (USD):</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={reconciliation.approvedPettyCashUsd}
                        onChange={(e) =>
                          updateReconciliation({
                            approvedPettyCashUsd: Math.max(0, parseFloat(e.target.value) || 0),
                          })
                        }
                        className="w-24 px-2 py-0.5 rounded bg-black border border-zinc-800 text-white font-mono text-xs focus:outline-none focus:border-red-500"
                      />
                      <span>
                        • Rendido: ${reconciliation.totalExpensesReportedUsd.toFixed(2)} USD
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => setIsReceiptModalOpen(true)}
                  className="px-3.5 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-black uppercase flex items-center gap-1.5 transition shrink-0"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Cargar Factura Real
                </button>
              </div>

              {reconciliation.receipts.length === 0 ? (
                <div className="p-6 rounded-xl bg-black border border-zinc-900 text-center text-xs text-zinc-500 mb-4">
                  No se han cargado comprobantes fiscales en esta rendición.
                </div>
              ) : (
                <div className="space-y-3 mb-5">
                  {reconciliation.receipts.map((rec) => (
                    <div
                      key={rec.id}
                      className="p-3.5 rounded-xl bg-black border border-zinc-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-white">
                            {rec.invoiceNumber}
                          </span>
                          <span className="text-[10px] text-zinc-400 font-mono">
                            RIF: {rec.supplierRif}
                          </span>
                          <span
                            className={`text-[10px] font-black px-2 py-0.2 rounded uppercase ${
                              rec.isValidatedByContraloria
                                ? 'bg-red-950 text-red-400 border border-red-700'
                                : 'bg-zinc-900 text-zinc-300 border border-zinc-800'
                            }`}
                          >
                            {rec.isValidatedByContraloria ? '✓ CONFORME FISCAL' : 'PENDIENTE'}
                          </span>
                        </div>
                        <p className="font-bold text-white">{rec.supplierName}</p>
                        <p className="text-zinc-400 text-[11px]">{rec.concept}</p>
                      </div>

                      <div className="flex sm:flex-col items-center sm:items-end justify-between gap-1">
                        <span className="font-mono font-black text-sm text-white">
                          ${rec.totalUsd.toFixed(2)}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => validateFiscalReceipt(rec.id, true)}
                            className="px-2.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-white text-[10px] font-bold border border-zinc-800"
                          >
                            Validar
                          </button>
                          <button
                            onClick={() =>
                              validateFiscalReceipt(rec.id, false, 'Observación por Contraloría')
                            }
                            className="px-2.5 py-0.5 rounded bg-red-950 hover:bg-red-900 text-red-400 text-[10px] font-bold border border-red-800"
                          >
                            Observar
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-black border border-zinc-900 flex items-center justify-between text-xs">
                <span className="text-zinc-300 font-medium">
                  Saldo de Caja Chica / Rendición:
                </span>
                <span className="font-mono font-black text-white text-sm">
                  ${reconciliation.balanceDueCompanyOrPromotorUsd.toFixed(2)} USD
                </span>
              </div>
            </div>

            {/* Emisión de Acta Digital de Paz y Salvo */}
            <div className="bg-zinc-950 border border-red-600/80 rounded-2xl p-6 shadow-2xl relative overflow-hidden">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="p-2 rounded-xl bg-red-600 text-white shadow-md">
                    <ShieldCheck className="w-5 h-5" />
                  </span>
                  <div>
                    <h3 className="text-base font-black text-white uppercase tracking-wider">
                      Acta Digital de "Paz y Salvo" de Activación
                    </h3>
                    <p className="text-xs text-zinc-400">
                      Cierre vinculante de responsabilidades con Contraloría Codizulca
                    </p>
                  </div>
                </div>

                {reconciliation.pazYSalvoIssued ? (
                  <span className="px-3 py-1 rounded-full bg-red-600 text-white font-black text-xs flex items-center gap-1.5 uppercase tracking-wider border border-red-500">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    EMITIDO Y VIGENTE
                  </span>
                ) : (
                  <span className="px-3 py-1 rounded-full bg-zinc-900 text-white border border-zinc-800 font-bold text-xs uppercase">
                    PENDIENTE DE CIERRE
                  </span>
                )}
              </div>

              {reconciliation.pazYSalvoIssued ? (
                <div className="p-5 rounded-xl bg-black border border-zinc-900 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-900">
                    <div>
                      <span className="text-xs text-zinc-400 block font-bold">Certificado N°:</span>
                      <span className="text-sm font-black text-red-500 font-mono">
                        PYS-{activeReq.requestCode}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs text-zinc-400 block font-bold">
                        Fecha y Hora de Emisión:
                      </span>
                      <span className="text-xs font-mono text-zinc-200">
                        {reconciliation.pazYSalvoIssueDate
                          ? new Date(reconciliation.pazYSalvoIssueDate).toLocaleString('es-VE')
                          : '—'}
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-zinc-300 leading-relaxed font-medium">
                    {reconciliation.auditNotes}
                  </p>

                  <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs border-t border-zinc-900">
                    <div className="font-mono text-[10px] text-zinc-400 truncate max-w-sm">
                      Firma Criptográfica: {reconciliation.pazYSalvoHash}
                    </div>
                    <ExportPdfButton
                      label="Exportar a PDF"
                      documentTitle={`Paz y Salvo Oficial - ${activeReq.requestCode}`}
                      onExportPdf={() => exportContraloriaPdf(activeReq, reconciliation, requests)}
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <textarea
                    rows={2}
                    placeholder="Ingrese las observaciones reales de auditoría documental y física para emitir el Paz y Salvo..."
                    value={pazYSalvoNotes}
                    onChange={(e) => setPazYSalvoNotes(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600"
                  />
                  <button
                    onClick={handleIssuePazYSalvo}
                    className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase tracking-widest shadow-xl shadow-red-950/60 flex items-center justify-center gap-2 transition"
                  >
                    <Lock className="w-4 h-4" />
                    Emitir "Paz y Salvo" y Sellar Cierre de Solicitud {activeReq.requestCode}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
        </>
      )}

      {/* Modal: Radicar Nueva Requisición Oficial */}
      {isNewReqModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm overflow-y-auto">
          <div className="relative w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
              <div>
                <span className="text-[10px] font-black text-red-500 uppercase tracking-widest">
                  Trade Marketing → Contraloría
                </span>
                <h3 className="text-base font-black text-white uppercase tracking-wide">
                  Radicar Nueva Requisición de Productos
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsNewReqModalOpen(false)}
                className="p-1.5 rounded-lg bg-zinc-900 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateRequisitionSubmit} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-zinc-300 mb-1">Código de Solicitud</label>
                  <input
                    type="text"
                    required
                    value={newReqCode}
                    onChange={(e) => setNewReqCode(e.target.value)}
                    placeholder="Ej: MP-2026-0001"
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-600"
                  />
                </div>
                <div>
                  <label className="block font-bold text-zinc-300 mb-1">Fecha de Solicitud</label>
                  <input
                    type="date"
                    required
                    value={newReqDate}
                    onChange={(e) => setNewReqDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-600"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-zinc-300 mb-1">
                  Campaña / Propósito de Uso
                </label>
                <input
                  type="text"
                  required
                  value={newReqPurpose}
                  onChange={(e) => setNewReqPurpose(e.target.value)}
                  placeholder="Descripción real de la campaña o degustación"
                  className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-600"
                />
              </div>

              <div>
                <label className="block font-bold text-zinc-300 mb-1">
                  Producto / Insumo Solicitado
                </label>
                <input
                  type="text"
                  required
                  value={newReqProduct}
                  onChange={(e) => setNewReqProduct(e.target.value)}
                  placeholder="Nombre del producto Codizulca"
                  className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-600"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-bold text-zinc-300 mb-1">Cantidad</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={newReqQty}
                    onChange={(e) => setNewReqQty(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-600"
                  />
                </div>
                <div>
                  <label className="block font-bold text-zinc-300 mb-1">Costo Unit. (USD)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    value={newReqUnitCost}
                    onChange={(e) => setNewReqUnitCost(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-600"
                  />
                </div>
                <div>
                  <label className="block font-bold text-zinc-300 mb-1">Tope Partida (USD)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={newReqBudgetCap}
                    onChange={(e) => setNewReqBudgetCap(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-zinc-300 mb-1">
                    Responsable Recepción / Facturación
                  </label>
                  <input
                    type="text"
                    value={newReqRecipient}
                    onChange={(e) => setNewReqRecipient(e.target.value)}
                    placeholder="Responsable de retiro"
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-600"
                  />
                </div>
                <div>
                  <label className="block font-bold text-zinc-300 mb-1">Destino / Almacén</label>
                  <input
                    type="text"
                    value={newReqDestination}
                    onChange={(e) => setNewReqDestination(e.target.value)}
                    placeholder="Destino físico"
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-600"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-zinc-300 mb-1">Observaciones</label>
                <textarea
                  rows={2}
                  value={newReqNotes}
                  onChange={(e) => setNewReqNotes(e.target.value)}
                  placeholder="Instrucciones u observaciones adicionales"
                  className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-600"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-900">
                <button
                  type="button"
                  onClick={() => setIsNewReqModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-zinc-900 text-zinc-300 font-bold"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-black uppercase tracking-wider"
                >
                  Radicar Solicitud
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Cargar Comprobante Fiscal Real */}
      {isReceiptModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm overflow-y-auto">
          <div className="relative w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl p-6">
            <h3 className="text-base font-black text-white uppercase tracking-wider mb-2">
              Cargar Comprobante Fiscal Digital
            </h3>
            <p className="text-xs text-zinc-400 mb-4">
              Registro formal con validación de RIF y prevención de doble rendición para Codizulca.
            </p>

            <form onSubmit={handleCreateReceipt} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-zinc-300 mb-1">
                    N° de Factura
                  </label>
                  <input
                    type="text"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    placeholder="Ingrese N° de factura"
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-600"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-300 mb-1">
                    RIF del Proveedor
                  </label>
                  <input
                    type="text"
                    value={supplierRif}
                    onChange={(e) => setSupplierRif(e.target.value)}
                    placeholder="Ej: J-00000000-0"
                    className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-600"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-300 mb-1">
                  Razón Social del Proveedor
                </label>
                <input
                  type="text"
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  placeholder="Nombre fiscal del proveedor"
                  className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-300 mb-1">
                  Concepto del Gasto
                </label>
                <input
                  type="text"
                  value={invoiceConcept}
                  onChange={(e) => setInvoiceConcept(e.target.value)}
                  placeholder="Detalle del insumo o servicio facturado"
                  className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-300 mb-1">
                  Monto Total (USD)
                </label>
                <input
                  type="number"
                  min={0.01}
                  step="0.01"
                  value={invoiceTotal}
                  onChange={(e) => setInvoiceTotal(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-xs text-white font-mono font-bold focus:outline-none focus:border-red-600"
                  required
                />
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setIsReceiptModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-zinc-900 text-zinc-300 text-xs font-bold"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-black uppercase tracking-wider"
                >
                  Validar y Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bloque oficial de firmas para soporte impreso / PDF */}
      <PrintSignatureBlock />
    </div>
  );
};
