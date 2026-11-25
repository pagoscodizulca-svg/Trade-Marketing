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

## 9. Blindaje Obligatorio de Escrituras desde la App de Promotoras (RPC `SECURITY DEFINER` + RLS)
- **Regla permanente inamovible:** Toda escritura crítica desde la App de Promotoras hacia tablas con RLS debe realizarse mediante funciones RPC `SECURITY DEFINER` idempotentes con `SET search_path = public`, y todo archivo SQL debe incluir `DROP POLICY IF EXISTS` y `GRANT` explícitos verificados contra el rol real de sesión (`anon`/`authenticated`).
- En este proyecto, las promotoras se autentican mediante **Supabase Auth real** (rol `authenticated`, `auth.uid()` activo); por tanto, los permisos de tabla, Storage y `EXECUTE` de RPCs operativas se otorgan exclusivamente a `authenticated` y `service_role`, revocando siempre `PUBLIC` y `anon`.
- Toda función auxiliar invocada dentro de políticas RLS (`obtener_mi_sucursal()`, `fn_trade_current_promotora_id()`, `fn_trade_is_promotora_owner()`, `fn_trade_is_asistencia_manager()`) debe declararse `SECURITY DEFINER SET search_path = public` para evitar recursión de RLS y fallos silenciosos (`NULL` por `email = ''` vs `correo`).
- El registro fotográfico de asistencia en `/portal/asistencia` debe ejecutarse mediante `public.rpc_registrar_turno_asistencia(JSONB)` / `public.rpc_abrir_jornada_asistencia(...)` (idempotentes con `ON CONFLICT`), respaldado por el autodiagnóstico de solo lectura `public.rpc_healthcheck_asistencia()` y triggers de normalización de `sucursal` (`ZULIA -> OCCIDENTE`, `VALENCIA -> CENTRO`) en `public.asistencias_jornada` y `public.asistencia_evidencias`.
- Toda nueva migración que toque tablas o políticas RLS de `/portal/*` debe pasar `node --import tsx scripts/certifySchemaProduction.ts --mode static` y la suite `tests/asistenciaRlsDefinitivo.test.ts` antes de desplegar en Render.

## 10. Estándar Permanente de Invalidación Automática de Caché en Despliegues (5 Capas)
Para que **ningún usuario** de los dashboards o PWAs (`/`, `/portal`, `/logistica` o cualquier aplicación futura) deba borrar caché manualmente al publicar una nueva versión, toda app web debe mantener estas 5 capas:
1. **Build ID automático + `version.json` (`scripts/lib/buildVersionPlugin.ts`)**: cada compilación Vite genera automáticamente un `buildId` único (`__APP_BUILD_ID__`), emite `version.json` en `dist/` y estampa ese ID dentro de `dist/sw.js` (prohibido mantener versiones de caché escritas a mano como `v335`; en apps Workbox excluir `**/version.json` de `globIgnores`).
2. **Cabeceras HTTP estrictas y 404 real para assets (`src/server/spaCachePolicy.ts`)**: `index.html`, `version.json`, `sw.js` y `manifest.*` se sirven siempre con `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`; `/assets/*` con hash de contenido se sirve con `public, max-age=31536000, immutable`; y el fallback SPA **jamás** devuelve `200 text/html` ante archivos faltantes en `/assets/*` o extensiones estáticas (responde `404` con `no-store` para eliminar cache poisoning).
3. **Service Worker blindado**: registrar siempre con `{ updateViaCache: 'none' }`, validar que ninguna respuesta `text/html` se guarde bajo `/assets/*`, excluir `/version.json` del interceptador `fetch` y purgar cachés obsoletas en `activate`.
4. **Guardián de versión cliente (`appVersionGuard.ts`)**: valida `version.json?t=...` con `cache: 'no-store'` al arrancar, al volver a la pestaña (`visibilitychange`/`focus`), al reconectar (`online`) y periódicamente; purga únicamente Cache Storage estático (jamás `localStorage` de sesión `sb-*`/`codizulca.*` ni IndexedDB offline), protege contra bucles de recarga vía `sessionStorage` y difiere la recarga si el usuario está escribiendo en un campo activo.
5. **Auto-recuperación de módulos diferidos (`vite:preloadError`)**: capturar `vite:preloadError`, `unhandledrejection` de chunks obsoletos y fallos equivalentes en `ErrorBoundary` para purgar caché estática y recargar una sola vez automáticamente.



