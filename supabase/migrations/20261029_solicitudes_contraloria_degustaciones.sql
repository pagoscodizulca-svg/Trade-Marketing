-- =============================================================================
-- CODIZULCA C.A. - FLUJO DE SOLICITUD Y APROBACIÓN DE PRODUCTOS (DEGUSTACIONES)
-- Emisor: Módulo Trade Marketing ("Solicitudes a Contraloría - Degustaciones")
-- Receptor: Módulo Contraloría Interna ("Bandeja de Entrada")
-- Formato Corporativo: SOLICITUD DE PRODUCTOS (Correlativo MP-07-XXXX)
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.solicitudes_contraloria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_correlativo TEXT NOT NULL UNIQUE,
  fecha_solicitud TEXT NOT NULL,
  fecha_iso TEXT NOT NULL,
  dirigido_a TEXT NOT NULL DEFAULT 'CONTRALORÍA',
  para_ser_utilizado TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_unidades NUMERIC NOT NULL DEFAULT 0,
  observacion TEXT NOT NULL DEFAULT '',
  solicitado_por TEXT NOT NULL,
  firma_digital_texto TEXT DEFAULT NULL,
  firma_digital_imagen TEXT DEFAULT NULL,
  departamento_solicitante TEXT NOT NULL DEFAULT 'MERCADEO Y PUBLICIDAD',
  estado TEXT NOT NULL DEFAULT 'PENDIENTE_APROBACION'
    CHECK (estado IN ('PENDIENTE_APROBACION', 'APROBADA', 'RECHAZADA')),
  nota_contraloria TEXT DEFAULT NULL,
  resuelto_por TEXT DEFAULT NULL,
  resuelto_at TIMESTAMPTZ DEFAULT NULL,
  leido_contraloria BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_contraloria_estado_created
  ON public.solicitudes_contraloria (estado, created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_solicitudes_contraloria_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solicitudes_contraloria_updated_at ON public.solicitudes_contraloria;

CREATE TRIGGER trg_solicitudes_contraloria_updated_at
  BEFORE UPDATE ON public.solicitudes_contraloria
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_solicitudes_contraloria_updated_at();

-- Habilitar fila completa para eventos UPDATE/INSERT en Supabase Realtime
ALTER TABLE public.solicitudes_contraloria REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'solicitudes_contraloria'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.solicitudes_contraloria;
  END IF;
END $$;

-- Permisos y políticas RLS para Trade Marketing y Contraloría Interna
GRANT SELECT, INSERT, UPDATE ON TABLE public.solicitudes_contraloria TO anon, authenticated;

ALTER TABLE public.solicitudes_contraloria ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'solicitudes_contraloria'
      AND policyname = 'solicitudes_contraloria_select_policy'
  ) THEN
    CREATE POLICY solicitudes_contraloria_select_policy
      ON public.solicitudes_contraloria
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'solicitudes_contraloria'
      AND policyname = 'solicitudes_contraloria_insert_policy'
  ) THEN
    CREATE POLICY solicitudes_contraloria_insert_policy
      ON public.solicitudes_contraloria
      FOR INSERT
      TO anon, authenticated
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'solicitudes_contraloria'
      AND policyname = 'solicitudes_contraloria_update_policy'
  ) THEN
    CREATE POLICY solicitudes_contraloria_update_policy
      ON public.solicitudes_contraloria
      FOR UPDATE
      TO anon, authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

COMMIT;
