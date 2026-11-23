-- ==============================================================================
-- SCRIPT LISTO PARA SUPABASE SQL EDITOR (100% ADITIVO E IDEMPOTENTE)
-- Integración App Promotoras (`/portal/*`) <-> Módulo 1 -> Pestaña "Informe"
-- Proyecto: Trade Marketing CODIZULCA (`apaxdgxtaoeyswlfblgi.supabase.co`)
--
-- Instrucciones: Copiar y ejecutar completo en el SQL Editor del Supabase Principal.
-- Al final incluye consultas de verificación automática (`pg_policies`, columnas y bucket).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. FUNCIONES AUXILIARES ZERO-TRUST (`SECURITY INVOKER`, CERO `anon`)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trade_current_promotora_id()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_jwt_email text := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_promotora_id text := NULL;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$
        SELECT p.id::text
        FROM public.promotoras p
        WHERE COALESCE(p.activo, true) = true
          AND (
            p.auth_user_id = $1
            OR ($2 <> '' AND LOWER(BTRIM(COALESCE(p.correo, ''))) = $2)
          )
        ORDER BY CASE WHEN p.auth_user_id = $1 THEN 0 ELSE 1 END ASC
        LIMIT 1
      $q$
      INTO v_promotora_id
      USING v_uid, v_jwt_email;
    EXCEPTION WHEN undefined_column THEN
      EXECUTE $q$
        SELECT p.id::text
        FROM public.promotoras p
        WHERE COALESCE(p.activo, true) = true
          AND $1 <> ''
          AND LOWER(BTRIM(COALESCE(p.correo, ''))) = $1
        LIMIT 1
      $q$
      INTO v_promotora_id
      USING v_jwt_email;
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
  p_auth_uid uuid,
  p_promotora_id text,
  p_creator_or_email text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (SELECT auth.uid()) IS NOT NULL
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

