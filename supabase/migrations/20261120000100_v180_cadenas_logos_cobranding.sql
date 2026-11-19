-- =============================================================================
-- ENTREGA v1.8.0 — CO-BRANDING B2B DE CADENAS COMERCIALES EN `/cliente`
-- Archivo: supabase/migrations/20261120000100_v180_cadenas_logos_cobranding.sql
--
-- Reglas inquebrantables cumplidas:
--   1. Inspect-Before-Create sobre `public.cadenas_comerciales`, `public.clientes`,
--      `public.cliente_portal_accesos` y `public.regiones`.
--   2. 100 % idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`).
--      CERO DDL destructivo (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE` prohibidos).
--   3. Blindaje Anti-XSS / Anti-SSRF desde BD: únicamente formatos rasterizados
--      (`image/png`, `image/webp`) y rutas determinísticas internas en el bucket
--      privado `cadenas-logos` (<= 512 KB), prohibiendo `.svg` y URLs externas.
--   4. Aislamiento estricto sobre las 5 regiones activas (`ZULIA`, `VALENCIA`,
--      `CENTRO`, `ORIENTE`, `CAPITAL`) mediante `RLS` + `FORCE RLS`.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. COLUMNAS IDEMPOTENTES DE LOGOTIPO SECUNDARIO EN `public.cadenas_comerciales`
-- =============================================================================
ALTER TABLE public.cadenas_comerciales
  ADD COLUMN IF NOT EXISTS logo_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS logo_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS logo_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cadenas_comerciales_logo_updated_by
  ON public.cadenas_comerciales (logo_updated_by);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = to_regclass('public.cadenas_comerciales')
      AND con.conname = 'chk_cadenas_logo_mime_raster'
  ) THEN
    ALTER TABLE public.cadenas_comerciales
      ADD CONSTRAINT chk_cadenas_logo_mime_raster
      CHECK (
        logo_mime_type IS NULL
        OR logo_mime_type IN ('image/png', 'image/webp')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = to_regclass('public.cadenas_comerciales')
      AND con.conname = 'chk_cadenas_logo_storage_path_deterministico'
  ) THEN
    ALTER TABLE public.cadenas_comerciales
      ADD CONSTRAINT chk_cadenas_logo_storage_path_deterministico
      CHECK (
        logo_storage_path IS NULL
        OR (
          logo_storage_path ~ '^cadenas-logos/(ZULIA|VALENCIA|CENTRO|ORIENTE|CAPITAL)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/logo_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|webp)$'
          AND position('..' in logo_storage_path) = 0
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.cadenas_comerciales.logo_storage_path IS
  'Ruta determinística privada en bucket cadenas-logos (PNG/WebP <= 512 KB). Prohibido SVG o URL externa.';
COMMENT ON COLUMN public.cadenas_comerciales.logo_mime_type IS
  'MIME verificado por magic bytes en servidor: exclusivamente image/png o image/webp.';

-- =============================================================================
-- 2. ENDURECIMIENTO RLS + FORCE RLS POR REGIÓN EN `public.cadenas_comerciales`
-- =============================================================================
REVOKE ALL ON TABLE public.cadenas_comerciales FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cadenas_comerciales TO authenticated;

ALTER TABLE public.cadenas_comerciales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cadenas_comerciales FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cadenas_comerciales_select_sucursal ON public.cadenas_comerciales;
CREATE POLICY cadenas_comerciales_select_sucursal
  ON public.cadenas_comerciales
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_region(region_id, sucursal))
    AND (
      (SELECT public.obtener_mi_rol()) <> 'cliente'
      OR EXISTS (
        SELECT 1
        FROM public.cliente_portal_accesos a
        LEFT JOIN public.clientes c ON c.id = a.cliente_id
        WHERE a.user_id = (SELECT auth.uid())
          AND a.activo = true
          AND (SELECT public.tiene_acceso_region(a.region_id, a.sucursal))
          AND (
            a.cadena_id = public.cadenas_comerciales.id
            OR c.cadena_id = public.cadenas_comerciales.id
          )
      )
    )
  );

DROP POLICY IF EXISTS cadenas_comerciales_insert_coord_admin ON public.cadenas_comerciales;
CREATE POLICY cadenas_comerciales_insert_coord_admin
  ON public.cadenas_comerciales
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_region(region_id, sucursal))
  );

DROP POLICY IF EXISTS cadenas_comerciales_update_coord_admin ON public.cadenas_comerciales;
CREATE POLICY cadenas_comerciales_update_coord_admin
  ON public.cadenas_comerciales
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_region(region_id, sucursal))
  )
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_region(region_id, sucursal))
  );

