-- ==============================================================================
-- MIGRACIÓN IDEMPOTENTE: BLINDAJE Y LECTURA AUTENTICADA (`authenticated`) DE
-- CATÁLOGOS MAESTROS (VENDEDORES, CLIENTES, CADENAS, ZONAS Y JOINS ERP)
-- Archivo: supabase/migrations/20261129000100_fix_catalogos_maestros_rls_authenticated.sql
-- Proyecto: Trade Marketing CODIZULCA (`apaxdgxtaoeyswlfblgi.supabase.co`)
--
-- Reglas de Seguridad Innegociables:
--   1. Mantiene `ENABLE ROW LEVEL SECURITY` activo en todas las tablas maestras.
--   2. CERO acceso `anon` / `PUBLIC` (`REVOKE ALL ... FROM PUBLIC, anon` verificado:
--      ninguna ruta pública del repositorio consulta catálogos maestros sin login).
--   3. Otorga únicamente `GRANT USAGE ON SCHEMA public TO authenticated` y
--      `GRANT SELECT` mínimo privilegio a `authenticated`.
--   4. Jamás lee `user_metadata` ni usa `auth.role()` deprecado.
--   5. 100 % idempotente y no destructivo (protegido con `to_regclass(...) IS NOT NULL`).
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
  -- 1. Bloquear de raíz cualquier acceso sin usuario autenticado (`anon`)
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- 2. Si existe `public.profiles` en la instancia, respetar cuenta activa, rol y región
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

  -- 3. Roles globales (super_admin, admin, gerencia, contraloria GLOBAL) leen todas las regiones
  IF v_effective_role IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin')
     OR (v_effective_role IN ('contraloria', 'analista_contraloria', 'contralor') AND v_effective_sucursal IN ('', 'GLOBAL'))
  THEN
    RETURN true;
  END IF;

  -- 4. Catálogos de referencia sin columna regional específica: legibles por cualquier usuario `authenticated` activo
  IF p_region_id IS NULL THEN
    RETURN true;
  END IF;

  -- 5. Si el actor tiene región asignada explícita, aplicar aislamiento regional
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

  -- 6. Instancias ERP sin `public.profiles` ni claim regional restrictivo:
  --    autoriza lectura a la sesión `authenticated` verificada (`v_uid IS NOT NULL`).
  RETURN NOT v_has_profile;
END;
$$;

COMMENT ON FUNCTION public.fn_trade_authenticated_catalog_read(uuid) IS
  'Autoriza SELECT exclusivo para usuarios autenticados (TO authenticated, cero anon) respetando public.profiles o app_metadata cuando existen.';

REVOKE ALL ON FUNCTION public.fn_trade_authenticated_catalog_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_authenticated_catalog_read(uuid) TO authenticated, service_role;

-- ==============================================================================
-- 1. PRIVILEGIOS, RLS ESTRICTO (`TO authenticated`) E ÍNDICES EN TABLAS MAESTRAS
-- ==============================================================================
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

  -- 1A. Tablas de referencia ERP (solo SELECT para authenticated; REVOKE total a anon)
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

  -- 1B. `public."Clientes"` (tabla maestra de PDVs con columna regional `clie_regi`)
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

  -- 1C. `public."Supervisores"` (tabla relacionada en joins de vendedores/clientes)
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

  -- 1D. Índices de filtrado frecuente en tablas ERP relacionadas
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

  -- 1E. Vista de detalle de productos (solo `authenticated`, cero `anon`)
  IF to_regclass('public.vw_productos_detalle') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.vw_productos_detalle FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT ON public.vw_productos_detalle TO authenticated';
  END IF;
END;
$$;

-- ------------------------------------------------------------------------------
-- BLOQUE 2: Esquema normalizado Trade Marketing (tablas en minúsculas si existen)
--           Sin DROP POLICY destructivo: preserva las políticas regionales previas
--           y solo agrega SELECT TO authenticated si alguna tabla carece de una.
-- ------------------------------------------------------------------------------
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
  -- 2A. Esquema normalizado Trade Marketing (cuando existan las tablas en minúsculas)
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

  -- Índices en tablas normalizadas (solo si existen tabla y columnas)
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
