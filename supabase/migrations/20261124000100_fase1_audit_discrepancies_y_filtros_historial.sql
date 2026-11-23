-- =============================================================================
-- FASE 1 (1/4) — PERSISTENCIA DE AUDITORÍA (`audit_logs`), ALERTAS DE
-- DISCREPANCIA (`discrepancy_alerts`), POLÍTICAS RLS DE `"Regiones"` E
-- ÍNDICES COMPUESTOS PARA HISTORIAL DE DEGUSTACIONES
--
-- Archivo:   supabase/migrations/20261124000100_fase1_audit_discrepancies_y_filtros_historial.sql
-- Destino:   https://apaxdgxtaoeyswlfblgi.supabase.co (PostgreSQL 15+ / 17)
--
-- Garantías de Seguridad e Idempotencia:
--   1. 100 % idempotente y no destructivo (CERO DROP TABLE, TRUNCATE ni DELETE).
--   2. CERO secretos ni UUIDs hardcodeados.
--   3. Row Level Security (`ENABLE` + `FORCE`) en `public.audit_logs` y
--      `public.discrepancy_alerts`, con `REVOKE ALL` a `PUBLIC` y `anon`.
--   4. Compatible tanto con la cadena completa de migraciones locales/CI
--      (`supabase db reset --local`) como con ejecución controlada sobre la
--      instancia remota que contiene la tabla existente `public."Regiones"`
--      (`id_regi uuid PK`, `created_at timestamptz`, `regi_desd text`,
--       `regi_saba boolean`; regiones válidas: 'OCCIDENTE', 'CENTRO', 'ANDES').
--   5. Las funciones helper RLS únicamente confían en funciones verificadas
--      del esquema `public` o en `auth.jwt() -> 'app_metadata'` firmado por
--      servidor (NUNCA en `user_metadata`).
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. FUNCIONES HELPER IDEMPOTENTES Y ZERO TRUST PARA POLÍTICAS RLS DE FASE 1
--    (Delegan a las funciones canónicas de RBAC si existen; en caso contrario
--     evalúan exclusivamente `app_metadata` del JWT firmado por Supabase Auth.)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_fase1_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_fase1_touch_updated_at() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.fn_fase1_is_super_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_result BOOLEAN;
  v_jwt_role TEXT;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN FALSE;
  END IF;

  IF to_regprocedure('public.is_super_admin()') IS NOT NULL THEN
    EXECUTE 'SELECT public.is_super_admin()' INTO v_result;
    RETURN COALESCE(v_result, FALSE);
  END IF;

  v_jwt_role := lower(btrim(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    ''
  )));
  RETURN v_jwt_role IN ('super_admin', 'superadmin');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_fase1_is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_fase1_is_super_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_fase1_actor_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN NULL;
  END IF;

  IF to_regprocedure('public.obtener_mi_rol()') IS NOT NULL THEN
    EXECUTE 'SELECT public.obtener_mi_rol()' INTO v_role;
    IF v_role IS NOT NULL AND btrim(v_role) <> '' THEN
      RETURN lower(btrim(v_role));
    END IF;
  END IF;

  v_role := lower(btrim(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    ''
  )));
  RETURN NULLIF(v_role, '');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_fase1_actor_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_fase1_actor_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_fase1_is_torre_control()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_result BOOLEAN;
  v_role TEXT;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN FALSE;
  END IF;

  IF to_regprocedure('public.is_torre_control_viewer()') IS NOT NULL THEN
    EXECUTE 'SELECT public.is_torre_control_viewer()' INTO v_result;
    RETURN COALESCE(v_result, FALSE);
  END IF;

  v_role := public.fn_fase1_actor_role();
  RETURN v_role IN (
    'super_admin',
    'superadmin',
    'admin',
    'gerencia',
    'gerente_admin',
    'coordinacion',
    'coordinadora',
    'contraloria',
    'analista_contraloria',
    'auditor'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_fase1_is_torre_control() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_fase1_is_torre_control() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_fase1_is_global_scope()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_sucursal TEXT;
  v_role TEXT;
BEGIN
  IF public.fn_fase1_is_super_admin() THEN
    RETURN TRUE;
  END IF;

  v_role := public.fn_fase1_actor_role();
  IF v_role IN ('admin', 'gerencia', 'gerente_admin', 'contraloria', 'analista_contraloria', 'auditor') THEN
    RETURN TRUE;
  END IF;

  IF to_regprocedure('public.obtener_mi_sucursal()') IS NOT NULL THEN
    EXECUTE 'SELECT public.obtener_mi_sucursal()::text' INTO v_sucursal;
    RETURN upper(btrim(COALESCE(v_sucursal, ''))) = 'GLOBAL';
  END IF;

  v_sucursal := upper(btrim(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'sucursal',
    ''
  )));
  RETURN v_sucursal = 'GLOBAL';