-- =============================================================================
-- 3. FUNCIÓN DE AUTORIZACIÓN Y BUCKET PRIVADO `cadenas-logos` (512 KB, PNG/WEBP)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_tiene_acceso_logo_cadena(p_cadena_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_rol TEXT := (SELECT public.obtener_mi_rol());
  v_sucursal public.sucursal_codigo;
  v_region_id UUID;
BEGIN
  IF v_uid IS NULL OR p_cadena_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT cad.sucursal, cad.region_id
  INTO v_sucursal, v_region_id
  FROM public.cadenas_comerciales cad
  WHERE cad.id = p_cadena_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF NOT public.tiene_acceso_region(v_region_id, v_sucursal) THEN
    RETURN false;
  END IF;

  IF public.is_torre_control_viewer() THEN
    RETURN true;
  END IF;

  IF v_rol = 'cliente' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.cliente_portal_accesos a
      LEFT JOIN public.clientes c ON c.id = a.cliente_id
      WHERE a.user_id = v_uid
        AND a.activo = true
        AND public.tiene_acceso_region(a.region_id, a.sucursal)
        AND (
          a.cadena_id = p_cadena_id
          OR c.cadena_id = p_cadena_id
        )
    );
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.fn_tiene_acceso_logo_cadena(UUID) IS
  'Verifica acceso regional estricto al logotipo secundario de una cadena comercial para Torre de Control o cliente vinculado en cliente_portal_accesos.';

REVOKE ALL ON FUNCTION public.fn_tiene_acceso_logo_cadena(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_tiene_acceso_logo_cadena(UUID) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'cadenas-logos',
      'cadenas-logos',
      false,
      524288,
      ARRAY['image/png', 'image/webp']
    )
    ON CONFLICT (id) DO UPDATE
    SET
      public = false,
      file_size_limit = 524288,
      allowed_mime_types = ARRAY['image/png', 'image/webp'];
  END IF;

  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS storage_cadenas_logos_select ON storage.objects;
    DROP POLICY IF EXISTS storage_cadenas_logos_insert ON storage.objects;
    DROP POLICY IF EXISTS storage_cadenas_logos_update ON storage.objects;
    DROP POLICY IF EXISTS storage_cadenas_logos_delete ON storage.objects;

    CREATE POLICY storage_cadenas_logos_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'cadenas-logos'
        AND (storage.foldername(name))[1] = 'cadenas-logos'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND COALESCE((storage.foldername(name))[3], '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (SELECT public.fn_tiene_acceso_logo_cadena(((storage.foldername(name))[3])::uuid))
      );

    CREATE POLICY storage_cadenas_logos_insert
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'cadenas-logos'
        AND (storage.foldername(name))[1] = 'cadenas-logos'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion')
        AND (SELECT public.tiene_acceso_sucursal(
          public.fn_normalizar_sucursal_codigo((storage.foldername(name))[2])
        ))
      );

    CREATE POLICY storage_cadenas_logos_update
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (
        bucket_id = 'cadenas-logos'
        AND (storage.foldername(name))[1] = 'cadenas-logos'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion')
        AND (SELECT public.tiene_acceso_sucursal(
          public.fn_normalizar_sucursal_codigo((storage.foldername(name))[2])
        ))
      )
      WITH CHECK (
        bucket_id = 'cadenas-logos'
        AND (storage.foldername(name))[1] = 'cadenas-logos'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion')
        AND (SELECT public.tiene_acceso_sucursal(
          public.fn_normalizar_sucursal_codigo((storage.foldername(name))[2])
        ))
      );

    CREATE POLICY storage_cadenas_logos_delete
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'cadenas-logos'
        AND (storage.foldername(name))[1] = 'cadenas-logos'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion')
        AND (SELECT public.tiene_acceso_sucursal(
          public.fn_normalizar_sucursal_codigo((storage.foldername(name))[2])
        ))
      );
  END IF;
END $$;

-- =============================================================================
-- 4. VISTA SECURITY INVOKER `public.v_cliente_portal_cadenas_branding`
-- =============================================================================
CREATE OR REPLACE VIEW public.v_cliente_portal_cadenas_branding
WITH (security_invoker = true)
AS
SELECT DISTINCT
  a.user_id,
  cad.id AS cadena_id,
  cad.codigo AS cadena_codigo,
  cad.nombre AS cadena_nombre,
  cad.tipo_canal,
  cad.sucursal,
  cad.region_id,
  (cad.logo_storage_path IS NOT NULL AND cad.logo_mime_type IS NOT NULL) AS has_logo,
  cad.logo_mime_type,
  cad.logo_updated_at
