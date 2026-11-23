-- ==============================================================================
-- SUBFASE B · ACCESO AUTENTICADO RLS + ÍNDICES PARA DATA MAESTRA REAL EN SUPABASE
-- ==============================================================================
-- Proyecto objetivo: `apaxdgxtaoeyswlfblgi.supabase.co`
-- Regiones oficiales en `public."Regiones"`: `OCCIDENTE` (P1, regi_saba=true),
-- `CENTRO` (P2, regi_saba=false), `ANDES` (P3, regi_saba=false).
--
-- Principios estrictos de seguridad (AppSec / Supabase Postgres Best Practices):
--   1. JAMÁS desactiva RLS (`ENABLE ROW LEVEL SECURITY` preservado en todas).
--   2. CERO políticas `USING (true)` abiertas a `public` o `anon`.
--   3. CERO `GRANT SELECT` a `anon` (solo `authenticated` + `service_role`).
--   4. CERO uso de `user_metadata` (solo `public.profiles` o `app_metadata` firmado).
--   5. CERO UUIDs hardcodeados: toda resolución de `id_regi` usa `UPPER(TRIM(regi_desd))`.
--   6. 100% idempotente y protegido con `to_regclass(...) IS NOT NULL` para no romper
--      reconstrucciones limpias ni políticas existentes del ERP corporativo.
-- ==============================================================================

-- 1. Helper `SECURITY INVOKER` que verifica actor autenticado activo y alcance regional
--    sin exponer bypass RLS ni depender de `user_metadata`.
CREATE OR REPLACE FUNCTION public.fn_trade_es_actor_maestros_autorizado()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_jwt_role text := LOWER(TRIM(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    ''
  )));
  v_profile_ok boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE $q$
      SELECT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = $1
          AND p.is_active = TRUE
          AND LOWER(TRIM(COALESCE(p.role::text, ''))) IN (
            'super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin',
            'coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade',
            'supervisor', 'contraloria', 'analista_contraloria', 'contralor',
            'vendedor', 'fdv', 'promotora', 'chofer'
          )
      )
    $q$ INTO v_profile_ok USING v_uid;

    IF v_profile_ok THEN
      RETURN true;
    END IF;
  END IF;

  RETURN v_jwt_role IN (
    'super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin',
    'coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade',
    'supervisor', 'contraloria', 'analista_contraloria', 'contralor',
    'vendedor', 'fdv', 'promotora', 'chofer'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_trade_tiene_acceso_region_erp(p_region_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_jwt_role text := LOWER(TRIM(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    ''
  )));
  v_jwt_sucursal text := UPPER(TRIM(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'sucursal',
    ''
  )));
  v_profile_role text;
  v_profile_sucursal text;
  v_profile_region_id uuid;
  v_target_region_code text;
  v_actor_region_code text;
BEGIN
  IF v_uid IS NULL OR NOT public.fn_trade_es_actor_maestros_autorizado() THEN
    RETURN false;
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE $q$
      SELECT
        LOWER(TRIM(COALESCE(p.role::text, ''))),
        UPPER(TRIM(COALESCE(p.sucursal::text, ''))),
        p.region_id
      FROM public.profiles p
      WHERE p.id = $1 AND p.is_active = TRUE
      LIMIT 1
    $q$ INTO v_profile_role, v_profile_sucursal, v_profile_region_id USING v_uid;
  END IF;

  v_profile_role := COALESCE(NULLIF(v_profile_role, ''), v_jwt_role);
  v_profile_sucursal := COALESCE(NULLIF(v_profile_sucursal, ''), v_jwt_sucursal);

  -- Roles globales ven las 3 regiones oficiales y registros históricos en cuarentena (`NULL`)
  IF v_profile_role IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin')
     OR (v_profile_role IN ('contraloria', 'analista_contraloria', 'contralor') AND v_profile_sucursal = 'GLOBAL')
  THEN
    RETURN true;
  END IF;

  -- Actores regionales jamás ven filas sin región asignada (fail-closed)
  IF p_region_id IS NULL THEN
    RETURN false;
  END IF;

  IF v_profile_region_id IS NOT NULL AND v_profile_region_id = p_region_id THEN
    RETURN true;
  END IF;

  -- Mapear alias legado de perfil regional (`ZULIA` -> `OCCIDENTE`, `VALENCIA`/`CAPITAL` -> `CENTRO`)
  v_actor_region_code := CASE
    WHEN v_profile_sucursal IN ('OCCIDENTE', 'ZULIA') THEN 'OCCIDENTE'
    WHEN v_profile_sucursal IN ('CENTRO', 'VALENCIA', 'CAPITAL') THEN 'CENTRO'
    WHEN v_profile_sucursal = 'ANDES' THEN 'ANDES'
    ELSE NULL
  END;

  IF v_actor_region_code IS NULL THEN
    RETURN false;
  END IF;

  IF to_regclass('public."Regiones"') IS NOT NULL THEN
    EXECUTE 'SELECT UPPER(TRIM(regi_desd)) FROM public."Regiones" WHERE id_regi = $1 LIMIT 1'
      INTO v_target_region_code
      USING p_region_id;
    RETURN v_target_region_code = v_actor_region_code;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_es_actor_maestros_autorizado() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_trade_es_actor_maestros_autorizado() TO authenticated;

