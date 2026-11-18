-- =============================================================================
-- TAREA 2: Seguridad RLS y Funciones RPC Atómicas de Sincronización
-- Archivo: supabase/migrations/02_rls_y_rpc_sync.sql
-- Proyecto: Trade Marketing (PostgreSQL 17 / Supabase)
-- Reglas de Seguridad:
--   1. Row Level Security obligatorio en las tres tablas.
--   2. Autorización exclusiva sobre app_metadata (raw_app_meta_data firmado
--      en servidor), jamás user_metadata editable por el cliente.
--   3. Bloqueo absoluto de escrituras anónimas (anon).
--   4. Sincronización idempotente (INSERT ... ON CONFLICT DO UPDATE) por lotes
--      con deduplicación intra-lote y desactivación lógica (activo = false).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Habilitar Row Level Security y restringir privilegios base
-- -----------------------------------------------------------------------------
ALTER TABLE public.vendedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lotes_sincronizacion ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.vendedores FROM PUBLIC, anon;
REVOKE ALL ON public.clientes FROM PUBLIC, anon;
REVOKE ALL ON public.lotes_sincronizacion FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendedores TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clientes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lotes_sincronizacion TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Función Auxiliar de Autorización: public.es_admin_trade()
--    Inspecciona únicamente app_metadata.role (con fallback a app_role cuando
--    role no esté definido) verificando 'admin' o 'gerencia'.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.es_admin_trade()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    LOWER(BTRIM(COALESCE(
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role'
    ))) IN ('admin', 'gerencia'),
    false
  );
$$;

COMMENT ON FUNCTION public.es_admin_trade() IS
  'Verifica en el JWT firmado por Supabase Auth si app_metadata contiene rol admin o gerencia.';

