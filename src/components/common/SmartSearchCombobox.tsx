import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { normalizeSearchText } from '../../utils/textSearch';

export interface SmartSearchComboboxOption {
  value: string;
  label: string;
  sublabel?: string;
  badge?: string;
  /** Texto adicional indexado para búsqueda inteligente (ej. código SKU sin ceros, grupo, subgrupo, zona) */
  keywords?: string;
  disabled?: boolean;
  /** Mantiene la opción anclada al inicio cuando el buscador está vacío */
  pinned?: boolean;
}

export interface SmartSearchComboboxProps {
  value: string;
  onChange: (value: string, option?: SmartSearchComboboxOption) => void;
  options: readonly SmartSearchComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  customActionLabel?: (query: string) => string;
  emptyMessage?: string;
  maxVisible?: number;
  compact?: boolean;
  className?: string;
  triggerClassName?: string;
  testId?: string;
  searchTestId?: string;
  panelMinWidth?: number;
}

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Motor puro de búsqueda inteligente instantánea (insensible a tildes/mayúsculas, multi-término,
 * compatible con códigos numéricos con o sin ceros a la izquierda y ranking por relevancia).
 */
export function filterSmartComboboxOptions(
  options: readonly SmartSearchComboboxOption[],
  rawQuery: string
): SmartSearchComboboxOption[] {
  const qNorm = normalizeSearchText(rawQuery);
  if (!qNorm) return [...options];

  const tokens = qNorm.split(' ').filter(Boolean);
  const qCompact = qNorm.replace(/[^a-z0-9]+/g, '');
  const qNumericUnpadded = /^\d+$/.test(qCompact) ? qCompact.replace(/^0+/, '') || '0' : '';

  const scored: Array<{ opt: SmartSearchComboboxOption; score: number; idx: number }> = [];

  for (let idx = 0; idx < options.length; idx += 1) {
    const opt = options[idx];
    const normLabel = normalizeSearchText(opt.label);
    const normValue = normalizeSearchText(opt.value);
    const normKeywords = normalizeSearchText(
      `${opt.keywords ?? ''} ${opt.sublabel ?? ''} ${opt.badge ?? ''}`
    );
    const normFull = `${normLabel} ${normValue} ${normKeywords}`.trim();
    const compactFull = normFull.replace(/[^a-z0-9]+/g, '');

    const allTokensMatch = tokens.every((tok) => {
      if (normFull.includes(tok)) return true;
      if (/^\d+$/.test(tok)) {
        const unpadded = tok.replace(/^0+/, '') || '0';
        const padded = unpadded.padStart(6, '0');
        return normFull.includes(unpadded) || normFull.includes(padded);
      }
      return false;
    });
    const compactMatch = qCompact.length >= 2 && compactFull.includes(qCompact);
    const numericMatch =
      qNumericUnpadded.length > 0 &&
      (normFull.includes(qNumericUnpadded.padStart(6, '0')) ||
        normFull.split(/\s+/).some((w) => w.replace(/^0+/, '') === qNumericUnpadded));

    if (!allTokensMatch && !compactMatch && !numericMatch) continue;

    let score = 10;
    if (normValue === qNorm || normLabel === qNorm) {
      score = 0;
    } else if (numericMatch && normKeywords.includes(qNumericUnpadded.padStart(6, '0'))) {
      score = 1;
    } else if (normLabel.startsWith(qNorm)) {
      score = 2;
    } else if (normKeywords.startsWith(qNorm)) {
      score = 3;
    } else if (normLabel.includes(qNorm)) {
      score = 4;
    } else if (allTokensMatch) {
      score = 5;
    } else if (compactMatch) {
      score = 6;
    }

    scored.push({ opt, score, idx });
  }

  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  return scored.map((item) => item.opt);
}

interface FloatingRect {
  top: number;
  left: number;
  width: number;
  openUpward: boolean;
}

