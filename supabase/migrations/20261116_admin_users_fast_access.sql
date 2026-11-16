-- =============================================================================
-- CODIZULCA C.A. - FASE 1: MÓDULO "GESTIÓN DE USUARIOS" (IAM SUPER_ADMIN)
-- Archivo: supabase/migrations/20261116_admin_users_fast_access.sql
--
-- Modelo minimalista estricto:
--   - public.profiles: id, email, full_name, role ('super_admin' | 'coordinacion' | 'vendedor'),
--     is_active, must_change_password (boolean DEFAULT false), created_at, updated_at.
--   - public.user_management_audit: bitácora inmutable de altas, cambios de rol y suspensiones,
--     con RLS de lectura exclusivo para super_admin activo.
--
-- Garantías estrictas de seguridad:
--   1. Cero secretos, contraseñas o llaves en SQL.
--   2. Toda función SECURITY DEFINER declara SET search_path = public, revoca EXECUTE
--      a PUBLIC y anon, y lo concede únicamente a authenticated.
--   3. La primera instrucción ejecutable de cada RPC administrativa verifica en
--      public.profiles que auth.uid() tenga role = 'super_admin' e is_active = true.
--   4. Candado Anti Auto-Bloqueo transaccional: prohíbe auto-suspensión o auto-degradación
--      de rol sobre auth.uid() e impide dejar el sistema con cero usuarios super_admin activos.
--   5. Endurecimiento de helpers previos (public.es_admin_trade, private.is_strict_admin,
--      private.is_coordinator_or_admin) para exigir is_active = true en public.profiles.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. TABLA MINIMALISTA IDEMPOTENTE: public.profiles
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'vendedor',
  is_active BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compatibilidad idempotente si public.profiles ya existía parcialmente en el proyecto
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'vendedor',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.profiles
  ALTER COLUMN is_active SET DEFAULT true,
  ALTER COLUMN must_change_password SET DEFAULT false,
  ALTER COLUMN role SET DEFAULT 'vendedor',
  ALTER COLUMN updated_at SET DEFAULT now();

-- Normalización defensiva de alias previos antes de aplicar CHECK de dominio estricto
UPDATE public.profiles
SET role = CASE
  WHEN lower(btrim(role)) IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin') THEN 'super_admin'
  WHEN lower(btrim(role)) IN ('coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade', 'supervisor', 'analista_contraloria') THEN 'coordinacion'
  ELSE 'vendedor'
END
WHERE role IS DISTINCT FROM CASE
  WHEN lower(btrim(role)) IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin') THEN 'super_admin'
  WHEN lower(btrim(role)) IN ('coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade', 'supervisor', 'analista_contraloria') THEN 'coordinacion'
  ELSE 'vendedor'
END;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_profiles_role_minimalist'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT chk_profiles_role_minimalist
      CHECK (role IN ('super_admin', 'coordinacion', 'vendedor'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_role_active
  ON public.profiles (role, is_active);

CREATE INDEX IF NOT EXISTS idx_profiles_email_lower
  ON public.profiles (lower(email));

-- Bootstrap idempotente sin credenciales para el Administrador General si ya existe en auth.users
INSERT INTO public.profiles (id, email, full_name, role, is_active, must_change_password)
SELECT
  u.id,
  lower(btrim(u.email)),
  COALESCE(
    NULLIF(btrim(u.raw_app_meta_data ->> 'display_name'), ''),
    NULLIF(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    'Administrador General'
  ),
  'super_admin',
  true,
  false
FROM auth.users u
WHERE u.email IS NOT NULL
  AND lower(btrim(u.email)) = 'admin@codizulca.com'
ON CONFLICT (id) DO UPDATE
SET
  email = EXCLUDED.email,
  role = 'super_admin',
  is_active = true,
  updated_at = now();

UPDATE auth.users u
SET
  email_confirmed_at = COALESCE(u.email_confirmed_at, now()),
  banned_until = NULL,
  raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
    'role', 'super_admin',
    'app_role', 'super_admin',
    'is_active', true
  )
WHERE u.email IS NOT NULL
  AND lower(btrim(u.email)) = 'admin@codizulca.com';

-- Trigger liviano para mantener updated_at e higiene de email en minúsculas
CREATE OR REPLACE FUNCTION public.fn_profiles_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.email := lower(btrim(COALESCE(NEW.email, '')));
  NEW.full_name := btrim(COALESCE(NEW.full_name, ''));
  NEW.role := lower(btrim(COALESCE(NEW.role, 'vendedor')));
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

-- Defensa adicional a nivel tabla: impide eliminar o desactivar el último super_admin activo
CREATE OR REPLACE FUNCTION public.fn_prevent_zero_active_super_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'super_admin' AND OLD.is_active = true THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.role = 'super_admin'
          AND p.is_active = true
          AND p.id <> OLD.id
      ) THEN
        RAISE EXCEPTION 'Operación bloqueada: no se puede eliminar el último usuario super_admin activo.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.role = 'super_admin'
       AND OLD.is_active = true
       AND (NEW.role <> 'super_admin' OR NEW.is_active IS DISTINCT FROM true) THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.role = 'super_admin'
          AND p.is_active = true
          AND p.id <> OLD.id
      ) THEN
        RAISE EXCEPTION 'Operación bloqueada: el sistema no puede quedar con cero usuarios super_admin activos.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_prevent_zero_active_super_admin() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_profiles_prevent_zero_super_admin ON public.profiles;

