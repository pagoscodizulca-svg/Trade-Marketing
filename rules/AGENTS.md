# Reglas Permanentes de Seguridad — Programa de Trade Marketing (Supabase)

Estas reglas son **obligatorias** para todo agente de IA, colaborador o revisor que modifique este repositorio. Ningún cambio que las incumpla debe fusionarse.

## 1. Credenciales prohibidas en el frontend
- **Nunca** aceptes, escribas, pegues ni sugieras llaves con prefijo `sb_secret_` ni tokens JWT con rol `service_role` en:
  - código cliente (`src/**`), HTML, CSS o archivos estáticos (`public/**`);
  - variables con prefijo `VITE_` o cualquier archivo versionado en Git (`.env.example`, documentación, pruebas).
- La única llave permitida en el navegador es la **Publishable Key** (`sb_publishable_...`), cargada desde `.env.local` (ignorado por Git) mediante `import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY`.
- Las llaves administrativas solo pueden existir como variables de entorno **del servidor** (sin prefijo `VITE_`) y jamás se registran en logs.
- Si un usuario comparte una llave secreta en una conversación o archivo, **no la uses**: indica que debe rotarla en el panel de Supabase.

## 2. URL del proyecto
- Usa siempre la URL raíz: `https://apaxdgxtaoeyswlfblgi.supabase.co`.
- **Prohibido** incluir sufijos `/rest/v1/`, `/auth/v1/` o barras finales en `VITE_SUPABASE_URL`; el SDK construye esas rutas internamente.
- Toda inicialización debe pasar por `normalizarSupabaseUrl()` y `assertCredencialesSeguras()` en `src/lib/supabaseClient.js` **antes** de `createClient()`.

## 3. Autorización basada en RLS
- El filtrado en JavaScript **nunca** sustituye la seguridad en base de datos.
- Toda tabla consultada con la llave pública debe tener `ENABLE ROW LEVEL SECURITY` (y preferiblemente `FORCE ROW LEVEL SECURITY`) con políticas explícitas; el rol `anon` no debe tener acceso a tablas operativas.
- Los roles de usuario se leen de `app_metadata` o de tablas protegidas por RLS, **nunca** de `user_metadata`.

## 4. Archivos de configuración local
- `.env`, `.env.*` (excepto `.env.example`) y `src/config/env.js` deben permanecer en `.gitignore`.
- Los archivos versionables solo contienen marcadores de posición (`PEGA_AQUI_TU_SB_PUBLISHABLE_KEY`).
- Antes de cualquier commit, verifica con `git status` y `git check-ignore -v .env.local` que el archivo privado no sea rastreable.

## 5. Prevención de XSS
- Prohibido `innerHTML`, `outerHTML` e `insertAdjacentHTML` para pintar datos provenientes de Supabase o diagnósticos.
- Usa exclusivamente `textContent`, `value` y `document.createElement`.

## 6. Diagnósticos y registros
- Los diagnósticos (`src/diagnostics/checkSupabaseConnection.js`) deben devolver `{ ok, urlNormalizada, sesionActiva, mensaje }` sin incluir llaves, tokens ni encabezados de autorización.
