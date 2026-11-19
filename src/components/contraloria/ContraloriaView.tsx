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
  FileSpreadsheet,
  FileText,
  Plus,
  X,
  Inbox,
  Loader2,
  ExternalLink,
  DollarSign,
  FolderKanban,
} from 'lucide-react';
import { RequisitionStatus } from '../../types';
import type { PazYSalvoVerificationResult } from '../../types/contraloriaFinancial';
import { ExportPdfButton } from '../common/ExportPdfButton';
import { PrintSupportHeader, PrintSignatureBlock } from '../common/PrintSupportHeader';
import { ContraloriaSolicitudesInbox } from './ContraloriaSolicitudesInbox';
import { AnimatedTabContainer } from '../ui/AnimatedTabContainer';
import {
  SUCURSAL_LABELS,
  type OperativeSucursal,
} from '../../services/userManagementService';

export type ContraloriaSubTab =
  | 'bandeja_entrada'
  | 'conciliacion_auditoria'
  | 'presupuestos_tarifario';

export const ContraloriaView: React.FC = () => {
  const app = useApp();
  const {
    currentUser,
    currentRole,
    verifiedIamRole,
    verifiedSucursal,
    isContraloriaOrAdmin,
    requests,
    reconciliation,
    solicitudesContraloria,
    campanasTrade,
    presupuestosTrade,
    tarifarioCostos,
    selectReconciliationForRequest,
    saveCampanaTrade,
    savePresupuestoTrade,
    saveTarifarioCosto,
    verifyPazYSalvoCertificate,
    advanceRequisitionWorkflow,
    createRequisition,
    addFiscalReceipt,
    validateFiscalReceipt,
    updateReconciliation,
    closeReconciliationAndIssuePazYSalvo,
  } = app;

  const effectiveSucursal =
    (app as unknown as { activeSucursal?: OperativeSucursal | null }).activeSucursal ??
    verifiedSucursal ??
    'GLOBAL';
  const activeRegionLabel = SUCURSAL_LABELS[effectiveSucursal] ?? String(effectiveSucursal);

  const [activeSubTab, setActiveSubTab] =
    useState<ContraloriaSubTab>('bandeja_entrada');

  const [selectedReqCode, setSelectedReqCode] = useState<string>('');
  const activeReq = requests.find((r) => r.requestCode === selectedReqCode) || requests[0];

  // Estado de transiciones y persistencia en BD
  const [justificationText, setJustificationText] = useState<string>('');
  const [isSavingFinancial, setIsSavingFinancial] = useState<boolean>(false);
  const [transitionMsg, setTransitionMsg] = useState<{ text: string; isError?: boolean } | null>(
    null
  );
  const [pysVerification, setPysVerification] = useState<PazYSalvoVerificationResult | null>(null);

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

  // Modal: Cargar Comprobante Fiscal real (con archivo binario PDF/imagen hacia Storage privado)
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState<boolean>(false);
  const [invoiceNumber, setInvoiceNumber] = useState<string>('');
  const [supplierRif, setSupplierRif] = useState<string>('');
  const [supplierName, setSupplierName] = useState<string>('');
  const [invoiceConcept, setInvoiceConcept] = useState<string>('');
  const [invoiceTotal, setInvoiceTotal] = useState<string>('');
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);

  // Notas de cierre Paz y Salvo
  const [pazYSalvoNotes, setPazYSalvoNotes] = useState<string>('');

  // Formularios rápidos para Campañas, Presupuestos y Tarifario en BD
  const [campCodigo, setCampCodigo] = useState<string>('');
  const [campNombre, setCampNombre] = useState<string>('');
  const [campMarca, setCampMarca] = useState<'ASTURIAS' | 'VENCAMPO' | 'GENERAL'>('ASTURIAS');
  const [campInicio, setCampInicio] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [campFin, setCampFin] = useState<string>(() => new Date().toISOString().slice(0, 10));

  const [presPeriodo, setPresPeriodo] = useState<string>(() => new Date().toISOString().slice(0, 7));
  const [presCategoria, setPresCategoria] = useState<string>('Degustaciones BTL');
  const [presMonto, setPresMonto] = useState<string>('');
  const [presCampanaId, setPresCampanaId] = useState<string>('');

  const [editingTarifaId, setEditingTarifaId] = useState<string | null>(null);
  const [editingTarifaCost, setEditingTarifaCost] = useState<string>('');
  const [editingTarifaPrice, setEditingTarifaPrice] = useState<string>('');

  const isReconciliationLocked = Boolean(reconciliation.cerrada || reconciliation.pazYSalvoIssued);

  const handleOpenNewReqModal = () => {
    setNewReqCode('AUTO');
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

  const handleCreateRequisitionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingFinancial) return;
    const [yyyy, mm, dd] = newReqDate.split('-');
    const formattedDate = yyyy && mm && dd ? `${dd}/${mm}/${yyyy}` : newReqDate;
    const qty = Math.max(1, Number(newReqQty) || 1);
    const unitCost = Math.max(0, Number(newReqUnitCost) || 0);
    const totalCost = +(qty * unitCost).toFixed(2);
    const requestedCode = newReqCode.trim().toUpperCase();

    setIsSavingFinancial(true);
    try {
      const res = await createRequisition({
        requestCode: requestedCode && requestedCode !== 'AUTO' ? requestedCode : undefined,
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

      setTransitionMsg({ text: res.message, isError: !res.success });
      if (res.success && res.requisicion) {
        setSelectedReqCode(res.requisicion.requestCode);
        setIsNewReqModalOpen(false);
      }
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleSelectRequisition = (code: string) => {
    setSelectedReqCode(code);
    setPysVerification(null);
    const found = requests.find((r) => r.requestCode === code);
    if (found) {
      selectReconciliationForRequest(found.id);
    }
  };

  const handleAdvance = async (nextStatus: RequisitionStatus) => {
    if (!activeReq || isSavingFinancial) return;
    const requiresControllerAuthority =
      nextStatus === 'APROBADO_CONTRALORIA' ||
      nextStatus === 'RECHAZADO' ||
      nextStatus === 'CONCILIADO_CERRADO';

    if (requiresControllerAuthority && !isContraloriaOrAdmin) {
      setTransitionMsg({
        text: 'Segregación de Funciones: esta etapa requiere autorización exclusiva de Contraloría Interna o Administración General.',
        isError: true,
      });
      return;
    }

    setIsSavingFinancial(true);
    try {
      const res = await advanceRequisitionWorkflow(activeReq.id, nextStatus, justificationText);
      setTransitionMsg({ text: res.message, isError: !res.success });
      if (res.success) setJustificationText('');
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleCreateReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingFinancial) return;
    const totalNum = Math.max(0, parseFloat(invoiceTotal) || 0);
    if (!invoiceNumber.trim() || !supplierRif.trim() || totalNum <= 0) return;

    setIsSavingFinancial(true);
    try {
      const res = await addFiscalReceipt(
        {
          invoiceNumber: invoiceNumber.trim(),
          supplierRif: supplierRif.trim().toUpperCase(),
          supplierName: supplierName.trim(),
          concept: invoiceConcept.trim(),
          subtotalUsd: +(totalNum / 1.16).toFixed(2),
          taxAmountUsd: +(totalNum - totalNum / 1.16).toFixed(2),
          totalUsd: totalNum,
          imageUrl: '',
        },
        invoiceFile
      );
      setTransitionMsg({ text: res.message, isError: !res.success });
      if (res.success) {
        setInvoiceNumber('');
        setSupplierRif('');
        setSupplierName('');
        setInvoiceConcept('');
        setInvoiceTotal('');
        setInvoiceFile(null);
        setIsReceiptModalOpen(false);
      }
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleValidateReceipt = async (receiptId: string, isValid: boolean, notes?: string) => {
    if (isSavingFinancial) return;
    if (!isContraloriaOrAdmin) {
      setTransitionMsg({
        text: 'Segregación de Funciones: solo Contraloría Interna o Super Admin puede validar comprobantes fiscales.',
        isError: true,
      });
      return;
    }
    setIsSavingFinancial(true);
    try {
      const res = await validateFiscalReceipt(receiptId, isValid, notes);
      setTransitionMsg({ text: res.message, isError: !res.success });
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleIssuePazYSalvo = async () => {
    if (isSavingFinancial) return;
    if (!isContraloriaOrAdmin) {
      setTransitionMsg({
        text: 'Segregación de Funciones: solo Contraloría Interna o Administración General pueden emitir y sellar un Paz y Salvo.',
        isError: true,
      });
      return;
    }
    const notes =
      pazYSalvoNotes.trim() ||
      `Conciliación conforme para solicitud ${activeReq?.requestCode || reconciliation.requestCode}.`;
    setIsSavingFinancial(true);
    try {
      const res = await closeReconciliationAndIssuePazYSalvo(notes);
      setTransitionMsg({ text: res.message, isError: !res.success });
      setPysVerification(null);
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleVerifyPazYSalvoServer = async () => {
    const certCode =
      reconciliation.pazYSalvoCertificateCode ||
      (activeReq ? `PYS-${activeReq.requestCode}` : '');
    if (!certCode || isSavingFinancial) return;
    setIsSavingFinancial(true);
    try {
      const result = await verifyPazYSalvoCertificate(certCode);
      setPysVerification(result);
      setTransitionMsg({
        text: result.valid
          ? `Integridad SHA-256 VERIFICADA en PostgreSQL para ${result.codigo_certificado}.`
          : `No se pudo verificar la integridad criptográfica de ${certCode}.`,
        isError: !result.valid,
      });
    } catch (err) {
      setTransitionMsg({
        text: err instanceof Error ? err.message : 'Error verificando SHA-256 en servidor.',
        isError: true,
      });
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleSaveCampanaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingFinancial) return;
    setIsSavingFinancial(true);
    try {
      const res = await saveCampanaTrade({
        codigo: campCodigo,
        nombre: campNombre,
        marca: campMarca,
        fecha_inicio: campInicio,
        fecha_fin: campFin,
      });
      setTransitionMsg({ text: res.message, isError: !res.success });
      if (res.success) {
        setCampCodigo('');
        setCampNombre('');
      }
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleSavePresupuestoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingFinancial) return;
    const monto = parseFloat(presMonto);
    if (!Number.isFinite(monto) || monto < 0) return;
    setIsSavingFinancial(true);
    try {
      const res = await savePresupuestoTrade({
        campana_id: presCampanaId || null,
        periodo_ym: presPeriodo,
        categoria: presCategoria,
        monto_asignado_usd: monto,
      });
      setTransitionMsg({ text: res.message, isError: !res.success });
      if (res.success) setPresMonto('');
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleSaveTarifaRow = async (tarifa: (typeof tarifarioCostos)[number]) => {
    if (isSavingFinancial) return;
    const nextCost = parseFloat(editingTarifaCost);
    const nextPrice = parseFloat(editingTarifaPrice);
    if (!Number.isFinite(nextCost) || nextCost <= 0 || !Number.isFinite(nextPrice) || nextPrice < 0) {
      setTransitionMsg({ text: 'Ingresa un costo (>0) y precio (>=0) válidos.', isError: true });
      return;
    }
    setIsSavingFinancial(true);
    try {
      const res = await saveTarifarioCosto({
        id: tarifa.id,
        line_id: tarifa.line_id,
        etiqueta: tarifa.etiqueta,
        marca: tarifa.marca,
        unidad_medida: tarifa.unidad_medida,
        costo_unitario_usd: nextCost,
        precio_referencia_usd: nextPrice,
        vigente_desde: tarifa.vigente_desde,
        sucursal: tarifa.sucursal,
      });
      setTransitionMsg({ text: res.message, isError: !res.success });
      if (res.success) setEditingTarifaId(null);
    } finally {
      setIsSavingFinancial(false);
    }
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

  const handleExportContraloriaPdf = async () => {
    if (!activeReq) return;
    const { exportContraloriaPdf } = await import('../../utils/pdfExport');
    await exportContraloriaPdf(activeReq, reconciliation, requests, {
      regionLabel: activeRegionLabel,
    });
  };

  const handleExportContraloriaXlsx = async () => {
    const { downloadExecutiveWorkbookXlsx } = await import('../../utils/excelWordExport');
    const todayIso = new Date().toISOString().slice(0, 10);
    await downloadExecutiveWorkbookXlsx(
      {
        title: 'Contraloría Interna · Requisiciones, Conciliación y Presupuestos',
        generatedBy: currentUser?.name || 'Contraloría Interna CODIZULCA',
        regionLabel: activeRegionLabel,
        sheets: [
          {
            name: 'Requisiciones MP-07',
            headers: [
              'Código',
              'Fecha',
              'Campaña / Propósito',
              'Solicitante',
              'Estado',
              'Tope Aprobado (USD)',
              'Costo Ejecutado (USD)',
            ],
            rows: requests.map((r) => [
              r.requestCode,
              r.requestDate,
              r.campaignOrPurpose,
              r.applicantName,
              r.status,
              r.approvedBudgetCapUsd,
              r.estimatedCostUsd,
            ]),
            currencyColumns: [5, 6],
          },
          {
            name: 'Conciliación Trípode',
            headers: [
              'Solicitud',
              'Entregadas',
              'Degustadas',
              'Devueltas',
              'Diferencia',
              'Estado Conciliación',
              'Certificado Paz y Salvo',
            ],
            rows: [
              [
                activeReq?.requestCode || reconciliation.requestCode || '—',
                reconciliation.deliveredUnits,
                reconciliation.degustatedUnitsReported,
                reconciliation.returnedRemanentUnits,
                varianceUnits,
                reconciliation.discrepancyStatus,
                reconciliation.pazYSalvoCertificateCode || 'PENDIENTE',
              ],
            ],
          },
          {
            name: 'Bandeja Solicitudes',
            headers: ['Correlativo', 'Fecha', 'Solicitado Por', 'Estado', 'Ítems'],
            rows: solicitudesContraloria.solicitudes.map((s) => [
              s.codigoCorrelativo,
              s.fechaSolicitud,
              s.solicitadoPor,
              s.estado,
              s.items.length,
            ]),
          },
        ],
      },
      `codizulca-contraloria-${String(effectiveSucursal).toLowerCase()}-${todayIso}`
    );
  };

  const handleExportContraloriaDocx = async () => {
    const { downloadDocxReport } = await import('../../utils/excelWordExport');
    const todayIso = new Date().toISOString().slice(0, 10);
    await downloadDocxReport(
      {
        title: 'Acta de Auditoría, Conciliación y Paz y Salvo',
        subtitle: activeReq
          ? `Requisición N° ${activeReq.requestCode} · Departamento de Contraloría Interna`
          : 'Reporte Consolidado de Contraloría Interna',
        regionLabel: activeRegionLabel,
        metadata: [
          ['Fecha de emisión', new Date().toLocaleDateString('es-VE')],
          ['Emitido por', currentUser?.name || 'Contraloría Interna CODIZULCA'],
          ['Solicitud activa', activeReq?.requestCode || 'Consolidado'],
          ['Unidades entregadas', String(reconciliation.deliveredUnits)],
          ['Unidades degustadas', String(reconciliation.degustatedUnitsReported)],
          ['Unidades devueltas', String(reconciliation.returnedRemanentUnits)],
          ['Diferencia inventario', String(varianceUnits)],
        ],
        sections: [
          {
            heading: 'Requisiciones y Control Presupuestario',
            table: {
              headers: ['Código', 'Propósito', 'Estado', 'Tope (USD)', 'Ejecutado (USD)'],
              rows: requests.map((r) => [
                r.requestCode,
                r.campaignOrPurpose,
                r.status,
                r.approvedBudgetCapUsd.toFixed(2),
                r.estimatedCostUsd.toFixed(2),
              ]),
            },
          },
        ],
        pazYSalvo:
          reconciliation.pazYSalvoIssued && reconciliation.pazYSalvoCertificateCode
            ? {
                codigo: reconciliation.pazYSalvoCertificateCode,
                sha256:
                  pysVerification?.stored_sha256 ||
                  pysVerification?.recomputed_sha256 ||
                  String(
                    (activeReq ? app.certificadosPazYSalvo?.[activeReq.id]?.sha256_hash : '') ||
                      (activeReq
                        ? app.certificadosPazYSalvo?.[activeReq.id]?.firma_sha256_hex
                        : '') ||
                      String(reconciliation.pazYSalvoHash || '').replace(/^SHA256:/i, '') ||
                      ''
                  ).trim() ||
                  'VERIFICADO_EN_SERVIDOR',
              }
            : null,
      },
      `codizulca-acta-contraloria-${String(effectiveSucursal).toLowerCase()}-${todayIso}`
    );
  };

  return (
    <div className="space-y-6">
      {/* Membrete oficial exclusivo para soporte impreso / PDF */}
      <PrintSupportHeader
        moduleTitle="MÓDULO 3: CONTRALORÍA - ACTA DE CONCILIACIÓN Y PAZ Y SALVO"
        documentSubtitle={
          activeReq
            ? `Auditoría de Requisición N° ${activeReq.requestCode} • Región / Sucursal Activa: ${activeRegionLabel}`
            : `Control de Requisiciones y Conciliación • Región / Sucursal Activa: ${activeRegionLabel}`
        }
        documentCode={activeReq ? `CZ-MOD3-${activeReq.requestCode}` : 'CZ-MOD3-CONTRALORIA'}
      />

      {/* Cabecera Contraloría (CODIZULCA - Negro, Blanco y Rojo) */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-red-600/20 text-red-400 uppercase tracking-wider border border-red-500/30">
                CODIZULCA · Contraloría & Auditoría Interna
              </span>
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-zinc-950 text-zinc-200 border border-white/10">
                {activeRegionLabel}
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

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleOpenNewReqModal}
              className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-black uppercase tracking-wider flex items-center gap-1.5 shadow-md transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nueva Requisición</span>
            </button>

            <button
              type="button"
              data-testid="btn-contraloria-export-xlsx"
              onClick={() => void handleExportContraloriaXlsx()}
              className="px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold inline-flex items-center gap-1.5 shadow-sm transition cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>Exportar Excel (.xlsx)</span>
            </button>

            <button
              type="button"
              data-testid="btn-contraloria-export-docx"
              onClick={() => void handleExportContraloriaDocx()}
              className="cz-keep-inverse px-3 py-2 rounded-xl bg-[#09090B] hover:bg-zinc-800 border border-zinc-700 text-white text-xs font-bold inline-flex items-center gap-1.5 shadow-sm transition cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Exportar Word (.docx)</span>
            </button>

            {activeReq && (
              <ExportPdfButton
                label="Exportar a PDF"
                documentTitle={`Acta de Contraloría - ${activeReq.requestCode} (${activeRegionLabel})`}
                onExportPdf={handleExportContraloriaPdf}
              />
            )}

            {activeSubTab === 'conciliacion_auditoria' && activeReq && (
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

            <button
              type="button"
              onClick={() => setActiveSubTab('presupuestos_tarifario')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
                activeSubTab === 'presupuestos_tarifario'
                  ? 'bg-[#DC2626] text-[#FFFFFF] shadow-md'
                  : 'text-zinc-300 hover:text-white hover:bg-white/[0.05]'
              }`}
            >
              <DollarSign className="w-3.5 h-3.5" />
              <span>Campañas, Presupuestos y Tarifario BD</span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                  activeSubTab === 'presupuestos_tarifario'
                    ? 'bg-black/30 text-white'
                    : 'bg-zinc-900 text-zinc-400 border border-white/10'
                }`}
              >
                {tarifarioCostos.length}
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
      <AnimatedTabContainer tabKey={activeSubTab} className="space-y-6">
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
                  Aprobaciones Escalonadas (Rol IAM: {verifiedIamRole || currentRole}):
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
                    disabled={isReconciliationLocked}
                    value={reconciliation.deliveredUnits}
                    onChange={(e) =>
                      void updateReconciliation({
                        requestId: activeReq.id,
                        requestCode: activeReq.requestCode,
                        deliveredUnits: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    className="w-24 text-center text-2xl font-black text-white font-mono bg-zinc-950 border border-zinc-800 rounded-lg py-1 focus:outline-none focus:border-red-500 disabled:opacity-50"
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
                    disabled={isReconciliationLocked}
                    value={reconciliation.degustatedUnitsReported}
                    onChange={(e) =>
                      void updateReconciliation({
                        requestId: activeReq.id,
                        requestCode: activeReq.requestCode,
                        degustatedUnitsReported: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    className="w-24 text-center text-2xl font-black text-red-500 font-mono bg-zinc-950 border border-zinc-800 rounded-lg py-1 focus:outline-none focus:border-red-500 disabled:opacity-50"
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
                    disabled={isReconciliationLocked}
                    value={reconciliation.returnedRemanentUnits}
                    onChange={(e) =>
                      void updateReconciliation({
                        requestId: activeReq.id,
                        requestCode: activeReq.requestCode,
                        returnedRemanentUnits: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    className="w-24 text-center text-2xl font-black text-white font-mono bg-zinc-950 border border-zinc-800 rounded-lg py-1 focus:outline-none focus:border-red-500 disabled:opacity-50"
                  />
                  <input
                    type="text"
                    disabled={isReconciliationLocked}
                    placeholder="N° Acta devolución (opcional)"
                    value={reconciliation.returnWarehouseReceiptNumber || ''}
                    onChange={(e) =>
                      void updateReconciliation({ returnWarehouseReceiptNumber: e.target.value })
                    }
                    className="mt-1.5 w-full text-center text-[10px] font-mono text-zinc-300 bg-transparent border-b border-zinc-800 focus:outline-none focus:border-red-500 disabled:opacity-50"
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
                        disabled={isReconciliationLocked}
                        value={reconciliation.approvedPettyCashUsd}
                        onChange={(e) =>
                          void updateReconciliation({
                            approvedPettyCashUsd: Math.max(0, parseFloat(e.target.value) || 0),
                          })
                        }
                        className="w-24 px-2 py-0.5 rounded bg-black border border-zinc-800 text-white font-mono text-xs focus:outline-none focus:border-red-500 disabled:opacity-50"
                      />
                      <span>
                        • Rendido: ${reconciliation.totalExpensesReportedUsd.toFixed(2)} USD
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={isReconciliationLocked || isSavingFinancial}
                  onClick={() => setIsReceiptModalOpen(true)}
                  className="px-3.5 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-black uppercase flex items-center gap-1.5 transition shrink-0"
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
                        <div className="flex flex-wrap items-center gap-2">
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
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          {rec.imageUrl && (
                            <a
                              href={rec.imageUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 font-mono underline"
                            >
                              <ExternalLink className="w-3 h-3" />
                              Ver Comprobante Privado ({rec.mimeType || 'PDF/IMG'})
                            </a>
                          )}
                          {rec.archivoSha256Hex && (
                            <span className="text-[9px] font-mono text-zinc-500">
                              SHA256: {String(rec.archivoSha256Hex || '').slice(0, 14)}…
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex sm:flex-col items-center sm:items-end justify-between gap-1">
                        <span className="font-mono font-black text-sm text-white">
                          ${rec.totalUsd.toFixed(2)}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={isReconciliationLocked || isSavingFinancial || !isContraloriaOrAdmin}
                            onClick={() => void handleValidateReceipt(rec.id, true)}
                            className="px-2.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-[10px] font-bold border border-zinc-800"
                          >
                            Validar
                          </button>
                          <button
                            type="button"
                            disabled={isReconciliationLocked || isSavingFinancial || !isContraloriaOrAdmin}
                            onClick={() =>
                              void handleValidateReceipt(rec.id, false, 'Observación por Contraloría')
                            }
                            className="px-2.5 py-0.5 rounded bg-red-950 hover:bg-red-900 disabled:opacity-40 text-red-400 text-[10px] font-bold border border-red-800"
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
                      Cierre inmutable sellado con SHA-256 en servidor PostgreSQL (`pgcrypto`)
                    </p>
                  </div>
                </div>

                {reconciliation.pazYSalvoIssued ? (
                  <span className="px-3 py-1 rounded-full bg-red-600 text-white font-black text-xs flex items-center gap-1.5 uppercase tracking-wider border border-red-500">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    INMUTABLE · SELLADO
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
                        {reconciliation.pazYSalvoCertificateCode || `PYS-${activeReq.requestCode}`}
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

                  {pysVerification && (
                    <div
                      className={`p-2.5 rounded-lg border text-[11px] font-mono ${
                        pysVerification.valid
                          ? 'bg-emerald-950/40 border-emerald-700/60 text-emerald-300'
                          : 'bg-red-950/50 border-red-700 text-red-300'
                      }`}
                    >
                      {pysVerification.valid
                        ? `✓ VERIFICADO EN SERVIDOR: hash recomputado coincide 100% (${String(
                            pysVerification.recomputed_sha256 || pysVerification.stored_sha256 || ''
                          ).slice(0, 20)}…)`
                        : '✗ ALERTA DE INTEGRIDAD: El hash almacenado no pudo verificarse.'}
                    </div>
                  )}

                  <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs border-t border-zinc-900">
                    <div className="font-mono text-[10px] text-zinc-400 truncate max-w-sm">
                      Firma SHA-256 (BD):{' '}
                      {(() => {
                        const certRow = activeReq
                          ? app.certificadosPazYSalvo?.[activeReq.id]
                          : undefined;
                        const rawHash = String(
                          reconciliation.pazYSalvoHash ||
                            certRow?.sha256_hash ||
                            certRow?.firma_sha256_hex ||
                            ''
                        ).trim();
                        if (!rawHash) return '—';
                        const cleanHash = String(rawHash.replace(/^SHA256:/i, '') || '').slice(
                          0,
                          64
                        );
                        return cleanHash ? `SHA256:${cleanHash}` : '—';
                      })()}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isSavingFinancial}
                        onClick={() => void handleVerifyPazYSalvoServer()}
                        className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-emerald-300 border border-emerald-700/50 text-[11px] font-bold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        Verificar SHA-256
                      </button>
                      <ExportPdfButton
                        label="Exportar a PDF"
                        documentTitle={`Paz y Salvo Oficial - ${activeReq.requestCode} (${activeRegionLabel})`}
                        onExportPdf={handleExportContraloriaPdf}
                      />
                    </div>
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
                    type="button"
                    disabled={isSavingFinancial || !isContraloriaOrAdmin}
                    onClick={() => void handleIssuePazYSalvo()}
                    className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-black text-xs uppercase tracking-widest shadow-xl shadow-red-950/60 flex items-center justify-center gap-2 transition"
                  >
                    {isSavingFinancial ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Lock className="w-4 h-4" />
                    )}
                    {isSavingFinancial
                      ? 'Calculando SHA-256 y Sellando en PostgreSQL...'
                      : `Emitir "Paz y Salvo" y Sellar Cierre de Solicitud ${activeReq.requestCode}`}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
        </>
      )}

      {/* Vista 3: Campañas Trade, Presupuestos y Tarifario Oficial de Costos en BD */}
      {activeSubTab === 'presupuestos_tarifario' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Campañas Trade */}
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center gap-2 border-b border-zinc-900 pb-3">
                <FolderKanban className="w-5 h-5 text-red-500" />
                <div>
                  <h3 className="text-sm font-black text-white uppercase tracking-wider">
                    Campañas Trade Marketing (`campanas_trade`)
                  </h3>
                  <p className="text-[11px] text-zinc-400">
                    Registro multi-sucursal persistido en PostgreSQL
                  </p>
                </div>
              </div>

              <form onSubmit={handleSaveCampanaSubmit} className="grid grid-cols-2 gap-2.5 text-xs">
                <input
                  type="text"
                  required
                  placeholder="Código (ej. CAMP-2026-Q4)"
                  value={campCodigo}
                  onChange={(e) => setCampCodigo(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono"
                />
                <select
                  value={campMarca}
                  onChange={(e) =>
                    setCampMarca(e.target.value as 'ASTURIAS' | 'VENCAMPO' | 'GENERAL')
                  }
                  className="px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white"
                >
                  <option value="ASTURIAS">ASTURIAS</option>
                  <option value="VENCAMPO">VENCAMPO</option>
                  <option value="GENERAL">GENERAL</option>
                </select>
                <input
                  type="text"
                  required
                  placeholder="Nombre de la campaña"
                  value={campNombre}
                  onChange={(e) => setCampNombre(e.target.value)}
                  className="col-span-2 px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white"
                />
                <input
                  type="date"
                  required
                  value={campInicio}
                  onChange={(e) => setCampInicio(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono"
                />
                <input
                  type="date"
                  required
                  value={campFin}
                  onChange={(e) => setCampFin(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono"
                />
                <button
                  type="submit"
                  disabled={isSavingFinancial}
                  className="col-span-2 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-black uppercase text-xs"
                >
                  Guardar Campaña en BD
                </button>
              </form>

              <div className="space-y-2 max-h-52 overflow-y-auto">
                {campanasTrade.length === 0 ? (
                  <p className="text-xs text-zinc-500 text-center py-4">
                    Sin campañas registradas aún.
                  </p>
                ) : (
                  campanasTrade.map((c) => (
                    <div
                      key={c.id}
                      className="p-2.5 rounded-lg bg-black border border-zinc-900 flex items-center justify-between text-xs"
                    >
                      <div>
                        <span className="font-mono font-bold text-red-400">{c.codigo}</span>{' '}
                        <span className="text-white font-semibold">{c.nombre}</span>
                        <div className="text-[10px] text-zinc-500 font-mono">
                          {c.marca} · {c.fecha_inicio} → {c.fecha_fin} · {c.sucursal || 'SEDE'}
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded bg-zinc-900 text-zinc-300 text-[10px] font-mono">
                        {c.estado}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Presupuestos Trade */}
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center gap-2 border-b border-zinc-900 pb-3">
                <DollarSign className="w-5 h-5 text-red-500" />
                <div>
                  <h3 className="text-sm font-black text-white uppercase tracking-wider">
                    Presupuestos Mensuales (`presupuestos_trade`)
                  </h3>
                  <p className="text-[11px] text-zinc-400">
                    Autorización exclusiva de Contraloría Interna / Super Admin
                  </p>
                </div>
              </div>

              <form onSubmit={handleSavePresupuestoSubmit} className="grid grid-cols-2 gap-2.5 text-xs">
                <input
                  type="month"
                  required
                  value={presPeriodo}
                  onChange={(e) => setPresPeriodo(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono"
                />
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  placeholder="Asignado USD"
                  value={presMonto}
                  onChange={(e) => setPresMonto(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white font-mono"
                />
                <input
                  type="text"
                  required
                  placeholder="Partida / Categoría"
                  value={presCategoria}
                  onChange={(e) => setPresCategoria(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white"
                />
                <select
                  value={presCampanaId}
                  onChange={(e) => setPresCampanaId(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-black border border-zinc-800 text-white"
                >
                  <option value="">Sin campaña específica</option>
                  {campanasTrade.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.codigo} - {c.nombre}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={isSavingFinancial || !isContraloriaOrAdmin}
                  className="col-span-2 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-45 text-white font-black uppercase text-xs"
                >
                  Guardar Partida Presupuestaria
                </button>
              </form>

              <div className="space-y-2 max-h-52 overflow-y-auto">
                {presupuestosTrade.length === 0 ? (
                  <p className="text-xs text-zinc-500 text-center py-4">
                    Sin partidas presupuestarias registradas aún.
                  </p>
                ) : (
                  presupuestosTrade.map((p) => (
                    <div
                      key={p.id}
                      className="p-2.5 rounded-lg bg-black border border-zinc-900 flex items-center justify-between text-xs"
                    >
                      <div>
                        <span className="font-mono text-zinc-400">{p.periodo_ym}</span> ·{' '}
                        <span className="text-white font-bold">{p.categoria}</span>
                        <div className="text-[10px] text-zinc-500 font-mono">
                          Ejecutado: ${p.monto_ejecutado_usd.toFixed(2)} / Comprometido: $
                          {p.monto_comprometido_usd.toFixed(2)}
                        </div>
                      </div>
                      <span className="font-mono font-black text-emerald-400">
                        ${p.monto_asignado_usd.toFixed(2)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Tarifario Dinámico de Costos */}
          <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
              <div>
                <h3 className="text-sm font-black text-white uppercase tracking-wider">
                  Tarifario Oficial de Costos de Degustación (`tarifario_costos_trade`)
                </h3>
                <p className="text-[11px] text-zinc-400">
                  Alimenta dinámicamente el motor de factibilidad BTL (`tastingFeasibility.ts`) sin costos fijos en código.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400 uppercase text-[10px]">
                    <th className="py-2 px-3">Línea / Producto</th>
                    <th className="py-2 px-3">Marca</th>
                    <th className="py-2 px-3">Sede</th>
                    <th className="py-2 px-3 text-right">Costo Degustación (USD)</th>
                    <th className="py-2 px-3 text-right">Precio Ref. Anaquel (USD)</th>
                    <th className="py-2 px-3 text-right">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {tarifarioCostos.map((t) => {
                    const isEditing = editingTarifaId === t.id;
                    return (
                      <tr key={t.id} className="hover:bg-zinc-900/40">
                        <td className="py-2.5 px-3 font-semibold text-white">
                          {t.etiqueta}
                          <span className="block text-[10px] font-mono text-zinc-500">
                            {t.line_id} · {t.unidad_medida}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-mono text-zinc-300">{t.marca}</td>
                        <td className="py-2.5 px-3 font-mono text-zinc-400">{t.sucursal || '—'}</td>
                        <td className="py-2.5 px-3 text-right font-mono">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.01"
                              min="0.01"
                              value={editingTarifaCost}
                              onChange={(e) => setEditingTarifaCost(e.target.value)}
                              className="w-24 px-2 py-1 rounded bg-black border border-red-500 text-right text-white"
                            />
                          ) : (
                            <span className="text-red-400 font-bold">
                              ${t.costo_unitario_usd.toFixed(2)}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={editingTarifaPrice}
                              onChange={(e) => setEditingTarifaPrice(e.target.value)}
                              className="w-24 px-2 py-1 rounded bg-black border border-red-500 text-right text-white"
                            />
                          ) : (
                            <span className="text-zinc-200">
                              ${t.precio_referencia_usd.toFixed(2)}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {isEditing ? (
                            <div className="inline-flex gap-1.5">
                              <button
                                type="button"
                                disabled={isSavingFinancial}
                                onClick={() => void handleSaveTarifaRow(t)}
                                className="px-2.5 py-1 rounded bg-red-600 text-white text-[10px] font-bold"
                              >
                                Guardar
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingTarifaId(null)}
                                className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 text-[10px]"
                              >
                                Cancelar
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={!isContraloriaOrAdmin}
                              onClick={() => {
                                setEditingTarifaId(t.id);
                                setEditingTarifaCost(String(t.costo_unitario_usd));
                                setEditingTarifaPrice(String(t.precio_referencia_usd));
                              }}
                              className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-zinc-200 border border-zinc-800 text-[10px] font-bold"
                            >
                              Editar Costo
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      </AnimatedTabContainer>

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

              <div>
                <label className="block text-xs font-bold text-zinc-300 mb-1">
                  Archivo de Factura (PDF, JPEG, PNG o WebP · máx. 10 MB)
                </label>
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  onChange={(e) => setInvoiceFile(e.target.files?.[0] || null)}
                  className="w-full px-3 py-2 rounded-lg bg-black border border-zinc-800 text-xs text-zinc-300 file:mr-3 file:px-2.5 file:py-1 file:rounded file:border-0 file:bg-red-600 file:text-white file:text-[11px] file:font-bold"
                />
                <p className="text-[10px] text-zinc-500 mt-1">
                  El servidor verifica los bytes mágicos reales y guarda el soporte en el bucket privado `contraloria-facturas`.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  disabled={isSavingFinancial}
                  onClick={() => {
                    setInvoiceFile(null);
                    setIsReceiptModalOpen(false);
                  }}
                  className="px-4 py-2 rounded-xl bg-zinc-900 text-zinc-300 text-xs font-bold disabled:opacity-40"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingFinancial}
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-black uppercase tracking-wider inline-flex items-center gap-1.5"
                >
                  {isSavingFinancial && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{isSavingFinancial ? 'Validando y Guardando...' : 'Validar y Guardar'}</span>
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
