-- =============================================================================
-- CODIZULCA C.A. - FASE 1: ARCHIVADO LÓGICO NO DESTRUCTIVO Y CORTE INICIAL
-- Módulo: Degustaciones (Pestañas "Degustaciones" <-> "Historial")
--
-- Reglas Estrictas de Gobernanza y Seguridad:
--   1. PROHIBIDO ejecutar DELETE, TRUNCATE o DROP sobre registros de degustaciones.
--   2. Archivado 100% lógico mediante `en_historial`, `archivado_en`, `motivo_archivo`,
--      preservando intactos estados operativos, insumos, clientes, rutas y relaciones.
--   3. Trazabilidad y reversibilidad transaccional mediante `public.historial_cortes_degustaciones`.
--   4. Respeto estricto de políticas RLS Zero Trust (`TO authenticated` + `app_metadata`).
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. COLUMNAS ADITIVAS DE ARCHIVADO LÓGICO EN AMBAS TABLAS DE DEGUSTACIONES
-- =============================================================================
ALTER TABLE IF EXISTS public.surveys
  ADD COLUMN IF NOT EXISTS en_historial BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archivado_en TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motivo_archivo VARCHAR(64) DEFAULT NULL;

ALTER TABLE IF EXISTS public.cronograma_degustaciones
  ADD COLUMN IF NOT EXISTS en_historial BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archivado_en TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motivo_archivo VARCHAR(64) DEFAULT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_surveys_motivo_archivo_nonempty'
      AND conrelid = 'public.surveys'::regclass
  ) THEN
    ALTER TABLE public.surveys
      ADD CONSTRAINT chk_surveys_motivo_archivo_nonempty
      CHECK (motivo_archivo IS NULL OR btrim(motivo_archivo) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_cronograma_deg_motivo_archivo_nonempty'
      AND conrelid = 'public.cronograma_degustaciones'::regclass
  ) THEN
    ALTER TABLE public.cronograma_degustaciones
      ADD CONSTRAINT chk_cronograma_deg_motivo_archivo_nonempty
      CHECK (motivo_archivo IS NULL OR btrim(motivo_archivo) <> '');
  END IF;
END $$;

-- Sincronización automática si existiera espejo previo en JSON `comments`
UPDATE public.surveys
SET
  en_historial = TRUE,
  archivado_en = COALESCE(
    archivado_en,
    CASE
      WHEN comments IS NOT NULL
           AND btrim(comments::text) LIKE '{%'
           AND ((comments::jsonb) ->> 'archivado_en') ~ '^\d{4}-\d{2}-\d{2}T'
      THEN ((comments::jsonb) ->> 'archivado_en')::timestamptz
      ELSE NOW()
    END
  ),
  motivo_archivo = COALESCE(
    NULLIF(btrim(motivo_archivo), ''),
    CASE
      WHEN comments IS NOT NULL AND btrim(comments::text) LIKE '{%'
      THEN NULLIF(btrim((comments::jsonb) ->> 'motivo_archivo'), '')
      ELSE NULL
    END,
    'CORTE_INICIAL'
  )
WHERE type = 'Degustacion'
  AND en_historial = FALSE
  AND comments IS NOT NULL
  AND btrim(comments::text) LIKE '{%'
  AND COALESCE(((comments::jsonb) ->> 'en_historial')::boolean, FALSE) = TRUE;

-- =============================================================================
-- 2. ÍNDICES COMPUESTOS Y PARCIALES (NOMBRES REALES DE FECHA: `date` y `fecha`)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_surveys_degustacion_historial_date
  ON public.surveys (en_historial, date DESC, created_at DESC)
  WHERE type = 'Degustacion';

