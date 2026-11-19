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

## 7. Política "Inspect-Before-Create" y Cero DDL Destructivo en Supabase
- Antes de escribir cualquier migración SQL nueva, todo agente o desarrollador debe inspeccionar en modo solo lectura el catálogo existente (`information_schema.tables`, `information_schema.columns`, `pg_policies` y `supabase_migrations.schema_migrations` mediante `scripts/discoverExistingSupabaseCatalog.ts` y `scripts/certifySchemaProduction.ts`).
- Si una tabla o columna ya existe en `public`, se reutiliza e hidrata de forma 100 % aditiva e idempotente (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS` seguido inmediatamente de `CREATE POLICY`).
- **Prohibición absoluta de DDL destructivo**: queda terminantemente prohibido usar `DROP TABLE`, `DROP COLUMN` o `TRUNCATE` sobre tablas con datos históricos u operativos.
- En PostgreSQL, toda sentencia `ALTER TYPE ... ADD VALUE IF NOT EXISTS` debe ubicarse **antes** de `BEGIN;` (fuera del bloque transaccional explícito) para evitar fallos `unsafe use of new value` en la misma migración, manteniendo prefijos de migración únicos de 14 dígitos (`YYYYMMDDHHMMSS_*.sql`).

## 8. Modelo Oficial de las 5 Regiones Activas (`public.regiones`) y Login por Correo
- El catálogo maestro `public.regiones` gobierna exclusivamente las **5 regiones/sucursales activas oficiales** de **CODIZULCA C.A.**: **Zulia**, **Valencia**, **Centro**, **Oriente** y **Capital** (código `GLOBAL` reservado únicamente como marcador IAM de perfiles corporativos transversales, nunca como sucursal operativa mezclada).
- **Resolución canónica por correo electrónico**: la identidad, rol y sucursal asignada se resuelven en servidor y PostgreSQL a partir de `LOWER(TRIM(auth.jwt() ->> 'email'))` (`obtener_mi_correo_jwt()`, `obtener_mi_rol()`, `obtener_mi_sucursal()`, `obtener_mi_region_id()`), garantizando aislamiento estricto con `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` por región.
- **Cero mezcla operativa entre ciudades**:
  - Roles regionales (`coordinacion`, `supervisor`, `vendedor`, `promotora`, `chofer`, `cliente`) quedan bloqueados automáticamente a su única sucursal asignada en `public.profiles` / `public.staff` / `public.cliente_portal_accesos`.
  - Roles transversales (`super_admin` y `contraloria`) deben elegir explícitamente una sucursal activa mediante `RegionGateSelector`, la cual propaga la cabecera validada `x-sucursal-activa` (`obtener_sucursal_contexto_activo()`) y purga en memoria cualquier caché previo al cambiar de sede.
- **Comparativo ejecutivo sin mezcla**: la única vista autorizada para contrastar las 5 regiones simultáneamente es la pestaña exclusiva de solo lectura **"Comparativo por Región"** (`RegionalComparisonTab`), alimentada por la RPC consolidada `public.rpc_comparativo_regiones_resumen(p_periodo_inicio, p_periodo_fin)` reservada a `super_admin` y `contraloria`.

