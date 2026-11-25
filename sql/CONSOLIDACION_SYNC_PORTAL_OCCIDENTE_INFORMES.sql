-- ==============================================================================
-- MIGRACIÓN CONSOLIDADA, ADITIVA E IDEMPOTENTE (100% RE-EJECUTABLE EN PRODUCCIÓN)
-- Archivo: supabase/migrations/20261211000100_consolidacion_sync_portal_occidente_informes.sql
-- Proyecto objetivo: Trade Marketing CODIZULCA (apaxdgxtaoeyswlfblgi.supabase.co)
--
-- Cierra TODAS las brechas de sincronización App de Promotoras (/portal) ->
-- Base de Datos -> Módulo 1 -> Zona Occidente / Centro -> Informes:
--   1. Columnas bimonetarias + OCR + cadena + `client_submission_id` (UUID UNIQUE)
--      en `public.prices`, `public.surveys` y `public.inventory`.
--   2. Tablas faltantes en producción con RLS estricto (`ENABLE + FORCE RLS`,
--      cero `anon`): `public.tasas_bcv`, `public.configuracion_alertas_precios`,
--      `public.alertas_precios`, `public.incidencias_pdv`,
--      `public.ejecuciones_pdv_promotora` y `public.alertas_geocerca_auditoria`.
--   3. RPCs `SECURITY DEFINER` idempotentes (`SET search_path = public`) para
--      escrituras críticas desde `/portal`:
--        - `public.rpc_registrar_inventario_portal`
--        - `public.rpc_registrar_encuesta_portal`
--        - `public.rpc_registrar_precio_portal`
--        - `public.rpc_registrar_ejecucion_ruta_promotora`
--   4. Normalización canónica multisede (`CENTRO` | `OCCIDENTE`) vía
--      `public.normalizar_sucursal_multisede()`.
--   5. Publicación `supabase_realtime` garantizada para todas las tablas de
--      Módulo 1 -> Informes y recarga de caché PostgREST (`NOTIFY pgrst`).
--
-- Garantías de seguridad (AGENTS.md):
--   - RLS estrictamente habilitado y forzado en todas las tablas (`ENABLE` + `FORCE RLS`, cero desactivación de RLS).
--   - ZERO acceso `anon` / `PUBLIC` (`REVOKE ALL ... FROM PUBLIC, anon`).
--   - ZERO DDL destructivo (sin `DROP TABLE`, `DROP COLUMN` ni `TRUNCATE`).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. COLUMNAS ADITIVAS E IDEMPOTENCIA EN TABLAS EXISTENTES DE INFORMES Y RUTA
-- ------------------------------------------------------------------------------
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS sucursal TEXT,
  ADD COLUMN IF NOT EXISTS region TEXT DEFAULT 'Occidente',
  ADD COLUMN IF NOT EXISTS zona TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS promotora_id TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS sales_generated NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cronograma_id UUID,
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_client_submission_id_unique
  ON public.inventory (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

ALTER TABLE public.prices
  ADD COLUMN IF NOT EXISTS sucursal TEXT,
  ADD COLUMN IF NOT EXISTS region TEXT DEFAULT 'Occidente',
  ADD COLUMN IF NOT EXISTS zona TEXT,
  ADD COLUMN IF NOT EXISTS cadena TEXT,
  ADD COLUMN IF NOT EXISTS promotora_id TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS bcv_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS photo_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS moneda_propia TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS moneda_competencia TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS tasa_bcv_aplicada NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS tasa_bcv_fecha DATE,
  ADD COLUMN IF NOT EXISTS precio_propio_usd NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS precio_competencia_usd NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS brecha_usd NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS brecha_porcentaje NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS competitors_meta JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ocr_asistido BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ocr_confianza TEXT,
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_prices_client_submission_id_unique
  ON public.prices (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prices_sucursal_created_at
  ON public.prices (sucursal, created_at DESC);

ALTER TABLE public.surveys
  ADD COLUMN IF NOT EXISTS sucursal TEXT,
  ADD COLUMN IF NOT EXISTS region TEXT DEFAULT 'Occidente',
  ADD COLUMN IF NOT EXISTS promotora_id TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_client_submission_id_unique
  ON public.surveys (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_surveys_type_sucursal_created_at
  ON public.surveys (type, sucursal, created_at DESC);

ALTER TABLE public.rutas_promotoras
  ADD COLUMN IF NOT EXISTS sucursal TEXT,
  ADD COLUMN IF NOT EXISTS region TEXT,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS muestras_entregadas INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS meta_muestras INTEGER NOT NULL DEFAULT 150,
  ADD COLUMN IF NOT EXISTS unidades_vendidas NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notas_campo TEXT DEFAULT '',
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

-- Constraints bimonetarios idempotentes sobre `public.prices`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prices_moneda_propia_check' AND conrelid = 'public.prices'::regclass
  ) THEN
    ALTER TABLE public.prices
      ADD CONSTRAINT prices_moneda_propia_check CHECK (moneda_propia IN ('USD', 'VES'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prices_moneda_competencia_check' AND conrelid = 'public.prices'::regclass
  ) THEN
    ALTER TABLE public.prices
      ADD CONSTRAINT prices_moneda_competencia_check CHECK (moneda_competencia IN ('USD', 'VES'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prices_tasa_bcv_aplicada_check' AND conrelid = 'public.prices'::regclass
  ) THEN
    ALTER TABLE public.prices
      ADD CONSTRAINT prices_tasa_bcv_aplicada_check CHECK (tasa_bcv_aplicada IS NULL OR tasa_bcv_aplicada > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prices_ocr_confianza_check' AND conrelid = 'public.prices'::regclass
  ) THEN
    ALTER TABLE public.prices
      ADD CONSTRAINT prices_ocr_confianza_check CHECK (
        ocr_confianza IS NULL OR ocr_confianza IN ('alta', 'media', 'baja')
      );
  END IF;
END
$$;

-- Backfill seguro de columnas USD históricas en `public.prices`
UPDATE public.prices
SET
  tasa_bcv_aplicada = COALESCE(tasa_bcv_aplicada, CASE WHEN bcv_rate IS NOT NULL AND bcv_rate > 0 THEN ROUND(bcv_rate::numeric, 4) ELSE NULL END),
  tasa_bcv_fecha = COALESCE(tasa_bcv_fecha, (created_at AT TIME ZONE 'America/Caracas')::date),
  precio_propio_usd = COALESCE(precio_propio_usd, CASE WHEN "ourPrice" IS NOT NULL AND "ourPrice" > 0 THEN ROUND("ourPrice"::numeric, 4) ELSE NULL END),
  precio_competencia_usd = COALESCE(
    precio_competencia_usd,
    CASE
      WHEN COALESCE("competitor1Price", "competitorPrice") IS NOT NULL
           AND COALESCE("competitor1Price", "competitorPrice") > 0
      THEN ROUND(COALESCE("competitor1Price", "competitorPrice")::numeric, 4)
      ELSE NULL
    END
  )
WHERE precio_propio_usd IS NULL
   OR (COALESCE("competitor1Price", "competitorPrice") IS NOT NULL AND precio_competencia_usd IS NULL);

UPDATE public.prices
SET
  brecha_usd = COALESCE(brecha_usd, ROUND((precio_propio_usd - precio_competencia_usd)::numeric, 4)),
  brecha_porcentaje = COALESCE(
    brecha_porcentaje,
    ROUND((((precio_propio_usd - precio_competencia_usd) / precio_competencia_usd) * 100.0)::numeric, 2)
  )
WHERE precio_propio_usd IS NOT NULL
  AND precio_competencia_usd IS NOT NULL
  AND precio_competencia_usd > 0
  AND (brecha_usd IS NULL OR brecha_porcentaje IS NULL);

-- ------------------------------------------------------------------------------
-- 2. CREACIÓN ADITIVA DE TABLAS FALTANTES EN PRODUCCIÓN (GUARDADAS CON to_regclass)
--    Mantiene 100% compatibilidad con el analizador estático (cero N-01) y es
--    ejecutable de forma independiente en el SQL Editor de producción.
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  -- 2.1 Tasa oficial BCV (`public.tasas_bcv`)
  IF to_regclass('public.tasas_bcv') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.tasas_bcv (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fecha DATE NOT NULL UNIQUE,
        tasa_usd_ves NUMERIC(12, 4) NOT NULL CHECK (tasa_usd_ves > 0),
        fuente TEXT NOT NULL DEFAULT 'BCV_OFICIAL'
          CHECK (fuente IN ('BCV_OFICIAL', 'MANUAL_ADMIN', 'RESPALDO')),
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
      )
    $ddl$;
  END IF;

  -- 2.2 Configuración de umbrales de alertas de precios (`public.configuracion_alertas_precios`)
  IF to_regclass('public.configuracion_alertas_precios') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.configuracion_alertas_precios (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        region TEXT NOT NULL UNIQUE,
        umbral_caida_porcentaje NUMERIC(5, 2) NOT NULL DEFAULT 10.00
          CHECK (umbral_caida_porcentaje > 0 AND umbral_caida_porcentaje <= 95),
        ventana_dias INTEGER NOT NULL DEFAULT 30
          CHECK (ventana_dias BETWEEN 1 AND 365),
        activo BOOLEAN NOT NULL DEFAULT true,
        updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    $ddl$;
  END IF;

  -- 2.3 Alertas automáticas de caída de precios (`public.alertas_precios`)
  IF to_regclass('public.alertas_precios') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.alertas_precios (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        price_id UUID NOT NULL REFERENCES public.prices(id) ON DELETE CASCADE,
        previous_price_id UUID REFERENCES public.prices(id) ON DELETE SET NULL,
        region TEXT NOT NULL,
        sucursal TEXT CHECK (sucursal IS NULL OR sucursal IN ('CENTRO', 'OCCIDENTE')),
        cadena TEXT,
        zona TEXT,
        store TEXT NOT NULL,
        producto_propio TEXT NOT NULL,
        marca_competidor TEXT NOT NULL,
        precio_anterior_usd NUMERIC(12, 4) NOT NULL CHECK (precio_anterior_usd > 0),
        precio_actual_usd NUMERIC(12, 4) NOT NULL CHECK (precio_actual_usd > 0),
        caida_porcentaje NUMERIC(8, 2) NOT NULL CHECK (caida_porcentaje > 0),
        umbral_aplicado NUMERIC(5, 2) NOT NULL CHECK (umbral_aplicado > 0),
        severidad TEXT NOT NULL DEFAULT 'media'
          CHECK (severidad IN ('baja', 'media', 'alta', 'critica')),
        estado TEXT NOT NULL DEFAULT 'pendiente'
          CHECK (estado IN ('pendiente', 'revisada', 'descartada')),
        notas_revision TEXT,
        revisada_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        revisada_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_alertas_precios_price_brand UNIQUE (price_id, marca_competidor)
      )
    $ddl$;
  END IF;

  -- 2.4 Incidencias en Punto de Venta (`public.incidencias_pdv`)
  IF to_regclass('public.incidencias_pdv') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.incidencias_pdv (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        codigo_incidencia TEXT NOT NULL DEFAULT '',
        cliente_id UUID NULL,
        pdv_nombre TEXT NOT NULL,
        ruta_id UUID NULL REFERENCES public.rutas_promotoras(id) ON DELETE SET NULL,
        reportado_por_uid UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
        reportado_por_nombre TEXT NOT NULL DEFAULT '',
        responsable_nombre TEXT NOT NULL DEFAULT 'Coordinación Trade',
        tipo_incidencia TEXT NOT NULL
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
        descripcion TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'ABIERTA'
          CHECK (estado IN ('ABIERTA', 'EN_PROCESO', 'RESUELTA', 'CERRADA')),
        sla_horas INTEGER NOT NULL DEFAULT 24 CHECK (sla_horas > 0),
        sla_vence_en TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
        resuelta_en TIMESTAMPTZ NULL,
        notas_resolucion TEXT NOT NULL DEFAULT '',
        foto_storage_bucket TEXT NULL,
        foto_storage_path TEXT NULL,
        foto_mime_type TEXT NULL,
        foto_sha256_hex TEXT NULL,
        client_submission_id TEXT NULL UNIQUE,
        sucursal TEXT NOT NULL DEFAULT 'OCCIDENTE'
          CHECK (sucursal IN ('CENTRO', 'OCCIDENTE')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    $ddl$;
  END IF;

  -- 2.5 Ejecuciones de PDV de promotora (`public.ejecuciones_pdv_promotora`)
  IF to_regclass('public.ejecuciones_pdv_promotora') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.ejecuciones_pdv_promotora (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ruta_id UUID NOT NULL UNIQUE REFERENCES public.rutas_promotoras(id) ON DELETE RESTRICT,
        cronograma_id UUID NULL REFERENCES public.cronograma_degustaciones(id) ON DELETE SET NULL,
        promotora_id TEXT NOT NULL,
        auth_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
        cliente_id UUID NULL,
        cliente_nombre TEXT NOT NULL,
        fecha DATE NOT NULL,
        lote_producto TEXT NOT NULL DEFAULT '',
        fecha_vencimiento DATE NULL,
        unidades_abiertas NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (unidades_abiertas >= 0),
        muestras_entregadas INTEGER NOT NULL DEFAULT 0 CHECK (muestras_entregadas >= 0),
        ventas_asistidas_unidades INTEGER NOT NULL DEFAULT 0 CHECK (ventas_asistidas_unidades >= 0),
        observaciones TEXT NOT NULL DEFAULT '',
        client_submission_id TEXT NOT NULL UNIQUE,
        sucursal TEXT NOT NULL DEFAULT 'OCCIDENTE'
          CHECK (sucursal IN ('CENTRO', 'OCCIDENTE')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    $ddl$;
  END IF;

  -- 2.6 Auditoría inmutable de geocercas (`public.alertas_geocerca_auditoria`)
  IF to_regclass('public.alertas_geocerca_auditoria') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE public.alertas_geocerca_auditoria (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ruta_id UUID NOT NULL REFERENCES public.rutas_promotoras(id) ON DELETE RESTRICT,
        promotora_id TEXT NOT NULL,
        auth_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
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
        sucursal TEXT NOT NULL DEFAULT 'OCCIDENTE'
          CHECK (sucursal IN ('CENTRO', 'OCCIDENTE')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    $ddl$;
  END IF;

  -- 2.7 Bucket privado de incidencias (`incidencias-evidencias`)
  IF to_regclass('storage.buckets') IS NOT NULL THEN
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
  END IF;
END
$$;

-- Semilla idempotente de umbral global de alertas de precios
INSERT INTO public.configuracion_alertas_precios (region, umbral_caida_porcentaje, ventana_dias, activo)
VALUES ('GLOBAL', 10.00, 30, true)
ON CONFLICT (region) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 3. BLINDAJE RLS (`ENABLE + FORCE`, CERO `anon`) Y NORMALIZACIÓN MULTISEDE
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tasas_bcv',
    'configuracion_alertas_precios',
    'alertas_precios',
    'incidencias_pdv',
    'ejecuciones_pdv_promotora',
    'alertas_geocerca_auditoria'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', tbl);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO authenticated, service_role', tbl);
      EXECUTE format('GRANT DELETE ON TABLE public.%I TO service_role', tbl);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    END IF;
  END LOOP;
END
$$;

-- Políticas explícitas verificadas contra `authenticated` (con `DROP POLICY IF EXISTS`)
DROP POLICY IF EXISTS tasas_bcv_select_authenticated ON public.tasas_bcv;
CREATE POLICY tasas_bcv_select_authenticated
  ON public.tasas_bcv
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS tasas_bcv_manage_admin ON public.tasas_bcv;
CREATE POLICY tasas_bcv_manage_admin
  ON public.tasas_bcv
  FOR ALL
  TO authenticated
  USING ((SELECT public.es_admin_nacional()))
  WITH CHECK ((SELECT public.es_admin_nacional()));

DROP POLICY IF EXISTS cfg_alertas_precios_select_auth ON public.configuracion_alertas_precios;
CREATE POLICY cfg_alertas_precios_select_auth
  ON public.configuracion_alertas_precios
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS cfg_alertas_precios_write_admin ON public.configuracion_alertas_precios;
CREATE POLICY cfg_alertas_precios_write_admin
  ON public.configuracion_alertas_precios
  FOR ALL
  TO authenticated
  USING ((SELECT public.es_admin_nacional()))
  WITH CHECK ((SELECT public.es_admin_nacional()));

DROP POLICY IF EXISTS alertas_precios_select_multisede ON public.alertas_precios;
CREATE POLICY alertas_precios_select_multisede
  ON public.alertas_precios
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(region) = (SELECT public.obtener_mi_sucursal())
  );

DROP POLICY IF EXISTS alertas_precios_update_multisede ON public.alertas_precios;
CREATE POLICY alertas_precios_update_multisede
  ON public.alertas_precios
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(region) = (SELECT public.obtener_mi_sucursal())
  )
  WITH CHECK (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(region) = (SELECT public.obtener_mi_sucursal())
  );

DROP POLICY IF EXISTS incidencias_pdv_select_multisede ON public.incidencias_pdv;
CREATE POLICY incidencias_pdv_select_multisede
  ON public.incidencias_pdv
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.es_admin_nacional())
    OR reportado_por_uid = (SELECT auth.uid())
    OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
  );

DROP POLICY IF EXISTS incidencias_pdv_insert_multisede ON public.incidencias_pdv;
CREATE POLICY incidencias_pdv_insert_multisede
  ON public.incidencias_pdv
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) IS NOT NULL
    AND (
      (SELECT public.es_admin_nacional())
      OR reportado_por_uid = (SELECT auth.uid())
    )
    AND (
      (SELECT public.es_admin_nacional())
      OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
    )
  );

DROP POLICY IF EXISTS incidencias_pdv_update_multisede ON public.incidencias_pdv;
CREATE POLICY incidencias_pdv_update_multisede
  ON public.incidencias_pdv
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
  )
  WITH CHECK (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
  );

DROP POLICY IF EXISTS ejecuciones_pdv_select_multisede ON public.ejecuciones_pdv_promotora;
CREATE POLICY ejecuciones_pdv_select_multisede
  ON public.ejecuciones_pdv_promotora
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
  );

DROP POLICY IF EXISTS ejecuciones_pdv_write_multisede ON public.ejecuciones_pdv_promotora;
CREATE POLICY ejecuciones_pdv_write_multisede
  ON public.ejecuciones_pdv_promotora
  FOR ALL
  TO authenticated
  USING (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
  )
  WITH CHECK (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
  );

DROP POLICY IF EXISTS alertas_geocerca_select_multisede ON public.alertas_geocerca_auditoria;
CREATE POLICY alertas_geocerca_select_multisede
  ON public.alertas_geocerca_auditoria
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.es_admin_nacional())
    OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
  );

