-- ==============================================================================
-- MIGRACIÓN ADITIVA E IDEMPOTENTE:
--   Comparativa de Precios Avanzada (BCV Bimonetario + IA OCR + Alertas > X%)
--
-- Proyecto objetivo: Trade Marketing CODIZULCA (`apaxdgxtaoeyswlfblgi.supabase.co`)
-- Reglas de seguridad innegociables:
--   1. 100% ADITIVA E IDEMPOTENTE (sin DROP TABLE, DROP COLUMN, TRUNCATE ni DELETE).
--   2. CERO DISABLE ROW LEVEL SECURITY y CERO acceso `anon`.
--   3. CERO referencias a `user_metadata` ni a `auth.role()` deprecado.
--   4. Aislamiento Multi-Región estricto mediante `public.can_access_region(region)`
--      y `public.is_global_admin()` (Grecia: OCCIDENTE; María: CENTRO y ANDES).
--   5. Vista de compatibilidad `public.comparativa_precios` con `security_invoker = true`.
-- ==============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.can_access_region(text)') IS NULL
     OR to_regprocedure('public.is_global_admin()') IS NULL THEN
    RAISE EXCEPTION
      'Prerrequisito faltante: ejecuta primero sql/rls_multiregion_centro_andes.sql antes de aplicar esta migración.';
  END IF;
END
$$;

-- ==============================================================================
-- 1. TABLA OFICIAL DIARIA DE TASA BCV (`public.tasas_bcv`)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.tasas_bcv (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha DATE NOT NULL UNIQUE,
  tasa_usd_ves NUMERIC(12, 4) NOT NULL CHECK (tasa_usd_ves > 0),
  fuente TEXT NOT NULL DEFAULT 'BCV_OFICIAL'
    CHECK (fuente IN ('BCV_OFICIAL', 'MANUAL_ADMIN', 'RESPALDO')),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasas_bcv_fecha_desc
  ON public.tasas_bcv (fecha DESC);

REVOKE ALL ON TABLE public.tasas_bcv FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tasas_bcv TO authenticated, service_role;
ALTER TABLE public.tasas_bcv ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasas_bcv_select_authenticated ON public.tasas_bcv;
DROP POLICY IF EXISTS tasas_bcv_insert_global_admin ON public.tasas_bcv;
DROP POLICY IF EXISTS tasas_bcv_update_global_admin ON public.tasas_bcv;
DROP POLICY IF EXISTS tasas_bcv_delete_global_admin ON public.tasas_bcv;

CREATE POLICY tasas_bcv_select_authenticated
  ON public.tasas_bcv
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

CREATE POLICY tasas_bcv_insert_global_admin
  ON public.tasas_bcv
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_global_admin()));

CREATE POLICY tasas_bcv_update_global_admin
  ON public.tasas_bcv
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_global_admin()))
  WITH CHECK ((SELECT public.is_global_admin()));

CREATE POLICY tasas_bcv_delete_global_admin
  ON public.tasas_bcv
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_global_admin()));

-- ==============================================================================
-- 2. EXTENSIÓN ADITIVA DE `public.prices` (INMUTABILIDAD BIMONETARIA + OCR + CADENA/ZONA)
--    Los montos originales se conservan intactos en `ourPrice` y `competitor*Price`.
-- ==============================================================================
ALTER TABLE public.prices
  ADD COLUMN IF NOT EXISTS cadena TEXT,
  ADD COLUMN IF NOT EXISTS zona TEXT,
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
  ADD COLUMN IF NOT EXISTS ocr_confianza TEXT;

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

-- Backfill seguro e idempotente únicamente para registros históricos previos sin columnas USD pobladas
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

