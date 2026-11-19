-- =============================================================================
-- HITO 1 — IDENTIDAD ÚNICA EN `public.profiles` Y AISLAMIENTO TOTAL ZULIA / VALENCIA / GLOBAL
-- Archivo: supabase/migrations/20261118000400_hito1_identidad_unica_y_aislamiento_sucursales.sql
--
-- Cierra hallazgos:
--   N-02 / B-02  Modelo único de identidad sobre `public.profiles` con 7 roles
--                (`super_admin`, `coordinacion`, `contraloria`, `vendedor`,
--                `promotora`, `cliente`, `chofer`), migración `supervisor` -> `coordinacion`,
--                columna obligatoria `sucursal` (`ZULIA`, `VALENCIA`, `GLOBAL` solo para
--                `super_admin` y `contraloria`), `obtener_mi_rol()` y `obtener_mi_sucursal()`
--                leyendo exclusivamente de `public.profiles` / `app_metadata`, y deprecación
--                no destructiva de `public.perfiles_acceso` (renombre sin borrar datos).
--   N-04 / B-03  Columna `sucursal`, índices, backfill seguro, triggers selladores en servidor
--                y políticas RLS estrictas (`ENABLE` + `FORCE ROW LEVEL SECURITY`) en las
--                8 tablas operativas (`staff`, `surveys`, `cronograma_degustaciones`,
--                `rutas_promotoras`, `asistencias_jornada`, `asistencia_evidencias`,
--                `solicitudes_contraloria`, `entregas_degustacion`) + `vendedores`,
--                `promotoras` y `reportes_trade`.
--   N-05         Políticas de escritura en `public.clientes` habilitadas para `super_admin`
--                y `coordinacion` dentro de su propia sucursal (gestión e importación).
--   N-06 (sede)  Filtro estricto por sucursal añadido a `surveys` para vendedores y torre.
--
-- Garantías inquebrantables:
--   1. Cero eliminación física de tablas ni vaciado masivo de registros maestros u operativos.
--   2. 100 % forward-only e idempotente (`IF NOT EXISTS`, bloques `DO` con guardas).
--   3. Cero uso de `user_metadata` o `auth.role()`; todo usa `(SELECT ...)` para initPlan.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. DOMINIO CONTROLADO `public.sucursal_codigo` Y CLASIFICADOR TERRITORIAL
-- =============================================================================
DO $$
BEGIN
  CREATE TYPE public.sucursal_codigo AS ENUM ('ZULIA', 'VALENCIA', 'GLOBAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.fn_inferir_sucursal_codigo(p_texto_ubicacion TEXT)
RETURNS public.sucursal_codigo
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
  v_es_zulia BOOLEAN := false;
  v_es_valencia BOOLEAN := false;
BEGIN
  IF p_texto_ubicacion IS NULL OR btrim(p_texto_ubicacion) = '' THEN
    RETURN NULL;
  END IF;

  v_norm := lower(
    translate(
      btrim(p_texto_ubicacion),
      'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ',
      'AEIOUAEIOUAEIOUNaeiouaeiouaeioun'
    )
  );

  v_es_zulia := v_norm ~ '\m(maracaibo|san francisco|cabimas|ciudad ojeda|lagunillas|machiques|santa barbara|mara|la concepcion|mene grande|bachaquero|tia juana|los puertos|costa oriental|zulia)\M';
  v_es_valencia := v_norm ~ '\m(valencia|naguanagua|san diego|los guayos|guacara|tocuyito|puerto cabello|mariara|bejuma|carlos arvelo|guigue|moron|carabobo)\M';

  IF v_es_zulia AND v_es_valencia THEN
    RETURN NULL;
  ELSIF v_es_zulia THEN
    RETURN 'ZULIA'::public.sucursal_codigo;
  ELSIF v_es_valencia THEN
    RETURN 'VALENCIA'::public.sucursal_codigo;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_inferir_sucursal_codigo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_inferir_sucursal_codigo(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_normalizar_sucursal_codigo(p_valor TEXT)
RETURNS public.sucursal_codigo
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_clean TEXT := upper(btrim(COALESCE(p_valor, '')));
BEGIN
  IF v_clean = '' THEN
    RETURN NULL;
  END IF;

  IF v_clean IN ('ZULIA', 'SUCURSAL ZULIA', 'MARACAIBO') THEN
    RETURN 'ZULIA'::public.sucursal_codigo;
  ELSIF v_clean IN ('VALENCIA', 'SUCURSAL VALENCIA', 'CARABOBO') THEN
    RETURN 'VALENCIA'::public.sucursal_codigo;
  ELSIF v_clean IN ('GLOBAL', 'NACIONAL', 'ADMIN_GENERAL') THEN
    RETURN 'GLOBAL'::public.sucursal_codigo;
  END IF;

  RETURN public.fn_inferir_sucursal_codigo(p_valor);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_normalizar_sucursal_codigo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_normalizar_sucursal_codigo(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_normalizar_rol_perfil(p_rol TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_raw TEXT := lower(btrim(COALESCE(p_rol, '')));
BEGIN
  IF v_raw IN ('super_admin', 'superadmin', 'admin_general', 'admin', 'gerencia', 'gerente_admin') THEN
    RETURN 'super_admin';
  ELSIF v_raw IN ('contraloria', 'analista_contraloria', 'contralor') THEN
    RETURN 'contraloria';
  ELSIF v_raw IN ('coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade', 'supervisor', 'supervisora', 'supervisor_trade') THEN
    RETURN 'coordinacion';
  ELSIF v_raw IN ('vendedor', 'fdv', 'fuerza_ventas') THEN
    RETURN 'vendedor';
  ELSIF v_raw = 'promotora' THEN
    RETURN 'promotora';
  ELSIF v_raw IN ('cliente', 'portal_cliente', 'cadena_comercial') THEN
    RETURN 'cliente';
  ELSIF v_raw IN ('chofer', 'conductor', 'logistica') THEN
    RETURN 'chofer';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_normalizar_rol_perfil(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_normalizar_rol_perfil(TEXT) TO authenticated, service_role;

-- =============================================================================
-- 2. LIMPIEZA PREVIA DE DEPENDENCIAS DE `perfiles_acceso` Y DE TIPOS LEGADOS
--    Se retiran triggers/políticas que referenciaban `perfiles_acceso`,
--    `obtener_mi_rol()::rol_trade` o `obtener_mi_sucursal()::sucursal_tipo`
--    ANTES de evolucionar las firmas y tipos de columna.
-- =============================================================================
DROP TRIGGER IF EXISTS trg_vincular_nuevo_auth_user_perfil ON auth.users;
DROP FUNCTION IF EXISTS public.fn_trigger_vincular_nuevo_auth_user();

DO $$
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_sync_promotora_a_perfil_acceso ON public.promotoras;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.fn_sync_promotora_a_perfil_acceso();
DROP FUNCTION IF EXISTS public.vincular_mi_usuario_auth();

DO $$
DECLARE
  v_pol RECORD;
BEGIN
  FOR v_pol IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('perfiles_acceso', 'promotoras', 'clientes', 'reportes_trade')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_pol.policyname, v_pol.tablename);
  END LOOP;
END $$;

-- =============================================================================
-- 3. UNIFICACIÓN DE `public.profiles` (7 ROLES + `sucursal` OBLIGATORIA)
--    Y MIGRACIÓN SEGURA DESDE `perfiles_acceso` ANTES DE DEPRECARLA
-- =============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

-- Retirar constraints de rol previos para permitir los 7 roles unificados
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS chk_profiles_role_minimalist,
  DROP CONSTRAINT IF EXISTS chk_profiles_corporate_roles,
  DROP CONSTRAINT IF EXISTS chk_profiles_unified_roles,
  DROP CONSTRAINT IF EXISTS chk_profiles_sucursal_por_rol;

-- Trigger de normalización previa a escritura en `public.profiles`
CREATE OR REPLACE FUNCTION public.fn_profiles_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_norm_role TEXT;
BEGIN
  NEW.email := lower(btrim(COALESCE(NEW.email, '')));
  NEW.full_name := btrim(COALESCE(NEW.full_name, ''));
  v_norm_role := public.fn_normalizar_rol_perfil(COALESCE(NEW.role, 'vendedor'));

  IF v_norm_role IS NOT NULL THEN
    NEW.role := v_norm_role;
  ELSE
    NEW.role := lower(btrim(COALESCE(NEW.role, '')));
  END IF;

  IF NEW.role = 'super_admin' THEN
    NEW.sucursal := 'GLOBAL'::public.sucursal_codigo;
  ELSIF NEW.role = 'contraloria' AND NEW.sucursal IS NULL THEN
    NEW.sucursal := 'GLOBAL'::public.sucursal_codigo;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_profiles_before_write() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_profiles_before_write ON public.profiles;
CREATE TRIGGER trg_profiles_before_write
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_profiles_before_write();

-- Migrar identidades activas/útiles desde `public.perfiles_acceso` hacia `public.profiles`
-- y vincular `public.staff.auth_user_id` cuando exista correspondencia unívoca por correo.
DO $$
DECLARE
  v_fallback_emails TEXT := '';
  v_fallback_count INTEGER := 0;
BEGIN
  IF to_regclass('public.perfiles_acceso') IS NOT NULL THEN
    INSERT INTO public.profiles (
      id,
      email,
      full_name,
      role,
      sucursal,
      is_active,
      must_change_password
    )
    SELECT
      COALESCE(pa.auth_user_id, u.id) AS resolved_uid,
      lower(btrim(COALESCE(u.email, pa.email))),
      COALESCE(NULLIF(btrim(pa.nombre_completo), ''), 'Usuario Trade Marketing'),
      CASE pa.rol::text
        WHEN 'admin_general' THEN 'super_admin'
        WHEN 'coordinadora' THEN 'coordinacion'
        ELSE 'promotora'
      END,
      CASE
        WHEN pa.rol::text = 'admin_general' THEN 'GLOBAL'::public.sucursal_codigo
        ELSE COALESCE(
          public.fn_normalizar_sucursal_codigo(pa.sucursal::text),
          'ZULIA'::public.sucursal_codigo
        )
      END,
      COALESCE(pa.activo, true),
      false
    FROM public.perfiles_acceso pa
    JOIN auth.users u
      ON u.id = pa.auth_user_id
      OR (pa.auth_user_id IS NULL AND lower(btrim(COALESCE(u.email, ''))) = lower(btrim(pa.email)))
    ON CONFLICT (id) DO UPDATE
    SET
      sucursal = COALESCE(public.profiles.sucursal, EXCLUDED.sucursal),
      full_name = CASE
        WHEN btrim(public.profiles.full_name) = '' THEN EXCLUDED.full_name
        ELSE public.profiles.full_name
      END,
      updated_at = now();

    IF to_regclass('public.staff') IS NOT NULL THEN
      UPDATE public.staff s
      SET
        auth_user_id = pa.auth_user_id,
        updated_at = now()
      FROM public.perfiles_acceso pa
      WHERE pa.auth_user_id IS NOT NULL
        AND s.auth_user_id IS NULL
        AND lower(btrim(COALESCE(s.email, ''))) = lower(btrim(pa.email))
        AND NOT EXISTS (
          SELECT 1
          FROM public.staff s2
          WHERE s2.auth_user_id = pa.auth_user_id
        );
    END IF;
  END IF;

  -- Normalizar roles existentes en `public.profiles` (`supervisor` -> `coordinacion`)
  UPDATE public.profiles p
  SET role = COALESCE(public.fn_normalizar_rol_perfil(p.role), 'vendedor')
  WHERE p.role IS DISTINCT FROM COALESCE(public.fn_normalizar_rol_perfil(p.role), 'vendedor');

  -- 1) Roles nacionales (`super_admin` siempre GLOBAL; `contraloria` GLOBAL si aún es NULL)
  UPDATE public.profiles
  SET sucursal = 'GLOBAL'::public.sucursal_codigo
  WHERE role = 'super_admin'
     OR (role = 'contraloria' AND sucursal IS NULL);

  -- 2) Rellenar `sucursal` para roles regionales desde `app_metadata` firmado en `auth.users`
  UPDATE public.profiles p
  SET sucursal = public.fn_normalizar_sucursal_codigo(u.raw_app_meta_data ->> 'sucursal')
  FROM auth.users u
  WHERE u.id = p.id
    AND p.sucursal IS NULL
    AND public.fn_normalizar_sucursal_codigo(u.raw_app_meta_data ->> 'sucursal') IN (
      'ZULIA'::public.sucursal_codigo,
      'VALENCIA'::public.sucursal_codigo
    );

  -- 3) Rellenar desde `public.promotoras` o `public.vendedores` por coincidencia de correo
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    UPDATE public.profiles p
    SET sucursal = public.fn_normalizar_sucursal_codigo(pr.sucursal::text)
    FROM public.promotoras pr
    WHERE p.sucursal IS NULL
      AND lower(btrim(COALESCE(pr.email, ''))) = lower(btrim(p.email))
      AND public.fn_normalizar_sucursal_codigo(pr.sucursal::text) IN (
        'ZULIA'::public.sucursal_codigo,
        'VALENCIA'::public.sucursal_codigo
      );
  END IF;

  IF to_regclass('public.vendedores') IS NOT NULL THEN
    UPDATE public.profiles p
    SET sucursal = public.fn_inferir_sucursal_codigo(v.zona)
    FROM public.vendedores v
    WHERE p.sucursal IS NULL
      AND lower(btrim(COALESCE(v.email, ''))) = lower(btrim(p.email))
      AND public.fn_inferir_sucursal_codigo(v.zona) IS NOT NULL;
  END IF;

  -- 4) Respaldo auditado para perfiles corporativos previos sin pista geográfica (ej. cuentas semilla):
  --    se asigna sede matriz `ZULIA` y se emite aviso explícito para revisión del super_admin,
  --    garantizando que `ALTER COLUMN sucursal SET NOT NULL` jamás aborte ni destruya cuentas.
  SELECT
    COUNT(*),
    COALESCE(string_agg(email, ', ' ORDER BY email), '')
  INTO v_fallback_count, v_fallback_emails
  FROM public.profiles
  WHERE sucursal IS NULL;

  IF v_fallback_count > 0 THEN
    UPDATE public.profiles
    SET sucursal = 'ZULIA'::public.sucursal_codigo
    WHERE sucursal IS NULL;

    RAISE WARNING '[AUDITORÍA HITO 1 - PROFILES] % perfil(es) previos sin sucursal explícita fueron asignados preventivamente a ZULIA (sede matriz). Verifique en Gestión de Usuarios: %',
      v_fallback_count, v_fallback_emails;
  END IF;

  -- Corregir cualquier combinación inválida heredada antes de activar el CHECK estricto
  UPDATE public.profiles
  SET sucursal = 'ZULIA'::public.sucursal_codigo
  WHERE sucursal = 'GLOBAL'::public.sucursal_codigo
    AND role NOT IN ('super_admin', 'contraloria');
