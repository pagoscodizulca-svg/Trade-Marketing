-- ==============================================================================
-- SCRIPT IDEMPOTENTE LISTO PARA SUPABASE SQL EDITOR — CATÁLOGOS MAESTROS RLS
-- Archivo: sql/fix_catalogos_maestros_rls.sql
-- Proyecto: Trade Marketing CODIZULCA (`apaxdgxtaoeyswlfblgi.supabase.co`)
--
-- Uso:
--   1. Abre Supabase Dashboard -> SQL Editor -> New Query.
--   2. Pega y ejecuta este archivo completo (100% idempotente, cero borrado de datos).
--   3. Revisa al final los resultados de verificación (`pg_policies`, `grants` y `COUNT(*)`).
--
-- Seguridad Innegociable:
--   - Mantiene `ENABLE ROW LEVEL SECURITY` activo en todas las tablas maestras.
--   - Revoca privilegios innecesarios de `anon` / `PUBLIC` (verificado en auditoría:
--     ninguna ruta pública del repositorio lee clientes/vendedores/cadenas/zonas como anon).
--   - Otorga `GRANT SELECT` exclusivamente a `authenticated`.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_trade_authenticated_catalog_read(
  p_region_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_jwt_email text := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_jwt_role text := LOWER(BTRIM(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    ''
  )));
  v_jwt_sucursal text := UPPER(BTRIM(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'sucursal',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'region',
    ''
  )));
  v_has_profile boolean := false;
  v_profile_active boolean;
  v_profile_role text;
  v_profile_sucursal text;
  v_profile_region_id uuid;
  v_effective_role text;
  v_effective_sucursal text;
  v_actor_region_code text;
  v_target_region_code text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE $q$
      SELECT
        true,
        p.is_active,
        LOWER(BTRIM(COALESCE(p.role::text, ''))),
        UPPER(BTRIM(COALESCE(p.sucursal::text, ''))),
        p.region_id
      FROM public.profiles p
      WHERE p.id = $1
         OR ($2 <> '' AND LOWER(BTRIM(COALESCE(p.email, ''))) = $2)
      ORDER BY CASE WHEN p.id = $1 THEN 0 ELSE 1 END ASC
      LIMIT 1
    $q$
    INTO v_has_profile, v_profile_active, v_profile_role, v_profile_sucursal, v_profile_region_id
    USING v_uid, v_jwt_email;

    IF v_has_profile AND v_profile_active IS DISTINCT FROM true THEN
      RETURN false;
    END IF;
  END IF;

  v_effective_role := COALESCE(NULLIF(v_profile_role, ''), v_jwt_role);
  v_effective_sucursal := COALESCE(NULLIF(v_profile_sucursal, ''), v_jwt_sucursal);

  IF v_effective_role IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin')
     OR (v_effective_role IN ('contraloria', 'analista_contraloria', 'contralor') AND v_effective_sucursal IN ('', 'GLOBAL'))
  THEN
    RETURN true;
  END IF;

  IF p_region_id IS NULL THEN
    RETURN true;
  END IF;

  IF v_profile_region_id IS NOT NULL THEN
    RETURN v_profile_region_id = p_region_id;
  END IF;

  v_actor_region_code := CASE
    WHEN v_effective_sucursal IN ('OCCIDENTE', 'ZULIA') THEN 'OCCIDENTE'
    WHEN v_effective_sucursal IN ('CENTRO', 'VALENCIA', 'CAPITAL') THEN 'CENTRO'
    WHEN v_effective_sucursal = 'ANDES' THEN 'ANDES'
    ELSE NULL
  END;

  IF v_actor_region_code IS NOT NULL AND to_regclass('public."Regiones"') IS NOT NULL THEN
    EXECUTE 'SELECT UPPER(BTRIM(regi_desd)) FROM public."Regiones" WHERE id_regi = $1 LIMIT 1'
      INTO v_target_region_code
      USING p_region_id;
    RETURN v_target_region_code = v_actor_region_code;
  END IF;

  RETURN NOT v_has_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_authenticated_catalog_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_authenticated_catalog_read(uuid) TO authenticated, service_role;

