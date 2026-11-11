import React, { useState } from 'react';
import { FileText, Printer, Download, X, CheckCircle2, Building2 } from 'lucide-react';
import { triggerBrowserPrint, getFormattedTimestamp } from '../../utils/pdfExport';

interface ExportPdfButtonProps {
  label?: string;
  documentTitle?: string;
  subtitle?: string;
  onExportPdf: () => void | Promise<void>;
  className?: string;
  variant?: 'primary' | 'secondary' | 'compact';
  badgeText?: string;
  customPrint?: () => void;
}

export const ExportPdfButton: React.FC<ExportPdfButtonProps> = ({
  label = 'Exportar a PDF',
  documentTitle = 'Soporte Codizulca',
  subtitle,
  onExportPdf,
  className = '',
  variant = 'primary',
  badgeText,
  customPrint,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  const handleDownload = async () => {
    try {
      await onExportPdf();
      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 3500);
    } catch {
      // Error de exportación silenciado para no exponer objetos internos en consola
    }
  };

  const handlePrint = () => {
    setIsModalOpen(false);
    if (customPrint) {
      customPrint();
    } else {
      triggerBrowserPrint(`CODIZULCA - ${documentTitle}`);
    }
  };

  const getButtonStyles = () => {
    if (variant === 'secondary') {
      return 'bg-zinc-900/90 hover:bg-zinc-800 text-zinc-100 border-white/10 hover:border-red-500/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';
    }
    if (variant === 'compact') {
      return 'bg-zinc-900/90 hover:bg-zinc-800 text-zinc-200 border-white/10 hover:border-red-500/50 text-xs py-1.5 px-3';
    }
    // primary default (Sleek Red Codizulca)
    return 'bg-red-600 hover:bg-red-500 text-white border-red-500/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_2px_10px_-2px_rgba(220,38,38,0.45)]';
  };

  return (
    <>
      {/* Botón estilizado sin menú desplegable */}
      <button
        type="button"
        onClick={() => setIsModalOpen(true)}
        title="Abrir opciones para imprimir o descargar en PDF"
        className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold tracking-wide border transition-all cursor-pointer ${getButtonStyles()} ${className}`}
      >
        <FileText className="w-3.5 h-3.5 text-white/90" />
        <span>{label}</span>
        {badgeText && (
          <span className="text-[9px] px-1.5 py-0.2 bg-black/40 rounded border border-white/20 text-white font-mono lowercase">
            {badgeText}
          </span>
        )}
      </button>

      {/* Ventana Modal que se abre al hacer clic */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fadeIn">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl relative overflow-hidden">
            
            {/* Resplandor decorativo */}
            <div className="absolute top-0 right-0 w-48 h-48 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />

            {/* Cabecera del modal */}
            <div className="flex items-center justify-between pb-4 border-b border-zinc-900">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center font-black text-white text-base shadow-lg shadow-red-950/70 border border-red-500">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-black text-white tracking-tight">
                    Exportar Documento Oficial
                  </h3>
                  <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-red-500 inline" />
                    <span>CODIZULCA C.A. • RIF J-07011928-0</span>
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Ficha resumen del documento */}
            <div className="mt-4 p-4 rounded-xl bg-black border border-zinc-900 space-y-2">
              <span className="text-[10px] font-black uppercase tracking-wider text-red-500 block">
                Documento a Generar:
              </span>
              <h4 className="text-sm font-black text-white leading-tight">
                {documentTitle}
              </h4>
              {subtitle && (
                <p className="text-xs text-zinc-400">
                  {subtitle}
                </p>
              )}
              <div className="pt-2 border-t border-zinc-900/80 flex items-center justify-between text-[11px] text-zinc-500 font-mono">
                <span>Fecha: {getFormattedTimestamp()}</span>
                <span className="text-emerald-400 font-bold">● Formato Certificado</span>
              </div>
            </div>

            {/* Mensaje de confirmación de descarga */}
            {downloadSuccess && (
              <div className="mt-4 p-3 bg-emerald-950/40 border border-emerald-500/50 rounded-xl flex items-center gap-2 text-xs text-emerald-300 animate-fadeIn">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>¡Archivo PDF descargado exitosamente en tu equipo!</span>
              </div>
            )}

            {/* Botones de Acción: IMPRIMIR y DESCARGAR */}
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Botón Imprimir */}
              <button
                type="button"
                onClick={handlePrint}
                className="flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white font-bold text-xs border border-zinc-700 hover:border-zinc-500 transition shadow-sm group"
              >
                <Printer className="w-4 h-4 text-zinc-300 group-hover:text-white transition" />
                <span>Imprimir Soporte</span>
              </button>

              {/* Botón Descargar PDF */}
              <button
                type="button"
                onClick={handleDownload}
                className="flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-black text-xs border border-red-500 transition shadow-lg shadow-red-950/70"
              >
                <Download className="w-4 h-4 text-white" />
                <span>Descargar PDF</span>
              </button>
            </div>

            {/* Pie del modal */}
            <div className="mt-4 pt-3 border-t border-zinc-900 flex justify-end">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white transition"
              >
                Cerrar
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  );
};
