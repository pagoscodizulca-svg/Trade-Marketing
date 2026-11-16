/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Calendar, LogOut, MapPin } from 'lucide-react';
import { RoleGuard } from './components/auth/RoleGuard';
import { TradeAuthGate } from './components/auth/TradeAuthGate';
import { AppProvider, useApp } from './context/AppContext';
import { Header, MainNavTab } from './components/common/Header';
import {
  DegustacionesNotificationBell,
  DegustacionesRealtimeToastStack,
} from './components/common/DegustacionesNotificationBell';
import type { VerifiedAuthProfile } from './services/authService';
import { DegustacionNotificationItem } from './types';
import { SyncStatusBadge } from './components/common/SyncStatusBadge';
import { useLiveVenezuelaClock } from './utils/weekCalendar';

// Carga diferida por módulo: reduce el bundle inicial (jsPDF y vistas pesadas se descargan bajo demanda)
const ContraloriaView = lazy(() => import('./components/contraloria/ContraloriaView').then((m) => ({ default: m.ContraloriaView })));
const ScheduleMatrixView = lazy(() => import('./components/schedule/ScheduleMatrixView').then((m) => ({ default: m.ScheduleMatrixView })));
const FieldPromotoraView = lazy(() => import('./components/field/FieldPromotoraView').then((m) => ({ default: m.FieldPromotoraView })));
const ExecutiveDashboard = lazy(() => import('./components/dashboard/ExecutiveDashboard').then((m) => ({ default: m.ExecutiveDashboard })));
const PromotoraRutaPortalView = lazy(() =>
  import('./components/portal/PromotoraRutaPortalView').then((m) => ({
    default: m.PromotoraRutaPortalView,
  }))
);
const UserManagementView = lazy(() =>
  import('./components/users/UserManagementView').then((m) => ({
    default: m.UserManagementView,
  }))
);

function isPromotoraPortalPath(pathname?: string): boolean {
  const rawPath =
    pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '');
  const cleanPath = rawPath.replace(/\/+$/, '').toLowerCase();
  return cleanPath === '/portal' || cleanPath.startsWith('/portal/');
}

function isUserManagementPath(pathname?: string): boolean {
  const rawPath =
    pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '');
  const cleanPath = rawPath.replace(/\/+$/, '').toLowerCase();
  return cleanPath === '/admin/usuarios' || cleanPath === '/usuarios';
}