DO $$
DECLARE
  tbl text;
  pol_name text;
  legacy_pol text;
  erp_reference_tables text[] := ARRAY[
    'Regiones',
    'Sucursales',
    'Estados',
    'Municipios',
    'Tipificacion_Clientes',
    'Canal_Comercializacion',
    'Forecast_Vendedores_Excluidos',
    'Vendedores',
    'Productos'
  ];
BEGIN
  GRANT USAGE ON SCHEMA public TO authenticated;

  FOREACH tbl IN ARRAY erp_reference_tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', tbl);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', tbl);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

      legacy_pol := format('trade_authenticated_read_%s', lower(tbl));
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', legacy_pol, tbl);

      pol_name := format('trade_rls_select_%s', lower(tbl));
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, tbl);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.fn_trade_authenticated_catalog_read(NULL::uuid)))',
        pol_name,
        tbl
      );
    END IF;
  END LOOP;

  IF to_regclass('public."Clientes"') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public."Clientes" FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT ON TABLE public."Clientes" TO authenticated';
    EXECUTE 'ALTER TABLE public."Clientes" ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS trade_authenticated_read_clientes ON public."Clientes"';
    EXECUTE 'DROP POLICY IF EXISTS trade_rls_select_clientes ON public."Clientes"';
    EXECUTE $pol$
      CREATE POLICY trade_rls_select_clientes
      ON public."Clientes"
      FOR SELECT
      TO authenticated
      USING ((SELECT public.fn_trade_authenticated_catalog_read(clie_regi)))
    $pol$;

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_clientes_acti ON public."Clientes" (clie_acti)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_clientes_regi_acti ON public."Clientes" (clie_regi, clie_acti)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_clientes_esta_muni ON public."Clientes" (id_esta, id_muni)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_clientes_tipi ON public."Clientes" (id_tipi)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_clientes_vend ON public."Clientes" (id_vend)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_clientes_prin ON public."Clientes" (id_clie_prin) WHERE id_clie_prin IS NOT NULL';
  END IF;

  IF to_regclass('public."Supervisores"') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public."Supervisores" FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT ON TABLE public."Supervisores" TO authenticated';
    EXECUTE 'ALTER TABLE public."Supervisores" ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS trade_authenticated_read_supervisores ON public."Supervisores"';
    EXECUTE 'DROP POLICY IF EXISTS trade_rls_select_supervisores ON public."Supervisores"';
    EXECUTE $pol$
      CREATE POLICY trade_rls_select_supervisores
      ON public."Supervisores"
      FOR SELECT
      TO authenticated
      USING ((SELECT public.fn_trade_authenticated_catalog_read(id_regi)))
    $pol$;

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_supervisores_regi ON public."Supervisores" (id_regi)';
  END IF;

  IF to_regclass('public."Vendedores"') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_vendedores_acti ON public."Vendedores" (vend_acti)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_vendedores_sucu_acti ON public."Vendedores" (id_sucu, vend_acti)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_vendedores_supe ON public."Vendedores" (id_supe)';
  END IF;

  IF to_regclass('public."Sucursales"') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_sucursales_regi ON public."Sucursales" (id_regi)';
  END IF;

  IF to_regclass('public."Estados"') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_estados_regi ON public."Estados" (id_regi)';
  END IF;

  IF to_regclass('public."Municipios"') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_erp_municipios_esta_regi ON public."Municipios" (id_esta, id_regi)';
  END IF;

  IF to_regclass('public.vw_productos_detalle') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.vw_productos_detalle FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT ON public.vw_productos_detalle TO authenticated';
  END IF;
END;
$$;

-- Esquema normalizado Trade Marketing (tablas en minúsculas si existen)
DO $$
DECLARE
  tbl text;
  pol_name text;
  has_select_policy boolean;
  normalized_master_tables text[] := ARRAY[
    'vendedores',
    'clientes',
    'cadenas_comerciales',
    'zonas',
    'regiones',
    'promotoras'
  ];
