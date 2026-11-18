-- =============================================================================
-- CODIZULCA C.A. - FASE 1 DE CIERRE A PRODUCCIÓN (SEGURIDAD P0, RBAC Y FIXES SQL)
-- Archivo: supabase/migrations/20261118000100_fase1_lockdown_rls_rbac_and_fixes.sql
--
-- Cobertura Técnica (MVP-01, MVP-02 y MVP-03):
--   1. Aseguramiento idempotente de tablas base (`staff`, `surveys`, `prices`,
--      `inventory`, `checkins`, `entregas_degustacion`) en entornos preexistentes.
--   2. Expansión del modelo RBAC corporativo en `public.profiles` a 5 roles:
--      `('super_admin', 'coordinacion', 'contraloria', 'supervisor', 'vendedor')`,
--      retirando identidades cableadas en triggers (`on_auth_user_created`).
--   3. Purga total de políticas RLS `PERMISSIVE` heredadas abiertas al rol `anon`
--      (`surveys`, `solicitudes_contraloria`, `entregas_degustacion`) y acotamiento
--      horizontal en `clientes`, `vendedores` y `staff` + Segregación de Funciones
--      estricta en `solicitudes_contraloria` (Trade solicita vs. Contraloría aprueba).
--   4. Corrección de índice de idempotencia `idx_cronograma_deg_idempotency_active`,
--      reprogramación de `pg_cron` hacia `ejecutar_cierre_dominical_degustaciones`,
--      y soporte de `CHECKOUT` post-medianoche Caracas desde `rutas_promotoras`.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. ASEGURAMIENTO IDEMPOTENTE DE TABLAS BASE Y COLUMNAS REQUERIDAS
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Promotora',
  email TEXT NOT NULL DEFAULT '',
  status TEXT DEFAULT 'Activo',
  "creatorId" TEXT,
  "uploaderEmail" TEXT,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL DEFAULT 'Degustacion',
  date TEXT,
  store TEXT,
  promoter TEXT,
  product TEXT,
  rating NUMERIC,
  intent TEXT,
  purchase TEXT,
  email TEXT,
  competitor TEXT,
  comments TEXT,
  "creatorId" TEXT,
  leido_trade BOOLEAN NOT NULL DEFAULT false,
  visto_en_trade_at TIMESTAMPTZ,
  en_historial BOOLEAN NOT NULL DEFAULT false,
  archivado_en TIMESTAMPTZ,
  motivo_archivo TEXT,
  fecha_evento DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS leido_trade BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS visto_en_trade_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS en_historial BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archivado_en TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS motivo_archivo TEXT,
  ADD COLUMN IF NOT EXISTS fecha_evento DATE;

