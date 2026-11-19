-- =============================================================================
-- COMPUERTA G2 — EXPANSIÓN OFICIAL A 5 REGIONES (ZULIA, VALENCIA, CENTRO,
-- ORIENTE, CAPITAL), MOTOR CANÓNICO CORREO -> REGIÓN, RLS MULTI-HUB Y
-- COMPARATIVO EJECUTIVO CONSOLIDADO
--
-- Archivo: supabase/migrations/20261119000100_cinco_regiones_motor_correo_rls_y_comparativo.sql
-- Motor objetivo: PostgreSQL 15+ / 17 (Supabase)
--
-- Garantías inquebrantables:
--   1. Regla PostgreSQL 15+/17 para ENUMs: ALTER TYPE ... ADD VALUE IF NOT EXISTS
--      se ejecuta fuera y antes de BEGIN; para evitar SQLSTATE 55P04.
--   2. 100 % aditivo e idempotente (cero operaciones destructivas sobre tablas,
--      columnas o filas). Reutiliza public.regiones, public.supervisores y
--      public.productos sin recrearlas.
--   3. Identidad canónica por correo verificado LOWER(TRIM(auth.jwt() ->> 'email'))
--      y vínculo por UUID + app_metadata firmado en servidor (jamás metadatos editables por cliente).
--   4. Aislamiento estricto por hub activo (obtener_sucursal_contexto_activo)
--      para roles regionales y sesiones GLOBAL acotadas vía x-sucursal-activa.
-- =============================================================================

ALTER TYPE public.sucursal_codigo ADD VALUE IF NOT EXISTS 'CENTRO';
ALTER TYPE public.sucursal_codigo ADD VALUE IF NOT EXISTS 'ORIENTE';
ALTER TYPE public.sucursal_codigo ADD VALUE IF NOT EXISTS 'CAPITAL';

BEGIN;

-- =============================================================================
-- 1. REUTILIZACIÓN SEGURA DE CATÁLOGOS EXISTENTES:
--    public.regiones, public.supervisores y public.productos
-- =============================================================================

ALTER TABLE public.regiones
  ADD COLUMN IF NOT EXISTS codigo TEXT,
  ADD COLUMN IF NOT EXISTS nombre TEXT,
  ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.supervisores
  ADD COLUMN IF NOT EXISTS codigo TEXT,
  ADD COLUMN IF NOT EXISTS nombre TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS telefono TEXT,
  ADD COLUMN IF NOT EXISTS zona TEXT,
  ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_codigo,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS codigo TEXT,
  ADD COLUMN IF NOT EXISTS nombre TEXT,
  ADD COLUMN IF NOT EXISTS categoria TEXT,
  ADD COLUMN IF NOT EXISTS marca TEXT,
  ADD COLUMN IF NOT EXISTS unidad_medida TEXT DEFAULT 'KG',
  ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_regiones_codigo_upper
  ON public.regiones (upper(btrim(COALESCE(codigo, ''))));

CREATE INDEX IF NOT EXISTS idx_regiones_activo
  ON public.regiones (activo);

CREATE INDEX IF NOT EXISTS idx_supervisores_email_lower
  ON public.supervisores (lower(btrim(COALESCE(email, ''))));

CREATE INDEX IF NOT EXISTS idx_supervisores_sucursal_activo
  ON public.supervisores (sucursal, activo);

-- Homologar y asegurar de forma idempotente los 5 hubs oficiales en public.regiones
-- sin duplicar registros preexistentes (comparación insensible a mayúsculas y tildes).
DO $$
BEGIN
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
END $$;

ALTER TABLE public.regiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regiones FORCE ROW LEVEL SECURITY;

ALTER TABLE public.supervisores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supervisores FORCE ROW LEVEL SECURITY;

ALTER TABLE public.productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.regiones FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.supervisores FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.productos FROM PUBLIC, anon;

GRANT SELECT ON TABLE public.regiones TO authenticated;
GRANT SELECT ON TABLE public.supervisores TO authenticated;
GRANT INSERT, UPDATE ON TABLE public.supervisores TO authenticated;
GRANT SELECT ON TABLE public.productos TO authenticated;

-- =============================================================================
-- 2. COLUMNA ADITIVA `region_id` + ÍNDICES B-TREE EN TABLAS DE IDENTIDAD,
--    MAESTROS, OPERACIONES Y FINANZAS
-- =============================================================================

-- 2.1 Identidad y maestros
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_region_id
  ON public.profiles (region_id);

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_region_id
  ON public.clientes (region_id);

ALTER TABLE public.promotoras
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_promotoras_region_id
  ON public.promotoras (region_id);

ALTER TABLE public.vendedores
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_vendedores_region_id
  ON public.vendedores (region_id);

ALTER TABLE public.supervisores
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_supervisores_region_id
  ON public.supervisores (region_id);

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_staff_region_id
  ON public.staff (region_id);

ALTER TABLE public.cadenas_comerciales
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cadenas_comerciales_region_id
  ON public.cadenas_comerciales (region_id);

ALTER TABLE public.zonas
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_zonas_region_id
  ON public.zonas (region_id);

-- 2.2 Tablas operativas y financieras
ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_surveys_region_id
  ON public.surveys (region_id);

ALTER TABLE public.cronograma_degustaciones
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cronograma_degustaciones_region_id
  ON public.cronograma_degustaciones (region_id);

ALTER TABLE public.rutas_promotoras
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_region_id
  ON public.rutas_promotoras (region_id);

ALTER TABLE public.ejecuciones_pdv_promotora
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ejecuciones_pdv_promotora_region_id
  ON public.ejecuciones_pdv_promotora (region_id);

ALTER TABLE public.alertas_geocerca_auditoria
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_alertas_geocerca_auditoria_region_id
  ON public.alertas_geocerca_auditoria (region_id);

ALTER TABLE public.asistencias_jornada
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_asistencias_jornada_region_id
  ON public.asistencias_jornada (region_id);

ALTER TABLE public.asistencia_evidencias
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_asistencia_evidencias_region_id
  ON public.asistencia_evidencias (region_id);

ALTER TABLE public.material_pop_inventario
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_material_pop_inventario_region_id
  ON public.material_pop_inventario (region_id);

ALTER TABLE public.material_pop_entregas
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_material_pop_entregas_region_id
  ON public.material_pop_entregas (region_id);

ALTER TABLE public.incidencias_pdv
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_incidencias_pdv_region_id
  ON public.incidencias_pdv (region_id);

ALTER TABLE public.cliente_portal_accesos
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cliente_portal_accesos_region_id
  ON public.cliente_portal_accesos (region_id);

ALTER TABLE public.solicitudes_contraloria
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_solicitudes_contraloria_region_id
  ON public.solicitudes_contraloria (region_id);

ALTER TABLE public.contraloria_requisiciones
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contraloria_requisiciones_region_id
  ON public.contraloria_requisiciones (region_id);

ALTER TABLE public.contraloria_conciliaciones
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contraloria_conciliaciones_region_id
  ON public.contraloria_conciliaciones (region_id);

ALTER TABLE public.contraloria_facturas
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contraloria_facturas_region_id
  ON public.contraloria_facturas (region_id);

ALTER TABLE public.certificados_paz_y_salvo
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_certificados_paz_y_salvo_region_id
  ON public.certificados_paz_y_salvo (region_id);

ALTER TABLE IF EXISTS public.contraloria_paz_y_salvo
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF to_regclass('public.contraloria_paz_y_salvo') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_contraloria_paz_y_salvo_region_id
      ON public.contraloria_paz_y_salvo (region_id);
  END IF;
END $$;

ALTER TABLE public.campanas_trade
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_campanas_trade_region_id
  ON public.campanas_trade (region_id);

ALTER TABLE public.presupuestos_trade
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_presupuestos_trade_region_id
  ON public.presupuestos_trade (region_id);

ALTER TABLE public.tarifario_costos_trade
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tarifario_costos_trade_region_id
  ON public.tarifario_costos_trade (region_id);

ALTER TABLE public.entregas_degustacion
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_entregas_degustacion_region_id
  ON public.entregas_degustacion (region_id);

ALTER TABLE public.reportes_trade
  ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES public.regiones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_reportes_trade_region_id
  ON public.reportes_trade (region_id);

