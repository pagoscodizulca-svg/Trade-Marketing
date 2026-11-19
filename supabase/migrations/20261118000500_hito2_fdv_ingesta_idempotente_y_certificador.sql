-- =============================================================================
-- HITO 2 — INGESTA FDV IDEMPOTENTE (SURVEYS) Y CERTIFICADOR DE ESQUEMA SOLO LECTURA
-- Archivo: supabase/migrations/20261118000500_hito2_fdv_ingesta_idempotente_y_certificador.sql
--
-- Cierra:
--   N-07 / FINDING-IDEMPOTENCY-SURVEYS-01
--     Cierra la condición de carrera ante doble envío paralelo (`Promise.all`) en
--     `public.surveys` mediante `degustacion_key` normalizada por trigger y un
--     índice UNIQUE parcial sobre solicitudes activas de degustación.
--   B-04 (Canal seguro de certificación remota)
--     Expone `public.rpc_certificar_esquema_trade()`, función estrictamente de
--     SOLO LECTURA sobre `pg_catalog` (cero datos de negocio), restringida a
--     `super_admin` o `service_role`.
--
-- Reglas de integridad:
--   * Forward-only e idempotente. Sin comandos destructivos sobre tablas ni datos.
--   * Depende de `20261118000400_hito1_identidad_unica_y_aislamiento_sucursales.sql`.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. CLAVE CANÓNICA DE IDEMPOTENCIA EN `public.surveys`
-- =============================================================================
ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS degustacion_key TEXT;

COMMENT ON COLUMN public.surveys.degustacion_key IS
  'Clave canónica normalizada del degustacionId para garantizar idempotencia atómica ante reintentos paralelos en solicitudes activas.';