CREATE TABLE IF NOT EXISTS public.prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date TEXT,
  store TEXT,
  "ourProduct" TEXT,
  "ourPrice" NUMERIC,
  "competitor1Brand" TEXT,
  "competitor1Price" NUMERIC,
  "competitor2Brand" TEXT,
  "competitor2Price" NUMERIC,
  "competitor3Brand" TEXT,
  "competitor3Price" NUMERIC,
  "competitorBrand" TEXT,
  "competitorPrice" NUMERIC,
  comments TEXT,
  "creatorId" TEXT,
  promoter TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date TEXT,
  store TEXT,
  product TEXT,
  "initialQuantity" NUMERIC,
  "finalQuantity" NUMERIC,
  degustations NUMERIC,
  comments TEXT,
  "creatorId" TEXT,
  promoter TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date TEXT,
  store TEXT,
  type TEXT,
  location JSONB,
  "creatorId" TEXT,
  promoter TEXT,
  "photoBase64" TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.entregas_degustacion (
  id TEXT PRIMARY KEY,
  fecha TEXT NOT NULL,
  turno TEXT NOT NULL,
  numero_grupo_turno TEXT NOT NULL,
  cliente TEXT NOT NULL,
  producto TEXT NOT NULL,
  vendedor TEXT NOT NULL DEFAULT '',
  promotora TEXT NOT NULL DEFAULT '',
  stand_entregado BOOLEAN NOT NULL DEFAULT false,
  producto_entregado BOOLEAN NOT NULL DEFAULT false,
  completado BOOLEAN NOT NULL DEFAULT false,
  hora_entrega TEXT,
  hora_entrega_real TIMESTAMPTZ,
  actualizado_chofer_at TIMESTAMPTZ,
  notas_chofer TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.entregas_degustacion
  ADD COLUMN IF NOT EXISTS hora_entrega_real TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actualizado_chofer_at TIMESTAMPTZ;

-- =============================================================================
-- 2. EXPANSIÓN RBAC CORPORATIVO A 5 ROLES Y RETIRO DE TRIGGERS CON EMAILS FIJOS
-- =============================================================================

-- Retirar trigger que auto-promovía roles por coincidencia de correos cableados (SEC-02)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_corporate_auth_user_sync();

-- Actualizar trigger de normalización en public.profiles preservando contraloria y supervisor
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

  IF v_raw_role IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin') THEN
    NEW.role := 'super_admin';
  ELSIF v_raw_role IN ('contraloria', 'analista_contraloria', 'contralor') THEN
    NEW.role := 'contraloria';
  ELSIF v_raw_role IN ('coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade') THEN
    NEW.role := 'coordinacion';
  ELSIF v_raw_role IN ('supervisor', 'supervisora', 'supervisor_trade') THEN
    NEW.role := 'supervisor';
  ELSIF v_raw_role IN ('vendedor', 'fdv', 'fuerza_ventas') THEN
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

-- Reemplazar constraint minimalista de 3 roles por dominio corporativo de 5 roles
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS chk_profiles_role_minimalist,
  DROP CONSTRAINT IF EXISTS chk_profiles_corporate_roles;

UPDATE public.profiles
SET role = CASE
  WHEN lower(btrim(COALESCE(role, ''))) IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin')
    THEN 'super_admin'
  WHEN lower(btrim(COALESCE(role, ''))) IN ('contraloria', 'analista_contraloria', 'contralor')
    THEN 'contraloria'
  WHEN lower(btrim(COALESCE(role, ''))) IN ('coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade')
    THEN 'coordinacion'
  WHEN lower(btrim(COALESCE(role, ''))) IN ('supervisor', 'supervisora', 'supervisor_trade')
    THEN 'supervisor'
  ELSE 'vendedor'
END;

ALTER TABLE public.profiles
  ADD CONSTRAINT chk_profiles_corporate_roles
  CHECK (role IN ('super_admin', 'coordinacion', 'contraloria', 'supervisor', 'vendedor'));

-- =============================================================================
-- 3. FUNCIONES DE AUTORIZACIÓN RBAC (SECURITY DEFINER + search_path FIJO)
-- =============================================================================

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

  -- Respaldo estricto sobre app_metadata firmado por servidor (jamás user_metadata)
  v_jwt_role := lower(btrim(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    ''
  )));

  IF v_jwt_role IN ('super_admin', 'superadmin', 'admin', 'gerencia', 'gerente_admin') THEN
    RETURN 'super_admin';
  ELSIF v_jwt_role IN ('contraloria', 'analista_contraloria', 'contralor') THEN
    RETURN 'contraloria';
  ELSIF v_jwt_role IN ('coordinacion', 'coordinadora', 'coordinadora_trade', 'jefe_trade') THEN
    RETURN 'coordinacion';
  ELSIF v_jwt_role IN ('supervisor', 'supervisora', 'supervisor_trade') THEN
    RETURN 'supervisor';
  ELSIF v_jwt_role IN ('vendedor', 'fdv', 'fuerza_ventas') THEN
    RETURN 'vendedor';
  ELSIF v_jwt_role = 'chofer' THEN
    RETURN 'chofer';
  ELSIF v_jwt_role = 'promotora' THEN
    RETURN 'promotora';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.current_active_profile_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_active_profile_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role = 'super_admin'
      AND p.is_active = true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

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
GRANT EXECUTE ON FUNCTION public.is_active_super_admin() TO authenticated, service_role;

-- Segregación de Funciones: exclusivo para Contraloría Interna o Super Admin activo
CREATE OR REPLACE FUNCTION public.is_contraloria_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT public.current_active_profile_role()) IN ('super_admin', 'contraloria'), false);
$$;

REVOKE ALL ON FUNCTION public.is_contraloria_or_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_contraloria_or_admin() TO authenticated, service_role;

