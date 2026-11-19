-- =============================================================================
-- v1.9.0 — OFFLINE-FIRST (IDEMPOTENCIA), ENLACES DINÁMICOS FIRMADOS POR JORNADA
-- Y ALERTAS AUTOMÁTICAS FDV -> TRADE MARKETING (WHATSAPP CLOUD API + WEB PUSH)
--
-- Archivo: supabase/migrations/20261121000100_v190_offline_shift_links_and_alerts_outbox.sql
-- Motor objetivo: PostgreSQL 15+ / 17 (Supabase)
--
-- Garantías de Seguridad y Gobernanza:
--   1. Transaccional y 100 % idempotente (`IF NOT EXISTS`, cero `DROP TABLE`,
--      cero `DROP COLUMN`, cero `TRUNCATE` sobre tablas productivas).
--   2. `public.sesiones_jornada` almacena exclusivamente `token_hash` (SHA-256
--      en hexadecimal, único e indexado), jamás tokens en texto plano.
--   3. Aislamiento territorial estricto sobre las 5 regiones activas (Zulia,
--      Valencia, Centro, Oriente, Capital) mediante `RLS + FORCE RLS` y RPCs
--      acotadas por `region_id`, `sucursal`, `ruta_codigo`, `revoked_at IS NULL`
--      y `expires_at > now()` en UTC.
--   4. Idempotencia offline y prevención de ataques de repetición (replay)
--      mediante `client_mutation_id UUID UNIQUE` en tablas operativas y libro
--      inmutable `public.offline_mutation_receipts`.
--   5. Trigger `AFTER INSERT` sobre degustaciones protegido con `EXCEPTION WHEN
--      OTHERS` para encolar alertas sin bloquear jamás el guardado del vendedor.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. ENRUTAMIENTO REGIONAL DE ALERTAS WHATSAPP EN `public.regiones` (ADITIVO)
-- =============================================================================
ALTER TABLE public.regiones
  ADD COLUMN IF NOT EXISTS whatsapp_responsable_telefono TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_responsable_nombre TEXT;

COMMENT ON COLUMN public.regiones.whatsapp_responsable_telefono IS
  'Teléfono E.164 (sin +, ej. 584141234567) del responsable regional para alertas automáticas WhatsApp Cloud API.';
COMMENT ON COLUMN public.regiones.whatsapp_responsable_nombre IS
  'Nombre visible del responsable regional que recibe alertas de nuevas degustaciones FDV.';

-- =============================================================================
-- 2. TABLA `public.sesiones_jornada` (ENLACES DINÁMICOS FIRMADOS POR JORNADA)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.sesiones_jornada (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  rol TEXT NOT NULL CHECK (rol IN ('promotora', 'chofer')),
  personal_id UUID NULL,
  personal_nombre TEXT NOT NULL DEFAULT '',
  region_id UUID NOT NULL REFERENCES public.regiones(id) ON DELETE RESTRICT,
  sucursal public.sucursal_codigo NOT NULL,
  ruta_codigo TEXT NOT NULL CHECK (length(btrim(ruta_codigo)) >= 1 AND length(btrim(ruta_codigo)) <= 120),
  duracion_horas SMALLINT NOT NULL DEFAULT 12 CHECK (duracion_horas IN (8, 12, 24)),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_sesiones_jornada_token_hash_sha256
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_sesiones_jornada_sucursal_operativa
    CHECK (sucursal <> 'GLOBAL'::public.sucursal_codigo),
  CONSTRAINT chk_sesiones_jornada_expira_futuro
    CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.sesiones_jornada IS
  'Sesiones efímeras de enlaces dinámicos firmados para Promotoras (/portal) y Choferes (/logistica). Almacena únicamente SHA-256 del token.';

CREATE INDEX IF NOT EXISTS idx_sesiones_jornada_region_activas
  ON public.sesiones_jornada (region_id, rol, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sesiones_jornada_sucursal_activas
  ON public.sesiones_jornada (sucursal, rol, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sesiones_jornada_created_by
  ON public.sesiones_jornada (created_by, created_at DESC);

DROP TRIGGER IF EXISTS trg_v190_sellar_sucursal_sesiones_jornada ON public.sesiones_jornada;
CREATE TRIGGER trg_v190_sellar_sucursal_sesiones_jornada
  BEFORE INSERT OR UPDATE ON public.sesiones_jornada
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sellar_y_proteger_sucursal_operativa();

REVOKE ALL ON TABLE public.sesiones_jornada FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sesiones_jornada TO authenticated;
GRANT ALL ON TABLE public.sesiones_jornada TO service_role;

ALTER TABLE public.sesiones_jornada ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sesiones_jornada FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sesiones_jornada_select_coord_region ON public.sesiones_jornada;
CREATE POLICY sesiones_jornada_select_coord_region
  ON public.sesiones_jornada
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_region(region_id, sucursal))
  );

DROP POLICY IF EXISTS sesiones_jornada_insert_coord_region ON public.sesiones_jornada;
CREATE POLICY sesiones_jornada_insert_coord_region
  ON public.sesiones_jornada
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_coordinadora_or_admin())
    AND (SELECT public.tiene_acceso_region(region_id, sucursal))
    AND created_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS sesiones_jornada_update_coord_region ON public.sesiones_jornada;
CREATE POLICY sesiones_jornada_update_coord_region
  ON public.sesiones_jornada
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

