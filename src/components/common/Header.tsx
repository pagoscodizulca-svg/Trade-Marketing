import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  Calendar,
  Smartphone,
  Scale,
  BarChart3,
  ChevronRight,
  ShieldCheck,
  Database,
} from 'lucide-react';
import { GlobalExportPdfModal } from './GlobalExportPdfModal';
import { RoleGuard } from '../auth/RoleGuard';
import { useApp } from '../../context/AppContext';
import type { ManagedUserRole } from '../../services/userManagementService';

export type MainNavTab =
  | 'promotoras'
  | 'llenado_cronograma'
  | 'maestros'
  | 'contraloria'
  | 'kpis_trazabilidad'
  | 'gestion_usuarios';

export const MODULE_ALLOWED_ROLES: Record<MainNavTab, readonly ManagedUserRole[]> = {
  promotoras: ['super_admin', 'coordinacion'],
  llenado_cronograma: ['super_admin', 'coordinacion'],
  maestros: ['super_admin', 'coordinacion'],
  contraloria: ['super_admin', 'contraloria', 'coordinacion'],
  kpis_trazabilidad: ['super_admin', 'contraloria', 'coordinacion'],
  gestion_usuarios: ['super_admin'],
};

interface HeaderProps {
  activeTab: MainNavTab;
  setActiveTab: (tab: MainNavTab) => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
}) => {
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const { degustacionNotifications, solicitudesContraloria } = useApp();
  const unreadDegCount = degustacionNotifications.unreadCount;
  const pendingContraloriaCount = solicitudesContraloria.pendingCount;

  const navItems: { id: MainNavTab; label: string; subtitle: string; icon: React.ReactNode }[] = [
    {
      id: 'promotoras',
      label: 'Promotoras y FDV',
      subtitle: 'Campo, Informes & Merch',
      icon: <Smartphone className="w-4 h-4" />,
    },
    {
      id: 'llenado_cronograma',
      label: 'Cronograma de Productos',
      subtitle: 'Matriz de Llenado e Insumos',
      icon: <Calendar className="w-4 h-4" />,
    },
    {
      id: 'maestros',
      label: 'Maestros (PDVs y Zonas)',
      subtitle: 'Clientes, Cadenas & FDV',
      icon: <Database className="w-4 h-4" />,
    },
    {
      id: 'contraloria',
      label: 'Contraloría Interna',
      subtitle: 'Conciliación & Paz y Salvo',
      icon: <Scale className="w-4 h-4" />,
    },
    {
      id: 'kpis_trazabilidad',
      label: 'KPIs y Trazabilidad',
      subtitle: 'Torre de Control Ejecutiva',
      icon: <BarChart3 className="w-4 h-4" />,
    },
  ];

  return (
    <aside className="w-full md:w-64 shrink-0 bg-[#09090b]/95 border-b md:border-b-0 md:border-r border-white/[0.07] flex flex-col justify-between md:min-h-screen md:sticky md:top-0 z-30 backdrop-blur-xl no-print">
      <div>
        {/* Línea fina superior en rojo corporativo */}
        <div className="h-[2px] w-full bg-gradient-to-r from-red-700 via-red-500 to-transparent" />

        {/* Identidad Corporativa con Logo Oficial de Codizulca */}
        <div className="px-5 py-5 border-b border-white/[0.06]">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-white p-1 flex items-center justify-center shadow-[0_4px_14px_rgba(220,38,38,0.28)] border border-white/90 shrink-0">
              <img
                src="/codizulca-logo.png"
                alt="Logo Oficial CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-sm text-white tracking-tight">
                  CODIZULCA
                </span>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-400 border border-red-500/25">
                  C.A.
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                Trade Marketing & Contraloría
              </p>
            </div>
          </div>
        </div>

        {/* Navegación Vertical Estilizada */}
        <div className="p-3.5 space-y-1.5">
          <div className="px-2.5 py-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Módulos Operativos
            </span>
          </div>

          <nav className="flex flex-col gap-1" aria-label="Navegación de Módulos">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <RoleGuard key={item.id} allowedRoles={MODULE_ALLOWED_ROLES[item.id]}>
                <button
                  type="button"
                  title={`${item.label} — ${item.subtitle}`}
                  aria-label={`${item.label} — ${item.subtitle}`}
                  onClick={() => setActiveTab(item.id)}
                  className={`group relative w-full px-3 py-2.5 rounded-xl text-left flex items-center gap-2.5 transition-all cursor-pointer ${
                    isActive
                      ? 'bg-gradient-to-r from-red-600 to-red-700 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_4px_14px_-2px_rgba(220,38,38,0.45)] border border-red-500/40'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] border border-transparent hover:border-white/[0.06]'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                      isActive
                        ? 'bg-white/15 text-white shadow-inner'
                        : 'bg-zinc-900/90 text-zinc-400 border border-white/[0.06] group-hover:text-red-400 group-hover:border-red-500/30'
                    }`}
                  >
                    {item.icon}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-1.5">
                      <span
                        className={`text-xs block leading-snug line-clamp-2 break-words ${
                          isActive ? 'font-bold text-white' : 'font-semibold text-zinc-200 group-hover:text-white'
                        }`}
                      >
                        {item.label}
                      </span>
                      {item.id === 'promotoras' && unreadDegCount > 0 && (
                        <span
                          className={`shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[9px] font-black font-mono leading-none ${
                            isActive
                              ? 'bg-[#FFFFFF] text-[#DC2626]'
                              : 'bg-[#DC2626] text-[#FFFFFF] animate-pulse'
                          }`}
                          title={`${unreadDegCount} degustación(es) nueva(s) sin leer`}
                        >
                          {unreadDegCount > 99 ? '99+' : unreadDegCount}
                        </span>
                      )}
                      {item.id === 'contraloria' && pendingContraloriaCount > 0 && (
                        <span
                          className={`shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[9px] font-black font-mono leading-none ${
                            isActive
                              ? 'bg-[#FFFFFF] text-[#DC2626]'
                              : 'bg-[#DC2626] text-[#FFFFFF] animate-pulse'
                          }`}
                          title={`${pendingContraloriaCount} solicitud(es) pendiente(s) por aprobar en Bandeja de Entrada`}
                        >
                          {pendingContraloriaCount > 99 ? '99+' : pendingContraloriaCount}
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-[10px] block truncate mt-0.5 ${
                        isActive ? 'text-red-100/90' : 'text-zinc-500 group-hover:text-zinc-400'
                      }`}
                    >
                      {item.subtitle}
                    </span>
                  </div>

                  <ChevronRight
                    className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                      isActive
                        ? 'text-white/90 translate-x-0'
                        : 'text-zinc-600 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0'
                    }`}
                  />
                </button>
                </RoleGuard>
              );
            })}
          </nav>

          <RoleGuard allowedRoles={['super_admin']}>
            <div className="pt-3 mt-2 border-t border-white/[0.06] space-y-1">
              <div className="px-2.5 py-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Seguridad IAM
                </span>
              </div>

              <button
                type="button"
                data-testid="nav-gestion-usuarios"
                title="Gestión de Usuarios — Roles, Accesos & Auditoría IAM"
                aria-label="Gestión de Usuarios — Roles, Accesos & Auditoría IAM"
                onClick={() => setActiveTab('gestion_usuarios')}
                className={`group relative w-full px-3 py-2.5 rounded-xl text-left flex items-center gap-2.5 transition-all cursor-pointer ${
                  activeTab === 'gestion_usuarios'
                    ? 'bg-gradient-to-r from-red-600 to-red-700 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_4px_14px_-2px_rgba(220,38,38,0.45)] border border-red-500/40'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] border border-transparent hover:border-white/[0.06]'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                    activeTab === 'gestion_usuarios'
                      ? 'bg-white/15 text-white shadow-inner'
                      : 'bg-zinc-900/90 text-zinc-400 border border-white/[0.06] group-hover:text-red-400 group-hover:border-red-500/30'
                  }`}
                >
                  <ShieldCheck className="w-4 h-4" />
                </div>

                <div className="min-w-0 flex-1">
                  <span
                    className={`text-xs block leading-snug ${
                      activeTab === 'gestion_usuarios'
                        ? 'font-bold text-white'
                        : 'font-semibold text-zinc-200 group-hover:text-white'
                    }`}
                  >
                    Gestión de Usuarios
                  </span>
                  <span
                    className={`text-[10px] block truncate mt-0.5 ${
                      activeTab === 'gestion_usuarios'
                        ? 'text-red-100/90'
                        : 'text-zinc-500 group-hover:text-zinc-400'
                    }`}
                  >
                    Roles, Accesos & Auditoría
                  </span>
                </div>

                <ChevronRight
                  className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                    activeTab === 'gestion_usuarios'
                      ? 'text-white/90 translate-x-0'
                      : 'text-zinc-600 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0'
                  }`}
                />
              </button>
            </div>
          </RoleGuard>
        </div>
      </div>

      {/* Pie del Panel Lateral con Botón Estilizado */}
      <div className="p-3.5 border-t border-white/[0.06] space-y-3">
        <button
          type="button"
          onClick={() => setIsExportModalOpen(true)}
          title="Exportar Soporte Oficial en PDF (Imprimir o Descargar)"
          className="w-full h-9 px-3.5 rounded-xl bg-zinc-900/90 hover:bg-red-600 text-zinc-100 hover:text-white text-xs font-semibold flex items-center justify-center gap-2 border border-white/10 hover:border-red-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-all cursor-pointer group"
        >
          <FileText className="w-3.5 h-3.5 text-red-400 group-hover:text-white transition-colors" />
          <span>Exportar Documento PDF</span>
        </button>

        <div className="px-2 flex items-center justify-between text-[10px] text-zinc-500 font-mono">
          <span>RIF: J-07011928-0</span>
          <span className="inline-flex items-center gap-1.5 text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Online
          </span>
        </div>
      </div>

      {/* Global Export PDF / Print Modal (Portal en document.body para escapar de backdrop-blur del aside) */}
      {typeof document !== 'undefined' &&
        isExportModalOpen &&
        createPortal(
          <GlobalExportPdfModal
            isOpen={isExportModalOpen}
            onClose={() => setIsExportModalOpen(false)}
            activeTab={activeTab}
          />,
          document.body
        )}
    </aside>
  );
};
