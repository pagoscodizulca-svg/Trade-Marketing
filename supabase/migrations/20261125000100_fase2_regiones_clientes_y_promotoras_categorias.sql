-- =============================================================================
-- FASE 2 (2/4) — ÍNDICES DE SINCRONIZACIÓN REGIONAL ("Regiones"), BÚSQUEDA
-- NORMALIZADA DE RAZONES SOCIALES (", C.A.") Y DIVISIÓN OBLIGATORIA DE
-- PROMOTORAS EN `Fijas` / `Eventuales` / `Merchandising`
--
-- Archivo:   supabase/migrations/20261125000100_fase2_regiones_clientes_y_promotoras_categorias.sql
-- Destino:   https://apaxdgxtaoeyswlfblgi.supabase.co (PostgreSQL 15+ / 17)
--
-- Garantías de Seguridad e Idempotencia:
--   1. 100 % idempotente y no destructivo (sin borrado de tablas ni filas).
--   2. CERO secretos ni UUIDs hardcodeados (`id_regi` siempre se resuelve
--      dinámicamente desde `public."Regiones"` por `regi_desd`).
--   3. Normaliza de forma segura cualquier registro legacy de `public.promotoras`
--      y `public.staff` ANTES de aplicar constraints `CHECK`.
--   4. Verifica existencia de tablas/columnas opcionales antes de crear índices
--      compuestos o RPCs, evitando fallos 42703 en esquemas remotos heterogéneos.
--   5. Búsqueda comercial parametrizada mediante RPC `SECURITY INVOKER`
--      (preserva al 100 % el aislamiento Row Level Security del usuario activo).
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. NORMALIZACIÓN Y CLASIFICACIÓN OBLIGATORIA DE PROMOTORAS
--    Categorías únicas permitidas: 'Fijas' | 'Eventuales' | 'Merchandising'
-- =============================================================================

ALTER TABLE public.promotoras
  ADD COLUMN IF NOT EXISTS categoria TEXT;

-- Normalizar filas existentes antes de aplicar NOT NULL y CHECK (sin pérdida de datos)
DO $$
DECLARE
  v_has_tipo BOOLEAN;
  v_has_rol BOOLEAN;
  v_has_role BOOLEAN;
  v_has_metadata BOOLEAN;
  v_expr TEXT := 'COALESCE(categoria, '''')';
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'promotoras' AND column_name = 'tipo'
  ) INTO v_has_tipo;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'promotoras' AND column_name = 'rol'
  ) INTO v_has_rol;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'promotoras' AND column_name = 'role'
  ) INTO v_has_role;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'promotoras' AND column_name = 'metadata'
  ) INTO v_has_metadata;

  IF v_has_tipo THEN
    v_expr := v_expr || ' || '' '' || COALESCE(tipo::text, '''')';
  END IF;
  IF v_has_rol THEN
    v_expr := v_expr || ' || '' '' || COALESCE(rol::text, '''')';
  END IF;
  IF v_has_role THEN
    v_expr := v_expr || ' || '' '' || COALESCE(role::text, '''')';
  END IF;
  IF v_has_metadata THEN
    v_expr := v_expr || ' || '' '' || COALESCE(metadata::text, '''')';
  END IF;

  EXECUTE format(
    $upd$
      UPDATE public.promotoras
      SET categoria = CASE
        WHEN lower(translate(%s, 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) ~ '(merchandising|mercaderista|mercadeo|anaquel|gondola)'
          THEN 'Merchandising'
        WHEN lower(translate(%s, 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) ~ '(eventual|temporal|suplente|apoyo|freelance)'
          THEN 'Eventuales'
        ELSE 'Fijas'
      END
      WHERE categoria IS NULL
         OR categoria NOT IN ('Fijas', 'Eventuales', 'Merchandising')
    $upd$,
    v_expr,
    v_expr
  );
END $$;

ALTER TABLE public.promotoras
  ALTER COLUMN categoria SET DEFAULT 'Fijas';

ALTER TABLE public.promotoras
  ALTER COLUMN categoria SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_promotoras_categoria_oficial'
      AND conrelid = 'public.promotoras'::regclass
  ) THEN
    ALTER TABLE public.promotoras
      ADD CONSTRAINT chk_promotoras_categoria_oficial
      CHECK (categoria IN ('Fijas', 'Eventuales', 'Merchandising'));
  END IF;
END $$;

COMMENT ON COLUMN public.promotoras.categoria IS
  'Clasificación obligatoria de la promotora: Fijas, Eventuales o Merchandising.';

CREATE INDEX IF NOT EXISTS idx_promotoras_categoria
  ON public.promotoras (categoria);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'promotoras'
      AND column_name IN ('region_id', 'categoria', 'activo')
    GROUP BY table_name HAVING count(*) = 3
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_promotoras_region_categoria_activo ON public.promotoras (region_id, categoria, activo)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'promotoras'
      AND column_name IN ('sucursal', 'categoria', 'activo')
    GROUP BY table_name HAVING count(*) = 3
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_promotoras_sucursal_categoria_activo ON public.promotoras (sucursal, categoria, activo)';
  END IF;
END $$;

-- =============================================================================
-- 2. ESPEJO ADITIVO DE CATEGORÍA EN `public.staff` (SI EXISTE LA TABLA)
-- =============================================================================

DO $$
DECLARE
  v_has_role BOOLEAN;
  v_has_status BOOLEAN;
  v_has_sucursal BOOLEAN;
  v_expr TEXT := 'COALESCE(categoria, '''')';
