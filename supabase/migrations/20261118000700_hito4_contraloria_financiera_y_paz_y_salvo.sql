-- =============================================================================
-- HITO 4 — CONTRALORÍA FINANCIERA, CORRELATIVO SECUENCIAL MP-07-XXXX,
-- WORKFLOW DE 8 ETAPAS CON SEGREGACIÓN DE FUNCIONES EN BD, FACTURAS PRIVADAS
-- Y CERTIFICADO PAZ Y SALVO INMUTABLE CON SHA-256 EN SERVIDOR (pgcrypto)
--
-- Archivo: supabase/migrations/20261118000700_hito4_contraloria_financiera_y_paz_y_salvo.sql
--
-- Cierra:
--   B-07  Persistencia real de Contraloría, Campañas, Presupuestos, Tarifario
--         de Costos, Requisiciones (8 etapas), Facturas privadas y Conciliaciones.
--   S-03  Segregación de Funciones forzada en PostgreSQL por RPC y triggers
--         (la UI ya no es el único guardia de transiciones).
--   S-04  SHA-256 criptográfico calculado en servidor (pgcrypto) sobre payload
--         canónico inmutable con bloqueo físico de UPDATE/DELETE posterior.
--   P-05  Secuencia atómica PostgreSQL `public.seq_mp07_correlativo` y RPC
--         `public.rpc_crear_solicitud_contraloria` (cero Split-Brain / colisiones).
--
-- Reglas de integridad:
--   * Forward-only e idempotente. Sin comandos destructivos ni borrado de datos.
--   * Depende de `20261118000400_hito1_identidad_unica_y_aislamiento_sucursales.sql`.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. EXTENSIÓN CRIPTOGRÁFICA + FUNCIÓN DE TIMESTAMP
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.fn_contraloria_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_contraloria_touch_updated_at() FROM PUBLIC, anon;

-- =============================================================================
-- 1. SECUENCIA ATÓMICA MP-07-XXXX (CIERRA P-05: CERO CONDICIÓN DE CARRERA)
-- =============================================================================
CREATE SEQUENCE IF NOT EXISTS public.seq_mp07_correlativo
  AS BIGINT
  START WITH 72
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

