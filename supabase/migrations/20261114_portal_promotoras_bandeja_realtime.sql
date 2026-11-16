-- =============================================================================
-- CODIZULCA C.A. - PROGRAMA DE TRADE MARKETING (SUPABASE: "dashboard de gerencia")
-- Migración: Integración Nativa de /portal/, Bandeja vs. Historial ("No Autorizada")
--            y Sincronización Atómica en Tiempo Real (Módulo 1 -> /portal/ + Módulo 2)
--
-- Reglas de Seguridad y Arquitectura:
--   1. Cero credenciales ni secretos en SQL.
--   2. Zona horaria oficial explícita: 'America/Caracas' (UTC-4) mediante fn_hoy_caracas().
--   3. Soporte idempotente para estado 'NO_AUTORIZADA' en cronograma_degustaciones y surveys,
--      además de clasificación automática a 'NO_AUTORIZADA' cuando fecha < fn_hoy_caracas()
--      sin haber sido aprobada.
--   4. RPC transaccional atómica rpc_autorizar_degustacion_trade (normaliza LOWER(TRIM(email)),
--      vincula promotora activa de public.staff, hace UPSERT sin duplicados en
--      cronograma_degustaciones y rutas_promotoras) y rpc_no_autorizar_degustacion_trade.
--   5. RLS estricto:
--      - Solo Coordinación / Admin / Gerencia (app_metadata) autorizan o marcan 'NO_AUTORIZADA'.
--      - En /portal/, cada promotora autenticada solo lee sus propias rutas autorizadas donde
--        LOWER(BTRIM(promotora_email)) = LOWER(BTRIM(auth.jwt() ->> 'email')) o vínculo staff_id.
--   6. Publicación garantizada en supabase_realtime con REPLICA IDENTITY FULL.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. FUNCIÓN OFICIAL DE FECHA ACTUAL EN 'America/Caracas' (UTC-4)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_hoy_caracas()
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT (pg_catalog.timezone('America/Caracas', NOW()))::date;
$$;

GRANT EXECUTE ON FUNCTION public.fn_hoy_caracas() TO anon, authenticated;

-- =============================================================================
-- 2. EXPANSIÓN IDEMPOTENTE DEL ESTADO 'NO_AUTORIZADA' E ÍNDICES DE RENDIMIENTO
-- =============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    -- Eliminar cualquier constraint CHECK previo sobre la columna `estado` para recrearlo con 'NO_AUTORIZADA'
    FOR v_con IN
      SELECT c.conname
      FROM pg_constraint c
      WHERE c.conrelid = 'public.cronograma_degustaciones'::regclass
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%estado%'
        AND pg_get_constraintdef(c.oid) ILIKE '%PENDIENTE_APROBACION%'
    LOOP
      EXECUTE format(
        'ALTER TABLE public.cronograma_degustaciones DROP CONSTRAINT IF EXISTS %I',
        v_con.conname
      );
    END LOOP;

    ALTER TABLE public.cronograma_degustaciones
      ADD CONSTRAINT cronograma_degustaciones_estado_check
      CHECK (
        estado IN (
          'PENDIENTE_APROBACION',
          'APROBADA',
          'NO_AUTORIZADA',
          'RECHAZADA',
          'CANCELADA',
          'EN_CURSO',
          'COMPLETADA'
        )
      );

    ALTER TABLE public.cronograma_degustaciones
      ADD COLUMN IF NOT EXISTS en_historial BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS archivado_en TIMESTAMPTZ DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS motivo_archivo TEXT DEFAULT NULL;
  END IF;
END $$;

ALTER TABLE IF EXISTS public.surveys
  ADD COLUMN IF NOT EXISTS leido_trade BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS visto_en_trade_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS en_historial BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archivado_en TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motivo_archivo TEXT DEFAULT NULL;

DO $$
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    -- Actualizar índice parcial de idempotencia para permitir reenviar si una previa quedó NO_AUTORIZADA
    DROP INDEX IF EXISTS public.uq_cronograma_idempotency_active;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cronograma_idempotency_active
      ON public.cronograma_degustaciones (idempotency_hash)
      WHERE estado NOT IN ('RECHAZADA', 'CANCELADA', 'NO_AUTORIZADA');

    CREATE INDEX IF NOT EXISTS idx_cronograma_fecha_estado_caracas
      ON public.cronograma_degustaciones (fecha DESC, estado);
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_email_trim_fecha
      ON public.rutas_promotoras (lower(btrim(promotora_email)), fecha ASC, hora_inicio ASC);
  END IF;

  IF to_regclass('public.staff') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_staff_email_lower_trim
      ON public.staff (lower(btrim(COALESCE(email, ''))));
  END IF;
END $$;

-- Normalizar correos ya existentes en cronograma_degustaciones y rutas_promotoras
DO $$
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    UPDATE public.cronograma_degustaciones
    SET promotora_email = lower(btrim(promotora_email))
    WHERE promotora_email IS NOT NULL
      AND promotora_email <> lower(btrim(promotora_email));
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    UPDATE public.rutas_promotoras
    SET promotora_email = lower(btrim(promotora_email))
    WHERE promotora_email IS NOT NULL
      AND promotora_email <> lower(btrim(promotora_email));
  END IF;
END $$;

-- =============================================================================
-- 3. FUNCIONES ZERO TRUST EN ESQUEMA `private` (JWT EMAIL + APP_METADATA + STAFF)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.current_jwt_email_normalized()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT lower(
    pg_catalog.btrim(
      COALESCE((SELECT auth.jwt()) ->> 'email', '')
    )
  );
$$;

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
       'admin',
       'gerencia',
       'gerente_admin',
       'superadmin'
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
       'coordinadora',
       'coordinadora_trade',
       'jefe_trade',
       'supervisor',
       'analista_contraloria',
       'gerencia',
       'gerente_admin',
       'admin',
       'superadmin'
     );
$$;