BEGIN
  IF to_regclass('public.staff') IS NOT NULL THEN
    ALTER TABLE public.staff
      ADD COLUMN IF NOT EXISTS categoria TEXT;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'role'
    ) INTO v_has_role;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'status'
    ) INTO v_has_status;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'sucursal'
    ) INTO v_has_sucursal;

    IF v_has_role THEN
      v_expr := v_expr || ' || '' '' || COALESCE(role::text, '''')';
    END IF;
    IF v_has_status THEN
      v_expr := v_expr || ' || '' '' || COALESCE(status::text, '''')';
    END IF;

    EXECUTE format(
      $upd$
        UPDATE public.staff
        SET categoria = CASE
          WHEN lower(translate(%s, 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) ~ '(merchandising|mercaderista|mercadeo|anaquel|gondola)'
            THEN 'Merchandising'
          WHEN lower(translate(%s, 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) ~ '(eventual|temporal|suplente|apoyo|freelance)'
            THEN 'Eventuales'
          ELSE 'Fijas'
        END
        WHERE categoria IS NULL
           OR categoria NOT IN ('Fijas', 'Eventuales', 'Merchandising')
      $upd$,
      v_expr,
      v_expr
    );

    ALTER TABLE public.staff
      ALTER COLUMN categoria SET DEFAULT 'Fijas';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'chk_staff_categoria_oficial'
        AND conrelid = 'public.staff'::regclass
    ) THEN
      ALTER TABLE public.staff
        ADD CONSTRAINT chk_staff_categoria_oficial
        CHECK (categoria IS NULL OR categoria IN ('Fijas', 'Eventuales', 'Merchandising'));
    END IF;

    IF v_has_sucursal THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_staff_sucursal_categoria ON public.staff (sucursal, categoria)';
    ELSE
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_staff_categoria ON public.staff (categoria)';
    END IF;
  ELSE
    RAISE NOTICE 'Tabla public.staff no existe en esta instancia; espejo de categoría omitido de forma segura.';
  END IF;
END $$;

-- =============================================================================
-- 3. FUNCIÓN DE NORMALIZACIÓN COMERCIAL (", C.A." / "CA"), ÍNDICES Y RPC EN `public.clientes`
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_normalizar_razon_social_busqueda(p_texto TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT regexp_replace(
    upper(
      translate(
        COALESCE(p_texto, ''),
        'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜáéíóúàèìòùäëïöü',
        'AEIOUAEIOUAEIOUaeiouaeiouaeiou'
      )
    ),
    '[^A-Z0-9Ñ]+',
    '',
    'g'
  );
$$;

REVOKE ALL ON FUNCTION public.fn_normalizar_razon_social_busqueda(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_normalizar_razon_social_busqueda(TEXT) TO authenticated, service_role;

DO $$
DECLARE
  v_has_full_clientes_schema BOOLEAN;
BEGIN
  IF to_regclass('public.clientes') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clientes'
        AND column_name IN ('region_id', 'codigo_cliente', 'activo')
      GROUP BY table_name HAVING count(*) = 3
    ) THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_clientes_region_codigo_activo ON public.clientes (region_id, codigo_cliente) WHERE activo = true';
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clientes'
        AND column_name IN ('region_id', 'razon_social')
      GROUP BY table_name HAVING count(*) = 2
    ) THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_clientes_region_razon_social ON public.clientes (region_id, razon_social)';
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clientes'
        AND column_name IN ('codigo_cliente', 'razon_social', 'nombre_comercial', 'rif', 'activo', 'region_id')
      GROUP BY table_name HAVING count(*) = 6
    ) INTO v_has_full_clientes_schema;

    IF v_has_full_clientes_schema THEN
      EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.rpc_buscar_clientes_maestros(
          p_busqueda TEXT,
          p_region_id UUID DEFAULT NULL,
          p_solo_activos BOOLEAN DEFAULT TRUE,
          p_limite INTEGER DEFAULT 200,
          p_offset INTEGER DEFAULT 0
        )
        RETURNS SETOF public.clientes
        LANGUAGE sql
        STABLE
        SECURITY INVOKER
        SET search_path = public
        AS $body$
          WITH term AS (
            SELECT
              btrim(COALESCE(p_busqueda, '')) AS raw_q,
              public.fn_normalizar_razon_social_busqueda(p_busqueda) AS compact_q,
              GREATEST(1, LEAST(COALESCE(p_limite, 200), 1000)) AS safe_limit,
              GREATEST(0, COALESCE(p_offset, 0)) AS safe_offset
          )
          SELECT c.*
          FROM public.clientes c
          CROSS JOIN term t
          WHERE (NOT COALESCE(p_solo_activos, TRUE) OR c.activo = TRUE)
            AND (p_region_id IS NULL OR c.region_id = p_region_id)
            AND (
              t.raw_q = ''
              OR c.razon_social ILIKE '%' || replace(replace(replace(t.raw_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
              OR COALESCE(c.nombre_comercial, '') ILIKE '%' || replace(replace(replace(t.raw_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
              OR c.codigo_cliente ILIKE '%' || replace(replace(replace(t.raw_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
              OR COALESCE(c.rif, '') ILIKE '%' || replace(replace(replace(t.raw_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
              OR (
                length(t.compact_q) >= 2
                AND (
                  public.fn_normalizar_razon_social_busqueda(c.razon_social) LIKE '%' || t.compact_q || '%'
                  OR public.fn_normalizar_razon_social_busqueda(COALESCE(c.nombre_comercial, '')) LIKE '%' || t.compact_q || '%'
                )
              )
            )
          ORDER BY c.razon_social ASC
          LIMIT (SELECT safe_limit FROM term)
          OFFSET (SELECT safe_offset FROM term);
        $body$;
      $fn$;

      REVOKE ALL ON FUNCTION public.rpc_buscar_clientes_maestros(TEXT, UUID, BOOLEAN, INTEGER, INTEGER) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.rpc_buscar_clientes_maestros(TEXT, UUID, BOOLEAN, INTEGER, INTEGER) TO authenticated, service_role;
    ELSE
      RAISE NOTICE 'public.clientes no contiene aún las 6 columnas estándar (codigo_cliente, razon_social, nombre_comercial, rif, activo, region_id); creación de rpc_buscar_clientes_maestros omitida de forma segura.';
    END IF;
  ELSE
    RAISE NOTICE 'Tabla public.clientes no existe en esta instancia; índices y RPC omitidos de forma segura.';
  END IF;
END $$;

-- =============================================================================
-- 4. ÍNDICE DE RESOLUCIÓN RÁPIDA Y VERIFICACIÓN RLS EN `public."Regiones"`
--    Estructura real en https://apaxdgxtaoeyswlfblgi.supabase.co:
--      id_regi (uuid PK), created_at (timestamptz),
--      regi_desd (text: 'OCCIDENTE' | 'CENTRO' | 'ANDES'), regi_saba (boolean)
-- =============================================================================

DO $$
DECLARE
  v_has_regi_desd BOOLEAN;
  v_has_id_regi BOOLEAN;
BEGIN
  IF to_regclass('public."Regiones"') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Regiones' AND column_name = 'regi_desd'
    ) INTO v_has_regi_desd;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Regiones' AND column_name = 'id_regi'
    ) INTO v_has_id_regi;

    IF v_has_regi_desd THEN
      EXECUTE $idx$
        CREATE INDEX IF NOT EXISTS idx_regiones_ext_desd_norm
          ON public."Regiones" (upper(btrim(COALESCE(regi_desd, ''))))
      $idx$;
    END IF;

    REVOKE ALL ON TABLE public."Regiones" FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public."Regiones" TO authenticated;
    GRANT ALL ON TABLE public."Regiones" TO service_role;

    ALTER TABLE public."Regiones" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public."Regiones" FORCE ROW LEVEL SECURITY;

    IF v_has_id_regi THEN
      RAISE NOTICE 'Catálogo public."Regiones" (id_regi, regi_desd, regi_saba) verificado con índice normalizado y RLS activo.';
    END IF;
  ELSE
    RAISE NOTICE 'public."Regiones" no existe en este entorno efímero; índice externo omitido de forma segura.';
  END IF;
END $$;

COMMIT;
