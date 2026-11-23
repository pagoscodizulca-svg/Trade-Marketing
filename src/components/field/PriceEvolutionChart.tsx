import React, { useMemo, useState } from 'react';
import { AlertTriangle, TrendingDown } from 'lucide-react';
import type { PriceEvolutionPoint, PriceEvolutionSeries } from '../../utils/bimonetaryPriceMath';

export interface PriceEvolutionChartProps {
  dates: string[];
  series: PriceEvolutionSeries[];
  title?: string;
  subtitle?: string;
}

const CHART_WIDTH = 760;
const CHART_HEIGHT = 270;
const PAD_LEFT = 54;
const PAD_RIGHT = 24;
const PAD_TOP = 20;
const PAD_BOTTOM = 42;

function formatShortDate(ymd: string): string {
  const parts = ymd.split('-');
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}`;
}

export const PriceEvolutionChart: React.FC<PriceEvolutionChartProps> = ({
  dates,
  series,
  title = 'Evolución Histórica de Precios (USD Normalizado BCV)',
  subtitle,
}) => {
  const [selectedPoint, setSelectedPoint] = useState<{
    seriesLabel: string;
    color: string;
    point: PriceEvolutionPoint;
  } | null>(null);

  const { minVal, maxVal, yTicks } = useMemo(() => {
    const allPrices: number[] = [];
    for (const s of series) {
      for (const p of s.points) {
        if (Number.isFinite(p.priceUsd) && p.priceUsd > 0) allPrices.push(p.priceUsd);
      }
    }
    if (allPrices.length === 0) {
      return { minVal: 0, maxVal: 10, yTicks: [0, 2.5, 5, 7.5, 10] };
    }
    const rawMin = Math.min(...allPrices);
    const rawMax = Math.max(...allPrices);
    const span = Math.max(rawMax - rawMin, rawMax * 0.2, 0.5);
    const lo = Math.max(0, Number((rawMin - span * 0.15).toFixed(2)));
    const hi = Number((rawMax + span * 0.15).toFixed(2));
    const step = (hi - lo) / 4;
    return {
      minVal: lo,
      maxVal: hi,
      yTicks: [0, 1, 2, 3, 4].map((i) => Number((lo + step * i).toFixed(2))),
    };
  }, [series]);

  const innerW = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

  const xForDate = (ymd: string): number => {
    if (dates.length <= 1) return PAD_LEFT + innerW / 2;
    const idx = dates.indexOf(ymd);
    if (idx < 0) return PAD_LEFT;
    return PAD_LEFT + (idx / (dates.length - 1)) * innerW;
  };

  const yForPrice = (val: number): number => {
    const range = Math.max(maxVal - minVal, 0.01);
    const ratio = (val - minVal) / range;
    return PAD_TOP + innerH - ratio * innerH;
  };

  const xLabelStep = dates.length > 10 ? Math.ceil(dates.length / 8) : 1;

  return (
    <div
      data-testid="price-evolution-chart"
      className="rounded-2xl bg-[#121215] border border-zinc-800 p-4 space-y-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-xs sm:text-sm font-extrabold text-white tracking-tight flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-red-500 shrink-0" />
            <span>{title}</span>
          </h4>
          {subtitle && <p className="text-[11px] text-zinc-400 mt-0.5">{subtitle}</p>}
        </div>

        {/* Leyenda de marcas */}
        <div className="flex flex-wrap items-center gap-2">
          {series.map((s) => (
            <span
              key={s.key}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-black border border-zinc-800 text-[10px] font-bold text-zinc-200"
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
              />
              <span>{s.label}</span>
            </span>
          ))}
        </div>
      </div>

      {dates.length === 0 || series.length === 0 ? (
        <div
          data-testid="price-evolution-chart-empty"
          className="h-44 rounded-xl bg-black/50 border border-dashed border-zinc-800 flex flex-col items-center justify-center text-center px-4"
        >
          <p className="text-xs font-bold text-zinc-400">
            Sin capturas suficientes para trazar evolución histórica en este filtro.
          </p>
          <p className="text-[11px] text-zinc-500 mt-1">
            A medida que las promotoras registren precios en campo, se graficará la tendencia por cadena y zona en USD normalizado BCV.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="w-full overflow-x-auto">
            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              role="img"
              aria-label={title}
              className="w-full min-w-[520px] h-auto select-none"
            >
              {/* Líneas horizontales y etiquetas eje Y */}
              {yTicks.map((tick, idx) => {
                const y = yForPrice(tick);
                return (
                  <g key={idx}>
                    <line
                      x1={PAD_LEFT}
                      x2={CHART_WIDTH - PAD_RIGHT}
                      y1={y}
                      y2={y}
                      stroke="#27272A"
                      strokeDasharray="3 3"
                      strokeWidth="1"
                    />
                    <text
                      x={PAD_LEFT - 8}
                      y={y + 4}
                      textAnchor="end"
                      fill="#A1A1AA"
                      fontSize="10"
                      fontFamily="monospace"
                    >
                      ${tick.toFixed(2)}
                    </text>
                  </g>
                );
              })}

              {/* Etiquetas eje X */}
              {dates.map((d, idx) => {
                if (idx % xLabelStep !== 0 && idx !== dates.length - 1) return null;
                const x = xForDate(d);
                return (
                  <text
                    key={d}
                    x={x}
                    y={CHART_HEIGHT - 12}
                    textAnchor="middle"
                    fill="#A1A1AA"
                    fontSize="10"
                    fontFamily="monospace"
                  >
                    {formatShortDate(d)}
                  </text>
                );
              })}

              {/* Series históricas */}
              {series.map((s) => {
                const pathD = s.points
                  .map(
                    (pt, idx) =>
                      `${idx === 0 ? 'M' : 'L'} ${xForDate(pt.date).toFixed(1)} ${yForPrice(pt.priceUsd).toFixed(1)}`
                  )
                  .join(' ');
                return (
                  <g key={s.key}>
                    {s.points.length > 1 && (
                      <path
                        d={pathD}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={s.isOwnBrand ? 3 : 2}
                        strokeDasharray={s.isOwnBrand ? undefined : '5 3'}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                    {s.points.map((pt) => {
                      const cx = xForDate(pt.date);
                      const cy = yForPrice(pt.priceUsd);
                      const isActive =
                        selectedPoint?.seriesLabel === s.label &&
                        selectedPoint.point.date === pt.date;
                      return (
                        <g
                          key={`${s.key}-${pt.date}`}
                          className="cursor-pointer"
                          onMouseEnter={() =>
                            setSelectedPoint({ seriesLabel: s.label, color: s.color, point: pt })
                          }
                          onClick={() =>
                            setSelectedPoint({ seriesLabel: s.label, color: s.color, point: pt })
                          }
                        >
                          {pt.hasDropAlert && (
                            <circle
                              cx={cx}
                              cy={cy}
                              r={9}
                              fill="rgba(220, 38, 38, 0.25)"
                              stroke="#DC2626"
                              strokeWidth="1.5"
                            />
                          )}
                          <circle
                            cx={cx}
                            cy={cy}
                            r={isActive ? 6 : s.isOwnBrand ? 4.5 : 3.8}
                            fill={s.color}
                            stroke="#09090B"
                            strokeWidth="1.5"
                          >
                            <title>
                              {`${s.label} · ${pt.date}: $${pt.priceUsd.toFixed(2)} USD (${pt.cadena || pt.storeName})`}
                            </title>
                          </circle>
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          </div>

          {selectedPoint && (
            <div
              data-testid="price-chart-tooltip"
              className="rounded-xl bg-black border border-zinc-800 px-3 py-2 text-[11px] flex flex-wrap items-center justify-between gap-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: selectedPoint.color }}
                />
                <strong className="text-white">{selectedPoint.seriesLabel}</strong>
                <span className="font-mono text-zinc-400">{selectedPoint.point.date}</span>
                <span className="font-mono font-bold text-emerald-400">
                  ${selectedPoint.point.priceUsd.toFixed(2)} USD
                </span>
                <span className="text-zinc-400">
                  (Orig: {selectedPoint.point.currency === 'VES' ? 'Bs.' : '$'}{' '}
                  {selectedPoint.point.originalPrice.toFixed(2)}
                  {selectedPoint.point.bcvRate
                    ? ` · BCV ${selectedPoint.point.bcvRate.toFixed(2)}`
                    : ''}
                  )
                </span>
              </div>
              <div className="flex items-center gap-2 text-zinc-400">
                <span>
                  {selectedPoint.point.cadena} · {selectedPoint.point.zona}
                </span>
                {selectedPoint.point.hasDropAlert && selectedPoint.point.dropPercent && (
                  <span className="px-2 py-0.5 rounded bg-red-600/20 border border-red-500/50 text-red-300 font-mono font-bold inline-flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    -{selectedPoint.point.dropPercent.toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
