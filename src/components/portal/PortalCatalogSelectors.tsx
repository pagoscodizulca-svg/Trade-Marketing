import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Package, Plus, Search, Store, X } from 'lucide-react';
import {
  savePortalActiveStore,
  type PortalClientOption,
  type PortalProductOption,
} from '../../services/promotoraCampoService';
import { OFFICIAL_PORTAL_PRODUCT_OPTIONS } from '../../data/officialTradeProductsCatalog';
import { normalizeSearchText } from '../../utils/textSearch';

interface PortalStoreSelectorProps {
  value: string;
  onChange: (storeName: string, client?: PortalClientOption) => void;
  clients: PortalClientOption[];
  label?: string;
  testIdPrefix?: string;
}

export const PortalStoreSelector: React.FC<PortalStoreSelectorProps> = ({
  value,
  onChange,
  clients,
  label = 'Punto de Venta / Sucursal (PDV):',
  testIdPrefix = 'portal-store',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const [customInput, setCustomInput] = useState('');

  useEffect(() => {
    if (!isDropdownOpen) return;
    const onPointerDown = (ev: MouseEvent) => {
      if (!containerRef.current?.contains(ev.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setIsDropdownOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isDropdownOpen]);

  const filteredClients = useMemo(() => {
    const qNorm = normalizeSearchText(search);
    if (!qNorm) return clients.slice(0, 60);
    const tokens = qNorm.split(' ').filter(Boolean);
    return clients
      .filter((c) => {
        const hay = normalizeSearchText(`${c.nombre} ${c.codigo} ${c.zona} ${c.region}`);
        return tokens.every((tok) => hay.includes(tok));
      })
      .slice(0, 60);
  }, [clients, search]);

  const handleSelect = (client: PortalClientOption) => {
    savePortalActiveStore(client.nombre);
    onChange(client.nombre, client);
    setSearch('');
    setIsDropdownOpen(false);
  };

  const handleSaveCustom = () => {
    const clean = customInput.trim();
    if (!clean) return;
    savePortalActiveStore(clean);
    onChange(clean);
    setCustomInput('');
    setIsAddingCustom(false);
    setIsDropdownOpen(false);
  };

  return (
    <div ref={containerRef} className="space-y-1.5 relative">
      <div className="flex items-center justify-between gap-2">
        <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-1">
          <Store className="w-3 h-3 text-red-500" />
          <span>{label}</span>
        </label>
        <button
          type="button"
          onClick={() => {
            setIsAddingCustom((prev) => !prev);
            setIsDropdownOpen(false);
          }}
          className="px-2 py-0.5 rounded-lg bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 text-red-400 hover:text-white text-[10px] font-black uppercase tracking-wider flex items-center gap-1 transition-colors cursor-pointer"
        >
          {isAddingCustom ? (
            <>
              <X className="w-3 h-3" />
              <span>Cancelar</span>
            </>
          ) : (
            <>
              <Plus className="w-3 h-3" />
              <span>PDV Manual</span>
            </>
          )}
        </button>
      </div>

      {isAddingCustom ? (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            data-testid={`${testIdPrefix}-custom-input`}
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveCustom();
              }
            }}
            placeholder="Escribir nombre del cliente / PDV..."
            className="flex-1 bg-[#171717] border border-red-500/60 rounded-xl px-3 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-red-500"
          />
          <button
            type="button"
            data-testid={`${testIdPrefix}-custom-save`}
            onClick={handleSaveCustom}
            className="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-black uppercase flex items-center gap-1 shrink-0 cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Usar</span>
          </button>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              data-testid={`${testIdPrefix}-search`}
              value={isDropdownOpen ? search : value}
              onFocus={() => {
                setIsDropdownOpen(true);
                setSearch('');
              }}
              onChange={(e) => {
                setSearch(e.target.value);
                setIsDropdownOpen(true);
              }}
              placeholder={
                clients.length > 0
                  ? `Buscar entre ${clients.length.toLocaleString('es-VE')} clientes / PDVs...`
                  : 'Buscar o escribir Punto de Venta...'
              }
              className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl pl-8 pr-8 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none font-medium"
            />
            {(value || search) && (
              <button
                type="button"
                aria-label="Limpiar tienda"
                onClick={() => {
                  setSearch('');
                  setIsDropdownOpen(true);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {isDropdownOpen && (
            <div className="z-30 max-h-56 overflow-y-auto rounded-xl bg-[#121212] border border-neutral-700 shadow-2xl divide-y divide-neutral-800/80">
              {filteredClients.length === 0 ? (
                <div className="p-3 text-center space-y-2">
                  <p className="text-[11px] text-neutral-400">
                    Sin coincidencias en el catálogo maestro.
                  </p>
                  {search.trim().length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const clean = search.trim();
                        savePortalActiveStore(clean);
                        onChange(clean);
                        setIsDropdownOpen(false);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[11px] font-bold cursor-pointer"
                    >
                      Usar &ldquo;{search.trim()}&rdquo;
                    </button>
                  )}
                </div>
              ) : (
                filteredClients.map((client) => {
                  const isSelected =
                    client.nombre.toLowerCase() === String(value || '').toLowerCase();
                  return (
                    <button
                      key={client.id}
                      type="button"
                      onClick={() => handleSelect(client)}
                      className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center justify-between gap-2 cursor-pointer ${
                        isSelected
                          ? 'bg-red-600/20 text-white font-bold'
                          : 'text-neutral-200 hover:bg-neutral-800/80'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{client.nombre}</p>
                        <p className="text-[10px] text-neutral-400 font-mono truncate">
                          {client.codigo ? `${client.codigo} • ` : ''}
                          {client.zona} • {client.region}
                        </p>
                      </div>
                      {isSelected && <Check className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                    </button>
                  );
                })
              )}
              <div className="p-1.5 bg-black/50 flex justify-end">
                <button
                  type="button"
                  onClick={() => setIsDropdownOpen(false)}
                  className="px-2.5 py-1 rounded-lg text-[10px] text-neutral-400 hover:text-white cursor-pointer"
                >
                  Cerrar lista
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Motor puro de búsqueda inteligente instantánea para productos en la App de Promotoras:
 * multi-término, insensible a tildes/mayúsculas, soporta códigos con/sin ceros y ordena por relevancia.
 */
export function filterPortalProductsSmart(
  products: readonly PortalProductOption[],
  rawQuery: string
): PortalProductOption[] {
  const qNorm = normalizeSearchText(rawQuery);
  if (!qNorm) return [...products];

  const tokens = qNorm.split(' ').filter(Boolean);
  const qCompact = qNorm.replace(/[^a-z0-9]+/g, '');
  const qNum = /^\d+$/.test(qCompact) ? qCompact.replace(/^0+/, '') || '0' : '';

  const scored: Array<{ prod: PortalProductOption; score: number }> = [];

  for (const prod of products) {
    const normName = normalizeSearchText(prod.nombre);
    const normCode = normalizeSearchText(prod.codigo);
    const unpaddedCode = normCode.replace(/^0+/, '');
    const normFull = normalizeSearchText(
      `${prod.nombre} ${prod.codigo} ${unpaddedCode} ${prod.categoria} ${prod.presentacion}`
    );
    const compactFull = normFull.replace(/[^a-z0-9]+/g, '');

    const allTokensMatch = tokens.every((tok) => {
      if (normFull.includes(tok)) return true;
      if (/^\d+$/.test(tok)) {
        const cleanTok = tok.replace(/^0+/, '') || '0';
        return unpaddedCode === cleanTok || normCode.includes(cleanTok);
      }
      return false;
    });
    const compactMatch = qCompact.length >= 2 && compactFull.includes(qCompact);
    if (!allTokensMatch && !compactMatch) continue;

    let score = 10;
    if ((normCode && normCode === qNorm) || (qNum && unpaddedCode === qNum)) {
      score = 0;
    } else if (normName.startsWith(qNorm)) {
      score = 1;
    } else if (normCode && normCode.includes(qNorm)) {
      score = 2;
    } else if (normName.includes(qNorm)) {
      score = 3;
    } else if (allTokensMatch) {
      score = 4;
    } else {
      score = 5;
    }
    scored.push({ prod, score });
  }

  scored.sort((a, b) => a.score - b.score || a.prod.nombre.localeCompare(b.prod.nombre, 'es'));
  return scored.map((s) => s.prod);
}

interface PortalProductSelectorProps {
  value: string;
  onChange: (productName: string, product?: PortalProductOption) => void;
  products: PortalProductOption[];
  label?: string;
  testIdPrefix?: string;
  placeholder?: string;
}

export const PortalProductSelector: React.FC<PortalProductSelectorProps> = ({
  value,
  onChange,
  products,
  label = 'Producto / SKU del Catálogo Oficial:',
  testIdPrefix = 'portal-product',
  placeholder,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(60);
  const [highlightedIdx, setHighlightedIdx] = useState(0);

  const effectiveProducts = useMemo<PortalProductOption[]>(() => {
    if (products.length > 0) return products;
    return OFFICIAL_PORTAL_PRODUCT_OPTIONS.map((p) => ({
      id: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      categoria: p.categoria,
      presentacion: p.presentacion,
    }));
  }, [products]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (ev: MouseEvent) => {
      if (!containerRef.current?.contains(ev.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setIsOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const filteredProducts = useMemo(
    () => filterPortalProductsSmart(effectiveProducts, search),
    [effectiveProducts, search]
  );

  const visibleProducts = useMemo(
    () => filteredProducts.slice(0, visibleLimit),
    [filteredProducts, visibleLimit]
  );

  useEffect(() => {
    setVisibleLimit(60);
    setHighlightedIdx(0);
  }, [search]);

  const handleSelectProduct = (prod: PortalProductOption) => {
    onChange(prod.nombre, prod);
    setSearch('');
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="space-y-1.5 relative">
      <div className="flex items-center justify-between gap-2">
        <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-1">
          <Package className="w-3 h-3 text-red-500" />
          <span>{label}</span>
        </label>
        <span className="text-[10px] font-mono text-neutral-500">
          {isOpen && search.trim()
            ? `${filteredProducts.length} de ${effectiveProducts.length}`
            : `${effectiveProducts.length} SKUs`}
        </span>
      </div>

      <div className="relative">
        <Search className="w-3.5 h-3.5 text-red-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          data-testid={`${testIdPrefix}-search`}
          value={isOpen ? search : value}
          onFocus={() => {
            setIsOpen(true);
            setSearch('');
          }}
          onChange={(e) => {
            setSearch(e.target.value);
            setIsOpen(true);
          }}
          onKeyDown={(e) => {
            if (!isOpen) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (visibleProducts.length > 0) {
                setHighlightedIdx((prev) => (prev + 1) % visibleProducts.length);
              }
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (visibleProducts.length > 0) {
                setHighlightedIdx((prev) => (prev - 1 + visibleProducts.length) % visibleProducts.length);
              }
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (visibleProducts[highlightedIdx]) {
                handleSelectProduct(visibleProducts[highlightedIdx]);
              } else if (search.trim()) {
                onChange(search.trim());
                setSearch('');
                setIsOpen(false);
              }
            }
          }}
          autoComplete="off"
          placeholder={
            placeholder ||
            `Teclea nombre, código o grupo (${effectiveProducts.length} productos oficiales)...`
          }
          className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl pl-8 pr-8 py-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none font-semibold"
        />
        {(value || search) && (
          <button
            type="button"
            aria-label="Limpiar producto"
            onClick={() => {
              setSearch('');
              setIsOpen(true);
              inputRef.current?.focus();
            }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {isOpen && (
        <div
          data-testid={`${testIdPrefix}-dropdown`}
          className="z-30 max-h-64 overflow-y-auto rounded-xl bg-[#121212] border border-neutral-700 shadow-2xl divide-y divide-neutral-800/80"
        >
          {visibleProducts.length === 0 ? (
            <div className="p-3 text-center space-y-2">
              <p className="text-[11px] text-neutral-400">
                Sin coincidencias para &ldquo;{search.trim()}&rdquo; en el catálogo oficial.
              </p>
              {search.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(search.trim());
                    setSearch('');
                    setIsOpen(false);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[11px] font-bold cursor-pointer"
                >
                  Usar &ldquo;{search.trim()}&rdquo;
                </button>
              )}
            </div>
          ) : (
            <>
              {visibleProducts.map((prod, idx) => {
                const isSelected = prod.nombre.toLowerCase() === String(value || '').toLowerCase();
                const isHighlighted = idx === highlightedIdx;
                return (
                  <button
                    key={prod.id}
                    type="button"
                    onMouseEnter={() => setHighlightedIdx(idx)}
                    onClick={() => handleSelectProduct(prod)}
                    className={`w-full text-left px-3 py-2.5 text-xs transition-colors flex items-center justify-between gap-2 cursor-pointer ${
                      isSelected
                        ? 'bg-red-600/20 text-white font-bold'
                        : isHighlighted
                          ? 'bg-neutral-800 text-white'
                          : 'text-neutral-200 hover:bg-neutral-800/80'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{prod.nombre}</p>
                      <p className="text-[10px] text-neutral-400 font-mono truncate">
                        {prod.codigo ? `${prod.codigo} • ` : ''}
                        {prod.categoria}
                        {prod.presentacion ? ` • ${prod.presentacion}` : ''}
                      </p>
                    </div>
                    {isSelected && <Check className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                  </button>
                );
              })}

              {filteredProducts.length > visibleProducts.length && (
                <button
                  type="button"
                  onClick={() => setVisibleLimit((prev) => prev + 60)}
                  className="w-full py-2 px-3 bg-neutral-900/90 hover:bg-neutral-800 text-[11px] font-bold text-red-400 text-center cursor-pointer"
                >
                  Mostrar más productos ({visibleProducts.length} de {filteredProducts.length})
                </button>
              )}
            </>
          )}
          <div className="p-1.5 bg-black/50 flex justify-end">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-2.5 py-1 rounded-lg text-[10px] text-neutral-400 hover:text-white cursor-pointer"
            >
              Cerrar lista
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