REVOKE ALL ON FUNCTION public.fn_trade_is_promotora_owner(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_promotora_owner(uuid, text, text) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 2. CREACIÓN ADITIVA DE TABLAS FALTANTES (`CREATE TABLE IF NOT EXISTS`)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date TEXT NOT NULL,
  store TEXT NOT NULL,
  product TEXT NOT NULL,
  "initialQuantity" NUMERIC NOT NULL DEFAULT 0,
  "finalQuantity" NUMERIC NOT NULL DEFAULT 0,
  degustations NUMERIC NOT NULL DEFAULT 0,
  sales_generated NUMERIC NOT NULL DEFAULT 0,
  comments TEXT DEFAULT '',
  "creatorId" TEXT,
  promoter TEXT NOT NULL,
  promotora_id TEXT,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  region TEXT NOT NULL DEFAULT 'Occidente',
  zona TEXT DEFAULT '',
  cronograma_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.asistencias_jornada (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha_jornada DATE NOT NULL,
  promotora_id TEXT NOT NULL,
  promotora_ref_id INTEGER,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  promotora_nombre TEXT NOT NULL,
  perfil_aplicado TEXT NOT NULL CHECK (perfil_aplicado IN ('FIJA', 'EVENTUAL')),
  pdv_nombre TEXT NOT NULL DEFAULT '',
  zona TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT 'Occidente',
  sucursal TEXT NOT NULL DEFAULT 'ZULIA',
  opened_at_server TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at_server TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by_uid UUID,
  CONSTRAINT uq_asistencias_jornada_fecha_promotora UNIQUE (fecha_jornada, promotora_id)
);

CREATE TABLE IF NOT EXISTS public.asistencia_evidencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asistencia_id UUID NOT NULL REFERENCES public.asistencias_jornada(id) ON DELETE CASCADE,
  slot_foto TEXT NOT NULL CHECK (
    slot_foto IN (
      'JORNADA_INGRESO',
      'JORNADA_SALIDA',
      'MANANA_INGRESO',
      'MANANA_SALIDA',
      'TARDE_INGRESO',
      'TARDE_SALIDA'
    )
  ),
  storage_bucket TEXT NOT NULL DEFAULT 'asistencia-evidencias'
    CHECK (storage_bucket = 'asistencia-evidencias'),
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  tamano_bytes INTEGER NOT NULL CHECK (tamano_bytes > 0 AND tamano_bytes <= 5242880),
  sha256_hex TEXT NOT NULL DEFAULT '',
  ancho_px INTEGER,
  alto_px INTEGER,
  pdv_nombre TEXT NOT NULL DEFAULT '',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  gps_accuracy DOUBLE PRECISION,
  region TEXT NOT NULL DEFAULT 'Occidente',
  sucursal TEXT NOT NULL DEFAULT 'ZULIA',
  capturado_en_servidor TIMESTAMPTZ NOT NULL DEFAULT now(),
  cargado_por_uid UUID,
  cargado_por_rol TEXT NOT NULL DEFAULT 'promotora'
    CHECK (cargado_por_rol IN ('promotora', 'coordinadora', 'admin')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_asistencia_evidencias_jornada_slot UNIQUE (asistencia_id, slot_foto)
);

CREATE TABLE IF NOT EXISTS public.prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date TEXT NOT NULL,
  store TEXT NOT NULL,
  "ourProduct" TEXT NOT NULL,
  "ourPrice" NUMERIC NOT NULL DEFAULT 0,
  "competitor1Brand" TEXT,
  "competitor1Price" NUMERIC,
  "competitor2Brand" TEXT,
  "competitor2Price" NUMERIC,
  "competitor3Brand" TEXT,
  "competitor3Price" NUMERIC,
  "competitorBrand" TEXT,
  "competitorPrice" NUMERIC,
  bcv_rate NUMERIC,
  photo_storage_path TEXT,
  comments TEXT DEFAULT '',
  "creatorId" TEXT,
  promoter TEXT NOT NULL,
  promotora_id TEXT,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  region TEXT NOT NULL DEFAULT 'Occidente',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL DEFAULT 'Profunda',
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
  promotora_id TEXT,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  region TEXT NOT NULL DEFAULT 'Occidente',
  leido_trade BOOLEAN NOT NULL DEFAULT false,
  visto_en_trade_at TIMESTAMPTZ,
  en_historial BOOLEAN NOT NULL DEFAULT false,
  archivado_en TIMESTAMPTZ,
  motivo_archivo TEXT,
  fecha_evento DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 3. COLUMNAS ADITIVAS E ÍNDICES DE RENDIMIENTO
-- ------------------------------------------------------------------------------

ALTER TABLE public.promotoras
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS region TEXT;

CREATE INDEX IF NOT EXISTS idx_promotoras_auth_user_id
  ON public.promotoras (auth_user_id) WHERE auth_user_id IS NOT NULL;

ALTER TABLE public.rutas_promotoras
  ADD COLUMN IF NOT EXISTS muestras_entregadas INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS meta_muestras INTEGER NOT NULL DEFAULT 150,
  ADD COLUMN IF NOT EXISTS unidades_vendidas NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS region TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notas_campo TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_auth_user_id
  ON public.rutas_promotoras (auth_user_id) WHERE auth_user_id IS NOT NULL;

ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS sales_generated NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotora_id TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'Occidente',
  ADD COLUMN IF NOT EXISTS zona TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS cronograma_id UUID;

CREATE INDEX IF NOT EXISTS idx_inventory_region_created_at ON public.inventory (region, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_promotora_id ON public.inventory (promotora_id) WHERE promotora_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_auth_user_id ON public.inventory (auth_user_id) WHERE auth_user_id IS NOT NULL;

ALTER TABLE public.asistencias_jornada
  ADD COLUMN IF NOT EXISTS promotora_ref_id INTEGER,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'Occidente',
  ADD COLUMN IF NOT EXISTS sucursal TEXT NOT NULL DEFAULT 'ZULIA';

CREATE INDEX IF NOT EXISTS idx_asistencias_jornada_region_fecha ON public.asistencias_jornada (region, fecha_jornada DESC);
CREATE INDEX IF NOT EXISTS idx_asistencias_jornada_auth_user_id ON public.asistencias_jornada (auth_user_id) WHERE auth_user_id IS NOT NULL;

ALTER TABLE public.asistencia_evidencias
  ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'Occidente',
  ADD COLUMN IF NOT EXISTS sucursal TEXT NOT NULL DEFAULT 'ZULIA',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_asistencia_evidencias_jornada_slot ON public.asistencia_evidencias (asistencia_id, slot_foto);

ALTER TABLE public.prices
  ADD COLUMN IF NOT EXISTS bcv_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS photo_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS promotora_id TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'Occidente';

CREATE INDEX IF NOT EXISTS idx_prices_region_created_at ON public.prices (region, created_at DESC);

ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS promotora_id TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'Occidente';

CREATE INDEX IF NOT EXISTS idx_surveys_region_type_created_at ON public.surveys (region, type, created_at DESC);

-- ------------------------------------------------------------------------------
-- 4. RLS ESTRICTO Y PERMISOS (`TO authenticated`, CERO `anon`)
-- ------------------------------------------------------------------------------

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory TO authenticated, service_role;

DROP POLICY IF EXISTS inventory_portal_select_auth ON public.inventory;
DROP POLICY IF EXISTS inventory_portal_insert_auth ON public.inventory;
DROP POLICY IF EXISTS inventory_portal_update_auth ON public.inventory;
DROP POLICY IF EXISTS inventory_portal_delete_auth ON public.inventory;

CREATE POLICY inventory_portal_select_auth ON public.inventory FOR SELECT TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId"));

CREATE POLICY inventory_portal_insert_auth ON public.inventory FOR INSERT TO authenticated
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (auth_user_id = (SELECT auth.uid()) AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")));

CREATE POLICY inventory_portal_update_auth ON public.inventory FOR UPDATE TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId"))
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (auth_user_id = (SELECT auth.uid()) AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")));

CREATE POLICY inventory_portal_delete_auth ON public.inventory FOR DELETE TO authenticated
  USING (public.fn_trade_is_manager_or_admin());

ALTER TABLE public.asistencias_jornada ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.asistencias_jornada FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asistencias_jornada TO authenticated, service_role;

DROP POLICY IF EXISTS asistencias_jornada_portal_select_auth ON public.asistencias_jornada;
DROP POLICY IF EXISTS asistencias_jornada_portal_insert_auth ON public.asistencias_jornada;
DROP POLICY IF EXISTS asistencias_jornada_portal_update_auth ON public.asistencias_jornada;
DROP POLICY IF EXISTS asistencias_jornada_portal_delete_auth ON public.asistencias_jornada;

CREATE POLICY asistencias_jornada_portal_select_auth ON public.asistencias_jornada FOR SELECT TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, NULL));

CREATE POLICY asistencias_jornada_portal_insert_auth ON public.asistencias_jornada FOR INSERT TO authenticated
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (auth_user_id = (SELECT auth.uid()) AND COALESCE(opened_by_uid, (SELECT auth.uid())) = (SELECT auth.uid()) AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, NULL)));

