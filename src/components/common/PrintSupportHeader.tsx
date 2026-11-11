import React from 'react';
import { getFormattedTimestamp } from '../../utils/pdfExport';

interface PrintSupportHeaderProps {
  moduleTitle: string;
  documentSubtitle?: string;
  documentCode?: string;
}

export const PrintSupportHeader: React.FC<PrintSupportHeaderProps> = ({
  moduleTitle,
  documentSubtitle = 'Sistema Integral de Gestión de Trade Marketing, PDV y Contraloría',
  documentCode = 'CZ-SOPORTE-2026',
}) => {
  return (
    <div className="print-only mb-6 border-b-2 border-black pb-4 text-black">
      {/* Top Banner Bar */}
      <div className="flex items-center justify-between pb-3 border-b border-gray-300">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 border border-gray-300 rounded-lg bg-white p-0.5 flex items-center justify-center">
            <img
              src="/codizulca-logo.png"
              alt="Logo CODIZULCA C.A."
              className="w-full h-full object-contain"
            />
          </div>
          <div>
            <h1 className="text-base font-black tracking-tight text-black uppercase">
              CODIZULCA C.A.
            </h1>
            <p className="text-[10px] text-gray-700">
              Comercializadora y Distribuidora del Zulia C.A. • RIF: J-07011928-0
            </p>
          </div>
        </div>

        <div className="text-right text-[10px] text-gray-800">
          <div className="font-bold text-red-700">{documentCode}</div>
          <div>Emisión: {getFormattedTimestamp()}</div>
          <div className="font-semibold text-gray-600">Soporte Físico y Trazabilidad Operativa</div>
        </div>
      </div>

      {/* Document Title */}
      <div className="mt-3">
        <h2 className="text-sm font-extrabold uppercase text-black">
          {moduleTitle}
        </h2>
        <p className="text-xs text-gray-600">
          {documentSubtitle}
        </p>
      </div>
    </div>
  );
};

export const PrintSignatureBlock: React.FC = () => {
  return (
    <div className="print-only mt-10 pt-4 border-t border-gray-300 text-black">
      <div className="grid grid-cols-3 gap-6 text-center text-xs">
        <div>
          <div className="border-t border-black pt-2 font-bold">
            SUPERVISOR DE TRADE MARKETING
          </div>
          <div className="text-[10px] text-gray-600">Elaboración y Verificación de Campo</div>
        </div>
        <div>
          <div className="border-t border-black pt-2 font-bold">
            CONTRALORÍA & AUDITORÍA INTERNA
          </div>
          <div className="text-[10px] text-gray-600">Revisión Fiscal e Inventarios</div>
        </div>
        <div>
          <div className="border-t border-black pt-2 font-bold">
            PROMOTORA LÍDER / CLIENTE PDV
          </div>
          <div className="text-[10px] text-gray-600">Conforme / Recepción en Tienda</div>
        </div>
      </div>

      <div className="mt-4 text-[9px] text-gray-500 text-center">
        CODIZULCA C.A. • Documento emitido bajo directrices de Cero Papel y Trazabilidad Inmutable.
      </div>
    </div>
  );
};