END;
$$;

REVOKE ALL ON FUNCTION public.fn_fase1_is_global_scope() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_fase1_is_global_scope() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_fase1_actor_region_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_region_id UUID;
  v_raw TEXT;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN NULL;
  END IF;

  IF to_regprocedure('public.obtener_mi_region_id()') IS NOT NULL THEN
    EXECUTE 'SELECT public.obtener_mi_region_id()' INTO v_region_id;
    IF v_region_id IS NOT NULL THEN
      RETURN v_region_id;
    END IF;
  END IF;

  v_raw := btrim(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'region_id',
    ''
  ));
  IF v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN v_raw::uuid;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_fase1_actor_region_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_fase1_actor_region_id() TO authenticated, service_role;

-- =============================================================================
-- 2. TABLA: `public.audit_logs` (Bitácora inmutable de auditoría — append-only)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  region_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT NULL,
  CONSTRAINT chk_audit_logs_actor_role_nonempty CHECK (btrim(actor_role) <> ''),
  CONSTRAINT chk_audit_logs_action_nonempty CHECK (btrim(action) <> ''),
  CONSTRAINT chk_audit_logs_entity_type_nonempty CHECK (btrim(entity_type) <> ''),
  CONSTRAINT chk_audit_logs_entity_id_nonempty CHECK (btrim(entity_id) <> '')
);

COMMENT ON TABLE public.audit_logs IS
  'Bitácora persistente de auditoría (append-only para usuarios autenticados). Almacena trazabilidad de acciones críticas y metadatos de integridad (SHA-256, estado previo/nuevo, justificación).';

CREATE INDEX IF NOT EXISTS idx_audit_logs_region_created_at
  ON public.audit_logs (region_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created_at
  ON public.audit_logs (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created_at
  ON public.audit_logs (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at
  ON public.audit_logs (action, created_at DESC);

REVOKE ALL ON TABLE public.audit_logs FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE public.audit_logs TO authenticated;
GRANT ALL ON TABLE public.audit_logs TO service_role;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_select_authenticated ON public.audit_logs;
CREATE POLICY audit_logs_select_authenticated
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.fn_fase1_is_super_admin())
    OR (
      (SELECT public.fn_fase1_is_torre_control())
      AND (
        (SELECT public.fn_fase1_is_global_scope())
        OR region_id IS NULL
        OR region_id = (SELECT public.fn_fase1_actor_region_id())
      )
    )
    OR actor_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS audit_logs_insert_authenticated ON public.audit_logs;
CREATE POLICY audit_logs_insert_authenticated
  ON public.audit_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) IS NOT NULL
    AND (actor_id IS NULL OR actor_id = (SELECT auth.uid()))
    AND (
      (SELECT public.fn_fase1_is_super_admin())
      OR (SELECT public.fn_fase1_is_torre_control())
      OR (SELECT public.fn_fase1_actor_role()) IN (
        'promotora',
        'vendedor',
        'chofer',
        'logistica',
        'supervisor'
      )
    )
    AND (
      (SELECT public.fn_fase1_is_global_scope())
      OR region_id IS NULL
      OR region_id = (SELECT public.fn_fase1_actor_region_id())
    )
  );

DROP POLICY IF EXISTS audit_logs_service_role_all ON public.audit_logs;
CREATE POLICY audit_logs_service_role_all
  ON public.audit_logs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- =============================================================================
