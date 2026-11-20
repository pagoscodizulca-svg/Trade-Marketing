-- =============================================================================
-- MIGRACIÓN: Sincronización Directa BD <-> Pantallas (5 Entidades Maestras) y
--            Aislamiento Multi-Sucursal Fail-Closed con Cuarentena Segura
-- Archivo:   supabase/migrations/20261123000100_master_entities_sync_rls_fail_closed.sql
-- Instancia: https://apaxdgxtaoeyswlfblgi.supabase.co (tablas preexistentes)
--
-- Garantías Inquebrantables (OWASP Top 10 / Multi-Tenant RLS):
--   1. CERO creación de tablas nuevas: opera exclusivamente sobre las tablas
--      ya existentes en `apaxdgxtaoeyswlfblgi` (`to_regclass(...) IS NOT NULL`).
--   2. CERO asignación ciega por defecto (prohibido asignar filas históricas
--      ambiguas a Zulia). Toda fila sin región 100 % determinista queda en
--      Cuarentena Segura (`region_id = NULL`), invisible para cualquier sucursal
--      y visible/reclasificable únicamente por `admin@codizulca.com`.
--   3. RLS SIEMPRE ACTIVO (`ENABLE` + `FORCE ROW LEVEL SECURITY`), CERO acceso
--      `anon`, CERO lectura de `raw_user_meta_data` y CERO secretos quemados.
--   4. Catálogo nacional único de `public.productos`: lectura para usuarios
--      autenticados activos con región o `super_admin`; escritura exclusiva de
--      `admin@codizulca.com` (`public.is_super_admin()`).
--   5. Trigger `BEFORE INSERT` obligatorio de `region_id` en registros nuevos +
--      Trigger anti-cruce regional (`CROSS_REGION_LINK_FORBIDDEN`) impidiendo
--      vincular promotoras, clientes o rutas de región X con supervisores/entidades
--      de región Y.
--   6. Publicación en `supabase_realtime` (`REPLICA IDENTITY FULL`) de las 5
--      entidades maestras para sincronización reactiva inmediata BD <-> Pantallas.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. VERIFICACIÓN ADITIVA DE COLUMNAS RELACIONALES E ÍNDICES EN TABLAS EXISTENTES
--    (No-op seguro si ya existen en https://apaxdgxtaoeyswlfblgi.supabase.co)
-- =============================================================================

DO $$
DECLARE
  v_tbl TEXT;
  v_region_tables TEXT[] := ARRAY[
    'profiles',
    'supervisores',
    'promotoras',
    'clientes',
    'staff',
    'vendedores',
    'cadenas_comerciales',
    'zonas',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'entregas_degustacion',
    'surveys',
    'incidencias_pdv'
  ];
  v_supervisor_fk_tables TEXT[] := ARRAY[
    'promotoras',
    'clientes',
    'rutas_promotoras',
    'cronograma_degustaciones'
  ];
BEGIN
  -- 1.1 Asegurar los 5 hubs oficiales en `public.regiones` sin duplicar registros existentes
  IF to_regclass('public.regiones') IS NOT NULL THEN
    ALTER TABLE public.regiones
      ADD COLUMN IF NOT EXISTS codigo TEXT,
      ADD COLUMN IF NOT EXISTS nombre TEXT,
      ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    UPDATE public.regiones r
    SET
      codigo = COALESCE(NULLIF(upper(btrim(r.codigo)), ''), v.codigo),
      activo = COALESCE(r.activo, true),
      updated_at = now()
    FROM (
      VALUES
        ('ZULIA', 'Zulia'),
        ('VALENCIA', 'Valencia'),
        ('CENTRO', 'Centro'),
        ('ORIENTE', 'Oriente'),
        ('CAPITAL', 'Capital')
    ) AS v(codigo, nombre)
    WHERE (
      lower(translate(btrim(COALESCE(r.codigo, '')), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ', 'AEIOUAEIOUAEIOUNaeiouaeiouaeioun')) = lower(v.codigo)
      OR lower(translate(btrim(COALESCE(r.nombre, '')), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ', 'AEIOUAEIOUAEIOUNaeiouaeiouaeioun')) = lower(v.nombre)
    )
    AND (
      NULLIF(upper(btrim(COALESCE(r.codigo, ''))), '') IS DISTINCT FROM v.codigo
      OR r.activo IS NULL
    );

    INSERT INTO public.regiones (codigo, nombre, activo)
    SELECT v.codigo, v.nombre, true
    FROM (
      VALUES
        ('ZULIA', 'Zulia'),
        ('VALENCIA', 'Valencia'),
        ('CENTRO', 'Centro'),
        ('ORIENTE', 'Oriente'),
        ('CAPITAL', 'Capital')
    ) AS v(codigo, nombre)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.regiones r
      WHERE lower(translate(btrim(COALESCE(r.codigo, '')), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ', 'AEIOUAEIOUAEIOUNaeiouaeiouaeioun')) = lower(v.codigo)
         OR lower(translate(btrim(COALESCE(r.nombre, '')), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ', 'AEIOUAEIOUAEIOUNaeiouaeiouaeioun')) = lower(v.nombre)
    )
    ON CONFLICT DO NOTHING;

    CREATE INDEX IF NOT EXISTS idx_regiones_codigo_norm
      ON public.regiones (upper(btrim(COALESCE(codigo, ''))));
  END IF;

  -- 1.2 Asegurar columna `region_id` e índice B-Tree en entidades maestras y operativas existentes
  IF to_regclass('public.regiones') IS NOT NULL THEN
    FOREACH v_tbl IN ARRAY v_region_tables LOOP
      IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL',
          v_tbl
        );
        EXECUTE format(
          'CREATE INDEX IF NOT EXISTS idx_%I_region_id ON public.%I (region_id)',
          v_tbl,
          v_tbl
        );
      END IF;
    END LOOP;
  END IF;

  -- 1.3 Asegurar columna aditiva `supervisor_id` + índice B-Tree para control anti-cruce regional
  IF to_regclass('public.supervisores') IS NOT NULL THEN
    FOREACH v_tbl IN ARRAY v_supervisor_fk_tables LOOP
      IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS supervisor_id UUID REFERENCES public.supervisores(id) ON DELETE SET NULL',
          v_tbl
        );
        EXECUTE format(
          'CREATE INDEX IF NOT EXISTS idx_%I_supervisor_id ON public.%I (supervisor_id)',
          v_tbl,
          v_tbl
        );
      END IF;
    END LOOP;
  END IF;

  -- 1.4 Asegurar columnas estándar no destructivas en `public.productos`
  IF to_regclass('public.productos') IS NOT NULL THEN
    ALTER TABLE public.productos
      ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS idx_productos_activo
      ON public.productos (activo);
  END IF;
END $$;

-- =============================================================================
-- 2. FUNCIONES CANÓNICAS ENDURECIDAS (`SECURITY DEFINER`, `search_path = public, auth`)
--    - `public.is_super_admin()`: exclusivo `admin@codizulca.com` + rol `'super_admin'`
--    - `public.current_user_region_id()`: UUID de región verificada o NULL (fail-closed)
--    - JAMÁS confía en `raw_user_meta_data` / `user_metadata`
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
  v_auth_email TEXT;
  v_auth_app_role TEXT;
  v_auth_banned TIMESTAMPTZ;
  v_auth_deleted TIMESTAMPTZ;
  v_prof_role TEXT;
  v_prof_email TEXT;
  v_prof_active BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- Verificar identidad real en `auth.users` (nunca `raw_user_meta_data`)
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

  -- Regla estricta: únicamente la cuenta maestra verificada `admin@codizulca.com`
  IF v_auth_email <> 'admin@codizulca.com' THEN
    RETURN false;
  END IF;

  IF v_jwt_email <> '' AND v_jwt_email <> 'admin@codizulca.com' THEN
    RETURN false;
  END IF;

  -- Verificar perfil en `public.profiles` (fail-closed si fue suspendido)
  SELECT
    lower(btrim(COALESCE(p.role, ''))),
    lower(btrim(COALESCE(p.email, ''))),
    p.is_active
  INTO v_prof_role, v_prof_email, v_prof_active
  FROM public.profiles p
  WHERE p.id = v_uid
     OR lower(btrim(COALESCE(p.email, ''))) = 'admin@codizulca.com'
  ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
  LIMIT 1;

  IF FOUND THEN
    IF v_prof_active IS DISTINCT FROM true THEN
      RETURN false;
    END IF;
    RETURN v_prof_email = 'admin@codizulca.com' AND v_prof_role = 'super_admin';
  END IF;

  -- Respaldo firmado en servidor exclusivamente desde `raw_app_meta_data`
  RETURN v_auth_app_role = 'super_admin';
END;
$$;

COMMENT ON FUNCTION public.is_super_admin() IS
  'Retorna true exclusivamente para la sesión autenticada y activa de admin@codizulca.com con rol verificado super_admin en public.profiles o auth.users.raw_app_meta_data. Jamás lee user_metadata.';

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

CREATE OR REPLACE FUNCTION public.current_user_region_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_auth_email TEXT;
  v_auth_banned TIMESTAMPTZ;
  v_auth_deleted TIMESTAMPTZ;
  v_app_meta JSONB;
  v_prof_role TEXT;
  v_prof_active BOOLEAN;
  v_prof_region_id UUID;
  v_prof_sucursal public.sucursal_codigo;
  v_app_region_text TEXT;
  v_resolved_region_id UUID := NULL;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Verificar usuario activo en `auth.users` y leer únicamente `raw_app_meta_data`
  SELECT
    lower(btrim(COALESCE(u.email, ''))),
    u.banned_until,
    u.deleted_at,
    COALESCE(u.raw_app_meta_data, '{}'::jsonb)
  INTO v_auth_email, v_auth_banned, v_auth_deleted, v_app_meta
  FROM auth.users u
  WHERE u.id = v_uid
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_auth_deleted IS NOT NULL OR (v_auth_banned IS NOT NULL AND v_auth_banned > now()) THEN
    RETURN NULL;
  END IF;

  -- 2. Fuente primaria: `public.profiles` (fail-closed si `is_active <> true`)
  SELECT p.role, p.is_active, p.region_id, p.sucursal
  INTO v_prof_role, v_prof_active, v_prof_region_id, v_prof_sucursal
  FROM public.profiles p
  WHERE p.id = v_uid
     OR (v_auth_email <> '' AND lower(btrim(COALESCE(p.email, ''))) = v_auth_email)
  ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
  LIMIT 1;

  IF FOUND THEN
    IF v_prof_active IS DISTINCT FROM true THEN
      RETURN NULL;
    END IF;

    -- El super_admin opera a nivel global (no fijado a una única región)
    IF lower(btrim(COALESCE(v_prof_role, ''))) = 'super_admin' THEN
      RETURN NULL;
    END IF;

    IF v_prof_region_id IS NOT NULL THEN
      RETURN v_prof_region_id;
    END IF;

    IF v_prof_sucursal IS NOT NULL AND v_prof_sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
      RETURN public.fn_resolver_region_id(v_prof_sucursal::text);
    END IF;

    -- Perfil regional sin región asignada -> fail-closed (NULL = 0 filas visibles)
    RETURN NULL;
  END IF;

  -- 3. Respaldo firmado en servidor desde `auth.users.raw_app_meta_data` (nunca `user_metadata`)
  IF lower(btrim(COALESCE(v_app_meta ->> 'role', v_app_meta ->> 'app_role', ''))) = 'super_admin' THEN
    RETURN NULL;
  END IF;

  v_app_region_text := NULLIF(btrim(COALESCE(v_app_meta ->> 'region_id', '')), '');
  IF v_app_region_text IS NOT NULL THEN
    v_resolved_region_id := public.fn_resolver_region_id(v_app_region_text);
    IF v_resolved_region_id IS NOT NULL THEN
      RETURN v_resolved_region_id;
    END IF;
  END IF;

  v_app_region_text := NULLIF(
    btrim(COALESCE(v_app_meta ->> 'sucursal', v_app_meta ->> 'region', '')),
    ''
  );
  IF v_app_region_text IS NOT NULL THEN
    RETURN public.fn_resolver_region_id(v_app_region_text);
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.current_user_region_id() IS
  'Retorna el UUID de public.regiones asignado al usuario autenticado actual desde public.profiles o auth.users.raw_app_meta_data (o NULL en modo fail-closed si no posee región asignada). Jamás lee raw_user_meta_data.';

REVOKE ALL ON FUNCTION public.current_user_region_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_region_id() TO authenticated, service_role;

-- Alinear `public.tiene_acceso_region` para garantizar fail-closed sobre `region_id IS NULL`
CREATE OR REPLACE FUNCTION public.tiene_acceso_region(
  p_region_id UUID,
  p_sucursal public.sucursal_codigo DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_user_region_id UUID;
  v_ctx public.sucursal_codigo;
  v_rol TEXT;
  v_effective_row_region UUID;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- Super admin (`admin@codizulca.com`) siempre tiene visibilidad completa (incluyendo cuarentena NULL)
  IF (SELECT public.is_super_admin()) THEN
    v_ctx := (SELECT public.obtener_sucursal_contexto_activo());
    IF v_ctx IS NULL OR v_ctx = 'GLOBAL'::public.sucursal_codigo THEN
      RETURN true;
    END IF;
    -- Si super_admin acotó explícitamente un hub vía x-sucursal-activa, filtra al hub elegido
    v_effective_row_region := COALESCE(
      p_region_id,
      CASE
        WHEN p_sucursal IS NOT NULL AND p_sucursal <> 'GLOBAL'::public.sucursal_codigo
          THEN public.fn_resolver_region_id(p_sucursal::text)
        ELSE NULL
      END
    );
    RETURN v_effective_row_region IS NOT NULL
      AND v_effective_row_region = public.fn_resolver_region_id(v_ctx::text);
  END IF;

  -- Contraloría nacional solo ve filas clasificadas (nunca cuarentena `region_id IS NULL`)
  v_rol := (SELECT public.obtener_mi_rol());
  v_ctx := (SELECT public.obtener_sucursal_contexto_activo());
  v_effective_row_region := COALESCE(
    p_region_id,
    CASE
      WHEN p_sucursal IS NOT NULL AND p_sucursal <> 'GLOBAL'::public.sucursal_codigo
        THEN public.fn_resolver_region_id(p_sucursal::text)
      ELSE NULL
    END
  );

  IF v_effective_row_region IS NULL THEN
    RETURN false;
  END IF;

  IF v_rol = 'contraloria' AND v_ctx = 'GLOBAL'::public.sucursal_codigo THEN
    RETURN true;
  END IF;

  v_user_region_id := (SELECT public.current_user_region_id());
  IF v_user_region_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN v_effective_row_region = v_user_region_id;
END;
$$;

REVOKE ALL ON FUNCTION public.tiene_acceso_region(UUID, public.sucursal_codigo) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tiene_acceso_region(UUID, public.sucursal_codigo) TO authenticated, service_role;

-- =============================================================================
-- 3. PROTECCIÓN ANTI-ESCALAMIENTO EN `public.profiles` + SINCRONIZACIÓN A
--    `auth.users.raw_app_meta_data` (`role`, `sucursal`, `region_id`)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_guard_profiles_self_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_is_sa BOOLEAN := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_is_sa := (SELECT public.is_super_admin());

  IF TG_OP = 'DELETE' THEN
    IF NOT v_is_sa THEN
      RAISE EXCEPTION 'PRIVILEGE_ESCALATION_BLOCKED: Solo super_admin puede eliminar perfiles.'
        USING ERRCODE = '42501';
    END IF;
    IF lower(btrim(COALESCE(OLD.email, ''))) = 'admin@codizulca.com' THEN
      RAISE EXCEPTION 'SUPER_ADMIN_PROTECTED: No se permite eliminar el perfil maestro admin@codizulca.com.'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_is_sa THEN
      RAISE EXCEPTION 'PRIVILEGE_ESCALATION_BLOCKED: Solo super_admin puede crear perfiles IAM.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: bloquear auto-escalamiento de role, region_id, sucursal o is_active
  IF NOT v_is_sa THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.region_id IS DISTINCT FROM OLD.region_id
       OR NEW.sucursal IS DISTINCT FROM OLD.sucursal
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR lower(btrim(COALESCE(NEW.email, ''))) IS DISTINCT FROM lower(btrim(COALESCE(OLD.email, ''))) THEN
      RAISE EXCEPTION 'PRIVILEGE_ESCALATION_BLOCKED: No puedes modificar role, region_id, sucursal, is_active ni email de un perfil.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Impedir degradación accidental de la cuenta maestra `admin@codizulca.com`
  IF lower(btrim(COALESCE(OLD.email, ''))) = 'admin@codizulca.com' THEN
    IF NEW.role IS DISTINCT FROM 'super_admin' OR NEW.is_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'SUPER_ADMIN_PROTECTED: No se permite degradar ni desactivar a admin@codizulca.com.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_guard_profiles_self_escalation() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.fn_sync_profiles_to_auth_app_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NEW.id IS NOT NULL THEN
    UPDATE auth.users u
    SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', NEW.role,
      'app_role', NEW.role,
      'sucursal', CASE WHEN NEW.sucursal IS NOT NULL THEN NEW.sucursal::text ELSE NULL END,
      'region_id', CASE WHEN NEW.region_id IS NOT NULL THEN NEW.region_id::text ELSE NULL END
    )
    WHERE u.id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sync_profiles_to_auth_app_metadata() FROM PUBLIC, anon;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_profiles_self_escalation ON public.profiles;
    CREATE TRIGGER trg_guard_profiles_self_escalation
      BEFORE INSERT OR UPDATE OR DELETE ON public.profiles
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_guard_profiles_self_escalation();

    DROP TRIGGER IF EXISTS trg_sync_profiles_to_auth_app_metadata ON public.profiles;
    CREATE TRIGGER trg_sync_profiles_to_auth_app_metadata
      AFTER INSERT OR UPDATE OF role, sucursal, region_id, is_active ON public.profiles
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_sync_profiles_to_auth_app_metadata();
  END IF;
END $$;

-- =============================================================================
-- 4. BACKFILL DETERMINISTA AUDITABLE + CUARENTENA SEGURA (`region_id = NULL`)
--    PROHIBIDO asignar Zulia ni otra región por defecto a registros ambiguos.
-- =============================================================================

DO $$
DECLARE
  v_cli_clasificados INTEGER := 0;
  v_cli_cuarentena INTEGER := 0;
  v_prom_clasificadas INTEGER := 0;
  v_prom_cuarentena INTEGER := 0;
  v_sup_clasificados INTEGER := 0;
  v_sup_cuarentena INTEGER := 0;
BEGIN
  -- Habilita únicamente durante esta transacción de migración conservar NULL en filas históricas ambiguas
  PERFORM set_config('codizulca.allow_legacy_null_backfill', '1', true);

  -- 4.1 `public.profiles`: alinear `region_id <-> sucursal` y propagar `raw_app_meta_data`
  IF to_regclass('public.profiles') IS NOT NULL THEN
    UPDATE public.profiles p
    SET region_id = CASE
      WHEN p.role = 'super_admin' OR p.sucursal = 'GLOBAL'::public.sucursal_codigo THEN NULL
      WHEN p.sucursal IS NOT NULL THEN public.fn_resolver_region_id(p.sucursal::text)
      ELSE p.region_id
    END
    WHERE p.region_id IS DISTINCT FROM (
      CASE
        WHEN p.role = 'super_admin' OR p.sucursal = 'GLOBAL'::public.sucursal_codigo THEN NULL
        WHEN p.sucursal IS NOT NULL THEN public.fn_resolver_region_id(p.sucursal::text)
        ELSE p.region_id
      END
    );

    -- Sincronizar `raw_app_meta_data` de todos los perfiles activos existentes
    UPDATE auth.users u
    SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', p.role,
      'app_role', p.role,
      'sucursal', CASE WHEN p.sucursal IS NOT NULL THEN p.sucursal::text ELSE NULL END,
      'region_id', CASE WHEN p.region_id IS NOT NULL THEN p.region_id::text ELSE NULL END
    )
    FROM public.profiles p
    WHERE u.id = p.id
      AND p.is_active = true;
  END IF;

  -- 4.2 `public.supervisores`: mapeo 100 % determinista; filas ambiguas permanecen en `region_id = NULL`
  IF to_regclass('public.supervisores') IS NOT NULL THEN
    UPDATE public.supervisores sv
    SET
      region_id = COALESCE(
        sv.region_id,
        CASE
          WHEN sv.sucursal IS NOT NULL AND sv.sucursal <> 'GLOBAL'::public.sucursal_codigo
            THEN public.fn_resolver_region_id(sv.sucursal::text)
          ELSE NULL
        END,
        (
          SELECT p.region_id
          FROM public.profiles p
          WHERE sv.email IS NOT NULL
            AND btrim(sv.email) <> ''
            AND lower(btrim(sv.email)) = lower(btrim(p.email))
            AND p.region_id IS NOT NULL
          LIMIT 1
        ),
        public.fn_resolver_region_id(
          public.fn_inferir_sucursal_codigo(
            concat_ws(
              ' | ',
              to_jsonb(sv) ->> 'region',
              to_jsonb(sv) ->> 'sede',
              to_jsonb(sv) ->> 'estado',
              to_jsonb(sv) ->> 'ciudad',
              to_jsonb(sv) ->> 'zona',
              to_jsonb(sv) ->> 'ruta'
            )
          )::text
        )
      ),
      sucursal = COALESCE(
        sv.sucursal,
        public.fn_resolver_sucursal_desde_region_id(sv.region_id),
        (
          SELECT p.sucursal
          FROM public.profiles p
          WHERE sv.email IS NOT NULL
            AND btrim(sv.email) <> ''
            AND lower(btrim(sv.email)) = lower(btrim(p.email))
            AND p.sucursal IS NOT NULL
            AND p.sucursal <> 'GLOBAL'::public.sucursal_codigo
          LIMIT 1
        ),
        public.fn_inferir_sucursal_codigo(
          concat_ws(
            ' | ',
            to_jsonb(sv) ->> 'region',
            to_jsonb(sv) ->> 'sede',
            to_jsonb(sv) ->> 'estado',
            to_jsonb(sv) ->> 'ciudad',
            to_jsonb(sv) ->> 'zona',
            to_jsonb(sv) ->> 'ruta'
          )
        )
      )
    WHERE sv.region_id IS NULL;

    -- Mantener consistencia estricta: si quedó sin `region_id`, su `sucursal` también queda NULL (cuarentena)
    UPDATE public.supervisores
    SET sucursal = public.fn_resolver_sucursal_desde_region_id(region_id)
    WHERE region_id IS NOT NULL
      AND sucursal IS DISTINCT FROM public.fn_resolver_sucursal_desde_region_id(region_id);

    SELECT
      COUNT(*) FILTER (WHERE region_id IS NOT NULL),
      COUNT(*) FILTER (WHERE region_id IS NULL)
    INTO v_sup_clasificados, v_sup_cuarentena
    FROM public.supervisores;
  END IF;

  -- 4.3 `public.promotoras`: mapeo 100 % determinista; filas ambiguas permanecen en `region_id = NULL`
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    UPDATE public.promotoras pr
    SET
      region_id = COALESCE(
        pr.region_id,
        CASE
          WHEN pr.sucursal IS NOT NULL AND pr.sucursal <> 'GLOBAL'::public.sucursal_codigo
            THEN public.fn_resolver_region_id(pr.sucursal::text)
          ELSE NULL
        END,
        (
          SELECT p.region_id
          FROM public.profiles p
          WHERE pr.email IS NOT NULL
            AND btrim(pr.email) <> ''
            AND lower(btrim(pr.email)) = lower(btrim(p.email))
            AND p.region_id IS NOT NULL
          LIMIT 1
        ),
        (
          SELECT st.region_id
          FROM public.staff st
          WHERE pr.email IS NOT NULL
            AND btrim(pr.email) <> ''
            AND lower(btrim(pr.email)) = lower(btrim(COALESCE(st.email, '')))
            AND st.region_id IS NOT NULL
          LIMIT 1
        ),
        public.fn_resolver_region_id(
          public.fn_inferir_sucursal_codigo(
            concat_ws(
              ' | ',
              to_jsonb(pr) ->> 'region',
              to_jsonb(pr) ->> 'sede',
              to_jsonb(pr) ->> 'estado',
              to_jsonb(pr) ->> 'ciudad',
              to_jsonb(pr) ->> 'zona',
              to_jsonb(pr) ->> 'ruta',
              to_jsonb(pr) ->> 'direccion'
            )
          )::text
        )
      ),
      sucursal = COALESCE(
        pr.sucursal,
        public.fn_resolver_sucursal_desde_region_id(pr.region_id),
        public.fn_inferir_sucursal_codigo(
          concat_ws(
            ' | ',
            to_jsonb(pr) ->> 'region',
            to_jsonb(pr) ->> 'sede',
            to_jsonb(pr) ->> 'estado',
            to_jsonb(pr) ->> 'ciudad',
            to_jsonb(pr) ->> 'zona',
            to_jsonb(pr) ->> 'ruta',
            to_jsonb(pr) ->> 'direccion'
          )
        )
      )
    WHERE pr.region_id IS NULL;

    UPDATE public.promotoras
    SET sucursal = public.fn_resolver_sucursal_desde_region_id(region_id)
    WHERE region_id IS NOT NULL
      AND sucursal IS DISTINCT FROM public.fn_resolver_sucursal_desde_region_id(region_id);

    SELECT
      COUNT(*) FILTER (WHERE region_id IS NOT NULL),
      COUNT(*) FILTER (WHERE region_id IS NULL)
    INTO v_prom_clasificadas, v_prom_cuarentena
    FROM public.promotoras;
  END IF;

  -- 4.4 `public.clientes`: mapeo 100 % determinista; filas ambiguas permanecen en `region_id = NULL`
  IF to_regclass('public.clientes') IS NOT NULL THEN
    UPDATE public.clientes c
    SET
      region_id = COALESCE(
        c.region_id,
        CASE
          WHEN c.sucursal IS NOT NULL AND c.sucursal <> 'GLOBAL'::public.sucursal_codigo
            THEN public.fn_resolver_region_id(c.sucursal::text)
          ELSE NULL
        END,
        (SELECT z.region_id FROM public.zonas z WHERE z.id = c.zona_id AND z.region_id IS NOT NULL LIMIT 1),
        (SELECT cad.region_id FROM public.cadenas_comerciales cad WHERE cad.id = c.cadena_id AND cad.region_id IS NOT NULL LIMIT 1),
        (SELECT v.region_id FROM public.vendedores v WHERE v.id = c.vendedor_id AND v.region_id IS NOT NULL LIMIT 1),
        public.fn_resolver_region_id(
          public.fn_inferir_sucursal_codigo(
            concat_ws(
              ' | ',
              to_jsonb(c) ->> 'region',
              to_jsonb(c) ->> 'sede',
              to_jsonb(c) ->> 'estado',
              to_jsonb(c) ->> 'ciudad',
              to_jsonb(c) ->> 'zona',
              to_jsonb(c) ->> 'ruta',
              to_jsonb(c) ->> 'direccion'
            )
          )::text
        )
      ),
      sucursal = COALESCE(
        c.sucursal,
        public.fn_resolver_sucursal_desde_region_id(c.region_id),
        public.fn_inferir_sucursal_codigo(
          concat_ws(
            ' | ',
            to_jsonb(c) ->> 'region',
            to_jsonb(c) ->> 'sede',
            to_jsonb(c) ->> 'estado',
            to_jsonb(c) ->> 'ciudad',
            to_jsonb(c) ->> 'zona',
            to_jsonb(c) ->> 'ruta',
            to_jsonb(c) ->> 'direccion'
          )
        )
      )
    WHERE c.region_id IS NULL;

    UPDATE public.clientes
    SET sucursal = public.fn_resolver_sucursal_desde_region_id(region_id)
    WHERE region_id IS NOT NULL
      AND sucursal IS DISTINCT FROM public.fn_resolver_sucursal_desde_region_id(region_id);

    SELECT
      COUNT(*) FILTER (WHERE region_id IS NOT NULL),
      COUNT(*) FILTER (WHERE region_id IS NULL)
    INTO v_cli_clasificados, v_cli_cuarentena
    FROM public.clientes;
  END IF;

  RAISE NOTICE '[AUDITORÍA CUARENTENA FAIL-CLOSED] clientes(clasificados=%, cuarentena_null=%) | promotoras(clasificadas=%, cuarentena_null=%) | supervisores(clasificados=%, cuarentena_null=%)',
    v_cli_clasificados, v_cli_cuarentena,
    v_prom_clasificadas, v_prom_cuarentena,
    v_sup_clasificados, v_sup_cuarentena;
END $$;

-- =============================================================================
-- 5. TRIGGER OBLIGATORIO `BEFORE INSERT OR UPDATE` DE `region_id` EN MAESTROS
--    + TRIGGER ANTI-CRUCE REGIONAL (`CROSS_REGION_LINK_FORBIDDEN`)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_master_region_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_is_sa BOOLEAN := false;
  v_user_region_id UUID := NULL;
  v_resolved_sucursal public.sucursal_codigo := NULL;
  v_allow_legacy_null BOOLEAN := COALESCE(current_setting('codizulca.allow_legacy_null_backfill', true), '') = '1';
BEGIN
  -- En operaciones administrativas directas sin JWT (migración de backfill controlada)
  IF v_uid IS NULL THEN
    IF NEW.region_id IS NULL AND NEW.sucursal IS NOT NULL AND NEW.sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
      NEW.region_id := public.fn_resolver_region_id(NEW.sucursal::text);
    END IF;
    IF NEW.region_id IS NOT NULL THEN
      NEW.sucursal := public.fn_resolver_sucursal_desde_region_id(NEW.region_id);
    ELSIF NOT v_allow_legacy_null THEN
      RAISE EXCEPTION 'REGION_CONTEXT_REQUIRED: Todo registro nuevo en public.% requiere un region_id válido.',
        TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  v_is_sa := (SELECT public.is_super_admin());

  IF NOT v_is_sa THEN
    v_user_region_id := (SELECT public.current_user_region_id());
    IF v_user_region_id IS NULL THEN
      RAISE EXCEPTION 'REGION_CONTEXT_REQUIRED: Tu usuario no posee una región asignada para escribir en public.%.',
        TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.region_id IS DISTINCT FROM v_user_region_id THEN
      RAISE EXCEPTION 'CROSS_REGION_WRITE_FORBIDDEN: No puedes editar registros fuera de tu región en public.%.',
        TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;

    IF NEW.region_id IS NOT NULL AND NEW.region_id <> v_user_region_id THEN
      RAISE EXCEPTION 'CROSS_REGION_WRITE_FORBIDDEN: No puedes asignar otra región en public.%.',
        TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;

    -- Forzar automáticamente el region_id verificado del usuario regional
    NEW.region_id := v_user_region_id;
    NEW.sucursal := public.fn_resolver_sucursal_desde_region_id(v_user_region_id);
    RETURN NEW;
  END IF;

  -- Para super_admin: resolver bidireccionalmente `region_id <-> sucursal` y exigir `region_id` en INSERT nuevos
  IF NEW.region_id IS NULL AND NEW.sucursal IS NOT NULL AND NEW.sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
    NEW.region_id := public.fn_resolver_region_id(NEW.sucursal::text);
  END IF;

  IF NEW.region_id IS NOT NULL THEN
    v_resolved_sucursal := public.fn_resolver_sucursal_desde_region_id(NEW.region_id);
    IF v_resolved_sucursal IS NULL THEN
      RAISE EXCEPTION 'INVALID_REGION_ID: El region_id (%) no existe en public.regiones.', NEW.region_id
        USING ERRCODE = '23503';
    END IF;
    NEW.sucursal := v_resolved_sucursal;
  ELSIF TG_OP = 'INSERT' AND NOT v_allow_legacy_null THEN
    RAISE EXCEPTION 'REGION_CONTEXT_REQUIRED: Todo registro nuevo en public.% debe especificar un region_id válido.',
      TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_enforce_master_region_before_write() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.fn_guard_cross_region_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_json JSONB := to_jsonb(NEW);
  v_row_region_id UUID := NEW.region_id;
  v_sup_id UUID := NULL;
  v_sup_region_id UUID := NULL;
  v_ref_id UUID := NULL;
  v_ref_region_id UUID := NULL;
BEGIN
  IF v_row_region_id IS NULL AND NEW.sucursal IS NOT NULL AND NEW.sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
    v_row_region_id := public.fn_resolver_region_id(NEW.sucursal::text);
  END IF;

  -- 1. Validar `supervisor_id` contra `public.supervisores` (prohibido cruzar región X con supervisor de región Y)
  IF NULLIF(btrim(COALESCE(v_json ->> 'supervisor_id', '')), '') IS NOT NULL
     AND to_regclass('public.supervisores') IS NOT NULL THEN
    v_sup_id := (v_json ->> 'supervisor_id')::uuid;
    SELECT sv.region_id
    INTO v_sup_region_id
    FROM public.supervisores sv
    WHERE sv.id = v_sup_id
    LIMIT 1;

    IF v_sup_region_id IS NULL OR v_row_region_id IS NULL OR v_sup_region_id <> v_row_region_id THEN
      RAISE EXCEPTION 'CROSS_REGION_LINK_FORBIDDEN: No se permite vincular un registro en public.% con un supervisor de una región distinta o sin región confirmada.',
        TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Validaciones cruzadas adicionales en `public.clientes` (`vendedor_id`, `zona_id`, `cadena_id`)
  IF TG_TABLE_NAME = 'clientes' AND v_row_region_id IS NOT NULL THEN
    IF NULLIF(btrim(COALESCE(v_json ->> 'vendedor_id', '')), '') IS NOT NULL
       AND to_regclass('public.vendedores') IS NOT NULL THEN
      v_ref_id := (v_json ->> 'vendedor_id')::uuid;
      SELECT v.region_id INTO v_ref_region_id FROM public.vendedores v WHERE v.id = v_ref_id LIMIT 1;
      IF v_ref_region_id IS NOT NULL AND v_ref_region_id <> v_row_region_id THEN
        RAISE EXCEPTION 'CROSS_REGION_LINK_FORBIDDEN: El vendedor asignado pertenece a una región distinta a la del cliente.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NULLIF(btrim(COALESCE(v_json ->> 'zona_id', '')), '') IS NOT NULL
       AND to_regclass('public.zonas') IS NOT NULL THEN
      v_ref_id := (v_json ->> 'zona_id')::uuid;
      SELECT z.region_id INTO v_ref_region_id FROM public.zonas z WHERE z.id = v_ref_id LIMIT 1;
      IF v_ref_region_id IS NOT NULL AND v_ref_region_id <> v_row_region_id THEN
        RAISE EXCEPTION 'CROSS_REGION_LINK_FORBIDDEN: La zona comercial pertenece a una región distinta a la del cliente.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NULLIF(btrim(COALESCE(v_json ->> 'cadena_id', '')), '') IS NOT NULL
       AND to_regclass('public.cadenas_comerciales') IS NOT NULL THEN
      v_ref_id := (v_json ->> 'cadena_id')::uuid;
      SELECT c.region_id INTO v_ref_region_id FROM public.cadenas_comerciales c WHERE c.id = v_ref_id LIMIT 1;
      IF v_ref_region_id IS NOT NULL AND v_ref_region_id <> v_row_region_id THEN
        RAISE EXCEPTION 'CROSS_REGION_LINK_FORBIDDEN: La cadena comercial pertenece a una región distinta a la del cliente.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- 3. Validaciones cruzadas en `rutas_promotoras` y `cronograma_degustaciones` (`promotora_id`)
  IF TG_TABLE_NAME IN ('rutas_promotoras', 'cronograma_degustaciones')
     AND v_row_region_id IS NOT NULL
     AND NULLIF(btrim(COALESCE(v_json ->> 'promotora_id', '')), '') IS NOT NULL THEN
    v_ref_id := (v_json ->> 'promotora_id')::uuid;

    IF to_regclass('public.staff') IS NOT NULL THEN
      SELECT st.region_id INTO v_ref_region_id FROM public.staff st WHERE st.id = v_ref_id LIMIT 1;
      IF v_ref_region_id IS NOT NULL AND v_ref_region_id <> v_row_region_id THEN
        RAISE EXCEPTION 'CROSS_REGION_LINK_FORBIDDEN: La promotora asignada pertenece a una región distinta a la de la ruta/cronograma.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF v_ref_region_id IS NULL AND to_regclass('public.promotoras') IS NOT NULL THEN
      SELECT pr.region_id INTO v_ref_region_id FROM public.promotoras pr WHERE pr.id = v_ref_id LIMIT 1;
      IF v_ref_region_id IS NOT NULL AND v_ref_region_id <> v_row_region_id THEN
        RAISE EXCEPTION 'CROSS_REGION_LINK_FORBIDDEN: La promotora asignada pertenece a una región distinta a la de la ruta/cronograma.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_guard_cross_region_integrity() FROM PUBLIC, anon;

DO $$
DECLARE
  v_tbl TEXT;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['clientes', 'promotoras', 'supervisores'] LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_enforce_master_region_%I ON public.%I', v_tbl, v_tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_enforce_master_region_%I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_master_region_before_write()',
        v_tbl,
        v_tbl
      );
    END IF;
  END LOOP;

  FOREACH v_tbl IN ARRAY ARRAY['promotoras', 'clientes', 'rutas_promotoras', 'cronograma_degustaciones'] LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_guard_cross_region_%I ON public.%I', v_tbl, v_tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_guard_cross_region_%I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_guard_cross_region_integrity()',
        v_tbl,
        v_tbl
      );
    END IF;
  END LOOP;
END $$;

-- =============================================================================
-- 6. MATRIZ EXACTA DE POLÍTICAS RLS EN LAS 5 ENTIDADES MAESTRAS
--    - RLS SIEMPRE ACTIVO (`ENABLE` + `FORCE ROW LEVEL SECURITY`)
--    - CERO permisos a `PUBLIC` o `anon`
--    - Subconsultas `(SELECT ...)` para optimización initPlan en PostgreSQL
-- =============================================================================

DO $$
DECLARE
  v_pol RECORD;
  v_master TEXT;
BEGIN
  -- 6.1 Limpiar políticas previas en las 5 tablas maestras para evitar reglas permisivas residuales
  FOREACH v_master IN ARRAY ARRAY['productos', 'regiones', 'supervisores', 'promotoras', 'clientes'] LOOP
    IF to_regclass('public.' || v_master) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_master);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_master);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', v_master);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', v_master);

      FOR v_pol IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_master
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_pol.policyname, v_master);
      END LOOP;
    END IF;
  END LOOP;

  -- 6.2 `public.productos` (Catálogo Único Nacional Compartido)
  --     SELECT: usuarios autenticados activos (super_admin o con región asignada)
  --     INSERT / UPDATE / DELETE: exclusivo `public.is_super_admin()`
  IF to_regclass('public.productos') IS NOT NULL THEN
    CREATE POLICY productos_select_national_catalog
      ON public.productos
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_super_admin())
        OR (SELECT public.current_user_region_id()) IS NOT NULL
      );

    CREATE POLICY productos_insert_super_admin
      ON public.productos
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.is_super_admin()));

    CREATE POLICY productos_update_super_admin
      ON public.productos
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()));

    CREATE POLICY productos_delete_super_admin
      ON public.productos
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));
  END IF;

  -- 6.3 `public.regiones`
  --     SELECT: `super_admin` ve todas; usuario regional ve únicamente su región asignada
  --     INSERT / UPDATE / DELETE: exclusivo `public.is_super_admin()`
  IF to_regclass('public.regiones') IS NOT NULL THEN
    CREATE POLICY regiones_select_isolated
      ON public.regiones
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_super_admin())
        OR id = (SELECT public.current_user_region_id())
      );

    CREATE POLICY regiones_insert_super_admin
      ON public.regiones
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.is_super_admin()));

    CREATE POLICY regiones_update_super_admin
      ON public.regiones
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()));

    CREATE POLICY regiones_delete_super_admin
      ON public.regiones
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));
  END IF;

  -- 6.4 `public.supervisores`, `public.promotoras`, `public.clientes`
  --     SELECT / INSERT / UPDATE: `super_admin` O (`region_id IS NOT NULL AND region_id = current_user_region_id()`)
  --     DELETE: exclusivo `public.is_super_admin()` (desactivación lógica en operativa normal)
  IF to_regclass('public.supervisores') IS NOT NULL THEN
    CREATE POLICY supervisores_select_region_strict
      ON public.supervisores
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY supervisores_insert_region_strict
      ON public.supervisores
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY supervisores_update_region_strict
      ON public.supervisores
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      )
      WITH CHECK (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY supervisores_delete_super_admin_only
      ON public.supervisores
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    CREATE POLICY promotoras_select_region_strict
      ON public.promotoras
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY promotoras_insert_region_strict
      ON public.promotoras
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY promotoras_update_region_strict
      ON public.promotoras
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      )
      WITH CHECK (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY promotoras_delete_super_admin_only
      ON public.promotoras
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));
  END IF;

  IF to_regclass('public.clientes') IS NOT NULL THEN
    CREATE POLICY clientes_select_region_strict
      ON public.clientes
      FOR SELECT
      TO authenticated
      USING (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY clientes_insert_region_strict
      ON public.clientes
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY clientes_update_region_strict
      ON public.clientes
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      )
      WITH CHECK (
        (SELECT public.is_super_admin())
        OR (region_id IS NOT NULL AND region_id = (SELECT public.current_user_region_id()))
      );

    CREATE POLICY clientes_delete_super_admin_only
      ON public.clientes
      FOR DELETE
      TO authenticated
      USING ((SELECT public.is_super_admin()));
  END IF;
END $$;

-- =============================================================================
-- 7. PUBLICACIÓN REALTIME NATIVA (`supabase_realtime`) + `REPLICA IDENTITY FULL`
--    Sincronización instantánea BD <-> Pantallas para las 5 entidades maestras
-- =============================================================================

DO $$
DECLARE
  v_rt_tbl TEXT;
  v_rt_tables TEXT[] := ARRAY[
    'regiones',
    'supervisores',
    'promotoras',
    'clientes',
    'productos',
    'staff',
    'vendedores',
    'cadenas_comerciales',
    'zonas'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_rt_tbl IN ARRAY v_rt_tables LOOP
      IF to_regclass('public.' || v_rt_tbl) IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', v_rt_tbl);

        IF NOT EXISTS (
          SELECT 1
          FROM pg_publication_tables
          WHERE pubname = 'supabase_realtime'
            AND schemaname = 'public'
            AND tablename = v_rt_tbl
        ) THEN
          EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_rt_tbl);
        END IF;
      END IF;
    END LOOP;
  END IF;
END $$;

COMMIT;