-- =============================================================================
-- 3. IDEMPOTENCIA OFFLINE (`client_mutation_id UUID UNIQUE` + RECIBOS ANTI-REPLAY)
-- =============================================================================
ALTER TABLE public.ejecuciones_pdv_promotora
  ADD COLUMN IF NOT EXISTS client_mutation_id UUID UNIQUE;

ALTER TABLE public.incidencias_pdv
  ADD COLUMN IF NOT EXISTS client_mutation_id UUID UNIQUE;

ALTER TABLE public.rutas_promotoras
  ADD COLUMN IF NOT EXISTS client_mutation_id UUID UNIQUE;

ALTER TABLE public.entregas_degustacion
  ADD COLUMN IF NOT EXISTS client_mutation_id UUID UNIQUE;

ALTER TABLE public.reportes_trade
  ADD COLUMN IF NOT EXISTS client_mutation_id UUID UNIQUE;

CREATE TABLE IF NOT EXISTS public.offline_mutation_receipts (
  client_mutation_id UUID PRIMARY KEY,
  entidad TEXT NOT NULL CHECK (length(btrim(entidad)) >= 2 AND length(btrim(entidad)) <= 80),
  registro_id TEXT NOT NULL,
  sesion_jornada_id UUID NULL REFERENCES public.sesiones_jornada(id) ON DELETE SET NULL,
  actor_uid UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  region_id UUID NULL REFERENCES public.regiones(id) ON DELETE SET NULL,
  sucursal public.sucursal_codigo NULL,
  payload_sha256 TEXT NULL CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.offline_mutation_receipts IS
  'Registro inmutable de idempotencia anti-replay para mutaciones offline sincronizadas desde IndexedDB.';

CREATE INDEX IF NOT EXISTS idx_offline_receipts_sesion
  ON public.offline_mutation_receipts (sesion_jornada_id, created_at DESC)
  WHERE sesion_jornada_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offline_receipts_region
  ON public.offline_mutation_receipts (region_id, created_at DESC);

REVOKE ALL ON TABLE public.offline_mutation_receipts FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.offline_mutation_receipts TO authenticated;
GRANT ALL ON TABLE public.offline_mutation_receipts TO service_role;

ALTER TABLE public.offline_mutation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offline_mutation_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offline_receipts_select_coord_region ON public.offline_mutation_receipts;
CREATE POLICY offline_receipts_select_coord_region
  ON public.offline_mutation_receipts
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_coordinadora_or_admin())
    AND (
      sucursal IS NULL
      OR (SELECT public.tiene_acceso_region(region_id, sucursal))
    )
  );

