-- =============================================================================
-- CODIZULCA C.A. - PLANTILLA SEGURA DE APROVISIONAMIENTO DE LAS 3 CUENTAS RBAC
-- Archivo: supabase/seed_3_usuarios.template.sql
--
-- Cuentas corporativas aprovisionadas por este script:
--   1. Admin@codizulca.com    -> admin@codizulca.com    (Super administrador: 'super_admin')
--   2. Grecia01@codizulca.com -> grecia01@codizulca.com (Coordinadora: 'coordinacion')
--   3. Maria01@codizulca.com  -> maria01@codizulca.com  (Coordinadora: 'coordinacion')
--
-- INSTRUCCIONES DE USO SEGURO (SIN EXPONER SECRETOS EN GIT):
--   1. Abre el SQL Editor en tu panel de Supabase.
--   2. Copia el contenido de esta plantilla en el SQL Editor (NUNCA guardes
--      contraseñas reales dentro de este archivo versionado).
--   3. Reemplaza únicamente los dos placeholders del bloque DECLARE:
--        - <CLAVE_SUPER_ADMIN>
--        - <CLAVE_COORDINADORA>
--      por las contraseñas reales (>= 6 caracteres) y pulsa "Run".
--   4. Requiere haber ejecutado previamente:
--        supabase/migrations/20261116_rbac_corporate_profiles_and_rls.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

BEGIN;

DO $$
DECLARE
  v_clave_super_admin TEXT := '<CLAVE_SUPER_ADMIN>';
  v_clave_coordinadora TEXT := '<CLAVE_COORDINADORA>';

  v_rec RECORD;
  v_user_id UUID;
  v_hashed_pwd TEXT;
  v_meta JSONB;
