-- ==============================================================================
-- MIGRACIÓN SQL 100% ADITIVA E IDEMPOTENTE
-- Flujo Atómico e Idempotente:
--   1) Grecia (OCCIDENTE): Aprobar en Degustaciones (`public.surveys`)
--      -> Módulo 2 (`public.cronograma_degustaciones`)
--      -> App Promotoras (`public.rutas_promotoras`)
--      -> App Chofer Occidente (`public.entregas_degustacion`, chofer_sede='OCCIDENTE')
--      (Conservando carga manual en Módulo 2 con el mismo despacho atómico)
--   2) María (CENTRO y ANDES): Carga Manual exclusiva en Módulo 2
--      -> App Promotoras (`public.rutas_promotoras`)
--      -> App Chofer Valencia (`public.entregas_degustacion`, sucursal='VALENCIA', chofer_sede='VALENCIA')
--
-- Archivos espejo:
--   - supabase/migrations/20261204000100_mod2_aprobacion_y_despacho_ruta_chofer.sql
--   - sql/mod2_aprobacion_y_despacho_ruta_chofer.sql
--
-- Garantías de Producción:
--   - CERO DDL/DML destructivo (sin DROP TABLE, sin TRUNCATE, sin DELETE masivos).
--   - CERO secretos/contraseñas.
--   - CERO DISABLE ROW LEVEL SECURITY y CERO user_metadata en autorización.
--   - Todas las funciones SECURITY DEFINER usan SET search_path = public.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. COLUMNAS ADITIVAS E ÍNDICES ÚNICOS PARCIALES (IDEMPOTENCIA 0 DUPLICADOS)
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    ALTER TABLE public.cronograma_degustaciones
      ADD COLUMN IF NOT EXISTS degustacion_origen_id UUID,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS chofer_sede TEXT;

    UPDATE public.cronograma_degustaciones
    SET degustacion_origen_id = BTRIM(survey_origen_id)::UUID
    WHERE degustacion_origen_id IS NULL
      AND survey_origen_id IS NOT NULL
      AND BTRIM(survey_origen_id) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    UPDATE public.cronograma_degustaciones
    SET chofer_sede = CASE
      WHEN UPPER(BTRIM(COALESCE(region, ''))) IN ('VALENCIA', 'CENTRO', 'ANDES', 'CAPITAL')
        OR UPPER(BTRIM(COALESCE(sucursal, ''))) IN ('VALENCIA', 'CENTRO', 'CAPITAL')
        THEN 'VALENCIA'
      WHEN UPPER(BTRIM(COALESCE(region, ''))) IN ('OCCIDENTE', 'ZULIA')
        OR UPPER(BTRIM(COALESCE(sucursal, ''))) IN ('ZULIA', 'OCCIDENTE')
        THEN 'OCCIDENTE'
      ELSE NULL
    END
    WHERE NULLIF(BTRIM(COALESCE(chofer_sede, '')), '') IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cronograma_degustaciones_degustacion_origen_uniq
      ON public.cronograma_degustaciones (degustacion_origen_id)
      WHERE degustacion_origen_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cronograma_degustaciones_survey_origen_uniq
      ON public.cronograma_degustaciones (survey_origen_id)
      WHERE survey_origen_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_cronograma_degustaciones_chofer_sede
      ON public.cronograma_degustaciones (chofer_sede)
      WHERE chofer_sede IS NOT NULL;
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    ALTER TABLE public.rutas_promotoras
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS auth_user_id UUID;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_rutas_promotoras_cronograma_id_uniq
      ON public.rutas_promotoras (cronograma_id)
      WHERE cronograma_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_email_fecha
      ON public.rutas_promotoras (LOWER(BTRIM(COALESCE(promotora_email, ''))), fecha);
  END IF;

  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    ALTER TABLE public.entregas_degustacion
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS chofer_sede TEXT;

    UPDATE public.entregas_degustacion
    SET chofer_sede = CASE
      WHEN UPPER(BTRIM(COALESCE(region, ''))) IN ('VALENCIA', 'CENTRO', 'ANDES', 'CAPITAL')
        OR UPPER(BTRIM(COALESCE(sucursal, ''))) IN ('VALENCIA', 'CENTRO', 'CAPITAL')
        THEN 'VALENCIA'
      WHEN UPPER(BTRIM(COALESCE(region, ''))) IN ('OCCIDENTE', 'ZULIA')
        OR UPPER(BTRIM(COALESCE(sucursal, ''))) IN ('ZULIA', 'OCCIDENTE')
        THEN 'OCCIDENTE'
      ELSE NULL
    END
    WHERE NULLIF(BTRIM(COALESCE(chofer_sede, '')), '') IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_entregas_degustacion_cronograma_id_uniq
      ON public.entregas_degustacion (cronograma_id)
      WHERE cronograma_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_entregas_degustacion_chofer_sede_sucursal
      ON public.entregas_degustacion (chofer_sede, sucursal);
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 2. HELPERS DE ENRUTAMIENTO Y AISLAMIENTO CHOFER (OCCIDENTE VS VALENCIA)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trade_resolve_chofer_sede(
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_reg TEXT;
  v_suc TEXT;
BEGIN
  v_reg := public.fn_trade_normalize_region_token(p_region);
  v_suc := public.fn_trade_normalize_region_token(p_sucursal);

  IF v_reg IN ('CENTRO', 'ANDES') THEN
    RETURN 'VALENCIA';
  END IF;
  IF v_reg = 'OCCIDENTE' THEN
    RETURN 'OCCIDENTE';
  END IF;

  IF v_suc IN ('CENTRO', 'ANDES') THEN
    RETURN 'VALENCIA';
  END IF;
  IF v_suc = 'OCCIDENTE' THEN
    RETURN 'OCCIDENTE';
  END IF;

  IF UPPER(BTRIM(COALESCE(p_sucursal, ''))) IN ('VALENCIA', 'CENTRO', 'CAPITAL') THEN
    RETURN 'VALENCIA';
  END IF;
  IF UPPER(BTRIM(COALESCE(p_sucursal, ''))) IN ('ZULIA', 'OCCIDENTE') THEN
    RETURN 'OCCIDENTE';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_resolve_chofer_sede(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_resolve_chofer_sede(TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trade_format_chofer_day_label(p_fecha DATE)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_dow INT;
  v_day_name TEXT;
BEGIN
  IF p_fecha IS NULL THEN
    RETURN '';
  END IF;

  v_dow := EXTRACT(DOW FROM p_fecha)::INT;
  v_day_name := CASE v_dow
    WHEN 0 THEN 'DOMINGO'
    WHEN 1 THEN 'LUNES'
    WHEN 2 THEN 'MARTES'
    WHEN 3 THEN 'MIÉRCOLES'
    WHEN 4 THEN 'JUEVES'
    WHEN 5 THEN 'VIERNES'
    WHEN 6 THEN 'SÁBADO'
    ELSE ''
  END;

  RETURN v_day_name || ' ' || LPAD(EXTRACT(DAY FROM p_fecha)::INT::TEXT, 2, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_format_chofer_day_label(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_format_chofer_day_label(DATE) TO authenticated, service_role;

-- Actualizar `fn_trade_region_matches_actor` para admitir el hub logístico de Valencia
-- (`region = 'Andes'` + `sucursal = 'VALENCIA'`) sin falsas contradicciones, manteniendo
-- el bloqueo estricto contra cualquier cruce con `OCCIDENTE`.
CREATE OR REPLACE FUNCTION public.fn_trade_region_matches_actor(
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL,
  p_region_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_role TEXT;
  v_reg_from_text TEXT;
  v_reg_from_suc TEXT;
  v_reg_from_id TEXT;
  v_reg_desc TEXT;
  v_row_region TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  v_role := public.current_user_role();
  IF v_role = '__INACTIVE__' THEN
    RETURN false;
  END IF;

  IF public.is_global_admin() THEN
    RETURN true;
  END IF;

  v_reg_from_text := public.fn_trade_normalize_region_token(p_region);
  v_reg_from_suc := public.fn_trade_normalize_region_token(p_sucursal);
  v_reg_from_id := NULL;

  IF p_region_id IS NOT NULL AND to_regclass('public."Regiones"') IS NOT NULL THEN
    SELECT regi_desd INTO v_reg_desc
    FROM public."Regiones"
    WHERE id_regi = p_region_id
    LIMIT 1;
    v_reg_from_id := public.fn_trade_normalize_region_token(v_reg_desc);
  END IF;

  -- Contradicción estricta si se mezcla OCCIDENTE con otra región o si region_id discrepa del texto
  IF v_reg_from_text IS NOT NULL AND v_reg_from_id IS NOT NULL AND v_reg_from_text <> v_reg_from_id THEN
    RETURN false;
  END IF;

  IF v_reg_from_text IS NOT NULL AND v_reg_from_suc IS NOT NULL AND v_reg_from_text <> v_reg_from_suc THEN
    -- Único emparejamiento hub autorizado: activación ANDES despachada por sede VALENCIA (normalizada a CENTRO)
    IF NOT (v_reg_from_text = 'ANDES' AND v_reg_from_suc = 'CENTRO') THEN
      RETURN false;
    END IF;
  END IF;

  IF v_reg_from_suc IS NOT NULL AND v_reg_from_id IS NOT NULL AND v_reg_from_suc <> v_reg_from_id THEN
    IF NOT (v_reg_from_id = 'ANDES' AND v_reg_from_suc = 'CENTRO') THEN
      RETURN false;
    END IF;
  END IF;

  v_row_region := COALESCE(v_reg_from_text, v_reg_from_id, v_reg_from_suc);
  IF v_row_region IS NULL THEN
    RETURN false;
  END IF;

  RETURN public.can_access_region(v_row_region);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_region_matches_actor(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_region_matches_actor(TEXT, TEXT, UUID) TO authenticated, service_role;

-- Predicado estricto de enrutamiento para Choferes (Occidente vs Valencia) y Coordinadores:
--   - Admin Global: todo.
--   - Grecia (OCCIDENTE): solo chofer_sede = 'OCCIDENTE'.
--   - María (CENTRO + ANDES): solo chofer_sede = 'VALENCIA' (0 Occidente).
--   - Chofer Occidente (ZULIA / OCCIDENTE): solo chofer_sede = 'OCCIDENTE' (0 Valencia).
--   - Chofer Valencia (VALENCIA / CENTRO / ANDES): solo chofer_sede = 'VALENCIA' (0 Occidente).
CREATE OR REPLACE FUNCTION public.fn_trade_can_deliver_sede(
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL,
  p_chofer_sede TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_role TEXT;
  v_allowed TEXT[];
  v_row_sede TEXT;
  v_row_reg TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  v_role := public.current_user_role();
  IF v_role = '__INACTIVE__' THEN
    RETURN false;
  END IF;

  IF public.is_global_admin() THEN
    RETURN true;
  END IF;

  v_row_sede := COALESCE(
    NULLIF(UPPER(BTRIM(COALESCE(p_chofer_sede, ''))), ''),
    public.fn_trade_resolve_chofer_sede(p_region, p_sucursal)
  );
  v_row_reg := COALESCE(
    public.fn_trade_normalize_region_token(p_region),
    public.fn_trade_normalize_region_token(p_sucursal)
  );

  IF v_row_sede IS NULL AND v_row_reg IS NULL THEN
    RETURN false;
  END IF;

  v_allowed := public.current_user_regions();

  IF public.fn_trade_is_regional_coordinator() THEN
    IF v_allowed IS NULL OR array_length(v_allowed, 1) IS NULL THEN
      RETURN false;
    END IF;
    IF v_row_sede = 'OCCIDENTE' THEN
      RETURN 'OCCIDENTE' = ANY(v_allowed);
    END IF;
    IF v_row_sede = 'VALENCIA' THEN
      RETURN ('CENTRO' = ANY(v_allowed) OR 'ANDES' = ANY(v_allowed));
    END IF;
    RETURN v_row_reg IS NOT NULL AND v_row_reg = ANY(v_allowed);
  END IF;

  IF v_role IN ('chofer', 'logistica', 'despacho') THEN
    IF v_allowed IS NULL OR array_length(v_allowed, 1) IS NULL THEN
      RETURN false;
    END IF;
    IF v_row_sede = 'OCCIDENTE' THEN
      RETURN 'OCCIDENTE' = ANY(v_allowed);
    END IF;
    IF v_row_sede = 'VALENCIA' THEN
      RETURN ('CENTRO' = ANY(v_allowed) OR 'ANDES' = ANY(v_allowed));
    END IF;
    RETURN v_row_reg IS NOT NULL AND v_row_reg = ANY(v_allowed);
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_can_deliver_sede(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_can_deliver_sede(TEXT, TEXT, TEXT) TO authenticated, service_role;

-- Retrocompatibilidad del helper 2-arg existente
CREATE OR REPLACE FUNCTION public.fn_trade_can_deliver_region(
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.fn_trade_can_deliver_sede(p_region, p_sucursal, NULL);
$$;

REVOKE ALL ON FUNCTION public.fn_trade_can_deliver_region(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_can_deliver_region(TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 3. TRIGGER 1: APROBACIÓN DE DEGUSTACIÓN OCCIDENTE (GRECIA) -> MÓDULO 2
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trg_survey_aprobada_to_cronograma()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type_norm TEXT;
  v_comments JSONB := '{}'::JSONB;
  v_estado TEXT;
  v_reg_norm TEXT;
  v_fecha_txt TEXT;
  v_fecha DATE;
  v_turno_raw TEXT;
  v_turno TEXT;
  v_hora_ini TEXT;
  v_hora_fin TEXT;
  v_cliente TEXT;
  v_cliente_cod TEXT;
  v_zona TEXT;
  v_producto TEXT;
  v_qty_txt TEXT;
  v_qty NUMERIC := 1;
  v_vendedor TEXT;
  v_prom_nombre TEXT;
  v_prom_email TEXT;
  v_prom_auth_uid UUID := NULL;
  v_lookup_nombre TEXT;
  v_lookup_email TEXT;
  v_lookup_auth_uid UUID;
  v_obs TEXT;
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NULL THEN
    RETURN NEW;
  END IF;

  v_type_norm := TRANSLATE(UPPER(BTRIM(COALESCE(NEW.type, ''))), 'ÁÉÍÓÚÀÈÌÒÙ', 'AEIOUAEIOU');
  IF v_type_norm NOT LIKE '%DEGUSTACION%' THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF NEW.comments IS NOT NULL AND BTRIM(NEW.comments) <> '' THEN
      v_comments := NEW.comments::JSONB;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_comments := '{}'::JSONB;
  END;

  v_estado := UPPER(BTRIM(COALESCE(v_comments ->> 'estado', v_comments ->> 'status', '')));

  -- Si una degustación fue marcada como NO_AUTORIZADA / RECHAZADA / CANCELADA, cancelar lógicamente su fila vinculada
  IF v_estado IN ('NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA') THEN
    UPDATE public.cronograma_degustaciones
    SET estado = 'CANCELADA',
        updated_at = now()
    WHERE (survey_origen_id = NEW.id::TEXT OR degustacion_origen_id = NEW.id)
      AND estado <> 'CANCELADA';
    RETURN NEW;
  END IF;

  IF v_estado NOT IN ('APROBADA', 'APROBADO', 'ACEPTADA', 'AUTORIZADA') THEN
    RETURN NEW;
  END IF;

  -- Solo proyectar automáticamente solicitudes de OCCIDENTE (flujo de Grecia; María carga manualmente en Módulo 2)
  v_reg_norm := COALESCE(
    public.fn_trade_normalize_region_token(NEW.region),
    public.fn_trade_normalize_region_token(v_comments ->> 'region'),
    public.current_user_region()
  );
  IF v_reg_norm IS DISTINCT FROM 'OCCIDENTE' THEN
    RETURN NEW;
  END IF;

  v_fecha_txt := COALESCE(
    NULLIF(BTRIM(COALESCE(v_comments ->> 'fecha', '')), ''),
    NULLIF(BTRIM(COALESCE(v_comments ->> 'date', '')), ''),
    NULLIF(BTRIM(COALESCE(NEW.date::TEXT, '')), ''),
    to_char((now() AT TIME ZONE 'America/Caracas')::DATE, 'YYYY-MM-DD')
  );
  IF v_fecha_txt ~ '^\d{4}-\d{2}-\d{2}' THEN
    v_fecha := SUBSTRING(v_fecha_txt FROM 1 FOR 10)::DATE;
  ELSE
    v_fecha := (now() AT TIME ZONE 'America/Caracas')::DATE;
  END IF;

  v_turno_raw := TRANSLATE(
    UPPER(BTRIM(COALESCE(v_comments ->> 'turno', v_comments ->> 'shift', 'MAÑANA'))),
    'ÁÉÍÓÚ',
    'AEIOU'
  );
  IF v_turno_raw LIKE '%TARDE%' THEN
    v_turno := 'TARDE';
    v_hora_ini := '14:00';
    v_hora_fin := '18:00';
  ELSIF v_turno_raw LIKE '%COMPLETO%' THEN
    v_turno := 'COMPLETO';
    v_hora_ini := '09:00';
    v_hora_fin := '17:00';
  ELSE
    v_turno := 'MAÑANA';
    v_hora_ini := '09:00';
    v_hora_fin := '13:00';
  END IF;

  v_cliente := COALESCE(
    NULLIF(BTRIM(COALESCE(NEW.store, '')), ''),
    NULLIF(BTRIM(COALESCE(v_comments ->> 'client', v_comments ->> 'store', '')), ''),
    'PDV SIN NOMBRE'
  );
  v_cliente_cod := UPPER(BTRIM(COALESCE(v_comments ->> 'clienteCodigo', v_comments ->> 'codigo_cliente', '')));
  v_zona := COALESCE(
    NULLIF(BTRIM(COALESCE(v_comments ->> 'zona', v_comments ->> 'zone', v_comments ->> 'direccion', '')), ''),
    'OCCIDENTE'
  );
  v_producto := UPPER(COALESCE(
    NULLIF(BTRIM(COALESCE(NEW.product, '')), ''),
    NULLIF(BTRIM(COALESCE(v_comments ->> 'product', '')), ''),
    'MORTADELA'
  ));

  v_qty_txt := REPLACE(
    BTRIM(COALESCE(v_comments ->> 'cantidad', v_comments ->> 'requestedQty', v_comments ->> 'cantidad_kilos', '1')),
    ',',
    '.'
  );
  IF v_qty_txt ~ '^\d+(\.\d+)?$' THEN
    v_qty := GREATEST(0.1, v_qty_txt::NUMERIC);
  ELSE
    v_qty := 1;
  END IF;

  v_vendedor := COALESCE(
    NULLIF(BTRIM(COALESCE(v_comments ->> 'vendedor', v_comments ->> 'sellerName', '')), ''),
    'FDV CODIZULCA'
  );
  v_prom_nombre := COALESCE(
    NULLIF(BTRIM(COALESCE(v_comments ->> 'promotoraAsignada', v_comments ->> 'promotora', NEW.promoter, '')), ''),
    'POR ASIGNAR (Trade Marketing)'
  );
  v_prom_email := LOWER(BTRIM(COALESCE(v_comments ->> 'promotoraEmail', v_comments ->> 'promotora_email', '')));
  v_obs := COALESCE(
    NULLIF(BTRIM(COALESCE(v_comments ->> 'observaciones', v_comments ->> 'notes', '')), ''),
    ''
  );

  -- Enriquecer correo y auth_user_id desde `public.promotoras` sin sobrescribir si 0 filas
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT
      p.nombre_completo,
      LOWER(BTRIM(COALESCE(p.correo, ''))),
      p.auth_user_id
    INTO v_lookup_nombre, v_lookup_email, v_lookup_auth_uid
    FROM public.promotoras p
    WHERE (v_prom_email <> '' AND LOWER(BTRIM(COALESCE(p.correo, ''))) = v_prom_email)
       OR (v_prom_nombre <> '' AND LOWER(BTRIM(COALESCE(p.nombre_completo, ''))) = LOWER(BTRIM(v_prom_nombre)))
    ORDER BY CASE WHEN v_prom_email <> '' AND LOWER(BTRIM(COALESCE(p.correo, ''))) = v_prom_email THEN 0 ELSE 1 END ASC
    LIMIT 1;
    IF FOUND THEN
      v_prom_nombre := COALESCE(NULLIF(v_prom_nombre, ''), v_lookup_nombre);
      v_prom_email := COALESCE(NULLIF(v_prom_email, ''), v_lookup_email);
      v_prom_auth_uid := COALESCE(v_prom_auth_uid, v_lookup_auth_uid);
    END IF;
  END IF;

  IF v_prom_auth_uid IS NULL AND NEW.promotora_id IS NOT NULL
     AND BTRIM(NEW.promotora_id) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_prom_auth_uid := BTRIM(NEW.promotora_id)::UUID;
  END IF;

  INSERT INTO public.cronograma_degustaciones (
    fecha,
    turno,
    hora_inicio,
    hora_fin,
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
    promotora_nombre,
    promotora_email,
    observaciones,
    estado,
    sucursal,
    region,
    chofer_sede,
    survey_origen_id,
    degustacion_origen_id,
    idempotency_hash,
    updated_at
  ) VALUES (
    v_fecha,
    v_turno,
    v_hora_ini,
    v_hora_fin,
    v_cliente,
    v_cliente_cod,
    v_zona,
    LEFT(v_producto, 160),
    jsonb_build_array(LEFT(v_producto, 160)),
    v_qty,
    0,
    COALESCE(v_comments -> 'insumosCalculados', '{}'::JSONB),
    v_vendedor,
    v_prom_auth_uid,
    COALESCE(NULLIF(v_prom_nombre, ''), 'POR ASIGNAR (Trade Marketing)'),
    NULLIF(v_prom_email, ''),
    v_obs,
    'APROBADA',
    'ZULIA',
    'Occidente',
    'OCCIDENTE',
    NEW.id::TEXT,
    NEW.id,
    'survey_' || NEW.id::TEXT,
    now()
  )
  ON CONFLICT (survey_origen_id) WHERE survey_origen_id IS NOT NULL
  DO UPDATE SET
    fecha = EXCLUDED.fecha,
    turno = EXCLUDED.turno,
    hora_inicio = EXCLUDED.hora_inicio,
    hora_fin = EXCLUDED.hora_fin,
    cliente_nombre = EXCLUDED.cliente_nombre,
    cliente_codigo = EXCLUDED.cliente_codigo,
    zona_direccion = EXCLUDED.zona_direccion,
    producto_resumen = EXCLUDED.producto_resumen,
    productos = EXCLUDED.productos,
    cantidad_kilos = EXCLUDED.cantidad_kilos,
    vendedor_fdv = EXCLUDED.vendedor_fdv,
    promotora_id = COALESCE(EXCLUDED.promotora_id, public.cronograma_degustaciones.promotora_id),
    promotora_nombre = EXCLUDED.promotora_nombre,
    promotora_email = COALESCE(EXCLUDED.promotora_email, public.cronograma_degustaciones.promotora_email),
    observaciones = CASE
      WHEN NULLIF(BTRIM(COALESCE(EXCLUDED.observaciones, '')), '') IS NOT NULL THEN EXCLUDED.observaciones
      ELSE public.cronograma_degustaciones.observaciones
    END,
    estado = CASE
      WHEN public.cronograma_degustaciones.estado IN ('EN_CURSO', 'COMPLETADA') THEN public.cronograma_degustaciones.estado
      ELSE 'APROBADA'
    END,
    sucursal = 'ZULIA',
    region = 'Occidente',
    chofer_sede = 'OCCIDENTE',
    degustacion_origen_id = COALESCE(public.cronograma_degustaciones.degustacion_origen_id, NEW.id),
    updated_at = now();

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_survey_aprobada_to_cronograma() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_survey_aprobada_to_cronograma() TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('public.surveys') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_survey_aprobada_to_cronograma ON public.surveys;
    CREATE TRIGGER trg_survey_aprobada_to_cronograma
      AFTER INSERT OR UPDATE ON public.surveys
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_trg_survey_aprobada_to_cronograma();
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 4. TRIGGER 2 (UNIFICADO): MÓDULO 2 -> RUTA PROMOTORA + BANDEJA CHOFER (ATÓMICO)
--    Se dispara para TODA activación en Módulo 2:
--      - Aprobación automática de Grecia (Occidente -> Chofer Occidente)
--      - Carga manual de Grecia (Occidente -> Chofer Occidente)
--      - Carga manual de María (Centro/Andes -> Chofer Valencia)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_trg_cronograma_normalize_routing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reg_norm TEXT;
  v_sede TEXT;
BEGIN
  IF NEW.degustacion_origen_id IS NULL
     AND NEW.survey_origen_id IS NOT NULL
     AND BTRIM(NEW.survey_origen_id) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    NEW.degustacion_origen_id := BTRIM(NEW.survey_origen_id)::UUID;
  END IF;

  v_reg_norm := COALESCE(
    public.fn_trade_normalize_region_token(NEW.region),
    public.fn_trade_normalize_region_token(NEW.sucursal),
    public.current_user_region()
  );

  v_sede := COALESCE(
    NULLIF(UPPER(BTRIM(COALESCE(NEW.chofer_sede, ''))), ''),
    public.fn_trade_resolve_chofer_sede(NEW.region, NEW.sucursal),
    CASE
      WHEN v_reg_norm = 'OCCIDENTE' THEN 'OCCIDENTE'
      WHEN v_reg_norm IN ('CENTRO', 'ANDES') THEN 'VALENCIA'
      ELSE NULL
    END
  );

  IF NULLIF(BTRIM(COALESCE(NEW.region, '')), '') IS NULL THEN
    NEW.region := CASE
      WHEN v_reg_norm = 'ANDES' THEN 'Andes'
      WHEN v_reg_norm = 'CENTRO' THEN 'Centro'
      WHEN v_reg_norm = 'OCCIDENTE' THEN 'Occidente'
      WHEN v_sede = 'VALENCIA' THEN 'Centro'
      WHEN v_sede = 'OCCIDENTE' THEN 'Occidente'
      ELSE NEW.region
    END;
  END IF;

  IF v_sede = 'VALENCIA' THEN
    NEW.chofer_sede := 'VALENCIA';
    NEW.sucursal := 'VALENCIA';
  ELSIF v_sede = 'OCCIDENTE' THEN
    NEW.chofer_sede := 'OCCIDENTE';
    NEW.sucursal := 'ZULIA';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_cronograma_normalize_routing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_cronograma_normalize_routing() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trg_cronograma_dispatch_ruta_y_chofer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado TEXT := UPPER(BTRIM(COALESCE(NEW.estado, '')));
  v_sede TEXT;
  v_chofer_sucursal TEXT;
  v_chofer_turno TEXT;
  v_chofer_fecha TEXT;
  v_prom_nombre TEXT;
  v_prom_email TEXT;
  v_prom_auth_uid UUID := NULL;
  v_lookup_nombre TEXT;
  v_lookup_email TEXT;
  v_lookup_auth_uid UUID;
  v_has_promotora BOOLEAN := false;
  v_target_estado_ruta TEXT;
BEGIN
  IF v_estado IN ('CANCELADA', 'RECHAZADA', 'NO_AUTORIZADA') THEN
    IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
      UPDATE public.rutas_promotoras
      SET estado_ruta = 'CANCELADA',
          updated_at = now()
      WHERE cronograma_id = NEW.id
        AND estado_ruta <> 'COMPLETADA';
    END IF;
    RETURN NEW;
  END IF;

  IF v_estado NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN
    RETURN NEW;
  END IF;

  v_sede := COALESCE(
    NULLIF(UPPER(BTRIM(COALESCE(NEW.chofer_sede, ''))), ''),
    public.fn_trade_resolve_chofer_sede(NEW.region, NEW.sucursal),
    'OCCIDENTE'
  );
  v_chofer_sucursal := CASE WHEN v_sede = 'VALENCIA' THEN 'VALENCIA' ELSE 'ZULIA' END;

  v_prom_nombre := BTRIM(COALESCE(NEW.promotora_nombre, ''));
  v_prom_email := LOWER(BTRIM(COALESCE(NEW.promotora_email, '')));

  -- Resolver identidad completa de la promotora (`correo`, `auth_user_id`) desde `public.promotoras` sin sobrescribir si 0 filas
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT
      p.nombre_completo,
      LOWER(BTRIM(COALESCE(p.correo, ''))),
      p.auth_user_id
    INTO v_lookup_nombre, v_lookup_email, v_lookup_auth_uid
    FROM public.promotoras p
    WHERE (v_prom_email <> '' AND LOWER(BTRIM(COALESCE(p.correo, ''))) = v_prom_email)
       OR (NEW.promotora_id IS NOT NULL AND p.auth_user_id = NEW.promotora_id)
       OR (v_prom_nombre <> '' AND LOWER(BTRIM(COALESCE(p.nombre_completo, ''))) = LOWER(v_prom_nombre))
    ORDER BY
      CASE
        WHEN v_prom_email <> '' AND LOWER(BTRIM(COALESCE(p.correo, ''))) = v_prom_email THEN 0
        WHEN NEW.promotora_id IS NOT NULL AND p.auth_user_id = NEW.promotora_id THEN 1
        ELSE 2
      END ASC
    LIMIT 1;
    IF FOUND THEN
      v_prom_nombre := COALESCE(NULLIF(v_prom_nombre, ''), v_lookup_nombre);
      v_prom_email := COALESCE(NULLIF(v_prom_email, ''), v_lookup_email);
      v_prom_auth_uid := COALESCE(v_prom_auth_uid, v_lookup_auth_uid);
    END IF;
  END IF;

  -- Si `public.profiles` tiene cuenta confirmada para ese correo, vincular también `auth_user_id`
  IF v_prom_auth_uid IS NULL AND v_prom_email <> '' AND to_regclass('public.profiles') IS NOT NULL THEN
    SELECT pr.id INTO v_lookup_auth_uid
    FROM public.profiles pr
    WHERE LOWER(BTRIM(COALESCE(pr.email, ''))) = v_prom_email
    LIMIT 1;
    IF FOUND THEN
      v_prom_auth_uid := v_lookup_auth_uid;
    END IF;
  END IF;

  v_has_promotora := (
    v_prom_email <> ''
    OR NEW.promotora_id IS NOT NULL
    OR v_prom_auth_uid IS NOT NULL
    OR (
      v_prom_nombre <> ''
      AND UPPER(v_prom_nombre) NOT LIKE 'POR ASIGNAR%'
      AND UPPER(v_prom_nombre) NOT LIKE 'SIN ASIGNAR%'
    )
  );

  -- A) Despacho atómico e idempotente a App de Promotoras (`public.rutas_promotoras`)
  IF v_has_promotora AND to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    v_target_estado_ruta := CASE
      WHEN v_estado = 'EN_CURSO' THEN 'EN_CURSO'
      WHEN v_estado = 'COMPLETADA' THEN 'COMPLETADA'
      ELSE 'ASIGNADA'
    END;

    INSERT INTO public.rutas_promotoras (
      cronograma_id,
      fecha,
      turno,
      hora_inicio,
      hora_fin,
      cliente_nombre,
      cliente_codigo,
      zona_direccion,
      producto_resumen,
      productos,
      cantidad_kilos,
      vendedor_fdv,
      promotora_id,
      promotora_nombre,
      promotora_email,
      auth_user_id,
      estado_ruta,
      observaciones,
      region,
      sucursal,
      updated_at
    ) VALUES (
      NEW.id,
      NEW.fecha,
      NEW.turno,
      COALESCE(NULLIF(BTRIM(COALESCE(NEW.hora_inicio, '')), ''), '09:00'),
      COALESCE(NULLIF(BTRIM(COALESCE(NEW.hora_fin, '')), ''), '13:00'),
      NEW.cliente_nombre,
      COALESCE(NEW.cliente_codigo, ''),
      COALESCE(NEW.zona_direccion, ''),
      COALESCE(NEW.producto_resumen, ''),
      COALESCE(NEW.productos, '[]'::JSONB),
      COALESCE(NEW.cantidad_kilos, 1),
      COALESCE(NEW.vendedor_fdv, ''),
      COALESCE(NEW.promotora_id, v_prom_auth_uid),
      COALESCE(NULLIF(v_prom_nombre, ''), NEW.promotora_nombre, 'POR ASIGNAR (Trade Marketing)'),
      NULLIF(v_prom_email, ''),
      COALESCE(v_prom_auth_uid, NEW.promotora_id),
      v_target_estado_ruta,
      COALESCE(NEW.observaciones, ''),
      NEW.region,
      v_chofer_sucursal,
      now()
    )
    ON CONFLICT (cronograma_id) WHERE cronograma_id IS NOT NULL
    DO UPDATE SET
      fecha = EXCLUDED.fecha,
      turno = EXCLUDED.turno,
      hora_inicio = EXCLUDED.hora_inicio,
      hora_fin = EXCLUDED.hora_fin,
      cliente_nombre = EXCLUDED.cliente_nombre,
      cliente_codigo = EXCLUDED.cliente_codigo,
      zona_direccion = EXCLUDED.zona_direccion,
      producto_resumen = EXCLUDED.producto_resumen,
      productos = EXCLUDED.productos,
      cantidad_kilos = EXCLUDED.cantidad_kilos,
      vendedor_fdv = EXCLUDED.vendedor_fdv,
      promotora_id = COALESCE(EXCLUDED.promotora_id, public.rutas_promotoras.promotora_id),
      promotora_nombre = EXCLUDED.promotora_nombre,
      promotora_email = COALESCE(EXCLUDED.promotora_email, public.rutas_promotoras.promotora_email),
      auth_user_id = COALESCE(EXCLUDED.auth_user_id, public.rutas_promotoras.auth_user_id),
      estado_ruta = CASE
        WHEN public.rutas_promotoras.estado_ruta IN ('EN_CURSO', 'COMPLETADA') AND v_estado = 'APROBADA'
          THEN public.rutas_promotoras.estado_ruta
        ELSE EXCLUDED.estado_ruta
      END,
      observaciones = EXCLUDED.observaciones,
      region = EXCLUDED.region,
      sucursal = EXCLUDED.sucursal,
      updated_at = now();
  END IF;

  -- B) Despacho atómico e idempotente a App de Chofer (`public.entregas_degustacion`)
  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    v_chofer_turno := CASE
      WHEN UPPER(BTRIM(COALESCE(NEW.turno, ''))) = 'TARDE' THEN 'TARDE'
      ELSE 'MAÑANA'
    END;
    v_chofer_fecha := COALESCE(
      NULLIF(public.fn_trade_format_chofer_day_label(NEW.fecha), ''),
      to_char(NEW.fecha, 'YYYY-MM-DD')
    );

    INSERT INTO public.entregas_degustacion (
      id,
      cronograma_id,
      fecha,
      turno,
      numero_grupo_turno,
      cliente,
      producto,
      vendedor,
      promotora,
      stand_entregado,
      producto_entregado,
      completado,
      estado_logistico,
      notas_chofer,
      region,
      sucursal,
      chofer_sede,
      updated_at
    ) VALUES (
      gen_random_uuid()::TEXT,
      NEW.id,
      v_chofer_fecha,
      v_chofer_turno,
      v_chofer_turno || ' · ' || to_char(NEW.fecha, 'YYYY-MM-DD'),
      UPPER(BTRIM(COALESCE(NEW.cliente_nombre, 'PDV SIN NOMBRE'))),
      LEFT(UPPER(BTRIM(COALESCE(NEW.producto_resumen, 'DEGUSTACIÓN'))), 120),
      UPPER(BTRIM(COALESCE(NULLIF(BTRIM(COALESCE(NEW.vendedor_fdv, '')), ''), 'TRADE MARKETING'))),
      UPPER(BTRIM(COALESCE(NULLIF(v_prom_nombre, ''), NULLIF(BTRIM(COALESCE(NEW.promotora_nombre, '')), ''), 'POR ASIGNAR (TRADE MARKETING)'))),
      false,
      false,
      false,
      'PENDIENTE',
      COALESCE(NEW.observaciones, ''),
      NEW.region,
      v_chofer_sucursal,
      v_sede,
      now()
    )
    ON CONFLICT (cronograma_id) WHERE cronograma_id IS NOT NULL
    DO UPDATE SET
      fecha = EXCLUDED.fecha,
      turno = EXCLUDED.turno,
      numero_grupo_turno = EXCLUDED.numero_grupo_turno,
      cliente = EXCLUDED.cliente,
      producto = EXCLUDED.producto,
      vendedor = EXCLUDED.vendedor,
      promotora = EXCLUDED.promotora,
      region = EXCLUDED.region,
      sucursal = EXCLUDED.sucursal,
      chofer_sede = EXCLUDED.chofer_sede,
      notas_chofer = CASE
        WHEN NULLIF(BTRIM(COALESCE(public.entregas_degustacion.notas_chofer, '')), '') IS NOT NULL
          THEN public.entregas_degustacion.notas_chofer
        ELSE EXCLUDED.notas_chofer
      END,
      updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_cronograma_dispatch_ruta_y_chofer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_cronograma_dispatch_ruta_y_chofer() TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_cronograma_normalize_routing ON public.cronograma_degustaciones;
    CREATE TRIGGER trg_cronograma_normalize_routing
      BEFORE INSERT OR UPDATE ON public.cronograma_degustaciones
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_trg_cronograma_normalize_routing();

    DROP TRIGGER IF EXISTS trg_sync_cronograma_to_rutas_promotoras ON public.cronograma_degustaciones;
    DROP TRIGGER IF EXISTS trg_cronograma_dispatch_ruta_y_chofer ON public.cronograma_degustaciones;
    CREATE TRIGGER trg_cronograma_dispatch_ruta_y_chofer
      AFTER INSERT OR UPDATE ON public.cronograma_degustaciones
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_trg_cronograma_dispatch_ruta_y_chofer();
  END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 5. POLÍTICAS RLS ESTRICTAS PARA ENTREGAS DE CHOFER (OCCIDENTE VS VALENCIA)
-- ------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.entregas_degustacion FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.entregas_degustacion TO authenticated;
    ALTER TABLE public.entregas_degustacion ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS trade_rls_select_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_insert_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_update_entregas_degustacion ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_delete_entregas_degustacion_qa_only ON public.entregas_degustacion;
    DROP POLICY IF EXISTS trade_rls_restrict_regional_entregas ON public.entregas_degustacion;

    CREATE POLICY trade_rls_select_entregas_degustacion
      ON public.entregas_degustacion
      FOR SELECT
      TO authenticated
      USING (public.fn_trade_can_deliver_sede(region, sucursal, chofer_sede));

    CREATE POLICY trade_rls_insert_entregas_degustacion
      ON public.entregas_degustacion
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR (
          (SELECT public.fn_trade_is_regional_coordinator())
          AND public.fn_trade_can_deliver_sede(region, sucursal, chofer_sede)
        )
      );

    CREATE POLICY trade_rls_update_entregas_degustacion
      ON public.entregas_degustacion
      FOR UPDATE
      TO authenticated
      USING (public.fn_trade_can_deliver_sede(region, sucursal, chofer_sede))
      WITH CHECK (public.fn_trade_can_deliver_sede(region, sucursal, chofer_sede));

    CREATE POLICY trade_rls_delete_entregas_degustacion_qa_only
      ON public.entregas_degustacion
      FOR DELETE
      TO authenticated
      USING (
        (
          (SELECT public.is_global_admin())
          OR (
            (SELECT public.fn_trade_is_regional_coordinator())
            AND public.fn_trade_can_deliver_sede(region, sucursal, chofer_sede)
          )
        )
        AND COALESCE(notas_chofer, '') ILIKE '%[QA-TEST]%'
      );

    -- Guardrail RESTRICTIVE: impide cualquier fuga entre Chofer Occidente y Chofer Valencia
    CREATE POLICY trade_rls_restrict_regional_entregas
      ON public.entregas_degustacion
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (
        (SELECT public.is_global_admin())
        OR public.fn_trade_can_deliver_sede(region, sucursal, chofer_sede)
      )
      WITH CHECK (
        (SELECT public.is_global_admin())
        OR public.fn_trade_can_deliver_sede(region, sucursal, chofer_sede)
      );
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

-- ------------------------------------------------------------------------------
-- 6. BLOQUE VERIFICADOR SQL (TRIGGERS Y POLÍTICAS RLS ACTIVAS)
-- ------------------------------------------------------------------------------

SELECT
  c.relname AS tabla,
  t.tgname AS trigger_activo,
  p.proname AS funcion
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND t.tgname IN (
    'trg_survey_aprobada_to_cronograma',
    'trg_cronograma_normalize_routing',
    'trg_cronograma_dispatch_ruta_y_chofer'
  )
ORDER BY c.relname, t.tgname;

SELECT
  tablename,
  policyname,
  permissive,
  cmd,
  roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'entregas_degustacion'
  )
ORDER BY tablename, permissive DESC, cmd, policyname;
