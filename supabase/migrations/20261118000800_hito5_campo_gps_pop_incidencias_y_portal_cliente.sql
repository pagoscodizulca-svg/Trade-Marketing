-- =============================================================================
-- HITO 5 — PORTAL DE CAMPO CON GPS/GEOCERCA Y EJECUCIÓN PDV, MATERIAL POP,
-- GESTIÓN DE INCIDENCIAS CON FOTO PRIVADA + SLA Y PORTAL DE LECTURA ROL CLIENTE
--
-- Archivo: supabase/migrations/20261118000800_hito5_campo_gps_pop_incidencias_y_portal_cliente.sql
--
-- Cierra:
--   B-08  Validación geoespacial Haversine contra geocerca del PDV, alertas
--         auditadas fuera de rango y formulario transaccional de ejecución en
--         PDV con idempotencia para sincronización de cola offline.
--   M-01  Módulo completo de Material POP (`material_pop_inventario`,
--         `material_pop_entregas` + RPC atómica con bloqueo de stock) y Gestión
--         de Incidencias en PDV (`incidencias_pdv` + bucket privado
--         `incidencias-evidencias` + cálculo automático de SLA).
--   M-03  Tabla de accesos granulares `cliente_portal_accesos` (usuario cliente
--         <-> PDV / Cadena Comercial) y RPC de solo lectura con aislamiento por
--         sucursal sin exponer costos ni márgenes internos.
--
-- Reglas de integridad:
--   * Forward-only e idempotente. Cero comandos destructivos ni borrado de datos.
--   * Depende de `20261118000600` y `20261118000700`.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. FUNCIÓN HAVERSINE PURA EN SERVIDOR Y COLUMNAS GPS EN `rutas_promotoras`
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_haversine_metros(
  p_lat1 DOUBLE PRECISION,
  p_lng1 DOUBLE PRECISION,
  p_lat2 DOUBLE PRECISION,
  p_lng2 DOUBLE PRECISION
)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_earth_radius_m CONSTANT DOUBLE PRECISION := 6371000.0;
  v_dlat DOUBLE PRECISION;
  v_dlng DOUBLE PRECISION;
  v_a DOUBLE PRECISION;
  v_c DOUBLE PRECISION;