-- Operación Trade Marketing (Coordinación, Supervisión de Campo y Super Admin activo)
CREATE OR REPLACE FUNCTION public.is_coordinadora_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT public.current_active_profile_role()) IN ('super_admin', 'coordinacion', 'supervisor'),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_coordinadora_or_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_coordinadora_or_admin() TO authenticated, service_role;

-- Lectura transversal autorizada en Torre de Control (incluye Contraloría para auditoría)
CREATE OR REPLACE FUNCTION public.is_torre_control_viewer()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT public.current_active_profile_role()) IN (
      'super_admin',
      'coordinacion',
      'contraloria',
      'supervisor'
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_torre_control_viewer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_torre_control_viewer() TO authenticated, service_role;

-- Operación logística de entregas (Chofer autenticado o Coordinación/Supervisión/Admin)
CREATE OR REPLACE FUNCTION public.is_chofer_or_logistics_ops()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT public.current_active_profile_role()) IN (
      'super_admin',
      'coordinacion',
      'supervisor',
      'chofer'
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_chofer_or_logistics_ops() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_chofer_or_logistics_ops() TO authenticated, service_role;

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
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

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

-- Helper seguro para validar en RLS de `surveys` que un vendedor solo escriba solicitudes en estado SOLICITADA
CREATE OR REPLACE FUNCTION public.fn_is_survey_solicitada(p_comments TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_json JSONB;
  v_estado TEXT;
BEGIN
  IF p_comments IS NULL OR btrim(p_comments) = '' THEN
    RETURN true;
  END IF;

  IF btrim(p_comments) NOT LIKE '{%' THEN
    RETURN false;
  END IF;

  BEGIN
    v_json := p_comments::jsonb;
    v_estado := upper(btrim(COALESCE(v_json ->> 'estado', v_json ->> 'status', 'SOLICITADA')));
    RETURN v_estado IN ('SOLICITADA', 'PENDIENTE');
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_is_survey_solicitada(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_survey_solicitada(TEXT) TO authenticated, service_role;

-- =============================================================================
-- 4. ACTUALIZACIÓN DE RPCs IAM PARA LOS 5 ROLES CORPORATIVOS
-- =============================================================================

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
      WHEN 'supervisor' THEN 4
      WHEN 'vendedor' THEN 5
      ELSE 6
    END ASC,
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

  v_clean_role := lower(btrim(COALESCE(p_role, '')));
  IF v_clean_role NOT IN ('super_admin', 'coordinacion', 'contraloria', 'supervisor', 'vendedor') THEN
    RAISE EXCEPTION 'Rol inválido (%). Valores permitidos: super_admin, coordinacion, contraloria, supervisor, vendedor.', p_role
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

REVOKE ALL ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) TO authenticated;

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

  v_clean_role := lower(btrim(COALESCE(p_role, '')));
  IF v_clean_role NOT IN ('super_admin', 'coordinacion', 'contraloria', 'supervisor', 'vendedor') THEN
    RAISE EXCEPTION 'Rol inválido (%). Valores permitidos: super_admin, coordinacion, contraloria, supervisor, vendedor.', p_role
      USING ERRCODE = '22023';
  END IF;

  IF p_target_user_id = v_actor_id AND v_clean_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes cambiar tu propio rol fuera de super_admin.'
      USING ERRCODE = 'P0001';
  END IF;

  v_must_change := COALESCE(p_must_change_password, false);

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
      'provisioned_via', 'server_admin_api'
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

REVOKE ALL ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

-- =============================================================================
-- 5. BLINDAJE P0 DE ROW LEVEL SECURITY (CIERRE 100% DE ROL `anon` Y FUGAS)
-- =============================================================================

DO $$
DECLARE
  v_tbl TEXT;
  v_pol RECORD;
  v_managed_tables TEXT[] := ARRAY[
    'profiles',
    'user_management_audit',
    'vendedores',
    'clientes',
    'lotes_sincronizacion',
    'surveys',
    'staff',
    'prices',
    'inventory',
    'checkins',
    'cargas_archivos',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'solicitudes_contraloria',
    'asistencias_jornada',
    'asistencia_evidencias',
    'historial_cortes_degustaciones',
    'cierres_semanales_log',
    'entregas_degustacion'
  ];
BEGIN
  -- 5.1 Habilitar RLS y revocar TODO acceso al rol `anon` y `PUBLIC`
  FOREACH v_tbl IN ARRAY v_managed_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tbl);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', v_tbl);
    END IF;
  END LOOP;

  -- 5.2 Purgar dinámicamente CUALQUIER política que incluya a `anon` o `public` (SEC-01)
  FOR v_pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY(v_managed_tables)
      AND ('anon' = ANY(roles) OR roles = '{public}'::name[])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_pol.policyname, v_pol.tablename);
  END LOOP;