-- Resuelve el UUID de public.staff correspondiente a la promotora autenticada:
--   1. Por vínculo directo auth_user_id = auth.uid()
--   2. Por claim inmutable app_metadata.staff_id
--   3. Por coincidencia exacta LOWER(TRIM(email)) entre el JWT autenticado y public.staff.email
--      (Pestaña de Personal del Módulo 1), verificando que esté Activa y no sea Merchandising.
CREATE OR REPLACE FUNCTION private.current_active_promotora_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_jwt_email TEXT := (SELECT private.current_jwt_email_normalized());
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

  -- Prioridad 1: vínculo físico auth_user_id
  SELECT s.id, s.role, s.status, s.email, s.auth_user_id
  INTO v_staff
  FROM public.staff s
  WHERE s.auth_user_id = v_uid
  LIMIT 1;

  -- Prioridad 2: claim firmado app_metadata.staff_id
  IF NOT FOUND AND v_claim_staff_id IS NOT NULL THEN
    SELECT s.id, s.role, s.status, s.email, s.auth_user_id
    INTO v_staff
    FROM public.staff s
    WHERE s.id = v_claim_staff_id
      AND (s.auth_user_id IS NULL OR s.auth_user_id = v_uid)
    LIMIT 1;
  END IF;

  -- Prioridad 3: correo exacto registrado en Pestaña de Personal (public.staff.email)
  IF NOT FOUND AND v_jwt_email <> '' THEN
    SELECT s.id, s.role, s.status, s.email, s.auth_user_id
    INTO v_staff
    FROM public.staff s
    WHERE lower(pg_catalog.btrim(COALESCE(s.email, ''))) = v_jwt_email
      AND (s.auth_user_id IS NULL OR s.auth_user_id = v_uid)
    ORDER BY s.created_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_staff.status IS NOT NULL AND pg_catalog.btrim(v_staff.status::text) LIKE '{%' THEN
    BEGIN
      v_status_json := (v_staff.status::text)::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_status_json := '{}'::jsonb;
    END;
  END IF;

  v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
  v_member_category := lower(COALESCE(v_status_json ->> 'category', ''));

  IF lower(pg_catalog.btrim(v_member_status)) = 'inactivo' THEN
    RETURN NULL;
  END IF;

  IF v_member_category = 'merchandising'
     OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
    RETURN NULL;
  END IF;

  RETURN v_staff.id;
END;
$$;

REVOKE ALL ON FUNCTION private.current_jwt_email_normalized() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.current_app_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.is_strict_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.is_coordinator_or_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.current_active_promotora_id() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.current_jwt_email_normalized() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_strict_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_coordinator_or_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_active_promotora_id() TO authenticated;

-- =============================================================================
-- 4. ACTUALIZACIÓN DE TRIGGERS DE VALIDACIÓN, RUTA E INMUTABILIDAD EN CARACAS
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_validate_and_enrich_cronograma_degustacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_staff RECORD;
  v_status_json JSONB := '{}'::jsonb;
  v_member_status TEXT := 'Activo';
  v_member_category TEXT := '';
  v_survey RECORD;
  v_survey_comments JSONB := '{}'::jsonb;
  v_survey_estado TEXT := '';
  v_conflict RECORD;
