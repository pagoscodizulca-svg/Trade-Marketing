-- =============================================================================
-- CODIZULCA C.A. - EVIDENCIAS FOTOGRÁFICAS CONDICIONALES EN INFORMES > ASISTENCIA
-- Arquitectura Zero Trust:
--   1. Snapshot Histórico Inmutable (`perfil_aplicado`: 'FIJA' | 'EVENTUAL') en
--      `public.asistencias_jornada` con restricción UNIQUE (fecha_jornada, promotora_id).
--   2. Unicidad por Ranura (`UNIQUE (asistencia_id, slot_foto)`) en
--      `public.asistencia_evidencias` con hora oficial del servidor (`NOW()`)
--      normalizable a `America/Caracas` (`UTC-4`).
--   3. Reglas estrictas de integridad cruzada en motor PostgreSQL:
--      - Perfil 'FIJA': exclusivamente ('JORNADA_INGRESO', 'JORNADA_SALIDA'), máx. 2 fotos.
--      - Perfil 'EVENTUAL': exclusivamente ('MANANA_INGRESO', 'MANANA_SALIDA',
--        'TARDE_INGRESO', 'TARDE_SALIDA'), máx. 4 fotos.
--   4. Bucket privado (`public = false`) `asistencia-evidencias` en Supabase Storage
--      con límite de 5 MB, MIME estricto (`image/jpeg`, `image/png`, `image/webp`) y
--      políticas RLS Zero Trust (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) para acceso
--      exclusivo mediante Signed URLs de corta duración.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. ESQUEMA NO EXPUESTO `private` Y FUNCIONES AUXILIARES ZERO TRUST (IDEMPOTENTE)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

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