END $$;

ALTER TABLE public.profiles
  ALTER COLUMN sucursal SET NOT NULL;

ALTER TABLE public.profiles
  ADD CONSTRAINT chk_profiles_unified_roles
    CHECK (role IN ('super_admin', 'coordinacion', 'contraloria', 'vendedor', 'promotora', 'cliente', 'chofer')),
  ADD CONSTRAINT chk_profiles_sucursal_por_rol
    CHECK (
      (role = 'super_admin' AND sucursal = 'GLOBAL'::public.sucursal_codigo)
      OR (
        role = 'contraloria'
        AND sucursal IN (
          'ZULIA'::public.sucursal_codigo,
          'VALENCIA'::public.sucursal_codigo,
          'GLOBAL'::public.sucursal_codigo
        )
      )
      OR (
        role IN ('coordinacion', 'vendedor', 'promotora', 'cliente', 'chofer')
        AND sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
      )
    );

CREATE INDEX IF NOT EXISTS idx_profiles_sucursal_role_active
  ON public.profiles (sucursal, role, is_active);

-- Sincronizar `role` y `sucursal` firmados hacia `auth.users.raw_app_meta_data`
UPDATE auth.users u
SET
  raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
    'role', p.role,
    'app_role', p.role,
    'sucursal', p.sucursal::text,
    'is_active', p.is_active
  ),
  updated_at = now()
FROM public.profiles p
WHERE u.id = p.id;

-- Deprecación NO DESTRUCTIVA de `public.perfiles_acceso`:
-- se revocan todos los permisos de clientes y se renombra a tabla histórica inactiva.
DO $$
BEGIN
  IF to_regclass('public.perfiles_acceso') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.perfiles_acceso FROM PUBLIC, anon, authenticated;

    IF to_regclass('public.perfiles_acceso_deprecado_hito1') IS NULL THEN
      ALTER TABLE public.perfiles_acceso RENAME TO perfiles_acceso_deprecado_hito1;
      COMMENT ON TABLE public.perfiles_acceso_deprecado_hito1 IS
        'Tabla paralela deprecada en Hito 1 sin borrado de datos. La única fuente autoritativa de identidad y sede es public.profiles.';
    END IF;
  END IF;
END $$;

-- =============================================================================
-- 4. FUNCIONES CENTRALES DE AUTORIZACIÓN Y SEDE (`profiles` + `app_metadata`)
-- =============================================================================
DROP FUNCTION IF EXISTS public.obtener_mi_rol();
DROP FUNCTION IF EXISTS public.obtener_mi_sucursal();

CREATE OR REPLACE FUNCTION public.current_active_profile_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_role TEXT;
  v_active BOOLEAN;
  v_jwt_role TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.role, p.is_active
  INTO v_role, v_active
  FROM public.profiles p
  WHERE p.id = v_uid
  LIMIT 1;

  IF FOUND THEN
    IF v_active IS DISTINCT FROM true THEN
      RETURN '__SUSPENDED__';
    END IF;
    RETURN v_role;
  END IF;

  -- Respaldo estricto sobre app_metadata firmado en servidor (JAMÁS user_metadata)
  v_jwt_role := public.fn_normalizar_rol_perfil(
    COALESCE(
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
      ''
    )
  );

  RETURN v_jwt_role;
END;
$$;

REVOKE ALL ON FUNCTION public.current_active_profile_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_active_profile_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.obtener_mi_rol()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := (SELECT public.current_active_profile_role());
BEGIN
  IF v_role IS NULL OR v_role = '__SUSPENDED__' THEN
    RETURN NULL;
  END IF;
  RETURN v_role;
END;
$$;

COMMENT ON FUNCTION public.obtener_mi_rol() IS
  'Devuelve el rol activo unificado del usuario autenticado desde public.profiles (con respaldo firmado en app_metadata).';

REVOKE ALL ON FUNCTION public.obtener_mi_rol() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_rol() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.obtener_mi_sucursal()
RETURNS public.sucursal_codigo
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_role TEXT;
  v_sucursal public.sucursal_codigo;
  v_active BOOLEAN;
  v_jwt_role TEXT;
  v_jwt_sucursal public.sucursal_codigo;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.role, p.sucursal, p.is_active
  INTO v_role, v_sucursal, v_active
  FROM public.profiles p
  WHERE p.id = v_uid
  LIMIT 1;

  IF FOUND THEN
    IF v_active IS DISTINCT FROM true THEN
      RETURN NULL;
    END IF;
    IF v_role = 'super_admin' THEN
      RETURN 'GLOBAL'::public.sucursal_codigo;
    END IF;
    IF v_sucursal = 'GLOBAL'::public.sucursal_codigo AND v_role NOT IN ('super_admin', 'contraloria') THEN
      RETURN NULL;
    END IF;
    RETURN v_sucursal;
  END IF;

  -- Respaldo controlado sobre app_metadata firmado en servidor para sesiones previas a alta en profiles
  v_jwt_role := public.obtener_mi_rol();
  IF v_jwt_role IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_jwt_role = 'super_admin' THEN
    RETURN 'GLOBAL'::public.sucursal_codigo;
  END IF;

  v_jwt_sucursal := public.fn_normalizar_sucursal_codigo(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'sucursal'
  );

  IF v_jwt_sucursal = 'GLOBAL'::public.sucursal_codigo AND v_jwt_role <> 'contraloria' THEN
    RETURN NULL;
  END IF;

  RETURN v_jwt_sucursal;
END;
$$;

COMMENT ON FUNCTION public.obtener_mi_sucursal() IS
  'Devuelve la sucursal autorizada (ZULIA, VALENCIA o GLOBAL) exclusivamente desde public.profiles / app_metadata.';

REVOKE ALL ON FUNCTION public.obtener_mi_sucursal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_sucursal() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tiene_acceso_sucursal(p_sucursal public.sucursal_codigo)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN (SELECT public.obtener_mi_sucursal()) = 'GLOBAL'::public.sucursal_codigo
         AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'contraloria')
      THEN true
    WHEN p_sucursal IS NOT NULL
         AND p_sucursal <> 'GLOBAL'::public.sucursal_codigo
         AND p_sucursal = (SELECT public.obtener_mi_sucursal())
      THEN true
    ELSE false
  END;
$$;

COMMENT ON FUNCTION public.tiene_acceso_sucursal(public.sucursal_codigo) IS
  'Evalúa aislamiento multi-sede: GLOBAL solo para super_admin/contraloria; los demás roles solo ven y operan su propia sede (ZULIA o VALENCIA). Filas con sucursal NULL quedan restringidas a GLOBAL.';

REVOKE ALL ON FUNCTION public.tiene_acceso_sucursal(public.sucursal_codigo) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tiene_acceso_sucursal(public.sucursal_codigo) TO authenticated, service_role;

-- Alinear helpers de rol al dominio unificado sin `supervisor` separado
CREATE OR REPLACE FUNCTION public.is_coordinadora_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion'),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_coordinadora_or_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_coordinadora_or_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_contraloria_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT public.obtener_mi_rol()) IN ('super_admin', 'contraloria'),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_contraloria_or_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_contraloria_or_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_torre_control_viewer()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion', 'contraloria'),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_torre_control_viewer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_torre_control_viewer() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_chofer_or_logistics_ops()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion', 'chofer'),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_chofer_or_logistics_ops() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_chofer_or_logistics_ops() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.current_app_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE((SELECT public.obtener_mi_rol()), '');
$$;

CREATE OR REPLACE FUNCTION private.is_strict_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT (SELECT public.is_super_admin());
$$;

CREATE OR REPLACE FUNCTION private.is_coordinator_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT (SELECT public.is_coordinadora_or_admin());
$$;