REVOKE ALL ON SEQUENCE public.seq_mp07_correlativo FROM PUBLIC, anon;
GRANT USAGE, SELECT ON SEQUENCE public.seq_mp07_correlativo TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_generar_correlativo_mp07()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next BIGINT;
BEGIN
  v_next := nextval('public.seq_mp07_correlativo');
  RETURN 'MP-07-' || lpad(v_next::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_generar_correlativo_mp07() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_generar_correlativo_mp07() TO authenticated, service_role;

-- Trigger de asignación atómica en `public.solicitudes_contraloria` cuando no se envía código explícito
CREATE OR REPLACE FUNCTION public.fn_solicitudes_contraloria_asignar_correlativo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq BIGINT;
BEGIN
  IF NEW.codigo_correlativo IS NULL
     OR btrim(NEW.codigo_correlativo) = ''
     OR upper(btrim(NEW.codigo_correlativo)) = 'AUTO' THEN
    NEW.codigo_correlativo := public.fn_generar_correlativo_mp07();
  ELSE
    NEW.codigo_correlativo := upper(btrim(NEW.codigo_correlativo));
    IF NEW.codigo_correlativo ~ '^MP-07-[0-9]+$' THEN
      v_seq := substring(NEW.codigo_correlativo FROM '^MP-07-([0-9]+)$')::bigint;
      IF v_seq > (SELECT last_value FROM public.seq_mp07_correlativo) THEN
        PERFORM setval('public.seq_mp07_correlativo', v_seq, true);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_solicitudes_contraloria_asignar_correlativo() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_hito4_solicitudes_correlativo ON public.solicitudes_contraloria;
CREATE TRIGGER trg_hito4_solicitudes_correlativo
  BEFORE INSERT ON public.solicitudes_contraloria
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_solicitudes_contraloria_asignar_correlativo();

-- =============================================================================
-- 2. TABLA: `public.campanas_trade`
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.campanas_trade (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  marca TEXT NOT NULL DEFAULT 'GENERAL'
    CHECK (marca IN ('ASTURIAS', 'VENCAMPO', 'GENERAL')),
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  estado TEXT NOT NULL DEFAULT 'ACTIVA'
    CHECK (estado IN ('PLANIFICADA', 'ACTIVA', 'CERRADA', 'CANCELADA')),
  responsable_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  observaciones TEXT NOT NULL DEFAULT '',
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_campanas_trade_codigo_norm
    CHECK (codigo = upper(btrim(codigo)) AND length(codigo) >= 2),
  CONSTRAINT chk_campanas_trade_fechas
    CHECK (fecha_fin >= fecha_inicio),
  CONSTRAINT chk_campanas_trade_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_campanas_trade_sucursal_estado
  ON public.campanas_trade (sucursal, estado);

CREATE INDEX IF NOT EXISTS idx_campanas_trade_fechas
  ON public.campanas_trade (fecha_inicio, fecha_fin);

DROP TRIGGER IF EXISTS trg_campanas_trade_touch ON public.campanas_trade;
CREATE TRIGGER trg_campanas_trade_touch
  BEFORE UPDATE ON public.campanas_trade
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_contraloria_touch_updated_at();

DROP TRIGGER IF EXISTS trg_hito4_sellar_sucursal_campanas ON public.campanas_trade;
CREATE TRIGGER trg_hito4_sellar_sucursal_campanas
  BEFORE INSERT OR UPDATE ON public.campanas_trade
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.campanas_trade FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.campanas_trade TO authenticated;

ALTER TABLE public.campanas_trade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campanas_trade FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campanas_trade_select_sede ON public.campanas_trade;
CREATE POLICY campanas_trade_select_sede
  ON public.campanas_trade
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS campanas_trade_insert_torre ON public.campanas_trade;
CREATE POLICY campanas_trade_insert_torre
  ON public.campanas_trade
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS campanas_trade_update_torre ON public.campanas_trade;
CREATE POLICY campanas_trade_update_torre
  ON public.campanas_trade
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- =============================================================================
-- 3. TABLA: `public.presupuestos_trade`
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.presupuestos_trade (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campana_id UUID NULL REFERENCES public.campanas_trade(id) ON DELETE SET NULL,
  periodo_ym TEXT NOT NULL CHECK (periodo_ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  categoria TEXT NOT NULL,
  monto_asignado_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (monto_asignado_usd >= 0),
  monto_comprometido_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (monto_comprometido_usd >= 0),
  monto_ejecutado_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (monto_ejecutado_usd >= 0),
  activo BOOLEAN NOT NULL DEFAULT true,
  observaciones TEXT NOT NULL DEFAULT '',
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_presupuestos_trade_categoria_no_vacia
    CHECK (length(btrim(categoria)) >= 2),
  CONSTRAINT chk_presupuestos_trade_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_presupuestos_trade_sucursal_periodo
  ON public.presupuestos_trade (sucursal, periodo_ym);

CREATE INDEX IF NOT EXISTS idx_presupuestos_trade_campana_id
  ON public.presupuestos_trade (campana_id);

DROP TRIGGER IF EXISTS trg_presupuestos_trade_touch ON public.presupuestos_trade;
CREATE TRIGGER trg_presupuestos_trade_touch
  BEFORE UPDATE ON public.presupuestos_trade
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_contraloria_touch_updated_at();

DROP TRIGGER IF EXISTS trg_hito4_sellar_sucursal_presupuestos ON public.presupuestos_trade;
CREATE TRIGGER trg_hito4_sellar_sucursal_presupuestos
  BEFORE INSERT OR UPDATE ON public.presupuestos_trade
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.presupuestos_trade FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.presupuestos_trade TO authenticated;

ALTER TABLE public.presupuestos_trade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presupuestos_trade FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS presupuestos_trade_select_sede ON public.presupuestos_trade;
CREATE POLICY presupuestos_trade_select_sede
  ON public.presupuestos_trade
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS presupuestos_trade_write_contraloria_admin ON public.presupuestos_trade;
CREATE POLICY presupuestos_trade_write_contraloria_admin
  ON public.presupuestos_trade
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS presupuestos_trade_update_contraloria_admin ON public.presupuestos_trade;
CREATE POLICY presupuestos_trade_update_contraloria_admin
  ON public.presupuestos_trade
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- =============================================================================
-- 4. TABLA: `public.tarifario_costos_trade` (REEMPLAZA COSTOS FIJOS EN CÓDIGO)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.tarifario_costos_trade (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id TEXT NOT NULL,
  etiqueta TEXT NOT NULL,
  marca TEXT NOT NULL CHECK (marca IN ('ASTURIAS', 'VENCAMPO', 'GENERAL')),
  unidad_medida TEXT NOT NULL DEFAULT 'Piezas / Unid',
  costo_unitario_usd NUMERIC(12, 4) NOT NULL CHECK (costo_unitario_usd > 0),
  precio_referencia_usd NUMERIC(12, 4) NOT NULL DEFAULT 0 CHECK (precio_referencia_usd >= 0),
  vigente_desde DATE NOT NULL DEFAULT CURRENT_DATE,
  vigente_hasta DATE NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  updated_by_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_tarifario_line_id_norm
    CHECK (line_id = lower(btrim(line_id)) AND length(line_id) >= 2),
  CONSTRAINT chk_tarifario_vigencia
    CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde),
  CONSTRAINT chk_tarifario_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo),
  CONSTRAINT uq_tarifario_line_sucursal_vigencia
    UNIQUE (line_id, sucursal, vigente_desde)
);

CREATE INDEX IF NOT EXISTS idx_tarifario_costos_sucursal_activo
  ON public.tarifario_costos_trade (sucursal, activo, vigente_desde DESC);

DROP TRIGGER IF EXISTS trg_tarifario_costos_touch ON public.tarifario_costos_trade;
CREATE TRIGGER trg_tarifario_costos_touch
  BEFORE UPDATE ON public.tarifario_costos_trade
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_contraloria_touch_updated_at();

DROP TRIGGER IF EXISTS trg_hito4_sellar_sucursal_tarifario ON public.tarifario_costos_trade;
CREATE TRIGGER trg_hito4_sellar_sucursal_tarifario
  BEFORE INSERT OR UPDATE ON public.tarifario_costos_trade
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.tarifario_costos_trade FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tarifario_costos_trade TO authenticated;

ALTER TABLE public.tarifario_costos_trade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tarifario_costos_trade FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tarifario_costos_select_sede ON public.tarifario_costos_trade;
CREATE POLICY tarifario_costos_select_sede
  ON public.tarifario_costos_trade
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS tarifario_costos_insert_contraloria_admin ON public.tarifario_costos_trade;
CREATE POLICY tarifario_costos_insert_contraloria_admin
  ON public.tarifario_costos_trade
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS tarifario_costos_update_contraloria_admin ON public.tarifario_costos_trade;
CREATE POLICY tarifario_costos_update_contraloria_admin
  ON public.tarifario_costos_trade
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- Semilla base idempotente del tarifario oficial para ZULIA y VALENCIA (editable desde UI por Contraloría/Admin)
INSERT INTO public.tarifario_costos_trade (
  line_id, etiqueta, marca, unidad_medida, costo_unitario_usd, precio_referencia_usd, vigente_desde, sucursal
)
SELECT
  t.line_id,
  t.etiqueta,
  t.marca,
  t.unidad_medida,
  t.costo_unitario_usd,
  t.precio_referencia_usd,
  DATE '2026-01-01',
  s.sucursal
FROM (
  VALUES
    ('pechuga_pavo_asturias', 'Pechuga de Pavo Asturias', 'ASTURIAS', 'Piezas / Unid', 13.5000, 7.3500),
    ('pechuga_pollo_asturias', 'Pechuga de Pollo Asturias', 'ASTURIAS', 'Piezas / Unid', 13.0000, 7.0100),
    ('espalda_asturias', 'Espalda Cocida / Ahumada Asturias', 'ASTURIAS', 'Piezas / Unid', 12.5000, 6.5000),
    ('jamon_asturias', 'Jamón Cocido y Ahumado Asturias', 'ASTURIAS', 'Piezas / Unid', 13.5000, 7.0500),
    ('mortadela_asturias', 'Mortadela y Embutidos Asturias', 'ASTURIAS', 'Piezas (1kg)', 12.0000, 5.2500),
    ('azucar_vencampo', 'Azúcar Refinada Vencampo (1kg)', 'VENCAMPO', 'Empaques (1kg)', 2.1000, 1.9500),
    ('aceite_vencampo', 'Aceite Comestible Vencampo (900ml)', 'VENCAMPO', 'Unid (900ml)', 2.8500, 2.8500),
    ('leche_vencampo', 'Leche en Polvo Vencampo', 'VENCAMPO', 'Empaques', 8.5000, 8.2000),
    ('granos_vencampo', 'Granos Seleccionados Vencampo', 'VENCAMPO', 'Empaques', 2.5000, 2.4500),
    ('arroz_vencampo', 'Arroz Blanco e Insumos Vencampo', 'VENCAMPO', 'Unid (1kg)', 2.6000, 1.3500)
) AS t(line_id, etiqueta, marca, unidad_medida, costo_unitario_usd, precio_referencia_usd)
CROSS JOIN (
  VALUES ('ZULIA'::public.sucursal_codigo), ('VALENCIA'::public.sucursal_codigo)
) AS s(sucursal)
ON CONFLICT (line_id, sucursal, vigente_desde) DO NOTHING;

-- =============================================================================
-- 5. TABLA: `public.contraloria_requisiciones` (WORKFLOW 8 ETAPAS EN BD)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.contraloria_requisiciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_correlativo TEXT NOT NULL UNIQUE,
  solicitud_origen_id UUID NULL REFERENCES public.solicitudes_contraloria(id) ON DELETE SET NULL,
  campana_id UUID NULL REFERENCES public.campanas_trade(id) ON DELETE SET NULL,
  presupuesto_id UUID NULL REFERENCES public.presupuestos_trade(id) ON DELETE SET NULL,
  fecha_solicitud TEXT NOT NULL,
  fecha_iso DATE NOT NULL DEFAULT CURRENT_DATE,
  departamento_destino TEXT NOT NULL DEFAULT 'CONTRALORÍA',
  proposito_campana TEXT NOT NULL,
  departamento_solicitante TEXT NOT NULL DEFAULT 'MERCADEO Y PUBLICIDAD',
  solicitante_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  solicitante_nombre TEXT NOT NULL,
  destinatario_facturacion TEXT NOT NULL DEFAULT 'Facturación / Almacén Codizulca',
  destino_despacho TEXT NOT NULL DEFAULT 'Despacho Operativo Trade Marketing',
  observaciones TEXT NOT NULL DEFAULT '',
  categoria_presupuesto TEXT NOT NULL DEFAULT 'Activación BTL - Trade Marketing',
  tope_presupuesto_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (tope_presupuesto_usd >= 0),
  estado TEXT NOT NULL DEFAULT 'VALIDACION_COMERCIAL' CHECK (
    estado IN (
      'BORRADOR',
      'VALIDACION_COMERCIAL',
      'REVISION_FINANCIERA',
      'APROBADO_CONTRALORIA',
      'DESPACHADO_ALMACEN',
      'EN_EJECUCION',
      'RENDICION_PENDIENTE',
      'CONCILIADO_CERRADO',
      'RECHAZADO',
      'AJUSTE_SOLICITADO'
    )
  ),
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_unidades NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_unidades >= 0),
  costo_estimado_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (costo_estimado_usd >= 0),
  aprobador_comercial JSONB NULL,
  auditor_financiero JSONB NULL,
  aprobador_final JSONB NULL,
  motivo_rechazo TEXT NULL,
  paz_y_salvo_id UUID NULL,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_contraloria_req_codigo_no_vacio
    CHECK (length(btrim(codigo_correlativo)) >= 4),
  CONSTRAINT chk_contraloria_req_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_contraloria_requisiciones_sucursal_estado
  ON public.contraloria_requisiciones (sucursal, estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contraloria_requisiciones_solicitud_origen
  ON public.contraloria_requisiciones (solicitud_origen_id);

CREATE INDEX IF NOT EXISTS idx_contraloria_requisiciones_campana_id
  ON public.contraloria_requisiciones (campana_id);

-- Trigger de protección de integridad del workflow (S-03 + S-04):
-- Impide saltar etapas por UPDATE directo y bloquea mutaciones sobre requisiciones CONCILIADO_CERRADO.
CREATE OR REPLACE FUNCTION public.fn_proteger_workflow_requisicion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_via_rpc BOOLEAN := COALESCE(current_setting('codizulca.workflow_rpc', true), '') = '1';
  v_is_service BOOLEAN := COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.codigo_correlativo IS NULL
       OR btrim(NEW.codigo_correlativo) = ''
       OR upper(btrim(NEW.codigo_correlativo)) = 'AUTO' THEN
      NEW.codigo_correlativo := public.fn_generar_correlativo_mp07();
    ELSE
      NEW.codigo_correlativo := upper(btrim(NEW.codigo_correlativo));
    END IF;

    -- Anti auto-aprobación al insertar: solo nace en BORRADOR o VALIDACION_COMERCIAL salvo RPC/service
    IF NOT v_via_rpc AND NOT v_is_service AND NEW.estado NOT IN ('BORRADOR', 'VALIDACION_COMERCIAL') THEN
      RAISE EXCEPTION 'WORKFLOW_INITIAL_STATE_FORBIDDEN: Toda requisición debe iniciar en BORRADOR o VALIDACION_COMERCIAL.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.solicitante_uid IS NULL AND auth.uid() IS NOT NULL THEN
      NEW.solicitante_uid := auth.uid();
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.estado = 'CONCILIADO_CERRADO' THEN
      RAISE EXCEPTION 'IMMUTABLE_CLOSED_REQUISITION: La requisición % ya posee Paz y Salvo y está cerrada definitivamente.', OLD.codigo_correlativo
        USING ERRCODE = '23514';
    END IF;

    IF NEW.estado IS DISTINCT FROM OLD.estado AND NOT v_via_rpc AND NOT v_is_service THEN
      RAISE EXCEPTION 'WORKFLOW_RPC_REQUIRED: Las transiciones de estado deben ejecutarse mediante rpc_transicionar_requisicion_contraloria o rpc_emitir_paz_y_salvo.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.paz_y_salvo_id IS DISTINCT FROM OLD.paz_y_salvo_id AND NOT v_via_rpc AND NOT v_is_service THEN
      RAISE EXCEPTION 'PAZ_Y_SALVO_RPC_REQUIRED: Solo rpc_emitir_paz_y_salvo puede vincular un certificado.'
        USING ERRCODE = '42501';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_proteger_workflow_requisicion() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_hito4_proteger_workflow_req ON public.contraloria_requisiciones;
CREATE TRIGGER trg_hito4_proteger_workflow_req
  BEFORE INSERT OR UPDATE ON public.contraloria_requisiciones
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_proteger_workflow_requisicion();

DROP TRIGGER IF EXISTS trg_hito4_sellar_sucursal_req ON public.contraloria_requisiciones;
CREATE TRIGGER trg_hito4_sellar_sucursal_req
  BEFORE INSERT OR UPDATE ON public.contraloria_requisiciones
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.contraloria_requisiciones FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.contraloria_requisiciones TO authenticated;

ALTER TABLE public.contraloria_requisiciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contraloria_requisiciones FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contraloria_requisiciones_select_sede ON public.contraloria_requisiciones;
CREATE POLICY contraloria_requisiciones_select_sede
  ON public.contraloria_requisiciones
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS contraloria_requisiciones_insert_torre ON public.contraloria_requisiciones;
CREATE POLICY contraloria_requisiciones_insert_torre
  ON public.contraloria_requisiciones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS contraloria_requisiciones_update_torre ON public.contraloria_requisiciones;
CREATE POLICY contraloria_requisiciones_update_torre
  ON public.contraloria_requisiciones
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- =============================================================================
-- 6. TABLA: `public.contraloria_conciliaciones` (3 VÍAS + INMUTABILIDAD POST-CIERRE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.contraloria_conciliaciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisicion_id UUID NOT NULL UNIQUE REFERENCES public.contraloria_requisiciones(id) ON DELETE RESTRICT,
  codigo_correlativo TEXT NOT NULL,
  producto_principal TEXT NOT NULL DEFAULT '',
  unidades_entregadas NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unidades_entregadas >= 0),
  unidades_degustadas NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unidades_degustadas >= 0),
  unidades_devueltas NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unidades_devueltas >= 0),
  discrepancia_unidades NUMERIC(12, 2) GENERATED ALWAYS AS (
    unidades_entregadas - (unidades_degustadas + unidades_devueltas)
  ) STORED,
  estado_discrepancia TEXT NOT NULL DEFAULT 'CUADRADO'
    CHECK (estado_discrepancia IN ('CUADRADO', 'DESVIACION_ACEPTABLE', 'MERMA_NO_JUSTIFICADA')),
  acta_devolucion_almacen TEXT NOT NULL DEFAULT '',
  fondo_asignado_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (fondo_asignado_usd >= 0),
  total_gastos_reportados_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_gastos_reportados_usd >= 0),
  saldo_favor_usd NUMERIC(14, 2) NOT NULL DEFAULT 0,
  notas_auditoria TEXT NOT NULL DEFAULT '',
  cerrada BOOLEAN NOT NULL DEFAULT false,
  cerrada_en TIMESTAMPTZ NULL,
  cerrada_por_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_conciliaciones_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_contraloria_conciliaciones_sucursal_cerrada
  ON public.contraloria_conciliaciones (sucursal, cerrada, updated_at DESC);

