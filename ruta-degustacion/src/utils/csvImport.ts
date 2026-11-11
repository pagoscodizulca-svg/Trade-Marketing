import { PRODUCTOS, TURNOS, type Entrega, type Producto, type Turno } from '../types';

export type EntregaImport = Omit<Entrega, 'id'>;

export interface ImportError {
  /** Número exacto de fila 1-based en el archivo (1 = encabezado) */
  fila: number;
  mensaje: string;
}

export interface ImportResult {
  rows: EntregaImport[];
  errors: ImportError[];
}

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB máximo para mitigar DoS
export const MAX_IMPORT_ROWS = 2000; // Máximo de filas de datos por lote

type Celda = string | number | boolean | Date | null | undefined;

const COLUMNAS_PLANTILLA = [
  'FECHA',
  'TURNO',
  'GRUPO',
  'CLIENTE',
  'PRODUCTO',
  'VENDEDOR',
  'PROMOTORA',
  'ESTADO',
  'HORA ENTREGA',
];

/** Plantilla CSV: solo encabezados, sin filas de datos. */
export const PLANTILLA_CSV = COLUMNAS_PLANTILLA.join(',') + '\n';

const CLAVES_PELIGROSAS = new Set(['__proto__', 'constructor', 'prototype']);

function esClavePeligrosa(k: unknown): boolean {
  if (typeof k !== 'string') return false;
  const limpia = k.trim().toLowerCase();
  return CLAVES_PELIGROSAS.has(limpia);
}

function crearMapaSeguro<T>(pares: ReadonlyArray<readonly [string, T]> = []): Record<string, T> {
  const mapa = Object.create(null) as Record<string, T>;
  for (const [k, v] of pares) {
    if (!esClavePeligrosa(k)) {
      mapa[k] = v;
    }
  }
  return mapa;
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Sanitiza textos libres contra caracteres de control y Formula/CSV Injection
 * (`=`, `+`, `-`, `@`, `\t`, `\r` al inicio), preservando números negativos y fechas válidas.
 */
export function sanitizarTextoCelda(valor: unknown, maxLen = 250): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'function' || typeof valor === 'symbol') return '';
  if (typeof valor === 'object' && !(valor instanceof Date)) return '';

  const strOriginal = String(valor);
  const inicioSinControl = strOriginal.replace(
    /^[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]+/,
    ''
  );
  const teniaTabOCrEjecutable = /^[\t\r]+\s*[=+\-@]/.test(inicioSinControl);

  let limpio = strOriginal
    .replace(/[\u0000-\u001F\u007F-\u009F\u00A0\u200B-\u200D\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!limpio) return '';

  if (teniaTabOCrEjecutable || /^[=+\-@]/.test(limpio)) {
    const esNumeroConSigno = /^[+-]?\d+(?:[.,]\d+)?$/.test(limpio);
    const esPatronFecha =
      /^\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}$/.test(limpio) ||
      /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(limpio);

    if (!esNumeroConSigno && !esPatronFecha) {
      limpio = limpio.replace(/^(?:[=+\-@]\s*)+/, '').trim();
    }
  }

  return limpio.length > maxLen ? limpio.slice(0, maxLen).trim() : limpio;
}

function extraerFechaDeInstanciaDate(d: Date): { anio: number; mes: number; dia: number } | null {
  if (Number.isNaN(d.getTime())) return null;
  const esMedianocheUtc =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;
  const esMedianocheLocal =
    d.getHours() === 0 &&
    d.getMinutes() === 0 &&
    d.getSeconds() === 0 &&
    d.getMilliseconds() === 0;

  const usarLocal = !esMedianocheUtc && esMedianocheLocal;
  return {
    anio: usarLocal ? d.getFullYear() : d.getUTCFullYear(),
    mes: usarLocal ? d.getMonth() + 1 : d.getUTCMonth() + 1,
    dia: usarLocal ? d.getDate() : d.getUTCDate(),
  };
}