-- 3. TABLA: `public.discrepancy_alerts` (Alertas de discrepancia / antifraude)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.discrepancy_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity TEXT NOT NULL DEFAULT 'MEDIA',
  status TEXT NOT NULL DEFAULT 'OPEN',
  category TEXT NOT NULL DEFAULT 'GENERAL',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT 'GENERAL',
  entity_id TEXT NOT NULL,
  region_id UUID NULL,
  resolved_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_discrepancy_alerts_severity
    CHECK (severity IN ('BAJA', 'MEDIA', 'ALTA', 'CRITICA')),
  CONSTRAINT chk_discrepancy_alerts_status
    CHECK (status IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED')),
  CONSTRAINT chk_discrepancy_alerts_title_nonempty
    CHECK (btrim(title) <> ''),
  CONSTRAINT chk_discrepancy_alerts_entity_id_nonempty
    CHECK (btrim(entity_id) <> '')
);

COMMENT ON TABLE public.discrepancy_alerts IS
  'Alertas operativas y antifraude (ej. facturas fiscales duplicadas, mermas no justificadas, desviaciones de geocerca).';

CREATE INDEX IF NOT EXISTS idx_discrepancy_alerts_status_sev_created
  ON public.discrepancy_alerts (status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_discrepancy_alerts_region_status_created
  ON public.discrepancy_alerts (region_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_discrepancy_alerts_entity
  ON public.discrepancy_alerts (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_discrepancy_alerts_open_partial
  ON public.discrepancy_alerts (region_id, severity, created_at DESC)
  WHERE status IN ('OPEN', 'IN_REVIEW');

DROP TRIGGER IF EXISTS trg_discrepancy_alerts_touch_updated_at ON public.discrepancy_alerts;
CREATE TRIGGER trg_discrepancy_alerts_touch_updated_at
  BEFORE UPDATE ON public.discrepancy_alerts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_fase1_touch_updated_at();

REVOKE ALL ON TABLE public.discrepancy_alerts FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.discrepancy_alerts TO authenticated;
GRANT ALL ON TABLE public.discrepancy_alerts TO service_role;

ALTER TABLE public.discrepancy_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discrepancy_alerts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS discrepancy_alerts_select_authenticated ON public.discrepancy_alerts;
CREATE POLICY discrepancy_alerts_select_authenticated
  ON public.discrepancy_alerts
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.fn_fase1_is_super_admin())
    OR (
      (SELECT public.fn_fase1_is_torre_control())
      AND (
        (SELECT public.fn_fase1_is_global_scope())
        OR region_id IS NULL
        OR region_id = (SELECT public.fn_fase1_actor_region_id())
      )
    )
  );

DROP POLICY IF EXISTS discrepancy_alerts_insert_authenticated ON public.discrepancy_alerts;
CREATE POLICY discrepancy_alerts_insert_authenticated
  ON public.discrepancy_alerts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.fn_fase1_is_super_admin())
    OR (
      (SELECT public.fn_fase1_is_torre_control())
      AND (
        (SELECT public.fn_fase1_is_global_scope())
        OR region_id IS NULL
        OR region_id = (SELECT public.fn_fase1_actor_region_id())
      )
    )
  );

DROP POLICY IF EXISTS discrepancy_alerts_update_authenticated ON public.discrepancy_alerts;
CREATE POLICY discrepancy_alerts_update_authenticated
  ON public.discrepancy_alerts
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.fn_fase1_is_super_admin())
    OR (
      (SELECT public.fn_fase1_is_torre_control())
      AND (
        (SELECT public.fn_fase1_is_global_scope())
        OR region_id IS NULL
        OR region_id = (SELECT public.fn_fase1_actor_region_id())
      )
    )
  )
  WITH CHECK (
    (SELECT public.fn_fase1_is_super_admin())
    OR (
      (SELECT public.fn_fase1_is_torre_control())
      AND (resolved_by IS NULL OR resolved_by = (SELECT auth.uid()))
      AND (
        (SELECT public.fn_fase1_is_global_scope())
        OR region_id IS NULL
        OR region_id = (SELECT public.fn_fase1_actor_region_id())
      )
    )
  );

DROP POLICY IF EXISTS discrepancy_alerts_service_role_all ON public.discrepancy_alerts;
CREATE POLICY discrepancy_alerts_service_role_all
  ON public.discrepancy_alerts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- =============================================================================