CREATE OR REPLACE FUNCTION public.fn_proteger_conciliacion_inmutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_via_rpc BOOLEAN := COALESCE(current_setting('codizulca.workflow_rpc', true), '') = '1';
  v_disc NUMERIC(12, 2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECONCILIATION_DELETE: No se permite borrar físicamente conciliaciones de Contraloría.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.cerrada = true THEN
    RAISE EXCEPTION 'IMMUTABLE_CLOSED_RECONCILIATION: La conciliación % está sellada con Paz y Salvo y no puede modificarse.', OLD.codigo_correlativo
      USING ERRCODE = '23514';
  END IF;

  IF NEW.cerrada = true AND (TG_OP = 'INSERT' OR OLD.cerrada = false) AND NOT v_via_rpc THEN
    RAISE EXCEPTION 'PAZ_Y_SALVO_RPC_REQUIRED: El cierre definitivo de una conciliación solo puede ejecutarse mediante rpc_emitir_paz_y_salvo.'
      USING ERRCODE = '42501';
  END IF;

  v_disc := COALESCE(NEW.unidades_entregadas, 0) - (COALESCE(NEW.unidades_degustadas, 0) + COALESCE(NEW.unidades_devueltas, 0));
  NEW.estado_discrepancia := CASE
    WHEN v_disc = 0 THEN 'CUADRADO'
    WHEN abs(v_disc) <= 1 THEN 'DESVIACION_ACEPTABLE'
    ELSE 'MERMA_NO_JUSTIFICADA'
  END;
  NEW.saldo_favor_usd := COALESCE(NEW.fondo_asignado_usd, 0) - COALESCE(NEW.total_gastos_reportados_usd, 0);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_proteger_conciliacion_inmutable() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_hito4_proteger_conciliacion ON public.contraloria_conciliaciones;
CREATE TRIGGER trg_hito4_proteger_conciliacion
  BEFORE INSERT OR UPDATE OR DELETE ON public.contraloria_conciliaciones
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_proteger_conciliacion_inmutable();

DROP TRIGGER IF EXISTS trg_hito4_sellar_sucursal_conciliacion ON public.contraloria_conciliaciones;
CREATE TRIGGER trg_hito4_sellar_sucursal_conciliacion
  BEFORE INSERT OR UPDATE ON public.contraloria_conciliaciones
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.contraloria_conciliaciones FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.contraloria_conciliaciones TO authenticated;

ALTER TABLE public.contraloria_conciliaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contraloria_conciliaciones FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contraloria_conciliaciones_select_sede ON public.contraloria_conciliaciones;
CREATE POLICY contraloria_conciliaciones_select_sede
  ON public.contraloria_conciliaciones
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS contraloria_conciliaciones_insert_torre ON public.contraloria_conciliaciones;
CREATE POLICY contraloria_conciliaciones_insert_torre
  ON public.contraloria_conciliaciones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS contraloria_conciliaciones_update_torre ON public.contraloria_conciliaciones;
CREATE POLICY contraloria_conciliaciones_update_torre
  ON public.contraloria_conciliaciones
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
    AND cerrada = false
  )
  WITH CHECK (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- =============================================================================
-- 7. TABLA: `public.contraloria_facturas` (ANTIFRAUDE UNIQUE + STORAGE PRIVADO)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.contraloria_facturas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conciliacion_id UUID NOT NULL REFERENCES public.contraloria_conciliaciones(id) ON DELETE RESTRICT,
  requisicion_id UUID NOT NULL REFERENCES public.contraloria_requisiciones(id) ON DELETE RESTRICT,
  numero_factura TEXT NOT NULL,
  rif_proveedor TEXT NOT NULL,
  razon_social_proveedor TEXT NOT NULL,
  concepto TEXT NOT NULL,
  subtotal_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (subtotal_usd >= 0),
  impuesto_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (impuesto_usd >= 0),
  total_usd NUMERIC(14, 2) NOT NULL CHECK (total_usd > 0),
  storage_bucket TEXT NULL DEFAULT 'contraloria-facturas'
    CHECK (storage_bucket IS NULL OR storage_bucket = 'contraloria-facturas'),
  storage_path TEXT NULL CHECK (
    storage_path IS NULL
    OR storage_path ~ '^facturas/(ZULIA|VALENCIA)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(pdf|jpg|png|webp)$'
  ),
  mime_type TEXT NULL CHECK (
    mime_type IS NULL
    OR mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  ),
  tamano_bytes INTEGER NULL CHECK (
    tamano_bytes IS NULL OR (tamano_bytes > 0 AND tamano_bytes <= 10485760)
  ),
  archivo_sha256_hex CHAR(64) NULL CHECK (
    archivo_sha256_hex IS NULL OR archivo_sha256_hex ~ '^[0-9a-f]{64}$'
  ),
  validada_contraloria BOOLEAN NOT NULL DEFAULT false,
  validada_por_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  validada_por_nombre TEXT NULL,
  validada_en TIMESTAMPTZ NULL,
  notas_validacion TEXT NULL,
  cargado_por_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_contraloria_facturas_rif_numero UNIQUE (rif_proveedor, numero_factura),
  CONSTRAINT chk_facturas_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_contraloria_facturas_conciliacion_id
  ON public.contraloria_facturas (conciliacion_id);

CREATE INDEX IF NOT EXISTS idx_contraloria_facturas_requisicion_id
  ON public.contraloria_facturas (requisicion_id);

CREATE INDEX IF NOT EXISTS idx_contraloria_facturas_sucursal_validada
  ON public.contraloria_facturas (sucursal, validada_contraloria);

CREATE OR REPLACE FUNCTION public.fn_proteger_factura_y_recalcular()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cerrada BOOLEAN;
  v_conc_id UUID;
  v_total_gastos NUMERIC(14, 2);
  v_is_service BOOLEAN := COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role';
BEGIN
  v_conc_id := COALESCE(NEW.conciliacion_id, OLD.conciliacion_id);

  SELECT c.cerrada INTO v_cerrada
  FROM public.contraloria_conciliaciones c
  WHERE c.id = v_conc_id
  FOR UPDATE;

  IF v_cerrada = true THEN
    RAISE EXCEPTION 'IMMUTABLE_CLOSED_RECONCILIATION: No se pueden crear, editar ni eliminar facturas en una conciliación cerrada con Paz y Salvo.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_FACTURA_DELETE: Las facturas fiscales no se borran físicamente; deben observarse por Contraloría.'
      USING ERRCODE = '23514';
  END IF;

  NEW.numero_factura := upper(btrim(COALESCE(NEW.numero_factura, '')));
  NEW.rif_proveedor := upper(btrim(COALESCE(NEW.rif_proveedor, '')));
  NEW.razon_social_proveedor := btrim(COALESCE(NEW.razon_social_proveedor, ''));
  NEW.concepto := btrim(COALESCE(NEW.concepto, ''));

  IF TG_OP = 'INSERT' THEN
    IF NOT v_is_service AND NEW.validada_contraloria = true AND NOT public.is_contraloria_or_admin() THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Contraloría Interna o Super Admin puede validar fiscalmente una factura.'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.cargado_por_uid IS NULL AND auth.uid() IS NOT NULL THEN
      NEW.cargado_por_uid := auth.uid();
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.validada_contraloria IS DISTINCT FROM OLD.validada_contraloria
        OR NEW.notas_validacion IS DISTINCT FROM OLD.notas_validacion)
       AND NOT v_is_service
       AND NOT public.is_contraloria_or_admin() THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Contraloría Interna o Super Admin puede validar u observar comprobantes fiscales.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.validada_contraloria = true AND OLD.validada_contraloria = false THEN
      NEW.validada_en := now();
      IF NEW.validada_por_uid IS NULL AND auth.uid() IS NOT NULL THEN
        NEW.validada_por_uid := auth.uid();
      END IF;
    END IF;
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_proteger_factura_y_recalcular() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.fn_recalcular_totales_conciliacion_after_factura()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conc_id UUID := COALESCE(NEW.conciliacion_id, OLD.conciliacion_id);
  v_sum NUMERIC(14, 2);
