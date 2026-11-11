import type { Entrega, Producto } from '../types';
import { safePct } from './safeMath';

/** Minúsculas sin acentos, para búsquedas y comparaciones tolerantes. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function porcentaje(parte: number | null | undefined, total: number | null | undefined): number {
  return safePct(parte, total);
}

export interface Resumen {
  total: number;
  entregadas: number;
  pendientes: number;
  cumplimiento: number;
}

export function resumir(entregas: Entrega[] | null | undefined): Resumen {
  const lista = Array.isArray(entregas) ? entregas : [];
  const total = lista.length;
  const entregadas = lista.filter((e) => e.completado).length;
  return { total, entregadas, pendientes: total - entregadas, cumplimiento: porcentaje(entregadas, total) };
}

/** Días únicos en el orden en que aparecen en el cronograma. */
export function diasUnicos(entregas: Entrega[]): string[] {
  return Array.from(new Set(entregas.map((e) => e.fecha)));
}

export interface ProductoStyle {
  /** Etiqueta sólida de alto contraste */
  chip: string;
  /** Punto/acento */
  dot: string;
}

/** Clases literales para que Tailwind las detecte. */
export const PRODUCTO_STYLES: Record<Producto, ProductoStyle> = {
  AHUMADO: { chip: 'bg-amber-700 text-white', dot: 'bg-amber-700' },
  VENCAMPO: { chip: 'bg-blue-700 text-white', dot: 'bg-blue-700' },
  MORTADELA: { chip: 'bg-fuchsia-700 text-white', dot: 'bg-fuchsia-700' },
  ESTANDAR: { chip: 'bg-zinc-700 text-white', dot: 'bg-zinc-700' },
  ESPALDA: { chip: 'bg-purple-700 text-white', dot: 'bg-purple-700' },
};

export const PRODUCTO_LABEL: Record<Producto, string> = {
  AHUMADO: 'AHUMADO',
  VENCAMPO: 'VENCAMPO',
  MORTADELA: 'MORTADELA',
  ESTANDAR: 'ESTÁNDAR',
  ESPALDA: 'ESPALDA',
};

const ESTILO_DESCONOCIDO: ProductoStyle = { chip: 'bg-zinc-600 text-white', dot: 'bg-zinc-600' };

/** Estilo del producto; tolera valores no reconocidos que lleguen desde el servidor. */
export function estiloProducto(producto: string): ProductoStyle {
  return PRODUCTO_STYLES[producto as Producto] ?? ESTILO_DESCONOCIDO;
}

/** Etiqueta del producto; tolera valores no reconocidos que lleguen desde el servidor. */
export function etiquetaProducto(producto: string): string {
  return PRODUCTO_LABEL[producto as Producto] ?? (producto || '—');
}
