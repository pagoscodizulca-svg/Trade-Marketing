-- ==============================================================================
-- MIGRACIÓN SQL 100% ADITIVA E IDEMPOTENTE
-- Acceso Individual 1:1 para Promotoras + `must_change_password` + Aislamiento
-- Regional Estricto (Propiedad + Región en políticas `AS RESTRICTIVE`)
--
-- Archivos espejo:
--   - supabase/migrations/20261205000100_promotoras_auth_1a1_aislamiento_estricto.sql
--   - sql/promotoras_auth_1a1_aislamiento_estricto.sql
--
-- Garantías de Producción:
--   - CERO DDL/DML destructivo (sin DROP TABLE, sin TRUNCATE, sin DELETE masivos).
--   - CERO secretos/contraseñas literales.
--   - CERO DISABLE ROW LEVEL SECURITY y CERO user_metadata en autorización RLS.
--   - Todas las funciones SECURITY DEFINER usan SET search_path = public y
--     revocan acceso a PUBLIC y anon.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. INTEGRIDAD 1 A 1 (`auth_user_id`) Y SOPORTE `must_change_password`
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles
      ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    ALTER TABLE public.promotoras
      ADD COLUMN IF NOT EXISTS auth_user_id UUID;

    -- Garantía física 1 a 1 en PostgreSQL: imposible vincular la misma cuenta Auth
    -- a dos perfiles de promotoras (misma o distinta región).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promotoras_auth_user_id_uniq
      ON public.promotoras (auth_user_id)
      WHERE auth_user_id IS NOT NULL;
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 2. RPC SEGURO PARA CONFIRMAR CAMBIO OBLIGATORIO DE CONTRASEÑA PROPIA
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_own_password_change()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Se requiere sesión autenticada.';
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    UPDATE public.profiles
    SET must_change_password = false,
        updated_at = now()
    WHERE id = v_uid;
  END IF;

  -- Sincronizar también la bandera en auth.users si el rol propietario tiene permiso
  BEGIN
    UPDATE auth.users
    SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::JSONB) || jsonb_build_object('must_change_password', false),
        raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::JSONB) || jsonb_build_object('must_change_password', false),
        updated_at = now()
    WHERE id = v_uid;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_own_password_change() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_own_password_change() TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 3. HELPER DE AISLAMIENTO REGIONAL ESTRICTO PARA PROMOTORAS (FAIL-CLOSED)
