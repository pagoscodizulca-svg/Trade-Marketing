-- ==============================================================================
-- MIGRACIÓN TRANSACCIONAL E IDEMPOTENTE — AISLAMIENTO MULTISEDE ESTRICTO
-- Sucursales canónicas aisladas al 100%: 'CENTRO' y 'OCCIDENTE'
-- Catálogo Maestro Nacional compartido (SELECT): public.productos / public."Productos"
-- Proyecto objetivo: Trade Marketing CODIZULCA (apaxdgxtaoeyswlfblgi.supabase.co)
--
-- Cubre los 7 Bloques Obligatorios de Arquitectura y Seguridad:
--   BLOQUE 1: public.perfiles_usuarios vinculada a auth.users(id) + public.obtener_mi_sucursal()
--   BLOQUE 2: Catálogo nacional productos + columna sucursal CHECK ('CENTRO','OCCIDENTE') e índices
--   BLOQUE 3: Trigger puente BEFORE INSERT para dashboard-fdv-planificador + cero caídas FDV
--   BLOQUE 4: ENABLE + FORCE ROW LEVEL SECURITY y políticas SELECT/INSERT/UPDATE/DELETE estrictas
--   BLOQUE 5: Enlaces públicos PDV por token único (obtener_datos_pdv_por_token / reportar_ejecucion_pdv)
--   BLOQUE 7: Backfill transaccional Carabobo/Aragua -> 'CENTRO', Occidente -> 'OCCIDENTE' + guarda NOT NULL
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- PREPARACIÓN ADITIVA SEGURA (Evita 42703 / 42P01 en cualquier entorno de Supabase)
-- ==============================================================================

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS regiones_asignadas TEXT[],
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    ALTER TABLE public.promotoras
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS correo TEXT,
      ADD COLUMN IF NOT EXISTS ciudad TEXT,
      ADD COLUMN IF NOT EXISTS estado TEXT,
      ADD COLUMN IF NOT EXISTS direccion TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS categoria TEXT DEFAULT 'Fijas',
      ADD COLUMN IF NOT EXISTS auth_user_id UUID;
  END IF;

  IF to_regclass('public.clientes') IS NOT NULL THEN
    ALTER TABLE public.clientes
      ADD COLUMN IF NOT EXISTS radio_geocerca_m INTEGER DEFAULT 250;
  END IF;

  IF to_regclass('public.surveys') IS NOT NULL THEN
    ALTER TABLE public.surveys
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS autor_user_id UUID,
      ADD COLUMN IF NOT EXISTS promotora_id TEXT,
      ADD COLUMN IF NOT EXISTS en_historial BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS leido_trade BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS degustacion_key TEXT;
  END IF;

  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    ALTER TABLE public.cronograma_degustaciones
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS chofer_sede TEXT,
      ADD COLUMN IF NOT EXISTS degustacion_origen_id UUID,
      ADD COLUMN IF NOT EXISTS en_historial BOOLEAN DEFAULT false;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cronograma_degustaciones_survey_origen_uniq
      ON public.cronograma_degustaciones (survey_origen_id)
      WHERE survey_origen_id IS NOT NULL;
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    ALTER TABLE public.rutas_promotoras
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS auth_user_id UUID;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_rutas_promotoras_cronograma_id_uniq
      ON public.rutas_promotoras (cronograma_id)
      WHERE cronograma_id IS NOT NULL;
  END IF;

  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    ALTER TABLE public.entregas_degustacion
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS chofer_sede TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_entregas_degustacion_cronograma_id_uniq
      ON public.entregas_degustacion (cronograma_id)
      WHERE cronograma_id IS NOT NULL;
  END IF;

  IF to_regclass('public.inventory') IS NOT NULL THEN
    ALTER TABLE public.inventory
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS zona TEXT,
      ADD COLUMN IF NOT EXISTS promotora_id TEXT,
      ADD COLUMN IF NOT EXISTS cronograma_id UUID,
      ADD COLUMN IF NOT EXISTS sales_generated NUMERIC DEFAULT 0,
      ADD COLUMN IF NOT EXISTS client_submission_id UUID;
  END IF;

  IF to_regclass('public.prices') IS NOT NULL THEN
    ALTER TABLE public.prices
      ADD COLUMN IF NOT EXISTS sucursal TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS zona TEXT,
      ADD COLUMN IF NOT EXISTS promotora_id TEXT;
  END IF;
END
$$;

