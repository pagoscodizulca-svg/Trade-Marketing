import { createSupabaseRepository } from './supabaseRepository';
import { createUnconfiguredRepository } from './unconfiguredRepository';
import type { EntregasRepository } from './entregasRepository';

const url = (import.meta.env?.VITE_SUPABASE_URL as string | undefined)?.trim();
const key = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

/**
 * Repositorio único de la app: Supabase. Sin credenciales NO se usa ningún respaldo ni dato inventado:
 * se expone un repositorio "no configurado" (estado `error`, lista vacía).
 */
export const entregasRepo: EntregasRepository =
  url && key ? createSupabaseRepository(url, key) : createUnconfiguredRepository();
