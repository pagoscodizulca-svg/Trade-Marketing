-- ==============================================================================
-- SCRIPT IDEMPOTENTE PARA SUPABASE SQL EDITOR (1 CLIC)
-- Archivo: sql/fix_rls_perfiles_degustaciones_chofer_storage.sql
-- Proyecto: Trade Marketing CODIZULCA (`apaxdgxtaoeyswlfblgi.supabase.co`)
--
-- Incluye:
--   1. Funciones seguras `SECURITY INVOKER` (cero `anon`, mínimo privilegio `TO authenticated`).
--   2. Creación segura e idempotente (sin sobrescribir ni destruir datos) de:
--        - `public.profiles`
--        - `public.cronograma_degustaciones`
--        - `public.rutas_promotoras`
--        - `public.entregas_degustacion` (+ columnas Salida/Llegada/Evidencia)
--   3. `GRANT` y políticas RLS granulares para `public.promotoras`, `public.profiles`,
--      `public.cronograma_degustaciones`, `public.rutas_promotoras` y `public.entregas_degustacion`.
--   4. Bucket privado `entregas-evidencias` (<= 5 MB, JPG/PNG/WebP) + RLS en `storage.objects`.
--   5. Bloque final de verificación automática (`pg_policies`, `storage.buckets`, columnas clave).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. FUNCIONES AUXILIARES DE AUTORIZACIÓN (`SECURITY INVOKER`, CERO `anon`)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trade_current_actor_role()
RETURNS text
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
  v_has_profile boolean := false;
  v_profile_active boolean;
  v_profile_role text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN '';
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE $q$
      SELECT
        true,
        p.is_active,
        LOWER(BTRIM(COALESCE(p.role::text, '')))
      FROM public.profiles p
      WHERE p.id = $1
         OR ($2 <> '' AND LOWER(BTRIM(COALESCE(p.email, ''))) = $2)
      ORDER BY CASE WHEN p.id = $1 THEN 0 ELSE 1 END ASC
      LIMIT 1
    $q$
    INTO v_has_profile, v_profile_active, v_profile_role
    USING v_uid, v_jwt_email;

    IF v_has_profile AND v_profile_active IS DISTINCT FROM true THEN
      RETURN '__INACTIVE__';
    END IF;
  END IF;

  RETURN COALESCE(NULLIF(v_profile_role, ''), v_jwt_role);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_current_actor_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_current_actor_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_is_manager_or_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (SELECT auth.uid()) IS NOT NULL
    AND public.fn_trade_current_actor_role() IN (
      'super_admin',
      'superadmin',
      'admin',
      'coordinacion',
      'coordinador',
      'jefe_trade',
      'supervisor',
      'gerencia',
      'gerente_admin'
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_manager_or_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_manager_or_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_is_chofer_or_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    public.fn_trade_is_manager_or_admin()
    OR (
      (SELECT auth.uid()) IS NOT NULL
      AND public.fn_trade_current_actor_role() IN ('chofer', 'logistica', 'despacho')
    );
$$;

REVOKE ALL ON FUNCTION public.fn_trade_is_chofer_or_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_chofer_or_manager() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_is_promotora_owner(
  p_promotora_email text,
  p_promotora_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    public.fn_trade_is_manager_or_admin()
    OR (
      (SELECT auth.uid()) IS NOT NULL
      AND public.fn_trade_current_actor_role() <> '__INACTIVE__'
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

REVOKE ALL ON FUNCTION public.fn_trade_is_promotora_owner(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_is_promotora_owner(text, uuid) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 2. CREACIÓN SEGURA E IDEMPOTENTE DE TABLAS OPERATIVAS FALTANTES
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.profiles (
        id uuid PRIMARY KEY,
        email text UNIQUE,
        full_name text,
        role text NOT NULL DEFAULT 'promotora',
        sucursal text DEFAULT 'GLOBAL',
        region_id uuid,
        is_active boolean NOT NULL DEFAULT true,
        must_change_password boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $ddl$;
  END IF;

  IF to_regclass('public.cronograma_degustaciones') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.cronograma_degustaciones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        fecha date NOT NULL,
        turno text NOT NULL CHECK (turno IN ('MAÑANA', 'TARDE', 'COMPLETO')),
        hora_inicio text DEFAULT '09:00',
        hora_fin text DEFAULT '13:00',
        cliente_nombre text NOT NULL,
        cliente_codigo text NOT NULL DEFAULT '',
        zona_direccion text NOT NULL DEFAULT '',
        producto_resumen text NOT NULL,
        productos jsonb NOT NULL DEFAULT '[]'::jsonb,
        cantidad_kilos numeric(12,2) NOT NULL DEFAULT 1,
        personas_estimadas integer NOT NULL DEFAULT 0,
        insumos_calculados jsonb NOT NULL DEFAULT '{}'::jsonb,
        vendedor_fdv text NOT NULL DEFAULT '',
        promotora_id uuid,
        promotora_nombre text NOT NULL DEFAULT 'POR ASIGNAR (Trade Marketing)',
        promotora_email text,
        observaciones text NOT NULL DEFAULT '',
        estado text NOT NULL DEFAULT 'APROBADA',
        sucursal text NOT NULL DEFAULT 'ZULIA',
        idempotency_hash text,
        survey_origen_id text,
        carga_id uuid,
        en_historial boolean NOT NULL DEFAULT false,
        archivado_en timestamptz,
        motivo_archivo text,
        motivo_rechazo text,
        fecha_rechazo timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $ddl$;
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.rutas_promotoras (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cronograma_id uuid REFERENCES public.cronograma_degustaciones(id) ON DELETE CASCADE,
        fecha date NOT NULL,
        turno text NOT NULL CHECK (turno IN ('MAÑANA', 'TARDE', 'COMPLETO')),
        hora_inicio text DEFAULT '09:00',
        hora_fin text DEFAULT '13:00',
        cliente_nombre text NOT NULL,
        cliente_codigo text NOT NULL DEFAULT '',
        zona_direccion text NOT NULL DEFAULT '',
        producto_resumen text NOT NULL,
        productos jsonb NOT NULL DEFAULT '[]'::jsonb,
        cantidad_kilos numeric(12,2) NOT NULL DEFAULT 1,
        vendedor_fdv text NOT NULL DEFAULT '',
        promotora_id uuid,
        promotora_nombre text NOT NULL DEFAULT 'POR ASIGNAR (Trade Marketing)',
        promotora_email text,
        estado_ruta text NOT NULL DEFAULT 'ASIGNADA' CHECK (estado_ruta IN ('ASIGNADA', 'EN_CURSO', 'COMPLETADA', 'CANCELADA')),
        checkin_at timestamptz,
        checkout_at timestamptz,
        observaciones text NOT NULL DEFAULT '',
        sucursal text NOT NULL DEFAULT 'ZULIA',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $ddl$;
  END IF;

  IF to_regclass('public.entregas_degustacion') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.entregas_degustacion (
        id text PRIMARY KEY,
        cronograma_id uuid,
        fecha text NOT NULL,
        turno text NOT NULL CHECK (turno IN ('MAÑANA', 'TARDE')),
        numero_grupo_turno text NOT NULL DEFAULT '',
        cliente text NOT NULL,
        producto text NOT NULL,
        vendedor text NOT NULL DEFAULT '',
        promotora text NOT NULL DEFAULT '',
        stand_entregado boolean NOT NULL DEFAULT false,
        producto_entregado boolean NOT NULL DEFAULT false,
        completado boolean NOT NULL DEFAULT false,
        estado_logistico text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado_logistico IN ('PENDIENTE', 'EN_RUTA', 'ENTREGADO')),
        hora_salida text,
        hora_salida_real timestamptz,
        hora_llegada text,
        hora_entrega text,
        hora_entrega_real timestamptz,
        actualizado_chofer_at timestamptz,
        client_mutation_id uuid,
        evidencia_path text,
        evidencia_bucket text DEFAULT 'entregas-evidencias',
        evidencia_subida_at timestamptz,
        notas_chofer text NOT NULL DEFAULT '',
        sucursal text NOT NULL DEFAULT 'ZULIA',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $ddl$;
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 3. EVOLUCIÓN NO DESTRUCTIVA DE COLUMNAS E ÍNDICES
-- ------------------------------------------------------------------------------

ALTER TABLE public.entregas_degustacion
  ADD COLUMN IF NOT EXISTS cronograma_id uuid,
  ADD COLUMN IF NOT EXISTS estado_logistico text NOT NULL DEFAULT 'PENDIENTE',
  ADD COLUMN IF NOT EXISTS hora_salida text,
  ADD COLUMN IF NOT EXISTS hora_salida_real timestamptz,
  ADD COLUMN IF NOT EXISTS hora_llegada text,
  ADD COLUMN IF NOT EXISTS hora_entrega_real timestamptz,
  ADD COLUMN IF NOT EXISTS actualizado_chofer_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_mutation_id uuid,
  ADD COLUMN IF NOT EXISTS evidencia_path text,
  ADD COLUMN IF NOT EXISTS evidencia_bucket text DEFAULT 'entregas-evidencias',
  ADD COLUMN IF NOT EXISTS evidencia_subida_at timestamptz,
  ADD COLUMN IF NOT EXISTS sucursal text NOT NULL DEFAULT 'ZULIA';

ALTER TABLE public.cronograma_degustaciones
  ADD COLUMN IF NOT EXISTS promotora_nombre text NOT NULL DEFAULT 'POR ASIGNAR (Trade Marketing)',
  ADD COLUMN IF NOT EXISTS promotora_email text,
  ADD COLUMN IF NOT EXISTS sucursal text NOT NULL DEFAULT 'ZULIA',
  ADD COLUMN IF NOT EXISTS en_historial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archivado_en timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_archivo text;

ALTER TABLE public.rutas_promotoras
  ADD COLUMN IF NOT EXISTS promotora_nombre text NOT NULL DEFAULT 'POR ASIGNAR (Trade Marketing)',
  ADD COLUMN IF NOT EXISTS promotora_email text,
  ADD COLUMN IF NOT EXISTS observaciones text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sucursal text NOT NULL DEFAULT 'ZULIA';

CREATE INDEX IF NOT EXISTS idx_cronograma_degustaciones_fecha_turno
  ON public.cronograma_degustaciones (fecha, turno);
CREATE INDEX IF NOT EXISTS idx_cronograma_degustaciones_estado
  ON public.cronograma_degustaciones (estado);
CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_cronograma_id
  ON public.rutas_promotoras (cronograma_id);
CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_fecha_estado
  ON public.rutas_promotoras (fecha, estado_ruta);
CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_email_lower
  ON public.rutas_promotoras (LOWER(BTRIM(COALESCE(promotora_email, ''))));
CREATE INDEX IF NOT EXISTS idx_entregas_degustacion_cronograma_id
  ON public.entregas_degustacion (cronograma_id);
CREATE INDEX IF NOT EXISTS idx_entregas_degustacion_estado_logistico
  ON public.entregas_degustacion (estado_logistico);

-- ------------------------------------------------------------------------------
-- 4. PRIVILEGIOS Y POLÍTICAS RLS GRANULARES (`TO authenticated`, MÍNIMO PRIVILEGIO)
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  GRANT USAGE ON SCHEMA public TO authenticated;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.promotoras FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.promotoras TO authenticated;
    ALTER TABLE public.promotoras ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_promotoras ON public.promotoras;
    DROP POLICY IF EXISTS trade_rls_insert_promotoras ON public.promotoras;
    DROP POLICY IF EXISTS trade_rls_update_promotoras ON public.promotoras;

    CREATE POLICY trade_rls_select_promotoras
      ON public.promotoras
      FOR SELECT
      TO authenticated
      USING ((SELECT auth.uid()) IS NOT NULL AND public.fn_trade_current_actor_role() <> '__INACTIVE__');

    CREATE POLICY trade_rls_insert_promotoras
      ON public.promotoras
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.fn_trade_is_manager_or_admin()));

    CREATE POLICY trade_rls_update_promotoras
      ON public.promotoras
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.fn_trade_is_manager_or_admin()))
      WITH CHECK ((SELECT public.fn_trade_is_manager_or_admin()));
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon;
    GRANT SELECT, UPDATE ON TABLE public.profiles TO authenticated;
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_profiles ON public.profiles;
    DROP POLICY IF EXISTS trade_rls_update_profiles ON public.profiles;

    CREATE POLICY trade_rls_select_profiles
      ON public.profiles
      FOR SELECT
      TO authenticated
      USING (
        id = (SELECT auth.uid())
        OR (SELECT public.fn_trade_is_manager_or_admin())
      );

    CREATE POLICY trade_rls_update_profiles
      ON public.profiles
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.fn_trade_is_manager_or_admin()))
      WITH CHECK ((SELECT public.fn_trade_is_manager_or_admin()));
  END IF;

  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.cronograma_degustaciones FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cronograma_degustaciones TO authenticated;
    ALTER TABLE public.cronograma_degustaciones ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_cronograma ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS trade_rls_insert_cronograma ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS trade_rls_update_cronograma ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS trade_rls_delete_cronograma_qa_only ON public.cronograma_degustaciones;

    CREATE POLICY trade_rls_select_cronograma
      ON public.cronograma_degustaciones
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_is_promotora_owner(promotora_email, promotora_id));

    CREATE POLICY trade_rls_insert_cronograma
      ON public.cronograma_degustaciones
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.fn_trade_is_manager_or_admin()));

    CREATE POLICY trade_rls_update_cronograma
      ON public.cronograma_degustaciones
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.fn_trade_is_manager_or_admin()))
      WITH CHECK ((SELECT public.fn_trade_is_manager_or_admin()));

    CREATE POLICY trade_rls_delete_cronograma_qa_only
      ON public.cronograma_degustaciones
      FOR DELETE
      TO authenticated
      USING (
        (SELECT public.fn_trade_is_manager_or_admin())
        AND COALESCE(observaciones, '') ILIKE '%[QA-TEST]%'
      );
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.rutas_promotoras FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rutas_promotoras TO authenticated;
    ALTER TABLE public.rutas_promotoras ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_rutas_promotoras ON public.rutas_promotoras;
    DROP POLICY IF EXISTS trade_rls_insert_rutas_promotoras ON public.rutas_promotoras;
    DROP POLICY IF EXISTS trade_rls_update_rutas_promotoras ON public.rutas_promotoras;
    DROP POLICY IF EXISTS trade_rls_delete_rutas_promotoras_qa_only ON public.rutas_promotoras;

    CREATE POLICY trade_rls_select_rutas_promotoras
      ON public.rutas_promotoras
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_is_promotora_owner(promotora_email, promotora_id));

    CREATE POLICY trade_rls_insert_rutas_promotoras
      ON public.rutas_promotoras
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.fn_trade_is_manager_or_admin()));

    CREATE POLICY trade_rls_update_rutas_promotoras
      ON public.rutas_promotoras
      FOR UPDATE
      TO authenticated
      USING (public.fn_trade_is_promotora_owner(promotora_email, promotora_id))
      WITH CHECK (public.fn_trade_is_promotora_owner(promotora_email, promotora_id));

    CREATE POLICY trade_rls_delete_rutas_promotoras_qa_only
      ON public.rutas_promotoras
      FOR DELETE
      TO authenticated
      USING (
        (SELECT public.fn_trade_is_manager_or_admin())
        AND COALESCE(observaciones, '') ILIKE '%[QA-TEST]%'
      );
  END IF;

  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.entregas_degustacion FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.entregas_degustacion TO authenticated;
    ALTER TABLE public.entregas_degustacion ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_insert_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_update_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_delete_entregas_degustacion_qa_only ON public.entregas_degustacion;

    CREATE POLICY trade_rls_select_entregas_degustacion
      ON public.entregas_degustacion
      FOR SELECT
      TO authenticated
      USING ((SELECT public.fn_trade_is_chofer_or_manager()));

    CREATE POLICY trade_rls_insert_entregas_degustacion
      ON public.entregas_degustacion
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.fn_trade_is_manager_or_admin()));

    CREATE POLICY trade_rls_update_entregas_degustacion
      ON public.entregas_degustacion
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.fn_trade_is_chofer_or_manager()))
      WITH CHECK ((SELECT public.fn_trade_is_chofer_or_manager()));

    CREATE POLICY trade_rls_delete_entregas_degustacion_qa_only
      ON public.entregas_degustacion
      FOR DELETE
      TO authenticated
      USING (
        (SELECT public.fn_trade_is_manager_or_admin())
        AND COALESCE(notas_chofer, '') ILIKE '%[QA-TEST]%'
      );
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 5. SUPABASE STORAGE: BUCKET PRIVADO `entregas-evidencias` + POLÍTICAS RLS
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'entregas-evidencias',
      'entregas-evidencias',
      false,
      5242880,
      ARRAY['image/jpeg', 'image/png', 'image/webp']
    )
    ON CONFLICT (id) DO UPDATE SET
      public = false,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];
  END IF;

  IF to_regclass('storage.objects') IS NOT NULL THEN
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
        AND (SELECT public.fn_trade_is_chofer_or_manager())
      );

    CREATE POLICY trade_storage_insert_entregas_evidencias
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (SELECT public.fn_trade_is_chofer_or_manager())
      );

    CREATE POLICY trade_storage_update_entregas_evidencias
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (SELECT public.fn_trade_is_chofer_or_manager())
      )
      WITH CHECK (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (SELECT public.fn_trade_is_chofer_or_manager())
      );

    CREATE POLICY trade_storage_delete_entregas_evidencias
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'entregas-evidencias'
        AND name LIKE 'entregas/%'
        AND name NOT LIKE '%..%'
        AND (SELECT public.fn_trade_is_chofer_or_manager())
      );
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

-- ------------------------------------------------------------------------------
-- 6. VERIFICACIÓN EN 1 CLIC (POLÍTICAS RLS, BUCKET STORAGE Y COLUMNAS CLAVE)
-- ------------------------------------------------------------------------------

SELECT
  schemaname,
  tablename,
  policyname,
  cmd,
  roles
FROM pg_policies
WHERE (
  schemaname = 'public'
  AND tablename IN (
    'promotoras',
    'profiles',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'entregas_degustacion'
  )
)
OR (
  schemaname = 'storage'
  AND tablename = 'objects'
  AND policyname LIKE 'trade_storage_%'
)
ORDER BY schemaname, tablename, cmd, policyname;

SELECT
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
FROM storage.buckets
WHERE id = 'entregas-evidencias';

SELECT
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'promotoras',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'entregas_degustacion'
  )
  AND column_name IN (
    'correo',
    'nombre_completo',
    'activo',
    'categoria',
    'estado',
    'promotora_nombre',
    'promotora_email',
    'estado_ruta',
    'estado_logistico',
    'hora_salida',
    'hora_llegada',
    'evidencia_path',
    'evidencia_bucket',
    'cronograma_id'
  )
ORDER BY table_name, column_name;
