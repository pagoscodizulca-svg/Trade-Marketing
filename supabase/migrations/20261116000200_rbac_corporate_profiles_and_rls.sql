-- =============================================================================
-- CODIZULCA C.A. - ARQUITECTURA RBAC CORPORATIVA, RLS GLOBAL Y TRIGGER DE ALTA
-- Archivo: supabase/migrations/20261116_rbac_corporate_profiles_and_rls.sql
--
-- Objetivo:
--   1. Resolver definitivamente el bloqueo post-login ("Tu cuenta autenticada no
--      tiene un perfil operativo asignado") asegurando public.profiles vinculada
--      a auth.users(id) ON DELETE CASCADE con normalización LOWER(TRIM(email)).
--   2. Definir funciones seguras SECURITY DEFINER (SET search_path = public):
--      - public.is_super_admin()
--      - public.is_coordinadora_or_admin()
--      evitando recursión infinita en RLS e impidiendo auto-escalación de rol.
--   3. Configurar políticas RLS para que:
--      - Super administrador (super_admin) tenga control total (SELECT, INSERT,
--        UPDATE, DELETE) sobre todas las tablas del sistema.
--      - Coordinadora (coordinacion / coordinadora) tenga acceso operativo
--        completo en Degustaciones, Cronograma y Contraloría.
--      - El acceso de promotoras a /portal permanezca 100 % intacto.
--   4. Crear trigger on_auth_user_created + sincronización retroactiva automática
--      para las 3 cuentas corporativas:
--      - admin@codizulca.com    -> Super administrador ('super_admin')
--      - grecia01@codizulca.com -> Coordinadora ('coordinacion')
--      - maria01@codizulca.com  -> Coordinadora ('coordinacion')
--
-- SEGURIDAD: Archivo 100 % libre de contraseñas, hashes o llaves secretas.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. ESTRUCTURA IDEMPOTENTE Y NORMALIZACIÓN DE public.profiles
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

-- Normalizar correos y alias de rol existentes en public.profiles
UPDATE public.profiles
SET
  email = lower(btrim(COALESCE(email, ''))),
  role = CASE
    WHEN lower(btrim(COALESCE(role, ''))) IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin')
      THEN 'super_admin'
    WHEN lower(btrim(COALESCE(role, ''))) IN ('coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade', 'supervisor', 'analista_contraloria')
      THEN 'coordinacion'
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

-- Índice único funcional sobre LOWER(TRIM(email)) si no existen duplicados previos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT lower(btrim(email))
    FROM public.profiles
    WHERE btrim(email) <> ''
    GROUP BY lower(btrim(email))
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_email_lower_clean
      ON public.profiles (lower(btrim(email)))
      WHERE btrim(email) <> '';
  END IF;
END $$;

-- Trigger de normalización previa a escritura (acepta 'coordinadora' convirtiéndolo a 'coordinacion')
CREATE OR REPLACE FUNCTION public.fn_profiles_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_raw_role TEXT;
BEGIN
  NEW.email := lower(btrim(COALESCE(NEW.email, '')));
  NEW.full_name := btrim(COALESCE(NEW.full_name, ''));
  v_raw_role := lower(btrim(COALESCE(NEW.role, 'vendedor')));

  IF v_raw_role IN ('super_admin', 'superadmin') THEN
    NEW.role := 'super_admin';
  ELSIF v_raw_role IN ('coordinacion', 'coordinadora') THEN
    NEW.role := 'coordinacion';
  ELSIF v_raw_role IN ('vendedor', 'fdv') THEN
    NEW.role := 'vendedor';
  ELSE
    NEW.role := v_raw_role;
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

-- =============================================================================
-- 2. FUNCIONES RBAC SECURITY DEFINER (SIN RECURSIÓN RLS + ANTI ESCALACIÓN)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_super_admin()
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

COMMENT ON FUNCTION public.is_super_admin() IS
  'Retorna true si el usuario autenticado posee perfil activo con rol super_admin en public.profiles.';

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- Alias compatible con el módulo IAM de Gestión de Usuarios
CREATE OR REPLACE FUNCTION public.is_active_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin();
$$;

REVOKE ALL ON FUNCTION public.is_active_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_super_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_coordinadora_or_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_role TEXT;
  v_active BOOLEAN;
  v_jwt_role TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.role, p.is_active
  INTO v_role, v_active
  FROM public.profiles p
  WHERE p.id = v_uid
  LIMIT 1;

  IF FOUND THEN
    IF v_active IS DISTINCT FROM true THEN
      RETURN false;
    END IF;
    RETURN v_role IN ('super_admin', 'coordinacion');
  END IF;

  -- Fallback seguro únicamente sobre app_metadata firmado por el servidor si aún no tiene fila en profiles
  v_jwt_role := lower(btrim(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    ''
  )));

  RETURN v_jwt_role IN (
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
  );
END;
$$;

COMMENT ON FUNCTION public.is_coordinadora_or_admin() IS
  'Retorna true si el usuario autenticado es Super administrador o Coordinadora activa (sin recursión RLS).';

REVOKE ALL ON FUNCTION public.is_coordinadora_or_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_coordinadora_or_admin() TO authenticated;

