import { createSupabaseRepository } from './supabaseRepository';
import { createUnconfiguredRepository } from './unconfiguredRepository';
import { resolveRutaSupabaseConfig } from './supabaseAuth';
import type { EntregasRepository } from './entregasRepository';

const { config, configError } = resolveRutaSupabaseConfig();

/**
 * Repositorio único de la app: Supabase autenticado. Sin credenciales públicas válidas NO se usa
 * ningún respaldo ni dato inventado: se expone un repositorio "no configurado" (estado `error`, lista vacía).
 */
export const entregasRepo: EntregasRepository =
  config && !configError
    ? createSupabaseRepository(config.url, config.publicKey)
    : createUnconfiguredRepository(configError);
