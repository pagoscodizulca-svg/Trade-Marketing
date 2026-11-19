-- =============================================================================
-- HITO 0 — PRIVACIDAD DE `surveys` POR AUTOR Y LECTURA DE EVIDENCIAS PARA CONTRALORÍA
-- Archivo: supabase/migrations/20261118000300_hito0_surveys_privacidad_y_lectura_contraloria.sql
--
-- Cierra:
--   N-06  Un `vendedor` podía leer todas las degustaciones de todos los vendedores.
--   N-08  El rol `contraloria` no podía consultar evidencias de asistencia (solo lectura).
--
-- Diseño:
--   * Forward-only e idempotente: NO reescribe migraciones anteriores.
--   * La autoría de `surveys` hoy es texto libre (`creatorId` = nombre del vendedor), por lo que
--     no sirve para autorizar. Se añade `autor_user_id` sellado en servidor con `auth.uid()`.
--     Las filas históricas sin autor quedan visibles solo para la torre de control
--     (`super_admin`, `coordinacion`, `supervisor`, `contraloria`).
--   * El filtro por SUCURSAL se añade en el Hito 1 (hoy `surveys` no tiene esa columna).
--     Punto de enganche marcado con `-- [HITO 1]`.
--   * Depende de `public.is_torre_control_viewer()` y `public.fn_is_survey_solicitada()`,
--     definidas en `20261118000100_fase1_lockdown_rls_rbac_and_fixes.sql`.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. AUTORÍA VERIFICABLE EN `public.surveys`
-- =============================================================================
DO $$
BEGIN
  IF to_regclass('public.surveys') IS NOT NULL THEN
    ALTER TABLE public.surveys
      ADD COLUMN IF NOT EXISTS autor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_surveys_autor_user_id
      ON public.surveys (autor_user_id)
      WHERE autor_user_id IS NOT NULL;
  END IF;
END $$;

-- Sello de autor en INSERT: el valor enviado por el cliente se IGNORA cuando hay sesión.
-- Con rol de servicio/postgres (`auth.uid() IS NULL`) se respeta el valor explícito para que
-- el backend pueda registrar solicitudes en nombre de un vendedor autenticado.
CREATE OR REPLACE FUNCTION public.fn_surveys_sellar_autor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
BEGIN
  IF v_uid IS NOT NULL THEN
    NEW.autor_user_id := v_uid;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_surveys_sellar_autor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_surveys_sellar_autor() TO authenticated, service_role;

-- Inmutabilidad de la autoría en UPDATE: solo `super_admin` o el rol de servicio pueden cambiarla.
CREATE OR REPLACE FUNCTION public.fn_surveys_proteger_autor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.autor_user_id IS DISTINCT FROM OLD.autor_user_id
     AND (SELECT auth.uid()) IS NOT NULL
     AND NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'Operación bloqueada: la autoría (autor_user_id) de una solicitud no puede modificarse.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_surveys_proteger_autor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_surveys_proteger_autor() TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('public.surveys') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_surveys_sellar_autor ON public.surveys;
    CREATE TRIGGER trg_surveys_sellar_autor
      BEFORE INSERT ON public.surveys
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_surveys_sellar_autor();

    DROP TRIGGER IF EXISTS trg_surveys_proteger_autor ON public.surveys;
    CREATE TRIGGER trg_surveys_proteger_autor
      BEFORE UPDATE ON public.surveys
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_surveys_proteger_autor();
  END IF;
END $$;

-- =============================================================================
-- 2. POLÍTICAS DE `surveys`: EL VENDEDOR SOLO VE Y EDITA LO SUYO
-- =============================================================================
DO $$
BEGIN
  IF to_regclass('public.surveys') IS NOT NULL THEN
    DROP POLICY IF EXISTS surveys_select_authenticated_roles ON public.surveys;
    CREATE POLICY surveys_select_authenticated_roles
      ON public.surveys
      FOR SELECT
      TO authenticated
      USING (
        -- Torre de control: supervisión completa (incluye historial sin autor)
        (SELECT public.is_torre_control_viewer())
        -- Vendedor: únicamente las solicitudes de degustación creadas por él mismo
        -- [HITO 1] añadir aquí: AND sucursal = (SELECT public.obtener_mi_sucursal())
        OR (
          type = 'Degustacion'
          AND autor_user_id = (SELECT auth.uid())
          AND (SELECT public.current_active_profile_role()) = 'vendedor'
        )
      );

    DROP POLICY IF EXISTS surveys_update_authenticated_trade_or_fdv ON public.surveys;
    CREATE POLICY surveys_update_authenticated_trade_or_fdv
      ON public.surveys
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT public.is_coordinadora_or_admin())
        OR (
          type = 'Degustacion'
          AND autor_user_id = (SELECT auth.uid())
          AND COALESCE(en_historial, false) = false
          AND (SELECT public.current_active_profile_role()) = 'vendedor'
          AND public.fn_is_survey_solicitada(comments)
        )
      )
      WITH CHECK (
        (SELECT public.is_coordinadora_or_admin())
        OR (
          type = 'Degustacion'
          AND autor_user_id = (SELECT auth.uid())
          AND COALESCE(en_historial, false) = false
          AND (SELECT public.current_active_profile_role()) = 'vendedor'
          AND public.fn_is_survey_solicitada(comments)
        )
      );
  END IF;
END $$;

-- =============================================================================
-- 3. CONTRALORÍA: LECTURA (SOLO SELECT) DE ASISTENCIAS Y EVIDENCIAS
--    Políticas ADITIVAS: no alteran las de promotoras ni coordinación.
-- =============================================================================
DO $$
BEGIN
  IF to_regclass('public.asistencias_jornada') IS NOT NULL THEN
    DROP POLICY IF EXISTS asistencias_jornada_select_torre_viewer ON public.asistencias_jornada;
    CREATE POLICY asistencias_jornada_select_torre_viewer
      ON public.asistencias_jornada
      FOR SELECT
      TO authenticated
      USING ((SELECT public.is_torre_control_viewer()));
  END IF;

  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    DROP POLICY IF EXISTS asistencia_evidencias_select_torre_viewer ON public.asistencia_evidencias;
    CREATE POLICY asistencia_evidencias_select_torre_viewer
      ON public.asistencia_evidencias
      FOR SELECT
      TO authenticated
      USING ((SELECT public.is_torre_control_viewer()));
  END IF;
END $$;

-- Lectura de objetos del bucket privado (el servidor usa la llave de servicio, pero este
-- respaldo cubre el caso en que el gateway opere con el token del usuario).
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS storage_asistencia_evidencias_select_torre_viewer ON storage.objects;
    CREATE POLICY storage_asistencia_evidencias_select_torre_viewer
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'asistencia-evidencias'
        AND (storage.foldername(name))[1] = 'asistencia'
        AND (SELECT public.is_torre_control_viewer())
      );
  END IF;
END $$;

COMMIT;
