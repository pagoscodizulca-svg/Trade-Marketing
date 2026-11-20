import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  applyUiThemeToDocument,
  normalizeUiThemeMode,
  readStoredUiThemeMode,
  UI_THEME_STORAGE_KEY,
  type UiThemeMode,
} from '../bootTheme';

export { UI_THEME_STORAGE_KEY, normalizeUiThemeMode, type UiThemeMode };

export interface ThemeModeContextValue {
  mode: UiThemeMode;
  isControlRoom: boolean;
  setMode: (nextMode: UiThemeMode) => void;
  toggleMode: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

export interface ThemeModeProviderProps {
  initialMode?: UiThemeMode;
  children: React.ReactNode;
}

export const ThemeModeProvider: React.FC<ThemeModeProviderProps> = ({
  initialMode,
  children,
}) => {
  const [mode, setModeState] = useState<UiThemeMode>(() =>
    initialMode ? normalizeUiThemeMode(initialMode) : readStoredUiThemeMode()
  );

  useEffect(() => {
    applyUiThemeToDocument(mode);
  }, [mode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleStorage = (ev: StorageEvent) => {
      if (ev.key !== UI_THEME_STORAGE_KEY) return;
      const synced = normalizeUiThemeMode(ev.newValue);
      setModeState(synced);
      applyUiThemeToDocument(synced);
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setMode = useCallback((nextMode: UiThemeMode) => {
    const normalized = normalizeUiThemeMode(nextMode);
    setModeState(normalized);
    applyUiThemeToDocument(normalized);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(UI_THEME_STORAGE_KEY, normalized);
      } catch {
        // Si el navegador restringe almacenamiento, mantiene el estado en memoria y DOM
      }
    }
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((prev) => {
      const next: UiThemeMode = prev === 'control-room' ? 'default' : 'control-room';
      applyUiThemeToDocument(next);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(UI_THEME_STORAGE_KEY, next);
        } catch {
          // Ignorar bloqueo de Web Storage
        }
      }
      return next;
    });
  }, []);

  const value = useMemo<ThemeModeContextValue>(
    () => ({
      mode,
      isControlRoom: mode === 'control-room',
      setMode,
      toggleMode,
    }),
    [mode, setMode, toggleMode]
  );

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
};

const FALLBACK_CONTEXT: ThemeModeContextValue = {
  mode: 'control-room',
  isControlRoom: true,
  setMode: applyUiThemeToDocument,
  toggleMode: () => {
    const next: UiThemeMode = readStoredUiThemeMode() === 'control-room' ? 'default' : 'control-room';
    applyUiThemeToDocument(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(UI_THEME_STORAGE_KEY, next);
      } catch {
        // Ignorar bloqueo
      }
    }
  },
};

export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  return ctx ?? FALLBACK_CONTEXT;
}