-- =============================================================================
-- 4. RPCs SEGURAS DE VALIDACIÓN, BOOTSTRAP ACOTADO Y SYNC OFFLINE POR JORNADA
--    Ejecución restringida exclusivamente a `service_role` tras verificar firma
--    HMAC-SHA256 en servidor (`SHIFT_LINK_SECRET`).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_validar_sesion_jornada(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_hash TEXT := lower(btrim(COALESCE(p_token_hash, '')));
  v_ses public.sesiones_jornada;
  v_reg_nombre TEXT := '';
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_clean_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('valid', false, 'code', 'INVALID_TOKEN_HASH');
  END IF;

  SELECT *
  INTO v_ses
  FROM public.sesiones_jornada
  WHERE token_hash = v_clean_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'code', 'SESSION_NOT_FOUND');
  END IF;

  IF v_ses.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'valid', false,
      'code', 'SESSION_REVOKED',
      'revoked_at', v_ses.revoked_at
    );
  END IF;

  IF v_ses.expires_at <= v_now THEN
    RETURN jsonb_build_object(
      'valid', false,
      'code', 'SESSION_EXPIRED',
      'expires_at', v_ses.expires_at
    );
  END IF;

  UPDATE public.sesiones_jornada
  SET last_used_at = v_now
  WHERE id = v_ses.id;

  SELECT COALESCE(r.nombre, v_ses.sucursal::text)
  INTO v_reg_nombre
  FROM public.regiones r
  WHERE r.id = v_ses.region_id;

  RETURN jsonb_build_object(
    'valid', true,
    'session', jsonb_build_object(
      'id', v_ses.id,
      'rol', v_ses.rol,
      'personal_id', v_ses.personal_id,
      'personal_nombre', v_ses.personal_nombre,
      'region_id', v_ses.region_id,
      'region_nombre', COALESCE(v_reg_nombre, v_ses.sucursal::text),
      'sucursal', v_ses.sucursal::text,
      'ruta_codigo', v_ses.ruta_codigo,
      'duracion_horas', v_ses.duracion_horas,
      'expires_at', v_ses.expires_at,
      'last_used_at', v_now
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_validar_sesion_jornada(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_validar_sesion_jornada(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.rpc_bootstrap_sesion_jornada(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_validation JSONB;
  v_ses JSONB;
  v_rol TEXT;
  v_region_id UUID;
  v_sucursal public.sucursal_codigo;
  v_ruta_codigo TEXT;
  v_personal_id UUID;
  v_today_ve DATE := (now() AT TIME ZONE 'America/Caracas')::date;
  v_is_all_routes BOOLEAN := false;
  v_rutas JSONB := '[]'::jsonb;
  v_entregas JSONB := '[]'::jsonb;
  v_clientes JSONB := '[]'::jsonb;
  v_productos JSONB := '[]'::jsonb;
BEGIN
  v_validation := public.rpc_validar_sesion_jornada(p_token_hash);
  IF COALESCE((v_validation ->> 'valid')::boolean, false) IS NOT TRUE THEN
    RETURN v_validation;
  END IF;

  v_ses := v_validation -> 'session';
  v_rol := v_ses ->> 'rol';
  v_region_id := (v_ses ->> 'region_id')::uuid;
  v_sucursal := (v_ses ->> 'sucursal')::public.sucursal_codigo;
  v_ruta_codigo := upper(btrim(COALESCE(v_ses ->> 'ruta_codigo', '')));
  v_personal_id := NULLIF(btrim(COALESCE(v_ses ->> 'personal_id', '')), '')::uuid;
  v_is_all_routes := v_ruta_codigo IN ('TODAS', 'JORNADA_GENERAL', 'GENERAL', 'ALL');

  -- Clientes acotados estrictamente a la región de la sesión (con geocercas)
  SELECT COALESCE(jsonb_agg(to_jsonb(c_row) ORDER BY c_row.nombre_comercial ASC), '[]'::jsonb)
  INTO v_clientes
  FROM (
    SELECT
      c.id,
      c.codigo_cliente,
      COALESCE(NULLIF(btrim(c.nombre_comercial), ''), c.razon_social) AS nombre_comercial,
      c.direccion,
      c.ciudad,
      c.zona,
      c.ruta,
      c.latitud,
      c.longitud,
      COALESCE(c.radio_geocerca_m, 150) AS radio_geocerca_m
    FROM public.clientes c
    WHERE c.activo = true
      AND (c.region_id = v_region_id OR (c.region_id IS NULL AND c.sucursal = v_sucursal))
      AND (
        v_is_all_routes
        OR NULLIF(btrim(COALESCE(c.ruta, '')), '') IS NULL
        OR upper(btrim(c.ruta)) = v_ruta_codigo
        OR upper(btrim(COALESCE(c.zona, ''))) = v_ruta_codigo
      )
    LIMIT 500
  ) AS c_row;

  -- Productos activos de Trade Marketing
  SELECT COALESCE(jsonb_agg(to_jsonb(p_row) ORDER BY p_row.nombre ASC), '[]'::jsonb)
  INTO v_productos
  FROM (
    SELECT p.id, p.codigo, p.nombre, p.categoria, p.marca, p.unidad_medida
    FROM public.productos p
    WHERE p.activo = true
    LIMIT 500
  ) AS p_row;

  IF v_rol = 'promotora' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(r_row) ORDER BY r_row.fecha ASC, r_row.hora_inicio ASC), '[]'::jsonb)
    INTO v_rutas
    FROM (
      SELECT rp.*
      FROM public.rutas_promotoras rp
      WHERE rp.estado_ruta IN ('ASIGNADA', 'EN_CURSO', 'COMPLETADA')
        AND rp.fecha >= v_today_ve
        AND (rp.region_id = v_region_id OR (rp.region_id IS NULL AND rp.sucursal = v_sucursal))
        AND (v_personal_id IS NULL OR rp.promotora_id = v_personal_id)
        AND (
          v_is_all_routes
          OR upper(btrim(COALESCE(rp.zona_direccion, ''))) = v_ruta_codigo
          OR upper(btrim(COALESCE(rp.cliente_codigo, ''))) = v_ruta_codigo
          OR upper(btrim(COALESCE(rp.zona_direccion, ''))) LIKE '%' || v_ruta_codigo || '%'
        )
      ORDER BY rp.fecha ASC, rp.hora_inicio ASC
      LIMIT 250
    ) AS r_row;
  ELSIF v_rol = 'chofer' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(e_row) ORDER BY e_row.fecha ASC, e_row.turno ASC, e_row.id ASC), '[]'::jsonb)
    INTO v_entregas
    FROM (
      SELECT ed.*
      FROM public.entregas_degustacion ed
      WHERE (ed.region_id = v_region_id OR (ed.region_id IS NULL AND ed.sucursal = v_sucursal))
        AND (
          v_is_all_routes
          OR upper(btrim(COALESCE(ed.numero_grupo_turno, ''))) = v_ruta_codigo
          OR upper(btrim(COALESCE(ed.turno, ''))) = v_ruta_codigo
          OR upper(btrim(COALESCE(ed.cliente, ''))) LIKE '%' || v_ruta_codigo || '%'
        )
      ORDER BY ed.created_at ASC, ed.id ASC
      LIMIT 400
    ) AS e_row;
  END IF;

  RETURN jsonb_build_object(
    'valid', true,
    'session', v_ses,
    'rutas', v_rutas,
    'entregas', v_entregas,
    'clientes', v_clientes,
    'productos', v_productos,
    'synced_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_bootstrap_sesion_jornada(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_bootstrap_sesion_jornada(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.rpc_aplicar_mutacion_offline_jornada(
  p_token_hash TEXT,
  p_client_mutation_id UUID,
  p_tipo TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_hash TEXT := lower(btrim(COALESCE(p_token_hash, '')));
  v_ses public.sesiones_jornada;
  v_tipo TEXT := upper(btrim(COALESCE(p_tipo, '')));
  v_receipt_id UUID;
  v_now TIMESTAMPTZ := now();
  v_ruta_id UUID;
  v_ruta public.rutas_promotoras;
  v_accion TEXT;
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_acc DOUBLE PRECISION;
  v_motivo TEXT;
  v_ejec JSONB;
  v_entrega_id TEXT;
  v_entrega public.entregas_degustacion;
  v_incidencia_row public.incidencias_pdv;
  v_cliente_rec RECORD;
  v_cliente_found BOOLEAN := false;
  v_pdv_lat DOUBLE PRECISION := NULL;
  v_pdv_lng DOUBLE PRECISION := NULL;
  v_radio_m INTEGER := 150;
  v_distancia_m DOUBLE PRECISION := NULL;
  v_dentro_geocerca BOOLEAN := NULL;
  v_created_at_iso TIMESTAMPTZ;
BEGIN
  IF p_client_mutation_id IS NULL THEN
    RAISE EXCEPTION 'MISSING_MUTATION_ID: client_mutation_id UUID es obligatorio.'
      USING ERRCODE = '22023';
  END IF;

  IF v_clean_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_SHIFT_TOKEN: Token de jornada inválido.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_ses
  FROM public.sesiones_jornada
  WHERE token_hash = v_clean_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: Sesión de jornada inexistente.'
      USING ERRCODE = '42501';
  END IF;

  IF v_ses.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED: Este enlace de jornada fue revocado.'
      USING ERRCODE = '42501';
  END IF;

  IF v_ses.expires_at <= v_now THEN
    RAISE EXCEPTION 'SESSION_EXPIRED: Este enlace de jornada expiró.'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotencia atómica anti-replay en libro de recibos
  INSERT INTO public.offline_mutation_receipts (
    client_mutation_id,
    entidad,
    registro_id,
    sesion_jornada_id,
    actor_uid,
    region_id,
    sucursal
  )
  VALUES (
    p_client_mutation_id,
    v_tipo,
    COALESCE(p_payload ->> 'ruta_id', p_payload ->> 'delivery_id', p_payload ->> 'pdv_nombre', 'batch'),
    v_ses.id,
    v_ses.created_by,
    v_ses.region_id,
    v_ses.sucursal
  )
  ON CONFLICT (client_mutation_id) DO NOTHING
  RETURNING client_mutation_id INTO v_receipt_id;

  IF v_receipt_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_hit', true,
      'client_mutation_id', p_client_mutation_id
    );
  END IF;

  UPDATE public.sesiones_jornada
  SET last_used_at = v_now
  WHERE id = v_ses.id;

  IF v_tipo = 'PROMOTORA_RUTA_STEP' THEN
    IF v_ses.rol <> 'promotora' THEN
      RAISE EXCEPTION 'FORBIDDEN_SHIFT_ROLE: Enlace sin permisos de promotora.'
        USING ERRCODE = '42501';
    END IF;

    v_ruta_id := (p_payload ->> 'ruta_id')::uuid;
    v_accion := upper(btrim(COALESCE(p_payload ->> 'accion', '')));
    v_lat := NULLIF(btrim(COALESCE(p_payload ->> 'lat', '')), '')::double precision;
    v_lng := NULLIF(btrim(COALESCE(p_payload ->> 'lng', '')), '')::double precision;
    v_acc := NULLIF(btrim(COALESCE(p_payload ->> 'accuracy_m', '')), '')::double precision;
    v_motivo := btrim(COALESCE(p_payload ->> 'motivo_fuera_geocerca', ''));
    v_ejec := p_payload -> 'ejecucion';

    IF v_ruta_id IS NULL OR v_accion NOT IN ('CHECKIN', 'CHECKOUT') THEN
      RAISE EXCEPTION 'INVALID_RUTA_PAYLOAD: ruta_id y accion (CHECKIN/CHECKOUT) son obligatorios.'
        USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_ruta
    FROM public.rutas_promotoras
    WHERE id = v_ruta_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'RUTA_NOT_FOUND: La ruta especificada no existe.'
        USING ERRCODE = 'P0002';
    END IF;

    IF v_ruta.sucursal IS DISTINCT FROM v_ses.sucursal
       AND (v_ruta.region_id IS NULL OR v_ruta.region_id IS DISTINCT FROM v_ses.region_id) THEN
      RAISE EXCEPTION 'FORBIDDEN_REGION: La ruta no pertenece a la región de esta jornada.'
        USING ERRCODE = '42501';
    END IF;

    IF v_ses.personal_id IS NOT NULL AND v_ruta.promotora_id IS DISTINCT FROM v_ses.personal_id THEN
      RAISE EXCEPTION 'FORBIDDEN_OWNER: La ruta pertenece a otra promotora.'
        USING ERRCODE = '42501';
    END IF;

    SELECT c.id, c.latitud, c.longitud, COALESCE(c.radio_geocerca_m, 150) AS radio_geocerca_m
    INTO v_cliente_rec
    FROM public.clientes c
    WHERE (c.region_id = v_ses.region_id OR c.sucursal = v_ses.sucursal)
      AND (
        (NULLIF(btrim(v_ruta.cliente_codigo), '') IS NOT NULL
          AND upper(btrim(c.codigo_cliente)) = upper(btrim(v_ruta.cliente_codigo)))
        OR lower(btrim(c.nombre_comercial)) = lower(btrim(v_ruta.cliente_nombre))
      )
    LIMIT 1;

    IF FOUND THEN
      v_cliente_found := true;
      v_pdv_lat := v_cliente_rec.latitud::double precision;
      v_pdv_lng := v_cliente_rec.longitud::double precision;
      v_radio_m := COALESCE(v_cliente_rec.radio_geocerca_m, 150);
    END IF;

    IF v_lat IS NOT NULL AND v_lng IS NOT NULL AND v_pdv_lat IS NOT NULL AND v_pdv_lng IS NOT NULL THEN
      v_distancia_m := public.fn_haversine_metros(v_lat, v_lng, v_pdv_lat, v_pdv_lng);
      IF v_distancia_m IS NOT NULL THEN
        v_dentro_geocerca := (v_distancia_m <= v_radio_m);
        IF NOT v_dentro_geocerca THEN
          INSERT INTO public.alertas_geocerca_auditoria (
            ruta_id, promotora_id, promotora_nombre, cliente_nombre, accion,
            lat_capturada, lng_capturada, pdv_lat, pdv_lng, distancia_m, radio_permitido_m,
            motivo, client_submission_id, sucursal, region_id
          )
          VALUES (
            v_ruta.id, v_ruta.promotora_id, v_ruta.promotora_nombre, v_ruta.cliente_nombre, v_accion,
            v_lat, v_lng, v_pdv_lat, v_pdv_lng, v_distancia_m, v_radio_m,
            COALESCE(NULLIF(v_motivo, ''), 'Marcaje offline fuera de geocerca auditado'),
            p_client_mutation_id::text || ':' || v_accion,
            v_ses.sucursal, v_ses.region_id
          )
          ON CONFLICT (client_submission_id) DO NOTHING;
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
        client_mutation_id = p_client_mutation_id,
        updated_at = v_now
      WHERE id = v_ruta.id
      RETURNING * INTO v_ruta;
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
        client_mutation_id = p_client_mutation_id,
        updated_at = v_now
      WHERE id = v_ruta.id
      RETURNING * INTO v_ruta;

      IF v_ejec IS NOT NULL AND jsonb_typeof(v_ejec) = 'object' THEN
        INSERT INTO public.ejecuciones_pdv_promotora (
          ruta_id, cronograma_id, promotora_id, cliente_id, cliente_nombre, fecha,
          lote_producto, fecha_vencimiento, unidades_abiertas, muestras_entregadas,
          ventas_asistidas_unidades, observaciones, client_submission_id,
          client_mutation_id, sucursal, region_id
        )
        VALUES (
          v_ruta.id,
          v_ruta.cronograma_id,
          v_ruta.promotora_id,
          CASE WHEN v_cliente_found THEN v_cliente_rec.id ELSE NULL END,
          v_ruta.cliente_nombre,
          v_ruta.fecha,
          btrim(COALESCE(v_ejec ->> 'lote_producto', '')),
          NULLIF(btrim(COALESCE(v_ejec ->> 'fecha_vencimiento', '')), '')::date,
          GREATEST(0, COALESCE((v_ejec ->> 'unidades_abiertas')::numeric, 0)),
          GREATEST(0, COALESCE((v_ejec ->> 'muestras_entregadas')::integer, 0)),
          GREATEST(0, COALESCE((v_ejec ->> 'ventas_asistidas_unidades')::integer, 0)),
          btrim(COALESCE(v_ejec ->> 'observaciones', '')),
          p_client_mutation_id::text,
          p_client_mutation_id,
          v_ses.sucursal,
          v_ses.region_id
        )
        ON CONFLICT (ruta_id) DO UPDATE
        SET
          lote_producto = EXCLUDED.lote_producto,
          fecha_vencimiento = EXCLUDED.fecha_vencimiento,
          unidades_abiertas = EXCLUDED.unidades_abiertas,
          muestras_entregadas = EXCLUDED.muestras_entregadas,
          ventas_asistidas_unidades = EXCLUDED.ventas_asistidas_unidades,
          observaciones = EXCLUDED.observaciones,
          client_mutation_id = EXCLUDED.client_mutation_id,
          updated_at = v_now;
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_hit', false,
      'client_mutation_id', p_client_mutation_id,
      'ruta', to_jsonb(v_ruta)
    );

  ELSIF v_tipo = 'PROMOTORA_INCIDENCIA' THEN
    IF v_ses.rol <> 'promotora' THEN
      RAISE EXCEPTION 'FORBIDDEN_SHIFT_ROLE: Enlace sin permisos de promotora.'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.incidencias_pdv (
      codigo_incidencia,
      cliente_id,
      pdv_nombre,
      ruta_id,
      reportado_por_uid,
      reportado_por_nombre,
      tipo_incidencia,
      severidad,
      descripcion,
      foto_storage_bucket,
      foto_storage_path,
      foto_mime_type,
      foto_sha256_hex,
      sucursal,
      region_id,
      client_mutation_id
    )
    VALUES (
      'AUTO',
      NULLIF(btrim(COALESCE(p_payload ->> 'cliente_id', '')), '')::uuid,
      btrim(COALESCE(p_payload ->> 'pdv_nombre', '')),
      NULLIF(btrim(COALESCE(p_payload ->> 'ruta_id', '')), '')::uuid,
      v_ses.created_by,
      COALESCE(NULLIF(btrim(COALESCE(p_payload ->> 'reportado_por_nombre', '')), ''), NULLIF(v_ses.personal_nombre, ''), 'Promotora en Jornada'),
      COALESCE(NULLIF(upper(btrim(COALESCE(p_payload ->> 'tipo_incidencia', ''))), ''), 'OTRO'),
      COALESCE(NULLIF(upper(btrim(COALESCE(p_payload ->> 'severidad', ''))), ''), 'MEDIA'),
      btrim(COALESCE(p_payload ->> 'descripcion', '')),
      CASE WHEN NULLIF(btrim(COALESCE(p_payload ->> 'foto_storage_path', '')), '') IS NOT NULL THEN 'incidencias-evidencias' ELSE NULL END,
      NULLIF(btrim(COALESCE(p_payload ->> 'foto_storage_path', '')), ''),
      NULLIF(btrim(COALESCE(p_payload ->> 'foto_mime_type', '')), ''),
      NULLIF(btrim(COALESCE(p_payload ->> 'foto_sha256_hex', '')), ''),
      v_ses.sucursal,
      v_ses.region_id,
      p_client_mutation_id
    )
    RETURNING * INTO v_incidencia_row;

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_hit', false,
      'client_mutation_id', p_client_mutation_id,
      'incidencia', to_jsonb(v_incidencia_row)
    );

  ELSIF v_tipo = 'CHOFER_ENTREGA_PATCH' THEN
    IF v_ses.rol <> 'chofer' THEN
      RAISE EXCEPTION 'FORBIDDEN_SHIFT_ROLE: Enlace sin permisos de chofer.'
        USING ERRCODE = '42501';
    END IF;

    v_entrega_id := btrim(COALESCE(p_payload ->> 'delivery_id', ''));
    IF v_entrega_id = '' THEN
      RAISE EXCEPTION 'INVALID_DELIVERY_ID: delivery_id es obligatorio.'
        USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_entrega
    FROM public.entregas_degustacion
    WHERE id = v_entrega_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'DELIVERY_NOT_FOUND: La entrega no existe.'
        USING ERRCODE = 'P0002';
    END IF;

    IF v_entrega.sucursal IS DISTINCT FROM v_ses.sucursal
       AND (v_entrega.region_id IS NULL OR v_entrega.region_id IS DISTINCT FROM v_ses.region_id) THEN
      RAISE EXCEPTION 'FORBIDDEN_REGION: La entrega pertenece a otra región.'
        USING ERRCODE = '42501';
    END IF;

    v_created_at_iso := COALESCE(
      NULLIF(btrim(COALESCE(p_payload ->> 'actualizado_chofer_at', '')), '')::timestamptz,
      v_now
    );

    -- Gana el último: si el servidor ya recibió un toque más reciente, acepta de forma idempotente sin retroceder estado
    IF v_entrega.actualizado_chofer_at IS NOT NULL AND v_entrega.actualizado_chofer_at > v_created_at_iso THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent_hit', true,
        'stale_ignored', true,
        'client_mutation_id', p_client_mutation_id,
        'entrega', to_jsonb(v_entrega)
      );
    END IF;

    UPDATE public.entregas_degustacion
    SET
      stand_entregado = COALESCE((p_payload ->> 'stand_entregado')::boolean, stand_entregado),
      producto_entregado = COALESCE((p_payload ->> 'producto_entregado')::boolean, producto_entregado),
      completado = COALESCE((p_payload ->> 'completado')::boolean, completado),
      hora_entrega = CASE
        WHEN p_payload ? 'hora_entrega' THEN NULLIF(btrim(COALESCE(p_payload ->> 'hora_entrega', '')), '')
        ELSE hora_entrega
      END,
      hora_entrega_real = CASE
        WHEN p_payload ? 'hora_entrega_real' THEN NULLIF(btrim(COALESCE(p_payload ->> 'hora_entrega_real', '')), '')::timestamptz
        ELSE hora_entrega_real
      END,
      notas_chofer = CASE
        WHEN p_payload ? 'notas_chofer' THEN left(COALESCE(p_payload ->> 'notas_chofer', ''), 500)
        ELSE notas_chofer
      END,
      actualizado_chofer_at = v_created_at_iso,
      client_mutation_id = p_client_mutation_id
    WHERE id = v_entrega.id
    RETURNING * INTO v_entrega;

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_hit', false,
      'client_mutation_id', p_client_mutation_id,
      'entrega', to_jsonb(v_entrega)
    );
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_MUTATION_TYPE: Tipo de mutación offline no soportado (%).', v_tipo
      USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_aplicar_mutacion_offline_jornada(TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_aplicar_mutacion_offline_jornada(TEXT, UUID, TEXT, JSONB) TO service_role;

-- =============================================================================
-- 5. TABLA `public.notificaciones_outbox` Y `public.web_push_subscriptions`
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notificaciones_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  degustacion_id UUID NOT NULL,
  region_id UUID NULL REFERENCES public.regiones(id) ON DELETE SET NULL,
  sucursal public.sucursal_codigo NULL,
  canal TEXT NOT NULL CHECK (canal IN ('whatsapp', 'web_push')),
  destinatario TEXT NOT NULL CHECK (length(btrim(destinatario)) >= 2),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  estado TEXT NOT NULL DEFAULT 'pending'
    CHECK (estado IN ('pending', 'sent', 'failed', 'pending_config')),
  intentos INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_error TEXT NULL,
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notificaciones_outbox_degustacion_canal_dest
    UNIQUE (degustacion_id, canal, destinatario)
);

