-- ==============================================================================
-- MIGRACIÓN SQL 100% ADITIVA E IDEMPOTENTE — AISLAMIENTO REGIONAL ESTRICTO
-- Coordinadora de Trade Occidente (`grecia01@codizulca.com` · `coordinador_trade`)
--
-- Archivos espejo:
--   - supabase/migrations/20261201000100_rls_coordinador_occidente.sql
--   - sql/rls_coordinador_occidente.sql (listo para pegar en Supabase SQL Editor)
--
-- Proyecto objetivo: Trade Marketing CODIZULCA (`apaxdgxtaoeyswlfblgi.supabase.co`)
--
-- Garantías de Seguridad e Integridad en Producción:
--   1. CERO sentencias destructivas (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE`).
--   2. CERO secretos ni contraseñas literales.
--   3. Autorización basada EXCLUSIVAMENTE en `auth.jwt() -> 'app_metadata'` y la tabla
--      protegida `public.profiles` mediante funciones `SECURITY DEFINER` con
--      `SET search_path = public` (evitando recursión infinita y bloqueando auto-escalación).
--   4. Defensa en profundidad: combina políticas permisivas granulares (`TO authenticated`)
--      con políticas `AS RESTRICTIVE` para impedir que cualquier política heredada del ERP
--      filtre filas de Valencia/Centro/Andes a una coordinadora regional.
--   5. Protección total para actores existentes:
--        - Administrador Global (`admin@codizulca.com`, incluso sin fila en `public.profiles`)
--        - Promotoras y Choferes
--        - Usuarios ERP legacy sin restricción regional Trade (solo lectura ERP intacta).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EVOLUCIÓN ADITIVA DE COLUMNAS, ÍNDICES Y BACKFILL IDEMPOTENTE DE REGIÓN
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles
      ADD COLUMN IF NOT EXISTS region TEXT;
    CREATE INDEX IF NOT EXISTS idx_profiles_role_region
      ON public.profiles (LOWER(BTRIM(COALESCE(role, ''))), UPPER(BTRIM(COALESCE(region, ''))));
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    ALTER TABLE public.promotoras
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS region_id UUID;

    CREATE INDEX IF NOT EXISTS idx_promotoras_region_upper
      ON public.promotoras (UPPER(BTRIM(COALESCE(region, ''))));
    CREATE INDEX IF NOT EXISTS idx_promotoras_region_id
      ON public.promotoras (region_id) WHERE region_id IS NOT NULL;
  END IF;

  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    ALTER TABLE public.cronograma_degustaciones
      ADD COLUMN IF NOT EXISTS region TEXT;
    CREATE INDEX IF NOT EXISTS idx_cronograma_degustaciones_region_sucursal
      ON public.cronograma_degustaciones (UPPER(BTRIM(COALESCE(region, ''))), UPPER(BTRIM(COALESCE(sucursal, ''))));
  END IF;

  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    ALTER TABLE public.entregas_degustacion
      ADD COLUMN IF NOT EXISTS region TEXT;
    CREATE INDEX IF NOT EXISTS idx_entregas_degustacion_region_sucursal
      ON public.entregas_degustacion (UPPER(BTRIM(COALESCE(region, ''))), UPPER(BTRIM(COALESCE(sucursal, ''))));
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_region_sucursal
      ON public.rutas_promotoras (UPPER(BTRIM(COALESCE(region, ''))), UPPER(BTRIM(COALESCE(sucursal, ''))));
  END IF;

  IF to_regclass('public.inventory') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_inventory_region_upper
      ON public.inventory (UPPER(BTRIM(COALESCE(region, ''))));
  END IF;

  IF to_regclass('public.asistencias_jornada') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_asistencias_jornada_region_upper
      ON public.asistencias_jornada (UPPER(BTRIM(COALESCE(region, ''))));
  END IF;

  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_asistencia_evidencias_region_upper
      ON public.asistencia_evidencias (UPPER(BTRIM(COALESCE(region, ''))));
  END IF;

  IF to_regclass('public.prices') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_prices_region_upper
      ON public.prices (UPPER(BTRIM(COALESCE(region, ''))));
  END IF;

  IF to_regclass('public.surveys') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_surveys_region_upper
      ON public.surveys (UPPER(BTRIM(COALESCE(region, ''))));
  END IF;
END
$$;

-- Backfill aditivo e idempotente de `public.promotoras.region` y `public.promotoras.region_id`
-- (solo completa filas donde `region` o `region_id` esté vacío/NULL; jamás sobrescribe valores válidos).
DO $$
DECLARE
  v_occidente_id UUID;
  v_centro_id UUID;
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    -- 1) Clasificar explícitamente las promotoras de Valencia / Carabobo / Maracay / Caracas
    UPDATE public.promotoras
    SET region = 'Valencia',
        updated_at = COALESCE(updated_at, now())
    WHERE NULLIF(BTRIM(COALESCE(region, '')), '') IS NULL
      AND (
        LOWER(BTRIM(COALESCE(correo, ''))) IN (
          'paolamaldonado1805@gmail.com',
          'barbie.marqueztorres@gmail.com',
          'scarlett060219@gmail.com',
          'americac1809@gmail.com',
          'dosramosmariana0@gmail.com',
          'maizdajan04@gmail.com',
          'osverlys2025@gmail.com',
          'geyerlis2017@gmail.com',
          'rinconastrid10@gmail.com'
        )
        OR COALESCE(direccion, '') ~* '(valencia|carabobo|tocuyito|los guayos|paraparal|maracay|turmero|aragua|caracas|montalb|para[ií]so|plaza venezuela|distrito capital|miranda)'
      );

    -- 2) Clasificar las promotoras restantes sin región asignada como Occidente (padrón base Occidente: 24 filas)
    UPDATE public.promotoras
    SET region = 'Occidente',
        updated_at = COALESCE(updated_at, now())
    WHERE NULLIF(BTRIM(COALESCE(region, '')), '') IS NULL;

    -- 3) Enlazar dinámicamente `region_id` desde `public."Regiones"` (cero UUIDs hardcodeados)
    IF to_regclass('public."Regiones"') IS NOT NULL THEN
      SELECT id_regi INTO v_occidente_id
      FROM public."Regiones"
      WHERE UPPER(BTRIM(regi_desd)) = 'OCCIDENTE'
      LIMIT 1;

      SELECT id_regi INTO v_centro_id
      FROM public."Regiones"
      WHERE UPPER(BTRIM(regi_desd)) = 'CENTRO'
      LIMIT 1;

      IF v_occidente_id IS NOT NULL THEN
        UPDATE public.promotoras
        SET region_id = v_occidente_id
        WHERE region_id IS NULL
          AND UPPER(BTRIM(COALESCE(region, ''))) IN ('OCCIDENTE', 'ZULIA');
      END IF;

      IF v_centro_id IS NOT NULL THEN
        UPDATE public.promotoras
        SET region_id = v_centro_id
        WHERE region_id IS NULL
          AND UPPER(BTRIM(COALESCE(region, ''))) IN ('VALENCIA', 'CENTRO', 'CAPITAL');
      END IF;
    END IF;
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 2. FUNCIONES HELPER SEGURAS (`SECURITY DEFINER`, `SET search_path = public`)
--    - Cero lectura de metadatos editables por el usuario.
--    - Cero acceso a `anon` / `PUBLIC`.
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trade_normalize_region_token(p_raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
BEGIN
  v_norm := UPPER(BTRIM(COALESCE(p_raw, '')));
  IF v_norm = '' THEN
    RETURN NULL;
  END IF;

  -- Normalización de acentos comunes para comparaciones robustas
  v_norm := TRANSLATE(v_norm, 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜ', 'AEIOUAEIOUAEIOU');

  IF v_norm IN ('GLOBAL', 'TODAS', 'ALL', 'NACIONAL', 'TODAS LAS REGIONES') THEN
    RETURN NULL;
  END IF;

  IF v_norm IN (
    'OCCIDENTE',
    'REGION OCCIDENTE',
    'ZULIA',
    'MARACAIBO',
    'SAN FRANCISCO',
    'CABIMAS',
    'FALCON',
    'CORO',
    'PUNTO FIJO',
    'TRUJILLO',
    'VALERA',
    'LA VILLA',
    'MARA'
  ) THEN
    RETURN 'OCCIDENTE';
  END IF;

  IF v_norm IN (
    'VALENCIA',
    'CENTRO',
    'REGION CENTRO',
    'CARABOBO',
    'ARAGUA',
    'MARACAY',
    'TURMERO',
    'CAPITAL',
    'CARACAS',
    'DISTRITO CAPITAL',
    'MIRANDA'
  ) THEN
    RETURN 'CENTRO';
  END IF;

  IF v_norm IN ('ANDES', 'REGION ANDES', 'TACHIRA', 'MERIDA', 'BARINAS') THEN
    RETURN 'ANDES';
  END IF;

  IF v_norm IN ('ORIENTE', 'REGION ORIENTE', 'ANZOATEGUI', 'MONAGAS', 'SUCRE', 'BOLIVAR') THEN
    RETURN 'ORIENTE';
  END IF;

  RETURN v_norm;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_normalize_region_token(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_normalize_region_token(TEXT) TO authenticated, service_role;

-- Lee el rol autorizado exclusivamente desde `public.profiles` (protegida por RLS)
-- y/o `auth.jwt() -> 'app_metadata'` (solo modificable vía service_role).
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_jwt_email TEXT := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_jwt_role TEXT := LOWER(BTRIM(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    ''
  )));
  v_has_profile BOOLEAN := false;
  v_profile_active BOOLEAN := true;
  v_profile_role TEXT := '';
  v_effective TEXT := '';
BEGIN
  IF v_uid IS NULL THEN
    RETURN '';
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    SELECT
      true,
      p.is_active,
      LOWER(BTRIM(COALESCE(p.role::TEXT, '')))
    INTO v_has_profile, v_profile_active, v_profile_role
    FROM public.profiles p
    WHERE p.id = v_uid
       OR (v_jwt_email <> '' AND LOWER(BTRIM(COALESCE(p.email, ''))) = v_jwt_email)
    ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
    LIMIT 1;

    IF v_has_profile AND v_profile_active IS DISTINCT FROM true THEN
      RETURN '__INACTIVE__';
    END IF;
  END IF;

  v_effective := COALESCE(NULLIF(v_profile_role, ''), v_jwt_role);

  IF v_effective IN ('coordinadora_trade', 'coordinador_trade', 'coordinador_regional') THEN
    RETURN 'coordinador_trade';
  END IF;

  RETURN v_effective;
END;
$$;

REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

-- Retorna TRUE exclusivamente para administradores globales activos.
-- Garantiza compatibilidad con `admin@codizulca.com` incluso sin fila en `public.profiles`.
CREATE OR REPLACE FUNCTION public.is_global_admin()
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

  RETURN v_role IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin');
END;
$$;

REVOKE ALL ON FUNCTION public.is_global_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_global_admin() TO authenticated, service_role;

-- Retorna la región canónica normalizada (`UPPER(TRIM(...))`, ej. 'OCCIDENTE')
-- asignada al usuario autenticado, o `NULL` para administradores globales / ERP sin ámbito regional.
CREATE OR REPLACE FUNCTION public.current_user_region()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_jwt_email TEXT := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_role TEXT;
  v_jwt_region TEXT := COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'region', '');
  v_jwt_sucursal TEXT := COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'sucursal', '');
  v_jwt_region_id_txt TEXT := BTRIM(COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'region_id', ''));
  v_jwt_region_id UUID := NULL;
  v_prof_region TEXT := NULL;
  v_prof_sucursal TEXT := NULL;
  v_prof_region_id UUID := NULL;
  v_resolved TEXT := NULL;
  v_lookup_reg_id UUID := NULL;
  v_reg_name TEXT := NULL;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  v_role := public.current_user_role();
  IF v_role = '__INACTIVE__' THEN
    RETURN '__INACTIVE__';
  END IF;

  IF public.is_global_admin() THEN
    RETURN NULL;
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    SELECT
      p.region,
      p.sucursal::TEXT,
      p.region_id
    INTO v_prof_region, v_prof_sucursal, v_prof_region_id
    FROM public.profiles p
    WHERE p.id = v_uid
       OR (v_jwt_email <> '' AND LOWER(BTRIM(COALESCE(p.email, ''))) = v_jwt_email)
    ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
    LIMIT 1;
  END IF;

  -- 1) Prioridad a texto explícito en `public.profiles` -> `app_metadata`
  v_resolved := COALESCE(
    public.fn_trade_normalize_region_token(v_prof_region),
    public.fn_trade_normalize_region_token(v_prof_sucursal),
    public.fn_trade_normalize_region_token(v_jwt_region),
    public.fn_trade_normalize_region_token(v_jwt_sucursal)
  );

  IF v_resolved IS NOT NULL THEN
    RETURN v_resolved;
  END IF;

  -- 2) Respaldo mediante UUID `region_id` consultando `public."Regiones"`
  IF v_jwt_region_id_txt ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_jwt_region_id := v_jwt_region_id_txt::UUID;
  END IF;

  v_lookup_reg_id := COALESCE(v_prof_region_id, v_jwt_region_id);
  IF v_lookup_reg_id IS NOT NULL AND to_regclass('public."Regiones"') IS NOT NULL THEN
    SELECT regi_desd INTO v_reg_name
    FROM public."Regiones"
    WHERE id_regi = v_lookup_reg_id
    LIMIT 1;

    v_resolved := public.fn_trade_normalize_region_token(v_reg_name);
    IF v_resolved IS NOT NULL THEN
      RETURN v_resolved;
    END IF;
  END IF;

  -- 3) Respaldo para promotoras registradas en `public.promotoras`
  IF v_role = 'promotora' AND to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT p.region, p.region_id
    INTO v_prof_region, v_prof_region_id
    FROM public.promotoras p
    WHERE p.auth_user_id = v_uid
       OR (v_jwt_email <> '' AND LOWER(BTRIM(COALESCE(p.correo, ''))) = v_jwt_email)
    ORDER BY CASE WHEN p.auth_user_id = v_uid THEN 0 ELSE 1 END ASC
    LIMIT 1;

    v_resolved := public.fn_trade_normalize_region_token(v_prof_region);
    IF v_resolved IS NOT NULL THEN
      RETURN v_resolved;
    END IF;

    IF v_prof_region_id IS NOT NULL AND to_regclass('public."Regiones"') IS NOT NULL THEN
      SELECT regi_desd INTO v_reg_name
      FROM public."Regiones"
      WHERE id_regi = v_prof_region_id
      LIMIT 1;
      RETURN public.fn_trade_normalize_region_token(v_reg_name);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.current_user_region() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_region() TO authenticated, service_role;

-- Identifica coordinadores regionales Trade (excluyendo administradores globales).
CREATE OR REPLACE FUNCTION public.fn_trade_is_regional_coordinator()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT auth.uid()) IS NOT NULL
    AND NOT public.is_global_admin()
    AND public.current_user_role() IN (
      'coordinador_trade',
      'coordinadora_trade',
      'coordinacion',
      'coordinador',
      'jefe_trade',
      'supervisor'
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_regional_coordinator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_regional_coordinator() TO authenticated, service_role;

-- Evalúa estrictamente (fail-closed) si una fila pertenece a la región asignada del usuario.
-- También rechaza filas inconsistentes donde `region` y `sucursal` o `region_id` se contradigan.
CREATE OR REPLACE FUNCTION public.fn_trade_region_matches_actor(
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
  v_actor_region TEXT;
  v_reg_from_text TEXT;
  v_reg_from_suc TEXT;
  v_reg_from_id TEXT;
  v_reg_desc TEXT;
  v_row_region TEXT;
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

  v_actor_region := public.current_user_region();
  IF v_actor_region IS NULL OR v_actor_region = '' OR v_actor_region = '__INACTIVE__' THEN
    RETURN false;
  END IF;

  v_reg_from_text := public.fn_trade_normalize_region_token(p_region);
  v_reg_from_suc := public.fn_trade_normalize_region_token(p_sucursal);
  v_reg_from_id := NULL;

  IF p_region_id IS NOT NULL AND to_regclass('public."Regiones"') IS NOT NULL THEN
    SELECT regi_desd INTO v_reg_desc
    FROM public."Regiones"
    WHERE id_regi = p_region_id
    LIMIT 1;
    v_reg_from_id := public.fn_trade_normalize_region_token(v_reg_desc);
  END IF;

  -- Bloquear intentos de contradicción entre columnas regionales (ej. region='Occidente' + sucursal='VALENCIA')
  IF v_reg_from_text IS NOT NULL AND v_reg_from_suc IS NOT NULL AND v_reg_from_text <> v_reg_from_suc THEN
    RETURN false;
  END IF;

  IF v_reg_from_text IS NOT NULL AND v_reg_from_id IS NOT NULL AND v_reg_from_text <> v_reg_from_id THEN
    RETURN false;
  END IF;

  IF v_reg_from_suc IS NOT NULL AND v_reg_from_id IS NOT NULL AND v_reg_from_suc <> v_reg_from_id THEN
    RETURN false;
  END IF;

  v_row_region := COALESCE(v_reg_from_text, v_reg_from_suc, v_reg_from_id);
  IF v_row_region IS NULL THEN
    RETURN false;
  END IF;

  RETURN v_row_region = v_actor_region;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_region_matches_actor(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_region_matches_actor(TEXT, TEXT, UUID) TO authenticated, service_role;

-- Helper para gestión de tablas operativas Trade (Admin Global -> todo; Coordinador -> solo su región).
CREATE OR REPLACE FUNCTION public.fn_trade_can_manage_region(
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL,
  p_region_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_global_admin()
    OR (
      public.fn_trade_is_regional_coordinator()
      AND public.fn_trade_region_matches_actor(p_region, p_sucursal, p_region_id)
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_can_manage_region(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_can_manage_region(TEXT, TEXT, UUID) TO authenticated, service_role;

-- Helper para entregas logísticas (Choferes mantienen acceso intacto; Coordinador solo su región).
CREATE OR REPLACE FUNCTION public.fn_trade_can_deliver_region(
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.fn_trade_can_manage_region(p_region, p_sucursal, NULL)
    OR (
      (SELECT auth.uid()) IS NOT NULL
      AND public.current_user_role() IN ('chofer', 'logistica', 'despacho')
      AND (
        public.current_user_region() IS NULL
        OR public.fn_trade_region_matches_actor(p_region, p_sucursal, NULL)
      )
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_can_deliver_region(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_can_deliver_region(TEXT, TEXT) TO authenticated, service_role;

-- Helper para catálogos ERP compartidos (`"Clientes"`, `"Vendedores"`, `"Sucursales"`, etc.):
--   - Admin Global / Contraloría global: acceso completo.
--   - Coordinador regional (ej. Grecia -> 'OCCIDENTE') o cualquier rol con región asignada: SOLO su región.
--   - Usuario ERP legacy sin rol Trade y sin región restringida: mantiene lectura ERP sin regresiones.
CREATE OR REPLACE FUNCTION public.fn_trade_erp_catalog_region_allowed(
  p_region TEXT DEFAULT NULL,
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
  v_actor_region TEXT;
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

  v_actor_region := public.current_user_region();

  -- Contraloría nacional sin región asignada mantiene visibilidad nacional de lectura
  IF v_role IN ('contraloria', 'analista_contraloria', 'contralor') AND v_actor_region IS NULL THEN
    RETURN true;
  END IF;

  -- Si el actor tiene región asignada (ej. Grecia = 'OCCIDENTE'), aislamiento estricto fail-closed
  IF v_actor_region IS NOT NULL THEN
    RETURN public.fn_trade_region_matches_actor(p_region, NULL, p_region_id);
  END IF;

  -- Si es coordinador Trade pero carece de región configurada, fail-closed por seguridad
  IF public.fn_trade_is_regional_coordinator() THEN
    RETURN false;
  END IF;

  -- Usuario ERP legacy (sin perfil Trade ni rol regional): mantener compatibilidad ERP
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_erp_catalog_region_allowed(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_erp_catalog_region_allowed(TEXT, UUID) TO authenticated, service_role;

-- Sincronizar helpers heredados para evitar recursión y mantener compatibilidad con RPCs existentes
CREATE OR REPLACE FUNCTION public.fn_trade_current_actor_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_user_role();
$$;

REVOKE ALL ON FUNCTION public.fn_trade_current_actor_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_current_actor_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_current_promotora_id()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_jwt_email TEXT := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_promotora_id TEXT := NULL;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT p.id::TEXT
    INTO v_promotora_id
    FROM public.promotoras p
    WHERE COALESCE(p.activo, true) = true
      AND (
        p.auth_user_id = v_uid
        OR (v_jwt_email <> '' AND LOWER(BTRIM(COALESCE(p.correo, ''))) = v_jwt_email)
      )
    ORDER BY CASE WHEN p.auth_user_id = v_uid THEN 0 ELSE 1 END ASC
    LIMIT 1;
  END IF;

  IF v_promotora_id IS NOT NULL AND v_promotora_id <> '' THEN
    RETURN v_promotora_id;
  END IF;

  RETURN NULLIF(BTRIM(COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'staff_id', '')), '');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_current_promotora_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_current_promotora_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_is_manager_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_global_admin() OR public.fn_trade_is_regional_coordinator();
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_manager_or_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_manager_or_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_is_chofer_or_manager()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_global_admin()
    OR public.fn_trade_is_regional_coordinator()
    OR (
      (SELECT auth.uid()) IS NOT NULL
      AND public.current_user_role() IN ('chofer', 'logistica', 'despacho')
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_chofer_or_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_chofer_or_manager() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_is_promotora_owner(
  p_promotora_email TEXT,
  p_promotora_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_global_admin()
    OR (
      (SELECT auth.uid()) IS NOT NULL
      AND public.current_user_role() <> '__INACTIVE__'
      AND (
        (
          p_promotora_email IS NOT NULL
          AND BTRIM(p_promotora_email) <> ''
          AND LOWER(BTRIM(p_promotora_email)) = LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
        )
        OR (
          p_promotora_id IS NOT NULL
          AND p_promotora_id = (SELECT auth.uid())
        )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_promotora_owner(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_promotora_owner(TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_is_promotora_owner(
  p_auth_uid UUID,
  p_promotora_id TEXT,
  p_creator_or_email TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT auth.uid()) IS NOT NULL
    AND public.current_user_role() <> '__INACTIVE__'
    AND (
      (p_auth_uid IS NOT NULL AND p_auth_uid = (SELECT auth.uid()))
      OR (
        NULLIF(BTRIM(COALESCE(p_promotora_id, '')), '') IS NOT NULL
        AND BTRIM(p_promotora_id) = COALESCE(public.fn_trade_current_promotora_id(), '__NONE__')
      )
      OR (
        NULLIF(LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', ''))), '') IS NOT NULL
        AND LOWER(BTRIM(COALESCE(p_creator_or_email, ''))) = LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
      )
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_promotora_owner(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_promotora_owner(UUID, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_authenticated_catalog_read(
  p_region_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    CASE
      WHEN p_region_id IS NOT NULL THEN public.fn_trade_erp_catalog_region_allowed(NULL, p_region_id)
      ELSE (SELECT auth.uid()) IS NOT NULL AND public.current_user_role() <> '__INACTIVE__'
    END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_authenticated_catalog_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_authenticated_catalog_read(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 3. POLÍTICAS RLS ESTRICTAS EN TABLAS DE IDENTIDAD Y PERSONAL
-- ------------------------------------------------------------------------------

-- 3.1 `public.profiles`: BLOQUEAR auto-escalación de `role` / `region` / `sucursal` / `region_id`
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_profiles ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_insert_profiles ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_update_profiles ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_delete_profiles ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_restrict_profiles_write ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_restrict_profiles_select ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_restrict_profiles_insert ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_restrict_profiles_update ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_restrict_profiles_delete ON public.profiles;

    CREATE POLICY trade_rls_select_profiles
      ON public.profiles
      FOR SELECT
      TO authenticated
      USING (
        id = (SELECT auth.uid())
        OR (SELECT public.is_global_admin())
      );

    -- Solo administradores globales pueden crear, editar o borrar perfiles (impide a `coordinador_trade` alterar su rol o región)
    CREATE POLICY trade_rls_insert_profiles
      ON public.profiles
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.is_global_admin()));

    CREATE POLICY trade_rls_update_profiles
      ON public.profiles
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.is_global_admin()))
      WITH CHECK ((SELECT public.is_global_admin()));

    CREATE POLICY trade_rls_delete_profiles
      ON public.profiles
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_global_admin()));

    -- Guardrails RESTRICTIVE por comando: ninguna política heredada puede abrir lectura o escritura indebida en `profiles`
    CREATE POLICY trade_rls_restrict_profiles_select
      ON public.profiles
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (
        id = (SELECT auth.uid())
        OR (SELECT public.is_global_admin())
      );

    CREATE POLICY trade_rls_restrict_profiles_insert
      ON public.profiles
      AS RESTRICTIVE
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.is_global_admin()));

    CREATE POLICY trade_rls_restrict_profiles_update
      ON public.profiles
      AS RESTRICTIVE
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.is_global_admin()))
      WITH CHECK ((SELECT public.is_global_admin()));

    CREATE POLICY trade_rls_restrict_profiles_delete
      ON public.profiles
      AS RESTRICTIVE
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_global_admin()));
  END IF;
END
$$;

-- 3.2 `public.promotoras`: Aislamiento estricto por región (`OCCIDENTE` = 24 promotoras)
DO $$
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.promotoras FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.promotoras TO authenticated;
    ALTER TABLE public.promotoras ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_promotoras ON public.promotoras;
    DROP POLICY IF EXISTS trade_rls_insert_promotoras ON public.promotoras;
    DROP POLICY IF EXISTS trade_rls_update_promotoras ON public.promotoras;
    DROP POLICY IF EXISTS trade_norm_select_promotoras_authenticated ON public.promotoras;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_promotoras ON public.promotoras;

    CREATE POLICY trade_rls_select_promotoras
      ON public.promotoras
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR (
          (SELECT public.fn_trade_is_regional_coordinator())
          AND public.fn_trade_region_matches_actor(region, NULL, region_id)
        )
        OR (
          (SELECT auth.uid()) IS NOT NULL
          AND (SELECT public.current_user_role()) <> '__INACTIVE__'
          AND (
            auth_user_id = (SELECT auth.uid())
            OR (
              NULLIF(LOWER(BTRIM(COALESCE(correo, ''))), '') IS NOT NULL
              AND LOWER(BTRIM(correo)) = LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
            )
          )
        )
        OR (
          (SELECT public.current_user_role()) IN ('contraloria', 'analista_contraloria', 'contralor', 'chofer', 'logistica', 'despacho')
          AND (
            (SELECT public.current_user_region()) IS NULL
            OR public.fn_trade_region_matches_actor(region, NULL, region_id)
          )
        )
      );

    CREATE POLICY trade_rls_insert_promotoras
      ON public.promotoras
      FOR INSERT
      TO authenticated
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, region_id)
      );

    CREATE POLICY trade_rls_update_promotoras
      ON public.promotoras
      FOR UPDATE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, NULL, region_id)
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, region_id)
      );

    -- Guardrail RESTRICTIVE: impide que cualquier política heredada muestre Valencia a Grecia
    CREATE POLICY trade_rls_restrict_regional_promotoras
      ON public.promotoras
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR (
          NOT (SELECT public.fn_trade_is_regional_coordinator())
          AND (SELECT public.current_user_region()) IS NULL
          AND (SELECT public.current_user_role()) <> '__INACTIVE__'
        )
        OR public.fn_trade_region_matches_actor(region, NULL, region_id)
        OR auth_user_id = (SELECT auth.uid())
        OR (
          NOT (SELECT public.fn_trade_is_regional_coordinator())
          AND NULLIF(LOWER(BTRIM(COALESCE(correo, ''))), '') IS NOT NULL
          AND LOWER(BTRIM(correo)) = LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
        )
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, region_id)
      );
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 4. POLÍTICAS RLS EN CATÁLOGOS MAESTROS ERP REGIONALES + GLOBALES (SOLO SELECT)
-- ------------------------------------------------------------------------------

DO $$
DECLARE
  global_tbl TEXT;
  global_catalog_tables TEXT[] := ARRAY[
    'Productos',
    'Marcas',
    'Grupo_Productos',
    'Familia_Productos',
    'Tipificacion_Clientes',
    'Canal_Comercializacion',
    'Canales_Ventas',
    'Frecuencia_Visita'
  ];
BEGIN
  GRANT USAGE ON SCHEMA public TO authenticated;

  -- 4.1 Tablas catálogo globales compartidas (SOLO SELECT para no romper joins de Occidente)
  FOREACH global_tbl IN ARRAY global_catalog_tables LOOP
    IF to_regclass(format('public.%I', global_tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', global_tbl);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', global_tbl);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', global_tbl);

      EXECUTE format('DROP POLICY IF EXISTS trade_rls_select_%s ON public.%I', lower(global_tbl), global_tbl);
      EXECUTE format(
        'CREATE POLICY trade_rls_select_%s ON public.%I FOR SELECT TO authenticated USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT public.current_user_role()) <> ''__INACTIVE__'')',
        lower(global_tbl),
        global_tbl
      );
    END IF;
  END LOOP;

  -- 4.2 `public."Regiones"`: Grecia solo ve OCCIDENTE (1 fila)
  IF to_regclass('public."Regiones"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Regiones" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Regiones" TO authenticated;
    ALTER TABLE public."Regiones" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_authenticated_read_regiones ON public."Regiones";
    DROP POLICY IF EXISTS trade_rls_select_regiones ON public."Regiones";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_regiones ON public."Regiones";

    CREATE POLICY trade_rls_select_regiones
      ON public."Regiones"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(regi_desd, id_regi));

    CREATE POLICY trade_rls_restrict_regional_regiones
      ON public."Regiones"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(regi_desd, id_regi));
  END IF;

  -- 4.3 `public."Clientes"`: Grecia solo ve los 3,566 clientes de OCCIDENTE (0 de Centro/Valencia)
  IF to_regclass('public."Clientes"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Clientes" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Clientes" TO authenticated;
    ALTER TABLE public."Clientes" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_authenticated_read_clientes ON public."Clientes";
    DROP POLICY IF EXISTS trade_rls_select_clientes ON public."Clientes";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_clientes ON public."Clientes";

    CREATE POLICY trade_rls_select_clientes
      ON public."Clientes"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, clie_regi));

    CREATE POLICY trade_rls_restrict_regional_clientes
      ON public."Clientes"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, clie_regi));
  END IF;

  -- 4.4 `public."Supervisores"`: filtrado por `id_regi`
  IF to_regclass('public."Supervisores"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Supervisores" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Supervisores" TO authenticated;
    ALTER TABLE public."Supervisores" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_authenticated_read_supervisores ON public."Supervisores";
    DROP POLICY IF EXISTS trade_rls_select_supervisores ON public."Supervisores";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_supervisores ON public."Supervisores";

    CREATE POLICY trade_rls_select_supervisores
      ON public."Supervisores"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));

    CREATE POLICY trade_rls_restrict_regional_supervisores
      ON public."Supervisores"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));
  END IF;

  -- 4.5 `public."Sucursales"`: filtrado por `id_regi` (Zulia, Falcón, Trujillo para Occidente)
  IF to_regclass('public."Sucursales"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Sucursales" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Sucursales" TO authenticated;
    ALTER TABLE public."Sucursales" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_authenticated_read_sucursales ON public."Sucursales";
    DROP POLICY IF EXISTS trade_rls_select_sucursales ON public."Sucursales";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_sucursales ON public."Sucursales";

    CREATE POLICY trade_rls_select_sucursales
      ON public."Sucursales"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));

    CREATE POLICY trade_rls_restrict_regional_sucursales
      ON public."Sucursales"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));
  END IF;

  -- 4.6 `public."Vendedores"`: filtrado mediante FK `id_sucu` -> `public."Sucursales".id_regi` (49 Occidente)
  IF to_regclass('public."Vendedores"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Vendedores" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Vendedores" TO authenticated;
    ALTER TABLE public."Vendedores" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_authenticated_read_vendedores ON public."Vendedores";
    DROP POLICY IF EXISTS trade_rls_select_vendedores ON public."Vendedores";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_vendedores ON public."Vendedores";

    CREATE POLICY trade_rls_select_vendedores
      ON public."Vendedores"
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR (
          NOT (SELECT public.fn_trade_is_regional_coordinator())
          AND (SELECT public.current_user_region()) IS NULL
          AND (SELECT public.current_user_role()) <> '__INACTIVE__'
        )
        OR EXISTS (
          SELECT 1
          FROM public."Sucursales" s
          WHERE s.id_sucu = "Vendedores".id_sucu
            AND public.fn_trade_erp_catalog_region_allowed(NULL, s.id_regi)
        )
      );

    CREATE POLICY trade_rls_restrict_regional_vendedores
      ON public."Vendedores"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR (
          NOT (SELECT public.fn_trade_is_regional_coordinator())
          AND (SELECT public.current_user_region()) IS NULL
          AND (SELECT public.current_user_role()) <> '__INACTIVE__'
        )
        OR EXISTS (
          SELECT 1
          FROM public."Sucursales" s
          WHERE s.id_sucu = "Vendedores".id_sucu
            AND public.fn_trade_erp_catalog_region_allowed(NULL, s.id_regi)
        )
      );
  END IF;

  -- 4.7 `public."Estados"`: filtrado por `id_regi`
  IF to_regclass('public."Estados"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Estados" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Estados" TO authenticated;
    ALTER TABLE public."Estados" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_authenticated_read_estados ON public."Estados";
    DROP POLICY IF EXISTS trade_rls_select_estados ON public."Estados";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_estados ON public."Estados";

    CREATE POLICY trade_rls_select_estados
      ON public."Estados"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));

    CREATE POLICY trade_rls_restrict_regional_estados
      ON public."Estados"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));
  END IF;

  -- 4.8 `public."Municipios"`: filtrado por `id_regi`
  IF to_regclass('public."Municipios"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Municipios" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Municipios" TO authenticated;
    ALTER TABLE public."Municipios" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_authenticated_read_municipios ON public."Municipios";
    DROP POLICY IF EXISTS trade_rls_select_municipios ON public."Municipios";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_municipios ON public."Municipios";

    CREATE POLICY trade_rls_select_municipios
      ON public."Municipios"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));

    CREATE POLICY trade_rls_restrict_regional_municipios
      ON public."Municipios"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));
  END IF;

  -- 4.9 `public."Forecast_Zonas_Region"`, `public."Forecast_Vendedores_Excluidos"`, `public."Productos_Regiones"`
  IF to_regclass('public."Forecast_Zonas_Region"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Forecast_Zonas_Region" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Forecast_Zonas_Region" TO authenticated;
    ALTER TABLE public."Forecast_Zonas_Region" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_forecast_zonas_region ON public."Forecast_Zonas_Region";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_forecast_zonas_region ON public."Forecast_Zonas_Region";

    CREATE POLICY trade_rls_select_forecast_zonas_region
      ON public."Forecast_Zonas_Region"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));

    CREATE POLICY trade_rls_restrict_regional_forecast_zonas_region
      ON public."Forecast_Zonas_Region"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));
  END IF;

  IF to_regclass('public."Forecast_Vendedores_Excluidos"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Forecast_Vendedores_Excluidos" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Forecast_Vendedores_Excluidos" TO authenticated;
    ALTER TABLE public."Forecast_Vendedores_Excluidos" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_authenticated_read_forecast_vendedores_excluidos ON public."Forecast_Vendedores_Excluidos";
    DROP POLICY IF EXISTS trade_rls_select_forecast_vendedores_excluidos ON public."Forecast_Vendedores_Excluidos";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_forecast_vendedores_excluidos ON public."Forecast_Vendedores_Excluidos";

    CREATE POLICY trade_rls_select_forecast_vendedores_excluidos
      ON public."Forecast_Vendedores_Excluidos"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));

    CREATE POLICY trade_rls_restrict_regional_forecast_vendedores_excluidos
      ON public."Forecast_Vendedores_Excluidos"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));
  END IF;

  IF to_regclass('public."Productos_Regiones"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."Productos_Regiones" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Productos_Regiones" TO authenticated;
    ALTER TABLE public."Productos_Regiones" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_productos_regiones ON public."Productos_Regiones";
    DROP POLICY IF EXISTS trade_rls_restrict_regional_productos_regiones ON public."Productos_Regiones";

    CREATE POLICY trade_rls_select_productos_regiones
      ON public."Productos_Regiones"
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));

    CREATE POLICY trade_rls_restrict_regional_productos_regiones
      ON public."Productos_Regiones"
      AS RESTRICTIVE
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_erp_catalog_region_allowed(NULL, id_regi));
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 5. POLÍTICAS RLS EN TABLAS OPERATIVAS TRADE (DEGUSTACIONES, INFORME, ASISTENCIA)
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  -- 5.1 `public.cronograma_degustaciones`
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.cronograma_degustaciones FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cronograma_degustaciones TO authenticated;
    ALTER TABLE public.cronograma_degustaciones ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_cronograma ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS trade_rls_insert_cronograma ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS trade_rls_update_cronograma ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS trade_rls_delete_cronograma_qa_only ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_cronograma ON public.cronograma_degustaciones;

    CREATE POLICY trade_rls_select_cronograma
      ON public.cronograma_degustaciones
      FOR SELECT
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        OR public.fn_trade_is_promotora_owner(promotora_email, promotora_id)
      );

    CREATE POLICY trade_rls_insert_cronograma
      ON public.cronograma_degustaciones
      FOR INSERT
      TO authenticated
      WITH CHECK (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
      );

    CREATE POLICY trade_rls_update_cronograma
      ON public.cronograma_degustaciones
      FOR UPDATE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
      );

    CREATE POLICY trade_rls_delete_cronograma_qa_only
      ON public.cronograma_degustaciones
      FOR DELETE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        AND COALESCE(observaciones, '') ILIKE '%[QA-TEST]%'
      );

    CREATE POLICY trade_rls_restrict_regional_cronograma
      ON public.cronograma_degustaciones
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, sucursal, NULL)
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, sucursal, NULL)
      );
  END IF;

  -- 5.2 `public.rutas_promotoras`
  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.rutas_promotoras FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rutas_promotoras TO authenticated;
    ALTER TABLE public.rutas_promotoras ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_rutas_promotoras ON public.rutas_promotoras;
    DROP POLICY IF EXISTS trade_rls_insert_rutas_promotoras ON public.rutas_promotoras;
    DROP POLICY IF EXISTS trade_rls_update_rutas_promotoras ON public.rutas_promotoras;
    DROP POLICY IF EXISTS trade_rls_delete_rutas_promotoras_qa_only ON public.rutas_promotoras;
    DROP POLICY IF EXISTS rutas_promotoras_portal_self_select_auth ON public.rutas_promotoras;
    DROP POLICY IF EXISTS rutas_promotoras_portal_self_update_auth ON public.rutas_promotoras;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_rutas_promotoras ON public.rutas_promotoras;

    CREATE POLICY trade_rls_select_rutas_promotoras
      ON public.rutas_promotoras
      FOR SELECT
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, promotora_email)
      );

    CREATE POLICY trade_rls_insert_rutas_promotoras
      ON public.rutas_promotoras
      FOR INSERT
      TO authenticated
      WITH CHECK (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
      );

    CREATE POLICY trade_rls_update_rutas_promotoras
      ON public.rutas_promotoras
      FOR UPDATE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, promotora_email)
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, promotora_email)
      );

    CREATE POLICY trade_rls_delete_rutas_promotoras_qa_only
      ON public.rutas_promotoras
      FOR DELETE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        AND COALESCE(observaciones, '') ILIKE '%[QA-TEST]%'
      );

    CREATE POLICY trade_rls_restrict_regional_rutas_promotoras
      ON public.rutas_promotoras
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, sucursal, NULL)
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, sucursal, NULL)
      );
  END IF;

  -- 5.3 `public.entregas_degustacion`
  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.entregas_degustacion FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.entregas_degustacion TO authenticated;
    ALTER TABLE public.entregas_degustacion ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_insert_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_update_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_delete_entregas_degustacion_qa_only ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_entregas ON public.entregas_degustacion;

    CREATE POLICY trade_rls_select_entregas_degustacion
      ON public.entregas_degustacion
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_can_deliver_region(region, sucursal));

    CREATE POLICY trade_rls_insert_entregas_degustacion
      ON public.entregas_degustacion
      FOR INSERT
      TO authenticated
      WITH CHECK (public.fn_trade_can_manage_region(region, sucursal, NULL));

    CREATE POLICY trade_rls_update_entregas_degustacion
      ON public.entregas_degustacion
      FOR UPDATE
      TO authenticated
      USING (public.fn_trade_can_deliver_region(region, sucursal))
      WITH CHECK (public.fn_trade_can_deliver_region(region, sucursal));

    CREATE POLICY trade_rls_delete_entregas_degustacion_qa_only
      ON public.entregas_degustacion
      FOR DELETE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        AND COALESCE(notas_chofer, '') ILIKE '%[QA-TEST]%'
      );

    CREATE POLICY trade_rls_restrict_regional_entregas
      ON public.entregas_degustacion
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, sucursal, NULL)
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, sucursal, NULL)
      );
  END IF;

  -- 5.4 `public.inventory` (Módulo 1 -> Pestaña Informe: Inventario y degustaciones)
  IF to_regclass('public.inventory') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.inventory FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory TO authenticated;
    ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS inventory_portal_select_auth ON public.inventory;
    DROP POLICY IF EXISTS inventory_portal_insert_auth ON public.inventory;
    DROP POLICY IF EXISTS inventory_portal_update_auth ON public.inventory;
    DROP POLICY IF EXISTS inventory_portal_delete_auth ON public.inventory;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_inventory ON public.inventory;

    CREATE POLICY inventory_portal_select_auth
      ON public.inventory
      FOR SELECT
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
      );

    CREATE POLICY inventory_portal_insert_auth
      ON public.inventory
      FOR INSERT
      TO authenticated
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR (
          auth_user_id = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      );

    CREATE POLICY inventory_portal_update_auth
      ON public.inventory
      FOR UPDATE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR (
          auth_user_id = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      );

    CREATE POLICY inventory_portal_delete_auth
      ON public.inventory
      FOR DELETE
      TO authenticated
      USING (public.fn_trade_can_manage_region(region, NULL, NULL));

    CREATE POLICY trade_rls_restrict_regional_inventory
      ON public.inventory
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, NULL, NULL)
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, NULL, NULL)
      );
  END IF;

  -- 5.5 `public.asistencias_jornada` (Módulo 1 -> Pestaña Informe: Asistencia)
  IF to_regclass('public.asistencias_jornada') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.asistencias_jornada FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asistencias_jornada TO authenticated;
    ALTER TABLE public.asistencias_jornada ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS asistencias_jornada_portal_select_auth ON public.asistencias_jornada;
    DROP POLICY IF EXISTS asistencias_jornada_portal_insert_auth ON public.asistencias_jornada;
    DROP POLICY IF EXISTS asistencias_jornada_portal_update_auth ON public.asistencias_jornada;
    DROP POLICY IF EXISTS asistencias_jornada_portal_delete_auth ON public.asistencias_jornada;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_asistencias_jornada ON public.asistencias_jornada;

    CREATE POLICY asistencias_jornada_portal_select_auth
      ON public.asistencias_jornada
      FOR SELECT
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, NULL)
      );

    CREATE POLICY asistencias_jornada_portal_insert_auth
      ON public.asistencias_jornada
      FOR INSERT
      TO authenticated
      WITH CHECK (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        OR (
          auth_user_id = (SELECT auth.uid())
          AND COALESCE(opened_by_uid, (SELECT auth.uid())) = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, NULL)
        )
      );

    CREATE POLICY asistencias_jornada_portal_update_auth
      ON public.asistencias_jornada
      FOR UPDATE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, NULL)
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, sucursal, NULL)
        OR (
          auth_user_id = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::TEXT, NULL)
        )
      );

    CREATE POLICY asistencias_jornada_portal_delete_auth
      ON public.asistencias_jornada
      FOR DELETE
      TO authenticated
      USING (public.fn_trade_can_manage_region(region, sucursal, NULL));

    CREATE POLICY trade_rls_restrict_regional_asistencias_jornada
      ON public.asistencias_jornada
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, sucursal, NULL)
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, sucursal, NULL)
      );
  END IF;

  -- 5.6 `public.asistencia_evidencias` (doble validación: propia + FK `asistencia_id` -> `asistencias_jornada`)
  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.asistencia_evidencias FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asistencia_evidencias TO authenticated;
    ALTER TABLE public.asistencia_evidencias ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS asistencia_evidencias_portal_select_auth ON public.asistencia_evidencias;
    DROP POLICY IF EXISTS asistencia_evidencias_portal_insert_auth ON public.asistencia_evidencias;
    DROP POLICY IF EXISTS asistencia_evidencias_portal_update_auth ON public.asistencia_evidencias;
    DROP POLICY IF EXISTS asistencia_evidencias_portal_delete_auth ON public.asistencia_evidencias;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_asistencia_evidencias ON public.asistencia_evidencias;

    CREATE POLICY asistencia_evidencias_portal_select_auth
      ON public.asistencia_evidencias
      FOR SELECT
      TO authenticated
      USING (
        (
          public.fn_trade_can_manage_region(region, sucursal, NULL)
          AND EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_can_manage_region(j.region, j.sucursal, NULL)
          )
        )
        OR EXISTS (
          SELECT 1 FROM public.asistencias_jornada j
          WHERE j.id = asistencia_id
            AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::TEXT, NULL)
        )
      );

    CREATE POLICY asistencia_evidencias_portal_insert_auth
      ON public.asistencia_evidencias
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (
          public.fn_trade_can_manage_region(region, sucursal, NULL)
          AND EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_can_manage_region(j.region, j.sucursal, NULL)
          )
        )
        OR (
          cargado_por_uid = (SELECT auth.uid())
          AND EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::TEXT, NULL)
          )
        )
      );

    CREATE POLICY asistencia_evidencias_portal_update_auth
      ON public.asistencia_evidencias
      FOR UPDATE
      TO authenticated
      USING (
        (
          public.fn_trade_can_manage_region(region, sucursal, NULL)
          AND EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_can_manage_region(j.region, j.sucursal, NULL)
          )
        )
        OR EXISTS (
          SELECT 1 FROM public.asistencias_jornada j
          WHERE j.id = asistencia_id
            AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::TEXT, NULL)
        )
      )
      WITH CHECK (
        (
          public.fn_trade_can_manage_region(region, sucursal, NULL)
          AND EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_can_manage_region(j.region, j.sucursal, NULL)
          )
        )
        OR (
          cargado_por_uid = (SELECT auth.uid())
          AND EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::TEXT, NULL)
          )
        )
      );

    CREATE POLICY asistencia_evidencias_portal_delete_auth
      ON public.asistencia_evidencias
      FOR DELETE
      TO authenticated
      USING (public.fn_trade_can_manage_region(region, sucursal, NULL));

    CREATE POLICY trade_rls_restrict_regional_asistencia_evidencias
      ON public.asistencia_evidencias
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR (
          public.fn_trade_region_matches_actor(region, sucursal, NULL)
          AND EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_region_matches_actor(j.region, j.sucursal, NULL)
          )
        )
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR (
          public.fn_trade_region_matches_actor(region, sucursal, NULL)
          AND EXISTS (
            SELECT 1 FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_region_matches_actor(j.region, j.sucursal, NULL)
          )
        )
      );
  END IF;

  -- 5.7 `public.prices`
  IF to_regclass('public.prices') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.prices FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prices TO authenticated;
    ALTER TABLE public.prices ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS prices_portal_select_auth ON public.prices;
    DROP POLICY IF EXISTS prices_portal_insert_auth ON public.prices;
    DROP POLICY IF EXISTS prices_portal_update_auth ON public.prices;
    DROP POLICY IF EXISTS prices_portal_delete_auth ON public.prices;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_prices ON public.prices;

    CREATE POLICY prices_portal_select_auth
      ON public.prices
      FOR SELECT
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
      );

    CREATE POLICY prices_portal_insert_auth
      ON public.prices
      FOR INSERT
      TO authenticated
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR (
          auth_user_id = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      );

    CREATE POLICY prices_portal_update_auth
      ON public.prices
      FOR UPDATE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR (
          auth_user_id = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      );

    CREATE POLICY prices_portal_delete_auth
      ON public.prices
      FOR DELETE
      TO authenticated
      USING (public.fn_trade_can_manage_region(region, NULL, NULL));

    CREATE POLICY trade_rls_restrict_regional_prices
      ON public.prices
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, NULL, NULL)
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, NULL, NULL)
      );
  END IF;

  -- 5.8 `public.surveys` (Degustaciones FDV + Merchandising + Encuestas)
  IF to_regclass('public.surveys') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.surveys FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.surveys TO authenticated;
    ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS surveys_portal_select_auth ON public.surveys;
    DROP POLICY IF EXISTS surveys_portal_insert_auth ON public.surveys;
    DROP POLICY IF EXISTS surveys_portal_update_auth ON public.surveys;
    DROP POLICY IF EXISTS surveys_portal_delete_auth ON public.surveys;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_surveys ON public.surveys;

    CREATE POLICY surveys_portal_select_auth
      ON public.surveys
      FOR SELECT
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
      );

    CREATE POLICY surveys_portal_insert_auth
      ON public.surveys
      FOR INSERT
      TO authenticated
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR (
          auth_user_id = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      );

    CREATE POLICY surveys_portal_update_auth
      ON public.surveys
      FOR UPDATE
      TO authenticated
      USING (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
      )
      WITH CHECK (
        public.fn_trade_can_manage_region(region, NULL, NULL)
        OR (
          auth_user_id = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")
        )
      );

    CREATE POLICY surveys_portal_delete_auth
      ON public.surveys
      FOR DELETE
      TO authenticated
      USING (public.fn_trade_can_manage_region(region, NULL, NULL));

    CREATE POLICY trade_rls_restrict_regional_surveys
      ON public.surveys
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, NULL, NULL)
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR NOT (SELECT public.fn_trade_is_regional_coordinator())
        OR public.fn_trade_region_matches_actor(region, NULL, NULL)
      );
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 6. PROTECCIÓN CONDICIONAL DE TABLAS NORMALIZADAS OPCIONALES (SI EXISTEN)
-- ------------------------------------------------------------------------------

DO $$
DECLARE
  opt_tbl TEXT;
  has_region BOOLEAN;
  has_sucursal BOOLEAN;
  has_region_id BOOLEAN;
  expr_region TEXT;
  expr_sucursal TEXT;
  expr_region_id TEXT;
  optional_regional_tables TEXT[] := ARRAY[
    'clientes',
    'vendedores',
    'zonas',
    'cadenas_comerciales',
    'staff',
    'solicitudes_contraloria',
    'material_pop_inventario',
    'material_pop_entregas',
    'incidencias_pdv'
  ];
BEGIN
  FOREACH opt_tbl IN ARRAY optional_regional_tables LOOP
    IF to_regclass(format('public.%I', opt_tbl)) IS NOT NULL THEN
      SELECT
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = opt_tbl AND column_name = 'region'),
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = opt_tbl AND column_name = 'sucursal'),
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = opt_tbl AND column_name = 'region_id')
      INTO has_region, has_sucursal, has_region_id;

      IF has_region OR has_sucursal OR has_region_id THEN
        expr_region := CASE WHEN has_region THEN 'region::text' ELSE 'NULL::text' END;
        expr_sucursal := CASE WHEN has_sucursal THEN 'sucursal::text' ELSE 'NULL::text' END;
        expr_region_id := CASE WHEN has_region_id THEN 'region_id::uuid' ELSE 'NULL::uuid' END;

        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', opt_tbl);
        EXECUTE format('DROP POLICY IF EXISTS trade_rls_restrict_regional_%s ON public.%I', opt_tbl, opt_tbl);
        EXECUTE format(
          'CREATE POLICY trade_rls_restrict_regional_%s ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_global_admin()) OR NOT (SELECT public.fn_trade_is_regional_coordinator()) OR public.fn_trade_region_matches_actor(%s, %s, %s)) WITH CHECK ((SELECT public.is_global_admin()) OR NOT (SELECT public.fn_trade_is_regional_coordinator()) OR public.fn_trade_region_matches_actor(%s, %s, %s))',
          opt_tbl,
          opt_tbl,
          expr_region,
          expr_sucursal,
          expr_region_id,
          expr_region,
          expr_sucursal,
          expr_region_id
        );
      END IF;
    END IF;
  END LOOP;
END
$$;

-- ------------------------------------------------------------------------------
-- 7. SUPABASE STORAGE: AISLAMIENTO REGIONAL EN `asistencia-evidencias` Y `entregas-evidencias`
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    -- 7.1 Bucket `asistencia-evidencias`
    DROP POLICY IF EXISTS asistencia_evidencias_storage_select_auth ON storage.objects;
    DROP POLICY IF EXISTS asistencia_evidencias_storage_insert_auth ON storage.objects;
    DROP POLICY IF EXISTS asistencia_evidencias_storage_update_auth ON storage.objects;
    DROP POLICY IF EXISTS asistencia_evidencias_storage_delete_auth ON storage.objects;

    CREATE POLICY asistencia_evidencias_storage_select_auth
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'asistencia-evidencias'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.fn_trade_is_regional_coordinator())
            AND (
              EXISTS (
                SELECT 1
                FROM public.asistencia_evidencias e
                WHERE e.storage_bucket = 'asistencia-evidencias'
                  AND e.storage_path = name
                  AND public.fn_trade_region_matches_actor(e.region, e.sucursal, NULL)
              )
              OR EXISTS (
                SELECT 1
                FROM public.promotoras p
                WHERE (
                  p.id::TEXT = (storage.foldername(name))[1]
                  OR p.auth_user_id::TEXT = (storage.foldername(name))[1]
                )
                  AND public.fn_trade_region_matches_actor(p.region, NULL, p.region_id)
              )
            )
          )
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::TEXT
          )
        )
      );

    CREATE POLICY asistencia_evidencias_storage_insert_auth
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'asistencia-evidencias'
        AND name NOT LIKE '%..%'
        AND name NOT LIKE '/%'
        AND (
          name ~ '^[A-Za-z0-9_-]{1,64}/(asistencia|inventario|degustacion|precios|merchandising)/[A-Za-z0-9_.-]{8,96}\.(jpg|jpeg|png|webp)$'
          OR name ~ '^[A-Za-z0-9_-]{1,64}/[0-9]{4}-[0-9]{2}-[0-9]{2}/[A-Za-z0-9_.-]{4,96}\.(jpg|jpeg|png|webp)$'
        )
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.fn_trade_is_regional_coordinator())
            AND EXISTS (
              SELECT 1
              FROM public.promotoras p
              WHERE (
                p.id::TEXT = (storage.foldername(name))[1]
                OR p.auth_user_id::TEXT = (storage.foldername(name))[1]
              )
                AND public.fn_trade_region_matches_actor(p.region, NULL, p.region_id)
            )
          )
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::TEXT
          )
        )
      );

    CREATE POLICY asistencia_evidencias_storage_update_auth
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (
        bucket_id = 'asistencia-evidencias'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.fn_trade_is_regional_coordinator())
            AND EXISTS (
              SELECT 1
              FROM public.promotoras p
              WHERE (
                p.id::TEXT = (storage.foldername(name))[1]
                OR p.auth_user_id::TEXT = (storage.foldername(name))[1]
              )
                AND public.fn_trade_region_matches_actor(p.region, NULL, p.region_id)
            )
          )
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::TEXT
          )
        )
      )
      WITH CHECK (
        bucket_id = 'asistencia-evidencias'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.fn_trade_is_regional_coordinator())
            AND EXISTS (
              SELECT 1
              FROM public.promotoras p
              WHERE (
                p.id::TEXT = (storage.foldername(name))[1]
                OR p.auth_user_id::TEXT = (storage.foldername(name))[1]
              )
                AND public.fn_trade_region_matches_actor(p.region, NULL, p.region_id)
            )
          )
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::TEXT
          )
        )
      );

    CREATE POLICY asistencia_evidencias_storage_delete_auth
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'asistencia-evidencias'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.fn_trade_is_regional_coordinator())
            AND EXISTS (
              SELECT 1
              FROM public.promotoras p
              WHERE (
                p.id::TEXT = (storage.foldername(name))[1]
                OR p.auth_user_id::TEXT = (storage.foldername(name))[1]
              )
                AND public.fn_trade_region_matches_actor(p.region, NULL, p.region_id)
            )
          )
        )
      );

    -- 7.2 Bucket `entregas-evidencias`
    DROP POLICY IF EXISTS trade_storage_select_entregas_evidencias ON storage.objects;
    DROP POLICY IF EXISTS trade_storage_insert_entregas_evidencias ON storage.objects;
    DROP POLICY IF EXISTS trade_storage_update_entregas_evidencias ON storage.objects;
    DROP POLICY IF EXISTS trade_storage_delete_entregas_evidencias ON storage.objects;

    CREATE POLICY trade_storage_select_entregas_evidencias
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.current_user_role()) IN ('chofer', 'logistica', 'despacho')
            AND (SELECT public.current_user_region()) IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM public.entregas_degustacion ed
            WHERE (ed.evidencia_path = name OR name LIKE ('entregas/' || ed.id::TEXT || '/%'))
              AND public.fn_trade_can_deliver_region(ed.region, ed.sucursal)
          )
        )
      );

    CREATE POLICY trade_storage_insert_entregas_evidencias
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.current_user_role()) IN ('chofer', 'logistica', 'despacho')
            AND (SELECT public.current_user_region()) IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM public.entregas_degustacion ed
            WHERE (ed.evidencia_path = name OR name LIKE ('entregas/' || ed.id::TEXT || '/%'))
              AND public.fn_trade_can_deliver_region(ed.region, ed.sucursal)
          )
        )
      );

    CREATE POLICY trade_storage_update_entregas_evidencias
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.current_user_role()) IN ('chofer', 'logistica', 'despacho')
            AND (SELECT public.current_user_region()) IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM public.entregas_degustacion ed
            WHERE (ed.evidencia_path = name OR name LIKE ('entregas/' || ed.id::TEXT || '/%'))
              AND public.fn_trade_can_deliver_region(ed.region, ed.sucursal)
          )
        )
      )
      WITH CHECK (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.current_user_role()) IN ('chofer', 'logistica', 'despacho')
            AND (SELECT public.current_user_region()) IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM public.entregas_degustacion ed
            WHERE (ed.evidencia_path = name OR name LIKE ('entregas/' || ed.id::TEXT || '/%'))
              AND public.fn_trade_can_deliver_region(ed.region, ed.sucursal)
          )
        )
      );

    CREATE POLICY trade_storage_delete_entregas_evidencias
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.fn_trade_is_regional_coordinator())
            AND EXISTS (
              SELECT 1
              FROM public.entregas_degustacion ed
              WHERE (ed.evidencia_path = name OR name LIKE ('entregas/' || ed.id::TEXT || '/%'))
                AND public.fn_trade_region_matches_actor(ed.region, ed.sucursal, NULL)
            )
          )
        )
      );
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

-- ==============================================================================
-- 8. BLOQUE DE VERIFICACIÓN SQL (LISTO PARA SUPABASE SQL EDITOR)
-- ==============================================================================

-- 8.1 Prueba lógica de normalización de regiones
SELECT
  public.fn_trade_normalize_region_token('Occidente') AS norm_occidente,
  public.fn_trade_normalize_region_token('  zulia ') AS norm_zulia,
  public.fn_trade_normalize_region_token('Valencia') AS norm_valencia,
  public.fn_trade_normalize_region_token('CENTRO') AS norm_centro,
  public.fn_trade_normalize_region_token('GLOBAL') AS norm_global;

-- 8.2 Distribución verificada de `public.promotoras` por región (esperado: 24 Occidente, 9 Valencia, 0 NULL)
SELECT
  COALESCE(region, 'NULL') AS region_asignada,
  COUNT(*) AS total_promotoras,
  COUNT(*) FILTER (WHERE region_id IS NOT NULL) AS con_region_id
FROM public.promotoras
GROUP BY COALESCE(region, 'NULL')
ORDER BY region_asignada;

-- 8.3 Conteo regional en catálogos ERP principales (`Clientes`, `Vendedores`, `Supervisores`)
SELECT
  r.regi_desd AS region_erp,
  (SELECT COUNT(*) FROM public."Clientes" c WHERE c.clie_regi = r.id_regi) AS total_clientes,
  (SELECT COUNT(*) FROM public."Vendedores" v JOIN public."Sucursales" s ON s.id_sucu = v.id_sucu WHERE s.id_regi = r.id_regi) AS total_vendedores,
  (SELECT COUNT(*) FROM public."Supervisores" sup WHERE sup.id_regi = r.id_regi) AS total_supervisores
FROM public."Regiones" r
ORDER BY r.regi_desd;

-- 8.4 Auditoría de políticas RLS activas (`PERMISSIVE` + `RESTRICTIVE`) en tablas Trade y ERP
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  cmd,
  roles
FROM pg_policies
WHERE (
  schemaname = 'public'
  AND tablename IN (
    'profiles',
    'promotoras',
    'Regiones',
    'Clientes',
    'Supervisores',
    'Sucursales',
    'Vendedores',
    'Estados',
    'Municipios',
    'Forecast_Zonas_Region',
    'Forecast_Vendedores_Excluidos',
    'Productos_Regiones',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'entregas_degustacion',
    'inventory',
    'asistencias_jornada',
    'asistencia_evidencias',
    'prices',
    'surveys'
  )
)
OR (
  schemaname = 'storage'
  AND tablename = 'objects'
  AND (policyname LIKE 'asistencia_evidencias_storage_%' OR policyname LIKE 'trade_storage_%')
)
ORDER BY schemaname, tablename, permissive DESC, cmd, policyname;
