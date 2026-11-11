-- =====================================================================
-- RutaDegustación · soporte offline-first (OPCIONAL pero recomendado)
-- Agrega dos columnas a public.entregas_degustacion:
--   hora_entrega_real     instante EXACTO (con zona horaria) en que el chofer tocó «Entregado»,
--                         aunque la operación se suba horas después por falta de señal.
--   actualizado_chofer_at instante de la última acción del chofer sobre la fila; permite que el servidor
--                         conserve el cambio MÁS RECIENTE si llegan operaciones atrasadas (gana el último).
-- Si NO se ejecuta, la app funciona igual: detecta que faltan las columnas y guarda solo `hora_entrega` (HH:mm).
-- Ejecutar en el SQL Editor de Supabase (o con `supabase db push`). Es idempotente.
-- =====================================================================

alter table public.entregas_degustacion
  add column if not exists hora_entrega_real timestamptz,
  add column if not exists actualizado_chofer_at timestamptz;

comment on column public.entregas_degustacion.hora_entrega_real is
  'Instante exacto (ISO) del toque «Entregado» en el teléfono del chofer; null si no está entregada.';
comment on column public.entregas_degustacion.actualizado_chofer_at is
  'Instante de la última acción del chofer sincronizada; protege el orden cuando llegan operaciones tardías.';

-- Tras agregar columnas, PostgREST actualiza su caché de esquema automáticamente en Supabase;
-- si ves el error PGRST204 durante unos segundos, ejecuta:  notify pgrst, 'reload schema';
