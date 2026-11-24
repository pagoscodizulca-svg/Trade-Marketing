-- ==============================================================================
-- FIX DEFINITIVO RLS & RPC TRANSACCIONAL DE ASISTENCIA (100% IDEMPOTENTE)
-- Archivo versionado: supabase/migrations/20261209000100_fix_definitivo_rls_asistencia.sql
-- Copia SQL Editor:   sql/FIX_DEFINITIVO_RLS_ASISTENCIA.sql
--
-- Erradica de raíz el error 42501:
--   "Permiso denegado por RLS al abrir la jornada de asistencia."
--
-- Causas raíz corregidas de forma definitiva:
--   1. `public.asistencias_jornada` y `public.asistencia_evidencias` habían sido
--      omitidas de los triggers de normalización multisede (`ZULIA`->`OCCIDENTE`,
--      `VALENCIA`->`CENTRO`), causando rechazo 42501 en RLS `WITH CHECK` y CHECK.
--   2. `public.fn_trade_current_promotora_id()` y `public.fn_trade_is_promotora_owner()`
--      corrían en `SECURITY INVOKER` y solo consultaban `promotoras.correo` (no `email`).
--   3. `public.obtener_mi_sucursal()` usaba `COALESCE(pr.email, pr.correo, '')`,
--      fallando cuando `email` era cadena vacía `''` y el correo estaba en `correo`.
--   4. Se reemplaza el `.insert()` directo del móvil por RPCs `SECURITY DEFINER`
--      transaccionales e idempotentes (`rpc_abrir_jornada_asistencia`,
--      `rpc_registrar_turno_asistencia`) + `rpc_healthcheck_asistencia()`.
--
-- Garantías de Seguridad e Invariantes:
--   - RLS permanece ENABLE + FORCE en todas las tablas (cero DISABLE RLS).
--   - Cero acceso a `anon` / `PUBLIC` (las promotoras usan Supabase Auth real `authenticated`).
--   - Cero DDL destructivo (sin DROP TABLE, DROP COLUMN ni TRUNCATE).
--   - 100% re-ejecutable múltiples veces en el SQL Editor de Supabase sin errores.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. COLUMNAS ADITIVAS Y BUCKET PRIVADO DE STORAGE (100% IDEMPOTENTE)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    ALTER TABLE public.promotoras
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS correo TEXT,
      ADD COLUMN IF NOT EXISTS ciudad TEXT,
      ADD COLUMN IF NOT EXISTS estado TEXT,
      ADD COLUMN IF NOT EXISTS direccion TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS categoria TEXT DEFAULT 'Fijas',
      ADD COLUMN IF NOT EXISTS auth_user_id UUID;
  END IF;

  IF to_regclass('public.asistencias_jornada') IS NOT NULL THEN
    ALTER TABLE public.asistencias_jornada
      ADD COLUMN IF NOT EXISTS promotora_ref_id INTEGER,
      ADD COLUMN IF NOT EXISTS auth_user_id UUID,
      ADD COLUMN IF NOT EXISTS region TEXT DEFAULT 'Occidente',
      ADD COLUMN IF NOT EXISTS sucursal TEXT DEFAULT 'OCCIDENTE';
  END IF;

  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    ALTER TABLE public.asistencia_evidencias
      ADD COLUMN IF NOT EXISTS region TEXT DEFAULT 'Occidente',
      ADD COLUMN IF NOT EXISTS sucursal TEXT DEFAULT 'OCCIDENTE',
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS location_source TEXT NOT NULL DEFAULT 'gps_high';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'asistencia_evidencias_location_source_check'
        AND conrelid = 'public.asistencia_evidencias'::regclass
    ) THEN
      ALTER TABLE public.asistencia_evidencias
        ADD CONSTRAINT asistencia_evidencias_location_source_check
        CHECK (location_source IN ('gps_high', 'wifi_cell', 'ip_fallback'));
    END IF;
  END IF;

  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (
      id,
      name,
      public,
      file_size_limit,
      allowed_mime_types
    )
    VALUES (
      'asistencia-evidencias',
      'asistencia-evidencias',
      false,
      5242880,
      ARRAY['image/jpeg', 'image/png', 'image/webp']
    )
    ON CONFLICT (id) DO UPDATE
      SET public = false,
          file_size_limit = 5242880,
          allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 2. SANEAMIENTO DE HELPERS RLS (`SECURITY DEFINER SET search_path = public`)
