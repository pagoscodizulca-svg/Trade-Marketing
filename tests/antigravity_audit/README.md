# Suite Aislada de Auditoría QA, SRE y Seguridad (`tests/antigravity_audit/`)

Esta carpeta contiene el arnés aislado de pruebas automatizadas creado durante la auditoría integral del repositorio **CODIZULCA C.A. — Trade Marketing**.

## Garantías Estrictas de Gobernanza
1. **Cero Impacto en Producción (`127.0.0.1` Exclusivo):** El preload `networkEgressGuard.mjs` intercepta `globalThis.fetch`, `node:http` y `node:https` bloqueando cualquier paquete saliente hacia dominios externos (`*.supabase.co`, `onrender.com`, APIs de terceros).
2. **Aislamiento Total:** Ningún archivo de lógica de negocio productiva (`src/`, `server.ts`, `supabase/`, `ruta-degustacion/`) ni `.env.local` fue modificado.

## Estructura de Archivos
- `networkEgressGuard.mjs`: Cortafuegos de egreso en memoria para procesos Node/Express.
- `localMockInfra.ts`: Servidor HTTP local efímero (`127.0.0.1:0`) que emula Supabase Auth, PostgREST, RPCs, Storage privado y endpoints externos (Render FDV / BCV).
- `step2_sync_validation.test.ts`: Pruebas automatizadas E2E de sincronización, resiliencia ante errores `503`, idempotencia SHA-256, condiciones de carrera (`TOCTOU` Storage y Split-Brain `MP-07-XXXX`) y desajuste de `storageKey`.
- `step3_filters_audit.test.ts`: Certificación de filtros backend/UI, paginación fuera de rango, sanitización contra Formula Injection / Prototype Pollution / XSS y pruebas de regresión sobre dependencias `useMemo`.
- `step4_local_stress_runner.ts`: Ejecutor de carga progresiva (**10, 50 y 100 solicitudes concurrentes**) sobre instancias locales aisladas de `server.ts` y consultas paginadas de 2,500 registros.
- `uiAuditServer.ts`: Servidor local aislado Vite + Express (`http://localhost:4177/`) con `envDir` efímero para auditoría visual DOM sin leer `.env.local`.
- `results/`: Métricas JSON generadas en las corridas (`step2_sync_results.json`, `step3_filters_results.json`, `step4_stress_results.json`).

## Ejecución Manual Segura (Windows PowerShell)
```powershell
# Paso 2 y Paso 3 (Sincronizaciones + Filtros)
.\node_modules\.bin\tsx.cmd --import ./tests/antigravity_audit/networkEgressGuard.mjs --test tests/antigravity_audit/step2_sync_validation.test.ts tests/antigravity_audit/step3_filters_audit.test.ts

# Paso 4 (Pruebas de Estrés 10 / 50 / 100 concurrentes)
.\node_modules\.bin\tsx.cmd --import ./tests/antigravity_audit/networkEgressGuard.mjs tests/antigravity_audit/step4_local_stress_runner.ts
```

## Limpieza Opcional
Si deseas retirar completamente estos artefactos temporales tras revisar `docs/INFORME_AUDITORIA_ESTADO.md`:
```powershell
Remove-Item -Recurse -Force tests\antigravity_audit
```
