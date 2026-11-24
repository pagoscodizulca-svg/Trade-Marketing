-- ==============================================================================
-- MIGRACIÓN SQL 100% ADITIVA E IDEMPOTENTE
-- Normalización y Sincronización Permanente de Columnas `correo` <-> `email`
-- en `public.promotoras` + Blindaje RLS (Cero anon, Cero DDL destructivo)
--
-- Archivos espejo:
--   - supabase/migrations/20261210000100_sync_promotoras_correo_email_normalizacion.sql
--   - sql/sync_promotoras_correo_email_normalizacion.sql
--
-- Problema prevenido:
--   `public.promotoras` coexiste con las columnas `correo` (primaria ERP) y
--   `email` (esquema normalizado). Cuando una edición dejaba `email = NULL` o
--   desalineado respecto a `correo`, lecturas que consultaban `email` primero
--   podían ver un correo obsoleto o nulo. Este trigger garantiza paridad 1:1
--   case-insensitive (`LOWER(BTRIM(...))`) en cada INSERT o UPDATE.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. COLUMNAS ADITIVAS Y BACKFILL IDEMPOTENTE (`correo` <-> `email`)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    ALTER TABLE public.promotoras
      ADD COLUMN IF NOT EXISTS correo TEXT,
      ADD COLUMN IF NOT EXISTS email TEXT;

    -- Backfill no destructivo e idempotente: normaliza a minúsculas sin espacios
    -- y alinea ambas columnas cuando alguna sea NULL, vacía o distinta.
    UPDATE public.promotoras
    SET
      correo = NULLIF(LOWER(BTRIM(COALESCE(NULLIF(BTRIM(correo), ''), NULLIF(BTRIM(email), '')))), ''),
      email  = NULLIF(LOWER(BTRIM(COALESCE(NULLIF(BTRIM(correo), ''), NULLIF(BTRIM(email), '')))), ''),
      updated_at = now()
    WHERE
      correo IS DISTINCT FROM NULLIF(LOWER(BTRIM(COALESCE(NULLIF(BTRIM(correo), ''), NULLIF(BTRIM(email), '')))), '')
      OR email IS DISTINCT FROM NULLIF(LOWER(BTRIM(COALESCE(NULLIF(BTRIM(correo), ''), NULLIF(BTRIM(email), '')))), '');

    -- Índices únicos parciales case-insensitive en ambas columnas
    CREATE UNIQUE INDEX IF NOT EXISTS uq_promotoras_correo_lower
      ON public.promotoras (LOWER(BTRIM(correo)))
      WHERE correo IS NOT NULL AND BTRIM(correo) <> '';

    CREATE UNIQUE INDEX IF NOT EXISTS uq_promotoras_email_lower
      ON public.promotoras (LOWER(BTRIM(email)))
      WHERE email IS NOT NULL AND BTRIM(email) <> '';
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 2. TRIGGER DE SINCRONIZACIÓN Y NORMALIZACIÓN PERMANENTE (`correo` <-> `email`)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_trg_sync_promotoras_correo_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_correo TEXT := NULLIF(LOWER(BTRIM(COALESCE(NEW.correo, ''))), '');
  v_new_email  TEXT := NULLIF(LOWER(BTRIM(COALESCE(NEW.email, ''))), '');
  v_old_correo TEXT;
  v_old_email  TEXT;
  v_canonical  TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_canonical := COALESCE(v_new_correo, v_new_email);
  ELSE
    v_old_correo := NULLIF(LOWER(BTRIM(COALESCE(OLD.correo, ''))), '');
    v_old_email  := NULLIF(LOWER(BTRIM(COALESCE(OLD.email, ''))), '');

    IF v_new_correo IS DISTINCT FROM v_old_correo AND v_new_email IS NOT DISTINCT FROM v_old_email THEN
      -- Se actualizó `correo`: propagar automáticamente hacia `email`
      v_canonical := v_new_correo;
    ELSIF v_new_email IS DISTINCT FROM v_old_email AND v_new_correo IS NOT DISTINCT FROM v_old_correo THEN
      -- Se actualizó `email`: propagar automáticamente hacia `correo`
      v_canonical := v_new_email;
    ELSE
      -- Ambos cambiaron o ninguno cambió (asegura normalización y paridad)
      v_canonical := COALESCE(v_new_correo, v_new_email);
    END IF;
  END IF;

  NEW.correo := v_canonical;
  NEW.email  := v_canonical;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_sync_promotoras_correo_email() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_sync_promotoras_correo_email() TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_promotoras_sync_correo_email ON public.promotoras;

    CREATE TRIGGER trg_promotoras_sync_correo_email
      BEFORE INSERT OR UPDATE ON public.promotoras
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_trg_sync_promotoras_correo_email();

    -- Ratificar blindaje RLS y privilegios mínimos (Cero anon / Cero PUBLIC)
    REVOKE ALL ON TABLE public.promotoras FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promotoras TO authenticated, service_role;
    ALTER TABLE public.promotoras ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.promotoras FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
