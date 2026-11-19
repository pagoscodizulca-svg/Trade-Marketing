-- =============================================================================
-- HITO 3 — MAESTROS COMERCIALES (`cadenas_comerciales`, `zonas`, GEOCERCA EN
-- `clientes`) Y RPCs TRANSACCIONALES PARA MATRIZ DE RUTAS (`ScheduleMatrixView`)
-- Archivo: supabase/migrations/20261118000600_hito3_maestros_cadenas_zonas_y_rpc_matriz.sql
--
-- Cierra:
--   B-05  Tablas maestras `cadenas_comerciales` y `zonas` con aislamiento por
--         `sucursal` + RLS forzoso, y columnas `cadena_id`, `zona_id` y
--         `radio_geocerca_m` en `public.clientes`.
--   B-06  RPCs idempotentes sobre `public.cronograma_degustaciones` y
--         `public.rutas_promotoras` para alta, edición, llenado por lote y
--         cancelación lógica (respetando el candado histórico sin borrado físico).
--
-- Reglas de integridad:
--   * Forward-only e idempotente. Sin comandos destructivos ni borrado de datos.
--   * Depende de `20261118000400_hito1_identidad_unica_y_aislamiento_sucursales.sql`.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. TABLA MAESTRA: `public.cadenas_comerciales`
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.cadenas_comerciales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  tipo_canal TEXT NOT NULL DEFAULT 'Supermercado',
  sucursal public.sucursal_codigo,
  activo BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cadenas_codigo_normalizado
    CHECK (codigo = UPPER(BTRIM(codigo)) AND LENGTH(codigo) > 0),
  CONSTRAINT chk_cadenas_nombre_no_vacio
    CHECK (LENGTH(BTRIM(nombre)) > 0),
  CONSTRAINT chk_cadenas_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

COMMENT ON TABLE public.cadenas_comerciales IS
  'Catálogo maestro de cadenas comerciales y grupos de PDV con aislamiento por sucursal (ZULIA / VALENCIA).';

CREATE INDEX IF NOT EXISTS idx_cadenas_comerciales_sucursal
  ON public.cadenas_comerciales (sucursal);

CREATE INDEX IF NOT EXISTS idx_cadenas_comerciales_activo
  ON public.cadenas_comerciales (activo);

CREATE INDEX IF NOT EXISTS idx_cadenas_comerciales_nombre
  ON public.cadenas_comerciales (lower(nombre));

DROP TRIGGER IF EXISTS trg_cadenas_comerciales_set_updated_at ON public.cadenas_comerciales;
CREATE TRIGGER trg_cadenas_comerciales_set_updated_at
  BEFORE UPDATE ON public.cadenas_comerciales
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_maestros_set_updated_at();

DROP TRIGGER IF EXISTS trg_hito3_sellar_sucursal_cadenas ON public.cadenas_comerciales;
CREATE TRIGGER trg_hito3_sellar_sucursal_cadenas
  BEFORE INSERT OR UPDATE ON public.cadenas_comerciales
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.cadenas_comerciales FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cadenas_comerciales TO authenticated;

ALTER TABLE public.cadenas_comerciales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cadenas_comerciales FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cadenas_comerciales_select_sucursal ON public.cadenas_comerciales;
CREATE POLICY cadenas_comerciales_select_sucursal
  ON public.cadenas_comerciales
  FOR SELECT
  TO authenticated
  USING ((SELECT public.tiene_acceso_sucursal(sucursal)));

DROP POLICY IF EXISTS cadenas_comerciales_insert_coord_admin ON public.cadenas_comerciales;
CREATE POLICY cadenas_comerciales_insert_coord_admin
  ON public.cadenas_comerciales
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS cadenas_comerciales_update_coord_admin ON public.cadenas_comerciales;
CREATE POLICY cadenas_comerciales_update_coord_admin
  ON public.cadenas_comerciales
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- =============================================================================
-- 2. TABLA MAESTRA: `public.zonas`
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.zonas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  ciudad TEXT,
  estado TEXT,
  sucursal public.sucursal_codigo,
  activo BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_zonas_codigo_normalizado
    CHECK (codigo = UPPER(BTRIM(codigo)) AND LENGTH(codigo) > 0),
  CONSTRAINT chk_zonas_nombre_no_vacio
    CHECK (LENGTH(BTRIM(nombre)) > 0),
  CONSTRAINT chk_zonas_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

COMMENT ON TABLE public.zonas IS
  'Catálogo maestro de zonas geográficas y territorios comerciales con aislamiento por sucursal.';