--    Verifica que una promotora autenticada SOLO acceda/escriba filas de su
--    propia región (además de su propio `promotora_id`/`auth_user_id`).
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trade_actor_regional_guardrail(
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL,
  p_region_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_role TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  v_role := public.current_user_role();
  IF v_role = '__INACTIVE__' THEN
    RETURN false;
  END IF;

  IF public.is_global_admin() THEN
    RETURN true;
  END IF;

  -- Coordinadores regionales y promotoras SIEMPRE pasan por validación regional fail-closed
  IF public.fn_trade_is_regional_coordinator() OR v_role = 'promotora' THEN
    RETURN public.fn_trade_region_matches_actor(p_region, p_sucursal, p_region_id);
  END IF;

  -- Otros roles autenticados activos (contraloría global, choferes con sus propias políticas)
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_actor_regional_guardrail(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_actor_regional_guardrail(TEXT, TEXT, UUID) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 4. REFUERZO `AS RESTRICTIVE` EN TODAS LAS TABLAS OPERATIVAS DE PROMOTORAS
--    Bloqueo horizontal absoluto entre regiones y entre distintas promotoras.
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  -- 4.1 `public.promotoras`: Una promotora SOLO ve su propia fila Y en su propia región (0 otras promotoras)
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    ALTER TABLE public.promotoras ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_restrict_regional_promotoras ON public.promotoras;

    CREATE POLICY trade_rls_restrict_regional_promotoras
      ON public.promotoras
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR (
          (SELECT public.current_user_role()) = 'promotora'
          AND public.fn_trade_region_matches_actor(region, NULL, region_id)
          AND (
            auth_user_id = (SELECT auth.uid())
            OR (
              NULLIF(LOWER(BTRIM(COALESCE(correo, ''))), '') IS NOT NULL
              AND LOWER(BTRIM(correo)) = LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
            )
          )
        )
        OR (
          (SELECT public.fn_trade_is_regional_coordinator())
          AND public.fn_trade_region_matches_actor(region, NULL, region_id)
        )
        OR (
          (SELECT public.current_user_role()) IN ('contraloria', 'analista_contraloria', 'contralor', 'chofer', 'logistica', 'despacho')
          AND (
            (SELECT public.current_user_regions()) IS NULL
            OR public.fn_trade_region_matches_actor(region, NULL, region_id)
          )
        )
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, region_id)
      );
  END IF;

  -- 4.2 `public.rutas_promotoras`: Propiedad estricta + región para promotoras
  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    ALTER TABLE public.rutas_promotoras ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_restrict_regional_rutas_promotoras ON public.rutas_promotoras;

    CREATE POLICY trade_rls_restrict_regional_rutas_promotoras
      ON public.rutas_promotoras
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        public.fn_trade_actor_regional_guardrail(region, sucursal, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, promotora_email)
        )
      )
      WITH CHECK (
        public.fn_trade_actor_regional_guardrail(region, sucursal, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, promotora_email)
        )
      );
  END IF;

  -- 4.3 `public.cronograma_degustaciones`: Propiedad estricta + región para promotoras
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    ALTER TABLE public.cronograma_degustaciones ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_restrict_regional_cronograma ON public.cronograma_degustaciones;

    CREATE POLICY trade_rls_restrict_regional_cronograma
      ON public.cronograma_degustaciones
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        public.fn_trade_actor_regional_guardrail(region, sucursal, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR public.fn_trade_is_promotora_owner(promotora_email, promotora_id)
        )
      )
      WITH CHECK (
        public.fn_trade_actor_regional_guardrail(region, sucursal, NULL)
      );
  END IF;

  -- 4.4 `public.inventory`: Propiedad estricta + región para promotoras
  IF to_regclass('public.inventory') IS NOT NULL THEN
    ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_restrict_regional_inventory ON public.inventory;

    CREATE POLICY trade_rls_restrict_regional_inventory
      ON public.inventory
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        public.fn_trade_actor_regional_guardrail(region, NULL, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      )
      WITH CHECK (
        public.fn_trade_actor_regional_guardrail(region, NULL, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR (
            auth_user_id = (SELECT auth.uid())
            AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
          )
        )
      );
  END IF;

  -- 4.5 `public.prices`: Propiedad estricta + región para promotoras
  IF to_regclass('public.prices') IS NOT NULL THEN
    ALTER TABLE public.prices ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_restrict_regional_prices ON public.prices;

    CREATE POLICY trade_rls_restrict_regional_prices
      ON public.prices
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        public.fn_trade_actor_regional_guardrail(region, NULL, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      )
      WITH CHECK (
        public.fn_trade_actor_regional_guardrail(region, NULL, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR (
            auth_user_id = (SELECT auth.uid())
            AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
          )
        )
      );
  END IF;

  -- 4.6 `public.surveys`: Propiedad estricta + región para promotoras
  IF to_regclass('public.surveys') IS NOT NULL THEN
    ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_restrict_regional_surveys ON public.surveys;

    CREATE POLICY trade_rls_restrict_regional_surveys
      ON public.surveys
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        public.fn_trade_actor_regional_guardrail(region, NULL, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      )
      WITH CHECK (
        public.fn_trade_actor_regional_guardrail(region, NULL, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR (
            auth_user_id = (SELECT auth.uid())
            AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
          )
        )
      );
  END IF;

  -- 4.7 `public.asistencias_jornada`: Propiedad estricta + región para promotoras
  IF to_regclass('public.asistencias_jornada') IS NOT NULL THEN
    ALTER TABLE public.asistencias_jornada ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_restrict_regional_asistencias_jornada ON public.asistencias_jornada;

    CREATE POLICY trade_rls_restrict_regional_asistencias_jornada
      ON public.asistencias_jornada
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        public.fn_trade_actor_regional_guardrail(region, sucursal, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, NULL)
        )
      )
      WITH CHECK (
        public.fn_trade_actor_regional_guardrail(region, sucursal, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR (
            auth_user_id = (SELECT auth.uid())
            AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, NULL)
          )
        )
      );
  END IF;

  -- 4.8 `public.asistencia_evidencias`: Propiedad estricta + región para promotoras
  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    ALTER TABLE public.asistencia_evidencias ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_restrict_regional_asistencia_evidencias ON public.asistencia_evidencias;

    CREATE POLICY trade_rls_restrict_regional_asistencia_evidencias
      ON public.asistencia_evidencias
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        public.fn_trade_actor_regional_guardrail(region, sucursal, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::TEXT, NULL)
              AND public.fn_trade_region_matches_actor(j.region, j.sucursal, NULL)
          )
        )
      )
      WITH CHECK (
        public.fn_trade_actor_regional_guardrail(region, sucursal, NULL)
        AND (
          (SELECT public.current_user_role()) <> 'promotora'
          OR EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::TEXT, NULL)
              AND public.fn_trade_region_matches_actor(j.region, j.sucursal, NULL)
          )
        )
      );
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

-- ------------------------------------------------------------------------------
-- 5. BLOQUE VERIFICADOR SQL (ÍNDICE 1:1, RPC Y POLÍTICAS RESTRICTIVE ACTIVAS)
-- ------------------------------------------------------------------------------

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'promotoras'
  AND indexname = 'idx_promotoras_auth_user_id_uniq';

SELECT proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND proname IN ('complete_own_password_change', 'fn_trade_actor_regional_guardrail')
ORDER BY proname;

SELECT tablename, policyname, permissive, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND permissive = 'RESTRICTIVE'
  AND tablename IN (
    'promotoras',
    'rutas_promotoras',
    'cronograma_degustaciones',
    'inventory',
    'prices',
    'surveys',
    'asistencias_jornada',
    'asistencia_evidencias'
  )
ORDER BY tablename, policyname;