CREATE POLICY asistencias_jornada_portal_update_auth ON public.asistencias_jornada FOR UPDATE TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, NULL))
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (auth_user_id = (SELECT auth.uid()) AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, NULL)));

CREATE POLICY asistencias_jornada_portal_delete_auth ON public.asistencias_jornada FOR DELETE TO authenticated
  USING (public.fn_trade_is_manager_or_admin());

ALTER TABLE public.asistencia_evidencias ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.asistencia_evidencias FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asistencia_evidencias TO authenticated, service_role;

DROP POLICY IF EXISTS asistencia_evidencias_portal_select_auth ON public.asistencia_evidencias;
DROP POLICY IF EXISTS asistencia_evidencias_portal_insert_auth ON public.asistencia_evidencias;
DROP POLICY IF EXISTS asistencia_evidencias_portal_update_auth ON public.asistencia_evidencias;
DROP POLICY IF EXISTS asistencia_evidencias_portal_delete_auth ON public.asistencia_evidencias;

CREATE POLICY asistencia_evidencias_portal_select_auth ON public.asistencia_evidencias FOR SELECT TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR EXISTS (SELECT 1 FROM public.asistencias_jornada j WHERE j.id = asistencia_id AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::text, NULL)));

CREATE POLICY asistencia_evidencias_portal_insert_auth ON public.asistencia_evidencias FOR INSERT TO authenticated
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (cargado_por_uid = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.asistencias_jornada j WHERE j.id = asistencia_id AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::text, NULL))));