CREATE INDEX IF NOT EXISTS idx_prices_cadena_zona_created_at
  ON public.prices (cadena, zona, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prices_product_region_created_at
  ON public.prices (LOWER(BTRIM(COALESCE("ourProduct", ''))), UPPER(BTRIM(COALESCE(region, ''))), created_at DESC);

-- Vista de compatibilidad de solo lectura con `security_invoker = true` (respeta 100% RLS de `public.prices`)
CREATE OR REPLACE VIEW public.comparativa_precios
WITH (security_invoker = true) AS
SELECT
  id,
  date,
  store,
  cadena,
  zona,
  region,
  "ourProduct" AS producto_propio,
  "ourPrice" AS precio_propio,
  moneda_propia,
  COALESCE("competitor1Brand", "competitorBrand") AS marca_competencia,
  COALESCE("competitor1Price", "competitorPrice") AS precio_competencia,
  moneda_competencia,
  tasa_bcv_aplicada,
  tasa_bcv_fecha,
  precio_propio_usd,
  precio_competencia_usd,
  brecha_usd,
  brecha_porcentaje,
  competitors_meta,
  ocr_asistido,
  ocr_confianza,
  photo_storage_path,
  comments,
  promoter,
  promotora_id,
  auth_user_id,
  created_at
FROM public.prices;

DO $$
BEGIN
  IF to_regclass('public.comparativa_precios') IS NOT NULL THEN
    REVOKE ALL ON public.comparativa_precios FROM PUBLIC, anon;
    GRANT SELECT ON public.comparativa_precios TO authenticated, service_role;
  END IF;
END
$$;

-- ==============================================================================
-- 3. CONFIGURACIÓN DE UMBRALES DE ALERTAS (`public.configuracion_alertas_precios`)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.configuracion_alertas_precios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region TEXT NOT NULL UNIQUE,
  umbral_caida_porcentaje NUMERIC(5, 2) NOT NULL DEFAULT 10.00
    CHECK (umbral_caida_porcentaje > 0 AND umbral_caida_porcentaje <= 95),
  ventana_dias INTEGER NOT NULL DEFAULT 30
    CHECK (ventana_dias BETWEEN 1 AND 365),
  activo BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.configuracion_alertas_precios (region, umbral_caida_porcentaje, ventana_dias, activo)
VALUES ('GLOBAL', 10.00, 30, true)
ON CONFLICT (region) DO NOTHING;

REVOKE ALL ON TABLE public.configuracion_alertas_precios FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.configuracion_alertas_precios TO authenticated, service_role;
ALTER TABLE public.configuracion_alertas_precios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cfg_alertas_precios_select_auth ON public.configuracion_alertas_precios;
DROP POLICY IF EXISTS cfg_alertas_precios_insert_admin_coord ON public.configuracion_alertas_precios;
DROP POLICY IF EXISTS cfg_alertas_precios_update_admin_coord ON public.configuracion_alertas_precios;

CREATE POLICY cfg_alertas_precios_select_auth
  ON public.configuracion_alertas_precios
  FOR SELECT
  TO authenticated
  USING (
    (SELECT auth.uid()) IS NOT NULL
    AND (
      (SELECT public.is_global_admin())
      OR UPPER(BTRIM(region)) = 'GLOBAL'
      OR public.can_access_region(region)
    )
  );

CREATE POLICY cfg_alertas_precios_insert_admin_coord
  ON public.configuracion_alertas_precios
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_global_admin())
    OR (
      (SELECT public.fn_trade_is_regional_coordinator())
      AND UPPER(BTRIM(region)) <> 'GLOBAL'
      AND public.can_access_region(region)
    )
  );

CREATE POLICY cfg_alertas_precios_update_admin_coord
  ON public.configuracion_alertas_precios
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_global_admin())
    OR (
      (SELECT public.fn_trade_is_regional_coordinator())
      AND UPPER(BTRIM(region)) <> 'GLOBAL'
      AND public.can_access_region(region)
    )
  )
  WITH CHECK (
    (SELECT public.is_global_admin())
    OR (
      (SELECT public.fn_trade_is_regional_coordinator())
      AND UPPER(BTRIM(region)) <> 'GLOBAL'
      AND public.can_access_region(region)
    )
  );

