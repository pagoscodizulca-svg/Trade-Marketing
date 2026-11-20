-- =============================================================================
-- MIGRACIÓN: Acceso Total `super_admin` Seguro para `admin@codizulca.com`
-- Versión:   20261122000100_grant_super_admin_trade_marketing.sql
-- Propósito:
--   1. Endurecer `public.is_super_admin()` con `SECURITY DEFINER` y
--      `SET search_path = public, auth` (prevención de search_path hijacking),
--      exigiendo `auth.uid() IS NOT NULL` y verificando `public.profiles` +
--      `auth.users.raw_app_meta_data` (JAMÁS `raw_user_meta_data`).
--   2. Sincronizar de forma idempotente a `admin@codizulca.com` como `super_admin`
--      (`sucursal = 'GLOBAL'`, `is_active = true`) si ya existe en `auth.users`,
--      y dejar instalado un trigger automático en `auth.users` sin contraseñas ni
--      secretos quemados en código.
--   3. Blindar `public.profiles` contra auto-escalamiento de privilegios (OWASP A01)
--      y contra degradación/auto-bloqueo de `admin@codizulca.com`.
--   4. Garantizar RLS ACTIVO (nunca deshabilitado, cero acceso `anon`) con políticas
--      explícitas `SELECT / INSERT / UPDATE / DELETE` para `public.is_super_admin()`
--      en las 45 tablas `public.*` y los 4 buckets de `storage.objects`.
--   5. Habilitar bypass controlado de geocerca/oficina para `super_admin` en las RPCs
--      de campo (`rpc_registrar_ejecucion_ruta_promotora` y
--      `registrar_avance_ruta_promotora`) conservando intactas las reglas de operarios.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. FUNCIÓN CANÓNICA `public.is_super_admin()` ENDURECIDA
--    - `SECURITY DEFINER` + `SET search_path = public, auth`
--    - Requiere sesión autenticada real (`auth.uid() IS NOT NULL`)
--    - Fail-closed si el perfil está suspendido (`is_active = false`)
--    - JAMÁS lee `raw_user_meta_data` / `user_metadata`
-- =============================================================================
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_jwt_email TEXT := lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_role TEXT;
  v_active BOOLEAN;
  v_auth_email TEXT;
  v_auth_app_role TEXT;
  v_auth_banned TIMESTAMPTZ;
  v_auth_deleted TIMESTAMPTZ;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- 1. Validación primaria contra `public.profiles` (fuente única IAM en BD)
  SELECT p.role, p.is_active
  INTO v_role, v_active
  FROM public.profiles p
  WHERE p.id = v_uid
     OR (v_jwt_email <> '' AND lower(btrim(COALESCE(p.email, ''))) = v_jwt_email)
  ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
  LIMIT 1;

  IF FOUND THEN
    IF v_active IS DISTINCT FROM true THEN
      RETURN false;
    END IF;
    IF lower(btrim(COALESCE(v_role, ''))) = 'super_admin' THEN
      RETURN true;
    END IF;
    RETURN false;
  END IF;

  -- 2. Respaldo verificado contra `auth.users.raw_app_meta_data` (solo firmado por servidor)
  --    exclusivamente para la cuenta maestra verificada `admin@codizulca.com`.
  SELECT
    lower(btrim(COALESCE(u.email, ''))),
    lower(btrim(COALESCE(
      u.raw_app_meta_data ->> 'role',
      u.raw_app_meta_data ->> 'app_role',
      ''
    ))),
    u.banned_until,
    u.deleted_at
  INTO v_auth_email, v_auth_app_role, v_auth_banned, v_auth_deleted
  FROM auth.users u
  WHERE u.id = v_uid
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_auth_deleted IS NOT NULL OR (v_auth_banned IS NOT NULL AND v_auth_banned > now()) THEN
    RETURN false;
  END IF;

  RETURN (
    v_auth_email = 'admin@codizulca.com'
    AND v_auth_app_role = 'super_admin'
  );
END;
$$;

