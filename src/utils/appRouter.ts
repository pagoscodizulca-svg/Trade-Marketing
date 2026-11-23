/**
 * Enrutamiento real por History API (`M-04`). Funciones puras: mapean rutas URL <-> vistas.
 */
export type AppTab =
  | 'promotoras'
  | 'llenado_cronograma'
  | 'maestros'
  | 'pop_incidencias'
  | 'contraloria'
  | 'kpis_trazabilidad'
  | 'gestion_usuarios';

export type StandaloneRoute = 'portal' | 'cliente';

export type PortalSubTab =
  | 'ruta'
  | 'asistencia'
  | 'encuestas'
  | 'precios'
  | 'inventario'
  | 'merchandising'
  | 'perfil';

export const PORTAL_SUBTAB_TO_PATH: Readonly<Record<PortalSubTab, string>> = {
  ruta: '/portal/ruta',
  asistencia: '/portal/asistencia',
  encuestas: '/portal/encuestas',
  precios: '/portal/precios',
  inventario: '/portal/inventario',
  merchandising: '/portal/merchandising',
  perfil: '/portal/perfil',
};

export function resolvePortalSubTab(pathname: string): PortalSubTab {
  const p = normalizePathname(pathname);
  if (p === '/portal/asistencia' || p === '/portal/checkin') return 'asistencia';
  if (p === '/portal/inventario') return 'inventario';
  if (p === '/portal/encuestas') return 'encuestas';
  if (p === '/portal/precios') return 'precios';
  if (p === '/portal/merchandising') return 'merchandising';
  if (p === '/portal/perfil') return 'perfil';
  return 'ruta';
}

export function pathForPortalSubTab(tab: PortalSubTab): string {
  return PORTAL_SUBTAB_TO_PATH[tab];
}

export const TAB_TO_PATH: Readonly<Record<AppTab, string>> = {
  promotoras: '/promotoras',
  llenado_cronograma: '/cronograma',
  maestros: '/maestros',
  pop_incidencias: '/pop-incidencias',
  contraloria: '/contraloria',
  kpis_trazabilidad: '/kpis',
  gestion_usuarios: '/admin/usuarios',
};

export const STANDALONE_PATHS: Readonly<Record<StandaloneRoute, string>> = {
  portal: '/portal',
  cliente: '/cliente',
};

export type ResolvedRoute =
  | { kind: 'tab'; tab: AppTab }
  | { kind: 'standalone'; route: StandaloneRoute }
  | { kind: 'home' };

export function normalizePathname(pathname: string): string {
  const clean = String(pathname || '/').split(/[?#]/)[0].toLowerCase().replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

export function resolveRoute(pathname: string): ResolvedRoute {
  const p = normalizePathname(pathname);
  if (p === '/portal' || p.startsWith('/portal/')) return { kind: 'standalone', route: 'portal' };
  if (p === '/cliente' || p.startsWith('/cliente/')) return { kind: 'standalone', route: 'cliente' };
  if (p === '/usuarios') return { kind: 'tab', tab: 'gestion_usuarios' };
  for (const [tab, path] of Object.entries(TAB_TO_PATH) as Array<[AppTab, string]>) {
    if (p === path) return { kind: 'tab', tab };
  }
  return { kind: 'home' };
}

export function pathForTab(tab: AppTab): string {
  return TAB_TO_PATH[tab];
}

export function navigateTo(path: string, replace = false): void {
  if (typeof window === 'undefined') return;
  if (normalizePathname(window.location.pathname) === normalizePathname(path)) return;
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
