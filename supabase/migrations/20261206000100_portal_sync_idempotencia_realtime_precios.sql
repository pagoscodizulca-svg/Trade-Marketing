-- ==============================================================================
-- MIGRACIÓN ADITIVA E IDEMPOTENTE:
--   Sincronización Total App de Promotoras (/portal) -> Módulo 1 Informes
--   1. Idempotencia estricta anti-duplicados (`client_submission_id` UUID UNIQUE)
--      en `public.inventory`, `public.prices` y `public.surveys`.
--   2. Columnas bimonetarias aditivas en `public.prices` + tabla `public.tasas_bcv`
--      con RLS estricto `TO authenticated` (sin `anon`, usando `auth.uid()`).
--   3. Publicación Supabase Realtime (`supabase_realtime`) para reflejo inmediato
--      en Módulo 1 -> Informes (`inventory`, `prices`, `surveys`,
--      `asistencias_jornada`, `asistencia_evidencias`).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. IDEMPOTENCIA ANTI-DUPLICADOS (`client_submission_id` + ÍNDICE PARCIAL UNIQUE)
-- ------------------------------------------------------------------------------
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_client_submission_id_unique
  ON public.inventory (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

ALTER TABLE public.prices
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_prices_client_submission_id_unique
  ON public.prices (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_client_submission_id_unique
  ON public.surveys (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 2. EXTENSIÓN BIMONETARIA EN `public.prices` Y CACHÉ OFICIAL `public.tasas_bcv`
--    (Elimina fallos PGRST204 y 404 en /portal/precios -> Informes Precios)
-- ------------------------------------------------------------------------------
ALTER TABLE public.prices
  ADD COLUMN IF NOT EXISTS cadena TEXT,
  ADD COLUMN IF NOT EXISTS zona TEXT,
  ADD COLUMN IF NOT EXISTS moneda_propia TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS moneda_competencia TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS tasa_bcv_aplicada NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS tasa_bcv_fecha DATE,
  ADD COLUMN IF NOT EXISTS precio_propio_usd NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS precio_competencia_usd NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS brecha_usd NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS brecha_porcentaje NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS competitors_meta JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ocr_asistido BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ocr_confianza TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prices_moneda_propia_check' AND conrelid = 'public.prices'::regclass
  ) THEN
    ALTER TABLE public.prices
      ADD CONSTRAINT prices_moneda_propia_check CHECK (moneda_propia IN ('USD', 'VES'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prices_moneda_competencia_check' AND conrelid = 'public.prices'::regclass
  ) THEN
    ALTER TABLE public.prices
      ADD CONSTRAINT prices_moneda_competencia_check CHECK (moneda_competencia IN ('USD', 'VES'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prices_tasa_bcv_aplicada_check' AND conrelid = 'public.prices'::regclass
  ) THEN
    ALTER TABLE public.prices
      ADD CONSTRAINT prices_tasa_bcv_aplicada_check CHECK (tasa_bcv_aplicada IS NULL OR tasa_bcv_aplicada > 0);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.tasas_bcv (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha DATE NOT NULL UNIQUE,
  tasa_usd_ves NUMERIC(12, 4) NOT NULL CHECK (tasa_usd_ves > 0),
  fuente TEXT NOT NULL DEFAULT 'BCV_OFICIAL'
    CHECK (fuente IN ('BCV_OFICIAL', 'MANUAL_ADMIN', 'RESPALDO')),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasas_bcv_fecha_desc
  ON public.tasas_bcv (fecha DESC);

REVOKE ALL ON TABLE public.tasas_bcv FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tasas_bcv TO authenticated, service_role;
ALTER TABLE public.tasas_bcv ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasas_bcv_select_authenticated ON public.tasas_bcv;
CREATE POLICY tasas_bcv_select_authenticated
  ON public.tasas_bcv
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

DO $$
BEGIN
  IF to_regprocedure('public.is_global_admin()') IS NOT NULL THEN
    DROP POLICY IF EXISTS tasas_bcv_insert_global_admin ON public.tasas_bcv;
    CREATE POLICY tasas_bcv_insert_global_admin
      ON public.tasas_bcv
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.is_global_admin()));

    DROP POLICY IF EXISTS tasas_bcv_update_global_admin ON public.tasas_bcv;
    CREATE POLICY tasas_bcv_update_global_admin
      ON public.tasas_bcv
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.is_global_admin()))
      WITH CHECK ((SELECT public.is_global_admin()));

    DROP POLICY IF EXISTS tasas_bcv_delete_global_admin ON public.tasas_bcv;
    CREATE POLICY tasas_bcv_delete_global_admin
      ON public.tasas_bcv
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_global_admin()));
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 3. PUBLICACIÓN REALTIME (`supabase_realtime`) PARA MÓDULO 1 -> INFORMES
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'inventory',
    'prices',
    'surveys',
    'asistencias_jornada',
    'asistencia_evidencias'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public'
           AND tablename = tbl
       ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
    END IF;
  END LOOP;
END
$$;

-- ------------------------------------------------------------------------------
-- 4. RECARGAR CACHÉ DE ESQUEMA DE POSTGREST
-- ------------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