CREATE TRIGGER trg_profiles_prevent_zero_super_admin
  BEFORE UPDATE OR DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_prevent_zero_active_super_admin();

-- =============================================================================
-- 2. HELPERS IAM EN POSTGRESQL (CON VALIDACIÓN ESTRICTA DE is_active = true)
-- =============================================================================

-- Verifica sin recursión RLS si el usuario autenticado actual es un super_admin activo
CREATE OR REPLACE FUNCTION public.is_active_super_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'super_admin'
      AND p.is_active = true
  );
END;
$$;

COMMENT ON FUNCTION public.is_active_super_admin() IS
  'Retorna true únicamente si auth.uid() existe en public.profiles con role = super_admin e is_active = true.';

REVOKE ALL ON FUNCTION public.is_active_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_super_admin() TO authenticated;

-- Resuelve el estado/rol de public.profiles para reforzar helpers globales con is_active = true:
--   - Retorna '__SUSPENDED__' si existe fila en public.profiles con is_active = false.
--   - Retorna p.role ('super_admin' | 'coordinacion' | 'vendedor') si existe fila activa.
--   - Retorna NULL si el usuario aún no posee fila en public.profiles (compatibilidad controlada).
CREATE OR REPLACE FUNCTION public.current_active_profile_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_active BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.role, p.is_active
  INTO v_role, v_active
  FROM public.profiles p
  WHERE p.id = auth.uid()
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_active IS DISTINCT FROM true THEN
    RETURN '__SUSPENDED__';
  END IF;

  RETURN v_role;
END;
$$;

REVOKE ALL ON FUNCTION public.current_active_profile_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_active_profile_role() TO authenticated;

-- Endurecimiento de funciones de autorización preexistentes para validar is_active = true
CREATE OR REPLACE FUNCTION public.es_admin_trade()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN (SELECT public.current_active_profile_role()) = '__SUSPENDED__' THEN false
    WHEN (SELECT public.current_active_profile_role()) IN ('super_admin', 'coordinacion') THEN true
    WHEN (SELECT public.current_active_profile_role()) IS NOT NULL THEN false
    ELSE COALESCE(
      LOWER(BTRIM(COALESCE(
        (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
        (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role'
      ))) IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'coordinacion', 'coordinadora'),
      false
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.es_admin_trade() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_admin_trade() TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.is_strict_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN (SELECT public.current_active_profile_role()) = '__SUSPENDED__' THEN false
    WHEN (SELECT public.current_active_profile_role()) = 'super_admin' THEN true
    WHEN (SELECT public.current_active_profile_role()) IS NOT NULL THEN false
    ELSE (SELECT private.current_app_role()) IN (
      'super_admin',
      'superadmin',
      'admin',
      'gerencia',
      'gerente_admin'
    )
  END;
$$;

CREATE OR REPLACE FUNCTION private.is_coordinator_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN (SELECT public.current_active_profile_role()) = '__SUSPENDED__' THEN false
    WHEN (SELECT public.current_active_profile_role()) IN ('super_admin', 'coordinacion') THEN true
    WHEN (SELECT public.current_active_profile_role()) IS NOT NULL THEN false
    ELSE (SELECT private.current_app_role()) IN (
      'super_admin',
      'superadmin',
      'admin',
      'gerencia',
      'gerente_admin',
      'coordinacion',
      'coordinadora',
      'coordinadora_trade',
      'jefe_trade',
      'supervisor',
      'analista_contraloria'
    )
  END;
$$;

-- =============================================================================
-- 3. RLS Y PRIVILEGIOS DE MÍNIMO ACCESO EN public.profiles
-- =============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profiles TO authenticated;

DROP POLICY IF EXISTS profiles_select_self_or_super_admin ON public.profiles;

CREATE POLICY profiles_select_self_or_super_admin
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (SELECT public.is_active_super_admin())
  );

-- =============================================================================
-- 4. TABLA DE AUDITORÍA IAM: public.user_management_audit
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.user_management_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_email TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_mgmt_audit_created_at
  ON public.user_management_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_mgmt_audit_actor_id
  ON public.user_management_audit (actor_id);

CREATE INDEX IF NOT EXISTS idx_user_mgmt_audit_target_user_id
  ON public.user_management_audit (target_user_id);

ALTER TABLE public.user_management_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_management_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_management_audit TO authenticated;

DROP POLICY IF EXISTS user_management_audit_select_super_admin ON public.user_management_audit;

CREATE POLICY user_management_audit_select_super_admin
  ON public.user_management_audit
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_active_super_admin()));