CREATE INDEX IF NOT EXISTS idx_surveys_degustacion_activas_date
  ON public.surveys (date ASC, created_at ASC)
  WHERE type = 'Degustacion' AND en_historial = FALSE;

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_historial_fecha
  ON public.cronograma_degustaciones (en_historial, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_activas_fecha
  ON public.cronograma_degustaciones (fecha ASC, hora_inicio ASC)
  WHERE en_historial = FALSE AND estado NOT IN ('RECHAZADA', 'CANCELADA');

-- =============================================================================
-- 3. PROTECCIÓN ANTI-DESARCHIVADO ACCIDENTAL EN RE-SINCRONIZACIONES EXTERNAS
-- =============================================================================
CREATE OR REPLACE FUNCTION public.preserve_surveys_leido_trade()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.leido_trade IS TRUE THEN
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

  -- Preservar archivado lógico si una actualización externa de `comments` omite `en_historial`
  IF OLD.en_historial IS TRUE THEN
    IF NEW.en_historial IS DISTINCT FROM FALSE
       OR (
         NEW.comments IS NOT NULL
         AND NEW.comments NOT LIKE '%"en_historial":false%'
         AND NEW.comments NOT LIKE '%"en_historial": false%'
         AND NEW.motivo_archivo IS NOT NULL
       ) THEN
      NEW.en_historial := TRUE;
      NEW.archivado_en := COALESCE(NEW.archivado_en, OLD.archivado_en, NOW());
      NEW.motivo_archivo := COALESCE(NEW.motivo_archivo, OLD.motivo_archivo, 'CORTE_INICIAL');
    END IF;
  END IF;

  IF NEW.en_historial IS TRUE AND NEW.archivado_en IS NULL THEN
    NEW.archivado_en := NOW();
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 4. TABLA DE AUDITORÍA Y REVERSIÓN TRANSACCIONAL DE CORTES (`CORTE_INICIAL`)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.historial_cortes_degustaciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  motivo_archivo VARCHAR(64) NOT NULL,
  surveys_afectados UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  cronograma_afectados UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  total_surveys INTEGER NOT NULL DEFAULT 0 CHECK (total_surveys >= 0),
  total_cronograma INTEGER NOT NULL DEFAULT 0 CHECK (total_cronograma >= 0),
  ejecutado_por TEXT NOT NULL DEFAULT 'sistema',
  ejecutado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revertido_en TIMESTAMPTZ DEFAULT NULL,
  revertido_por TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_historial_cortes_deg_motivo
  ON public.historial_cortes_degustaciones (motivo_archivo, ejecutado_en DESC);

REVOKE ALL ON TABLE public.historial_cortes_degustaciones FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.historial_cortes_degustaciones TO authenticated;

ALTER TABLE public.historial_cortes_degustaciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS historial_cortes_deg_select_coord_admin ON public.historial_cortes_degustaciones;
DROP POLICY IF EXISTS historial_cortes_deg_insert_coord_admin ON public.historial_cortes_degustaciones;
DROP POLICY IF EXISTS historial_cortes_deg_update_coord_admin ON public.historial_cortes_degustaciones;

CREATE POLICY historial_cortes_deg_select_coord_admin
  ON public.historial_cortes_degustaciones
  FOR SELECT
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY historial_cortes_deg_insert_coord_admin
  ON public.historial_cortes_degustaciones
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY historial_cortes_deg_update_coord_admin
  ON public.historial_cortes_degustaciones
  FOR UPDATE
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()))
  WITH CHECK ((SELECT private.is_coordinator_or_admin()));

