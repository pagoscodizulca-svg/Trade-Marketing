-- =============================================================================
-- TAREA 1: Esquema Relacional Definitivo de Maestros (Vendedores y Clientes)
-- Archivo: supabase/migrations/01_schema_maestros.sql
-- Proyecto: Trade Marketing (PostgreSQL 17 / Supabase)
-- Reglas:
--   1. Script 100 % idempotente (IF NOT EXISTS / bloques DO seguros).
--   2. Cero borrado físico masivo (ON DELETE SET NULL + bandera lógica activo).
--   3. Claves de negocio normalizadas en mayúsculas y sin espacios laterales.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Tabla Maestra: public.vendedores
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendedores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_vendedor TEXT NOT NULL UNIQUE,
  nombre_completo TEXT NOT NULL,
  documento_identidad TEXT,
  telefono TEXT,
  email TEXT,
  zona TEXT,
  supervisor TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ultima_sincronizacion TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_vendedores_codigo_normalizado
    CHECK (codigo_vendedor = UPPER(BTRIM(codigo_vendedor)) AND LENGTH(codigo_vendedor) > 0),
  CONSTRAINT chk_vendedores_nombre_no_vacio
    CHECK (LENGTH(BTRIM(nombre_completo)) > 0)
);

COMMENT ON TABLE public.vendedores IS
  'Fuente Única de Verdad (Master Data) de la Fuerza de Ventas de Trade Marketing.';
COMMENT ON COLUMN public.vendedores.codigo_vendedor IS
  'Código único del vendedor normalizado en MAYÚSCULAS y sin espacios laterales.';

-- -----------------------------------------------------------------------------
-- 2. Tabla Maestra: public.clientes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_cliente TEXT NOT NULL UNIQUE,
  rif TEXT,
  razon_social TEXT NOT NULL,
  nombre_comercial TEXT,
  canal TEXT,
  segmento TEXT,
  zona TEXT,
  ruta TEXT,
  direccion TEXT,
  ciudad TEXT,
  estado TEXT,
  telefono TEXT,
  latitud NUMERIC(10,7),
  longitud NUMERIC(10,7),
  vendedor_id UUID REFERENCES public.vendedores(id) ON DELETE SET NULL,
  codigo_vendedor TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ultima_sincronizacion TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_clientes_codigo_normalizado
    CHECK (codigo_cliente = UPPER(BTRIM(codigo_cliente)) AND LENGTH(codigo_cliente) > 0),
  CONSTRAINT chk_clientes_razon_social_no_vacia
    CHECK (LENGTH(BTRIM(razon_social)) > 0)
);

COMMENT ON TABLE public.clientes IS
  'Fuente Única de Verdad (Master Data) de Clientes / Puntos de Venta de Trade Marketing.';
COMMENT ON COLUMN public.clientes.codigo_cliente IS
  'Clave definitiva del negocio para el cliente, normalizada en MAYÚSCULAS.';
COMMENT ON COLUMN public.clientes.rif IS
  'RIF fiscal normalizado (no único para soportar múltiples sucursales bajo una misma razón social).';

