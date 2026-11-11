import { useEffect, useMemo, useState } from 'react';
import { normalizeExcelDate } from './excelDateNormalizer';

// ============================================================================
// MOTOR AUTOMÁTICO DE FECHAS Y SEMANAS EN TIEMPO REAL (VENEZUELA UTC-4)
// Actualiza automáticamente el día activo, la semana en curso (Lunes-Domingo)
// y los meses comparativos a medida que transcurren las semanas.
// ============================================================================

export const MONTH_NAMES_FULL_ES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

export const MONTH_NAMES_SHORT_ES = [
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
];

export const DAY_NAMES_FULL_ES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
];

export const DAY_NAMES_SHORT_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export interface MonthCalendarWeekDef {
  weekNumber: number;
  startDay: number;
  endDay: number;
  startStr: string;
  endStr: string;
  startYmd: string;
  endYmd: string;
  defaultDayStr: string;
  defaultDateYmd: string;
  rangeLabel: string;
  shortRangeLabel: string;
}

export interface RollingWeekDay {
  ymd: string;
  year: number;
  monthIndex: number;
  dayNumber: number;
  dayOfWeekSun0: number;
  dayName: string;
  shortDayName: string;
  monthShort: string;
  ddMm: string;
  dayLabel: string;
  isToday: boolean;
  isPast: boolean;
}

export interface RollingWeekWindow {
  weekOffset: number;
  isCurrentWeek: boolean;
  isoWeekNumber: number;
  isoWeekYear: number;
  mondayYmd: string;
  sundayYmd: string;
  rangeLabel: string;
  shortRangeLabel: string;
  days: RollingWeekDay[];
}

export interface LiveVenezuelaClock {
  todayYmd: string;
  year: number;
  month: number; // 1..12
  monthIndex: number; // 0..11
  day: number; // 1..31
  yearMonth: string; // YYYY-MM
  prevYearMonth: string; // YYYY-MM
  isoWeekNumber: number;
  isoWeekYear: number;
  monthWeekNumber: number;
  todayDayLabel: string; // Ej: "Miércoles 28/10"
  todayLongLabel: string; // Ej: "Miércoles 28 Oct 2026"
  currentWeek: RollingWeekWindow;
}

/** Obtiene la fecha YYYY-MM-DD actual en hora oficial de Venezuela (UTC-4). */
export function getLiveVenezuelaYmd(now: Date = new Date()): string {
  const ve = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return ve.toISOString().slice(0, 10);
}

/** Calcula el número de semana ISO-8601 (Lunes a Domingo, 1..53) y su año ISO. */
export function getIsoWeekInfo(ymd: string): { isoWeekNumber: number; isoWeekYear: number } {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { isoWeekNumber: 1, isoWeekYear: new Date().getFullYear() };

  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const dayNum = d.getUTCDay() || 7; // Lunes = 1 .. Domingo = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoWeekYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoWeekYear, 0, 1));
  const isoWeekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { isoWeekNumber, isoWeekYear };
}

/**
 * Calcula dinámicamente el número de semana calendario (Lunes a Domingo) dentro de un mes (1..6).
 * Si no se pasa año/mes, aplica bloques de 7 días estándar.
 */
export function getDynamicWeekNumberInMonth(
  day: number,
  year?: number,
  monthIndex?: number
): number {
  const safeDay = Math.max(1, Math.min(31, Math.floor(day)));
  if (typeof year === 'number' && typeof monthIndex === 'number' && year > 1990) {
    const firstDowSun0 = new Date(year, monthIndex, 1).getDay();
    const firstDowMon0 = (firstDowSun0 + 6) % 7; // Lunes=0 .. Domingo=6
    const firstSunday = 7 - firstDowMon0; // Día 1..7 del primer domingo del mes
    if (safeDay <= firstSunday) return 1;
    return 1 + Math.ceil((safeDay - firstSunday) / 7);
  }
  if (safeDay <= 4) return 1;
  if (safeDay <= 11) return 2;
  if (safeDay <= 18) return 3;
  if (safeDay <= 25) return 4;
  return 5;
}