BEGIN
  IF p_lat1 IS NULL OR p_lng1 IS NULL OR p_lat2 IS NULL OR p_lng2 IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_lat1 < -90 OR p_lat1 > 90 OR p_lat2 < -90 OR p_lat2 > 90
     OR p_lng1 < -180 OR p_lng1 > 180 OR p_lng2 < -180 OR p_lng2 > 180 THEN
    RETURN NULL;
  END IF;

  v_dlat := radians(p_lat2 - p_lat1);
  v_dlng := radians(p_lng2 - p_lng1);

  v_a := power(sin(v_dlat / 2.0), 2)
       + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(v_dlng / 2.0), 2);
  v_a := LEAST(1.0, GREATEST(0.0, v_a));
  v_c := 2.0 * atan2(sqrt(v_a), sqrt(1.0 - v_a));

  RETURN round((v_earth_radius_m * v_c)::numeric, 2)::double precision;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_haversine_metros(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_haversine_metros(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;

ALTER TABLE public.rutas_promotoras
  ADD COLUMN IF NOT EXISTS checkin_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS checkin_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS checkin_accuracy_m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS checkin_distancia_m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS checkin_dentro_geocerca BOOLEAN,
  ADD COLUMN IF NOT EXISTS checkout_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS checkout_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS checkout_accuracy_m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS checkout_distancia_m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS checkout_dentro_geocerca BOOLEAN,
  ADD COLUMN IF NOT EXISTS pdv_lat_referencia DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pdv_lng_referencia DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pdv_radio_geocerca_m INTEGER;

-- =============================================================================
-- 2. TABLA: `public.ejecuciones_pdv_promotora` (REPORTE DE CAMPO IDEMPOTENTE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.ejecuciones_pdv_promotora (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_id UUID NOT NULL UNIQUE REFERENCES public.rutas_promotoras(id) ON DELETE RESTRICT,
  cronograma_id UUID NULL REFERENCES public.cronograma_degustaciones(id) ON DELETE SET NULL,
  promotora_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  cliente_id UUID NULL REFERENCES public.clientes(id) ON DELETE SET NULL,
  cliente_nombre TEXT NOT NULL,
  fecha DATE NOT NULL,
  lote_producto TEXT NOT NULL DEFAULT '',
  fecha_vencimiento DATE NULL,
  unidades_abiertas NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (unidades_abiertas >= 0),
  muestras_entregadas INTEGER NOT NULL DEFAULT 0 CHECK (muestras_entregadas >= 0),
  ventas_asistidas_unidades INTEGER NOT NULL DEFAULT 0 CHECK (ventas_asistidas_unidades >= 0),
  observaciones TEXT NOT NULL DEFAULT '',
  client_submission_id TEXT NOT NULL UNIQUE,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ejecuciones_pdv_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_ejecuciones_pdv_promotora_fecha
  ON public.ejecuciones_pdv_promotora (promotora_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_ejecuciones_pdv_cliente_fecha
  ON public.ejecuciones_pdv_promotora (cliente_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_ejecuciones_pdv_sucursal
  ON public.ejecuciones_pdv_promotora (sucursal);

DROP TRIGGER IF EXISTS trg_hito5_ejecuciones_pdv_updated_at ON public.ejecuciones_pdv_promotora;
CREATE TRIGGER trg_hito5_ejecuciones_pdv_updated_at
  BEFORE UPDATE ON public.ejecuciones_pdv_promotora
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_contraloria_touch_updated_at();

DROP TRIGGER IF EXISTS trg_hito5_sellar_sucursal_ejecuciones_pdv ON public.ejecuciones_pdv_promotora;
CREATE TRIGGER trg_hito5_sellar_sucursal_ejecuciones_pdv
  BEFORE INSERT OR UPDATE ON public.ejecuciones_pdv_promotora
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.ejecuciones_pdv_promotora FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ejecuciones_pdv_promotora TO authenticated;

ALTER TABLE public.ejecuciones_pdv_promotora ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ejecuciones_pdv_promotora FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ejecuciones_pdv_select_sede_o_propia ON public.ejecuciones_pdv_promotora;
CREATE POLICY ejecuciones_pdv_select_sede_o_propia
  ON public.ejecuciones_pdv_promotora
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

DROP POLICY IF EXISTS ejecuciones_pdv_insert_propia_o_coord ON public.ejecuciones_pdv_promotora;
CREATE POLICY ejecuciones_pdv_insert_propia_o_coord
  ON public.ejecuciones_pdv_promotora
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

DROP POLICY IF EXISTS ejecuciones_pdv_update_propia_o_coord ON public.ejecuciones_pdv_promotora;
CREATE POLICY ejecuciones_pdv_update_propia_o_coord
  ON public.ejecuciones_pdv_promotora
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  )
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

-- =============================================================================
-- 3. TABLA: `public.alertas_geocerca_auditoria` (APPEND-ONLY INMUTABLE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.alertas_geocerca_auditoria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_id UUID NOT NULL REFERENCES public.rutas_promotoras(id) ON DELETE RESTRICT,
  promotora_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  promotora_nombre TEXT NOT NULL,
  cliente_nombre TEXT NOT NULL,
  accion TEXT NOT NULL CHECK (accion IN ('CHECKIN', 'CHECKOUT')),
  lat_capturada DOUBLE PRECISION NOT NULL CHECK (lat_capturada BETWEEN -90 AND 90),
  lng_capturada DOUBLE PRECISION NOT NULL CHECK (lng_capturada BETWEEN -180 AND 180),
  pdv_lat DOUBLE PRECISION NOT NULL CHECK (pdv_lat BETWEEN -90 AND 90),
  pdv_lng DOUBLE PRECISION NOT NULL CHECK (pdv_lng BETWEEN -180 AND 180),
  distancia_m DOUBLE PRECISION NOT NULL CHECK (distancia_m >= 0),
  radio_permitido_m INTEGER NOT NULL CHECK (radio_permitido_m >= 20),
  motivo TEXT NOT NULL DEFAULT '',
  client_submission_id TEXT NULL UNIQUE,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_alertas_geocerca_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_alertas_geocerca_ruta
  ON public.alertas_geocerca_auditoria (ruta_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alertas_geocerca_sucursal
  ON public.alertas_geocerca_auditoria (sucursal, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_bloquear_mutacion_alerta_geocerca()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_GEOFENCE_AUDIT: Las alertas de geocerca auditadas son inmutables y no admiten %.', TG_OP
    USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.fn_bloquear_mutacion_alerta_geocerca() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_hito5_inmutable_alerta_geocerca ON public.alertas_geocerca_auditoria;
CREATE TRIGGER trg_hito5_inmutable_alerta_geocerca
  BEFORE UPDATE OR DELETE ON public.alertas_geocerca_auditoria
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_bloquear_mutacion_alerta_geocerca();

DROP TRIGGER IF EXISTS trg_hito5_sellar_sucursal_alerta_geocerca ON public.alertas_geocerca_auditoria;
CREATE TRIGGER trg_hito5_sellar_sucursal_alerta_geocerca
  BEFORE INSERT ON public.alertas_geocerca_auditoria
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.alertas_geocerca_auditoria FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE public.alertas_geocerca_auditoria TO authenticated;

ALTER TABLE public.alertas_geocerca_auditoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alertas_geocerca_auditoria FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alertas_geocerca_select_sede_o_propia ON public.alertas_geocerca_auditoria;
CREATE POLICY alertas_geocerca_select_sede_o_propia
  ON public.alertas_geocerca_auditoria
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

DROP POLICY IF EXISTS alertas_geocerca_insert_propia_o_coord ON public.alertas_geocerca_auditoria;
CREATE POLICY alertas_geocerca_insert_propia_o_coord
  ON public.alertas_geocerca_auditoria
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_coordinadora_or_admin())
      OR promotora_id = (SELECT private.current_active_promotora_id())
    )
  );

-- =============================================================================
-- 4. RPC TRANSACCIONAL IDEMPOTENTE DE EJECUCIÓN EN RUTA + GEOCERCA (`B-08`)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_promotora_id UUID := (SELECT private.current_active_promotora_id());
  v_is_coord BOOLEAN := (SELECT public.is_coordinadora_or_admin());
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

  IF NOT public.tiene_acceso_sucursal(v_ruta.sucursal) THEN
    RAISE EXCEPTION 'FORBIDDEN_BRANCH: No tienes acceso a rutas de otra sucursal.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_coord AND (v_promotora_id IS NULL OR v_ruta.promotora_id <> v_promotora_id) THEN
    RAISE EXCEPTION 'FORBIDDEN_OWNER: Solo la promotora titular o Coordinación puede actualizar esta ruta.'
      USING ERRCODE = '42501';
  END IF;

  IF v_ruta.estado_ruta = 'CANCELADA' THEN
    RAISE EXCEPTION 'CANCELLED_ROUTE: No se puede operar sobre una ruta cancelada.'
      USING ERRCODE = '23514';
  END IF;

  -- Resolver geocerca desde `public.clientes` por `codigo_cliente` o `nombre_comercial`
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

  IF v_lat IS NOT NULL AND v_lng IS NOT NULL AND v_pdv_lat IS NOT NULL AND v_pdv_lng IS NOT NULL THEN
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
    'alerta_geocerca_registrada', v_alerta_registrada
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(JSONB) TO authenticated, service_role;

-- =============================================================================
-- 5. MATERIAL POP: INVENTARIO Y MOVIMIENTOS ATÓMICOS (`M-01`)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.material_pop_inventario (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'EXHIBIDOR'
    CHECK (categoria IN ('EXHIBIDOR', 'AFICHE', 'HABLADOR', 'UNIFORME', 'STAND_BTL', 'MERCHANDISING', 'OTRO')),
  marca TEXT NOT NULL DEFAULT 'GENERAL'
    CHECK (marca IN ('ASTURIAS', 'VENCAMPO', 'GENERAL')),
  unidad TEXT NOT NULL DEFAULT 'UND',
  stock_disponible NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (stock_disponible >= 0),
  stock_minimo NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
  activo BOOLEAN NOT NULL DEFAULT true,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pop_inv_sku_normalizado
    CHECK (sku = upper(btrim(sku)) AND length(btrim(sku)) > 0),
  CONSTRAINT chk_pop_inv_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_material_pop_inventario_sucursal
  ON public.material_pop_inventario (sucursal, activo);

DROP TRIGGER IF EXISTS trg_hito5_pop_inventario_updated_at ON public.material_pop_inventario;
CREATE TRIGGER trg_hito5_pop_inventario_updated_at
  BEFORE UPDATE ON public.material_pop_inventario
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_contraloria_touch_updated_at();

DROP TRIGGER IF EXISTS trg_hito5_sellar_sucursal_pop_inventario ON public.material_pop_inventario;
CREATE TRIGGER trg_hito5_sellar_sucursal_pop_inventario
  BEFORE INSERT OR UPDATE ON public.material_pop_inventario
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.material_pop_inventario FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.material_pop_inventario TO authenticated;

ALTER TABLE public.material_pop_inventario ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_pop_inventario FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS material_pop_inventario_select_sede ON public.material_pop_inventario;
CREATE POLICY material_pop_inventario_select_sede
  ON public.material_pop_inventario
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS material_pop_inventario_insert_coord ON public.material_pop_inventario;
CREATE POLICY material_pop_inventario_insert_coord
  ON public.material_pop_inventario
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS material_pop_inventario_update_coord ON public.material_pop_inventario;
CREATE POLICY material_pop_inventario_update_coord
  ON public.material_pop_inventario
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

CREATE TABLE IF NOT EXISTS public.material_pop_entregas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id UUID NOT NULL REFERENCES public.material_pop_inventario(id) ON DELETE RESTRICT,
  cliente_id UUID NULL REFERENCES public.clientes(id) ON DELETE SET NULL,
  pdv_nombre TEXT NOT NULL,
  promotora_id UUID NULL REFERENCES public.staff(id) ON DELETE SET NULL,
  responsable_nombre TEXT NOT NULL,
  tipo_movimiento TEXT NOT NULL DEFAULT 'ENTREGA_PDV'
    CHECK (tipo_movimiento IN ('ENTREGA_PDV', 'REINGRESO_ALMACEN', 'BAJA_DETERIORO')),
  cantidad NUMERIC(12, 2) NOT NULL CHECK (cantidad > 0),
  fecha_movimiento DATE NOT NULL DEFAULT CURRENT_DATE,
  observaciones TEXT NOT NULL DEFAULT '',
  registrado_por_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pop_entregas_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_material_pop_entregas_material
  ON public.material_pop_entregas (material_id, fecha_movimiento DESC);

CREATE INDEX IF NOT EXISTS idx_material_pop_entregas_sucursal
  ON public.material_pop_entregas (sucursal, fecha_movimiento DESC);

DROP TRIGGER IF EXISTS trg_hito5_sellar_sucursal_pop_entregas ON public.material_pop_entregas;
CREATE TRIGGER trg_hito5_sellar_sucursal_pop_entregas
  BEFORE INSERT OR UPDATE ON public.material_pop_entregas
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.material_pop_entregas FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE public.material_pop_entregas TO authenticated;

ALTER TABLE public.material_pop_entregas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_pop_entregas FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS material_pop_entregas_select_sede ON public.material_pop_entregas;
CREATE POLICY material_pop_entregas_select_sede
  ON public.material_pop_entregas
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS material_pop_entregas_insert_coord ON public.material_pop_entregas;
CREATE POLICY material_pop_entregas_insert_coord
  ON public.material_pop_entregas
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

CREATE OR REPLACE FUNCTION public.rpc_registrar_movimiento_pop(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_material_id UUID := (p_payload ->> 'material_id')::uuid;
  v_tipo TEXT := upper(btrim(COALESCE(p_payload ->> 'tipo_movimiento', 'ENTREGA_PDV')));
  v_cantidad NUMERIC(12, 2) := COALESCE((p_payload ->> 'cantidad')::numeric, 0);
  v_pdv TEXT := btrim(COALESCE(p_payload ->> 'pdv_nombre', ''));
  v_resp TEXT := btrim(COALESCE(p_payload ->> 'responsable_nombre', ''));
  v_cliente_id UUID := NULLIF(btrim(COALESCE(p_payload ->> 'cliente_id', '')), '')::uuid;
  v_promotora_id UUID := NULLIF(btrim(COALESCE(p_payload ->> 'promotora_id', '')), '')::uuid;
  v_fecha DATE := COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'fecha_movimiento', '')), '')::date, CURRENT_DATE);
  v_obs TEXT := btrim(COALESCE(p_payload ->> 'observaciones', ''));
  v_inv public.material_pop_inventario;
  v_mov public.material_pop_entregas;
  v_nuevo_stock NUMERIC(12, 2);
BEGIN
  IF NOT public.is_coordinadora_or_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Solo Coordinación Trade o Super Admin puede registrar movimientos de Material POP.'
      USING ERRCODE = '42501';
  END IF;

  IF v_material_id IS NULL OR v_cantidad <= 0 OR v_pdv = '' OR v_resp = '' THEN
    RAISE EXCEPTION 'INVALID_PAYLOAD: Material, cantidad (> 0), PDV y responsable son obligatorios.'
      USING ERRCODE = '22023';
  END IF;

  IF v_tipo NOT IN ('ENTREGA_PDV', 'REINGRESO_ALMACEN', 'BAJA_DETERIORO') THEN
    RAISE EXCEPTION 'INVALID_MOVEMENT_TYPE: Tipo de movimiento POP inválido (%).', v_tipo
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_inv
  FROM public.material_pop_inventario
  WHERE id = v_material_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'POP_ITEM_NOT_FOUND: El ítem de Material POP no existe.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.tiene_acceso_sucursal(v_inv.sucursal) THEN
    RAISE EXCEPTION 'FORBIDDEN_BRANCH: No tienes acceso al inventario POP de otra sucursal.'
      USING ERRCODE = '42501';
  END IF;

  IF v_tipo IN ('ENTREGA_PDV', 'BAJA_DETERIORO') THEN
    IF v_inv.stock_disponible < v_cantidad THEN
      RAISE EXCEPTION 'INSUFFICIENT_POP_STOCK: Stock insuficiente para % (disponible: %, solicitado: %).',
        v_inv.nombre, v_inv.stock_disponible, v_cantidad
        USING ERRCODE = '23514';
    END IF;
    v_nuevo_stock := v_inv.stock_disponible - v_cantidad;
  ELSE
    v_nuevo_stock := v_inv.stock_disponible + v_cantidad;
  END IF;

  UPDATE public.material_pop_inventario
  SET stock_disponible = v_nuevo_stock,
      updated_at = now()
  WHERE id = v_inv.id
  RETURNING * INTO v_inv;

  INSERT INTO public.material_pop_entregas (
    material_id,
    cliente_id,
    pdv_nombre,
    promotora_id,
    responsable_nombre,
    tipo_movimiento,
    cantidad,
    fecha_movimiento,
    observaciones,
    registrado_por_uid,
    sucursal
  )
  VALUES (
    v_inv.id,
    v_cliente_id,
    v_pdv,
    v_promotora_id,
    v_resp,
    v_tipo,
    v_cantidad,
    v_fecha,
    v_obs,
    v_uid,
    v_inv.sucursal
  )
  RETURNING * INTO v_mov;

  RETURN jsonb_build_object(
    'ok', true,
    'inventario', to_jsonb(v_inv),
    'movimiento', to_jsonb(v_mov)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_registrar_movimiento_pop(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_movimiento_pop(JSONB) TO authenticated, service_role;

-- =============================================================================
-- 6. INCIDENCIAS EN PDV CON FOTO PRIVADA + SLA (`M-01`)
-- =============================================================================
CREATE SEQUENCE IF NOT EXISTS public.seq_incidencia_pdv
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

REVOKE ALL ON SEQUENCE public.seq_incidencia_pdv FROM PUBLIC, anon;
GRANT USAGE, SELECT ON SEQUENCE public.seq_incidencia_pdv TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_generar_codigo_incidencia()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next BIGINT;
BEGIN
  v_next := nextval('public.seq_incidencia_pdv');
  RETURN 'INC-' || lpad(v_next::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_generar_codigo_incidencia() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_generar_codigo_incidencia() TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.incidencias_pdv (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_incidencia TEXT NOT NULL UNIQUE,
  cliente_id UUID NULL REFERENCES public.clientes(id) ON DELETE SET NULL,
  pdv_nombre TEXT NOT NULL,
  ruta_id UUID NULL REFERENCES public.rutas_promotoras(id) ON DELETE SET NULL,
  reportado_por_uid UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reportado_por_nombre TEXT NOT NULL,
  responsable_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  responsable_nombre TEXT NOT NULL DEFAULT 'Coordinación Trade',
  tipo_incidencia TEXT NOT NULL DEFAULT 'QUIEBRE_STOCK'
    CHECK (tipo_incidencia IN (
      'QUIEBRE_STOCK',
      'PRECIO_INCORRECTO',
      'MATERIAL_POP_DANADO',
      'COMPETENCIA_AGRESIVA',
      'CALIDAD_PRODUCTO',
      'ACCESO_PDV',
      'OTRO'
    )),
  severidad TEXT NOT NULL DEFAULT 'MEDIA'
    CHECK (severidad IN ('BAJA', 'MEDIA', 'ALTA', 'CRITICA')),
  descripcion TEXT NOT NULL CHECK (length(btrim(descripcion)) >= 5),
  estado TEXT NOT NULL DEFAULT 'ABIERTA'
    CHECK (estado IN ('ABIERTA', 'EN_PROCESO', 'RESUELTA', 'CERRADA')),
  sla_horas INTEGER NOT NULL DEFAULT 24 CHECK (sla_horas BETWEEN 1 AND 720),
  sla_vence_en TIMESTAMPTZ NOT NULL,
  resuelta_en TIMESTAMPTZ NULL,
  notas_resolucion TEXT NOT NULL DEFAULT '',
  foto_storage_bucket TEXT NULL DEFAULT 'incidencias-evidencias',
  foto_storage_path TEXT NULL,
  foto_mime_type TEXT NULL
    CHECK (foto_mime_type IS NULL OR foto_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  foto_sha256_hex TEXT NULL
    CHECK (foto_sha256_hex IS NULL OR foto_sha256_hex ~ '^[0-9a-f]{64}$'),
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_incidencias_pdv_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_incidencias_pdv_estado_sla
  ON public.incidencias_pdv (estado, sla_vence_en ASC);

CREATE INDEX IF NOT EXISTS idx_incidencias_pdv_sucursal
  ON public.incidencias_pdv (sucursal, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incidencias_pdv_autor
  ON public.incidencias_pdv (reportado_por_uid, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_incidencias_pdv_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default_sla INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_INCIDENT_DELETE: Las incidencias operativas no se eliminan físicamente; ciérrelas con trazabilidad.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.codigo_incidencia IS NULL OR btrim(NEW.codigo_incidencia) = '' OR upper(btrim(NEW.codigo_incidencia)) = 'AUTO' THEN
      NEW.codigo_incidencia := public.fn_generar_codigo_incidencia();
    ELSE
      NEW.codigo_incidencia := upper(btrim(NEW.codigo_incidencia));
    END IF;

    IF NEW.reportado_por_uid IS NULL AND auth.uid() IS NOT NULL THEN
      NEW.reportado_por_uid := auth.uid();
    END IF;

    v_default_sla := CASE NEW.severidad
      WHEN 'CRITICA' THEN 4
      WHEN 'ALTA' THEN 12
      WHEN 'MEDIA' THEN 24
      ELSE 72
    END;

    IF NEW.sla_horas IS NULL OR NEW.sla_horas <= 0 THEN
      NEW.sla_horas := v_default_sla;
    END IF;

    IF NEW.sla_vence_en IS NULL THEN
      NEW.sla_vence_en := COALESCE(NEW.created_at, now()) + make_interval(hours => NEW.sla_horas);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.estado IN ('RESUELTA', 'CERRADA') AND OLD.resuelta_en IS NULL THEN
      NEW.resuelta_en := now();
    END IF;
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_incidencias_pdv_before_write() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_hito5_incidencias_before_write ON public.incidencias_pdv;
CREATE TRIGGER trg_hito5_incidencias_before_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.incidencias_pdv
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_incidencias_pdv_before_write();

DROP TRIGGER IF EXISTS trg_hito5_sellar_sucursal_incidencias ON public.incidencias_pdv;
CREATE TRIGGER trg_hito5_sellar_sucursal_incidencias
  BEFORE INSERT OR UPDATE ON public.incidencias_pdv
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.incidencias_pdv FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.incidencias_pdv TO authenticated;

ALTER TABLE public.incidencias_pdv ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidencias_pdv FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incidencias_pdv_select_sede_o_autor ON public.incidencias_pdv;
CREATE POLICY incidencias_pdv_select_sede_o_autor
  ON public.incidencias_pdv
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR reportado_por_uid = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS incidencias_pdv_insert_operativo ON public.incidencias_pdv;
CREATE POLICY incidencias_pdv_insert_operativo
  ON public.incidencias_pdv
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND reportado_por_uid = (SELECT auth.uid())
    AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion', 'promotora', 'vendedor')
  );

DROP POLICY IF EXISTS incidencias_pdv_update_coord_admin ON public.incidencias_pdv;
CREATE POLICY incidencias_pdv_update_coord_admin
  ON public.incidencias_pdv
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

-- Bucket privado `incidencias-evidencias` (máx. 5 MB, solo imágenes reales JPEG/PNG/WebP)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'incidencias-evidencias',
  'incidencias-evidencias',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS storage_incidencias_evidencias_select ON storage.objects;
CREATE POLICY storage_incidencias_evidencias_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'incidencias-evidencias'
    AND (storage.foldername(name))[1] = 'incidencias'
    AND (
      (SELECT public.is_torre_control_viewer())
      OR (SELECT public.obtener_mi_rol()) IN ('promotora', 'vendedor')
    )
    AND (
      (SELECT public.obtener_mi_sucursal()) = 'GLOBAL'::public.sucursal_codigo
      OR upper(COALESCE((storage.foldername(name))[2], '')) = (SELECT public.obtener_mi_sucursal())::text
    )
  );

DROP POLICY IF EXISTS storage_incidencias_evidencias_insert ON storage.objects;
CREATE POLICY storage_incidencias_evidencias_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'incidencias-evidencias'
    AND (storage.foldername(name))[1] = 'incidencias'
    AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion', 'promotora', 'vendedor')
    AND (
      (SELECT public.obtener_mi_sucursal()) = 'GLOBAL'::public.sucursal_codigo
      OR upper(COALESCE((storage.foldername(name))[2], '')) = (SELECT public.obtener_mi_sucursal())::text
    )
  );

-- =============================================================================
-- 7. PORTAL DE SOLO LECTURA ROL `cliente` (`M-03`)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.cliente_portal_accesos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cliente_id UUID NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  cadena_id UUID NULL REFERENCES public.cadenas_comerciales(id) ON DELETE CASCADE,
  activo BOOLEAN NOT NULL DEFAULT true,
  notas TEXT NOT NULL DEFAULT '',
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cliente_portal_objetivo
    CHECK (cliente_id IS NOT NULL OR cadena_id IS NOT NULL),
  CONSTRAINT chk_cliente_portal_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cliente_portal_user_cliente_uniq
  ON public.cliente_portal_accesos (user_id, cliente_id)
  WHERE cliente_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cliente_portal_user_cadena_uniq
  ON public.cliente_portal_accesos (user_id, cadena_id)
  WHERE cadena_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cliente_portal_accesos_user
  ON public.cliente_portal_accesos (user_id, activo);

CREATE INDEX IF NOT EXISTS idx_cliente_portal_accesos_sucursal
  ON public.cliente_portal_accesos (sucursal);

DROP TRIGGER IF EXISTS trg_hito5_cliente_portal_updated_at ON public.cliente_portal_accesos;
CREATE TRIGGER trg_hito5_cliente_portal_updated_at
  BEFORE UPDATE ON public.cliente_portal_accesos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_contraloria_touch_updated_at();

DROP TRIGGER IF EXISTS trg_hito5_sellar_sucursal_cliente_portal ON public.cliente_portal_accesos;
CREATE TRIGGER trg_hito5_sellar_sucursal_cliente_portal
  BEFORE INSERT OR UPDATE ON public.cliente_portal_accesos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.cliente_portal_accesos FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cliente_portal_accesos TO authenticated;

ALTER TABLE public.cliente_portal_accesos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_portal_accesos FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cliente_portal_accesos_select ON public.cliente_portal_accesos;
CREATE POLICY cliente_portal_accesos_select
  ON public.cliente_portal_accesos
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_sucursal(sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR (user_id = (SELECT auth.uid()) AND activo = true)
    )
  );

DROP POLICY IF EXISTS cliente_portal_accesos_insert_coord ON public.cliente_portal_accesos;
CREATE POLICY cliente_portal_accesos_insert_coord
  ON public.cliente_portal_accesos
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS cliente_portal_accesos_update_coord ON public.cliente_portal_accesos;
CREATE POLICY cliente_portal_accesos_update_coord
  ON public.cliente_portal_accesos
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

-- RPC de solo lectura para el Portal del Rol `cliente`:
-- Devuelve ÚNICAMENTE PDVs autorizados en `cliente_portal_accesos` (o de la sede si
-- previsualiza un usuario de Torre de Control) y métricas comerciales de ejecución
-- sin filtrar jamás costos, presupuestos ni datos internos de Contraloría.
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
      cad.nombre AS cadena_nombre
    FROM public.clientes c
    LEFT JOIN public.cadenas_comerciales cad ON cad.id = c.cadena_id
    WHERE c.activo = true
      AND public.tiene_acceso_sucursal(c.sucursal)
      AND (
        v_is_torre
        OR EXISTS (
          SELECT 1
          FROM public.cliente_portal_accesos a
          WHERE a.user_id = v_uid
            AND a.activo = true
            AND public.tiene_acceso_sucursal(a.sucursal)
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
        'cadena_nombre', COALESCE(p.cadena_nombre, 'PDV Independiente'),
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

  WITH pdvs_autorizados AS (
    SELECT DISTINCT
      c.id,
      c.codigo_cliente,
      c.nombre_comercial
    FROM public.clientes c
    WHERE c.activo = true
      AND public.tiene_acceso_sucursal(c.sucursal)
      AND (
        v_is_torre
        OR EXISTS (
          SELECT 1
          FROM public.cliente_portal_accesos a
          WHERE a.user_id = v_uid
            AND a.activo = true
            AND public.tiene_acceso_sucursal(a.sucursal)
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
  WHERE public.tiene_acceso_sucursal(cd.sucursal)
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
    'activaciones', v_activaciones
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_obtener_resumen_portal_cliente() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_obtener_resumen_portal_cliente() TO authenticated, service_role;

COMMIT;