-- =============================================================================
-- 5. RPCs IAM ACTUALIZADAS PARA 7 ROLES Y `sucursal` OBLIGATORIA
-- =============================================================================
DROP FUNCTION IF EXISTS public.admin_list_profiles();
DROP FUNCTION IF EXISTS public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION public.admin_list_profiles()
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
  sucursal TEXT,
  is_active BOOLEAN,
  must_change_password BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'Acceso denegado: se requiere un perfil super_admin activo.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.email,
    p.full_name,
    p.role,
    p.sucursal::text,
    p.is_active,
    p.must_change_password,
    p.created_at,
    p.updated_at
  FROM public.profiles p
  ORDER BY
    CASE p.role
      WHEN 'super_admin' THEN 1
      WHEN 'contraloria' THEN 2
      WHEN 'coordinacion' THEN 3
      WHEN 'vendedor' THEN 4
      WHEN 'promotora' THEN 5
      WHEN 'chofer' THEN 6
      WHEN 'cliente' THEN 7
      ELSE 8
    END ASC,
    p.sucursal::text ASC,
    lower(p.full_name) ASC,
    lower(p.email) ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_update_user_access(
  p_target_user_id UUID,
  p_full_name TEXT,
  p_role TEXT,
  p_is_active BOOLEAN,
  p_must_change_password BOOLEAN DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
  sucursal TEXT,
  is_active BOOLEAN,
  must_change_password BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id UUID;
  v_clean_name TEXT;
  v_clean_role TEXT;
  v_target_sucursal public.sucursal_codigo;
  v_current public.profiles%ROWTYPE;
  v_updated public.profiles%ROWTYPE;
  v_remaining_super_admins BIGINT := 0;
  v_audit_action TEXT;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'Acceso denegado: se requiere un perfil super_admin activo.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := (SELECT auth.uid());

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'El identificador del usuario objetivo (p_target_user_id) es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  IF p_is_active IS NULL THEN
    RAISE EXCEPTION 'El estado de acceso (p_is_active) es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_name := btrim(COALESCE(p_full_name, ''));
  IF char_length(v_clean_name) < 2 OR char_length(v_clean_name) > 160 THEN
    RAISE EXCEPTION 'El nombre completo debe contener entre 2 y 160 caracteres.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_role := public.fn_normalizar_rol_perfil(p_role);
  IF v_clean_role IS NULL THEN
    RAISE EXCEPTION 'Rol inválido (%). Valores permitidos: super_admin, coordinacion, contraloria, vendedor, promotora, cliente, chofer.', p_role
      USING ERRCODE = '22023';
  END IF;

  IF p_target_user_id = v_actor_id THEN
    IF p_is_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes suspender tu propia cuenta de super_admin.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_clean_role <> 'super_admin' THEN
      RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes cambiar tu propio rol fuera de super_admin.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  PERFORM 1
  FROM public.profiles p
  WHERE p.role = 'super_admin'
  ORDER BY p.id
  FOR UPDATE;

  SELECT *
  INTO v_current
  FROM public.profiles p
  WHERE p.id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe el perfil solicitado (%) en public.profiles.', p_target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_clean_role = 'super_admin' THEN
    v_target_sucursal := 'GLOBAL'::public.sucursal_codigo;
  ELSIF p_sucursal IS NOT NULL AND btrim(p_sucursal) <> '' THEN
    v_target_sucursal := public.fn_normalizar_sucursal_codigo(p_sucursal);
    IF v_target_sucursal IS NULL THEN
      RAISE EXCEPTION 'Sucursal inválida (%). Valores permitidos: ZULIA, VALENCIA o GLOBAL.', p_sucursal
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_target_sucursal := v_current.sucursal;
    IF v_target_sucursal = 'GLOBAL'::public.sucursal_codigo AND v_clean_role <> 'contraloria' THEN
      RAISE EXCEPTION 'Debe asignar una sucursal regional (ZULIA o VALENCIA) al cambiar al rol %.', v_clean_role
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_target_sucursal = 'GLOBAL'::public.sucursal_codigo
     AND v_clean_role NOT IN ('super_admin', 'contraloria') THEN
    RAISE EXCEPTION 'La sucursal GLOBAL está reservada exclusivamente para super_admin y contraloria (recibido rol: %).', v_clean_role
      USING ERRCODE = '22023';
  END IF;

  IF v_current.role = 'super_admin'
     AND v_current.is_active = true
     AND (v_clean_role <> 'super_admin' OR p_is_active IS DISTINCT FROM true) THEN
    SELECT COUNT(*)
    INTO v_remaining_super_admins
    FROM public.profiles p
    WHERE p.role = 'super_admin'
      AND p.is_active = true
      AND p.id <> p_target_user_id;

    IF v_remaining_super_admins < 1 THEN
      RAISE EXCEPTION 'Operación bloqueada: el sistema debe mantener al menos un usuario super_admin activo.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.profiles p
  SET
    full_name = v_clean_name,
    role = v_clean_role,
    sucursal = v_target_sucursal,
    is_active = p_is_active,
    must_change_password = COALESCE(p_must_change_password, p.must_change_password),
    updated_at = now()
  WHERE p.id = p_target_user_id
  RETURNING * INTO v_updated;

  UPDATE auth.users u
  SET
    banned_until = CASE
      WHEN p_is_active THEN NULL
      ELSE '2099-12-31T23:59:59Z'::timestamptz
    END,
    raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', v_updated.role,
      'app_role', v_updated.role,
      'sucursal', v_updated.sucursal::text,
      'display_name', v_updated.full_name,
      'is_active', v_updated.is_active,
      'must_change_password', v_updated.must_change_password
    ),
    updated_at = now()
  WHERE u.id = p_target_user_id;

  v_audit_action := CASE
    WHEN v_current.is_active = true AND v_updated.is_active = false THEN 'USER_SUSPENDED'
    WHEN v_current.is_active = false AND v_updated.is_active = true THEN 'USER_REACTIVATED'
    WHEN v_current.role <> v_updated.role THEN 'USER_ROLE_CHANGED'
    WHEN v_current.sucursal IS DISTINCT FROM v_updated.sucursal THEN 'USER_BRANCH_CHANGED'
    ELSE 'USER_ACCESS_UPDATED'
  END;

  INSERT INTO public.user_management_audit (
    actor_id,
    target_user_id,
    target_email,
    action,
    details
  )
  VALUES (
    v_actor_id,
    v_updated.id,
    v_updated.email,
    v_audit_action,
    jsonb_build_object(
      'previous', jsonb_build_object(
        'full_name', v_current.full_name,
        'role', v_current.role,
        'sucursal', v_current.sucursal::text,
        'is_active', v_current.is_active,
        'must_change_password', v_current.must_change_password
      ),
      'next', jsonb_build_object(
        'full_name', v_updated.full_name,
        'role', v_updated.role,
        'sucursal', v_updated.sucursal::text,
        'is_active', v_updated.is_active,
        'must_change_password', v_updated.must_change_password
      )
    )
  );

  RETURN QUERY
  SELECT
    v_updated.id,
    v_updated.email,
    v_updated.full_name,
    v_updated.role,
    v_updated.sucursal::text,
    v_updated.is_active,
    v_updated.must_change_password,
    v_updated.created_at,
    v_updated.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_finalize_created_user(
  p_target_user_id UUID,
  p_full_name TEXT,
  p_role TEXT,
  p_must_change_password BOOLEAN DEFAULT false,
  p_sucursal TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
  sucursal TEXT,
  is_active BOOLEAN,
  must_change_password BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id UUID;
  v_clean_name TEXT;
  v_clean_role TEXT;
  v_clean_sucursal public.sucursal_codigo;
  v_must_change BOOLEAN;
  v_target_email TEXT;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'Acceso denegado: se requiere un perfil super_admin activo.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := (SELECT auth.uid());

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'El identificador del nuevo usuario (p_target_user_id) es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_name := btrim(COALESCE(p_full_name, ''));
  IF char_length(v_clean_name) < 2 OR char_length(v_clean_name) > 160 THEN
    RAISE EXCEPTION 'El nombre completo debe contener entre 2 y 160 caracteres.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_role := public.fn_normalizar_rol_perfil(p_role);
  IF v_clean_role IS NULL THEN
    RAISE EXCEPTION 'Rol inválido (%). Valores permitidos: super_admin, coordinacion, contraloria, vendedor, promotora, cliente, chofer.', p_role
      USING ERRCODE = '22023';
  END IF;

  IF p_target_user_id = v_actor_id AND v_clean_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes cambiar tu propio rol fuera de super_admin.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_clean_role = 'super_admin' THEN
    v_clean_sucursal := 'GLOBAL'::public.sucursal_codigo;
  ELSIF p_sucursal IS NULL OR btrim(p_sucursal) = '' THEN
    IF v_clean_role = 'contraloria' THEN
      v_clean_sucursal := 'GLOBAL'::public.sucursal_codigo;
    ELSE
      RAISE EXCEPTION 'La sucursal (ZULIA o VALENCIA) es obligatoria para el rol %.', v_clean_role
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_clean_sucursal := public.fn_normalizar_sucursal_codigo(p_sucursal);
    IF v_clean_sucursal IS NULL THEN
      RAISE EXCEPTION 'Sucursal inválida (%). Valores permitidos: ZULIA, VALENCIA o GLOBAL.', p_sucursal
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_clean_sucursal = 'GLOBAL'::public.sucursal_codigo
     AND v_clean_role NOT IN ('super_admin', 'contraloria') THEN
    RAISE EXCEPTION 'La sucursal GLOBAL está reservada exclusivamente para super_admin y contraloria (recibido rol: %).', v_clean_role
      USING ERRCODE = '22023';
  END IF;

  v_must_change := COALESCE(p_must_change_password, false);

  UPDATE auth.users u
  SET
    email_confirmed_at = COALESCE(u.email_confirmed_at, now()),
    banned_until = NULL,
    raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', v_clean_role,
      'app_role', v_clean_role,
      'sucursal', v_clean_sucursal::text,
      'display_name', v_clean_name,
      'is_active', true,
      'must_change_password', v_must_change
    ),
    updated_at = now()
  WHERE u.id = p_target_user_id
  RETURNING lower(btrim(COALESCE(u.email, ''))) INTO v_target_email;

  IF NOT FOUND OR v_target_email IS NULL OR v_target_email = '' THEN
    RAISE EXCEPTION 'El usuario objetivo (%) no existe en auth.users o carece de correo válido.', p_target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    role,
    sucursal,
    is_active,
    must_change_password
  )
  VALUES (
    p_target_user_id,
    v_target_email,
    v_clean_name,
    v_clean_role,
    v_clean_sucursal,
    true,
    v_must_change
  )
  ON CONFLICT (id) DO UPDATE
  SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    sucursal = EXCLUDED.sucursal,
    is_active = true,
    must_change_password = EXCLUDED.must_change_password,
    updated_at = now()
  RETURNING * INTO v_profile;

  INSERT INTO public.user_management_audit (
    actor_id,
    target_user_id,
    target_email,
    action,
    details
  )
  VALUES (
    v_actor_id,
    v_profile.id,
    v_profile.email,
    'USER_CREATED',
    jsonb_build_object(
      'full_name', v_profile.full_name,
      'role', v_profile.role,
      'sucursal', v_profile.sucursal::text,
      'is_active', v_profile.is_active,
      'must_change_password', v_profile.must_change_password,
      'provisioned_via', 'server_admin_api'
    )
  );

  RETURN QUERY
  SELECT
    v_profile.id,
    v_profile.email,
    v_profile.full_name,
    v_profile.role,
    v_profile.sucursal::text,
    v_profile.is_active,
    v_profile.must_change_password,
    v_profile.created_at,
    v_profile.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;