/**
 * Construye dinámicamente todas las semanas calendario (Lunes a Domingo) de cualquier mes y año,
 * actualizando automáticamente los rangos de días cuando cambia el mes o el año.
 */
export function getMonthCalendarWeeks(year: number, monthIndex: number): MonthCalendarWeekDef[] {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const mm = String(monthIndex + 1).padStart(2, '0');
  const mShort = MONTH_NAMES_SHORT_ES[monthIndex] || 'Mes';

  const firstDowSun0 = new Date(year, monthIndex, 1).getDay();
  const firstDowMon0 = (firstDowSun0 + 6) % 7; // Lunes=0 .. Domingo=6
  const firstSunday = Math.min(lastDay, 7 - firstDowMon0);

  const weeks: MonthCalendarWeekDef[] = [];
  let currentStart = 1;
  let currentEnd = firstSunday;
  let weekNumber = 1;

  while (currentStart <= lastDay) {
    const startStr = String(currentStart).padStart(2, '0');
    const endStr = String(currentEnd).padStart(2, '0');
    const midDay = Math.floor((currentStart + currentEnd) / 2);
    const defaultDayStr = String(midDay).padStart(2, '0');

    weeks.push({
      weekNumber,
      startDay: currentStart,
      endDay: currentEnd,
      startStr,
      endStr,
      startYmd: `${year}-${mm}-${startStr}`,
      endYmd: `${year}-${mm}-${endStr}`,
      defaultDayStr,
      defaultDateYmd: `${year}-${mm}-${defaultDayStr}`,
      rangeLabel: `${startStr} ${mShort} - ${endStr} ${mShort} ${year}`,
      shortRangeLabel: `${startStr}-${endStr} ${mShort}`,
    });

    weekNumber += 1;
    currentStart = currentEnd + 1;
    currentEnd = Math.min(lastDay, currentStart + 6);
  }

  return weeks;
}

function formatUtcDateToYmd(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Calcula la ventana completa de 7 días (Lunes a Domingo) para la semana actual (weekOffset = 0),
 * semanas anteriores (weekOffset < 0) o semanas futuras (weekOffset > 0), incluso cuando cruza de mes o año.
 */
export function getRollingWeekWindow(
  todayYmd: string,
  weekOffset = 0
): RollingWeekWindow {
  const m = todayYmd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const baseYear = m ? Number(m[1]) : new Date().getFullYear();
  const baseMonthIdx = m ? Number(m[2]) - 1 : new Date().getMonth();
  const baseDay = m ? Number(m[3]) : new Date().getDate();

  const anchorUtc = new Date(Date.UTC(baseYear, baseMonthIdx, baseDay, 12, 0, 0));
  if (weekOffset !== 0) {
    anchorUtc.setUTCDate(anchorUtc.getUTCDate() + weekOffset * 7);
  }

  const dowSun0 = anchorUtc.getUTCDay();
  const offsetToMonday = dowSun0 === 0 ? -6 : 1 - dowSun0;

  const mondayUtc = new Date(anchorUtc.getTime());
  mondayUtc.setUTCDate(anchorUtc.getUTCDate() + offsetToMonday);

  const days: RollingWeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(mondayUtc.getTime());
    cur.setUTCDate(mondayUtc.getUTCDate() + i);
    const ymd = formatUtcDateToYmd(cur);
    const y = cur.getUTCFullYear();
    const mIdx = cur.getUTCMonth();
    const dNum = cur.getUTCDate();
    const sun0 = cur.getUTCDay();
    const dayName = DAY_NAMES_FULL_ES[sun0];
    const shortDayName = DAY_NAMES_SHORT_ES[sun0];
    const monthShort = MONTH_NAMES_SHORT_ES[mIdx];
    const dd = String(dNum).padStart(2, '0');
    const mm = String(mIdx + 1).padStart(2, '0');

    days.push({
      ymd,
      year: y,
      monthIndex: mIdx,
      dayNumber: dNum,
      dayOfWeekSun0: sun0,
      dayName,
      shortDayName,
      monthShort,
      ddMm: `${dd}/${mm}`,
      dayLabel: `${dayName} ${dd}/${mm}`,
      isToday: ymd === todayYmd,
      isPast: ymd < todayYmd,
    });
  }

  const mon = days[0];
  const sun = days[6];
  const { isoWeekNumber, isoWeekYear } = getIsoWeekInfo(mon.ymd);

  const sameMonth = mon.monthIndex === sun.monthIndex && mon.year === sun.year;
  const sameYear = mon.year === sun.year;

  const rangeLabel = sameMonth
    ? `${String(mon.dayNumber).padStart(2, '0')} - ${String(sun.dayNumber).padStart(2, '0')} ${mon.monthShort} ${mon.year}`
    : sameYear
      ? `${String(mon.dayNumber).padStart(2, '0')} ${mon.monthShort} - ${String(sun.dayNumber).padStart(2, '0')} ${sun.monthShort} ${sun.year}`
      : `${String(mon.dayNumber).padStart(2, '0')} ${mon.monthShort} ${mon.year} - ${String(sun.dayNumber).padStart(2, '0')} ${sun.monthShort} ${sun.year}`;

  const shortRangeLabel = `${mon.ddMm} - ${sun.ddMm}`;

  return {
    weekOffset,
    isCurrentWeek: weekOffset === 0,
    isoWeekNumber,
    isoWeekYear,
    mondayYmd: mon.ymd,
    sundayYmd: sun.ymd,
    rangeLabel,
    shortRangeLabel,
    days,
  };
}

