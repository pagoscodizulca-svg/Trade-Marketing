-- ==============================================================================
-- MIGRACIÓN IDEMPOTENTE: PADRÓN DE PROMOTORAS ("Personal") + AUTH + RLS ESTRICTO
-- Archivo: supabase/migrations/20261128000200_promotoras_personal_auth_rls.sql
--
-- Objetivo:
--   1. Garantizar en `public.promotoras` las columnas `region`, `auth_user_id`,
--      `region_id` (vinculada a `public."Regiones"`), `direccion` nullable e índice
--      único insensible a mayúsculas sobre `LOWER(BTRIM(correo))`.
--   2. Implementar políticas RLS compensatorias de mínimo privilegio:
--      - CERO permisos a `anon` / `PUBLIC`.
--      - CERO políticas abiertas `USING (true)`.
--      - CERO decisiones de autorización basadas en `user_metadata`.
--      - Administradores / Coordinación / Contraloría: lectura y gestión según alcance.
--      - Promotoras autenticadas: únicamente `SELECT` de SU PROPIA FILA
--        (`auth_user_id = (SELECT auth.uid())` o correo del JWT), jamás modificar ni
--        eliminar perfiles propios o ajenos.
--   3. 100% idempotente y no destructiva (sin `TRUNCATE` ni `DROP TABLE`).
-- ==============================================================================

-- 1. Funciones helper `SECURITY INVOKER` optimizadas con `(SELECT auth.uid()/auth.jwt())`
CREATE OR REPLACE FUNCTION public.fn_trade_es_admin_personal()
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
            'supervisor'
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
    'supervisor'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_trade_es_promotora_propia(
  p_auth_user_id uuid,
  p_correo text
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
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  IF p_auth_user_id IS NOT NULL AND p_auth_user_id = v_uid THEN
    RETURN true;
  END IF;

  IF p_correo IS NOT NULL AND v_jwt_email <> '' AND LOWER(BTRIM(p_correo)) = v_jwt_email THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_trade_admin_acceso_region_promotora(
  p_region text,
  p_region_id uuid
)
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
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'region',
    ''
  )));
  v_profile_role text;
  v_profile_sucursal text;
  v_profile_region_id uuid;
  v_actor_region_label text;
  v_row_region_label text;
BEGIN
  IF v_uid IS NULL THEN
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

  -- Roles globales ven todas las regiones del padrón de Personal
  IF v_profile_role IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin')
     OR (v_profile_role IN ('contraloria', 'analista_contraloria', 'contralor') AND v_profile_sucursal = 'GLOBAL')
  THEN
    RETURN true;
  END IF;

  -- Solo perfiles administrativos/coordinación/contraloría regionales pasan este filtro
  IF v_profile_role NOT IN (
    'coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade',
    'supervisor', 'contraloria', 'analista_contraloria', 'contralor'
  ) THEN
    RETURN false;
  END IF;

  IF v_profile_region_id IS NOT NULL AND p_region_id IS NOT NULL AND v_profile_region_id = p_region_id THEN
    RETURN true;
  END IF;

  v_actor_region_label := CASE
    WHEN v_profile_sucursal IN ('OCCIDENTE', 'ZULIA') THEN 'OCCIDENTE'
    WHEN v_profile_sucursal IN ('VALENCIA', 'CENTRO', 'CAPITAL') THEN 'VALENCIA'
    WHEN v_profile_sucursal = 'ANDES' THEN 'ANDES'
    ELSE NULL
  END;

  v_row_region_label := CASE
    WHEN UPPER(TRIM(COALESCE(p_region, ''))) IN ('OCCIDENTE', 'ZULIA') THEN 'OCCIDENTE'
    WHEN UPPER(TRIM(COALESCE(p_region, ''))) IN ('VALENCIA', 'CENTRO', 'CAPITAL') THEN 'VALENCIA'
    WHEN UPPER(TRIM(COALESCE(p_region, ''))) = 'ANDES' THEN 'ANDES'
    ELSE NULL
  END;

  IF v_actor_region_label IS NOT NULL AND v_row_region_label IS NOT NULL THEN
    RETURN v_actor_region_label = v_row_region_label;
  END IF;

  RETURN public.fn_trade_tiene_acceso_region_erp(p_region_id);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_es_admin_personal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_trade_es_admin_personal() TO authenticated;