-- Resuelve el perfil contractual maestro ('FIJA' | 'EVENTUAL') de una promotora activa en public.staff
CREATE OR REPLACE FUNCTION private.resolve_staff_attendance_profile(p_staff_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_staff RECORD;
  v_status_json JSONB := '{}'::jsonb;
  v_member_status TEXT := 'Activo';
  v_member_category TEXT := '';
  v_role_lower TEXT := '';
BEGIN
  IF p_staff_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.id, s.name, s.role, s.status
  INTO v_staff
  FROM public.staff s
  WHERE s.id = p_staff_id
  LIMIT 1;

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
  v_member_category := lower(btrim(COALESCE(v_status_json ->> 'category', '')));
  v_role_lower := lower(btrim(COALESCE(v_staff.role, '')));

  IF lower(btrim(v_member_status)) = 'inactivo' THEN
    RETURN NULL;
  END IF;

  IF v_member_category = 'merchandising' OR v_role_lower LIKE '%merchandising%' THEN
    RETURN NULL;
  END IF;

  IF v_member_category = 'eventual' OR v_role_lower LIKE '%eventual%' THEN
    RETURN 'EVENTUAL';
  END IF;

  RETURN 'FIJA';
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_staff_attendance_profile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.resolve_staff_attendance_profile(UUID) TO authenticated;

-- =============================================================================
-- 1. TABLA CABECERA DIARIA: `public.asistencias_jornada` (SNAPSHOT INMUTABLE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.asistencias_jornada (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha_jornada DATE NOT NULL,
  promotora_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  promotora_nombre TEXT NOT NULL CHECK (char_length(btrim(promotora_nombre)) BETWEEN 1 AND 160),
  perfil_aplicado TEXT NOT NULL CHECK (perfil_aplicado IN ('FIJA', 'EVENTUAL')),
  pdv_nombre TEXT NOT NULL DEFAULT '' CHECK (char_length(pdv_nombre) <= 180),
  zona TEXT NOT NULL DEFAULT '' CHECK (char_length(zona) <= 180),
  opened_at_server TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at_server TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by_uid UUID NULL,
  CONSTRAINT uq_asistencias_jornada_fecha_promotora UNIQUE (fecha_jornada, promotora_id),
  CONSTRAINT chk_asistencias_jornada_no_future CHECK (
    fecha_jornada <= ((NOW() AT TIME ZONE 'America/Caracas')::date)
  )
);

CREATE INDEX IF NOT EXISTS idx_asistencias_jornada_fecha_promotora
  ON public.asistencias_jornada (fecha_jornada DESC, promotora_id);

CREATE INDEX IF NOT EXISTS idx_asistencias_jornada_promotora_fecha
  ON public.asistencias_jornada (promotora_id, fecha_jornada DESC);

-- Trigger que sella `perfil_aplicado` al abrir la jornada y prohíbe su mutación futura
CREATE OR REPLACE FUNCTION public.fn_lock_asistencia_perfil_aplicado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_staff_name TEXT := NULL;
  v_resolved_profile TEXT := NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT btrim(s.name)
    INTO v_staff_name
    FROM public.staff s
    WHERE s.id = NEW.promotora_id
    LIMIT 1;

    IF v_staff_name IS NULL OR v_staff_name = '' THEN
      RAISE EXCEPTION 'PROMOTORA_NOT_FOUND: La promotora indicada no existe en public.staff.'
        USING ERRCODE = '23503';
    END IF;

    v_resolved_profile := private.resolve_staff_attendance_profile(NEW.promotora_id);
    IF v_resolved_profile IS NULL THEN
      RAISE EXCEPTION 'PROMOTORA_INACTIVE_OR_INVALID_ROLE: Solo promotoras activas (FIJA o EVENTUAL) pueden abrir jornada de asistencia.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.perfil_aplicado IS NULL OR btrim(NEW.perfil_aplicado) = '' THEN
      NEW.perfil_aplicado := v_resolved_profile;
    ELSIF NEW.perfil_aplicado NOT IN ('FIJA', 'EVENTUAL') THEN
      RAISE EXCEPTION 'INVALID_PERFIL_APLICADO: El perfil aplicado debe ser FIJA o EVENTUAL.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.promotora_nombre IS NULL OR btrim(NEW.promotora_nombre) = '' THEN
      NEW.promotora_nombre := v_staff_name;
    END IF;

    NEW.opened_at_server := NOW();
    NEW.updated_at_server := NOW();
    IF NEW.opened_by_uid IS NULL THEN
      NEW.opened_by_uid := (SELECT auth.uid());
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.perfil_aplicado IS DISTINCT FROM OLD.perfil_aplicado THEN
      RAISE EXCEPTION 'IMMUTABLE_PERFIL_APLICADO: El snapshot histórico perfil_aplicado (%) no puede modificarse una vez abierta la jornada.', OLD.perfil_aplicado
        USING ERRCODE = '23514';
    END IF;

    IF NEW.promotora_id IS DISTINCT FROM OLD.promotora_id
       OR NEW.fecha_jornada IS DISTINCT FROM OLD.fecha_jornada THEN
      RAISE EXCEPTION 'IMMUTABLE_JORNADA_KEY: No se permite reasignar fecha_jornada ni promotora_id en un registro de asistencia existente.'
        USING ERRCODE = '23514';
    END IF;

    NEW.opened_at_server := OLD.opened_at_server;
    NEW.updated_at_server := NOW();
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_lock_asistencia_perfil_aplicado() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_lock_asistencia_perfil_aplicado ON public.asistencias_jornada;
CREATE TRIGGER trg_lock_asistencia_perfil_aplicado
  BEFORE INSERT OR UPDATE ON public.asistencias_jornada
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_lock_asistencia_perfil_aplicado();

-- =============================================================================
-- 2. TABLA DETALLE DE EVIDENCIAS: `public.asistencia_evidencias`
-- =============================================================================
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
  storage_path TEXT NOT NULL CHECK (
    storage_path ~ '^asistencia/[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/(JORNADA_INGRESO|JORNADA_SALIDA|MANANA_INGRESO|MANANA_SALIDA|TARDE_INGRESO|TARDE_SALIDA)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(jpg|png|webp)$'
  ),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  tamano_bytes INTEGER NOT NULL CHECK (tamano_bytes > 0 AND tamano_bytes <= 5242880),
  sha256_hex CHAR(64) NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  ancho_px INTEGER NULL CHECK (ancho_px IS NULL OR (ancho_px > 0 AND ancho_px <= 4096)),
  alto_px INTEGER NULL CHECK (alto_px IS NULL OR (alto_px > 0 AND alto_px <= 4096)),
  pdv_nombre TEXT NOT NULL DEFAULT '' CHECK (char_length(pdv_nombre) <= 180),
  lat DOUBLE PRECISION NULL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  lng DOUBLE PRECISION NULL CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)),
  gps_accuracy DOUBLE PRECISION NULL CHECK (gps_accuracy IS NULL OR (gps_accuracy >= 0 AND gps_accuracy <= 100000)),
  capturado_en_servidor TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cargado_por_uid UUID NULL,
  cargado_por_rol TEXT NOT NULL DEFAULT 'promotora'
    CHECK (cargado_por_rol IN ('promotora', 'coordinadora', 'admin')),
  CONSTRAINT uq_asistencia_evidencias_jornada_slot UNIQUE (asistencia_id, slot_foto)
);