-- =============================================================================
-- 6. CONVERSIÓN DE `clientes`, `promotoras`, `reportes_trade` Y `vendedores`
--    A `public.sucursal_codigo` + COLUMNAS `sucursal` EN LAS 8 TABLAS OPERATIVAS
-- =============================================================================

-- 6.1 Convertir `sucursal` en tablas que usaban `public.sucursal_tipo` ('Zulia'/'Valencia')
ALTER TABLE public.clientes
  ALTER COLUMN sucursal TYPE public.sucursal_codigo
  USING public.fn_normalizar_sucursal_codigo(sucursal::text);

DO $$
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    ALTER TABLE public.promotoras
      ALTER COLUMN sucursal TYPE public.sucursal_codigo
      USING public.fn_normalizar_sucursal_codigo(sucursal::text);
  END IF;

  IF to_regclass('public.reportes_trade') IS NOT NULL THEN
    ALTER TABLE public.reportes_trade
      ALTER COLUMN sucursal TYPE public.sucursal_codigo
      USING public.fn_normalizar_sucursal_codigo(sucursal::text);
  END IF;
END $$;

-- 6.2 Añadir `sucursal public.sucursal_codigo` de forma idempotente en maestros y las 8 tablas operativas
ALTER TABLE public.vendedores
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

ALTER TABLE public.cronograma_degustaciones
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

ALTER TABLE public.rutas_promotoras
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

ALTER TABLE public.asistencias_jornada
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

ALTER TABLE public.asistencia_evidencias
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

ALTER TABLE public.solicitudes_contraloria
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

ALTER TABLE public.entregas_degustacion
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo;

-- Impedir que registros operativos o maestros almacenen `'GLOBAL'` como sede física
DO $$
DECLARE
  v_tbl TEXT;
  v_regional_tables TEXT[] := ARRAY[
    'clientes',
    'vendedores',
    'staff',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'asistencias_jornada',
    'asistencia_evidencias',
    'solicitudes_contraloria',
    'entregas_degustacion',
    'promotoras',
    'reportes_trade'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_regional_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS chk_%I_sucursal_regional',
        v_tbl,
        v_tbl
      );
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT chk_%I_sucursal_regional '
        || 'CHECK (sucursal IS NULL OR sucursal IN (''ZULIA''::public.sucursal_codigo, ''VALENCIA''::public.sucursal_codigo))',
        v_tbl,
        v_tbl
      );
    END IF;
  END LOOP;
END $$;

-- 6.3 Índices de rendimiento para todas las políticas RLS multi-sede
CREATE INDEX IF NOT EXISTS idx_clientes_sucursal_activo
  ON public.clientes (sucursal, activo);

CREATE INDEX IF NOT EXISTS idx_vendedores_sucursal_activo
  ON public.vendedores (sucursal, activo);

CREATE INDEX IF NOT EXISTS idx_staff_sucursal
  ON public.staff (sucursal);

