---
description: Regla permanente de blindaje RLS, RPCs SECURITY DEFINER e idempotencia SQL para Supabase y App de Promotoras
globs:
  - "supabase/migrations/**/*.sql"
  - "sql/**/*.sql"
  - "src/services/**/*promotora*.ts"
  - "src/services/**/*asistencia*.ts"
  - "src/components/portal/**/*.tsx"
---

# Guardián Permanente de RLS y Escrituras Críticas en Supabase

## Regla Principal (Obligatoria)
> **Toda escritura crítica desde la App de Promotoras hacia tablas con RLS debe realizarse mediante funciones RPC `SECURITY DEFINER` idempotentes con `SET search_path = public`, y todo archivo SQL debe incluir `DROP POLICY IF EXISTS` y `GRANT` explícitos verificados contra el rol real de sesión (`anon`/`authenticated`).**

## Checklist Obligatorio antes de Aprobar Cambios en SQL o `/portal/*`
1. **Autenticación real (`authenticated`):** Confirmar si el módulo usa sesión `supabase.auth` (`authenticated` con `auth.uid()`). En CODIZULCA Trade Marketing las promotoras operan con rol `authenticated`; prohibido habilitar acceso `anon` en tablas operativas (`REVOKE ALL ... FROM PUBLIC, anon;`).
2. **RPCs `SECURITY DEFINER` idempotentes:**
   - Declarar siempre `SECURITY DEFINER` + `SET search_path = public`.
   - Validar `auth.uid() IS NOT NULL` y pertenencia activa en `public.promotoras` (o rol de coordinación/admin activo) dentro de la función.
   - Resolver `sucursal` canónica (`CENTRO` | `OCCIDENTE`) y fecha `America/Caracas` en el servidor, usando `INSERT ... ON CONFLICT (...) DO UPDATE` para evitar duplicados por reintentos móviles.
   - Otorgar `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;` y `GRANT EXECUTE ON FUNCTION ... TO authenticated, service_role;`.
3. **Políticas RLS y Funciones Auxiliares sin Recursión:**
   - Toda función auxiliar usada dentro de `CREATE POLICY` debe ser `SECURITY DEFINER SET search_path = public` y tratar cadenas vacías con `NULLIF(BTRIM(...), '')`.
   - Mantener `ENABLE ROW LEVEL SECURITY` y `FORCE ROW LEVEL SECURITY` (nunca `DISABLE ROW LEVEL SECURITY`).
   - Preceder cada política con `DROP POLICY IF EXISTS` y finalizar la migración con `NOTIFY pgrst, 'reload schema';`.
   - Preservar acceso de solo lectura de Contraloría (`is_torre_control_viewer()`).
4. **Resiliencia Frontend Móvil:**
   - Verificar/refrescar sesión (`getSession()` / `refreshSession()`) antes de subir evidencias a Storage o invocar la RPC.
   - Ejecutar rollback automático del archivo en Storage si la escritura en BD falla.
   - Persistir borrador ligero en `sessionStorage`/`localStorage` antes de abrir `<input capture>` (Cámara Nativa Android) para sobrevivir recargas de pestaña.
   - Registrar `{ code, message, details, hint }` en `console.error` sin exponer JWTs ni credenciales.
5. **Verificación CI Local Obligatoria:**
   - `node --import tsx scripts/certifySchemaProduction.ts --mode static`
   - `npm test` (incluye `tests/asistenciaRlsDefinitivo.test.ts` y `tests/hito0_migraciones_orden.test.ts`).