/**
 * Convierte una celda a texto limpio sin invocar jamás `.toISOString()` sobre instancias `Date`.
 */
const texto = (c: Celda): string => {
  if (c === null || c === undefined) return '';
  if (c instanceof Date) {
    const comp = extraerFechaDeInstanciaDate(c);
    if (!comp) return '';
    return `${String(comp.dia).padStart(2, '0')}-${String(comp.mes).padStart(2, '0')}-${String(comp.anio).padStart(4, '0')}`;
  }
  return sanitizarTextoCelda(c);
};

const clave = (s: string) => sinAcentos(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

const CONECTORES_ENCABEZADO = Object.freeze(
  crearMapaSeguro<true>([
    ['DE', true],
    ['DEL', true],
    ['LA', true],
    ['LAS', true],
    ['EL', true],
    ['LOS', true],
    ['A', true],
    ['AL', true],
    ['POR', true],
    ['PARA', true],
  ])
);

function normalizarEncabezadoColumna(raw: string): { compacta: string; canonica: string } {
  const limpio = sanitizarTextoCelda(raw, 140).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  if (!limpio || esClavePeligrosa(limpio)) {
    return { compacta: '', canonica: '' };
  }
  const tokens = sinAcentos(limpio)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => Boolean(t) && !esClavePeligrosa(t));

  const compacta = tokens.join('');
  const significativos = tokens.filter((t) => !CONECTORES_ENCABEZADO[t]);
  const canonica = (significativos.length > 0 ? significativos : tokens).join('');
  return { compacta, canonica };
}

/** Parser CSV (comillas, saltos de línea en celdas; detecta delimitador , ; o tab). */
export function parseCsv(input: string): string[][] {
  const src = input.replace(/^\uFEFF/, '');
  const primera = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', '\t', ','].reduce((best, d) =>
    primera.split(d).length > primera.split(best).length ? d : best
  );
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let enComillas = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (enComillas) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          celda += '"';
          i++;
        } else enComillas = false;
      } else celda += ch;
    } else if (ch === '"') enComillas = true;
    else if (ch === delim) {
      fila.push(sanitizarTextoCelda(celda));
      celda = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      fila.push(sanitizarTextoCelda(celda));
      filas.push(fila);
      fila = [];
      celda = '';
    } else celda += ch;
  }
  if (celda !== '' || fila.length > 0) {
    fila.push(sanitizarTextoCelda(celda));
    filas.push(fila);
  }
  return filas.filter((f) => f.some((c) => c.trim() !== ''));
}

const DIAS_SEMANA = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

const MESES_MAP: Readonly<Record<string, number>> = Object.freeze(
  crearMapaSeguro<number>([
    ['enero', 1],
    ['ene', 1],
    ['january', 1],
    ['jan', 1],
    ['febrero', 2],
    ['feb', 2],
    ['february', 2],
    ['marzo', 3],
    ['mar', 3],
    ['march', 3],
    ['abril', 4],
    ['abr', 4],
    ['april', 4],
    ['apr', 4],
    ['mayo', 5],
    ['may', 5],
    ['junio', 6],
    ['jun', 6],
    ['june', 6],
    ['julio', 7],
    ['jul', 7],
    ['july', 7],
    ['agosto', 8],
    ['ago', 8],
    ['agos', 8],
    ['august', 8],
    ['aug', 8],
    ['septiembre', 9],
    ['setiembre', 9],
    ['sep', 9],
    ['sept', 9],
    ['set', 9],
    ['september', 9],
    ['octubre', 10],
    ['oct', 10],
    ['october', 10],
    ['noviembre', 11],
    ['nov', 11],
    ['november', 11],
    ['diciembre', 12],
    ['dic', 12],
    ['december', 12],
    ['dec', 12],
  ])
);