-- 4. INTEGRIDAD REFERENCIAL Y POLÍTICAS RLS DE LA TABLA EXISTENTE `"Regiones"`
--    Estructura confirmada en https://apaxdgxtaoeyswlfblgi.supabase.co:
--      * id_regi    UUID        PRIMARY KEY
--      * created_at TIMESTAMPTZ
--      * regi_desd  TEXT        (Únicamente 3 regiones válidas: 'OCCIDENTE', 'CENTRO', 'ANDES')
--      * regi_saba  BOOLEAN
--
--    Notas de Gobernanza (NO DESTRUCTIVO):
--      - Jamás elimina filas ni altera el esquema de `"Regiones"`.
--      - Jamás hardcodea UUIDs de `id_regi`.
--      - Usa identificadores exactos respetando mayúsculas/minúsculas (`public."Regiones"`).
--      - Al estar protegido por `to_regclass('public."Regiones"') IS NOT NULL`,
--        enlaza automáticamente las FKs y políticas en producción/staging y
--        permite que `supabase db reset --local` en CI pase sin fallos si la
--        tabla externa no existe en el contenedor efímero.
--
--    Verificación recomendada tras ejecutar en el SQL Editor de Supabase:
--      SELECT tablename, policyname, roles, cmd, qual, with_check
--      FROM pg_policies
--      WHERE schemaname = 'public'
--        AND tablename IN ('Regiones', 'audit_logs', 'discrepancy_alerts')
--      ORDER BY tablename, policyname;
-- =============================================================================

DO $$
DECLARE
  v_has_id_regi BOOLEAN;
  v_has_regi_desd BOOLEAN;
BEGIN
  IF to_regclass('public."Regiones"') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Regiones'
        AND column_name = 'id_regi'
    ) INTO v_has_id_regi;

    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Regiones'
        AND column_name = 'regi_desd'
    ) INTO v_has_regi_desd;

    -- 4.1 Claves foráneas `region_id -> public."Regiones"(id_regi)`
    IF v_has_id_regi THEN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_audit_logs_region_id_regiones'
          AND conrelid = 'public.audit_logs'::regclass
      ) THEN
        ALTER TABLE public.audit_logs
          ADD CONSTRAINT fk_audit_logs_region_id_regiones
          FOREIGN KEY (region_id)
          REFERENCES public."Regiones" (id_regi)
          ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_discrepancy_alerts_region_id_regiones'
          AND conrelid = 'public.discrepancy_alerts'::regclass
      ) THEN
        ALTER TABLE public.discrepancy_alerts
          ADD CONSTRAINT fk_discrepancy_alerts_region_id_regiones
          FOREIGN KEY (region_id)
          REFERENCES public."Regiones" (id_regi)
          ON DELETE SET NULL;
      END IF;
    END IF;

    -- 4.2 Políticas RLS de mínimo privilegio sobre `public."Regiones"` (sin borrar datos)
    REVOKE ALL ON TABLE public."Regiones" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Regiones" TO authenticated;
    GRANT ALL ON TABLE public."Regiones" TO service_role;

    ALTER TABLE public."Regiones" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public."Regiones" FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS regiones_ext_select_authenticated ON public."Regiones";
    DROP POLICY IF EXISTS regiones_ext_admin_write ON public."Regiones";
    DROP POLICY IF EXISTS regiones_ext_service_role_all ON public."Regiones";

    IF v_has_regi_desd THEN
      EXECUTE $pol$
        CREATE POLICY regiones_ext_select_authenticated
          ON public."Regiones"
          FOR SELECT
          TO authenticated
          USING (
            upper(btrim(COALESCE(regi_desd, ''))) IN ('OCCIDENTE', 'CENTRO', 'ANDES')
          )
      $pol$;

      EXECUTE $pol$
        CREATE POLICY regiones_ext_admin_write
          ON public."Regiones"
          FOR ALL
          TO authenticated
          USING ((SELECT public.fn_fase1_is_super_admin()))
          WITH CHECK (
            (SELECT public.fn_fase1_is_super_admin())
            AND upper(btrim(COALESCE(regi_desd, ''))) IN ('OCCIDENTE', 'CENTRO', 'ANDES')
          )
      $pol$;
    ELSE
      EXECUTE $pol$
        CREATE POLICY regiones_ext_select_authenticated
          ON public."Regiones"
          FOR SELECT
          TO authenticated
          USING ((SELECT auth.uid()) IS NOT NULL)
      $pol$;

      EXECUTE $pol$
        CREATE POLICY regiones_ext_admin_write
          ON public."Regiones"
          FOR ALL
          TO authenticated
          USING ((SELECT public.fn_fase1_is_super_admin()))
          WITH CHECK ((SELECT public.fn_fase1_is_super_admin()))
      $pol$;
    END IF;

    EXECUTE $pol$
      CREATE POLICY regiones_ext_service_role_all
        ON public."Regiones"
        FOR ALL
        TO service_role
        USING (TRUE)
        WITH CHECK (TRUE)
    $pol$;
  ELSE
    RAISE NOTICE 'public."Regiones" no existe en este entorno efímero; FKs hacia "Regiones"(id_regi) y políticas RLS se omiten de forma segura.';
  END IF;