CREATE INDEX IF NOT EXISTS idx_asistencia_evidencias_asistencia_id
  ON public.asistencia_evidencias (asistencia_id);

CREATE INDEX IF NOT EXISTS idx_asistencia_evidencias_capturado_servidor
  ON public.asistencia_evidencias (capturado_en_servidor DESC);

-- Trigger transaccional que bloquea la cabecera (`FOR UPDATE`), valida ranura vs `perfil_aplicado`,
-- aplica el tope estricto de fotos (2 para FIJA, 4 para EVENTUAL) y fuerza hora oficial del servidor (`NOW()`).
CREATE OR REPLACE FUNCTION public.fn_validate_asistencia_evidencia_slot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parent RECORD;
  v_other_count INTEGER := 0;
  v_expected_prefix TEXT := '';
BEGIN
  SELECT j.id, j.fecha_jornada, j.promotora_id, j.perfil_aplicado
  INTO v_parent
  FROM public.asistencias_jornada j
  WHERE j.id = NEW.asistencia_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASISTENCIA_JORNADA_NOT_FOUND: No existe la cabecera diaria asociada a la evidencia.'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.asistencia_id IS DISTINCT FROM OLD.asistencia_id THEN
    RAISE EXCEPTION 'IMMUTABLE_EVIDENCIA_PARENT: No se permite mover una evidencia hacia otra jornada.'
      USING ERRCODE = '23514';
  END IF;

  -- Validar correspondencia estricta de ranura y cupo según `perfil_aplicado`
  IF v_parent.perfil_aplicado = 'FIJA' THEN
    IF NEW.slot_foto NOT IN ('JORNADA_INGRESO', 'JORNADA_SALIDA') THEN
      RAISE EXCEPTION 'SLOT_NOT_ALLOWED_FOR_FIJA: El perfil FIJA solo admite JORNADA_INGRESO y JORNADA_SALIDA (recibido: %).', NEW.slot_foto
        USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*)::int
    INTO v_other_count
    FROM public.asistencia_evidencias e
    WHERE e.asistencia_id = NEW.asistencia_id
      AND e.slot_foto <> NEW.slot_foto;

    IF v_other_count >= 2 THEN
      RAISE EXCEPTION 'MAX_SLOTS_EXCEEDED_FIJA: El perfil FIJA permite un máximo estricto de 2 fotos por jornada.'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_parent.perfil_aplicado = 'EVENTUAL' THEN
    IF NEW.slot_foto NOT IN ('MANANA_INGRESO', 'MANANA_SALIDA', 'TARDE_INGRESO', 'TARDE_SALIDA') THEN
      RAISE EXCEPTION 'SLOT_NOT_ALLOWED_FOR_EVENTUAL: El perfil EVENTUAL solo admite MANANA_INGRESO, MANANA_SALIDA, TARDE_INGRESO y TARDE_SALIDA (recibido: %).', NEW.slot_foto
        USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*)::int
    INTO v_other_count
    FROM public.asistencia_evidencias e
    WHERE e.asistencia_id = NEW.asistencia_id
      AND e.slot_foto <> NEW.slot_foto;

    IF v_other_count >= 4 THEN
      RAISE EXCEPTION 'MAX_SLOTS_EXCEEDED_EVENTUAL: El perfil EVENTUAL permite un máximo estricto de 4 fotos por jornada.'
        USING ERRCODE = '23514';
    END IF;

  ELSE
    RAISE EXCEPTION 'UNKNOWN_PERFIL_APLICADO: Perfil de asistencia no reconocido (%).', v_parent.perfil_aplicado
      USING ERRCODE = '23514';
  END IF;

  -- Validar que `storage_path` coincida exactamente con la fecha_jornada, promotora_id y slot_foto del registro
  v_expected_prefix := 'asistencia/' || to_char(v_parent.fecha_jornada, 'YYYY-MM-DD') || '/' || (v_parent.promotora_id::text) || '/' || NEW.slot_foto || '_';
  IF position(v_expected_prefix IN NEW.storage_path) <> 1 THEN
    RAISE EXCEPTION 'STORAGE_PATH_MISMATCH: La ruta de almacenamiento no coincide con la estructura determinista de la jornada/promotora/slot.'
      USING ERRCODE = '23514';
  END IF;

  -- Sellar siempre la marca de tiempo oficial del servidor (ignorando reloj del dispositivo cliente)
  NEW.capturado_en_servidor := NOW();
  IF NEW.cargado_por_uid IS NULL THEN
    NEW.cargado_por_uid := (SELECT auth.uid());
  END IF;

  UPDATE public.asistencias_jornada
  SET updated_at_server = NOW(),
      pdv_nombre = CASE
        WHEN btrim(NEW.pdv_nombre) <> '' THEN btrim(NEW.pdv_nombre)
        ELSE pdv_nombre
      END
  WHERE id = NEW.asistencia_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_validate_asistencia_evidencia_slot() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_validate_asistencia_evidencia_slot ON public.asistencia_evidencias;