/** Construye el estado completo de calendario vivo a partir de un `todayYmd`. */
export function buildLiveVenezuelaClock(todayYmd: string): LiveVenezuelaClock {
  const m = todayYmd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const year = m ? Number(m[1]) : new Date().getFullYear();
  const month = m ? Number(m[2]) : new Date().getMonth() + 1;
  const day = m ? Number(m[3]) : new Date().getDate();
  const monthIndex = month - 1;

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const yearMonth = `${year}-${mm}`;

  const prevMonthDate = new Date(year, monthIndex - 1, 1);
  const prevYearMonth = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;

  const { isoWeekNumber, isoWeekYear } = getIsoWeekInfo(todayYmd);
  const monthWeekNumber = getDynamicWeekNumberInMonth(day, year, monthIndex);
  const currentWeek = getRollingWeekWindow(todayYmd, 0);

  const utc = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
  const dayName = DAY_NAMES_FULL_ES[utc.getUTCDay()];
  const monthShort = MONTH_NAMES_SHORT_ES[monthIndex];

  return {
    todayYmd,
    year,
    month,
    monthIndex,
    day,
    yearMonth,
    prevYearMonth,
    isoWeekNumber,
    isoWeekYear,
    monthWeekNumber,
    todayDayLabel: `${dayName} ${dd}/${mm}`,
    todayLongLabel: `${dayName} ${dd} ${monthShort} ${year}`,
    currentWeek,
  };
}

/**
 * Hook Reactivo de Calendario Automático (America/Caracas UTC-4).
 * Revisa el reloj cada 30 segundos y al enfocar la ventana; si cambia el día o inicia una nueva semana,
 * actualiza automáticamente todas las fechas, semanas activas y períodos sin recargar la página.
 */
export function useLiveVenezuelaClock(): LiveVenezuelaClock {
  const [todayYmd, setTodayYmd] = useState<string>(() => getLiveVenezuelaYmd());

  useEffect(() => {
    const syncDateIfChanged = () => {
      const latest = getLiveVenezuelaYmd();
      setTodayYmd((prev) => (prev !== latest ? latest : prev));
    };

    syncDateIfChanged();
    const intervalId = window.setInterval(syncDateIfChanged, 30_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        syncDateIfChanged();
      }
    };

    window.addEventListener('focus', syncDateIfChanged);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', syncDateIfChanged);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return useMemo(() => buildLiveVenezuelaClock(todayYmd), [todayYmd]);
}

/** Normaliza cualquier fecha de registro (Excel serial, letras ES/EN, dd-mm-aaaa, dd/mm/aaaa o ISO) a YYYY-MM-DD. */
export function normalizeAnyDateToYmd(raw?: unknown): string | null {
  return normalizeExcelDate(raw).fechaIso;
}
