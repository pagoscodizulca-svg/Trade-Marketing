-- =============================================================================
-- CODIZULCA C.A. - SINCRONIZACIÓN EN TIEMPO REAL DE DEGUSTACIONES (FDV -> TRADE)
-- Origen Emisor: FDV Planificador (https://dashboard-fdv-planificador.onrender.com)
-- Destino Receptor: Dashboard de Trade Marketing
-- Tabla compartida: public.surveys (registros donde type = 'Degustacion')
-- =============================================================================

BEGIN;

-- 1. Columnas nativas de trazabilidad de lectura para Trade Marketing
ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS leido_trade BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS visto_en_trade_at TIMESTAMPTZ DEFAULT NULL;

-- 2. Normalización inicial de históricos previos:
--    Marca como vistas únicamente las filas que NO son degustaciones, o cuya fecha
--    programada ya pasó (< CURRENT_DATE), o que ya tienen un estado terminal
--    (APROBADA, COMPLETADA, REALIZADA, RECHAZADA, CANCELADA), o que no provienen de FDV.
--    Toda solicitud FDV vigente pendiente ('SOLICITADA' / 'pendiente') y todo INSERT
--    futuro queda estrictamente en leido_trade = FALSE para encender el Globito (#DC2626).
UPDATE public.surveys
SET
  leido_trade = TRUE,
  visto_en_trade_at = COALESCE(visto_en_trade_at, NOW())
WHERE
  leido_trade = FALSE
  AND (
    type IS DISTINCT FROM 'Degustacion'
    OR date < CURRENT_DATE::TEXT
    OR comments IS NULL
    OR (
      comments NOT LIKE '%"source":"vendedor_app"%'
      AND comments NOT LIKE '%"source": "vendedor_app"%'
      AND comments NOT LIKE '%"degustacionId":%'
      AND comments NOT LIKE '%"vendedor":%'
    )
    OR comments LIKE '%"estado":"APROBADA"%'
    OR comments LIKE '%"estado":"COMPLETADA"%'
    OR comments LIKE '%"estado":"REALIZADA"%'
    OR comments LIKE '%"estado":"RECHAZADA"%'
    OR comments LIKE '%"estado":"CANCELADA"%'
  );

-- 3. Trigger protector anti-sobrescritura:
--    Si FDV Planificador ejecuta un PATCH de re-sincronización sobre `comments` sin
--    incluir `leido_trade`, preserva automáticamente `leido_trade = TRUE` y `visto_en_trade_at`
--    para impedir que una notificación ya vista vuelva a disparar el globito.
CREATE OR REPLACE FUNCTION public.preserve_surveys_leido_trade()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.leido_trade IS TRUE THEN
    -- Solo permitir reabrir a FALSE si el payload envía explícitamente `"leido_trade":false` y columna `FALSE`
    IF NEW.leido_trade IS DISTINCT FROM FALSE
       OR NEW.comments IS NULL
       OR (
         NEW.comments NOT LIKE '%"leido_trade":false%'
         AND NEW.comments NOT LIKE '%"leido_trade": false%'
       ) THEN
      NEW.leido_trade := TRUE;
      NEW.visto_en_trade_at := COALESCE(NEW.visto_en_trade_at, OLD.visto_en_trade_at, NOW());
    END IF;
  END IF;

  IF NEW.leido_trade IS TRUE AND NEW.visto_en_trade_at IS NULL THEN
    NEW.visto_en_trade_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_surveys_leido_trade ON public.surveys;

CREATE TRIGGER trg_preserve_surveys_leido_trade
  BEFORE UPDATE ON public.surveys
  FOR EACH ROW
  EXECUTE FUNCTION public.preserve_surveys_leido_trade();

-- 4. Índice parcial de alto rendimiento para consulta exacta del Globito (leido_trade = false)
CREATE INDEX IF NOT EXISTS idx_surveys_degustacion_unread
  ON public.surveys (type, leido_trade, created_at DESC)
  WHERE type = 'Degustacion' AND leido_trade = FALSE;

-- 5. Configuración de Supabase Realtime (INSERT + UPDATE + DELETE con fila completa)
ALTER TABLE public.surveys REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'surveys'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.surveys;
  END IF;
END $$;

-- 6. Permisos y Políticas RLS para garantizar SELECT, INSERT y UPDATE de leido_trade
GRANT SELECT, INSERT, UPDATE ON TABLE public.surveys TO anon, authenticated;

DO $$
DECLARE
  rls_enabled BOOLEAN;
BEGIN
  SELECT relrowsecurity
  INTO rls_enabled
  FROM pg_class
  WHERE oid = 'public.surveys'::regclass;

  IF rls_enabled THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'surveys'
        AND policyname = 'surveys_trade_select_policy'
    ) THEN
      CREATE POLICY surveys_trade_select_policy
        ON public.surveys
        FOR SELECT
        TO anon, authenticated
        USING (true);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'surveys'
        AND policyname = 'surveys_fdv_insert_policy'
    ) THEN
      CREATE POLICY surveys_fdv_insert_policy
        ON public.surveys
        FOR INSERT
        TO anon, authenticated
        WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'surveys'
        AND policyname = 'surveys_trade_update_leido_policy'
    ) THEN
      CREATE POLICY surveys_trade_update_leido_policy
        ON public.surveys
        FOR UPDATE
        TO anon, authenticated
        USING (true)
        WITH CHECK (true);
    END IF;
  END IF;
END $$;

COMMIT;