--    Elimina recursión RLS y fallos por `email = ''` vs `correo`.
--    Crea guardas idempotentes si este script se ejecuta de forma independiente.
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regprocedure('public.normalizar_sucursal_multisede(text)') IS NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.normalizar_sucursal_multisede(p_raw TEXT)
      RETURNS TEXT
      LANGUAGE plpgsql
      IMMUTABLE
      SET search_path = public
      AS $body$
      DECLARE
        v_clean TEXT := UPPER(BTRIM(COALESCE(p_raw, '')));
      BEGIN
        IF v_clean = '' THEN RETURN NULL; END IF;
        v_clean := TRANSLATE(v_clean, 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜ', 'AEIOUAEIOUAEIOU');
        IF v_clean IN ('CENTRO','SUCURSAL CENTRO','REGION CENTRO','VALENCIA','SUCURSAL VALENCIA','CARABOBO','SAN DIEGO','NAGUANAGUA','GUACARA','TOCUYITO','LOS GUAYOS','ARAGUA','MARACAY','EL SAMAN','TURMERO','CAGUA','CAPITAL','CARACAS','ANDES') THEN
          RETURN 'CENTRO';
        END IF;
        IF v_clean IN ('OCCIDENTE','SUCURSAL OCCIDENTE','REGION OCCIDENTE','ZULIA','SUCURSAL ZULIA','MARACAIBO','SAN FRANCISCO','CABIMAS','CIUDAD OJEDA','FALCON','CORO','PUNTO FIJO','LARA','BARQUISIMETO') THEN
          RETURN 'OCCIDENTE';
        END IF;
        RETURN NULL;
      END;
      $body$;
    $fn$;
  END IF;

  IF to_regprocedure('public.fn_inferir_sucursal_geografica(text)') IS NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.fn_inferir_sucursal_geografica(p_texto TEXT)
      RETURNS TEXT
      LANGUAGE plpgsql
      IMMUTABLE
      SET search_path = public
      AS $body$
      DECLARE
        v_norm TEXT := UPPER(TRANSLATE(BTRIM(COALESCE(p_texto, '')), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜ', 'AEIOUAEIOUAEIOU'));
      BEGIN
        IF v_norm = '' THEN RETURN NULL; END IF;
        IF v_norm ~ '(VALENCIA|CARABOBO|SAN DIEGO|NAGUANAGUA|GUACARA|MARACAY|ARAGUA|TURMERO|CAGUA|EL SAMAN|CARACAS|CENTRO)' THEN
          RETURN 'CENTRO';
        END IF;
        IF v_norm ~ '(ZULIA|MARACAIBO|SAN FRANCISCO|CABIMAS|OJEDA|FALCON|CORO|LARA|BARQUISIMETO|OCCIDENTE)' THEN
          RETURN 'OCCIDENTE';
        END IF;
        RETURN NULL;
      END;
      $body$;
    $fn$;
  END IF;

  IF to_regprocedure('public.es_admin_nacional()') IS NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.es_admin_nacional()
      RETURNS BOOLEAN
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      DECLARE
        v_uid UUID := (SELECT auth.uid());
        v_rol TEXT := '';
        v_activo BOOLEAN := false;
      BEGIN
        IF v_uid IS NULL THEN RETURN false; END IF;
        IF to_regclass('public.profiles') IS NOT NULL THEN
          SELECT LOWER(BTRIM(COALESCE(p.role::text, ''))), COALESCE(p.is_active, true)
            INTO v_rol, v_activo
          FROM public.profiles p
          WHERE p.id = v_uid;
          IF FOUND THEN
            RETURN v_activo IS TRUE AND v_rol IN ('super_admin', 'admin', 'gerente_admin', 'admin_nacional', 'contraloria', 'analista_contraloria');
          END IF;
        END IF;
        v_rol := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'role', (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role', '')));
        RETURN v_rol IN ('admin_nacional', 'super_admin', 'admin');
      END;
      $body$;
    $fn$;
    REVOKE ALL ON FUNCTION public.es_admin_nacional() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.es_admin_nacional() TO authenticated, service_role;
  END IF;

  IF to_regprocedure('public.is_torre_control_viewer()') IS NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.is_torre_control_viewer()
      RETURNS BOOLEAN
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      DECLARE
        v_uid UUID := (SELECT auth.uid());
        v_rol TEXT := '';
        v_activo BOOLEAN := false;
      BEGIN
        IF v_uid IS NULL THEN RETURN false; END IF;
        IF to_regclass('public.profiles') IS NOT NULL THEN
          SELECT LOWER(BTRIM(COALESCE(p.role::text, ''))), COALESCE(p.is_active, true)
            INTO v_rol, v_activo
          FROM public.profiles p
          WHERE p.id = v_uid;
          IF FOUND THEN
            RETURN v_activo IS TRUE AND v_rol IN ('contraloria', 'analista_contraloria', 'contralor', 'super_admin');
          END IF;
        END IF;
        RETURN false;
      END;
      $body$;
    $fn$;
    REVOKE ALL ON FUNCTION public.is_torre_control_viewer() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.is_torre_control_viewer() TO authenticated, service_role;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.obtener_mi_sucursal()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_sucursal TEXT;
  v_activo BOOLEAN;
  v_jwt_email TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Fuente primaria inmutable: public.perfiles_usuarios
  IF to_regclass('public.perfiles_usuarios') IS NOT NULL THEN
    SELECT pu.sucursal, pu.activo
      INTO v_sucursal, v_activo
    FROM public.perfiles_usuarios pu
    WHERE pu.id = v_uid;

    IF FOUND THEN
      IF v_activo IS DISTINCT FROM true THEN
        RETURN NULL;
      END IF;
      RETURN public.normalizar_sucursal_multisede(v_sucursal);
    END IF;
  END IF;

  -- 2. Respaldo en public.profiles
  IF to_regclass('public.profiles') IS NOT NULL THEN
    SELECT
      COALESCE(
        public.normalizar_sucursal_multisede(p.sucursal::text),
        public.normalizar_sucursal_multisede(p.region),
        public.normalizar_sucursal_multisede((p.regiones_asignadas)[1])
      ),
      COALESCE(p.is_active, true)
    INTO v_sucursal, v_activo
    FROM public.profiles p
    WHERE p.id = v_uid;

    IF FOUND THEN
      IF v_activo IS DISTINCT FROM true THEN
        RETURN NULL;
      END IF;
      IF v_sucursal IS NOT NULL THEN
        RETURN v_sucursal;
      END IF;
    END IF;
  END IF;

  -- 3. Ficha activa en public.promotoras (tolerante a email='' y correo real)
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    v_jwt_email := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
    SELECT
      COALESCE(
        public.normalizar_sucursal_multisede(pr.sucursal::text),
        public.normalizar_sucursal_multisede(pr.region),
        public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', pr.ciudad, pr.estado, pr.direccion))
      ),
      COALESCE(pr.activo, true)
    INTO v_sucursal, v_activo
    FROM public.promotoras pr
    WHERE pr.auth_user_id = v_uid
       OR (
         v_jwt_email <> ''
         AND (
           LOWER(BTRIM(COALESCE(NULLIF(BTRIM(pr.email), ''), ''))) = v_jwt_email
           OR LOWER(BTRIM(COALESCE(NULLIF(BTRIM(pr.correo), ''), ''))) = v_jwt_email
         )
       )
    ORDER BY CASE WHEN pr.auth_user_id = v_uid THEN 0 ELSE 1 END
    LIMIT 1;

    IF FOUND AND v_activo IS TRUE AND v_sucursal IS NOT NULL THEN
      RETURN v_sucursal;
    END IF;
  END IF;

  -- 4. Claims firmados del servidor (`app_metadata`, jamás `user_metadata`)
  RETURN public.normalizar_sucursal_multisede(
    COALESCE(
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'sucursal',
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'region'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_mi_sucursal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_sucursal() TO authenticated, service_role;

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
    BEGIN
      SELECT p.id::text
        INTO v_promotora_id
      FROM public.promotoras p
      WHERE COALESCE(p.activo, true) = true
        AND (
          p.auth_user_id = v_uid
          OR (
            v_jwt_email <> ''
            AND (
              LOWER(BTRIM(COALESCE(NULLIF(BTRIM(p.email), ''), ''))) = v_jwt_email
              OR LOWER(BTRIM(COALESCE(NULLIF(BTRIM(p.correo), ''), ''))) = v_jwt_email
            )
          )
        )
      ORDER BY CASE WHEN p.auth_user_id = v_uid THEN 0 ELSE 1 END ASC
      LIMIT 1;
    EXCEPTION WHEN undefined_column THEN
      SELECT p.id::text
        INTO v_promotora_id
      FROM public.promotoras p
      WHERE COALESCE(p.activo, true) = true
        AND v_jwt_email <> ''
        AND LOWER(BTRIM(COALESCE(p.correo, ''))) = v_jwt_email
      LIMIT 1;
    END;
  END IF;

  IF v_promotora_id IS NOT NULL AND v_promotora_id <> '' THEN
    RETURN v_promotora_id;
  END IF;

  RETURN NULLIF(BTRIM(COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'staff_id', '')), '');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_current_promotora_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_current_promotora_id() TO authenticated, service_role;

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
    AND (
      (p_auth_uid IS NOT NULL AND p_auth_uid = (SELECT auth.uid()))
      OR (
        NULLIF(BTRIM(COALESCE(p_promotora_id, '')), '') IS NOT NULL
        AND BTRIM(p_promotora_id) IN (
          COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
          (SELECT auth.uid())::text
        )
      )
      OR (
        NULLIF(LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', ''))), '') IS NOT NULL
        AND LOWER(BTRIM(COALESCE(p_creator_or_email, ''))) = LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')))
      )
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_promotora_owner(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_promotora_owner(UUID, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_is_asistencia_manager()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_role TEXT := '';
  v_active BOOLEAN := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  IF public.es_admin_nacional() THEN
    RETURN true;
  END IF;

  IF to_regclass('public.perfiles_usuarios') IS NOT NULL THEN
    SELECT LOWER(BTRIM(COALESCE(pu.rol, ''))), COALESCE(pu.activo, false)
      INTO v_role, v_active
    FROM public.perfiles_usuarios pu
    WHERE pu.id = v_uid;

    IF FOUND THEN
      RETURN v_active IS TRUE AND v_role IN ('admin_nacional', 'coordinador');
    END IF;
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    SELECT LOWER(BTRIM(COALESCE(p.role::text, ''))), COALESCE(p.is_active, false)
      INTO v_role, v_active
    FROM public.profiles p
    WHERE p.id = v_uid;

    IF FOUND THEN
      RETURN v_active IS TRUE AND v_role IN (
        'super_admin',
        'admin',
        'gerente_admin',
        'admin_nacional',
        'coordinacion',
        'coordinador',
        'coordinador_trade',
        'coordinadora',
        'coordinadora_trade',
        'jefe_trade',
        'supervisor'
      );
    END IF;
  END IF;

  v_role := LOWER(BTRIM(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'rol_multisede',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    ''
  )));

  RETURN v_role IN ('admin_nacional', 'super_admin', 'admin', 'coordinacion', 'coordinador', 'coordinadora', 'supervisor');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_asistencia_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_asistencia_manager() TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 3. TRIGGER DE NORMALIZACIÓN AUTOMÁTICA DE SUCURSAL EN TABLAS DE ASISTENCIA
--    Convierte 'ZULIA' -> 'OCCIDENTE' y 'VALENCIA' -> 'CENTRO' antes de RLS/CHECK.
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trg_normalizar_sucursal_asistencia()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
BEGIN
  v_norm := COALESCE(
    public.normalizar_sucursal_multisede(NEW.sucursal::text),
    public.normalizar_sucursal_multisede(NEW.region::text),
    (SELECT public.obtener_mi_sucursal()),
    'OCCIDENTE'
  );

  NEW.sucursal := v_norm;

  IF NULLIF(BTRIM(COALESCE(NEW.region, '')), '') IS NULL THEN
    NEW.region := CASE WHEN v_norm = 'CENTRO' THEN 'Valencia' ELSE 'Occidente' END;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_normalizar_sucursal_asistencia() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.asistencias_jornada') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_aa_normalizar_sucursal_asistencia ON public.asistencias_jornada;
    CREATE TRIGGER trg_aa_normalizar_sucursal_asistencia
      BEFORE INSERT OR UPDATE ON public.asistencias_jornada
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_trg_normalizar_sucursal_asistencia();
  END IF;

  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_aa_normalizar_sucursal_asistencia ON public.asistencia_evidencias;
    CREATE TRIGGER trg_aa_normalizar_sucursal_asistencia
      BEFORE INSERT OR UPDATE ON public.asistencia_evidencias
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_trg_normalizar_sucursal_asistencia();
  END IF;

  -- Si existe el trigger histórico `fn_lock_asistencia_perfil_aplicado` (20261112),
  -- preservar la inmutabilidad en UPDATE pero permitir INSERT de promotoras desde `public.promotoras`
  IF to_regprocedure('public.fn_lock_asistencia_perfil_aplicado()') IS NOT NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.fn_lock_asistencia_perfil_aplicado()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.perfil_aplicado IS NULL OR BTRIM(NEW.perfil_aplicado) = '' THEN
            NEW.perfil_aplicado := 'FIJA';
          ELSIF NEW.perfil_aplicado NOT IN ('FIJA', 'EVENTUAL') THEN
            RAISE EXCEPTION 'INVALID_PERFIL_APLICADO: El perfil aplicado debe ser FIJA o EVENTUAL.'
              USING ERRCODE = '23514';
          END IF;
          IF NEW.promotora_nombre IS NULL OR BTRIM(NEW.promotora_nombre) = '' THEN
            NEW.promotora_nombre := 'Promotora';
          END IF;
          NEW.opened_at_server := COALESCE(NEW.opened_at_server, NOW());
          NEW.updated_at_server := NOW();
          IF NEW.opened_by_uid IS NULL THEN
            NEW.opened_by_uid := (SELECT auth.uid());
          END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'UPDATE' THEN
          IF NEW.perfil_aplicado IS DISTINCT FROM OLD.perfil_aplicado THEN
            RAISE EXCEPTION 'IMMUTABLE_PERFIL_APLICADO: El snapshot histórico perfil_aplicado (%) no puede modificarse.', OLD.perfil_aplicado
              USING ERRCODE = '23514';
          END IF;
          IF NEW.promotora_id IS DISTINCT FROM OLD.promotora_id
             OR NEW.fecha_jornada IS DISTINCT FROM OLD.fecha_jornada THEN
            RAISE EXCEPTION 'IMMUTABLE_JORNADA_KEY: No se permite reasignar fecha_jornada ni promotora_id.'
              USING ERRCODE = '23514';
          END IF;
          NEW.opened_at_server := OLD.opened_at_server;
          NEW.updated_at_server := NOW();
          RETURN NEW;
        END IF;

        RETURN NEW;
      END;
      $body$;
    $fn$;
    REVOKE ALL ON FUNCTION public.fn_lock_asistencia_perfil_aplicado() FROM PUBLIC, anon, authenticated;
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 4. RPC TRANSACCIONAL 1: `public.rpc_abrir_jornada_asistencia(...)`
--    SECURITY DEFINER + SET search_path = public + Idempotente (ON CONFLICT)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rpc_abrir_jornada_asistencia(
  p_pdv_nombre TEXT,
  p_zona TEXT DEFAULT '',
  p_fecha_jornada DATE DEFAULT NULL,
  p_promotora_id TEXT DEFAULT NULL
)
RETURNS public.asistencias_jornada
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_jwt_email TEXT := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_is_admin BOOLEAN := false;
  v_is_manager BOOLEAN := false;
  v_actor_sucursal TEXT;
  v_hoy_caracas DATE := (now() AT TIME ZONE 'America/Caracas')::date;
  v_fecha DATE;
  v_clean_pdv TEXT := LEFT(BTRIM(COALESCE(p_pdv_nombre, '')), 180);
  v_clean_zona TEXT := LEFT(BTRIM(COALESCE(p_zona, '')), 180);
  v_req_prom_id TEXT := NULLIF(BTRIM(COALESCE(p_promotora_id, '')), '');

  v_prom_id TEXT;
  v_prom_ref_id INTEGER := NULL;
  v_prom_auth_uid UUID := NULL;
  v_prom_nombre TEXT;
  v_prom_categoria TEXT := 'Fijas';
  v_prom_direccion TEXT := '';
  v_prom_sucursal TEXT;
  v_prom_region TEXT;
  v_prom_activo BOOLEAN := true;
  v_perfil_aplicado TEXT := 'FIJA';
  v_found_prom BOOLEAN := false;
  v_jornada public.asistencias_jornada;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_SESSION_EXPIRED: Tu sesión expiró. Inicia sesión nuevamente.'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_pdv = '' THEN
    RAISE EXCEPTION 'PDV_REQUERIDO: Selecciona el Punto de Venta (PDV) antes de abrir la jornada.'
      USING ERRCODE = '22023';
  END IF;

  v_fecha := COALESCE(p_fecha_jornada, v_hoy_caracas);
  IF v_fecha > v_hoy_caracas THEN
    RAISE EXCEPTION 'FECHA_FUTURA_NO_PERMITIDA: No se puede abrir jornada para fechas futuras (% > %).', v_fecha, v_hoy_caracas
      USING ERRCODE = '22023';
  END IF;

  v_is_admin := public.es_admin_nacional();
  v_is_manager := public.fn_trade_is_asistencia_manager();
  v_actor_sucursal := public.obtener_mi_sucursal();

  -- 1. Resolver y validar ficha activa en public.promotoras
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    IF v_is_manager AND v_req_prom_id IS NOT NULL THEN
      SELECT
        pr.id::text,
        CASE WHEN pr.id::text ~ '^[0-9]+$' THEN pr.id::text::integer ELSE NULL END,
        pr.auth_user_id,
        COALESCE(NULLIF(BTRIM(pr.nombre_completo), ''), NULLIF(BTRIM(pr.email), ''), NULLIF(BTRIM(pr.correo), ''), 'Promotora'),
        COALESCE(NULLIF(BTRIM(pr.categoria), ''), 'Fijas'),
        COALESCE(BTRIM(pr.direccion), ''),
        COALESCE(
          public.normalizar_sucursal_multisede(pr.sucursal::text),
          public.normalizar_sucursal_multisede(pr.region),
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', pr.ciudad, pr.estado, pr.direccion)),
          v_actor_sucursal,
          'OCCIDENTE'
        ),
        COALESCE(pr.activo, true)
      INTO
        v_prom_id,
        v_prom_ref_id,
        v_prom_auth_uid,
        v_prom_nombre,
        v_prom_categoria,
        v_prom_direccion,
        v_prom_sucursal,
        v_prom_activo
      FROM public.promotoras pr
      WHERE pr.id::text = v_req_prom_id
         OR (pr.auth_user_id IS NOT NULL AND pr.auth_user_id::text = v_req_prom_id)
      LIMIT 1;
      v_found_prom := FOUND;

      IF v_found_prom AND NOT v_is_admin AND v_actor_sucursal IS NOT NULL AND v_prom_sucursal IS DISTINCT FROM v_actor_sucursal THEN
        RAISE EXCEPTION 'FORBIDDEN_BRANCH: No puedes abrir jornada de una promotora perteneciente a otra sucursal.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NOT v_found_prom THEN
      SELECT
        pr.id::text,
        CASE WHEN pr.id::text ~ '^[0-9]+$' THEN pr.id::text::integer ELSE NULL END,
        COALESCE(pr.auth_user_id, v_uid),
        COALESCE(NULLIF(BTRIM(pr.nombre_completo), ''), NULLIF(BTRIM(pr.email), ''), NULLIF(BTRIM(pr.correo), ''), 'Promotora'),
        COALESCE(NULLIF(BTRIM(pr.categoria), ''), 'Fijas'),
        COALESCE(BTRIM(pr.direccion), ''),
        COALESCE(
          public.normalizar_sucursal_multisede(pr.sucursal::text),
          public.normalizar_sucursal_multisede(pr.region),
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', pr.ciudad, pr.estado, pr.direccion)),
          v_actor_sucursal,
          'OCCIDENTE'
        ),
        COALESCE(pr.activo, true)
      INTO
        v_prom_id,
        v_prom_ref_id,
        v_prom_auth_uid,
        v_prom_nombre,
        v_prom_categoria,
        v_prom_direccion,
        v_prom_sucursal,
        v_prom_activo
      FROM public.promotoras pr
      WHERE pr.auth_user_id = v_uid
         OR (
           v_jwt_email <> ''
           AND (
             LOWER(BTRIM(COALESCE(NULLIF(BTRIM(pr.email), ''), ''))) = v_jwt_email
             OR LOWER(BTRIM(COALESCE(NULLIF(BTRIM(pr.correo), ''), ''))) = v_jwt_email
           )
         )
      ORDER BY CASE WHEN pr.auth_user_id = v_uid THEN 0 ELSE 1 END ASC
      LIMIT 1;
      v_found_prom := FOUND;
    END IF;
  END IF;

  -- Si la promotora existe pero está inactiva -> rechazar explícitamente
  IF v_found_prom AND v_prom_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PROMOTORA_INACTIVA: Tu perfil de promotora no se encuentra activo. Contacta a Coordinación.'
      USING ERRCODE = '42501';
  END IF;

  -- Si no existe en public.promotoras, solo se permite apertura de supervisión para admin/coordinación activa
  IF NOT v_found_prom THEN
    IF NOT v_is_manager THEN
      RAISE EXCEPTION 'PROMOTORA_NO_ENCONTRADA: Tu usuario autenticado no figura como promotora activa en el padrón.'
        USING ERRCODE = '42501';
    END IF;

    v_prom_id := COALESCE(v_req_prom_id, v_uid::text);
    v_prom_auth_uid := v_uid;
    v_prom_nombre := COALESCE(
      NULLIF(BTRIM((SELECT auth.jwt()) -> 'app_metadata' ->> 'display_name'), ''),
      NULLIF(v_jwt_email, ''),
      'Supervisión Trade'
    );
    v_prom_categoria := 'Fijas';
    v_prom_sucursal := COALESCE(v_actor_sucursal, 'OCCIDENTE');
  END IF;

  v_prom_sucursal := COALESCE(public.normalizar_sucursal_multisede(v_prom_sucursal), 'OCCIDENTE');
  v_prom_region := CASE WHEN v_prom_sucursal = 'CENTRO' THEN 'Valencia' ELSE 'Occidente' END;
  v_perfil_aplicado := CASE WHEN LOWER(v_prom_categoria) LIKE '%event%' THEN 'EVENTUAL' ELSE 'FIJA' END;
  IF v_clean_zona = '' THEN
    v_clean_zona := COALESCE(NULLIF(v_prom_direccion, ''), v_prom_region);
  END IF;

  -- 2. Apertura idempotente: si ya existe jornada ese día, devuelve el registro actualizado sin duplicar
  --    Compatible tanto si `promotora_id` es TEXT (esquema portal) como UUID (esquema legado)
  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = 'public.asistencias_jornada'::regclass
      AND a.attname = 'promotora_id'
      AND a.atttypid = 'uuid'::regtype
      AND NOT a.attisdropped
  ) THEN
    EXECUTE $ins_uuid$
      INSERT INTO public.asistencias_jornada (
        fecha_jornada,
        promotora_id,
        promotora_ref_id,
        auth_user_id,
        promotora_nombre,
        perfil_aplicado,
        pdv_nombre,
        zona,
        region,
        sucursal,
        opened_at_server,
        updated_at_server,
        opened_by_uid
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now(), $11)
      ON CONFLICT (fecha_jornada, promotora_id) DO UPDATE
        SET pdv_nombre = EXCLUDED.pdv_nombre,
            zona = CASE WHEN EXCLUDED.zona <> '' THEN EXCLUDED.zona ELSE public.asistencias_jornada.zona END,
            auth_user_id = COALESCE(public.asistencias_jornada.auth_user_id, EXCLUDED.auth_user_id),
            promotora_ref_id = COALESCE(public.asistencias_jornada.promotora_ref_id, EXCLUDED.promotora_ref_id),
            sucursal = COALESCE(public.normalizar_sucursal_multisede(public.asistencias_jornada.sucursal::text), EXCLUDED.sucursal),
            region = COALESCE(NULLIF(BTRIM(public.asistencias_jornada.region), ''), EXCLUDED.region),
            updated_at_server = now()
      RETURNING *
    $ins_uuid$
    INTO v_jornada
    USING
      v_fecha,
      CASE
        WHEN v_prom_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_prom_id::uuid
        ELSE COALESCE(v_prom_auth_uid, v_uid)
      END,
      v_prom_ref_id,
      COALESCE(v_prom_auth_uid, v_uid),
      v_prom_nombre,
      v_perfil_aplicado,
      v_clean_pdv,
      v_clean_zona,
      v_prom_region,
      v_prom_sucursal,
      v_uid;
  ELSE
    INSERT INTO public.asistencias_jornada (
      fecha_jornada,
      promotora_id,
      promotora_ref_id,
      auth_user_id,
      promotora_nombre,
      perfil_aplicado,
      pdv_nombre,
      zona,
      region,
      sucursal,
      opened_at_server,
      updated_at_server,
      opened_by_uid
    )
    VALUES (
      v_fecha,
      v_prom_id,
      v_prom_ref_id,
      COALESCE(v_prom_auth_uid, v_uid),
      v_prom_nombre,
      v_perfil_aplicado,
      v_clean_pdv,
      v_clean_zona,
      v_prom_region,
      v_prom_sucursal,
      now(),
      now(),
      v_uid
    )
    ON CONFLICT (fecha_jornada, promotora_id) DO UPDATE
      SET pdv_nombre = EXCLUDED.pdv_nombre,
          zona = CASE WHEN EXCLUDED.zona <> '' THEN EXCLUDED.zona ELSE public.asistencias_jornada.zona END,
          auth_user_id = COALESCE(public.asistencias_jornada.auth_user_id, EXCLUDED.auth_user_id),
          promotora_ref_id = COALESCE(public.asistencias_jornada.promotora_ref_id, EXCLUDED.promotora_ref_id),
          sucursal = COALESCE(public.normalizar_sucursal_multisede(public.asistencias_jornada.sucursal::text), EXCLUDED.sucursal),
          region = COALESCE(NULLIF(BTRIM(public.asistencias_jornada.region), ''), EXCLUDED.region),
          updated_at_server = now()
    RETURNING * INTO v_jornada;
  END IF;

  RETURN v_jornada;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_abrir_jornada_asistencia(TEXT, TEXT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_abrir_jornada_asistencia(TEXT, TEXT, DATE, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 5. RPC TRANSACCIONAL 2: `public.rpc_registrar_turno_asistencia(p_payload JSONB)`
--    Abre la jornada idempotentemente y certifica el turno fotográfico en 1 transacción.
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rpc_registrar_turno_asistencia(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_is_manager BOOLEAN := false;
  v_is_admin BOOLEAN := false;
  v_jornada public.asistencias_jornada;
  v_evidencia public.asistencia_evidencias;
  v_prev_storage_path TEXT := NULL;

  v_pdv TEXT;
  v_zona TEXT;
  v_fecha DATE;
  v_req_prom_id TEXT;
  v_slot TEXT;
  v_bucket TEXT;
  v_storage_path TEXT;
  v_mime TEXT;
  v_bytes INTEGER;
  v_sha256 TEXT;
  v_ancho INTEGER;
  v_alto INTEGER;
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_acc DOUBLE PRECISION;
  v_loc_source TEXT;
  v_actor_rol TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_SESSION_EXPIRED: Tu sesión expiró. Inicia sesión nuevamente.'
      USING ERRCODE = '42501';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALIDO: Se esperaba un objeto JSON con los datos del turno.'
      USING ERRCODE = '22023';
  END IF;

  v_pdv := LEFT(BTRIM(COALESCE(p_payload ->> 'pdv_nombre', '')), 180);
  v_zona := LEFT(BTRIM(COALESCE(p_payload ->> 'zona', '')), 180);
  v_req_prom_id := NULLIF(BTRIM(COALESCE(p_payload ->> 'promotora_id', '')), '');
  v_slot := UPPER(BTRIM(COALESCE(p_payload ->> 'slot_foto', '')));
  v_bucket := COALESCE(NULLIF(BTRIM(COALESCE(p_payload ->> 'storage_bucket', '')), ''), 'asistencia-evidencias');
  v_storage_path := BTRIM(COALESCE(p_payload ->> 'storage_path', ''));
  v_mime := LOWER(BTRIM(COALESCE(p_payload ->> 'mime_type', '')));
  v_sha256 := LEFT(BTRIM(COALESCE(p_payload ->> 'sha256_hex', '')), 128);
  v_loc_source := LOWER(BTRIM(COALESCE(p_payload ->> 'location_source', 'gps_high')));

  IF NULLIF(BTRIM(COALESCE(p_payload ->> 'fecha_jornada', '')), '') IS NOT NULL THEN
    BEGIN
      v_fecha := (p_payload ->> 'fecha_jornada')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'FECHA_INVALIDA: Formato de fecha_jornada inválido (use YYYY-MM-DD).'
        USING ERRCODE = '22023';
    END;
  ELSE
    v_fecha := NULL;
  END IF;

  IF v_bucket <> 'asistencia-evidencias' THEN
    RAISE EXCEPTION 'BUCKET_INVALIDO: Bucket de evidencias no autorizado.'
      USING ERRCODE = '22023';
  END IF;

  IF v_storage_path = '' OR v_storage_path LIKE '%..%' OR v_storage_path LIKE '/%' THEN
    RAISE EXCEPTION 'STORAGE_PATH_INVALIDO: Ruta de evidencia bloqueada por seguridad.'
      USING ERRCODE = '22023';
  END IF;

  IF v_mime NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'MIME_NO_PERMITIDO: Solo se admiten imágenes JPEG, PNG o WebP.'
      USING ERRCODE = '22023';
  END IF;

  v_bytes := COALESCE((p_payload ->> 'tamano_bytes')::integer, 0);
  IF v_bytes <= 0 OR v_bytes > 5242880 THEN
    RAISE EXCEPTION 'TAMANO_INVALIDO: La imagen debe pesar entre 1 byte y 5 MB.'
      USING ERRCODE = '22023';
  END IF;

  v_ancho := CASE WHEN NULLIF(BTRIM(COALESCE(p_payload ->> 'ancho_px', '')), '') IS NOT NULL THEN (p_payload ->> 'ancho_px')::integer ELSE NULL END;
  v_alto := CASE WHEN NULLIF(BTRIM(COALESCE(p_payload ->> 'alto_px', '')), '') IS NOT NULL THEN (p_payload ->> 'alto_px')::integer ELSE NULL END;
  v_lat := CASE WHEN NULLIF(BTRIM(COALESCE(p_payload ->> 'lat', '')), '') IS NOT NULL THEN (p_payload ->> 'lat')::double precision ELSE NULL END;
  v_lng := CASE WHEN NULLIF(BTRIM(COALESCE(p_payload ->> 'lng', '')), '') IS NOT NULL THEN (p_payload ->> 'lng')::double precision ELSE NULL END;
  v_acc := CASE WHEN NULLIF(BTRIM(COALESCE(p_payload ->> 'gps_accuracy', '')), '') IS NOT NULL THEN (p_payload ->> 'gps_accuracy')::double precision ELSE NULL END;

  IF (v_lat IS NOT NULL AND (v_lat < -90 OR v_lat > 90))
     OR (v_lng IS NOT NULL AND (v_lng < -180 OR v_lng > 180))
     OR (v_acc IS NOT NULL AND (v_acc < 0 OR v_acc > 100000)) THEN
    RAISE EXCEPTION 'COORDENADAS_INVALIDAS: Latitud, longitud o precisión GPS fuera de rango WGS84.'
      USING ERRCODE = '22023';
  END IF;

  IF v_loc_source NOT IN ('gps_high', 'wifi_cell', 'ip_fallback') THEN
    v_loc_source := 'gps_high';
  END IF;

  -- 1. Abrir u obtener la jornada de forma idempotente (resuelve promotora, sucursal y fecha Caracas)
  v_jornada := public.rpc_abrir_jornada_asistencia(
    p_pdv_nombre => v_pdv,
    p_zona => v_zona,
    p_fecha_jornada => v_fecha,
    p_promotora_id => v_req_prom_id
  );

  -- 2. Validar compatibilidad estricta entre `slot_foto` y el `perfil_aplicado` inmutable
  IF v_jornada.perfil_aplicado = 'FIJA' AND v_slot NOT IN ('JORNADA_INGRESO', 'JORNADA_SALIDA') THEN
    RAISE EXCEPTION 'SLOT_NO_PERMITIDO: El perfil FIJA solo permite JORNADA_INGRESO y JORNADA_SALIDA.'
      USING ERRCODE = '22023';
  ELSIF v_jornada.perfil_aplicado = 'EVENTUAL' AND v_slot NOT IN ('MANANA_INGRESO', 'MANANA_SALIDA', 'TARDE_INGRESO', 'TARDE_SALIDA') THEN
    RAISE EXCEPTION 'SLOT_NO_PERMITIDO: El perfil EVENTUAL solo permite MANANA_INGRESO, MANANA_SALIDA, TARDE_INGRESO y TARDE_SALIDA.'
      USING ERRCODE = '22023';
  END IF;

  v_is_admin := public.es_admin_nacional();
  v_is_manager := public.fn_trade_is_asistencia_manager();
  v_actor_rol := CASE WHEN v_is_admin THEN 'admin' WHEN v_is_manager THEN 'coordinadora' ELSE 'promotora' END;

  -- Capturar ruta anterior (si existía) para limpieza post-commit en Storage
  SELECT e.storage_path
    INTO v_prev_storage_path
  FROM public.asistencia_evidencias e
  WHERE e.asistencia_id = v_jornada.id
    AND e.slot_foto = v_slot
  LIMIT 1;

  -- 3. Upsert atómico e idempotente del turno fotográfico
  INSERT INTO public.asistencia_evidencias (
    asistencia_id,
    slot_foto,
    storage_bucket,
    storage_path,
    mime_type,
    tamano_bytes,
    sha256_hex,
    ancho_px,
    alto_px,
    pdv_nombre,
    lat,
    lng,
    gps_accuracy,
    location_source,
    region,
    sucursal,
    capturado_en_servidor,
    cargado_por_uid,
    cargado_por_rol,
    version,
    updated_at
  )
  VALUES (
    v_jornada.id,
    v_slot,
    v_bucket,
    v_storage_path,
    v_mime,
    v_bytes,
    v_sha256,
    v_ancho,
    v_alto,
    v_jornada.pdv_nombre,
    v_lat,
    v_lng,
    v_acc,
    v_loc_source,
    v_jornada.region,
    v_jornada.sucursal,
    now(),
    v_uid,
    v_actor_rol,
    1,
    now()
  )
  ON CONFLICT (asistencia_id, slot_foto) DO UPDATE
    SET storage_bucket = EXCLUDED.storage_bucket,
        storage_path = EXCLUDED.storage_path,
        mime_type = EXCLUDED.mime_type,
        tamano_bytes = EXCLUDED.tamano_bytes,
        sha256_hex = EXCLUDED.sha256_hex,
        ancho_px = EXCLUDED.ancho_px,
        alto_px = EXCLUDED.alto_px,
        pdv_nombre = EXCLUDED.pdv_nombre,
        lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        gps_accuracy = EXCLUDED.gps_accuracy,
        location_source = EXCLUDED.location_source,
        region = EXCLUDED.region,
        sucursal = EXCLUDED.sucursal,
        capturado_en_servidor = now(),
        cargado_por_uid = EXCLUDED.cargado_por_uid,
        cargado_por_rol = EXCLUDED.cargado_por_rol,
        version = COALESCE(public.asistencia_evidencias.version, 1) + 1,
        updated_at = now()
  RETURNING * INTO v_evidencia;

  RETURN jsonb_build_object(
    'ok', true,
    'jornada', to_jsonb(v_jornada),
    'evidencia', to_jsonb(v_evidencia),
    'previous_storage_path', v_prev_storage_path
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_registrar_turno_asistencia(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_turno_asistencia(JSONB) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 6. RPC DE AUTODIAGNÓSTICO (SOLO LECTURA): `public.rpc_healthcheck_asistencia()`
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rpc_healthcheck_asistencia()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tables_ok BOOLEAN := false;
  v_bucket_ok BOOLEAN := false;
  v_rpcs_ok BOOLEAN := false;
  v_uid UUID := (SELECT auth.uid());
BEGIN
  v_tables_ok :=
    to_regclass('public.asistencias_jornada') IS NOT NULL
    AND to_regclass('public.asistencia_evidencias') IS NOT NULL
    AND to_regclass('public.promotoras') IS NOT NULL;

  IF to_regclass('storage.buckets') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM storage.buckets WHERE id = 'asistencia-evidencias'
    ) INTO v_bucket_ok;
  END IF;

  v_rpcs_ok :=
    to_regprocedure('public.rpc_abrir_jornada_asistencia(text,text,date,text)') IS NOT NULL
    AND to_regprocedure('public.rpc_registrar_turno_asistencia(jsonb)') IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', (v_tables_ok AND v_bucket_ok AND v_rpcs_ok),
    'tables_ok', v_tables_ok,
    'storage_bucket_ok', v_bucket_ok,
    'rpcs_ok', v_rpcs_ok,
    'has_auth_session', (v_uid IS NOT NULL),
    'mi_sucursal', CASE WHEN v_uid IS NOT NULL THEN public.obtener_mi_sucursal() ELSE NULL END,
    'promotora_id', CASE WHEN v_uid IS NOT NULL THEN public.fn_trade_current_promotora_id() ELSE NULL END,
    'timestamp', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_healthcheck_asistencia() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_healthcheck_asistencia() TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 7. POLÍTICAS RLS EXPLÍCITAS Y LIMPIAS EN TABLAS Y STORAGE (ZERO-ANON)
-- ------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO authenticated;

DO $$
DECLARE
  v_pol RECORD;
BEGIN
  -- 7.1 public.asistencias_jornada
  IF to_regclass('public.asistencias_jornada') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.asistencias_jornada FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asistencias_jornada TO authenticated;
    GRANT ALL ON TABLE public.asistencias_jornada TO service_role;

    ALTER TABLE public.asistencias_jornada ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.asistencias_jornada FORCE ROW LEVEL SECURITY;

    FOR v_pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'asistencias_jornada'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.asistencias_jornada', v_pol.policyname);
    END LOOP;

    CREATE POLICY asistencias_jornada_select_auth
      ON public.asistencias_jornada
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.es_admin_nacional())
        OR (SELECT public.is_torre_control_viewer())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
        OR (
          sucursal = (SELECT public.obtener_mi_sucursal())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, NULL)
        )
      );

    CREATE POLICY asistencias_jornada_insert_auth
      ON public.asistencias_jornada
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.es_admin_nacional())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
        OR (
          sucursal = (SELECT public.obtener_mi_sucursal())
          AND auth_user_id = (SELECT auth.uid())
          AND COALESCE(opened_by_uid, (SELECT auth.uid())) = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, NULL)
        )
      );

    CREATE POLICY asistencias_jornada_update_auth
      ON public.asistencias_jornada
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT public.es_admin_nacional())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
        OR (
          sucursal = (SELECT public.obtener_mi_sucursal())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, NULL)
        )
      )
      WITH CHECK (
        (SELECT public.es_admin_nacional())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
        OR (
          sucursal = (SELECT public.obtener_mi_sucursal())
          AND auth_user_id = (SELECT auth.uid())
          AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, NULL)
        )
      );

    CREATE POLICY asistencias_jornada_delete_auth
      ON public.asistencias_jornada
      FOR DELETE
      TO authenticated
      USING (
        (SELECT public.es_admin_nacional())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
      );
  END IF;

  -- 7.2 public.asistencia_evidencias
  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.asistencia_evidencias FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asistencia_evidencias TO authenticated;
    GRANT ALL ON TABLE public.asistencia_evidencias TO service_role;

    ALTER TABLE public.asistencia_evidencias ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.asistencia_evidencias FORCE ROW LEVEL SECURITY;

    FOR v_pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'asistencia_evidencias'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.asistencia_evidencias', v_pol.policyname);
    END LOOP;

    CREATE POLICY asistencia_evidencias_select_auth
      ON public.asistencia_evidencias
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.es_admin_nacional())
        OR (SELECT public.is_torre_control_viewer())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
        OR (
          sucursal = (SELECT public.obtener_mi_sucursal())
          AND EXISTS (
            SELECT 1
            FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::text, NULL)
          )
        )
      );

    CREATE POLICY asistencia_evidencias_insert_auth
      ON public.asistencia_evidencias
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.es_admin_nacional())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
        OR (
          sucursal = (SELECT public.obtener_mi_sucursal())
          AND cargado_por_uid = (SELECT auth.uid())
          AND EXISTS (
            SELECT 1
            FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::text, NULL)
          )
        )
      );

    CREATE POLICY asistencia_evidencias_update_auth
      ON public.asistencia_evidencias
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT public.es_admin_nacional())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
        OR (
          sucursal = (SELECT public.obtener_mi_sucursal())
          AND EXISTS (
            SELECT 1
            FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::text, NULL)
          )
        )
      )
      WITH CHECK (
        (SELECT public.es_admin_nacional())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
        OR (
          sucursal = (SELECT public.obtener_mi_sucursal())
          AND cargado_por_uid = (SELECT auth.uid())
          AND EXISTS (
            SELECT 1
            FROM public.asistencias_jornada j
            WHERE j.id = asistencia_id
              AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::text, NULL)
          )
        )
      );

    CREATE POLICY asistencia_evidencias_delete_auth
      ON public.asistencia_evidencias
      FOR DELETE
      TO authenticated
      USING (
        (SELECT public.es_admin_nacional())
        OR (
          (SELECT public.fn_trade_is_asistencia_manager())
          AND sucursal = (SELECT public.obtener_mi_sucursal())
        )
      );
  END IF;

  -- 7.3 storage.objects para el bucket privado `asistencia-evidencias`
  IF to_regclass('storage.objects') IS NOT NULL THEN
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
          (SELECT public.es_admin_nacional())
          OR (SELECT public.is_torre_control_viewer())
          OR (
            (SELECT public.fn_trade_is_asistencia_manager())
            AND (
              (storage.foldername(name))[1] = 'asistencia'
              OR EXISTS (
                SELECT 1
                FROM public.promotoras pr
                WHERE (
                  pr.id::text = (storage.foldername(name))[1]
                  OR pr.auth_user_id::text = (storage.foldername(name))[1]
                )
                  AND pr.sucursal = (SELECT public.obtener_mi_sucursal())
              )
            )
          )
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::text
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
          OR name ~ '^asistencia/[0-9]{4}-[0-9]{2}-[0-9]{2}/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_.-]{8,96}\.(jpg|jpeg|png|webp)$'
        )
        AND (
          (SELECT public.es_admin_nacional())
          OR (SELECT public.fn_trade_is_asistencia_manager())
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::text
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
          (SELECT public.es_admin_nacional())
          OR (SELECT public.fn_trade_is_asistencia_manager())
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::text
          )
        )
      )
      WITH CHECK (
        bucket_id = 'asistencia-evidencias'
        AND name NOT LIKE '%..%'
        AND name NOT LIKE '/%'
        AND (
          (SELECT public.es_admin_nacional())
          OR (SELECT public.fn_trade_is_asistencia_manager())
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::text
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
          (SELECT public.es_admin_nacional())
          OR (SELECT public.fn_trade_is_asistencia_manager())
          OR (storage.foldername(name))[1] IN (
            COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'),
            (SELECT auth.uid())::text
          )
        )
      );
  END IF;
END
$$;

-- Refrescar caché de esquema de PostgREST
NOTIFY pgrst, 'reload schema';
