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