CREATE TRIGGER trg_validate_asistencia_evidencia_slot
  BEFORE INSERT OR UPDATE ON public.asistencia_evidencias
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_validate_asistencia_evidencia_slot();

-- =============================================================================
-- 3. ROW LEVEL SECURITY (RLS) ZERO TRUST EN TABLAS DE ASISTENCIA
-- =============================================================================
ALTER TABLE public.asistencias_jornada ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asistencia_evidencias ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.asistencias_jornada FROM PUBLIC, anon;
REVOKE ALL ON public.asistencia_evidencias FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.asistencias_jornada TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.asistencia_evidencias TO authenticated;

-- Políticas sobre `public.asistencias_jornada`
DROP POLICY IF EXISTS asistencias_jornada_select_policy ON public.asistencias_jornada;
CREATE POLICY asistencias_jornada_select_policy
  ON public.asistencias_jornada
  FOR SELECT
  TO authenticated
  USING (
    (SELECT private.is_coordinator_or_admin())
    OR promotora_id = (SELECT private.current_active_promotora_id())
  );

DROP POLICY IF EXISTS asistencias_jornada_insert_policy ON public.asistencias_jornada;
CREATE POLICY asistencias_jornada_insert_policy
  ON public.asistencias_jornada
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT private.is_coordinator_or_admin())
    OR promotora_id = (SELECT private.current_active_promotora_id())
  );

DROP POLICY IF EXISTS asistencias_jornada_update_policy ON public.asistencias_jornada;
CREATE POLICY asistencias_jornada_update_policy
  ON public.asistencias_jornada
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT private.is_coordinator_or_admin())
    OR promotora_id = (SELECT private.current_active_promotora_id())
  )
  WITH CHECK (
    (SELECT private.is_coordinator_or_admin())
    OR promotora_id = (SELECT private.current_active_promotora_id())
  );

DROP POLICY IF EXISTS asistencias_jornada_delete_policy ON public.asistencias_jornada;
CREATE POLICY asistencias_jornada_delete_policy
  ON public.asistencias_jornada
  FOR DELETE
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