-- -----------------------------------------------------------------------------
-- 3. Tabla de Auditoría: public.lotes_sincronizacion
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lotes_sincronizacion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ejecutado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  entidad TEXT NOT NULL CHECK (entidad IN ('vendedores', 'clientes', 'sincronizacion_completa')),
  nombre_archivo TEXT,
  registros_recibidos INTEGER NOT NULL DEFAULT 0,
  registros_procesados INTEGER NOT NULL DEFAULT 0,
  registros_desactivados INTEGER NOT NULL DEFAULT 0,
  errores_detalle JSONB NOT NULL DEFAULT '[]'::jsonb,
  estado TEXT NOT NULL CHECK (estado IN ('en_proceso', 'completado', 'con_observaciones', 'fallido')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.lotes_sincronizacion IS
  'Bitácora inmutable de ejecuciones de carga y reconciliación masiva de Data Maestra.';

-- -----------------------------------------------------------------------------
-- 4. Índices de Búsqueda, Filtros Operativos y Llaves Foráneas
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_vendedores_activo
  ON public.vendedores(activo);

CREATE INDEX IF NOT EXISTS idx_clientes_vendedor_id
  ON public.clientes(vendedor_id);

CREATE INDEX IF NOT EXISTS idx_clientes_codigo_vendedor
  ON public.clientes(codigo_vendedor);

CREATE INDEX IF NOT EXISTS idx_clientes_zona_ruta
  ON public.clientes(zona, ruta);

CREATE INDEX IF NOT EXISTS idx_clientes_activo
  ON public.clientes(activo);

CREATE INDEX IF NOT EXISTS idx_clientes_rif
  ON public.clientes(rif);

CREATE INDEX IF NOT EXISTS idx_lotes_sincronizacion_ejecutado_por
  ON public.lotes_sincronizacion(ejecutado_por);

CREATE INDEX IF NOT EXISTS idx_lotes_sincronizacion_created_at
  ON public.lotes_sincronizacion(created_at DESC);

-- -----------------------------------------------------------------------------
-- 5. Función y Triggers Automáticos para updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_maestros_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'vendedores'
      AND t.tgname = 'trg_vendedores_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_vendedores_set_updated_at
      BEFORE UPDATE ON public.vendedores
      FOR EACH ROW
      EXECUTE FUNCTION public.tg_maestros_set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'clientes'
      AND t.tgname = 'trg_clientes_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_clientes_set_updated_at
      BEFORE UPDATE ON public.clientes
      FOR EACH ROW
      EXECUTE FUNCTION public.tg_maestros_set_updated_at();
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. Catálogos Preexistentes Reconciliados (Compuerta G1 — No-op seguro en Prod)
--    Garantiza reconstrucción limpia desde cero (`supabase db reset --local`)
--    reutilizando sin duplicación las tablas ya existentes en producción:
--      * public.regiones (5 hubs oficiales: Zulia, Valencia, Centro, Oriente, Capital)
--      * public.supervisores
--      * public.productos
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.regiones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE,
  nombre TEXT NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.regiones IS
  'Catálogo oficial de los 5 hubs regionales corporativos (Zulia, Valencia, Centro, Oriente, Capital).';

CREATE TABLE IF NOT EXISTS public.supervisores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE,
  nombre TEXT NOT NULL,
  email TEXT,
  telefono TEXT,
  zona TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.supervisores IS
  'Catálogo maestro de supervisores comerciales (reutiliza tabla existente en producción si ya fue creada).';

CREATE TABLE IF NOT EXISTS public.productos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE,
  nombre TEXT NOT NULL,
  categoria TEXT,
  marca TEXT,
  unidad_medida TEXT DEFAULT 'KG',
  activo BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.productos IS
  'Catálogo maestro de productos de Trade Marketing (reutiliza tabla existente en producción si ya fue creada).';

ALTER TABLE public.regiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supervisores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.regiones FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.supervisores FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.productos FROM PUBLIC, anon;

GRANT SELECT ON TABLE public.regiones TO authenticated;
GRANT SELECT ON TABLE public.supervisores TO authenticated;
GRANT SELECT ON TABLE public.productos TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'regiones'
      AND policyname = 'regiones_select_authenticated'
  ) THEN
    CREATE POLICY regiones_select_authenticated
      ON public.regiones
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'supervisores'
      AND policyname = 'supervisores_select_authenticated'
  ) THEN
    CREATE POLICY supervisores_select_authenticated
      ON public.supervisores
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'productos'
      AND policyname = 'productos_select_authenticated'
  ) THEN
    CREATE POLICY productos_select_authenticated
      ON public.productos
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regiones'
      AND column_name = 'codigo'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regiones'
      AND column_name = 'nombre'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regiones'
      AND column_name = 'activo'
  ) THEN
    INSERT INTO public.regiones (codigo, nombre, activo) VALUES
      ('ZULIA', 'Zulia', true),
      ('VALENCIA', 'Valencia', true),
      ('CENTRO', 'Centro', true),
      ('ORIENTE', 'Oriente', true),
      ('CAPITAL', 'Capital', true)
    ON CONFLICT DO NOTHING;
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regiones'
      AND column_name = 'codigo'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regiones'
      AND column_name = 'nombre'
  ) THEN
    INSERT INTO public.regiones (codigo, nombre) VALUES
      ('ZULIA', 'Zulia'),
      ('VALENCIA', 'Valencia'),
      ('CENTRO', 'Centro'),
      ('ORIENTE', 'Oriente'),
      ('CAPITAL', 'Capital')
    ON CONFLICT DO NOTHING;
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regiones'
      AND column_name = 'nombre'
  ) THEN
    INSERT INTO public.regiones (nombre) VALUES
      ('Zulia'),
      ('Valencia'),
      ('Centro'),
      ('Oriente'),
      ('Capital')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