CREATE INDEX IF NOT EXISTS idx_surveys_sucursal_type_created
  ON public.surveys (sucursal, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_sucursal_estado_fecha
  ON public.cronograma_degustaciones (sucursal, estado, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_sucursal_fecha
  ON public.rutas_promotoras (sucursal, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_asistencias_jornada_sucursal_fecha
  ON public.asistencias_jornada (sucursal, fecha_jornada DESC);

CREATE INDEX IF NOT EXISTS idx_asistencia_evidencias_sucursal_capturado
  ON public.asistencia_evidencias (sucursal, capturado_en_servidor DESC);

CREATE INDEX IF NOT EXISTS idx_solicitudes_contraloria_sucursal_estado_created
  ON public.solicitudes_contraloria (sucursal, estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entregas_degustacion_sucursal_fecha_turno
  ON public.entregas_degustacion (sucursal, fecha, turno);

-- =============================================================================
-- 7. BACKFILL DETERMINISTA Y REPORTE DE FILAS NO INFERIBLES (`NULL` -> SOLO `GLOBAL`)
-- =============================================================================
DO $$
DECLARE
  v_tbl TEXT;
  v_zulia BIGINT;
  v_valencia BIGINT;
  v_nulls BIGINT;
  v_backfill_tables TEXT[] := ARRAY[
    'clientes',
    'vendedores',
    'staff',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'asistencias_jornada',
    'asistencia_evidencias',
    'solicitudes_contraloria',
    'entregas_degustacion'
  ];
BEGIN
  -- 7.1 `vendedores`: desde `profiles`, inferencia en `zona`, o mayoría unívoca en `clientes`
  UPDATE public.vendedores v
  SET sucursal = p.sucursal
  FROM public.profiles p
  WHERE v.sucursal IS NULL
    AND v.email IS NOT NULL
    AND lower(btrim(v.email)) = lower(btrim(p.email))
    AND p.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.vendedores v
  SET sucursal = public.fn_inferir_sucursal_codigo(v.zona)
  WHERE v.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(v.zona) IS NOT NULL;

  UPDATE public.vendedores v
  SET sucursal = sub.unica_sucursal
  FROM (
    SELECT
      c.vendedor_id,
      (array_agg(DISTINCT c.sucursal))[1] AS unica_sucursal
    FROM public.clientes c
    WHERE c.vendedor_id IS NOT NULL
      AND c.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
    GROUP BY c.vendedor_id
    HAVING COUNT(DISTINCT c.sucursal) = 1
  ) sub
  WHERE v.id = sub.vendedor_id
    AND v.sucursal IS NULL;

  -- 7.2 `staff`: desde `profiles`, `promotoras` e inferencia territorial sobre `status`
  UPDATE public.staff s
  SET sucursal = p.sucursal
  FROM public.profiles p
  WHERE s.sucursal IS NULL
    AND (s.auth_user_id = p.id OR (btrim(s.email) <> '' AND lower(btrim(s.email)) = lower(btrim(p.email))))
    AND p.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    UPDATE public.staff s
    SET sucursal = pr.sucursal
    FROM public.promotoras pr
    WHERE s.sucursal IS NULL
      AND btrim(s.email) <> ''
      AND lower(btrim(s.email)) = lower(btrim(COALESCE(pr.email, '')))
      AND pr.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);
  END IF;

  UPDATE public.staff s
  SET sucursal = public.fn_inferir_sucursal_codigo(COALESCE(s.status, '') || ' | ' || COALESCE(s.role, ''))
  WHERE s.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(COALESCE(s.status, '') || ' | ' || COALESCE(s.role, '')) IS NOT NULL;

  -- 7.3 `surveys`: desde `profiles` (`autor_user_id`), `clientes` (`store`), `staff` e inferencia
  UPDATE public.surveys sv
  SET sucursal = p.sucursal
  FROM public.profiles p
  WHERE sv.sucursal IS NULL
    AND sv.autor_user_id = p.id
    AND p.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.surveys sv
  SET sucursal = c.sucursal
  FROM public.clientes c
  WHERE sv.sucursal IS NULL
    AND sv.store IS NOT NULL
    AND btrim(sv.store) <> ''
    AND (
      lower(btrim(c.razon_social)) = lower(btrim(sv.store))
      OR lower(btrim(COALESCE(c.nombre_comercial, ''))) = lower(btrim(sv.store))
    )
    AND c.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.surveys sv
  SET sucursal = st.sucursal
  FROM public.staff st
  WHERE sv.sucursal IS NULL
    AND st.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
    AND (
      (btrim(COALESCE(sv.email, '')) <> '' AND lower(btrim(sv.email)) = lower(btrim(st.email)))
      OR (btrim(COALESCE(sv.promoter, '')) <> '' AND lower(btrim(sv.promoter)) = lower(btrim(st.name)))
    );

  UPDATE public.surveys sv
  SET sucursal = public.fn_inferir_sucursal_codigo(concat_ws(' | ', sv.store, sv.comments))
  WHERE sv.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(concat_ws(' | ', sv.store, sv.comments)) IS NOT NULL;

  -- 7.4 `cronograma_degustaciones`: desde `surveys`, `staff`, `clientes` e inferencia
  UPDATE public.cronograma_degustaciones cd
  SET sucursal = sv.sucursal
  FROM public.surveys sv
  WHERE cd.sucursal IS NULL
    AND cd.survey_origen_id = sv.id
    AND sv.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.cronograma_degustaciones cd
  SET sucursal = st.sucursal
  FROM public.staff st
  WHERE cd.sucursal IS NULL
    AND cd.promotora_id = st.id
    AND st.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.cronograma_degustaciones cd
  SET sucursal = cl.sucursal
  FROM public.clientes cl
  WHERE cd.sucursal IS NULL
    AND cl.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
    AND (
      (btrim(cd.cliente_codigo) <> '' AND cl.codigo_cliente = upper(btrim(cd.cliente_codigo)))
      OR lower(btrim(cl.razon_social)) = lower(btrim(cd.cliente_nombre))
      OR lower(btrim(COALESCE(cl.nombre_comercial, ''))) = lower(btrim(cd.cliente_nombre))
    );

  UPDATE public.cronograma_degustaciones cd
  SET sucursal = public.fn_inferir_sucursal_codigo(concat_ws(' | ', cd.zona_direccion, cd.cliente_nombre, cd.observaciones))
  WHERE cd.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(concat_ws(' | ', cd.zona_direccion, cd.cliente_nombre, cd.observaciones)) IS NOT NULL;

  -- 7.5 `rutas_promotoras`: desde `cronograma_degustaciones`, `staff`, `clientes` e inferencia
  UPDATE public.rutas_promotoras rp
  SET sucursal = cd.sucursal
  FROM public.cronograma_degustaciones cd
  WHERE rp.sucursal IS NULL
    AND rp.cronograma_id = cd.id
    AND cd.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.rutas_promotoras rp
  SET sucursal = st.sucursal
  FROM public.staff st
  WHERE rp.sucursal IS NULL
    AND rp.promotora_id = st.id
    AND st.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.rutas_promotoras rp
  SET sucursal = public.fn_inferir_sucursal_codigo(concat_ws(' | ', rp.zona_direccion, rp.cliente_nombre))
  WHERE rp.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(concat_ws(' | ', rp.zona_direccion, rp.cliente_nombre)) IS NOT NULL;

  -- 7.6 `asistencias_jornada` y `asistencia_evidencias`
  UPDATE public.asistencias_jornada aj
  SET sucursal = st.sucursal
  FROM public.staff st
  WHERE aj.sucursal IS NULL
    AND aj.promotora_id = st.id
    AND st.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.asistencias_jornada aj
  SET sucursal = p.sucursal
  FROM public.profiles p
  WHERE aj.sucursal IS NULL
    AND aj.opened_by_uid = p.id
    AND p.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.asistencias_jornada aj
  SET sucursal = public.fn_inferir_sucursal_codigo(concat_ws(' | ', aj.zona, aj.pdv_nombre))
  WHERE aj.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(concat_ws(' | ', aj.zona, aj.pdv_nombre)) IS NOT NULL;

  UPDATE public.asistencia_evidencias ae
  SET sucursal = aj.sucursal
  FROM public.asistencias_jornada aj
  WHERE ae.sucursal IS NULL
    AND ae.asistencia_id = aj.id
    AND aj.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo);

  UPDATE public.asistencia_evidencias ae
  SET sucursal = public.fn_inferir_sucursal_codigo(ae.pdv_nombre)
  WHERE ae.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(ae.pdv_nombre) IS NOT NULL;

  -- 7.7 `solicitudes_contraloria`
  UPDATE public.solicitudes_contraloria sc
  SET sucursal = p.sucursal
  FROM public.profiles p
  WHERE sc.sucursal IS NULL
    AND p.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
    AND (
      lower(btrim(sc.solicitado_por)) = lower(btrim(p.email))
      OR lower(btrim(sc.solicitado_por)) = lower(btrim(p.full_name))
    );

  UPDATE public.solicitudes_contraloria sc
  SET sucursal = public.fn_inferir_sucursal_codigo(concat_ws(' | ', sc.para_ser_utilizado, sc.observacion))
  WHERE sc.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(concat_ws(' | ', sc.para_ser_utilizado, sc.observacion)) IS NOT NULL;

  -- 7.8 `entregas_degustacion`
  UPDATE public.entregas_degustacion ed
  SET sucursal = cl.sucursal
  FROM public.clientes cl
  WHERE ed.sucursal IS NULL
    AND cl.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
    AND (
      lower(btrim(cl.razon_social)) = lower(btrim(ed.cliente))
      OR lower(btrim(COALESCE(cl.nombre_comercial, ''))) = lower(btrim(ed.cliente))
    );

  UPDATE public.entregas_degustacion ed
  SET sucursal = st.sucursal
  FROM public.staff st
  WHERE ed.sucursal IS NULL
    AND st.sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
    AND btrim(ed.promotora) <> ''
    AND lower(btrim(st.name)) = lower(btrim(ed.promotora));

  UPDATE public.entregas_degustacion ed
  SET sucursal = public.fn_inferir_sucursal_codigo(concat_ws(' | ', ed.cliente, ed.notas_chofer))
  WHERE ed.sucursal IS NULL
    AND public.fn_inferir_sucursal_codigo(concat_ws(' | ', ed.cliente, ed.notas_chofer)) IS NOT NULL;

  -- Reporte auditable por tabla
  FOREACH v_tbl IN ARRAY v_backfill_tables LOOP
    EXECUTE format(
      'SELECT '
      || 'COUNT(*) FILTER (WHERE sucursal = ''ZULIA''::public.sucursal_codigo), '
      || 'COUNT(*) FILTER (WHERE sucursal = ''VALENCIA''::public.sucursal_codigo), '
      || 'COUNT(*) FILTER (WHERE sucursal IS NULL) '
      || 'FROM public.%I',
      v_tbl
    )
    INTO v_zulia, v_valencia, v_nulls;

    RAISE NOTICE '[BACKFILL HITO 1] public.% -> ZULIA=% | VALENCIA=% | NULL(solo GLOBAL)=%',
      v_tbl, v_zulia, v_valencia, v_nulls;
  END LOOP;
END $$;

-- =============================================================================
-- 8. TRIGGERS DE SELLO AUTOMÁTICO Y PROTECCIÓN ANTI-CRUCE DE SUCURSAL
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_mi_rol TEXT := (SELECT public.obtener_mi_rol());
  v_mi_sucursal public.sucursal_codigo := (SELECT public.obtener_mi_sucursal());
  v_inferida public.sucursal_codigo := NULL;
  v_json JSONB := to_jsonb(NEW);
  v_old_json JSONB := NULL;
BEGIN
  -- 1. En UPDATE: ningún usuario regional puede alterar una sucursal ya sellada
  IF TG_OP = 'UPDATE' THEN
    v_old_json := to_jsonb(OLD);

    IF NEW.sucursal IS DISTINCT FROM OLD.sucursal
       AND OLD.sucursal IS NOT NULL
       AND v_uid IS NOT NULL
       AND v_mi_rol IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'Cruce de sede bloqueado: no se permite cambiar la sucursal (%) de un registro en public.%.',
        OLD.sucursal, TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;

    -- Candado D6: el rol `chofer` solo puede actualizar campos de entrega en `entregas_degustacion`
    -- (se usa `to_jsonb` porque este trigger se comparte entre múltiples tablas con esquemas distintos)
    IF TG_TABLE_NAME = 'entregas_degustacion' AND v_mi_rol = 'chofer' THEN
      IF (v_json ->> 'fecha') IS DISTINCT FROM (v_old_json ->> 'fecha')
         OR (v_json ->> 'turno') IS DISTINCT FROM (v_old_json ->> 'turno')
         OR (v_json ->> 'numero_grupo_turno') IS DISTINCT FROM (v_old_json ->> 'numero_grupo_turno')
         OR (v_json ->> 'cliente') IS DISTINCT FROM (v_old_json ->> 'cliente')
         OR (v_json ->> 'producto') IS DISTINCT FROM (v_old_json ->> 'producto')
         OR (v_json ->> 'vendedor') IS DISTINCT FROM (v_old_json ->> 'vendedor')
         OR (v_json ->> 'promotora') IS DISTINCT FROM (v_old_json ->> 'promotora')
         OR NEW.sucursal IS DISTINCT FROM OLD.sucursal THEN
        RAISE EXCEPTION 'Acceso denegado: el rol chofer solo puede actualizar el estado y notas de la entrega.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- 2. Si el actor tiene sede regional (ZULIA o VALENCIA), forzar y verificar coincidencia estricta
  IF v_uid IS NOT NULL AND v_mi_sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo) THEN
    IF NEW.sucursal IS NOT NULL AND NEW.sucursal <> v_mi_sucursal THEN
      RAISE EXCEPTION 'Cruce de sede bloqueado en public.%: tu perfil pertenece a % y no puede escribir registros para %.',
        TG_TABLE_NAME, v_mi_sucursal, NEW.sucursal
        USING ERRCODE = '42501';
    END IF;
    NEW.sucursal := v_mi_sucursal;
  END IF;

  -- 3. Si es `super_admin` (`GLOBAL`) o proceso de servidor (`auth.uid() IS NULL`) y `NEW.sucursal` es NULL,
  --    resolver determinísticamente desde claves foráneas o columnas geográficas.
  IF NEW.sucursal IS NULL THEN
    IF TG_TABLE_NAME = 'asistencia_evidencias' AND NULLIF(btrim(COALESCE(v_json ->> 'asistencia_id', '')), '') IS NOT NULL THEN
      SELECT j.sucursal INTO v_inferida
      FROM public.asistencias_jornada j
      WHERE j.id = (v_json ->> 'asistencia_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'asistencias_jornada' AND NULLIF(btrim(COALESCE(v_json ->> 'promotora_id', '')), '') IS NOT NULL THEN
      SELECT s.sucursal INTO v_inferida
      FROM public.staff s
      WHERE s.id = (v_json ->> 'promotora_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'rutas_promotoras' AND NULLIF(btrim(COALESCE(v_json ->> 'cronograma_id', '')), '') IS NOT NULL THEN
      SELECT c.sucursal INTO v_inferida
      FROM public.cronograma_degustaciones c
      WHERE c.id = (v_json ->> 'cronograma_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'cronograma_degustaciones' THEN
      IF NULLIF(btrim(COALESCE(v_json ->> 'survey_origen_id', '')), '') IS NOT NULL THEN
        SELECT sv.sucursal INTO v_inferida
        FROM public.surveys sv
        WHERE sv.id = (v_json ->> 'survey_origen_id')::uuid
        LIMIT 1;
      END IF;
      IF v_inferida IS NULL AND NULLIF(btrim(COALESCE(v_json ->> 'promotora_id', '')), '') IS NOT NULL THEN
        SELECT s.sucursal INTO v_inferida
        FROM public.staff s
        WHERE s.id = (v_json ->> 'promotora_id')::uuid
        LIMIT 1;
      END IF;
    END IF;

    IF v_inferida IS NULL THEN
      v_inferida := public.fn_inferir_sucursal_codigo(
        concat_ws(
          ' | ',
          v_json ->> 'estado',
          v_json ->> 'ciudad',
          v_json ->> 'zona',
          v_json ->> 'ruta',
          v_json ->> 'direccion',
          v_json ->> 'zona_direccion',
          v_json ->> 'store',
          v_json ->> 'cliente_nombre',
          v_json ->> 'cliente',
          v_json ->> 'pdv_nombre',
          v_json ->> 'para_ser_utilizado'
        )
      );
    END IF;

    NEW.sucursal := v_inferida;
  END IF;

  -- Validación cruzada en `cronograma_degustaciones`: no asignar promotora de otra sucursal
  IF TG_TABLE_NAME = 'cronograma_degustaciones'
     AND NULLIF(btrim(COALESCE(v_json ->> 'promotora_id', '')), '') IS NOT NULL
     AND NEW.sucursal IS NOT NULL THEN
    PERFORM 1
    FROM public.staff s
    WHERE s.id = (v_json ->> 'promotora_id')::uuid
      AND s.sucursal IS NOT NULL
      AND s.sucursal <> NEW.sucursal;

    IF FOUND THEN
      RAISE EXCEPTION 'Cruce territorial prohibido: la promotora seleccionada pertenece a otra sucursal distinta de %.', NEW.sucursal
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sellar_y_proteger_sucursal_operativa() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_sellar_y_proteger_sucursal_operativa() TO authenticated, service_role;

DO $$
DECLARE
  v_tbl TEXT;
  v_trigger_tables TEXT[] := ARRAY[
    'clientes',
    'vendedores',
    'staff',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'asistencias_jornada',
    'asistencia_evidencias',
    'solicitudes_contraloria',
    'entregas_degustacion',
    'promotoras'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_trigger_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_hito1_sellar_sucursal ON public.%I',
        v_tbl
      );
      EXECUTE format(
        'CREATE TRIGGER trg_hito1_sellar_sucursal '
        || 'BEFORE INSERT OR UPDATE ON public.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa()',
        v_tbl
      );
    END IF;
  END LOOP;
END $$;

-- Actualizar `fn_sync_cronograma_to_rutas_promotoras` para propagar `sucursal` hacia `rutas_promotoras`
CREATE OR REPLACE FUNCTION public.fn_sync_cronograma_to_rutas_promotoras()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_target_estado_ruta TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') AND NEW.promotora_id IS NOT NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD.promotora_id IS NOT NULL
       AND OLD.promotora_id IS DISTINCT FROM NEW.promotora_id THEN
      DELETE FROM public.rutas_promotoras
      WHERE cronograma_id = NEW.id;
    END IF;

    v_target_estado_ruta := CASE
      WHEN NEW.estado = 'EN_CURSO' THEN 'EN_CURSO'
      WHEN NEW.estado = 'COMPLETADA' THEN 'COMPLETADA'
      ELSE 'ASIGNADA'
    END;

    INSERT INTO public.rutas_promotoras (
      cronograma_id,
      promotora_id,
      promotora_nombre,
      promotora_email,
      fecha,
      hora_inicio,
      hora_fin,
      turno,
      cliente_nombre,
      cliente_codigo,
      zona_direccion,
      producto_resumen,
      productos,
      cantidad_kilos,
      personas_estimadas,
      vendedor_fdv,
      observaciones,
      sucursal,
      estado_ruta,
      aprobado_por,
      asignado_at,
      updated_at
    ) VALUES (
      NEW.id,
      NEW.promotora_id,
      COALESCE(NEW.promotora_nombre, ''),
      COALESCE(NEW.promotora_email, ''),
      NEW.fecha,
      NEW.hora_inicio,
      NEW.hora_fin,
      NEW.turno,
      NEW.cliente_nombre,
      NEW.cliente_codigo,
      NEW.zona_direccion,
      NEW.producto_resumen,
      NEW.productos,
      NEW.cantidad_kilos,
      NEW.personas_estimadas,
      NEW.vendedor_fdv,
      NEW.observaciones,
      NEW.sucursal,
      v_target_estado_ruta,
      NEW.aprobado_por,
      NOW(),
      NOW()
    )
    ON CONFLICT (cronograma_id) DO UPDATE SET
      promotora_id = EXCLUDED.promotora_id,
      promotora_nombre = EXCLUDED.promotora_nombre,
      promotora_email = EXCLUDED.promotora_email,
      fecha = EXCLUDED.fecha,
      hora_inicio = EXCLUDED.hora_inicio,
      hora_fin = EXCLUDED.hora_fin,
      turno = EXCLUDED.turno,
      cliente_nombre = EXCLUDED.cliente_nombre,
      cliente_codigo = EXCLUDED.cliente_codigo,
      zona_direccion = EXCLUDED.zona_direccion,
      producto_resumen = EXCLUDED.producto_resumen,
      productos = EXCLUDED.productos,
      cantidad_kilos = EXCLUDED.cantidad_kilos,
      personas_estimadas = EXCLUDED.personas_estimadas,
      vendedor_fdv = EXCLUDED.vendedor_fdv,
      observaciones = EXCLUDED.observaciones,
      sucursal = COALESCE(EXCLUDED.sucursal, public.rutas_promotoras.sucursal),
      estado_ruta = CASE
        WHEN public.rutas_promotoras.estado_ruta IN ('EN_CURSO', 'COMPLETADA')
             AND NEW.estado = 'APROBADA'
          THEN public.rutas_promotoras.estado_ruta
        ELSE EXCLUDED.estado_ruta
      END,
      aprobado_por = EXCLUDED.aprobado_por,
      updated_at = NOW();
  ELSE
    DELETE FROM public.rutas_promotoras
    WHERE cronograma_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Endurecer `obtener_ruta_promotora` (SECURITY DEFINER) para validar propiedad y sucursal
CREATE OR REPLACE FUNCTION public.obtener_ruta_promotora(
  p_promotora_id UUID,
  p_fecha_desde DATE DEFAULT NULL,
  p_fecha_hasta DATE DEFAULT NULL
)
RETURNS SETOF public.rutas_promotoras
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_promotora UUID := (SELECT private.current_active_promotora_id());
  v_is_viewer BOOLEAN := (SELECT public.is_torre_control_viewer());
BEGIN
  IF (SELECT auth.uid()) IS NULL OR p_promotora_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT v_is_viewer AND v_caller_promotora IS DISTINCT FROM p_promotora_id THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT r.*
  FROM public.rutas_promotoras r
  WHERE r.promotora_id = p_promotora_id
    AND r.estado_ruta <> 'CANCELADA'
    AND (SELECT public.tiene_acceso_sucursal(r.sucursal))
    AND (p_fecha_desde IS NULL OR r.fecha >= p_fecha_desde)
    AND (p_fecha_hasta IS NULL OR r.fecha <= p_fecha_hasta)
  ORDER BY r.fecha ASC, r.hora_inicio ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_ruta_promotora(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_ruta_promotora(UUID, DATE, DATE) TO authenticated, service_role;

-- Actualizar `fn_forzar_integridad_reporte_trade` para usar `profiles` + `staff` (sin `perfiles_acceso`)
CREATE OR REPLACE FUNCTION public.fn_forzar_integridad_reporte_trade()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_rol TEXT;
  v_mi_sucursal public.sucursal_codigo;
  v_sucursal_cliente public.sucursal_codigo;
  v_cliente_activo BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
       OR NEW.promotora_id IS DISTINCT FROM OLD.promotora_id
       OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
       OR NEW.sucursal IS DISTINCT FROM OLD.sucursal THEN
      RAISE EXCEPTION 'Operación bloqueada: no se permite modificar sucursal, cliente_id, promotora_id ni auth_user_id en un reporte registrado.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticación requerida para registrar reportes de Trade Marketing.'
      USING ERRCODE = '42501';
  END IF;

  v_rol := (SELECT public.obtener_mi_rol());
  v_mi_sucursal := (SELECT public.obtener_mi_sucursal());

  IF v_rol <> 'promotora' OR v_mi_sucursal NOT IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo) THEN
    RAISE EXCEPTION 'Acceso denegado: solo una promotora activa con sucursal regional asignada puede registrar reportes.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.sucursal IS NOT NULL AND NEW.sucursal <> v_mi_sucursal THEN
    RAISE EXCEPTION 'Cruce de sede bloqueado: tu perfil pertenece a % y no puede enviar reportes para %.',
      v_mi_sucursal, NEW.sucursal
      USING ERRCODE = '42501';
  END IF;

  NEW.auth_user_id := v_uid;
  NEW.sucursal := v_mi_sucursal;

  IF NEW.cliente_id IS NULL THEN
    RAISE EXCEPTION 'Debe especificar un cliente_id válido.'
      USING ERRCODE = '23502';
  END IF;

  SELECT c.sucursal, c.activo
  INTO v_sucursal_cliente, v_cliente_activo
  FROM public.clientes c
  WHERE c.id = NEW.cliente_id
  LIMIT 1;

  IF NOT FOUND OR v_cliente_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'El cliente seleccionado (%) no existe o se encuentra inactivo.', NEW.cliente_id
      USING ERRCODE = '42501';
  END IF;

  IF v_sucursal_cliente IS DISTINCT FROM NEW.sucursal THEN
    RAISE EXCEPTION 'Cruce territorial prohibido: el cliente pertenece a % y la promotora opera en %.',
      COALESCE(v_sucursal_cliente::text, 'SIN_SUCURSAL'), NEW.sucursal
      USING ERRCODE = '42501';
  END IF;

  IF NEW.observaciones IS NOT NULL THEN
    NEW.observaciones := left(btrim(NEW.observaciones), 2000);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_forzar_integridad_reporte_trade() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 9. ROW LEVEL SECURITY ESTRICTO POR SUCURSAL (`ENABLE` + `FORCE ROW LEVEL SECURITY`)
--    Se purgan TODAS las políticas permisivas previas (incluidas `rbac_coordinadora_ops_*`
--    y `rbac_super_admin_all_*`) que carecían de filtro territorial, preservando
--    íntegramente las políticas `AS RESTRICTIVE` de inmutabilidad histórica.
-- =============================================================================
DO $$
DECLARE
  v_tbl TEXT;
  v_pol RECORD;
  v_isolated_tables TEXT[] := ARRAY[
    'clientes',
    'vendedores',
    'staff',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'asistencias_jornada',
    'asistencia_evidencias',
    'solicitudes_contraloria',
    'entregas_degustacion',
    'promotoras',
    'reportes_trade'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_isolated_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tbl);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_tbl);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', v_tbl);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', v_tbl);
    END IF;
  END LOOP;

  -- Eliminar únicamente políticas PERMISSIVE previas en las tablas aisladas;
  -- las políticas `AS RESTRICTIVE` de cierre histórico se conservan intactas.
  FOR v_pol IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY(v_isolated_tables)
      AND permissive = 'PERMISSIVE'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_pol.policyname, v_pol.tablename);
  END LOOP;
END $$;

-- 9.1 `public.clientes` (N-05: lectura por sede + escritura para `super_admin` y `coordinacion` en su sucursal)
CREATE POLICY clientes_select_sede
  ON public.clientes
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR (
        activo = true
        AND (SELECT public.obtener_mi_rol()) IN ('vendedor', 'promotora', 'chofer', 'cliente')
      )
    )
  );