COMMENT ON TABLE public.notificaciones_outbox IS
  'Cola transaccional Outbox para alertas automáticas WhatsApp Cloud API y Web Push (VAPID) disparadas al crearse una degustación FDV.';

CREATE INDEX IF NOT EXISTS idx_notificaciones_outbox_pending
  ON public.notificaciones_outbox (estado, next_retry_at ASC)
  WHERE estado = 'pending';

CREATE INDEX IF NOT EXISTS idx_notificaciones_outbox_region_created
  ON public.notificaciones_outbox (region_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notificaciones_outbox_degustacion
  ON public.notificaciones_outbox (degustacion_id);

DROP TRIGGER IF EXISTS trg_v190_notificaciones_outbox_updated_at ON public.notificaciones_outbox;
CREATE TRIGGER trg_v190_notificaciones_outbox_updated_at
  BEFORE UPDATE ON public.notificaciones_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_contraloria_touch_updated_at();

REVOKE ALL ON TABLE public.notificaciones_outbox FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.notificaciones_outbox TO authenticated;
GRANT ALL ON TABLE public.notificaciones_outbox TO service_role;

ALTER TABLE public.notificaciones_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notificaciones_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notificaciones_outbox_select_torre ON public.notificaciones_outbox;
CREATE POLICY notificaciones_outbox_select_torre
  ON public.notificaciones_outbox
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_torre_control_viewer())
    AND (
      sucursal IS NULL
      OR (SELECT public.tiene_acceso_region(region_id, sucursal))
    )
  );