COMMENT ON FUNCTION public.is_super_admin() IS
  'Verifica con SECURITY DEFINER (search_path = public, auth) si auth.uid() corresponde a un super_admin activo vía public.profiles o raw_app_meta_data verificado. Nunca lee user_metadata.';

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_active_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin();
$$;

REVOKE ALL ON FUNCTION public.is_active_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_super_admin() TO authenticated, service_role;

-- =============================================================================
-- 2. SINCRONIZACIÓN SEGURA + TRIGGER AUTOMÁTICO PARA `admin@codizulca.com`
--    - CERO contraseñas quemadas; nunca crea usuarios en `auth.users`.
--    - Actualiza de inmediato si `admin@codizulca.com` ya existe en `auth.users`.
--    - Si aún no existe, otorga automáticamente `super_admin` en cuanto se cree
--      o confirme por el canal oficial de administración.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_sync_super_admin_codizulca(
  p_user_id UUID,
  p_email TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
BEGIN
  IF p_user_id IS NULL OR v_email <> 'admin@codizulca.com' THEN
    RETURN;
  END IF;

  -- Actualizar raw_app_meta_data (solo modificable en servidor/BD; jamás user_metadata)
  UPDATE auth.users
  SET
    raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', 'super_admin',
      'app_role', 'super_admin',
      'sucursal', 'GLOBAL',
      'display_name', 'Administrador General CODIZULCA',
      'must_change_password', false
    ),
    updated_at = now()
  WHERE id = p_user_id
    AND (
      COALESCE(raw_app_meta_data ->> 'role', '') IS DISTINCT FROM 'super_admin'
      OR COALESCE(raw_app_meta_data ->> 'app_role', '') IS DISTINCT FROM 'super_admin'
      OR COALESCE(raw_app_meta_data ->> 'sucursal', '') IS DISTINCT FROM 'GLOBAL'
      OR COALESCE((raw_app_meta_data ->> 'must_change_password')::boolean, false) IS DISTINCT FROM false
    );

  -- Alinear cualquier registro previo de email en public.profiles para evitar colisiones
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DELETE FROM public.profiles
    WHERE lower(btrim(COALESCE(email, ''))) = 'admin@codizulca.com'
      AND id <> p_user_id;

    INSERT INTO public.profiles (
      id,
      email,
      full_name,
      role,
      sucursal,
      is_active,
      must_change_password,
      updated_at
    )
    VALUES (
      p_user_id,
      'admin@codizulca.com',
      'Administrador General CODIZULCA',
      'super_admin',
      'GLOBAL'::public.sucursal_codigo,
      true,
      false,
      now()
    )
    ON CONFLICT (id) DO UPDATE
    SET
      email = 'admin@codizulca.com',
      full_name = COALESCE(NULLIF(btrim(public.profiles.full_name), ''), 'Administrador General CODIZULCA'),
      role = 'super_admin',
      sucursal = 'GLOBAL'::public.sucursal_codigo,
      is_active = true,
      must_change_password = false,
      updated_at = now();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sync_super_admin_codizulca(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_super_admin_codizulca(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_trg_auto_grant_super_admin_codizulca()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF lower(btrim(COALESCE(NEW.email, ''))) = 'admin@codizulca.com' THEN
    PERFORM public.fn_sync_super_admin_codizulca(NEW.id, NEW.email);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_auto_grant_super_admin_codizulca() FROM PUBLIC, anon, authenticated;

-- Sincronización inmediata si `admin@codizulca.com` ya existe en `auth.users`
DO $$
DECLARE
  v_admin RECORD;
BEGIN
  FOR v_admin IN
    SELECT u.id, u.email
    FROM auth.users u
    WHERE lower(btrim(COALESCE(u.email, ''))) = 'admin@codizulca.com'
      AND u.deleted_at IS NULL
  LOOP
    PERFORM public.fn_sync_super_admin_codizulca(v_admin.id, v_admin.email);
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Sin privilegios directos sobre auth.users durante la migración; aplique desde rol postgres/supabase_admin.';
END $$;

-- Instalar trigger automático en `auth.users` para aprovisionamiento futuro sin contraseñas quemadas
DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_auto_grant_super_admin_codizulca ON auth.users;
  CREATE TRIGGER trg_auto_grant_super_admin_codizulca
    AFTER INSERT OR UPDATE OF email, email_confirmed_at ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_auto_grant_super_admin_codizulca();
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'No se pudo adjuntar trigger en auth.users por privilegios del rol ejecutor.';
END $$;

-- =============================================================================
-- 3. BLINDAJE ANTI-ESCALAMIENTO DE PRIVILEGIOS EN `public.profiles` (OWASP A01)
--    - Ningún usuario autenticado no-superadmin puede modificar role, sucursal,
--      region_id ni is_active en public.profiles.
--    - La cuenta maestra `admin@codizulca.com` no puede ser degradada ni borrada
--      desde sesiones cliente.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_guard_profiles_self_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, auth
AS $$
DECLARE
  v_old_email TEXT := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN lower(btrim(COALESCE(OLD.email, ''))) ELSE '' END;
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF NOT (SELECT public.is_super_admin()) THEN
      RAISE EXCEPTION 'Acceso denegado: solo el Super administrador puede modificar perfiles, roles o sucursales.'
        USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE' AND (OLD.id = (SELECT auth.uid()) OR v_old_email = 'admin@codizulca.com') THEN
      IF NEW.is_active IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): la cuenta de Super administrador debe permanecer activa.'
          USING ERRCODE = 'P0001';
      END IF;
      IF lower(btrim(COALESCE(NEW.role, ''))) <> 'super_admin' THEN
        RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no se puede degradar el rol super_admin.'
          USING ERRCODE = 'P0001';
      END IF;
      IF NEW.sucursal IS DISTINCT FROM 'GLOBAL'::public.sucursal_codigo THEN
        RAISE EXCEPTION 'Operación bloqueada: el Super administrador debe mantener alcance sucursal = GLOBAL.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF TG_OP = 'DELETE' AND (OLD.id = (SELECT auth.uid()) OR v_old_email = 'admin@codizulca.com') THEN
      RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no se puede eliminar la cuenta maestra de Super administrador.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_guard_profiles_self_escalation() FROM PUBLIC, anon;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_profiles_self_escalation ON public.profiles;
    CREATE TRIGGER trg_guard_profiles_self_escalation
      BEFORE INSERT OR UPDATE OR DELETE ON public.profiles
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_guard_profiles_self_escalation();
  END IF;
END $$;

-- =============================================================================
-- 4. POLÍTICAS RLS EXPLÍCITAS `super_admin` EN LAS 45 TABLAS `public.*`
--    - RLS SIEMPRE ACTIVO (JAMÁS `DISABLE ROW LEVEL SECURITY`)
--    - CERO políticas abiertas a `anon`
--    - Conserva intactas las políticas operativas de promotoras, choferes,
--      coordinadoras, vendedores, clientes y contraloría.
-- =============================================================================
DO $$
DECLARE
  v_table TEXT;
  v_tables TEXT[] := ARRAY[
    'alertas_geocerca_auditoria',
    'api_rate_limits',
    'asistencia_evidencias',
    'asistencias_jornada',
    'cadenas_comerciales',
    'campanas_trade',
    'cargas_archivos',
    'certificados_paz_y_salvo',
    'checkins',
    'cierres_semanales_log',
    'cliente_portal_accesos',
    'clientes',
    'contraloria_conciliaciones',
    'contraloria_facturas',
    'contraloria_requisiciones',
    'cronograma_degustaciones',
    'ejecuciones_pdv_promotora',
    'entregas_degustacion',
    'historial_cortes_degustaciones',
    'incidencias_pdv',
    'inventory',
    'lotes_sincronizacion',
    'material_pop_entregas',
    'material_pop_inventario',
    'notificaciones_outbox',
    'offline_mutation_receipts',
    'perfiles_acceso',
    'presupuestos_trade',
    'prices',
    'productos',
    'profiles',
    'promotoras',
    'regiones',
    'reportes_trade',
    'rutas_promotoras',
    'sesiones_jornada',
    'solicitudes_contraloria',
    'staff',
    'supervisores',
    'surveys',
    'tarifario_costos_trade',
    'user_management_audit',
    'vendedores',
    'web_push_subscriptions',
    'zonas'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', v_table);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', v_table);

      EXECUTE format('DROP POLICY IF EXISTS super_admin_full_select ON public.%I', v_table);
      EXECUTE format(
        'CREATE POLICY super_admin_full_select ON public.%I FOR SELECT TO authenticated USING ((SELECT public.is_super_admin()))',
        v_table
      );

      EXECUTE format('DROP POLICY IF EXISTS super_admin_full_insert ON public.%I', v_table);
      EXECUTE format(
        'CREATE POLICY super_admin_full_insert ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_super_admin()))',
        v_table
      );

      EXECUTE format('DROP POLICY IF EXISTS super_admin_full_update ON public.%I', v_table);
      EXECUTE format(
        'CREATE POLICY super_admin_full_update ON public.%I FOR UPDATE TO authenticated USING ((SELECT public.is_super_admin())) WITH CHECK ((SELECT public.is_super_admin()))',
        v_table
      );

      EXECUTE format('DROP POLICY IF EXISTS super_admin_full_delete ON public.%I', v_table);
      EXECUTE format(
        'CREATE POLICY super_admin_full_delete ON public.%I FOR DELETE TO authenticated USING ((SELECT public.is_super_admin()))',
        v_table
      );
    END IF;
  END LOOP;
END $$;

-- =============================================================================
-- 5. POLÍTICAS EXPLÍCITAS DE STORAGE (`storage.objects`) PARA `super_admin`
--    - Cobertura completa `SELECT / INSERT / UPDATE / DELETE` en los 4 buckets
--      del Programa de Trade Marketing (permite lectura, carga, upsert y borrado).
--    - Estrictamente `TO authenticated` cuando `(SELECT public.is_super_admin())`.
-- =============================================================================
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS super_admin_storage_trade_select ON storage.objects;
    CREATE POLICY super_admin_storage_trade_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id IN (
          'asistencia-evidencias',
          'cadenas-logos',
          'contraloria-facturas',
          'incidencias-evidencias'
        )
        AND (SELECT public.is_super_admin())
      );

    DROP POLICY IF EXISTS super_admin_storage_trade_insert ON storage.objects;
    CREATE POLICY super_admin_storage_trade_insert
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id IN (
          'asistencia-evidencias',
          'cadenas-logos',
          'contraloria-facturas',
          'incidencias-evidencias'
        )
        AND (SELECT public.is_super_admin())
      );

    DROP POLICY IF EXISTS super_admin_storage_trade_update ON storage.objects;
    CREATE POLICY super_admin_storage_trade_update
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (
        bucket_id IN (
          'asistencia-evidencias',
          'cadenas-logos',
          'contraloria-facturas',
          'incidencias-evidencias'
        )
        AND (SELECT public.is_super_admin())
      )
      WITH CHECK (
        bucket_id IN (
          'asistencia-evidencias',
          'cadenas-logos',
          'contraloria-facturas',
          'incidencias-evidencias'
        )
        AND (SELECT public.is_super_admin())
      );

    DROP POLICY IF EXISTS super_admin_storage_trade_delete ON storage.objects;
    CREATE POLICY super_admin_storage_trade_delete
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id IN (
          'asistencia-evidencias',
          'cadenas-logos',
          'contraloria-facturas',
          'incidencias-evidencias'
        )
        AND (SELECT public.is_super_admin())
      );
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Políticas super_admin sobre storage.objects requieren propietario de storage.objects.';
END $$;