-- =============================================================================
-- 5. RPCs ADMINISTRATIVAS EXCLUSIVAS PARA super_admin ACTIVO
-- =============================================================================

-- 5.1 Listar perfiles ordenados por jerarquía de rol y nombre
CREATE OR REPLACE FUNCTION public.admin_list_profiles()
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
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
  -- 1ª instrucción obligatoria: validación estricta de super_admin activo
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'super_admin'
      AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'Acceso denegado: se requiere un perfil super_admin activo.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.email,
    p.full_name,
    p.role,
    p.is_active,
    p.must_change_password,
    p.created_at,
    p.updated_at
  FROM public.profiles p
  ORDER BY
    CASE p.role
      WHEN 'super_admin' THEN 1
      WHEN 'coordinacion' THEN 2
      WHEN 'vendedor' THEN 3
      ELSE 4
    END ASC,
    lower(p.full_name) ASC,
    lower(p.email) ASC;
END;
$$;

COMMENT ON FUNCTION public.admin_list_profiles() IS
  'Lista todos los perfiles de public.profiles ordenados por rol y nombre. Exclusivo para super_admin activo.';

REVOKE ALL ON FUNCTION public.admin_list_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles() TO authenticated;

-- 5.2 Actualizar nombre, rol, estado (Activo/Suspendido) y bandera opcional must_change_password
CREATE OR REPLACE FUNCTION public.admin_update_user_access(
  p_target_user_id UUID,
  p_full_name TEXT,
  p_role TEXT,
  p_is_active BOOLEAN,
  p_must_change_password BOOLEAN DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
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
  v_current public.profiles%ROWTYPE;
  v_updated public.profiles%ROWTYPE;
  v_remaining_super_admins BIGINT := 0;
  v_audit_action TEXT;
BEGIN
  -- 1ª instrucción obligatoria: validación estricta de super_admin activo
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'super_admin'
      AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'Acceso denegado: se requiere un perfil super_admin activo.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := auth.uid();

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

  v_clean_role := lower(btrim(COALESCE(p_role, '')));
  IF v_clean_role NOT IN ('super_admin', 'coordinacion', 'vendedor') THEN
    RAISE EXCEPTION 'Rol inválido (%). Valores permitidos: super_admin, coordinacion, vendedor.', p_role
      USING ERRCODE = '22023';
  END IF;

  -- REGLA ANTI AUTO-BLOQUEO DIRECTA SOBRE auth.uid()
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

  -- Bloqueo determinista de filas super_admin para impedir condición de carrera (write skew)
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

  -- REGLA ANTI CERO SUPER_ADMIN ACTIVOS
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
    is_active = p_is_active,
    must_change_password = COALESCE(p_must_change_password, p.must_change_password),
    updated_at = now()
  WHERE p.id = p_target_user_id
  RETURNING * INTO v_updated;

  -- Sincronización de estado y metadatos firmados en auth.users (sin exponer service_role al cliente)
  UPDATE auth.users u
  SET
    banned_until = CASE
      WHEN p_is_active THEN NULL
      ELSE '2099-12-31T23:59:59Z'::timestamptz
    END,
    raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', v_updated.role,
      'app_role', v_updated.role,
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
        'is_active', v_current.is_active,
        'must_change_password', v_current.must_change_password
      ),
      'next', jsonb_build_object(
        'full_name', v_updated.full_name,
        'role', v_updated.role,
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
    v_updated.is_active,
    v_updated.must_change_password,
    v_updated.created_at,
    v_updated.updated_at;
END;
$$;

COMMENT ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) IS
  'Actualiza nombre, rol, estado y must_change_password en public.profiles con protección anti auto-bloqueo y auditoría.';

