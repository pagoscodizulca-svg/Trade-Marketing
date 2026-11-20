/**
 * Inicialización síncrona del tema corporativo en /logistica antes de montar React (Cero FOUC).
 * Comparte la clave `codizulca.ui_theme` con Torre de Control, /portal y /cliente.
 */
export type RutaUiThemeMode = 'default' | 'control-room';

export const UI_THEME_STORAGE_KEY = 'codizulca.ui_theme';

export function normalizeRutaUiThemeMode(raw: unknown): RutaUiThemeMode {
  return raw === 'default' ? 'default' : 'control-room';
}

export function readStoredRutaUiThemeMode(): RutaUiThemeMode {
  if (typeof window === 'undefined') return 'control-room';
  try {
    return normalizeRutaUiThemeMode(window.localStorage.getItem(UI_THEME_STORAGE_KEY));
  } catch {
    return 'control-room';
  }
}

export function applyRutaUiThemeToDocument(mode: RutaUiThemeMode): void {
  if (typeof document === 'undefined') return;
  const normalized = normalizeRutaUiThemeMode(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', normalized);
  root.style.colorScheme = normalized === 'control-room' ? 'dark' : 'light';
}

export function persistRutaUiThemeMode(mode: RutaUiThemeMode): RutaUiThemeMode {
  const normalized = normalizeRutaUiThemeMode(mode);
  applyRutaUiThemeToDocument(normalized);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(UI_THEME_STORAGE_KEY, normalized);
    } catch {
      // Almacenamiento restringido: aplica solo en sesión actual
    }
  }
  return normalized;
}

if (typeof document !== 'undefined') {
  applyRutaUiThemeToDocument(readStoredRutaUiThemeMode());
}
