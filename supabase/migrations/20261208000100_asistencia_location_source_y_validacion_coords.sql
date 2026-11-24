-- ==============================================================================
-- MIGRACIÓN ADITIVA E IDEMPOTENTE:
--   Auditoría de Origen de Ubicación (`location_source`) y Validación Estricta
--   WGS84 en `public.asistencia_evidencias` (Motor GPS en Cascada de 3 Capas).
--
-- Garantías de Producción y Seguridad:
--   1. 100% aditiva e idempotente (`IF NOT EXISTS`, cero DROP/TRUNCATE/DELETE).
--   2. Cero alteración a RLS existente (se preserva mínimo privilegio `TO authenticated`, cero `anon`).
--   3. Restricciones CHECK WGS84 declaradas con `NOT VALID` para validar toda escritura
--      nueva/actualizada sin fallar sobre registros históricos preexistentes.
-- ==============================================================================

DO $$
BEGIN
  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    ALTER TABLE public.asistencia_evidencias
      ADD COLUMN IF NOT EXISTS location_source TEXT NOT NULL DEFAULT 'gps_high';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'asistencia_evidencias_location_source_check'
        AND conrelid = 'public.asistencia_evidencias'::regclass
    ) THEN
      ALTER TABLE public.asistencia_evidencias
        ADD CONSTRAINT asistencia_evidencias_location_source_check
        CHECK (location_source IN ('gps_high', 'wifi_cell', 'ip_fallback'));
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'asistencia_evidencias_lat_wgs84_check'
        AND conrelid = 'public.asistencia_evidencias'::regclass
    ) THEN
      ALTER TABLE public.asistencia_evidencias
        ADD CONSTRAINT asistencia_evidencias_lat_wgs84_check
        CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)) NOT VALID;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'asistencia_evidencias_lng_wgs84_check'
        AND conrelid = 'public.asistencia_evidencias'::regclass
    ) THEN
      ALTER TABLE public.asistencia_evidencias
        ADD CONSTRAINT asistencia_evidencias_lng_wgs84_check
        CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)) NOT VALID;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'asistencia_evidencias_gps_accuracy_non_negative_check'
        AND conrelid = 'public.asistencia_evidencias'::regclass
    ) THEN
      ALTER TABLE public.asistencia_evidencias
        ADD CONSTRAINT asistencia_evidencias_gps_accuracy_non_negative_check
        CHECK (gps_accuracy IS NULL OR (gps_accuracy >= 0 AND gps_accuracy <= 100000)) NOT VALID;
    END IF;

    COMMENT ON COLUMN public.asistencia_evidencias.location_source IS
      'Origen auditado de captura de coordenadas: gps_high (satelital), wifi_cell (triangulación red/antenas) o ip_fallback (respaldo auditado servidor/PDV).';
  END IF;
END
$$;

-- Recargar caché de esquema de PostgREST
NOTIFY pgrst, 'reload schema';