REVOKE ALL ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) TO authenticated;

-- 5.3 Finalizar usuario recién creado: confirmar email en auth.users, crear/actualizar perfil activo y auditar
CREATE OR REPLACE FUNCTION public.admin_finalize_created_user(
  p_target_user_id UUID,
  p_full_name TEXT,
  p_role TEXT,
  p_must_change_password BOOLEAN DEFAULT false
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
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
  v_must_change BOOLEAN;
  v_target_email TEXT;
  v_profile public.profiles%ROWTYPE;
BEGIN
  -- 1ª instrucción obligatoria: validación estricta de super_admin activo
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'super_admin'
      AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'Acceso denegado: se requiere un perfil super_admin activo.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := auth.uid();

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'El identificador del nuevo usuario (p_target_user_id) es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_name := btrim(COALESCE(p_full_name, ''));
  IF char_length(v_clean_name) < 2 OR char_length(v_clean_name) > 160 THEN
    RAISE EXCEPTION 'El nombre completo debe contener entre 2 y 160 caracteres.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_role := lower(btrim(COALESCE(p_role, '')));
  IF v_clean_role NOT IN ('super_admin', 'coordinacion', 'vendedor') THEN
    RAISE EXCEPTION 'Rol inválido (%). Valores permitidos: super_admin, coordinacion, vendedor.', p_role
      USING ERRCODE = '22023';
  END IF;

  -- Defensa anti auto-bloqueo también en caso de invocación sobre auth.uid()
  IF p_target_user_id = v_actor_id AND v_clean_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes cambiar tu propio rol fuera de super_admin.'
      USING ERRCODE = 'P0001';
  END IF;

  v_must_change := COALESCE(p_must_change_password, false);

  -- Sello inmediato sin fricción en auth.users: confirma email si estuviera nulo y firma app_metadata
  UPDATE auth.users u
  SET
    email_confirmed_at = COALESCE(u.email_confirmed_at, now()),
    banned_until = NULL,
    raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', v_clean_role,
      'app_role', v_clean_role,
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
    is_active,
    must_change_password
  )
  VALUES (
    p_target_user_id,
    v_target_email,
    v_clean_name,
    v_clean_role,
    true,
    v_must_change
  )
  ON CONFLICT (id) DO UPDATE
  SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
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
      'is_active', v_profile.is_active,
      'must_change_password', v_profile.must_change_password,
      'email_confirmed_sealed', true
    )
  );

  RETURN QUERY
  SELECT
    v_profile.id,
    v_profile.email,
    v_profile.full_name,
    v_profile.role,
    v_profile.is_active,
    v_profile.must_change_password,
    v_profile.created_at,
    v_profile.updated_at;
END;
$$;

COMMENT ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN) IS
  'Confirma de inmediato email_confirmed_at en auth.users, inserta/actualiza public.profiles activo y registra auditoría.';

REVOKE ALL ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

-- 5.4 RPC de autoservicio acotada para limpiar must_change_password tras cambio de clave propio
CREATE OR REPLACE FUNCTION public.complete_own_password_change()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'Acceso denegado: cuenta no autenticada o suspendida.'
      USING ERRCODE = '42501';
  END IF;

  v_uid := auth.uid();

  UPDATE public.profiles
  SET
    must_change_password = false,
    updated_at = now()
  WHERE id = v_uid;

  UPDATE auth.users u
  SET
    raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'must_change_password', false
    ),
    updated_at = now()
  WHERE u.id = v_uid;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_own_password_change() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_own_password_change() TO authenticated;

COMMIT;