REVOKE ALL ON FUNCTION public.fn_trade_tiene_acceso_region_erp(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_trade_tiene_acceso_region_erp(uuid) TO authenticated;

-- 2. Garantizar `GRANT USAGE` y lectura RLS segura (`TO authenticated`, CERO `anon`)
--    sobre los catálogos maestros reales del ERP y `public.promotoras`.
DO $$
DECLARE
  tbl text;
  legacy_pol text;
  pol_name text;
  national_catalog_tables text[] := ARRAY[
    'Regiones',
    'Productos',
    'Productos_Regiones',
    'Marcas',
    'Grupo_Productos',
    'Familia_Productos',
    'Sucursales',
    'Estados',
    'Municipios',
    'Forecast_Zonas_Region',
    'Tipificacion_Clientes',
    'Canal_Comercializacion',
    'Canales_Ventas',
    'Forecast_Vendedores_Excluidos',
    'Vendedores',
    'Rutas'
  ];
BEGIN
  GRANT USAGE ON SCHEMA public TO authenticated;

  -- Catálogos de referencia nacionales (requieren actor autenticado con rol autorizado)
  FOREACH tbl IN ARRAY national_catalog_tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', tbl);

      legacy_pol := format('trade_authenticated_read_%s', lower(tbl));
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', legacy_pol, tbl);

      pol_name := format('trade_rls_select_%s', lower(tbl));
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, tbl);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.fn_trade_es_actor_maestros_autorizado())',
        pol_name,
        tbl
      );
    END IF;
  END LOOP;

  -- Vista de productos enriquecida (solo `authenticated`, jamás `anon`)
  IF to_regclass('public.vw_productos_detalle') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON public.vw_productos_detalle TO authenticated';
  END IF;

  -- `public."Clientes"` con aislamiento regional estricto por `clie_regi`
  IF to_regclass('public."Clientes"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public."Clientes" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'GRANT SELECT ON TABLE public."Clientes" TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS trade_authenticated_read_clientes ON public."Clientes"';
    EXECUTE 'DROP POLICY IF EXISTS trade_rls_select_clientes ON public."Clientes"';
    EXECUTE $p$
      CREATE POLICY trade_rls_select_clientes
      ON public."Clientes"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_tiene_acceso_region_erp(clie_regi))
    $p$;
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_clientes_regi_acti ON public."Clientes" (clie_regi, clie_acti)';
  END IF;

  -- `public."Supervisores"` con aislamiento regional estricto por `id_regi`
  IF to_regclass('public."Supervisores"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public."Supervisores" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'GRANT SELECT ON TABLE public."Supervisores" TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS trade_authenticated_read_supervisores ON public."Supervisores"';
    EXECUTE 'DROP POLICY IF EXISTS trade_rls_select_supervisores ON public."Supervisores"';
    EXECUTE $p$
      CREATE POLICY trade_rls_select_supervisores
      ON public."Supervisores"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_tiene_acceso_region_erp(id_regi))
    $p$;
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_supervisores_regi ON public."Supervisores" (id_regi)';
  END IF;

  -- `public."Vendedores"` índice operativo por sucursal y estado
  IF to_regclass('public."Vendedores"') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_vendedores_sucu_acti ON public."Vendedores" (id_sucu, vend_acti)';
  END IF;

  -- `public.promotoras`: añadir `region_id` opcional si falta + backfill dinámico vía `"Regiones"` + RLS regional
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    IF to_regclass('public."Regiones"') IS NOT NULL THEN
      EXECUTE $ddl$
        ALTER TABLE public.promotoras
        ADD COLUMN IF NOT EXISTS region_id uuid REFERENCES public."Regiones"(id_regi)
      $ddl$;

      -- Backfill no destructivo solo sobre filas con `region_id IS NULL`, resolviendo UUID dinámicamente
      EXECUTE $bf$
        UPDATE public.promotoras p
        SET region_id = r.id_regi
        FROM public."Regiones" r
        WHERE p.region_id IS NULL
          AND UPPER(TRIM(r.regi_desd)) = 'OCCIDENTE'
          AND COALESCE(p.direccion, '') ~* '(CORO|PUNTO FIJO|CABIMAS|MARACAIBO|SAN FRANCISCO|LA VILLA|MARA|MOJAN|CUATRICENTENARIO|VARILLAL|LA LIMPIA|LA POPULAR|EL SILENCIO|EL BAJO|SANTA MARIA|PLAZA DE LAS MADRES|DIA DE LAS MADRES|\mC2\M)'
      $bf$;

      EXECUTE $bf$
        UPDATE public.promotoras p
        SET region_id = r.id_regi
        FROM public."Regiones" r
        WHERE p.region_id IS NULL
          AND UPPER(TRIM(r.regi_desd)) = 'CENTRO'
          AND COALESCE(p.direccion, '') ~* '(VALENCIA|CARABOBO|LOS GUAYOS|TOCUYITO|MARACAY|TURMERO|ARAGUA|CARACAS|DISTRITO CAPITAL|EL PARAISO|MONTALBAN|PLAZA VENEZUELA)'
      $bf$;

      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_promotoras_region_categoria ON public.promotoras (region_id, categoria)';
    END IF;

    EXECUTE 'ALTER TABLE public.promotoras ENABLE ROW LEVEL SECURITY';
    EXECUTE 'GRANT SELECT ON TABLE public.promotoras TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS trade_rls_select_promotoras ON public.promotoras';
    EXECUTE $p$
      CREATE POLICY trade_rls_select_promotoras
      ON public.promotoras
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_tiene_acceso_region_erp(region_id))
    $p$;
  END IF;
END
$$;
