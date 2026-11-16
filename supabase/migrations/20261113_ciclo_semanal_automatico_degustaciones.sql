-- =============================================================================
-- CODIZULCA C.A. - SEPARACIÓN AUTOMÁTICA POR CICLO SEMANAL ISO EN DEGUSTACIONES
-- Regla de Negocio (Zona Horaria Oficial: America/Caracas, UTC-04:00):
--   - Semana en Curso (ISO): Lunes 00:00:00.000 a Domingo 23:59:59.999
--   - Bandeja de Entrada (Semana en Curso): fecha_evento >= fn_inicio_semana_caracas()
--   - Historial (Semanas Anteriores):       fecha_evento <  fn_inicio_semana_caracas()
--
-- Garantías de Seguridad y Gobernanza:
--   1. Cero operaciones destructivas sobre datos (prohibido DELETE FROM, TRUNCATE o DROP TABLE).
--   2. Columna tipada aditiva `fecha_evento DATE` en `public.surveys` sincronizada por trigger
--      e índices B-tree parciales/compuestos para paginación eficiente en servidor.
--   3. Candado de Integridad Histórica (RBAC / RLS Zero Trust):
--      Políticas RLS `AS RESTRICTIVE` + Trigger `BEFORE UPDATE OR DELETE` que impiden a roles
--      no administradores modificar o eliminar degustaciones con fecha < inicio_semana_actual
--      en `America/Caracas`, leyendo el rol exclusivamente desde `app_metadata`.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. FUNCIONES DETERMINISTAS DE FECHA Y CORTE SEMANAL ISO (`America/Caracas`)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_parse_degustacion_fecha(
  p_date TEXT,
  p_comments TEXT
)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_raw TEXT;
  v_json JSONB;
  v_candidate TEXT;
BEGIN
  v_raw := pg_catalog.btrim(COALESCE(p_date, ''));

  IF v_raw = '' AND p_comments IS NOT NULL AND pg_catalog.btrim(p_comments) LIKE '{%' THEN
    BEGIN
      v_json := p_comments::jsonb;
      v_raw := pg_catalog.btrim(COALESCE(v_json ->> 'date', v_json ->> 'fecha', ''));
    EXCEPTION WHEN OTHERS THEN
      v_raw := '';
    END;
  END IF;

  IF v_raw = '' THEN
    RETURN NULL;
  END IF;

  -- Formato ISO YYYY-MM-DD (o prefijo ISO YYYY-MM-DDTHH:mm...)
  IF v_raw ~ '^\d{4}-\d{2}-\d{2}' THEN
    v_candidate := pg_catalog.substring(v_raw FROM 1 FOR 10);
    BEGIN
      RETURN v_candidate::date;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END IF;

  -- Formato venezolano DD/MM/YYYY o DD-MM-YYYY
  IF v_raw ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}$' THEN
    BEGIN
      RETURN pg_catalog.to_date(pg_catalog.replace(v_raw, '-', '/'), 'DD/MM/YYYY');
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END IF;

  RETURN NULL;
END;
$$;