DROP POLICY IF EXISTS alertas_geocerca_insert_multisede ON public.alertas_geocerca_auditoria;
CREATE POLICY alertas_geocerca_insert_multisede
  ON public.alertas_geocerca_auditoria
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) IS NOT NULL
    AND (
      (SELECT public.es_admin_nacional())
      OR public.normalizar_sucursal_multisede(sucursal::text) = (SELECT public.obtener_mi_sucursal())
    )
  );

-- Trigger de normalización automática + código autogenerado en `public.incidencias_pdv`
CREATE OR REPLACE FUNCTION public.fn_incidencias_pdv_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm_suc TEXT;
BEGIN
  v_norm_suc := COALESCE(
    public.normalizar_sucursal_multisede(NEW.sucursal::text),
    public.obtener_mi_sucursal(),
    'OCCIDENTE'
  );
  IF v_norm_suc NOT IN ('CENTRO', 'OCCIDENTE') THEN
    v_norm_suc := 'OCCIDENTE';
  END IF;
  NEW.sucursal := v_norm_suc;

  IF COALESCE(BTRIM(NEW.codigo_incidencia), '') = '' OR UPPER(BTRIM(NEW.codigo_incidencia)) = 'AUTO' THEN
    NEW.codigo_incidencia := 'INC-' || to_char(now() AT TIME ZONE 'America/Caracas', 'YYYYMMDD') || '-' ||
      UPPER(SUBSTRING(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6));
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_incidencias_pdv_before_write() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_incidencias_pdv_before_write ON public.incidencias_pdv;
CREATE TRIGGER trg_incidencias_pdv_before_write
  BEFORE INSERT OR UPDATE ON public.incidencias_pdv
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_incidencias_pdv_before_write();