END $$;

-- Revocar ejecución anónima en helper de fechas si existía
DO $$
BEGIN
  IF to_regprocedure('public.fn_parse_degustacion_fecha(text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.fn_parse_degustacion_fecha(TEXT, TEXT) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.fn_parse_degustacion_fecha(TEXT, TEXT) TO authenticated, service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5.3 `public.solicitudes_contraloria`: Segregación de Funciones Estricta
--     - Lectura: Torre de Control (`super_admin`, `coordinacion`, `contraloria`, `supervisor`)
--     - Creación: Coordinación / Supervisión / Super Admin (solo en PENDIENTE_APROBACION)
--     - Aprobación / Rechazo (UPDATE): EXCLUSIVO Contraloría Interna o Super Admin
--     - Eliminación: EXCLUSIVO Super Admin
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.solicitudes_contraloria') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.solicitudes_contraloria TO authenticated;

    DROP POLICY IF EXISTS solicitudes_contraloria_select_policy ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS solicitudes_contraloria_insert_policy ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS solicitudes_contraloria_update_policy ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS rbac_coordinadora_ops_solicitudes_contraloria ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS rbac_super_admin_all_solicitudes_contraloria ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS solicitudes_contraloria_select_torre ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS solicitudes_contraloria_insert_trade ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS solicitudes_contraloria_update_contraloria ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS solicitudes_contraloria_delete_super_admin ON public.solicitudes_contraloria;

    CREATE POLICY solicitudes_contraloria_select_torre
      ON public.solicitudes_contraloria
      FOR SELECT
      TO authenticated
      USING ((SELECT public.is_torre_control_viewer()));

    CREATE POLICY solicitudes_contraloria_insert_trade
      ON public.solicitudes_contraloria
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        AND estado = 'PENDIENTE_APROBACION'
      );

    CREATE POLICY solicitudes_contraloria_update_contraloria
      ON public.solicitudes_contraloria
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.is_contraloria_or_admin()))
      WITH CHECK ((SELECT public.is_contraloria_or_admin()));

    CREATE POLICY solicitudes_contraloria_delete_super_admin
      ON public.solicitudes_contraloria
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5.4 `public.surveys`: Cierre 100% de `anon` + Protección Anti Auto-Aprobación FDV
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.surveys') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.surveys TO authenticated;

    DROP POLICY IF EXISTS surveys_trade_select_policy ON public.surveys;
    DROP POLICY IF EXISTS surveys_fdv_insert_policy ON public.surveys;
    DROP POLICY IF EXISTS surveys_trade_update_leido_policy ON public.surveys;
    DROP POLICY IF EXISTS surveys_restrict_historical_degustacion_update ON public.surveys;
    DROP POLICY IF EXISTS surveys_restrict_historical_degustacion_delete ON public.surveys;
    DROP POLICY IF EXISTS surveys_select_authenticated_roles ON public.surveys;
    DROP POLICY IF EXISTS surveys_insert_authenticated_fdv_or_trade ON public.surveys;
    DROP POLICY IF EXISTS surveys_update_authenticated_trade_or_fdv ON public.surveys;
    DROP POLICY IF EXISTS surveys_delete_super_admin ON public.surveys;

    CREATE POLICY surveys_select_authenticated_roles
      ON public.surveys
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_torre_control_viewer())
        OR (
          type = 'Degustacion'
          AND (SELECT public.current_active_profile_role()) = 'vendedor'
        )
      );

    CREATE POLICY surveys_insert_authenticated_fdv_or_trade
      ON public.surveys
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        OR (
          type = 'Degustacion'
          AND (SELECT public.current_active_profile_role()) = 'vendedor'
          AND public.fn_is_survey_solicitada(comments)
        )
      );

    CREATE POLICY surveys_update_authenticated_trade_or_fdv
      ON public.surveys
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT public.is_coordinadora_or_admin())
        OR (
          type = 'Degustacion'
          AND COALESCE(en_historial, false) = false
          AND (SELECT public.current_active_profile_role()) = 'vendedor'
          AND public.fn_is_survey_solicitada(comments)
        )
      )
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        OR (
          type = 'Degustacion'
          AND COALESCE(en_historial, false) = false
          AND (SELECT public.current_active_profile_role()) = 'vendedor'
          AND public.fn_is_survey_solicitada(comments)
        )
      );

    CREATE POLICY surveys_delete_super_admin
      ON public.surveys
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));

    -- Políticas RESTRICTIVE de inmutabilidad histórica exclusivamente para `authenticated`
    IF to_regprocedure('public.fn_hoy_caracas()') IS NOT NULL
       AND to_regprocedure('public.fn_parse_degustacion_fecha(text,text)') IS NOT NULL THEN
      CREATE POLICY surveys_restrict_historical_degustacion_update
        ON public.surveys
        AS RESTRICTIVE
        FOR UPDATE
        TO authenticated
        USING (
          type IS DISTINCT FROM 'Degustacion'
          OR COALESCE(fecha_evento, public.fn_parse_degustacion_fecha(date, comments)) >= public.fn_hoy_caracas()
          OR (SELECT private.is_coordinator_or_admin())
        )
        WITH CHECK (
          type IS DISTINCT FROM 'Degustacion'
          OR COALESCE(fecha_evento, public.fn_parse_degustacion_fecha(date, comments)) >= public.fn_hoy_caracas()
          OR (SELECT private.is_coordinator_or_admin())
        );

      CREATE POLICY surveys_restrict_historical_degustacion_delete
        ON public.surveys
        AS RESTRICTIVE
        FOR DELETE
        TO authenticated
        USING (
          type IS DISTINCT FROM 'Degustacion'
          OR COALESCE(fecha_evento, public.fn_parse_degustacion_fecha(date, comments)) >= public.fn_hoy_caracas()
          OR (SELECT private.is_strict_admin())
        );
    END IF;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5.5 `public.entregas_degustacion`: Cierre 100% de `anon` y Acceso Chofer/Trade
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.entregas_degustacion TO authenticated;

    DROP POLICY IF EXISTS entregas_degustacion_select ON public.entregas_degustacion;
    DROP POLICY IF EXISTS entregas_degustacion_insert ON public.entregas_degustacion;
    DROP POLICY IF EXISTS entregas_degustacion_update ON public.entregas_degustacion;
    DROP POLICY IF EXISTS entregas_degustacion_delete ON public.entregas_degustacion;
    DROP POLICY IF EXISTS entregas_degustacion_select_authenticated ON public.entregas_degustacion;
    DROP POLICY IF EXISTS entregas_degustacion_insert_coord ON public.entregas_degustacion;
    DROP POLICY IF EXISTS entregas_degustacion_update_logistics ON public.entregas_degustacion;
    DROP POLICY IF EXISTS entregas_degustacion_delete_coord ON public.entregas_degustacion;

    CREATE POLICY entregas_degustacion_select_authenticated
      ON public.entregas_degustacion
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_torre_control_viewer())
        OR (SELECT public.is_chofer_or_logistics_ops())
      );

    CREATE POLICY entregas_degustacion_insert_coord
      ON public.entregas_degustacion
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.is_coordinadora_or_admin()));

    CREATE POLICY entregas_degustacion_update_logistics
      ON public.entregas_degustacion
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.is_chofer_or_logistics_ops()))
      WITH CHECK ((SELECT public.is_chofer_or_logistics_ops()));

    CREATE POLICY entregas_degustacion_delete_coord
      ON public.entregas_degustacion
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_coordinadora_or_admin()));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5.6 `public.vendedores` y `public.clientes`: Acotamiento Horizontal por Rol
--     (Elimina lectura abierta `USING (true)` que exponía todo el padrón maestro)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.vendedores') IS NOT NULL THEN
    DROP POLICY IF EXISTS vendedores_select_authenticated ON public.vendedores;
    DROP POLICY IF EXISTS vendedores_select_scoped ON public.vendedores;

    CREATE POLICY vendedores_select_scoped
      ON public.vendedores
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_torre_control_viewer())
        OR (
          (SELECT public.current_active_profile_role()) = 'vendedor'
          AND lower(btrim(COALESCE(email, ''))) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '__none__')))
        )
      );
  END IF;

  IF to_regclass('public.clientes') IS NOT NULL THEN
    DROP POLICY IF EXISTS clientes_select_authenticated ON public.clientes;
    DROP POLICY IF EXISTS clientes_select_scoped ON public.clientes;

    IF to_regclass('public.perfiles_acceso') IS NOT NULL
       AND to_regprocedure('public.obtener_mi_sucursal()') IS NOT NULL
       AND to_regprocedure('public.obtener_mi_rol()') IS NOT NULL THEN
      -- Preservar aislamiento multi-sucursal estricto (Zulia / Valencia / admin_general)
      -- establecido por `001_blindaje_trade_sucursales.sql`, eliminando políticas permisivas sin filtro de sede.
      DROP POLICY IF EXISTS rbac_coordinadora_ops_clientes ON public.clientes;
      DROP POLICY IF EXISTS rbac_super_admin_all_clientes ON public.clientes;
      DROP POLICY IF EXISTS clientes_insert_admin_trade ON public.clientes;
      DROP POLICY IF EXISTS clientes_update_admin_trade ON public.clientes;
      DROP POLICY IF EXISTS clientes_delete_admin_trade ON public.clientes;
      DROP POLICY IF EXISTS clientes_select_aislado ON public.clientes;

      ALTER TABLE public.clientes FORCE ROW LEVEL SECURITY;

      CREATE POLICY clientes_select_aislado
        ON public.clientes
        FOR SELECT
        TO authenticated
        USING (
          activo = true
          AND (
            sucursal = (SELECT public.obtener_mi_sucursal())
            OR (SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade
          )
        );
    ELSE
      CREATE POLICY clientes_select_scoped
        ON public.clientes
        FOR SELECT
        TO authenticated
        USING (
          (SELECT public.is_torre_control_viewer())
          OR (
            (SELECT public.current_active_profile_role()) = 'vendedor'
            AND EXISTS (
              SELECT 1
              FROM public.vendedores v
              WHERE (v.id = clientes.vendedor_id OR v.codigo_vendedor = clientes.codigo_vendedor)
                AND lower(btrim(COALESCE(v.email, ''))) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '__none__')))
            )
          )
        );
    END IF;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5.7 `public.staff`, `prices`, `inventory`, `checkins` y lectura Contraloría
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.staff') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff TO authenticated;
    DROP POLICY IF EXISTS staff_select_torre_or_self ON public.staff;
    DROP POLICY IF EXISTS staff_write_trade_ops ON public.staff;

    CREATE POLICY staff_select_torre_or_self
      ON public.staff
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_torre_control_viewer())
        OR auth_user_id = (SELECT auth.uid())
        OR lower(btrim(COALESCE(email, ''))) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '__none__')))
      );

    CREATE POLICY staff_write_trade_ops
      ON public.staff
      FOR ALL
      TO authenticated
      USING ((SELECT public.is_coordinadora_or_admin()))
      WITH CHECK ((SELECT public.is_coordinadora_or_admin()));
  END IF;

  IF to_regclass('public.prices') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.prices TO authenticated;
    DROP POLICY IF EXISTS prices_select_torre_or_author ON public.prices;
    DROP POLICY IF EXISTS prices_insert_field_or_trade ON public.prices;

    CREATE POLICY prices_select_torre_or_author
      ON public.prices
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_torre_control_viewer())
        OR lower(btrim(COALESCE("creatorId", ''))) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '__none__')))
      );

    CREATE POLICY prices_insert_field_or_trade
      ON public.prices
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        OR (SELECT private.current_active_promotora_id()) IS NOT NULL
      );
  END IF;

  IF to_regclass('public.inventory') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory TO authenticated;
    DROP POLICY IF EXISTS inventory_select_torre_or_author ON public.inventory;
    DROP POLICY IF EXISTS inventory_insert_field_or_trade ON public.inventory;

    CREATE POLICY inventory_select_torre_or_author
      ON public.inventory
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_torre_control_viewer())
        OR lower(btrim(COALESCE("creatorId", ''))) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '__none__')))
      );

    CREATE POLICY inventory_insert_field_or_trade
      ON public.inventory
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        OR (SELECT private.current_active_promotora_id()) IS NOT NULL
      );
  END IF;

  IF to_regclass('public.checkins') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.checkins TO authenticated;
    DROP POLICY IF EXISTS checkins_select_torre_or_author ON public.checkins;
    DROP POLICY IF EXISTS checkins_insert_field_or_trade ON public.checkins;

    CREATE POLICY checkins_select_torre_or_author
      ON public.checkins
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_torre_control_viewer())
        OR lower(btrim(COALESCE("creatorId", ''))) = lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '__none__')))
      );

    CREATE POLICY checkins_insert_field_or_trade
      ON public.checkins
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        OR (SELECT private.current_active_promotora_id()) IS NOT NULL
      );
  END IF;

  -- Visibilidad de solo lectura para Contraloría en cronograma y bitácoras de corte
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    DROP POLICY IF EXISTS cronograma_select_torre_viewer ON public.cronograma_degustaciones;
    CREATE POLICY cronograma_select_torre_viewer
      ON public.cronograma_degustaciones
      FOR SELECT
      TO authenticated
      USING ((SELECT public.is_torre_control_viewer()));
  END IF;

  IF to_regclass('public.historial_cortes_degustaciones') IS NOT NULL THEN
    DROP POLICY IF EXISTS rbac_coordinadora_select_historial_cortes_degustaciones ON public.historial_cortes_degustaciones;
    DROP POLICY IF EXISTS historial_cortes_select_torre_viewer ON public.historial_cortes_degustaciones;
    CREATE POLICY historial_cortes_select_torre_viewer
      ON public.historial_cortes_degustaciones
      FOR SELECT
      TO authenticated
      USING ((SELECT public.is_torre_control_viewer()));
  END IF;

  IF to_regclass('public.cierres_semanales_log') IS NOT NULL THEN
    DROP POLICY IF EXISTS rbac_coordinadora_select_cierres_semanales_log ON public.cierres_semanales_log;
    DROP POLICY IF EXISTS cierres_semanales_select_torre_viewer ON public.cierres_semanales_log;
    CREATE POLICY cierres_semanales_select_torre_viewer
      ON public.cierres_semanales_log
      FOR SELECT
      TO authenticated
      USING ((SELECT public.is_torre_control_viewer()));
  END IF;