END $$;

-- =============================================================================
-- 5. ÍNDICES COMPUESTOS Y DE BÚSQUEDA PARA CONSULTAS FILTRADAS DE HISTORIAL
--    (status/estado, shift/turno, fechas, store, product y comments)
-- =============================================================================

DO $$
DECLARE
  v_surveys_has_fecha_evento BOOLEAN;
  v_surveys_has_en_historial BOOLEAN;
  v_has_pg_trgm BOOLEAN;
BEGIN
  -- 5.1 Índices compuestos en `public.cronograma_degustaciones` (estado, turno, fecha)
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'cronograma_degustaciones'
        AND column_name IN ('en_historial', 'estado', 'turno', 'fecha')
      GROUP BY table_name
      HAVING count(*) = 4
    ) THEN
      EXECUTE '
        CREATE INDEX IF NOT EXISTS idx_cronograma_deg_historial_estado_turno_fecha
          ON public.cronograma_degustaciones (en_historial, estado, turno, fecha DESC)
      ';
    END IF;
  END IF;

  -- 5.2 Índices compuestos en `public.surveys` para el historial paginado en servidor
  IF to_regclass('public.surveys') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'surveys' AND column_name = 'fecha_evento'
    ) INTO v_surveys_has_fecha_evento;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'surveys' AND column_name = 'en_historial'
    ) INTO v_surveys_has_en_historial;

    IF v_surveys_has_fecha_evento AND v_surveys_has_en_historial THEN
      EXECUTE $idx$
        CREATE INDEX IF NOT EXISTS idx_surveys_deg_historial_fecha_created
          ON public.surveys (en_historial, fecha_evento DESC, created_at DESC)
          WHERE type = 'Degustacion'
      $idx$;

      EXECUTE $idx$
        CREATE INDEX IF NOT EXISTS idx_surveys_deg_store_product_fecha
          ON public.surveys (fecha_evento DESC, store, product)
          WHERE type = 'Degustacion'
      $idx$;
    ELSE
      EXECUTE $idx$
        CREATE INDEX IF NOT EXISTS idx_surveys_deg_store_product_date
          ON public.surveys (date DESC, store, product)
          WHERE type = 'Degustacion'
      $idx$;
    END IF;

    -- 5.3 Índices GIN `pg_trgm` condicionales para acelerar `ILIKE '%...%'` en comments, store y product
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION
      WHEN insufficient_privilege OR undefined_file THEN
        RAISE NOTICE 'Extensión pg_trgm no disponible por permisos; se omite creación de índices GIN trigram.';
    END;

    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_trgm'
    ) INTO v_has_pg_trgm;

    IF v_has_pg_trgm THEN
      EXECUTE $idx$
        CREATE INDEX IF NOT EXISTS idx_surveys_deg_comments_trgm
          ON public.surveys USING gin (comments gin_trgm_ops)
          WHERE type = 'Degustacion'
      $idx$;

      EXECUTE $idx$
        CREATE INDEX IF NOT EXISTS idx_surveys_deg_store_trgm
          ON public.surveys USING gin (store gin_trgm_ops)
          WHERE type = 'Degustacion'
      $idx$;

      EXECUTE $idx$
        CREATE INDEX IF NOT EXISTS idx_surveys_deg_product_trgm
          ON public.surveys USING gin (product gin_trgm_ops)
          WHERE type = 'Degustacion'
      $idx$;
    END IF;
  END IF;
END $$;

COMMIT;