CREATE POLICY clientes_insert_trade_sede
  ON public.clientes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY clientes_update_trade_sede
  ON public.clientes
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY clientes_delete_super_admin
  ON public.clientes
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_super_admin()));

-- 9.2 `public.vendedores`
CREATE POLICY vendedores_select_sede
  ON public.vendedores
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR (
        (SELECT public.obtener_mi_rol()) = 'vendedor'
        AND lower(btrim(COALESCE(email, ''))) = (SELECT private.current_jwt_email_normalized())
      )
    )
  );

CREATE POLICY vendedores_insert_trade_sede
  ON public.vendedores
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY vendedores_update_trade_sede
  ON public.vendedores
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY vendedores_delete_super_admin
  ON public.vendedores
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_super_admin()));

-- 9.3 `public.staff` (1/8 operativa)
CREATE POLICY staff_select_sede
  ON public.staff
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR auth_user_id = (SELECT auth.uid())
      OR (
        (SELECT private.current_jwt_email_normalized()) <> ''
        AND lower(btrim(COALESCE(email, ''))) = (SELECT private.current_jwt_email_normalized())
      )
    )
  );

CREATE POLICY staff_insert_trade_sede
  ON public.staff
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY staff_update_trade_sede
  ON public.staff
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY staff_delete_super_admin
  ON public.staff
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_super_admin()));

-- 9.4 `public.surveys` (2/8 operativa — cierra N-06 con autor + sucursal)
CREATE POLICY surveys_select_authenticated_roles
  ON public.surveys
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR (
        type = 'Degustacion'
        AND autor_user_id = (SELECT auth.uid())
        AND (SELECT public.obtener_mi_rol()) = 'vendedor'
      )
      OR (
        type <> 'Degustacion'
        AND (SELECT private.current_active_promotora_id()) IS NOT NULL
        AND lower(btrim(COALESCE("creatorId", email, ''))) = (SELECT private.current_jwt_email_normalized())
      )
    )
  );

CREATE POLICY surveys_insert_authenticated_fdv_or_trade
  ON public.surveys
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR (
        type = 'Degustacion'
        AND (SELECT public.obtener_mi_rol()) = 'vendedor'
        AND public.fn_is_survey_solicitada(comments)
      )
      OR (
        type <> 'Degustacion'
        AND (SELECT private.current_active_promotora_id()) IS NOT NULL
      )
    )
  );

CREATE POLICY surveys_update_authenticated_trade_or_fdv
  ON public.surveys
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR (
        type = 'Degustacion'
        AND autor_user_id = (SELECT auth.uid())
        AND COALESCE(en_historial, false) = false
        AND (SELECT public.obtener_mi_rol()) = 'vendedor'
        AND public.fn_is_survey_solicitada(comments)
      )
    )
  )
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR (
        type = 'Degustacion'
        AND autor_user_id = (SELECT auth.uid())
        AND COALESCE(en_historial, false) = false
        AND (SELECT public.obtener_mi_rol()) = 'vendedor'
        AND public.fn_is_survey_solicitada(comments)
      )
    )
  );

CREATE POLICY surveys_delete_super_admin
  ON public.surveys
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_super_admin()));

-- 9.5 `public.cronograma_degustaciones` (3/8 operativa)
CREATE POLICY cronograma_select_sede
  ON public.cronograma_degustaciones
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY cronograma_insert_trade_sede
  ON public.cronograma_degustaciones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY cronograma_update_trade_sede
  ON public.cronograma_degustaciones
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY cronograma_delete_trade_sede
  ON public.cronograma_degustaciones
  FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (
      (SELECT public.is_coordinadora_or_admin())
      AND (SELECT public.tiene_acceso_sucursal(sucursal))
    )
  );