END $$;

-- =============================================================================
-- 6. CORRECCIONES OPERATIVAS SQL (MVP-02: ÍNDICE IDEMPOTENCIA, CHECKOUT 00:00 Y CRON)
-- =============================================================================

-- 6.1 Reemplazar índice parcial legado `idx_cronograma_deg_idempotency_active`
DO $$
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.idx_cronograma_deg_idempotency_active;
    DROP INDEX IF EXISTS public.uq_cronograma_idempotency_active;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_cronograma_idempotency_active
      ON public.cronograma_degustaciones (idempotency_hash)
      WHERE estado NOT IN ('RECHAZADA', 'CANCELADA', 'NO_AUTORIZADA');
  END IF;
END $$;

-- 6.2 Permitir propagación segura de CHECKIN / CHECKOUT desde `rutas_promotoras`
--     incluso cuando la promotora cierre jornada pasadas las 00:00 America/Caracas
DO $$
BEGIN
  IF to_regprocedure('public.fn_hoy_caracas()') IS NOT NULL
     AND to_regprocedure('public.fn_parse_degustacion_fecha(text,text)') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public.fn_guard_historical_degustacion_immutability()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = ''
    AS $guard$
    DECLARE
      v_hoy_caracas DATE := public.fn_hoy_caracas();
      v_old_fecha DATE := NULL;
      v_new_fecha DATE := NULL;
      v_new_estado TEXT := '';
      v_is_privileged_system BOOLEAN := (
        (SELECT auth.uid()) IS NULL
        AND current_user IN ('postgres', 'service_role', 'supabase_admin')
      );
    BEGIN
      IF v_is_privileged_system OR (SELECT private.is_strict_admin()) THEN
        IF TG_OP = 'UPDATE' THEN
          RETURN NEW;
        END IF;
        RETURN OLD;
      END IF;

      IF TG_TABLE_NAME = 'surveys' THEN
        IF COALESCE(OLD.type, '') <> 'Degustacion'
           AND (TG_OP <> 'UPDATE' OR COALESCE(NEW.type, '') <> 'Degustacion') THEN
          IF TG_OP = 'UPDATE' THEN
            RETURN NEW;
          END IF;
          RETURN OLD;
        END IF;

        v_old_fecha := COALESCE(
          OLD.fecha_evento,
          public.fn_parse_degustacion_fecha(OLD.date, OLD.comments),
          (pg_catalog.timezone('America/Caracas', COALESCE(OLD.created_at, NOW())))::date
        );

        IF TG_OP = 'UPDATE' THEN
          v_new_fecha := COALESCE(
            NEW.fecha_evento,
            public.fn_parse_degustacion_fecha(NEW.date, NEW.comments),
            v_old_fecha
          );
          BEGIN
            IF NEW.comments IS NOT NULL AND pg_catalog.btrim(NEW.comments::text) LIKE '{%' THEN
              v_new_estado := upper(pg_catalog.btrim(COALESCE((NEW.comments::text)::jsonb ->> 'estado', '')));
            END IF;
          EXCEPTION WHEN OTHERS THEN
            v_new_estado := '';
          END;
        END IF;
      ELSIF TG_TABLE_NAME = 'cronograma_degustaciones' THEN
        v_old_fecha := OLD.fecha;
        IF TG_OP = 'UPDATE' THEN
          v_new_fecha := NEW.fecha;
          v_new_estado := upper(pg_catalog.btrim(COALESCE(NEW.estado, '')));
        END IF;

        -- Excepción criptográfica in-falsificable para `trg_sync_ruta_progress_to_cronograma`:
        -- solo aplica cuando proviene en cascada desde un trigger SECURITY DEFINER de sistema
        -- (`pg_trigger_depth() > 1` y `current_user` privilegiado), sin alterar la fecha programada.
        IF TG_OP = 'UPDATE'
           AND pg_catalog.pg_trigger_depth() > 1
           AND current_user IN ('postgres', 'service_role', 'supabase_admin')
           AND NEW.fecha IS NOT DISTINCT FROM OLD.fecha
           AND v_new_estado IN ('EN_CURSO', 'COMPLETADA') THEN
          RETURN NEW;
        END IF;
      END IF;

      IF TG_OP = 'UPDATE'
         AND v_new_estado = 'NO_AUTORIZADA'
         AND (SELECT private.is_coordinator_or_admin()) THEN
        RETURN NEW;
      END IF;

      IF v_old_fecha IS NOT NULL AND v_old_fecha < v_hoy_caracas THEN
        RAISE EXCEPTION 'REGISTRO HISTÓRICO CERRADO: Solo un Administrador puede modificar o eliminar degustaciones de fechas pasadas (% < %).',
          v_old_fecha, v_hoy_caracas
          USING ERRCODE = '42501';
      END IF;

      IF TG_OP = 'UPDATE' AND v_new_fecha IS NOT NULL AND v_new_fecha < v_hoy_caracas THEN
        RAISE EXCEPTION 'REGISTRO HISTÓRICO CERRADO: No se permite asignar degustaciones hacia una fecha pasada (% < %).',
          v_new_fecha, v_hoy_caracas
          USING ERRCODE = '42501';
      END IF;

      IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
      END IF;
      RETURN OLD;
    END;
    $guard$;
  END IF;
END $$;

-- 6.3 Reparación de `pg_cron`: programar la firma real `ejecutar_cierre_dominical_degustaciones`
DO $$
DECLARE
  v_job RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN (
        'cierre-dominical-degustaciones-9pm-ve',
        'cierre-semanal-iso-degustaciones-caracas'
      )
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    IF to_regprocedure('public.ejecutar_cierre_dominical_degustaciones(timestamptz,text,boolean)') IS NOT NULL THEN
      PERFORM cron.schedule(
        'cierre-dominical-degustaciones-9pm-ve',
        '0 1 * * 1',
        $cron$SELECT public.ejecutar_cierre_dominical_degustaciones(NOW(), 'America/Caracas', FALSE);$cron$
      );
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no habilitado en este entorno; el respaldo HTTP /api/cron/degustaciones-cierre-semanal permanece operativo.';
END $$;

COMMIT;