-- Mantener alineados los helpers previos del repositorio con las nuevas funciones RBAC
CREATE OR REPLACE FUNCTION public.es_admin_trade()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT public.is_coordinadora_or_admin();
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
  SELECT public.is_super_admin();
$$;

CREATE OR REPLACE FUNCTION private.is_coordinator_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT public.is_coordinadora_or_admin();
$$;

-- Trigger anti auto-escalación y anti auto-bloqueo directo sobre public.profiles
CREATE OR REPLACE FUNCTION public.fn_guard_profiles_self_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Si la operación proviene directamente de una sesión cliente PostgREST (authenticated/anon),
  -- solo un super_admin activo puede insertar, editar roles/estados o eliminar perfiles.
  IF current_user IN ('authenticated', 'anon') THEN
    IF NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'Acceso denegado: solo el Super administrador puede modificar perfiles y roles.'
        USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.id = auth.uid() THEN
      IF NEW.is_active IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes suspender tu propia cuenta de Super administrador.'
          USING ERRCODE = 'P0001';
      END IF;
      IF NEW.role <> 'super_admin' THEN
        RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes cambiar tu propio rol fuera de super_admin.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF TG_OP = 'DELETE' AND OLD.id = auth.uid() THEN
      RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes eliminar tu propia cuenta activa.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_guard_profiles_self_escalation() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_guard_profiles_self_escalation ON public.profiles;
CREATE TRIGGER trg_guard_profiles_self_escalation
  BEFORE INSERT OR UPDATE OR DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_profiles_self_escalation();

-- =============================================================================
-- 3. POLÍTICAS RLS EN public.profiles Y TODAS LAS TABLAS DEL SISTEMA
--    (Preservando íntegramente las políticas operativas de /portal)
-- =============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profiles FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;

DROP POLICY IF EXISTS profiles_select_self_or_super_admin ON public.profiles;
CREATE POLICY profiles_select_self_or_super_admin
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (SELECT public.is_super_admin())
  );

DROP POLICY IF EXISTS profiles_super_admin_insert ON public.profiles;
CREATE POLICY profiles_super_admin_insert
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_super_admin()));

DROP POLICY IF EXISTS profiles_super_admin_update ON public.profiles;
CREATE POLICY profiles_super_admin_update
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_super_admin()))
  WITH CHECK ((SELECT public.is_super_admin()));

DROP POLICY IF EXISTS profiles_super_admin_delete ON public.profiles;
CREATE POLICY profiles_super_admin_delete
  ON public.profiles
  FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    AND id <> (SELECT auth.uid())
  );

-- Aplicación dinámica e idempotente de políticas RBAC sobre las tablas del ecosistema:
--   a) Super administrador: control total (SELECT, INSERT, UPDATE, DELETE) en todas las tablas.
--   b) Coordinadora: control operativo completo en Degustaciones, Cronograma, Contraloría y Personal,
--      más lectura/sincronización en catálogos maestros.
--   c) Las políticas existentes de promotoras (/portal) NO se eliminan ni alteran.
DO $$
DECLARE
  v_tbl TEXT;
  v_all_system_tables TEXT[] := ARRAY[
    'vendedores',
    'clientes',
    'lotes_sincronizacion',
    'surveys',
    'staff',
    'cargas_archivos',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'solicitudes_contraloria',
    'asistencias_jornada',
    'asistencia_evidencias',
    'historial_cortes_degustaciones',
    'cierres_semanales_log',
    'prices',
    'inventory',
    'checkins',
    'entregas_degustacion'
  ];
  v_coordinadora_full_ops_tables TEXT[] := ARRAY[
    'vendedores',
    'clientes',
    'lotes_sincronizacion',
    'surveys',
    'staff',
    'cargas_archivos',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'solicitudes_contraloria',
    'asistencias_jornada',
    'asistencia_evidencias',
    'prices',
    'inventory',
    'checkins'
  ];
  v_coordinadora_readonly_tables TEXT[] := ARRAY[
    'historial_cortes_degustaciones',
    'cierres_semanales_log',
    'entregas_degustacion'
  ];
BEGIN
  -- 3.A Control total para Super administrador en todas las tablas existentes
  FOREACH v_tbl IN ARRAY v_all_system_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tbl);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', v_tbl);

      EXECUTE format('DROP POLICY IF EXISTS rbac_super_admin_all_%I ON public.%I', v_tbl, v_tbl);
      EXECUTE format(
        'CREATE POLICY rbac_super_admin_all_%I ON public.%I FOR ALL TO authenticated '
        || 'USING ((SELECT public.is_super_admin())) '
        || 'WITH CHECK ((SELECT public.is_super_admin()))',
        v_tbl,
        v_tbl
      );
    END IF;
  END LOOP;

  -- 3.B Acceso operativo completo para Coordinadora en Degustaciones, Cronograma, Contraloría y Maestros
  FOREACH v_tbl IN ARRAY v_coordinadora_full_ops_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS rbac_coordinadora_ops_%I ON public.%I', v_tbl, v_tbl);
      EXECUTE format(
        'CREATE POLICY rbac_coordinadora_ops_%I ON public.%I FOR ALL TO authenticated '
        || 'USING ((SELECT public.is_coordinadora_or_admin())) '
        || 'WITH CHECK ((SELECT public.is_coordinadora_or_admin()))',
        v_tbl,
        v_tbl
      );
    END IF;
  END LOOP;

  -- 3.C Lectura operativa para Coordinadora en bitácoras de cierre/historial
  FOREACH v_tbl IN ARRAY v_coordinadora_readonly_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS rbac_coordinadora_select_%I ON public.%I', v_tbl, v_tbl);
      EXECUTE format(
        'CREATE POLICY rbac_coordinadora_select_%I ON public.%I FOR SELECT TO authenticated '
        || 'USING ((SELECT public.is_coordinadora_or_admin()))',
        v_tbl,
        v_tbl
      );
    END IF;
  END LOOP;