-- Políticas sobre `public.asistencia_evidencias`
DROP POLICY IF EXISTS asistencia_evidencias_select_policy ON public.asistencia_evidencias;
CREATE POLICY asistencia_evidencias_select_policy
  ON public.asistencia_evidencias
  FOR SELECT
  TO authenticated
  USING (
    (SELECT private.is_coordinator_or_admin())
    OR EXISTS (
      SELECT 1
      FROM public.asistencias_jornada j
      WHERE j.id = asistencia_evidencias.asistencia_id
        AND j.promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

DROP POLICY IF EXISTS asistencia_evidencias_insert_policy ON public.asistencia_evidencias;
CREATE POLICY asistencia_evidencias_insert_policy
  ON public.asistencia_evidencias
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT private.is_coordinator_or_admin())
    OR EXISTS (
      SELECT 1
      FROM public.asistencias_jornada j
      WHERE j.id = asistencia_evidencias.asistencia_id
        AND j.promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

DROP POLICY IF EXISTS asistencia_evidencias_update_policy ON public.asistencia_evidencias;
CREATE POLICY asistencia_evidencias_update_policy
  ON public.asistencia_evidencias
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT private.is_coordinator_or_admin())
    OR EXISTS (
      SELECT 1
      FROM public.asistencias_jornada j
      WHERE j.id = asistencia_evidencias.asistencia_id
        AND j.promotora_id = (SELECT private.current_active_promotora_id())
    )
  )
  WITH CHECK (
    (SELECT private.is_coordinator_or_admin())
    OR EXISTS (
      SELECT 1
      FROM public.asistencias_jornada j
      WHERE j.id = asistencia_evidencias.asistencia_id
        AND j.promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

DROP POLICY IF EXISTS asistencia_evidencias_delete_policy ON public.asistencia_evidencias;
CREATE POLICY asistencia_evidencias_delete_policy
  ON public.asistencia_evidencias
  FOR DELETE
  TO authenticated
  USING ((SELECT private.is_coordinator_or_admin()));

-- =============================================================================
-- 4. BUCKET PRIVADO `asistencia-evidencias` EN SUPABASE STORAGE + RLS OBJECTS
-- =============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'asistencia-evidencias',
  'asistencia-evidencias',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS storage_asistencia_evidencias_select ON storage.objects;
CREATE POLICY storage_asistencia_evidencias_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'asistencia-evidencias'
    AND (storage.foldername(name))[1] = 'asistencia'
    AND (
      (SELECT private.is_coordinator_or_admin())
      OR (storage.foldername(name))[3] = ((SELECT private.current_active_promotora_id())::text)
    )
  );

DROP POLICY IF EXISTS storage_asistencia_evidencias_insert ON storage.objects;
CREATE POLICY storage_asistencia_evidencias_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'asistencia-evidencias'
    AND (storage.foldername(name))[1] = 'asistencia'
    AND (
      (SELECT private.is_coordinator_or_admin())
      OR (storage.foldername(name))[3] = ((SELECT private.current_active_promotora_id())::text)
    )
  );

DROP POLICY IF EXISTS storage_asistencia_evidencias_update ON storage.objects;
CREATE POLICY storage_asistencia_evidencias_update
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'asistencia-evidencias'
    AND (storage.foldername(name))[1] = 'asistencia'
    AND (
      (SELECT private.is_coordinator_or_admin())
      OR (storage.foldername(name))[3] = ((SELECT private.current_active_promotora_id())::text)
    )
  )
  WITH CHECK (
    bucket_id = 'asistencia-evidencias'
    AND (storage.foldername(name))[1] = 'asistencia'
    AND (
      (SELECT private.is_coordinator_or_admin())
      OR (storage.foldername(name))[3] = ((SELECT private.current_active_promotora_id())::text)
    )
  );

DROP POLICY IF EXISTS storage_asistencia_evidencias_delete ON storage.objects;
CREATE POLICY storage_asistencia_evidencias_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'asistencia-evidencias'
    AND (storage.foldername(name))[1] = 'asistencia'
    AND (
      (SELECT private.is_coordinator_or_admin())
      OR (storage.foldername(name))[3] = ((SELECT private.current_active_promotora_id())::text)
    )
  );

COMMIT;