CREATE INDEX IF NOT EXISTS idx_zonas_sucursal
  ON public.zonas (sucursal);

CREATE INDEX IF NOT EXISTS idx_zonas_activo
  ON public.zonas (activo);

CREATE INDEX IF NOT EXISTS idx_zonas_nombre
  ON public.zonas (lower(nombre));

DROP TRIGGER IF EXISTS trg_zonas_set_updated_at ON public.zonas;
CREATE TRIGGER trg_zonas_set_updated_at
  BEFORE UPDATE ON public.zonas
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_maestros_set_updated_at();

DROP TRIGGER IF EXISTS trg_hito3_sellar_sucursal_zonas ON public.zonas;
CREATE TRIGGER trg_hito3_sellar_sucursal_zonas
  BEFORE INSERT OR UPDATE ON public.zonas
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.zonas FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.zonas TO authenticated;

ALTER TABLE public.zonas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zonas FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zonas_select_sucursal ON public.zonas;
CREATE POLICY zonas_select_sucursal
  ON public.zonas
  FOR SELECT
  TO authenticated
  USING ((SELECT public.tiene_acceso_sucursal(sucursal)));

DROP POLICY IF EXISTS zonas_insert_coord_admin ON public.zonas;
CREATE POLICY zonas_insert_coord_admin
  ON public.zonas
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS zonas_update_coord_admin ON public.zonas;
CREATE POLICY zonas_update_coord_admin
  ON public.zonas
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- =============================================================================
-- 3. EXTENSIÓN NO DESTRUCTIVA DE `public.clientes`: cadena_id, zona_id, radio_geocerca_m
-- =============================================================================
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS cadena_id UUID REFERENCES public.cadenas_comerciales(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS zona_id UUID REFERENCES public.zonas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS radio_geocerca_m INTEGER NOT NULL DEFAULT 150;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_clientes_radio_geocerca_m'
      AND conrelid = 'public.clientes'::regclass
  ) THEN
    ALTER TABLE public.clientes
      ADD CONSTRAINT chk_clientes_radio_geocerca_m
      CHECK (radio_geocerca_m >= 25 AND radio_geocerca_m <= 5000);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clientes_cadena_id
  ON public.clientes (cadena_id)
  WHERE cadena_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clientes_zona_id
  ON public.clientes (zona_id)
  WHERE zona_id IS NOT NULL;

COMMENT ON COLUMN public.clientes.cadena_id IS
  'Referencia opcional al catálogo normalizado public.cadenas_comerciales.';
COMMENT ON COLUMN public.clientes.zona_id IS
  'Referencia opcional al catálogo normalizado public.zonas.';
COMMENT ON COLUMN public.clientes.radio_geocerca_m IS
  'Radio de geocerca GPS permitido en metros para check-in de campo (25 m a 5000 m, por defecto 150 m).';

-- Actualizar `rpc_sincronizar_clientes` para preservar/aceptar cadena_id, zona_id y radio_geocerca_m
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
  v_mi_sucursal public.sucursal_codigo := (SELECT public.obtener_mi_sucursal());
