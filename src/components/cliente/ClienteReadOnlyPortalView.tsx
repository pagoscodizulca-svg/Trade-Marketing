import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Download, FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react';
import {
  computeCadenaInitials,
  fetchCadenaSecondaryLogoBlobUrl,
  isSafeLocalLogoSrc,
  revokeLogoBlobUrl,
} from '../../services/cadenaLogoService';
import {
  fetchClientePortalResumen,
  type ClientePortalCadenaBranding,
  type ClientePortalResumen,
} from '../../services/clientePortalService';
import { downloadExecutiveWorkbookXlsx } from '../../utils/excelWordExport';
import { AnimatedTabContainer } from '../ui/AnimatedTabContainer';
import { ControlRoomThemeToggle } from '../ui/ControlRoomThemeToggle';

export interface ClienteReadOnlyPortalViewProps {
  onSignOut?: () => void;
  /** Datos iniciales opcionales para pruebas SSR/determinísticas */
  initialData?: ClientePortalResumen | null;
  /** Vista previa local segura (`blob:` o `data:image/png|webp;base64,...`) para pruebas SSR */
  initialLogoPreviewSrc?: string | null;
}

/**
 * Portal Ejecutivo B2B de SOLO LECTURA para el rol `cliente` (`/cliente`):
 * - Cabecera Co-Brandeada `[Logo Corporativo CODIZULCA C.A.] | [Logo Secundario Cadena Comercial]`.
 * - Carga mediante `Blob URL` autenticado con liberación `URL.revokeObjectURL` al desmontar.
 * - Cápsula cerámica adaptativa (`h-9 max-w-[160px] object-contain`) para máxima legibilidad
 *   en Modo Día Ejecutivo y Modo Oscuro Nocturno Completo de Sala de Control.
 */