const MainAppContent: React.FC<{
  authProfile: VerifiedAuthProfile;
  isLocalDevWorkstation: boolean;
  onSignOut: () => Promise<void>;
}> = ({ authProfile, isLocalDevWorkstation, onSignOut }) => {
  const [activeTab, setActiveTabState] = useState<MainNavTab>(() =>
    isUserManagementPath() ? 'gestion_usuarios' : 'promotoras'
  );

  const setActiveTab = useCallback((nextTab: MainNavTab) => {
    setActiveTabState(nextTab);
    if (typeof window !== 'undefined') {
      const currentPath = window.location.pathname.replace(/\/+$/, '').toLowerCase();
      if (nextTab === 'gestion_usuarios' && currentPath !== '/admin/usuarios') {
        window.history.pushState({}, '', '/admin/usuarios');
      } else if (
        nextTab !== 'gestion_usuarios' &&
        (currentPath === '/admin/usuarios' || currentPath === '/usuarios')
      ) {
        window.history.pushState({}, '', '/');
      }
    }
  }, []);

  useEffect(() => {
    const syncTabFromUrl = () => {
      if (isUserManagementPath()) {
        setActiveTabState('gestion_usuarios');
      } else {
        setActiveTabState((prev) => (prev === 'gestion_usuarios' ? 'promotoras' : prev));
      }
    };
    window.addEventListener('popstate', syncTabFromUrl);
    return () => window.removeEventListener('popstate', syncTabFromUrl);
  }, []);
  const liveClock = useLiveVenezuelaClock();
  const {
    degustacionNotifications,
    setFocusedTastingId,
    setFocusedTastingSnapshot,
  } = useApp();

  const handleOpenDegustacionNotification = useCallback(
    (item: DegustacionNotificationItem) => {
      void degustacionNotifications.markAsRead(item.id);
      setFocusedTastingSnapshot(item);
      setFocusedTastingId(item.id);
      setActiveTab('promotoras');
    },
    [degustacionNotifications, setFocusedTastingId, setFocusedTastingSnapshot]
  );

  const handleOpenDegustacionFromToast = useCallback(
    (surveyId: string) => {
      const matched = degustacionNotifications.unreadItems.find((i) => i.id === surveyId) || null;
      void degustacionNotifications.markAsRead(surveyId);
      if (matched) {
        setFocusedTastingSnapshot(matched);
      }
      setFocusedTastingId(surveyId);
      setActiveTab('promotoras');
    },
    [degustacionNotifications, setFocusedTastingId, setFocusedTastingSnapshot]
  );

  const activeModuleTitle: Record<MainNavTab, { title: string; badge: string }> = {
    promotoras: { title: 'Módulo 1 · Promotoras y Fuerza de Ventas (FDV)', badge: 'Campo & Merchandising' },
    llenado_cronograma: { title: 'Módulo 2 · Cronograma y Matriz de Productos', badge: 'Llenado por Lote' },
    contraloria: { title: 'Módulo 3 · Contraloría y Auditoría Interna', badge: 'Conciliación & Paz y Salvo' },
    kpis_trazabilidad: { title: 'Módulo 4 · KPIs y Trazabilidad Ejecutiva', badge: 'Torre de Control' },
    gestion_usuarios: { title: 'Seguridad IAM · Gestión de Usuarios Corporativos', badge: 'Super Admin' },
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-white flex flex-col md:flex-row font-sans selection:bg-red-600 selection:text-white relative overflow-x-hidden">
      
      {/* Panel Lateral Izquierdo con los 4 Módulos en Vertical (Negro, Rojo y Blanco) */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />

      {/* Área Principal de Contenido (Lado Derecho — sin stacking context sellado) */}
      <div className="flex-1 min-w-0 flex flex-col justify-between relative">
        {/* Encabezado Superior del Sistema con Logo Oficial de Codizulca */}
        <div className="bg-zinc-950/85 border-b border-white/[0.07] backdrop-blur-xl sticky top-0 z-20 no-print">
          <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-white p-1 flex items-center justify-center shadow-[0_2px_12px_rgba(220,38,38,0.25)] border border-white/90 shrink-0">
                <img
                  src="/codizulca-logo.png"
                  alt="Logo CODIZULCA C.A."
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-sm sm:text-base font-extrabold text-white tracking-tight truncate">
                    CODIZULCA C.A.
                  </h1>
                  <span className="hidden sm:inline-block whitespace-nowrap shrink-0 text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md bg-white/[0.06] text-zinc-300 border border-white/10">
                    RIF: J-07011928-0
                  </span>
                </div>
                <p className="text-xs text-zinc-400 truncate">
                  {activeModuleTitle[activeTab].title}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <div
                className="hidden 2xl:inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-900/90 border border-white/10 text-[11px] font-mono text-zinc-200"
                title="Sincronización automática de fechas y semana calendario (Hora Venezuela UTC-4)"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <Calendar className="w-3.5 h-3.5 text-red-400" />
                <span className="font-bold text-white">Sem. {liveClock.isoWeekNumber}</span>
                <span className="text-zinc-500">·</span>
                <span>{liveClock.currentWeek.rangeLabel}</span>
                <span className="text-zinc-500">·</span>
                <span className="text-red-300 font-semibold">Hoy: {liveClock.todayDayLabel}</span>
              </div>
              <span className="hidden xl:inline-flex px-3 py-1 rounded-full bg-red-500/15 text-red-400 border border-red-500/25 text-xs font-semibold">
                {activeModuleTitle[activeTab].badge}
              </span>

              {/* Estado de sincronización con el servidor + sincronización manual */}
              <SyncStatusBadge />

              {/* Globito de Notificaciones en Tiempo Real (Degustaciones FDV -> Trade Marketing) */}
              <DegustacionesNotificationBell
                unreadItems={degustacionNotifications.unreadItems}
                unreadCount={degustacionNotifications.unreadCount}
                isLoading={degustacionNotifications.isLoadingNotifications}
                isRealtimeConnected={degustacionNotifications.isRealtimeConnected}
                hasRecentArrivalPulse={degustacionNotifications.hasRecentArrivalPulse}
                onSelectNotification={handleOpenDegustacionNotification}
                onMarkAsRead={degustacionNotifications.markAsRead}
                onMarkAllAsRead={degustacionNotifications.markAllAsRead}
              />

              <a
                href="/portal"
                target="_blank"
                rel="noopener noreferrer"
                title="Abrir Portal de Promotoras (/portal)"
                className="hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-bold text-zinc-200 transition"
              >
                <MapPin className="w-3.5 h-3.5 text-red-400" />
                <span>/portal</span>
              </a>

              {isLocalDevWorkstation && (
                <button
                  type="button"
                  onClick={() => void onSignOut()}
                  title="Cambiar a sesión autenticada con Supabase Auth (JWT)"
                  className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-[11px] font-bold text-amber-200 transition cursor-pointer"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  <span>Modo Local · Autenticar</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => void onSignOut()}
                title={
                  isLocalDevWorkstation
                    ? 'Volver al inicio de sesión corporativo'
                    : `Cerrar sesión (${authProfile.email})`
                }
                className="p-2 rounded-xl bg-zinc-900 hover:bg-red-950/60 border border-white/10 hover:border-red-700 text-zinc-300 hover:text-red-300 transition cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Alertas Visuales Instantáneas (Toast) al recibir nuevas degustaciones */}
        <DegustacionesRealtimeToastStack
          toasts={degustacionNotifications.activeToasts}
          onDismiss={degustacionNotifications.dismissToast}
          onOpenDegustacion={handleOpenDegustacionFromToast}
        />

        <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-24 text-sm text-zinc-300 font-mono" role="status" aria-live="polite">
                <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping mr-2.5" />
                Cargando módulo corporativo...
              </div>
            }
          >
            {/* Modulo 1: Promotoras y FDV */}
            {activeTab === 'promotoras' && <FieldPromotoraView />}

            {/* Modulo 2: Llenado por productos(Cronograma) */}
            {activeTab === 'llenado_cronograma' && <ScheduleMatrixView />}

            {/* Modulo 3: Contraloría */}
            {activeTab === 'contraloria' && <ContraloriaView />}

            {/* Modulo 4: KPI y Trazabilidad */}
            {activeTab === 'kpis_trazabilidad' && <ExecutiveDashboard />}

            {/* Módulo IAM Exclusivo Super Admin: Gestión de Usuarios */}
            {activeTab === 'gestion_usuarios' && (
              <RoleGuard
                allowedRoles={['super_admin']}
                variant="route"
                onReturnHome={() => setActiveTab('promotoras')}
              >
                <UserManagementView />
              </RoleGuard>
            )}
          </Suspense>
        </main>

        {/* Codizulca Corporate Footer (Negro, Rojo y Blanco) */}
        <footer className="bg-black border-t border-white/10 py-5 mt-8 text-xs text-zinc-400 relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-red-600 to-transparent opacity-80" />
          <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-white p-0.5 flex items-center justify-center shadow-sm border border-white/80 shrink-0">
                <img
                  src="/codizulca-logo.png"
                  alt="Logo CODIZULCA C.A."
                  className="w-full h-full object-contain"
                />
              </div>
              <div>
                <span className="font-black text-white uppercase tracking-wider">CODIZULCA C.A.</span>
                <span className="text-zinc-400 hidden sm:inline"> · Comercializadora y Distribuidora del Zulia C.A.</span>
              </div>
            </div>
            <div className="font-mono text-zinc-300 text-[11px] flex flex-wrap items-center gap-2.5">
              <span className="px-2 py-0.5 rounded bg-zinc-900 border border-white/10 text-white font-bold">RIF: J-07011928-0</span>
              <span className="text-red-500 font-bold">·</span>
              <span>Sistema Corporativo de Trade Marketing & Contraloría</span>
            </div>
          </div>
        </footer>
      </div>

    </div>
  );
};

export default function App() {
  const [isPortalRoute, setIsPortalRoute] = useState<boolean>(() => isPromotoraPortalPath());

  useEffect(() => {
    const handleRouteChange = () => {
      setIsPortalRoute(isPromotoraPortalPath());
    };
    window.addEventListener('popstate', handleRouteChange);
    return () => {
      window.removeEventListener('popstate', handleRouteChange);
    };
  }, []);

  if (isPortalRoute) {
    return (
      <Suspense
        fallback={
          <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center text-sm font-mono">
            Cargando Portal de Promotoras (/portal)...
          </div>
        }
      >
        <PromotoraRutaPortalView />
      </Suspense>
    );
  }

  return (
    <TradeAuthGate>
      {({ profile, isLocalDevWorkstation, onSignOut }) => (
        <AppProvider verifiedProfile={profile}>
          <MainAppContent
            authProfile={profile}
            isLocalDevWorkstation={isLocalDevWorkstation}
            onSignOut={onSignOut}
          />
        </AppProvider>
      )}
    </TradeAuthGate>
  );
}