END $$;

-- =============================================================================
-- 4. TRIGGER on_auth_user_created + SINCRONIZACIÓN RETROACTIVA DE LAS 3 CUENTAS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_corporate_auth_user_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_assigned_role TEXT := NULL;
  v_default_name TEXT := NULL;
BEGIN
  v_email := lower(btrim(COALESCE(NEW.email, '')));
  IF v_email = '' THEN
    RETURN NEW;
  END IF;

  IF v_email = 'admin@codizulca.com' THEN
    v_assigned_role := 'super_admin';
    v_default_name := 'Administrador General Codizulca';
  ELSIF v_email = 'grecia01@codizulca.com' THEN
    v_assigned_role := 'coordinacion';
    v_default_name := 'Grecia · Coordinación Trade';
  ELSIF v_email = 'maria01@codizulca.com' THEN
    v_assigned_role := 'coordinacion';
    v_default_name := 'María · Coordinación Trade';
  END IF;

  IF v_assigned_role IS NOT NULL THEN
    INSERT INTO public.profiles (
      id,
      email,
      full_name,
      role,
      is_active,
      must_change_password
    )
    VALUES (
      NEW.id,
      v_email,
      COALESCE(
        NULLIF(btrim(NEW.raw_app_meta_data ->> 'display_name'), ''),
        NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
        v_default_name
      ),
      v_assigned_role,
      true,
      false
    )
    ON CONFLICT (id) DO UPDATE
    SET
      email = EXCLUDED.email,
      role = EXCLUDED.role,
      is_active = true,
      updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_corporate_auth_user_sync() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_corporate_auth_user_sync();

-- Sincronización retroactiva inmediata sobre usuarios ya existentes en auth.users
INSERT INTO public.profiles (
  id,
  email,
  full_name,
  role,
  is_active,
  must_change_password
)
SELECT
  u.id,
  lower(btrim(u.email)),
  COALESCE(
    NULLIF(btrim(u.raw_app_meta_data ->> 'display_name'), ''),
    NULLIF(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    CASE lower(btrim(u.email))
      WHEN 'admin@codizulca.com' THEN 'Administrador General Codizulca'
      WHEN 'grecia01@codizulca.com' THEN 'Grecia · Coordinación Trade'
      WHEN 'maria01@codizulca.com' THEN 'María · Coordinación Trade'
    END
  ),
  CASE lower(btrim(u.email))
    WHEN 'admin@codizulca.com' THEN 'super_admin'
    ELSE 'coordinacion'
  END,
  true,
  false
FROM auth.users u
WHERE u.email IS NOT NULL
  AND lower(btrim(u.email)) IN (
    'admin@codizulca.com',
    'grecia01@codizulca.com',
    'maria01@codizulca.com'
  )
ON CONFLICT (id) DO UPDATE
SET
  email = EXCLUDED.email,
  full_name = CASE
    WHEN btrim(public.profiles.full_name) = '' THEN EXCLUDED.full_name
    ELSE public.profiles.full_name
  END,
  role = EXCLUDED.role,
  is_active = true,
  updated_at = now();

UPDATE auth.users u
SET
  email_confirmed_at = COALESCE(u.email_confirmed_at, now()),
  banned_until = NULL,
  raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
    'role', CASE
      WHEN lower(btrim(u.email)) = 'admin@codizulca.com' THEN 'super_admin'
      ELSE 'coordinacion'
    END,
    'app_role', CASE
      WHEN lower(btrim(u.email)) = 'admin@codizulca.com' THEN 'super_admin'
      ELSE 'coordinacion'
    END,
    'display_name', COALESCE(
      NULLIF(btrim(u.raw_app_meta_data ->> 'display_name'), ''),
      CASE lower(btrim(u.email))
        WHEN 'admin@codizulca.com' THEN 'Administrador General Codizulca'
        WHEN 'grecia01@codizulca.com' THEN 'Grecia · Coordinación Trade'
        ELSE 'María · Coordinación Trade'
      END
    ),
    'is_active', true
  ),
  updated_at = now()
WHERE u.email IS NOT NULL
  AND lower(btrim(u.email)) IN (
    'admin@codizulca.com',
    'grecia01@codizulca.com',
    'maria01@codizulca.com'
  );

COMMIT;