-- Calcula exactamente el Lunes 00:00:00 (ISO-8601) de la semana vigente en `America/Caracas` (UTC-4)
CREATE OR REPLACE FUNCTION public.fn_inicio_semana_caracas(
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pg_catalog.date_trunc(
    'week',
    pg_catalog.timezone('America/Caracas', COALESCE(p_now, NOW()))
  )::date;
$$;

GRANT EXECUTE ON FUNCTION public.fn_parse_degustacion_fecha(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_inicio_semana_caracas(TIMESTAMPTZ) TO anon, authenticated;

-- =============================================================================
-- 2. COLUMNA ADITIVA `fecha_evento DATE` + TRIGGER DE SINCRONIZACIÓN + ÍNDICES
-- =============================================================================
ALTER TABLE IF EXISTS public.surveys
  ADD COLUMN IF NOT EXISTS fecha_evento DATE DEFAULT NULL;

CREATE OR REPLACE FUNCTION public.fn_sync_surveys_fecha_evento()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.type = 'Degustacion' THEN
    NEW.fecha_evento := COALESCE(
      public.fn_parse_degustacion_fecha(NEW.date, NEW.comments),
      (pg_catalog.timezone('America/Caracas', COALESCE(NEW.created_at, NOW())))::date
    );
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_sync_surveys_fecha_evento'
      AND tgrelid = 'public.surveys'::regclass
  ) THEN
    CREATE TRIGGER trg_sync_surveys_fecha_evento
      BEFORE INSERT OR UPDATE OF type, date, comments
      ON public.surveys
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_sync_surveys_fecha_evento();
  END IF;
END $$;

-- Backfill no destructivo para filas existentes de degustación
UPDATE public.surveys s
SET fecha_evento = COALESCE(
  public.fn_parse_degustacion_fecha(s.date, s.comments),
  (pg_catalog.timezone('America/Caracas', COALESCE(s.created_at, NOW())))::date
)
WHERE s.type = 'Degustacion'
  AND s.fecha_evento IS NULL;

-- Índices B-tree parciales/compuestos para paginación eficiente en servidor (25 registros/página)
CREATE INDEX IF NOT EXISTS idx_surveys_degustacion_fecha_evento_desc
  ON public.surveys (fecha_evento DESC, created_at DESC)
  WHERE type = 'Degustacion';

CREATE INDEX IF NOT EXISTS idx_surveys_degustacion_fecha_evento_asc
  ON public.surveys (fecha_evento ASC, created_at DESC)
  WHERE type = 'Degustacion';

CREATE INDEX IF NOT EXISTS idx_cronograma_degustaciones_fecha_created_desc
  ON public.cronograma_degustaciones (fecha DESC, created_at DESC);

-- =============================================================================
-- 3. AUTORIZACIÓN ESTRICTA (`private.is_strict_admin`) Y CANDADO HISTÓRICO RLS
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS private;

GRANT USAGE ON SCHEMA private TO anon, authenticated;

CREATE OR REPLACE FUNCTION private.current_app_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pg_catalog.lower(
    pg_catalog.btrim(
      COALESCE(
        (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
        (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
        ''
      )
    )
  );
$$;

-- Lee exclusivamente `app_metadata` firmado por servidor (jamás `user_metadata` ni `auth.role()`)
CREATE OR REPLACE FUNCTION private.is_strict_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND (SELECT private.current_app_role()) IN ('admin', 'gerente_admin', 'superadmin');
$$;

REVOKE ALL ON FUNCTION private.current_app_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_strict_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.current_app_role() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_strict_admin() TO anon, authenticated;

-- 3.A. Políticas RLS `AS RESTRICTIVE` en `public.surveys` (bloquea UPDATE/DELETE de semanas pasadas a no-admins)
DO $$
DECLARE
  v_surveys_rls BOOLEAN := FALSE;
BEGIN
  SELECT c.relrowsecurity
  INTO v_surveys_rls
  FROM pg_class c
  WHERE c.oid = 'public.surveys'::regclass;

  IF v_surveys_rls THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'surveys'
        AND policyname = 'surveys_restrict_historical_degustacion_update'
    ) THEN
      CREATE POLICY surveys_restrict_historical_degustacion_update
        ON public.surveys
        AS RESTRICTIVE
        FOR UPDATE
        TO anon, authenticated
        USING (
          type IS DISTINCT FROM 'Degustacion'
          OR COALESCE(fecha_evento, public.fn_parse_degustacion_fecha(date, comments)) >= public.fn_inicio_semana_caracas()
          OR (SELECT private.is_strict_admin())
        )
        WITH CHECK (
          type IS DISTINCT FROM 'Degustacion'
          OR COALESCE(fecha_evento, public.fn_parse_degustacion_fecha(date, comments)) >= public.fn_inicio_semana_caracas()
          OR (SELECT private.is_strict_admin())
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'surveys'
        AND policyname = 'surveys_restrict_historical_degustacion_delete'
    ) THEN
      CREATE POLICY surveys_restrict_historical_degustacion_delete
        ON public.surveys
        AS RESTRICTIVE
        FOR DELETE
        TO anon, authenticated
        USING (
          type IS DISTINCT FROM 'Degustacion'
          OR COALESCE(fecha_evento, public.fn_parse_degustacion_fecha(date, comments)) >= public.fn_inicio_semana_caracas()
          OR (SELECT private.is_strict_admin())
        );
    END IF;
  END IF;
END $$;

-- 3.B. Políticas RLS `AS RESTRICTIVE` en `public.cronograma_degustaciones`
DO $$
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'cronograma_degustaciones'
        AND policyname = 'cronograma_restrict_historical_update'
    ) THEN
      CREATE POLICY cronograma_restrict_historical_update
        ON public.cronograma_degustaciones
        AS RESTRICTIVE
        FOR UPDATE
        TO authenticated
        USING (
          fecha >= public.fn_inicio_semana_caracas()
          OR (SELECT private.is_strict_admin())
        )
        WITH CHECK (
          fecha >= public.fn_inicio_semana_caracas()
          OR (SELECT private.is_strict_admin())
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'cronograma_degustaciones'
        AND policyname = 'cronograma_restrict_historical_delete'
    ) THEN
      CREATE POLICY cronograma_restrict_historical_delete
        ON public.cronograma_degustaciones
        AS RESTRICTIVE
        FOR DELETE
        TO authenticated
        USING (
          fecha >= public.fn_inicio_semana_caracas()
          OR (SELECT private.is_strict_admin())
        );
    END IF;
  END IF;
END $$;

-- =============================================================================
-- 4. DEFENSA EN PROFUNDIDAD: TRIGGER DE INMUTABILIDAD HISTÓRICA (SEMANAS CERRADAS)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_guard_historical_degustacion_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inicio_semana DATE := public.fn_inicio_semana_caracas();
  v_old_fecha DATE := NULL;
  v_new_fecha DATE := NULL;
  v_is_privileged_system BOOLEAN := (
    (SELECT auth.uid()) IS NULL
    AND current_user IN ('postgres', 'service_role', 'supabase_admin')
  );
BEGIN
  IF v_is_privileged_system OR (SELECT private.is_strict_admin()) THEN
    IF TG_OP = 'UPDATE' THEN
      RETURN NEW;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'surveys' THEN
    IF COALESCE(OLD.type, '') <> 'Degustacion'
       AND (TG_OP <> 'UPDATE' OR COALESCE(NEW.type, '') <> 'Degustacion') THEN
      IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
      END IF;
      RETURN OLD;
    END IF;

    v_old_fecha := COALESCE(
      OLD.fecha_evento,
      public.fn_parse_degustacion_fecha(OLD.date, OLD.comments),
      (pg_catalog.timezone('America/Caracas', COALESCE(OLD.created_at, NOW())))::date
    );

    IF TG_OP = 'UPDATE' THEN
      v_new_fecha := COALESCE(
        NEW.fecha_evento,
        public.fn_parse_degustacion_fecha(NEW.date, NEW.comments),
        v_old_fecha
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'cronograma_degustaciones' THEN
    v_old_fecha := OLD.fecha;
    IF TG_OP = 'UPDATE' THEN
      v_new_fecha := NEW.fecha;
    END IF;
  END IF;

  IF v_old_fecha IS NOT NULL AND v_old_fecha < v_inicio_semana THEN
    RAISE EXCEPTION 'REGISTRO HISTÓRICO CERRADO: Solo un Administrador puede modificar o eliminar degustaciones de semanas anteriores (% < %).',
      v_old_fecha, v_inicio_semana
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND v_new_fecha IS NOT NULL AND v_new_fecha < v_inicio_semana THEN
    RAISE EXCEPTION 'REGISTRO HISTÓRICO CERRADO: No se permite retrotraer degustaciones hacia una semana anterior cerrada (% < %).',
      v_new_fecha, v_inicio_semana
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_guard_historical_surveys_degustacion'
      AND tgrelid = 'public.surveys'::regclass
  ) THEN
    CREATE TRIGGER trg_guard_historical_surveys_degustacion
      BEFORE UPDATE OR DELETE
      ON public.surveys
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_guard_historical_degustacion_immutability();
  END IF;

  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_trigger
       WHERE tgname = 'trg_guard_historical_cronograma_degustacion'
         AND tgrelid = 'public.cronograma_degustaciones'::regclass
     ) THEN
    CREATE TRIGGER trg_guard_historical_cronograma_degustacion
      BEFORE UPDATE OR DELETE
      ON public.cronograma_degustaciones
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_guard_historical_degustacion_immutability();
  END IF;
END $$;

-- =============================================================================
-- 5. ALINEACIÓN OPCIONAL DE `pg_cron` AL CORTE ISO LUNES 00:00 `America/Caracas`
--    (`0 4 * * 1` UTC = Lunes 00:00:00 America/Caracas)
-- =============================================================================
DO $$
DECLARE
  v_job RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN (
        'cierre-dominical-degustaciones-9pm-ve',
        'cierre-semanal-iso-degustaciones-caracas'
      )
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    IF to_regprocedure('public.ejecutar_cierre_semanal_degustaciones(timestamptz,boolean)') IS NOT NULL THEN
      PERFORM cron.schedule(
        'cierre-semanal-iso-degustaciones-caracas',
        '0 4 * * 1',
        $cron$SELECT public.ejecutar_cierre_semanal_degustaciones(NOW(), TRUE);$cron$
      );
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no habilitado en este entorno; la separación semanal opera en tiempo real mediante fecha_evento y fn_inicio_semana_caracas().';
END $$;

COMMIT;