-- =============================================================================
-- 5. RPC TRANSACCIONAL DE CORTE INICIAL CON MODO `p_dry_run` Y REVERSIÓN SEGURA
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ejecutar_corte_historial_degustaciones(
  p_motivo TEXT DEFAULT 'CORTE_INICIAL',
  p_dry_run BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_motivo VARCHAR(64) := COALESCE(NULLIF(btrim(p_motivo), ''), 'CORTE_INICIAL')::varchar(64);
  v_now TIMESTAMPTZ := NOW();
  v_survey_ids UUID[] := ARRAY[]::UUID[];
  v_cronograma_ids UUID[] := ARRAY[]::UUID[];
  v_lote_id UUID := NULL;
  v_actor TEXT;
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
     AND NOT (SELECT private.is_coordinator_or_admin()) THEN
    RAISE EXCEPTION 'ACCESO DENEGADO: Solo Coordinación, Administración o proceso autorizado pueden ejecutar cortes de historial.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('corte_historial:' || v_motivo, 20261112));

  SELECT COALESCE(array_agg(s.id), ARRAY[]::UUID[])
  INTO v_survey_ids
  FROM public.surveys s
  WHERE s.type = 'Degustacion'
    AND s.en_historial = FALSE;

  SELECT COALESCE(array_agg(c.id), ARRAY[]::UUID[])
  INTO v_cronograma_ids
  FROM public.cronograma_degustaciones c
  WHERE c.en_historial = FALSE;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'dry_run', TRUE,
      'motivo_archivo', v_motivo,
      'surveys_candidatas', COALESCE(array_length(v_survey_ids, 1), 0),
      'cronograma_candidatas', COALESCE(array_length(v_cronograma_ids, 1), 0),
      'total_candidatas', COALESCE(array_length(v_survey_ids, 1), 0) + COALESCE(array_length(v_cronograma_ids, 1), 0)
    );
  END IF;

  IF COALESCE(array_length(v_survey_ids, 1), 0) = 0
     AND COALESCE(array_length(v_cronograma_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'dry_run', FALSE,
      'idempotent_noop', TRUE,
      'motivo_archivo', v_motivo,
      'surveys_archivadas', 0,
      'cronograma_archivadas', 0,
      'total_archivadas', 0
    );
  END IF;

  IF COALESCE(array_length(v_survey_ids, 1), 0) > 0 THEN
    UPDATE public.surveys s
    SET
      en_historial = TRUE,
      archivado_en = v_now,
      motivo_archivo = v_motivo,
      leido_trade = TRUE,
      visto_en_trade_at = COALESCE(s.visto_en_trade_at, v_now),
      comments = CASE
        WHEN s.comments IS NOT NULL AND btrim(s.comments::text) LIKE '{%' THEN
          (
            (s.comments::jsonb) || jsonb_build_object(
              'en_historial', TRUE,
              'archivado_en', v_now,
              'motivo_archivo', v_motivo
            )
          )::text
        ELSE s.comments
      END
    WHERE s.id = ANY(v_survey_ids)
      AND s.en_historial = FALSE;
  END IF;

  IF COALESCE(array_length(v_cronograma_ids, 1), 0) > 0 THEN
    UPDATE public.cronograma_degustaciones c
    SET
      en_historial = TRUE,
      archivado_en = v_now,
      motivo_archivo = v_motivo
    WHERE c.id = ANY(v_cronograma_ids)
      AND c.en_historial = FALSE;
  END IF;

  v_actor := COALESCE(
    NULLIF(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')), ''),
    current_user
  );

  INSERT INTO public.historial_cortes_degustaciones (
    motivo_archivo,
    surveys_afectados,
    cronograma_afectados,
    total_surveys,
    total_cronograma,
    ejecutado_por,
    ejecutado_en
  ) VALUES (
    v_motivo,
    v_survey_ids,
    v_cronograma_ids,
    COALESCE(array_length(v_survey_ids, 1), 0),
    COALESCE(array_length(v_cronograma_ids, 1), 0),
    v_actor,
    v_now
  )
  RETURNING id INTO v_lote_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'dry_run', FALSE,
    'lote_id', v_lote_id,
    'motivo_archivo', v_motivo,
    'archivado_en', v_now,
    'surveys_archivadas', COALESCE(array_length(v_survey_ids, 1), 0),
    'cronograma_archivadas', COALESCE(array_length(v_cronograma_ids, 1), 0),
    'total_archivadas', COALESCE(array_length(v_survey_ids, 1), 0) + COALESCE(array_length(v_cronograma_ids, 1), 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revertir_corte_historial_degustaciones(
  p_lote_id UUID DEFAULT NULL,
  p_motivo TEXT DEFAULT 'CORTE_INICIAL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_lote public.historial_cortes_degustaciones;
  v_surveys_rev INTEGER := 0;
  v_cronograma_rev INTEGER := 0;
  v_actor TEXT;
BEGIN
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
     AND NOT (SELECT private.is_coordinator_or_admin()) THEN
    RAISE EXCEPTION 'ACCESO DENEGADO: Solo Coordinación, Administración o proceso autorizado pueden revertir un corte.'
      USING ERRCODE = '42501';
  END IF;

  IF p_lote_id IS NOT NULL THEN
    SELECT *
    INTO v_lote
    FROM public.historial_cortes_degustaciones
    WHERE id = p_lote_id
      AND revertido_en IS NULL
    LIMIT 1;
  ELSE
    SELECT *
    INTO v_lote
    FROM public.historial_cortes_degustaciones
    WHERE motivo_archivo = COALESCE(NULLIF(btrim(p_motivo), ''), 'CORTE_INICIAL')
      AND revertido_en IS NULL
    ORDER BY ejecutado_en DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'idempotent_noop', TRUE,
      'surveys_revertidas', 0,
      'cronograma_revertidas', 0
    );
  END IF;

  IF COALESCE(array_length(v_lote.surveys_afectados, 1), 0) > 0 THEN
    UPDATE public.surveys s
    SET
      en_historial = FALSE,
      archivado_en = NULL,
      motivo_archivo = NULL,
      comments = CASE
        WHEN s.comments IS NOT NULL AND btrim(s.comments::text) LIKE '{%' THEN
          (
            ((s.comments::jsonb) - 'archivado_en' - 'motivo_archivo')
            || jsonb_build_object('en_historial', FALSE)
          )::text
        ELSE s.comments
      END
    WHERE s.id = ANY(v_lote.surveys_afectados)
      AND s.motivo_archivo = v_lote.motivo_archivo;

    GET DIAGNOSTICS v_surveys_rev = ROW_COUNT;
  END IF;

  IF COALESCE(array_length(v_lote.cronograma_afectados, 1), 0) > 0 THEN
    UPDATE public.cronograma_degustaciones c
    SET
      en_historial = FALSE,
      archivado_en = NULL,
      motivo_archivo = NULL
    WHERE c.id = ANY(v_lote.cronograma_afectados)
      AND c.motivo_archivo = v_lote.motivo_archivo;

    GET DIAGNOSTICS v_cronograma_rev = ROW_COUNT;
  END IF;

  v_actor := COALESCE(
    NULLIF(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')), ''),
    current_user
  );

  UPDATE public.historial_cortes_degustaciones
  SET
    revertido_en = NOW(),
    revertido_por = v_actor
  WHERE id = v_lote.id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'lote_id', v_lote.id,
    'surveys_revertidas', v_surveys_rev,
    'cronograma_revertidas', v_cronograma_rev
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ejecutar_corte_historial_degustaciones(TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revertir_corte_historial_degustaciones(UUID, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.ejecutar_corte_historial_degustaciones(TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revertir_corte_historial_degustaciones(UUID, TEXT) TO authenticated, service_role;

COMMIT;