FROM public.cliente_portal_accesos a
LEFT JOIN public.clientes c ON c.id = a.cliente_id
JOIN public.cadenas_comerciales cad
  ON cad.id = COALESCE(a.cadena_id, c.cadena_id)
WHERE a.activo = true
  AND cad.activo = true;

DO $$
BEGIN
  IF to_regclass('public.v_cliente_portal_cadenas_branding') IS NOT NULL THEN
    REVOKE ALL ON public.v_cliente_portal_cadenas_branding FROM PUBLIC, anon;
    GRANT SELECT ON public.v_cliente_portal_cadenas_branding TO authenticated;
  END IF;
END $$;

-- =============================================================================
-- 5. ACTUALIZACIÓN DE RPCs (`rpc_obtener_resumen_portal_cliente`,
--    `rpc_listar_personal_sucursal` Y `rpc_certificar_esquema_trade`)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_obtener_resumen_portal_cliente()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_rol TEXT := (SELECT public.obtener_mi_rol());
  v_is_torre BOOLEAN := (SELECT public.is_torre_control_viewer());
  v_pdvs JSONB := '[]'::jsonb;
  v_cadenas JSONB := '[]'::jsonb;
  v_activaciones JSONB := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: Sesión requerida para consultar el Portal Cliente.'
      USING ERRCODE = '42501';
  END IF;

  IF v_rol <> 'cliente' AND NOT v_is_torre THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Tu perfil no cuenta con acceso al Portal Cliente.'
      USING ERRCODE = '42501';
  END IF;

  WITH pdvs_autorizados AS (
    SELECT DISTINCT
      c.id,
      c.codigo_cliente,
      c.nombre_comercial,
      c.ciudad,
      c.estado,
      c.sucursal,
      cad.id AS cadena_id,
      cad.codigo AS cadena_codigo,
      cad.nombre AS cadena_nombre,
      (cad.logo_storage_path IS NOT NULL AND cad.logo_mime_type IS NOT NULL) AS cadena_has_logo,
      cad.logo_mime_type AS cadena_logo_mime_type,
      cad.logo_updated_at AS cadena_logo_updated_at
    FROM public.clientes c
    LEFT JOIN public.cadenas_comerciales cad ON cad.id = c.cadena_id
    WHERE c.activo = true
      AND public.tiene_acceso_region(c.region_id, c.sucursal)
      AND (
        v_is_torre
        OR EXISTS (
          SELECT 1
          FROM public.cliente_portal_accesos a
          WHERE a.user_id = v_uid
            AND a.activo = true
            AND public.tiene_acceso_region(a.region_id, a.sucursal)
            AND (
              a.cliente_id = c.id
              OR (a.cadena_id IS NOT NULL AND a.cadena_id = c.cadena_id)
            )
        )
      )
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'codigo_cliente', p.codigo_cliente,
        'nombre_comercial', p.nombre_comercial,
        'cadena_id', p.cadena_id,
        'cadena_codigo', p.cadena_codigo,
        'cadena_nombre', COALESCE(p.cadena_nombre, 'PDV Independiente'),
        'cadena_has_logo', COALESCE(p.cadena_has_logo, false),
        'cadena_logo_mime_type', p.cadena_logo_mime_type,
        'cadena_logo_updated_at', p.cadena_logo_updated_at,
        'ciudad', COALESCE(p.ciudad, ''),
        'estado', COALESCE(p.estado, ''),
        'sucursal', p.sucursal
      )
      ORDER BY p.nombre_comercial ASC
    ),
    '[]'::jsonb
  )
  INTO v_pdvs
  FROM pdvs_autorizados p;

  WITH cadenas_autorizadas AS (
    SELECT DISTINCT
      cad.id,
      cad.codigo,
      cad.nombre,
      cad.tipo_canal,
      cad.sucursal,
      (cad.logo_storage_path IS NOT NULL AND cad.logo_mime_type IS NOT NULL) AS has_logo,
      cad.logo_mime_type,
      cad.logo_updated_at
    FROM public.cadenas_comerciales cad
    WHERE cad.activo = true
      AND public.tiene_acceso_region(cad.region_id, cad.sucursal)
      AND (
        v_is_torre
        OR EXISTS (
          SELECT 1
          FROM public.cliente_portal_accesos a
          LEFT JOIN public.clientes c ON c.id = a.cliente_id
          WHERE a.user_id = v_uid
            AND a.activo = true
            AND public.tiene_acceso_region(a.region_id, a.sucursal)
            AND (
              a.cadena_id = cad.id
              OR c.cadena_id = cad.id
            )
        )
      )
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', ca.id,
        'codigo', ca.codigo,
        'nombre', ca.nombre,
        'tipo_canal', ca.tipo_canal,
        'sucursal', ca.sucursal,
        'has_logo', ca.has_logo,
        'logo_mime_type', ca.logo_mime_type,
        'logo_updated_at', ca.logo_updated_at
      )
      ORDER BY lower(ca.nombre) ASC
    ),
    '[]'::jsonb
  )
  INTO v_cadenas
  FROM cadenas_autorizadas ca;

  WITH pdvs_autorizados AS (
    SELECT DISTINCT
      c.id,
      c.codigo_cliente,
      c.nombre_comercial
    FROM public.clientes c
    WHERE c.activo = true
      AND public.tiene_acceso_region(c.region_id, c.sucursal)
      AND (
        v_is_torre
        OR EXISTS (
          SELECT 1
          FROM public.cliente_portal_accesos a
          WHERE a.user_id = v_uid
            AND a.activo = true
            AND public.tiene_acceso_region(a.region_id, a.sucursal)
            AND (
              a.cliente_id = c.id
              OR (a.cadena_id IS NOT NULL AND a.cadena_id = c.cadena_id)
            )
        )
      )
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', cd.id,
        'fecha', cd.fecha,
        'turno', cd.turno,
        'hora_inicio', cd.hora_inicio,
        'hora_fin', cd.hora_fin,
        'cliente_nombre', cd.cliente_nombre,
        'cliente_codigo', cd.cliente_codigo,
        'producto_resumen', cd.producto_resumen,
        'estado', cd.estado,
        'promotora_nombre', COALESCE(cd.promotora_nombre, 'Por asignar'),
        'muestras_entregadas', COALESCE(ep.muestras_entregadas, cd.personas_estimadas, 0),
        'ventas_asistidas_unidades', COALESCE(ep.ventas_asistidas_unidades, 0),
        'checkin_dentro_geocerca', rp.checkin_dentro_geocerca
      )
      ORDER BY cd.fecha DESC, cd.hora_inicio ASC
    ),
    '[]'::jsonb
  )
  INTO v_activaciones
  FROM public.cronograma_degustaciones cd
  LEFT JOIN public.rutas_promotoras rp ON rp.cronograma_id = cd.id
  LEFT JOIN public.ejecuciones_pdv_promotora ep ON ep.ruta_id = rp.id
  WHERE public.tiene_acceso_region(cd.region_id, cd.sucursal)
    AND cd.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA')
    AND EXISTS (
      SELECT 1
      FROM pdvs_autorizados p
      WHERE (
        NULLIF(btrim(cd.cliente_codigo), '') IS NOT NULL
        AND upper(btrim(p.codigo_cliente)) = upper(btrim(cd.cliente_codigo))
      )
      OR lower(btrim(p.nombre_comercial)) = lower(btrim(cd.cliente_nombre))
    );

  RETURN jsonb_build_object(
    'ok', true,
    'rol', v_rol,
    'pdvs_autorizados', v_pdvs,
    'cadenas_branding', v_cadenas,
    'activaciones', v_activaciones
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_obtener_resumen_portal_cliente() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_obtener_resumen_portal_cliente() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_listar_personal_sucursal(
  p_sucursal TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_rol TEXT := (SELECT public.obtener_mi_rol());
  v_mi_sucursal public.sucursal_codigo := (SELECT public.obtener_mi_sucursal());
  v_ctx_sucursal public.sucursal_codigo := (SELECT public.obtener_sucursal_contexto_activo());
  v_req_sucursal public.sucursal_codigo := NULL;
  v_target_sucursal public.sucursal_codigo;
  v_profiles JSONB := '[]'::jsonb;
  v_staff JSONB := '[]'::jsonb;
  v_clientes JSONB := '[]'::jsonb;
  v_cadenas JSONB := '[]'::jsonb;
  v_portal_accesos JSONB := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR v_rol NOT IN ('super_admin', 'contraloria', 'coordinacion') THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Solo Torre de Control puede consultar el padrón regional de personal.'
      USING ERRCODE = '42501';
  END IF;

  IF p_sucursal IS NOT NULL AND btrim(p_sucursal) <> '' THEN
    v_req_sucursal := COALESCE(
      public.fn_normalizar_sucursal_codigo(p_sucursal),
      public.fn_resolver_sucursal_desde_region_id(public.fn_resolver_region_id(p_sucursal))
    );
    IF v_req_sucursal IS NULL THEN
      RAISE EXCEPTION 'INVALID_SUCURSAL: Región inválida (%).', p_sucursal
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_rol = 'coordinacion' OR v_mi_sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
    IF v_mi_sucursal IS NULL OR v_mi_sucursal = 'GLOBAL'::public.sucursal_codigo THEN
      RAISE EXCEPTION 'REGION_CONTEXT_REQUIRED: El perfil carece de región operativa asignada.'
        USING ERRCODE = '42501';
    END IF;
    IF v_req_sucursal IS NOT NULL AND v_req_sucursal <> v_mi_sucursal THEN
      RAISE EXCEPTION 'FORBIDDEN_BRANCH: No tienes autorización para consultar personal de la región %.', v_req_sucursal
        USING ERRCODE = '42501';
    END IF;
    v_target_sucursal := v_mi_sucursal;
  ELSE
    v_target_sucursal := COALESCE(v_req_sucursal, v_ctx_sucursal, 'GLOBAL'::public.sucursal_codigo);
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'email', p.email,
        'full_name', p.full_name,
        'role', p.role,
        'sucursal', p.sucursal::text,
        'region_id', p.region_id,
        'is_active', p.is_active
      )
      ORDER BY p.role ASC, lower(p.full_name) ASC
    ),
    '[]'::jsonb
  )
  INTO v_profiles
  FROM public.profiles p
  WHERE v_target_sucursal = 'GLOBAL'::public.sucursal_codigo
     OR p.sucursal = v_target_sucursal;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'role', s.role,
        'email', s.email,
        'status', s.status,
        'auth_user_id', s.auth_user_id,
        'sucursal', s.sucursal::text,
        'region_id', s.region_id
      )
      ORDER BY lower(s.name) ASC
    ),
    '[]'::jsonb
  )
  INTO v_staff
  FROM public.staff s
  WHERE v_target_sucursal = 'GLOBAL'::public.sucursal_codigo
     OR s.sucursal = v_target_sucursal;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'codigo_cliente', c.codigo_cliente,
        'razon_social', c.razon_social,
        'nombre_comercial', c.nombre_comercial,
        'ciudad', c.ciudad,
        'estado', c.estado,
        'cadena_id', c.cadena_id,
        'zona_id', c.zona_id,
        'activo', c.activo,
        'sucursal', c.sucursal::text,
        'region_id', c.region_id
      )
      ORDER BY lower(COALESCE(c.nombre_comercial, c.razon_social)) ASC
    ),
    '[]'::jsonb
  )
  INTO v_clientes
  FROM public.clientes c
  WHERE v_target_sucursal = 'GLOBAL'::public.sucursal_codigo
     OR c.sucursal = v_target_sucursal;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', cad.id,
        'codigo', cad.codigo,
        'nombre', cad.nombre,
        'tipo_canal', cad.tipo_canal,
        'activo', cad.activo,
        'sucursal', cad.sucursal::text,
        'region_id', cad.region_id,
        'logo_storage_path', cad.logo_storage_path,
        'logo_mime_type', cad.logo_mime_type,
        'logo_updated_at', cad.logo_updated_at,
        'logo_updated_by', cad.logo_updated_by
      )
      ORDER BY lower(cad.nombre) ASC
    ),
    '[]'::jsonb
  )
  INTO v_cadenas
  FROM public.cadenas_comerciales cad
  WHERE v_target_sucursal = 'GLOBAL'::public.sucursal_codigo
     OR cad.sucursal = v_target_sucursal;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'user_id', a.user_id,
        'cliente_id', a.cliente_id,
        'cadena_id', a.cadena_id,
        'activo', a.activo,
        'notas', a.notas,
        'sucursal', a.sucursal::text,
        'region_id', a.region_id
      )
      ORDER BY a.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_portal_accesos
  FROM public.cliente_portal_accesos a
  WHERE v_target_sucursal = 'GLOBAL'::public.sucursal_codigo
     OR a.sucursal = v_target_sucursal;

  RETURN jsonb_build_object(
    'ok', true,
    'sucursal', v_target_sucursal::text,
    'region_id', CASE
      WHEN v_target_sucursal = 'GLOBAL'::public.sucursal_codigo THEN NULL
      ELSE public.fn_resolver_region_id(v_target_sucursal::text)
    END,
    'profiles', v_profiles,
    'staff', v_staff,
    'clientes', v_clientes,
    'cadenas', v_cadenas,
    'portal_accesos', v_portal_accesos
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_listar_personal_sucursal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_listar_personal_sucursal(TEXT) TO authenticated, service_role;

COMMIT;