-- 9.6 `public.rutas_promotoras` (4/8 operativa)
CREATE POLICY rutas_promotoras_select_sede
  ON public.rutas_promotoras
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR (
        (SELECT private.current_active_promotora_id()) IS NOT NULL
        AND COALESCE((SELECT public.obtener_mi_rol()), '') NOT IN ('vendedor', 'cliente', 'chofer')
        AND estado_ruta IN ('ASIGNADA', 'EN_CURSO', 'COMPLETADA')
        AND (
          promotora_id = (SELECT private.current_active_promotora_id())
          OR (
            (SELECT private.current_jwt_email_normalized()) <> ''
            AND lower(btrim(promotora_email)) = (SELECT private.current_jwt_email_normalized())
          )
        )
      )
    )
  );

CREATE POLICY rutas_promotoras_insert_trade_sede
  ON public.rutas_promotoras
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY rutas_promotoras_update_sede
  ON public.rutas_promotoras
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR (
        (SELECT private.current_active_promotora_id()) IS NOT NULL
        AND COALESCE((SELECT public.obtener_mi_rol()), '') NOT IN ('vendedor', 'cliente', 'chofer')
        AND estado_ruta IN ('ASIGNADA', 'EN_CURSO')
        AND (
          promotora_id = (SELECT private.current_active_promotora_id())
          OR (
            (SELECT private.current_jwt_email_normalized()) <> ''
            AND lower(btrim(promotora_email)) = (SELECT private.current_jwt_email_normalized())
          )
        )
      )
    )
  )
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR (
        (SELECT private.current_active_promotora_id()) IS NOT NULL
        AND COALESCE((SELECT public.obtener_mi_rol()), '') NOT IN ('vendedor', 'cliente', 'chofer')
        AND estado_ruta IN ('EN_CURSO', 'COMPLETADA')
        AND (
          promotora_id = (SELECT private.current_active_promotora_id())
          OR (
            (SELECT private.current_jwt_email_normalized()) <> ''
            AND lower(btrim(promotora_email)) = (SELECT private.current_jwt_email_normalized())
          )
        )
      )
    )
  );

CREATE POLICY rutas_promotoras_delete_trade_sede
  ON public.rutas_promotoras
  FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- 9.7 `public.asistencias_jornada` (5/8 operativa)
CREATE POLICY asistencias_jornada_select_sede
  ON public.asistencias_jornada
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

CREATE POLICY asistencias_jornada_insert_sede
  ON public.asistencias_jornada
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

CREATE POLICY asistencias_jornada_update_sede
  ON public.asistencias_jornada
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  )
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

CREATE POLICY asistencias_jornada_delete_trade_sede
  ON public.asistencias_jornada
  FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- 9.8 `public.asistencia_evidencias` (6/8 operativa)
CREATE POLICY asistencia_evidencias_select_sede
  ON public.asistencia_evidencias
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR EXISTS (
        SELECT 1
        FROM public.asistencias_jornada j
        WHERE j.id = asistencia_evidencias.asistencia_id
          AND j.promotora_id = (SELECT private.current_active_promotora_id())
      )
    )
  );

CREATE POLICY asistencia_evidencias_insert_sede
  ON public.asistencia_evidencias
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR EXISTS (
        SELECT 1
        FROM public.asistencias_jornada j
        WHERE j.id = asistencia_evidencias.asistencia_id
          AND j.promotora_id = (SELECT private.current_active_promotora_id())
      )
    )
  );

CREATE POLICY asistencia_evidencias_update_sede
  ON public.asistencia_evidencias
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR EXISTS (
        SELECT 1
        FROM public.asistencias_jornada j
        WHERE j.id = asistencia_evidencias.asistencia_id
          AND j.promotora_id = (SELECT private.current_active_promotora_id())
      )
    )
  )
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR EXISTS (
        SELECT 1
        FROM public.asistencias_jornada j
        WHERE j.id = asistencia_evidencias.asistencia_id
          AND j.promotora_id = (SELECT private.current_active_promotora_id())
      )
    )
  );

CREATE POLICY asistencia_evidencias_delete_trade_sede
  ON public.asistencia_evidencias
  FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- 9.9 `public.solicitudes_contraloria` (7/8 operativa — Segregación de Funciones + sucursal)
CREATE POLICY solicitudes_contraloria_select_sede
  ON public.solicitudes_contraloria
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY solicitudes_contraloria_insert_trade_sede
  ON public.solicitudes_contraloria
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND estado = 'PENDIENTE_APROBACION'
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY solicitudes_contraloria_update_contraloria_sede
  ON public.solicitudes_contraloria
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY solicitudes_contraloria_delete_super_admin
  ON public.solicitudes_contraloria
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_super_admin()));

-- 9.10 `public.entregas_degustacion` (8/8 operativa — chofer actualiza solo en su sucursal)
CREATE POLICY entregas_degustacion_select_sede
  ON public.entregas_degustacion
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR (SELECT public.is_chofer_or_logistics_ops())
    )
  );

CREATE POLICY entregas_degustacion_insert_coord_sede
  ON public.entregas_degustacion
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY entregas_degustacion_update_logistics_sede
  ON public.entregas_degustacion
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_chofer_or_logistics_ops())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_chofer_or_logistics_ops())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE POLICY entregas_degustacion_delete_coord_sede
  ON public.entregas_degustacion
  FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- 9.11 `public.promotoras` y `public.reportes_trade` (alineadas a `profiles` sin `perfiles_acceso`)
DO $$
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    CREATE POLICY promotoras_select_sede
      ON public.promotoras
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.tiene_acceso_sucursal(sucursal))
        AND (
          (SELECT public.is_torre_control_viewer())
          OR (
            (SELECT private.current_jwt_email_normalized()) <> ''
            AND lower(btrim(COALESCE(email, ''))) = (SELECT private.current_jwt_email_normalized())
          )
        )
      );

    CREATE POLICY promotoras_insert_trade_sede
      ON public.promotoras
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        AND (SELECT public.tiene_acceso_sucursal(sucursal))
      );

    CREATE POLICY promotoras_update_trade_sede
      ON public.promotoras
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT public.is_coordinadora_or_admin())
        AND (SELECT public.tiene_acceso_sucursal(sucursal))
      )
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        AND (SELECT public.tiene_acceso_sucursal(sucursal))
      );

    CREATE POLICY promotoras_delete_super_admin
      ON public.promotoras
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));
  END IF;

  IF to_regclass('public.reportes_trade') IS NOT NULL THEN
    CREATE POLICY reportes_trade_select_sede
      ON public.reportes_trade
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.tiene_acceso_sucursal(sucursal))
        AND (
          (SELECT public.is_torre_control_viewer())
          OR (
            (SELECT public.obtener_mi_rol()) = 'promotora'
            AND auth_user_id = (SELECT auth.uid())
          )
        )
      );

    CREATE POLICY reportes_trade_insert_promotora_sede
      ON public.reportes_trade
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.obtener_mi_rol()) = 'promotora'
        AND auth_user_id = (SELECT auth.uid())
        AND (SELECT public.tiene_acceso_sucursal(sucursal))
        AND EXISTS (
          SELECT 1
          FROM public.clientes c
          WHERE c.id = reportes_trade.cliente_id
            AND c.activo = true
            AND c.sucursal = reportes_trade.sucursal
        )
      );

    CREATE POLICY reportes_trade_update_super_admin
      ON public.reportes_trade
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()));

    CREATE POLICY reportes_trade_delete_super_admin
      ON public.reportes_trade
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));
  END IF;
END $$;