-- Helper seguro para parsear JSON en columnas TEXT (nunca lanza 22P02 ante texto malformado)
CREATE OR REPLACE FUNCTION public.fn_safe_jsonb(p_raw TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_raw IS NULL OR LEFT(BTRIM(p_raw), 1) <> '{' THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN p_raw::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN '{}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_safe_jsonb(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_safe_jsonb(TEXT) TO anon, authenticated, service_role;

-- Helpers seguros de casteo polimórfico (BIGINT / TEXT / UUID sin error 22P02 ni 42883)
CREATE OR REPLACE FUNCTION public.fn_try_uuid(p_raw TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_clean TEXT := BTRIM(COALESCE(p_raw, ''));
BEGIN
  IF v_clean ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN v_clean::uuid;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_try_uuid(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_try_uuid(TEXT) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_try_bigint(p_raw TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_clean TEXT := BTRIM(COALESCE(p_raw, ''));
BEGIN
  IF v_clean ~ '^-?[0-9]+$' THEN
    RETURN v_clean::bigint;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_try_bigint(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_try_bigint(TEXT) TO anon, authenticated, service_role;


-- ==============================================================================
-- BLOQUE 1 — VINCULACIÓN INMUTABLE DE USUARIOS SUPABASE AUTH A SUCURSAL
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.perfiles_usuarios (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  nombre_completo TEXT,
  rol TEXT NOT NULL DEFAULT 'coordinador'
    CHECK (rol IN ('coordinador', 'admin_nacional')),
  sucursal TEXT NOT NULL
    CHECK (sucursal IN ('CENTRO', 'OCCIDENTE')),
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_perfiles_usuarios_sucursal_activo
  ON public.perfiles_usuarios (sucursal, activo);

CREATE INDEX IF NOT EXISTS idx_perfiles_usuarios_email_lower
  ON public.perfiles_usuarios (LOWER(BTRIM(email)));

-- Función pura de normalización binaria hacia el dominio estricto ('CENTRO' | 'OCCIDENTE')
CREATE OR REPLACE FUNCTION public.normalizar_sucursal_multisede(p_raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_clean TEXT;
BEGIN
  v_clean := UPPER(BTRIM(COALESCE(p_raw, '')));
  IF v_clean = '' THEN
    RETURN NULL;
  END IF;

  v_clean := TRANSLATE(v_clean, 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜ', 'AEIOUAEIOUAEIOU');

  IF v_clean IN (
    'CENTRO',
    'SUCURSAL CENTRO',
    'REGION CENTRO',
    'VALENCIA',
    'SUCURSAL VALENCIA',
    'CARABOBO',
    'SAN DIEGO',
    'NAGUANAGUA',
    'GUACARA',
    'TOCUYITO',
    'LOS GUAYOS',
    'ARAGUA',
    'MARACAY',
    'EL SAMAN',
    'TURMERO',
    'CAGUA',
    'CAPITAL',
    'CARACAS',
    'DISTRITO CAPITAL',
    'MIRANDA',
    'COJEDES',
    'GUARICO',
    'ANDES',
    'MERIDA',
    'TACHIRA',
    'BARINAS'
  ) THEN
    RETURN 'CENTRO';
  END IF;

  IF v_clean IN (
    'OCCIDENTE',
    'SUCURSAL OCCIDENTE',
    'REGION OCCIDENTE',
    'ZULIA',
    'SUCURSAL ZULIA',
    'MARACAIBO',
    'SAN FRANCISCO',
    'CABIMAS',
    'CIUDAD OJEDA',
    'LAGUNILLAS',
    'FALCON',
    'CORO',
    'PUNTO FIJO',
    'TRUJILLO',
    'VALERA',
    'LARA',
    'BARQUISIMETO'
  ) THEN
    RETURN 'OCCIDENTE';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.normalizar_sucursal_multisede(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalizar_sucursal_multisede(TEXT) TO anon, authenticated, service_role;

-- Clasificador geográfico/textual exhaustivo para tiendas, rutas, direcciones y comentarios JSON
CREATE OR REPLACE FUNCTION public.fn_inferir_sucursal_geografica(p_texto TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_txt TEXT;
  v_direct TEXT;
BEGIN
  v_direct := public.normalizar_sucursal_multisede(p_texto);
  IF v_direct IS NOT NULL THEN
    RETURN v_direct;
  END IF;

  v_txt := LOWER(TRANSLATE(BTRIM(COALESCE(p_texto, '')), 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜáéíóúàèìòùäëïöü', 'AEIOUAEIOUAEIOUaeiouaeiouaeiou'));
  IF v_txt = '' THEN
    RETURN NULL;
  END IF;

  -- Prioridad explícita sobre tiendas Makro y municipios de Carabobo / Aragua / Centro / Andes
  IF v_txt ~ '(makro\s+(san diego|naguanagua|el saman|saman|turmero|maracay|valencia|la urbina|la yaguara|guarenas|charallave)|\m(san diego|naguanagua|el saman|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|paraparal|puerto cabello|mariara|bejuma|moron|cagua|la victoria|villa de cura|santa cruz|palo negro|el limon|cojedes|san carlos|tinaquillo|guarico|caracas|distrito capital|miranda|la guaira|vargas|tachira|san cristobal|merida|barinas|el vigia|andes|region centro|sucursal centro)\M)' THEN
    RETURN 'CENTRO';
  END IF;

  -- Coincidencias explícitas de Zulia y estados de Occidente
  IF v_txt ~ '(makro\s+(maracaibo|limpia|punto fijo|barquisimeto|cabimas)|\m(occidente|zulia|maracaibo|san francisco|cabimas|ciudad ojeda|lagunillas|machiques|la villa|mara|mojan|santa rita|costa oriental|cuatricentenario|varillal|la limpia|falcon|coro|punto fijo|paraguana|trujillo|valera|bocono|lara|barquisimeto|cabudare|carora|region occidente|sucursal occidente)\M)' THEN
    RETURN 'OCCIDENTE';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_inferir_sucursal_geografica(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_inferir_sucursal_geografica(TEXT) TO anon, authenticated, service_role;

-- Trigger de sincronización unidireccional hacia auth.users.raw_app_meta_data y public.profiles
-- (jamás lee ni confía en metadatos editables por el cliente)
CREATE OR REPLACE FUNCTION public.fn_trg_sync_perfiles_usuarios_to_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_suc_col_type TEXT;
BEGIN
  NEW.sucursal := COALESCE(public.normalizar_sucursal_multisede(NEW.sucursal), NEW.sucursal);
  NEW.email := LOWER(BTRIM(COALESCE(NEW.email, '')));
  NEW.updated_at := now();

  -- Sincronizar claims firmados del servidor en auth.users.raw_app_meta_data
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
    'sucursal', NEW.sucursal,
    'region', NEW.sucursal,
    'regions', jsonb_build_array(NEW.sucursal),
    'rol_multisede', NEW.rol,
    'role', CASE WHEN NEW.rol = 'admin_nacional' THEN 'super_admin' ELSE 'coordinacion' END,
    'app_role', CASE WHEN NEW.rol = 'admin_nacional' THEN 'super_admin' ELSE 'coordinacion' END
  )
  WHERE id = NEW.id;

  -- Mantener tabla puente public.profiles sincronizada sin recursión ni choque de tipo ENUM
  IF to_regclass('public.profiles') IS NOT NULL AND pg_trigger_depth() <= 1 THEN
    SELECT c.data_type INTO v_suc_col_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'profiles' AND c.column_name = 'sucursal';

    IF v_suc_col_type = 'text' THEN
      UPDATE public.profiles
      SET sucursal = CASE WHEN NEW.rol = 'admin_nacional' THEN sucursal ELSE NEW.sucursal END,
          region = CASE WHEN NEW.rol = 'admin_nacional' THEN region ELSE NEW.sucursal END,
          regiones_asignadas = CASE WHEN NEW.rol = 'admin_nacional' THEN NULL ELSE ARRAY[NEW.sucursal] END,
          is_active = NEW.activo,
          updated_at = now()
      WHERE id = NEW.id;
    ELSE
      UPDATE public.profiles
      SET region = CASE WHEN NEW.rol = 'admin_nacional' THEN region ELSE NEW.sucursal END,
          regiones_asignadas = CASE WHEN NEW.rol = 'admin_nacional' THEN NULL ELSE ARRAY[NEW.sucursal] END,
          is_active = NEW.activo,
          updated_at = now()
      WHERE id = NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_sync_perfiles_usuarios_to_auth() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_perfiles_usuarios_to_auth ON public.perfiles_usuarios;
CREATE TRIGGER trg_sync_perfiles_usuarios_to_auth
  BEFORE INSERT OR UPDATE ON public.perfiles_usuarios
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_trg_sync_perfiles_usuarios_to_auth();

-- Poblar idempotentemente public.perfiles_usuarios para coordinadores y administradores existentes
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL AND to_regclass('public.profiles') IS NOT NULL THEN
    INSERT INTO public.perfiles_usuarios (id, email, nombre_completo, rol, sucursal, activo)
    SELECT
      u.id,
      LOWER(BTRIM(COALESCE(u.email, p.email, u.id::text || '@codizulca.local'))),
      COALESCE(NULLIF(BTRIM(p.full_name), ''), u.raw_app_meta_data ->> 'display_name', split_part(COALESCE(u.email, ''), '@', 1)),
      CASE
        WHEN LOWER(BTRIM(COALESCE(p.role::text, u.raw_app_meta_data ->> 'role', u.raw_app_meta_data ->> 'app_role', '')))
             IN ('super_admin', 'admin', 'gerente_admin', 'admin_nacional', 'contraloria', 'analista_contraloria')
          THEN 'admin_nacional'
        ELSE 'coordinador'
      END AS rol_resuelto,
      COALESCE(
        CASE
          WHEN LOWER(BTRIM(COALESCE(u.email, ''))) LIKE 'maria01@%' THEN 'CENTRO'
          WHEN LOWER(BTRIM(COALESCE(u.email, ''))) LIKE 'grecia01@%' THEN 'OCCIDENTE'
          ELSE NULL
        END,
        public.normalizar_sucursal_multisede(p.sucursal::text),
        public.normalizar_sucursal_multisede(p.region),
        public.normalizar_sucursal_multisede((p.regiones_asignadas)[1]),
        public.normalizar_sucursal_multisede(u.raw_app_meta_data ->> 'sucursal'),
        public.normalizar_sucursal_multisede(u.raw_app_meta_data ->> 'region'),
        'OCCIDENTE'
      ) AS sucursal_resuelta,
      COALESCE(p.is_active, true)
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    WHERE LOWER(BTRIM(COALESCE(p.role::text, u.raw_app_meta_data ->> 'role', u.raw_app_meta_data ->> 'app_role', '')))
          IN (
            'super_admin',
            'admin',
            'gerente_admin',
            'admin_nacional',
            'contraloria',
            'analista_contraloria',
            'coordinacion',
            'coordinador',
            'coordinador_trade',
            'coordinadora_trade',
            'jefe_trade',
            'supervisor'
          )
       OR LOWER(BTRIM(COALESCE(u.email, ''))) LIKE 'maria01@%'
       OR LOWER(BTRIM(COALESCE(u.email, ''))) LIKE 'grecia01@%'
    ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          rol = EXCLUDED.rol,
          sucursal = CASE
            WHEN LOWER(EXCLUDED.email) LIKE 'maria01@%' THEN 'CENTRO'
            WHEN LOWER(EXCLUDED.email) LIKE 'grecia01@%' THEN 'OCCIDENTE'
            ELSE COALESCE(public.perfiles_usuarios.sucursal, EXCLUDED.sucursal)
          END,
          activo = EXCLUDED.activo,
          updated_at = now();
  END IF;
END
$$;

-- Función auxiliar para identificar rol admin_nacional (sin usar metadatos editables por el cliente)
CREATE OR REPLACE FUNCTION public.es_admin_nacional()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_rol TEXT;
  v_activo BOOLEAN;
  v_jwt_role TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT pu.rol, pu.activo
    INTO v_rol, v_activo
  FROM public.perfiles_usuarios pu
  WHERE pu.id = v_uid;

  IF FOUND THEN
    RETURN v_activo IS TRUE AND v_rol = 'admin_nacional';
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    SELECT LOWER(BTRIM(COALESCE(p.role::text, ''))), COALESCE(p.is_active, true)
      INTO v_rol, v_activo
    FROM public.profiles p
    WHERE p.id = v_uid;

    IF FOUND THEN
      RETURN v_activo IS TRUE AND v_rol IN ('super_admin', 'admin', 'gerente_admin', 'admin_nacional', 'contraloria', 'analista_contraloria');
    END IF;
  END IF;

  v_jwt_role := LOWER(BTRIM(COALESCE(
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'rol_multisede',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'role',
    (SELECT auth.jwt()) -> 'app_metadata' ->> 'app_role',
    ''
  )));

  RETURN v_jwt_role IN ('admin_nacional', 'super_admin', 'admin');
END;
$$;

REVOKE ALL ON FUNCTION public.es_admin_nacional() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_admin_nacional() TO authenticated, service_role;

-- Si en algún entorno previo obtener_mi_sucursal() tenía tipo de retorno ENUM distinto de TEXT,
-- liberar limpiamente la firma previa antes de recrearla como TEXT ('CENTRO' | 'OCCIDENTE').
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'obtener_mi_sucursal'
      AND p.pronargs = 0
      AND p.prorettype <> 'text'::regtype
  ) THEN
    EXECUTE 'DROP FUNCTION public.obtener_mi_sucursal() CASCADE';
  END IF;
END
$$;

-- Función oficial solicitada en BLOQUE 1:
-- Retorna exactamente 'CENTRO' u 'OCCIDENTE' para el auth.uid() autenticado.
CREATE OR REPLACE FUNCTION public.obtener_mi_sucursal()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_sucursal TEXT;
  v_activo BOOLEAN;
  v_jwt_email TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Fuente primaria inmutable: public.perfiles_usuarios vinculada a auth.users(id)
  SELECT pu.sucursal, pu.activo
    INTO v_sucursal, v_activo
  FROM public.perfiles_usuarios pu
  WHERE pu.id = v_uid;

  IF FOUND THEN
    IF v_activo IS DISTINCT FROM true THEN
      RETURN NULL;
    END IF;
    RETURN public.normalizar_sucursal_multisede(v_sucursal);
  END IF;

  -- 2. Respaldo para personal de campo / choferes / usuarios en public.profiles o promotoras
  IF to_regclass('public.profiles') IS NOT NULL THEN
    SELECT
      COALESCE(
        public.normalizar_sucursal_multisede(p.sucursal::text),
        public.normalizar_sucursal_multisede(p.region),
        public.normalizar_sucursal_multisede((p.regiones_asignadas)[1])
      ),
      COALESCE(p.is_active, true)
    INTO v_sucursal, v_activo
    FROM public.profiles p
    WHERE p.id = v_uid;

    IF FOUND THEN
      IF v_activo IS DISTINCT FROM true THEN
        RETURN NULL;
      END IF;
      IF v_sucursal IS NOT NULL THEN
        RETURN v_sucursal;
      END IF;
    END IF;
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    v_jwt_email := LOWER(BTRIM(COALESCE((SELECT auth.jwt()) ->> 'email', '')));
    SELECT
      COALESCE(
        public.normalizar_sucursal_multisede(pr.sucursal::text),
        public.normalizar_sucursal_multisede(pr.region),
        public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', pr.ciudad, pr.estado, pr.direccion))
      ),
      COALESCE(pr.activo, true)
    INTO v_sucursal, v_activo
    FROM public.promotoras pr
    WHERE pr.auth_user_id = v_uid
       OR (v_jwt_email <> '' AND LOWER(BTRIM(COALESCE(pr.email, pr.correo, ''))) = v_jwt_email)
    ORDER BY CASE WHEN pr.auth_user_id = v_uid THEN 0 ELSE 1 END
    LIMIT 1;

    IF FOUND AND v_activo IS TRUE AND v_sucursal IS NOT NULL THEN
      RETURN v_sucursal;
    END IF;
  END IF;

  -- 3. Respaldo en app_metadata firmado por el servidor (jamás metadatos de cliente)
  RETURN public.normalizar_sucursal_multisede(
    COALESCE(
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'sucursal',
      (SELECT auth.jwt()) -> 'app_metadata' ->> 'region'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_mi_sucursal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_mi_sucursal() TO authenticated, service_role;

-- Protección RLS de public.perfiles_usuarios (solo lectura propia; cero auto-edición desde cliente)
REVOKE ALL ON TABLE public.perfiles_usuarios FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.perfiles_usuarios TO authenticated;
GRANT ALL ON TABLE public.perfiles_usuarios TO service_role;

ALTER TABLE public.perfiles_usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perfiles_usuarios FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_perfiles_usuarios_select_own ON public.perfiles_usuarios;
CREATE POLICY rls_perfiles_usuarios_select_own
  ON public.perfiles_usuarios
  FOR SELECT
  TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (SELECT public.es_admin_nacional())
  );

-- Recrear funciones puente de compatibilidad únicamente si el tipo ENUM legado existe
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'sucursal_codigo'
  ) THEN
    EXECUTE $f1$
      CREATE OR REPLACE FUNCTION public.obtener_sucursal_contexto_activo()
      RETURNS public.sucursal_codigo
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_suc TEXT := (SELECT public.obtener_mi_sucursal());
      BEGIN
        IF (SELECT public.es_admin_nacional()) THEN
          RETURN 'GLOBAL'::public.sucursal_codigo;
        END IF;
        IF v_suc = 'CENTRO' THEN
          RETURN 'CENTRO'::public.sucursal_codigo;
        END IF;
        IF v_suc = 'OCCIDENTE' THEN
          RETURN 'ZULIA'::public.sucursal_codigo;
        END IF;
        RETURN NULL;
      END;
      $inner$;
    $f1$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.obtener_sucursal_contexto_activo() FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.obtener_sucursal_contexto_activo() TO authenticated, service_role';

    EXECUTE $f2$
      CREATE OR REPLACE FUNCTION public.tiene_acceso_sucursal(p_sucursal public.sucursal_codigo)
      RETURNS BOOLEAN
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
        SELECT
          (SELECT auth.uid()) IS NOT NULL
          AND (
            (SELECT public.es_admin_nacional())
            OR public.normalizar_sucursal_multisede(p_sucursal::text) = (SELECT public.obtener_mi_sucursal())
          );
      $inner$;
    $f2$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.tiene_acceso_sucursal(public.sucursal_codigo) FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.tiene_acceso_sucursal(public.sucursal_codigo) TO authenticated, service_role';
  END IF;
END
$$;

-- Actualizar fn_trade_normalize_region_token para incluir municipios de Carabobo y Aragua
CREATE OR REPLACE FUNCTION public.fn_trade_normalize_region_token(p_raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  RETURN public.fn_inferir_sucursal_geografica(p_raw);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trade_normalize_region_token(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trade_normalize_region_token(TEXT) TO authenticated, service_role;


-- ==============================================================================
-- BLOQUE 2 — ESQUEMA DE BASE DE DATOS, CATÁLOGO NACIONAL Y COLUMNAS REGIONALES
-- ==============================================================================

-- 2.1 Catálogo Maestro Nacional Compartido: public.productos / public."Productos" y nomencladores
DO $$
DECLARE
  v_global_tbl TEXT;
  v_global_tables TEXT[] := ARRAY[
    'Productos',
    'Marcas',
    'Grupo_Productos',
    'Familia_Productos',
    'Tipificacion_Clientes',
    'Canal_Comercializacion',
    'Canales_Ventas',
    'Frecuencia_Visita',
    'tasas_bcv'
  ];
BEGIN
  IF to_regclass('public.productos') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.productos FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public.productos TO authenticated;
    GRANT ALL ON TABLE public.productos TO service_role;
    ALTER TABLE public.productos ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS productos_select_authenticated ON public.productos;
    DROP POLICY IF EXISTS rls_productos_catalogo_nacional_select ON public.productos;
    DROP POLICY IF EXISTS rls_productos_catalogo_nacional_admin_write ON public.productos;

    CREATE POLICY rls_productos_catalogo_nacional_select
      ON public.productos
      FOR SELECT
      TO authenticated
      USING (
        (SELECT auth.uid()) IS NOT NULL
        AND (
          (SELECT public.obtener_mi_sucursal()) IN ('CENTRO', 'OCCIDENTE')
          OR (SELECT public.es_admin_nacional())
        )
      );

    CREATE POLICY rls_productos_catalogo_nacional_admin_write
      ON public.productos
      FOR ALL
      TO authenticated
      USING ((SELECT public.es_admin_nacional()))
      WITH CHECK ((SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.vw_productos_detalle') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.vw_productos_detalle SET (security_invoker = true)';
    EXECUTE 'GRANT SELECT ON public.vw_productos_detalle TO authenticated';
  END IF;

  FOREACH v_global_tbl IN ARRAY v_global_tables LOOP
    IF to_regclass(format('public.%I', v_global_tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', v_global_tbl);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', v_global_tbl);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_global_tbl);
      EXECUTE format('DROP POLICY IF EXISTS rls_catalogo_nacional_select_%s ON public.%I', lower(v_global_tbl), v_global_tbl);
      EXECUTE format(
        'CREATE POLICY rls_catalogo_nacional_select_%s ON public.%I FOR SELECT TO authenticated USING ((SELECT auth.uid()) IS NOT NULL AND ((SELECT public.obtener_mi_sucursal()) IN (''CENTRO'', ''OCCIDENTE'') OR (SELECT public.es_admin_nacional())))',
        lower(v_global_tbl),
        v_global_tbl
      );
    END IF;
  END LOOP;
END
$$;

-- 2.2 Asegurar `sucursal TEXT` (sin DEFAULT 'ZULIA') en todas las tablas regionales existentes
DO $$
DECLARE
  v_tbl TEXT;
  v_col_type TEXT;
  v_regional_tables TEXT[] := ARRAY[
    'clientes',
    'Clientes',
    'cadenas_comerciales',
    'zonas',
    'promotoras',
    'staff',
    'vendedores',
    'Vendedores',
    'supervisores',
    'Supervisores',
    'Sucursales',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'ejecuciones_pdv_promotora',
    'entregas_degustacion',
    'sesiones_jornada',
    'offline_mutation_receipts',
    'inventory',
    'prices',
    'asistencias_jornada',
    'asistencia_evidencias',
    'checkins',
    'reportes_trade',
    'incidencias_pdv',
    'material_pop_inventario',
    'material_pop_entregas',
    'solicitudes_contraloria',
    'contraloria_requisiciones',
    'contraloria_conciliaciones',
    'contraloria_facturas',
    'certificados_paz_y_salvo',
    'campanas_trade',
    'presupuestos_trade',
    'tarifario_costos_trade',
    'alertas_precios',
    'configuracion_alertas_precios',
    'alertas_geocerca_auditoria',
    'discrepancy_alerts',
    'notificaciones_outbox',
    'cliente_portal_accesos',
    'cargas_archivos',
    'lotes_sincronizacion'
  ];
  v_pol RECORD;
  v_con RECORD;
  v_trg RECORD;
BEGIN
  FOREACH v_tbl IN ARRAY v_regional_tables LOOP
    IF to_regclass(format('public.%I', v_tbl)) IS NOT NULL THEN
      -- Retirar triggers legados basados en ENUM sucursal_codigo antes de convertir columnas o ejecutar backfill
      FOR v_trg IN
        SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class rel ON rel.oid = t.tgrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        JOIN pg_proc prc ON prc.oid = t.tgfoid
        WHERE nsp.nspname = 'public'
          AND rel.relname = v_tbl
          AND NOT t.tgisinternal
          AND prc.proname IN (
            'fn_sellar_y_proteger_sucursal_operativa',
            'fn_enforce_master_region_before_write',
            'fn_guard_cross_region_integrity'
          )
      LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_trg.tgname, v_tbl);
      END LOOP;

      -- Retirar CHECK constraints legados de sucursal (ZULIA/VALENCIA) o region (Occidente/Valencia) antes del backfill
      FOR v_con IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = v_tbl
          AND con.contype = 'c'
          AND (
            pg_get_constraintdef(con.oid) ILIKE '%sucursal%'
            OR con.conname = 'chk_promotoras_region_valida'
          )
      LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_tbl, v_con.conname);
      END LOOP;

      SELECT c.data_type
        INTO v_col_type
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = v_tbl
        AND c.column_name = 'sucursal';

      IF NOT FOUND THEN
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS sucursal TEXT', v_tbl);
      ELSIF v_col_type = 'USER-DEFINED' THEN
        FOR v_pol IN
          SELECT policyname
          FROM pg_policies
          WHERE schemaname = 'public' AND tablename = v_tbl
        LOOP
          EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_pol.policyname, v_tbl);
        END LOOP;
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN sucursal DROP DEFAULT', v_tbl);
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN sucursal TYPE TEXT USING sucursal::text', v_tbl);
      ELSE
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN sucursal DROP DEFAULT', v_tbl);
      END IF;
    END IF;
  END LOOP;
END
$$;

-- 2.3 Tabla de Configuración / Tokens de Enlaces Públicos de Promotoras (BLOQUE 5)
CREATE TABLE IF NOT EXISTS public.enlaces_publicos_sucursal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal TEXT NOT NULL
    CHECK (sucursal IN ('CENTRO', 'OCCIDENTE')),
  token_hash TEXT NOT NULL UNIQUE,
  token_publico TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  uso_contador BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_enlaces_publicos_sucursal_activo
  ON public.enlaces_publicos_sucursal (sucursal)
  WHERE activo = true AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_enlaces_publicos_sucursal_lookup
  ON public.enlaces_publicos_sucursal (token_hash)
  WHERE activo = true AND revoked_at IS NULL;

-- 2.4 Índices compuestos de rendimiento (creados de forma condicional si cada tabla existe)
DO $$
BEGIN
  IF to_regclass('public.clientes') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_clientes_sucursal_activo ON public.clientes (sucursal, activo);
  END IF;
  IF to_regclass('public."Clientes"') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_erp_clientes_sucursal ON public."Clientes" (sucursal);
  END IF;
  IF to_regclass('public.cadenas_comerciales') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_cadenas_sucursal_activo ON public.cadenas_comerciales (sucursal, activo);
  END IF;
  IF to_regclass('public.zonas') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_zonas_sucursal_activo ON public.zonas (sucursal, activo);
  END IF;
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_promotoras_sucursal_activo ON public.promotoras (sucursal, activo);
  END IF;
  IF to_regclass('public.vendedores') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_vendedores_sucursal_codigo ON public.vendedores (sucursal, codigo_vendedor);
  END IF;
  IF to_regclass('public."Vendedores"') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_erp_vendedores_sucursal ON public."Vendedores" (sucursal);
  END IF;
  IF to_regclass('public.surveys') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_surveys_sucursal_type_created ON public.surveys (sucursal, type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_multisede_surveys_sucursal_historial ON public.surveys (sucursal, en_historial, date DESC);
  END IF;
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_cronograma_sucursal_fecha ON public.cronograma_degustaciones (sucursal, fecha DESC);
  END IF;
  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_rutas_promotoras_sucursal_fecha ON public.rutas_promotoras (sucursal, fecha DESC);
  END IF;
  IF to_regclass('public.ejecuciones_pdv_promotora') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_ejecuciones_pdv_sucursal_fecha ON public.ejecuciones_pdv_promotora (sucursal, fecha DESC);
  END IF;
  IF to_regclass('public.inventory') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_inventory_sucursal_created ON public.inventory (sucursal, created_at DESC);
  END IF;
  IF to_regclass('public.prices') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_multisede_prices_sucursal_created ON public.prices (sucursal, created_at DESC);
  END IF;
END
$$;


-- ==============================================================================
-- PRE-BACKFILL: ACTUALIZACIÓN PREVENTIVA DE TRIGGERS DE ENRUTAMIENTO MÓDULO 2
--   Reemplaza funciones previas que escribían 'ZULIA'/'VALENCIA' antes de correr
--   el backfill transaccional sobre surveys y cronograma_degustaciones.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_trg_survey_aprobada_to_cronograma()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comments JSONB;
  v_estado TEXT;
  v_sucursal TEXT;
  v_chofer_sede TEXT;
  v_fecha DATE;
  v_turno TEXT;
  v_cliente_nombre TEXT;
  v_cliente_codigo TEXT;
  v_zona TEXT;
  v_vendedor TEXT;
  v_prom_nombre TEXT;
  v_prom_email TEXT;
  v_prom_id_text TEXT;
  v_prom_uuid UUID := NULL;
  v_lookup_nombre TEXT;
  v_lookup_email TEXT;
  v_lookup_auth_uid UUID;
  v_productos JSONB;
  v_prod_resumen TEXT;
  v_kilos NUMERIC(12,2);
  v_personas INT;
  v_obs TEXT;
BEGIN
  IF COALESCE(NEW.type, '') <> 'Degustacion' OR to_regclass('public.cronograma_degustaciones') IS NULL THEN
    RETURN NEW;
  END IF;

  v_sucursal := COALESCE(public.normalizar_sucursal_multisede(NEW.sucursal), 'OCCIDENTE');
  IF v_sucursal NOT IN ('CENTRO', 'OCCIDENTE') THEN
    RETURN NEW;
  END IF;
  v_chofer_sede := CASE WHEN v_sucursal = 'CENTRO' THEN 'VALENCIA' ELSE 'OCCIDENTE' END;

  -- Si solo cambió sucursal/region (ej. backfill), propagar únicamente a filas ya existentes sin reinsertar
  IF TG_OP = 'UPDATE'
     AND OLD.comments IS NOT DISTINCT FROM NEW.comments
     AND OLD.promoter IS NOT DISTINCT FROM NEW.promoter
     AND OLD.store IS NOT DISTINCT FROM NEW.store
     AND OLD.date IS NOT DISTINCT FROM NEW.date THEN
    UPDATE public.cronograma_degustaciones
    SET sucursal = v_sucursal,
        region = v_sucursal,
        chofer_sede = v_chofer_sede,
        updated_at = now()
    WHERE survey_origen_id::text = NEW.id::text;
    RETURN NEW;
  END IF;

  v_comments := public.fn_safe_jsonb(NEW.comments);
  v_estado := UPPER(BTRIM(COALESCE(v_comments ->> 'estado', v_comments ->> 'status', '')));
  IF v_estado NOT IN ('APROBADA', 'AUTORIZADA', 'ACEPTADA', 'PROGRAMADA') THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_fecha := COALESCE(NULLIF(BTRIM(COALESCE(v_comments ->> 'date', NEW.date::text)), '')::date, CURRENT_DATE);
  EXCEPTION WHEN OTHERS THEN
    v_fecha := CURRENT_DATE;
  END;

  v_turno := UPPER(BTRIM(COALESCE(NULLIF(BTRIM(COALESCE(v_comments ->> 'turno', v_comments ->> 'shift', '')), ''), 'MAÑANA')));
  IF v_turno NOT IN ('MAÑANA', 'TARDE', 'COMPLETO') THEN
    v_turno := 'MAÑANA';
  END IF;

  v_cliente_nombre := COALESCE(NULLIF(BTRIM(COALESCE(NEW.store, v_comments ->> 'client', '')), ''), 'PDV');
  v_cliente_codigo := COALESCE(NULLIF(BTRIM(COALESCE(v_comments ->> 'clienteCodigo', '')), ''), '');
  v_zona := COALESCE(NULLIF(BTRIM(COALESCE(v_comments ->> 'zona', v_comments ->> 'ruta', '')), ''), v_sucursal);
  v_vendedor := COALESCE(NULLIF(BTRIM(COALESCE(v_comments ->> 'vendedor', '')), ''), '');
  v_prom_nombre := COALESCE(NULLIF(BTRIM(COALESCE(NEW.promoter, v_comments ->> 'promoter', '')), ''), 'POR ASIGNAR (Trade Marketing)');
  v_prom_email := LOWER(BTRIM(COALESCE(NEW.email, v_comments ->> 'promoterEmail', v_comments ->> 'promotoraEmail', '')));
  v_prom_id_text := NULLIF(BTRIM(COALESCE(NEW.promotora_id::text, '')), '');

  -- Resolución polimórfica de promotora_id (soporta promotoras.id BIGINT o UUID)
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT
      pr.nombre_completo,
      LOWER(BTRIM(COALESCE(pr.correo, pr.email, ''))),
      pr.auth_user_id
    INTO v_lookup_nombre, v_lookup_email, v_lookup_auth_uid
    FROM public.promotoras pr
    WHERE (v_prom_id_text IS NOT NULL AND (pr.id::text = v_prom_id_text OR pr.auth_user_id::text = v_prom_id_text))
       OR (v_prom_email <> '' AND LOWER(BTRIM(COALESCE(pr.correo, pr.email, ''))) = v_prom_email)
       OR (v_prom_nombre <> '' AND LOWER(BTRIM(COALESCE(pr.nombre_completo, ''))) = LOWER(v_prom_nombre))
    ORDER BY
      CASE
        WHEN v_prom_id_text IS NOT NULL AND (pr.id::text = v_prom_id_text OR pr.auth_user_id::text = v_prom_id_text) THEN 0
        WHEN v_prom_email <> '' AND LOWER(BTRIM(COALESCE(pr.correo, pr.email, ''))) = v_prom_email THEN 1
        ELSE 2
      END ASC
    LIMIT 1;

    IF FOUND THEN
      v_prom_nombre := COALESCE(NULLIF(v_prom_nombre, ''), v_lookup_nombre, 'POR ASIGNAR (Trade Marketing)');
      v_prom_email := COALESCE(NULLIF(v_prom_email, ''), v_lookup_email);
      v_prom_uuid := v_lookup_auth_uid;
    END IF;
  END IF;

  IF v_prom_uuid IS NULL THEN
    v_prom_uuid := public.fn_try_uuid(v_prom_id_text);
  END IF;

  v_productos := CASE WHEN jsonb_typeof(v_comments -> 'products') = 'array' THEN v_comments -> 'products' ELSE '[]'::jsonb END;
  v_prod_resumen := COALESCE(NULLIF(BTRIM(COALESCE(NEW.product, v_comments ->> 'productSummary', '')), ''), 'Degustación Trade');
  v_kilos := GREATEST(
    1,
    COALESCE(NULLIF(regexp_replace(COALESCE(v_comments ->> 'kilos', '1'), '[^0-9.]', '', 'g'), '')::numeric, 1)
  );
  v_personas := GREATEST(
    0,
    COALESCE(NULLIF(regexp_replace(COALESCE(v_comments ->> 'personas', '0'), '[^0-9]', '', 'g'), '')::int, 0)
  );
  v_obs := COALESCE(NULLIF(BTRIM(COALESCE(v_comments ->> 'notes', v_comments ->> 'observaciones', '')), ''), '');

  INSERT INTO public.cronograma_degustaciones (
    survey_origen_id,
    degustacion_origen_id,
    idempotency_hash,
    fecha,
    turno,
    cliente_nombre,
    cliente_codigo,
    zona_direccion,
    producto_resumen,
    productos,
    cantidad_kilos,
    personas_estimadas,
    vendedor_fdv,
    promotora_id,
    promotora_nombre,
    promotora_email,
    observaciones,
    estado,
    sucursal,
    region,
    chofer_sede,
    updated_at
  ) VALUES (
    NEW.id::text,
    public.fn_try_uuid(NEW.id::text),
    'SURVEY_' || NEW.id::text,
    v_fecha,
    v_turno,
    v_cliente_nombre,
    v_cliente_codigo,
    v_zona,
    LEFT(v_prod_resumen, 160),
    v_productos,
    v_kilos,
    v_personas,
    v_vendedor,
    v_prom_uuid,
    v_prom_nombre,
    NULLIF(v_prom_email, ''),
    v_obs,
    'APROBADA',
    v_sucursal,
    v_sucursal,
    v_chofer_sede,
    now()
  )
  ON CONFLICT (survey_origen_id) WHERE survey_origen_id IS NOT NULL
  DO UPDATE SET
    fecha = EXCLUDED.fecha,
    turno = EXCLUDED.turno,
    cliente_nombre = EXCLUDED.cliente_nombre,
    cliente_codigo = EXCLUDED.cliente_codigo,
    zona_direccion = EXCLUDED.zona_direccion,
    producto_resumen = EXCLUDED.producto_resumen,
    productos = EXCLUDED.productos,
    promotora_id = COALESCE(EXCLUDED.promotora_id, public.cronograma_degustaciones.promotora_id),
    promotora_nombre = COALESCE(NULLIF(EXCLUDED.promotora_nombre, ''), public.cronograma_degustaciones.promotora_nombre),
    promotora_email = COALESCE(EXCLUDED.promotora_email, public.cronograma_degustaciones.promotora_email),
    sucursal = EXCLUDED.sucursal,
    region = EXCLUDED.region,
    chofer_sede = EXCLUDED.chofer_sede,
    degustacion_origen_id = COALESCE(public.cronograma_degustaciones.degustacion_origen_id, EXCLUDED.degustacion_origen_id),
    updated_at = now();

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_survey_aprobada_to_cronograma() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_survey_aprobada_to_cronograma() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trg_cronograma_normalize_routing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sucursal TEXT;
BEGIN
  IF NEW.degustacion_origen_id IS NULL AND NEW.survey_origen_id IS NOT NULL THEN
    NEW.degustacion_origen_id := public.fn_try_uuid(NEW.survey_origen_id::text);
  END IF;

  v_sucursal := COALESCE(
    CASE
      WHEN public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', NEW.cliente_nombre, NEW.zona_direccion, NEW.observaciones)) = 'CENTRO'
        THEN 'CENTRO'
      ELSE NULL
    END,
    public.normalizar_sucursal_multisede(NEW.sucursal),
    public.normalizar_sucursal_multisede(NEW.region),
    public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', NEW.cliente_nombre, NEW.zona_direccion, NEW.region)),
    (SELECT public.obtener_mi_sucursal()),
    'OCCIDENTE'
  );

  NEW.sucursal := v_sucursal;
  NEW.region := v_sucursal;
  NEW.chofer_sede := CASE WHEN v_sucursal = 'CENTRO' THEN 'VALENCIA' ELSE 'OCCIDENTE' END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_cronograma_normalize_routing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_cronograma_normalize_routing() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_trg_cronograma_dispatch_ruta_y_chofer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado TEXT := UPPER(BTRIM(COALESCE(NEW.estado, '')));
  v_sucursal TEXT;
  v_sede TEXT;
  v_chofer_turno TEXT;
  v_chofer_fecha TEXT;
  v_prom_nombre TEXT;
  v_prom_email TEXT;
  v_prom_auth_uid UUID := NULL;
  v_lookup_nombre TEXT;
  v_lookup_email TEXT;
  v_lookup_auth_uid UUID;
  v_has_promotora BOOLEAN := false;
  v_target_estado_ruta TEXT;
BEGIN
  IF v_estado IN ('CANCELADA', 'RECHAZADA', 'NO_AUTORIZADA') THEN
    IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
      UPDATE public.rutas_promotoras
      SET estado_ruta = 'CANCELADA',
          updated_at = now()
      WHERE cronograma_id = NEW.id
        AND estado_ruta <> 'COMPLETADA';
    END IF;
    RETURN NEW;
  END IF;

  IF v_estado NOT IN ('APROBADA', 'EN_CURSO', 'COMPLETADA') THEN
    RETURN NEW;
  END IF;

  v_sucursal := COALESCE(
    public.normalizar_sucursal_multisede(NEW.sucursal),
    public.normalizar_sucursal_multisede(NEW.region),
    'OCCIDENTE'
  );
  v_sede := CASE WHEN v_sucursal = 'CENTRO' THEN 'VALENCIA' ELSE 'OCCIDENTE' END;

  -- Si solo cambió sucursal/region/chofer_sede (ej. backfill), propagar solo a filas ya existentes
  IF TG_OP = 'UPDATE'
     AND OLD.estado IS NOT DISTINCT FROM NEW.estado
     AND OLD.fecha IS NOT DISTINCT FROM NEW.fecha
     AND OLD.turno IS NOT DISTINCT FROM NEW.turno
     AND OLD.promotora_id IS NOT DISTINCT FROM NEW.promotora_id
     AND OLD.promotora_nombre IS NOT DISTINCT FROM NEW.promotora_nombre
     AND OLD.promotora_email IS NOT DISTINCT FROM NEW.promotora_email
     AND OLD.cliente_nombre IS NOT DISTINCT FROM NEW.cliente_nombre THEN
    IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
      UPDATE public.rutas_promotoras
      SET sucursal = v_sucursal,
          region = v_sucursal,
          updated_at = now()
      WHERE cronograma_id = NEW.id;
    END IF;
    IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
      UPDATE public.entregas_degustacion
      SET sucursal = v_sucursal,
          region = v_sucursal,
          chofer_sede = v_sede,
          updated_at = now()
      WHERE cronograma_id = NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  v_prom_nombre := BTRIM(COALESCE(NEW.promotora_nombre, ''));
  v_prom_email := LOWER(BTRIM(COALESCE(NEW.promotora_email, '')));

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT
      p.nombre_completo,
      LOWER(BTRIM(COALESCE(p.correo, p.email, ''))),
      p.auth_user_id
    INTO v_lookup_nombre, v_lookup_email, v_lookup_auth_uid
    FROM public.promotoras p
    WHERE (v_prom_email <> '' AND LOWER(BTRIM(COALESCE(p.correo, p.email, ''))) = v_prom_email)
       OR (NEW.promotora_id IS NOT NULL AND (p.auth_user_id::text = NEW.promotora_id::text OR p.id::text = NEW.promotora_id::text))
       OR (v_prom_nombre <> '' AND LOWER(BTRIM(COALESCE(p.nombre_completo, ''))) = LOWER(v_prom_nombre))
    ORDER BY
      CASE
        WHEN v_prom_email <> '' AND LOWER(BTRIM(COALESCE(p.correo, p.email, ''))) = v_prom_email THEN 0
        WHEN NEW.promotora_id IS NOT NULL AND (p.auth_user_id::text = NEW.promotora_id::text OR p.id::text = NEW.promotora_id::text) THEN 1
        ELSE 2
      END ASC
    LIMIT 1;
    IF FOUND THEN
      v_prom_nombre := COALESCE(NULLIF(v_prom_nombre, ''), v_lookup_nombre);
      v_prom_email := COALESCE(NULLIF(v_prom_email, ''), v_lookup_email);
      v_prom_auth_uid := COALESCE(v_prom_auth_uid, v_lookup_auth_uid);
    END IF;
  END IF;

  IF v_prom_auth_uid IS NULL AND v_prom_email <> '' AND to_regclass('public.profiles') IS NOT NULL THEN
    SELECT pr.id INTO v_lookup_auth_uid
    FROM public.profiles pr
    WHERE LOWER(BTRIM(COALESCE(pr.email, ''))) = v_prom_email
    LIMIT 1;
    IF FOUND THEN
      v_prom_auth_uid := v_lookup_auth_uid;
    END IF;
  END IF;

  v_has_promotora := (
    v_prom_email <> ''
    OR NEW.promotora_id IS NOT NULL
    OR v_prom_auth_uid IS NOT NULL
    OR (
      v_prom_nombre <> ''
      AND UPPER(v_prom_nombre) NOT LIKE 'POR ASIGNAR%'
      AND UPPER(v_prom_nombre) NOT LIKE 'SIN ASIGNAR%'
    )
  );

  -- A) Despacho atómico a App de Promotoras (conservando sucursal canónica 'CENTRO' | 'OCCIDENTE')
  IF v_has_promotora AND to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    v_target_estado_ruta := CASE
      WHEN v_estado = 'EN_CURSO' THEN 'EN_CURSO'
      WHEN v_estado = 'COMPLETADA' THEN 'COMPLETADA'
      ELSE 'ASIGNADA'
    END;

    INSERT INTO public.rutas_promotoras (
      cronograma_id,
      fecha,
      turno,
      hora_inicio,
      hora_fin,
      cliente_nombre,
      cliente_codigo,
      zona_direccion,
      producto_resumen,
      productos,
      cantidad_kilos,
      vendedor_fdv,
      promotora_id,
      promotora_nombre,
      promotora_email,
      auth_user_id,
      estado_ruta,
      observaciones,
      region,
      sucursal,
      updated_at
    ) VALUES (
      NEW.id,
      NEW.fecha,
      NEW.turno,
      COALESCE(NULLIF(BTRIM(COALESCE(NEW.hora_inicio, '')), ''), '09:00'),
      COALESCE(NULLIF(BTRIM(COALESCE(NEW.hora_fin, '')), ''), '13:00'),
      NEW.cliente_nombre,
      COALESCE(NEW.cliente_codigo, ''),
      COALESCE(NEW.zona_direccion, ''),
      COALESCE(NEW.producto_resumen, ''),
      COALESCE(NEW.productos, '[]'::JSONB),
      GREATEST(1, COALESCE(NEW.cantidad_kilos, 1)),
      COALESCE(NEW.vendedor_fdv, ''),
      COALESCE(NEW.promotora_id, v_prom_auth_uid),
      COALESCE(NULLIF(v_prom_nombre, ''), NEW.promotora_nombre, 'POR ASIGNAR (Trade Marketing)'),
      NULLIF(v_prom_email, ''),
      COALESCE(v_prom_auth_uid, NEW.promotora_id),
      v_target_estado_ruta,
      COALESCE(NEW.observaciones, ''),
      v_sucursal,
      v_sucursal,
      now()
    )
    ON CONFLICT (cronograma_id) WHERE cronograma_id IS NOT NULL
    DO UPDATE SET
      fecha = EXCLUDED.fecha,
      turno = EXCLUDED.turno,
      hora_inicio = EXCLUDED.hora_inicio,
      hora_fin = EXCLUDED.hora_fin,
      cliente_nombre = EXCLUDED.cliente_nombre,
      cliente_codigo = EXCLUDED.cliente_codigo,
      zona_direccion = EXCLUDED.zona_direccion,
      producto_resumen = EXCLUDED.producto_resumen,
      productos = EXCLUDED.productos,
      cantidad_kilos = EXCLUDED.cantidad_kilos,
      vendedor_fdv = EXCLUDED.vendedor_fdv,
      promotora_id = COALESCE(EXCLUDED.promotora_id, public.rutas_promotoras.promotora_id),
      promotora_nombre = EXCLUDED.promotora_nombre,
      promotora_email = COALESCE(EXCLUDED.promotora_email, public.rutas_promotoras.promotora_email),
      auth_user_id = COALESCE(EXCLUDED.auth_user_id, public.rutas_promotoras.auth_user_id),
      estado_ruta = CASE
        WHEN public.rutas_promotoras.estado_ruta IN ('EN_CURSO', 'COMPLETADA') AND v_estado = 'APROBADA'
          THEN public.rutas_promotoras.estado_ruta
        ELSE EXCLUDED.estado_ruta
      END,
      observaciones = EXCLUDED.observaciones,
      region = EXCLUDED.region,
      sucursal = EXCLUDED.sucursal,
      updated_at = now();
  END IF;

  -- B) Despacho atómico a App de Chofer (sucursal canónica 'CENTRO'|'OCCIDENTE', chofer_sede 'VALENCIA'|'OCCIDENTE')
  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    v_chofer_turno := CASE
      WHEN UPPER(BTRIM(COALESCE(NEW.turno, ''))) = 'TARDE' THEN 'TARDE'
      ELSE 'MAÑANA'
    END;
    v_chofer_fecha := to_char(NEW.fecha, 'YYYY-MM-DD');

    INSERT INTO public.entregas_degustacion (
      id,
      cronograma_id,
      fecha,
      turno,
      numero_grupo_turno,
      cliente,
      producto,
      vendedor,
      promotora,
      stand_entregado,
      producto_entregado,
      completado,
      estado_logistico,
      notas_chofer,
      region,
      sucursal,
      chofer_sede,
      updated_at
    ) VALUES (
      gen_random_uuid()::TEXT,
      NEW.id,
      v_chofer_fecha,
      v_chofer_turno,
      v_chofer_turno || ' · ' || to_char(NEW.fecha, 'YYYY-MM-DD'),
      UPPER(BTRIM(COALESCE(NEW.cliente_nombre, 'PDV SIN NOMBRE'))),
      LEFT(UPPER(BTRIM(COALESCE(NEW.producto_resumen, 'DEGUSTACIÓN'))), 120),
      UPPER(BTRIM(COALESCE(NULLIF(BTRIM(COALESCE(NEW.vendedor_fdv, '')), ''), 'TRADE MARKETING'))),
      UPPER(BTRIM(COALESCE(NULLIF(v_prom_nombre, ''), NULLIF(BTRIM(COALESCE(NEW.promotora_nombre, '')), ''), 'POR ASIGNAR (TRADE MARKETING)'))),
      false,
      false,
      false,
      'PENDIENTE',
      COALESCE(NEW.observaciones, ''),
      v_sucursal,
      v_sucursal,
      v_sede,
      now()
    )
    ON CONFLICT (cronograma_id) WHERE cronograma_id IS NOT NULL
    DO UPDATE SET
      fecha = EXCLUDED.fecha,
      turno = EXCLUDED.turno,
      numero_grupo_turno = EXCLUDED.numero_grupo_turno,
      cliente = EXCLUDED.cliente,
      producto = EXCLUDED.producto,
      vendedor = EXCLUDED.vendedor,
      promotora = EXCLUDED.promotora,
      region = EXCLUDED.region,
      sucursal = EXCLUDED.sucursal,
      chofer_sede = EXCLUDED.chofer_sede,
      notas_chofer = CASE
        WHEN NULLIF(BTRIM(COALESCE(public.entregas_degustacion.notas_chofer, '')), '') IS NOT NULL
          THEN public.entregas_degustacion.notas_chofer
        ELSE EXCLUDED.notas_chofer
      END,
      updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_cronograma_dispatch_ruta_y_chofer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_cronograma_dispatch_ruta_y_chofer() TO authenticated, service_role;


-- ==============================================================================
-- BLOQUE 7 — CLASIFICACIÓN TRANSACCIONAL SIN PÉRDIDA DE DATOS + SET NOT NULL
-- ==============================================================================

DO $$
DECLARE
  v_ambiguous_count BIGINT := 0;
  v_tbl TEXT;
  v_check_name TEXT;
  v_core_not_null_tables TEXT[] := ARRAY[
    'clientes',
    'Clientes',
    'promotoras',
    'vendedores',
    'Vendedores',
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'ejecuciones_pdv_promotora',
    'entregas_degustacion',
    'inventory',
    'prices',
    'enlaces_publicos_sucursal'
  ];
BEGIN
  -- 7.1 Clasificar ERP "Sucursales", "Clientes", "Vendedores", "Supervisores" con nombres reales de columna
  IF to_regclass('public."Sucursales"') IS NOT NULL AND to_regclass('public."Regiones"') IS NOT NULL THEN
    UPDATE public."Sucursales" s
    SET sucursal = COALESCE(
      public.fn_inferir_sucursal_geografica(r.regi_desd),
      public.fn_inferir_sucursal_geografica(s.sucu_desc),
      'OCCIDENTE'
    )
    FROM public."Regiones" r
    WHERE s.id_regi::text = r.id_regi::text
      AND (s.sucursal IS NULL OR s.sucursal NOT IN ('CENTRO', 'OCCIDENTE'));

    UPDATE public."Sucursales"
    SET sucursal = COALESCE(public.fn_inferir_sucursal_geografica(sucu_desc), 'OCCIDENTE')
    WHERE sucursal IS NULL OR sucursal NOT IN ('CENTRO', 'OCCIDENTE');
  END IF;

  IF to_regclass('public."Clientes"') IS NOT NULL THEN
    IF to_regclass('public."Regiones"') IS NOT NULL THEN
      UPDATE public."Clientes" c
      SET sucursal = CASE
        WHEN COALESCE(c.clie_nomb, '') ~* '(makro\s+(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|valencia)|san diego|naguanagua|el sam[aá]n|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua)'
          THEN 'CENTRO'
        ELSE COALESCE(
          public.fn_inferir_sucursal_geografica(c.clie_nomb),
          public.fn_inferir_sucursal_geografica(r.regi_desd),
          'OCCIDENTE'
        )
      END
      FROM public."Regiones" r
      WHERE c.clie_regi::text = r.id_regi::text;
    END IF;

    UPDATE public."Clientes"
    SET sucursal = COALESCE(public.fn_inferir_sucursal_geografica(clie_nomb), 'OCCIDENTE')
    WHERE sucursal IS NULL OR sucursal NOT IN ('CENTRO', 'OCCIDENTE');
  END IF;

  IF to_regclass('public."Vendedores"') IS NOT NULL THEN
    IF to_regclass('public."Sucursales"') IS NOT NULL THEN
      UPDATE public."Vendedores" v
      SET sucursal = COALESCE(
        s.sucursal,
        public.fn_inferir_sucursal_geografica(s.sucu_desc),
        'OCCIDENTE'
      )
      FROM public."Sucursales" s
      WHERE v.id_sucu::text = s.id_sucu::text;
    END IF;

    UPDATE public."Vendedores"
    SET sucursal = COALESCE(public.normalizar_sucursal_multisede(sucursal), 'OCCIDENTE')
    WHERE sucursal IS NULL OR sucursal NOT IN ('CENTRO', 'OCCIDENTE');
  END IF;

  IF to_regclass('public."Supervisores"') IS NOT NULL AND to_regclass('public."Regiones"') IS NOT NULL THEN
    UPDATE public."Supervisores" sp
    SET sucursal = COALESCE(public.fn_inferir_sucursal_geografica(r.regi_desd), 'OCCIDENTE')
    FROM public."Regiones" r
    WHERE sp.id_regi::text = r.id_regi::text
      AND (sp.sucursal IS NULL OR sp.sucursal NOT IN ('CENTRO', 'OCCIDENTE'));
  END IF;

  -- 7.2 Clasificar public.vendedores (FDV)
  IF to_regclass('public.vendedores') IS NOT NULL THEN
    UPDATE public.vendedores v
    SET sucursal = COALESCE(
      public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', v.zona, v.supervisor, v.metadata ->> 'region_codigo')),
      public.normalizar_sucursal_multisede(v.sucursal),
      'OCCIDENTE'
    )
    WHERE v.sucursal IS NULL
       OR v.sucursal NOT IN ('CENTRO', 'OCCIDENTE')
       OR CONCAT_WS(' ', v.zona, v.metadata ->> 'region_codigo') ~* '(san diego|naguanagua|el sam[aá]n|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|centro|andes)';
  END IF;

  -- 7.3 Clasificar public.clientes (Makro San Diego, Naguanagua, El Samán Maracay, Turmero Maracay -> 'CENTRO')
  IF to_regclass('public.clientes') IS NOT NULL THEN
    UPDATE public.clientes c
    SET sucursal = CASE
      WHEN CONCAT_WS(' ', c.nombre_comercial, c.razon_social, c.direccion, c.ciudad, c.estado, c.zona, c.metadata ->> 'region_codigo') ~*
           '(makro\s+(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|valencia)|san diego|naguanagua|el sam[aá]n|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|guarico|caracas|distrito capital|miranda|la guaira|t[aá]chira|san crist[oó]bal|m[eé]rida|barinas|el vig[ií]a|andes)'
        THEN 'CENTRO'
      ELSE COALESCE(
        public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', c.nombre_comercial, c.razon_social, c.direccion, c.ciudad, c.estado, c.zona, c.metadata ->> 'region_codigo')),
        public.normalizar_sucursal_multisede(c.sucursal),
        'OCCIDENTE'
      )
    END
    WHERE c.sucursal IS NULL
       OR c.sucursal NOT IN ('CENTRO', 'OCCIDENTE')
       OR CONCAT_WS(' ', c.nombre_comercial, c.razon_social, c.direccion, c.ciudad, c.estado, c.zona, c.metadata ->> 'region_codigo') ~*
          '(makro\s+(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|valencia)|san diego|naguanagua|el sam[aá]n|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|caracas|miranda|centro|andes)';
  END IF;

  -- 7.4 Clasificar public.promotoras (soporta tanto `email` como `correo`) y public.staff
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    UPDATE public.promotoras pr
    SET sucursal = CASE
          WHEN LOWER(BTRIM(COALESCE(pr.email, pr.correo, ''))) IN (
            'paolamaldonado1805@gmail.com',
            'barbie.marqueztorres@gmail.com',
            'scarlett060219@gmail.com',
            'americac1809@gmail.com',
            'dosramosmariana0@gmail.com',
            'maizdajan04@gmail.com',
            'osverlys2025@gmail.com',
            'geyerlis2017@gmail.com',
            'rinconastrid10@gmail.com'
          )
          OR CONCAT_WS(' ', pr.ciudad, pr.estado, pr.direccion, pr.region) ~*
             '(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|paraparal|cagua|la victoria|puerto cabello|mariara|caracas|montalb|para[ií]so|plaza venezuela|distrito capital|miranda|t[aá]chira|san crist[oó]bal|m[eé]rida|barinas|el vig[ií]a|andes|centro)'
            THEN 'CENTRO'
          ELSE COALESCE(
            public.normalizar_sucursal_multisede(pr.sucursal),
            public.normalizar_sucursal_multisede(pr.region),
            public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', pr.ciudad, pr.estado, pr.direccion)),
            'OCCIDENTE'
          )
        END,
        region = CASE
          WHEN LOWER(BTRIM(COALESCE(pr.email, pr.correo, ''))) IN (
            'paolamaldonado1805@gmail.com',
            'barbie.marqueztorres@gmail.com',
            'scarlett060219@gmail.com',
            'americac1809@gmail.com',
            'dosramosmariana0@gmail.com',
            'maizdajan04@gmail.com',
            'osverlys2025@gmail.com',
            'geyerlis2017@gmail.com',
            'rinconastrid10@gmail.com'
          )
          OR CONCAT_WS(' ', pr.ciudad, pr.estado, pr.direccion, pr.region) ~*
             '(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|paraparal|cagua|la victoria|puerto cabello|mariara|caracas|montalb|para[ií]so|plaza venezuela|distrito capital|miranda|t[aá]chira|san crist[oó]bal|m[eé]rida|barinas|el vig[ií]a|andes|centro)'
            THEN 'CENTRO'
          ELSE COALESCE(
            public.normalizar_sucursal_multisede(pr.sucursal),
            public.normalizar_sucursal_multisede(pr.region),
            'OCCIDENTE'
          )
        END;
  END IF;

  IF to_regclass('public.staff') IS NOT NULL THEN
    UPDATE public.staff st
    SET sucursal = CASE
      WHEN CONCAT_WS(' ', st.name, st.email, st.status) ~*
           '(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|caracas|miranda|andes|merida|tachira|centro)'
        THEN 'CENTRO'
      ELSE COALESCE(public.normalizar_sucursal_multisede(st.sucursal), 'OCCIDENTE')
    END;
  END IF;

  -- 7.5 Clasificar solicitudes de degustación y encuestas (public.surveys)
  IF to_regclass('public.surveys') IS NOT NULL THEN
    UPDATE public.surveys s
    SET sucursal = CASE
          WHEN CONCAT_WS(' ', s.store, s.region, s.comments) ~*
               '(makro\s+(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|valencia)|san diego|naguanagua|el sam[aá]n|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|caracas|distrito capital|miranda|t[aá]chira|san crist[oó]bal|m[eé]rida|barinas|el vig[ií]a|andes)'
            THEN 'CENTRO'
          ELSE COALESCE(
            public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', s.store, s.region, s.comments)),
            public.normalizar_sucursal_multisede(s.sucursal),
            'OCCIDENTE'
          )
        END,
        region = CASE
          WHEN CONCAT_WS(' ', s.store, s.region, s.comments) ~*
               '(makro\s+(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|valencia)|san diego|naguanagua|el sam[aá]n|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|caracas|distrito capital|miranda|t[aá]chira|san crist[oó]bal|m[eé]rida|barinas|el vig[ií]a|andes)'
            THEN 'CENTRO'
          ELSE COALESCE(
            public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', s.store, s.region, s.comments)),
            public.normalizar_sucursal_multisede(s.sucursal),
            'OCCIDENTE'
          )
        END;

    -- Enriquecer desde public.promotoras (soporta promotora_id TEXT/UUID y promotoras.id BIGINT/UUID)
    IF to_regclass('public.promotoras') IS NOT NULL THEN
      UPDATE public.surveys s
      SET sucursal = pr.sucursal, region = pr.sucursal
      FROM public.promotoras pr
      WHERE s.promotora_id IS NOT NULL
        AND (
          s.promotora_id::text = pr.id::text
          OR s.promotora_id::text = pr.auth_user_id::text
        )
        AND pr.sucursal IN ('CENTRO', 'OCCIDENTE')
        AND s.sucursal IS DISTINCT FROM pr.sucursal
        AND public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', s.store, s.comments)) IS NULL;
    END IF;
  END IF;

  -- 7.6 Clasificar cronograma_degustaciones, rutas_promotoras, ejecuciones_pdv_promotora, entregas_degustacion, inventory, prices
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    UPDATE public.cronograma_degustaciones cd
    SET sucursal = CASE
          WHEN CONCAT_WS(' ', cd.cliente_nombre, cd.zona_direccion, cd.region, cd.observaciones) ~*
               '(makro\s+(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|valencia)|san diego|naguanagua|el sam[aá]n|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|caracas|miranda|andes|merida|tachira)'
            THEN 'CENTRO'
          ELSE COALESCE(
            (SELECT s.sucursal FROM public.surveys s WHERE cd.survey_origen_id IS NOT NULL AND s.id::text = cd.survey_origen_id::text AND s.sucursal IN ('CENTRO', 'OCCIDENTE') LIMIT 1),
            public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', cd.cliente_nombre, cd.zona_direccion, cd.region)),
            public.normalizar_sucursal_multisede(cd.sucursal),
            'OCCIDENTE'
          )
        END,
        region = CASE
          WHEN CONCAT_WS(' ', cd.cliente_nombre, cd.zona_direccion, cd.region, cd.observaciones) ~*
               '(makro\s+(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|valencia)|san diego|naguanagua|el sam[aá]n|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|caracas|miranda|andes|merida|tachira)'
            THEN 'CENTRO'
          ELSE COALESCE(
            (SELECT s.sucursal FROM public.surveys s WHERE cd.survey_origen_id IS NOT NULL AND s.id::text = cd.survey_origen_id::text AND s.sucursal IN ('CENTRO', 'OCCIDENTE') LIMIT 1),
            public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', cd.cliente_nombre, cd.zona_direccion, cd.region)),
            public.normalizar_sucursal_multisede(cd.sucursal),
            'OCCIDENTE'
          )
        END,
        chofer_sede = CASE
          WHEN CONCAT_WS(' ', cd.cliente_nombre, cd.zona_direccion, cd.region, cd.observaciones) ~*
               '(makro\s+(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|valencia)|san diego|naguanagua|el sam[aá]n|saman maracay|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|caracas|miranda|andes|merida|tachira)'
            THEN 'VALENCIA'
          WHEN COALESCE(
            (SELECT s.sucursal FROM public.surveys s WHERE cd.survey_origen_id IS NOT NULL AND s.id::text = cd.survey_origen_id::text AND s.sucursal IN ('CENTRO', 'OCCIDENTE') LIMIT 1),
            public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', cd.cliente_nombre, cd.zona_direccion, cd.region)),
            public.normalizar_sucursal_multisede(cd.sucursal),
            'OCCIDENTE'
          ) = 'CENTRO' THEN 'VALENCIA'
          ELSE 'OCCIDENTE'
        END;
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    UPDATE public.rutas_promotoras rp
    SET sucursal = COALESCE(
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', rp.cliente_nombre, rp.zona_direccion, rp.region)),
          public.normalizar_sucursal_multisede(rp.sucursal),
          'OCCIDENTE'
        ),
        region = COALESCE(
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', rp.cliente_nombre, rp.zona_direccion, rp.region)),
          public.normalizar_sucursal_multisede(rp.sucursal),
          'OCCIDENTE'
        );
  END IF;

  IF to_regclass('public.ejecuciones_pdv_promotora') IS NOT NULL THEN
    UPDATE public.ejecuciones_pdv_promotora ep
    SET sucursal = COALESCE(
      public.fn_inferir_sucursal_geografica(ep.cliente_nombre),
      public.normalizar_sucursal_multisede(ep.sucursal),
      'OCCIDENTE'
    );
  END IF;

  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    UPDATE public.entregas_degustacion ed
    SET sucursal = COALESCE(
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', ed.cliente, ed.region, ed.sucursal)),
          public.normalizar_sucursal_multisede(ed.sucursal),
          'OCCIDENTE'
        ),
        region = COALESCE(
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', ed.cliente, ed.region, ed.sucursal)),
          public.normalizar_sucursal_multisede(ed.sucursal),
          'OCCIDENTE'
        ),
        chofer_sede = CASE
          WHEN COALESCE(
            public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', ed.cliente, ed.region, ed.sucursal)),
            public.normalizar_sucursal_multisede(ed.sucursal),
            'OCCIDENTE'
          ) = 'CENTRO' THEN 'VALENCIA'
          ELSE 'OCCIDENTE'
        END;
  END IF;

  IF to_regclass('public.inventory') IS NOT NULL THEN
    UPDATE public.inventory inv
    SET sucursal = COALESCE(
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', inv.store, inv.zona, inv.region)),
          public.normalizar_sucursal_multisede(inv.sucursal),
          'OCCIDENTE'
        ),
        region = COALESCE(
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', inv.store, inv.zona, inv.region)),
          public.normalizar_sucursal_multisede(inv.sucursal),
          'OCCIDENTE'
        );
  END IF;

  IF to_regclass('public.prices') IS NOT NULL THEN
    UPDATE public.prices prc
    SET sucursal = COALESCE(
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', prc.store, prc.zona, prc.region)),
          public.normalizar_sucursal_multisede(prc.sucursal),
          'OCCIDENTE'
        ),
        region = COALESCE(
          public.fn_inferir_sucursal_geografica(CONCAT_WS(' ', prc.store, prc.zona, prc.region)),
          public.normalizar_sucursal_multisede(prc.sucursal),
          'OCCIDENTE'
        );
  END IF;

  -- Normalizar el resto de tablas regionales secundarias
  FOR v_tbl IN
    SELECT unnest(ARRAY[
      'cadenas_comerciales',
      'zonas',
      'supervisores',
      'sesiones_jornada',
      'offline_mutation_receipts',
      'asistencias_jornada',
      'asistencia_evidencias',
      'checkins',
      'reportes_trade',
      'incidencias_pdv',
      'material_pop_inventario',
      'material_pop_entregas',
      'solicitudes_contraloria',
      'contraloria_requisiciones',
      'contraloria_conciliaciones',
      'contraloria_facturas',
      'certificados_paz_y_salvo',
      'campanas_trade',
      'presupuestos_trade',
      'tarifario_costos_trade',
      'alertas_precios',
      'configuracion_alertas_precios',
      'alertas_geocerca_auditoria',
      'discrepancy_alerts',
      'notificaciones_outbox',
      'cliente_portal_accesos',
      'cargas_archivos',
      'lotes_sincronizacion'
    ])
  LOOP
    IF to_regclass(format('public.%I', v_tbl)) IS NOT NULL THEN
      EXECUTE format(
        'UPDATE public.%I SET sucursal = COALESCE(public.normalizar_sucursal_multisede(sucursal), ''OCCIDENTE'') WHERE sucursal IS NULL OR sucursal NOT IN (''CENTRO'', ''OCCIDENTE'')',
        v_tbl
      );
    END IF;
  END LOOP;

  -- 7.7 Verificación atómica previa a SET NOT NULL + CHECK (sucursal IN ('CENTRO', 'OCCIDENTE'))
  FOREACH v_tbl IN ARRAY v_core_not_null_tables LOOP
    IF to_regclass(format('public.%I', v_tbl)) IS NOT NULL THEN
      EXECUTE format(
        'SELECT COUNT(*) FROM public.%I WHERE sucursal IS NULL OR sucursal NOT IN (''CENTRO'', ''OCCIDENTE'')',
        v_tbl
      ) INTO v_ambiguous_count;

      IF v_ambiguous_count > 0 THEN
        RAISE EXCEPTION 'MIGRACION_ABORTADA_REGISTROS_AMBIGUOS: La tabla public.% aún contiene % registro(s) sin sucursal válida (CENTRO/OCCIDENTE). Ejecute sql/auditoria_previa_multisede_centro_occidente.sql para revisarlos.', v_tbl, v_ambiguous_count;
      END IF;

      FOR v_check_name IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = v_tbl
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) ILIKE '%sucursal%'
      LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_tbl, v_check_name);
      END LOOP;

      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (sucursal IN (''CENTRO'', ''OCCIDENTE''))',
        v_tbl,
        'chk_' || lower(v_tbl) || '_sucursal_multisede'
      );
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN sucursal SET NOT NULL', v_tbl);
    END IF;
  END LOOP;
END
$$;


-- ==============================================================================
-- BLOQUE 3 — COMPATIBILIDAD PUENTE CON LA APP EXTERNA DE VENDEDORES (FDV)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_trg_inferir_sucursal_degustacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB;
  v_comments JSONB := '{}'::jsonb;
  v_explicit TEXT;
  v_geo TEXT;
  v_from_vendedor TEXT;
  v_from_cliente TEXT;
  v_vendedor_token TEXT;
  v_cliente_codigo TEXT;
  v_store_name TEXT;
  v_raw_concat TEXT;
BEGIN
  v_row := to_jsonb(NEW);
  v_comments := public.fn_safe_jsonb(v_row ->> 'comments');

  v_store_name := BTRIM(COALESCE(
    v_row ->> 'store',
    v_row ->> 'cliente_nombre',
    v_row ->> 'nombre_comercial',
    v_row ->> 'clie_nomb',
    v_comments ->> 'client',
    v_comments ->> 'store',
    ''
  ));

  v_cliente_codigo := BTRIM(COALESCE(
    v_row ->> 'cliente_codigo',
    v_row ->> 'codigo_cliente',
    v_row ->> 'clie_rif',
    v_comments ->> 'clienteCodigo',
    v_comments ->> 'codigo_cliente',
    ''
  ));

  v_vendedor_token := BTRIM(COALESCE(
    v_row ->> 'vendedor_fdv',
    v_row ->> 'codigo_vendedor',
    v_row ->> 'vend_codi',
    v_comments ->> 'vendedorId',
    v_comments ->> 'codigoVendedor',
    v_comments ->> 'vendedor',
    ''
  ));

  v_raw_concat := CONCAT_WS(
    ' ',
    v_store_name,
    v_row ->> 'zona_direccion',
    v_row ->> 'direccion',
    v_row ->> 'ciudad',
    v_row ->> 'estado',
    v_row ->> 'zona',
    v_row ->> 'ruta',
    v_row ->> 'region',
    v_comments ->> 'sucursal',
    v_comments ->> 'region',
    v_comments ->> 'estado',
    v_comments ->> 'ciudad',
    v_comments ->> 'zona',
    v_comments ->> 'ruta',
    v_comments ->> 'route'
  );

  v_geo := public.fn_inferir_sucursal_geografica(v_raw_concat);
  v_explicit := public.normalizar_sucursal_multisede(NEW.sucursal);

  IF v_explicit = 'CENTRO' THEN
    NEW.sucursal := 'CENTRO';
  ELSIF v_explicit = 'OCCIDENTE' AND COALESCE(UPPER(BTRIM(NEW.sucursal)), '') = 'OCCIDENTE' AND v_geo IS DISTINCT FROM 'CENTRO' THEN
    NEW.sucursal := 'OCCIDENTE';
  ELSE
    -- 1) Inferencia por Vendedor FDV en public.vendedores o public."Vendedores"
    IF v_vendedor_token <> '' AND to_regclass('public.vendedores') IS NOT NULL THEN
      SELECT v.sucursal INTO v_from_vendedor
      FROM public.vendedores v
      WHERE (
        UPPER(BTRIM(COALESCE(v.codigo_vendedor, ''))) = UPPER(v_vendedor_token)
        OR UPPER(BTRIM(COALESCE(v.nombre_completo, ''))) = UPPER(v_vendedor_token)
        OR v.id::text = v_vendedor_token
      )
        AND v.sucursal IN ('CENTRO', 'OCCIDENTE')
      LIMIT 1;
    END IF;

    IF v_from_vendedor IS NULL AND v_vendedor_token <> '' AND to_regclass('public."Vendedores"') IS NOT NULL THEN
      SELECT v.sucursal INTO v_from_vendedor
      FROM public."Vendedores" v
      WHERE (
        UPPER(BTRIM(COALESCE(v.vend_codi::text, ''))) = UPPER(v_vendedor_token)
        OR UPPER(BTRIM(COALESCE(v.vend_nomb, ''))) = UPPER(v_vendedor_token)
        OR v.id_vend::text = v_vendedor_token
      )
        AND v.sucursal IN ('CENTRO', 'OCCIDENTE')
      LIMIT 1;
    END IF;

    -- 2) Inferencia por Cliente / Tienda en public.clientes o public."Clientes"
    IF (v_cliente_codigo <> '' OR v_store_name <> '') AND to_regclass('public.clientes') IS NOT NULL THEN
      SELECT c.sucursal INTO v_from_cliente
      FROM public.clientes c
      WHERE (
        (v_cliente_codigo <> '' AND UPPER(BTRIM(COALESCE(c.codigo_cliente, ''))) = UPPER(v_cliente_codigo))
        OR (v_store_name <> '' AND (
          UPPER(BTRIM(COALESCE(c.nombre_comercial, ''))) = UPPER(v_store_name)
          OR UPPER(BTRIM(COALESCE(c.razon_social, ''))) = UPPER(v_store_name)
        ))
      )
        AND c.sucursal IN ('CENTRO', 'OCCIDENTE')
      LIMIT 1;
    END IF;

    IF v_from_cliente IS NULL AND (v_cliente_codigo <> '' OR v_store_name <> '') AND to_regclass('public."Clientes"') IS NOT NULL THEN
      SELECT c.sucursal INTO v_from_cliente
      FROM public."Clientes" c
      WHERE (
        (v_cliente_codigo <> '' AND UPPER(BTRIM(COALESCE(c.clie_rif, ''))) = UPPER(v_cliente_codigo))
        OR (v_store_name <> '' AND UPPER(BTRIM(COALESCE(c.clie_nomb, ''))) = UPPER(v_store_name))
      )
        AND c.sucursal IN ('CENTRO', 'OCCIDENTE')
      LIMIT 1;
    END IF;

    -- 3) Prioridad final: Geografía Centro -> Cliente -> Vendedor -> Geografía Occidente -> Sesión -> Explicit -> 'OCCIDENTE'
    NEW.sucursal := COALESCE(
      CASE WHEN v_geo = 'CENTRO' THEN 'CENTRO' ELSE NULL END,
      v_from_cliente,
      v_from_vendedor,
      v_geo,
      (SELECT public.obtener_mi_sucursal()),
      v_explicit,
      'OCCIDENTE'
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_inferir_sucursal_degustacion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_inferir_sucursal_degustacion() TO authenticated, service_role;

-- Trigger ligero y nativo para mantener sincronizada la columna `region` espejo sin alterar otras columnas
CREATE OR REPLACE FUNCTION public.fn_trg_sync_region_from_sucursal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sucursal IN ('CENTRO', 'OCCIDENTE') THEN
    NEW.region := NEW.sucursal;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_trg_sync_region_from_sucursal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trg_sync_region_from_sucursal() TO authenticated, service_role;

-- Adjuntar Triggers BEFORE INSERT OR UPDATE de forma segura sobre todas las tablas existentes
DO $$
DECLARE
  v_tbl TEXT;
  v_has_region BOOLEAN;
  v_trigger_tables TEXT[] := ARRAY[
    'surveys',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'ejecuciones_pdv_promotora',
    'entregas_degustacion',
    'inventory',
    'prices',
    'clientes',
    'promotoras',
    'vendedores'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_trigger_tables LOOP
    IF to_regclass(format('public.%I', v_tbl)) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_aa_inferir_sucursal_multisede ON public.%I', v_tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_aa_inferir_sucursal_multisede BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_trg_inferir_sucursal_degustacion()',
        v_tbl
      );

      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = v_tbl AND column_name = 'region'
      ) INTO v_has_region;

      IF v_has_region THEN
        EXECUTE format('DROP TRIGGER IF EXISTS trg_ab_sync_region_from_sucursal ON public.%I', v_tbl);
        EXECUTE format(
          'CREATE TRIGGER trg_ab_sync_region_from_sucursal BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_trg_sync_region_from_sucursal()',
          v_tbl
        );
      END IF;
    END IF;
  END LOOP;

  -- Declaración explícita del Trigger puente sobre public.surveys (app externa FDV)
  IF to_regclass('public.surveys') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_aa_inferir_sucursal_multisede ON public.surveys;
    CREATE TRIGGER trg_aa_inferir_sucursal_multisede
      BEFORE INSERT OR UPDATE ON public.surveys
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_trg_inferir_sucursal_degustacion();
  END IF;
END
$$;

-- RPC puente de ingesta idempotente para dashboard-fdv-planificador (sin exponer lectura)
CREATE OR REPLACE FUNCTION public.ingestar_solicitud_fdv(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store TEXT;
  v_date TEXT;
  v_product TEXT;
  v_deg_key TEXT;
  v_inserted_id TEXT;
  v_sucursal TEXT;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'PAYLOAD_FDV_INVALIDO' USING ERRCODE = '22023';
  END IF;

  v_store := NULLIF(BTRIM(COALESCE(p_payload ->> 'store', p_payload ->> 'client', '')), '');
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'TIENDA_REQUERIDA_FDV' USING ERRCODE = '22023';
  END IF;

  v_date := COALESCE(NULLIF(BTRIM(COALESCE(p_payload ->> 'date', '')), ''), CURRENT_DATE::text);
  v_product := COALESCE(NULLIF(BTRIM(COALESCE(p_payload ->> 'product', '')), ''), 'Degustación Solicitada FDV');
  v_deg_key := NULLIF(BTRIM(COALESCE(p_payload ->> 'degustacionId', p_payload ->> 'degustacion_key', '')), '');

  IF v_deg_key IS NOT NULL THEN
    SELECT s.id::text, s.sucursal INTO v_inserted_id, v_sucursal
    FROM public.surveys s
    WHERE s.degustacion_key = v_deg_key
    LIMIT 1;
  END IF;

  IF v_inserted_id IS NULL THEN
    INSERT INTO public.surveys (
      type,
      date,
      store,
      promoter,
      product,
      comments,
      degustacion_key,
      leido_trade,
      en_historial,
      autor_user_id
    ) VALUES (
      'Degustacion',
      v_date,
      v_store,
      'Por Asignar Trade',
      v_product,
      (p_payload || jsonb_build_object('estado', 'SOLICITADA', 'origin', 'fdv_planificador'))::text,
      v_deg_key,
      false,
      false,
      (SELECT auth.uid())
    )
    RETURNING id::text, sucursal INTO v_inserted_id, v_sucursal;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_inserted_id,
    'sucursal', v_sucursal
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingestar_solicitud_fdv(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingestar_solicitud_fdv(JSONB) TO anon, authenticated, service_role;


-- ==============================================================================
-- BLOQUE 4 — ROW LEVEL SECURITY (RLS) ESTRICTO EN SUPABASE
--   Ninguna coordinadora de 'OCCIDENTE' puede leer, autorizar, editar ni borrar
--   filas de 'CENTRO' y viceversa, ni siquiera invocando la API REST manualmente.
-- ==============================================================================

DO $$
DECLARE
  v_tbl TEXT;
  v_pol RECORD;
  v_strict_tables TEXT[] := ARRAY[
    'clientes',
    'Clientes',
    'cadenas_comerciales',
    'zonas',
    'promotoras',
    'staff',
    'vendedores',
    'Vendedores',
    'supervisores',
    'Supervisores',
    'Sucursales',
    'cronograma_degustaciones',
    'rutas_promotoras',
    'ejecuciones_pdv_promotora',
    'entregas_degustacion',
    'sesiones_jornada',
    'offline_mutation_receipts',
    'inventory',
    'prices',
    'asistencias_jornada',
    'asistencia_evidencias',
    'checkins',
    'reportes_trade',
    'incidencias_pdv',
    'material_pop_inventario',
    'material_pop_entregas',
    'solicitudes_contraloria',
    'contraloria_requisiciones',
    'contraloria_conciliaciones',
    'contraloria_facturas',
    'certificados_paz_y_salvo',
    'campanas_trade',
    'presupuestos_trade',
    'tarifario_costos_trade',
    'alertas_precios',
    'configuracion_alertas_precios',
    'alertas_geocerca_auditoria',
    'discrepancy_alerts',
    'notificaciones_outbox',
    'cliente_portal_accesos',
    'cargas_archivos',
    'lotes_sincronizacion',
    'enlaces_publicos_sucursal'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_strict_tables LOOP
    IF to_regclass(format('public.%I', v_tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', v_tbl);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', v_tbl);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', v_tbl);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tbl);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_tbl);

      FOR v_pol IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_tbl
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_pol.policyname, v_tbl);
      END LOOP;

      EXECUTE format(
        'CREATE POLICY rls_multisede_select ON public.%I FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()))',
        v_tbl
      );
      EXECUTE format(
        'CREATE POLICY rls_multisede_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()))',
        v_tbl
      );
      EXECUTE format(
        'CREATE POLICY rls_multisede_update ON public.%I FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()))',
        v_tbl
      );
      EXECUTE format(
        'CREATE POLICY rls_multisede_delete ON public.%I FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()))',
        v_tbl
      );
    END IF;
  END LOOP;
END
$$;

-- Declaración explícita y auditable de políticas RLS en tablas troncales (con guarda to_regclass)
DO $$
BEGIN
  IF to_regclass('public.clientes') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.clientes;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.clientes;
    DROP POLICY IF EXISTS rls_multisede_update ON public.clientes;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.clientes;
    CREATE POLICY rls_multisede_select ON public.clientes FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.clientes FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.clientes FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.clientes FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.vendedores') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.vendedores;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.vendedores;
    DROP POLICY IF EXISTS rls_multisede_update ON public.vendedores;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.vendedores;
    CREATE POLICY rls_multisede_select ON public.vendedores FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.vendedores FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.vendedores FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.vendedores FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.promotoras') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.promotoras;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.promotoras;
    DROP POLICY IF EXISTS rls_multisede_update ON public.promotoras;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.promotoras;
    CREATE POLICY rls_multisede_select ON public.promotoras FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.promotoras FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.promotoras FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.promotoras FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.staff') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.staff;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.staff;
    DROP POLICY IF EXISTS rls_multisede_update ON public.staff;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.staff;
    CREATE POLICY rls_multisede_select ON public.staff FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.staff FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.staff FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.staff FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS rls_multisede_update ON public.cronograma_degustaciones;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.cronograma_degustaciones;
    CREATE POLICY rls_multisede_select ON public.cronograma_degustaciones FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.cronograma_degustaciones FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.cronograma_degustaciones FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.cronograma_degustaciones FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.rutas_promotoras') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.rutas_promotoras;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.rutas_promotoras;
    DROP POLICY IF EXISTS rls_multisede_update ON public.rutas_promotoras;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.rutas_promotoras;
    CREATE POLICY rls_multisede_select ON public.rutas_promotoras FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.rutas_promotoras FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.rutas_promotoras FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.rutas_promotoras FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.entregas_degustacion') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.entregas_degustacion;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.entregas_degustacion;
    DROP POLICY IF EXISTS rls_multisede_update ON public.entregas_degustacion;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.entregas_degustacion;
    CREATE POLICY rls_multisede_select ON public.entregas_degustacion FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.entregas_degustacion FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.entregas_degustacion FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.entregas_degustacion FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.asistencias_jornada') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.asistencias_jornada;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.asistencias_jornada;
    DROP POLICY IF EXISTS rls_multisede_update ON public.asistencias_jornada;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.asistencias_jornada;
    CREATE POLICY rls_multisede_select ON public.asistencias_jornada FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.asistencias_jornada FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.asistencias_jornada FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.asistencias_jornada FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.asistencia_evidencias') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.asistencia_evidencias;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.asistencia_evidencias;
    DROP POLICY IF EXISTS rls_multisede_update ON public.asistencia_evidencias;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.asistencia_evidencias;
    CREATE POLICY rls_multisede_select ON public.asistencia_evidencias FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.asistencia_evidencias FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.asistencia_evidencias FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.asistencia_evidencias FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  IF to_regclass('public.solicitudes_contraloria') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_select ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS rls_multisede_insert ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS rls_multisede_update ON public.solicitudes_contraloria;
    DROP POLICY IF EXISTS rls_multisede_delete ON public.solicitudes_contraloria;
    CREATE POLICY rls_multisede_select ON public.solicitudes_contraloria FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_insert ON public.solicitudes_contraloria FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_update ON public.solicitudes_contraloria FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
    CREATE POLICY rls_multisede_delete ON public.solicitudes_contraloria FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  END IF;

  DROP POLICY IF EXISTS rls_multisede_select ON public.enlaces_publicos_sucursal;
  DROP POLICY IF EXISTS rls_multisede_insert ON public.enlaces_publicos_sucursal;
  DROP POLICY IF EXISTS rls_multisede_update ON public.enlaces_publicos_sucursal;
  DROP POLICY IF EXISTS rls_multisede_delete ON public.enlaces_publicos_sucursal;
  CREATE POLICY rls_multisede_select ON public.enlaces_publicos_sucursal FOR SELECT TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  CREATE POLICY rls_multisede_insert ON public.enlaces_publicos_sucursal FOR INSERT TO authenticated WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  CREATE POLICY rls_multisede_update ON public.enlaces_publicos_sucursal FOR UPDATE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional())) WITH CHECK (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
  CREATE POLICY rls_multisede_delete ON public.enlaces_publicos_sucursal FOR DELETE TO authenticated USING (sucursal = (SELECT public.obtener_mi_sucursal()) OR (SELECT public.es_admin_nacional()));
END
$$;

-- Políticas estrictas en public.surveys (coordinadora aislada por sucursal + puente seguro FDV propio)
DO $$
DECLARE
  v_pol RECORD;
BEGIN
  IF to_regclass('public.surveys') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.surveys FROM PUBLIC, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.surveys TO authenticated;
    GRANT ALL ON TABLE public.surveys TO service_role;

    ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.surveys FORCE ROW LEVEL SECURITY;

    FOR v_pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'surveys'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.surveys', v_pol.policyname);
    END LOOP;

    CREATE POLICY rls_multisede_surveys_select
      ON public.surveys
      FOR SELECT
      TO authenticated
      USING (
        sucursal = (SELECT public.obtener_mi_sucursal())
        OR (SELECT public.es_admin_nacional())
        OR (
          autor_user_id IS NOT NULL
          AND autor_user_id::text = (SELECT auth.uid())::text
        )
      );

    CREATE POLICY rls_multisede_surveys_insert
      ON public.surveys
      FOR INSERT
      TO authenticated
      WITH CHECK (
        sucursal = (SELECT public.obtener_mi_sucursal())
        OR (SELECT public.es_admin_nacional())
        OR (
          type = 'Degustacion'
          AND sucursal IN ('CENTRO', 'OCCIDENTE')
          AND (autor_user_id IS NULL OR autor_user_id::text = (SELECT auth.uid())::text)
        )
      );

    CREATE POLICY rls_multisede_surveys_update
      ON public.surveys
      FOR UPDATE
      TO authenticated
      USING (
        sucursal = (SELECT public.obtener_mi_sucursal())
        OR (SELECT public.es_admin_nacional())
      )
      WITH CHECK (
        sucursal = (SELECT public.obtener_mi_sucursal())
        OR (SELECT public.es_admin_nacional())
      );

    CREATE POLICY rls_multisede_surveys_delete
      ON public.surveys
      FOR DELETE
      TO authenticated
      USING (
        sucursal = (SELECT public.obtener_mi_sucursal())
        OR (SELECT public.es_admin_nacional())
      );
  END IF;
END
$$;

-- Aislamiento de Buckets Privados en storage.objects por sucursal activa
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS rls_multisede_storage_select ON storage.objects;
    CREATE POLICY rls_multisede_storage_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id IN ('asistencia-evidencias', 'entregas-evidencias', 'incidencias-evidencias')
        AND (
          (SELECT public.es_admin_nacional())
          OR EXISTS (
            SELECT 1
            FROM public.promotoras pr
            WHERE (pr.id::text = (storage.foldername(name))[1] OR pr.auth_user_id::text = (storage.foldername(name))[1])
              AND pr.sucursal = (SELECT public.obtener_mi_sucursal())
          )
        )
      );
  END IF;
END
$$;


-- ==============================================================================
-- BLOQUE 5 — AISLAMIENTO SEGURO DEL ENLACE PÚBLICO DE PROMOTORAS (SIN LOGIN)
--   Tokens criptográficos regionales independientes ('CENTRO' vs 'OCCIDENTE')
--   revocables/regenerables desde el botón "Enlaces" de cada coordinadora.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_sha256_token_hex(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(BTRIM(COALESCE(p_token, '')), 'UTF8')),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION public.fn_sha256_token_hex(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_sha256_token_hex(TEXT) TO anon, authenticated, service_role;

-- 5.1 RPC autenticado: Obtener o crear el enlace público activo de la sucursal de la coordinadora
CREATE OR REPLACE FUNCTION public.obtener_o_crear_enlace_pdv_mi_sucursal(
  p_sucursal_override TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_mi_sucursal TEXT;
  v_target_sucursal TEXT;
  v_existing public.enlaces_publicos_sucursal%ROWTYPE;
  v_raw_token TEXT;
  v_hash TEXT;
  v_hint TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTENTICACION_REQUERIDA' USING ERRCODE = '42501';
  END IF;

  v_mi_sucursal := (SELECT public.obtener_mi_sucursal());
  IF (SELECT public.es_admin_nacional()) AND p_sucursal_override IS NOT NULL THEN
    v_target_sucursal := public.normalizar_sucursal_multisede(p_sucursal_override);
  ELSE
    v_target_sucursal := v_mi_sucursal;
  END IF;

  IF v_target_sucursal IS NULL OR v_target_sucursal NOT IN ('CENTRO', 'OCCIDENTE') THEN
    RAISE EXCEPTION 'SUCURSAL_NO_AUTORIZADA' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.es_admin_nacional()) AND v_target_sucursal IS DISTINCT FROM v_mi_sucursal THEN
    RAISE EXCEPTION 'ACCESO_DENEGADO_SUCURSAL_CRUZADA' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_existing
  FROM public.enlaces_publicos_sucursal e
  WHERE e.sucursal = v_target_sucursal
    AND e.activo = true
    AND e.revoked_at IS NULL
    AND (e.expires_at IS NULL OR e.expires_at > now())
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id', v_existing.id,
      'sucursal', v_existing.sucursal,
      'token', v_existing.token_publico,
      'token_hint', v_existing.token_hint,
      'created_at', v_existing.created_at,
      'last_used_at', v_existing.last_used_at,
      'uso_contador', v_existing.uso_contador
    );
  END IF;

  v_raw_token := LOWER(v_target_sucursal) || '_' ||
                 replace(gen_random_uuid()::text, '-', '') ||
                 replace(gen_random_uuid()::text, '-', '');
  v_hash := public.fn_sha256_token_hex(v_raw_token);
  v_hint := LEFT(v_raw_token, 12) || '...' || RIGHT(v_raw_token, 6);

  INSERT INTO public.enlaces_publicos_sucursal (
    sucursal,
    token_hash,
    token_publico,
    token_hint,
    activo,
    created_by
  ) VALUES (
    v_target_sucursal,
    v_hash,
    v_raw_token,
    v_hint,
    true,
    v_uid
  )
  RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'id', v_existing.id,
    'sucursal', v_existing.sucursal,
    'token', v_existing.token_publico,
    'token_hint', v_existing.token_hint,
    'created_at', v_existing.created_at,
    'last_used_at', v_existing.last_used_at,
    'uso_contador', v_existing.uso_contador
  );
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_o_crear_enlace_pdv_mi_sucursal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obtener_o_crear_enlace_pdv_mi_sucursal(TEXT) TO authenticated, service_role;

-- 5.2 RPC autenticado: Revocar el token actual y emitir uno nuevo para la sucursal activa
CREATE OR REPLACE FUNCTION public.regenerar_enlace_pdv_mi_sucursal(
  p_sucursal_override TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_mi_sucursal TEXT;
  v_target_sucursal TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTENTICACION_REQUERIDA' USING ERRCODE = '42501';
  END IF;

  v_mi_sucursal := (SELECT public.obtener_mi_sucursal());
  IF (SELECT public.es_admin_nacional()) AND p_sucursal_override IS NOT NULL THEN
    v_target_sucursal := public.normalizar_sucursal_multisede(p_sucursal_override);
  ELSE
    v_target_sucursal := v_mi_sucursal;
  END IF;

  IF v_target_sucursal IS NULL OR v_target_sucursal NOT IN ('CENTRO', 'OCCIDENTE') THEN
    RAISE EXCEPTION 'SUCURSAL_NO_AUTORIZADA' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.es_admin_nacional()) AND v_target_sucursal IS DISTINCT FROM v_mi_sucursal THEN
    RAISE EXCEPTION 'ACCESO_DENEGADO_SUCURSAL_CRUZADA' USING ERRCODE = '42501';
  END IF;

  UPDATE public.enlaces_publicos_sucursal
  SET activo = false,
      revoked_at = now(),
      revoked_by = v_uid
  WHERE sucursal = v_target_sucursal
    AND activo = true
    AND revoked_at IS NULL;

  RETURN public.obtener_o_crear_enlace_pdv_mi_sucursal(v_target_sucursal);
END;
$$;

REVOKE ALL ON FUNCTION public.regenerar_enlace_pdv_mi_sucursal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regenerar_enlace_pdv_mi_sucursal(TEXT) TO authenticated, service_role;

-- 5.3 RPC autenticado: Revocar enlace público sin emitir reemplazo inmediato
CREATE OR REPLACE FUNCTION public.revocar_enlace_pdv_mi_sucursal(
  p_sucursal_override TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_mi_sucursal TEXT;
  v_target_sucursal TEXT;
  v_revoked_count INT := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTENTICACION_REQUERIDA' USING ERRCODE = '42501';
  END IF;

  v_mi_sucursal := (SELECT public.obtener_mi_sucursal());
  IF (SELECT public.es_admin_nacional()) AND p_sucursal_override IS NOT NULL THEN
    v_target_sucursal := public.normalizar_sucursal_multisede(p_sucursal_override);
  ELSE
    v_target_sucursal := v_mi_sucursal;
  END IF;

  IF v_target_sucursal IS NULL OR v_target_sucursal NOT IN ('CENTRO', 'OCCIDENTE') THEN
    RAISE EXCEPTION 'SUCURSAL_NO_AUTORIZADA' USING ERRCODE = '42501';
  END IF;

  IF NOT (SELECT public.es_admin_nacional()) AND v_target_sucursal IS DISTINCT FROM v_mi_sucursal THEN
    RAISE EXCEPTION 'ACCESO_DENEGADO_SUCURSAL_CRUZADA' USING ERRCODE = '42501';
  END IF;

  UPDATE public.enlaces_publicos_sucursal
  SET activo = false,
      revoked_at = now(),
      revoked_by = v_uid
  WHERE sucursal = v_target_sucursal
    AND activo = true
    AND revoked_at IS NULL;

  GET DIAGNOSTICS v_revoked_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'sucursal', v_target_sucursal,
    'revocados', v_revoked_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revocar_enlace_pdv_mi_sucursal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revocar_enlace_pdv_mi_sucursal(TEXT) TO authenticated, service_role;

-- 5.4 RPC Público sin Login: public.obtener_datos_pdv_por_token(p_token text)
--     Retorna EXCLUSIVAMENTE tiendas, promotoras y degustaciones autorizadas de la sucursal
--     asociada al token + el catálogo maestro nacional de productos (soporta tablas ERP y normalizadas).
CREATE OR REPLACE FUNCTION public.obtener_datos_pdv_por_token(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_token TEXT := BTRIM(COALESCE(p_token, ''));
  v_hash TEXT;
  v_link public.enlaces_publicos_sucursal%ROWTYPE;
  v_sucursal TEXT;
  v_tiendas JSONB := '[]'::jsonb;
  v_promotoras JSONB := '[]'::jsonb;
  v_deg_crono JSONB := '[]'::jsonb;
  v_deg_surv JSONB := '[]'::jsonb;
  v_productos JSONB := '[]'::jsonb;
BEGIN
  IF length(v_clean_token) < 24 OR length(v_clean_token) > 256 THEN
    RAISE EXCEPTION 'TOKEN_PDV_INVALIDO_O_REVOCADO' USING ERRCODE = '42501';
  END IF;

  v_hash := public.fn_sha256_token_hex(v_clean_token);

  SELECT *
    INTO v_link
  FROM public.enlaces_publicos_sucursal e
  WHERE e.token_hash = v_hash
    AND e.activo = true
    AND e.revoked_at IS NULL
    AND (e.expires_at IS NULL OR e.expires_at > now())
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOKEN_PDV_INVALIDO_O_REVOCADO' USING ERRCODE = '42501';
  END IF;

  v_sucursal := v_link.sucursal;

  UPDATE public.enlaces_publicos_sucursal
  SET last_used_at = now(),
      uso_contador = uso_contador + 1
  WHERE id = v_link.id;

  -- a) Tiendas activas EXCLUSIVAS de la sucursal del token (prioriza public.clientes; respaldo ERP "Clientes")
  IF to_regclass('public.clientes') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(t ORDER BY t.nombre_comercial), '[]'::jsonb)
      INTO v_tiendas
    FROM (
      SELECT
        c.id::text AS id,
        c.codigo_cliente,
        COALESCE(NULLIF(BTRIM(c.nombre_comercial), ''), c.razon_social) AS nombre_comercial,
        c.ciudad,
        c.estado,
        c.zona,
        c.ruta,
        c.latitud,
        c.longitud,
        COALESCE((to_jsonb(c) ->> 'radio_geocerca_m')::int, 250) AS radio_geocerca_m
      FROM public.clientes c
      WHERE c.sucursal = v_sucursal
        AND COALESCE(c.activo, true) = true
      LIMIT 1500
    ) t;
  END IF;

  IF jsonb_array_length(v_tiendas) = 0 AND to_regclass('public."Clientes"') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(t ORDER BY t.nombre_comercial), '[]'::jsonb)
      INTO v_tiendas
    FROM (
      SELECT
        c.id_clie::text AS id,
        c.clie_rif AS codigo_cliente,
        c.clie_nomb AS nombre_comercial,
        NULL::text AS ciudad,
        NULL::text AS estado,
        v_sucursal AS zona,
        NULL::text AS ruta,
        c.clie_lati AS latitud,
        c.clie_long AS longitud,
        250::int AS radio_geocerca_m
      FROM public."Clientes" c
      WHERE c.sucursal = v_sucursal
        AND COALESCE(c.clie_acti, true) = true
      LIMIT 1500
    ) t;
  END IF;

  -- b) Promotoras activas EXCLUSIVAS de la sucursal del token (id::text soporta BIGINT o UUID)
  IF to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(p ORDER BY p.nombre_completo), '[]'::jsonb)
      INTO v_promotoras
    FROM (
      SELECT
        pr.id::text AS id,
        pr.nombre_completo,
        COALESCE(pr.categoria, 'Fijas') AS categoria
      FROM public.promotoras pr
      WHERE pr.sucursal = v_sucursal
        AND COALESCE(pr.activo, true) = true
    ) p;
  END IF;

  -- c) Degustaciones autorizadas / vigentes EXCLUSIVAS de la sucursal del token
  IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(d ORDER BY d.fecha DESC, d.cliente_nombre ASC), '[]'::jsonb)
      INTO v_deg_crono
    FROM (
      SELECT
        cd.id::text AS degustacion_id,
        'cronograma'::text AS fuente,
        cd.survey_origen_id::text AS survey_origen_id,
        cd.fecha::text AS fecha,
        COALESCE(cd.turno, 'MAÑANA') AS turno,
        cd.cliente_nombre,
        cd.cliente_codigo,
        cd.zona_direccion,
        cd.producto_resumen,
        cd.productos,
        cd.promotora_id::text AS promotora_id,
        cd.promotora_nombre,
        cd.vendedor_fdv,
        cd.estado
      FROM public.cronograma_degustaciones cd
      WHERE cd.sucursal = v_sucursal
        AND COALESCE(cd.en_historial, false) = false
        AND UPPER(COALESCE(cd.estado, '')) IN ('APROBADA', 'AUTORIZADA', 'EN_CURSO', 'PROGRAMADA')
        AND cd.fecha >= (CURRENT_DATE - INTERVAL '7 days')
      LIMIT 200
    ) d;
  END IF;

  IF to_regclass('public.surveys') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(d ORDER BY d.fecha DESC, d.cliente_nombre ASC), '[]'::jsonb)
      INTO v_deg_surv
    FROM (
      SELECT
        s.id::text AS degustacion_id,
        'survey'::text AS fuente,
        s.id::text AS survey_origen_id,
        COALESCE(s.date::text, CURRENT_DATE::text) AS fecha,
        COALESCE(public.fn_safe_jsonb(s.comments) ->> 'turno', 'MAÑANA') AS turno,
        COALESCE(s.store, 'PDV') AS cliente_nombre,
        (public.fn_safe_jsonb(s.comments) ->> 'clienteCodigo') AS cliente_codigo,
        COALESCE(public.fn_safe_jsonb(s.comments) ->> 'zona', v_sucursal) AS zona_direccion,
        COALESCE(s.product, 'Degustación Autorizada') AS producto_resumen,
        '[]'::jsonb AS productos,
        s.promotora_id::text AS promotora_id,
        s.promoter AS promotora_nombre,
        (public.fn_safe_jsonb(s.comments) ->> 'vendedor') AS vendedor_fdv,
        COALESCE(
          UPPER(COALESCE(public.fn_safe_jsonb(s.comments) ->> 'estado', public.fn_safe_jsonb(s.comments) ->> 'status')),
          'APROBADA'
        ) AS estado
      FROM public.surveys s
      WHERE s.sucursal = v_sucursal
        AND s.type = 'Degustacion'
        AND COALESCE(s.en_historial, false) = false
        AND UPPER(COALESCE(public.fn_safe_jsonb(s.comments) ->> 'estado', public.fn_safe_jsonb(s.comments) ->> 'status', ''))
            IN ('APROBADA', 'AUTORIZADA', 'ACEPTADA', 'EN_CURSO', 'PROGRAMADA')
      LIMIT 200
    ) d;
  END IF;

  -- d) Catálogo Maestro Nacional de Productos (prioriza public.productos; respaldo ERP "Productos")
  IF to_regclass('public.productos') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(pr ORDER BY pr.nombre), '[]'::jsonb)
      INTO v_productos
    FROM (
      SELECT
        p.id::text AS id,
        p.codigo,
        p.nombre,
        p.marca,
        p.categoria,
        p.unidad_medida
      FROM public.productos p
      WHERE COALESCE(p.activo, true) = true
      LIMIT 1000
    ) pr;
  END IF;

  IF jsonb_array_length(v_productos) = 0 AND to_regclass('public."Productos"') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(pr ORDER BY pr.nombre), '[]'::jsonb)
      INTO v_productos
    FROM (
      SELECT
        p.id_prod::text AS id,
        p.prod_codi::text AS codigo,
        p.prod_desc AS nombre,
        NULL::text AS marca,
        NULL::text AS categoria,
        p.prod_unid::text AS unidad_medida
      FROM public."Productos" p
      WHERE COALESCE(p.prod_acti, true) = true
      LIMIT 1000
    ) pr;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sucursal', v_sucursal,
    'tiendas', v_tiendas,
    'promotoras', v_promotoras,
    'degustaciones_autorizadas', COALESCE(v_deg_crono, '[]'::jsonb) || COALESCE(v_deg_surv, '[]'::jsonb),
    'productos', v_productos,
    'server_time', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.obtener_datos_pdv_por_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_datos_pdv_por_token(TEXT) TO anon, authenticated, service_role;