export const SmartSearchCombobox: React.FC<SmartSearchComboboxProps> = ({
  value,
  onChange,
  options,
  placeholder = 'Seleccionar...',
  searchPlaceholder = 'Escribir para buscar al instante...',
  ariaLabel,
  disabled = false,
  allowCustom = false,
  customActionLabel = (q) => `Usar "${q}"`,
  emptyMessage = 'Sin coincidencias para la búsqueda.',
  maxVisible = 80,
  compact = false,
  className = '',
  triggerClassName = '',
  testId,
  searchTestId,
  panelMinWidth = 260,
}) => {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [visibleLimit, setVisibleLimit] = useState(maxVisible);
  const [rect, setRect] = useState<FloatingRect | null>(null);

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value) ?? null,
    [options, value]
  );

  const filteredOptions = useMemo(
    () => filterSmartComboboxOptions(options, query),
    [options, query]
  );

  const visibleOptions = useMemo(
    () => filteredOptions.slice(0, visibleLimit),
    [filteredOptions, visibleLimit]
  );

  const updateFloatingPosition = useCallback(() => {
    if (!triggerRef.current || typeof window === 'undefined') return;
    const box = triggerRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const desiredWidth = Math.min(Math.max(box.width, panelMinWidth), viewportW - 16);
    const left = Math.max(8, Math.min(box.left, viewportW - desiredWidth - 8));
    const spaceBelow = viewportH - box.bottom - 12;
    const spaceAbove = box.top - 12;
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
    const top = openUpward ? Math.max(8, box.top - 6) : Math.min(viewportH - 16, box.bottom + 6);
    setRect({ top, left, width: desiredWidth, openUpward });
  }, [panelMinWidth]);

  useIsomorphicLayoutEffect(() => {
    if (!isOpen) return;
    updateFloatingPosition();
    const handleReposition = () => updateFloatingPosition();
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [isOpen, updateFloatingPosition]);

  useEffect(() => {
    if (!isOpen) return;
    setVisibleLimit(maxVisible);
    const rafId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [isOpen, maxVisible]);

  useEffect(() => {
    setVisibleLimit(maxVisible);
    const firstEnabled = filteredOptions.findIndex((o) => !o.disabled);
    setHighlightedIndex(firstEnabled >= 0 ? firstEnabled : 0);
  }, [query, filteredOptions, maxVisible]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelectOption = useCallback(
    (opt: SmartSearchComboboxOption) => {
      if (opt.disabled) return;
      onChange(opt.value, opt);
      setQuery('');
      setIsOpen(false);
    },
    [onChange]
  );

  const handleSearchKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (visibleOptions.length === 0) return;
      let next = highlightedIndex;
      for (let i = 0; i < visibleOptions.length; i += 1) {
        next = (next + 1) % visibleOptions.length;
        if (!visibleOptions[next].disabled) {
          setHighlightedIndex(next);
          break;
        }
      }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (visibleOptions.length === 0) return;
      let prev = highlightedIndex;
      for (let i = 0; i < visibleOptions.length; i += 1) {
        prev = (prev - 1 + visibleOptions.length) % visibleOptions.length;
        if (!visibleOptions[prev].disabled) {
          setHighlightedIndex(prev);
          break;
        }
      }
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const targetOpt = visibleOptions[highlightedIndex];
      if (targetOpt && !targetOpt.disabled) {
        handleSelectOption(targetOpt);
      } else if (allowCustom && query.trim()) {
        onChange(query.trim());
        setQuery('');
        setIsOpen(false);
      }
    }
  };

  const displayLabel = selectedOption?.label || value || placeholder;
  const isPlaceholderShown = !selectedOption && !value;

  const panelNode =
    isOpen && rect ? (
      <div
        ref={panelRef}
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel || placeholder}
        style={{
          position: 'fixed',
          top: rect.openUpward ? undefined : `${rect.top}px`,
          bottom: rect.openUpward ? `${window.innerHeight - rect.top}px` : undefined,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          zIndex: 110,
        }}
        className="rounded-xl bg-zinc-950 border border-zinc-700 shadow-2xl overflow-hidden flex flex-col max-h-[340px]"
      >
        {/* Barra de búsqueda inteligente instantánea */}
        <div className="p-2 border-b border-zinc-800 bg-black/80 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-red-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              data-testid={searchTestId || (testId ? `${testId}-search` : undefined)}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={searchPlaceholder}
              autoComplete="off"
              className="w-full pl-8 pr-7 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-red-500 text-xs text-white placeholder-zinc-400 focus:outline-none font-medium"
            />
            {query && (
              <button
                type="button"
                aria-label="Limpiar búsqueda"
                onClick={() => {
                  setQuery('');
                  searchInputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-zinc-400 px-0.5">
            <span>
              {query.trim()
                ? `${filteredOptions.length} coincidencia${filteredOptions.length === 1 ? '' : 's'}`
                : `${options.length} disponible${options.length === 1 ? '' : 's'}`}
            </span>
            <span>↑↓ navegar · Enter elegir</span>
          </div>
        </div>

        {/* Opciones filtradas */}
        <div className="overflow-y-auto divide-y divide-zinc-900/80 flex-1 min-h-0">
          {visibleOptions.length === 0 ? (
            <div className="p-3 text-center space-y-2">
              <p className="text-[11px] text-zinc-400">{emptyMessage}</p>
              {allowCustom && query.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(query.trim());
                    setQuery('');
                    setIsOpen(false);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[11px] font-bold cursor-pointer"
                >
                  {customActionLabel(query.trim())}
                </button>
              )}
            </div>
          ) : (
            <>
              {visibleOptions.map((opt, idx) => {
                const isSelected = opt.value === value;
                const isHighlighted = idx === highlightedIndex;
                return (
                  <button
                    key={`${opt.value}-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={opt.disabled}
                    onMouseEnter={() => {
                      if (!opt.disabled) setHighlightedIndex(idx);
                    }}
                    onClick={() => handleSelectOption(opt)}
                    className={`w-full text-left px-3 py-2 text-xs transition flex items-center justify-between gap-2 ${
                      opt.disabled
                        ? 'opacity-50 cursor-not-allowed bg-zinc-950 text-zinc-500'
                        : isSelected
                          ? 'bg-red-600/20 text-white font-bold cursor-pointer'
                          : isHighlighted
                            ? 'bg-zinc-800/90 text-white cursor-pointer'
                            : 'text-zinc-200 hover:bg-zinc-900 cursor-pointer'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold leading-snug">{opt.label}</div>
                      {opt.sublabel && (
                        <div className="text-[10px] text-zinc-400 font-mono truncate mt-0.5">
                          {opt.sublabel}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {opt.badge && (
                        <span className="px-1.5 py-0.5 rounded bg-black/70 border border-zinc-700 text-[9px] font-mono font-bold text-zinc-300">
                          {opt.badge}
                        </span>
                      )}
                      {isSelected && <Check className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                    </div>
                  </button>
                );
              })}

              {filteredOptions.length > visibleOptions.length && (
                <button
                  type="button"
                  onClick={() => setVisibleLimit((prev) => prev + 80)}
                  className="w-full py-2 px-3 bg-zinc-900/80 hover:bg-zinc-800 text-[11px] font-bold text-red-400 text-center cursor-pointer"
                >
                  Mostrar más ({visibleOptions.length} de {filteredOptions.length})
                </button>
              )}
            </>
          )}
        </div>
      </div>
    ) : null;

  return (
    <div className={`relative ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={isOpen ? listboxId : undefined}
        aria-label={ariaLabel || placeholder}
        data-testid={testId}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setIsOpen((prev) => !prev);
        }}
        className={`w-full flex items-center justify-between gap-2 text-left rounded-xl bg-zinc-950 border transition focus:outline-none focus:border-red-600 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${
          isOpen ? 'border-red-600 ring-1 ring-red-600/30' : 'border-zinc-800 hover:border-zinc-700'
        } ${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-xs'} ${
          isPlaceholderShown ? 'text-zinc-400 font-medium' : 'text-white font-bold'
        } ${triggerClassName}`.trim()}
      >
        <span className="truncate flex-1">{displayLabel}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform ${
            isOpen ? 'rotate-180 text-red-400' : ''
          }`}
        />
      </button>

      {panelNode && typeof document !== 'undefined' ? createPortal(panelNode, document.body) : panelNode}
    </div>
  );
};