-- 9.12 Actualizar `rpc_sincronizar_vendedores` y `rpc_sincronizar_clientes` para respetar la sede
--      de la coordinadora al reconciliar registros ausentes (evita desactivar la otra sede).
CREATE OR REPLACE FUNCTION public.rpc_sincronizar_vendedores(
  p_registros JSONB,
  p_desactivar_ausentes BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_procesados INTEGER := 0;
  v_desactivados INTEGER := 0;
  v_codigos_procesados TEXT[] := ARRAY[]::TEXT[];
  v_mi_sucursal public.sucursal_codigo := (SELECT public.obtener_mi_sucursal());
BEGIN
  IF NOT (SELECT public.is_coordinadora_or_admin()) THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol coordinacion o super_admin activo para sincronizar vendedores.'
      USING ERRCODE = '42501';
  END IF;

  IF p_registros IS NOT NULL AND jsonb_typeof(p_registros) <> 'array' THEN
    RAISE EXCEPTION 'El parámetro p_registros debe ser un arreglo JSONB.'
      USING ERRCODE = '22023';
  END IF;

  WITH entrada_bruta AS (
    SELECT
      ord,
      UPPER(BTRIM(COALESCE(elem ->> 'codigo_vendedor', ''))) AS codigo_vendedor,
      BTRIM(COALESCE(elem ->> 'nombre_completo', '')) AS nombre_completo,
      NULLIF(BTRIM(COALESCE(elem ->> 'documento_identidad', '')), '') AS documento_identidad,
      NULLIF(BTRIM(COALESCE(elem ->> 'telefono', '')), '') AS telefono,
      LOWER(NULLIF(BTRIM(COALESCE(elem ->> 'email', '')), '')) AS email,
      NULLIF(BTRIM(COALESCE(elem ->> 'zona', '')), '') AS zona,
      NULLIF(BTRIM(COALESCE(elem ->> 'supervisor', '')), '') AS supervisor,
      CASE
        WHEN v_mi_sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
          THEN v_mi_sucursal
        ELSE public.fn_normalizar_sucursal_codigo(COALESCE(elem ->> 'sucursal', elem ->> 'zona'))
      END AS sucursal_resuelta,
      CASE
        WHEN jsonb_typeof(elem -> 'metadata') = 'object' THEN elem -> 'metadata'
        ELSE '{}'::jsonb
      END AS metadata
    FROM jsonb_array_elements(COALESCE(p_registros, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  ),
  lote_dedup AS (
    SELECT DISTINCT ON (codigo_vendedor)
      codigo_vendedor,
      nombre_completo,
      documento_identidad,
      telefono,
      email,
      zona,
      supervisor,
      CASE
        WHEN sucursal_resuelta IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
          THEN sucursal_resuelta
        ELSE NULL
      END AS sucursal,
      metadata
    FROM entrada_bruta
    WHERE codigo_vendedor <> ''
      AND nombre_completo <> ''
    ORDER BY codigo_vendedor, ord DESC
  ),
  upserted AS (
    INSERT INTO public.vendedores (
      codigo_vendedor,
      nombre_completo,
      documento_identidad,
      telefono,
      email,
      zona,
      supervisor,
      sucursal,
      activo,
      metadata,
      ultima_sincronizacion
    )
    SELECT
      codigo_vendedor,
      nombre_completo,
      documento_identidad,
      telefono,
      email,
      zona,
      supervisor,
      sucursal,
      true,
      metadata,
      v_now
    FROM lote_dedup
    ON CONFLICT (codigo_vendedor) DO UPDATE SET
      nombre_completo = EXCLUDED.nombre_completo,
      documento_identidad = COALESCE(EXCLUDED.documento_identidad, public.vendedores.documento_identidad),
      telefono = COALESCE(EXCLUDED.telefono, public.vendedores.telefono),
      email = COALESCE(EXCLUDED.email, public.vendedores.email),
      zona = COALESCE(EXCLUDED.zona, public.vendedores.zona),
      supervisor = COALESCE(EXCLUDED.supervisor, public.vendedores.supervisor),
      sucursal = COALESCE(public.vendedores.sucursal, EXCLUDED.sucursal),
      activo = true,
      metadata = COALESCE(public.vendedores.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      ultima_sincronizacion = v_now
    RETURNING codigo_vendedor
  )
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(ARRAY_AGG(codigo_vendedor), ARRAY[]::TEXT[])
  INTO v_procesados, v_codigos_procesados
  FROM upserted;

  IF cardinality(v_codigos_procesados) > 0 THEN
    UPDATE public.clientes c
    SET vendedor_id = v.id
    FROM public.vendedores v
    WHERE v.codigo_vendedor = ANY(v_codigos_procesados)
      AND c.codigo_vendedor = v.codigo_vendedor
      AND (SELECT public.tiene_acceso_sucursal(c.sucursal))
      AND c.vendedor_id IS DISTINCT FROM v.id;
  END IF;

  IF COALESCE(p_desactivar_ausentes, false) = true AND cardinality(v_codigos_procesados) > 0 THEN
    UPDATE public.vendedores v
    SET activo = false
    WHERE v.activo = true
      AND (SELECT public.tiene_acceso_sucursal(v.sucursal))
      AND NOT (v.codigo_vendedor = ANY(v_codigos_procesados));
    GET DIAGNOSTICS v_desactivados = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'procesados', v_procesados,
    'sin_vendedor_asignado', 0,
    'desactivados', v_desactivados
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_sincronizar_vendedores(JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_sincronizar_vendedores(JSONB, BOOLEAN) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_sincronizar_clientes(
  p_registros JSONB,
  p_codigos_activos_totales TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_procesados INTEGER := 0;
  v_sin_vendedor INTEGER := 0;
  v_desactivados INTEGER := 0;
  v_vendedores_faltantes TEXT[] := ARRAY[]::TEXT[];
  v_codigos_totales_norm TEXT[] := ARRAY[]::TEXT[];
  v_mi_sucursal public.sucursal_codigo := (SELECT public.obtener_mi_sucursal());
BEGIN
  IF NOT (SELECT public.is_coordinadora_or_admin()) THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol coordinacion o super_admin activo para sincronizar clientes.'
      USING ERRCODE = '42501';
  END IF;

  IF p_registros IS NOT NULL AND jsonb_typeof(p_registros) <> 'array' THEN
    RAISE EXCEPTION 'El parámetro p_registros debe ser un arreglo JSONB.'
      USING ERRCODE = '22023';
  END IF;

  WITH entrada_bruta AS (
    SELECT
      ord,
      UPPER(BTRIM(COALESCE(elem ->> 'codigo_cliente', ''))) AS codigo_cliente,
      BTRIM(COALESCE(elem ->> 'razon_social', '')) AS razon_social,
      NULLIF(UPPER(BTRIM(COALESCE(elem ->> 'codigo_vendedor', ''))), '') AS codigo_vendedor
    FROM jsonb_array_elements(COALESCE(p_registros, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  ),
  lote_dedup AS (
    SELECT DISTINCT ON (codigo_cliente)
      codigo_cliente,
      codigo_vendedor
    FROM entrada_bruta
    WHERE codigo_cliente <> ''
      AND razon_social <> ''
    ORDER BY codigo_cliente, ord DESC
  )
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(ARRAY_AGG(DISTINCT d.codigo_vendedor), ARRAY[]::TEXT[])
  INTO v_sin_vendedor, v_vendedores_faltantes
  FROM lote_dedup d
  LEFT JOIN public.vendedores v
    ON v.codigo_vendedor = d.codigo_vendedor
  WHERE d.codigo_vendedor IS NOT NULL
    AND v.id IS NULL;

  WITH entrada_bruta AS (
    SELECT
      ord,
      UPPER(BTRIM(COALESCE(elem ->> 'codigo_cliente', ''))) AS codigo_cliente,
      CASE
        WHEN UPPER(BTRIM(COALESCE(elem ->> 'rif', ''))) IN ('', '#N/D', 'N/D', 'N/A', '#N/A', 'NULL', 'SIN RIF', '-')
        THEN NULL
        ELSE REGEXP_REPLACE(UPPER(BTRIM(elem ->> 'rif')), '\s+', '', 'g')
      END AS rif,
      BTRIM(COALESCE(elem ->> 'razon_social', '')) AS razon_social,
      NULLIF(BTRIM(COALESCE(elem ->> 'nombre_comercial', '')), '') AS nombre_comercial,
      NULLIF(BTRIM(COALESCE(elem ->> 'canal', '')), '') AS canal,
      NULLIF(BTRIM(COALESCE(elem ->> 'segmento', '')), '') AS segmento,
      NULLIF(BTRIM(COALESCE(elem ->> 'zona', '')), '') AS zona,
      NULLIF(BTRIM(COALESCE(elem ->> 'ruta', '')), '') AS ruta,
      NULLIF(BTRIM(COALESCE(elem ->> 'direccion', '')), '') AS direccion,
      NULLIF(BTRIM(COALESCE(elem ->> 'ciudad', '')), '') AS ciudad,
      NULLIF(BTRIM(COALESCE(elem ->> 'estado', '')), '') AS estado,
      NULLIF(BTRIM(COALESCE(elem ->> 'telefono', '')), '') AS telefono,
      CASE
        WHEN (elem ->> 'latitud') ~ '^-?[0-9]+(\.[0-9]+)?$'
          AND ((elem ->> 'latitud')::NUMERIC BETWEEN -90 AND 90)
        THEN ROUND((elem ->> 'latitud')::NUMERIC, 7)
        ELSE NULL
      END AS latitud,
      CASE
        WHEN (elem ->> 'longitud') ~ '^-?[0-9]+(\.[0-9]+)?$'
          AND ((elem ->> 'longitud')::NUMERIC BETWEEN -180 AND 180)
        THEN ROUND((elem ->> 'longitud')::NUMERIC, 7)
        ELSE NULL
      END AS longitud,
      NULLIF(UPPER(BTRIM(COALESCE(elem ->> 'codigo_vendedor', ''))), '') AS codigo_vendedor,
      CASE
        WHEN v_mi_sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
          THEN v_mi_sucursal
        ELSE COALESCE(
          public.fn_normalizar_sucursal_codigo(elem ->> 'sucursal'),
          public.fn_inferir_sucursal_codigo(
            concat_ws(' | ', elem ->> 'estado', elem ->> 'ciudad', elem ->> 'zona', elem ->> 'ruta', elem ->> 'direccion')
          )
        )
      END AS sucursal_resuelta,
      CASE
        WHEN jsonb_typeof(elem -> 'metadata') = 'object' THEN elem -> 'metadata'
        ELSE '{}'::jsonb
      END AS metadata
    FROM jsonb_array_elements(COALESCE(p_registros, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  ),
  lote_dedup AS (
    SELECT DISTINCT ON (codigo_cliente)
      codigo_cliente,
      rif,
      razon_social,
      nombre_comercial,
      canal,
      segmento,
      zona,
      ruta,
      direccion,
      ciudad,
      estado,
      telefono,
      latitud,
      longitud,
      codigo_vendedor,
      CASE
        WHEN sucursal_resuelta IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
          THEN sucursal_resuelta
        ELSE NULL
      END AS sucursal,
      metadata
    FROM entrada_bruta
    WHERE codigo_cliente <> ''
      AND razon_social <> ''
    ORDER BY codigo_cliente, ord DESC
  ),
  upserted AS (
    INSERT INTO public.clientes (
      codigo_cliente,
      rif,
      razon_social,
      nombre_comercial,
      canal,
      segmento,
      zona,
      ruta,
      direccion,
      ciudad,
      estado,
      telefono,
      latitud,
      longitud,
      vendedor_id,
      codigo_vendedor,
      sucursal,
      activo,
      metadata,
      ultima_sincronizacion
    )
    SELECT
      d.codigo_cliente,
      d.rif,
      d.razon_social,
      d.nombre_comercial,
      d.canal,
      d.segmento,
      d.zona,
      d.ruta,
      d.direccion,
      d.ciudad,
      d.estado,
      d.telefono,
      d.latitud,
      d.longitud,
      v.id AS vendedor_id,
      d.codigo_vendedor,
      d.sucursal,
      true,
      d.metadata,
      v_now
    FROM lote_dedup d
    LEFT JOIN public.vendedores v
      ON v.codigo_vendedor = d.codigo_vendedor
    ON CONFLICT (codigo_cliente) DO UPDATE SET
      rif = COALESCE(EXCLUDED.rif, public.clientes.rif),
      razon_social = EXCLUDED.razon_social,
      nombre_comercial = COALESCE(EXCLUDED.nombre_comercial, public.clientes.nombre_comercial),
      canal = COALESCE(EXCLUDED.canal, public.clientes.canal),
      segmento = COALESCE(EXCLUDED.segmento, public.clientes.segmento),
      zona = COALESCE(EXCLUDED.zona, public.clientes.zona),
      ruta = COALESCE(EXCLUDED.ruta, public.clientes.ruta),
      direccion = COALESCE(EXCLUDED.direccion, public.clientes.direccion),
      ciudad = COALESCE(EXCLUDED.ciudad, public.clientes.ciudad),
      estado = COALESCE(EXCLUDED.estado, public.clientes.estado),
      telefono = COALESCE(EXCLUDED.telefono, public.clientes.telefono),
      latitud = COALESCE(EXCLUDED.latitud, public.clientes.latitud),
      longitud = COALESCE(EXCLUDED.longitud, public.clientes.longitud),
      vendedor_id = CASE
        WHEN EXCLUDED.codigo_vendedor IS NOT NULL THEN EXCLUDED.vendedor_id
        ELSE public.clientes.vendedor_id
      END,
      codigo_vendedor = COALESCE(EXCLUDED.codigo_vendedor, public.clientes.codigo_vendedor),
      sucursal = COALESCE(public.clientes.sucursal, EXCLUDED.sucursal),
      activo = true,
      metadata = COALESCE(public.clientes.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      ultima_sincronizacion = v_now
    RETURNING codigo_cliente
  )
  SELECT COUNT(*)::INTEGER
  INTO v_procesados
  FROM upserted;

  IF p_codigos_activos_totales IS NOT NULL THEN
    SELECT COALESCE(ARRAY_AGG(DISTINCT UPPER(BTRIM(c))), ARRAY[]::TEXT[])
    INTO v_codigos_totales_norm
    FROM unnest(p_codigos_activos_totales) AS c
    WHERE c IS NOT NULL AND BTRIM(c) <> '';

    IF cardinality(v_codigos_totales_norm) > 0 THEN
      UPDATE public.clientes cl
      SET activo = false
      WHERE cl.activo = true
        AND (SELECT public.tiene_acceso_sucursal(cl.sucursal))
        AND NOT (cl.codigo_cliente = ANY(v_codigos_totales_norm));
      GET DIAGNOSTICS v_desactivados = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'procesados', v_procesados,
    'sin_vendedor_asignado', v_sin_vendedor,
    'desactivados', v_desactivados,
    'codigos_vendedor_faltantes', to_jsonb(v_vendedores_faltantes)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_sincronizar_clientes(JSONB, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_sincronizar_clientes(JSONB, TEXT[]) TO authenticated, service_role;

COMMIT;