REVOKE EXECUTE ON FUNCTION public.es_admin_trade() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_admin_trade() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Políticas Row Level Security (separadas por operación para óptimo initPlan)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- ============================
  -- Políticas: public.vendedores
  -- ============================
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'vendedores'
      AND policyname = 'vendedores_select_authenticated'
  ) THEN
    CREATE POLICY vendedores_select_authenticated
      ON public.vendedores
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'vendedores'
      AND policyname = 'vendedores_insert_admin_trade'
  ) THEN
    CREATE POLICY vendedores_insert_admin_trade
      ON public.vendedores
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.es_admin_trade()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'vendedores'
      AND policyname = 'vendedores_update_admin_trade'
  ) THEN
    CREATE POLICY vendedores_update_admin_trade
      ON public.vendedores
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.es_admin_trade()))
      WITH CHECK ((SELECT public.es_admin_trade()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'vendedores'
      AND policyname = 'vendedores_delete_admin_trade'
  ) THEN
    CREATE POLICY vendedores_delete_admin_trade
      ON public.vendedores
      FOR DELETE
      TO authenticated
      USING ((SELECT public.es_admin_trade()));
  END IF;

  -- ==========================
  -- Políticas: public.clientes
  -- ==========================
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'clientes'
      AND policyname = 'clientes_select_authenticated'
  ) THEN
    CREATE POLICY clientes_select_authenticated
      ON public.clientes
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'clientes'
      AND policyname = 'clientes_insert_admin_trade'
  ) THEN
    CREATE POLICY clientes_insert_admin_trade
      ON public.clientes
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.es_admin_trade()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'clientes'
      AND policyname = 'clientes_update_admin_trade'
  ) THEN
    CREATE POLICY clientes_update_admin_trade
      ON public.clientes
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.es_admin_trade()))
      WITH CHECK ((SELECT public.es_admin_trade()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'clientes'
      AND policyname = 'clientes_delete_admin_trade'
  ) THEN
    CREATE POLICY clientes_delete_admin_trade
      ON public.clientes
      FOR DELETE
      TO authenticated
      USING ((SELECT public.es_admin_trade()));
  END IF;

  -- =========================================
  -- Políticas: public.lotes_sincronizacion
  -- =========================================
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'lotes_sincronizacion'
      AND policyname = 'lotes_sync_select_admin_trade'
  ) THEN
    CREATE POLICY lotes_sync_select_admin_trade
      ON public.lotes_sincronizacion
      FOR SELECT
      TO authenticated
      USING ((SELECT public.es_admin_trade()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'lotes_sincronizacion'
      AND policyname = 'lotes_sync_insert_admin_trade'
  ) THEN
    CREATE POLICY lotes_sync_insert_admin_trade
      ON public.lotes_sincronizacion
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.es_admin_trade()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'lotes_sincronizacion'
      AND policyname = 'lotes_sync_update_admin_trade'
  ) THEN
    CREATE POLICY lotes_sync_update_admin_trade
      ON public.lotes_sincronizacion
      FOR UPDATE
      TO authenticated
      USING ((SELECT public.es_admin_trade()))
      WITH CHECK ((SELECT public.es_admin_trade()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'lotes_sincronizacion'
      AND policyname = 'lotes_sync_delete_admin_trade'
  ) THEN
    CREATE POLICY lotes_sync_delete_admin_trade
      ON public.lotes_sincronizacion
      FOR DELETE
      TO authenticated
      USING ((SELECT public.es_admin_trade()));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Función RPC Transaccional: public.rpc_sincronizar_vendedores
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_sincronizar_vendedores(
  p_registros JSONB,
  p_desactivar_ausentes BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_procesados INTEGER := 0;
  v_desactivados INTEGER := 0;
  v_codigos_procesados TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT public.es_admin_trade() THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol admin o gerencia en app_metadata para sincronizar vendedores.'
      USING ERRCODE = '42501';
  END IF;

  IF p_registros IS NOT NULL AND jsonb_typeof(p_registros) <> 'array' THEN
    RAISE EXCEPTION 'El parámetro p_registros debe ser un arreglo JSONB.'
      USING ERRCODE = '22023';
  END IF;

  WITH entrada_bruta AS (
    SELECT
      ord,
      UPPER(BTRIM(COALESCE(elem ->> 'codigo_vendedor', ''))) AS codigo_vendedor,
      BTRIM(COALESCE(elem ->> 'nombre_completo', '')) AS nombre_completo,
      NULLIF(BTRIM(COALESCE(elem ->> 'documento_identidad', '')), '') AS documento_identidad,
      NULLIF(BTRIM(COALESCE(elem ->> 'telefono', '')), '') AS telefono,
      LOWER(NULLIF(BTRIM(COALESCE(elem ->> 'email', '')), '')) AS email,
      NULLIF(BTRIM(COALESCE(elem ->> 'zona', '')), '') AS zona,
      NULLIF(BTRIM(COALESCE(elem ->> 'supervisor', '')), '') AS supervisor,
      CASE
        WHEN jsonb_typeof(elem -> 'metadata') = 'object' THEN elem -> 'metadata'
        ELSE '{}'::jsonb
      END AS metadata
    FROM jsonb_array_elements(COALESCE(p_registros, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  ),
  lote_dedup AS (
    SELECT DISTINCT ON (codigo_vendedor)
      codigo_vendedor,
      nombre_completo,
      documento_identidad,
      telefono,
      email,
      zona,
      supervisor,
      metadata
    FROM entrada_bruta
    WHERE codigo_vendedor <> ''
      AND nombre_completo <> ''
    ORDER BY codigo_vendedor, ord DESC
  ),
  upserted AS (
    INSERT INTO public.vendedores (
      codigo_vendedor,
      nombre_completo,
      documento_identidad,
      telefono,
      email,
      zona,
      supervisor,
      activo,
      metadata,
      ultima_sincronizacion
    )
    SELECT
      codigo_vendedor,
      nombre_completo,
      documento_identidad,
      telefono,
      email,
      zona,
      supervisor,
      true,
      metadata,
      v_now
    FROM lote_dedup
    ON CONFLICT (codigo_vendedor) DO UPDATE SET
      nombre_completo = EXCLUDED.nombre_completo,
      documento_identidad = COALESCE(EXCLUDED.documento_identidad, public.vendedores.documento_identidad),
      telefono = COALESCE(EXCLUDED.telefono, public.vendedores.telefono),
      email = COALESCE(EXCLUDED.email, public.vendedores.email),
      zona = COALESCE(EXCLUDED.zona, public.vendedores.zona),
      supervisor = COALESCE(EXCLUDED.supervisor, public.vendedores.supervisor),
      activo = true,
      metadata = COALESCE(public.vendedores.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      ultima_sincronizacion = v_now
    RETURNING codigo_vendedor
  )
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(ARRAY_AGG(codigo_vendedor), ARRAY[]::TEXT[])
  INTO v_procesados, v_codigos_procesados
  FROM upserted;

  -- Enlace retroactivo automático para clientes que aguardaban creación de su vendedor
  IF cardinality(v_codigos_procesados) > 0 THEN
    UPDATE public.clientes c
    SET vendedor_id = v.id
    FROM public.vendedores v
    WHERE v.codigo_vendedor = ANY(v_codigos_procesados)
      AND c.codigo_vendedor = v.codigo_vendedor
      AND c.vendedor_id IS DISTINCT FROM v.id;
  END IF;

  -- Desactivación lógica (sin DELETE físico) cuando se solicita reconciliar toda la plantilla
  IF COALESCE(p_desactivar_ausentes, false) = true AND cardinality(v_codigos_procesados) > 0 THEN
    UPDATE public.vendedores
    SET activo = false
    WHERE activo = true
      AND NOT (codigo_vendedor = ANY(v_codigos_procesados));
    GET DIAGNOSTICS v_desactivados = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'procesados', v_procesados,
    'sin_vendedor_asignado', 0,
    'desactivados', v_desactivados
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_sincronizar_vendedores(JSONB, BOOLEAN) IS
  'Sincroniza lotes de vendedores vía UPSERT idempotente y desactivación lógica opcional.';

REVOKE EXECUTE ON FUNCTION public.rpc_sincronizar_vendedores(JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_sincronizar_vendedores(JSONB, BOOLEAN) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Función RPC Transaccional: public.rpc_sincronizar_clientes
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_sincronizar_clientes(
  p_registros JSONB,
  p_codigos_activos_totales TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_procesados INTEGER := 0;
  v_sin_vendedor INTEGER := 0;
  v_desactivados INTEGER := 0;
  v_vendedores_faltantes TEXT[] := ARRAY[]::TEXT[];
  v_codigos_totales_norm TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT public.es_admin_trade() THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol admin o gerencia en app_metadata para sincronizar clientes.'
      USING ERRCODE = '42501';
  END IF;

  IF p_registros IS NOT NULL AND jsonb_typeof(p_registros) <> 'array' THEN
    RAISE EXCEPTION 'El parámetro p_registros debe ser un arreglo JSONB.'
      USING ERRCODE = '22023';
  END IF;

  -- Contabilizar códigos de vendedor no encontrados en public.vendedores sin abortar el lote
  WITH entrada_bruta AS (
    SELECT
      ord,
      UPPER(BTRIM(COALESCE(elem ->> 'codigo_cliente', ''))) AS codigo_cliente,
      BTRIM(COALESCE(elem ->> 'razon_social', '')) AS razon_social,
      NULLIF(UPPER(BTRIM(COALESCE(elem ->> 'codigo_vendedor', ''))), '') AS codigo_vendedor
    FROM jsonb_array_elements(COALESCE(p_registros, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  ),
  lote_dedup AS (
    SELECT DISTINCT ON (codigo_cliente)
      codigo_cliente,
      codigo_vendedor
    FROM entrada_bruta
    WHERE codigo_cliente <> ''
      AND razon_social <> ''
    ORDER BY codigo_cliente, ord DESC
  )
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(ARRAY_AGG(DISTINCT d.codigo_vendedor), ARRAY[]::TEXT[])
  INTO v_sin_vendedor, v_vendedores_faltantes
  FROM lote_dedup d
  LEFT JOIN public.vendedores v
    ON v.codigo_vendedor = d.codigo_vendedor
  WHERE d.codigo_vendedor IS NOT NULL
    AND v.id IS NULL;

  -- UPSERT atómico del lote con resolución automática de vendedor_id
  WITH entrada_bruta AS (
    SELECT
      ord,
      UPPER(BTRIM(COALESCE(elem ->> 'codigo_cliente', ''))) AS codigo_cliente,
      CASE
        WHEN UPPER(BTRIM(COALESCE(elem ->> 'rif', ''))) IN ('', '#N/D', 'N/D', 'N/A', '#N/A', 'NULL', 'SIN RIF', '-')
        THEN NULL
        ELSE REGEXP_REPLACE(UPPER(BTRIM(elem ->> 'rif')), '\s+', '', 'g')
      END AS rif,
      BTRIM(COALESCE(elem ->> 'razon_social', '')) AS razon_social,
      NULLIF(BTRIM(COALESCE(elem ->> 'nombre_comercial', '')), '') AS nombre_comercial,
      NULLIF(BTRIM(COALESCE(elem ->> 'canal', '')), '') AS canal,
      NULLIF(BTRIM(COALESCE(elem ->> 'segmento', '')), '') AS segmento,
      NULLIF(BTRIM(COALESCE(elem ->> 'zona', '')), '') AS zona,
      NULLIF(BTRIM(COALESCE(elem ->> 'ruta', '')), '') AS ruta,
      NULLIF(BTRIM(COALESCE(elem ->> 'direccion', '')), '') AS direccion,
      NULLIF(BTRIM(COALESCE(elem ->> 'ciudad', '')), '') AS ciudad,
      NULLIF(BTRIM(COALESCE(elem ->> 'estado', '')), '') AS estado,
      NULLIF(BTRIM(COALESCE(elem ->> 'telefono', '')), '') AS telefono,
      CASE
        WHEN (elem ->> 'latitud') ~ '^-?[0-9]+(\.[0-9]+)?$'
          AND ((elem ->> 'latitud')::NUMERIC BETWEEN -90 AND 90)
        THEN ROUND((elem ->> 'latitud')::NUMERIC, 7)
        ELSE NULL
      END AS latitud,
      CASE
        WHEN (elem ->> 'longitud') ~ '^-?[0-9]+(\.[0-9]+)?$'
          AND ((elem ->> 'longitud')::NUMERIC BETWEEN -180 AND 180)
        THEN ROUND((elem ->> 'longitud')::NUMERIC, 7)
        ELSE NULL
      END AS longitud,
      NULLIF(UPPER(BTRIM(COALESCE(elem ->> 'codigo_vendedor', ''))), '') AS codigo_vendedor,
      CASE
        WHEN jsonb_typeof(elem -> 'metadata') = 'object' THEN elem -> 'metadata'
        ELSE '{}'::jsonb
      END AS metadata
    FROM jsonb_array_elements(COALESCE(p_registros, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  ),
  lote_dedup AS (
    SELECT DISTINCT ON (codigo_cliente)
      codigo_cliente,
      rif,
      razon_social,
      nombre_comercial,
      canal,
      segmento,
      zona,
      ruta,
      direccion,
      ciudad,
      estado,
      telefono,
      latitud,
      longitud,
      codigo_vendedor,
      metadata
    FROM entrada_bruta
    WHERE codigo_cliente <> ''
      AND razon_social <> ''
    ORDER BY codigo_cliente, ord DESC
  ),
  upserted AS (
    INSERT INTO public.clientes (
      codigo_cliente,
      rif,
      razon_social,
      nombre_comercial,
      canal,
      segmento,
      zona,
      ruta,
      direccion,
      ciudad,
      estado,
      telefono,
      latitud,
      longitud,
      vendedor_id,
      codigo_vendedor,
      activo,
      metadata,
      ultima_sincronizacion
    )
    SELECT
      d.codigo_cliente,
      d.rif,
      d.razon_social,
      d.nombre_comercial,
      d.canal,
      d.segmento,
      d.zona,
      d.ruta,
      d.direccion,
      d.ciudad,
      d.estado,
      d.telefono,
      d.latitud,
      d.longitud,
      v.id AS vendedor_id,
      d.codigo_vendedor,
      true,
      d.metadata,
      v_now
    FROM lote_dedup d
    LEFT JOIN public.vendedores v
      ON v.codigo_vendedor = d.codigo_vendedor
    ON CONFLICT (codigo_cliente) DO UPDATE SET
      rif = COALESCE(EXCLUDED.rif, public.clientes.rif),
      razon_social = EXCLUDED.razon_social,
      nombre_comercial = COALESCE(EXCLUDED.nombre_comercial, public.clientes.nombre_comercial),
      canal = COALESCE(EXCLUDED.canal, public.clientes.canal),
      segmento = COALESCE(EXCLUDED.segmento, public.clientes.segmento),
      zona = COALESCE(EXCLUDED.zona, public.clientes.zona),
      ruta = COALESCE(EXCLUDED.ruta, public.clientes.ruta),
      direccion = COALESCE(EXCLUDED.direccion, public.clientes.direccion),
      ciudad = COALESCE(EXCLUDED.ciudad, public.clientes.ciudad),
      estado = COALESCE(EXCLUDED.estado, public.clientes.estado),
      telefono = COALESCE(EXCLUDED.telefono, public.clientes.telefono),
      latitud = COALESCE(EXCLUDED.latitud, public.clientes.latitud),
      longitud = COALESCE(EXCLUDED.longitud, public.clientes.longitud),
      vendedor_id = CASE
        WHEN EXCLUDED.codigo_vendedor IS NOT NULL THEN EXCLUDED.vendedor_id
        ELSE public.clientes.vendedor_id
      END,
      codigo_vendedor = COALESCE(EXCLUDED.codigo_vendedor, public.clientes.codigo_vendedor),
      activo = true,
      metadata = COALESCE(public.clientes.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      ultima_sincronizacion = v_now
    RETURNING codigo_cliente
  )
  SELECT COUNT(*)::INTEGER
  INTO v_procesados
  FROM upserted;

  -- Reconciliación opcional de cartera completa mediante desactivación lógica (activo = false)
  IF p_codigos_activos_totales IS NOT NULL THEN
    SELECT COALESCE(ARRAY_AGG(DISTINCT UPPER(BTRIM(c))), ARRAY[]::TEXT[])
    INTO v_codigos_totales_norm
    FROM unnest(p_codigos_activos_totales) AS c
    WHERE c IS NOT NULL AND BTRIM(c) <> '';

    IF cardinality(v_codigos_totales_norm) > 0 THEN
      UPDATE public.clientes
      SET activo = false
      WHERE activo = true
        AND NOT (codigo_cliente = ANY(v_codigos_totales_norm));
      GET DIAGNOSTICS v_desactivados = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'procesados', v_procesados,
    'sin_vendedor_asignado', v_sin_vendedor,
    'desactivados', v_desactivados,
    'codigos_vendedor_faltantes', to_jsonb(v_vendedores_faltantes)
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_sincronizar_clientes(JSONB, TEXT[]) IS
  'Sincroniza lotes de clientes vía UPSERT idempotente, enlaza vendedor_id y reconcilia cartera sin borrado físico.';

REVOKE EXECUTE ON FUNCTION public.rpc_sincronizar_clientes(JSONB, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_sincronizar_clientes(JSONB, TEXT[]) TO authenticated, service_role;
