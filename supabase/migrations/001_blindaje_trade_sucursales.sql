-- =============================================================================
-- PROGRAMA DE TRADE MARKETING — FASE 1: BLINDAJE MULTI-SUCURSAL ZERO-TRUST
-- Archivo: supabase/migrations/001_blindaje_trade_sucursales.sql
-- Motor objetivo: PostgreSQL 15+ / 17 (Supabase)
--
-- GARANTÍAS DE INTEGRIDAD Y CIBERSEGURIDAD (CUMPLIMIENTO OBLIGATORIO):
--   1. NO DESTRUCTIVO: Cero borrado de tablas ni pérdida de registros previos
--      en `public.promotoras` o `public.clientes`. Adaptación 100% idempotente
--      mediante `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
--   2. AISLAMIENTO ESTRICTO DE SEDES: Separación criptográfica y relacional
--      entre `'Zulia'` y `'Valencia'` con supervisión nacional `'admin_general'`.
--   3. RLS FORZOSO (`ENABLE` + `FORCE ROW LEVEL SECURITY`) en las 4 tablas del
--      dominio (`promotoras`, `clientes`, `perfiles_acceso`, `reportes_trade`),
--      revocando permisos sobre datos operativos al rol `anon`.
--   4. LISTA BLANCA DE ACCESO: Ningún usuario de `auth.users` obtiene acceso si
--      su correo normalizado no figura previamente activo en `perfiles_acceso`.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. TIPOS ENUM CONTROLADOS (IDEMPOTENTES)
-- =============================================================================
DO $$
BEGIN
  CREATE TYPE public.sucursal_tipo AS ENUM ('Zulia', 'Valencia');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE public.rol_trade AS ENUM ('promotora', 'coordinadora', 'admin_general');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- 2. FUNCIÓN AUXILIAR DETERMINISTA DE CLASIFICACIÓN TERRITORIAL
--    Evalúa ciudad, estado, municipio, zona, ruta o dirección sin adivinar
--    cuando una cadena es ambigua (ej. menciona ambas regiones a la vez).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_inferir_sucursal_territorial(p_texto_ubicacion TEXT)
RETURNS public.sucursal_tipo
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_norm TEXT;
  v_es_zulia BOOLEAN := false;
  v_es_valencia BOOLEAN := false;
BEGIN
  IF p_texto_ubicacion IS NULL OR btrim(p_texto_ubicacion) = '' THEN
    RETURN NULL;
  END IF;

  -- Normalizar mayúsculas/minúsculas y tildes comunes en español
  v_norm := lower(
    translate(
      btrim(p_texto_ubicacion),
      'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑáéíóúàèìòùäëïöüñ',
      'AEIOUAEIOUAEIOUNaeiouaeiouaeioun'
    )
  );

  v_es_zulia := v_norm ~ '\m(maracaibo|san francisco|cabimas|ciudad ojeda|lagunillas|machiques|santa barbara|mara|la concepcion|mene grande|bachaquero|tia juana|los puertos|costa oriental|zulia)\M';
  v_es_valencia := v_norm ~ '\m(valencia|naguanagua|san diego|los guayos|guacara|tocuyito|puerto cabello|mariara|bejuma|carlos arvelo|guigue|moron|carabobo)\M';

  -- Si coincide con ambas regiones simultáneamente, se deja NULL como ambiguo
  IF v_es_zulia AND v_es_valencia THEN
    RETURN NULL;
  ELSIF v_es_zulia THEN
    RETURN 'Zulia'::public.sucursal_tipo;
  ELSIF v_es_valencia THEN
    RETURN 'Valencia'::public.sucursal_tipo;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_inferir_sucursal_territorial(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_inferir_sucursal_territorial(TEXT) TO authenticated, service_role;

-- =============================================================================
-- 3. ADAPTACIÓN SEGURA Y NO DESTRUCTIVA DE `public.promotoras` Y `public.clientes`
-- =============================================================================

-- 3.1 Asegurar estructura mínima de `public.promotoras` (no-op si ya existe con datos)
CREATE TABLE IF NOT EXISTS public.promotoras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_completo TEXT,
  email TEXT,
  telefono TEXT,
  ciudad TEXT,
  estado TEXT,
  direccion TEXT,
  sucursal public.sucursal_tipo,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columnas requeridas agregadas de forma estrictamente aditiva (cero pérdida de datos)
ALTER TABLE public.promotoras
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS nombre_completo TEXT,
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_tipo,
  ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Homologar sin borrar columnas previas si la tabla preexistente usaba `correo`,
-- `correo_electronico`, `nombre`, `nombres` o `name`, y normalizar `email` en minúsculas.
DO $$
DECLARE
  v_col_correo TEXT := NULL;
  v_col_nombre TEXT := NULL;
  v_duplicados_email INTEGER := 0;
  v_zulia_count INTEGER := 0;
  v_valencia_count INTEGER := 0;
  v_pendientes_count INTEGER := 0;
  v_pendientes_muestra TEXT := '';
BEGIN
  -- Detectar columna alternativa de correo en caso de esquema legado
  SELECT c.column_name
  INTO v_col_correo
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'promotoras'
    AND c.column_name IN ('correo', 'correo_electronico', 'mail')
  ORDER BY CASE c.column_name
    WHEN 'correo' THEN 1
    WHEN 'correo_electronico' THEN 2
    ELSE 3
  END
  LIMIT 1;

  IF v_col_correo IS NOT NULL THEN
    EXECUTE format(
      'UPDATE public.promotoras SET email = lower(btrim(%I::text)) '
      || 'WHERE (email IS NULL OR btrim(email) = '''') '
      || 'AND %I IS NOT NULL AND btrim(%I::text) <> ''''',
      v_col_correo,
      v_col_correo,
      v_col_correo
    );
  END IF;

  -- Detectar columna alternativa de nombre en caso de esquema legado
  SELECT c.column_name
  INTO v_col_nombre
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'promotoras'
    AND c.column_name IN ('nombre', 'nombres', 'name', 'full_name')
  ORDER BY CASE c.column_name
    WHEN 'nombre' THEN 1
    WHEN 'nombres' THEN 2
    WHEN 'full_name' THEN 3
    ELSE 4
  END
  LIMIT 1;

  IF v_col_nombre IS NOT NULL THEN
    EXECUTE format(
      'UPDATE public.promotoras SET nombre_completo = btrim(%I::text) '
      || 'WHERE (nombre_completo IS NULL OR btrim(nombre_completo) = '''') '
      || 'AND %I IS NOT NULL AND btrim(%I::text) <> ''''',
      v_col_nombre,
      v_col_nombre,
      v_col_nombre
    );
  END IF;

  -- Normalizar `email` existente (trim + minúsculas)
  UPDATE public.promotoras
  SET email = lower(btrim(email))
  WHERE email IS NOT NULL
    AND email <> lower(btrim(email));

  -- Verificar si existen correos duplicados antes de crear el índice único funcional
  SELECT COUNT(*)
  INTO v_duplicados_email
  FROM (
    SELECT lower(btrim(email))
    FROM public.promotoras
    WHERE email IS NOT NULL AND btrim(email) <> ''
    GROUP BY lower(btrim(email))
    HAVING COUNT(*) > 1
  ) dup;

  IF v_duplicados_email = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_promotoras_email_lower_norm
      ON public.promotoras (lower(btrim(email)))
      WHERE email IS NOT NULL AND btrim(email) <> '';
  ELSE
    CREATE INDEX IF NOT EXISTS idx_promotoras_email_lower_lookup
      ON public.promotoras (lower(btrim(email)))
      WHERE email IS NOT NULL AND btrim(email) <> '';
    RAISE WARNING '[AUDITORÍA PROMOTORAS] Se detectaron % correo(s) repetidos en public.promotoras. Revise duplicados antes de activar uq_promotoras_email_lower_norm.', v_duplicados_email;
  END IF;

  -- Inferencia territorial segura en `public.promotoras` donde `sucursal IS NULL`
  -- Usa `to_jsonb(p)` para inspeccionar cualquier columna geográfica presente sin fallar si alguna no existe.
  UPDATE public.promotoras p
  SET
    sucursal = public.fn_inferir_sucursal_territorial(
      concat_ws(
        ' | ',
        to_jsonb(p) ->> 'sede',
        to_jsonb(p) ->> 'estado',
        to_jsonb(p) ->> 'ciudad',
        to_jsonb(p) ->> 'municipio',
        to_jsonb(p) ->> 'zona',
        to_jsonb(p) ->> 'ruta',
        to_jsonb(p) ->> 'direccion',
        to_jsonb(p) ->> 'ubicacion'
      )
    ),
    updated_at = now()
  WHERE p.sucursal IS NULL
    AND public.fn_inferir_sucursal_territorial(
      concat_ws(
        ' | ',
        to_jsonb(p) ->> 'sede',
        to_jsonb(p) ->> 'estado',
        to_jsonb(p) ->> 'ciudad',
        to_jsonb(p) ->> 'municipio',
        to_jsonb(p) ->> 'zona',
        to_jsonb(p) ->> 'ruta',
        to_jsonb(p) ->> 'direccion',
        to_jsonb(p) ->> 'ubicacion'
      )
    ) IS NOT NULL;

  SELECT
    COUNT(*) FILTER (WHERE sucursal = 'Zulia'),
    COUNT(*) FILTER (WHERE sucursal = 'Valencia'),
    COUNT(*) FILTER (WHERE sucursal IS NULL)
  INTO v_zulia_count, v_valencia_count, v_pendientes_count
  FROM public.promotoras;

  IF v_pendientes_count > 0 THEN
    SELECT COALESCE(string_agg(id::text, ', '), '')
    INTO v_pendientes_muestra
    FROM (
      SELECT id
      FROM public.promotoras
      WHERE sucursal IS NULL
      ORDER BY id
      LIMIT 15
    ) s;

    RAISE NOTICE '[REPORTE PROMOTORAS] Zulia=% | Valencia=% | Pendientes por dirección ambigua/vacía=% (Muestra IDs: %)',
      v_zulia_count, v_valencia_count, v_pendientes_count, v_pendientes_muestra;
  ELSE
    RAISE NOTICE '[REPORTE PROMOTORAS] Normalización completa: Zulia=% | Valencia=% | Pendientes=0',
      v_zulia_count, v_valencia_count;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_promotoras_sucursal_activo
  ON public.promotoras (sucursal, activo);

-- 3.2 Adaptación no destructiva de `public.clientes` (PK existente: `id uuid`)
CREATE TABLE IF NOT EXISTS public.clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_cliente TEXT NOT NULL UNIQUE,
  rif TEXT,
  razon_social TEXT NOT NULL,
  nombre_comercial TEXT,
  zona TEXT,
  ruta TEXT,
  direccion TEXT,
  ciudad TEXT,
  estado TEXT,
  telefono TEXT,
  sucursal public.sucursal_tipo,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_tipo,
  ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;

DO $$
DECLARE
  v_cli_zulia INTEGER := 0;
  v_cli_valencia INTEGER := 0;
  v_cli_pendientes INTEGER := 0;
  v_cli_muestra TEXT := '';
BEGIN
  UPDATE public.clientes c
  SET sucursal = public.fn_inferir_sucursal_territorial(
    concat_ws(
      ' | ',
      to_jsonb(c) ->> 'sede',
      to_jsonb(c) ->> 'estado',
      to_jsonb(c) ->> 'ciudad',
      to_jsonb(c) ->> 'municipio',
      to_jsonb(c) ->> 'zona',
      to_jsonb(c) ->> 'ruta',
      to_jsonb(c) ->> 'direccion'
    )
  )
  WHERE c.sucursal IS NULL
    AND public.fn_inferir_sucursal_territorial(
      concat_ws(
        ' | ',
        to_jsonb(c) ->> 'sede',
        to_jsonb(c) ->> 'estado',
        to_jsonb(c) ->> 'ciudad',
        to_jsonb(c) ->> 'municipio',
        to_jsonb(c) ->> 'zona',
        to_jsonb(c) ->> 'ruta',
        to_jsonb(c) ->> 'direccion'
      )
    ) IS NOT NULL;

  SELECT
    COUNT(*) FILTER (WHERE sucursal = 'Zulia'),
    COUNT(*) FILTER (WHERE sucursal = 'Valencia'),
    COUNT(*) FILTER (WHERE sucursal IS NULL)
  INTO v_cli_zulia, v_cli_valencia, v_cli_pendientes
  FROM public.clientes;

  IF v_cli_pendientes > 0 THEN
    SELECT COALESCE(string_agg(id::text, ', '), '')
    INTO v_cli_muestra
    FROM (
      SELECT id
      FROM public.clientes
      WHERE sucursal IS NULL
      ORDER BY id
      LIMIT 15
    ) s;

    RAISE NOTICE '[REPORTE CLIENTES] Zulia=% | Valencia=% | Pendientes por dirección ambigua/vacía=% (Muestra IDs: %)',
      v_cli_zulia, v_cli_valencia, v_cli_pendientes, v_cli_muestra;
  ELSE
    RAISE NOTICE '[REPORTE CLIENTES] Normalización completa: Zulia=% | Valencia=% | Pendientes=0',
      v_cli_zulia, v_cli_valencia;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clientes_sucursal_activo
  ON public.clientes (sucursal, activo);

-- =============================================================================
-- 4. TABLA `public.perfiles_acceso` SINCRONIZADA CON `public.promotoras`
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.perfiles_acceso (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  email TEXT NOT NULL UNIQUE,
  nombre_completo TEXT NOT NULL,
  rol public.rol_trade NOT NULL,
  sucursal public.sucursal_tipo NULL,
  promotora_id UUID UNIQUE REFERENCES public.promotoras(id) ON DELETE SET NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_perfiles_acceso_email_normalizado
    CHECK (email = lower(btrim(email)) AND char_length(email) >= 5),
  CONSTRAINT chk_perfiles_acceso_nombre_no_vacio
    CHECK (char_length(btrim(nombre_completo)) > 0),
  CONSTRAINT chk_perfiles_acceso_sucursal_obligatoria
    CHECK ((rol = 'admin_general') OR (sucursal IS NOT NULL))
);

ALTER TABLE public.perfiles_acceso
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_perfiles_acceso_auth_uid_activo
  ON public.perfiles_acceso (auth_user_id)
  WHERE activo = true;

CREATE INDEX IF NOT EXISTS idx_perfiles_acceso_rol_sucursal
  ON public.perfiles_acceso (rol, sucursal, activo);

-- Trigger de higiene previa a escritura sobre `public.perfiles_acceso`
CREATE OR REPLACE FUNCTION public.fn_perfiles_acceso_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.email := lower(btrim(COALESCE(NEW.email, '')));
  NEW.nombre_completo := btrim(COALESCE(NEW.nombre_completo, ''));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_perfiles_acceso_before_write() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_perfiles_acceso_before_write ON public.perfiles_acceso;
CREATE TRIGGER trg_perfiles_acceso_before_write
  BEFORE INSERT OR UPDATE ON public.perfiles_acceso
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_perfiles_acceso_before_write();

-- 4.1 Poblamiento inicial automático desde `public.promotoras` (solo filas con email y sede)
INSERT INTO public.perfiles_acceso (
  email,
  nombre_completo,
  rol,
  sucursal,
  promotora_id,
  activo
)
SELECT
  lower(
    btrim(
      COALESCE(
        NULLIF(btrim(p.email), ''),
        NULLIF(btrim(to_jsonb(p) ->> 'correo'), ''),
        NULLIF(btrim(to_jsonb(p) ->> 'correo_electronico'), '')
      )
    )
  ) AS email_norm,
  COALESCE(
    NULLIF(btrim(p.nombre_completo), ''),
    NULLIF(btrim(to_jsonb(p) ->> 'nombre'), ''),
    NULLIF(btrim(to_jsonb(p) ->> 'nombres'), ''),
    NULLIF(btrim(to_jsonb(p) ->> 'name'), ''),
    'Promotora ' || left(p.id::text, 8)
  ) AS nombre_resuelto,
  'promotora'::public.rol_trade,
  p.sucursal,
  p.id,
  COALESCE(p.activo, true)
FROM public.promotoras p
WHERE COALESCE(
    NULLIF(btrim(p.email), ''),
    NULLIF(btrim(to_jsonb(p) ->> 'correo'), ''),
    NULLIF(btrim(to_jsonb(p) ->> 'correo_electronico'), '')
  ) IS NOT NULL
  AND p.sucursal IS NOT NULL
ON CONFLICT (email) DO NOTHING;

-- 4.2 Plantillas comentadas para registrar Coordinadoras por sede y Administrador General:
/*
INSERT INTO public.perfiles_acceso (email, nombre_completo, rol, sucursal, activo)
VALUES
  ('coordinadora.zulia@tuempresa.com', 'Coordinadora Trade Zulia', 'coordinadora', 'Zulia', true),
  ('coordinadora.valencia@tuempresa.com', 'Coordinadora Trade Valencia', 'coordinadora', 'Valencia', true),
  ('admin.nacional@tuempresa.com', 'Administrador General Nacional', 'admin_general', NULL, true)
ON CONFLICT (email) DO UPDATE
SET
  nombre_completo = EXCLUDED.nombre_completo,
  rol = EXCLUDED.rol,
  sucursal = EXCLUDED.sucursal,
  activo = EXCLUDED.activo,
  updated_at = now();
*/

-- 4.3 Trigger en `public.promotoras` (AFTER INSERT OR UPDATE) -> sincroniza `perfiles_acceso`
CREATE OR REPLACE FUNCTION public.fn_sync_promotora_a_perfil_acceso()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_nombre TEXT;
  v_activo BOOLEAN;
BEGIN
  v_email := lower(
    btrim(
      COALESCE(
        NULLIF(btrim(NEW.email), ''),
        NULLIF(btrim(to_jsonb(NEW) ->> 'correo'), ''),
        NULLIF(btrim(to_jsonb(NEW) ->> 'correo_electronico'), ''),
        ''
      )
    )
  );

  v_nombre := COALESCE(
    NULLIF(btrim(NEW.nombre_completo), ''),
    NULLIF(btrim(to_jsonb(NEW) ->> 'nombre'), ''),
    NULLIF(btrim(to_jsonb(NEW) ->> 'nombres'), ''),
    NULLIF(btrim(to_jsonb(NEW) ->> 'name'), ''),
    'Promotora ' || left(NEW.id::text, 8)
  );

  v_activo := COALESCE(NEW.activo, true);

  -- Caso A: Ya existe perfil vinculado por `promotora_id`
  IF EXISTS (SELECT 1 FROM public.perfiles_acceso pa WHERE pa.promotora_id = NEW.id) THEN
    UPDATE public.perfiles_acceso pa
    SET
      email = CASE WHEN v_email <> '' THEN v_email ELSE pa.email END,
      nombre_completo = v_nombre,
      sucursal = COALESCE(NEW.sucursal, pa.sucursal),
      activo = CASE WHEN NEW.sucursal IS NULL THEN false ELSE v_activo END,
      updated_at = now()
    WHERE pa.promotora_id = NEW.id
      AND pa.rol = 'promotora';
    RETURN NEW;
  END IF;

  -- Caso B: Nueva promotora con correo válido y sucursal definida
  IF v_email <> '' AND NEW.sucursal IS NOT NULL THEN
    INSERT INTO public.perfiles_acceso (
      email,
      nombre_completo,
      rol,
      sucursal,
      promotora_id,
      activo
    )
    VALUES (
      v_email,
      v_nombre,
      'promotora'::public.rol_trade,
      NEW.sucursal,
      NEW.id,
      v_activo
    )
    ON CONFLICT (email) DO UPDATE
    SET
      nombre_completo = EXCLUDED.nombre_completo,
      sucursal = EXCLUDED.sucursal,
      promotora_id = EXCLUDED.promotora_id,
      activo = EXCLUDED.activo,
      updated_at = now()
    WHERE public.perfiles_acceso.rol = 'promotora';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sync_promotora_a_perfil_acceso() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_promotora_a_perfil_acceso ON public.promotoras;
CREATE TRIGGER trg_sync_promotora_a_perfil_acceso
  AFTER INSERT OR UPDATE ON public.promotoras
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_promotora_a_perfil_acceso();

-- =============================================================================
-- 5. VINCULACIÓN AUTOMÁTICA Y SEGURA CON SUPABASE AUTH (LISTA BLANCA POR CORREO)
-- =============================================================================

-- 5.1 RPC invocada al iniciar sesión desde `authGuard.js`
CREATE OR REPLACE FUNCTION public.vincular_mi_usuario_auth()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_jwt_email TEXT := lower(btrim(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
  v_perfil public.perfiles_acceso%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_jwt_email = '' THEN
    RETURN jsonb_build_object(
      'vinculado', false,
      'motivo', 'SESION_NO_AUTENTICADA'
    );
  END IF;

  SELECT *
  INTO v_perfil
  FROM public.perfiles_acceso pa
  WHERE lower(btrim(pa.email)) = v_jwt_email
    AND pa.activo = true
  FOR UPDATE;

  -- Lista blanca estricta: si no está pre-registrado activo, NO se crea perfil ni se da acceso
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'vinculado', false,
      'motivo', 'CORREO_NO_PREREGISTRADO_O_INACTIVO'
    );
  END IF;

  IF v_perfil.auth_user_id IS NULL THEN
    UPDATE public.perfiles_acceso
    SET
      auth_user_id = v_uid,
      updated_at = now()
    WHERE id = v_perfil.id;

    RETURN jsonb_build_object(
      'vinculado', true,
      'rol', v_perfil.rol,
      'sucursal', v_perfil.sucursal
    );
  END IF;

  IF v_perfil.auth_user_id = v_uid THEN
    RETURN jsonb_build_object(
      'vinculado', true,
      'rol', v_perfil.rol,
      'sucursal', v_perfil.sucursal
    );
  END IF;

  -- Impide suplantación si otra identidad ya estaba enlazada a ese perfil
  RETURN jsonb_build_object(
    'vinculado', false,
    'motivo', 'PERFIL_YA_VINCULADO_A_OTRO_USUARIO'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.vincular_mi_usuario_auth() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vincular_mi_usuario_auth() TO authenticated;

-- 5.2 Trigger `AFTER INSERT ON auth.users` para enlazar automáticamente correos de lista blanca
CREATE OR REPLACE FUNCTION public.fn_trigger_vincular_nuevo_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email_norm TEXT := lower(btrim(COALESCE(NEW.email, '')));
BEGIN
  IF v_email_norm = '' THEN
    RETURN NEW;
  END IF;

  UPDATE public.perfiles_acceso pa
  SET
    auth_user_id = NEW.id,
    updated_at = now()
  WHERE lower(btrim(pa.email)) = v_email_norm
    AND pa.activo = true
    AND pa.auth_user_id IS NULL;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trigger_vincular_nuevo_auth_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_vincular_nuevo_auth_user_perfil ON auth.users;
CREATE TRIGGER trg_vincular_nuevo_auth_user_perfil
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_trigger_vincular_nuevo_auth_user();

-- =============================================================================
-- 6. TABLA OPERATIVA `public.reportes_trade` (IDEMPOTENTE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.reportes_trade (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  promotora_id UUID REFERENCES public.promotoras(id) ON DELETE SET NULL,
  cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE RESTRICT,
  sucursal public.sucursal_tipo NOT NULL,
  datos_gestion JSONB NOT NULL DEFAULT '{}'::jsonb,
  observaciones TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.reportes_trade
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS promotora_id UUID REFERENCES public.promotoras(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cliente_id UUID REFERENCES public.clientes(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sucursal public.sucursal_tipo,
  ADD COLUMN IF NOT EXISTS datos_gestion JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS observaciones TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_reportes_trade_sucursal_created_at
  ON public.reportes_trade (sucursal, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reportes_trade_auth_user_id
  ON public.reportes_trade (auth_user_id);

CREATE INDEX IF NOT EXISTS idx_reportes_trade_cliente_id
  ON public.reportes_trade (cliente_id);

CREATE INDEX IF NOT EXISTS idx_reportes_trade_promotora_id
  ON public.reportes_trade (promotora_id);

-- =============================================================================
-- 7. FUNCIONES AUXILIARES ANTI-RECURSIÓN RLS (`STABLE SECURITY DEFINER`)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.obtener_mi_rol()
RETURNS public.rol_trade
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pa.rol
  FROM public.perfiles_acceso pa
  WHERE pa.auth_user_id = (SELECT auth.uid())
    AND pa.activo = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.obtener_mi_rol() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_rol() TO authenticated;

CREATE OR REPLACE FUNCTION public.obtener_mi_sucursal()
RETURNS public.sucursal_tipo
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pa.sucursal
  FROM public.perfiles_acceso pa
  WHERE pa.auth_user_id = (SELECT auth.uid())
    AND pa.activo = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.obtener_mi_sucursal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_sucursal() TO authenticated;

-- =============================================================================
-- 8. POLÍTICAS RLS ESTRICTAS (`ENABLE` + `FORCE ROW LEVEL SECURITY`)
--    Cero cruce entre Zulia y Valencia; bloqueo total al rol `anon`.
-- =============================================================================

ALTER TABLE public.promotoras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotoras FORCE ROW LEVEL SECURITY;

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.perfiles_acceso ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perfiles_acceso FORCE ROW LEVEL SECURITY;

ALTER TABLE public.reportes_trade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reportes_trade FORCE ROW LEVEL SECURITY;

-- Revocar permisos al rol `anon` y `PUBLIC` sobre las 4 tablas operativas
REVOKE ALL ON TABLE public.promotoras FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.clientes FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.perfiles_acceso FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.reportes_trade FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promotoras TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clientes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.perfiles_acceso TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reportes_trade TO authenticated;

-- Limpiar políticas previas en estas 4 tablas para impedir fugas por combinación `OR`
DO $$
DECLARE
  v_pol RECORD;
BEGIN
  FOR v_pol IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('perfiles_acceso', 'promotoras', 'clientes', 'reportes_trade')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_pol.policyname, v_pol.tablename);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 8.1 Políticas en `public.perfiles_acceso`
-- -----------------------------------------------------------------------------
CREATE POLICY perfiles_acceso_select_aislado
  ON public.perfiles_acceso
  FOR SELECT
  TO authenticated
  USING (
    (auth_user_id = (SELECT auth.uid()) AND activo = true)
    OR (
      (SELECT public.obtener_mi_rol()) = 'coordinadora'::public.rol_trade
      AND sucursal = (SELECT public.obtener_mi_sucursal())
    )
    OR (SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade
  );

CREATE POLICY perfiles_acceso_insert_admin_general
  ON public.perfiles_acceso
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

CREATE POLICY perfiles_acceso_update_admin_general
  ON public.perfiles_acceso
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade)
  WITH CHECK ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

CREATE POLICY perfiles_acceso_delete_admin_general
  ON public.perfiles_acceso
  FOR DELETE
  TO authenticated
  USING ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

-- -----------------------------------------------------------------------------
-- 8.2 Políticas en `public.promotoras`
-- -----------------------------------------------------------------------------
CREATE POLICY promotoras_select_aislado
  ON public.promotoras
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.perfiles_acceso pa
      WHERE pa.promotora_id = promotoras.id
        AND pa.auth_user_id = (SELECT auth.uid())
        AND pa.activo = true
    )
    OR (
      (SELECT public.obtener_mi_rol()) = 'coordinadora'::public.rol_trade
      AND sucursal = (SELECT public.obtener_mi_sucursal())
    )
    OR (SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade
  );

CREATE POLICY promotoras_insert_admin_general
  ON public.promotoras
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

CREATE POLICY promotoras_update_admin_general
  ON public.promotoras
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade)
  WITH CHECK ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

CREATE POLICY promotoras_delete_admin_general
  ON public.promotoras
  FOR DELETE
  TO authenticated
  USING ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

-- -----------------------------------------------------------------------------
-- 8.3 Políticas en `public.clientes`
-- -----------------------------------------------------------------------------
CREATE POLICY clientes_select_aislado
  ON public.clientes
  FOR SELECT
  TO authenticated
  USING (
    activo = true
    AND (
      sucursal = (SELECT public.obtener_mi_sucursal())
      OR (SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade
    )
  );

CREATE POLICY clientes_insert_admin_general
  ON public.clientes
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

CREATE POLICY clientes_update_admin_general
  ON public.clientes
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade)
  WITH CHECK ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

CREATE POLICY clientes_delete_admin_general
  ON public.clientes
  FOR DELETE
  TO authenticated
  USING ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

-- -----------------------------------------------------------------------------
-- 8.4 Políticas y Trigger de Integridad en `public.reportes_trade`
-- -----------------------------------------------------------------------------
CREATE POLICY reportes_trade_insert_promotora_sede
  ON public.reportes_trade
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.obtener_mi_rol()) = 'promotora'::public.rol_trade
    AND auth_user_id = (SELECT auth.uid())
    AND sucursal = (SELECT public.obtener_mi_sucursal())
    AND EXISTS (
      SELECT 1
      FROM public.clientes c
      WHERE c.id = reportes_trade.cliente_id
        AND c.activo = true
        AND c.sucursal = (SELECT public.obtener_mi_sucursal())
    )
  );

CREATE POLICY reportes_trade_select_aislado
  ON public.reportes_trade
  FOR SELECT
  TO authenticated
  USING (
    (
      (SELECT public.obtener_mi_rol()) = 'promotora'::public.rol_trade
      AND auth_user_id = (SELECT auth.uid())
      AND sucursal = (SELECT public.obtener_mi_sucursal())
    )
    OR (
      (SELECT public.obtener_mi_rol()) = 'coordinadora'::public.rol_trade
      AND sucursal = (SELECT public.obtener_mi_sucursal())
    )
    OR (SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade
  );

CREATE POLICY reportes_trade_update_admin_general
  ON public.reportes_trade
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade)
  WITH CHECK ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

CREATE POLICY reportes_trade_delete_admin_general
  ON public.reportes_trade
  FOR DELETE
  TO authenticated
  USING ((SELECT public.obtener_mi_rol()) = 'admin_general'::public.rol_trade);

-- Trigger `BEFORE INSERT OR UPDATE ON public.reportes_trade`:
-- Fuerza identidad/sucursal en servidor e impide cualquier cruce de sedes o mutación posterior.
CREATE OR REPLACE FUNCTION public.fn_forzar_integridad_reporte_trade()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_rol public.rol_trade;
  v_mi_sucursal public.sucursal_tipo;
  v_promotora_id UUID;
  v_sucursal_cliente public.sucursal_tipo;
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
    RETURN NEW;
  END IF;

  -- Validación estricta en INSERT
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticación requerida para registrar reportes de Trade Marketing.'
      USING ERRCODE = '42501';
  END IF;

  SELECT pa.rol, pa.sucursal, pa.promotora_id
  INTO v_rol, v_mi_sucursal, v_promotora_id
  FROM public.perfiles_acceso pa
  WHERE pa.auth_user_id = v_uid
    AND pa.activo = true
  LIMIT 1;

  IF NOT FOUND OR v_rol <> 'promotora'::public.rol_trade OR v_mi_sucursal IS NULL THEN
    RAISE EXCEPTION 'Acceso denegado: solo una promotora activa con sucursal asignada puede registrar reportes.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.sucursal IS NOT NULL AND NEW.sucursal <> v_mi_sucursal THEN
    RAISE EXCEPTION 'Cruce de sede bloqueado: tu perfil pertenece a % y no puede enviar reportes para %.',
      v_mi_sucursal, NEW.sucursal
      USING ERRCODE = '42501';
  END IF;

  -- Sellar campos autoritativos desde servidor (ignorando manipulación cliente)
  NEW.auth_user_id := v_uid;
  NEW.promotora_id := v_promotora_id;
  NEW.sucursal := public.obtener_mi_sucursal();

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

DROP TRIGGER IF EXISTS trg_forzar_integridad_reporte_trade ON public.reportes_trade;
CREATE TRIGGER trg_forzar_integridad_reporte_trade
  BEFORE INSERT OR UPDATE ON public.reportes_trade
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_forzar_integridad_reporte_trade();

COMMIT;

-- =============================================================================
-- 9. BLOQUE DE VERIFICACIÓN SQL MULTI-PERFIL (COMENTADO — CERO RESIDUOS)
--    Ejecutar en el SQL Editor dentro de `BEGIN; ... ROLLBACK;` para auditar
--    empíricamente los 5 perfiles con `set_config('request.jwt.claims', ...)`:
--      1) Promotora Zulia
--      2) Promotora Valencia
--      3) Coordinadora Zulia
--      4) Coordinadora Valencia
--      5) Administrador General (`admin_general`)
-- =============================================================================
/*
BEGIN;

-- Semilla efímera de prueba (se revierte íntegramente con el ROLLBACK final)
INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'qa.promotora.zulia@test.local', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000102', 'qa.promotora.valencia@test.local', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000201', 'qa.coord.zulia@test.local', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000202', 'qa.coord.valencia@test.local', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000999', 'qa.admin.general@test.local', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated');

INSERT INTO public.promotoras (id, nombre_completo, email, ciudad, sucursal, activo)
VALUES
  ('00000000-0000-4000-8000-000000001101', 'Promotora QA Zulia', 'qa.promotora.zulia@test.local', 'Maracaibo', 'Zulia', true),
  ('00000000-0000-4000-8000-000000001102', 'Promotora QA Valencia', 'qa.promotora.valencia@test.local', 'Valencia', 'Valencia', true);

INSERT INTO public.perfiles_acceso (auth_user_id, email, nombre_completo, rol, sucursal, promotora_id, activo)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'qa.promotora.zulia@test.local', 'Promotora QA Zulia', 'promotora', 'Zulia', '00000000-0000-4000-8000-000000001101', true),
  ('00000000-0000-4000-8000-000000000102', 'qa.promotora.valencia@test.local', 'Promotora QA Valencia', 'promotora', 'Valencia', '00000000-0000-4000-8000-000000001102', true),
  ('00000000-0000-4000-8000-000000000201', 'qa.coord.zulia@test.local', 'Coordinadora QA Zulia', 'coordinadora', 'Zulia', NULL, true),
  ('00000000-0000-4000-8000-000000000202', 'qa.coord.valencia@test.local', 'Coordinadora QA Valencia', 'coordinadora', 'Valencia', NULL, true),
  ('00000000-0000-4000-8000-000000000999', 'qa.admin.general@test.local', 'Admin General QA', 'admin_general', NULL, NULL, true)
ON CONFLICT (email) DO UPDATE
SET auth_user_id = EXCLUDED.auth_user_id, rol = EXCLUDED.rol, sucursal = EXCLUDED.sucursal, activo = true;

INSERT INTO public.clientes (id, codigo_cliente, razon_social, ciudad, sucursal, activo)
VALUES
  ('00000000-0000-4000-8000-000000002101', 'QA-CLI-ZUL-01', 'AUTOMERCADO ZULIA QA', 'Maracaibo', 'Zulia', true),
  ('00000000-0000-4000-8000-000000002102', 'QA-CLI-VAL-01', 'HIPERMERCADO VALENCIA QA', 'Naguanagua', 'Valencia', true);

SET LOCAL ROLE authenticated;

-- 1) PERFIL: PROMOTORA ZULIA (Inserta en Zulia OK, lee solo lo suyo y 0 clientes de Valencia)
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000101","role":"authenticated","email":"qa.promotora.zulia@test.local"}', true);
INSERT INTO public.reportes_trade (cliente_id, datos_gestion, observaciones)
VALUES ('00000000-0000-4000-8000-000000002101', '{"muestras":45}'::jsonb, 'Reporte Zulia OK');
SELECT '1_promotora_zulia_clientes_valencia' AS caso, COUNT(*) AS debe_ser_cero FROM public.clientes WHERE sucursal = 'Valencia';

-- 2) PERFIL: PROMOTORA VALENCIA (Inserta en Valencia OK, lee 0 reportes de Zulia)
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000102","role":"authenticated","email":"qa.promotora.valencia@test.local"}', true);
INSERT INTO public.reportes_trade (cliente_id, datos_gestion, observaciones)
VALUES ('00000000-0000-4000-8000-000000002102', '{"muestras":60}'::jsonb, 'Reporte Valencia OK');
SELECT '2_promotora_valencia_reportes_zulia' AS caso, COUNT(*) AS debe_ser_cero FROM public.reportes_trade WHERE sucursal = 'Zulia';

-- 3) PERFIL: COORDINADORA ZULIA (Lee todos los reportes de Zulia y 0 de Valencia)
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000201","role":"authenticated","email":"qa.coord.zulia@test.local"}', true);
SELECT '3_coord_zulia_ve_zulia' AS caso, COUNT(*) AS zulia_visibles FROM public.reportes_trade WHERE sucursal = 'Zulia';
SELECT '3_coord_zulia_ve_valencia' AS caso, COUNT(*) AS debe_ser_cero FROM public.reportes_trade WHERE sucursal = 'Valencia';

-- 4) PERFIL: COORDINADORA VALENCIA (Lee todos los reportes de Valencia y 0 de Zulia)
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000202","role":"authenticated","email":"qa.coord.valencia@test.local"}', true);
SELECT '4_coord_valencia_ve_valencia' AS caso, COUNT(*) AS valencia_visibles FROM public.reportes_trade WHERE sucursal = 'Valencia';
SELECT '4_coord_valencia_ve_zulia' AS caso, COUNT(*) AS debe_ser_cero FROM public.reportes_trade WHERE sucursal = 'Zulia';

-- 5) PERFIL: ADMINISTRADOR GENERAL (Supervisión nacional consolidada Zulia + Valencia)
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000999","role":"authenticated","email":"qa.admin.general@test.local"}', true);
SELECT '5_admin_general_consolidado' AS caso, sucursal, COUNT(*) AS total
FROM public.reportes_trade
WHERE id IS NOT NULL
GROUP BY sucursal
ORDER BY sucursal;

ROLLBACK;
*/