BEGIN
  NEW.updated_at := NOW();
  NEW.idempotency_hash := lower(pg_catalog.btrim(COALESCE(NEW.idempotency_hash, '')));

  IF NEW.idempotency_hash = '' THEN
    RAISE EXCEPTION 'El campo idempotency_hash es obligatorio para registrar la degustación.'
      USING ERRCODE = '23514';
  END IF;

  -- A. Candado de origen validado cuando proviene de solicitud FDV (public.surveys)
  IF NEW.survey_origen_id IS NOT NULL
     AND NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN
    SELECT s.id, s.type, s.comments
    INTO v_survey
    FROM public.surveys s
    WHERE s.id = NEW.survey_origen_id;

    IF NOT FOUND OR COALESCE(v_survey.type, '') <> 'Degustacion' THEN
      RAISE EXCEPTION 'ORIGEN NO VALIDADO: El registro origen (%) no existe o no es una degustación válida.', NEW.survey_origen_id
        USING ERRCODE = '23514';
    END IF;

    BEGIN
      IF v_survey.comments IS NOT NULL AND pg_catalog.btrim(v_survey.comments::text) LIKE '{%' THEN
        v_survey_comments := (v_survey.comments::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_survey_comments := '{}'::jsonb;
    END;

    v_survey_estado := upper(
      pg_catalog.btrim(
        COALESCE(
          v_survey_comments ->> 'estado',
          v_survey_comments ->> 'status',
          ''
        )
      )
    );

    IF v_survey_estado NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA', 'REALIZADA') THEN
      RAISE EXCEPTION 'ORIGEN NO VALIDADO: La degustación FDV (%) tiene estado "%" y debe estar explícitamente en "APROBADA" antes de asignarse a una ruta.',
        NEW.survey_origen_id, COALESCE(NULLIF(v_survey_estado, ''), 'SOLICITADA')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- B. Validación de promotora activa y normalización estricta LOWER(TRIM(email))
  IF NEW.promotora_id IS NOT NULL AND NEW.estado NOT IN ('NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA') THEN
    SELECT id, name, email, role, status
    INTO v_staff
    FROM public.staff
    WHERE id = NEW.promotora_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La promotora seleccionada (%) no existe en public.staff.', NEW.promotora_id
        USING ERRCODE = '23503';
    END IF;

    BEGIN
      IF v_staff.status IS NOT NULL AND pg_catalog.btrim(v_staff.status::text) LIKE '{%' THEN
        v_status_json := (v_staff.status::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_status_json := '{}'::jsonb;
    END;

    v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
    v_member_category := lower(COALESCE(v_status_json ->> 'category', ''));

    IF lower(pg_catalog.btrim(v_member_status)) = 'inactivo' THEN
      RAISE EXCEPTION 'No se puede asignar la promotora "%" porque figura como Inactiva.', v_staff.name
        USING ERRCODE = '23514';
    END IF;

    IF v_member_category = 'merchandising'
       OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
      RAISE EXCEPTION 'El perfil "%" pertenece a Merchandising y no puede asignarse a ruta de degustación.', v_staff.name
        USING ERRCODE = '23514';
    END IF;

    NEW.promotora_nombre := pg_catalog.btrim(v_staff.name);
    NEW.promotora_email := lower(pg_catalog.btrim(COALESCE(v_staff.email, '')));

    IF NEW.estado IN ('APROBADA', 'EN_CURSO') AND NEW.promotora_email = '' THEN
      RAISE EXCEPTION 'VALIDACIÓN REQUERIDA: La promotora "%" no tiene correo electrónico registrado en la Pestaña de Personal.', NEW.promotora_nombre
        USING ERRCODE = '23514';
    END IF;

    -- C. Prevención de doble reserva para la misma promotora, fecha y turno
    IF NEW.estado IN ('APROBADA', 'EN_CURSO') THEN
      SELECT c.id, c.cliente_nombre, c.turno
      INTO v_conflict
      FROM public.cronograma_degustaciones c
      WHERE c.promotora_id = NEW.promotora_id
        AND c.fecha = NEW.fecha
        AND c.estado IN ('APROBADA', 'EN_CURSO')
        AND c.id IS DISTINCT FROM NEW.id
        AND (
          NEW.turno = 'COMPLETO'
          OR c.turno = 'COMPLETO'
          OR c.turno = NEW.turno
        )
      LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION 'CONFLICTO DE JORNADA: La promotora "%" ya tiene asignada una degustación activa en "%" para el % (jornada %).',
          NEW.promotora_nombre, v_conflict.cliente_nombre, NEW.fecha, v_conflict.turno
          USING ERRCODE = '23505';
      END IF;
    END IF;
  ELSIF NEW.promotora_id IS NULL THEN
    NEW.promotora_nombre := NULL;
    NEW.promotora_email := NULL;

    IF NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN
      RAISE EXCEPTION 'BLOQUEO DE SEGURIDAD: No se puede autorizar ni asignar a ruta sin promotora_id válida.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.estado = 'APROBADA'
     AND (TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM 'APROBADA') THEN
    NEW.fecha_aprobacion := COALESCE(NEW.fecha_aprobacion, NOW());
    NEW.aprobado_por := COALESCE(NULLIF(pg_catalog.btrim(NEW.aprobado_por), ''), 'Coordinadora de Trade Marketing');
    NEW.en_historial := (NEW.fecha < public.fn_hoy_caracas());
  END IF;

  IF NEW.estado IN ('NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA')
     AND (TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM NEW.estado) THEN
    NEW.fecha_rechazo := COALESCE(NEW.fecha_rechazo, NOW());
    NEW.en_historial := TRUE;
    NEW.archivado_en := COALESCE(NEW.archivado_en, NOW());
    NEW.motivo_archivo := COALESCE(NEW.motivo_archivo, NEW.estado);
  END IF;

  RETURN NEW;
END;
$$;

-- Alinear el candado histórico con `fn_hoy_caracas()` (permitiendo a Coordinadora/Admin
-- autorizar o marcar 'NO_AUTORIZADA' en `fecha >= fn_hoy_caracas()`, y marcar vencidas como 'NO_AUTORIZADA')
CREATE OR REPLACE FUNCTION public.fn_guard_historical_degustacion_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
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
  END IF;

  -- Permitir la clasificación explícita o automática a 'NO_AUTORIZADA' por Coordinación
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
$$;

-- Actualizar políticas RESTRICTIVE previas de `20261113` para usar `fn_hoy_caracas()`
DO $$
BEGIN
  IF to_regclass('public.surveys') IS NOT NULL THEN
    DROP POLICY IF EXISTS surveys_restrict_historical_degustacion_update ON public.surveys;
    CREATE POLICY surveys_restrict_historical_degustacion_update
      ON public.surveys
      AS RESTRICTIVE
      FOR UPDATE
      TO anon, authenticated
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

    DROP POLICY IF EXISTS surveys_restrict_historical_degustacion_delete ON public.surveys;
    CREATE POLICY surveys_restrict_historical_degustacion_delete
      ON public.surveys
      AS RESTRICTIVE
      FOR DELETE
      TO anon, authenticated
      USING (
        type IS DISTINCT FROM 'Degustacion'
        OR COALESCE(fecha_evento, public.fn_parse_degustacion_fecha(date, comments)) >= public.fn_hoy_caracas()
        OR (SELECT private.is_strict_admin())
      );
  END IF;

  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    DROP POLICY IF EXISTS cronograma_restrict_historical_update ON public.cronograma_degustaciones;
    CREATE POLICY cronograma_restrict_historical_update
      ON public.cronograma_degustaciones
      AS RESTRICTIVE
      FOR UPDATE
      TO authenticated
      USING (
        fecha >= public.fn_hoy_caracas()
        OR (SELECT private.is_coordinator_or_admin())
      )
      WITH CHECK (
        fecha >= public.fn_hoy_caracas()
        OR (SELECT private.is_coordinator_or_admin())
      );

    DROP POLICY IF EXISTS cronograma_restrict_historical_delete ON public.cronograma_degustaciones;
    CREATE POLICY cronograma_restrict_historical_delete
      ON public.cronograma_degustaciones
      AS RESTRICTIVE
      FOR DELETE
      TO authenticated
      USING (
        fecha >= public.fn_hoy_caracas()
        OR (SELECT private.is_strict_admin())
      );
  END IF;
END $$;

-- =============================================================================
-- 5. VISTA Y FUNCIÓN DE CLASIFICACIÓN EN VIVO ('America/Caracas' -> 'NO_AUTORIZADA')
-- =============================================================================
DO $$
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW public.v_cronograma_degustaciones_caracas
      WITH (security_invoker = true) AS
      SELECT
        c.*,
        public.fn_hoy_caracas() AS hoy_caracas,
        CASE
          WHEN c.estado IN ('NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA') THEN 'NO_AUTORIZADA'
          WHEN c.fecha < public.fn_hoy_caracas()
               AND c.estado NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN 'NO_AUTORIZADA'
          ELSE c.estado
        END AS estado_efectivo_caracas,
        (
          c.fecha < public.fn_hoy_caracas()
          OR c.estado IN ('NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA')
        ) AS va_a_historial_caracas
      FROM public.cronograma_degustaciones c;
    $view$;

    GRANT SELECT ON public.v_cronograma_degustaciones_caracas TO authenticated;
  END IF;
END $$;

-- =============================================================================
-- 6. RPC TRANSACCIONAL ATÓMICA: `public.rpc_autorizar_degustacion_trade`
--    Normaliza LOWER(TRIM(email)) desde Pestaña de Personal (`public.staff`),
--    autoriza la degustación y proyecta sin duplicados (ON CONFLICT DO UPDATE)
--    hacia `public.cronograma_degustaciones` (Módulo 2) y `public.rutas_promotoras` (`/portal/`).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_autorizar_degustacion_trade(
  p_promotora_id UUID,
  p_survey_id UUID DEFAULT NULL,
  p_cronograma_id UUID DEFAULT NULL,
  p_aprobado_por TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_lock_key TEXT;
  v_staff RECORD;
  v_status_json JSONB := '{}'::jsonb;
  v_member_status TEXT := 'Activo';
  v_member_category TEXT := '';
  v_promotora_email TEXT;
  v_promotora_nombre TEXT;
  v_survey RECORD;
  v_comments JSONB := '{}'::jsonb;
  v_estado_origen TEXT := '';
  v_fecha DATE;
  v_raw_date TEXT;
  v_turno TEXT;
  v_hora_inicio TEXT;
  v_hora_fin TEXT;
  v_cliente_nombre TEXT;
  v_cliente_codigo TEXT;
  v_zona_direccion TEXT;
  v_productos JSONB := '[]'::jsonb;
  v_producto_resumen TEXT;
  v_cantidad_kilos NUMERIC(10, 2);
  v_personas_estimadas INTEGER;
  v_insumos JSONB := '{}'::jsonb;
  v_vendedor_fdv TEXT;
  v_observaciones TEXT;
  v_seed TEXT;
  v_hash TEXT;
  v_cronograma RECORD;
  v_target_cronograma_id UUID;
  v_aprobador TEXT;
  v_ruta public.rutas_promotoras;
BEGIN
  IF NOT (SELECT private.is_coordinator_or_admin()) THEN
    RAISE EXCEPTION 'ACCESO DENEGADO: Solo Coordinación, Gerencia o Admin pueden autorizar degustaciones.'
      USING ERRCODE = '42501';
  END IF;

  IF p_promotora_id IS NULL THEN
    RAISE EXCEPTION 'Debe seleccionar una promotora activa válida (p_promotora_id).'
      USING ERRCODE = '22023';
  END IF;

  IF p_survey_id IS NULL AND p_cronograma_id IS NULL THEN
    RAISE EXCEPTION 'Debe indicar p_survey_id o p_cronograma_id para autorizar la degustación.'
      USING ERRCODE = '22023';
  END IF;

  -- Candado transaccional anti-concurrencia / anti-doble clic
  v_lock_key := 'autorizar_trade|' || COALESCE(p_survey_id::text, '') || '|' || COALESCE(p_cronograma_id::text, '');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 20261114));

  -- 1. Validar promotora y correo registrado en Pestaña de Personal (`public.staff`)
  SELECT s.id, s.name, s.email, s.role, s.status
  INTO v_staff
  FROM public.staff s
  WHERE s.id = p_promotora_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La promotora seleccionada (%) no existe en la Pestaña de Personal (public.staff).', p_promotora_id
      USING ERRCODE = '23503';
  END IF;

  IF v_staff.status IS NOT NULL AND pg_catalog.btrim(v_staff.status::text) LIKE '{%' THEN
    BEGIN
      v_status_json := (v_staff.status::text)::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_status_json := '{}'::jsonb;
    END;
  END IF;

  v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
  v_member_category := lower(COALESCE(v_status_json ->> 'category', ''));

  IF lower(pg_catalog.btrim(v_member_status)) = 'inactivo' THEN
    RAISE EXCEPTION 'La promotora "%" figura como Inactiva en Personal y no puede ser asignada.', v_staff.name
      USING ERRCODE = '23514';
  END IF;

  IF v_member_category = 'merchandising'
     OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
    RAISE EXCEPTION 'El perfil "%" pertenece a Merchandising y no puede asignarse a ruta de degustaciones.', v_staff.name
      USING ERRCODE = '23514';
  END IF;

  v_promotora_nombre := pg_catalog.btrim(v_staff.name);
  v_promotora_email := lower(pg_catalog.btrim(COALESCE(v_staff.email, '')));

  IF v_promotora_email = '' OR position('@' IN v_promotora_email) <= 1 THEN
    RAISE EXCEPTION 'CORREO FALTANTE EN PERSONAL: La promotora "%" no tiene un correo electrónico válido registrado en la Pestaña de Personal del Módulo 1.', v_promotora_nombre
      USING ERRCODE = '23514';
  END IF;

  v_aprobador := COALESCE(
    NULLIF(pg_catalog.btrim(p_aprobado_por), ''),
    NULLIF((SELECT private.current_jwt_email_normalized()), ''),
    'Coordinadora de Trade Marketing'
  );

  -- =========================================================================
  -- RAMA A: Solicitud originada en Vendedores FDV (`public.surveys`)
  -- =========================================================================
  IF p_survey_id IS NOT NULL THEN
    SELECT *
    INTO v_survey
    FROM public.surveys s
    WHERE s.id = p_survey_id
    FOR UPDATE;

    IF NOT FOUND OR COALESCE(v_survey.type, '') <> 'Degustacion' THEN
      RAISE EXCEPTION 'La solicitud (%) no existe en public.surveys o no es de tipo Degustacion.', p_survey_id
        USING ERRCODE = 'P0002';
    END IF;

    BEGIN
      IF v_survey.comments IS NOT NULL AND pg_catalog.btrim(v_survey.comments::text) LIKE '{%' THEN
        v_comments := (v_survey.comments::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_comments := '{}'::jsonb;
    END;

    v_estado_origen := upper(
      pg_catalog.btrim(
        COALESCE(v_comments ->> 'estado', v_comments ->> 'status', 'SOLICITADA')
      )
    );

    v_raw_date := pg_catalog.btrim(
      COALESCE(v_comments ->> 'date', v_comments ->> 'fecha', v_survey.date::text, '')
    );

    BEGIN
      IF v_survey.fecha_evento IS NOT NULL THEN
        v_fecha := v_survey.fecha_evento;
      ELSIF v_raw_date ~ '^\d{4}-\d{2}-\d{2}' THEN
        v_fecha := substring(v_raw_date FROM 1 FOR 10)::date;
      ELSIF v_raw_date ~ '^\d{2}[/-]\d{2}[/-]\d{4}' THEN
        v_fecha := to_date(substring(v_raw_date FROM 1 FOR 10), 'DD-MM-YYYY');
      ELSE
        v_fecha := public.fn_hoy_caracas();
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fecha := public.fn_hoy_caracas();
    END;

    IF v_fecha < public.fn_hoy_caracas() AND NOT (SELECT private.is_strict_admin()) THEN
      RAISE EXCEPTION 'FECHA VENCIDA EN CARACAS: La degustación del % ya pasó a Historial como No Autorizada.', v_fecha
        USING ERRCODE = '23514';
    END IF;

    -- Persistir estado autorizado y correo normalizado en public.surveys
    v_comments := v_comments || jsonb_build_object(
      'estado', CASE WHEN v_estado_origen IN ('EN_CURSO', 'COMPLETADA', 'REALIZADA') THEN v_estado_origen ELSE 'APROBADA' END,
      'status', CASE WHEN v_estado_origen IN ('COMPLETADA', 'REALIZADA') THEN 'completada' WHEN v_estado_origen = 'EN_CURSO' THEN 'en_curso' ELSE 'aprobada' END,
      'promotoraAsignada', v_promotora_nombre,
      'promoter', v_promotora_nombre,
      'promotoraId', p_promotora_id::text,
      'promotoraEmail', v_promotora_email,
      'aprobadoEnTradeAt', COALESCE(v_comments ->> 'aprobadoEnTradeAt', to_jsonb(NOW()) #>> '{}'),
      'aprobadoPor', v_aprobador,
      'leido_trade', true
    ) - 'motivoRechazo' - 'rechazadoEnTradeAt';

    UPDATE public.surveys
    SET
      comments = v_comments::text,
      promoter = v_promotora_nombre,
      leido_trade = TRUE,
      en_historial = (v_fecha < public.fn_hoy_caracas()),
      visto_en_trade_at = COALESCE(visto_en_trade_at, NOW())
    WHERE id = p_survey_id;

    v_turno := upper(pg_catalog.btrim(COALESCE(v_comments ->> 'turno', v_comments ->> 'shift', 'MAÑANA')));
    IF v_turno LIKE '%TARDE%' THEN
      v_turno := 'TARDE';
      v_hora_inicio := '14:00';
      v_hora_fin := '18:00';
    ELSIF v_turno LIKE '%COMPLETO%' OR v_turno LIKE '%DIA%' OR v_turno LIKE '%DÍA%' THEN
      v_turno := 'COMPLETO';
      v_hora_inicio := '09:00';
      v_hora_fin := '18:00';
    ELSE
      v_turno := 'MAÑANA';
      v_hora_inicio := '09:00';
      v_hora_fin := '13:00';
    END IF;

    v_hora_inicio := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(v_comments ->> 'horaInicio', '')), ''), v_hora_inicio);
    v_hora_fin := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(v_comments ->> 'horaFin', '')), ''), v_hora_fin);

    v_cliente_nombre := COALESCE(
      NULLIF(pg_catalog.btrim(COALESCE(v_comments ->> 'cliente', v_comments ->> 'client', v_comments ->> 'storeName', v_survey.store, '')), ''),
      'PDV Confirmado'
    );
    v_cliente_codigo := pg_catalog.btrim(COALESCE(v_comments ->> 'clienteCodigo', v_comments ->> 'clientCode', ''));
    v_zona_direccion := pg_catalog.btrim(COALESCE(v_comments ->> 'direccion', v_comments ->> 'address', v_comments ->> 'ruta', v_comments ->> 'zone', ''));

    IF jsonb_typeof(v_comments -> 'products') = 'array' AND jsonb_array_length(v_comments -> 'products') > 0 THEN
      v_productos := v_comments -> 'products';
      SELECT string_agg(pg_catalog.btrim(elem), ' + ')
      INTO v_producto_resumen
      FROM jsonb_array_elements_text(v_productos) AS elem
      WHERE pg_catalog.btrim(elem) <> '';
    ELSIF jsonb_typeof(v_comments -> 'productos') = 'array' AND jsonb_array_length(v_comments -> 'productos') > 0 THEN
      v_productos := v_comments -> 'productos';
      SELECT string_agg(pg_catalog.btrim(elem), ' + ')
      INTO v_producto_resumen
      FROM jsonb_array_elements_text(v_productos) AS elem
      WHERE pg_catalog.btrim(elem) <> '';
    END IF;

    v_producto_resumen := COALESCE(
      NULLIF(pg_catalog.btrim(COALESCE(v_producto_resumen, v_comments ->> 'product', v_comments ->> 'producto', v_survey.product, '')), ''),
      'DEGUSTACIÓN CODIZULCA'
    );
    IF jsonb_typeof(v_productos) <> 'array' OR jsonb_array_length(v_productos) = 0 THEN
      v_productos := jsonb_build_array(v_producto_resumen);
    END IF;

    BEGIN
      v_cantidad_kilos := GREATEST(
        COALESCE(NULLIF(regexp_replace(COALESCE(v_comments ->> 'kilos', v_comments ->> 'requestedQty', '1'), '[^0-9.]', '', 'g'), '')::numeric, 1.00),
        0.10
      );
    EXCEPTION WHEN OTHERS THEN
      v_cantidad_kilos := 1.00;
    END;

    BEGIN
      v_personas_estimadas := GREATEST(
        COALESCE(NULLIF(regexp_replace(COALESCE(v_comments ->> 'personasEstimadas', v_comments ->> ' personas', v_comments ->> 'targetSamples', '0'), '[^0-9]', '', 'g'), '')::integer, 0),
        0
      );
    EXCEPTION WHEN OTHERS THEN
      v_personas_estimadas := 0;
    END;

    IF jsonb_typeof(v_comments -> 'insumosCalculados') = 'object' THEN
      v_insumos := v_comments -> 'insumosCalculados';
    END IF;

    v_vendedor_fdv := pg_catalog.btrim(COALESCE(v_comments ->> 'vendedor', v_comments ->> 'sellerName', 'FDV'));
    v_observaciones := pg_catalog.btrim(COALESCE(v_comments ->> 'observaciones', v_comments ->> 'notes', ''));

    v_seed := v_fecha::text || '|' || lower(v_cliente_nombre) || '|' || v_turno || '|' || lower(v_producto_resumen) || '|' || p_survey_id::text;
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_seed, 'UTF8')), 'hex');

    SELECT c.id INTO v_target_cronograma_id
    FROM public.cronograma_degustaciones c
    WHERE c.survey_origen_id = p_survey_id
    LIMIT 1;

    IF v_target_cronograma_id IS NULL THEN
      SELECT c.id INTO v_target_cronograma_id
      FROM public.cronograma_degustaciones c
      WHERE c.survey_origen_id IS NULL
        AND c.fecha = v_fecha
        AND c.turno = v_turno
        AND lower(pg_catalog.btrim(COALESCE(NULLIF(c.cliente_codigo, ''), c.cliente_nombre))) =
            lower(pg_catalog.btrim(COALESCE(NULLIF(v_cliente_codigo, ''), v_cliente_nombre)))
        AND c.estado NOT IN ('RECHAZADA', 'CANCELADA', 'NO_AUTORIZADA')
      LIMIT 1;
    END IF;

    IF v_target_cronograma_id IS NOT NULL THEN
      UPDATE public.cronograma_degustaciones
      SET
        survey_origen_id = p_survey_id,
        fecha = v_fecha,
        hora_inicio = v_hora_inicio,
        hora_fin = v_hora_fin,
        turno = v_turno,
        cliente_nombre = v_cliente_nombre,
        cliente_codigo = v_cliente_codigo,
        zona_direccion = v_zona_direccion,
        producto_resumen = v_producto_resumen,
        productos = v_productos,
        cantidad_kilos = v_cantidad_kilos,
        personas_estimadas = v_personas_estimadas,
        insumos_calculados = CASE WHEN v_insumos <> '{}'::jsonb THEN v_insumos ELSE insumos_calculados END,
        vendedor_fdv = v_vendedor_fdv,
        observaciones = v_observaciones,
        promotora_id = p_promotora_id,
        promotora_nombre = v_promotora_nombre,
        promotora_email = v_promotora_email,
        estado = CASE WHEN estado IN ('EN_CURSO', 'COMPLETADA') THEN estado ELSE 'APROBADA' END,
        aprobado_por = v_aprobador,
        fecha_aprobacion = COALESCE(fecha_aprobacion, NOW()),
        en_historial = (v_fecha < public.fn_hoy_caracas()),
        updated_at = NOW()
      WHERE id = v_target_cronograma_id;
    ELSE
      INSERT INTO public.cronograma_degustaciones (
        survey_origen_id,
        idempotency_hash,
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
        insumos_calculados,
        vendedor_fdv,
        promotora_sugerida,
        promotora_id,
        promotora_nombre,
        promotora_email,
        observaciones,
        estado,
        aprobado_por,
        fecha_aprobacion,
        en_historial
      ) VALUES (
        p_survey_id,
        v_hash,
        v_fecha,
        v_hora_inicio,
        v_hora_fin,
        v_turno,
        v_cliente_nombre,
        v_cliente_codigo,
        v_zona_direccion,
        v_producto_resumen,
        v_productos,
        v_cantidad_kilos,
        v_personas_estimadas,
        v_insumos,
        v_vendedor_fdv,
        v_promotora_nombre,
        p_promotora_id,
        v_promotora_nombre,
        v_promotora_email,
        v_observaciones,
        'APROBADA',
        v_aprobador,
        NOW(),
        (v_fecha < public.fn_hoy_caracas())
      )
      ON CONFLICT (survey_origen_id) DO UPDATE SET
        promotora_id = EXCLUDED.promotora_id,
        promotora_nombre = EXCLUDED.promotora_nombre,
        promotora_email = EXCLUDED.promotora_email,
        estado = CASE
          WHEN public.cronograma_degustaciones.estado IN ('EN_CURSO', 'COMPLETADA')
            THEN public.cronograma_degustaciones.estado
          ELSE 'APROBADA'
        END,
        aprobado_por = EXCLUDED.aprobado_por,
        fecha_aprobacion = COALESCE(public.cronograma_degustaciones.fecha_aprobacion, NOW()),
        en_historial = EXCLUDED.en_historial,
        updated_at = NOW()
      RETURNING id INTO v_target_cronograma_id;
    END IF;

  -- =========================================================================
  -- RAMA B: Fila existente en `public.cronograma_degustaciones`
  -- =========================================================================
  ELSE
    SELECT *
    INTO v_cronograma
    FROM public.cronograma_degustaciones c
    WHERE c.id = p_cronograma_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La fila de cronograma (%) no existe.', p_cronograma_id
        USING ERRCODE = 'P0002';
    END IF;

    IF v_cronograma.fecha < public.fn_hoy_caracas() AND NOT (SELECT private.is_strict_admin()) THEN
      RAISE EXCEPTION 'FECHA VENCIDA EN CARACAS: La degustación del % ya pasó a Historial.', v_cronograma.fecha
        USING ERRCODE = '23514';
    END IF;

    IF v_cronograma.survey_origen_id IS NOT NULL THEN
      UPDATE public.surveys s
      SET
        comments = (
          CASE
            WHEN s.comments IS NOT NULL AND pg_catalog.btrim(s.comments::text) LIKE '{%'
              THEN (s.comments::text)::jsonb
            ELSE '{}'::jsonb
          END || jsonb_build_object(
            'estado', 'APROBADA',
            'status', 'aprobada',
            'promotoraAsignada', v_promotora_nombre,
            'promoter', v_promotora_nombre,
            'promotoraId', p_promotora_id::text,
            'promotoraEmail', v_promotora_email,
            'aprobadoPor', v_aprobador,
            'leido_trade', true
          )
        )::text,
        promoter = v_promotora_nombre,
        leido_trade = TRUE
      WHERE s.id = v_cronograma.survey_origen_id;
    END IF;

    UPDATE public.cronograma_degustaciones
    SET
      promotora_id = p_promotora_id,
      promotora_nombre = v_promotora_nombre,
      promotora_email = v_promotora_email,
      estado = CASE WHEN estado IN ('EN_CURSO', 'COMPLETADA') THEN estado ELSE 'APROBADA' END,
      aprobado_por = COALESCE(aprobado_por, v_aprobador),
      fecha_aprobacion = COALESCE(fecha_aprobacion, NOW()),
      en_historial = (fecha < public.fn_hoy_caracas()),
      updated_at = NOW()
    WHERE id = p_cronograma_id
    RETURNING id INTO v_target_cronograma_id;
  END IF;

  -- El trigger AFTER INSERT OR UPDATE (`trg_sync_cronograma_to_rutas_promotoras`) ya proyecta
  -- en `public.rutas_promotoras` con ON CONFLICT (cronograma_id) DO UPDATE; verificamos y retornamos.
  SELECT *
  INTO v_ruta
  FROM public.rutas_promotoras r
  WHERE r.cronograma_id = v_target_cronograma_id;

  RETURN jsonb_build_object(
    'ok', true,
    'cronograma_id', v_target_cronograma_id,
    'ruta_id', v_ruta.id,
    'promotora_id', v_ruta.promotora_id,
    'promotora_nombre', v_ruta.promotora_nombre,
    'promotora_email', v_ruta.promotora_email,
    'estado_ruta', v_ruta.estado_ruta,
    'ruta', to_jsonb(v_ruta)
  );
