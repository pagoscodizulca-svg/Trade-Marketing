-- =============================================================================
-- CODIZULCA C.A. - FASE 2: CIERRE AUTOMÁTICO DOMINICAL 9:00 PM (AMERICA/CARACAS)
-- Módulo: Degustaciones -> Pase Automático e Idempotente a "Historial"
--
-- Conversión Matemática de Zona Horaria para `pg_cron`:
--   - Zona horaria de negocio: `America/Caracas` (UTC-04:00 fijo todo el año).
--   - Domingo 21:00:00 America/Caracas == Lunes 01:00:00 UTC.
--   - Expresión cron en UTC: `0 1 * * 1` (minuto 0, hora 01 UTC, día 1 = Lunes UTC).
--   - Al ejecutarse a las 01:00 UTC del lunes, `(NOW() AT TIME ZONE 'America/Caracas')::date`
--     evalúa exactamente al DOMINGO que cierra a las 21:00 hora local.
--
-- Garantías de Seguridad y Confiabilidad (SRE / Zero Trust):
--   1. `SET search_path = public` explícito en funciones SQL.
--   2. `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated` (inaccesible desde cliente).
--   3. Cero sentencias destructivas (prohibido borrar registros de degustaciones).
--   4. Bitácora `public.cierres_semanales_log` libre de PII e idempotente por `fecha_corte`.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. BITÁCORA DE AUDITORÍA `public.cierres_semanales_log` (SIN PII E IDEMPOTENTE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.cierres_semanales_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ejecutado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_corte DATE NOT NULL,
  registros_archivados INTEGER NOT NULL DEFAULT 0 CHECK (registros_archivados >= 0),
  estado TEXT NOT NULL CHECK (estado IN ('OK', 'ERROR')),
  detalle_diagnostico JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_cierres_semanales_log_ejecutado_en
  ON public.cierres_semanales_log (ejecutado_en DESC);

-- Garantiza idempotencia de auditoría: máximo 1 registro 'OK' por domingo de corte
CREATE UNIQUE INDEX IF NOT EXISTS uq_cierres_semanales_log_fecha_corte_ok
  ON public.cierres_semanales_log (fecha_corte)
  WHERE estado = 'OK';

REVOKE ALL ON TABLE public.cierres_semanales_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cierres_semanales_log TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cierres_semanales_log TO service_role;

ALTER TABLE public.cierres_semanales_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cierres_semanales_log_select_coord_admin ON public.cierres_semanales_log;

CREATE POLICY cierres_semanales_log_select_coord_admin
  ON public.cierres_semanales_log
  FOR SELECT
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

-- =============================================================================
-- 2. PARSER SEGURO `IMMUTABLE` DE FECHA DE EVENTO PARA `public.surveys`
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_parse_degustacion_fecha(
  p_raw_date TEXT,
  p_comments TEXT DEFAULT NULL
)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_candidate TEXT := btrim(COALESCE(p_raw_date, ''));
  v_json JSONB;
BEGIN
  IF v_candidate = '' AND p_comments IS NOT NULL AND btrim(p_comments) LIKE '{%' THEN
    BEGIN
      v_json := p_comments::jsonb;
      v_candidate := btrim(COALESCE(v_json ->> 'date', v_json ->> 'fecha', ''));
    EXCEPTION WHEN OTHERS THEN
      v_candidate := '';
    END;
  END IF;

  IF v_candidate ~ '^\d{4}-\d{2}-\d{2}' THEN
    BEGIN
      RETURN substring(v_candidate FROM 1 FOR 10)::date;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END IF;

  IF v_candidate ~ '^\d{2}[/-]\d{2}[/-]\d{4}$' THEN
    BEGIN
      RETURN to_date(replace(v_candidate, '/', '-'), 'DD-MM-YYYY');
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_parse_degustacion_fecha(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_parse_degustacion_fecha(TEXT, TEXT) TO anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_surveys_degustacion_parsed_fecha_activas
  ON public.surveys (en_historial, public.fn_parse_degustacion_fecha(date, comments))
  WHERE type = 'Degustacion' AND en_historial = FALSE;

-- =============================================================================
-- 3. FUNCIÓN ATÓMICA E IDEMPOTENTE DE CIERRE DOMINICAL 9:00 PM
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ejecutar_cierre_dominical_degustaciones(
  p_now TIMESTAMPTZ DEFAULT NOW(),
  p_timezone TEXT DEFAULT 'America/Caracas',
  p_force_run BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz TEXT := COALESCE(NULLIF(btrim(p_timezone), ''), 'America/Caracas');
  v_effective_now TIMESTAMPTZ := COALESCE(p_now, NOW());
  v_local_ts TIMESTAMP;
  v_isodow INTEGER;
  v_local_hour INTEGER;
  v_fecha_corte_domingo DATE;
  v_existing_log_id UUID := NULL;
  v_surveys_archived INTEGER := 0;
  v_cronograma_archived INTEGER := 0;
  v_total_archived INTEGER := 0;
  v_log_id UUID := NULL;
  v_diag JSONB;
BEGIN
  -- Validar que la zona horaria exista en el catálogo de PostgreSQL
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_tz
  ) THEN
    v_tz := 'America/Caracas';
  END IF;

  v_local_ts := v_effective_now AT TIME ZONE v_tz;
  v_isodow := EXTRACT(ISODOW FROM v_local_ts)::integer; -- 1=Lunes .. 7=Domingo
  v_local_hour := EXTRACT(HOUR FROM v_local_ts)::integer;

  -- En disparo automático normal (`p_force_run = FALSE`), verificar que en `America/Caracas`
  -- sea efectivamente domingo >= 21:00. Si se invoca con `p_force_run = TRUE` en recuperación
  -- manual, calcular el domingo de cierre correspondiente sin archivar jamás la semana entrante.
  IF NOT p_force_run THEN
    IF v_isodow <> 7 OR v_local_hour < 21 THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'skipped_outside_window', TRUE,
        'timezone', v_tz,
        'local_timestamp', to_char(v_local_ts, 'YYYY-MM-DD HH24:MI:SS'),
        'registros_archivados', 0
      );
    END IF;
    v_fecha_corte_domingo := v_local_ts::date;
  ELSE
    IF v_isodow = 7 THEN
      v_fecha_corte_domingo := v_local_ts::date;
    ELSE
      -- Si un operador fuerza recuperación el lunes/martes, el corte corresponde al domingo inmediato anterior
      v_fecha_corte_domingo := (v_local_ts::date - v_isodow);
    END IF;
  END IF;

  -- Candado transaccional exclusivo por fecha de corte dominical
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cierre_dominical_9pm:' || v_fecha_corte_domingo::text, 20261115)
  );

  SELECT l.id
  INTO v_existing_log_id
  FROM public.cierres_semanales_log l
  WHERE l.fecha_corte = v_fecha_corte_domingo
    AND l.estado = 'OK'
  LIMIT 1;

  -- 3.A. Archivar degustaciones en `public.surveys` cuya fecha de evento <= fecha_corte_domingo
  --      PROTECCIÓN DE SEMANA EN CURSO: `fecha_evento > v_fecha_corte_domingo` permanece en `en_historial = FALSE`
  UPDATE public.surveys s
  SET
    en_historial = TRUE,
    archivado_en = v_effective_now,
    motivo_archivo = 'CIERRE_DOMINGO_9PM',
    leido_trade = TRUE,
    visto_en_trade_at = COALESCE(s.visto_en_trade_at, v_effective_now),
    comments = CASE
      WHEN s.comments IS NOT NULL AND btrim(s.comments::text) LIKE '{%' THEN
        (
          (s.comments::jsonb) || jsonb_build_object(
            'en_historial', TRUE,
            'archivado_en', v_effective_now,
            'motivo_archivo', 'CIERRE_DOMINGO_9PM'
          )
        )::text
      ELSE s.comments
    END
  WHERE s.type = 'Degustacion'
    AND s.en_historial = FALSE
    AND public.fn_parse_degustacion_fecha(s.date, s.comments) IS NOT NULL
    AND public.fn_parse_degustacion_fecha(s.date, s.comments) <= v_fecha_corte_domingo;

  GET DIAGNOSTICS v_surveys_archived = ROW_COUNT;

  -- 3.B. Archivar filas en `public.cronograma_degustaciones` cuya `fecha <= v_fecha_corte_domingo`
  --      preservando intacto su `estado` operativo y excluyendo `fecha > v_fecha_corte_domingo`
  UPDATE public.cronograma_degustaciones c
  SET
    en_historial = TRUE,
    archivado_en = v_effective_now,
    motivo_archivo = 'CIERRE_DOMINGO_9PM'
  WHERE c.en_historial = FALSE
    AND c.fecha <= v_fecha_corte_domingo;

  GET DIAGNOSTICS v_cronograma_archived = ROW_COUNT;

  v_total_archived := v_surveys_archived + v_cronograma_archived;

  -- 3.C. Registro idempotente en `public.cierres_semanales_log` (CERO PII, CERO DUPLICADOS)
  IF v_existing_log_id IS NOT NULL AND v_total_archived = 0 THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'estado', 'OK',
      'idempotent_noop', TRUE,
      'log_id', v_existing_log_id,
      'fecha_corte', v_fecha_corte_domingo,
      'registros_archivados', 0,
      'surveys_archivadas', 0,
      'cronograma_archivadas', 0,
      'timezone', v_tz
    );
  END IF;

  v_diag := jsonb_build_object(
    'zona_horaria', v_tz,
    'hora_local_ejecucion', to_char(v_local_ts, 'YYYY-MM-DD HH24:MI:SS'),
    'motivo_archivo', 'CIERRE_DOMINGO_9PM',
    'surveys_archivadas', v_surveys_archived,
    'cronograma_archivadas', v_cronograma_archived,
    'modo_forzado', p_force_run
  );

  IF v_existing_log_id IS NOT NULL THEN
    UPDATE public.cierres_semanales_log
    SET
      ejecutado_en = v_effective_now,
      registros_archivados = registros_archivados + v_total_archived,
      detalle_diagnostico = detalle_diagnostico || jsonb_build_object(
        'ultima_actualizacion_idempotente', v_effective_now,
        'adicionales_archivados', v_total_archived
      )
    WHERE id = v_existing_log_id
    RETURNING id INTO v_log_id;
  ELSE
    INSERT INTO public.cierres_semanales_log (
      ejecutado_en,
      fecha_corte,
      registros_archivados,
      estado,
      detalle_diagnostico
    ) VALUES (
      v_effective_now,
      v_fecha_corte_domingo,
      v_total_archived,
      'OK',
      v_diag
    )
    RETURNING id INTO v_log_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'estado', 'OK',
    'idempotent_noop', FALSE,
    'log_id', v_log_id,
    'fecha_corte', v_fecha_corte_domingo,
    'registros_archivados', v_total_archived,
    'surveys_archivadas', v_surveys_archived,
    'cronograma_archivadas', v_cronograma_archived,
    'timezone', v_tz
  );