-- 5.5 RPC Público sin Login: public.reportar_ejecucion_pdv(p_token text, p_payload jsonb)
--     Rechaza con SQLSTATE 42501 cualquier intento de reportar un degustacion_id, promotora_id
--     o cliente_id que pertenezca a la otra sucursal (polimórfico BIGINT / UUID / TEXT).
CREATE OR REPLACE FUNCTION public.reportar_ejecucion_pdv(
  p_token TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_token TEXT := BTRIM(COALESCE(p_token, ''));
  v_hash TEXT;
  v_link public.enlaces_publicos_sucursal%ROWTYPE;
  v_sucursal TEXT;
  v_degustacion_id_text TEXT;
  v_promotora_id_text TEXT;
  v_promotora_auth_uid UUID := NULL;
  v_cliente_id_text TEXT;
  v_row_sucursal TEXT;
  v_found_target BOOLEAN := false;
  v_cronograma_id UUID := NULL;
  v_survey_id_text TEXT := NULL;
  v_promotora_nombre TEXT;
  v_cliente_nombre TEXT;
  v_producto_nombre TEXT;
  v_muestras INT;
  v_ventas INT;
  v_unidades_abiertas INT;
  v_lote TEXT;
  v_observaciones TEXT;
  v_fecha DATE;
  v_submission_raw TEXT;
  v_submission_uuid UUID;
  v_submission_id_out TEXT;
  v_inventory_id_text TEXT := NULL;
  v_inv_prom_type TEXT := 'text';
  v_inv_sub_type TEXT := 'uuid';
  v_crono_prom_type TEXT := 'uuid';
  v_surv_prom_type TEXT := 'text';
  v_survey_comments JSONB;
BEGIN
  IF length(v_clean_token) < 24 OR length(v_clean_token) > 256 THEN
    RAISE EXCEPTION 'TOKEN_PDV_INVALIDO_O_REVOCADO' USING ERRCODE = '42501';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'PAYLOAD_EJECUCION_INVALIDO' USING ERRCODE = '22023';
  END IF;

  v_hash := public.fn_sha256_token_hex(v_clean_token);

  SELECT *
    INTO v_link
  FROM public.enlaces_publicos_sucursal e
  WHERE e.token_hash = v_hash
    AND e.activo = true
    AND e.revoked_at IS NULL
    AND (e.expires_at IS NULL OR e.expires_at > now())
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOKEN_PDV_INVALIDO_O_REVOCADO' USING ERRCODE = '42501';
  END IF;

  v_sucursal := v_link.sucursal;

  -- Validar y resolver degustacion_id (soporta UUID, BIGINT o TEXT; rechazo 42501 ante cruce)
  v_degustacion_id_text := NULLIF(BTRIM(COALESCE(p_payload ->> 'degustacion_id', '')), '');
  IF v_degustacion_id_text IS NOT NULL THEN
    IF to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
      SELECT cd.sucursal, cd.id, cd.survey_origen_id::text, cd.cliente_nombre, cd.producto_resumen
        INTO v_row_sucursal, v_cronograma_id, v_survey_id_text, v_cliente_nombre, v_producto_nombre
      FROM public.cronograma_degustaciones cd
      WHERE cd.id::text = v_degustacion_id_text
      FOR UPDATE;

      IF FOUND THEN
        v_found_target := true;
        IF v_row_sucursal IS DISTINCT FROM v_sucursal THEN
          RAISE EXCEPTION 'ACCESO_DENEGADO_SUCURSAL_CRUZADA: La degustación no pertenece a la sucursal %', v_sucursal
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;

    IF NOT v_found_target AND to_regclass('public.surveys') IS NOT NULL THEN
      SELECT s.sucursal, s.id::text, s.store, s.product
        INTO v_row_sucursal, v_survey_id_text, v_cliente_nombre, v_producto_nombre
      FROM public.surveys s
      WHERE s.id::text = v_degustacion_id_text
        AND s.type = 'Degustacion'
      FOR UPDATE;

      IF FOUND THEN
        v_found_target := true;
        IF v_row_sucursal IS DISTINCT FROM v_sucursal THEN
          RAISE EXCEPTION 'ACCESO_DENEGADO_SUCURSAL_CRUZADA: La solicitud de degustación no pertenece a la sucursal %', v_sucursal
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;

    IF NOT v_found_target THEN
      RAISE EXCEPTION 'DEGUSTACION_NO_ENCONTRADA' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- Validar promotora_id contra la sucursal del token (soporta promotoras.id BIGINT o UUID)
  v_promotora_id_text := NULLIF(BTRIM(COALESCE(p_payload ->> 'promotora_id', '')), '');
  IF v_promotora_id_text IS NOT NULL AND to_regclass('public.promotoras') IS NOT NULL THEN
    SELECT pr.sucursal, pr.nombre_completo, pr.auth_user_id
      INTO v_row_sucursal, v_promotora_nombre, v_promotora_auth_uid
    FROM public.promotoras pr
    WHERE (pr.id::text = v_promotora_id_text OR pr.auth_user_id::text = v_promotora_id_text)
      AND COALESCE(pr.activo, true) = true
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROMOTORA_NO_ACTIVA' USING ERRCODE = 'P0002';
    END IF;

    IF v_row_sucursal IS DISTINCT FROM v_sucursal THEN
      RAISE EXCEPTION 'ACCESO_DENEGADO_SUCURSAL_CRUZADA: La promotora no pertenece a la sucursal %', v_sucursal
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_promotora_nombre := COALESCE(NULLIF(BTRIM(COALESCE(p_payload ->> 'promotora_nombre', '')), ''), 'Promotora PDV');
  END IF;

  -- Validar cliente_id si se especifica (soporta public.clientes y ERP public."Clientes", UUID o BIGINT)
  v_cliente_id_text := NULLIF(BTRIM(COALESCE(p_payload ->> 'cliente_id', '')), '');
  IF v_cliente_id_text IS NOT NULL THEN
    v_row_sucursal := NULL;

    IF to_regclass('public.clientes') IS NOT NULL THEN
      SELECT c.sucursal, COALESCE(NULLIF(BTRIM(c.nombre_comercial), ''), c.razon_social)
        INTO v_row_sucursal, v_cliente_nombre
      FROM public.clientes c
      WHERE c.id::text = v_cliente_id_text
      LIMIT 1;
    END IF;

    IF v_row_sucursal IS NULL AND to_regclass('public."Clientes"') IS NOT NULL THEN
      SELECT c.sucursal, c.clie_nomb
        INTO v_row_sucursal, v_cliente_nombre
      FROM public."Clientes" c
      WHERE c.id_clie::text = v_cliente_id_text
      LIMIT 1;
    END IF;

    IF v_row_sucursal IS NULL THEN
      RAISE EXCEPTION 'CLIENTE_NO_ENCONTRADO' USING ERRCODE = 'P0002';
    END IF;

    IF v_row_sucursal IS DISTINCT FROM v_sucursal THEN
      RAISE EXCEPTION 'ACCESO_DENEGADO_SUCURSAL_CRUZADA: La tienda no pertenece a la sucursal %', v_sucursal
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_cliente_nombre := COALESCE(
      NULLIF(BTRIM(COALESCE(p_payload ->> 'cliente_nombre', p_payload ->> 'store', '')), ''),
      v_cliente_nombre
    );
  END IF;

  IF NULLIF(BTRIM(COALESCE(v_cliente_nombre, '')), '') IS NULL THEN
    RAISE EXCEPTION 'TIENDA_REQUERIDA' USING ERRCODE = '22023';
  END IF;

  v_producto_nombre := COALESCE(
    NULLIF(BTRIM(COALESCE(p_payload ->> 'producto_nombre', p_payload ->> 'product', '')), ''),
    v_producto_nombre,
    'Producto Catálogo Nacional'
  );

  v_muestras := GREATEST(0, COALESCE((p_payload ->> 'muestras_entregadas')::int, 0));
  v_ventas := GREATEST(0, COALESCE((p_payload ->> 'ventas_asistidas')::int, 0));
  v_unidades_abiertas := GREATEST(0, COALESCE((p_payload ->> 'unidades_abiertas')::int, 0));
  v_lote := NULLIF(BTRIM(COALESCE(p_payload ->> 'lote_producto', '')), '');
  v_observaciones := NULLIF(BTRIM(COALESCE(p_payload ->> 'observaciones', '')), '');

  v_submission_raw := NULLIF(BTRIM(COALESCE(p_payload ->> 'client_submission_id', '')), '');
  v_submission_uuid := COALESCE(
    public.fn_try_uuid(regexp_replace(COALESCE(v_submission_raw, ''), '^pdv[_-]', '', 'i')),
    gen_random_uuid()
  );

  BEGIN
    v_fecha := COALESCE(NULLIF(BTRIM(COALESCE(p_payload ->> 'fecha', '')), '')::date, CURRENT_DATE);
  EXCEPTION WHEN OTHERS THEN
    v_fecha := CURRENT_DATE;
  END;

  -- Idempotencia y persistencia en public.inventory (compatible con client_submission_id UUID/TEXT y promotora_id TEXT/UUID/BIGINT)
  IF to_regclass('public.inventory') IS NOT NULL THEN
    SELECT COALESCE(c.data_type, 'text') INTO v_inv_prom_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'inventory' AND c.column_name = 'promotora_id';

    SELECT COALESCE(c.data_type, 'uuid') INTO v_inv_sub_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'inventory' AND c.column_name = 'client_submission_id';

    v_submission_id_out := CASE
      WHEN v_inv_sub_type = 'uuid' THEN v_submission_uuid::text
      ELSE COALESCE(v_submission_raw, v_submission_uuid::text)
    END;

    SELECT inv.id::text
      INTO v_inventory_id_text
    FROM public.inventory inv
    WHERE inv.client_submission_id::text = v_submission_id_out
      AND inv.sucursal = v_sucursal
    LIMIT 1;

    IF v_inventory_id_text IS NULL THEN
      EXECUTE format(
        'INSERT INTO public.inventory (
           date, store, product, "initialQuantity", "finalQuantity",
           degustations, sales_generated, comments, promoter,
           promotora_id, cronograma_id, client_submission_id, sucursal, region
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,%s,$10,%s,$11,$12)
         RETURNING id::text',
        CASE
          WHEN v_inv_prom_type = 'uuid' THEN 'public.fn_try_uuid($13)'
          WHEN v_inv_prom_type IN ('bigint', 'integer', 'smallint') THEN 'public.fn_try_bigint($13)'
          ELSE '$13'
        END,
        CASE
          WHEN v_inv_sub_type = 'uuid' THEN 'public.fn_try_uuid($14)'
          ELSE '$14'
        END
      )
      INTO v_inventory_id_text
      USING
        v_fecha::text,
        v_cliente_nombre,
        v_producto_nombre,
        v_unidades_abiertas,
        0,
        v_muestras,
        v_ventas,
        CONCAT_WS(' · ', CASE WHEN v_lote IS NOT NULL THEN 'Lote: ' || v_lote END, v_observaciones),
        v_promotora_nombre,
        v_cronograma_id,
        v_sucursal,
        v_sucursal,
        CASE
          WHEN v_inv_prom_type = 'uuid' THEN COALESCE(public.fn_try_uuid(v_promotora_id_text), v_promotora_auth_uid)::text
          ELSE v_promotora_id_text
        END,
        v_submission_id_out;
    END IF;
  ELSE
    v_submission_id_out := COALESCE(v_submission_raw, v_submission_uuid::text);
  END IF;

  -- Actualizar estado ('COMPLETADA') y métricas en cronograma_degustaciones de la misma sucursal
  IF v_cronograma_id IS NOT NULL AND to_regclass('public.cronograma_degustaciones') IS NOT NULL THEN
    SELECT COALESCE(c.data_type, 'uuid') INTO v_crono_prom_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'cronograma_degustaciones' AND c.column_name = 'promotora_id';

    EXECUTE format(
      'UPDATE public.cronograma_degustaciones
       SET estado = ''COMPLETADA'',
           promotora_id = COALESCE(%s, promotora_id),
           promotora_nombre = COALESCE($2, promotora_nombre),
           observaciones = COALESCE($3, observaciones),
           updated_at = now()
       WHERE id = $4
         AND sucursal = $5',
      CASE
        WHEN v_crono_prom_type = 'uuid' THEN 'public.fn_try_uuid($1)'
        WHEN v_crono_prom_type IN ('bigint', 'integer', 'smallint') THEN 'public.fn_try_bigint($1)'
        ELSE '$1'
      END
    )
    USING
      CASE
        WHEN v_crono_prom_type = 'uuid' THEN COALESCE(public.fn_try_uuid(v_promotora_id_text), v_promotora_auth_uid)::text
        ELSE v_promotora_id_text
      END,
      v_promotora_nombre,
      v_observaciones,
      v_cronograma_id,
      v_sucursal;
  END IF;

  -- Actualizar estado y métricas en surveys de la misma sucursal
  IF v_survey_id_text IS NOT NULL AND to_regclass('public.surveys') IS NOT NULL THEN
    SELECT public.fn_safe_jsonb(s.comments)
      INTO v_survey_comments
    FROM public.surveys s
    WHERE s.id::text = v_survey_id_text
      AND s.sucursal = v_sucursal;

    IF FOUND THEN
      SELECT COALESCE(c.data_type, 'text') INTO v_surv_prom_type
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'surveys' AND c.column_name = 'promotora_id';

      EXECUTE format(
        'UPDATE public.surveys
         SET promoter = COALESCE($1, promoter),
             promotora_id = COALESCE(%s, promotora_id),
             comments = $3
         WHERE id::text = $4
           AND sucursal = $5',
        CASE
          WHEN v_surv_prom_type = 'uuid' THEN 'public.fn_try_uuid($2)'
          WHEN v_surv_prom_type IN ('bigint', 'integer', 'smallint') THEN 'public.fn_try_bigint($2)'
          ELSE '$2'
        END
      )
      USING
        v_promotora_nombre,
        CASE
          WHEN v_surv_prom_type = 'uuid' THEN COALESCE(public.fn_try_uuid(v_promotora_id_text), v_promotora_auth_uid)::text
          ELSE v_promotora_id_text
        END,
        (
          COALESCE(v_survey_comments, '{}'::jsonb) || jsonb_build_object(
            'estado', 'EJECUTADA',
            'status', 'completed',
            'delivered', v_muestras,
            'muestrasEntregadas', v_muestras,
            'ventasAsistidas', v_ventas,
            'loteProducto', v_lote,
            'ejecutadoEnPdvAt', now()
          )
        )::text,
        v_survey_id_text,
        v_sucursal;
    END IF;
  END IF;

  UPDATE public.enlaces_publicos_sucursal
  SET last_used_at = now(),
      uso_contador = uso_contador + 1
  WHERE id = v_link.id;

  RETURN jsonb_build_object(
    'ok', true,
    'sucursal', v_sucursal,
    'inventory_id', v_inventory_id_text,
    'degustacion_actualizada', v_found_target,
    'client_submission_id', v_submission_id_out
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reportar_ejecucion_pdv(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reportar_ejecucion_pdv(TEXT, JSONB) TO anon, authenticated, service_role;

COMMIT;