-- ==============================================================================
-- 4. ALERTAS AUTOMÁTICAS DE CAÍDA DE PRECIO DE COMPETIDORES (`public.alertas_precios`)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.alertas_precios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_id UUID NOT NULL REFERENCES public.prices(id) ON DELETE CASCADE,
  previous_price_id UUID REFERENCES public.prices(id) ON DELETE SET NULL,
  region TEXT NOT NULL,
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
);

CREATE INDEX IF NOT EXISTS idx_alertas_precios_region_estado_created
  ON public.alertas_precios (UPPER(BTRIM(region)), estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alertas_precios_price_id
  ON public.alertas_precios (price_id);

REVOKE ALL ON TABLE public.alertas_precios FROM PUBLIC, anon;
GRANT SELECT, UPDATE, DELETE ON TABLE public.alertas_precios TO authenticated, service_role;
GRANT INSERT ON TABLE public.alertas_precios TO service_role;
ALTER TABLE public.alertas_precios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alertas_precios_select_scoped ON public.alertas_precios;
DROP POLICY IF EXISTS alertas_precios_update_scoped ON public.alertas_precios;
DROP POLICY IF EXISTS alertas_precios_delete_admin ON public.alertas_precios;
DROP POLICY IF EXISTS alertas_precios_restrict_multiregion ON public.alertas_precios;

CREATE POLICY alertas_precios_select_scoped
  ON public.alertas_precios
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_global_admin())
    OR (
      (SELECT public.fn_trade_is_regional_coordinator())
      AND public.can_access_region(region)
    )
  );

CREATE POLICY alertas_precios_update_scoped
  ON public.alertas_precios
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_global_admin())
    OR (
      (SELECT public.fn_trade_is_regional_coordinator())
      AND public.can_access_region(region)
    )
  )
  WITH CHECK (
    (SELECT public.is_global_admin())
    OR (
      (SELECT public.fn_trade_is_regional_coordinator())
      AND public.can_access_region(region)
    )
  );

CREATE POLICY alertas_precios_delete_admin
  ON public.alertas_precios
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_global_admin()));

CREATE POLICY alertas_precios_restrict_multiregion
  ON public.alertas_precios
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    (SELECT public.is_global_admin())
    OR public.can_access_region(region)
  )
  WITH CHECK (
    (SELECT public.is_global_admin())
    OR public.can_access_region(region)
  );

-- ==============================================================================
-- 5. TRIGGER ATÓMICO DE DETECCIÓN DE CAÍDAS DE PRECIO DE COMPETIDORES (> X%)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.fn_detectar_alerta_caida_precio_competidor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm_region TEXT;
  v_umbral NUMERIC(5, 2) := 10.00;
  v_ventana INTEGER := 30;
  v_cfg_activo BOOLEAN := true;
  v_comp RECORD;
  v_prev_id UUID;
  v_prev_usd NUMERIC(12, 4);
  v_drop_pct NUMERIC(8, 2);
  v_sev TEXT;