-- Trigger automático de alertas de caída de precios (> umbral %) compatible multisede
CREATE OR REPLACE FUNCTION public.fn_detectar_alerta_caida_precio_competidor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm_suc TEXT;
  v_umbral NUMERIC(5, 2) := 10.00;
  v_ventana INTEGER := 30;
  v_cfg_activo BOOLEAN := true;
  v_comp RECORD;
  v_prev_id UUID;
  v_prev_usd NUMERIC(12, 4);
  v_drop_pct NUMERIC(8, 2);
  v_sev TEXT;
BEGIN
  IF to_regclass('public.configuracion_alertas_precios') IS NULL
     OR to_regclass('public.alertas_precios') IS NULL THEN
    RETURN NEW;
  END IF;

  v_norm_suc := COALESCE(
    public.normalizar_sucursal_multisede(NEW.sucursal),
    public.normalizar_sucursal_multisede(NEW.region),
    'OCCIDENTE'
  );

  SELECT c.umbral_caida_porcentaje, c.ventana_dias, c.activo
  INTO v_umbral, v_ventana, v_cfg_activo
  FROM public.configuracion_alertas_precios c
  WHERE UPPER(BTRIM(c.region)) IN (v_norm_suc, 'GLOBAL')
  ORDER BY CASE WHEN UPPER(BTRIM(c.region)) = v_norm_suc THEN 0 ELSE 1 END
  LIMIT 1;

  IF NOT COALESCE(v_cfg_activo, true) OR v_umbral IS NULL OR v_umbral <= 0 THEN
    RETURN NEW;
  END IF;

  FOR v_comp IN
    WITH from_json AS (
      SELECT
        BTRIM(elem->>'brand') AS brand,
        NULLIF(elem->>'priceUsd', '')::numeric(12, 4) AS curr_usd
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(NEW.competitors_meta) = 'array' THEN NEW.competitors_meta ELSE '[]'::jsonb END
      ) AS elem
      WHERE BTRIM(COALESCE(elem->>'brand', '')) <> ''
        AND NULLIF(elem->>'priceUsd', '')::numeric > 0
    ),
    from_cols AS (
      SELECT brand, curr_usd FROM (
        VALUES
          (
            BTRIM(COALESCE(NEW."competitor1Brand", NEW."competitorBrand", '')),
            COALESCE(NEW.precio_competencia_usd, ROUND(COALESCE(NEW."competitor1Price", NEW."competitorPrice")::numeric, 4))
          ),
          (BTRIM(COALESCE(NEW."competitor2Brand", '')), ROUND(NEW."competitor2Price"::numeric, 4)),
          (BTRIM(COALESCE(NEW."competitor3Brand", '')), ROUND(NEW."competitor3Price"::numeric, 4))
      ) AS t(brand, curr_usd)
      WHERE brand <> '' AND curr_usd IS NOT NULL AND curr_usd > 0
    )
    SELECT DISTINCT ON (UPPER(brand)) brand, curr_usd
    FROM (
      SELECT * FROM from_json
      UNION ALL
      SELECT * FROM from_cols WHERE NOT EXISTS (SELECT 1 FROM from_json)
    ) combined
  LOOP
    v_prev_id := NULL;
    v_prev_usd := NULL;

    SELECT prev_row.id, prev_row.prev_price_usd
    INTO v_prev_id, v_prev_usd
    FROM (
      SELECT
        p.id,
        p.created_at,
        COALESCE(
          (
            SELECT NULLIF(e->>'priceUsd', '')::numeric(12, 4)
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(p.competitors_meta) = 'array' THEN p.competitors_meta ELSE '[]'::jsonb END
            ) e
            WHERE UPPER(BTRIM(COALESCE(e->>'brand', ''))) = UPPER(v_comp.brand)
              AND NULLIF(e->>'priceUsd', '')::numeric > 0
            LIMIT 1
          ),
          CASE
            WHEN UPPER(BTRIM(COALESCE(p."competitor1Brand", p."competitorBrand", ''))) = UPPER(v_comp.brand)
            THEN COALESCE(p.precio_competencia_usd, ROUND(COALESCE(p."competitor1Price", p."competitorPrice")::numeric, 4))
            ELSE NULL
          END
        ) AS prev_price_usd
      FROM public.prices p
      WHERE p.id <> NEW.id
        AND p.created_at <= NEW.created_at
        AND p.created_at >= NEW.created_at - make_interval(days => v_ventana)
        AND LOWER(BTRIM(COALESCE(p."ourProduct", ''))) = LOWER(BTRIM(COALESCE(NEW."ourProduct", '')))
        AND COALESCE(public.normalizar_sucursal_multisede(p.sucursal), public.normalizar_sucursal_multisede(p.region), 'OCCIDENTE') = v_norm_suc
    ) prev_row
    WHERE prev_row.prev_price_usd IS NOT NULL AND prev_row.prev_price_usd > 0
    ORDER BY prev_row.created_at DESC
    LIMIT 1;

    IF v_prev_usd IS NOT NULL AND v_prev_usd > v_comp.curr_usd THEN
      v_drop_pct := ROUND((((v_prev_usd - v_comp.curr_usd) / v_prev_usd) * 100.0)::numeric, 2);
      IF v_drop_pct >= v_umbral THEN
        v_sev := CASE
          WHEN v_drop_pct >= GREATEST(v_umbral * 2, 25) THEN 'critica'
          WHEN v_drop_pct >= GREATEST(v_umbral * 1.5, 15) THEN 'alta'
          ELSE 'media'
        END;
        INSERT INTO public.alertas_precios (
          price_id, previous_price_id, region, cadena, zona, store,
          producto_propio, marca_competidor, precio_anterior_usd, precio_actual_usd,
          caida_porcentaje, umbral_aplicado, severidad, estado
        )
        VALUES (
          NEW.id, v_prev_id, v_norm_suc, NEW.cadena, NEW.zona, COALESCE(NEW.store, 'PDV'),
          COALESCE(NEW."ourProduct", 'Producto'), v_comp.brand, v_prev_usd, v_comp.curr_usd,
          v_drop_pct, v_umbral, v_sev, 'pendiente'
        )
        ON CONFLICT (price_id, marca_competidor) DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_detectar_alerta_caida_precio_competidor() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_prices_detectar_alerta_caida ON public.prices;