END;
$$;

-- =============================================================================
-- 7. RPC TRANSACCIONAL ATÓMICA: `public.rpc_no_autorizar_degustacion_trade`
--    Marca explícitamente una solicitud como 'NO_AUTORIZADA', la envía a la
--    Pestaña de Historial y retira cualquier proyección en `rutas_promotoras`.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_no_autorizar_degustacion_trade(
  p_survey_id UUID DEFAULT NULL,
  p_cronograma_id UUID DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actor TEXT;
  v_motivo_limpio TEXT := COALESCE(
    NULLIF(pg_catalog.btrim(COALESCE(p_motivo, '')), ''),
    'Marcada como No Autorizada por Coordinación de Trade Marketing'
  );
  v_affected_cronograma_id UUID := NULL;
BEGIN
  IF NOT (SELECT private.is_coordinator_or_admin()) THEN
    RAISE EXCEPTION 'ACCESO DENEGADO: Solo Coordinación, Gerencia o Admin pueden marcar degustaciones como No Autorizadas.'
      USING ERRCODE = '42501';
  END IF;

  IF p_survey_id IS NULL AND p_cronograma_id IS NULL THEN
    RAISE EXCEPTION 'Debe indicar p_survey_id o p_cronograma_id.'
      USING ERRCODE = '22023';
  END IF;

  v_actor := COALESCE(
    NULLIF((SELECT private.current_jwt_email_normalized()), ''),
    'Coordinadora de Trade Marketing'
  );

  IF p_survey_id IS NOT NULL THEN
    UPDATE public.surveys s
    SET
      comments = (
        CASE
          WHEN s.comments IS NOT NULL AND pg_catalog.btrim(s.comments::text) LIKE '{%'
            THEN (s.comments::text)::jsonb
          ELSE '{}'::jsonb
        END || jsonb_build_object(
          'estado', 'NO_AUTORIZADA',
          'status', 'no_autorizada',
          'noAutorizadaEnTradeAt', to_jsonb(NOW()) #>> '{}',
          'rechazadoEnTradeAt', to_jsonb(NOW()) #>> '{}',
          'motivoRechazo', v_motivo_limpio,
          'resueltoPor', v_actor,
          'leido_trade', true
        )
      )::text,
      leido_trade = TRUE,
      en_historial = TRUE,
      archivado_en = COALESCE(s.archivado_en, NOW()),
      motivo_archivo = 'NO_AUTORIZADA'
    WHERE s.id = p_survey_id;

    UPDATE public.cronograma_degustaciones c
    SET
      estado = 'NO_AUTORIZADA',
      rechazado_por = v_actor,
      fecha_rechazo = NOW(),
      motivo_rechazo = v_motivo_limpio,
      en_historial = TRUE,
      archivado_en = COALESCE(c.archivado_en, NOW()),
      motivo_archivo = 'NO_AUTORIZADA',
      updated_at = NOW()
    WHERE c.survey_origen_id = p_survey_id
    RETURNING c.id INTO v_affected_cronograma_id;
  END IF;

  IF p_cronograma_id IS NOT NULL THEN
    UPDATE public.cronograma_degustaciones c
    SET
      estado = 'NO_AUTORIZADA',
      rechazado_por = v_actor,
      fecha_rechazo = NOW(),
      motivo_rechazo = v_motivo_limpio,
      en_historial = TRUE,
      archivado_en = COALESCE(c.archivado_en, NOW()),
      motivo_archivo = 'NO_AUTORIZADA',
      updated_at = NOW()
    WHERE c.id = p_cronograma_id
    RETURNING c.id INTO v_affected_cronograma_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'estado', 'NO_AUTORIZADA',
    'cronograma_id', v_affected_cronograma_id
  );