REVOKE ALL ON FUNCTION public.fn_trade_es_promotora_propia(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_trade_es_promotora_propia(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_trade_admin_acceso_region_promotora(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_trade_admin_acceso_region_promotora(text, uuid) TO authenticated;

-- 2. Evolución idempotente del esquema + índices + RLS en `public.promotoras`
DO $$
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    -- Columnas requeridas (idempotentes)
    EXECUTE 'ALTER TABLE public.promotoras ADD COLUMN IF NOT EXISTS region text';
    EXECUTE 'ALTER TABLE public.promotoras ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL';

    IF to_regclass('public."Regiones"') IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public.promotoras ADD COLUMN IF NOT EXISTS region_id uuid REFERENCES public."Regiones"(id_regi)';
    END IF;

    -- Garantizar que `direccion` permita NULL (caso especial: Jose Barroso)
    EXECUTE 'ALTER TABLE public.promotoras ALTER COLUMN direccion DROP NOT NULL';

    -- Restricción controlada de valores permitidos para `region`
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'chk_promotoras_region_valida'
        AND conrelid = 'public.promotoras'::regclass
    ) THEN
      EXECUTE $chk$
        ALTER TABLE public.promotoras
        ADD CONSTRAINT chk_promotoras_region_valida
        CHECK (region IS NULL OR region IN ('Occidente', 'Valencia', 'Andes', 'Centro'))
      $chk$;
    END IF;

    -- Normalizar correos existentes (trim + minúsculas) antes del índice único case-insensitive
    EXECUTE $norm$
      UPDATE public.promotoras
      SET correo = LOWER(BTRIM(correo))
      WHERE correo IS NOT NULL
        AND correo <> LOWER(BTRIM(correo))
    $norm$;

    -- Backfill no destructivo de `region` únicamente cuando `region IS NULL`
    EXECUTE $bf_val$
      UPDATE public.promotoras
      SET region = 'Valencia'
      WHERE region IS NULL
        AND (
          created_at >= TIMESTAMPTZ '2026-11-19T00:00:00Z'
          OR COALESCE(direccion, '') ~* '(VALENCIA|CARABOBO|LOS GUAYOS|TOCUYITO|MARACAY|TURMERO|ARAGUA|CARACAS|EL PARAISO|MONTALBAN|PLAZA VENEZUELA)'
        )
    $bf_val$;

    EXECUTE $bf_occ$
      UPDATE public.promotoras
      SET region = 'Occidente'
      WHERE region IS NULL
        AND (
          LOWER(BTRIM(COALESCE(correo, ''))) = 'joseabraham.barroso@gmail.com'
          OR COALESCE(direccion, '') ~* '(CORO|PUNTO FIJO|CABIMAS|MARACAIBO|SAN FRANCISCO|LA VILLA|MARA|MOJAN|CUATRICENTENARIO|VARILLAL|LA LIMPIA|LA POPULAR|EL SILENCIO|EL BAJO|SANTA MARIA|PLAZA DE LAS MADRES|DIA DE LAS MADRES|\mC2\M)'
        )
    $bf_occ$;

    -- Sincronización dinámica de `region_id` desde `public."Regiones"` (cero UUIDs hardcodeados)
    IF to_regclass('public."Regiones"') IS NOT NULL THEN
      EXECUTE $bf_rid_occ$
        UPDATE public.promotoras p
        SET region_id = r.id_regi
        FROM public."Regiones" r
        WHERE p.region = 'Occidente'
          AND p.region_id IS NULL
          AND UPPER(TRIM(r.regi_desd)) = 'OCCIDENTE'
      $bf_rid_occ$;

      EXECUTE $bf_rid_val$
        UPDATE public.promotoras p
        SET region_id = r.id_regi
        FROM public."Regiones" r
        WHERE p.region = 'Valencia'
          AND p.region_id IS NULL
          AND UPPER(TRIM(r.regi_desd)) = 'CENTRO'
      $bf_rid_val$;
    END IF;

    -- Índice único case-insensitive en `correo` e índices operativos/RLS
    EXECUTE $idx_u$
      CREATE UNIQUE INDEX IF NOT EXISTS uq_promotoras_correo_lower
      ON public.promotoras (LOWER(BTRIM(correo)))
      WHERE correo IS NOT NULL AND BTRIM(correo) <> ''
    $idx_u$;

    EXECUTE $idx_auth$
      CREATE INDEX IF NOT EXISTS idx_promotoras_auth_user_id
      ON public.promotoras (auth_user_id)
      WHERE auth_user_id IS NOT NULL
    $idx_auth$;

    EXECUTE $idx_reg$
      CREATE INDEX IF NOT EXISTS idx_promotoras_region_activo
      ON public.promotoras (region, activo)
    $idx_reg$;

    -- Hardening de privilegios y Row Level Security estricto
    EXECUTE 'REVOKE ALL ON TABLE public.promotoras FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON TABLE public.promotoras FROM anon';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promotoras TO authenticated';
    EXECUTE 'ALTER TABLE public.promotoras ENABLE ROW LEVEL SECURITY';

    -- Reemplazar políticas previas por políticas explícitas de mínimo privilegio
    EXECUTE 'DROP POLICY IF EXISTS trade_rls_select_promotoras ON public.promotoras';
    EXECUTE 'DROP POLICY IF EXISTS promotoras_select_admin_or_own ON public.promotoras';
    EXECUTE 'DROP POLICY IF EXISTS promotoras_insert_admin_only ON public.promotoras';
    EXECUTE 'DROP POLICY IF EXISTS promotoras_update_admin_only ON public.promotoras';
    EXECUTE 'DROP POLICY IF EXISTS promotoras_delete_admin_only ON public.promotoras';

    EXECUTE $p_sel$
      CREATE POLICY promotoras_select_admin_or_own
      ON public.promotoras
      FOR SELECT
      TO authenticated
      USING (
        public.fn_trade_admin_acceso_region_promotora(region, region_id)
        OR public.fn_trade_es_promotora_propia(auth_user_id, correo)
      )
    $p_sel$;

    EXECUTE $p_ins$
      CREATE POLICY promotoras_insert_admin_only
      ON public.promotoras
      FOR INSERT
      TO authenticated
      WITH CHECK (public.fn_trade_es_admin_personal())
    $p_ins$;

    EXECUTE $p_upd$
      CREATE POLICY promotoras_update_admin_only
      ON public.promotoras
      FOR UPDATE
      TO authenticated
      USING (public.fn_trade_es_admin_personal())
      WITH CHECK (public.fn_trade_es_admin_personal())
    $p_upd$;

    EXECUTE $p_del$
      CREATE POLICY promotoras_delete_admin_only
      ON public.promotoras
      FOR DELETE
      TO authenticated
      USING (public.fn_trade_es_admin_personal())
    $p_del$;
  END IF;
END
$$;