export const ClienteReadOnlyPortalView: React.FC<ClienteReadOnlyPortalViewProps> = ({
  onSignOut,
  initialData = null,
  initialLogoPreviewSrc = null,
}) => {
  const [data, setData] = useState<ClientePortalResumen | null>(() => initialData);
  const [loading, setLoading] = useState<boolean>(() => !initialData);
  const [error, setError] = useState<string | null>(null);
  const [selectedCadenaId, setSelectedCadenaId] = useState<string>(
    () => initialData?.cadenasBranding[0]?.id ?? ''
  );
  const [secondaryLogoBlobUrl, setSecondaryLogoBlobUrl] = useState<string | null>(() =>
    isSafeLocalLogoSrc(initialLogoPreviewSrc) ? initialLogoPreviewSrc : null
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchClientePortalResumen();
      setData(result);
      if (result.cadenasBranding.length > 0) {
        setSelectedCadenaId((prev) =>
          result.cadenasBranding.some((c) => c.id === prev) ? prev : result.cadenasBranding[0]!.id
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando el portal.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialData) return;
    void load();
  }, [initialData, load]);

  const activeCadena: ClientePortalCadenaBranding | null = useMemo(() => {
    const list = data?.cadenasBranding ?? [];
    if (list.length === 0) return null;
    return list.find((c) => c.id === selectedCadenaId) ?? list[0] ?? null;
  }, [data?.cadenasBranding, selectedCadenaId]);

  // Carga autenticada del logotipo secundario por Blob URL + liberación determinística en cleanup
  useEffect(() => {
    if (isSafeLocalLogoSrc(initialLogoPreviewSrc)) {
      setSecondaryLogoBlobUrl(initialLogoPreviewSrc);
      return;
    }

    if (!activeCadena || !activeCadena.hasLogo) {
      setSecondaryLogoBlobUrl(null);
      return;
    }

    const controller = new AbortController();
    let mounted = true;
    let createdBlobUrl: string | null = null;

    void fetchCadenaSecondaryLogoBlobUrl(activeCadena.id, controller.signal).then((url) => {
      if (!mounted) {
        revokeLogoBlobUrl(url);
        return;
      }
      createdBlobUrl = url;
      setSecondaryLogoBlobUrl(url);
    });

    return () => {
      mounted = false;
      controller.abort();
      revokeLogoBlobUrl(createdBlobUrl);
    };
  }, [activeCadena, initialLogoPreviewSrc]);

  const fallbackPartnerLabel = useMemo(() => {
    if (activeCadena?.nombre) return activeCadena.nombre;
    const firstPdv = data?.pdvs[0];
    if (firstPdv?.cadenaNombre && firstPdv.cadenaNombre !== 'PDV Independiente') {
      return firstPdv.cadenaNombre;
    }
    return firstPdv?.nombreComercial || 'Aliado Comercial Autorizado';
  }, [activeCadena, data?.pdvs]);

  const partnerInitials = useMemo(
    () => computeCadenaInitials(fallbackPartnerLabel, activeCadena?.codigo),
    [activeCadena?.codigo, fallbackPartnerLabel]
  );

  const safeLogoSrc = isSafeLocalLogoSrc(secondaryLogoBlobUrl) ? secondaryLogoBlobUrl : null;

  const exportXlsx = async () => {
    if (!data) return;
    await downloadExecutiveWorkbookXlsx(
      {
        title: `Portal Cliente · ${fallbackPartnerLabel} · CODIZULCA C.A.`,
        generatedBy: 'Portal Cliente B2B',
        regionLabel: activeCadena?.sucursal || data.pdvs[0]?.sucursal || undefined,
        sheets: [
          {
            name: 'Activaciones',
            headers: ['Fecha', 'PDV', 'Producto', 'Estado', 'Muestras', 'Ventas asistidas'],
            rows: data.activaciones.map((a) => [
              a.fecha,
              a.clienteNombre,
              a.productoResumen,
              a.estado,
              a.muestrasEntregadas,
              a.ventasAsistidasUnidades,
            ]),
          },
        ],
      },
      'portal-cliente'
    );
  };

  return (
    <div
      className="cz-workspace-canvas min-h-screen bg-[var(--cz-bg-canvas)] text-[var(--cz-text-primary)] p-4 sm:p-8 space-y-5"
      data-testid="cliente-readonly-portal"
    >
      <header
        data-testid="cliente-cobrand-header"
        className="cz-surface rounded-2xl bg-zinc-950 border border-white/10 px-4 sm:px-6 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 no-print"
      >
        {/* Bloque Ejecutivo de Co-Branding: [Logo Corporativo Principal] | [Logo Secundario Cadena] */}
        <div className="flex flex-wrap items-center gap-3.5 min-w-0">
          <div className="flex items-center gap-3 shrink-0">
            <div className="cz-logo-badge w-10 h-10 rounded-xl bg-white border border-zinc-200 p-1 flex items-center justify-center shrink-0">
              <img
                src="/codizulca-logo.png"
                alt="Logo Corporativo CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-red-500 block">
                Portal Ejecutivo B2B
              </span>
              <h1 className="text-sm sm:text-base font-extrabold tracking-tight">
                CODIZULCA C.A.
              </h1>
            </div>
          </div>

          {/* Divisor arquitectónico vertical 1px */}
          <span
            aria-hidden="true"
            className="h-9 w-px bg-[var(--cz-border-subtle)] shrink-0"
          />

          {/* Cápsula neutra adaptativa con logo secundario (Blob URL) o insignia tipográfica limpia */}
          {safeLogoSrc ? (
            <div
              data-testid="cliente-cobrand-logo-capsule"
              className="cz-cobrand-capsule h-9 max-w-[160px] px-3 py-1 rounded-lg flex items-center justify-center shrink-0"
              title={`Cadena Comercial Aliada: ${fallbackPartnerLabel}`}
            >
              <img
                src={safeLogoSrc}
                alt={`Logotipo oficial ${fallbackPartnerLabel}`}
                data-testid="cliente-cobrand-secondary-img"
                onError={() => setSecondaryLogoBlobUrl(null)}
                className="h-full max-w-full object-contain"
              />
            </div>
          ) : (
            <div
              data-testid="cliente-cobrand-typographic-badge"
              className="cz-elevated h-9 px-3 rounded-lg border border-[var(--cz-border-subtle)] inline-flex items-center gap-2.5 min-w-0"
              title={`Cadena Comercial Aliada: ${fallbackPartnerLabel}`}
            >
              <span className="cz-keep-inverse w-6 h-6 rounded bg-[#DC2626] text-white text-[10px] font-mono font-black flex items-center justify-center shrink-0">
                {partnerInitials}
              </span>
              <span className="text-xs font-extrabold truncate max-w-[180px]">
                {fallbackPartnerLabel}
              </span>
            </div>
          )}

          {data && data.cadenasBranding.length > 1 && (
            <div className="inline-flex items-center gap-1.5 ml-1">
              <Building2 className="w-3.5 h-3.5 text-red-500 shrink-0" />
              <select
                aria-label="Seleccionar cadena comercial autorizada"
                value={activeCadena?.id || ''}
                onChange={(e) => setSelectedCadenaId(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-bold cursor-pointer"
              >
                {data.cadenasBranding.map((cad) => (
                  <option key={cad.id} value={cad.id}>
                    {cad.nombre}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <ControlRoomThemeToggle />
          <button
            type="button"
            onClick={() => void load()}
            title="Actualizar métricas"
            className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => void exportXlsx()}
            disabled={!data}
            className="px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4" /> Excel
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-4 h-4" /> PDF
          </button>
          {onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              className="px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-bold cursor-pointer"
            >
              Salir
            </button>
          )}
        </div>
      </header>

      <p className="text-xs text-zinc-400 px-1">
        Vista ejecutiva de solo lectura de tus puntos de venta autorizados ({fallbackPartnerLabel}).
      </p>

      {error && (
        <div
          role="alert"
          className="rounded-xl bg-red-950/50 border border-red-500/40 px-4 py-3 text-xs text-red-200"
        >
          {error}
        </div>
      )}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando...
        </div>
      )}

      {data && (
        <AnimatedTabContainer
          tabKey={`portal-cliente:${activeCadena?.id || 'default'}`}
          className="space-y-5 tabular-nums"
        >
          <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[
              ['PDV autorizados', data.kpis.totalPdvs],
              ['Activaciones', data.kpis.totalActivaciones],
              ['Completadas', data.kpis.completadas],
              ['Muestras entregadas', data.kpis.muestras],
              ['Ventas asistidas', data.kpis.ventasAsistidas],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="cz-surface rounded-2xl bg-zinc-950 border border-white/10 p-4"
              >
                <span className="text-[10px] uppercase font-mono text-zinc-500">{label}</span>
                <div className="text-2xl font-black tabular-nums mt-0.5">{value}</div>
              </div>
            ))}
          </section>

          <section className="cz-surface rounded-2xl bg-zinc-950 border border-white/10 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-zinc-400 text-left">
                <tr>
                  {['Fecha', 'PDV', 'Producto', 'Estado', 'Muestras', 'Ventas'].map((h) => (
                    <th key={h} className="px-3.5 py-2.5 font-bold uppercase text-[10px] tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.activaciones.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                      Sin activaciones para tus PDV.
                    </td>
                  </tr>
                )}
                {data.activaciones.map((a) => (
                  <tr key={a.id} className="border-t border-white/5">
                    <td className="px-3.5 py-2.5 font-mono tabular-nums">{a.fecha}</td>
                    <td className="px-3.5 py-2.5 font-semibold">{a.clienteNombre}</td>
                    <td className="px-3.5 py-2.5">{a.productoResumen}</td>
                    <td className="px-3.5 py-2.5 font-mono text-[11px]">{a.estado}</td>
                    <td className="px-3.5 py-2.5 font-mono tabular-nums">{a.muestrasEntregadas}</td>
                    <td className="px-3.5 py-2.5 font-mono tabular-nums">{a.ventasAsistidasUnidades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </AnimatedTabContainer>
      )}
    </div>
  );
};