END;
$$;

-- Actualizar `retirar_degustacion_de_ruta` para aceptar también `'NO_AUTORIZADA'`
CREATE OR REPLACE FUNCTION public.retirar_degustacion_de_ruta(
  p_survey_id UUID DEFAULT NULL,
  p_cronograma_id UUID DEFAULT NULL,
  p_nuevo_estado TEXT DEFAULT 'NO_AUTORIZADA',
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_estado_limpio TEXT := upper(pg_catalog.btrim(COALESCE(p_nuevo_estado, 'NO_AUTORIZADA')));
  v_rechazador TEXT;
  v_affected_cronograma_id UUID := NULL;
BEGIN
  IF NOT (SELECT private.is_coordinator_or_admin()) THEN
    RAISE EXCEPTION 'ACCESO DENEGADO: Solo Coordinadora o Admin pueden cancelar o marcar No Autorizada.'
      USING ERRCODE = '42501';
  END IF;

  IF v_estado_limpio NOT IN ('NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA') THEN
    RAISE EXCEPTION 'El estado de retiro debe ser NO_AUTORIZADA, RECHAZADA o CANCELADA.'
      USING ERRCODE = '22023';
  END IF;

  IF v_estado_limpio = 'NO_AUTORIZADA' THEN
    RETURN public.rpc_no_autorizar_degustacion_trade(p_survey_id, p_cronograma_id, p_motivo);
  END IF;

  v_rechazador := COALESCE(
    NULLIF((SELECT private.current_jwt_email_normalized()), ''),
    'Coordinadora de Trade Marketing'
  );

  IF p_survey_id IS NOT NULL THEN
    UPDATE public.surveys s
    SET
      comments = (
        CASE
          WHEN s.comments IS NOT NULL AND pg_catalog.btrim(s.comments::text) LIKE '{%'
            THEN (s.comments::text)::jsonb
          ELSE '{}'::jsonb
        END || jsonb_build_object(
          'estado', v_estado_limpio,
          'status', lower(v_estado_limpio),
          'rechazadoEnTradeAt', to_jsonb(NOW()) #>> '{}',
          'motivoRechazo', COALESCE(p_motivo, ''),
          'leido_trade', true
        )
      )::text,
      leido_trade = TRUE,
      en_historial = TRUE,
      archivado_en = COALESCE(s.archivado_en, NOW()),
      motivo_archivo = v_estado_limpio
    WHERE s.id = p_survey_id;

    UPDATE public.cronograma_degustaciones c
    SET
      estado = v_estado_limpio,
      rechazado_por = v_rechazador,
      fecha_rechazo = NOW(),
      motivo_rechazo = COALESCE(p_motivo, c.motivo_rechazo),
      en_historial = TRUE,
      archivado_en = COALESCE(c.archivado_en, NOW()),
      motivo_archivo = v_estado_limpio,
      updated_at = NOW()
    WHERE c.survey_origen_id = p_survey_id
    RETURNING c.id INTO v_affected_cronograma_id;
  END IF;

  IF p_cronograma_id IS NOT NULL THEN
    UPDATE public.cronograma_degustaciones c
    SET
      estado = v_estado_limpio,
      rechazado_por = v_rechazador,
      fecha_rechazo = NOW(),
      motivo_rechazo = COALESCE(p_motivo, c.motivo_rechazo),
      en_historial = TRUE,
      archivado_en = COALESCE(c.archivado_en, NOW()),
      motivo_archivo = v_estado_limpio,
      updated_at = NOW()
    WHERE c.id = p_cronograma_id
    RETURNING c.id INTO v_affected_cronograma_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'estado', v_estado_limpio,
    'cronograma_id', v_affected_cronograma_id
  );
