/**
 * Inicialización síncrona del tema visual antes del primer render de React (Cero FOUC).
 * Se sirve como módulo propio (`'self'`) para cumplir estrictamente `script-src 'self'` de CSP.
 */
export type UiThemeMode = 'default' | 'control-room';

export const UI_THEME_STORAGE_KEY = 'codizulca.ui_theme';

export function normalizeUiThemeMode(raw: unknown): UiThemeMode {
  return raw === 'control-room' ? 'control-room' : 'default';
}

export function readStoredUiThemeMode(): UiThemeMode {
  if (typeof window === 'undefined') return 'default';
  try {
    return normalizeUiThemeMode(window.localStorage.getItem(UI_THEME_STORAGE_KEY));
  } catch {
    return 'default';
  }
}

export function applyUiThemeToDocument(mode: UiThemeMode): void {
  if (typeof document === 'undefined') return;
  const normalized = normalizeUiThemeMode(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', normalized);
  root.style.colorScheme = normalized === 'control-room' ? 'dark' : 'light';
}

// Ejecución inmediata al importar en la primera línea de main.tsx
if (typeof document !== 'undefined') {
  applyUiThemeToDocument(readStoredUiThemeMode());
}