BEGIN
  -- Candado preventivo: impide ejecutar accidentalmente la plantilla sin sustituir placeholders
  IF v_clave_super_admin LIKE '<%' OR btrim(v_clave_super_admin) = '' OR char_length(v_clave_super_admin) < 6 THEN
    RAISE EXCEPTION 'Debes reemplazar <CLAVE_SUPER_ADMIN> por una contraseña real de al menos 6 caracteres en el SQL Editor antes de ejecutar.';
  END IF;

  IF v_clave_coordinadora LIKE '<%' OR btrim(v_clave_coordinadora) = '' OR char_length(v_clave_coordinadora) < 6 THEN
    RAISE EXCEPTION 'Debes reemplazar <CLAVE_COORDINADORA> por una contraseña real de al menos 6 caracteres en el SQL Editor antes de ejecutar.';
  END IF;

  FOR v_rec IN
    SELECT *
    FROM (
      VALUES
        ('admin@codizulca.com',    'Administrador General Codizulca', 'super_admin',  v_clave_super_admin),
        ('grecia01@codizulca.com', 'Grecia · Coordinación Trade',     'coordinacion', v_clave_coordinadora),
        ('maria01@codizulca.com',  'María · Coordinación Trade',      'coordinacion', v_clave_coordinadora)
    ) AS t(email_norm, full_name, profile_role, plain_pwd)
  LOOP
    v_hashed_pwd := extensions.crypt(v_rec.plain_pwd, extensions.gen_salt('bf', 10));

    v_meta := jsonb_build_object(
      'provider', 'email',
      'providers', jsonb_build_array('email'),
      'role', v_rec.profile_role,
      'app_role', v_rec.profile_role,
      'display_name', v_rec.full_name,
      'is_active', true,
      'must_change_password', false
    );

    -- 1. Buscar si el correo ya existe en auth.users (insensible a mayúsculas/espacios)
    SELECT u.id
    INTO v_user_id
    FROM auth.users u
    WHERE u.email IS NOT NULL
      AND lower(btrim(u.email)) = v_rec.email_norm
    LIMIT 1;

    IF v_user_id IS NOT NULL THEN
      -- Caso A: Usuario ya existente (ej. admin@codizulca.com) -> actualizar clave, confirmar y sanear tokens GoTrue
      UPDATE auth.users u
      SET
        instance_id = COALESCE(u.instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
        aud = 'authenticated',
        role = 'authenticated',
        email = v_rec.email_norm,
        encrypted_password = v_hashed_pwd,
        email_confirmed_at = COALESCE(u.email_confirmed_at, now()),
        banned_until = NULL,
        confirmation_token = COALESCE(u.confirmation_token, ''),
        recovery_token = COALESCE(u.recovery_token, ''),
        email_change_token_new = COALESCE(u.email_change_token_new, ''),
        email_change = COALESCE(u.email_change, ''),
        email_change_token_current = COALESCE(u.email_change_token_current, ''),
        phone_change = COALESCE(u.phone_change, ''),
        phone_change_token = COALESCE(u.phone_change_token, ''),
        reauthentication_token = COALESCE(u.reauthentication_token, ''),
        raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb) || v_meta,
        raw_user_meta_data = COALESCE(u.raw_user_meta_data, '{}'::jsonb) || jsonb_build_object(
          'full_name', v_rec.full_name
        ),
        updated_at = now()
      WHERE u.id = v_user_id;
    ELSE
      -- Caso B: Usuario nuevo (ej. grecia01@codizulca.com o maria01@codizulca.com) -> insertar fila completa válida para GoTrue
      v_user_id := gen_random_uuid();

      INSERT INTO auth.users (
        instance_id,
        id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        raw_app_meta_data,
        raw_user_meta_data,
        is_super_admin,
        created_at,
        updated_at,
        confirmation_token,
        recovery_token,
        email_change_token_new,
        email_change,
        email_change_token_current,
        phone_change,
        phone_change_token,
        reauthentication_token
      )
      VALUES (
        '00000000-0000-0000-0000-000000000000'::uuid,
        v_user_id,
        'authenticated',
        'authenticated',
        v_rec.email_norm,
        v_hashed_pwd,
        now(),
        v_meta,
        jsonb_build_object('full_name', v_rec.full_name),
        false,
        now(),
        now(),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        ''
      );
    END IF;

    -- 2. Asegurar registro en auth.identities para el proveedor 'email'
    IF EXISTS (
      SELECT 1
      FROM auth.identities i
      WHERE i.user_id = v_user_id
        AND i.provider = 'email'
    ) THEN
      UPDATE auth.identities i
      SET
        provider_id = v_user_id::text,
        identity_data = jsonb_build_object(
          'sub', v_user_id::text,
          'email', v_rec.email_norm,
          'email_verified', true,
          'phone_verified', false
        ),
        updated_at = now()
      WHERE i.user_id = v_user_id
        AND i.provider = 'email';
    ELSE
      INSERT INTO auth.identities (
        id,
        user_id,
        provider_id,
        identity_data,
        provider,
        last_sign_in_at,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        v_user_id,
        v_user_id::text,
        jsonb_build_object(
          'sub', v_user_id::text,
          'email', v_rec.email_norm,
          'email_verified', true,
          'phone_verified', false
        ),
        'email',
        now(),
        now(),
        now()
      );
    END IF;

    -- 3. Vincular y activar perfil operativo en public.profiles
    INSERT INTO public.profiles (
      id,
      email,
      full_name,
      role,
      is_active,
      must_change_password
    )
    VALUES (
      v_user_id,
      v_rec.email_norm,
      v_rec.full_name,
      v_rec.profile_role,
      true,
      false
    )
    ON CONFLICT (id) DO UPDATE
    SET
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      role = EXCLUDED.role,
      is_active = true,
      must_change_password = false,
      updated_at = now();
  END LOOP;
END $$;

COMMIT;

-- Verificación de salida (no expone contraseñas ni hashes):
SELECT
  p.id,
  p.email,
  p.full_name,
  p.role AS rol_operativo,
  p.is_active AS activo,
  (u.email_confirmed_at IS NOT NULL) AS email_confirmado,
  EXISTS (
    SELECT 1 FROM auth.identities i WHERE i.user_id = p.id AND i.provider = 'email'
  ) AS identidad_email_ok
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.email IN (
  'admin@codizulca.com',
  'grecia01@codizulca.com',
  'maria01@codizulca.com'
)
ORDER BY
  CASE p.role WHEN 'super_admin' THEN 1 ELSE 2 END,
  p.email;