ALTER TABLE public.notificaciones_outbox REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notificaciones_outbox'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notificaciones_outbox;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.web_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  region_id UUID NULL REFERENCES public.regiones(id) ON DELETE SET NULL,
  sucursal public.sucursal_codigo NULL,
  endpoint TEXT NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh TEXT NOT NULL CHECK (length(btrim(p256dh)) >= 16),
  auth_secret TEXT NOT NULL CHECK (length(btrim(auth_secret)) >= 8),
  user_agent TEXT NOT NULL DEFAULT '',
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.web_push_subscriptions IS
  'Suscripciones Web Push (RFC 8291/8292 VAPID) por usuario autenticado y región para alertas en vivo de nuevas degustaciones.';

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user
  ON public.web_push_subscriptions (user_id, activo);

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_region_activas
  ON public.web_push_subscriptions (region_id, sucursal)
  WHERE activo = true;

DROP TRIGGER IF EXISTS trg_v190_web_push_subscriptions_updated_at ON public.web_push_subscriptions;
CREATE TRIGGER trg_v190_web_push_subscriptions_updated_at
  BEFORE UPDATE ON public.web_push_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_contraloria_touch_updated_at();

REVOKE ALL ON TABLE public.web_push_subscriptions FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.web_push_subscriptions TO authenticated;
GRANT ALL ON TABLE public.web_push_subscriptions TO service_role;