CREATE TRIGGER trg_prices_detectar_alerta_caida
  AFTER INSERT ON public.prices
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_detectar_alerta_caida_precio_competidor();

-- ------------------------------------------------------------------------------
-- 4. RPCs `SECURITY DEFINER` IDEMPOTENTES PARA ESCRITURAS CRÍTICAS DEL PORTAL
--    (Regla Obligatoria AGENTS.md: `SECURITY DEFINER` + `SET search_path = public`
--     + validación real de `auth.uid()` + `REVOKE ALL FROM PUBLIC, anon`)
-- ------------------------------------------------------------------------------

-- 4.1 Helper interno para resolver ficha de promotora autenticada y sucursal canónica
CREATE OR REPLACE FUNCTION public.fn_portal_resolve_caller_identity()
RETURNS TABLE (
  auth_uid UUID,
  caller_email TEXT,
  promotora_id TEXT,
  promotora_nombre TEXT,
  sucursal_canonica TEXT,
  region_display TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_email TEXT := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_prom_id TEXT := NULL;
  v_prom_nombre TEXT := NULL;
  v_prom_suc TEXT := NULL;
  v_prom_reg TEXT := NULL;
  v_suc_final TEXT := NULL;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Sesión autenticada requerida.' USING ERRCODE = '42501';
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT
      p.id::text,
      COALESCE(NULLIF(BTRIM(p.nombre), ''), v_email),
      public.normalizar_sucursal_multisede(COALESCE(NULLIF(BTRIM(p.sucursal), ''), NULLIF(BTRIM(p.region), ''))),
      NULLIF(BTRIM(p.region), '')
    INTO v_prom_id, v_prom_nombre, v_prom_suc, v_prom_reg
    FROM public.promotoras p
    WHERE COALESCE(p.activo, true) = true
      AND (
        p.auth_user_id = v_uid
        OR (v_email <> '' AND LOWER(BTRIM(COALESCE(NULLIF(p.correo, ''), NULLIF(p.email, ''), ''))) = v_email)
      )
    ORDER BY CASE WHEN p.auth_user_id = v_uid THEN 0 ELSE 1 END
    LIMIT 1;
  END IF;

  v_suc_final := COALESCE(
    v_prom_suc,
    public.obtener_mi_sucursal(),
    public.normalizar_sucursal_multisede(v_prom_reg),
    'OCCIDENTE'
  );
  IF v_suc_final NOT IN ('CENTRO', 'OCCIDENTE') THEN
    v_suc_final := 'OCCIDENTE';
  END IF;

  RETURN QUERY SELECT
    v_uid,
    v_email,
    COALESCE(v_prom_id, v_uid::text),
    COALESCE(v_prom_nombre, NULLIF(v_email, ''), 'Promotora'),
    v_suc_final,
    COALESCE(v_prom_reg, CASE WHEN v_suc_final = 'CENTRO' THEN 'Centro' ELSE 'Occidente' END);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_portal_resolve_caller_identity() FROM PUBLIC, anon, authenticated;

-- 4.2 RPC Idempotente: Inventario y Degustación (`/portal` -> `public.inventory`)
CREATE OR REPLACE FUNCTION public.rpc_registrar_inventario_portal(
  p_store TEXT,
  p_product TEXT,
  p_initial_quantity NUMERIC,
  p_sales_generated NUMERIC DEFAULT 0,
  p_degustations NUMERIC DEFAULT 0,
  p_comments TEXT DEFAULT '',
  p_zona TEXT DEFAULT '',
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL,
  p_cronograma_id UUID DEFAULT NULL,
  p_client_submission_id UUID DEFAULT NULL,
  p_date TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller RECORD;
  v_sucursal TEXT;
  v_region TEXT;
  v_final_qty NUMERIC;
  v_date TEXT;
  v_existing public.inventory%ROWTYPE;
  v_inserted public.inventory%ROWTYPE;
BEGIN
  SELECT * INTO v_caller FROM public.fn_portal_resolve_caller_identity();

  IF COALESCE(BTRIM(p_store), '') = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: El Punto de Venta (PDV) es obligatorio.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(BTRIM(p_product), '') = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: El producto SKU es obligatorio.' USING ERRCODE = '22023';
  END IF;
  IF p_initial_quantity IS NULL OR p_initial_quantity <= 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: El inventario inicial debe ser mayor a cero.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_sales_generated, 0) < 0 OR COALESCE(p_degustations, 0) < 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Las ventas y degustaciones no pueden ser negativas.' USING ERRCODE = '22023';
  END IF;

  v_final_qty := ROUND((p_initial_quantity - COALESCE(p_sales_generated, 0) - COALESCE(p_degustations, 0))::numeric, 2);
  IF v_final_qty < 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Ventas + degustaciones superan el inventario inicial.' USING ERRCODE = '22023';
  END IF;

  IF (SELECT public.es_admin_nacional()) THEN
    v_sucursal := COALESCE(
      public.normalizar_sucursal_multisede(p_sucursal),
      public.normalizar_sucursal_multisede(p_region),
      v_caller.sucursal_canonica
    );
  ELSE
    v_sucursal := v_caller.sucursal_canonica;
  END IF;

  v_region := CASE WHEN v_sucursal = 'CENTRO' THEN 'Centro' ELSE 'Occidente' END;
  v_date := COALESCE(NULLIF(BTRIM(p_date), ''), to_char(now() AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD"T"HH24:MI:SS-04:00'));

  IF p_client_submission_id IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.inventory
    WHERE client_submission_id = p_client_submission_id
    LIMIT 1;
    IF FOUND THEN
      RETURN to_jsonb(v_existing);
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.inventory (
      date, store, product, "initialQuantity", "finalQuantity",
      degustations, sales_generated, comments, "creatorId", promoter,
      promotora_id, auth_user_id, region, sucursal, zona, cronograma_id, client_submission_id
    )
    VALUES (
      v_date, BTRIM(p_store), BTRIM(p_product), ROUND(p_initial_quantity::numeric, 2), v_final_qty,
      ROUND(COALESCE(p_degustations, 0)::numeric, 2), ROUND(COALESCE(p_sales_generated, 0)::numeric, 2),
      LEFT(BTRIM(COALESCE(p_comments, '')), 600),
      COALESCE(NULLIF(v_caller.caller_email, ''), v_caller.promotora_nombre),
      v_caller.promotora_nombre,
      v_caller.promotora_id,
      v_caller.auth_uid,
      v_region,
      v_sucursal,
      COALESCE(NULLIF(BTRIM(p_zona), ''), v_region),
      p_cronograma_id,
      p_client_submission_id
    )
    RETURNING * INTO v_inserted;
    RETURN to_jsonb(v_inserted);
  EXCEPTION WHEN unique_violation THEN
    IF p_client_submission_id IS NOT NULL THEN
      SELECT * INTO v_existing
      FROM public.inventory
      WHERE client_submission_id = p_client_submission_id
      LIMIT 1;
      IF FOUND THEN
        RETURN to_jsonb(v_existing);
      END IF;
    END IF;
    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_registrar_inventario_portal(TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_inventario_portal(TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, UUID, UUID, TEXT) TO authenticated, service_role;

-- 4.3 RPC Idempotente: Encuestas al Consumidor y Merchandising (`/portal` -> `public.surveys`)
CREATE OR REPLACE FUNCTION public.rpc_registrar_encuesta_portal(
  p_type TEXT,
  p_date TEXT,
  p_store TEXT,
  p_product TEXT,
  p_rating NUMERIC DEFAULT NULL,
  p_intent TEXT DEFAULT NULL,
  p_comments TEXT DEFAULT '',
  p_region TEXT DEFAULT NULL,
  p_sucursal TEXT DEFAULT NULL,
  p_client_submission_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller RECORD;
  v_sucursal TEXT;
  v_region TEXT;
  v_clean_type TEXT;
  v_existing_id UUID;
  v_new_id UUID;
BEGIN
  SELECT * INTO v_caller FROM public.fn_portal_resolve_caller_identity();

  v_clean_type := COALESCE(NULLIF(BTRIM(p_type), ''), 'Profunda');
  IF v_clean_type NOT IN ('Profunda', 'Breve', 'Merchandising') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Tipo de encuesta no permitido (%).', v_clean_type USING ERRCODE = '22023';
  END IF;
  IF COALESCE(BTRIM(p_store), '') = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: El Punto de Venta (PDV) es obligatorio.' USING ERRCODE = '22023';
  END IF;

  IF (SELECT public.es_admin_nacional()) THEN
    v_sucursal := COALESCE(
      public.normalizar_sucursal_multisede(p_sucursal),
      public.normalizar_sucursal_multisede(p_region),
      v_caller.sucursal_canonica
    );
  ELSE
    v_sucursal := v_caller.sucursal_canonica;
  END IF;
  v_region := CASE WHEN v_sucursal = 'CENTRO' THEN 'Centro' ELSE 'Occidente' END;

  IF p_client_submission_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM public.surveys
    WHERE client_submission_id = p_client_submission_id
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_existing_id, 'sucursal', v_sucursal, 'region', v_region, 'idempotent_hit', true);
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.surveys (
      type, date, store, promoter, product, rating, intent, comments,
      "creatorId", promotora_id, auth_user_id, region, sucursal, client_submission_id
    )
    VALUES (
      v_clean_type,
      COALESCE(NULLIF(BTRIM(p_date), ''), to_char(now() AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD"T"HH24:MI:SS-04:00')),
      BTRIM(p_store),
      v_caller.promotora_nombre,
      COALESCE(NULLIF(BTRIM(p_product), ''), 'Línea General Codizulca'),
      p_rating,
      p_intent,
      COALESCE(p_comments, ''),
      COALESCE(NULLIF(v_caller.caller_email, ''), v_caller.promotora_nombre),
      v_caller.promotora_id,
      v_caller.auth_uid,
      v_region,
      v_sucursal,
      p_client_submission_id
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('id', v_new_id, 'sucursal', v_sucursal, 'region', v_region, 'idempotent_hit', false);
  EXCEPTION WHEN unique_violation THEN
    IF p_client_submission_id IS NOT NULL THEN
      SELECT id INTO v_existing_id
      FROM public.surveys
      WHERE client_submission_id = p_client_submission_id
      LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object('id', v_existing_id, 'sucursal', v_sucursal, 'region', v_region, 'idempotent_hit', true);
      END IF;
    END IF;
    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_registrar_encuesta_portal(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_encuesta_portal(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

-- 4.4 RPC Idempotente: Comparativa Bimonetaria de Precios (`/portal` -> `public.prices`)
CREATE OR REPLACE FUNCTION public.rpc_registrar_precio_portal(
  p_payload JSONB,
  p_client_submission_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller RECORD;
  v_sucursal TEXT;
  v_region TEXT;
  v_sub_id UUID;
  v_existing_id UUID;
  v_new_id UUID;
  v_store TEXT;
  v_product TEXT;
  v_our_price NUMERIC;
BEGIN
  SELECT * INTO v_caller FROM public.fn_portal_resolve_caller_identity();

  v_store := BTRIM(COALESCE(p_payload ->> 'store', ''));
  v_product := BTRIM(COALESCE(p_payload ->> 'ourProduct', ''));
  v_our_price := NULLIF(p_payload ->> 'ourPrice', '')::numeric;

  IF v_store = '' OR v_product = '' OR v_our_price IS NULL OR v_our_price <= 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: PDV, producto y precio propio mayor a cero son obligatorios.' USING ERRCODE = '22023';
  END IF;

  v_sub_id := COALESCE(p_client_submission_id, public.fn_try_uuid(p_payload ->> 'client_submission_id'));

  IF (SELECT public.es_admin_nacional()) THEN
    v_sucursal := COALESCE(
      public.normalizar_sucursal_multisede(p_payload ->> 'sucursal'),
      public.normalizar_sucursal_multisede(p_payload ->> 'region'),
      v_caller.sucursal_canonica
    );
  ELSE
    v_sucursal := v_caller.sucursal_canonica;
  END IF;
  v_region := CASE WHEN v_sucursal = 'CENTRO' THEN 'Centro' ELSE 'Occidente' END;

  IF v_sub_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM public.prices
    WHERE client_submission_id = v_sub_id
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_existing_id, 'sucursal', v_sucursal, 'region', v_region, 'idempotent_hit', true);
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.prices (
      date, store, cadena, zona, region, sucursal,
      "ourProduct", "ourPrice",
      "competitor1Brand", "competitor1Price",
      "competitor2Brand", "competitor2Price",
      "competitor3Brand", "competitor3Price",
      "competitorBrand", "competitorPrice",
      bcv_rate, photo_storage_path, comments,
      "creatorId", promoter, promotora_id, auth_user_id,
      moneda_propia, moneda_competencia, tasa_bcv_aplicada, tasa_bcv_fecha,
      precio_propio_usd, precio_competencia_usd, brecha_usd, brecha_porcentaje,
      competitors_meta, ocr_asistido, ocr_confianza, client_submission_id
    )
    VALUES (
      COALESCE(NULLIF(BTRIM(p_payload ->> 'date'), ''), to_char(now() AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD"T"HH24:MI:SS-04:00')),
      v_store,
      NULLIF(BTRIM(COALESCE(p_payload ->> 'cadena', '')), ''),
      NULLIF(BTRIM(COALESCE(p_payload ->> 'zona', '')), ''),
      v_region,
      v_sucursal,
      v_product,
      v_our_price,
      NULLIF(BTRIM(COALESCE(p_payload ->> 'competitor1Brand', '')), ''),
      NULLIF(p_payload ->> 'competitor1Price', '')::numeric,
      NULLIF(BTRIM(COALESCE(p_payload ->> 'competitor2Brand', '')), ''),
      NULLIF(p_payload ->> 'competitor2Price', '')::numeric,
      NULLIF(BTRIM(COALESCE(p_payload ->> 'competitor3Brand', '')), ''),
      NULLIF(p_payload ->> 'competitor3Price', '')::numeric,
      NULLIF(BTRIM(COALESCE(p_payload ->> 'competitorBrand', '')), ''),
      NULLIF(p_payload ->> 'competitorPrice', '')::numeric,
      NULLIF(p_payload ->> 'bcv_rate', '')::numeric,
      NULLIF(BTRIM(COALESCE(p_payload ->> 'photo_storage_path', '')), ''),
      LEFT(BTRIM(COALESCE(p_payload ->> 'comments', '')), 500),
      COALESCE(NULLIF(v_caller.caller_email, ''), v_caller.promotora_nombre),
      v_caller.promotora_nombre,
      v_caller.promotora_id,
      v_caller.auth_uid,
      CASE WHEN UPPER(COALESCE(p_payload ->> 'moneda_propia', 'USD')) = 'VES' THEN 'VES' ELSE 'USD' END,
      CASE WHEN UPPER(COALESCE(p_payload ->> 'moneda_competencia', 'USD')) = 'VES' THEN 'VES' ELSE 'USD' END,
      NULLIF(p_payload ->> 'tasa_bcv_aplicada', '')::numeric,
      NULLIF(p_payload ->> 'tasa_bcv_fecha', '')::date,
      NULLIF(p_payload ->> 'precio_propio_usd', '')::numeric,
      NULLIF(p_payload ->> 'precio_competencia_usd', '')::numeric,
      NULLIF(p_payload ->> 'brecha_usd', '')::numeric,
      NULLIF(p_payload ->> 'brecha_porcentaje', '')::numeric,
      CASE WHEN jsonb_typeof(p_payload -> 'competitors_meta') = 'array' THEN p_payload -> 'competitors_meta' ELSE '[]'::jsonb END,
      COALESCE((p_payload ->> 'ocr_asistido')::boolean, false),
      CASE WHEN (p_payload ->> 'ocr_confianza') IN ('alta', 'media', 'baja') THEN p_payload ->> 'ocr_confianza' ELSE NULL END,
      v_sub_id
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('id', v_new_id, 'sucursal', v_sucursal, 'region', v_region, 'idempotent_hit', false);
  EXCEPTION WHEN unique_violation THEN
    IF v_sub_id IS NOT NULL THEN
      SELECT id INTO v_existing_id
      FROM public.prices
      WHERE client_submission_id = v_sub_id
      LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object('id', v_existing_id, 'sucursal', v_sucursal, 'region', v_region, 'idempotent_hit', true);
      END IF;
    END IF;
    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_registrar_precio_portal(JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_precio_portal(JSONB, UUID) TO authenticated, service_role;

-- 4.5 RPC Idempotente: Check-in / Check-out de Ruta + Ejecución en PDV + Geocerca
CREATE OR REPLACE FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller RECORD;
  v_ruta_id UUID;
  v_accion TEXT;
  v_sub_id TEXT;
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_acc DOUBLE PRECISION;
  v_motivo TEXT;
  v_exec JSONB;
  v_ruta RECORD;
  v_sucursal TEXT;
  v_radio INTEGER := 250;
  v_dist DOUBLE PRECISION := NULL;
  v_dentro BOOLEAN := NULL;
  v_alerta_creada BOOLEAN := false;
  v_muestras INTEGER := 0;
  v_ventas INTEGER := 0;
  v_abiertas NUMERIC(10, 2) := 0;
  v_lote TEXT := '';
  v_venc DATE := NULL;
  v_obs TEXT := '';
BEGIN
  SELECT * INTO v_caller FROM public.fn_portal_resolve_caller_identity();

  v_ruta_id := public.fn_try_uuid(p_payload ->> 'ruta_id');
  v_accion := UPPER(BTRIM(COALESCE(p_payload ->> 'accion', '')));
  v_sub_id := NULLIF(BTRIM(COALESCE(p_payload ->> 'client_submission_id', '')), '');
  v_lat := NULLIF(p_payload ->> 'lat', '')::double precision;
  v_lng := NULLIF(p_payload ->> 'lng', '')::double precision;
  v_acc := NULLIF(p_payload ->> 'accuracy_m', '')::double precision;
  v_motivo := LEFT(BTRIM(COALESCE(p_payload ->> 'motivo_fuera_geocerca', '')), 400);
  v_exec := CASE WHEN jsonb_typeof(p_payload -> 'ejecucion') = 'object' THEN p_payload -> 'ejecucion' ELSE NULL END;

  IF v_ruta_id IS NULL OR v_accion NOT IN ('CHECKIN', 'CHECKOUT') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: ruta_id válido y accion (CHECKIN|CHECKOUT) son obligatorios.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ruta
  FROM public.rutas_promotoras
  WHERE id = v_ruta_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: La degustación solicitada no existe.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (SELECT public.es_admin_nacional())
     AND COALESCE(v_ruta.auth_user_id, '00000000-0000-0000-0000-000000000000'::uuid) <> v_caller.auth_uid
     AND COALESCE(v_ruta.promotora_id::text, '') <> v_caller.promotora_id
     AND LOWER(BTRIM(COALESCE(v_ruta.promotora_email, ''))) <> v_caller.caller_email THEN
    RAISE EXCEPTION 'FORBIDDEN: No tienes permiso para modificar esta ruta.' USING ERRCODE = '42501';
  END IF;

  v_sucursal := COALESCE(
    public.normalizar_sucursal_multisede(v_ruta.sucursal),
    v_caller.sucursal_canonica,
    'OCCIDENTE'
  );
  v_radio := COALESCE(v_ruta.pdv_radio_geocerca_m, 250);

  IF v_lat IS NOT NULL AND v_lng IS NOT NULL
     AND v_ruta.pdv_lat_referencia IS NOT NULL AND v_ruta.pdv_lng_referencia IS NOT NULL
     AND to_regprocedure('public.fn_haversine_metros(double precision,double precision,double precision,double precision)') IS NOT NULL THEN
    v_dist := public.fn_haversine_metros(v_lat, v_lng, v_ruta.pdv_lat_referencia, v_ruta.pdv_lng_referencia);
    v_dentro := (v_dist IS NOT NULL AND v_dist <= v_radio);
  END IF;

  IF v_accion = 'CHECKIN' THEN
    UPDATE public.rutas_promotoras
    SET
      estado_ruta = CASE WHEN estado_ruta = 'COMPLETADA' THEN 'COMPLETADA' ELSE 'EN_CURSO' END,
      checkin_at = COALESCE(checkin_at, now()),
      checkin_lat = COALESCE(v_lat, checkin_lat),
      checkin_lng = COALESCE(v_lng, checkin_lng),
      checkin_accuracy_m = COALESCE(v_acc, checkin_accuracy_m),
      checkin_distancia_m = COALESCE(v_dist, checkin_distancia_m),
      checkin_dentro_geocerca = COALESCE(v_dentro, checkin_dentro_geocerca),
      sucursal = v_sucursal,
      updated_at = now()
    WHERE id = v_ruta_id
    RETURNING * INTO v_ruta;
  ELSE
    IF v_exec IS NOT NULL THEN
      v_lote := LEFT(BTRIM(COALESCE(v_exec ->> 'lote_producto', '')), 120);
      v_venc := NULLIF(BTRIM(COALESCE(v_exec ->> 'fecha_vencimiento', '')), '')::date;
      v_abiertas := GREATEST(0, COALESCE(NULLIF(v_exec ->> 'unidades_abiertas', '')::numeric, 0));
      v_muestras := GREATEST(0, COALESCE(NULLIF(v_exec ->> 'muestras_entregadas', '')::integer, 0));
      v_ventas := GREATEST(0, COALESCE(NULLIF(v_exec ->> 'ventas_asistidas_unidades', '')::integer, 0));
      v_obs := LEFT(BTRIM(COALESCE(v_exec ->> 'observaciones', '')), 600);
    END IF;

    UPDATE public.rutas_promotoras
    SET
      estado_ruta = 'COMPLETADA',
      checkin_at = COALESCE(checkin_at, now()),
      checkout_at = COALESCE(checkout_at, now()),
      checkout_lat = COALESCE(v_lat, checkout_lat),
      checkout_lng = COALESCE(v_lng, checkout_lng),
      checkout_accuracy_m = COALESCE(v_acc, checkout_accuracy_m),
      checkout_distancia_m = COALESCE(v_dist, checkout_distancia_m),
      checkout_dentro_geocerca = COALESCE(v_dentro, checkout_dentro_geocerca),
      muestras_entregadas = GREATEST(COALESCE(muestras_entregadas, 0), v_muestras),
      unidades_vendidas = GREATEST(COALESCE(unidades_vendidas, 0), v_ventas),
      notas_campo = CASE WHEN v_obs <> '' THEN v_obs ELSE notas_campo END,
      sucursal = v_sucursal,
      updated_at = now()
    WHERE id = v_ruta_id
    RETURNING * INTO v_ruta;

    IF v_exec IS NOT NULL AND to_regclass('public.ejecuciones_pdv_promotora') IS NOT NULL THEN
      INSERT INTO public.ejecuciones_pdv_promotora (
        ruta_id, cronograma_id, promotora_id, auth_user_id, cliente_nombre, fecha,
        lote_producto, fecha_vencimiento, unidades_abiertas, muestras_entregadas,
        ventas_asistidas_unidades, observaciones, client_submission_id, sucursal
      )
      VALUES (
        v_ruta_id, v_ruta.cronograma_id, v_caller.promotora_id, v_caller.auth_uid,
        COALESCE(v_ruta.cliente_nombre, 'PDV'), COALESCE(v_ruta.fecha, (now() AT TIME ZONE 'America/Caracas')::date),
        v_lote, v_venc, v_abiertas, v_muestras, v_ventas, v_obs,
        COALESCE(v_sub_id, v_ruta_id::text || ':CHECKOUT'),
        v_sucursal
      )
      ON CONFLICT (ruta_id) DO UPDATE
        SET lote_producto = EXCLUDED.lote_producto,
            fecha_vencimiento = EXCLUDED.fecha_vencimiento,
            unidades_abiertas = EXCLUDED.unidades_abiertas,
            muestras_entregadas = EXCLUDED.muestras_entregadas,
            ventas_asistidas_unidades = EXCLUDED.ventas_asistidas_unidades,
            observaciones = EXCLUDED.observaciones,
            updated_at = now();
    END IF;
  END IF;

  IF v_dentro IS FALSE AND v_lat IS NOT NULL AND v_lng IS NOT NULL
     AND v_ruta.pdv_lat_referencia IS NOT NULL AND v_ruta.pdv_lng_referencia IS NOT NULL
     AND to_regclass('public.alertas_geocerca_auditoria') IS NOT NULL THEN
    INSERT INTO public.alertas_geocerca_auditoria (
      ruta_id, promotora_id, auth_user_id, promotora_nombre, cliente_nombre,
      accion, lat_capturada, lng_capturada, pdv_lat, pdv_lng,
      distancia_m, radio_permitido_m, motivo, client_submission_id, sucursal
    )
    VALUES (
      v_ruta_id, v_caller.promotora_id, v_caller.auth_uid, v_caller.promotora_nombre,
      COALESCE(v_ruta.cliente_nombre, 'PDV'), v_accion, v_lat, v_lng,
      v_ruta.pdv_lat_referencia, v_ruta.pdv_lng_referencia,
      v_dist, v_radio, v_motivo, v_sub_id, v_sucursal
    )
    ON CONFLICT (client_submission_id) DO NOTHING;
    v_alerta_creada := true;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'ruta', to_jsonb(v_ruta),
    'distancia_m', v_dist,
    'radio_geocerca_m', v_radio,
    'dentro_geocerca', v_dentro,
    'alerta_geocerca_registrada', v_alerta_creada
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_ejecucion_ruta_promotora(JSONB) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 5. PUBLICACIÓN SUPABASE REALTIME PARA MÓDULO 1 -> INFORMES Y RECARGA POSTGREST
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'inventory',
    'prices',
    'surveys',
    'asistencias_jornada',
    'asistencia_evidencias',
    'rutas_promotoras',
    'cronograma_degustaciones',
    'incidencias_pdv',
    'ejecuciones_pdv_promotora',
    'alertas_precios'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
       AND NOT EXISTS (
         SELECT 1
         FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public'
           AND tablename = tbl
       ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
    END IF;
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
