-- =============================================================================
-- CODIZULCA C.A. - ARQUITECTURA ZERO TRUST Y SINCRONIZACIÓN REACTIVA DE RUTAS
-- Flujo Validado:
--   FDV (public.surveys type='Degustacion' en estado explícito 'APROBADA')
--     <-> Coordinadora de Promotoras (public.cronograma_degustaciones)
--     <-> Vista /portal/ruta (public.rutas_promotoras vía Supabase Realtime + RLS JWT)
--
-- Garantías de Seguridad (Zero Trust):
--   1. Prohibido el uso de cabeceras HTTP falsificables (x-promotora-id / x-codizulca-scope).
--   2. Prohibido user_metadata o auth.role(): autorización exclusiva mediante JWT
--      firmado en Supabase Auth (raw_app_meta_data / app_metadata) + vínculo físico
--      public.staff.auth_user_id.
--   3. Origen validado: imposible proyectar a rutas_promotoras una degustación FDV
--      que no se encuentre explícitamente en estado 'APROBADA' (o ejecución activa).
--   4. Aislamiento estricto por perfil:
--      - promotora: SELECT únicamente de sus propias filas activas en rutas_promotoras;
--        UPDATE restringido físicamente por trigger a check-in / check-out operativo.
--      - coordinadora / admin: gestión transaccional e idempotente de aprobaciones,
--        asignaciones, reasignaciones y supervisión global de rutas.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. COLUMNAS DE VINCULACIÓN E HIGIENE EN TABLAS PREEXISTENTES (surveys / staff)
-- =============================================================================
ALTER TABLE IF EXISTS public.surveys
  ADD COLUMN IF NOT EXISTS leido_trade BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS visto_en_trade_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE IF EXISTS public.staff
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_staff_auth_user_id'
      AND conrelid = 'public.staff'::regclass
  ) THEN
    ALTER TABLE public.staff
      ADD CONSTRAINT uq_staff_auth_user_id UNIQUE (auth_user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_staff_auth_user_id
  ON public.staff (auth_user_id);

-- Higiene automática: una vez vinculada la cuenta en auth.users (auth_user_id IS NOT NULL),
-- se elimina y bloquea cualquier clave "password" en texto plano dentro de public.staff.status.
CREATE OR REPLACE FUNCTION public.fn_sanitize_staff_plaintext_password()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status_json JSONB;
BEGIN
  IF NEW.auth_user_id IS NOT NULL
     AND NEW.status IS NOT NULL
     AND btrim(NEW.status::text) LIKE '{%' THEN
    BEGIN
      v_status_json := (NEW.status::text)::jsonb;
      IF v_status_json ? 'password' THEN
        NEW.status := (v_status_json - 'password')::text;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Si status no es JSON válido se conserva sin alterar
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sanitize_staff_plaintext_password ON public.staff;

CREATE TRIGGER trg_sanitize_staff_plaintext_password
  BEFORE INSERT OR UPDATE ON public.staff
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sanitize_staff_plaintext_password();

-- =============================================================================
-- 1. TABLAS DE PIPELINE Y RUTAS (AUTO-CONTENIDAS E IDEMPOTENTES)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.cargas_archivos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_archivo TEXT NOT NULL,
  extension TEXT NOT NULL
    CHECK (extension IN ('xlsx', 'xls', 'csv', 'pdf')),
  mime_type TEXT NOT NULL,
  tamano_bytes BIGINT NOT NULL
    CHECK (tamano_bytes > 0 AND tamano_bytes <= 15728640),
  archivo_sha256 TEXT NOT NULL,
  metodo_extraccion TEXT NOT NULL
    CHECK (metodo_extraccion IN ('TABULAR_DETERMINISTA', 'IA_ESTRUCTURADA')),
  total_filas_extraidas INTEGER NOT NULL DEFAULT 0
    CHECK (total_filas_extraidas >= 0),
  total_filas_insertadas INTEGER NOT NULL DEFAULT 0
    CHECK (total_filas_insertadas >= 0),
  total_filas_duplicadas INTEGER NOT NULL DEFAULT 0
    CHECK (total_filas_duplicadas >= 0),
  cargado_por TEXT NOT NULL,
  cargado_por_rol TEXT NOT NULL DEFAULT 'coordinadora',
  notas TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cargas_archivos_sha256
  ON public.cargas_archivos (archivo_sha256);

CREATE INDEX IF NOT EXISTS idx_cargas_archivos_created_at
  ON public.cargas_archivos (created_at DESC);

CREATE TABLE IF NOT EXISTS public.cronograma_degustaciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carga_id UUID REFERENCES public.cargas_archivos(id) ON DELETE SET NULL,
  survey_origen_id UUID UNIQUE REFERENCES public.surveys(id) ON DELETE SET NULL,
  idempotency_hash TEXT NOT NULL,

  fecha DATE NOT NULL,
  hora_inicio TEXT NOT NULL DEFAULT '09:00',
  hora_fin TEXT NOT NULL DEFAULT '13:00',
  turno TEXT NOT NULL DEFAULT 'MAÑANA'
    CHECK (turno IN ('MAÑANA', 'TARDE', 'COMPLETO')),
  cliente_nombre TEXT NOT NULL,
  cliente_codigo TEXT NOT NULL DEFAULT '',
  zona_direccion TEXT NOT NULL DEFAULT '',
  producto_resumen TEXT NOT NULL,
  productos JSONB NOT NULL DEFAULT '[]'::jsonb,
  cantidad_kilos NUMERIC(10, 2) NOT NULL DEFAULT 1.00
    CHECK (cantidad_kilos > 0),
  personas_estimadas INTEGER NOT NULL DEFAULT 0
    CHECK (personas_estimadas >= 0),
  insumos_calculados JSONB NOT NULL DEFAULT '{}'::jsonb,
  vendedor_fdv TEXT NOT NULL DEFAULT '',
  promotora_sugerida TEXT NOT NULL DEFAULT '',

  promotora_id UUID REFERENCES public.staff(id) ON DELETE RESTRICT,
  promotora_nombre TEXT DEFAULT NULL,
  promotora_email TEXT DEFAULT NULL,
  observaciones TEXT NOT NULL DEFAULT '',

  estado TEXT NOT NULL DEFAULT 'PENDIENTE_APROBACION'
    CHECK (estado IN (
      'PENDIENTE_APROBACION',
      'APROBADA',
      'RECHAZADA',
      'CANCELADA',
      'EN_CURSO',
      'COMPLETADA'
    )),
  aprobado_por TEXT DEFAULT NULL,
  fecha_aprobacion TIMESTAMPTZ DEFAULT NULL,
  rechazado_por TEXT DEFAULT NULL,
  fecha_rechazo TIMESTAMPTZ DEFAULT NULL,
  motivo_rechazo TEXT DEFAULT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_cronograma_aprobada_requiere_promotora
    CHECK (
      estado NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA')
      OR promotora_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_carga_id
  ON public.cronograma_degustaciones (carga_id);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_survey_origen_id
  ON public.cronograma_degustaciones (survey_origen_id);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_promotora_id
  ON public.cronograma_degustaciones (promotora_id);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_estado_fecha
  ON public.cronograma_degustaciones (estado, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_fecha
  ON public.cronograma_degustaciones (fecha DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cronograma_deg_idempotency_active
  ON public.cronograma_degustaciones (idempotency_hash)
  WHERE estado NOT IN ('RECHAZADA', 'CANCELADA');

-- Idempotencia adicional por Tienda + Fecha + Turno cuando está activa
CREATE UNIQUE INDEX IF NOT EXISTS idx_cronograma_deg_tienda_fecha_turno_active
  ON public.cronograma_degustaciones (
    fecha,
    turno,
    lower(btrim(COALESCE(NULLIF(cliente_codigo, ''), cliente_nombre)))
  )
  WHERE estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA');

CREATE TABLE IF NOT EXISTS public.rutas_promotoras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cronograma_id UUID NOT NULL UNIQUE
    REFERENCES public.cronograma_degustaciones(id) ON DELETE CASCADE,
  promotora_id UUID NOT NULL
    REFERENCES public.staff(id) ON DELETE RESTRICT,
  promotora_nombre TEXT NOT NULL,
  promotora_email TEXT NOT NULL DEFAULT '',

  fecha DATE NOT NULL,
  hora_inicio TEXT NOT NULL,
  hora_fin TEXT NOT NULL,
  turno TEXT NOT NULL
    CHECK (turno IN ('MAÑANA', 'TARDE', 'COMPLETO')),
  cliente_nombre TEXT NOT NULL,
  cliente_codigo TEXT NOT NULL DEFAULT '',
  zona_direccion TEXT NOT NULL DEFAULT '',
  producto_resumen TEXT NOT NULL,
  productos JSONB NOT NULL DEFAULT '[]'::jsonb,
  cantidad_kilos NUMERIC(10, 2) NOT NULL DEFAULT 1.00,
  personas_estimadas INTEGER NOT NULL DEFAULT 0,
  vendedor_fdv TEXT NOT NULL DEFAULT '',
  observaciones TEXT NOT NULL DEFAULT '',

  estado_ruta TEXT NOT NULL DEFAULT 'ASIGNADA'
    CHECK (estado_ruta IN ('ASIGNADA', 'EN_CURSO', 'COMPLETADA', 'CANCELADA')),
  checkin_at TIMESTAMPTZ DEFAULT NULL,
  checkout_at TIMESTAMPTZ DEFAULT NULL,
  aprobado_por TEXT DEFAULT NULL,
  asignado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_perfil_fecha
  ON public.rutas_promotoras (promotora_id, fecha ASC, estado_ruta);

CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_email_fecha
  ON public.rutas_promotoras (lower(promotora_email), fecha ASC);

-- =============================================================================
-- 2. ESQUEMA NO EXPUESTO `private` Y FUNCIONES HELPER CON CACHING INITPLAN
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

-- Lee el rol exclusivamente desde raw_app_meta_data (app_metadata), jamás desde user_metadata
CREATE OR REPLACE FUNCTION private.current_app_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT lower(
    btrim(
      COALESCE(
        (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
        (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
        ''
      )
    )
  );
$$;

-- Determina si el usuario autenticado posee rol de Coordinadora o Admin
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
       'gerente_admin',
       'admin'
     );
$$;

-- Resuelve el UUID de public.staff correspondiente a la promotora autenticada,
-- verificando en vivo que el registro exista, esté Activo y no sea de Merchandising.
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
      btrim(COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'staff_id', '')),
      ''
    )::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_claim_staff_id := NULL;
  END;

  -- Prioridad 1: vínculo directo public.staff.auth_user_id = auth.uid()
  SELECT s.id, s.role, s.status, s.auth_user_id
  INTO v_staff
  FROM public.staff s
  WHERE s.auth_user_id = v_uid
  LIMIT 1;

  -- Prioridad 2: claim inmutable app_metadata.staff_id (firmado por servidor)
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

  IF v_staff.status IS NOT NULL AND btrim(v_staff.status::text) LIKE '{%' THEN
    BEGIN
      v_status_json := (v_staff.status::text)::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_status_json := '{}'::jsonb;
    END;
  END IF;

  v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
  v_member_category := lower(COALESCE(v_status_json ->> 'category', ''));

  IF lower(btrim(v_member_status)) = 'inactivo' THEN
    RETURN NULL;
  END IF;

  IF v_member_category = 'merchandising'
     OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
    RETURN NULL;
  END IF;

  RETURN v_staff.id;
END;
$$;

REVOKE ALL ON FUNCTION private.current_app_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.is_coordinator_or_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.current_active_promotora_id() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_coordinator_or_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_active_promotora_id() TO authenticated;

-- =============================================================================
-- 3. TRIGGERS DE ORIGEN VALIDADO, CHOQUE HORARIO, SINCRONIZACIÓN E INMUTABILIDAD
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_validate_and_enrich_cronograma_degustacion()
RETURNS TRIGGER
LANGUAGE plpgsql
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
  NEW.idempotency_hash := lower(btrim(COALESCE(NEW.idempotency_hash, '')));

  IF NEW.idempotency_hash = '' THEN
    RAISE EXCEPTION 'El campo idempotency_hash es obligatorio para registrar la degustación.'
      USING ERRCODE = '23514';
  END IF;

  -- A. CANDADO DE ORIGEN VALIDADO (FDV <-> Promotoras):
  -- Si el registro está vinculado a una solicitud FDV (survey_origen_id), solo puede pasar
  -- a estado APROBADA / EN_CURSO / COMPLETADA si en public.surveys figura explícitamente APROBADA.
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
      IF v_survey.comments IS NOT NULL AND btrim(v_survey.comments::text) LIKE '{%' THEN
        v_survey_comments := (v_survey.comments::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_survey_comments := '{}'::jsonb;
    END;

    v_survey_estado := upper(
      btrim(
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

  -- B. VALIDACIÓN DE EXISTENCIA Y ESTATUS ACTIVO DE PROMOTORA EN public.staff
  IF NEW.promotora_id IS NOT NULL THEN
    SELECT id, name, email, role, status
    INTO v_staff
    FROM public.staff
    WHERE id = NEW.promotora_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La promotora seleccionada (%) no existe en public.staff.', NEW.promotora_id
        USING ERRCODE = '23503';
    END IF;

    BEGIN
      IF v_staff.status IS NOT NULL AND btrim(v_staff.status::text) LIKE '{%' THEN
        v_status_json := (v_staff.status::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_status_json := '{}'::jsonb;
    END;

    v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
    v_member_category := lower(COALESCE(v_status_json ->> 'category', ''));

    IF lower(btrim(v_member_status)) = 'inactivo' THEN
      RAISE EXCEPTION 'No se puede asignar la promotora "%" porque figura como Inactiva.', v_staff.name
        USING ERRCODE = '23514';
    END IF;

    IF v_member_category = 'merchandising'
       OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
      RAISE EXCEPTION 'El perfil "%" pertenece a Merchandising y no puede asignarse a ruta de degustación.', v_staff.name
        USING ERRCODE = '23514';
    END IF;

    NEW.promotora_nombre := btrim(v_staff.name);
    NEW.promotora_email := btrim(COALESCE(v_staff.email, ''));

    -- C. PREVENCIÓN DE DOBLE RESERVA / CONFLICTO DE JORNADA PARA LA MISMA PROMOTORA Y FECHA
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
  ELSE
    NEW.promotora_nombre := NULL;
    NEW.promotora_email := NULL;

    IF NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN
      RAISE EXCEPTION 'BLOQUEO DE SEGURIDAD: No se puede aprobar ni asignar a ruta sin promotora_id válida.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.estado = 'APROBADA'
     AND (TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM 'APROBADA') THEN
    NEW.fecha_aprobacion := COALESCE(NEW.fecha_aprobacion, NOW());
    NEW.aprobado_por := COALESCE(NULLIF(btrim(NEW.aprobado_por), ''), 'Coordinadora de Trade Marketing');
  END IF;

  IF NEW.estado IN ('RECHAZADA', 'CANCELADA')
     AND (TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM NEW.estado) THEN
    NEW.fecha_rechazo := COALESCE(NEW.fecha_rechazo, NOW());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_cronograma_degustacion ON public.cronograma_degustaciones;

CREATE TRIGGER trg_validate_cronograma_degustacion
  BEFORE INSERT OR UPDATE ON public.cronograma_degustaciones
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_validate_and_enrich_cronograma_degustacion();

-- Sincronización atómica hacia rutas_promotoras (DELETE + INSERT limpio en reasignaciones para Realtime)
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

DROP TRIGGER IF EXISTS trg_sync_cronograma_to_rutas_promotoras ON public.cronograma_degustaciones;

CREATE TRIGGER trg_sync_cronograma_to_rutas_promotoras
  AFTER INSERT OR UPDATE OR DELETE ON public.cronograma_degustaciones
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_cronograma_to_rutas_promotoras();

-- Blindaje de columnas en rutas_promotoras: una promotora jamás puede reasignar ni alterar datos maestros
CREATE OR REPLACE FUNCTION public.fn_guard_rutas_promotoras_immutable_cols()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := NOW();

  IF NOT (SELECT private.is_coordinator_or_admin()) THEN
    IF NEW.cronograma_id IS DISTINCT FROM OLD.cronograma_id
       OR NEW.promotora_id IS DISTINCT FROM OLD.promotora_id
       OR NEW.promotora_nombre IS DISTINCT FROM OLD.promotora_nombre
       OR NEW.promotora_email IS DISTINCT FROM OLD.promotora_email
       OR NEW.fecha IS DISTINCT FROM OLD.fecha
       OR NEW.hora_inicio IS DISTINCT FROM OLD.hora_inicio
       OR NEW.hora_fin IS DISTINCT FROM OLD.hora_fin
       OR NEW.turno IS DISTINCT FROM OLD.turno
       OR NEW.cliente_nombre IS DISTINCT FROM OLD.cliente_nombre
       OR NEW.cliente_codigo IS DISTINCT FROM OLD.cliente_codigo
       OR NEW.zona_direccion IS DISTINCT FROM OLD.zona_direccion
       OR NEW.producto_resumen IS DISTINCT FROM OLD.producto_resumen
       OR NEW.productos IS DISTINCT FROM OLD.productos
       OR NEW.cantidad_kilos IS DISTINCT FROM OLD.cantidad_kilos
       OR NEW.personas_estimadas IS DISTINCT FROM OLD.personas_estimadas
       OR NEW.vendedor_fdv IS DISTINCT FROM OLD.vendedor_fdv
       OR NEW.aprobado_por IS DISTINCT FROM OLD.aprobado_por
       OR NEW.asignado_at IS DISTINCT FROM OLD.asignado_at THEN
      RAISE EXCEPTION 'ACCESO DENEGADO: El perfil promotora no está autorizado para modificar la asignación ni los datos planificados de la ruta.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.estado_ruta NOT IN ('EN_CURSO', 'COMPLETADA') THEN
      RAISE EXCEPTION 'ACCESO DENEGADO: Transición de estado no permitida para el perfil promotora (%).', NEW.estado_ruta
        USING ERRCODE = '42501';
    END IF;

    IF OLD.estado_ruta = 'COMPLETADA' AND NEW.estado_ruta <> 'COMPLETADA' THEN
      RAISE EXCEPTION 'La ruta ya fue completada y no puede revertirse desde el portal de promotora.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.estado_ruta = 'EN_CURSO' THEN
      NEW.checkin_at := COALESCE(OLD.checkin_at, NOW());
      NEW.checkout_at := OLD.checkout_at;
    ELSIF NEW.estado_ruta = 'COMPLETADA' THEN
      NEW.checkin_at := COALESCE(OLD.checkin_at, NOW());
      NEW.checkout_at := COALESCE(OLD.checkout_at, NOW());
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_rutas_promotoras_immutable_cols ON public.rutas_promotoras;

CREATE TRIGGER trg_guard_rutas_promotoras_immutable_cols
  BEFORE UPDATE ON public.rutas_promotoras
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_rutas_promotoras_immutable_cols();

-- Propagación segura de progreso operativo (EN_CURSO / COMPLETADA) hacia cronograma_degustaciones
CREATE OR REPLACE FUNCTION public.fn_sync_ruta_progress_to_cronograma()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.estado_ruta IS DISTINCT FROM NEW.estado_ruta
     AND NEW.estado_ruta IN ('EN_CURSO', 'COMPLETADA') THEN
    UPDATE public.cronograma_degustaciones
    SET
      estado = NEW.estado_ruta,
      updated_at = NOW()
    WHERE id = NEW.cronograma_id
      AND estado <> NEW.estado_ruta
      AND estado NOT IN ('RECHAZADA', 'CANCELADA');
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sync_ruta_progress_to_cronograma() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_ruta_progress_to_cronograma ON public.rutas_promotoras;

CREATE TRIGGER trg_sync_ruta_progress_to_cronograma
  AFTER UPDATE OF estado_ruta ON public.rutas_promotoras
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_ruta_progress_to_cronograma();

-- =============================================================================
-- 4. RPCs TRANSACCIONALES E IDEMPOTENTES (ZERO TRUST)
-- =============================================================================

-- 4.A. Volcado en lote endurecido (requiere rol Coordinadora / Admin)
CREATE OR REPLACE FUNCTION public.volcar_lote_cronograma(
  p_carga JSONB,
  p_filas JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_carga_id UUID;
  v_item JSONB;
  v_recibidas INTEGER := 0;
  v_insertadas INTEGER := 0;
  v_duplicadas INTEGER := 0;
  v_inserted_id UUID;
  v_inserted_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  IF NOT (SELECT private.is_coordinator_or_admin()) THEN
    RAISE EXCEPTION 'ACCESO DENEGADO: Solo Coordinadora o Admin pueden cargar lotes al cronograma.'
      USING ERRCODE = '42501';
  END IF;

  IF p_filas IS NULL OR jsonb_typeof(p_filas) <> 'array' OR jsonb_array_length(p_filas) = 0 THEN
    RAISE EXCEPTION 'El lote de degustaciones (p_filas) debe ser un arreglo JSON no vacío.';
  END IF;

  v_recibidas := jsonb_array_length(p_filas);

  INSERT INTO public.cargas_archivos (
    nombre_archivo,
    extension,
    mime_type,
    tamano_bytes,
    archivo_sha256,
    metodo_extraccion,
    total_filas_extraidas,
    cargado_por,
    cargado_por_rol,
    notas,
    metadata
  ) VALUES (
    COALESCE(NULLIF(btrim(p_carga ->> 'nombre_archivo'), ''), 'planificacion_degustaciones.xlsx'),
    lower(COALESCE(NULLIF(btrim(p_carga ->> 'extension'), ''), 'xlsx')),
    COALESCE(NULLIF(btrim(p_carga ->> 'mime_type'), ''), 'application/octet-stream'),
    COALESCE((p_carga ->> 'tamano_bytes')::bigint, 1),
    COALESCE(NULLIF(btrim(p_carga ->> 'archivo_sha256'), ''), pg_catalog.md5(p_filas::text)),
    COALESCE(NULLIF(btrim(p_carga ->> 'metodo_extraccion'), ''), 'TABULAR_DETERMINISTA'),
    v_recibidas,
    COALESCE(NULLIF(btrim(p_carga ->> 'cargado_por'), ''), 'Coordinadora Trade Marketing'),
    (SELECT private.current_app_role()),
    COALESCE(p_carga ->> 'notas', ''),
    COALESCE(p_carga -> 'metadata', '{}'::jsonb)
  )
  RETURNING id INTO v_carga_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_filas)
  LOOP
    v_inserted_id := NULL;

    INSERT INTO public.cronograma_degustaciones (
      carga_id,
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
      observaciones,
      estado
    ) VALUES (
      v_carga_id,
      lower(btrim(v_item ->> 'idempotency_hash')),
      (v_item ->> 'fecha')::date,
      COALESCE(NULLIF(btrim(v_item ->> 'hora_inicio'), ''), '09:00'),
      COALESCE(NULLIF(btrim(v_item ->> 'hora_fin'), ''), '13:00'),
      COALESCE(NULLIF(btrim(v_item ->> 'turno'), ''), 'MAÑANA'),
      btrim(v_item ->> 'cliente_nombre'),
      COALESCE(btrim(v_item ->> 'cliente_codigo'), ''),
      COALESCE(btrim(v_item ->> 'zona_direccion'), ''),
      btrim(v_item ->> 'producto_resumen'),
      COALESCE(v_item -> 'productos', '[]'::jsonb),
      GREATEST(COALESCE((v_item ->> 'cantidad_kilos')::numeric, 1.00), 0.10),
      GREATEST(COALESCE((v_item ->> 'personas_estimadas')::integer, 0), 0),
      COALESCE(v_item -> 'insumos_calculados', '{}'::jsonb),
      COALESCE(btrim(v_item ->> 'vendedor_fdv'), ''),
      COALESCE(btrim(v_item ->> 'promotora_sugerida'), ''),
      NULLIF(btrim(COALESCE(v_item ->> 'promotora_id', '')), '')::uuid,
      COALESCE(btrim(v_item ->> 'observaciones'), ''),
      'PENDIENTE_APROBACION'
    )
    ON CONFLICT (idempotency_hash) WHERE estado NOT IN ('RECHAZADA', 'CANCELADA')
    DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NOT NULL THEN
      v_insertadas := v_insertadas + 1;
      v_inserted_ids := array_append(v_inserted_ids, v_inserted_id);
    ELSE
      v_duplicadas := v_duplicadas + 1;
    END IF;
  END LOOP;

  UPDATE public.cargas_archivos
  SET
    total_filas_insertadas = v_insertadas,
    total_filas_duplicadas = v_duplicadas
  WHERE id = v_carga_id;

  RETURN jsonb_build_object(
    'carga_id', v_carga_id,
    'total_recibidas', v_recibidas,
    'total_insertadas', v_insertadas,
    'total_duplicadas', v_duplicadas,
    'ids_insertados', to_jsonb(v_inserted_ids)
  );
END;
$$;

-- 4.B. RPC Transaccional Principal: Asignar / Reasignar Degustación Aceptada a Ruta
CREATE OR REPLACE FUNCTION public.asignar_degustacion_aceptada_a_ruta(
  p_promotora_id UUID,
  p_survey_id UUID DEFAULT NULL,
  p_cronograma_id UUID DEFAULT NULL,
  p_confirmar_aceptacion BOOLEAN DEFAULT FALSE,
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
    RAISE EXCEPTION 'ACCESO DENEGADO: Solo Coordinadora o Admin están autorizadas para asignar degustaciones a rutas.'
      USING ERRCODE = '42501';
  END IF;

  IF p_promotora_id IS NULL THEN
    RAISE EXCEPTION 'Debe indicar un identificador UUID válido de promotora (p_promotora_id).'
      USING ERRCODE = '22023';
  END IF;

  IF p_survey_id IS NULL AND p_cronograma_id IS NULL THEN
    RAISE EXCEPTION 'Debe indicar p_survey_id (solicitud FDV) o p_cronograma_id (fila de cronograma).'
      USING ERRCODE = '22023';
  END IF;

  -- Candado transaccional anti-doble clic / concurrencia sobre la misma degustación
  v_lock_key := COALESCE(p_survey_id::text, '') || '|' || COALESCE(p_cronograma_id::text, '');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 20261112));

  SELECT s.id, s.name, s.email
  INTO v_staff
  FROM public.staff s
  WHERE s.id = p_promotora_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La promotora seleccionada (%) no existe en public.staff.', p_promotora_id
      USING ERRCODE = '23503';
  END IF;

  v_aprobador := COALESCE(
    NULLIF(btrim(p_aprobado_por), ''),
    NULLIF(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')), ''),
    'Coordinadora de Trade Marketing'
  );

  -- =========================================================================
  -- RAMA A: Degustación originada en FDV (`public.surveys` con `p_survey_id`)
  -- =========================================================================
  IF p_survey_id IS NOT NULL THEN
    SELECT *
    INTO v_survey
    FROM public.surveys s
    WHERE s.id = p_survey_id
    FOR UPDATE;

    IF NOT FOUND OR COALESCE(v_survey.type, '') <> 'Degustacion' THEN
      RAISE EXCEPTION 'La solicitud FDV (%) no existe en public.surveys o no es de tipo Degustacion.', p_survey_id
        USING ERRCODE = 'P0002';
    END IF;

    BEGIN
      IF v_survey.comments IS NOT NULL AND btrim(v_survey.comments::text) LIKE '{%' THEN
        v_comments := (v_survey.comments::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_comments := '{}'::jsonb;
    END;

    v_estado_origen := upper(
      btrim(
        COALESCE(
          v_comments ->> 'estado',
          v_comments ->> 'status',
          'SOLICITADA'
        )
      )
    );

    -- Normalizar alias equivalentes del estado "aceptada" entre FDV y Promotoras
    IF v_estado_origen IN ('ACEPTADA', 'PROGRAMADA', 'CONFIRMADA', 'APROBADO') THEN
      v_estado_origen := 'APROBADA';
    END IF;

    IF v_estado_origen IN ('RECHAZADA', 'CANCELADA', 'RECHAZADO', 'CANCELADO') AND NOT p_confirmar_aceptacion THEN
      RAISE EXCEPTION 'ORIGEN INVÁLIDO: La degustación (%) fue % y no puede asignarse a una ruta.',
        p_survey_id, v_estado_origen
        USING ERRCODE = '23514';
    END IF;

    IF v_estado_origen NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA', 'REALIZADA') AND NOT p_confirmar_aceptacion THEN
      RAISE EXCEPTION 'ORIGEN NO VALIDADO: Solo las degustaciones con estatus explícito "APROBADA" entre FDV y Promotoras pueden asignarse a una ruta (estado actual: %).',
        v_estado_origen
        USING ERRCODE = '23514';
    END IF;

    -- Persistir aceptación explícita y promotora verificada en public.surveys
    v_comments := v_comments || jsonb_build_object(
      'estado', CASE WHEN v_estado_origen IN ('EN_CURSO', 'COMPLETADA', 'REALIZADA') THEN v_estado_origen ELSE 'APROBADA' END,
      'status', CASE WHEN v_estado_origen IN ('COMPLETADA', 'REALIZADA') THEN 'completada' WHEN v_estado_origen = 'EN_CURSO' THEN 'en_curso' ELSE 'aprobada' END,
      'promotoraAsignada', btrim(v_staff.name),
      'promoter', btrim(v_staff.name),
      'promotoraId', p_promotora_id::text,
      'aprobadoEnTradeAt', COALESCE(v_comments ->> 'aprobadoEnTradeAt', to_jsonb(NOW()) #>> '{}'),
      'aprobadoPor', v_aprobador,
      'leido_trade', true
    );

    UPDATE public.surveys
    SET
      comments = v_comments::text,
      leido_trade = true,
      visto_en_trade_at = COALESCE(visto_en_trade_at, NOW())
    WHERE id = p_survey_id;

    -- Extraer campos operativos normalizados para proyectar en cronograma_degustaciones
    v_raw_date := btrim(COALESCE(v_comments ->> 'date', v_comments ->> 'fecha', v_survey.date::text, ''));
    BEGIN
      IF v_raw_date ~ '^\d{4}-\d{2}-\d{2}' THEN
        v_fecha := substring(v_raw_date FROM 1 FOR 10)::date;
      ELSIF v_raw_date ~ '^\d{2}[/-]\d{2}[/-]\d{4}' THEN
        v_fecha := to_date(substring(v_raw_date FROM 1 FOR 10), 'DD-MM-YYYY');
      ELSE
        v_fecha := CURRENT_DATE;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fecha := CURRENT_DATE;
    END;

    v_turno := upper(btrim(COALESCE(v_comments ->> 'turno', v_comments ->> 'shift', 'MAÑANA')));
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

    v_hora_inicio := COALESCE(NULLIF(btrim(COALESCE(v_comments ->> 'horaInicio', '')), ''), v_hora_inicio);
    v_hora_fin := COALESCE(NULLIF(btrim(COALESCE(v_comments ->> 'horaFin', '')), ''), v_hora_fin);

    v_cliente_nombre := COALESCE(
      NULLIF(btrim(COALESCE(v_comments ->> 'cliente', v_comments ->> 'storeName', v_survey.store_name, '')), ''),
      'PDV Confirmado'
    );
    v_cliente_codigo := btrim(COALESCE(v_comments ->> 'clienteCodigo', v_comments ->> 'clientCode', ''));
    v_zona_direccion := btrim(COALESCE(v_comments ->> 'direccion', v_comments ->> 'ruta', v_comments ->> 'zone', ''));

    IF jsonb_typeof(v_comments -> 'products') = 'array' AND jsonb_array_length(v_comments -> 'products') > 0 THEN
      v_productos := v_comments -> 'products';
      SELECT string_agg(btrim(elem), ' + ')
      INTO v_producto_resumen
      FROM jsonb_array_elements_text(v_productos) AS elem
      WHERE btrim(elem) <> '';
    ELSIF jsonb_typeof(v_comments -> 'productos') = 'array' AND jsonb_array_length(v_comments -> 'productos') > 0 THEN
      v_productos := v_comments -> 'productos';
      SELECT string_agg(btrim(elem), ' + ')
      INTO v_producto_resumen
      FROM jsonb_array_elements_text(v_productos) AS elem
      WHERE btrim(elem) <> '';
    END IF;

    v_producto_resumen := COALESCE(
      NULLIF(btrim(COALESCE(v_producto_resumen, v_comments ->> 'product', v_comments ->> 'producto', '')), ''),
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
        COALESCE(NULLIF(regexp_replace(COALESCE(v_comments ->> 'personasEstimadas', v_comments ->> 'targetSamples', '0'), '[^0-9]', '', 'g'), '')::integer, 0),
        0
      );
    EXCEPTION WHEN OTHERS THEN
      v_personas_estimadas := 0;
    END;

    IF jsonb_typeof(v_comments -> 'insumosCalculados') = 'object' THEN
      v_insumos := v_comments -> 'insumosCalculados';
    END IF;

    v_vendedor_fdv := btrim(COALESCE(v_comments ->> 'vendedor', v_comments ->> 'sellerName', 'FDV'));
    v_observaciones := btrim(COALESCE(v_comments ->> 'observaciones', v_comments ->> 'notes', ''));

    v_seed := v_fecha::text || '|' || lower(v_cliente_nombre) || '|' || v_turno || '|' || lower(v_producto_resumen) || '|' || p_survey_id::text;
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_seed, 'UTF8')), 'hex');

    -- Si ya existía en cronograma para la misma tienda+fecha+turno sin survey_origen_id, enlazar idempotentemente
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
        AND lower(btrim(COALESCE(NULLIF(c.cliente_codigo, ''), c.cliente_nombre))) =
            lower(btrim(COALESCE(NULLIF(v_cliente_codigo, ''), v_cliente_nombre)))
        AND c.estado NOT IN ('RECHAZADA', 'CANCELADA')
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
        estado = CASE WHEN estado IN ('EN_CURSO', 'COMPLETADA') THEN estado ELSE 'APROBADA' END,
        aprobado_por = v_aprobador,
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
        observaciones,
        estado,
        aprobado_por,
        fecha_aprobacion
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
        btrim(v_staff.name),
        p_promotora_id,
        v_observaciones,
        'APROBADA',
        v_aprobador,
        NOW()
      )
      ON CONFLICT (survey_origen_id) DO UPDATE SET
        promotora_id = EXCLUDED.promotora_id,
        estado = CASE
          WHEN public.cronograma_degustaciones.estado IN ('EN_CURSO', 'COMPLETADA')
            THEN public.cronograma_degustaciones.estado
          ELSE 'APROBADA'
        END,
        aprobado_por = EXCLUDED.aprobado_por,
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

    IF v_cronograma.estado NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') AND NOT p_confirmar_aceptacion THEN
      RAISE EXCEPTION 'ORIGEN NO VALIDADO: La degustación (%) está en estado "%" y debe ser aprobada explícitamente antes de asignarse a una ruta.',
        p_cronograma_id, v_cronograma.estado
        USING ERRCODE = '23514';
    END IF;

    IF v_cronograma.survey_origen_id IS NOT NULL THEN
      UPDATE public.surveys s
      SET
        comments = (
          CASE
            WHEN s.comments IS NOT NULL AND btrim(s.comments::text) LIKE '{%'
              THEN (s.comments::text)::jsonb
            ELSE '{}'::jsonb
          END || jsonb_build_object(
            'estado', 'APROBADA',
            'status', 'aprobada',
            'promotoraAsignada', btrim(v_staff.name),
            'promoter', btrim(v_staff.name),
            'promotoraId', p_promotora_id::text,
            'aprobadoPor', v_aprobador,
            'leido_trade', true
          )
        )::text,
        leido_trade = true
      WHERE s.id = v_cronograma.survey_origen_id;
    END IF;

    UPDATE public.cronograma_degustaciones
    SET
      promotora_id = p_promotora_id,
      estado = CASE WHEN estado IN ('EN_CURSO', 'COMPLETADA') THEN estado ELSE 'APROBADA' END,
      aprobado_por = COALESCE(aprobado_por, v_aprobador),
      updated_at = NOW()
    WHERE id = p_cronograma_id
    RETURNING id INTO v_target_cronograma_id;
  END IF;

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
    'estado_ruta', v_ruta.estado_ruta,
    'ruta', to_jsonb(v_ruta)
  );
END;
$$;

-- 4.C. RPC Transaccional: Rechazar / Cancelar y Retirar Inmediatamente de `/portal/ruta`
CREATE OR REPLACE FUNCTION public.retirar_degustacion_de_ruta(
  p_survey_id UUID DEFAULT NULL,
  p_cronograma_id UUID DEFAULT NULL,
  p_nuevo_estado TEXT DEFAULT 'CANCELADA',
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_estado_limpio TEXT := upper(btrim(COALESCE(p_nuevo_estado, 'CANCELADA')));
  v_rechazador TEXT;
  v_affected_cronograma_id UUID := NULL;
BEGIN
  IF NOT (SELECT private.is_coordinator_or_admin()) THEN
    RAISE EXCEPTION 'ACCESO DENEGADO: Solo Coordinadora o Admin pueden cancelar o rechazar degustaciones.'
      USING ERRCODE = '42501';
  END IF;

  IF v_estado_limpio NOT IN ('RECHAZADA', 'CANCELADA') THEN
    RAISE EXCEPTION 'El estado de retiro debe ser RECHAZADA o CANCELADA.'
      USING ERRCODE = '22023';
  END IF;

  v_rechazador := COALESCE(
    NULLIF(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')), ''),
    'Coordinadora de Trade Marketing'
  );

  IF p_survey_id IS NOT NULL THEN
    UPDATE public.surveys s
    SET
      comments = (
        CASE
          WHEN s.comments IS NOT NULL AND btrim(s.comments::text) LIKE '{%'
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
      leido_trade = true
    WHERE s.id = p_survey_id;

    UPDATE public.cronograma_degustaciones c
    SET
      estado = v_estado_limpio,
      rechazado_por = v_rechazador,
      fecha_rechazo = NOW(),
      motivo_rechazo = COALESCE(p_motivo, c.motivo_rechazo),
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

-- 4.D. RPC Idempotente de Avance Operativo en `/portal/ruta` (Check-in / Check-out de Promotora)
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
  v_accion TEXT := upper(btrim(COALESCE(p_accion, '')));
  v_caller_promotora UUID := (SELECT private.current_active_promotora_id());
  v_is_coord BOOLEAN := (SELECT private.is_coordinator_or_admin());
  v_target_estado TEXT;
  v_updated public.rutas_promotoras;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Autenticación requerida.' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_coord AND v_caller_promotora IS NULL THEN
    RAISE EXCEPTION 'Perfil de promotora no activo o sin autorización.' USING ERRCODE = '42501';
  END IF;

  IF v_accion = 'CHECKIN' THEN
    v_target_estado := 'EN_CURSO';
  ELSIF v_accion = 'CHECKOUT' THEN
    v_target_estado := 'COMPLETADA';
  ELSE
    RAISE EXCEPTION 'Acción inválida (%). Use CHECKIN o CHECKOUT.', v_accion USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_ruta_id::text, 20261113));

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
    AND (v_is_coord OR r.promotora_id = v_caller_promotora)
    AND r.estado_ruta <> 'CANCELADA'
  RETURNING * INTO v_updated;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ruta no encontrada o no pertenece a tu perfil autenticado.'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_updated;
END;
$$;

-- =============================================================================
-- 5. ELIMINACIÓN DE FUNCIONES/POLÍTICAS INSEGURAS Y APLICACIÓN DE RLS ESTRICTO
-- =============================================================================
DROP FUNCTION IF EXISTS public.obtener_ruta_promotora(UUID, DATE, DATE);

REVOKE ALL ON TABLE public.cargas_archivos FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.cronograma_degustaciones FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.rutas_promotoras FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cargas_archivos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cronograma_degustaciones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rutas_promotoras TO authenticated;

REVOKE ALL ON FUNCTION public.volcar_lote_cronograma(JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asignar_degustacion_aceptada_a_ruta(UUID, UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.retirar_degustacion_de_ruta(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.registrar_avance_ruta_promotora(UUID, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.volcar_lote_cronograma(JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asignar_degustacion_aceptada_a_ruta(UUID, UUID, UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retirar_degustacion_de_ruta(UUID, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_avance_ruta_promotora(UUID, TEXT) TO authenticated;

ALTER TABLE public.cargas_archivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cronograma_degustaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rutas_promotoras ENABLE ROW LEVEL SECURITY;

-- Retirar cualquier política previa permisiva o basada en cabeceras HTTP
DROP POLICY IF EXISTS cargas_archivos_trade_all ON public.cargas_archivos;
DROP POLICY IF EXISTS cronograma_degustaciones_trade_all ON public.cronograma_degustaciones;
DROP POLICY IF EXISTS rutas_promotoras_select_isolated ON public.rutas_promotoras;
DROP POLICY IF EXISTS rutas_promotoras_write_sync_and_owner ON public.rutas_promotoras;

DROP POLICY IF EXISTS cargas_archivos_select_coordinadora_admin ON public.cargas_archivos;
DROP POLICY IF EXISTS cargas_archivos_insert_coordinadora_admin ON public.cargas_archivos;
DROP POLICY IF EXISTS cargas_archivos_update_coordinadora_admin ON public.cargas_archivos;
DROP POLICY IF EXISTS cargas_archivos_delete_coordinadora_admin ON public.cargas_archivos;

DROP POLICY IF EXISTS cronograma_select_coordinadora_admin ON public.cronograma_degustaciones;
DROP POLICY IF EXISTS cronograma_insert_coordinadora_admin ON public.cronograma_degustaciones;
DROP POLICY IF EXISTS cronograma_update_coordinadora_admin ON public.cronograma_degustaciones;
DROP POLICY IF EXISTS cronograma_delete_coordinadora_admin ON public.cronograma_degustaciones;

DROP POLICY IF EXISTS rutas_promotoras_select_rbac ON public.rutas_promotoras;
DROP POLICY IF EXISTS rutas_promotoras_insert_coordinadora ON public.rutas_promotoras;
DROP POLICY IF EXISTS rutas_promotoras_update_rbac ON public.rutas_promotoras;
DROP POLICY IF EXISTS rutas_promotoras_delete_coordinadora ON public.rutas_promotoras;

-- 5.A. Políticas cargas_archivos (Exclusivo Coordinadora y Admin)
CREATE POLICY cargas_archivos_select_coordinadora_admin
  ON public.cargas_archivos
  FOR SELECT
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY cargas_archivos_insert_coordinadora_admin
  ON public.cargas_archivos
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY cargas_archivos_update_coordinadora_admin
  ON public.cargas_archivos
  FOR UPDATE
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()))
  WITH CHECK ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY cargas_archivos_delete_coordinadora_admin
  ON public.cargas_archivos
  FOR DELETE
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

-- 5.B. Políticas cronograma_degustaciones (Exclusivo Coordinadora y Admin; Promotora prohibido)
CREATE POLICY cronograma_select_coordinadora_admin
  ON public.cronograma_degustaciones
  FOR SELECT
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY cronograma_insert_coordinadora_admin
  ON public.cronograma_degustaciones
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY cronograma_update_coordinadora_admin
  ON public.cronograma_degustaciones
  FOR UPDATE
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()))
  WITH CHECK ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY cronograma_delete_coordinadora_admin
  ON public.cronograma_degustaciones
  FOR DELETE
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

-- 5.C. Políticas rutas_promotoras (Zero Trust en /portal/ruta)
CREATE POLICY rutas_promotoras_select_rbac
  ON public.rutas_promotoras
  FOR SELECT
  TO authenticated
  USING (
    (SELECT private.is_coordinator_or_admin())
    OR (
      (SELECT private.current_app_role()) = 'promotora'
      AND promotora_id = (SELECT private.current_active_promotora_id())
      AND estado_ruta IN ('ASIGNADA', 'EN_CURSO', 'COMPLETADA')
    )
  );

CREATE POLICY rutas_promotoras_insert_coordinadora
  ON public.rutas_promotoras
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT private.is_coordinator_or_admin()));

CREATE POLICY rutas_promotoras_update_rbac
  ON public.rutas_promotoras
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT private.is_coordinator_or_admin())
    OR (
      (SELECT private.current_app_role()) = 'promotora'
      AND promotora_id = (SELECT private.current_active_promotora_id())
      AND estado_ruta IN ('ASIGNADA', 'EN_CURSO')
    )
  )
  WITH CHECK (
    (SELECT private.is_coordinator_or_admin())
    OR (
      (SELECT private.current_app_role()) = 'promotora'
      AND promotora_id = (SELECT private.current_active_promotora_id())
      AND estado_ruta IN ('EN_CURSO', 'COMPLETADA')
    )
  );

CREATE POLICY rutas_promotoras_delete_coordinadora
  ON public.rutas_promotoras
  FOR DELETE
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

-- =============================================================================
-- 6. PUBLICACIÓN EN SUPABASE REALTIME (FILA COMPLETA PARA DELETE/UPDATE)
-- =============================================================================
ALTER TABLE public.cronograma_degustaciones REPLICA IDENTITY FULL;
ALTER TABLE public.rutas_promotoras REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'cronograma_degustaciones'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cronograma_degustaciones;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'rutas_promotoras'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rutas_promotoras;
  END IF;
END $$;

COMMIT;
