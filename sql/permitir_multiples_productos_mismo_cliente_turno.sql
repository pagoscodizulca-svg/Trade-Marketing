-- =============================================================================
-- MIGRACIÓN: 20261212000100_permitir_multiples_productos_mismo_cliente_turno.sql
-- OBJETIVO:
--   Permitir cargar múltiples degustaciones manuales (o por lote) para el MISMO
--   cliente / PDV en la MISMA fecha y jornada cuando correspondan a PRODUCTOS
--   DIFERENTES, sin sobrescribir la degustación existente ni chocar con el
--   índice único o la validación de promotora en el mismo punto de venta.
--
-- SEGURIDAD E IDEMPOTENCIA:
--   - Cero DDL destructivo (sin DROP TABLE, sin DROP COLUMN, sin TRUNCATE).
--   - Mantiene ENABLE + FORCE ROW LEVEL SECURITY y cero acceso para anon.
--   - Reemplaza únicamente el índice único tienda+fecha+turno por
--     tienda+fecha+turno+producto_resumen y actualiza la RPC de matriz y el
--     trigger de validación con SET search_path = public.
-- =============================================================================

-- 1. Índice único parcial por Tienda + Fecha + Turno + Producto (reemplaza el
--    índice legado sin producto que bloqueaba 2 productos distintos en el mismo PDV)
DROP INDEX IF EXISTS public.idx_cronograma_deg_tienda_fecha_turno_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cronograma_deg_tienda_fecha_turno_producto_active
  ON public.cronograma_degustaciones (
    fecha,
    turno,
    lower(btrim(COALESCE(NULLIF(cliente_codigo, ''), cliente_nombre))),
    lower(btrim(COALESCE(producto_resumen, '')))
  )
  WHERE estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA');

-- 2. Trigger de validación: mantiene el bloqueo estricto de doble reserva de
--    promotora entre CLIENTES DIFERENTES en el mismo día/turno, pero permite
--    que una misma promotora (o promotoras distintas) cubran productos distintos
--    dentro del MISMO cliente / PDV en la misma jornada.
CREATE OR REPLACE FUNCTION public.fn_validate_and_enrich_cronograma_degustacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_staff RECORD;
  v_status_json JSONB := '{}'::jsonb;
  v_member_status TEXT := 'Activo';
  v_member_category TEXT := '';
  v_survey RECORD;
  v_survey_comments JSONB := '{}'::jsonb;
  v_survey_estado TEXT := '';
  v_conflict RECORD;