BEGIN
  v_norm_region := COALESCE(public.fn_trade_normalize_region_token(NEW.region), UPPER(BTRIM(COALESCE(NEW.region, 'OCCIDENTE'))));

  -- Resolver umbral vigente: primero región específica, luego GLOBAL
  SELECT c.umbral_caida_porcentaje, c.ventana_dias, c.activo
  INTO v_umbral, v_ventana, v_cfg_activo
  FROM public.configuracion_alertas_precios c
  WHERE UPPER(BTRIM(c.region)) IN (v_norm_region, 'GLOBAL')
  ORDER BY CASE WHEN UPPER(BTRIM(c.region)) = v_norm_region THEN 0 ELSE 1 END
  LIMIT 1;

  IF NOT COALESCE(v_cfg_activo, true) OR v_umbral IS NULL OR v_umbral <= 0 THEN
    RETURN NEW;
  END IF;

  -- Iterar competidores normalizados a USD desde `competitors_meta` o columnas clásicas
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
            COALESCE(
              NEW.precio_competencia_usd,
              CASE
                WHEN NEW.moneda_competencia = 'VES' AND NEW.tasa_bcv_aplicada IS NOT NULL AND NEW.tasa_bcv_aplicada > 0
                THEN ROUND((COALESCE(NEW."competitor1Price", NEW."competitorPrice") / NEW.tasa_bcv_aplicada)::numeric, 4)
                ELSE ROUND(COALESCE(NEW."competitor1Price", NEW."competitorPrice")::numeric, 4)
              END
            )
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

    -- Buscar el precio USD más reciente del mismo producto + marca competidora en la misma región dentro de ventana_dias
    SELECT
      prev_row.id,
      prev_row.prev_price_usd
    INTO v_prev_id, v_prev_usd
    FROM (
      SELECT
        p.id,
        p.created_at,
        CASE
          WHEN LOWER(BTRIM(COALESCE(p.store, ''))) = LOWER(BTRIM(COALESCE(NEW.store, ''))) THEN 0
          WHEN p.cadena IS NOT NULL AND NEW.cadena IS NOT NULL AND LOWER(BTRIM(p.cadena)) = LOWER(BTRIM(NEW.cadena)) THEN 1
          ELSE 2
        END AS match_rank,
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
            WHEN UPPER(BTRIM(COALESCE(p."competitor2Brand", ''))) = UPPER(v_comp.brand)
            THEN ROUND(p."competitor2Price"::numeric, 4)
            WHEN UPPER(BTRIM(COALESCE(p."competitor3Brand", ''))) = UPPER(v_comp.brand)
            THEN ROUND(p."competitor3Price"::numeric, 4)
            ELSE NULL
          END
        ) AS prev_price_usd
      FROM public.prices p
      WHERE p.id <> NEW.id
        AND p.created_at <= NEW.created_at
        AND p.created_at >= NEW.created_at - make_interval(days => v_ventana)
        AND LOWER(BTRIM(COALESCE(p."ourProduct", ''))) = LOWER(BTRIM(COALESCE(NEW."ourProduct", '')))
        AND COALESCE(public.fn_trade_normalize_region_token(p.region), UPPER(BTRIM(COALESCE(p.region, '')))) = v_norm_region
    ) prev_row
    WHERE prev_row.prev_price_usd IS NOT NULL
      AND prev_row.prev_price_usd > 0
    ORDER BY prev_row.match_rank ASC, prev_row.created_at DESC
    LIMIT 1;

    IF v_prev_usd IS NOT NULL AND v_prev_usd > v_comp.curr_usd THEN
      v_drop_pct := ROUND((((v_prev_usd - v_comp.curr_usd) / v_prev_usd) * 100.0)::numeric, 2);

      IF v_drop_pct >= v_umbral THEN
        IF v_drop_pct >= GREATEST(v_umbral * 2, 25) THEN
          v_sev := 'critica';
        ELSIF v_drop_pct >= GREATEST(v_umbral * 1.5, 15) THEN
          v_sev := 'alta';
        ELSE
          v_sev := 'media';
        END IF;

        INSERT INTO public.alertas_precios (
          price_id,
          previous_price_id,
          region,
          cadena,
          zona,
          store,
          producto_propio,
          marca_competidor,
          precio_anterior_usd,
          precio_actual_usd,
          caida_porcentaje,
          umbral_aplicado,
          severidad,
          estado
        )
        VALUES (
          NEW.id,
          v_prev_id,
          COALESCE(NEW.region, v_norm_region),
          NEW.cadena,
          NEW.zona,
          COALESCE(NEW.store, 'PDV'),
          COALESCE(NEW."ourProduct", 'Producto'),
          v_comp.brand,
          v_prev_usd,
          v_comp.curr_usd,
          v_drop_pct,
          v_umbral,
          v_sev,
          'pendiente'
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

-- ==============================================================================
-- 6. VERIFICACIÓN POST-MIGRACIÓN (SOLO LECTURA)
-- ==============================================================================
SELECT tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('tasas_bcv', 'configuracion_alertas_precios', 'alertas_precios', 'prices')
ORDER BY tablename, policyname;

SELECT region, umbral_caida_porcentaje, ventana_dias, activo
FROM public.configuracion_alertas_precios
ORDER BY region;