CREATE POLICY asistencia_evidencias_portal_update_auth ON public.asistencia_evidencias FOR UPDATE TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR EXISTS (SELECT 1 FROM public.asistencias_jornada j WHERE j.id = asistencia_id AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::text, NULL)))
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (cargado_por_uid = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.asistencias_jornada j WHERE j.id = asistencia_id AND public.fn_trade_is_promotora_owner(j.auth_user_id, j.promotora_id::text, NULL))));

CREATE POLICY asistencia_evidencias_portal_delete_auth ON public.asistencia_evidencias FOR DELETE TO authenticated
  USING (public.fn_trade_is_manager_or_admin());

ALTER TABLE public.prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.prices FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prices TO authenticated, service_role;

DROP POLICY IF EXISTS prices_portal_select_auth ON public.prices;
DROP POLICY IF EXISTS prices_portal_insert_auth ON public.prices;
DROP POLICY IF EXISTS prices_portal_update_auth ON public.prices;
DROP POLICY IF EXISTS prices_portal_delete_auth ON public.prices;

CREATE POLICY prices_portal_select_auth ON public.prices FOR SELECT TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId"));

CREATE POLICY prices_portal_insert_auth ON public.prices FOR INSERT TO authenticated
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (auth_user_id = (SELECT auth.uid()) AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")));

CREATE POLICY prices_portal_update_auth ON public.prices FOR UPDATE TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId"))
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (auth_user_id = (SELECT auth.uid()) AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")));

CREATE POLICY prices_portal_delete_auth ON public.prices FOR DELETE TO authenticated
  USING (public.fn_trade_is_manager_or_admin());

ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.surveys FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.surveys TO authenticated, service_role;

DROP POLICY IF EXISTS surveys_portal_select_auth ON public.surveys;
DROP POLICY IF EXISTS surveys_portal_insert_auth ON public.surveys;
DROP POLICY IF EXISTS surveys_portal_update_auth ON public.surveys;
DROP POLICY IF EXISTS surveys_portal_delete_auth ON public.surveys;

CREATE POLICY surveys_portal_select_auth ON public.surveys FOR SELECT TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId"));

CREATE POLICY surveys_portal_insert_auth ON public.surveys FOR INSERT TO authenticated
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (auth_user_id = (SELECT auth.uid()) AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")));

CREATE POLICY surveys_portal_update_auth ON public.surveys FOR UPDATE TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId"))
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR (auth_user_id = (SELECT auth.uid()) AND public.fn_trade_is_promotora_owner(auth_user_id, promotora_id, "creatorId")));

CREATE POLICY surveys_portal_delete_auth ON public.surveys FOR DELETE TO authenticated
  USING (public.fn_trade_is_manager_or_admin());

DROP POLICY IF EXISTS rutas_promotoras_portal_self_select_auth ON public.rutas_promotoras;
DROP POLICY IF EXISTS rutas_promotoras_portal_self_update_auth ON public.rutas_promotoras;

CREATE POLICY rutas_promotoras_portal_self_select_auth ON public.rutas_promotoras FOR SELECT TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, promotora_email));

