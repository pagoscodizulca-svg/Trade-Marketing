# AGENTS.md — Reglas Permanentes de Arquitectura y Seguridad (CODIZULCA Trade Marketing)

Este repositorio aplica controles estrictos de seguridad en PostgreSQL/Supabase, Express/Render y Frontend móvil (PWA). Todo agente de IA o colaborador **DEBE** respetar estas reglas y el catálogo ampliado en [`rules/AGENTS.md`](./rules/AGENTS.md) y [`.agents/rules/supabase-rls-guard.md`](./.agents/rules/supabase-rls-guard.md).

## Regla Obligatoria de Blindaje RLS en App de Promotoras (Permanente)
> **Toda escritura crítica desde la App de Promotoras hacia tablas con RLS debe realizarse mediante funciones RPC `SECURITY DEFINER` idempotentes con `SET search_path = public`, y todo archivo SQL debe incluir `DROP POLICY IF EXISTS` y `GRANT` explícitos verificados contra el rol real de sesión (`anon`/`authenticated`).**

## Invariantes No Negociables
1. **Zero `DISABLE ROW LEVEL SECURITY`:** Nunca desactives RLS en tablas operativas ni de auditoría (`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` obligatorio).
2. **Zero `SERVICE_ROLE_KEY` en Frontend:** El navegador solo puede usar `VITE_SUPABASE_PUBLISHABLE_KEY`; las llaves secretas permanecen exclusivamente en variables de entorno del servidor.
3. **Zero `anon` en Tablas Operativas:** Las promotoras operan con sesión real de Supabase Auth (`authenticated`, `auth.uid()` activo). Toda migración SQL debe incluir `REVOKE ALL ... FROM PUBLIC, anon;` y otorgar `GRANT` únicamente a `authenticated` y `service_role`.
4. **Canonicalización Multisede (`CENTRO` | `OCCIDENTE`):** Nunca envíes valores legacy (`ZULIA`, `VALENCIA`) en columnas `sucursal` restringidas por `CHECK` o `obtener_mi_sucursal()`. Las tablas operativas y triggers `BEFORE INSERT OR UPDATE` deben normalizar vía `public.normalizar_sucursal_multisede()`.
5. **Idempotencia SQL 100 % y Cero DDL Destructivo:** Usa siempre `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS`, `ON CONFLICT` y prefijos de migración de 14 dígitos (`YYYYMMDDHHMMSS_*.sql`). Prohibido `DROP TABLE`, `DROP COLUMN` o `TRUNCATE` sobre tablas con datos históricos.
6. **Validación Obligatoria Antes de Merge/Deploy:** Ejecuta siempre `tsc --noEmit`, `node --import tsx scripts/certifySchemaProduction.ts --mode static`, `npm test`, `npm run build:web` y `npm run build:server`.