BEGIN
  FOREACH tbl IN ARRAY normalized_master_tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', tbl);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', tbl);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

      SELECT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = tbl
          AND cmd = 'SELECT'
          AND 'authenticated' = ANY(roles)
      ) INTO has_select_policy;

      IF NOT has_select_policy THEN
        pol_name := format('trade_norm_select_%s_authenticated', tbl);
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.fn_trade_authenticated_catalog_read(NULL::uuid)))',
          pol_name,
          tbl
        );
      END IF;
    END IF;
  END LOOP;

  IF to_regclass('public.clientes') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'activo') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_norm_clientes_activo ON public.clientes (activo)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'region_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_norm_clientes_region_activo ON public.clientes (region_id, activo)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'zona_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_norm_clientes_zona_id ON public.clientes (zona_id) WHERE zona_id IS NOT NULL';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'cadena_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_norm_clientes_cadena_id ON public.clientes (cadena_id) WHERE cadena_id IS NOT NULL';
    END IF;
  END IF;

  IF to_regclass('public.vendedores') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vendedores' AND column_name = 'region_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_norm_vendedores_region_activo ON public.vendedores (region_id, activo)';
    END IF;
  END IF;

  IF to_regclass('public.cadenas_comerciales') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cadenas_comerciales' AND column_name = 'region_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_norm_cadenas_region_activo ON public.cadenas_comerciales (region_id, activo)';
    END IF;
  END IF;

  IF to_regclass('public.zonas') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'zonas' AND column_name = 'region_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_norm_zonas_region_activo ON public.zonas (region_id, activo)';
    END IF;
  END IF;
END
$$;

-- ==============================================================================
-- 2. CONSULTAS DE VERIFICACIÓN RÁPIDA (CONFIRMACIÓN INMEDIATA EN SQL EDITOR)
-- ==============================================================================

-- 2A. Verificar políticas RLS activas sobre los catálogos maestros (solo `authenticated`)
SELECT
  tablename,
  policyname,
  cmd,
  roles,
  qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'Regiones', 'Sucursales', 'Estados', 'Municipios', 'Supervisores',
    'Tipificacion_Clientes', 'Canal_Comercializacion', 'Forecast_Vendedores_Excluidos',
    'Vendedores', 'Clientes', 'Productos', 'promotoras',
    'vendedores', 'clientes', 'cadenas_comerciales', 'zonas', 'regiones'
  )
ORDER BY tablename, policyname;

-- 2B. Verificar privilegios de tabla: `authenticated` = SELECT, `anon` = 0 filas
SELECT
  table_name,
  grantee,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN (
    'Regiones', 'Sucursales', 'Estados', 'Municipios', 'Supervisores',
    'Tipificacion_Clientes', 'Canal_Comercializacion', 'Forecast_Vendedores_Excluidos',
    'Vendedores', 'Clientes', 'Productos', 'promotoras',
    'vendedores', 'clientes', 'cadenas_comerciales', 'zonas', 'regiones'
  )
ORDER BY table_name, grantee, privilege_type;

-- 2C. Conteo exacto `COUNT(*)` de registros por tabla maestra ERP
SELECT 'Regiones' AS tabla, COUNT(*) AS total FROM public."Regiones"
UNION ALL SELECT 'Sucursales', COUNT(*) FROM public."Sucursales"
UNION ALL SELECT 'Estados', COUNT(*) FROM public."Estados"
UNION ALL SELECT 'Municipios', COUNT(*) FROM public."Municipios"
UNION ALL SELECT 'Supervisores', COUNT(*) FROM public."Supervisores"
UNION ALL SELECT 'Tipificacion_Clientes', COUNT(*) FROM public."Tipificacion_Clientes"
UNION ALL SELECT 'Canal_Comercializacion', COUNT(*) FROM public."Canal_Comercializacion"
UNION ALL SELECT 'Vendedores (total)', COUNT(*) FROM public."Vendedores"
UNION ALL SELECT 'Vendedores (activos)', COUNT(*) FROM public."Vendedores" WHERE vend_acti = true
UNION ALL SELECT 'Clientes (total)', COUNT(*) FROM public."Clientes"
UNION ALL SELECT 'Clientes (activos)', COUNT(*) FROM public."Clientes" WHERE clie_acti = true
UNION ALL SELECT 'Productos (total)', COUNT(*) FROM public."Productos"
UNION ALL SELECT 'promotoras (total)', COUNT(*) FROM public.promotoras;