function formatearDdMmYyyy(anio: number, mes: number, dia: number): string | null {
  if (anio < 1990 || anio > 2100 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const dt = new Date(Date.UTC(anio, mes - 1, dia));
  if (dt.getUTCFullYear() !== anio || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== dia) {
    return null;
  }
  return `${String(dia).padStart(2, '0')}-${String(mes).padStart(2, '0')}-${String(anio).padStart(4, '0')}`;
}

function normalizarFecha(celda: Celda): string | null {
  try {
    if (celda === null || celda === undefined || typeof celda === 'boolean') return null;
    if (celda instanceof Date) {
      const comp = extraerFechaDeInstanciaDate(celda);
      if (!comp) return null;
      return formatearDdMmYyyy(comp.anio, comp.mes, comp.dia);
    }
    if (typeof celda === 'number') {
      if (!Number.isFinite(celda) || celda < 1 || celda > 2958465) return null;
      const whole = Math.floor(celda + 1e-9);
      if (whole === 60) return null; // 29/02/1900 no existe
      const epochOffset = whole < 60 ? 25568 : 25569;
      const dt = new Date((whole - epochOffset) * 86_400_000);
      return formatearDdMmYyyy(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }

    const limpio = String(celda)
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/^'+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    if (!limpio || esClavePeligrosa(limpio) || limpio.startsWith('#')) return null;

    if (/^\d{5}(?:[.,]\d{1,10})?$/.test(limpio)) {
      return normalizarFecha(Number(limpio.replace(',', '.')));
    }

    const iso = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[T\s].*)?$/i.exec(limpio);
    if (iso) {
      return formatearDdMmYyyy(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    }

    // Prioridad estricta latinoamericana DD/MM/YYYY: rechazar meses > 12
    const num = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(limpio);
    if (num) {
      const dia = Number(num[1]);
      const mes = Number(num[2]);
      const rawYr = Number(num[3]);
      const yr = num[3]!.length === 2 ? (rawYr <= 69 ? 2000 + rawYr : 1900 + rawYr) : rawYr;
      if (mes >= 1 && mes <= 12) {
        return formatearDdMmYyyy(yr, mes, dia);
      }
      return null;
    }

    // Fechas en letras (español o inglés)
    const tokens = sinAcentos(limpio)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((t) => Boolean(t) && !esClavePeligrosa(t));

    let mesEncontrado: number | null = null;
    const numeros: Array<{ val: number; len: number }> = [];
    for (const tok of tokens) {
      if (MESES_MAP[tok] && mesEncontrado === null) {
        mesEncontrado = MESES_MAP[tok]!;
      } else if (/^\d{1,4}$/.test(tok)) {
        numeros.push({ val: Number(tok), len: tok.length });
      }
    }
    if (mesEncontrado !== null && numeros.length >= 2) {
      const idxAnio = numeros.findIndex((n) => n.len === 4);
      const itemAnio = idxAnio >= 0 ? numeros[idxAnio]! : numeros[numeros.length - 1]!;
      const itemDia = idxAnio === 0 ? numeros[1]! : numeros[0]!;
      const yr =
        itemAnio.len === 2
          ? itemAnio.val <= 69
            ? 2000 + itemAnio.val
            : 1900 + itemAnio.val
          : itemAnio.val;
      return formatearDdMmYyyy(yr, mesEncontrado, itemDia.val);
    }

    // Formato corto heredado de ruta ("JUEVES 05")
    const corto = sinAcentos(limpio)
      .toUpperCase()
      .match(/^([A-Z]+)\s*(\d{1,2})$/);
    if (corto && DIAS_SEMANA.includes(corto[1]!)) {
      const nDia = Number(corto[2]!);
      if (nDia < 1 || nDia > 31) return null;
      const dia =
        corto[1] === 'MIERCOLES' ? 'MIÉRCOLES' : corto[1] === 'SABADO' ? 'SÁBADO' : corto[1]!;
      return `${dia} ${corto[2]!.padStart(2, '0')}`;
    }

    return null;
  } catch {
    return null;
  }
}

function normalizarTurno(valor: string): Turno | null {
  const k = clave(valor);
  if (k.startsWith('MANANA')) return 'MAÑANA';
  if (k.startsWith('TARDE')) return 'TARDE';
  return null;
}

function normalizarProducto(valor: string): Producto | null {
  const k = clave(valor);
  return (PRODUCTOS as readonly string[]).includes(k) ? (k as Producto) : null;
}

function normalizarHora(c: Celda): string | null {
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) return null;
    return `${String(c.getUTCHours()).padStart(2, '0')}:${String(c.getUTCMinutes()).padStart(2, '0')}`;
  }
  if (typeof c === 'number' && c >= 0 && c < 1) {
    const mins = Math.round(c * 24 * 60);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  const m = texto(c).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
}

const SINONIMOS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  crearMapaSeguro<readonly string[]>([
    [
      'fecha',
      [
        'FECHA',
        'FECHADEGUSTACION',
        'FECHADEDEGUSTACION',
        'FECHAPROGRAMADA',
        'FECHAEJECUCION',
        'FECHAACTIVIDAD',
        'DIA',
        'DIADEGUSTACION',
        'DATE',
      ],
    ],
    ['turno', ['TURNO', 'JORNADA', 'HORARIO']],
    ['grupo', ['GRUPO', 'NUMEROGRUPOTURNO', 'GRUPOTURNO', 'NGRUPO']],
    ['cliente', ['CLIENTE', 'PUNTODEVENTA', 'PUNTOVENTA', 'PDV', 'TIENDA', 'COMERCIO']],
    ['producto', ['PRODUCTO', 'PRODUCTOS', 'PRODUCTODEGUSTAR', 'PRODUCTOADEGUSTAR']],
    ['vendedor', ['VENDEDOR', 'FDV', 'ASESOR', 'FUERZAVENTAS', 'FUERZADEVENTAS']],
    ['promotora', ['PROMOTORA', 'PROMOTORASUGERIDA', 'IMPULSADORA']],
    ['estado', ['ESTADO', 'COMPLETADO', 'ENTREGADO']],
    ['hora', ['HORAENTREGA', 'HORA']],
  ])
);