BEGIN
  IF NOT (SELECT public.is_coordinadora_or_admin()) THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol coordinacion o super_admin activo para sincronizar clientes.'
      USING ERRCODE = '42501';
  END IF;

  IF p_registros IS NOT NULL AND jsonb_typeof(p_registros) <> 'array' THEN
    RAISE EXCEPTION 'El parámetro p_registros debe ser un arreglo JSONB.'
      USING ERRCODE = '22023';
  END IF;

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
      CASE
        WHEN (elem ->> 'cadena_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN (elem ->> 'cadena_id')::UUID
        ELSE NULL
      END AS cadena_id,
      CASE
        WHEN (elem ->> 'zona_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN (elem ->> 'zona_id')::UUID
        ELSE NULL
      END AS zona_id,
      CASE
        WHEN (elem ->> 'radio_geocerca_m') ~ '^[0-9]+$'
          AND ((elem ->> 'radio_geocerca_m')::INTEGER BETWEEN 25 AND 5000)
        THEN (elem ->> 'radio_geocerca_m')::INTEGER
        ELSE NULL
      END AS radio_geocerca_m,
      NULLIF(UPPER(BTRIM(COALESCE(elem ->> 'codigo_vendedor', ''))), '') AS codigo_vendedor,
      CASE
        WHEN v_mi_sucursal IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
          THEN v_mi_sucursal
        ELSE COALESCE(
          public.fn_normalizar_sucursal_codigo(elem ->> 'sucursal'),
          public.fn_inferir_sucursal_codigo(
            concat_ws(' | ', elem ->> 'estado', elem ->> 'ciudad', elem ->> 'zona', elem ->> 'ruta', elem ->> 'direccion')
          )
        )
      END AS sucursal_resuelta,
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
      cadena_id,
      zona_id,
      radio_geocerca_m,
      codigo_vendedor,
      CASE
        WHEN sucursal_resuelta IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
          THEN sucursal_resuelta
        ELSE NULL
      END AS sucursal,
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
      cadena_id,
      zona_id,
      radio_geocerca_m,
      vendedor_id,
      codigo_vendedor,
      sucursal,
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
      d.cadena_id,
      d.zona_id,
      COALESCE(d.radio_geocerca_m, 150),
      v.id AS vendedor_id,
      d.codigo_vendedor,
      d.sucursal,
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
      cadena_id = COALESCE(EXCLUDED.cadena_id, public.clientes.cadena_id),
      zona_id = COALESCE(EXCLUDED.zona_id, public.clientes.zona_id),
      radio_geocerca_m = CASE
        WHEN EXCLUDED.radio_geocerca_m IS DISTINCT FROM 150 THEN EXCLUDED.radio_geocerca_m
        ELSE COALESCE(public.clientes.radio_geocerca_m, 150)
      END,
      vendedor_id = CASE
        WHEN EXCLUDED.codigo_vendedor IS NOT NULL THEN EXCLUDED.vendedor_id
        ELSE public.clientes.vendedor_id
      END,
      codigo_vendedor = COALESCE(EXCLUDED.codigo_vendedor, public.clientes.codigo_vendedor),
      sucursal = COALESCE(public.clientes.sucursal, EXCLUDED.sucursal),
      activo = true,
      metadata = COALESCE(public.clientes.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      ultima_sincronizacion = v_now
    RETURNING codigo_cliente
  )
  SELECT COUNT(*)::INTEGER
  INTO v_procesados
  FROM upserted;

  IF p_codigos_activos_totales IS NOT NULL THEN
    SELECT COALESCE(ARRAY_AGG(DISTINCT UPPER(BTRIM(c))), ARRAY[]::TEXT[])
    INTO v_codigos_totales_norm
    FROM unnest(p_codigos_activos_totales) AS c
    WHERE c IS NOT NULL AND BTRIM(c) <> '';

    IF cardinality(v_codigos_totales_norm) > 0 THEN
      UPDATE public.clientes cl
      SET activo = false
      WHERE cl.activo = true
        AND (SELECT public.tiene_acceso_sucursal(cl.sucursal))
        AND NOT (cl.codigo_cliente = ANY(v_codigos_totales_norm));
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

REVOKE EXECUTE ON FUNCTION public.rpc_sincronizar_clientes(JSONB, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_sincronizar_clientes(JSONB, TEXT[]) TO authenticated, service_role;

-- =============================================================================
-- 4. RPCs DE PERSISTENCIA PARA `ScheduleMatrixView` (B-06)
--    - `rpc_upsert_matriz_cronograma_lote`: alta, edición y llenado por lote
--      en `public.cronograma_degustaciones` (proyectando a `rutas_promotoras`
--      cuando hay `promotora_id` asignada).
--    - `rpc_cancelar_matriz_cronograma_lote`: cancelación 100% LÓGICA
--      (respeta el candado histórico; jamás ejecuta borrado físico).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_upsert_matriz_cronograma_lote(
  p_filas JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_elem JSONB;
  v_actor TEXT;
  v_id UUID;
  v_fecha DATE;
  v_turno TEXT;
  v_hora_inicio TEXT;
  v_hora_fin TEXT;
  v_cliente_nombre TEXT;
  v_cliente_codigo TEXT;
  v_zona_direccion TEXT;
  v_producto_resumen TEXT;
  v_productos JSONB;
  v_cantidad_kilos NUMERIC(10, 2);
  v_personas_estimadas INTEGER;
  v_insumos JSONB;
  v_vendedor_fdv TEXT;
  v_promotora_id UUID;
  v_observaciones TEXT;
  v_estado TEXT;
  v_hash TEXT;
  v_existing_id UUID;
  v_existing_estado TEXT;
  v_conflict_cliente TEXT;
  v_saved_row public.cronograma_degustaciones%ROWTYPE;
  v_insertadas INTEGER := 0;
  v_actualizadas INTEGER := 0;
  v_resultados JSONB := '[]'::jsonb;
BEGIN
  IF NOT (SELECT public.is_coordinadora_or_admin()) THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol coordinacion o super_admin activo para persistir la matriz.'
      USING ERRCODE = '42501';
  END IF;

  IF p_filas IS NULL OR jsonb_typeof(p_filas) <> 'array' THEN
    RAISE EXCEPTION 'El parámetro p_filas debe ser un arreglo JSONB no vacío.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_filas) = 0 OR jsonb_array_length(p_filas) > 300 THEN
    RAISE EXCEPTION 'El lote de la matriz debe contener entre 1 y 300 filas.'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''), 'Coordinación Trade')
  INTO v_actor
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
  LIMIT 1;
  v_actor := COALESCE(v_actor, 'Coordinación Trade');

  FOR v_elem IN SELECT elem FROM jsonb_array_elements(p_filas) AS elem LOOP
    v_id := CASE
      WHEN COALESCE(v_elem ->> 'id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (v_elem ->> 'id')::UUID
      ELSE NULL
    END;

    IF NOT (COALESCE(v_elem ->> 'fecha', '') ~ '^\d{4}-\d{2}-\d{2}$') THEN
      RAISE EXCEPTION 'Fecha inválida en fila de matriz (%). Se requiere formato YYYY-MM-DD.', COALESCE(v_elem ->> 'fecha', 'NULL')
        USING ERRCODE = '22007';
    END IF;
    v_fecha := (v_elem ->> 'fecha')::DATE;

    v_turno := UPPER(BTRIM(COALESCE(v_elem ->> 'turno', 'MAÑANA')));
    IF v_turno = 'MANANA' THEN v_turno := 'MAÑANA'; END IF;
    IF v_turno NOT IN ('MAÑANA', 'TARDE', 'COMPLETO') THEN
      RAISE EXCEPTION 'Turno inválido en matriz (%). Valores permitidos: MAÑANA, TARDE, COMPLETO.', v_turno
        USING ERRCODE = '22023';
    END IF;

    v_hora_inicio := COALESCE(
      NULLIF(BTRIM(COALESCE(v_elem ->> 'hora_inicio', '')), ''),
      CASE v_turno WHEN 'TARDE' THEN '14:00' WHEN 'COMPLETO' THEN '09:00' ELSE '09:00' END
    );
    v_hora_fin := COALESCE(
      NULLIF(BTRIM(COALESCE(v_elem ->> 'hora_fin', '')), ''),
      CASE v_turno WHEN 'TARDE' THEN '18:00' WHEN 'COMPLETO' THEN '17:00' ELSE '13:00' END
    );

    v_cliente_nombre := BTRIM(COALESCE(v_elem ->> 'cliente_nombre', ''));
    IF v_cliente_nombre = '' THEN
      RAISE EXCEPTION 'El nombre del cliente / PDV es obligatorio en cada fila de la matriz.'
        USING ERRCODE = '22023';
    END IF;
    v_cliente_codigo := UPPER(BTRIM(COALESCE(v_elem ->> 'cliente_codigo', '')));
    v_zona_direccion := BTRIM(COALESCE(v_elem ->> 'zona_direccion', ''));

    v_producto_resumen := BTRIM(COALESCE(v_elem ->> 'producto_resumen', ''));
    IF v_producto_resumen = '' THEN
      RAISE EXCEPTION 'El producto principal es obligatorio para el cliente "%".', v_cliente_nombre
        USING ERRCODE = '22023';
    END IF;

    v_productos := CASE
      WHEN jsonb_typeof(v_elem -> 'productos') = 'array' AND jsonb_array_length(v_elem -> 'productos') > 0
      THEN v_elem -> 'productos'
      ELSE jsonb_build_array(v_producto_resumen)
    END;

    v_cantidad_kilos := GREATEST(
      0.10,
      COALESCE(
        CASE WHEN (v_elem ->> 'cantidad_kilos') ~ '^[0-9]+(\.[0-9]+)?$' THEN (v_elem ->> 'cantidad_kilos')::NUMERIC(10, 2) END,
        1.00
      )
    );
    v_personas_estimadas := GREATEST(
      0,
      COALESCE(
        CASE WHEN (v_elem ->> 'personas_estimadas') ~ '^[0-9]+$' THEN (v_elem ->> 'personas_estimadas')::INTEGER END,
        0
      )
    );
    v_insumos := CASE
      WHEN jsonb_typeof(v_elem -> 'insumos_calculados') = 'object' THEN v_elem -> 'insumos_calculados'
      ELSE '{}'::jsonb
    END;
    v_vendedor_fdv := BTRIM(COALESCE(v_elem ->> 'vendedor_fdv', ''));
    v_observaciones := BTRIM(COALESCE(v_elem ->> 'observaciones', ''));

    v_promotora_id := CASE
      WHEN COALESCE(v_elem ->> 'promotora_id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (v_elem ->> 'promotora_id')::UUID
      ELSE NULL
    END;

    -- Localizar fila existente por UUID o por slot activo (cliente + fecha + turno) dentro de la sede del actor
    v_existing_id := NULL;
    v_existing_estado := NULL;

    IF v_id IS NOT NULL THEN
      SELECT c.id, c.estado
      INTO v_existing_id, v_existing_estado
      FROM public.cronograma_degustaciones c
      WHERE c.id = v_id
        AND (SELECT public.tiene_acceso_sucursal(c.sucursal))
      LIMIT 1;
    END IF;

    IF v_existing_id IS NULL THEN
      SELECT c.id, c.estado
      INTO v_existing_id, v_existing_estado
      FROM public.cronograma_degustaciones c
      WHERE lower(btrim(c.cliente_nombre)) = lower(v_cliente_nombre)
        AND c.fecha = v_fecha
        AND c.turno = v_turno
        AND COALESCE(c.en_historial, false) = false
        AND c.estado NOT IN ('RECHAZADA', 'CANCELADA', 'NO_AUTORIZADA')
        AND (SELECT public.tiene_acceso_sucursal(c.sucursal))
      LIMIT 1;
    END IF;

    -- Validar que la promotora no quede duplicada en el mismo día y jornada
    IF v_promotora_id IS NOT NULL THEN
      SELECT c.cliente_nombre
      INTO v_conflict_cliente
      FROM public.cronograma_degustaciones c
      WHERE c.promotora_id = v_promotora_id
        AND c.fecha = v_fecha
        AND c.turno = v_turno
        AND COALESCE(c.en_historial, false) = false
        AND c.estado NOT IN ('RECHAZADA', 'CANCELADA', 'NO_AUTORIZADA')
        AND (v_existing_id IS NULL OR c.id <> v_existing_id)
      LIMIT 1;

      IF v_conflict_cliente IS NOT NULL THEN
        RAISE EXCEPTION 'Conflicto de jornada: la promotora ya está asignada en "%" el % (%).',
          v_conflict_cliente, v_fecha, v_turno
          USING ERRCODE = '23505';
      END IF;
    END IF;

    -- Estado seguro respetando el candado `chk_cronograma_aprobada_requiere_promotora`
    IF v_existing_estado IN ('EN_CURSO', 'COMPLETADA') THEN
      v_estado := v_existing_estado;
    ELSIF v_promotora_id IS NOT NULL THEN
      v_estado := 'APROBADA';
    ELSE
      v_estado := 'PENDIENTE_APROBACION';
    END IF;

    v_hash := lower(btrim(COALESCE(
      NULLIF(BTRIM(COALESCE(v_elem ->> 'idempotency_hash', '')), ''),
      md5(concat_ws('|', v_fecha::text, v_turno, lower(v_cliente_nombre), lower(v_producto_resumen)))
    )));

    IF v_existing_id IS NOT NULL THEN
      UPDATE public.cronograma_degustaciones
      SET
        fecha = v_fecha,
        turno = v_turno,
        hora_inicio = v_hora_inicio,
        hora_fin = v_hora_fin,
        cliente_nombre = v_cliente_nombre,
        cliente_codigo = COALESCE(NULLIF(v_cliente_codigo, ''), cliente_codigo),
        zona_direccion = COALESCE(NULLIF(v_zona_direccion, ''), zona_direccion),
        producto_resumen = v_producto_resumen,
        productos = v_productos,
        cantidad_kilos = v_cantidad_kilos,
        personas_estimadas = v_personas_estimadas,
        insumos_calculados = v_insumos,
        vendedor_fdv = COALESCE(NULLIF(v_vendedor_fdv, ''), vendedor_fdv),
        promotora_id = v_promotora_id,
        observaciones = v_observaciones,
        estado = v_estado,
        aprobado_por = CASE WHEN v_estado = 'APROBADA' THEN COALESCE(aprobado_por, v_actor) ELSE aprobado_por END
      WHERE id = v_existing_id
        AND COALESCE(en_historial, false) = false
      RETURNING * INTO v_saved_row;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'No se puede modificar el registro (%) porque ya fue archivado en Historial.', v_existing_id
          USING ERRCODE = '42501';
      END IF;

      v_actualizadas := v_actualizadas + 1;
    ELSE
      INSERT INTO public.cronograma_degustaciones (
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
        promotora_id,
        observaciones,
        estado,
        aprobado_por
      )
      VALUES (
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
        v_promotora_id,
        v_observaciones,
        v_estado,
        CASE WHEN v_estado = 'APROBADA' THEN v_actor ELSE NULL END
      )
      RETURNING * INTO v_saved_row;

      v_insertadas := v_insertadas + 1;
    END IF;

    v_resultados := v_resultados || jsonb_build_object(
      'id', v_saved_row.id,
      'client_temp_id', v_elem ->> 'client_temp_id',
      'cliente_nombre', v_saved_row.cliente_nombre,
      'fecha', v_saved_row.fecha,
      'turno', v_saved_row.turno,
      'estado', v_saved_row.estado,
      'promotora_id', v_saved_row.promotora_id,
      'promotora_nombre', v_saved_row.promotora_nombre,
      'sucursal', v_saved_row.sucursal
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'insertadas', v_insertadas,
    'actualizadas', v_actualizadas,
    'filas', v_resultados
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_upsert_matriz_cronograma_lote(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_matriz_cronograma_lote(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_cancelar_matriz_cronograma_lote(
  p_ids UUID[],
  p_motivo TEXT DEFAULT 'CANCELADO_DESDE_MATRIZ'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_actor TEXT;
  v_motivo TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_motivo, '')), ''), 'CANCELADO_DESDE_MATRIZ');
  v_cancelados UUID[] := ARRAY[]::UUID[];
  v_preservados INTEGER := 0;
BEGIN
  IF NOT (SELECT public.is_coordinadora_or_admin()) THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol coordinacion o super_admin activo para cancelar registros de la matriz.'
      USING ERRCODE = '42501';
  END IF;

  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'canceladas', 0,
      'preservadas_historicas', 0,
      'ids_cancelados', '[]'::jsonb
    );
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''), 'Coordinación Trade')
  INTO v_actor
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
  LIMIT 1;
  v_actor := COALESCE(v_actor, 'Coordinación Trade');

  -- Contar filas que se preservan intactas por candado histórico o cierre operativo
  SELECT COUNT(*)::INTEGER
  INTO v_preservados
  FROM public.cronograma_degustaciones c
  WHERE c.id = ANY(p_ids)
    AND (SELECT public.tiene_acceso_sucursal(c.sucursal))
    AND (COALESCE(c.en_historial, false) = true OR c.estado = 'COMPLETADA');

  -- Cancelación 100% LÓGICA (jamás borrado físico)
  WITH canceladas AS (
    UPDATE public.cronograma_degustaciones c
    SET
      estado = 'CANCELADA',
      motivo_rechazo = v_motivo,
      rechazado_por = v_actor,
      fecha_rechazo = now(),
      en_historial = true,
      archivado_en = now(),
      motivo_archivo = 'CANCELACION_MATRIZ',
      updated_at = now()
    WHERE c.id = ANY(p_ids)
      AND (SELECT public.tiene_acceso_sucursal(c.sucursal))
      AND COALESCE(c.en_historial, false) = false
      AND c.estado NOT IN ('COMPLETADA', 'CANCELADA', 'RECHAZADA')
    RETURNING c.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
  INTO v_cancelados
  FROM canceladas;

  -- Asegurar reflejo lógico inmediato en `public.rutas_promotoras` sin borrado físico
  IF cardinality(v_cancelados) > 0 THEN
    UPDATE public.rutas_promotoras rp
    SET
      estado_ruta = 'CANCELADA',
      updated_at = now()
    WHERE rp.cronograma_id = ANY(v_cancelados)
      AND (SELECT public.tiene_acceso_sucursal(rp.sucursal))
      AND rp.estado_ruta <> 'COMPLETADA';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'canceladas', COALESCE(cardinality(v_cancelados), 0),
    'preservadas_historicas', v_preservados,
    'ids_cancelados', to_jsonb(v_cancelados)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_cancelar_matriz_cronograma_lote(UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_cancelar_matriz_cronograma_lote(UUID[], TEXT) TO authenticated, service_role;

COMMIT;