CREATE OR REPLACE FUNCTION public.fn_extraer_degustacion_key(
  p_type TEXT,
  p_comments TEXT,
  p_explicit_key TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_raw TEXT;
  v_json JSONB;
  v_clean TEXT;
BEGIN
  IF btrim(COALESCE(p_type, '')) <> 'Degustacion' THEN
    RETURN NULL;
  END IF;

  v_raw := NULLIF(btrim(COALESCE(p_explicit_key, '')), '');

  IF v_raw IS NULL AND btrim(COALESCE(p_comments, '')) LIKE '{%' THEN
    BEGIN
      v_json := p_comments::jsonb;
      v_raw := COALESCE(
        NULLIF(btrim(COALESCE(v_json ->> 'degustacionId', '')), ''),
        NULLIF(btrim(COALESCE(v_json ->> 'id', '')), '')
      );
    EXCEPTION
      WHEN OTHERS THEN
        v_raw := NULL;
    END;
  END IF;

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  v_clean := lower(btrim(regexp_replace(v_raw, '^deg-', '', 'i')));
  IF v_clean = '' THEN
    RETURN NULL;
  END IF;

  RETURN left(v_clean, 128);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_extraer_degustacion_key(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_extraer_degustacion_key(TEXT, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_surveys_normalizar_degustacion_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.degustacion_key := public.fn_extraer_degustacion_key(
    NEW.type,
    NEW.comments,
    NEW.degustacion_key
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_surveys_normalizar_degustacion_key() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_surveys_normalizar_degustacion_key() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_surveys_normalizar_degustacion_key ON public.surveys;
CREATE TRIGGER trg_surveys_normalizar_degustacion_key
  BEFORE INSERT OR UPDATE ON public.surveys
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_surveys_normalizar_degustacion_key();

-- =============================================================================
-- 2. BACKFILL SEGURO ANTE DUPLICADOS HISTÓRICOS + ÍNDICE UNIQUE PARCIAL
-- =============================================================================
DO $$
DECLARE
  v_assigned BIGINT := 0;
  v_skipped_dups BIGINT := 0;
BEGIN
  IF to_regclass('public.surveys') IS NULL THEN
    RETURN;
  END IF;

  WITH candidatos AS (
    SELECT
      id,
      public.fn_extraer_degustacion_key(type, comments, degustacion_key) AS computed_key,
      ROW_NUMBER() OVER (
        PARTITION BY public.fn_extraer_degustacion_key(type, comments, degustacion_key)
        ORDER BY created_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM public.surveys
    WHERE type = 'Degustacion'
      AND COALESCE(en_historial, false) = false
      AND public.fn_extraer_degustacion_key(type, comments, degustacion_key) IS NOT NULL
  ),
  marcados AS (
    UPDATE public.surveys s
    SET degustacion_key = CASE WHEN c.rn = 1 THEN c.computed_key ELSE NULL END
    FROM candidatos c
    WHERE s.id = c.id
      AND s.degustacion_key IS DISTINCT FROM (CASE WHEN c.rn = 1 THEN c.computed_key ELSE NULL END)
    RETURNING c.rn
  )
  SELECT
    COUNT(*) FILTER (WHERE rn = 1),
    COUNT(*) FILTER (WHERE rn > 1)
  INTO v_assigned, v_skipped_dups
  FROM marcados;

  IF v_skipped_dups > 0 THEN
    RAISE NOTICE '[HITO 2] Backfill surveys.degustacion_key: % asignados, % duplicados históricos conservados sin clave única para no borrar registros.',
      v_assigned, v_skipped_dups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_surveys_degustacion_key_active
  ON public.surveys (degustacion_key)
  WHERE type = 'Degustacion'
    AND degustacion_key IS NOT NULL
    AND COALESCE(en_historial, false) = false;

-- =============================================================================
-- 3. RPC DE CERTIFICACIÓN DE ESQUEMA (SOLO LECTURA SOBRE `pg_catalog`)
--    Restringida exclusivamente a `super_admin` o `service_role`.
--    Jamás consulta ni expone registros operativos ni datos personales.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_certificar_esquema_trade()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE((SELECT auth.jwt() ->> 'role'), '');
  v_is_authorized BOOLEAN := false;
  v_expected_tables CONSTANT TEXT[] := ARRAY[
    'profiles',
    'clientes',
    'vendedores',
    'promotoras',
    'reportes_trade',
    'staff',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'asistencias_jornada',
    'asistencia_evidencias',
    'solicitudes_contraloria',
    'entregas_degustacion'
  ];
  v_tbl TEXT;
  v_oid OID;
  v_rls BOOLEAN;
  v_force_rls BOOLEAN;
  v_suc_type TEXT;
  v_pol_count INTEGER;
  v_anon_pol_count INTEGER;
  v_legacy_pols JSONB;
  v_tables_report JSONB := '[]'::jsonb;
  v_anon_grants JSONB := '[]'::jsonb;
  v_enum_labels JSONB := '[]'::jsonb;
  v_functions JSONB;
  v_indexes JSONB;
  v_surveys_cols JSONB;
BEGIN
  v_is_authorized :=
    v_jwt_role = 'service_role'
    OR current_user IN ('postgres', 'supabase_admin', 'service_role')
    OR ((SELECT auth.uid()) IS NOT NULL AND (SELECT public.is_super_admin()));

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Acceso denegado: rpc_certificar_esquema_trade() requiere super_admin o service_role.'
      USING ERRCODE = '42501';
  END IF;

  -- Labels del ENUM public.sucursal_codigo
  SELECT COALESCE(jsonb_agg(e.enumlabel ORDER BY e.enumsortorder), '[]'::jsonb)
  INTO v_enum_labels
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public'
    AND t.typname = 'sucursal_codigo';

  -- Inspección de tablas críticas (RLS, FORCE RLS, sucursal, políticas y grants a anon)
  FOREACH v_tbl IN ARRAY v_expected_tables LOOP
    SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity
    INTO v_oid, v_rls, v_force_rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_tbl
      AND c.relkind IN ('r', 'p')
    LIMIT 1;

    IF v_oid IS NULL THEN
      v_tables_report := v_tables_report || jsonb_build_object(
        'table_name', v_tbl,
        'exists', false,
        'rls_enabled', false,
        'force_rls', false,
        'has_sucursal_column', false,
        'sucursal_type', NULL,
        'policy_count', 0,
        'anon_policy_count', 0,
        'unfiltered_legacy_policies', '[]'::jsonb
      );
      CONTINUE;
    END IF;

    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod)
    INTO v_suc_type
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = v_oid
      AND a.attname = 'sucursal'
      AND a.attnum > 0
      AND NOT a.attisdropped
    LIMIT 1;

    SELECT
      COUNT(*)::integer,
      COUNT(*) FILTER (WHERE 'anon' = ANY(p.roles))::integer,
      COALESCE(
        jsonb_agg(p.policyname ORDER BY p.policyname) FILTER (
          WHERE p.policyname ~ '^(rbac_coordinadora_ops_|rbac_super_admin_all_)'
        ),
        '[]'::jsonb
      )
    INTO v_pol_count, v_anon_pol_count, v_legacy_pols
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = v_tbl;

    v_tables_report := v_tables_report || jsonb_build_object(
      'table_name', v_tbl,
      'exists', true,
      'rls_enabled', COALESCE(v_rls, false),
      'force_rls', COALESCE(v_force_rls, false),
      'has_sucursal_column', v_suc_type IS NOT NULL,
      'sucursal_type', v_suc_type,
      'policy_count', COALESCE(v_pol_count, 0),
      'anon_policy_count', COALESCE(v_anon_pol_count, 0),
      'unfiltered_legacy_policies', COALESCE(v_legacy_pols, '[]'::jsonb)
    );

    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
      IF pg_catalog.has_table_privilege('anon', v_oid, 'SELECT')
         OR pg_catalog.has_table_privilege('anon', v_oid, 'INSERT')
         OR pg_catalog.has_table_privilege('anon', v_oid, 'UPDATE')
         OR pg_catalog.has_table_privilege('anon', v_oid, 'DELETE') THEN
        v_anon_grants := v_anon_grants || jsonb_build_object(
          'table_name', v_tbl,
          'select', pg_catalog.has_table_privilege('anon', v_oid, 'SELECT'),
          'insert', pg_catalog.has_table_privilege('anon', v_oid, 'INSERT'),
          'update', pg_catalog.has_table_privilege('anon', v_oid, 'UPDATE'),
          'delete', pg_catalog.has_table_privilege('anon', v_oid, 'DELETE')
        );
      END IF;
    END IF;
  END LOOP;

  -- Presencia de funciones críticas y ausencia de `vincular_mi_usuario_auth`
  v_functions := jsonb_build_object(
    'obtener_mi_rol', to_regprocedure('public.obtener_mi_rol()') IS NOT NULL,
    'obtener_mi_sucursal', to_regprocedure('public.obtener_mi_sucursal()') IS NOT NULL,
    'tiene_acceso_sucursal', to_regprocedure('public.tiene_acceso_sucursal(public.sucursal_codigo)') IS NOT NULL,
    'is_super_admin', to_regprocedure('public.is_super_admin()') IS NOT NULL,
    'is_coordinadora_or_admin', to_regprocedure('public.is_coordinadora_or_admin()') IS NOT NULL,
    'is_torre_control_viewer', to_regprocedure('public.is_torre_control_viewer()') IS NOT NULL,
    'is_chofer_or_logistics_ops', to_regprocedure('public.is_chofer_or_logistics_ops()') IS NOT NULL,
    'fn_sellar_y_proteger_sucursal_operativa', to_regprocedure('public.fn_sellar_y_proteger_sucursal_operativa()') IS NOT NULL,
    'fn_surveys_sellar_autor', to_regprocedure('public.fn_surveys_sellar_autor()') IS NOT NULL,
    'fn_surveys_normalizar_degustacion_key', to_regprocedure('public.fn_surveys_normalizar_degustacion_key()') IS NOT NULL,
    'rpc_certificar_esquema_trade', to_regprocedure('public.rpc_certificar_esquema_trade()') IS NOT NULL,
    'vincular_mi_usuario_auth', to_regprocedure('public.vincular_mi_usuario_auth()') IS NOT NULL
  );

  -- Índices clave
  v_indexes := jsonb_build_object(
    'uq_surveys_degustacion_key_active', to_regclass('public.uq_surveys_degustacion_key_active') IS NOT NULL,
    'idx_surveys_autor_user_id', to_regclass('public.idx_surveys_autor_user_id') IS NOT NULL,
    'idx_clientes_vendedor_id', to_regclass('public.idx_clientes_vendedor_id') IS NOT NULL,
    'idx_clientes_codigo_vendedor', to_regclass('public.idx_clientes_codigo_vendedor') IS NOT NULL
  );

  -- Columnas de auditoría e idempotencia en `public.surveys`
  SELECT jsonb_build_object(
    'autor_user_id', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.surveys')
        AND a.attname = 'autor_user_id' AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'sucursal', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.surveys')
        AND a.attname = 'sucursal' AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'degustacion_key', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.surveys')
        AND a.attname = 'degustacion_key' AND a.attnum > 0 AND NOT a.attisdropped
    )
  )
  INTO v_surveys_cols;

  RETURN jsonb_build_object(
    'certified_at', now(),
    'schema', 'public',
    'sucursal_codigo_enum', v_enum_labels,
    'tables', v_tables_report,
    'legacy_tables', jsonb_build_object(
      'perfiles_acceso_exists', to_regclass('public.perfiles_acceso') IS NOT NULL,
      'perfiles_acceso_deprecado_exists', to_regclass('public.perfiles_acceso_deprecado_hito1') IS NOT NULL
    ),
    'functions', v_functions,
    'indexes', v_indexes,
    'surveys_columns', v_surveys_cols,
    'anon_table_grants', v_anon_grants
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_certificar_esquema_trade() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_certificar_esquema_trade() TO authenticated, service_role;

COMMIT;
