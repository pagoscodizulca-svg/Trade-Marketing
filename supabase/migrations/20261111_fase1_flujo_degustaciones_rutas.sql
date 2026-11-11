-- =============================================================================
-- CODIZULCA C.A. - FASE 1: ESQUEMA DE DATOS, MÁQUINA DE ESTADOS Y SINCRONIZACIÓN
-- Flujo Automatizado:
--   Módulo 1 (cargas_archivos)
--     -> Módulo 2 (cronograma_degustaciones en PENDIENTE_APROBACION)
--     -> App de Promotoras / Módulo de Ruta (rutas_promotoras al pasar a APROBADA + promotora_id)
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. TABLA DE AUDITORÍA DE LOTES DE ARCHIVOS (MÓDULO 1)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.cargas_archivos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_archivo TEXT NOT NULL,
  extension TEXT NOT NULL
    CHECK (extension IN ('xlsx', 'xls', 'csv', 'pdf')),
  mime_type TEXT NOT NULL,
  tamano_bytes BIGINT NOT NULL
    CHECK (tamano_bytes > 0 AND tamano_bytes <= 15728640), -- Máx. 15 MB
  archivo_sha256 TEXT NOT NULL,
  metodo_extraccion TEXT NOT NULL
    CHECK (metodo_extraccion IN ('TABULAR_DETERMINISTA', 'IA_ESTRUCTURADA')),
  total_filas_extraidas INTEGER NOT NULL DEFAULT 0
    CHECK (total_filas_extraidas >= 0),
  total_filas_insertadas INTEGER NOT NULL DEFAULT 0
    CHECK (total_filas_insertadas >= 0),
  total_filas_duplicadas INTEGER NOT NULL DEFAULT 0
    CHECK (total_filas_duplicadas >= 0),
  cargado_por TEXT NOT NULL,
  cargado_por_rol TEXT NOT NULL DEFAULT 'jefe_trade',
  notas TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cargas_archivos_sha256
  ON public.cargas_archivos (archivo_sha256);

CREATE INDEX IF NOT EXISTS idx_cargas_archivos_created_at
  ON public.cargas_archivos (created_at DESC);

-- =============================================================================
-- 2. TABLA DE CRONOGRAMA DE DEGUSTACIONES (MÓDULO 2 - COORDINADORA TRADE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.cronograma_degustaciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carga_id UUID REFERENCES public.cargas_archivos(id) ON DELETE SET NULL,
  survey_origen_id UUID UNIQUE REFERENCES public.surveys(id) ON DELETE SET NULL,
  idempotency_hash TEXT NOT NULL,

  -- Datos operativos de la planificación
  fecha DATE NOT NULL,
  hora_inicio TEXT NOT NULL DEFAULT '09:00',
  hora_fin TEXT NOT NULL DEFAULT '13:00',
  turno TEXT NOT NULL DEFAULT 'MAÑANA'
    CHECK (turno IN ('MAÑANA', 'TARDE', 'COMPLETO')),
  cliente_nombre TEXT NOT NULL,
  cliente_codigo TEXT NOT NULL DEFAULT '',
  zona_direccion TEXT NOT NULL DEFAULT '',
  producto_resumen TEXT NOT NULL,
  productos JSONB NOT NULL DEFAULT '[]'::jsonb,
  cantidad_kilos NUMERIC(10, 2) NOT NULL DEFAULT 1.00
    CHECK (cantidad_kilos > 0),
  personas_estimadas INTEGER NOT NULL DEFAULT 0
    CHECK (personas_estimadas >= 0),
  insumos_calculados JSONB NOT NULL DEFAULT '{}'::jsonb,
  vendedor_fdv TEXT NOT NULL DEFAULT '',
  promotora_sugerida TEXT NOT NULL DEFAULT '',

  -- Asignación oficial de Promotora (FK directa a public.staff)
  promotora_id UUID REFERENCES public.staff(id) ON DELETE RESTRICT,
  promotora_nombre TEXT DEFAULT NULL,
  promotora_email TEXT DEFAULT NULL,
  observaciones TEXT NOT NULL DEFAULT '',

  -- Máquina de estados y auditoría de Coordinadora Trade Marketing
  estado TEXT NOT NULL DEFAULT 'PENDIENTE_APROBACION'
    CHECK (estado IN (
      'PENDIENTE_APROBACION',
      'APROBADA',
      'RECHAZADA',
      'CANCELADA',
      'EN_CURSO',
      'COMPLETADA'
    )),
  aprobado_por TEXT DEFAULT NULL,
  fecha_aprobacion TIMESTAMPTZ DEFAULT NULL,
  rechazado_por TEXT DEFAULT NULL,
  fecha_rechazo TIMESTAMPTZ DEFAULT NULL,
  motivo_rechazo TEXT DEFAULT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- CANDADO DE SEGURIDAD FÍSICO: Imposible aprobar sin promotora_id asignada
  CONSTRAINT chk_cronograma_aprobada_requiere_promotora
    CHECK (
      estado NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA')
      OR promotora_id IS NOT NULL
    )
);