END;
$$;

-- Actualizar `registrar_avance_ruta_promotora` para admitir coincidencia por correo JWT o staff_id
CREATE OR REPLACE FUNCTION public.registrar_avance_ruta_promotora(
  p_ruta_id UUID,
  p_accion TEXT
)
RETURNS public.rutas_promotoras
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_accion TEXT := upper(pg_catalog.btrim(COALESCE(p_accion, '')));
  v_caller_promotora UUID := (SELECT private.current_active_promotora_id());
  v_jwt_email TEXT := (SELECT private.current_jwt_email_normalized());
  v_is_coord BOOLEAN := (SELECT private.is_coordinator_or_admin());
  v_target_estado TEXT;
  v_updated public.rutas_promotoras;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Autenticación requerida.' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_coord AND v_caller_promotora IS NULL THEN
    RAISE EXCEPTION 'Perfil de promotora no activo o correo no registrado en Pestaña de Personal.' USING ERRCODE = '42501';
  END IF;

  IF v_accion = 'CHECKIN' THEN
    v_target_estado := 'EN_CURSO';
  ELSIF v_accion = 'CHECKOUT' THEN
    v_target_estado := 'COMPLETADA';
  ELSE
    RAISE EXCEPTION 'Acción inválida (%). Use CHECKIN o CHECKOUT.', v_accion USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_ruta_id::text, 20261114));

  UPDATE public.rutas_promotoras r
  SET
    estado_ruta = CASE
      WHEN r.estado_ruta = 'COMPLETADA' THEN 'COMPLETADA'
      ELSE v_target_estado
    END,
    checkin_at = COALESCE(r.checkin_at, NOW()),
    checkout_at = CASE
      WHEN v_target_estado = 'COMPLETADA' THEN COALESCE(r.checkout_at, NOW())
      ELSE r.checkout_at
    END,
    updated_at = NOW()
  WHERE r.id = p_ruta_id
    AND (
      v_is_coord
      OR r.promotora_id = v_caller_promotora
      OR (v_jwt_email <> '' AND lower(pg_catalog.btrim(r.promotora_email)) = v_jwt_email)
    )
    AND r.estado_ruta <> 'CANCELADA'
  RETURNING * INTO v_updated;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ruta no encontrada o no pertenece a tu correo autenticado.'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_autorizar_degustacion_trade(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_no_autorizar_degustacion_trade(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_autorizar_degustacion_trade(UUID, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_no_autorizar_degustacion_trade(UUID, UUID, TEXT) TO authenticated;

