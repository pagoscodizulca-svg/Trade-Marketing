import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Detecta la preferencia del sistema operativo `@media (prefers-reduced-motion: reduce)`.
 * Compatible con SSR (`renderToStaticMarkup`) y pruebas unitarias mediante `forceReducedMotion`.
 */
export function usePrefersReducedMotion(forceReducedMotion?: boolean): boolean {
  const [prefersReduced, setPrefersReduced] = useState<boolean>(() => {
    if (typeof forceReducedMotion === 'boolean') return forceReducedMotion;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof forceReducedMotion === 'boolean') {
      setPrefersReduced(forceReducedMotion);
      return;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (ev: MediaQueryListEvent) => setPrefersReduced(ev.matches);
    setPrefersReduced(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [forceReducedMotion]);

  return typeof forceReducedMotion === 'boolean' ? forceReducedMotion : prefersReduced;
}

export interface AnimatedTabContainerProps {
  /** Clave única de la pestaña o sucursal activa que dispara la micro-transición GPU */
  tabKey: string;
  children: React.ReactNode;
  className?: string;
  /** Permite forzar el modo de movimiento reducido en pruebas determinísticas */
  reducedMotion?: boolean;
  'data-testid'?: string;
}

/**
 * Contenedor de transición micro-interactiva entre pestañas y módulos regionales:
 * - Anima exclusivamente `opacity` y `transform: translate3d(0, 4px, 0) -> translate3d(0, 0, 0)`.
 * - Duración exacta `150ms` con curva `cubic-bezier(0.16, 1, 0.3, 1)` acelerada por GPU.
 * - Respeta estrictamente `@media (prefers-reduced-motion: reduce)`.
 */
export const AnimatedTabContainer: React.FC<AnimatedTabContainerProps> = ({
  tabKey,
  children,
  className = '',
  reducedMotion,
  'data-testid': testId = 'animated-tab-container',
}) => {
  const isReducedMotion = usePrefersReducedMotion(reducedMotion);

  return (
    <div
      key={tabKey}
      data-testid={testId}
      data-tab-key={tabKey}
      data-motion={isReducedMotion ? 'reduced' : 'gpu'}
      className={`${isReducedMotion ? 'cz-tab-panel-static' : 'cz-tab-panel-enter'} ${className}`.trim()}
    >
      {children}
    </div>
  );
};

export interface SlidingTabItem<T extends string = string> {
  id: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
}

export interface SlidingTabRailProps<T extends string = string> {
  tabs: readonly SlidingTabItem<T>[];
  activeTab: T;
  onSelectTab: (tabId: T) => void;
  ariaLabel: string;
  className?: string;
  reducedMotion?: boolean;
}

/**
 * Riel horizontal de pestañas de precisión suiza con indicador inferior deslizante de `2px`
 * en Rojo Corporativo (`#DC2626`), posicionado por GPU (`translate3d`).
 */
export function SlidingTabRail<T extends string = string>({
  tabs,
  activeTab,
  onSelectTab,
  ariaLabel,
  className = '',
  reducedMotion,
}: SlidingTabRailProps<T>): React.ReactElement {
  const isReducedMotion = usePrefersReducedMotion(reducedMotion);
  const railRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState<{ x: number; width: number; ready: boolean }>({
    x: 0,
    width: 0,
    ready: false,
  });

  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      const btn = btnRefs.current.get(activeTab);
      const rail = railRef.current;
      if (!btn || !rail) return;
      setIndicator({
        x: btn.offsetLeft,
        width: btn.offsetWidth,
        ready: btn.offsetWidth > 0,
      });
    };

    measure();
    if (typeof ResizeObserver === 'undefined' || !railRef.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(railRef.current);
    return () => ro.disconnect();
  }, [activeTab, tabs.length]);

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`cz-sliding-tab-rail relative inline-flex flex-wrap items-center gap-1 border-b border-[var(--cz-border-subtle)] pb-0.5 no-print ${className}`.trim()}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) btnRefs.current.set(tab.id, el);
              else btnRefs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={tab.ariaLabel}
            disabled={tab.disabled}
            data-testid={tab.testId}
            onClick={() => onSelectTab(tab.id)}
            className={`cz-sliding-tab-btn relative inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-bold tracking-tight cursor-pointer disabled:opacity-45 ${
              isActive
                ? 'text-[var(--cz-text-primary)] cz-sliding-tab-active'
                : 'text-[var(--cz-text-secondary)] hover:text-[var(--cz-text-primary)]'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge}
            {/* Respaldo estático en SSR o antes de medir DOM */}
            {isActive && !indicator.ready && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-2 bottom-[-2px] h-[2px] bg-[#DC2626]"
              />
            )}
          </button>
        );
      })}

      {indicator.ready && (
        <span
          aria-hidden="true"
          data-testid="sliding-tab-active-indicator"
          className={isReducedMotion ? 'cz-tab-indicator-static' : 'cz-tab-indicator'}
          style={{
            width: `${indicator.width}px`,
            transform: `translate3d(${indicator.x}px, 0, 0)`,
          }}
        />
      )}
    </div>
  );
}