EXCEPTION WHEN OTHERS THEN
  v_fecha_corte_domingo := COALESCE(
    v_fecha_corte_domingo,
    (COALESCE(p_now, NOW()) AT TIME ZONE 'America/Caracas')::date
  );

  INSERT INTO public.cierres_semanales_log (
    ejecutado_en,
    fecha_corte,
    registros_archivados,
    estado,
    detalle_diagnostico
  ) VALUES (
    COALESCE(p_now, NOW()),
    v_fecha_corte_domingo,
    0,
    'ERROR',
    jsonb_build_object(
      'sqlstate', SQLSTATE,
      'codigo_diagnostico', 'ERR_CIERRE_DOMINICAL_9PM'
    )
  )
  RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'ok', FALSE,
    'estado', 'ERROR',
    'log_id', v_log_id,
    'fecha_corte', v_fecha_corte_domingo,
    'registros_archivados', 0,
    'error_code', SQLSTATE
  );
END;
$$;

-- Gobernanza estricta: ningún cliente público ni usuario autenticado de navegador puede invocar el cron SQL
REVOKE ALL ON FUNCTION public.ejecutar_cierre_dominical_degustaciones(TIMESTAMPTZ, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ejecutar_cierre_dominical_degustaciones(TIMESTAMPTZ, TEXT, BOOLEAN)
  TO postgres, service_role;

-- =============================================================================
-- 4. PROGRAMACIÓN IDEMPOTENTE EN `pg_cron` (0 1 * * 1 UTC == DOMINGOS 21:00 VE)
-- =============================================================================
DO $$
DECLARE
  v_existing_jobid BIGINT;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Extensión pg_cron no disponible o requiere rol superusuario en este entorno (%). Puede activarse desde Dashboard -> Database -> Extensions.', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    FOR v_existing_jobid IN
      SELECT jobid
      FROM cron.job
      WHERE jobname = 'cierre-dominical-degustaciones-9pm-ve'
    LOOP
      PERFORM cron.unschedule(v_existing_jobid);
    END LOOP;

    -- `0 1 * * 1` en UTC = Lunes 01:00 UTC = Domingo 21:00 America/Caracas (UTC-04:00)
    PERFORM cron.schedule(
      'cierre-dominical-degustaciones-9pm-ve',
      '0 1 * * 1',
      $cron$SELECT public.ejecutar_cierre_dominical_degustaciones(NOW(), 'America/Caracas', FALSE);$cron$
    );
  END IF;
END $$;

COMMIT;