-- Índices en columnas FK y filtros operativos frecuentes (Postgres Best Practices)
CREATE INDEX IF NOT EXISTS idx_cronograma_deg_carga_id
  ON public.cronograma_degustaciones (carga_id);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_promotora_id
  ON public.cronograma_degustaciones (promotora_id);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_estado_fecha
  ON public.cronograma_degustaciones (estado, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_cronograma_deg_fecha
  ON public.cronograma_degustaciones (fecha DESC);

-- Índice único parcial de idempotencia: bloquea duplicados activos al subir el mismo archivo
-- dos veces, pero permite reprogramar filas previamente RECHAZADAS o CANCELADAS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cronograma_deg_idempotency_active
  ON public.cronograma_degustaciones (idempotency_hash)
  WHERE estado NOT IN ('RECHAZADA', 'CANCELADA');

-- =============================================================================
-- 3. TABLA DEL MÓDULO DE RUTA EN LA APP DE LAS PROMOTORAS
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.rutas_promotoras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cronograma_id UUID NOT NULL UNIQUE
    REFERENCES public.cronograma_degustaciones(id) ON DELETE CASCADE,
  promotora_id UUID NOT NULL
    REFERENCES public.staff(id) ON DELETE RESTRICT,
  promotora_nombre TEXT NOT NULL,
  promotora_email TEXT NOT NULL DEFAULT '',

  fecha DATE NOT NULL,
  hora_inicio TEXT NOT NULL,
  hora_fin TEXT NOT NULL,
  turno TEXT NOT NULL
    CHECK (turno IN ('MAÑANA', 'TARDE', 'COMPLETO')),
  cliente_nombre TEXT NOT NULL,
  cliente_codigo TEXT NOT NULL DEFAULT '',
  zona_direccion TEXT NOT NULL DEFAULT '',
  producto_resumen TEXT NOT NULL,
  productos JSONB NOT NULL DEFAULT '[]'::jsonb,
  cantidad_kilos NUMERIC(10, 2) NOT NULL DEFAULT 1.00,
  personas_estimadas INTEGER NOT NULL DEFAULT 0,
  vendedor_fdv TEXT NOT NULL DEFAULT '',
  observaciones TEXT NOT NULL DEFAULT '',

  estado_ruta TEXT NOT NULL DEFAULT 'ASIGNADA'
    CHECK (estado_ruta IN ('ASIGNADA', 'EN_CURSO', 'COMPLETADA', 'CANCELADA')),
  checkin_at TIMESTAMPTZ DEFAULT NULL,
  checkout_at TIMESTAMPTZ DEFAULT NULL,
  aprobado_por TEXT DEFAULT NULL,
  asignado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_perfil_fecha
  ON public.rutas_promotoras (promotora_id, fecha ASC, estado_ruta);

CREATE INDEX IF NOT EXISTS idx_rutas_promotoras_email_fecha
  ON public.rutas_promotoras (lower(promotora_email), fecha ASC);

-- =============================================================================
-- 4. TRIGGER BEFORE: VALIDACIÓN DE PROMOTORA ACTIVA Y AUDITORÍA DE ESTADOS
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_validate_and_enrich_cronograma_degustacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_staff RECORD;
  v_status_json JSONB := '{}'::jsonb;
  v_member_status TEXT := 'Activo';
  v_member_category TEXT := '';
BEGIN
  NEW.updated_at := NOW();
  NEW.idempotency_hash := lower(btrim(COALESCE(NEW.idempotency_hash, '')));

  IF NEW.idempotency_hash = '' THEN
    RAISE EXCEPTION 'El campo idempotency_hash es obligatorio para registrar la degustación.';
  END IF;

  -- Validar promotora_id contra el padrón real public.staff cuando esté presente
  IF NEW.promotora_id IS NOT NULL THEN
    SELECT id, name, email, role, status
    INTO v_staff
    FROM public.staff
    WHERE id = NEW.promotora_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La promotora seleccionada (%) no existe en public.staff.', NEW.promotora_id;
    END IF;

    BEGIN
      IF v_staff.status IS NOT NULL AND btrim(v_staff.status::text) LIKE '{%' THEN
        v_status_json := (v_staff.status::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_status_json := '{}'::jsonb;
    END;

    v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
    v_member_category := lower(COALESCE(v_status_json ->> 'category', ''));

    IF lower(btrim(v_member_status)) = 'inactivo' THEN
      RAISE EXCEPTION 'No se puede asignar la promotora "%" porque figura como Inactiva.', v_staff.name;
    END IF;

    IF v_member_category = 'merchandising'
       OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
      RAISE EXCEPTION 'El perfil "%" pertenece a Merchandising y no puede asignarse a degustación.', v_staff.name;
    END IF;

    NEW.promotora_nombre := btrim(v_staff.name);
    NEW.promotora_email := btrim(COALESCE(v_staff.email, ''));
  ELSE
    NEW.promotora_nombre := NULL;
    NEW.promotora_email := NULL;

    IF NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN
      RAISE EXCEPTION 'BLOQUEO DE SEGURIDAD: No se puede aprobar una degustación sin promotora_id asignada.';
    END IF;
  END IF;

  -- Estampado automático de auditoría al pasar a APROBADA
  IF NEW.estado = 'APROBADA'
     AND (TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM 'APROBADA') THEN
    NEW.fecha_aprobacion := COALESCE(NEW.fecha_aprobacion, NOW());
    NEW.aprobado_por := COALESCE(NULLIF(btrim(NEW.aprobado_por), ''), 'Coordinadora de Trade Marketing');
  END IF;

  -- Estampado automático al pasar a RECHAZADA / CANCELADA
  IF NEW.estado IN ('RECHAZADA', 'CANCELADA')
     AND (TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM NEW.estado) THEN
    NEW.fecha_rechazo := COALESCE(NEW.fecha_rechazo, NOW());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_cronograma_degustacion ON public.cronograma_degustaciones;

CREATE TRIGGER trg_validate_cronograma_degustacion
  BEFORE INSERT OR UPDATE ON public.cronograma_degustaciones
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_validate_and_enrich_cronograma_degustacion();

-- =============================================================================
-- 5. TRIGGER AFTER: SINCRONIZACIÓN ATÓMICA HACIA MÓDULO DE RUTA (APP PROMOTORAS)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_sync_cronograma_to_rutas_promotoras()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_target_estado_ruta TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- ON DELETE CASCADE ya retira la fila vinculada en rutas_promotoras
    RETURN OLD;
  END IF;

  -- Condición simultánea obligatoria: estado APROBADA (o en ejecución/completada) + promotora_id válido
  IF NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') AND NEW.promotora_id IS NOT NULL THEN

    -- Si la Coordinadora reasignó la promotora en una degustación ya aprobada:
    -- eliminar primero el registro de la promotora anterior para que Realtime emita DELETE limpio
    -- en su perfil y un INSERT limpio en el perfil de la nueva promotora.
    IF TG_OP = 'UPDATE'
       AND OLD.promotora_id IS NOT NULL
       AND OLD.promotora_id IS DISTINCT FROM NEW.promotora_id THEN
      DELETE FROM public.rutas_promotoras
      WHERE cronograma_id = NEW.id;
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
      estado_ruta = CASE
        WHEN public.rutas_promotoras.estado_ruta IN ('EN_CURSO', 'COMPLETADA')
             AND NEW.estado = 'APROBADA'
          THEN public.rutas_promotoras.estado_ruta
        ELSE EXCLUDED.estado_ruta
      END,
      aprobado_por = EXCLUDED.aprobado_por,
      updated_at = NOW();

  ELSE
    -- Si vuelve a PENDIENTE_APROBACION o pasa a RECHAZADA / CANCELADA, retirar de inmediato de la ruta
    DELETE FROM public.rutas_promotoras
    WHERE cronograma_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cronograma_to_rutas_promotoras ON public.cronograma_degustaciones;

CREATE TRIGGER trg_sync_cronograma_to_rutas_promotoras
  AFTER INSERT OR UPDATE OR DELETE ON public.cronograma_degustaciones
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_cronograma_to_rutas_promotoras();

-- =============================================================================
-- 6. RPC TRANSACCIONAL DE VOLCADO EN LOTE (MÓDULO 1 -> MÓDULO 2)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.volcar_lote_cronograma(
  p_carga JSONB,
  p_filas JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_carga_id UUID;
  v_item JSONB;
  v_recibidas INTEGER := 0;
  v_insertadas INTEGER := 0;
  v_duplicadas INTEGER := 0;
  v_inserted_id UUID;
  v_inserted_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  IF p_filas IS NULL OR jsonb_typeof(p_filas) <> 'array' OR jsonb_array_length(p_filas) = 0 THEN
    RAISE EXCEPTION 'El lote de degustaciones (p_filas) debe ser un arreglo JSON no vacío.';
  END IF;

  v_recibidas := jsonb_array_length(p_filas);

  INSERT INTO public.cargas_archivos (
    nombre_archivo,
    extension,
    mime_type,
    tamano_bytes,
    archivo_sha256,
    metodo_extraccion,
    total_filas_extraidas,
    cargado_por,
    cargado_por_rol,
    notas,
    metadata
  ) VALUES (
    COALESCE(NULLIF(btrim(p_carga ->> 'nombre_archivo'), ''), 'planificacion_degustaciones.xlsx'),
    lower(COALESCE(NULLIF(btrim(p_carga ->> 'extension'), ''), 'xlsx')),
    COALESCE(NULLIF(btrim(p_carga ->> 'mime_type'), ''), 'application/octet-stream'),
    COALESCE((p_carga ->> 'tamano_bytes')::bigint, 1),
    COALESCE(NULLIF(btrim(p_carga ->> 'archivo_sha256'), ''), pg_catalog.md5(p_filas::text)),
    COALESCE(NULLIF(btrim(p_carga ->> 'metodo_extraccion'), ''), 'TABULAR_DETERMINISTA'),
    v_recibidas,
    COALESCE(NULLIF(btrim(p_carga ->> 'cargado_por'), ''), 'Trade Marketing'),
    COALESCE(NULLIF(btrim(p_carga ->> 'cargado_por_rol'), ''), 'jefe_trade'),
    COALESCE(p_carga ->> 'notas', ''),
    COALESCE(p_carga -> 'metadata', '{}'::jsonb)
  )
  RETURNING id INTO v_carga_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_filas)
  LOOP
    v_inserted_id := NULL;

    INSERT INTO public.cronograma_degustaciones (
      carga_id,
      idempotency_hash,
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
      insumos_calculados,
      vendedor_fdv,
      promotora_sugerida,
      promotora_id,
      observaciones,
      estado
    ) VALUES (
      v_carga_id,
      lower(btrim(v_item ->> 'idempotency_hash')),
      (v_item ->> 'fecha')::date,
      COALESCE(NULLIF(btrim(v_item ->> 'hora_inicio'), ''), '09:00'),
      COALESCE(NULLIF(btrim(v_item ->> 'hora_fin'), ''), '13:00'),
      COALESCE(NULLIF(btrim(v_item ->> 'turno'), ''), 'MAÑANA'),
      btrim(v_item ->> 'cliente_nombre'),
      COALESCE(btrim(v_item ->> 'cliente_codigo'), ''),
      COALESCE(btrim(v_item ->> 'zona_direccion'), ''),
      btrim(v_item ->> 'producto_resumen'),
      COALESCE(v_item -> 'productos', '[]'::jsonb),
      GREATEST(COALESCE((v_item ->> 'cantidad_kilos')::numeric, 1.00), 0.10),
      GREATEST(COALESCE((v_item ->> 'personas_estimadas')::integer, 0), 0),
      COALESCE(v_item -> 'insumos_calculados', '{}'::jsonb),
      COALESCE(btrim(v_item ->> 'vendedor_fdv'), ''),
      COALESCE(btrim(v_item ->> 'promotora_sugerida'), ''),
      NULLIF(btrim(COALESCE(v_item ->> 'promotora_id', '')), '')::uuid,
      COALESCE(btrim(v_item ->> 'observaciones'), ''),
      'PENDIENTE_APROBACION'
    )
    ON CONFLICT (idempotency_hash) WHERE estado NOT IN ('RECHAZADA', 'CANCELADA')
    DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NOT NULL THEN
      v_insertadas := v_insertadas + 1;
      v_inserted_ids := array_append(v_inserted_ids, v_inserted_id);
    ELSE
      v_duplicadas := v_duplicadas + 1;
    END IF;
  END LOOP;

  UPDATE public.cargas_archivos
  SET
    total_filas_insertadas = v_insertadas,
    total_filas_duplicadas = v_duplicadas
  WHERE id = v_carga_id;

  RETURN jsonb_build_object(
    'carga_id', v_carga_id,
    'total_recibidas', v_recibidas,
    'total_insertadas', v_insertadas,
    'total_duplicadas', v_duplicadas,
    'ids_insertados', to_jsonb(v_inserted_ids)
  );
END;
$$;

-- =============================================================================
-- 6.B. RPC DE LECTURA AISLADA PARA EL MÓDULO DE RUTA (APP DE LAS PROMOTORAS)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.obtener_ruta_promotora(
  p_promotora_id UUID,
  p_fecha_desde DATE DEFAULT NULL,
  p_fecha_hasta DATE DEFAULT NULL
)
RETURNS SETOF public.rutas_promotoras
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_staff RECORD;
  v_status_json JSONB := '{}'::jsonb;
BEGIN
  IF p_promotora_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id, status INTO v_staff
  FROM public.staff
  WHERE id = p_promotora_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  BEGIN
    IF v_staff.status IS NOT NULL AND btrim(v_staff.status::text) LIKE '{%' THEN
      v_status_json := (v_staff.status::text)::jsonb;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_status_json := '{}'::jsonb;
  END;

  IF lower(btrim(COALESCE(v_status_json ->> 'status', 'Activo'))) = 'inactivo' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT r.*
  FROM public.rutas_promotoras r
  WHERE r.promotora_id = p_promotora_id
    AND r.estado_ruta <> 'CANCELADA'
    AND (p_fecha_desde IS NULL OR r.fecha >= p_fecha_desde)
    AND (p_fecha_hasta IS NULL OR r.fecha <= p_fecha_hasta)
  ORDER BY r.fecha ASC, r.hora_inicio ASC;
END;
$$;

-- =============================================================================
-- 7. PUBLICACIÓN EN SUPABASE REALTIME (FILA COMPLETA)
-- =============================================================================
ALTER TABLE public.cronograma_degustaciones REPLICA IDENTITY FULL;
ALTER TABLE public.rutas_promotoras REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'cronograma_degustaciones'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cronograma_degustaciones;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'rutas_promotoras'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rutas_promotoras;
  END IF;
END $$;

-- =============================================================================
-- 8. PERMISOS DATA API Y POLÍTICAS RLS (AISLAMIENTO DE PERFIL POR PROMOTORA)
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cargas_archivos TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cronograma_degustaciones TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rutas_promotoras TO anon, authenticated;
REVOKE ALL ON FUNCTION public.obtener_ruta_promotora(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.volcar_lote_cronograma(JSONB, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.obtener_ruta_promotora(UUID, DATE, DATE) TO anon, authenticated;

ALTER TABLE public.cargas_archivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cronograma_degustaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rutas_promotoras ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Políticas cargas_archivos (Trade Marketing)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cargas_archivos'
      AND policyname = 'cargas_archivos_trade_all'
  ) THEN
    CREATE POLICY cargas_archivos_trade_all
      ON public.cargas_archivos
      FOR ALL
      TO anon, authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  -- Políticas cronograma_degustaciones (Módulo 1 & Módulo 2 Coordinadora Trade Marketing)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cronograma_degustaciones'
      AND policyname = 'cronograma_degustaciones_trade_all'
  ) THEN
    CREATE POLICY cronograma_degustaciones_trade_all
      ON public.cronograma_degustaciones
      FOR ALL
      TO anon, authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  -- Políticas rutas_promotoras:
  -- Aislamiento estricto por perfil cuando la App de Promotoras envía su identificador
  -- (JWT email o cabecera x-promotora-id), permitiendo supervisión global desde Trade Marketing
  -- únicamente cuando declara el scope explícito 'trade_coordinator' (o rol en app_metadata).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rutas_promotoras'
      AND policyname = 'rutas_promotoras_select_isolated'
  ) THEN
    CREATE POLICY rutas_promotoras_select_isolated
      ON public.rutas_promotoras
      FOR SELECT
      TO anon, authenticated
      USING (
        -- 1. Sesión Supabase Auth de la promotora (aislamiento por email verificado)
        (
          (SELECT auth.uid()) IS NOT NULL
          AND lower(promotora_email) = lower(COALESCE((SELECT auth.jwt() ->> 'email'), ''))
        )
        OR
        -- 2. Sesión Supabase Auth con rol supervisor / coordinadora en app_metadata
        (
          (SELECT auth.uid()) IS NOT NULL
          AND COALESCE((SELECT auth.jwt() -> 'app_metadata' ->> 'role'), '') IN (
            'jefe_trade', 'coordinadora_trade', 'supervisor', 'gerente_admin'
          )
        )
        OR
        -- 3. App de Promotoras autenticada contra public.staff (aislamiento estricto por UUID de su perfil)
        (
          promotora_id::text = COALESCE(
            NULLIF((SELECT (current_setting('request.headers', true)::jsonb ->> 'x-promotora-id')), ''),
            '00000000-0000-0000-0000-000000000000'
          )
        )
        OR
        -- 4. Torre de Control / Coordinadora Trade Marketing con cabecera explícita
        (
          COALESCE((SELECT (current_setting('request.headers', true)::jsonb ->> 'x-codizulca-scope')), '') = 'trade_coordinator'
        )
      );
  END IF;

  -- Escritura en rutas_promotoras para sincronización transaccional del trigger y check-in/out de la promotora propietaria
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rutas_promotoras'
      AND policyname = 'rutas_promotoras_write_sync_and_owner'
  ) THEN
    CREATE POLICY rutas_promotoras_write_sync_and_owner
      ON public.rutas_promotoras
      FOR ALL
      TO anon, authenticated
      USING (
        COALESCE((SELECT (current_setting('request.headers', true)::jsonb ->> 'x-codizulca-scope')), '') = 'trade_coordinator'
        OR promotora_id::text = COALESCE(
          NULLIF((SELECT (current_setting('request.headers', true)::jsonb ->> 'x-promotora-id')), ''),
          '00000000-0000-0000-0000-000000000000'
        )
        OR (
          (SELECT auth.uid()) IS NOT NULL
          AND lower(promotora_email) = lower(COALESCE((SELECT auth.jwt() ->> 'email'), ''))
        )
      )
      WITH CHECK (
        COALESCE((SELECT (current_setting('request.headers', true)::jsonb ->> 'x-codizulca-scope')), '') = 'trade_coordinator'
        OR promotora_id::text = COALESCE(
          NULLIF((SELECT (current_setting('request.headers', true)::jsonb ->> 'x-promotora-id')), ''),
          '00000000-0000-0000-0000-000000000000'
        )
        OR (
          (SELECT auth.uid()) IS NOT NULL
          AND lower(promotora_email) = lower(COALESCE((SELECT auth.jwt() ->> 'email'), ''))
        )
      );
  END IF;
END $$;

COMMIT;
