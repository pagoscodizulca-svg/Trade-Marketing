-- =============================================================================
-- FASE 3 (3/4) — BLOQUEO OPTIMISTA ANTI-TOCTOU EN `public.asistencia_evidencias`
--
-- Archivo: supabase/migrations/20261126000100_fase3_asistencia_evidencias_optimistic_lock.sql
-- Destino: https://apaxdgxtaoeyswlfblgi.supabase.co (PostgreSQL 15+ / 17)
--
-- Garantías de Seguridad e Idempotencia:
--   1. 100 % idempotente y no destructivo (sin sentencias destructivas de datos).
--   2. Agrega control de versión optimista (`version`, `updated_at`) sobre
--      `public.asistencia_evidencias` para eliminar condiciones de carrera TOCTOU.
--   3. Actualiza de forma retrocompatible el CHECK de `storage_path` para admitir
--      claves inmutables con UUID y marca temporal opcional (`<slot>_<uuid>[-<ts>].<ext>`).
--   4. Crea `public.rpc_upsert_asistencia_evidencia_cas(...)` como `SECURITY INVOKER`
--      con `SET search_path = ''`, respetando íntegramente RLS y el orden de bloqueo
--      (`asistencias_jornada FOR UPDATE` -> `asistencia_evidencias FOR UPDATE`) para
--      prevenir interbloqueos (deadlocks) y sobreescrituras concurrentes.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  IF to_regclass('public.asistencia_evidencias') IS NULL THEN
    RAISE NOTICE 'public.asistencia_evidencias no existe aún en este entorno; la migración de bloqueo optimista se omite de forma segura.';
    RETURN;
  END IF;

  -- 1. Columna `version` (entero positivo, inicia en 1 para filas existentes)
  ALTER TABLE public.asistencia_evidencias
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_asistencia_evidencias_version_positive'
      AND conrelid = 'public.asistencia_evidencias'::regclass
  ) THEN
    ALTER TABLE public.asistencia_evidencias
      ADD CONSTRAINT chk_asistencia_evidencias_version_positive
      CHECK (version >= 1);
  END IF;

  -- 2. Columna `updated_at` para auditoría temporal y respaldo optimista
  ALTER TABLE public.asistencia_evidencias
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

  -- 3. Índice de soporte para comparaciones atómicas (id, version)
  CREATE INDEX IF NOT EXISTS idx_asistencia_evidencias_id_version
    ON public.asistencia_evidencias (id, version);

  -- 4. Actualizar CHECK de `storage_path` de forma retrocompatible para aceptar
  --    `<slot>_<uuid>.<ext>` (histórico) y `<slot>_<uuid>-<timestampMs>.<ext>` (Fase 3)
  FOR v_constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.asistencia_evidencias'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%storage_path%'
      AND c.conname <> 'chk_asistencia_evidencias_storage_path_immutable'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.asistencia_evidencias DROP CONSTRAINT IF EXISTS %I',
      v_constraint_name
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_asistencia_evidencias_storage_path_immutable'
      AND conrelid = 'public.asistencia_evidencias'::regclass
  ) THEN
    ALTER TABLE public.asistencia_evidencias
      ADD CONSTRAINT chk_asistencia_evidencias_storage_path_immutable
      CHECK (
        storage_path ~ '^asistencia/[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/(JORNADA_INGRESO|JORNADA_SALIDA|MANANA_INGRESO|MANANA_SALIDA|TARDE_INGRESO|TARDE_SALIDA)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(-[0-9]{10,16})?\.(jpg|png|webp)$'
      );
  END IF;
END $$;

