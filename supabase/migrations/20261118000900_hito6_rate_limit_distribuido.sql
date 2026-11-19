-- =============================================================================
-- HITO 6 — LIMITADOR DE TASA DISTRIBUIDO RESPALDADO EN POSTGRESQL (P-04 / S-02)
--
-- Archivo: supabase/migrations/20261118000900_hito6_rate_limit_distribuido.sql
--
-- Reemplaza el limitador en memoria (no válido con varias instancias) por contadores
-- de ventana fija en PostgreSQL. Solo el servidor (`service_role`) puede invocarlo:
-- ni `anon` ni `authenticated` tienen acceso a la tabla ni a la RPC.
--
-- Reglas: forward-only e idempotente, sin DDL destructivo.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  bucket_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  PRIMARY KEY (bucket_key, window_start),
  CONSTRAINT chk_api_rate_limits_key_len CHECK (length(bucket_key) BETWEEN 1 AND 300)
);

CREATE INDEX IF NOT EXISTS idx_api_rate_limits_window_start
  ON public.api_rate_limits (window_start);

REVOKE ALL ON TABLE public.api_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_rate_limits TO service_role;

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_rate_limits FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.rpc_rate_limit_hit(
  p_key TEXT,
  p_window_seconds INTEGER,
  p_max_requests INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  IF p_key IS NULL OR length(p_key) = 0 OR length(p_key) > 300
     OR p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 3600
     OR p_max_requests IS NULL OR p_max_requests < 1 OR p_max_requests > 100000 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_PARAMS' USING ERRCODE = '22023';
  END IF;

  v_window_start := to_timestamp(
    floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO public.api_rate_limits AS rl (bucket_key, window_start, hit_count)
  VALUES (p_key, v_window_start, 1)
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET hit_count = rl.hit_count + 1
  RETURNING hit_count INTO v_count;

  -- Limpieza oportunista de ventanas antiguas (~1 % de las llamadas)
  IF random() < 0.01 THEN
    DELETE FROM public.api_rate_limits
    WHERE window_start < now() - interval '1 day';
  END IF;

  RETURN jsonb_build_object(
    'allowed', v_count <= p_max_requests,
    'count', v_count,
    'remaining', GREATEST(0, p_max_requests - v_count),
    'reset_at', v_window_start + make_interval(secs => p_window_seconds)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_rate_limit_hit(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_rate_limit_hit(TEXT, INTEGER, INTEGER) TO service_role;

COMMIT;