-- =============================================================================
-- 6. BYPASS CONTROLADO PARA `super_admin` EN RPCs DE CAMPO (`/portal`)
--    - Permite a `admin@codizulca.com` auditar y operar cualquier ruta de
--      cualquier sede sin requerir fila en `staff` ni estar físicamente dentro
--      del radio GPS de la geocerca cuando actúa en Modo Supervisión Global.
--    - Conserva al 100% las validaciones de propiedad, sucursal y geocerca
--      para promotoras y operarios estándar.
-- =============================================================================
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
  v_is_super_admin BOOLEAN := (SELECT public.is_super_admin());
  v_caller_promotora UUID := (SELECT private.current_active_promotora_id());
  v_jwt_email TEXT := (SELECT private.current_jwt_email_normalized());
  v_is_coord BOOLEAN := (SELECT private.is_coordinator_or_admin());
  v_target_estado TEXT;
  v_updated public.rutas_promotoras;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Autenticación requerida.' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super_admin AND NOT v_is_coord AND v_caller_promotora IS NULL THEN
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
      v_is_super_admin
      OR v_is_coord
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

REVOKE ALL ON FUNCTION public.registrar_avance_ruta_promotora(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_avance_ruta_promotora(UUID, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_is_super_admin BOOLEAN := (SELECT public.is_super_admin());
  v_promotora_id UUID := (SELECT private.current_active_promotora_id());
  v_is_coord BOOLEAN := (SELECT public.is_coordinadora_or_admin());
  v_super_admin_bypass BOOLEAN := v_is_super_admin AND COALESCE((p_payload ->> 'super_admin_bypass')::boolean, false);
  v_ruta_id UUID;
  v_accion TEXT := upper(btrim(COALESCE(p_payload ->> 'accion', '')));
  v_submission_id TEXT := NULLIF(btrim(COALESCE(p_payload ->> 'client_submission_id', '')), '');
  v_lat DOUBLE PRECISION := (p_payload ->> 'lat')::double precision;
  v_lng DOUBLE PRECISION := (p_payload ->> 'lng')::double precision;
  v_acc DOUBLE PRECISION := (p_payload ->> 'accuracy_m')::double precision;
  v_motivo_geocerca TEXT := btrim(COALESCE(p_payload ->> 'motivo_fuera_geocerca', ''));
  v_ruta public.rutas_promotoras;
  v_cliente RECORD;
  v_cliente_found BOOLEAN := false;
  v_pdv_lat DOUBLE PRECISION := NULL;
  v_pdv_lng DOUBLE PRECISION := NULL;
  v_radio_m INTEGER := 150;
  v_distancia_m DOUBLE PRECISION := NULL;
  v_dentro_geocerca BOOLEAN := NULL;
  v_alerta_registrada BOOLEAN := false;
  v_ejec_json JSONB := p_payload -> 'ejecucion';
  v_ejec_row public.ejecuciones_pdv_promotora;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: Se requiere sesión autenticada para registrar avance en ruta.'
      USING ERRCODE = '42501';
  END IF;

  IF v_accion NOT IN ('CHECKIN', 'CHECKOUT') THEN
    RAISE EXCEPTION 'INVALID_ACTION: La acción debe ser CHECKIN o CHECKOUT.'
      USING ERRCODE = '22023';
  END IF;

  v_ruta_id := (p_payload ->> 'ruta_id')::uuid;
  IF v_ruta_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_RUTA_ID: Identificador de ruta requerido.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ruta
  FROM public.rutas_promotoras
  WHERE id = v_ruta_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUTA_NOT_FOUND: La ruta solicitada no existe.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_is_super_admin AND NOT public.tiene_acceso_sucursal(v_ruta.sucursal) THEN
    RAISE EXCEPTION 'FORBIDDEN_BRANCH: No tienes acceso a rutas de otra sucursal.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super_admin AND NOT v_is_coord AND (v_promotora_id IS NULL OR v_ruta.promotora_id <> v_promotora_id) THEN
    RAISE EXCEPTION 'FORBIDDEN_OWNER: Solo la promotora titular o Coordinación puede actualizar esta ruta.'
      USING ERRCODE = '42501';
  END IF;

  IF v_ruta.estado_ruta = 'CANCELADA' THEN
    RAISE EXCEPTION 'CANCELLED_ROUTE: No se puede operar sobre una ruta cancelada.'
      USING ERRCODE = '23514';
  END IF;

  SELECT c.id, c.latitud, c.longitud, COALESCE(c.radio_geocerca_m, 150) AS radio_geocerca_m
  INTO v_cliente
  FROM public.clientes c
  WHERE (
      NULLIF(btrim(v_ruta.cliente_codigo), '') IS NOT NULL
      AND upper(btrim(c.codigo_cliente)) = upper(btrim(v_ruta.cliente_codigo))
    )
    OR lower(btrim(c.nombre_comercial)) = lower(btrim(v_ruta.cliente_nombre))
  ORDER BY
    CASE
      WHEN NULLIF(btrim(v_ruta.cliente_codigo), '') IS NOT NULL
           AND upper(btrim(c.codigo_cliente)) = upper(btrim(v_ruta.cliente_codigo))
      THEN 0
      ELSE 1
    END
  LIMIT 1;

  IF FOUND THEN
    v_cliente_found := true;
    v_pdv_lat := v_cliente.latitud::double precision;
    v_pdv_lng := v_cliente.longitud::double precision;
    v_radio_m := COALESCE(v_cliente.radio_geocerca_m, 150);
  END IF;

  -- Cuando super_admin opera en modo auditoría de oficina (`super_admin_bypass = true`),
  -- se omite el disparo de alerta de geocerca de campo sin perder trazabilidad de la acción.
  IF NOT v_super_admin_bypass
     AND v_lat IS NOT NULL
     AND v_lng IS NOT NULL
     AND v_pdv_lat IS NOT NULL
     AND v_pdv_lng IS NOT NULL THEN
    v_distancia_m := public.fn_haversine_metros(v_lat, v_lng, v_pdv_lat, v_pdv_lng);
    IF v_distancia_m IS NOT NULL THEN
      v_dentro_geocerca := (v_distancia_m <= v_radio_m);
      IF NOT v_dentro_geocerca THEN
        INSERT INTO public.alertas_geocerca_auditoria (
          ruta_id,
          promotora_id,
          promotora_nombre,
          cliente_nombre,
          accion,
          lat_capturada,
          lng_capturada,
          pdv_lat,
          pdv_lng,
          distancia_m,
          radio_permitido_m,
          motivo,
          client_submission_id,
          sucursal
        )
        VALUES (
          v_ruta.id,
          v_ruta.promotora_id,
          v_ruta.promotora_nombre,
          v_ruta.cliente_nombre,
          v_accion,
          v_lat,
          v_lng,
          v_pdv_lat,
          v_pdv_lng,
          v_distancia_m,
          v_radio_m,
          COALESCE(NULLIF(v_motivo_geocerca, ''), 'Marcaje fuera de geocerca auditado automáticamente'),
          CASE WHEN v_submission_id IS NOT NULL THEN v_submission_id || ':' || v_accion ELSE NULL END,
          v_ruta.sucursal
        )
        ON CONFLICT (client_submission_id) DO NOTHING;
        v_alerta_registrada := true;
      END IF;
    END IF;
  END IF;

  IF v_accion = 'CHECKIN' THEN
    UPDATE public.rutas_promotoras
    SET
      estado_ruta = CASE WHEN estado_ruta = 'COMPLETADA' THEN 'COMPLETADA' ELSE 'EN_CURSO' END,
      checkin_at = COALESCE(checkin_at, v_now),
      checkin_lat = COALESCE(v_lat, checkin_lat),
      checkin_lng = COALESCE(v_lng, checkin_lng),
      checkin_accuracy_m = COALESCE(v_acc, checkin_accuracy_m),
      checkin_distancia_m = COALESCE(v_distancia_m, checkin_distancia_m),
      checkin_dentro_geocerca = COALESCE(v_dentro_geocerca, checkin_dentro_geocerca),
      pdv_lat_referencia = COALESCE(v_pdv_lat, pdv_lat_referencia),
      pdv_lng_referencia = COALESCE(v_pdv_lng, pdv_lng_referencia),
      pdv_radio_geocerca_m = COALESCE(v_radio_m, pdv_radio_geocerca_m),
      updated_at = v_now
    WHERE id = v_ruta.id
    RETURNING * INTO v_ruta;

    IF v_ruta.cronograma_id IS NOT NULL THEN
      UPDATE public.cronograma_degustaciones
      SET estado = CASE WHEN estado = 'COMPLETADA' THEN 'COMPLETADA' ELSE 'EN_CURSO' END,
          updated_at = v_now
      WHERE id = v_ruta.cronograma_id;
    END IF;
  ELSE
    UPDATE public.rutas_promotoras
    SET
      estado_ruta = 'COMPLETADA',
      checkin_at = COALESCE(checkin_at, v_now),
      checkout_at = COALESCE(checkout_at, v_now),
      checkout_lat = COALESCE(v_lat, checkout_lat),
      checkout_lng = COALESCE(v_lng, checkout_lng),
      checkout_accuracy_m = COALESCE(v_acc, checkout_accuracy_m),
      checkout_distancia_m = COALESCE(v_distancia_m, checkout_distancia_m),
      checkout_dentro_geocerca = COALESCE(v_dentro_geocerca, checkout_dentro_geocerca),
      pdv_lat_referencia = COALESCE(v_pdv_lat, pdv_lat_referencia),
      pdv_lng_referencia = COALESCE(v_pdv_lng, pdv_lng_referencia),
      pdv_radio_geocerca_m = COALESCE(v_radio_m, pdv_radio_geocerca_m),
      updated_at = v_now
    WHERE id = v_ruta.id
    RETURNING * INTO v_ruta;

    IF v_ruta.cronograma_id IS NOT NULL THEN
      UPDATE public.cronograma_degustaciones
      SET estado = 'COMPLETADA',
          updated_at = v_now
      WHERE id = v_ruta.cronograma_id;
    END IF;

    IF v_ejec_json IS NOT NULL AND jsonb_typeof(v_ejec_json) = 'object' THEN
      INSERT INTO public.ejecuciones_pdv_promotora (
        ruta_id,
        cronograma_id,
        promotora_id,
        cliente_id,
        cliente_nombre,
        fecha,
        lote_producto,
        fecha_vencimiento,
        unidades_abiertas,
        muestras_entregadas,
        ventas_asistidas_unidades,
        observaciones,
        client_submission_id,
        sucursal
      )
      VALUES (
        v_ruta.id,
        v_ruta.cronograma_id,
        v_ruta.promotora_id,
        CASE WHEN v_cliente_found THEN v_cliente.id ELSE NULL END,
        v_ruta.cliente_nombre,
        v_ruta.fecha,
        btrim(COALESCE(v_ejec_json ->> 'lote_producto', '')),
        NULLIF(btrim(COALESCE(v_ejec_json ->> 'fecha_vencimiento', '')), '')::date,
        GREATEST(0, COALESCE((v_ejec_json ->> 'unidades_abiertas')::numeric, 0)),
        GREATEST(0, COALESCE((v_ejec_json ->> 'muestras_entregadas')::integer, 0)),
        GREATEST(0, COALESCE((v_ejec_json ->> 'ventas_asistidas_unidades')::integer, 0)),
        btrim(COALESCE(v_ejec_json ->> 'observaciones', '')),
        COALESCE(v_submission_id, 'ruta-exec-' || v_ruta.id::text),
        v_ruta.sucursal
      )
      ON CONFLICT (ruta_id) DO UPDATE
      SET
        lote_producto = EXCLUDED.lote_producto,
        fecha_vencimiento = EXCLUDED.fecha_vencimiento,
        unidades_abiertas = EXCLUDED.unidades_abiertas,
        muestras_entregadas = EXCLUDED.muestras_entregadas,
        ventas_asistidas_unidades = EXCLUDED.ventas_asistidas_unidades,
        observaciones = EXCLUDED.observaciones,
        updated_at = v_now
      RETURNING * INTO v_ejec_row;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'ruta', to_jsonb(v_ruta),
    'ejecucion', CASE WHEN v_ejec_row.id IS NOT NULL THEN to_jsonb(v_ejec_row) ELSE NULL END,
    'distancia_m', v_distancia_m,
    'radio_geocerca_m', v_radio_m,
    'dentro_geocerca', v_dentro_geocerca,
    'alerta_geocerca_registrada', v_alerta_registrada,
    'super_admin_bypass', v_super_admin_bypass
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(JSONB) TO authenticated, service_role;

COMMIT;