ALTER TABLE public.web_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_push_subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_push_subscriptions_own_select ON public.web_push_subscriptions;
CREATE POLICY web_push_subscriptions_own_select
  ON public.web_push_subscriptions
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS web_push_subscriptions_own_insert ON public.web_push_subscriptions;
CREATE POLICY web_push_subscriptions_own_insert
  ON public.web_push_subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS web_push_subscriptions_own_update ON public.web_push_subscriptions;
CREATE POLICY web_push_subscriptions_own_update
  ON public.web_push_subscriptions
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS web_push_subscriptions_own_delete ON public.web_push_subscriptions;
CREATE POLICY web_push_subscriptions_own_delete
  ON public.web_push_subscriptions
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- =============================================================================
-- 6. TRIGGER POSTGRESQL NO BLOQUEANTE `AFTER INSERT` PARA ENCOLAR ALERTAS FDV
--    Canónico sobre `public.surveys` (`type = 'Degustacion'`) + guarda opcional
--    para `public.degustaciones` si existe en el catálogo remoto.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_parse_jsonb_safe(p_raw TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_raw IS NULL OR btrim(p_raw) = '' THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN p_raw::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN '{}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_parse_jsonb_safe(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_parse_jsonb_safe(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_enqueue_degustacion_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comments JSONB := '{}'::jsonb;
  v_region_id UUID;
  v_sucursal public.sucursal_codigo;
  v_region_nombre TEXT := 'Sin Región';
  v_whatsapp_dest TEXT := NULL;
  v_cliente TEXT;
  v_productos TEXT;
  v_fecha TEXT;
  v_turno TEXT;
  v_vendedor TEXT;
  v_payload JSONB;
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'surveys' THEN
      IF NEW.type IS DISTINCT FROM 'Degustacion' THEN
        RETURN NEW;
      END IF;
      v_comments := public.fn_parse_jsonb_safe(NEW.comments);
      v_sucursal := NEW.sucursal;
      v_region_id := COALESCE(
        NEW.region_id,
        public.fn_resolver_region_id(COALESCE(NEW.sucursal::text, v_comments ->> 'sucursal', ''))
      );
      IF v_sucursal IS NULL AND v_region_id IS NOT NULL THEN
        v_sucursal := public.fn_resolver_sucursal_desde_region_id(v_region_id);
      END IF;

      v_cliente := COALESCE(
        NULLIF(btrim(NEW.store), ''),
        NULLIF(btrim(v_comments ->> 'cliente'), ''),
        NULLIF(btrim(v_comments ->> 'client'), ''),
        'Punto de Venta'
      );
      v_productos := COALESCE(
        NULLIF(btrim(NEW.product), ''),
        NULLIF(btrim(v_comments ->> 'product'), ''),
        'Degustación CODIZULCA'
      );
      v_fecha := COALESCE(
        NULLIF(btrim(NEW.date), ''),
        NULLIF(btrim(v_comments ->> 'date'), ''),
        to_char(now() AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD')
      );
      v_turno := COALESCE(
        NULLIF(btrim(v_comments ->> 'turno'), ''),
        NULLIF(btrim(v_comments ->> 'shift'), ''),
        'MAÑANA'
      );
      v_vendedor := COALESCE(
        NULLIF(btrim(v_comments ->> 'vendedor'), ''),
        NULLIF(btrim(v_comments ->> 'salesRep'), ''),
        NULLIF(btrim(NEW.promoter), ''),
        NULLIF(btrim(NEW."creatorId"), ''),
        'Vendedor FDV'
      );
    ELSE
      -- Soporte defensivo si el entorno remoto posee tabla `public.degustaciones`
      v_comments := to_jsonb(NEW);
      v_region_id := COALESCE(
        NULLIF(btrim(COALESCE(v_comments ->> 'region_id', '')), '')::uuid,
        public.fn_resolver_region_id(COALESCE(v_comments ->> 'sucursal', v_comments ->> 'region', ''))
      );
      v_sucursal := COALESCE(
        public.fn_normalizar_sucursal_codigo(v_comments ->> 'sucursal'),
        public.fn_resolver_sucursal_desde_region_id(v_region_id)
      );
      v_cliente := COALESCE(
        NULLIF(btrim(v_comments ->> 'cliente'), ''),
        NULLIF(btrim(v_comments ->> 'cliente_nombre'), ''),
        NULLIF(btrim(v_comments ->> 'store'), ''),
        'Punto de Venta'
      );
      v_productos := COALESCE(
        NULLIF(btrim(v_comments ->> 'producto'), ''),
        NULLIF(btrim(v_comments ->> 'productos'), ''),
        'Degustación CODIZULCA'
      );
      v_fecha := COALESCE(
        NULLIF(btrim(v_comments ->> 'fecha'), ''),
        NULLIF(btrim(v_comments ->> 'date'), ''),
        to_char(now() AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD')
      );
      v_turno := COALESCE(NULLIF(btrim(v_comments ->> 'turno'), ''), 'MAÑANA');
      v_vendedor := COALESCE(
        NULLIF(btrim(v_comments ->> 'vendedor'), ''),
        NULLIF(btrim(v_comments ->> 'vendedor_nombre'), ''),
        'Vendedor FDV'
      );
    END IF;

    IF v_region_id IS NOT NULL THEN
      SELECT
        COALESCE(NULLIF(btrim(r.nombre), ''), r.codigo, 'Sin Región'),
        NULLIF(regexp_replace(COALESCE(r.whatsapp_responsable_telefono, ''), '[^0-9]', '', 'g'), '')
      INTO v_region_nombre, v_whatsapp_dest
      FROM public.regiones r
      WHERE r.id = v_region_id;
    ELSIF v_sucursal IS NOT NULL THEN
      v_region_nombre := initcap(lower(v_sucursal::text));
    END IF;

    -- Fallback al teléfono del primer supervisor activo de la región si regiones.whatsapp_responsable_telefono está vacío
    IF v_whatsapp_dest IS NULL AND (v_region_id IS NOT NULL OR v_sucursal IS NOT NULL) THEN
      SELECT NULLIF(regexp_replace(COALESCE(s.telefono, ''), '[^0-9]', '', 'g'), '')
      INTO v_whatsapp_dest
      FROM public.supervisores s
      WHERE s.activo = true
        AND (s.region_id = v_region_id OR s.sucursal = v_sucursal)
        AND length(regexp_replace(COALESCE(s.telefono, ''), '[^0-9]', '', 'g')) >= 10
      ORDER BY s.created_at ASC
      LIMIT 1;
    END IF;

    v_payload := jsonb_build_object(
      'degustacion_id', NEW.id,
      'cliente', left(v_cliente, 180),
      'region_id', v_region_id,
      'region_codigo', COALESCE(v_sucursal::text, 'GLOBAL'),
      'region_nombre', left(v_region_nombre, 80),
      'productos', left(v_productos, 300),
      'fecha_programada', left(v_fecha, 32),
      'turno', left(v_turno, 40),
      'vendedor', left(v_vendedor, 140),
      'origen', TG_TABLE_NAME,
      'enqueued_at', now()
    );

    INSERT INTO public.notificaciones_outbox (
      degustacion_id,
      region_id,
      sucursal,
      canal,
      destinatario,
      payload,
      estado
    )
    VALUES (
      NEW.id,
      v_region_id,
      v_sucursal,
      'whatsapp',
      COALESCE(v_whatsapp_dest, 'REGION:' || COALESCE(v_sucursal::text, 'GLOBAL')),
      v_payload,
      'pending'
    )
    ON CONFLICT (degustacion_id, canal, destinatario) DO NOTHING;

    INSERT INTO public.notificaciones_outbox (
      degustacion_id,
      region_id,
      sucursal,
      canal,
      destinatario,
      payload,
      estado
    )
    VALUES (
      NEW.id,
      v_region_id,
      v_sucursal,
      'web_push',
      'REGION:' || COALESCE(v_sucursal::text, 'GLOBAL'),
      v_payload,
      'pending'
    )
    ON CONFLICT (degustacion_id, canal, destinatario) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Garantía absoluta: un fallo en la cola de alertas JAMÁS bloquea el guardado del vendedor en FDV.
    PERFORM 1;
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_enqueue_degustacion_outbox() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_v190_surveys_enqueue_degustacion_outbox ON public.surveys;
CREATE TRIGGER trg_v190_surveys_enqueue_degustacion_outbox
  AFTER INSERT ON public.surveys
  FOR EACH ROW
  WHEN (NEW.type = 'Degustacion')
  EXECUTE FUNCTION public.fn_enqueue_degustacion_outbox();

-- Guarda idempotente opcional por si existiera tabla física `public.degustaciones` en producción FDV
DO $$
BEGIN
  IF to_regclass('public.degustaciones') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_v190_degustaciones_enqueue_outbox ON public.degustaciones';
    EXECUTE 'CREATE TRIGGER trg_v190_degustaciones_enqueue_outbox AFTER INSERT ON public.degustaciones FOR EACH ROW EXECUTE FUNCTION public.fn_enqueue_degustacion_outbox()';
  END IF;
END $$;

COMMIT;