-- =============================================================================
-- 8. POLÍTICAS RLS ESTRICTAS POR CORREO JWT Y ROL EN `/portal/` Y MÓDULO 2
-- =============================================================================
DO $$
BEGIN
  IF to_regclass('public.staff') IS NOT NULL THEN
    ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS staff_select_portal_self_or_coord ON public.staff;
    CREATE POLICY staff_select_portal_self_or_coord
      ON public.staff
      FOR SELECT
      TO authenticated
      USING (
        (SELECT private.is_coordinator_or_admin())
        OR auth_user_id = (SELECT auth.uid())
        OR (
          (SELECT private.current_jwt_email_normalized()) <> ''
          AND lower(pg_catalog.btrim(COALESCE(email, ''))) = (SELECT private.current_jwt_email_normalized())
        )
      );
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    ALTER TABLE public.rutas_promotoras ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS rutas_promotoras_select_rbac ON public.rutas_promotoras;
    CREATE POLICY rutas_promotoras_select_rbac
      ON public.rutas_promotoras
      FOR SELECT
      TO authenticated
      USING (
        (SELECT private.is_coordinator_or_admin())
        OR (
          (SELECT private.current_active_promotora_id()) IS NOT NULL
          AND COALESCE((SELECT private.current_app_role()), '') NOT IN ('fdv', 'vendedor', 'fuerza_ventas')
          AND estado_ruta IN ('ASIGNADA', 'EN_CURSO', 'COMPLETADA')
          AND (
            promotora_id = (SELECT private.current_active_promotora_id())
            OR (
              (SELECT private.current_jwt_email_normalized()) <> ''
              AND lower(pg_catalog.btrim(promotora_email)) = (SELECT private.current_jwt_email_normalized())
            )
          )
        )
      );

    DROP POLICY IF EXISTS rutas_promotoras_update_rbac ON public.rutas_promotoras;
    CREATE POLICY rutas_promotoras_update_rbac
      ON public.rutas_promotoras
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT private.is_coordinator_or_admin())
        OR (
          (SELECT private.current_active_promotora_id()) IS NOT NULL
          AND COALESCE((SELECT private.current_app_role()), '') NOT IN ('fdv', 'vendedor', 'fuerza_ventas')
          AND estado_ruta IN ('ASIGNADA', 'EN_CURSO')
          AND (
            promotora_id = (SELECT private.current_active_promotora_id())
            OR (
              (SELECT private.current_jwt_email_normalized()) <> ''
              AND lower(pg_catalog.btrim(promotora_email)) = (SELECT private.current_jwt_email_normalized())
            )
          )
        )
      )
      WITH CHECK (
        (SELECT private.is_coordinator_or_admin())
        OR (
          (SELECT private.current_active_promotora_id()) IS NOT NULL
          AND COALESCE((SELECT private.current_app_role()), '') NOT IN ('fdv', 'vendedor', 'fuerza_ventas')
          AND estado_ruta IN ('EN_CURSO', 'COMPLETADA')
          AND (
            promotora_id = (SELECT private.current_active_promotora_id())
            OR (
              (SELECT private.current_jwt_email_normalized()) <> ''
              AND lower(pg_catalog.btrim(promotora_email)) = (SELECT private.current_jwt_email_normalized())
            )
          )
        )
      );
  END IF;
END $$;

-- =============================================================================
-- 9. PUBLICACIÓN EN SUPABASE REALTIME (`postgres_changes`)
-- =============================================================================
DO $$
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    ALTER TABLE public.cronograma_degustaciones REPLICA IDENTITY FULL;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'cronograma_degustaciones'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.cronograma_degustaciones;
    END IF;
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    ALTER TABLE public.rutas_promotoras REPLICA IDENTITY FULL;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'rutas_promotoras'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.rutas_promotoras;
    END IF;
  END IF;

  IF to_regclass('public.surveys') IS NOT NULL THEN
    ALTER TABLE public.surveys REPLICA IDENTITY FULL;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'surveys'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.surveys;
    END IF;
  END IF;
END $$;

COMMIT;