BEGIN
  SELECT COALESCE(SUM(total_usd), 0)
  INTO v_sum
  FROM public.contraloria_facturas
  WHERE conciliacion_id = v_conc_id;

  UPDATE public.contraloria_conciliaciones
  SET total_gastos_reportados_usd = v_sum,
      saldo_favor_usd = fondo_asignado_usd - v_sum,
      updated_at = now()
  WHERE id = v_conc_id
    AND cerrada = false;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_recalcular_totales_conciliacion_after_factura() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_hito4_proteger_factura ON public.contraloria_facturas;
CREATE TRIGGER trg_hito4_proteger_factura
  BEFORE INSERT OR UPDATE OR DELETE ON public.contraloria_facturas
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_proteger_factura_y_recalcular();

DROP TRIGGER IF EXISTS trg_hito4_recalcular_gastos_factura ON public.contraloria_facturas;
CREATE TRIGGER trg_hito4_recalcular_gastos_factura
  AFTER INSERT OR UPDATE ON public.contraloria_facturas
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_recalcular_totales_conciliacion_after_factura();

DROP TRIGGER IF EXISTS trg_hito4_sellar_sucursal_factura ON public.contraloria_facturas;
CREATE TRIGGER trg_hito4_sellar_sucursal_factura
  BEFORE INSERT OR UPDATE ON public.contraloria_facturas
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.contraloria_facturas FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.contraloria_facturas TO authenticated;