/** Convierte una matriz (CSV o Excel) con encabezados a registros validados. */
export function matrizAEntregas(matriz: Celda[][]): ImportResult {
  const result: ImportResult = { rows: [], errors: [] };
  if (matriz.length < 2) {
    result.errors.push({ fila: 1, mensaje: 'El archivo no tiene filas de datos.' });
    return result;
  }

  if (matriz.length - 1 > MAX_IMPORT_ROWS) {
    result.errors.push({
      fila: 1,
      mensaje: `El archivo contiene ${matriz.length - 1} filas y supera el máximo permitido de ${MAX_IMPORT_ROWS} registros por lote.`,
    });
    return result;
  }

  const encabezados = matriz[0]!.map((c) => normalizarEncabezadoColumna(texto(c)));
  const idx = crearMapaSeguro<number>();
  for (const [campo, alias] of Object.entries(SINONIMOS)) {
    if (esClavePeligrosa(campo)) continue;
    idx[campo] = encabezados.findIndex(
      (h) =>
        (Boolean(h.canonica) && alias.includes(h.canonica)) ||
        (Boolean(h.compacta) && alias.includes(h.compacta))
    );
  }

  const faltantes = (['fecha', 'cliente', 'producto'] as const).filter((c) => (idx[c] ?? -1) < 0);
  if ((idx.turno ?? -1) < 0 && (idx.grupo ?? -1) < 0) faltantes.push('turno' as never);
  if (faltantes.length) {
    result.errors.push({
      fila: 1,
      mensaje: `Faltan columnas obligatorias: ${faltantes.map((f) => f.toUpperCase()).join(', ')}.`,
    });
    return result;
  }

  const get = (fila: Celda[], campo: string): Celda => {
    if (esClavePeligrosa(campo)) return '';
    const colIdx = idx[campo] ?? -1;
    return colIdx >= 0 ? fila[colIdx] : '';
  };

  matriz.slice(1).forEach((fila, i) => {
    const nFila = i + 2;
    if (fila.every((c) => texto(c) === '')) return;
    const problemas: string[] = [];

    const celdaFechaRaw = get(fila, 'fecha');
    const fecha = normalizarFecha(celdaFechaRaw);
    if (!fecha) {
      const recibido = String(celdaFechaRaw ?? '').trim().slice(0, 60);
      problemas.push(
        recibido
          ? `Fila #${nFila}: FECHA inválida (recibido: "${recibido}"; use formato dd-mm-aaaa)`
          : `Fila #${nFila}: FECHA vacía (use formato dd-mm-aaaa)`
      );
    }

    const grupoTxt = texto(get(fila, 'grupo')).toUpperCase();
    const turno = normalizarTurno(texto(get(fila, 'turno'))) ?? normalizarTurno(grupoTxt);
    if (!turno) problemas.push(`TURNO inválido (use ${TURNOS.join(' o ')})`);

    const cliente = texto(get(fila, 'cliente')).toUpperCase();
    if (!cliente) problemas.push('CLIENTE vacío');

    const producto = normalizarProducto(texto(get(fila, 'producto')));
    if (!producto) {
      problemas.push(
        `PRODUCTO inválido ("${texto(get(fila, 'producto'))}", use ${PRODUCTOS.join(', ')})`
      );
    }

    if (problemas.length || !fecha || !turno || !producto) {
      result.errors.push({ fila: nFila, mensaje: problemas.join('; ') });
      return;
    }

    const estado = clave(texto(get(fila, 'estado')));
    const completado = ['COMPLETADO', 'ENTREGADO', 'SI', 'TRUE', '1', 'LISTO', 'X'].includes(
      estado
    );
    const hora = completado ? normalizarHora(get(fila, 'hora')) : null;

    result.rows.push({
      fecha,
      turno,
      numero_grupo_turno: grupoTxt.match(/\d/) ? grupoTxt : grupoTxt || turno,
      cliente,
      producto,
      vendedor: texto(get(fila, 'vendedor')).toUpperCase(),
      promotora: texto(get(fila, 'promotora')).toUpperCase(),
      stand_entregado: completado,
      producto_entregado: completado,
      completado,
      hora_entrega: completado ? hora ?? '00:00' : null,
      notas_chofer: '',
    });
  });

  if (result.rows.length === 0 && result.errors.length === 0) {
    result.errors.push({ fila: 2, mensaje: 'No se encontraron filas válidas.' });
  }
  return result;
}

/** Lee un archivo CSV o Excel (.xlsx) y lo convierte en registros validando tipo y tamaño. */
export async function importarArchivo(file: File): Promise<ImportResult> {
  if (!file || file.size <= 0) {
    return { rows: [], errors: [{ fila: 0, mensaje: 'El archivo seleccionado está vacío (0 bytes).' }] };
  }

  if (file.size > MAX_IMPORT_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(2);
    return {
      rows: [],
      errors: [
        {
          fila: 0,
          mensaje: `El archivo pesa ${mb} MB y supera el límite máximo permitido de 10 MB.`,
        },
      ],
    };
  }

  const nombre = file.name.toLowerCase();
  if (nombre.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser');
    const filas = (await readSheet(file)) as Celda[][];
    return matrizAEntregas(filas);
  }
  if (nombre.endsWith('.csv') || nombre.endsWith('.txt') || file.type.startsWith('text/')) {
    return matrizAEntregas(parseCsv(await file.text()));
  }
  return { rows: [], errors: [{ fila: 0, mensaje: 'Formato no soportado. Use .csv o .xlsx.' }] };
}