BEGIN
  NEW.updated_at := NOW();
  NEW.idempotency_hash := lower(pg_catalog.btrim(COALESCE(NEW.idempotency_hash, '')));

  IF NEW.idempotency_hash = '' THEN
    RAISE EXCEPTION 'El campo idempotency_hash es obligatorio para registrar la degustación.'
      USING ERRCODE = '23514';
  END IF;

  -- A. Candado de origen validado cuando proviene de solicitud FDV (public.surveys)
  IF NEW.survey_origen_id IS NOT NULL
     AND NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN
    SELECT s.id, s.type, s.comments
    INTO v_survey
    FROM public.surveys s
    WHERE s.id = NEW.survey_origen_id;

    IF NOT FOUND OR COALESCE(v_survey.type, '') <> 'Degustacion' THEN
      RAISE EXCEPTION 'ORIGEN NO VALIDADO: El registro origen (%) no existe o no es una degustación válida.', NEW.survey_origen_id
        USING ERRCODE = '23514';
    END IF;

    BEGIN
      IF v_survey.comments IS NOT NULL AND pg_catalog.btrim(v_survey.comments::text) LIKE '{%' THEN
        v_survey_comments := (v_survey.comments::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_survey_comments := '{}'::jsonb;
    END;

    v_survey_estado := upper(
      pg_catalog.btrim(
        COALESCE(
          v_survey_comments ->> 'estado',
          v_survey_comments ->> 'status',
          ''
        )
      )
    );

    IF v_survey_estado NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA', 'REALIZADA') THEN
      RAISE EXCEPTION 'ORIGEN NO VALIDADO: La degustación FDV (%) tiene estado "%" y debe estar explícitamente en "APROBADA" antes de asignarse a una ruta.',
        NEW.survey_origen_id, COALESCE(NULLIF(v_survey_estado, ''), 'SOLICITADA')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- B. Validación de promotora activa y normalización estricta LOWER(TRIM(email))
  IF NEW.promotora_id IS NOT NULL AND NEW.estado NOT IN ('NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA') THEN
    SELECT id, name, email, role, status
    INTO v_staff
    FROM public.staff
    WHERE id = NEW.promotora_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La promotora seleccionada (%) no existe en public.staff.', NEW.promotora_id
        USING ERRCODE = '23503';
    END IF;

    BEGIN
      IF v_staff.status IS NOT NULL AND pg_catalog.btrim(v_staff.status::text) LIKE '{%' THEN
        v_status_json := (v_staff.status::text)::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_status_json := '{}'::jsonb;
    END;

    v_member_status := COALESCE(v_status_json ->> 'status', 'Activo');
    v_member_category := lower(COALESCE(v_status_json ->> 'category', ''));

    IF lower(pg_catalog.btrim(v_member_status)) = 'inactivo' THEN
      RAISE EXCEPTION 'No se puede asignar la promotora "%" porque figura como Inactiva.', v_staff.name
        USING ERRCODE = '23514';
    END IF;

    IF v_member_category = 'merchandising'
       OR lower(COALESCE(v_staff.role, '')) LIKE '%merchandising%' THEN
      RAISE EXCEPTION 'El perfil "%" pertenece a Merchandising y no puede asignarse a ruta de degustación.', v_staff.name
        USING ERRCODE = '23514';
    END IF;

    NEW.promotora_nombre := pg_catalog.btrim(v_staff.name);
    NEW.promotora_email := lower(pg_catalog.btrim(COALESCE(v_staff.email, '')));

    IF NEW.estado IN ('APROBADA', 'EN_CURSO') AND NEW.promotora_email = '' THEN
      RAISE EXCEPTION 'VALIDACIÓN REQUERIDA: La promotora "%" no tiene correo electrónico registrado en la Pestaña de Personal.', NEW.promotora_nombre
        USING ERRCODE = '23514';
    END IF;

    -- C. Prevención de doble reserva para la misma promotora en DISTINTOS clientes en la misma fecha y turno
    IF NEW.estado IN ('APROBADA', 'EN_CURSO') THEN
      SELECT c.id, c.cliente_nombre, c.turno
      INTO v_conflict
      FROM public.cronograma_degustaciones c
      WHERE c.promotora_id = NEW.promotora_id
        AND c.fecha = NEW.fecha
        AND c.estado IN ('APROBADA', 'EN_CURSO')
        AND c.id IS DISTINCT FROM NEW.id
        AND lower(pg_catalog.btrim(COALESCE(c.cliente_nombre, ''))) <> lower(pg_catalog.btrim(COALESCE(NEW.cliente_nombre, '')))
        AND (
          NEW.turno = 'COMPLETO'
          OR c.turno = 'COMPLETO'
          OR c.turno = NEW.turno
        )
      LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION 'CONFLICTO DE JORNADA: La promotora "%" ya tiene asignada una degustación activa en "%" para el % (jornada %).',
          NEW.promotora_nombre, v_conflict.cliente_nombre, NEW.fecha, v_conflict.turno
          USING ERRCODE = '23505';
      END IF;
    END IF;
  ELSIF NEW.promotora_id IS NULL THEN
    NEW.promotora_nombre := NULL;
    NEW.promotora_email := NULL;

    IF NEW.estado IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN
      RAISE EXCEPTION 'BLOQUEO DE SEGURIDAD: No se puede autorizar ni asignar a ruta sin promotora_id válida.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.estado = 'APROBADA'
     AND (TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM 'APROBADA') THEN
    NEW.fecha_aprobacion := COALESCE(NEW.fecha_aprobacion, NOW());
    NEW.aprobado_por := COALESCE(NULLIF(pg_catalog.btrim(NEW.aprobado_por), ''), 'Coordinadora de Trade Marketing');
    NEW.en_historial := (NEW.fecha < public.fn_hoy_caracas());
  END IF;

  IF NEW.estado IN ('NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA')
     AND (TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM NEW.estado) THEN
    NEW.fecha_rechazo := COALESCE(NEW.fecha_rechazo, NOW());
    NEW.en_historial := TRUE;
    NEW.archivado_en := COALESCE(NEW.archivado_en, NOW());
    NEW.motivo_archivo := COALESCE(NEW.motivo_archivo, NEW.estado);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_validate_and_enrich_cronograma_degustacion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_validate_and_enrich_cronograma_degustacion() TO authenticated, service_role;

-- 3. RPC de persistencia de Módulo 2: distingue degustaciones del mismo cliente
--    y misma jornada por producto (`producto_resumen`) para crear una fila nueva
--    en lugar de sobrescribir la degustación ya cargada de otro producto.
CREATE OR REPLACE FUNCTION public.rpc_upsert_matriz_cronograma_lote(
  p_filas JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_elem JSONB;
  v_actor TEXT;
  v_id UUID;
  v_fecha DATE;
  v_turno TEXT;
  v_hora_inicio TEXT;
  v_hora_fin TEXT;
  v_cliente_nombre TEXT;
  v_cliente_codigo TEXT;
  v_zona_direccion TEXT;
  v_producto_resumen TEXT;
  v_productos JSONB;
  v_cantidad_kilos NUMERIC(10, 2);
  v_personas_estimadas INTEGER;
  v_insumos JSONB;
  v_vendedor_fdv TEXT;
  v_promotora_id UUID;
  v_observaciones TEXT;
  v_sucursal TEXT;
  v_estado TEXT;
  v_hash TEXT;
  v_existing_id UUID;
  v_existing_estado TEXT;
  v_conflict_cliente TEXT;
  v_saved_row public.cronograma_degustaciones%ROWTYPE;
  v_insertadas INTEGER := 0;
  v_actualizadas INTEGER := 0;
  v_resultados JSONB := '[]'::jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Sesión autenticada requerida para persistir la matriz de cronograma.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.is_coordinadora_or_admin()) THEN
    RAISE EXCEPTION 'Permisos insuficientes: se requiere rol coordinacion o super_admin activo para persistir la matriz.'
      USING ERRCODE = '42501';
  END IF;

  IF p_filas IS NULL OR jsonb_typeof(p_filas) <> 'array' THEN
    RAISE EXCEPTION 'El parámetro p_filas debe ser un arreglo JSONB no vacío.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_filas) = 0 OR jsonb_array_length(p_filas) > 300 THEN
    RAISE EXCEPTION 'El lote de la matriz debe contener entre 1 y 300 filas.'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''), 'Coordinación Trade')
  INTO v_actor
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
  LIMIT 1;
  v_actor := COALESCE(v_actor, 'Coordinación Trade');

  FOR v_elem IN SELECT elem FROM jsonb_array_elements(p_filas) AS elem LOOP
    v_id := CASE
      WHEN COALESCE(v_elem ->> 'id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (v_elem ->> 'id')::UUID
      ELSE NULL
    END;

    IF NOT (COALESCE(v_elem ->> 'fecha', '') ~ '^\d{4}-\d{2}-\d{2}$') THEN
      RAISE EXCEPTION 'Fecha inválida en fila de matriz (%). Se requiere formato YYYY-MM-DD.', COALESCE(v_elem ->> 'fecha', 'NULL')
        USING ERRCODE = '22007';
    END IF;
    v_fecha := (v_elem ->> 'fecha')::DATE;

    v_turno := UPPER(BTRIM(COALESCE(v_elem ->> 'turno', 'MAÑANA')));
    IF v_turno = 'MANANA' THEN v_turno := 'MAÑANA'; END IF;
    IF v_turno NOT IN ('MAÑANA', 'TARDE', 'COMPLETO') THEN
      RAISE EXCEPTION 'Turno inválido en matriz (%). Valores permitidos: MAÑANA, TARDE, COMPLETO.', v_turno
        USING ERRCODE = '22023';
    END IF;

    v_hora_inicio := COALESCE(
      NULLIF(BTRIM(COALESCE(v_elem ->> 'hora_inicio', '')), ''),
      CASE v_turno WHEN 'TARDE' THEN '14:00' WHEN 'COMPLETO' THEN '09:00' ELSE '09:00' END
    );
    v_hora_fin := COALESCE(
      NULLIF(BTRIM(COALESCE(v_elem ->> 'hora_fin', '')), ''),
      CASE v_turno WHEN 'TARDE' THEN '18:00' WHEN 'COMPLETO' THEN '17:00' ELSE '13:00' END
    );

    v_cliente_nombre := BTRIM(COALESCE(v_elem ->> 'cliente_nombre', ''));
    IF v_cliente_nombre = '' THEN
      RAISE EXCEPTION 'El nombre del cliente / PDV es obligatorio en cada fila de la matriz.'
        USING ERRCODE = '22023';
    END IF;
    v_cliente_codigo := UPPER(BTRIM(COALESCE(v_elem ->> 'cliente_codigo', '')));
    v_zona_direccion := BTRIM(COALESCE(v_elem ->> 'zona_direccion', ''));

    v_producto_resumen := BTRIM(COALESCE(v_elem ->> 'producto_resumen', ''));
    IF v_producto_resumen = '' THEN
      RAISE EXCEPTION 'El producto principal es obligatorio para el cliente "%".', v_cliente_nombre
        USING ERRCODE = '22023';
    END IF;

    v_productos := CASE
      WHEN jsonb_typeof(v_elem -> 'productos') = 'array' AND jsonb_array_length(v_elem -> 'productos') > 0
      THEN v_elem -> 'productos'
      ELSE jsonb_build_array(v_producto_resumen)
    END;

    v_cantidad_kilos := GREATEST(
      0.10,
      COALESCE(
        CASE WHEN (v_elem ->> 'cantidad_kilos') ~ '^[0-9]+(\.[0-9]+)?$' THEN (v_elem ->> 'cantidad_kilos')::NUMERIC(10, 2) END,
        1.00
      )
    );
    v_personas_estimadas := GREATEST(
      0,
      COALESCE(
        CASE WHEN (v_elem ->> 'personas_estimadas') ~ '^[0-9]+$' THEN (v_elem ->> 'personas_estimadas')::INTEGER END,
        0
      )
    );
    v_insumos := CASE
      WHEN jsonb_typeof(v_elem -> 'insumos_calculados') = 'object' THEN v_elem -> 'insumos_calculados'
      ELSE '{}'::jsonb
    END;
    v_vendedor_fdv := BTRIM(COALESCE(v_elem ->> 'vendedor_fdv', ''));
    v_observaciones := BTRIM(COALESCE(v_elem ->> 'observaciones', ''));

    v_promotora_id := CASE
      WHEN COALESCE(v_elem ->> 'promotora_id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (v_elem ->> 'promotora_id')::UUID
      ELSE NULL
    END;

    v_sucursal := COALESCE(
      public.normalizar_sucursal_multisede(v_elem ->> 'sucursal'),
      public.normalizar_sucursal_multisede(v_elem ->> 'region'),
      public.obtener_mi_sucursal(),
      'OCCIDENTE'
    );

    -- Localizar fila existente por UUID explícito o por slot+producto exacto (cliente + fecha + turno + producto)
    v_existing_id := NULL;
    v_existing_estado := NULL;

    IF v_id IS NOT NULL THEN
      SELECT c.id, c.estado
      INTO v_existing_id, v_existing_estado
      FROM public.cronograma_degustaciones c
      WHERE c.id = v_id
        AND (SELECT public.tiene_acceso_sucursal(c.sucursal))
      LIMIT 1;
    END IF;

    IF v_existing_id IS NULL THEN
      SELECT c.id, c.estado
      INTO v_existing_id, v_existing_estado
      FROM public.cronograma_degustaciones c
      WHERE lower(btrim(c.cliente_nombre)) = lower(v_cliente_nombre)
        AND c.fecha = v_fecha
        AND c.turno = v_turno
        AND lower(btrim(COALESCE(c.producto_resumen, ''))) = lower(v_producto_resumen)
        AND COALESCE(c.en_historial, false) = false
        AND c.estado NOT IN ('RECHAZADA', 'CANCELADA', 'NO_AUTORIZADA')
        AND (SELECT public.tiene_acceso_sucursal(c.sucursal))
      LIMIT 1;
    END IF;

    -- Validar que la promotora no quede duplicada en OTRO cliente en el mismo día y jornada
    IF v_promotora_id IS NOT NULL THEN
      SELECT c.cliente_nombre
      INTO v_conflict_cliente
      FROM public.cronograma_degustaciones c
      WHERE c.promotora_id = v_promotora_id
        AND c.fecha = v_fecha
        AND c.turno = v_turno
        AND COALESCE(c.en_historial, false) = false
        AND c.estado NOT IN ('RECHAZADA', 'CANCELADA', 'NO_AUTORIZADA')
        AND (v_existing_id IS NULL OR c.id <> v_existing_id)
        AND lower(btrim(COALESCE(c.cliente_nombre, ''))) <> lower(v_cliente_nombre)
      LIMIT 1;

      IF v_conflict_cliente IS NOT NULL THEN
        RAISE EXCEPTION 'Conflicto de jornada: la promotora ya está asignada en "%" el % (%).',
          v_conflict_cliente, v_fecha, v_turno
          USING ERRCODE = '23505';
      END IF;
    END IF;

    -- Estado seguro respetando el candado `chk_cronograma_aprobada_requiere_promotora`
    IF v_existing_estado IN ('EN_CURSO', 'COMPLETADA') THEN
      v_estado := v_existing_estado;
    ELSIF v_promotora_id IS NOT NULL THEN
      v_estado := 'APROBADA';
    ELSE
      v_estado := 'PENDIENTE_APROBACION';
    END IF;

    v_hash := lower(btrim(COALESCE(
      NULLIF(BTRIM(COALESCE(v_elem ->> 'idempotency_hash', '')), ''),
      md5(concat_ws('|', v_fecha::text, v_turno, lower(v_cliente_nombre), lower(v_producto_resumen)))
    )));

    IF v_existing_id IS NOT NULL THEN
      UPDATE public.cronograma_degustaciones
      SET
        fecha = v_fecha,
        turno = v_turno,
        hora_inicio = v_hora_inicio,
        hora_fin = v_hora_fin,
        cliente_nombre = v_cliente_nombre,
        cliente_codigo = COALESCE(NULLIF(v_cliente_codigo, ''), cliente_codigo),
        zona_direccion = COALESCE(NULLIF(v_zona_direccion, ''), zona_direccion),
        producto_resumen = v_producto_resumen,
        productos = v_productos,
        cantidad_kilos = v_cantidad_kilos,
        personas_estimadas = v_personas_estimadas,
        insumos_calculados = v_insumos,
        vendedor_fdv = COALESCE(NULLIF(v_vendedor_fdv, ''), vendedor_fdv),
        promotora_id = v_promotora_id,
        observaciones = v_observaciones,
        sucursal = v_sucursal,
        estado = v_estado,
        aprobado_por = CASE WHEN v_estado = 'APROBADA' THEN COALESCE(aprobado_por, v_actor) ELSE aprobado_por END
      WHERE id = v_existing_id
        AND COALESCE(en_historial, false) = false
      RETURNING * INTO v_saved_row;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'No se puede modificar el registro (%) porque ya fue archivado en Historial.', v_existing_id
          USING ERRCODE = '42501';
      END IF;

      v_actualizadas := v_actualizadas + 1;
    ELSE
      INSERT INTO public.cronograma_degustaciones (
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
        promotora_id,
        observaciones,
        sucursal,
        estado,
        aprobado_por
      )
      VALUES (
        v_hash,
        v_fecha,
        v_hora_inicio,
        v_hora_fin,
        v_turno,
        v_cliente_nombre,
        v_cliente_codigo,
        v_zona_direccion,
        v_producto_resumen,
        v_productos,
        v_cantidad_kilos,
        v_personas_estimadas,
        v_insumos,
        v_vendedor_fdv,
        v_promotora_id,
        v_observaciones,
        v_sucursal,
        v_estado,
        CASE WHEN v_estado = 'APROBADA' THEN v_actor ELSE NULL END
      )
      RETURNING * INTO v_saved_row;

      v_insertadas := v_insertadas + 1;
    END IF;

    v_resultados := v_resultados || jsonb_build_object(
      'id', v_saved_row.id,
      'client_temp_id', v_elem ->> 'client_temp_id',
      'cliente_nombre', v_saved_row.cliente_nombre,
      'fecha', v_saved_row.fecha,
      'turno', v_saved_row.turno,
      'estado', v_saved_row.estado,
      'promotora_id', v_saved_row.promotora_id,
      'promotora_nombre', v_saved_row.promotora_nombre,
      'sucursal', v_saved_row.sucursal
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'insertadas', v_insertadas,
    'actualizadas', v_actualizadas,
    'filas', v_resultados
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_upsert_matriz_cronograma_lote(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_matriz_cronograma_lote(JSONB) TO authenticated, service_role;

-- 4. Reafirmación de blindaje RLS, políticas multisede y permisos explícitos (cero anon)
ALTER TABLE public.cronograma_degustaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cronograma_degustaciones FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cronograma_degustaciones FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cronograma_degustaciones TO authenticated;
GRANT ALL ON TABLE public.cronograma_degustaciones TO service_role;

DROP POLICY IF EXISTS rls_multisede_select ON public.cronograma_degustaciones;
DROP POLICY IF EXISTS rls_multisede_insert ON public.cronograma_degustaciones;
DROP POLICY IF EXISTS rls_multisede_update ON public.cronograma_degustaciones;
DROP POLICY IF EXISTS rls_multisede_delete ON public.cronograma_degustaciones;

CREATE POLICY rls_multisede_select
  ON public.cronograma_degustaciones
  FOR SELECT TO authenticated
  USING (
    sucursal = (SELECT public.obtener_mi_sucursal())
    OR (SELECT public.es_admin_nacional())
  );

CREATE POLICY rls_multisede_insert
  ON public.cronograma_degustaciones
  FOR INSERT TO authenticated
  WITH CHECK (
    sucursal = (SELECT public.obtener_mi_sucursal())
    OR (SELECT public.es_admin_nacional())
  );

CREATE POLICY rls_multisede_update
  ON public.cronograma_degustaciones
  FOR UPDATE TO authenticated
  USING (
    sucursal = (SELECT public.obtener_mi_sucursal())
    OR (SELECT public.es_admin_nacional())
  )
  WITH CHECK (
    sucursal = (SELECT public.obtener_mi_sucursal())
    OR (SELECT public.es_admin_nacional())
  );

CREATE POLICY rls_multisede_delete
  ON public.cronograma_degustaciones
  FOR DELETE TO authenticated
  USING (
    sucursal = (SELECT public.obtener_mi_sucursal())
    OR (SELECT public.es_admin_nacional())
  );

NOTIFY pgrst, 'reload schema';