ALTER TABLE public.contraloria_facturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contraloria_facturas FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contraloria_facturas_select_sede ON public.contraloria_facturas;
CREATE POLICY contraloria_facturas_select_sede
  ON public.contraloria_facturas
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS contraloria_facturas_insert_torre ON public.contraloria_facturas;
CREATE POLICY contraloria_facturas_insert_torre
  ON public.contraloria_facturas
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

DROP POLICY IF EXISTS contraloria_facturas_update_contraloria ON public.contraloria_facturas;
CREATE POLICY contraloria_facturas_update_contraloria
  ON public.contraloria_facturas
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  )
  WITH CHECK (
    (SELECT public.is_contraloria_or_admin())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- =============================================================================
-- 8. TABLA: `public.certificados_paz_y_salvo` (SHA-256 REAL + INMUTABLE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.certificados_paz_y_salvo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_certificado TEXT NOT NULL UNIQUE,
  requisicion_id UUID NOT NULL UNIQUE REFERENCES public.contraloria_requisiciones(id) ON DELETE RESTRICT,
  conciliacion_id UUID NOT NULL UNIQUE REFERENCES public.contraloria_conciliaciones(id) ON DELETE RESTRICT,
  codigo_correlativo TEXT NOT NULL,
  payload_canonico JSONB NOT NULL,
  sha256_hash CHAR(64) NOT NULL CHECK (sha256_hash ~ '^[0-9a-f]{64}$'),
  emitido_por_uid UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  emitido_por_nombre TEXT NOT NULL,
  emitido_por_rol TEXT NOT NULL CHECK (emitido_por_rol IN ('contraloria', 'super_admin')),
  emitido_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  notas_cierre TEXT NOT NULL,
  sucursal public.sucursal_codigo,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_paz_y_salvo_sucursal_operativa
    CHECK (sucursal IS NULL OR sucursal <> 'GLOBAL'::public.sucursal_codigo)
);

CREATE INDEX IF NOT EXISTS idx_certificados_paz_y_salvo_sucursal_emitido
  ON public.certificados_paz_y_salvo (sucursal, emitido_en DESC);

-- FK diferida desde `contraloria_requisiciones.paz_y_salvo_id` (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_contraloria_req_paz_y_salvo'
  ) THEN
    ALTER TABLE public.contraloria_requisiciones
      ADD CONSTRAINT fk_contraloria_req_paz_y_salvo
      FOREIGN KEY (paz_y_salvo_id)
      REFERENCES public.certificados_paz_y_salvo(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_bloquear_mutacion_paz_y_salvo()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_PAZ_Y_SALVO: Los certificados de Paz y Salvo son inmutables (prohibido % sobre %).', TG_OP, OLD.codigo_certificado
    USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.fn_bloquear_mutacion_paz_y_salvo() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_hito4_inmutable_paz_y_salvo ON public.certificados_paz_y_salvo;
CREATE TRIGGER trg_hito4_inmutable_paz_y_salvo
  BEFORE UPDATE OR DELETE ON public.certificados_paz_y_salvo
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_bloquear_mutacion_paz_y_salvo();

-- Solo SELECT directo para authenticated; INSERT únicamente mediante `rpc_emitir_paz_y_salvo`
REVOKE ALL ON TABLE public.certificados_paz_y_salvo FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.certificados_paz_y_salvo TO authenticated;

ALTER TABLE public.certificados_paz_y_salvo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certificados_paz_y_salvo FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS certificados_paz_y_salvo_select_sede ON public.certificados_paz_y_salvo;
CREATE POLICY certificados_paz_y_salvo_select_sede
  ON public.certificados_paz_y_salvo
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (SELECT public.tiene_acceso_sucursal(sucursal))
  );

-- Sincronizar la secuencia MP-07-XXXX con el máximo correlativo ya persistido en ambas tablas
DO $$
DECLARE
  v_max_sol BIGINT := 71;
  v_max_req BIGINT := 71;
  v_target BIGINT := 71;
BEGIN
  SELECT COALESCE(
    MAX(substring(upper(btrim(codigo_correlativo)) FROM '^MP-07-([0-9]+)$')::bigint),
    71
  )
  INTO v_max_sol
  FROM public.solicitudes_contraloria
  WHERE upper(btrim(codigo_correlativo)) ~ '^MP-07-[0-9]+$';

  SELECT COALESCE(
    MAX(substring(upper(btrim(codigo_correlativo)) FROM '^MP-07-([0-9]+)$')::bigint),
    71
  )
  INTO v_max_req
  FROM public.contraloria_requisiciones
  WHERE upper(btrim(codigo_correlativo)) ~ '^MP-07-[0-9]+$';

  v_target := GREATEST(71, v_max_sol, v_max_req);
  PERFORM setval('public.seq_mp07_correlativo', v_target, true);
END $$;

-- =============================================================================
-- 9. BUCKET PRIVADO `contraloria-facturas` EN SUPABASE STORAGE + RLS
-- =============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contraloria-facturas',
  'contraloria-facturas',
  false,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS storage_contraloria_facturas_select ON storage.objects;
CREATE POLICY storage_contraloria_facturas_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'contraloria-facturas'
    AND (storage.foldername(name))[1] = 'facturas'
    AND (SELECT public.is_torre_control_viewer())
    AND (
      (SELECT public.obtener_mi_sucursal()) = 'GLOBAL'::public.sucursal_codigo
      OR upper(COALESCE((storage.foldername(name))[2], '')) = (SELECT public.obtener_mi_sucursal())::text
    )
  );

DROP POLICY IF EXISTS storage_contraloria_facturas_insert ON storage.objects;
CREATE POLICY storage_contraloria_facturas_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'contraloria-facturas'
    AND (storage.foldername(name))[1] = 'facturas'
    AND (SELECT public.is_torre_control_viewer())
    AND (
      (SELECT public.obtener_mi_sucursal()) = 'GLOBAL'::public.sucursal_codigo
      OR upper(COALESCE((storage.foldername(name))[2], '')) = (SELECT public.obtener_mi_sucursal())::text
    )
  );

-- =============================================================================
-- 10. RPCs SERVIDOR: SOLICITUDES ATÓMICAS, REQUISICIONES 8 ETAPAS Y PAZ Y SALVO
-- =============================================================================

-- 10.1 Alta atómica de Solicitud de Productos a Contraloría con secuencia MP-07-XXXX (P-05)
CREATE OR REPLACE FUNCTION public.rpc_crear_solicitud_contraloria(p_payload JSONB)
RETURNS public.solicitudes_contraloria
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
  v_items JSONB := COALESCE(p_payload -> 'items', '[]'::jsonb);
  v_total NUMERIC := COALESCE((p_payload ->> 'total_unidades')::numeric, 0);
  v_para TEXT := upper(btrim(COALESCE(p_payload ->> 'para_ser_utilizado', '')));
  v_sucursal public.sucursal_codigo;
  v_row public.solicitudes_contraloria;
