-- =============================================================================
-- CODIZULCA C.A. - MIGRACIÓN BASE REPRODUCIBLE (BASELINE CORE SCHEMA)
-- Archivo: supabase/migrations/20261001000000_baseline_core_tables.sql
--
-- Propósito (MVP-02):
--   Garantizar que un entorno limpio (Staging, CI o DRP) pueda ejecutar toda la
--   cadena de migraciones desde cero sin depender de tablas preexistentes ni
--   fallar por dependencias de funciones en el esquema `private`.
--
-- Garantías de Seguridad:
--   1. 100% idempotente (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).
--   2. Row Level Security habilitado desde el origen en todas las tablas base.
--   3. Cero privilegios otorgados a `PUBLIC` o `anon`.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. TABLAS OPERATIVAS BASE DEL ECOSISTEMA DE CAMPO Y LOGÍSTICA
-- =============================================================================

-- 1.1 Padrón de Personal Operativo (Promotoras Fijas, Eventuales y Merchandising)
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

CREATE INDEX IF NOT EXISTS idx_staff_auth_user_id
  ON public.staff (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_email_lower
  ON public.staff (lower(btrim(COALESCE(email, ''))));

-- 1.2 Bandeja de Solicitudes FDV, Encuestas y Auditorías de Campo
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

CREATE INDEX IF NOT EXISTS idx_surveys_type_created_at
  ON public.surveys (type, created_at DESC);

-- 1.3 Monitoreo de Precios Propios vs. Competencia en Anaquel
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

CREATE INDEX IF NOT EXISTS idx_prices_created_at
  ON public.prices (created_at DESC);

-- 1.4 Control de Inventario Inicial/Final y Muestras Degustadas en PDV
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

CREATE INDEX IF NOT EXISTS idx_inventory_created_at
  ON public.inventory (created_at DESC);

-- 1.5 Marcajes Históricos de Visita y Evidencias de Merchandising
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

CREATE INDEX IF NOT EXISTS idx_checkins_created_at
  ON public.checkins (created_at DESC);

-- 1.6 Logística de Entregas de Stands e Insumos (RutaDegustación Unificada)
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

CREATE INDEX IF NOT EXISTS idx_entregas_degustacion_fecha_turno
  ON public.entregas_degustacion (fecha, turno);

-- =============================================================================
-- 2. HABILITAR RLS Y REVOCAR ACCESO PÚBLICO / ANÓNIMO DESDE EL ORIGEN
-- =============================================================================
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entregas_degustacion ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.staff FROM PUBLIC, anon;
REVOKE ALL ON public.surveys FROM PUBLIC, anon;
REVOKE ALL ON public.prices FROM PUBLIC, anon;
REVOKE ALL ON public.inventory FROM PUBLIC, anon;
REVOKE ALL ON public.checkins FROM PUBLIC, anon;
REVOKE ALL ON public.entregas_degustacion FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surveys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.checkins TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entregas_degustacion TO authenticated;

-- =============================================================================
-- 3. ESQUEMA `private` Y HELPERS INICIALES PARA ORDENAMIENTO DE MIGRACIONES
--    (Refinados posteriormente por las migraciones IAM/RBAC con `public.profiles`)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.current_app_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT lower(
    pg_catalog.btrim(
      COALESCE(
        (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
        (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
        ''
      )
    )
  );
$$;

CREATE OR REPLACE FUNCTION private.is_strict_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND (SELECT private.current_app_role()) IN (
       'super_admin',
       'superadmin',
       'admin',
       'gerencia',
       'gerente_admin'
     );
$$;

CREATE OR REPLACE FUNCTION private.is_coordinator_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
     AND (SELECT private.current_app_role()) IN (
       'super_admin',
       'superadmin',
       'admin',
       'gerencia',
       'gerente_admin',
       'coordinacion',
       'coordinadora',
       'coordinadora_trade',
       'jefe_trade',
       'supervisor'
     );
$$;

CREATE OR REPLACE FUNCTION private.current_active_promotora_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_claim_staff_id UUID := NULL;
  v_staff RECORD;
  v_status_json JSONB := '{}'::jsonb;
  v_member_status TEXT := 'Activo';
  v_member_category TEXT := '';
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_claim_staff_id := NULLIF(
      pg_catalog.btrim(COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'staff_id', '')),
      ''
    )::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_claim_staff_id := NULL;
  END;

  SELECT s.id, s.role, s.status, s.auth_user_id
  INTO v_staff
  FROM public.staff s
  WHERE s.auth_user_id = v_uid
  LIMIT 1;

  IF NOT FOUND AND v_claim_staff_id IS NOT NULL THEN
    SELECT s.id, s.role, s.status, s.auth_user_id
    INTO v_staff
    FROM public.staff s
    WHERE s.id = v_claim_staff_id
      AND (s.auth_user_id IS NULL OR s.auth_user_id = v_uid)
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_staff.status IS NOT NULL AND pg_catalog.btrim(v_staff.status::text) LIKE '{%' THEN
    BEGIN
      v_status_json := (v_staff.status::text)::jsonb;
      v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
      v_member_category := lower(pg_catalog.btrim(COALESCE(v_status_json ->> 'category', '')));
    EXCEPTION WHEN OTHERS THEN
      v_member_status := 'Activo';
    END;
  ELSIF v_staff.status IS NOT NULL THEN
    v_member_status := v_staff.status::text;
  END IF;

  IF lower(pg_catalog.btrim(v_member_status)) = 'inactivo'
     OR v_member_category = 'merchandising'
     OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
    RETURN NULL;
  END IF;

  RETURN v_staff.id;
END;
$$;

REVOKE ALL ON FUNCTION private.current_active_promotora_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.current_active_promotora_id() TO authenticated, service_role;

COMMIT;
