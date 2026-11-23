import React, { useMemo, useState } from 'react';
import { Check, Package, Plus, Search, Store, X } from 'lucide-react';
import {
  savePortalActiveStore,
  type PortalClientOption,
  type PortalProductOption,
} from '../../services/promotoraCampoService';

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
  const [search, setSearch] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const [customInput, setCustomInput] = useState('');

  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients.slice(0, 60);
    return clients
      .filter(
        (c) =>
          c.nombre.toLowerCase().includes(q) ||
          c.codigo.toLowerCase().includes(q) ||
          c.zona.toLowerCase().includes(q) ||
          c.region.toLowerCase().includes(q)
      )
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
    <div className="space-y-1.5 relative">
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

interface PortalProductSelectorProps {
  value: string;
  onChange: (productName: string, product?: PortalProductOption) => void;
  products: PortalProductOption[];
  label?: string;
  testIdPrefix?: string;
}

export const PortalProductSelector: React.FC<PortalProductSelectorProps> = ({
  value,
  onChange,
  products,
  label = 'Producto / SKU del Catálogo Oficial:',
  testIdPrefix = 'portal-product',
}) => {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products.slice(0, 60);
    return products
      .filter(
        (p) =>
          p.nombre.toLowerCase().includes(q) ||
          p.codigo.toLowerCase().includes(q) ||
          p.categoria.toLowerCase().includes(q)
      )
      .slice(0, 60);
  }, [products, search]);

  return (
    <div className="space-y-1.5 relative">
      <label className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-1">
        <Package className="w-3 h-3 text-red-500" />
        <span>{label}</span>
      </label>

      <div className="relative">
        <Search className="w-3.5 h-3.5 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
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
          placeholder={
            products.length > 0
              ? `Buscar entre ${products.length} productos oficiales...`
              : 'Buscar o escribir producto SKU...'
          }
          className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl pl-8 pr-8 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none font-semibold"
        />
        {(value || search) && (
          <button
            type="button"
            aria-label="Limpiar producto"
            onClick={() => {
              setSearch('');
              setIsOpen(true);
            }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {isOpen && (
        <div className="z-30 max-h-56 overflow-y-auto rounded-xl bg-[#121212] border border-neutral-700 shadow-2xl divide-y divide-neutral-800/80">
          {filteredProducts.length === 0 ? (
            <div className="p-3 text-center space-y-2">
              <p className="text-[11px] text-neutral-400">Sin coincidencias en catálogo.</p>
              {search.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(search.trim());
                    setIsOpen(false);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[11px] font-bold cursor-pointer"
                >
                  Usar &ldquo;{search.trim()}&rdquo;
                </button>
              )}
            </div>
          ) : (
            filteredProducts.map((prod) => {
              const isSelected = prod.nombre.toLowerCase() === String(value || '').toLowerCase();
              return (
                <button
                  key={prod.id}
                  type="button"
                  onClick={() => {
                    onChange(prod.nombre, prod);
                    setSearch('');
                    setIsOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center justify-between gap-2 cursor-pointer ${
                    isSelected
                      ? 'bg-red-600/20 text-white font-bold'
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
            })
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
