-- =============================================================================
-- CODIZULCA C.A. - ALTA RÁPIDA DE ACCESO COORDINACIÓN / ADMIN EN SUPABASE AUTH
-- (No requiere SUPABASE_SERVICE_ROLE_KEY en local)
--
-- PASOS:
-- 1. En Supabase Dashboard abre: Authentication -> Users -> Add user -> Create new user
-- 2. Ingresa tu correo corporativo, define tu contraseña (>= 8 caracteres)
--    y deja marcada la casilla "Auto Confirm User".
-- 3. Reemplaza abajo 'coordinacion@codizulca.com' por tu correo exacto y ejecuta
--    este bloque en Supabase SQL Editor:
-- =============================================================================

UPDATE auth.users
SET
  email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
  raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
    'app_role', 'admin',
    'display_name', 'Coordinación Trade Marketing'
  )
WHERE lower(email) = lower('coordinacion@codizulca.com');

-- Verificación inmediata del rol firmado en servidor:
SELECT
  id,
  email,
  email_confirmed_at,
  raw_app_meta_data ->> 'app_role' AS rol_verificado,
  raw_app_meta_data ->> 'display_name' AS nombre_visible
FROM auth.users
WHERE lower(email) = lower('coordinacion@codizulca.com');