-- =============================================================================
-- 3. MOTOR CANÓNICO `CORREO -> REGIÓN` (`LOWER(TRIM(auth.jwt() ->> 'email'))`)
--    Y CLASIFICADOR TERRITORIAL DE LOS 5 HUBS CORPORATIVOS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.obtener_mi_correo_jwt()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT NULLIF(lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', ''))), '');
$$;

COMMENT ON FUNCTION public.obtener_mi_correo_jwt() IS
  'Devuelve el correo autenticado del JWT normalizado con LOWER(TRIM(...)) o NULL si está vacío.';

REVOKE ALL ON FUNCTION public.obtener_mi_correo_jwt() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_correo_jwt() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.current_jwt_email_normalized()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE((SELECT public.obtener_mi_correo_jwt()), '');
$$;

REVOKE ALL ON FUNCTION private.current_jwt_email_normalized() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.current_jwt_email_normalized() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_inferir_sucursal_codigo(p_texto_ubicacion TEXT)
RETURNS public.sucursal_codigo
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
  v_zulia BOOLEAN := false;
  v_valencia BOOLEAN := false;
  v_centro BOOLEAN := false;
  v_oriente BOOLEAN := false;
  v_capital BOOLEAN := false;
  v_hits INTEGER := 0;
  v_sin_vias TEXT;
BEGIN
  IF p_texto_ubicacion IS NULL OR btrim(p_texto_ubicacion) = '' THEN
    RETURN NULL;
  END IF;

  v_norm := lower(
    translate(
      btrim(p_texto_ubicacion),
      'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ',
      'AEIOUAEIOUAEIOUNaeiouaeiouaeioun'
    )
  );

  -- Nivel 1: topónimos inequívocos de los 5 hubs regionales
  v_zulia := v_norm ~ '\m(zulia|maracaibo|san francisco|cabimas|ciudad ojeda|lagunillas|machiques|santa barbara del zulia|mara|la concepcion|mene grande|bachaquero|tia juana|los puertos|costa oriental|col|sur del lago)\M';
  v_valencia := v_norm ~ '\m(valencia|carabobo|naguanagua|san diego|los guayos|guacara|tocuyito|puerto cabello|mariara|bejuma|carlos arvelo|guigue|moron)\M';
  v_centro := v_norm ~ '\m(centro|aragua|maracay|turmero|cagua|la victoria|el limon|villa de cura|lara|barquisimeto|cabudare|carora|quibor|yaracuy|san felipe|yaritagua|chivacoa|portuguesa|acarigua|araure|guanare|cojedes|tinaquillo|guarico|san juan de los morros|calabozo|valle de la pascua)\M';
  v_oriente := v_norm ~ '\m(oriente|anzoategui|barcelona|puerto la cruz|lecheria|guanta|el tigre|anaco|cantaura|monagas|maturin|punta de mata|cumana|carupano|nueva esparta|margarita|porlamar|pampatar|isla de margarita|ciudad bolivar|puerto ordaz|ciudad guayana|san felix|upata|estado bolivar|edo bolivar|estado sucre|edo sucre)\M';
  v_capital := v_norm ~ '\m(capital|gran caracas|caracas|distrito capital|chacao|baruta|el hatillo|petare|los teques|san antonio de los altos|carrizal|guarenas|guatire|valles del tuy|charallave|cua|ocumare del tuy|la guaira|vargas|catia la mar|maiquetia|estado miranda|edo miranda)\M';

  v_hits := (CASE WHEN v_zulia THEN 1 ELSE 0 END)
          + (CASE WHEN v_valencia THEN 1 ELSE 0 END)
          + (CASE WHEN v_centro THEN 1 ELSE 0 END)
          + (CASE WHEN v_oriente THEN 1 ELSE 0 END)
          + (CASE WHEN v_capital THEN 1 ELSE 0 END);

  IF v_hits > 1 THEN
    RETURN NULL;
  ELSIF v_hits = 1 THEN
    IF v_zulia THEN RETURN 'ZULIA'::public.sucursal_codigo; END IF;
    IF v_valencia THEN RETURN 'VALENCIA'::public.sucursal_codigo; END IF;
    IF v_centro THEN RETURN 'CENTRO'::public.sucursal_codigo; END IF;
    IF v_oriente THEN RETURN 'ORIENTE'::public.sucursal_codigo; END IF;
    IF v_capital THEN RETURN 'CAPITAL'::public.sucursal_codigo; END IF;
  END IF;

  -- Nivel 2: estados/municipios homónimos de avenidas (Miranda, Bolívar, Sucre, Libertador, Santa Bárbara)
  v_sin_vias := regexp_replace(
    v_norm,
    '\m(av|avenida|calle|boulevard|blvd|plaza|sector|parroquia)\.?\s+(bolivar|sucre|miranda|libertador|san carlos)\M',
    ' ',
    'g'
  );

  v_zulia := v_sin_vias ~ '\m(santa barbara)\M';
  v_centro := v_sin_vias ~ '\m(san carlos)\M';
  v_oriente := v_sin_vias ~ '\m(bolivar|sucre)\M';
  v_capital := v_sin_vias ~ '\m(miranda|libertador)\M';

  v_hits := (CASE WHEN v_zulia THEN 1 ELSE 0 END)
          + (CASE WHEN v_centro THEN 1 ELSE 0 END)
          + (CASE WHEN v_oriente THEN 1 ELSE 0 END)
          + (CASE WHEN v_capital THEN 1 ELSE 0 END);

  IF v_hits = 1 THEN
    IF v_zulia THEN RETURN 'ZULIA'::public.sucursal_codigo; END IF;
    IF v_centro THEN RETURN 'CENTRO'::public.sucursal_codigo; END IF;
    IF v_oriente THEN RETURN 'ORIENTE'::public.sucursal_codigo; END IF;
    IF v_capital THEN RETURN 'CAPITAL'::public.sucursal_codigo; END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_inferir_sucursal_codigo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_inferir_sucursal_codigo(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_normalizar_sucursal_codigo(p_valor TEXT)
RETURNS public.sucursal_codigo
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_clean TEXT;
BEGIN
  IF p_valor IS NULL OR btrim(p_valor) = '' THEN
    RETURN NULL;
  END IF;

  v_clean := upper(
    translate(
      btrim(p_valor),
      'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ',
      'AEIOUAEIOUAEIOUNaeiouaeiouaeioun'
    )
  );

  IF v_clean IN ('ZULIA', 'SUCURSAL ZULIA', 'REGION ZULIA', 'HUB ZULIA', 'MARACAIBO') THEN
    RETURN 'ZULIA'::public.sucursal_codigo;
  ELSIF v_clean IN ('VALENCIA', 'SUCURSAL VALENCIA', 'REGION VALENCIA', 'HUB VALENCIA', 'CARABOBO') THEN
    RETURN 'VALENCIA'::public.sucursal_codigo;
  ELSIF v_clean IN ('CENTRO', 'SUCURSAL CENTRO', 'REGION CENTRO', 'HUB CENTRO', 'CENTRAL', 'REGION CENTRAL') THEN
    RETURN 'CENTRO'::public.sucursal_codigo;
  ELSIF v_clean IN ('ORIENTE', 'SUCURSAL ORIENTE', 'REGION ORIENTE', 'HUB ORIENTE', 'ORIENTAL', 'REGION ORIENTAL') THEN
    RETURN 'ORIENTE'::public.sucursal_codigo;
  ELSIF v_clean IN ('CAPITAL', 'SUCURSAL CAPITAL', 'REGION CAPITAL', 'HUB CAPITAL', 'DISTRITO CAPITAL', 'GRAN CARACAS', 'CARACAS') THEN
    RETURN 'CAPITAL'::public.sucursal_codigo;
  ELSIF v_clean IN ('GLOBAL', 'NACIONAL', 'ADMIN_GENERAL') THEN
    RETURN 'GLOBAL'::public.sucursal_codigo;
  END IF;

  RETURN public.fn_inferir_sucursal_codigo(p_valor);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_normalizar_sucursal_codigo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_normalizar_sucursal_codigo(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_resolver_region_id(p_valor TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw TEXT := btrim(COALESCE(p_valor, ''));
  v_norm TEXT;
  v_suc public.sucursal_codigo;
  v_region_id UUID := NULL;
BEGIN
  IF v_raw = '' THEN
    RETURN NULL;
  END IF;

  -- Si recibe directamente un UUID de public.regiones
  IF v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT r.id
    INTO v_region_id
    FROM public.regiones r
    WHERE r.id = v_raw::uuid
    LIMIT 1;
    IF v_region_id IS NOT NULL THEN
      RETURN v_region_id;
    END IF;
  END IF;

  v_suc := public.fn_normalizar_sucursal_codigo(v_raw);
  IF v_suc = 'GLOBAL'::public.sucursal_codigo THEN
    RETURN NULL;
  END IF;

  v_norm := upper(
    translate(
      COALESCE(v_suc::text, v_raw),
      'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ',
      'AEIOUAEIOUAEIOUNaeiouaeiouaeioun'
    )
  );

  SELECT r.id
  INTO v_region_id
  FROM public.regiones r
  WHERE upper(translate(btrim(COALESCE(r.codigo, '')), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ', 'AEIOUAEIOUAEIOUNaeiouaeiouaeioun')) = v_norm
     OR upper(translate(btrim(COALESCE(r.nombre, '')), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ', 'AEIOUAEIOUAEIOUNaeiouaeiouaeioun')) = v_norm
  ORDER BY COALESCE(r.activo, true) DESC, r.created_at ASC NULLS LAST
  LIMIT 1;

  RETURN v_region_id;
END;
$$;

COMMENT ON FUNCTION public.fn_resolver_region_id(TEXT) IS
  'Resuelve dinámicamente el UUID en public.regiones a partir de un código, nombre, topónimo o UUID.';

REVOKE ALL ON FUNCTION public.fn_resolver_region_id(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_resolver_region_id(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_resolver_sucursal_desde_region_id(p_region_id UUID)
RETURNS public.sucursal_codigo
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_codigo TEXT;
  v_nombre TEXT;
  v_suc public.sucursal_codigo;
BEGIN
  IF p_region_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT r.codigo, r.nombre
  INTO v_codigo, v_nombre
  FROM public.regiones r
  WHERE r.id = p_region_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_suc := COALESCE(
    public.fn_normalizar_sucursal_codigo(v_codigo),
    public.fn_normalizar_sucursal_codigo(v_nombre)
  );

  IF v_suc = 'GLOBAL'::public.sucursal_codigo THEN
    RETURN NULL;
  END IF;

  RETURN v_suc;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_resolver_sucursal_desde_region_id(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_resolver_sucursal_desde_region_id(UUID) TO authenticated, service_role;

-- Identificación canónica de super_admin activo (por UUID o correo JWT verificado)
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_email TEXT := (SELECT public.obtener_mi_correo_jwt());
  v_role TEXT;
  v_active BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.role, p.is_active
  INTO v_role, v_active
  FROM public.profiles p
  WHERE p.id = v_uid
     OR (v_email IS NOT NULL AND lower(btrim(p.email)) = v_email)
  ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
  LIMIT 1;

  RETURN FOUND AND v_active = true AND v_role = 'super_admin';
END;
$$;

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_active_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin();
$$;

REVOKE ALL ON FUNCTION public.is_active_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_super_admin() TO authenticated, service_role;

-- Resolución canónica de rol activo:
--   1. public.profiles por id = auth.uid() o LOWER(TRIM(email)) = obtener_mi_correo_jwt()
--   2. app_metadata firmado en servidor (nunca metadatos de cliente)
--   3. Respaldo por correo verificado LOWER(TRIM(email)) en supervisores, vendedores, promotoras y staff
CREATE OR REPLACE FUNCTION public.current_active_profile_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_email TEXT := (SELECT public.obtener_mi_correo_jwt());
  v_role TEXT;
  v_active BOOLEAN;
  v_jwt_role TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.role, p.is_active
  INTO v_role, v_active
  FROM public.profiles p
  WHERE p.id = v_uid
     OR (v_email IS NOT NULL AND lower(btrim(p.email)) = v_email)
  ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
  LIMIT 1;

  IF FOUND THEN
    IF v_active IS DISTINCT FROM true THEN
      RETURN '__SUSPENDED__';
    END IF;
    RETURN COALESCE(public.fn_normalizar_rol_perfil(v_role), v_role);
  END IF;

  v_jwt_role := public.fn_normalizar_rol_perfil(
    COALESCE(
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
      ''
    )
  );
  IF v_jwt_role IS NOT NULL THEN
    RETURN v_jwt_role;
  END IF;

  IF v_email IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.supervisores sv
      WHERE lower(btrim(COALESCE(sv.email, ''))) = v_email
        AND COALESCE(sv.activo, true) = true
    ) THEN
      RETURN 'coordinacion';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.vendedores vd
      WHERE lower(btrim(COALESCE(vd.email, ''))) = v_email
        AND COALESCE(vd.activo, true) = true
    ) THEN
      RETURN 'vendedor';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.promotoras pr
      WHERE lower(btrim(COALESCE(pr.email, ''))) = v_email
        AND COALESCE(pr.activo, true) = true
    ) THEN
      RETURN 'promotora';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.staff st
      WHERE (st.auth_user_id = v_uid OR lower(btrim(COALESCE(st.email, ''))) = v_email)
        AND lower(btrim(COALESCE(st.status, 'Activo'))) <> 'inactivo'
        AND lower(COALESCE(st.role, '')) NOT LIKE '%merchandising%'
    ) THEN
      RETURN 'promotora';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.current_active_profile_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_active_profile_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.obtener_mi_rol()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := (SELECT public.current_active_profile_role());
BEGIN
  IF v_role IS NULL OR v_role = '__SUSPENDED__' THEN
    RETURN NULL;
  END IF;
  RETURN v_role;
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_mi_rol() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_rol() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.obtener_mi_sucursal()
RETURNS public.sucursal_codigo
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_email TEXT := (SELECT public.obtener_mi_correo_jwt());
  v_role TEXT;
  v_sucursal public.sucursal_codigo;
  v_region_id UUID;
  v_active BOOLEAN;
  v_eff_role TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.role, p.sucursal, p.region_id, p.is_active
  INTO v_role, v_sucursal, v_region_id, v_active
  FROM public.profiles p
  WHERE p.id = v_uid
     OR (v_email IS NOT NULL AND lower(btrim(p.email)) = v_email)
  ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
  LIMIT 1;

  IF FOUND THEN
    IF v_active IS DISTINCT FROM true THEN
      RETURN NULL;
    END IF;

    v_eff_role := COALESCE(public.fn_normalizar_rol_perfil(v_role), v_role);
    IF v_eff_role = 'super_admin' THEN
      RETURN 'GLOBAL'::public.sucursal_codigo;
    END IF;

    v_sucursal := COALESCE(
      v_sucursal,
      public.fn_resolver_sucursal_desde_region_id(v_region_id)
    );

    IF v_sucursal = 'GLOBAL'::public.sucursal_codigo
       AND v_eff_role NOT IN ('super_admin', 'contraloria') THEN
      v_sucursal := NULL;
    END IF;

    IF v_sucursal IS NOT NULL THEN
      RETURN v_sucursal;
    END IF;
  END IF;

  v_eff_role := (SELECT public.obtener_mi_rol());
  IF v_eff_role IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_eff_role = 'super_admin' THEN
    RETURN 'GLOBAL'::public.sucursal_codigo;
  END IF;

  -- Respaldo por correo verificado LOWER(TRIM(email)) en tablas maestras y operativas
  IF v_email IS NOT NULL THEN
    SELECT COALESCE(
      pr.sucursal,
      public.fn_resolver_sucursal_desde_region_id(pr.region_id),
      public.fn_inferir_sucursal_codigo(concat_ws(' | ', pr.estado, pr.ciudad, pr.direccion))
    )
    INTO v_sucursal
    FROM public.promotoras pr
    WHERE lower(btrim(COALESCE(pr.email, ''))) = v_email
      AND COALESCE(pr.activo, true) = true
    LIMIT 1;

    IF v_sucursal IS NOT NULL AND v_sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
      RETURN v_sucursal;
    END IF;

    SELECT COALESCE(
      st.sucursal,
      public.fn_resolver_sucursal_desde_region_id(st.region_id)
    )
    INTO v_sucursal
    FROM public.staff st
    WHERE (st.auth_user_id = v_uid OR lower(btrim(COALESCE(st.email, ''))) = v_email)
      AND lower(btrim(COALESCE(st.status, 'Activo'))) <> 'inactivo'
    ORDER BY CASE WHEN st.auth_user_id = v_uid THEN 0 ELSE 1 END ASC
    LIMIT 1;

    IF v_sucursal IS NOT NULL AND v_sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
      RETURN v_sucursal;
    END IF;

    SELECT COALESCE(
      sv.sucursal,
      public.fn_resolver_sucursal_desde_region_id(sv.region_id),
      public.fn_inferir_sucursal_codigo(sv.zona)
    )
    INTO v_sucursal
    FROM public.supervisores sv
    WHERE lower(btrim(COALESCE(sv.email, ''))) = v_email
      AND COALESCE(sv.activo, true) = true
    LIMIT 1;

    IF v_sucursal IS NOT NULL AND v_sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
      RETURN v_sucursal;
    END IF;

    SELECT COALESCE(
      vd.sucursal,
      public.fn_resolver_sucursal_desde_region_id(vd.region_id),
      public.fn_inferir_sucursal_codigo(vd.zona)
    )
    INTO v_sucursal
    FROM public.vendedores vd
    WHERE lower(btrim(COALESCE(vd.email, ''))) = v_email
      AND COALESCE(vd.activo, true) = true
    LIMIT 1;

    IF v_sucursal IS NOT NULL AND v_sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
      RETURN v_sucursal;
    END IF;
  END IF;

  -- Respaldo controlado sobre app_metadata firmado en servidor (jamás metadatos editables por cliente)
  v_sucursal := COALESCE(
    public.fn_normalizar_sucursal_codigo((SELECT auth.jwt()) -> 'app_metadata' ->> 'sucursal'),
    public.fn_normalizar_sucursal_codigo((SELECT auth.jwt()) -> 'app_metadata' ->> 'region')
  );

  IF v_sucursal = 'GLOBAL'::public.sucursal_codigo AND v_eff_role <> 'contraloria' THEN
    RETURN NULL;
  END IF;

  RETURN v_sucursal;
END;
$$;

COMMENT ON FUNCTION public.obtener_mi_sucursal() IS
  'Devuelve la región autorizada (ZULIA, VALENCIA, CENTRO, ORIENTE, CAPITAL o GLOBAL) mediante profiles, correo JWT verificado y app_metadata.';

REVOKE ALL ON FUNCTION public.obtener_mi_sucursal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_sucursal() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.obtener_sucursal_contexto_activo()
RETURNS public.sucursal_codigo
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_rol TEXT;
  v_mi_sucursal public.sucursal_codigo;
  v_raw_headers TEXT;
  v_headers_json JSONB;
  v_header_val TEXT;
  v_header_sucursal public.sucursal_codigo;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  v_rol := (SELECT public.obtener_mi_rol());
  v_mi_sucursal := (SELECT public.obtener_mi_sucursal());

  IF v_rol IS NULL OR v_mi_sucursal IS NULL THEN
    RETURN NULL;
  END IF;

  -- Para roles regionales (promotora, coordinacion, vendedor, cliente, chofer)
  -- o contraloría asignada a un hub específico: ignora cabeceras cliente y fija obtener_mi_sucursal().
  IF v_rol NOT IN ('super_admin', 'contraloria')
     OR v_mi_sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
    IF v_mi_sucursal = 'GLOBAL'::public.sucursal_codigo THEN
      RETURN NULL;
    END IF;
    RETURN v_mi_sucursal;
  END IF;

  -- Para super_admin y contraloria (GLOBAL): permite acotar la sesión activa a 1 de los 5 hubs vía x-sucursal-activa
  v_raw_headers := NULLIF(btrim(COALESCE(current_setting('request.headers', true), '')), '');
  IF v_raw_headers IS NOT NULL AND left(v_raw_headers, 1) = '{' THEN
    BEGIN
      v_headers_json := v_raw_headers::jsonb;
      v_header_val := COALESCE(
        NULLIF(btrim(COALESCE(v_headers_json ->> 'x-sucursal-activa', '')), ''),
        NULLIF(btrim(COALESCE(v_headers_json ->> 'X-Sucursal-Activa', '')), '')
      );
    EXCEPTION WHEN OTHERS THEN
      v_header_val := NULL;
    END;
  END IF;

  IF v_header_val IS NOT NULL THEN
    v_header_sucursal := public.fn_normalizar_sucursal_codigo(v_header_val);
    IF v_header_sucursal IN (
      'ZULIA'::public.sucursal_codigo,
      'VALENCIA'::public.sucursal_codigo,
      'CENTRO'::public.sucursal_codigo,
      'ORIENTE'::public.sucursal_codigo,
      'CAPITAL'::public.sucursal_codigo
    ) THEN
      RETURN v_header_sucursal;
    END IF;
  END IF;

  RETURN 'GLOBAL'::public.sucursal_codigo;
END;
$$;

COMMENT ON FUNCTION public.obtener_sucursal_contexto_activo() IS
  'Contexto regional efectivo de la consulta: fija obtener_mi_sucursal() para roles regionales y respeta x-sucursal-activa (1 de los 5 hubs) para super_admin/contraloria GLOBAL.';

REVOKE ALL ON FUNCTION public.obtener_sucursal_contexto_activo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_sucursal_contexto_activo() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.obtener_mi_region_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_email TEXT := (SELECT public.obtener_mi_correo_jwt());
  v_ctx public.sucursal_codigo;
  v_profile_region_id UUID := NULL;
  v_profile_sucursal public.sucursal_codigo := NULL;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  v_ctx := (SELECT public.obtener_sucursal_contexto_activo());
  IF v_ctx IS NULL OR v_ctx = 'GLOBAL'::public.sucursal_codigo THEN
    RETURN NULL;
  END IF;

  SELECT p.region_id, p.sucursal
  INTO v_profile_region_id, v_profile_sucursal
  FROM public.profiles p
  WHERE (p.id = v_uid OR (v_email IS NOT NULL AND lower(btrim(p.email)) = v_email))
    AND p.is_active = true
  ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
  LIMIT 1;

  IF v_profile_region_id IS NOT NULL AND v_profile_sucursal = v_ctx THEN
    RETURN v_profile_region_id;
  END IF;

  RETURN public.fn_resolver_region_id(v_ctx::text);
END;
$$;

COMMENT ON FUNCTION public.obtener_mi_region_id() IS
  'Devuelve el UUID de public.regiones correspondiente al hub activo del usuario autenticado (o NULL en modo GLOBAL sin filtro de sede).';

REVOKE ALL ON FUNCTION public.obtener_mi_region_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_region_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tiene_acceso_sucursal(p_sucursal public.sucursal_codigo)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN (SELECT public.obtener_sucursal_contexto_activo()) = 'GLOBAL'::public.sucursal_codigo
         AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'contraloria')
      THEN true
    WHEN p_sucursal IS NOT NULL
         AND p_sucursal <> 'GLOBAL'::public.sucursal_codigo
         AND p_sucursal = (SELECT public.obtener_sucursal_contexto_activo())
      THEN true
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.tiene_acceso_sucursal(public.sucursal_codigo) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tiene_acceso_sucursal(public.sucursal_codigo) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tiene_acceso_region(
  p_region_id UUID,
  p_sucursal public.sucursal_codigo DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx public.sucursal_codigo;
  v_rol TEXT;
  v_row_sucursal public.sucursal_codigo;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN false;
  END IF;

  v_ctx := (SELECT public.obtener_sucursal_contexto_activo());
  v_rol := (SELECT public.obtener_mi_rol());

  IF v_ctx IS NULL OR v_rol IS NULL THEN
    RETURN false;
  END IF;

  IF v_ctx = 'GLOBAL'::public.sucursal_codigo AND v_rol IN ('super_admin', 'contraloria') THEN
    RETURN true;
  END IF;

  v_row_sucursal := COALESCE(
    p_sucursal,
    public.fn_resolver_sucursal_desde_region_id(p_region_id)
  );

  IF v_row_sucursal IS NULL OR v_row_sucursal = 'GLOBAL'::public.sucursal_codigo THEN
    RETURN false;
  END IF;

  RETURN v_row_sucursal = v_ctx;
END;
$$;

COMMENT ON FUNCTION public.tiene_acceso_region(UUID, public.sucursal_codigo) IS
  'Evalúa aislamiento multi-región (5 hubs) combinando region_id y sucursal frente a obtener_sucursal_contexto_activo().';

REVOKE ALL ON FUNCTION public.tiene_acceso_region(UUID, public.sucursal_codigo) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tiene_acceso_region(UUID, public.sucursal_codigo) TO authenticated, service_role;

-- Actualizar resolución de promotora activa en private para soportar correo JWT normalizado
CREATE OR REPLACE FUNCTION private.current_active_promotora_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_email TEXT := (SELECT public.obtener_mi_correo_jwt());
  v_claim_staff_id UUID := NULL;
  v_staff RECORD;
  v_status_json JSONB := '{}'::jsonb;
  v_member_status TEXT := 'Activo';
  v_member_category TEXT := '';
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_claim_staff_id := NULLIF(
      pg_catalog.btrim(COALESCE((SELECT auth.jwt()) -> 'app_metadata' ->> 'staff_id', '')),
      ''
    )::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_claim_staff_id := NULL;
  END;

  SELECT s.id, s.role, s.status, s.auth_user_id
  INTO v_staff
  FROM public.staff s
  WHERE s.auth_user_id = v_uid
  LIMIT 1;

  IF NOT FOUND AND v_claim_staff_id IS NOT NULL THEN
    SELECT s.id, s.role, s.status, s.auth_user_id
    INTO v_staff
    FROM public.staff s
    WHERE s.id = v_claim_staff_id
      AND (s.auth_user_id IS NULL OR s.auth_user_id = v_uid)
    LIMIT 1;
  END IF;

  IF NOT FOUND AND v_email IS NOT NULL THEN
    SELECT s.id, s.role, s.status, s.auth_user_id
    INTO v_staff
    FROM public.staff s
    WHERE lower(pg_catalog.btrim(COALESCE(s.email, ''))) = v_email
      AND (s.auth_user_id IS NULL OR s.auth_user_id = v_uid)
    ORDER BY s.created_at ASC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_staff.status IS NOT NULL AND pg_catalog.btrim(v_staff.status::text) LIKE '{%' THEN
    BEGIN
      v_status_json := (v_staff.status::text)::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_status_json := '{}'::jsonb;
    END;
  END IF;

  v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
  v_member_category := lower(pg_catalog.btrim(COALESCE(v_status_json ->> 'category', '')));

  IF lower(pg_catalog.btrim(v_member_status)) = 'inactivo'
     OR v_member_category = 'merchandising'
     OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
    RETURN NULL;
  END IF;

  RETURN v_staff.id;
END;
$$;

REVOKE ALL ON FUNCTION private.current_active_promotora_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.current_active_promotora_id() TO authenticated, service_role;

-- =============================================================================
-- 4. POLÍTICAS RLS EN `regiones`, `productos`, `supervisores` Y `profiles`
-- =============================================================================

DROP POLICY IF EXISTS regiones_select_authenticated ON public.regiones;
CREATE POLICY regiones_select_authenticated
  ON public.regiones
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS productos_select_authenticated ON public.productos;
CREATE POLICY productos_select_authenticated
  ON public.productos
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS supervisores_select_authenticated ON public.supervisores;
DROP POLICY IF EXISTS supervisores_select_sede ON public.supervisores;
CREATE POLICY supervisores_select_sede
  ON public.supervisores
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.tiene_acceso_region(region_id, sucursal))
    AND (
      (SELECT public.is_torre_control_viewer())
      OR (
        (SELECT public.obtener_mi_correo_jwt()) IS NOT NULL
        AND lower(btrim(COALESCE(email, ''))) = (SELECT public.obtener_mi_correo_jwt())
      )
    )
  );

DROP POLICY IF EXISTS supervisores_insert_trade_sede ON public.supervisores;
CREATE POLICY supervisores_insert_trade_sede
  ON public.supervisores
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_region(region_id, sucursal))
  );

DROP POLICY IF EXISTS supervisores_update_trade_sede ON public.supervisores;
CREATE POLICY supervisores_update_trade_sede
  ON public.supervisores
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

DROP POLICY IF EXISTS profiles_select_self_or_super_admin ON public.profiles;
CREATE POLICY profiles_select_self_or_super_admin
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (
      (SELECT public.obtener_mi_correo_jwt()) IS NOT NULL
      AND lower(btrim(email)) = (SELECT public.obtener_mi_correo_jwt())
    )
    OR (SELECT public.is_super_admin())
  );

-- =============================================================================
-- 5. AMPLIACIÓN DE CONSTRAINTS `CHECK` A LOS 5 HUBS + TRIGGERS DE SELLADO
--    BIDIRECCIONAL (`region_id <-> sucursal`) Y `REGION_CONTEXT_REQUIRED`
-- =============================================================================

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS chk_profiles_sucursal_por_rol;

ALTER TABLE public.profiles
  ADD CONSTRAINT chk_profiles_sucursal_por_rol
  CHECK (
    (role = 'super_admin' AND sucursal = 'GLOBAL'::public.sucursal_codigo)
    OR (
      role = 'contraloria'
      AND sucursal IN (
        'ZULIA'::public.sucursal_codigo,
        'VALENCIA'::public.sucursal_codigo,
        'CENTRO'::public.sucursal_codigo,
        'ORIENTE'::public.sucursal_codigo,
        'CAPITAL'::public.sucursal_codigo,
        'GLOBAL'::public.sucursal_codigo
      )
    )
    OR (
      role IN ('coordinacion', 'vendedor', 'promotora', 'cliente', 'chofer')
      AND sucursal IN (
        'ZULIA'::public.sucursal_codigo,
        'VALENCIA'::public.sucursal_codigo,
        'CENTRO'::public.sucursal_codigo,
        'ORIENTE'::public.sucursal_codigo,
        'CAPITAL'::public.sucursal_codigo
      )
    )
  );

-- Ampliar todos los constraints `chk_<table>_sucursal_regional` a las 5 regiones operativas
DO $$
DECLARE
  v_tbl TEXT;
  v_regional_tables TEXT[] := ARRAY[
    'clientes',
    'vendedores',
    'supervisores',
    'staff',
    'cadenas_comerciales',
    'zonas',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'ejecuciones_pdv_promotora',
    'alertas_geocerca_auditoria',
    'asistencias_jornada',
    'asistencia_evidencias',
    'material_pop_inventario',
    'material_pop_entregas',
    'incidencias_pdv',
    'cliente_portal_accesos',
    'solicitudes_contraloria',
    'contraloria_requisiciones',
    'contraloria_conciliaciones',
    'contraloria_facturas',
    'certificados_paz_y_salvo',
    'campanas_trade',
    'presupuestos_trade',
    'tarifario_costos_trade',
    'entregas_degustacion',
    'promotoras',
    'reportes_trade'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_regional_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS chk_%I_sucursal_regional',
        v_tbl,
        v_tbl
      );
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT chk_%I_sucursal_regional '
        || 'CHECK (sucursal IS NULL OR sucursal IN ('
        || '''ZULIA''::public.sucursal_codigo, '
        || '''VALENCIA''::public.sucursal_codigo, '
        || '''CENTRO''::public.sucursal_codigo, '
        || '''ORIENTE''::public.sucursal_codigo, '
        || '''CAPITAL''::public.sucursal_codigo))',
        v_tbl,
        v_tbl
      );
    END IF;
  END LOOP;
END $$;

-- Actualizar el constraint de storage_path en public.contraloria_facturas para los 5 hubs
DO $$
DECLARE
  v_con RECORD;
BEGIN
  IF to_regclass('public.contraloria_facturas') IS NOT NULL THEN
    FOR v_con IN
      SELECT c.conname
      FROM pg_catalog.pg_constraint c
      WHERE c.conrelid = 'public.contraloria_facturas'::regclass
        AND c.contype = 'c'
        AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%storage_path%'
    LOOP
      EXECUTE format(
        'ALTER TABLE public.contraloria_facturas DROP CONSTRAINT IF EXISTS %I',
        v_con.conname
      );
    END LOOP;
  END IF;
END $$;

ALTER TABLE public.contraloria_facturas
  DROP CONSTRAINT IF EXISTS chk_contraloria_facturas_storage_path;

ALTER TABLE public.contraloria_facturas
  ADD CONSTRAINT chk_contraloria_facturas_storage_path
  CHECK (
    storage_path IS NULL
    OR storage_path ~ '^facturas/(ZULIA|VALENCIA|CENTRO|ORIENTE|CAPITAL)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(pdf|jpg|png|webp)$'
  );

-- Actualizar trigger de normalización en public.profiles para sincronizar region_id <-> sucursal
CREATE OR REPLACE FUNCTION public.fn_profiles_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_norm_role TEXT;
BEGIN
  NEW.email := lower(btrim(COALESCE(NEW.email, '')));
  NEW.full_name := btrim(COALESCE(NEW.full_name, ''));
  v_norm_role := public.fn_normalizar_rol_perfil(COALESCE(NEW.role, 'vendedor'));

  IF v_norm_role IS NOT NULL THEN
    NEW.role := v_norm_role;
  ELSE
    NEW.role := lower(btrim(COALESCE(NEW.role, '')));
  END IF;

  IF NEW.role = 'super_admin' THEN
    NEW.sucursal := 'GLOBAL'::public.sucursal_codigo;
    NEW.region_id := NULL;
  ELSE
    IF NEW.sucursal IS NULL AND NEW.region_id IS NOT NULL THEN
      NEW.sucursal := public.fn_resolver_sucursal_desde_region_id(NEW.region_id);
    END IF;

    IF NEW.role = 'contraloria' AND NEW.sucursal IS NULL THEN
      NEW.sucursal := 'GLOBAL'::public.sucursal_codigo;
    END IF;

    IF NEW.sucursal = 'GLOBAL'::public.sucursal_codigo THEN
      NEW.region_id := NULL;
    ELSIF NEW.sucursal IS NOT NULL THEN
      NEW.region_id := public.fn_resolver_region_id(NEW.sucursal::text);
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_profiles_before_write() FROM PUBLIC, anon;

-- Trigger maestro de sellado y protección multi-hub (`NEW.region_id <-> NEW.sucursal`)
CREATE OR REPLACE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_mi_rol TEXT := (SELECT public.obtener_mi_rol());
  v_mi_sucursal public.sucursal_codigo := (SELECT public.obtener_mi_sucursal());
  v_ctx_sucursal public.sucursal_codigo := (SELECT public.obtener_sucursal_contexto_activo());
  v_inferida public.sucursal_codigo := NULL;
  v_region_sucursal public.sucursal_codigo := NULL;
  v_json JSONB := to_jsonb(NEW);
  v_old_json JSONB := NULL;
  v_allow_legacy_null BOOLEAN := COALESCE(current_setting('codizulca.allow_legacy_null_backfill', true), '') = '1';
BEGIN
  -- 1. En UPDATE: ningún actor distinto de super_admin puede mutar una región ya sellada
  IF TG_OP = 'UPDATE' THEN
    v_old_json := to_jsonb(OLD);

    IF NEW.sucursal IS DISTINCT FROM OLD.sucursal
       AND OLD.sucursal IS NOT NULL
       AND v_uid IS NOT NULL
       AND v_mi_rol IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'Cruce de sede bloqueado: no se permite cambiar la sucursal (%) de un registro en public.%.',
        OLD.sucursal, TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;

    IF NEW.region_id IS DISTINCT FROM OLD.region_id
       AND OLD.region_id IS NOT NULL
       AND v_uid IS NOT NULL
       AND v_mi_rol IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'Cruce de región bloqueado: no se permite reasignar region_id en public.%.',
        TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;

    -- Candado D6: el rol chofer solo actualiza campos de entrega en entregas_degustacion
    IF TG_TABLE_NAME = 'entregas_degustacion' AND v_mi_rol = 'chofer' THEN
      IF (v_json ->> 'fecha') IS DISTINCT FROM (v_old_json ->> 'fecha')
         OR (v_json ->> 'turno') IS DISTINCT FROM (v_old_json ->> 'turno')
         OR (v_json ->> 'numero_grupo_turno') IS DISTINCT FROM (v_old_json ->> 'numero_grupo_turno')
         OR (v_json ->> 'cliente') IS DISTINCT FROM (v_old_json ->> 'cliente')
         OR (v_json ->> 'producto') IS DISTINCT FROM (v_old_json ->> 'producto')
         OR (v_json ->> 'vendedor') IS DISTINCT FROM (v_old_json ->> 'vendedor')
         OR (v_json ->> 'promotora') IS DISTINCT FROM (v_old_json ->> 'promotora')
         OR NEW.sucursal IS DISTINCT FROM OLD.sucursal THEN
        RAISE EXCEPTION 'Acceso denegado: el rol chofer solo puede actualizar el estado y notas de la entrega.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- 2. Resolver sucursal desde NEW.region_id si se envió UUID explícito
  IF NEW.region_id IS NOT NULL THEN
    v_region_sucursal := public.fn_resolver_sucursal_desde_region_id(NEW.region_id);
    IF NEW.sucursal IS NULL AND v_region_sucursal IS NOT NULL THEN
      NEW.sucursal := v_region_sucursal;
    ELSIF NEW.sucursal IS NOT NULL
          AND NEW.sucursal <> 'GLOBAL'::public.sucursal_codigo
          AND v_region_sucursal IS NOT NULL
          AND v_region_sucursal <> NEW.sucursal THEN
      RAISE EXCEPTION 'Inconsistencia regional en public.%: region_id corresponde a % pero sucursal indica %.',
        TG_TABLE_NAME, v_region_sucursal, NEW.sucursal
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 3. Actor con sede regional fija (1 de los 5 hubs): forzar y bloquear cruce territorial
  IF v_uid IS NOT NULL
     AND v_mi_sucursal IN (
       'ZULIA'::public.sucursal_codigo,
       'VALENCIA'::public.sucursal_codigo,
       'CENTRO'::public.sucursal_codigo,
       'ORIENTE'::public.sucursal_codigo,
       'CAPITAL'::public.sucursal_codigo
     ) THEN
    IF NEW.sucursal IS NOT NULL AND NEW.sucursal <> v_mi_sucursal THEN
      RAISE EXCEPTION 'Cruce de sede bloqueado en public.%: tu perfil pertenece a % y no puede escribir registros para %.',
        TG_TABLE_NAME, v_mi_sucursal, NEW.sucursal
        USING ERRCODE = '42501';
    END IF;
    NEW.sucursal := v_mi_sucursal;
  ELSIF v_uid IS NOT NULL
        AND v_ctx_sucursal IN (
          'ZULIA'::public.sucursal_codigo,
          'VALENCIA'::public.sucursal_codigo,
          'CENTRO'::public.sucursal_codigo,
          'ORIENTE'::public.sucursal_codigo,
          'CAPITAL'::public.sucursal_codigo
        ) THEN
    -- Sesión GLOBAL acotada mediante cabecera x-sucursal-activa
    IF NEW.sucursal IS NULL OR NEW.sucursal = 'GLOBAL'::public.sucursal_codigo THEN
      NEW.sucursal := v_ctx_sucursal;
    ELSIF NEW.sucursal <> v_ctx_sucursal THEN
      RAISE EXCEPTION 'Cruce de contexto regional bloqueado en public.%: el contexto activo es % y el registro apunta a %.',
        TG_TABLE_NAME, v_ctx_sucursal, NEW.sucursal
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 4. Inferencia determinista desde claves foráneas o campos geográficos si aún es NULL
  IF NEW.sucursal IS NULL THEN
    IF TG_TABLE_NAME = 'asistencia_evidencias' AND NULLIF(btrim(COALESCE(v_json ->> 'asistencia_id', '')), '') IS NOT NULL THEN
      SELECT j.sucursal INTO v_inferida
      FROM public.asistencias_jornada j
      WHERE j.id = (v_json ->> 'asistencia_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'asistencias_jornada' AND NULLIF(btrim(COALESCE(v_json ->> 'promotora_id', '')), '') IS NOT NULL THEN
      SELECT s.sucursal INTO v_inferida
      FROM public.staff s
      WHERE s.id = (v_json ->> 'promotora_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME IN ('ejecuciones_pdv_promotora', 'alertas_geocerca_auditoria')
          AND NULLIF(btrim(COALESCE(v_json ->> 'ruta_id', '')), '') IS NOT NULL THEN
      SELECT r.sucursal INTO v_inferida
      FROM public.rutas_promotoras r
      WHERE r.id = (v_json ->> 'ruta_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'rutas_promotoras' AND NULLIF(btrim(COALESCE(v_json ->> 'cronograma_id', '')), '') IS NOT NULL THEN
      SELECT c.sucursal INTO v_inferida
      FROM public.cronograma_degustaciones c
      WHERE c.id = (v_json ->> 'cronograma_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'cronograma_degustaciones' THEN
      IF NULLIF(btrim(COALESCE(v_json ->> 'survey_origen_id', '')), '') IS NOT NULL THEN
        SELECT sv.sucursal INTO v_inferida
        FROM public.surveys sv
        WHERE sv.id = (v_json ->> 'survey_origen_id')::uuid
        LIMIT 1;
      END IF;
      IF v_inferida IS NULL AND NULLIF(btrim(COALESCE(v_json ->> 'promotora_id', '')), '') IS NOT NULL THEN
        SELECT s.sucursal INTO v_inferida
        FROM public.staff s
        WHERE s.id = (v_json ->> 'promotora_id')::uuid
        LIMIT 1;
      END IF;
    ELSIF TG_TABLE_NAME = 'material_pop_entregas' AND NULLIF(btrim(COALESCE(v_json ->> 'material_id', '')), '') IS NOT NULL THEN
      SELECT m.sucursal INTO v_inferida
      FROM public.material_pop_inventario m
      WHERE m.id = (v_json ->> 'material_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'contraloria_conciliaciones' AND NULLIF(btrim(COALESCE(v_json ->> 'requisicion_id', '')), '') IS NOT NULL THEN
      SELECT cr.sucursal INTO v_inferida
      FROM public.contraloria_requisiciones cr
      WHERE cr.id = (v_json ->> 'requisicion_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'contraloria_facturas' AND NULLIF(btrim(COALESCE(v_json ->> 'conciliacion_id', '')), '') IS NOT NULL THEN
      SELECT cc.sucursal INTO v_inferida
      FROM public.contraloria_conciliaciones cc
      WHERE cc.id = (v_json ->> 'conciliacion_id')::uuid
      LIMIT 1;
    ELSIF TG_TABLE_NAME = 'clientes' THEN
      IF NULLIF(btrim(COALESCE(v_json ->> 'zona_id', '')), '') IS NOT NULL THEN
        SELECT z.sucursal INTO v_inferida
        FROM public.zonas z
        WHERE z.id = (v_json ->> 'zona_id')::uuid
        LIMIT 1;
      END IF;
      IF v_inferida IS NULL AND NULLIF(btrim(COALESCE(v_json ->> 'cadena_id', '')), '') IS NOT NULL THEN
        SELECT cad.sucursal INTO v_inferida
        FROM public.cadenas_comerciales cad
        WHERE cad.id = (v_json ->> 'cadena_id')::uuid
        LIMIT 1;
      END IF;
    END IF;

    IF v_inferida IS NULL THEN
      v_inferida := public.fn_inferir_sucursal_codigo(
        concat_ws(
          ' | ',
          v_json ->> 'estado',
          v_json ->> 'ciudad',
          v_json ->> 'zona',
          v_json ->> 'ruta',
          v_json ->> 'direccion',
          v_json ->> 'zona_direccion',
          v_json ->> 'store',
          v_json ->> 'cliente_nombre',
          v_json ->> 'cliente',
          v_json ->> 'pdv_nombre',
          v_json ->> 'para_ser_utilizado'
        )
      );
    END IF;

    NEW.sucursal := v_inferida;
  END IF;

  -- 5. Rechazar escrituras operativas ambiguas (NULL o GLOBAL)
  IF (NEW.sucursal IS NULL OR NEW.sucursal = 'GLOBAL'::public.sucursal_codigo)
     AND NOT v_allow_legacy_null THEN
    RAISE EXCEPTION 'REGION_CONTEXT_REQUIRED: Toda escritura operativa en public.% requiere una región activa válida (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL).',
      TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  -- 6. Sincronización canónica NEW.sucursal -> NEW.region_id
  IF NEW.sucursal IS NOT NULL AND NEW.sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
    NEW.region_id := public.fn_resolver_region_id(NEW.sucursal::text);
  ELSE
    NEW.region_id := NULL;
  END IF;

  -- 7. Validación cruzada en cronograma_degustaciones: prohibir asignar promotora de otra región
  IF TG_TABLE_NAME = 'cronograma_degustaciones'
     AND NULLIF(btrim(COALESCE(v_json ->> 'promotora_id', '')), '') IS NOT NULL
     AND NEW.sucursal IS NOT NULL THEN
    PERFORM 1
    FROM public.staff s
    WHERE s.id = (v_json ->> 'promotora_id')::uuid
      AND s.sucursal IS NOT NULL
      AND s.sucursal <> NEW.sucursal;

    IF FOUND THEN
      RAISE EXCEPTION 'Cruce territorial prohibido: la promotora seleccionada pertenece a otra región distinta de %.', NEW.sucursal
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sellar_y_proteger_sucursal_operativa() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_sellar_y_proteger_sucursal_operativa() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_g2_sellar_sucursal_supervisores ON public.supervisores;
CREATE TRIGGER trg_g2_sellar_sucursal_supervisores
  BEFORE INSERT OR UPDATE ON public.supervisores
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

-- Propagar también region_id de cronograma_degustaciones -> rutas_promotoras
CREATE OR REPLACE FUNCTION public.fn_sync_cronograma_to_rutas_promotoras()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_target_estado_ruta TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') AND NEW.promotora_id IS NOT NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD.promotora_id IS NOT NULL
       AND OLD.promotora_id IS DISTINCT FROM NEW.promotora_id THEN
      UPDATE public.rutas_promotoras
      SET estado_ruta = 'CANCELADA',
          updated_at = NOW()
      WHERE cronograma_id = NEW.id
        AND estado_ruta <> 'CANCELADA';
    END IF;

    v_target_estado_ruta := CASE
      WHEN NEW.estado = 'EN_CURSO' THEN 'EN_CURSO'
      WHEN NEW.estado = 'COMPLETADA' THEN 'COMPLETADA'
      ELSE 'ASIGNADA'
    END;

    INSERT INTO public.rutas_promotoras (
      cronograma_id,
      promotora_id,
      promotora_nombre,
      promotora_email,
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
      vendedor_fdv,
      observaciones,
      sucursal,
      region_id,
      estado_ruta,
      aprobado_por,
      asignado_at,
      updated_at
    ) VALUES (
      NEW.id,
      NEW.promotora_id,
      COALESCE(NEW.promotora_nombre, ''),
      COALESCE(NEW.promotora_email, ''),
      NEW.fecha,
      NEW.hora_inicio,
      NEW.hora_fin,
      NEW.turno,
      NEW.cliente_nombre,
      NEW.cliente_codigo,
      NEW.zona_direccion,
      NEW.producto_resumen,
      NEW.productos,
      NEW.cantidad_kilos,
      NEW.personas_estimadas,
      NEW.vendedor_fdv,
      NEW.observaciones,
      NEW.sucursal,
      NEW.region_id,
      v_target_estado_ruta,
      NEW.aprobado_por,
      NOW(),
      NOW()
    )
    ON CONFLICT (cronograma_id) DO UPDATE SET
      promotora_id = EXCLUDED.promotora_id,
      promotora_nombre = EXCLUDED.promotora_nombre,
      promotora_email = EXCLUDED.promotora_email,
      fecha = EXCLUDED.fecha,
      hora_inicio = EXCLUDED.hora_inicio,
      hora_fin = EXCLUDED.hora_fin,
      turno = EXCLUDED.turno,
      cliente_nombre = EXCLUDED.cliente_nombre,
      cliente_codigo = EXCLUDED.cliente_codigo,
      zona_direccion = EXCLUDED.zona_direccion,
      producto_resumen = EXCLUDED.producto_resumen,
      productos = EXCLUDED.productos,
      cantidad_kilos = EXCLUDED.cantidad_kilos,
      personas_estimadas = EXCLUDED.personas_estimadas,
      vendedor_fdv = EXCLUDED.vendedor_fdv,
      observaciones = EXCLUDED.observaciones,
      sucursal = COALESCE(EXCLUDED.sucursal, public.rutas_promotoras.sucursal),
      region_id = COALESCE(EXCLUDED.region_id, public.rutas_promotoras.region_id),
      estado_ruta = CASE
        WHEN public.rutas_promotoras.estado_ruta IN ('EN_CURSO', 'COMPLETADA')
             AND NEW.estado = 'APROBADA'
          THEN public.rutas_promotoras.estado_ruta
        ELSE EXCLUDED.estado_ruta
      END,
      aprobado_por = EXCLUDED.aprobado_por,
      updated_at = NOW();
  ELSE
    UPDATE public.rutas_promotoras
    SET estado_ruta = 'CANCELADA',
        updated_at = NOW()
    WHERE cronograma_id = NEW.id
      AND estado_ruta <> 'CANCELADA';
  END IF;

  RETURN NEW;
END;
$$;

-- Actualizar integridad de reportes_trade para los 5 hubs y sello de region_id
CREATE OR REPLACE FUNCTION public.fn_forzar_integridad_reporte_trade()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_rol TEXT;
  v_mi_sucursal public.sucursal_codigo;
  v_sucursal_cliente public.sucursal_codigo;
  v_cliente_activo BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
       OR NEW.promotora_id IS DISTINCT FROM OLD.promotora_id
       OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
       OR NEW.sucursal IS DISTINCT FROM OLD.sucursal THEN
      RAISE EXCEPTION 'Operación bloqueada: no se permite modificar sucursal, cliente_id, promotora_id ni auth_user_id en un reporte registrado.'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.sucursal IS NOT NULL AND NEW.sucursal <> 'GLOBAL'::public.sucursal_codigo THEN
      NEW.region_id := public.fn_resolver_region_id(NEW.sucursal::text);
    END IF;
    RETURN NEW;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticación requerida para registrar reportes de Trade Marketing.'
      USING ERRCODE = '42501';
  END IF;

  v_rol := (SELECT public.obtener_mi_rol());
  v_mi_sucursal := (SELECT public.obtener_mi_sucursal());

  IF v_rol <> 'promotora'
     OR v_mi_sucursal NOT IN (
       'ZULIA'::public.sucursal_codigo,
       'VALENCIA'::public.sucursal_codigo,
       'CENTRO'::public.sucursal_codigo,
       'ORIENTE'::public.sucursal_codigo,
       'CAPITAL'::public.sucursal_codigo
     ) THEN
    RAISE EXCEPTION 'REGION_CONTEXT_REQUIRED: solo una promotora activa con región asignada (1 de los 5 hubs) puede registrar reportes.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.sucursal IS NOT NULL AND NEW.sucursal <> v_mi_sucursal THEN
    RAISE EXCEPTION 'Cruce de sede bloqueado: tu perfil pertenece a % y no puede enviar reportes para %.',
      v_mi_sucursal, NEW.sucursal
      USING ERRCODE = '42501';
  END IF;

  NEW.auth_user_id := v_uid;
  NEW.sucursal := v_mi_sucursal;
  NEW.region_id := public.fn_resolver_region_id(NEW.sucursal::text);

  IF NEW.cliente_id IS NULL THEN
    RAISE EXCEPTION 'Debe especificar un cliente_id válido.'
      USING ERRCODE = '23502';
  END IF;

  SELECT c.sucursal, c.activo
  INTO v_sucursal_cliente, v_cliente_activo
  FROM public.clientes c
  WHERE c.id = NEW.cliente_id
  LIMIT 1;

  IF NOT FOUND OR v_cliente_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'El cliente seleccionado (%) no existe o se encuentra inactivo.', NEW.cliente_id
      USING ERRCODE = '42501';
  END IF;

  IF v_sucursal_cliente IS DISTINCT FROM NEW.sucursal THEN
    RAISE EXCEPTION 'Cruce territorial prohibido: el cliente pertenece a % y la promotora opera en %.',
      COALESCE(v_sucursal_cliente::text, 'SIN_SUCURSAL'), NEW.sucursal
      USING ERRCODE = '42501';
  END IF;

  IF NEW.observaciones IS NOT NULL THEN
    NEW.observaciones := left(btrim(NEW.observaciones), 2000);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_forzar_integridad_reporte_trade() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 6. BACKFILL IDEMPOTENTE DE `sucursal` Y `region_id` + SEMILLA DE TARIFARIO
-- =============================================================================

DO $$
DECLARE
  v_tbl TEXT;
  v_sync_tables TEXT[] := ARRAY[
    'clientes',
    'promotoras',
    'vendedores',
    'supervisores',
    'staff',
    'cadenas_comerciales',
    'zonas',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'ejecuciones_pdv_promotora',
    'asistencias_jornada',
    'material_pop_inventario',
    'material_pop_entregas',
    'incidencias_pdv',
    'cliente_portal_accesos',
    'solicitudes_contraloria',
    'campanas_trade',
    'presupuestos_trade',
    'tarifario_costos_trade',
    'entregas_degustacion',
    'reportes_trade'
  ];
BEGIN
  PERFORM set_config('codizulca.allow_legacy_null_backfill', '1', true);

  -- 6.1 profiles: sincronizar region_id para hubs regionales y NULL en GLOBAL
  UPDATE public.profiles p
  SET region_id = CASE
    WHEN p.sucursal = 'GLOBAL'::public.sucursal_codigo THEN NULL
    ELSE public.fn_resolver_region_id(p.sucursal::text)
  END
  WHERE p.region_id IS DISTINCT FROM (
    CASE
      WHEN p.sucursal = 'GLOBAL'::public.sucursal_codigo THEN NULL
      ELSE public.fn_resolver_region_id(p.sucursal::text)
    END
  );

  -- 6.2 zonas y cadenas_comerciales
  UPDATE public.zonas z
  SET sucursal = COALESCE(
    public.fn_resolver_sucursal_desde_region_id(z.region_id),
    public.fn_inferir_sucursal_codigo(concat_ws(' | ', z.estado, z.ciudad, z.nombre, z.codigo))
  )
  WHERE z.sucursal IS NULL
    AND COALESCE(
      public.fn_resolver_sucursal_desde_region_id(z.region_id),
      public.fn_inferir_sucursal_codigo(concat_ws(' | ', z.estado, z.ciudad, z.nombre, z.codigo))
    ) IS NOT NULL;

  UPDATE public.cadenas_comerciales cad
  SET sucursal = COALESCE(
    public.fn_resolver_sucursal_desde_region_id(cad.region_id),
    public.fn_inferir_sucursal_codigo(concat_ws(' | ', cad.nombre, cad.codigo))
  )
  WHERE cad.sucursal IS NULL
    AND COALESCE(
      public.fn_resolver_sucursal_desde_region_id(cad.region_id),
      public.fn_inferir_sucursal_codigo(concat_ws(' | ', cad.nombre, cad.codigo))
    ) IS NOT NULL;

  -- 6.3 supervisores y vendedores
  UPDATE public.supervisores sv
  SET sucursal = COALESCE(
    public.fn_resolver_sucursal_desde_region_id(sv.region_id),
    (
      SELECT p.sucursal
      FROM public.profiles p
      WHERE sv.email IS NOT NULL
        AND lower(btrim(sv.email)) = lower(btrim(p.email))
        AND p.sucursal <> 'GLOBAL'::public.sucursal_codigo
      LIMIT 1
    ),
    public.fn_inferir_sucursal_codigo(sv.zona)
  )
  WHERE sv.sucursal IS NULL
    AND COALESCE(
      public.fn_resolver_sucursal_desde_region_id(sv.region_id),
      (
        SELECT p.sucursal
        FROM public.profiles p
        WHERE sv.email IS NOT NULL
          AND lower(btrim(sv.email)) = lower(btrim(p.email))
          AND p.sucursal <> 'GLOBAL'::public.sucursal_codigo
        LIMIT 1
      ),
      public.fn_inferir_sucursal_codigo(sv.zona)
    ) IS NOT NULL;

  UPDATE public.vendedores v
  SET sucursal = COALESCE(
    public.fn_resolver_sucursal_desde_region_id(v.region_id),
    (
      SELECT p.sucursal
      FROM public.profiles p
      WHERE v.email IS NOT NULL
        AND lower(btrim(v.email)) = lower(btrim(p.email))
        AND p.sucursal <> 'GLOBAL'::public.sucursal_codigo
      LIMIT 1
    ),
    public.fn_inferir_sucursal_codigo(v.zona)
  )
  WHERE v.sucursal IS NULL
    AND COALESCE(
      public.fn_resolver_sucursal_desde_region_id(v.region_id),
      (
        SELECT p.sucursal
        FROM public.profiles p
        WHERE v.email IS NOT NULL
          AND lower(btrim(v.email)) = lower(btrim(p.email))
          AND p.sucursal <> 'GLOBAL'::public.sucursal_codigo
        LIMIT 1
      ),
      public.fn_inferir_sucursal_codigo(v.zona)
    ) IS NOT NULL;

  -- 6.4 clientes, promotoras y staff con las 5 regiones completas
  UPDATE public.clientes c
  SET sucursal = COALESCE(
    public.fn_resolver_sucursal_desde_region_id(c.region_id),
    public.fn_inferir_sucursal_codigo(concat_ws(' | ', c.estado, c.ciudad, c.zona, c.ruta, c.direccion))
  )
  WHERE c.sucursal IS NULL
    AND COALESCE(
      public.fn_resolver_sucursal_desde_region_id(c.region_id),
      public.fn_inferir_sucursal_codigo(concat_ws(' | ', c.estado, c.ciudad, c.zona, c.ruta, c.direccion))
    ) IS NOT NULL;

  UPDATE public.promotoras pr
  SET sucursal = COALESCE(
    public.fn_resolver_sucursal_desde_region_id(pr.region_id),
    public.fn_inferir_sucursal_codigo(concat_ws(' | ', pr.estado, pr.ciudad, pr.direccion))
  )
  WHERE pr.sucursal IS NULL
    AND COALESCE(
      public.fn_resolver_sucursal_desde_region_id(pr.region_id),
      public.fn_inferir_sucursal_codigo(concat_ws(' | ', pr.estado, pr.ciudad, pr.direccion))
    ) IS NOT NULL;

  UPDATE public.staff st
  SET sucursal = COALESCE(
    public.fn_resolver_sucursal_desde_region_id(st.region_id),
    (
      SELECT p.sucursal
      FROM public.profiles p
      WHERE (st.auth_user_id = p.id OR (btrim(st.email) <> '' AND lower(btrim(st.email)) = lower(btrim(p.email))))
        AND p.sucursal <> 'GLOBAL'::public.sucursal_codigo
      LIMIT 1
    ),
    (
      SELECT pr.sucursal
      FROM public.promotoras pr
      WHERE btrim(st.email) <> ''
        AND lower(btrim(st.email)) = lower(btrim(COALESCE(pr.email, '')))
        AND pr.sucursal IS NOT NULL
      LIMIT 1
    ),
    public.fn_inferir_sucursal_codigo(concat_ws(' | ', st.status, st.role))
  )
  WHERE st.sucursal IS NULL
    AND COALESCE(
      public.fn_resolver_sucursal_desde_region_id(st.region_id),
      (
        SELECT p.sucursal
        FROM public.profiles p
        WHERE (st.auth_user_id = p.id OR (btrim(st.email) <> '' AND lower(btrim(st.email)) = lower(btrim(p.email))))
          AND p.sucursal <> 'GLOBAL'::public.sucursal_codigo
        LIMIT 1
      ),
      (
        SELECT pr.sucursal
        FROM public.promotoras pr
        WHERE btrim(st.email) <> ''
          AND lower(btrim(st.email)) = lower(btrim(COALESCE(pr.email, '')))
          AND pr.sucursal IS NOT NULL
        LIMIT 1
      ),
      public.fn_inferir_sucursal_codigo(concat_ws(' | ', st.status, st.role))
    ) IS NOT NULL;

  -- 6.5 Propagar sucursal <-> region_id en todas las tablas editables
  FOREACH v_tbl IN ARRAY v_sync_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format(
        'UPDATE public.%I '
        || 'SET sucursal = public.fn_resolver_sucursal_desde_region_id(region_id) '
        || 'WHERE sucursal IS NULL AND region_id IS NOT NULL '
        || 'AND public.fn_resolver_sucursal_desde_region_id(region_id) IS NOT NULL',
        v_tbl
      );
      EXECUTE format(
        'UPDATE public.%I '
        || 'SET region_id = public.fn_resolver_region_id(sucursal::text) '
        || 'WHERE sucursal IS NOT NULL AND sucursal <> ''GLOBAL''::public.sucursal_codigo '
        || 'AND region_id IS DISTINCT FROM public.fn_resolver_region_id(sucursal::text)',
        v_tbl
      );
    END IF;
  END LOOP;

  -- Tablas financieras con candado de cierre: actualizar únicamente registros abiertos
  UPDATE public.contraloria_requisiciones
  SET region_id = public.fn_resolver_region_id(sucursal::text)
  WHERE estado <> 'CONCILIADO_CERRADO'
    AND sucursal IS NOT NULL
    AND sucursal <> 'GLOBAL'::public.sucursal_codigo
    AND region_id IS DISTINCT FROM public.fn_resolver_region_id(sucursal::text);

  UPDATE public.contraloria_conciliaciones
  SET region_id = public.fn_resolver_region_id(sucursal::text)
  WHERE cerrada = false
    AND sucursal IS NOT NULL
    AND sucursal <> 'GLOBAL'::public.sucursal_codigo
    AND region_id IS DISTINCT FROM public.fn_resolver_region_id(sucursal::text);

  UPDATE public.contraloria_facturas f
  SET region_id = public.fn_resolver_region_id(f.sucursal::text)
  WHERE f.sucursal IS NOT NULL
    AND f.sucursal <> 'GLOBAL'::public.sucursal_codigo
    AND f.region_id IS DISTINCT FROM public.fn_resolver_region_id(f.sucursal::text)
    AND EXISTS (
      SELECT 1
      FROM public.contraloria_conciliaciones cc
      WHERE cc.id = f.conciliacion_id
        AND cc.cerrada = false
    );

  PERFORM set_config('codizulca.allow_legacy_null_backfill', '0', true);
END $$;

-- Semilla idempotente del tarifario oficial para las 5 regiones (ZULIA, VALENCIA, CENTRO, ORIENTE, CAPITAL)
INSERT INTO public.tarifario_costos_trade (
  line_id,
  etiqueta,
  marca,
  unidad_medida,
  costo_unitario_usd,
  precio_referencia_usd,
  vigente_desde,
  sucursal,
  region_id
)
SELECT
  t.line_id,
  t.etiqueta,
  t.marca,
  t.unidad_medida,
  t.costo_unitario_usd,
  t.precio_referencia_usd,
  DATE '2026-01-01',
  s.sucursal,
  public.fn_resolver_region_id(s.sucursal::text)
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
  VALUES
    ('ZULIA'::public.sucursal_codigo),
    ('VALENCIA'::public.sucursal_codigo),
    ('CENTRO'::public.sucursal_codigo),
    ('ORIENTE'::public.sucursal_codigo),
    ('CAPITAL'::public.sucursal_codigo)
) AS s(sucursal)
ON CONFLICT (line_id, sucursal, vigente_desde) DO NOTHING;

-- =============================================================================
-- 7. RPCs IAM, SINCRONIZACIÓN MAESTRA Y CONTRALORÍA PARA LOS 5 HUBS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_update_user_access(
  p_target_user_id UUID,
  p_full_name TEXT,
  p_role TEXT,
  p_is_active BOOLEAN,
  p_must_change_password BOOLEAN DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
  sucursal TEXT,
  is_active BOOLEAN,
  must_change_password BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id UUID;
  v_clean_name TEXT;
  v_clean_role TEXT;
  v_target_sucursal public.sucursal_codigo;
  v_target_region_id UUID;
  v_current public.profiles%ROWTYPE;
  v_updated public.profiles%ROWTYPE;
  v_remaining_super_admins BIGINT := 0;
  v_audit_action TEXT;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'Acceso denegado: se requiere un perfil super_admin activo.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := (SELECT auth.uid());

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'El identificador del usuario objetivo (p_target_user_id) es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  IF p_is_active IS NULL THEN
    RAISE EXCEPTION 'El estado de acceso (p_is_active) es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_name := btrim(COALESCE(p_full_name, ''));
  IF char_length(v_clean_name) < 2 OR char_length(v_clean_name) > 160 THEN
    RAISE EXCEPTION 'El nombre completo debe contener entre 2 y 160 caracteres.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_role := public.fn_normalizar_rol_perfil(p_role);
  IF v_clean_role IS NULL THEN
    RAISE EXCEPTION 'Rol inválido (%). Valores permitidos: super_admin, coordinacion, contraloria, vendedor, promotora, cliente, chofer.', p_role
      USING ERRCODE = '22023';
  END IF;

  IF p_target_user_id = v_actor_id THEN
    IF p_is_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes suspender tu propia cuenta de super_admin.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_clean_role <> 'super_admin' THEN
      RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes cambiar tu propio rol fuera de super_admin.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  PERFORM 1
  FROM public.profiles p
  WHERE p.role = 'super_admin'
  ORDER BY p.id
  FOR UPDATE;

  SELECT *
  INTO v_current
  FROM public.profiles p
  WHERE p.id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe el perfil solicitado (%) en public.profiles.', p_target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_clean_role = 'super_admin' THEN
    v_target_sucursal := 'GLOBAL'::public.sucursal_codigo;
  ELSIF p_sucursal IS NOT NULL AND btrim(p_sucursal) <> '' THEN
    v_target_sucursal := COALESCE(
      public.fn_normalizar_sucursal_codigo(p_sucursal),
      public.fn_resolver_sucursal_desde_region_id(public.fn_resolver_region_id(p_sucursal))
    );
    IF v_target_sucursal IS NULL THEN
      RAISE EXCEPTION 'Sucursal/región inválida (%). Valores permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE, CAPITAL o GLOBAL.', p_sucursal
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_target_sucursal := v_current.sucursal;
    IF v_target_sucursal = 'GLOBAL'::public.sucursal_codigo AND v_clean_role <> 'contraloria' THEN
      RAISE EXCEPTION 'Debe asignar una región operativa (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) al cambiar al rol %.', v_clean_role
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_target_sucursal = 'GLOBAL'::public.sucursal_codigo
     AND v_clean_role NOT IN ('super_admin', 'contraloria') THEN
    RAISE EXCEPTION 'La sucursal GLOBAL está reservada exclusivamente para super_admin y contraloria (recibido rol: %).', v_clean_role
      USING ERRCODE = '22023';
  END IF;

  v_target_region_id := CASE
    WHEN v_target_sucursal = 'GLOBAL'::public.sucursal_codigo THEN NULL
    ELSE public.fn_resolver_region_id(v_target_sucursal::text)
  END;

  IF v_current.role = 'super_admin'
     AND v_current.is_active = true
     AND (v_clean_role <> 'super_admin' OR p_is_active IS DISTINCT FROM true) THEN
    SELECT COUNT(*)
    INTO v_remaining_super_admins
    FROM public.profiles p
    WHERE p.role = 'super_admin'
      AND p.is_active = true
      AND p.id <> p_target_user_id;

    IF v_remaining_super_admins < 1 THEN
      RAISE EXCEPTION 'Operación bloqueada: el sistema debe mantener al menos un usuario super_admin activo.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.profiles p
  SET
    full_name = v_clean_name,
    role = v_clean_role,
    sucursal = v_target_sucursal,
    region_id = v_target_region_id,
    is_active = p_is_active,
    must_change_password = COALESCE(p_must_change_password, p.must_change_password),
    updated_at = now()
  WHERE p.id = p_target_user_id
  RETURNING * INTO v_updated;

  UPDATE auth.users u
  SET
    banned_until = CASE
      WHEN p_is_active THEN NULL
      ELSE '2099-12-31T23:59:59Z'::timestamptz
    END,
    raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', v_updated.role,
      'app_role', v_updated.role,
      'sucursal', v_updated.sucursal::text,
      'region_id', v_updated.region_id,
      'display_name', v_updated.full_name,
      'is_active', v_updated.is_active,
      'must_change_password', v_updated.must_change_password
    ),
    updated_at = now()
  WHERE u.id = p_target_user_id;

  v_audit_action := CASE
    WHEN v_current.is_active = true AND v_updated.is_active = false THEN 'USER_SUSPENDED'
    WHEN v_current.is_active = false AND v_updated.is_active = true THEN 'USER_REACTIVATED'
    WHEN v_current.role <> v_updated.role THEN 'USER_ROLE_CHANGED'
    WHEN v_current.sucursal IS DISTINCT FROM v_updated.sucursal THEN 'USER_BRANCH_CHANGED'
    ELSE 'USER_ACCESS_UPDATED'
  END;

  INSERT INTO public.user_management_audit (
    actor_id,
    target_user_id,
    target_email,
    action,
    details
  )
  VALUES (
    v_actor_id,
    v_updated.id,
    v_updated.email,
    v_audit_action,
    jsonb_build_object(
      'previous', jsonb_build_object(
        'full_name', v_current.full_name,
        'role', v_current.role,
        'sucursal', v_current.sucursal::text,
        'region_id', v_current.region_id,
        'is_active', v_current.is_active,
        'must_change_password', v_current.must_change_password
      ),
      'next', jsonb_build_object(
        'full_name', v_updated.full_name,
        'role', v_updated.role,
        'sucursal', v_updated.sucursal::text,
        'region_id', v_updated.region_id,
        'is_active', v_updated.is_active,
        'must_change_password', v_updated.must_change_password
      )
    )
  );

  RETURN QUERY
  SELECT
    v_updated.id,
    v_updated.email,
    v_updated.full_name,
    v_updated.role,
    v_updated.sucursal::text,
    v_updated.is_active,
    v_updated.must_change_password,
    v_updated.created_at,
    v_updated.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_user_access(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_finalize_created_user(
  p_target_user_id UUID,
  p_full_name TEXT,
  p_role TEXT,
  p_must_change_password BOOLEAN DEFAULT false,
  p_sucursal TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
  sucursal TEXT,
  is_active BOOLEAN,
  must_change_password BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id UUID;
  v_clean_name TEXT;
  v_clean_role TEXT;
  v_clean_sucursal public.sucursal_codigo;
  v_clean_region_id UUID;
  v_must_change BOOLEAN;
  v_target_email TEXT;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT (SELECT public.is_super_admin()) THEN
    RAISE EXCEPTION 'Acceso denegado: se requiere un perfil super_admin activo.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := (SELECT auth.uid());

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'El identificador del nuevo usuario (p_target_user_id) es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_name := btrim(COALESCE(p_full_name, ''));
  IF char_length(v_clean_name) < 2 OR char_length(v_clean_name) > 160 THEN
    RAISE EXCEPTION 'El nombre completo debe contener entre 2 y 160 caracteres.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_role := public.fn_normalizar_rol_perfil(p_role);
  IF v_clean_role IS NULL THEN
    RAISE EXCEPTION 'Rol inválido (%). Valores permitidos: super_admin, coordinacion, contraloria, vendedor, promotora, cliente, chofer.', p_role
      USING ERRCODE = '22023';
  END IF;

  IF p_target_user_id = v_actor_id AND v_clean_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Operación bloqueada (anti auto-bloqueo): no puedes cambiar tu propio rol fuera de super_admin.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_clean_role = 'super_admin' THEN
    v_clean_sucursal := 'GLOBAL'::public.sucursal_codigo;
  ELSIF p_sucursal IS NULL OR btrim(p_sucursal) = '' THEN
    IF v_clean_role = 'contraloria' THEN
      v_clean_sucursal := 'GLOBAL'::public.sucursal_codigo;
    ELSE
      RAISE EXCEPTION 'La región operativa (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) es obligatoria para el rol %.', v_clean_role
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_clean_sucursal := COALESCE(
      public.fn_normalizar_sucursal_codigo(p_sucursal),
      public.fn_resolver_sucursal_desde_region_id(public.fn_resolver_region_id(p_sucursal))
    );
    IF v_clean_sucursal IS NULL THEN
      RAISE EXCEPTION 'Sucursal/región inválida (%). Valores permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE, CAPITAL o GLOBAL.', p_sucursal
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_clean_sucursal = 'GLOBAL'::public.sucursal_codigo
     AND v_clean_role NOT IN ('super_admin', 'contraloria') THEN
    RAISE EXCEPTION 'La sucursal GLOBAL está reservada exclusivamente para super_admin y contraloria (recibido rol: %).', v_clean_role
      USING ERRCODE = '22023';
  END IF;

  v_clean_region_id := CASE
    WHEN v_clean_sucursal = 'GLOBAL'::public.sucursal_codigo THEN NULL
    ELSE public.fn_resolver_region_id(v_clean_sucursal::text)
  END;

  v_must_change := COALESCE(p_must_change_password, false);

  UPDATE auth.users u
  SET
    email_confirmed_at = COALESCE(u.email_confirmed_at, now()),
    banned_until = NULL,
    raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
      'role', v_clean_role,
      'app_role', v_clean_role,
      'sucursal', v_clean_sucursal::text,
      'region_id', v_clean_region_id,
      'display_name', v_clean_name,
      'is_active', true,
      'must_change_password', v_must_change
    ),
    updated_at = now()
  WHERE u.id = p_target_user_id
  RETURNING lower(btrim(COALESCE(u.email, ''))) INTO v_target_email;

  IF NOT FOUND OR v_target_email IS NULL OR v_target_email = '' THEN
    RAISE EXCEPTION 'El usuario objetivo (%) no existe en auth.users o carece de correo válido.', p_target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    role,
    sucursal,
    region_id,
    is_active,
    must_change_password
  )
  VALUES (
    p_target_user_id,
    v_target_email,
    v_clean_name,
    v_clean_role,
    v_clean_sucursal,
    v_clean_region_id,
    true,
    v_must_change
  )
  ON CONFLICT (id) DO UPDATE
  SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    sucursal = EXCLUDED.sucursal,
    region_id = EXCLUDED.region_id,
    is_active = true,
    must_change_password = EXCLUDED.must_change_password,
    updated_at = now()
  RETURNING * INTO v_profile;

  INSERT INTO public.user_management_audit (
    actor_id,
    target_user_id,
    target_email,
    action,
    details
  )
  VALUES (
    v_actor_id,
    v_profile.id,
    v_profile.email,
    'USER_CREATED',
    jsonb_build_object(
      'full_name', v_profile.full_name,
      'role', v_profile.role,
      'sucursal', v_profile.sucursal::text,
      'region_id', v_profile.region_id,
      'is_active', v_profile.is_active,
      'must_change_password', v_profile.must_change_password,
      'provisioned_via', 'server_admin_api'
    )
  );

  RETURN QUERY
  SELECT
    v_profile.id,
    v_profile.email,
    v_profile.full_name,
    v_profile.role,
    v_profile.sucursal::text,
    v_profile.is_active,
    v_profile.must_change_password,
    v_profile.created_at,
    v_profile.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finalize_created_user(UUID, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;

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
  v_ctx_sucursal public.sucursal_codigo := (SELECT public.obtener_sucursal_contexto_activo());
BEGIN
  IF NOT (SELECT public.is_coordinadora_or_admin()) THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol coordinacion o super_admin activo para sincronizar vendedores.'
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
        WHEN v_ctx_sucursal IN (
          'ZULIA'::public.sucursal_codigo,
          'VALENCIA'::public.sucursal_codigo,
          'CENTRO'::public.sucursal_codigo,
          'ORIENTE'::public.sucursal_codigo,
          'CAPITAL'::public.sucursal_codigo
        ) THEN v_ctx_sucursal
        ELSE COALESCE(
          public.fn_normalizar_sucursal_codigo(elem ->> 'sucursal'),
          public.fn_resolver_sucursal_desde_region_id(public.fn_resolver_region_id(elem ->> 'region_id')),
          public.fn_inferir_sucursal_codigo(elem ->> 'zona')
        )
      END AS sucursal_resuelta,
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
      CASE
        WHEN sucursal_resuelta IN (
          'ZULIA'::public.sucursal_codigo,
          'VALENCIA'::public.sucursal_codigo,
          'CENTRO'::public.sucursal_codigo,
          'ORIENTE'::public.sucursal_codigo,
          'CAPITAL'::public.sucursal_codigo
        ) THEN sucursal_resuelta
        ELSE NULL
      END AS sucursal,
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
      sucursal,
      region_id,
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
      sucursal,
      public.fn_resolver_region_id(sucursal::text),
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
      sucursal = COALESCE(public.vendedores.sucursal, EXCLUDED.sucursal),
      region_id = COALESCE(public.vendedores.region_id, EXCLUDED.region_id),
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

  IF cardinality(v_codigos_procesados) > 0 THEN
    UPDATE public.clientes c
    SET vendedor_id = v.id
    FROM public.vendedores v
    WHERE v.codigo_vendedor = ANY(v_codigos_procesados)
      AND c.codigo_vendedor = v.codigo_vendedor
      AND (SELECT public.tiene_acceso_sucursal(c.sucursal))
      AND c.vendedor_id IS DISTINCT FROM v.id;
  END IF;

  IF COALESCE(p_desactivar_ausentes, false) = true AND cardinality(v_codigos_procesados) > 0 THEN
    UPDATE public.vendedores v
    SET activo = false
    WHERE v.activo = true
      AND (SELECT public.tiene_acceso_sucursal(v.sucursal))
      AND NOT (v.codigo_vendedor = ANY(v_codigos_procesados));
    GET DIAGNOSTICS v_desactivados = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'procesados', v_procesados,
    'sin_vendedor_asignado', 0,
    'desactivados', v_desactivados
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_sincronizar_vendedores(JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_sincronizar_vendedores(JSONB, BOOLEAN) TO authenticated, service_role;

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
  v_ctx_sucursal public.sucursal_codigo := (SELECT public.obtener_sucursal_contexto_activo());
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
        WHEN v_ctx_sucursal IN (
          'ZULIA'::public.sucursal_codigo,
          'VALENCIA'::public.sucursal_codigo,
          'CENTRO'::public.sucursal_codigo,
          'ORIENTE'::public.sucursal_codigo,
          'CAPITAL'::public.sucursal_codigo
        ) THEN v_ctx_sucursal
        ELSE COALESCE(
          public.fn_normalizar_sucursal_codigo(elem ->> 'sucursal'),
          public.fn_resolver_sucursal_desde_region_id(public.fn_resolver_region_id(elem ->> 'region_id')),
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
        WHEN sucursal_resuelta IN (
          'ZULIA'::public.sucursal_codigo,
          'VALENCIA'::public.sucursal_codigo,
          'CENTRO'::public.sucursal_codigo,
          'ORIENTE'::public.sucursal_codigo,
          'CAPITAL'::public.sucursal_codigo
        ) THEN sucursal_resuelta
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
      region_id,
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
      public.fn_resolver_region_id(d.sucursal::text),
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
      region_id = COALESCE(public.clientes.region_id, EXCLUDED.region_id),
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

-- Actualizar RPCs de Contraloría para exigir cualquiera de los 5 hubs sin degradar GLOBAL a ZULIA
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
  v_my_suc public.sucursal_codigo := (SELECT public.obtener_mi_sucursal());
  v_ctx_suc public.sucursal_codigo := (SELECT public.obtener_sucursal_contexto_activo());
  v_req_suc public.sucursal_codigo := public.fn_normalizar_sucursal_codigo(p_payload ->> 'sucursal');
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

  IF v_my_suc IN (
    'ZULIA'::public.sucursal_codigo,
    'VALENCIA'::public.sucursal_codigo,
    'CENTRO'::public.sucursal_codigo,
    'ORIENTE'::public.sucursal_codigo,
    'CAPITAL'::public.sucursal_codigo
  ) THEN
    IF v_req_suc IS NOT NULL AND v_req_suc <> v_my_suc THEN
      RAISE EXCEPTION 'FORBIDDEN_BRANCH: Tu perfil pertenece a % y no puede radicar solicitudes en %.', v_my_suc, v_req_suc
        USING ERRCODE = '42501';
    END IF;
    v_sucursal := v_my_suc;
  ELSE
    v_sucursal := COALESCE(
      CASE WHEN v_req_suc <> 'GLOBAL'::public.sucursal_codigo THEN v_req_suc ELSE NULL END,
      CASE WHEN v_ctx_suc <> 'GLOBAL'::public.sucursal_codigo THEN v_ctx_suc ELSE NULL END
    );
  END IF;

  IF v_sucursal IS NULL OR v_sucursal = 'GLOBAL'::public.sucursal_codigo THEN
    RAISE EXCEPTION 'REGION_CONTEXT_REQUIRED: Debe especificar una región operativa válida (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL).'
      USING ERRCODE = '42501';
  END IF;

  v_code := public.fn_generar_correlativo_mp07();

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
    sucursal,
    region_id
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
    v_sucursal,
    public.fn_resolver_region_id(v_sucursal::text)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_crear_solicitud_contraloria(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_crear_solicitud_contraloria(JSONB) TO authenticated, service_role;

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
  v_ctx_suc public.sucursal_codigo := public.obtener_sucursal_contexto_activo();
  v_req_suc public.sucursal_codigo := public.fn_normalizar_sucursal_codigo(p_payload ->> 'sucursal');
  v_target_suc public.sucursal_codigo;
  v_target_region_id UUID;
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

  IF v_my_suc IN (
    'ZULIA'::public.sucursal_codigo,
    'VALENCIA'::public.sucursal_codigo,
    'CENTRO'::public.sucursal_codigo,
    'ORIENTE'::public.sucursal_codigo,
    'CAPITAL'::public.sucursal_codigo
  ) THEN
    IF v_req_suc IS NOT NULL AND v_req_suc <> v_my_suc THEN
      RAISE EXCEPTION 'FORBIDDEN_BRANCH: No tienes permiso para crear requisiciones en la sede %.', v_req_suc
        USING ERRCODE = '42501';
    END IF;
    v_target_suc := v_my_suc;
  ELSE
    v_target_suc := COALESCE(
      CASE WHEN v_req_suc <> 'GLOBAL'::public.sucursal_codigo THEN v_req_suc ELSE NULL END,
      CASE WHEN v_ctx_suc <> 'GLOBAL'::public.sucursal_codigo THEN v_ctx_suc ELSE NULL END
    );
  END IF;

  IF v_target_suc IS NULL OR v_target_suc = 'GLOBAL'::public.sucursal_codigo THEN
    RAISE EXCEPTION 'REGION_CONTEXT_REQUIRED: Debe seleccionar una región operativa activa (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) para crear requisiciones.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.tiene_acceso_sucursal(v_target_suc) THEN
    RAISE EXCEPTION 'FORBIDDEN_BRANCH: No tienes permiso para crear requisiciones en la sede %.', v_target_suc
      USING ERRCODE = '42501';
  END IF;

  v_target_region_id := public.fn_resolver_region_id(v_target_suc::text);

  v_code := upper(btrim(COALESCE(p_payload ->> 'codigo_correlativo', '')));
  IF v_code = '' OR v_code = 'AUTO' THEN
    v_code := public.fn_generar_correlativo_mp07();
  END IF;

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
    sucursal,
    region_id
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
    v_target_suc,
    v_target_region_id
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
    sucursal,
    region_id
  )
  VALUES (
    v_req.id,
    v_req.codigo_correlativo,
    COALESCE(NULLIF(v_first_prod, ''), v_req.proposito_campana),
    v_req.total_unidades,
    0,
    0,
    0,
    v_req.sucursal,
    v_req.region_id
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
  v_email TEXT := public.obtener_mi_correo_jwt();
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

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.email, v_rol)
  INTO v_actor_name
  FROM public.profiles p
  WHERE p.id = v_uid
     OR (v_email IS NOT NULL AND lower(btrim(p.email)) = v_email)
  ORDER BY CASE WHEN p.id = v_uid THEN 0 ELSE 1 END ASC
  LIMIT 1;

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
    'region_id', COALESCE(v_req.region_id, public.fn_resolver_region_id(v_req.sucursal::text)),
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
    sucursal,
    region_id
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
    v_req.sucursal,
    COALESCE(v_req.region_id, public.fn_resolver_region_id(v_req.sucursal::text))
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
    'requisicion', to_jsonb(v_req_closed),
    'conciliacion', to_jsonb(v_conc_closed)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_emitir_paz_y_salvo(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_emitir_paz_y_salvo(UUID, TEXT) TO authenticated, service_role;

-- =============================================================================
-- 8. POLÍTICAS DE SUPABASE STORAGE PARA LOS 3 BUCKETS PRIVADOS EN LOS 5 HUBS:
--    `asistencia-evidencias`, `incidencias-evidencias`, `contraloria-facturas`
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_tiene_acceso_objeto_asistencia(
  p_object_name TEXT,
  p_write BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_segments TEXT[];
  v_seg2 TEXT;
  v_seg3 TEXT;
  v_target_sucursal public.sucursal_codigo := NULL;
  v_staff_id UUID := NULL;
  v_my_promotora UUID := (SELECT private.current_active_promotora_id());
BEGIN
  IF (SELECT auth.uid()) IS NULL OR p_object_name IS NULL THEN
    RETURN false;
  END IF;

  v_segments := storage.foldername(p_object_name);
  IF COALESCE(v_segments[1], '') <> 'asistencia' THEN
    RETURN false;
  END IF;

  v_seg2 := upper(btrim(COALESCE(v_segments[2], '')));
  v_seg3 := btrim(COALESCE(v_segments[3], ''));

  IF v_seg2 IN ('ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL') THEN
    v_target_sucursal := v_seg2::public.sucursal_codigo;
  ELSIF v_seg3 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_staff_id := v_seg3::uuid;
    SELECT s.sucursal
    INTO v_target_sucursal
    FROM public.staff s
    WHERE s.id = v_staff_id
    LIMIT 1;
  END IF;

  IF v_target_sucursal IS NULL OR NOT public.tiene_acceso_sucursal(v_target_sucursal) THEN
    RETURN false;
  END IF;

  IF p_write THEN
    RETURN public.is_coordinadora_or_admin()
      OR (v_my_promotora IS NOT NULL AND v_seg3 = v_my_promotora::text);
  END IF;

  RETURN public.is_torre_control_viewer()
    OR (v_my_promotora IS NOT NULL AND v_seg3 = v_my_promotora::text);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_tiene_acceso_objeto_asistencia(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_tiene_acceso_objeto_asistencia(TEXT, BOOLEAN) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    -- 8.1 asistencia-evidencias
    DROP POLICY IF EXISTS storage_asistencia_evidencias_select ON storage.objects;
    DROP POLICY IF EXISTS storage_asistencia_evidencias_select_torre_viewer ON storage.objects;
    DROP POLICY IF EXISTS storage_asistencia_evidencias_insert ON storage.objects;
    DROP POLICY IF EXISTS storage_asistencia_evidencias_update ON storage.objects;
    DROP POLICY IF EXISTS storage_asistencia_evidencias_delete ON storage.objects;

    CREATE POLICY storage_asistencia_evidencias_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'asistencia-evidencias'
        AND (SELECT public.fn_tiene_acceso_objeto_asistencia(name, false))
      );

    CREATE POLICY storage_asistencia_evidencias_insert
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'asistencia-evidencias'
        AND (SELECT public.fn_tiene_acceso_objeto_asistencia(name, true))
      );

    CREATE POLICY storage_asistencia_evidencias_update
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (
        bucket_id = 'asistencia-evidencias'
        AND (SELECT public.fn_tiene_acceso_objeto_asistencia(name, true))
      )
      WITH CHECK (
        bucket_id = 'asistencia-evidencias'
        AND (SELECT public.fn_tiene_acceso_objeto_asistencia(name, true))
      );

    CREATE POLICY storage_asistencia_evidencias_delete
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'asistencia-evidencias'
        AND (SELECT public.fn_tiene_acceso_objeto_asistencia(name, true))
      );

    -- 8.2 incidencias-evidencias
    DROP POLICY IF EXISTS storage_incidencias_evidencias_select ON storage.objects;
    DROP POLICY IF EXISTS storage_incidencias_evidencias_insert ON storage.objects;

    CREATE POLICY storage_incidencias_evidencias_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'incidencias-evidencias'
        AND (storage.foldername(name))[1] = 'incidencias'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND (
          (SELECT public.is_torre_control_viewer())
          OR (SELECT public.obtener_mi_rol()) IN ('promotora', 'vendedor')
        )
        AND (SELECT public.tiene_acceso_sucursal(
          public.fn_normalizar_sucursal_codigo((storage.foldername(name))[2])
        ))
      );

    CREATE POLICY storage_incidencias_evidencias_insert
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'incidencias-evidencias'
        AND (storage.foldername(name))[1] = 'incidencias'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND (SELECT public.obtener_mi_rol()) IN ('super_admin', 'coordinacion', 'promotora', 'vendedor')
        AND (SELECT public.tiene_acceso_sucursal(
          public.fn_normalizar_sucursal_codigo((storage.foldername(name))[2])
        ))
      );

    -- 8.3 contraloria-facturas
    DROP POLICY IF EXISTS storage_contraloria_facturas_select ON storage.objects;
    DROP POLICY IF EXISTS storage_contraloria_facturas_insert ON storage.objects;

    CREATE POLICY storage_contraloria_facturas_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'contraloria-facturas'
        AND (storage.foldername(name))[1] = 'facturas'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND (SELECT public.is_torre_control_viewer())
        AND (SELECT public.tiene_acceso_sucursal(
          public.fn_normalizar_sucursal_codigo((storage.foldername(name))[2])
        ))
      );

    CREATE POLICY storage_contraloria_facturas_insert
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'contraloria-facturas'
        AND (storage.foldername(name))[1] = 'facturas'
        AND upper(COALESCE((storage.foldername(name))[2], '')) IN (
          'ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'
        )
        AND (SELECT public.is_torre_control_viewer())
        AND (SELECT public.tiene_acceso_sucursal(
          public.fn_normalizar_sucursal_codigo((storage.foldername(name))[2])
        ))
      );
  END IF;
END $$;

-- =============================================================================
-- 9. RPCs DE INTERFAZ REGIONAL Y COMPARATIVO EJECUTIVO MULTI-REGIÓN
-- =============================================================================

-- 9.1 Catálogo dinámico de regiones activas ordenadas canónicamente
CREATE OR REPLACE FUNCTION public.rpc_listar_regiones_activas()
RETURNS TABLE (
  id UUID,
  codigo TEXT,
  nombre TEXT,
  activo BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: Se requiere sesión autenticada para listar regiones activas.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    COALESCE(
      NULLIF(upper(btrim(r.codigo)), ''),
      (public.fn_normalizar_sucursal_codigo(r.nombre))::text,
      upper(btrim(r.nombre))
    ) AS codigo,
    r.nombre,
    COALESCE(r.activo, true) AS activo
  FROM public.regiones r
  WHERE COALESCE(r.activo, true) = true
  ORDER BY
    CASE COALESCE(
      NULLIF(upper(btrim(r.codigo)), ''),
      (public.fn_normalizar_sucursal_codigo(r.nombre))::text
    )
      WHEN 'ZULIA' THEN 1
      WHEN 'VALENCIA' THEN 2
      WHEN 'CENTRO' THEN 3
      WHEN 'ORIENTE' THEN 4
      WHEN 'CAPITAL' THEN 5
      ELSE 99
    END ASC,
    lower(btrim(r.nombre)) ASC;
END;
$$;

COMMENT ON FUNCTION public.rpc_listar_regiones_activas() IS
  'Devuelve las regiones activas de public.regiones en orden corporativo canónico (ZULIA, VALENCIA, CENTRO, ORIENTE, CAPITAL).';

REVOKE ALL ON FUNCTION public.rpc_listar_regiones_activas() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_listar_regiones_activas() TO authenticated, service_role;

-- 9.2 Directorio aislado de personal y accesos del hub activo o solicitado
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
        'region_id', cad.region_id
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

COMMENT ON FUNCTION public.rpc_listar_personal_sucursal(TEXT) IS
  'Devuelve JSONB (profiles, staff, clientes, cadenas, portal_accesos) estrictamente aislado al hub de coordinacion o al hub solicitado por super_admin/contraloria.';

REVOKE ALL ON FUNCTION public.rpc_listar_personal_sucursal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_listar_personal_sucursal(TEXT) TO authenticated, service_role;

-- 9.3 Comparativo ejecutivo consolidado multi-región (exclusivo super_admin y contraloria)
CREATE OR REPLACE FUNCTION public.rpc_comparativo_regiones_resumen(
  p_periodo_inicio DATE DEFAULT NULL,
  p_periodo_fin DATE DEFAULT NULL
)
RETURNS TABLE (
  region_id UUID,
  region_codigo TEXT,
  region_nombre TEXT,
  clientes_activos BIGINT,
  promotoras_activas BIGINT,
  vendedores_activos BIGINT,
  rutas_programadas BIGINT,
  rutas_completadas BIGINT,
  cumplimiento_rutas_pct NUMERIC(5,2),
  degustaciones_programadas BIGINT,
  degustaciones_ejecutadas BIGINT,
  muestras_entregadas BIGINT,
  ventas_asistidas BIGINT,
  presupuesto_asignado_usd NUMERIC(14,2),
  presupuesto_ejecutado_usd NUMERIC(14,2),
  ejecucion_presupuestaria_pct NUMERIC(6,2),
  requisiciones_mp07_total BIGINT,
  requisiciones_conciliadas BIGINT,
  pop_items_activos BIGINT,
  pop_stock_critico_count BIGINT,
  incidencias_totales BIGINT,
  incidencias_abiertas BIGINT,
  incidencias_en_sla_count BIGINT,
  cumplimiento_sla_pct NUMERIC(5,2)
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT (SELECT public.is_contraloria_or_admin()) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: rpc_comparativo_regiones_resumen es exclusivo para super_admin y contraloria.'
      USING ERRCODE = '42501';
  END IF;

  IF p_periodo_inicio IS NOT NULL AND p_periodo_fin IS NOT NULL AND p_periodo_fin < p_periodo_inicio THEN
    RAISE EXCEPTION 'INVALID_PERIOD: p_periodo_fin (%) no puede ser anterior a p_periodo_inicio (%).',
      p_periodo_fin, p_periodo_inicio
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH regiones_activas AS (
    SELECT
      r.id AS reg_id,
      COALESCE(
        NULLIF(upper(btrim(r.codigo)), ''),
        (public.fn_normalizar_sucursal_codigo(r.nombre))::text,
        upper(btrim(r.nombre))
      ) AS reg_codigo,
      r.nombre AS reg_nombre,
      public.fn_normalizar_sucursal_codigo(COALESCE(r.codigo, r.nombre)) AS reg_sucursal,
      CASE COALESCE(
        NULLIF(upper(btrim(r.codigo)), ''),
        (public.fn_normalizar_sucursal_codigo(r.nombre))::text
      )
        WHEN 'ZULIA' THEN 1
        WHEN 'VALENCIA' THEN 2
        WHEN 'CENTRO' THEN 3
        WHEN 'ORIENTE' THEN 4
        WHEN 'CAPITAL' THEN 5
        ELSE 99
      END AS sort_rank
    FROM public.regiones r
    WHERE COALESCE(r.activo, true) = true
  )
  SELECT
    ra.reg_id AS region_id,
    ra.reg_codigo AS region_codigo,
    ra.reg_nombre AS region_nombre,
    COALESCE(cli.clientes_activos, 0)::BIGINT AS clientes_activos,
    GREATEST(COALESCE(stf.staff_activas, 0), COALESCE(prm.promotoras_cat_activas, 0))::BIGINT AS promotoras_activas,
    COALESCE(vnd.vendedores_activos, 0)::BIGINT AS vendedores_activos,
    COALESCE(rut.rutas_programadas, 0)::BIGINT AS rutas_programadas,
    COALESCE(rut.rutas_completadas, 0)::BIGINT AS rutas_completadas,
    CASE
      WHEN COALESCE(rut.rutas_programadas, 0) > 0 THEN
        LEAST(100.00, ROUND((rut.rutas_completadas::numeric * 100.0) / rut.rutas_programadas::numeric, 2))::NUMERIC(5,2)
      ELSE 0.00::NUMERIC(5,2)
    END AS cumplimiento_rutas_pct,
    COALESCE(deg.degustaciones_programadas, 0)::BIGINT AS degustaciones_programadas,
    COALESCE(deg.degustaciones_ejecutadas, 0)::BIGINT AS degustaciones_ejecutadas,
    COALESCE(ejc.muestras_entregadas, 0)::BIGINT AS muestras_entregadas,
    COALESCE(ejc.ventas_asistidas, 0)::BIGINT AS ventas_asistidas,
    COALESCE(pre.presupuesto_asignado_usd, 0.00)::NUMERIC(14,2) AS presupuesto_asignado_usd,
    COALESCE(pre.presupuesto_ejecutado_usd, 0.00)::NUMERIC(14,2) AS presupuesto_ejecutado_usd,
    CASE
      WHEN COALESCE(pre.presupuesto_asignado_usd, 0) > 0 THEN
        LEAST(9999.99, ROUND((COALESCE(pre.presupuesto_ejecutado_usd, 0) * 100.0) / pre.presupuesto_asignado_usd, 2))::NUMERIC(6,2)
      ELSE 0.00::NUMERIC(6,2)
    END AS ejecucion_presupuestaria_pct,
    COALESCE(req.requisiciones_mp07_total, 0)::BIGINT AS requisiciones_mp07_total,
    COALESCE(req.requisiciones_conciliadas, 0)::BIGINT AS requisiciones_conciliadas,
    COALESCE(pop.pop_items_activos, 0)::BIGINT AS pop_items_activos,
    COALESCE(pop.pop_stock_critico_count, 0)::BIGINT AS pop_stock_critico_count,
    COALESCE(inc.incidencias_totales, 0)::BIGINT AS incidencias_totales,
    COALESCE(inc.incidencias_abiertas, 0)::BIGINT AS incidencias_abiertas,
    COALESCE(inc.incidencias_en_sla_count, 0)::BIGINT AS incidencias_en_sla_count,
    CASE
      WHEN COALESCE(inc.incidencias_totales, 0) > 0 THEN
        LEAST(100.00, ROUND((inc.incidencias_en_sla_count::numeric * 100.0) / inc.incidencias_totales::numeric, 2))::NUMERIC(5,2)
      ELSE 0.00::NUMERIC(5,2)
    END AS cumplimiento_sla_pct
  FROM regiones_activas ra
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS clientes_activos
    FROM public.clientes c
    WHERE COALESCE(c.activo, true) = true
      AND (c.region_id = ra.reg_id OR (c.region_id IS NULL AND c.sucursal = ra.reg_sucursal))
  ) cli ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS staff_activas
    FROM public.staff s
    WHERE (s.region_id = ra.reg_id OR (s.region_id IS NULL AND s.sucursal = ra.reg_sucursal))
      AND lower(btrim(COALESCE(s.status, 'Activo'))) NOT LIKE '%inactivo%'
      AND lower(COALESCE(s.role, '')) NOT LIKE '%merchandising%'
  ) stf ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS promotoras_cat_activas
    FROM public.promotoras pr
    WHERE COALESCE(pr.activo, true) = true
      AND (pr.region_id = ra.reg_id OR (pr.region_id IS NULL AND pr.sucursal = ra.reg_sucursal))
  ) prm ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS vendedores_activos
    FROM public.vendedores v
    WHERE COALESCE(v.activo, true) = true
      AND (v.region_id = ra.reg_id OR (v.region_id IS NULL AND v.sucursal = ra.reg_sucursal))
  ) vnd ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE rp.estado_ruta <> 'CANCELADA')::BIGINT AS rutas_programadas,
      COUNT(*) FILTER (WHERE rp.estado_ruta = 'COMPLETADA')::BIGINT AS rutas_completadas
    FROM public.rutas_promotoras rp
    WHERE (rp.region_id = ra.reg_id OR (rp.region_id IS NULL AND rp.sucursal = ra.reg_sucursal))
      AND (p_periodo_inicio IS NULL OR rp.fecha >= p_periodo_inicio)
      AND (p_periodo_fin IS NULL OR rp.fecha <= p_periodo_fin)
  ) rut ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE cd.estado NOT IN ('RECHAZADA', 'CANCELADA', 'NO_AUTORIZADA'))::BIGINT AS degustaciones_programadas,
      COUNT(*) FILTER (WHERE cd.estado = 'COMPLETADA')::BIGINT AS degustaciones_ejecutadas
    FROM public.cronograma_degustaciones cd
    WHERE (cd.region_id = ra.reg_id OR (cd.region_id IS NULL AND cd.sucursal = ra.reg_sucursal))
      AND (p_periodo_inicio IS NULL OR cd.fecha >= p_periodo_inicio)
      AND (p_periodo_fin IS NULL OR cd.fecha <= p_periodo_fin)
  ) deg ON true
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(ep.muestras_entregadas), 0)::BIGINT AS muestras_entregadas,
      COALESCE(SUM(ep.ventas_asistidas_unidades), 0)::BIGINT AS ventas_asistidas
    FROM public.ejecuciones_pdv_promotora ep
    WHERE (ep.region_id = ra.reg_id OR (ep.region_id IS NULL AND ep.sucursal = ra.reg_sucursal))
      AND (p_periodo_inicio IS NULL OR ep.fecha >= p_periodo_inicio)
      AND (p_periodo_fin IS NULL OR ep.fecha <= p_periodo_fin)
  ) ejc ON true
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(pt.monto_asignado_usd), 0.00)::NUMERIC(14,2) AS presupuesto_asignado_usd,
      COALESCE(SUM(pt.monto_ejecutado_usd), 0.00)::NUMERIC(14,2) AS presupuesto_ejecutado_usd
    FROM public.presupuestos_trade pt
    WHERE COALESCE(pt.activo, true) = true
      AND (pt.region_id = ra.reg_id OR (pt.region_id IS NULL AND pt.sucursal = ra.reg_sucursal))
      AND (p_periodo_inicio IS NULL OR pt.periodo_ym >= to_char(p_periodo_inicio, 'YYYY-MM'))
      AND (p_periodo_fin IS NULL OR pt.periodo_ym <= to_char(p_periodo_fin, 'YYYY-MM'))
  ) pre ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE cr.estado <> 'RECHAZADO')::BIGINT AS requisiciones_mp07_total,
      COUNT(*) FILTER (WHERE cr.estado = 'CONCILIADO_CERRADO')::BIGINT AS requisiciones_conciliadas
    FROM public.contraloria_requisiciones cr
    WHERE (cr.region_id = ra.reg_id OR (cr.region_id IS NULL AND cr.sucursal = ra.reg_sucursal))
      AND (p_periodo_inicio IS NULL OR cr.fecha_iso >= p_periodo_inicio)
      AND (p_periodo_fin IS NULL OR cr.fecha_iso <= p_periodo_fin)
  ) req ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(mp.activo, true) = true)::BIGINT AS pop_items_activos,
      COUNT(*) FILTER (
        WHERE COALESCE(mp.activo, true) = true
          AND mp.stock_disponible <= mp.stock_minimo
      )::BIGINT AS pop_stock_critico_count
    FROM public.material_pop_inventario mp
    WHERE mp.region_id = ra.reg_id
       OR (mp.region_id IS NULL AND mp.sucursal = ra.reg_sucursal)
  ) pop ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::BIGINT AS incidencias_totales,
      COUNT(*) FILTER (WHERE ip.estado IN ('ABIERTA', 'EN_PROCESO'))::BIGINT AS incidencias_abiertas,
      COUNT(*) FILTER (
        WHERE (
          ip.estado IN ('RESUELTA', 'CERRADA')
          AND COALESCE(ip.resuelta_en, ip.updated_at) <= ip.sla_vence_en
        )
        OR (
          ip.estado IN ('ABIERTA', 'EN_PROCESO')
          AND now() <= ip.sla_vence_en
        )
      )::BIGINT AS incidencias_en_sla_count
    FROM public.incidencias_pdv ip
    WHERE (ip.region_id = ra.reg_id OR (ip.region_id IS NULL AND ip.sucursal = ra.reg_sucursal))
      AND (
        p_periodo_inicio IS NULL
        OR (ip.created_at AT TIME ZONE 'America/Caracas')::date >= p_periodo_inicio
      )
      AND (
        p_periodo_fin IS NULL
        OR (ip.created_at AT TIME ZONE 'America/Caracas')::date <= p_periodo_fin
      )
  ) inc ON true
  ORDER BY ra.sort_rank ASC, lower(btrim(ra.reg_nombre)) ASC;
END;
$$;

COMMENT ON FUNCTION public.rpc_comparativo_regiones_resumen(DATE, DATE) IS
  'Reporte comparativo consolidado de KPIs comerciales, rutas, degustaciones, presupuestos, MP-07, POP y SLA por cada región activa. Exclusivo para super_admin y contraloria.';

REVOKE ALL ON FUNCTION public.rpc_comparativo_regiones_resumen(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_comparativo_regiones_resumen(DATE, DATE) TO authenticated, service_role;

-- =============================================================================
-- 10. ACTUALIZACIÓN DE `public.rpc_certificar_esquema_trade()` PARA LAS 5 REGIONES
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_certificar_esquema_trade()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE((SELECT auth.jwt() ->> 'role'), '');
  v_is_authorized BOOLEAN := false;
  v_expected_tables CONSTANT TEXT[] := ARRAY[
    'regiones',
    'profiles',
    'clientes',
    'vendedores',
    'promotoras',
    'reportes_trade',
    'staff',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'asistencias_jornada',
    'asistencia_evidencias',
    'solicitudes_contraloria',
    'entregas_degustacion'
  ];
  v_tbl TEXT;
  v_oid OID;
  v_rls BOOLEAN;
  v_force_rls BOOLEAN;
  v_suc_type TEXT;
  v_has_region_id BOOLEAN;
  v_pol_count INTEGER;
  v_anon_pol_count INTEGER;
  v_legacy_pols JSONB;
  v_tables_report JSONB := '[]'::jsonb;
  v_anon_grants JSONB := '[]'::jsonb;
  v_enum_labels JSONB := '[]'::jsonb;
  v_regiones_catalog JSONB := '{}'::jsonb;
  v_active_hubs JSONB := '[]'::jsonb;
  v_functions JSONB;
  v_indexes JSONB;
  v_surveys_cols JSONB;
BEGIN
  v_is_authorized :=
    v_jwt_role = 'service_role'
    OR current_user IN ('postgres', 'supabase_admin', 'service_role')
    OR ((SELECT auth.uid()) IS NOT NULL AND (SELECT public.is_super_admin()));

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Acceso denegado: rpc_certificar_esquema_trade() requiere super_admin o service_role.'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(e.enumlabel ORDER BY e.enumsortorder), '[]'::jsonb)
  INTO v_enum_labels
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public'
    AND t.typname = 'sucursal_codigo';

  IF to_regclass('public.regiones') IS NOT NULL THEN
    SELECT COALESCE(
      jsonb_agg(
        DISTINCT COALESCE(
          NULLIF(upper(btrim(r.codigo)), ''),
          (public.fn_normalizar_sucursal_codigo(r.nombre))::text
        )
      ),
      '[]'::jsonb
    )
    INTO v_active_hubs
    FROM public.regiones r
    WHERE COALESCE(r.activo, true) = true;
  END IF;

  v_regiones_catalog := jsonb_build_object(
    'exists', to_regclass('public.regiones') IS NOT NULL,
    'has_codigo_column', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.regiones')
        AND a.attname = 'codigo' AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'has_nombre_column', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.regiones')
        AND a.attname = 'nombre' AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'has_activo_column', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.regiones')
        AND a.attname = 'activo' AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'active_hubs', v_active_hubs
  );

  FOREACH v_tbl IN ARRAY v_expected_tables LOOP
    SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity
    INTO v_oid, v_rls, v_force_rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_tbl
      AND c.relkind IN ('r', 'p')
    LIMIT 1;

    IF v_oid IS NULL THEN
      v_tables_report := v_tables_report || jsonb_build_object(
        'table_name', v_tbl,
        'exists', false,
        'rls_enabled', false,
        'force_rls', false,
        'has_sucursal_column', false,
        'has_region_id_column', false,
        'sucursal_type', NULL,
        'policy_count', 0,
        'anon_policy_count', 0,
        'unfiltered_legacy_policies', '[]'::jsonb
      );
      CONTINUE;
    END IF;

    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod)
    INTO v_suc_type
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = v_oid
      AND a.attname = 'sucursal'
      AND a.attnum > 0
      AND NOT a.attisdropped
    LIMIT 1;

    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = v_oid
        AND a.attname = 'region_id'
        AND a.attnum > 0
        AND NOT a.attisdropped
    )
    INTO v_has_region_id;

    SELECT
      COUNT(*)::integer,
      COUNT(*) FILTER (WHERE 'anon' = ANY(p.roles))::integer,
      COALESCE(
        jsonb_agg(p.policyname ORDER BY p.policyname) FILTER (
          WHERE p.policyname ~ '^(rbac_coordinadora_ops_|rbac_super_admin_all_)'
        ),
        '[]'::jsonb
      )
    INTO v_pol_count, v_anon_pol_count, v_legacy_pols
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = v_tbl;

    v_tables_report := v_tables_report || jsonb_build_object(
      'table_name', v_tbl,
      'exists', true,
      'rls_enabled', COALESCE(v_rls, false),
      'force_rls', COALESCE(v_force_rls, false),
      'has_sucursal_column', v_suc_type IS NOT NULL,
      'has_region_id_column', COALESCE(v_has_region_id, false),
      'sucursal_type', v_suc_type,
      'policy_count', COALESCE(v_pol_count, 0),
      'anon_policy_count', COALESCE(v_anon_pol_count, 0),
      'unfiltered_legacy_policies', COALESCE(v_legacy_pols, '[]'::jsonb)
    );

    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
      IF pg_catalog.has_table_privilege('anon', v_oid, 'SELECT')
         OR pg_catalog.has_table_privilege('anon', v_oid, 'INSERT')
         OR pg_catalog.has_table_privilege('anon', v_oid, 'UPDATE')
         OR pg_catalog.has_table_privilege('anon', v_oid, 'DELETE') THEN
        v_anon_grants := v_anon_grants || jsonb_build_object(
          'table_name', v_tbl,
          'select', pg_catalog.has_table_privilege('anon', v_oid, 'SELECT'),
          'insert', pg_catalog.has_table_privilege('anon', v_oid, 'INSERT'),
          'update', pg_catalog.has_table_privilege('anon', v_oid, 'UPDATE'),
          'delete', pg_catalog.has_table_privilege('anon', v_oid, 'DELETE')
        );
      END IF;
    END IF;
  END LOOP;

  v_functions := jsonb_build_object(
    'obtener_mi_correo_jwt', to_regprocedure('public.obtener_mi_correo_jwt()') IS NOT NULL,
    'obtener_mi_rol', to_regprocedure('public.obtener_mi_rol()') IS NOT NULL,
    'obtener_mi_sucursal', to_regprocedure('public.obtener_mi_sucursal()') IS NOT NULL,
    'obtener_mi_region_id', to_regprocedure('public.obtener_mi_region_id()') IS NOT NULL,
    'obtener_sucursal_contexto_activo', to_regprocedure('public.obtener_sucursal_contexto_activo()') IS NOT NULL,
    'fn_resolver_region_id', to_regprocedure('public.fn_resolver_region_id(text)') IS NOT NULL,
    'tiene_acceso_sucursal', to_regprocedure('public.tiene_acceso_sucursal(public.sucursal_codigo)') IS NOT NULL,
    'tiene_acceso_region', to_regprocedure('public.tiene_acceso_region(uuid,public.sucursal_codigo)') IS NOT NULL,
    'is_super_admin', to_regprocedure('public.is_super_admin()') IS NOT NULL,
    'is_coordinadora_or_admin', to_regprocedure('public.is_coordinadora_or_admin()') IS NOT NULL,
    'is_torre_control_viewer', to_regprocedure('public.is_torre_control_viewer()') IS NOT NULL,
    'is_chofer_or_logistics_ops', to_regprocedure('public.is_chofer_or_logistics_ops()') IS NOT NULL,
    'fn_sellar_y_proteger_sucursal_operativa', to_regprocedure('public.fn_sellar_y_proteger_sucursal_operativa()') IS NOT NULL,
    'fn_surveys_sellar_autor', to_regprocedure('public.fn_surveys_sellar_autor()') IS NOT NULL,
    'fn_surveys_normalizar_degustacion_key', to_regprocedure('public.fn_surveys_normalizar_degustacion_key()') IS NOT NULL,
    'rpc_listar_regiones_activas', to_regprocedure('public.rpc_listar_regiones_activas()') IS NOT NULL,
    'rpc_listar_personal_sucursal', to_regprocedure('public.rpc_listar_personal_sucursal(text)') IS NOT NULL,
    'rpc_comparativo_regiones_resumen', to_regprocedure('public.rpc_comparativo_regiones_resumen(date,date)') IS NOT NULL,
    'rpc_certificar_esquema_trade', to_regprocedure('public.rpc_certificar_esquema_trade()') IS NOT NULL,
    'vincular_mi_usuario_auth', to_regprocedure('public.vincular_mi_usuario_auth()') IS NOT NULL
  );

  v_indexes := jsonb_build_object(
    'uq_surveys_degustacion_key_active', to_regclass('public.uq_surveys_degustacion_key_active') IS NOT NULL,
    'idx_surveys_autor_user_id', to_regclass('public.idx_surveys_autor_user_id') IS NOT NULL,
    'idx_clientes_vendedor_id', to_regclass('public.idx_clientes_vendedor_id') IS NOT NULL,
    'idx_clientes_codigo_vendedor', to_regclass('public.idx_clientes_codigo_vendedor') IS NOT NULL,
    'idx_clientes_region_id', to_regclass('public.idx_clientes_region_id') IS NOT NULL,
    'idx_profiles_region_id', to_regclass('public.idx_profiles_region_id') IS NOT NULL
  );

  SELECT jsonb_build_object(
    'autor_user_id', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.surveys')
        AND a.attname = 'autor_user_id' AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'sucursal', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.surveys')
        AND a.attname = 'sucursal' AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'region_id', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.surveys')
        AND a.attname = 'region_id' AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'degustacion_key', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.surveys')
        AND a.attname = 'degustacion_key' AND a.attnum > 0 AND NOT a.attisdropped
    )
  )
  INTO v_surveys_cols;

  RETURN jsonb_build_object(
    'certified_at', now(),
    'schema', 'public',
    'sucursal_codigo_enum', v_enum_labels,
    'regiones_catalog', v_regiones_catalog,
    'tables', v_tables_report,
    'legacy_tables', jsonb_build_object(
      'perfiles_acceso_exists', to_regclass('public.perfiles_acceso') IS NOT NULL,
      'perfiles_acceso_deprecado_exists', to_regclass('public.perfiles_acceso_deprecado_hito1') IS NOT NULL
    ),
    'functions', v_functions,
    'indexes', v_indexes,
    'surveys_columns', v_surveys_cols,
    'anon_table_grants', v_anon_grants
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_certificar_esquema_trade() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_certificar_esquema_trade() TO authenticated, service_role;

COMMIT;