-- =============================================================================
-- 5. FUNCIÓN RPC TRANSACCIONAL CAS (`SECURITY INVOKER` — RESPETA RLS)
--    Serializa el reemplazo sobre (asistencia_id, slot_foto) bajo el mismo orden
--    de bloqueo del trigger `fn_validate_asistencia_evidencia_slot` y aplica
--    bloqueo optimista estricto (`expected_version`).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_upsert_asistencia_evidencia_cas(
  p_asistencia_id UUID,
  p_slot_foto TEXT,
  p_storage_bucket TEXT,
  p_storage_path TEXT,
  p_mime_type TEXT,
  p_tamano_bytes INTEGER,
  p_sha256_hex TEXT,
  p_ancho_px INTEGER DEFAULT NULL,
  p_alto_px INTEGER DEFAULT NULL,
  p_pdv_nombre TEXT DEFAULT '',
  p_lat DOUBLE PRECISION DEFAULT NULL,
  p_lng DOUBLE PRECISION DEFAULT NULL,
  p_gps_accuracy DOUBLE PRECISION DEFAULT NULL,
  p_cargado_por_uid UUID DEFAULT NULL,
  p_cargado_por_rol TEXT DEFAULT 'promotora',
  p_expected_evidence_id UUID DEFAULT NULL,
  p_expected_version INTEGER DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_parent_id UUID;
  v_existing public.asistencia_evidencias%ROWTYPE;
  v_saved public.asistencia_evidencias%ROWTYPE;
  v_sucursal_udt TEXT := NULL;
BEGIN
  -- 1. Bloquear primero la cabecera diaria para mantener orden determinista con el trigger
  SELECT j.id
  INTO v_parent_id
  FROM public.asistencias_jornada j
  WHERE j.id = p_asistencia_id
  FOR UPDATE;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'ASISTENCIA_JORNADA_NOT_FOUND: La jornada indicada no existe o no es accesible.'
      USING ERRCODE = '23503';
  END IF;

  -- 2. Bloquear la fila de la ranura si ya existe
  SELECT *
  INTO v_existing
  FROM public.asistencia_evidencias e
  WHERE e.asistencia_id = p_asistencia_id
    AND e.slot_foto = p_slot_foto
  FOR UPDATE;

  SELECT udt_name
  INTO v_sucursal_udt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'asistencia_evidencias'
    AND column_name = 'sucursal'
  LIMIT 1;

  -- 3. Caso A: Alta inicial (el llamador espera que la ranura esté vacía)
  IF p_expected_version IS NULL THEN
    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'CONFLICT',
        'reason', 'SLOT_ALREADY_EXISTS',
        'current_id', v_existing.id,
        'current_version', v_existing.version
      );
    END IF;

    IF v_sucursal_udt IS NOT NULL AND p_sucursal IS NOT NULL AND pg_catalog.btrim(p_sucursal) <> '' THEN
      EXECUTE format(
        $ins$
          INSERT INTO public.asistencia_evidencias (
            asistencia_id,
            slot_foto,
            storage_bucket,
            storage_path,
            mime_type,
            tamano_bytes,
            sha256_hex,
            ancho_px,
            alto_px,
            pdv_nombre,
            lat,
            lng,
            gps_accuracy,
            sucursal,
            capturado_en_servidor,
            cargado_por_uid,
            cargado_por_rol,
            version,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::%s,
            NOW(), $15, $16, 1, NOW()
          )
          RETURNING *
        $ins$,
        CASE
          WHEN v_sucursal_udt = 'sucursal_codigo' THEN 'public.sucursal_codigo'
          ELSE 'text'
        END
      )
      INTO v_saved
      USING
        p_asistencia_id,
        p_slot_foto,
        p_storage_bucket,
        p_storage_path,
        p_mime_type,
        p_tamano_bytes,
        p_sha256_hex,
        p_ancho_px,
        p_alto_px,
        COALESCE(p_pdv_nombre, ''),
        p_lat,
        p_lng,
        p_gps_accuracy,
        p_sucursal,
        p_cargado_por_uid,
        p_cargado_por_rol;
    ELSE
      INSERT INTO public.asistencia_evidencias (
        asistencia_id,
        slot_foto,
        storage_bucket,
        storage_path,
        mime_type,
        tamano_bytes,
        sha256_hex,
        ancho_px,
        alto_px,
        pdv_nombre,
        lat,
        lng,
        gps_accuracy,
        capturado_en_servidor,
        cargado_por_uid,
        cargado_por_rol,
        version,
        updated_at
      )
      VALUES (
        p_asistencia_id,
        p_slot_foto,
        p_storage_bucket,
        p_storage_path,
        p_mime_type,
        p_tamano_bytes,
        p_sha256_hex,
        p_ancho_px,
        p_alto_px,
        COALESCE(p_pdv_nombre, ''),
        p_lat,
        p_lng,
        p_gps_accuracy,
        NOW(),
        p_cargado_por_uid,
        p_cargado_por_rol,
        1,
        NOW()
      )
      RETURNING * INTO v_saved;
    END IF;

    RETURN jsonb_build_object(
      'status', 'INSERTED',
      'evidencia', to_jsonb(v_saved),
      'previous_storage_path', NULL
    );
  END IF;

  -- 4. Caso B: Reemplazo con bloqueo optimista (`WHERE id = ... AND version = p_expected_version`)
  IF v_existing.id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'CONFLICT',
      'reason', 'ROW_NOT_FOUND',
      'current_id', NULL,
      'current_version', NULL
    );
  END IF;

  IF (p_expected_evidence_id IS NOT NULL AND v_existing.id <> p_expected_evidence_id)
     OR v_existing.version <> p_expected_version THEN
    RETURN jsonb_build_object(
      'status', 'CONFLICT',
      'reason', 'VERSION_MISMATCH',
      'current_id', v_existing.id,
      'current_version', v_existing.version
    );
  END IF;

  UPDATE public.asistencia_evidencias
  SET storage_bucket = p_storage_bucket,
      storage_path = p_storage_path,
      mime_type = p_mime_type,
      tamano_bytes = p_tamano_bytes,
      sha256_hex = p_sha256_hex,
      ancho_px = p_ancho_px,
      alto_px = p_alto_px,
      pdv_nombre = COALESCE(p_pdv_nombre, ''),
      lat = p_lat,
      lng = p_lng,
      gps_accuracy = p_gps_accuracy,
      capturado_en_servidor = NOW(),
      cargado_por_uid = p_cargado_por_uid,
      cargado_por_rol = p_cargado_por_rol,
      version = v_existing.version + 1,
      updated_at = NOW()
  WHERE id = v_existing.id
    AND version = p_expected_version
  RETURNING * INTO v_saved;

  IF v_saved.id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'CONFLICT',
      'reason', 'CONCURRENT_UPDATE',
      'current_id', v_existing.id,
      'current_version', v_existing.version
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'UPDATED',
    'evidencia', to_jsonb(v_saved),
    'previous_storage_path', v_existing.storage_path
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_upsert_asistencia_evidencia_cas(
  UUID,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  INTEGER,
  TEXT,
  INTEGER,
  INTEGER,
  TEXT,
  DOUBLE PRECISION,
  DOUBLE PRECISION,
  DOUBLE PRECISION,
  UUID,
  TEXT,
  UUID,
  INTEGER,
  TEXT
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rpc_upsert_asistencia_evidencia_cas(
  UUID,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  INTEGER,
  TEXT,
  INTEGER,
  INTEGER,
  TEXT,
  DOUBLE PRECISION,
  DOUBLE PRECISION,
  DOUBLE PRECISION,
  UUID,
  TEXT,
  UUID,
  INTEGER,
  TEXT
) TO authenticated, service_role;

COMMIT;