CREATE POLICY rutas_promotoras_portal_self_update_auth ON public.rutas_promotoras FOR UPDATE TO authenticated
  USING (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, promotora_email))
  WITH CHECK (public.fn_trade_is_manager_or_admin() OR public.fn_trade_is_promotora_owner(auth_user_id, promotora_id::text, promotora_email));

-- ------------------------------------------------------------------------------
-- 5. BUCKET PRIVADO `asistencia-evidencias` + POLÍTICAS EN `storage.objects`
-- ------------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('asistencia-evidencias', 'asistencia-evidencias', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS asistencia_evidencias_storage_select_auth ON storage.objects;
DROP POLICY IF EXISTS asistencia_evidencias_storage_insert_auth ON storage.objects;
DROP POLICY IF EXISTS asistencia_evidencias_storage_update_auth ON storage.objects;
DROP POLICY IF EXISTS asistencia_evidencias_storage_delete_auth ON storage.objects;

CREATE POLICY asistencia_evidencias_storage_select_auth ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'asistencia-evidencias'
    AND (
      public.fn_trade_is_manager_or_admin()
      OR (storage.foldername(name))[1] IN (COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'), (SELECT auth.uid())::text)
    )
  );

CREATE POLICY asistencia_evidencias_storage_insert_auth ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'asistencia-evidencias'
    AND name NOT LIKE '%..%'
    AND name NOT LIKE '/%'
    AND (
      name ~ '^[A-Za-z0-9_-]{1,64}/(asistencia|inventario|degustacion|precios|merchandising)/[A-Za-z0-9_.-]{8,96}\.(jpg|jpeg|png|webp)$'
      OR name ~ '^asistencia/[0-9]{4}-[0-9]{2}-[0-9]{2}/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_.-]{8,96}\.(jpg|png|webp)$'
    )
    AND (
      public.fn_trade_is_manager_or_admin()
      OR (storage.foldername(name))[1] IN (COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'), (SELECT auth.uid())::text)
    )
  );

CREATE POLICY asistencia_evidencias_storage_update_auth ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'asistencia-evidencias'
    AND (
      public.fn_trade_is_manager_or_admin()
      OR (storage.foldername(name))[1] IN (COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'), (SELECT auth.uid())::text)
    )
  )
  WITH CHECK (
    bucket_id = 'asistencia-evidencias'
    AND name NOT LIKE '%..%'
    AND name NOT LIKE '/%'
    AND (
      public.fn_trade_is_manager_or_admin()
      OR (storage.foldername(name))[1] IN (COALESCE(public.fn_trade_current_promotora_id(), '__NONE__'), (SELECT auth.uid())::text)
    )
  );

CREATE POLICY asistencia_evidencias_storage_delete_auth ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'asistencia-evidencias' AND public.fn_trade_is_manager_or_admin());

NOTIFY pgrst, 'reload schema';

-- ------------------------------------------------------------------------------
-- 6. BLOQUE FINAL DE VERIFICACIÓN EN 1 CLIC (TABLAS, COLUMNAS, RLS Y BUCKET)
-- ------------------------------------------------------------------------------

SELECT table_name, COUNT(*) AS columnas_totales
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('inventory', 'asistencias_jornada', 'asistencia_evidencias', 'prices', 'surveys', 'rutas_promotoras', 'promotoras')
GROUP BY table_name
ORDER BY table_name;

SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE (schemaname = 'public' AND tablename IN ('inventory', 'asistencias_jornada', 'asistencia_evidencias', 'prices', 'surveys', 'rutas_promotoras'))
   OR (schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'asistencia_evidencias_storage_%')
ORDER BY schemaname, tablename, policyname;

SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id = 'asistencia-evidencias';