BEGIN
  IF NOT public.is_coordinadora_or_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Solo Coordinación Trade o Super Admin puede radicar solicitudes a Contraloría.'
      USING ERRCODE = '42501';
  END IF;

  IF length(v_para) < 2 THEN
    RAISE EXCEPTION 'INVALID_PARA_SER_UTILIZADO: El campo para_ser_utilizado es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'INVALID_ITEMS: Debe incluir al menos un ítem de producto válido.'
      USING ERRCODE = '22023';
  END IF;

  v_code := public.fn_generar_correlativo_mp07();
  v_sucursal := COALESCE(
    public.fn_normalizar_sucursal_codigo(p_payload ->> 'sucursal'),
    CASE
      WHEN public.obtener_mi_sucursal() IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo)
        THEN public.obtener_mi_sucursal()
      ELSE 'ZULIA'::public.sucursal_codigo
    END
  );

  INSERT INTO public.solicitudes_contraloria (
    codigo_correlativo,
    fecha_solicitud,
    fecha_iso,
    dirigido_a,
    para_ser_utilizado,
    items,
    total_unidades,
    observacion,
    solicitado_por,
    firma_digital_texto,
    firma_digital_imagen,
    departamento_solicitante,
    estado,
    leido_contraloria,
    sucursal
  )
  VALUES (
    v_code,
    COALESCE(NULLIF(btrim(p_payload ->> 'fecha_solicitud'), ''), to_char(CURRENT_DATE, 'DD/MM/YYYY')),
    COALESCE(NULLIF(btrim(p_payload ->> 'fecha_iso'), ''), to_char(CURRENT_DATE, 'YYYY-MM-DD')),
    upper(COALESCE(NULLIF(btrim(p_payload ->> 'dirigido_a'), ''), 'CONTRALORÍA')),
    v_para,
    v_items,
    GREATEST(0, v_total),
    upper(btrim(COALESCE(p_payload ->> 'observacion', ''))),
    COALESCE(NULLIF(btrim(p_payload ->> 'solicitado_por'), ''), 'Jefatura Trade Marketing'),
    NULLIF(btrim(p_payload ->> 'firma_digital_texto'), ''),
    NULLIF(btrim(p_payload ->> 'firma_digital_imagen'), ''),
    upper(COALESCE(NULLIF(btrim(p_payload ->> 'departamento_solicitante'), ''), 'MERCADEO Y PUBLICIDAD')),
    'PENDIENTE_APROBACION',
    false,
    v_sucursal
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_crear_solicitud_contraloria(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_crear_solicitud_contraloria(JSONB) TO authenticated, service_role;

-- 10.2 Alta atómica de Requisición (8 etapas) + Conciliación inicial emparejada
CREATE OR REPLACE FUNCTION public.rpc_crear_requisicion_contraloria(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_rol TEXT := public.obtener_mi_rol();
  v_my_suc public.sucursal_codigo := public.obtener_mi_sucursal();
  v_target_suc public.sucursal_codigo;
  v_code TEXT;
  v_estado_inicial TEXT;
  v_items JSONB := COALESCE(p_payload -> 'items', '[]'::jsonb);
  v_total_units NUMERIC(12, 2) := COALESCE((p_payload ->> 'total_unidades')::numeric, 0);
  v_est_cost NUMERIC(14, 2) := COALESCE((p_payload ->> 'costo_estimado_usd')::numeric, 0);
  v_req public.contraloria_requisiciones;
  v_conc public.contraloria_conciliaciones;
  v_first_prod TEXT := '';
BEGIN
  IF v_uid IS NULL OR v_rol NOT IN ('super_admin', 'coordinacion', 'contraloria') THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: Solo Torre de Control / Contraloría puede crear requisiciones.'
      USING ERRCODE = '42501';
  END IF;

  IF v_my_suc IN ('ZULIA'::public.sucursal_codigo, 'VALENCIA'::public.sucursal_codigo) THEN
    v_target_suc := v_my_suc;
  ELSE
    v_target_suc := COALESCE(
      public.fn_normalizar_sucursal_codigo(p_payload ->> 'sucursal'),
      'ZULIA'::public.sucursal_codigo
    );
    IF v_target_suc = 'GLOBAL'::public.sucursal_codigo THEN
      v_target_suc := 'ZULIA'::public.sucursal_codigo;
    END IF;
  END IF;

  IF NOT public.tiene_acceso_sucursal(v_target_suc) THEN
    RAISE EXCEPTION 'FORBIDDEN_BRANCH: No tienes permiso para crear requisiciones en la sede %.', v_target_suc
      USING ERRCODE = '42501';
  END IF;

  v_code := upper(btrim(COALESCE(p_payload ->> 'codigo_correlativo', '')));
  IF v_code = '' OR v_code = 'AUTO' THEN
    v_code := public.fn_generar_correlativo_mp07();
  END IF;

  -- Nunca se permite nacer en APROBADO_CONTRALORIA ni CONCILIADO_CERRADO (Segregación S-03)
  v_estado_inicial := CASE
    WHEN upper(btrim(COALESCE(p_payload ->> 'estado', ''))) = 'BORRADOR' THEN 'BORRADOR'
    ELSE 'VALIDACION_COMERCIAL'
  END;

  PERFORM set_config('codizulca.workflow_rpc', '1', true);

  INSERT INTO public.contraloria_requisiciones (
    codigo_correlativo,
    solicitud_origen_id,
    campana_id,
    presupuesto_id,
    fecha_solicitud,
    fecha_iso,
    departamento_destino,
    proposito_campana,
    departamento_solicitante,
    solicitante_uid,
    solicitante_nombre,
    destinatario_facturacion,
    destino_despacho,
    observaciones,
    categoria_presupuesto,
    tope_presupuesto_usd,
    estado,
    items,
    total_unidades,
    costo_estimado_usd,
    sucursal
  )
  VALUES (
    v_code,
    CASE WHEN (p_payload ->> 'solicitud_origen_id') ~ '^[0-9a-fA-F-]{36}$'
         THEN (p_payload ->> 'solicitud_origen_id')::uuid ELSE NULL END,
    CASE WHEN (p_payload ->> 'campana_id') ~ '^[0-9a-fA-F-]{36}$'
         THEN (p_payload ->> 'campana_id')::uuid ELSE NULL END,
    CASE WHEN (p_payload ->> 'presupuesto_id') ~ '^[0-9a-fA-F-]{36}$'
         THEN (p_payload ->> 'presupuesto_id')::uuid ELSE NULL END,
    COALESCE(NULLIF(btrim(p_payload ->> 'fecha_solicitud'), ''), to_char(CURRENT_DATE, 'DD/MM/YYYY')),
    COALESCE(NULLIF(btrim(p_payload ->> 'fecha_iso'), '')::date, CURRENT_DATE),
    COALESCE(NULLIF(btrim(p_payload ->> 'departamento_destino'), ''), 'CONTRALORÍA'),
    COALESCE(NULLIF(btrim(p_payload ->> 'proposito_campana'), ''), 'Activación Trade Marketing'),
    COALESCE(NULLIF(btrim(p_payload ->> 'departamento_solicitante'), ''), 'MERCADEO Y PUBLICIDAD'),
    v_uid,
    COALESCE(NULLIF(btrim(p_payload ->> 'solicitante_nombre'), ''), 'Trade Marketing'),
    COALESCE(NULLIF(btrim(p_payload ->> 'destinatario_facturacion'), ''), 'Facturación / Almacén Codizulca'),
    COALESCE(NULLIF(btrim(p_payload ->> 'destino_despacho'), ''), 'Despacho Operativo Trade Marketing'),
    COALESCE(btrim(p_payload ->> 'observaciones'), ''),
    COALESCE(NULLIF(btrim(p_payload ->> 'categoria_presupuesto'), ''), 'Activación BTL - Trade Marketing'),
    GREATEST(v_est_cost, COALESCE((p_payload ->> 'tope_presupuesto_usd')::numeric, v_est_cost)),
    v_estado_inicial,
    v_items,
    GREATEST(0, v_total_units),
    GREATEST(0, v_est_cost),
    v_target_suc
  )
  RETURNING * INTO v_req;

  IF jsonb_typeof(v_items) = 'array' AND jsonb_array_length(v_items) > 0 THEN
    v_first_prod := COALESCE(v_items -> 0 ->> 'productName', v_items -> 0 ->> 'producto', '');
  END IF;

  INSERT INTO public.contraloria_conciliaciones (
    requisicion_id,
    codigo_correlativo,
    producto_principal,
    unidades_entregadas,
    unidades_degustadas,
    unidades_devueltas,
    fondo_asignado_usd,
    sucursal
  )
  VALUES (
    v_req.id,
    v_req.codigo_correlativo,
    COALESCE(NULLIF(v_first_prod, ''), v_req.proposito_campana),
    v_req.total_unidades,
    0,
    0,
    0,
    v_req.sucursal
  )
  RETURNING * INTO v_conc;

  RETURN jsonb_build_object(
    'ok', true,
    'requisicion', to_jsonb(v_req),
    'conciliacion', to_jsonb(v_conc)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_crear_requisicion_contraloria(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_crear_requisicion_contraloria(JSONB) TO authenticated, service_role;

-- 10.3 Transición de etapa del workflow de 8 etapas con verificación de rol EN BASE DE DATOS (S-03)
CREATE OR REPLACE FUNCTION public.rpc_transicionar_requisicion_contraloria(
  p_requisicion_id UUID,
  p_estado_destino TEXT,
  p_justificacion TEXT DEFAULT '',
  p_comentarios TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_rol TEXT := public.obtener_mi_rol();
  v_actor_name TEXT;
  v_req public.contraloria_requisiciones;
  v_dest TEXT := upper(btrim(COALESCE(p_estado_destino, '')));
  v_note TEXT := btrim(COALESCE(NULLIF(btrim(p_justificacion), ''), p_comentarios, ''));
  v_stamp JSONB;
  v_has_pys BOOLEAN;
  v_updated public.contraloria_requisiciones;
BEGIN
  IF v_uid IS NULL OR v_rol NOT IN ('super_admin', 'coordinacion', 'contraloria') THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: No tienes autorización sobre el flujo de Contraloría.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req
  FROM public.contraloria_requisiciones
  WHERE id = p_requisicion_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REQUISITION_NOT_FOUND: Requisición no encontrada.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.tiene_acceso_sucursal(v_req.sucursal) THEN
    RAISE EXCEPTION 'FORBIDDEN_BRANCH: No puedes operar requisiciones de otra sucursal.'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.estado IN ('CONCILIADO_CERRADO', 'RECHAZADO') THEN
    RAISE EXCEPTION 'TERMINAL_STATE: La requisición % se encuentra en estado terminal (%).', v_req.codigo_correlativo, v_req.estado
      USING ERRCODE = '23514';
  END IF;

  -- Matriz estricta de transiciones y Segregación de Funciones por etapa (S-03)
  IF v_req.estado = 'BORRADOR' AND v_dest = 'VALIDACION_COMERCIAL' THEN
    IF v_rol NOT IN ('coordinacion', 'super_admin') THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Coordinación Trade o Super Admin puede radicar a Validación Comercial.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_req.estado = 'AJUSTE_SOLICITADO' AND v_dest = 'VALIDACION_COMERCIAL' THEN
    IF v_rol NOT IN ('coordinacion', 'super_admin') THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Coordinación Trade o Super Admin puede reenviar tras ajuste.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_req.estado = 'VALIDACION_COMERCIAL' AND v_dest IN ('REVISION_FINANCIERA', 'AJUSTE_SOLICITADO') THEN
    IF v_rol NOT IN ('coordinacion', 'super_admin') THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: La Validación Comercial corresponde a Coordinación Trade o Super Admin.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_req.estado = 'REVISION_FINANCIERA' AND v_dest IN ('APROBADO_CONTRALORIA', 'RECHAZADO', 'AJUSTE_SOLICITADO') THEN
    IF v_rol NOT IN ('contraloria', 'super_admin') THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Contraloría Interna o Super Admin puede aprobar o rechazar en Revisión Financiera.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_req.estado = 'APROBADO_CONTRALORIA' AND v_dest = 'DESPACHADO_ALMACEN' THEN
    IF v_rol NOT IN ('coordinacion', 'contraloria', 'super_admin') THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Rol sin permiso para confirmar Despacho de Almacén.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_req.estado = 'DESPACHADO_ALMACEN' AND v_dest = 'EN_EJECUCION' THEN
    IF v_rol NOT IN ('coordinacion', 'super_admin') THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Coordinación Trade o Super Admin puede iniciar ejecución en PDVs.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_req.estado = 'EN_EJECUCION' AND v_dest = 'RENDICION_PENDIENTE' THEN
    IF v_rol NOT IN ('coordinacion', 'super_admin') THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Coordinación Trade o Super Admin puede pasar a Rendición Pendiente.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_req.estado = 'RENDICION_PENDIENTE' AND v_dest = 'CONCILIADO_CERRADO' THEN
    IF v_rol NOT IN ('contraloria', 'super_admin') THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Contraloría Interna o Super Admin puede cerrar definitivamente una requisición.'
        USING ERRCODE = '42501';
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.certificados_paz_y_salvo WHERE requisicion_id = v_req.id
    ) INTO v_has_pys;
    IF NOT v_has_pys THEN
      RAISE EXCEPTION 'PAZ_Y_SALVO_REQUIRED: Debe emitir el certificado de Paz y Salvo (rpc_emitir_paz_y_salvo) para cerrar definitivamente.'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'INVALID_WORKFLOW_TRANSITION: Transición no permitida de % hacia %.', v_req.estado, v_dest
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(NULLIF(btrim(full_name), ''), email, v_rol)
  INTO v_actor_name
  FROM public.profiles
  WHERE id = v_uid;

  v_stamp := jsonb_build_object(
    'uid', v_uid,
    'name', COALESCE(v_actor_name, v_rol),
    'role', v_rol,
    'date', to_char(now() AT TIME ZONE 'America/Caracas', 'DD/MM/YYYY HH24:MI:SS'),
    'comments', v_note
  );

  PERFORM set_config('codizulca.workflow_rpc', '1', true);

  UPDATE public.contraloria_requisiciones
  SET
    estado = v_dest,
    aprobador_comercial = CASE WHEN v_dest = 'REVISION_FINANCIERA' THEN v_stamp ELSE aprobador_comercial END,
    auditor_financiero = CASE WHEN v_dest IN ('APROBADO_CONTRALORIA', 'RECHAZADO', 'AJUSTE_SOLICITADO') AND v_req.estado = 'REVISION_FINANCIERA' THEN v_stamp ELSE auditor_financiero END,
    aprobador_final = CASE WHEN v_dest IN ('APROBADO_CONTRALORIA', 'CONCILIADO_CERRADO') THEN v_stamp ELSE aprobador_final END,
    motivo_rechazo = CASE WHEN v_dest = 'RECHAZADO' THEN COALESCE(NULLIF(v_note, ''), 'Rechazado por Contraloría Interna.') ELSE motivo_rechazo END,
    updated_at = now()
  WHERE id = v_req.id
  RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'ok', true,
    'estado_anterior', v_req.estado,
    'estado_actual', v_updated.estado,
    'requisicion', to_jsonb(v_updated)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_transicionar_requisicion_contraloria(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_transicionar_requisicion_contraloria(UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- 10.4 Emisión de Paz y Salvo con SHA-256 real en servidor (pgcrypto) y sellado inmutable (S-04)
CREATE OR REPLACE FUNCTION public.rpc_emitir_paz_y_salvo(
  p_requisicion_id UUID,
  p_notas_cierre TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_rol TEXT := public.obtener_mi_rol();
  v_actor_name TEXT;
  v_req public.contraloria_requisiciones;
  v_conc public.contraloria_conciliaciones;
  v_unvalidated_count INTEGER := 0;
  v_facturas_json JSONB := '[]'::jsonb;
  v_now TIMESTAMPTZ := now();
  v_cert_code TEXT;
  v_notes TEXT;
  v_canonical JSONB;
  v_sha256 TEXT;
  v_cert public.certificados_paz_y_salvo;
  v_req_closed public.contraloria_requisiciones;
  v_conc_closed public.contraloria_conciliaciones;
BEGIN
  IF v_uid IS NULL OR NOT public.is_contraloria_or_admin() THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: Solo Contraloría Interna o Super Admin puede emitir y sellar un Paz y Salvo.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req
  FROM public.contraloria_requisiciones
  WHERE id = p_requisicion_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REQUISITION_NOT_FOUND: Requisición no encontrada.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.tiene_acceso_sucursal(v_req.sucursal) THEN
    RAISE EXCEPTION 'FORBIDDEN_BRANCH: No tienes permiso para emitir Paz y Salvo en otra sede.'
      USING ERRCODE = '42501';
  END IF;

  IF v_req.estado = 'RECHAZADO' THEN
    RAISE EXCEPTION 'REJECTED_REQUISITION: No se puede emitir Paz y Salvo sobre una requisición rechazada.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_conc
  FROM public.contraloria_conciliaciones
  WHERE requisicion_id = v_req.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECONCILIATION_NOT_FOUND: No existe registro de conciliación para la requisición %.', v_req.codigo_correlativo
      USING ERRCODE = 'P0002';
  END IF;

  IF v_conc.cerrada = true OR v_req.paz_y_salvo_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAZ_Y_SALVO_ALREADY_ISSUED: Ya existe un certificado Paz y Salvo inmutable para %.', v_req.codigo_correlativo
      USING ERRCODE = '23505';
  END IF;

  IF (v_conc.unidades_entregadas - (v_conc.unidades_degustadas + v_conc.unidades_devueltas)) <> 0 THEN
    RAISE EXCEPTION 'VARIANCE_BLOCK: No se puede emitir Paz y Salvo con una diferencia física de % unidades sin justificar.',
      (v_conc.unidades_entregadas - (v_conc.unidades_degustadas + v_conc.unidades_devueltas))
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO v_unvalidated_count
  FROM public.contraloria_facturas
  WHERE conciliacion_id = v_conc.id
    AND validada_contraloria = false;

  IF v_unvalidated_count > 0 THEN
    RAISE EXCEPTION 'UNVALIDATED_INVOICES: Existen % factura(s) fiscal(es) sin conformidad de Contraloría.', v_unvalidated_count
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', f.id,
        'numero_factura', f.numero_factura,
        'rif_proveedor', f.rif_proveedor,
        'total_usd', f.total_usd,
        'archivo_sha256_hex', f.archivo_sha256_hex
      )
      ORDER BY f.id
    ),
    '[]'::jsonb
  )
  INTO v_facturas_json
  FROM public.contraloria_facturas f
  WHERE f.conciliacion_id = v_conc.id;

  SELECT COALESCE(NULLIF(btrim(full_name), ''), email, v_rol)
  INTO v_actor_name
  FROM public.profiles
  WHERE id = v_uid;

  v_cert_code := 'PYS-' || v_req.codigo_correlativo;
  v_notes := COALESCE(
    NULLIF(btrim(p_notas_cierre), ''),
    'Conciliación conforme y auditada para solicitud ' || v_req.codigo_correlativo || '.'
  );

  v_canonical := jsonb_build_object(
    'schema', 'codizulca.paz_y_salvo.v1',
    'codigo_certificado', v_cert_code,
    'requisicion_id', v_req.id,
    'conciliacion_id', v_conc.id,
    'codigo_correlativo', v_req.codigo_correlativo,
    'sucursal', v_req.sucursal::text,
    'unidades_entregadas', v_conc.unidades_entregadas,
    'unidades_degustadas', v_conc.unidades_degustadas,
    'unidades_devueltas', v_conc.unidades_devueltas,
    'acta_devolucion_almacen', v_conc.acta_devolucion_almacen,
    'fondo_asignado_usd', v_conc.fondo_asignado_usd,
    'total_gastos_reportados_usd', v_conc.total_gastos_reportados_usd,
    'saldo_favor_usd', v_conc.fondo_asignado_usd - v_conc.total_gastos_reportados_usd,
    'facturas_validadas', v_facturas_json,
    'emitido_por_uid', v_uid,
    'emitido_por_rol', v_rol,
    'emitido_en', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'notas_cierre', v_notes
  );

  -- Cálculo real de SHA-256 en servidor PostgreSQL (`pgcrypto`)
  v_sha256 := encode(digest(convert_to(v_canonical::text, 'UTF8'), 'sha256'), 'hex');

  INSERT INTO public.certificados_paz_y_salvo (
    codigo_certificado,
    requisicion_id,
    conciliacion_id,
    codigo_correlativo,
    payload_canonico,
    sha256_hash,
    emitido_por_uid,
    emitido_por_nombre,
    emitido_por_rol,
    emitido_en,
    notas_cierre,
    sucursal
  )
  VALUES (
    v_cert_code,
    v_req.id,
    v_conc.id,
    v_req.codigo_correlativo,
    v_canonical,
    v_sha256,
    v_uid,
    COALESCE(v_actor_name, v_rol),
    v_rol,
    v_now,
    v_notes,
    v_req.sucursal
  )
  RETURNING * INTO v_cert;

  PERFORM set_config('codizulca.workflow_rpc', '1', true);

  UPDATE public.contraloria_conciliaciones
  SET
    notas_auditoria = v_notes,
    cerrada = true,
    cerrada_en = v_now,
    cerrada_por_uid = v_uid,
    updated_at = v_now
  WHERE id = v_conc.id
  RETURNING * INTO v_conc_closed;

  UPDATE public.contraloria_requisiciones
  SET
    estado = 'CONCILIADO_CERRADO',
    paz_y_salvo_id = v_cert.id,
    aprobador_final = jsonb_build_object(
      'uid', v_uid,
      'name', COALESCE(v_actor_name, v_rol),
      'role', v_rol,
      'date', to_char(v_now AT TIME ZONE 'America/Caracas', 'DD/MM/YYYY HH24:MI:SS'),
      'comments', v_notes
    ),
    updated_at = v_now
  WHERE id = v_req.id
  RETURNING * INTO v_req_closed;

  RETURN jsonb_build_object(
    'ok', true,
    'certificado', to_jsonb(v_cert),
    'conciliacion', to_jsonb(v_conc_closed),
    'requisicion', to_jsonb(v_req_closed)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_emitir_paz_y_salvo(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_emitir_paz_y_salvo(UUID, TEXT) TO authenticated, service_role;

-- 10.5 Verificación criptográfica en servidor de un Paz y Salvo existente (S-04)
CREATE OR REPLACE FUNCTION public.rpc_verificar_paz_y_salvo(p_codigo_certificado TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_cert public.certificados_paz_y_salvo;
  v_recomputed TEXT;
BEGIN
  SELECT * INTO v_cert
  FROM public.certificados_paz_y_salvo
  WHERE codigo_certificado = upper(btrim(COALESCE(p_codigo_certificado, '')));

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'found', false,
      'valid', false
    );
  END IF;

  v_recomputed := encode(digest(convert_to(v_cert.payload_canonico::text, 'UTF8'), 'sha256'), 'hex');

  RETURN jsonb_build_object(
    'found', true,
    'valid', (v_recomputed = v_cert.sha256_hash),
    'codigo_certificado', v_cert.codigo_certificado,
    'stored_sha256', v_cert.sha256_hash,
    'recomputed_sha256', v_recomputed,
    'emitido_en', v_cert.emitido_en,
    'emitido_por_nombre', v_cert.emitido_por_nombre
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_verificar_paz_y_salvo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_verificar_paz_y_salvo(TEXT) TO authenticated, service_role;

COMMIT;
