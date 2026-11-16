# INFORME TÉCNICO Y EJECUTIVO DE AUDITORÍA QA, SRE Y SEGURIDAD
**Proyecto:** CODIZULCA C.A. — Sistema Integral de Trade Marketing, Portal de Promotoras (`/portal`) y PWA Chofer (`ruta-degustacion`)  
**Fecha de Corte:** 2026-11-16 (`America/Caracas`, UTC-04:00)  
**Modalidad de Ejecución:** Aislamiento Estricto Cero-Producción (`127.0.0.1` + Cortafuegos de Egreso `networkEgressGuard.mjs`, cero modificaciones a lógica productiva, cero secretos expuestos)

---

## 1. Resumen Ejecutivo y % Global de Completitud (Readiness Score)

> **PORCENTAJE EXACTO DE PREPARACIÓN PARA PRODUCCIÓN: `73.43%` (NO APTO PARA DESPLIEGUE PÚBLICO SIN REMEDIAR BLOQUEANTES P0)**

El ecosistema presenta una **ingeniería notable en varios componentes críticos**: compilación limpia en TypeScript estricto (`tsc --noEmit` con 0 errores en ambas aplicaciones), validación criptográfica de *magic bytes* en evidencias fotográficas, comparación en tiempo constante (`crypto.timingSafeEqual`) para tareas programadas, uso exclusivo de `app_metadata` (nunca `user_metadata` ni `auth.role()`) en políticas Zero Trust recientes, cero uso de `dangerouslySetInnerHTML` en React, y **cero caídas o errores HTTP 5xx** bajo ráfagas de hasta 100 conexiones concurrentes locales.

Sin embargo, la auditoría estática y empírica descubrió **bloqueantes críticos (P0)** que impiden certificar el paso a producción hoy:
1. **Tablas expuestas con RLS abierto a usuarios anónimos (`anon`)**: `public.solicitudes_contraloria`, `public.entregas_degustacion` (incluyendo `DELETE` anónimo) y filas activas de `public.surveys`, agravado porque `solicitudesContraloriaService.ts` envía siempre `SUPABASE_ANON_KEY` en vez del JWT del usuario autenticado.
2. **Estado volátil solo en RAM en Módulos 2 y 3**: Las ediciones/llenados por lote de `ScheduleMatrixView` y el flujo de 8 etapas de Contraloría (requisiciones comerciales, comprobantes fiscales, conciliación de mermas y emisión de *Paz y Salvo* en `AppContext.tsx`) viven únicamente en memoria de React y **se pierden al recargar el navegador**.
3. **Bug *Split-Brain* bajo concurrencia en Contraloría (`MP-07-XXXX`)**: Ante dos envíos simultáneos, `isDedicatedTableMissing()` interpreta erróneamente el error `409 Conflict (23505)` como "tabla inexistente" (porque la expresión regular busca `/solicitudes_contraloria/i`), corrompe el modo de sesión hacia `surveys_envelope` e inserta **dos solicitudes distintas con el mismo correlativo oficial `MP-07-XXXX`**.
4. **Pérdida de sesión al arrancar (`storageKey` mismatch)** y **ruptura de orden en migraciones SQL / `pg_cron` desprogramado**.

### Desglose Ponderado Oficial (Rúbrica de Certificación)

| Dimensión Auditada | Peso Rúbrica | Calificación Obtenida (0–100%) | Aporte Ponderado Exacto | Justificación Técnica Resumida |
| :--- | :---: | :---: | :---: | :--- |
| **1. Funcionalidad Core y Completitud de Módulos** | **30%** | `75.30%` | **`22.59%`** | Módulos 1, 4 y `/portal` muy completos (`88–90%`); penalizado por falta de persistencia BD en llenado de Módulo 2 (`62%`) y conciliación/Paz y Salvo de Módulo 3 (`58%`), desconexión de `ruta-degustacion` (`70%`) y falta de políticas RLS de escritura en `public.staff`. |
| **2. Integridad y Resiliencia de Sincronizaciones** | **25%** | `69.40%` | **`17.35%`** | Reintentos progresivos, hashes SHA-256 y locks `pg_advisory_xact_lock` sólidos; penalizado por Split-Brain `MP-07-XXXX`, purga de sesión en `cleanSync.ts`, orden roto en migraciones `20261112`, `pg_cron` desprogramado en `20261113` y huérfanos TOCTOU en Storage. |
| **3. Exactitud y Sanitización de Filtros** | **20%** | `81.20%` | **`16.24%`** | Sanitización sobresaliente (`95%`: anti-XSS, anti-Formula-Injection, anti-Prototype-Pollution, Zod); penalizado por omisión de `statusFilter`/`shiftFilter` en query PostgREST de Historial, dependencias faltantes `matrixDateFrom/To` en `useMemo`, falsos negativos con `", C.A."` y sensibilidad a tildes en Asistencia/Matriz. |
| **4. Rendimiento bajo Estrés y Estabilidad** | **15%** | `75.65%` | **`11.35%`** | `0` errores HTTP 5xx y `0` errores de socket hasta 100 concurrentes; penalizado por 9–10 roundtrips secuenciales por foto (`p95 = 940 ms`), auth previa al rate limiter, sonda TCP en cada `/api/health`, y +`133.27 MB` de Heap por caché sin cota LRU en `cacheClientes`. |
| **5. Seguridad, Manejo de Errores y Cobertura de Pruebas** | **10%** | `59.00%` | **`5.90%`** | Excelente validación de `app_metadata` y binarios; fuertemente penalizado por RLS `anon` abierto en 3 tablas, DoS `429` al Cron con 6 peticiones anónimas, `xlsx@0.18.5` vulnerable, 22 bloques `catch` mudos y regresión en `verifyCicloSemanalDegustaciones.ts`. |
| **TOTAL GLOBAL DE COMPLETITUD (READINESS SCORE)** | **100%** | — | **`73.43%`** | **Requiere ejecutar Fase P0 y P1 del Plan de Acción antes de despliegue productivo.** |

---

## 2. Estado de Sincronizaciones (Evaluación E2E, Concurrencia y Resiliencia)

| ID | Flujo Evaluado | Estado | Causa Raíz de Fallos o Advertencias | Archivo y Línea Exacta |
| :--- | :--- | :---: | :--- | :--- |
| **SYNC-01** | Solicitudes FDV (Render) ↔ `public.surveys` + Globito Realtime | **Aprobado** *(Con Nota)* | Fusión determinista sin duplicados (`scoreDegustacionSurveyRow`) y recuperación automática verificada ante 2 fallos HTTP `503` consecutivos (`600ms -> 1400ms`). *Nota:* `useDegustacionesNotifications` hace polling cada 15 s incluso con pestaña oculta y `fetchLiveBcvRate` carece de timeout y frena el arranque. | `src/services/fdvDegustacionesAdapter.ts:643-732`, `src/hooks/useDegustacionesNotifications.ts:363-367`, `src/services/supabaseModule1.ts:581-595, 1046` |
| **SYNC-02** | Carga Multiformato (Excel/CSV/PDF IA) → RPC `volcar_lote_cronograma` | **Con Advertencias** | Deduplicación SHA-256 intra-archivo y en reintentos certificada OK (`0` duplicados). Sin embargo, la migración `20261114` intenta borrar `uq_cronograma_idempotency_active` dejando vivo `idx_cronograma_deg_idempotency_active`, lo que impide re-cargar filas marcadas como `NO_AUTORIZADA` (`23505`). Además, `pdfDegustacionesExtractor.ts` no define timeout en llamadas Gemini/OpenAI. | `supabase/migrations/20261112_zero_trust_fdv_promotoras_portal_ruta.sql:186-188`, `supabase/migrations/20261114_portal_promotoras_bandeja_realtime.sql:94-97`, `src/server/pdfDegustacionesExtractor.ts:117, 198` |
| **SYNC-03** | Autorización / Rechazo Trade ↔ `cronograma_degustaciones` ↔ `/portal` (`rutas_promotoras`) | **Con Advertencias** | RPC `rpc_autorizar_degustacion_trade` serializa con `pg_advisory_xact_lock` + `FOR UPDATE`. *Defectos:* (1) Si una promotora hace `CHECKOUT` pasada la medianoche Caracas, el trigger `fn_sync_ruta_progress_to_cronograma` choca con `fn_guard_historical_degustacion_immutability` (`42501`); (2) RPC fallback `asignar_degustacion_aceptada_a_ruta` referencia `v_survey.store_name` (columna inexistente, es `store`); (3) typo `' personas'` en `rpc_autorizar_degustacion_trade`; (4) el avance de `/portal` no actualiza `surveys` ni Render FDV. | `supabase/migrations/20261112_zero_trust_fdv_promotoras_portal_ruta.sql:700-724, 1047`, `supabase/migrations/20261114_portal_promotoras_bandeja_realtime.sql:471-555, 897` |
| **SYNC-04** | Evidencias Fotográficas (`asistencias_jornada` + `asistencia_evidencias` + Storage Privado) | **Con Advertencias** | Validación de *magic bytes*, bloqueo anti-IDOR (`403`) y rollback compensatorio de Storage verificados OK. *Defecto de carrera (TOCTOU):* Dos subidas simultáneas a la misma ranura leen el mismo `previousEvidence`, suben dos UUIDs distintos a Storage y dejan **1 binario huérfano** en el bucket privado. | `src/server/attendanceEvidencesHandler.ts:541-610` |
| **SYNC-05** | Sincronización Data Maestra (`vendedores`, `clientes`, `lotes_sincronizacion`) | **Con Advertencias** | Chunks de 400 filas, deduplicación y enlace FK verificados OK. *Defectos:* (1) `normalizarRifFiscal('J312345678')` genera `'J-312345678'` mientras `'J-31234567-8'` conserva el segundo guion; (2) `es_admin_trade()` solo acepta `'admin'`/`'gerencia'`, bloqueando a `'gerente_admin'`; (3) `vendedores` y `clientes` no están añadidos a `supabase_realtime`. | `src/services/masterDataSyncService.ts:93-103`, `supabase/migrations/02_rls_y_rpc_sync.sql:34-47`, `src/hooks/useMasterData.ts:140-145` |
| **SYNC-06** | Solicitudes de Productos a Contraloría (`MP-07-XXXX`) | **Fallido** | **(1) Bug Crítico Split-Brain bajo concurrencia:** Dos envíos simultáneos calculan el mismo `MP-07-0073` en cliente; el segundo recibe `409 (23505)` de `solicitudes_contraloria`, `isDedicatedTableMissing()` da falso positivo por `/solicitudes_contraloria/i`, degrada `detectedBackendMode = 'surveys_envelope'` y duplica `MP-07-0073` en `public.surveys`. **(2) Seguridad:** Usa `SUPABASE_ANON_KEY` fijo en vez del JWT de usuario y no usa `AbortController`. | `src/services/solicitudesContraloriaService.ts:56-61, 63-88, 456-459, 564-660` |
| **SYNC-07** | Cierre Semanal Automático (`POST /api/cron/degustaciones-cierre-semanal` + `pg_cron`) | **Con Advertencias** | Comparación `timingSafeEqual` e idempotencia del handler OK. *Defectos:* (1) `20261113` ejecuta `cron.unschedule` del job dominical y busca `ejecutar_cierre_semanal_degustaciones(timestamptz,boolean)` (nombre inexistente; el real es `ejecutar_cierre_dominical_degustaciones`), dejando **0 jobs en `pg_cron`**; (2) `getServerSupabaseWriteClient()` cae a `ANON_KEY` si falta `SERVICE_ROLE_KEY`; (3) orden lexicográfico roto: `20261112_asistencia...` llama `private.current_active_promotora_id()` antes de `20261112_zero_trust...`. | `supabase/migrations/20261113_ciclo_semanal_automatico_degustaciones.sql:408-424`, `src/server/weeklyTastingCronHandler.ts:30-42`, `supabase/migrations/20261112_asistencia_evidencias_perfil_condicional.sql:394` |
| **SYNC-08** | Persistencia de Sesión Auth vs `cleanSync` + Gestión de `public.staff` | **Fallido** | **(1)** `supabaseClient.ts` define `storageKey: 'codizulca.supabase.auth.v1'`, pero `cleanSync.ts` borra toda clave que no empiece por `'sb-'` (destruyendo la sesión al migrar) y `hasStoredSupabaseAuthToken()` busca `/^sb-.*-auth-token$/i` (devolviendo siempre `false`). **(2)** `20261114` activa `ENABLE ROW LEVEL SECURITY` en `public.staff` con política `SELECT`, sin crear políticas `INSERT/UPDATE/DELETE`. | `src/services/supabaseClient.ts:145, 199`, `src/services/cleanSync.ts:17-19, 36-49`, `src/services/authService.ts:45-62`, `supabase/migrations/20261114_portal_promotoras_bandeja_realtime.sql:1374-1390` |
| **SYNC-09** | Persistencia Operativa Módulo 2, Módulo 3 y Chofer PWA (`ruta-degustacion`) | **Fallido** | **(1)** En `AppContext.tsx`, el llenado por lote/edición de `visits` (Módulo 2) y las etapas de `requests`, facturas fiscales, `reconciliation`, `auditLogs` y *Paz y Salvo* (Módulo 3) solo mutan RAM de React (se pierden al recargar). **(2)** En `ruta-degustacion`, `entregas_degustacion` no sincroniza automáticamente desde `cronograma_degustaciones`, su modo `'reemplazar'` borra/inserta sin transacción atómica y el LWW depende del reloj local del teléfono. | `src/context/AppContext.tsx:775-1298, 1548-1582`, `ruta-degustacion/src/services/supabaseRepository.ts:409-430`, `ruta-degustacion/src/lib/syncCore.ts:96-98` |

---

## 3. Estado de Filtros (Matriz Backend + UI, Casos Borde y Sanitización)

### 3.1 Matriz Consolidada de Certificación de Filtros

| ID | Módulo / Filtro | Capa | Casos Borde Probados | Sanitización / Seguridad | Resultado | Detalle Técnico y Archivo:Línea |
| :--- | :--- | :---: | :--- | :---: | :---: | :--- |
| **FLT-01** | Historial Paginado (`HistorialPaginationFilterInputSchema` + `escapeIlikePattern`) | Backend / Zod | Vacíos, `2026-02-30`, `Desde > Hasta`, `page = 0 / -3 / 50000`, `pageSize = 101`, bytes nulos `\u0000`, `ñ/Ñ`, acentos, comodines `%` y `_` | **Certificada** (Zod + escape `\%` `\_` + SDK parametrizado) | **Aprobado** | Acota páginas fuera de límite a `totalPages` y rechaza fechas inválidas o rangos invertidos (`src/services/degustacionesWeeklyCycleService.ts:58-120, 455-527`). |
| **FLT-02** | Consulta Servidor de Historial (`queryServerPaginatedHistorialSurveys`) | Backend / PostgREST | Combinación múltiple `statusFilter` + `shiftFilter` + `productFilter` + `searchQuery` | **Certificada** | **Fallido** | `statusFilter` y `shiftFilter` se validan en Zod pero **jamás se envían a PostgREST**, devolviendo páginas incompletas y `totalCount` inexacto; `searchQuery` solo busca en `comments` omitiendo `store` (`src/services/degustacionesWeeklyCycleService.ts:298-405`). |
| **FLT-03** | Búsqueda Maestra (`obtenerClientesMaestros` / `obtenerVendedoresMaestros`) | Backend / PostgREST | Letra `Ñ` (`"ÑAPA"`), comas en razón social (`"INVERSIONES EL SOL, C.A."`), paréntesis, intento de inyección de cláusula `.or()` (`"SOL,activo.eq.false"`) | **Certificada** (neutraliza `,` y `()` antes de `.or()`) | **Con Advertencias** | Bloquea inyección de operadores en `.or()`, pero `sanitizarTerminoIlike` reemplaza `,` por espacio generando doble espacio (`"SOL  C.A."`) y **0 resultados** al buscar razones sociales reales con `", C.A."` (`src/services/masterDataSyncService.ts:1163-1165, 1300-1302`). |
| **FLT-04** | Motor de Fechas y Rangos (`normalizeExcelDate` + `matchesDateFilter`) | UI / Utilidades | Año bisiesto (`29/02/2024` vs `29/02/2026`), `31/04/2026`, `DD/MM/YYYY`, fronteras `23:59:59.999` Caracas, rango invertido `desde > hasta` | **Certificada** (diccionarios `Object.create(null)` + UTC puro) | **Con Advertencias** | Cero desfase de zona horaria; pero cuando `desde > hasta`, `matchesDateFilter` invierte silenciosamente los extremos mientras el backend Zod lanza excepción (`src/utils/excelDateNormalizer.ts:560-565`). |
| **FLT-05** | Parsers Tabulares, Sanitizadores de Texto y Renderizado React DOM | Parsers + DOM | Prefijos `=CMD...`, `+SUM(...)`, `@HYPERLINK(...)`, números negativos `-3.5`, `__proto__`/`constructor`, `<b>texto</b>`, teléfonos con etiquetas | **Certificada** (`0` usos de `dangerouslySetInnerHTML`) | **Aprobado** | Neutraliza *CSV/Formula Injection* al importar y exportar CSV, bloquea *Prototype Pollution* y escapa 100 % de HTML en el DOM (`src/utils/degustacionesTabularParser.ts:71-73`, `src/components/schedule/ScheduleMatrixView.tsx:627-631`). |
| **FLT-06** | Filtros de Tabla y Rango en Módulo 2 (`ScheduleMatrixView`) | UI / React | Rango `matrixDateFrom` / `matrixDateTo`, `selectedShift`, `selectedProduct`, buscador libre con/sin tildes | **Certificada** | **Fallido** | (1) `matrixDateFrom` y `matrixDateTo` **faltan en las dependencias de `useMemo`** de `filteredGlobalTastingItems` y `activeMatrixFilterMeta` (caché obsoleto); (2) `filteredVisits` solo filtra 3 productos fijos; (3) buscador sensible a tildes (`src/components/schedule/ScheduleMatrixView.tsx:211-272, 513-523`). |
| **FLT-07** | Filtros Visuales DOM Módulos 1, 3, 4, Asistencia, `/portal` y Chofer PWA | UI / Browser Live | `"ÑAPA"`, `"ÉXITO"`, `"<b>texto</b>"`, `""`, jornadas, `Historial`, perfiles `FIJA`/`EVENTUAL`, `"María"` vs `"maria"`, `MP-07-0072`, `Hoy` vs `Próximas` | **Certificada en Navegador Real** (`0` `console.error`) | **Con Advertencias** | Todos los filtros actualizaron el DOM sin errores en consola sobre `http://localhost:4177/`. Se confirmó visualmente sensibilidad a tildes en `AttendanceEvidenceSubTab.tsx:254` (`"María"` = 1 resultado; `"maria"` = 0 resultados), mientras Chofer PWA (`normalizar` NFD) sí es insensible a tildes. |

---

## 4. Resultados de Pruebas de Estrés Controladas (`127.0.0.1` Aislado)

Las pruebas se ejecutaron en `tests/antigravity_audit/step4_local_stress_runner.ts` sobre instancias locales reales de `server.ts` conectadas exclusivamente al mock en memoria `127.0.0.1`, en escalones de **10, 50 y 100 solicitudes concurrentes**.

### 4.1 Tabla de Métricas Obtenidas (Latencia, Percentiles, Throughput, Errores y Recursos)

| Escenario / Endpoint | Conc. | Promedio (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Throughput (req/s) | HTTP 2xx | HTTP 429 | HTTP 5xx / Socket Err | CPU User/Sys (ms) | RSS / Δ Heap (MB) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`GET /api/health`** *(Sonda TCP `:5174`)* | **10** | `21.38` | `21.26` | `25.05` | `25.05` | `351.00` | 10 | 0 | 0 / 0 | `47 / 16` | `85.83 / +1.02` |
| **`GET /api/health`** *(Sonda TCP `:5174`)* | **50** | `61.04` | `62.36` | `71.85` | `72.50` | `559.91` | 50 | 0 | 0 / 0 | `250 / 15` | `90.55 / +1.24` |
| **`GET /api/health`** *(Sonda TCP `:5174`)* | **100** | `104.65` | `110.03` | **`124.48`** | **`125.91`** | `665.25` | 100 | 0 | 0 / 0 | `156 / 78` | `85.11 / +0.45` |
| **`POST /api/asistencia/evidencias`** *(PNG + RBAC + Storage)* | **10** | `380.53` | `382.40` | `388.45` | `388.45` | `25.18` | 10 | 0 | 0 / 0 | `141 / 15` | `88.83 / -1.23` |
| **`POST /api/asistencia/evidencias`** *(PNG + RBAC + Storage)* | **50** | `761.04` | `849.24` | `869.66` | `871.69` | `56.61` | 40 | 10 | 0 / 0 | `187 / 78` | `96.73 / +4.53` |
| **`POST /api/asistencia/evidencias`** *(PNG + RBAC + Storage)* | **100** | `678.57` | `532.01` | **`940.23`** | **`947.74`** | `104.40` | 40 | 60 | 0 / 0 | `312 / 141` | `102.34 / +4.82` |
| **`POST /api/asistencia/evidencias/signed-urls`** *(60 UUIDs)* | **10** | `232.18` | `230.98` | `244.20` | `244.20` | `40.36` | 10 | 0 | 0 / 0 | `63 / 31` | `107.63 / +7.38` |
| **`POST /api/asistencia/evidencias/signed-urls`** *(60 UUIDs)* | **50** | `542.27` | `542.09` | `580.39` | `583.04` | `84.11` | 50 | 0 | 0 / 0 | `281 / 110` | `115.28 / -12.64` |
| **`POST /api/asistencia/evidencias/signed-urls`** *(60 UUIDs)* | **100** | `546.86` | `624.83` | **`720.32`** | **`725.61`** | `134.61` | 60 | 40 | 0 / 0 | `469 / 93` | `126.56 / +11.60` |
| **`POST /api/cron/degustaciones-cierre-semanal`** | **10** | `147.92` | `172.63` | `177.27` | `177.27` | `56.04` | 6 | 4 | 0 / 0 | `16 / 0` | `127.55 / +1.10` |
| **`POST /api/cron/degustaciones-cierre-semanal`** | **50** | `175.20` | `165.73` | `257.70` | `258.91` | `191.99` | 6 | 44 | 0 / 0 | `32 / 31` | `128.76 / +4.33` |
| **`POST /api/cron/degustaciones-cierre-semanal`** | **100** | `218.65` | `211.94` | **`330.93`** | **`336.00`** | `295.26` | 6 | 94 | 0 / 0 | `156 / 46` | `134.87 / -11.30` |
| **Filtrado/Paginación Pesada (2,500 Clientes + 2,500 Surveys)** | **10** | `342.47` | `340.24` | `357.03` | `357.03` | `27.54` | 10 | 0 | 0 / 0 | `547 / 0` | `184.14 / -14.04` |
| **Filtrado/Paginación Pesada (2,500 Clientes + 2,500 Surveys)** | **50** | `1149.49` | `1152.38` | `1156.81` | `1157.04` | `42.80` | 50 | 0 | 0 / 0 | `1125 / 110` | `304.07 / -22.80` |
| **Filtrado/Paginación Pesada (2,500 Clientes + 2,500 Surveys)** | **100** | `1994.68` | `1892.98` | **`2446.89`** | **`2447.19`** | `40.52` | 100 | 0 | 0 / 0 | `2453 / 156` | **`348.18 / +133.27`** |

### 4.2 Cuellos de Botella e Incidentes de Arquitectura Identificados bajo Carga

1. **Amplificación Upstream 9.9x en Subida de Evidencias + Auth antes del Rate Limiter (`server.ts:238-239`, `attendanceEvidencesHandler.ts:491-617`)**:
   - Con 10 subidas concurrentes se generaron **99 llamadas HTTP hacia Supabase** (~10 roundtrips secuenciales por foto: `auth.getUser`, `staff` lookup en middleware, `findJornada`, `lookupStaffProfile`, `createJornada`, `listEvidences`, `storage.upload`, `upsertSlotEvidence`, `createSignedUrls`).
   - Al pasar de 50 a 100 solicitudes concurrentes (donde las 50 adicionales fueron rechazadas con `429`), las llamadas a Supabase subieron de `419` a `519` (+`100` llamadas inútiles a `auth.getUser` + `staff`) porque `requireAttendanceActorAuth` se ejecuta **antes** que `attendanceUploadRateLimiter`.
2. **Bloqueo DoS (`HTTP 429`) del Cron Dominical Demostrado Empíricamente (`server.ts:216-221`)**:
   - En la prueba `[D-SEC]`, 6 solicitudes sin credencial válida agotaron `weeklyCronRateLimiter` (`6 req/min`) porque el limitador corre **antes** de `requireCronSecretAuth` y `server.ts` carece de `app.set('trust proxy', 1)`. La séptima petición **con el `CRON_SECRET` legítimo fue bloqueada con `HTTP 429`**.
3. **Crecimiento de Memoria sin Cota (`+133.27 MB` Heap / `348.18 MB` RSS) en Caché de Clientes (`masterDataSyncService.ts:1140-1141, 1319`)**:
   - `cacheClientes` almacena arreglos completos de `ClienteConVendedor[]` indexados por el texto exacto de `busqueda` sin límite máximo de entradas (LRU). Bajo 100 consultas concurrentes con términos distintos sobre 2,500 clientes, el consumo de memoria escaló abruptamente y la latencia `p95` alcanzó `2,446.89 ms`.
4. **Sonda TCP por Petición en `/api/health` (`server.ts:142-153`)**:
   - Abrir un `net.Socket()` en vivo hacia `127.0.0.1:5174` en cada llamada a `/api/health` quintuplicó la latencia (`21.38 ms` -> `124.48 ms p95`) sin caché de estado.
5. **Consultas N+1 y Falta de Índices en Base de Datos**:
   - Bucles `for ... await client.from('surveys').insert/update(...)` secuenciales en `weeklyTastingCronHandler.ts:126-155, 234-255`.
   - `public.entregas_degustacion` carece por completo de índices secundarios (`fecha`, `created_at`, `actualizado_chofer_at`).
   - Búsquedas `ILIKE '%...%'` sobre `public.surveys.comments` (`TEXT`) sin índice GIN `pg_trgm`, y sobrecarga de WAL/WebSockets por `REPLICA IDENTITY FULL` en tablas con payloads JSON/Base64 grandes.

---

## 5. Plan de Acción Priorizado para Llegar al 100%

### Fase P0 — Bloqueantes Críticos de Seguridad e Integridad de Datos *(Obligatorios antes de Producción — lleva el sistema del `73.43%` al `~89%`)*

1. **[P0-SEC-01] Cerrar RLS Anónimo en `solicitudes_contraloria`, `entregas_degustacion` y `surveys` + Enviar JWT Real:**
   - En `src/services/solicitudesContraloriaService.ts:56-61`, inyectar `getCachedAccessToken()` (o usar `getSupabaseClient()`) en `Authorization: Bearer <jwt>`, jamás `SUPABASE_ANON_KEY` fijo.
   - Crear migración SQL que revoque `INSERT/UPDATE/DELETE` a `anon` en `public.solicitudes_contraloria`, `public.entregas_degustacion` y `public.surveys`, exigiendo `TO authenticated` con validación de rol en `app_metadata` (`private.is_coordinator_or_admin()` para aprobar en Contraloría; rol autenticado de chofer/logística en `ruta-degustacion`).
2. **[P0-DATA-02] Eliminar el Split-Brain de Correlativos `MP-07-XXXX` en Contraloría:**
   - En `src/services/solicitudesContraloriaService.ts:456-459`, restringir `isDedicatedTableMissing()` exclusivamente a `status === 404` o códigos `PGRST205` / `42P01` (eliminar `/solicitudes_contraloria/i` del regex).
   - Generar `MP-07-XXXX` mediante una secuencia `SERIAL`/`SEQUENCE` o función RPC atómica en PostgreSQL (`DEFAULT 'MP-07-' || lpad(nextval('seq_mp07')::text, 4, '0')`).
3. **[P0-PERSIST-03] Persistir en Supabase las Operaciones de Módulo 2 y Módulo 3 (`AppContext.tsx`):**
   - Conectar `batchFillClientsProductShift`, `updateVisit`, `addVisit` y `deleteVisitsByIds` en `src/context/AppContext.tsx:1031-1298` con `public.cronograma_degustaciones` vía RPC/SDK.
   - Crear tablas con RLS (`requisiciones_contraloria`, `conciliaciones_inventario`, `comprobantes_fiscales`, `bitacora_auditoria`) para persistir el flujo de 8 etapas y el *Paz y Salvo* de `ContraloriaView`.
4. **[P0-AUTH-04] Alinear `storageKey` de Sesión y Políticas RLS de Escritura en `public.staff`:**
   - En `src/services/cleanSync.ts:12-19` y `src/services/authService.ts:45-62`, preservar y detectar explícitamente `'codizulca.supabase.auth.v1'`, `'codizulca.supabase.master.auth.v1'` y excluir la base IndexedDB `'rutadegustacion-offline'` de `purgeIndexedDb()`.
   - Añadir políticas RLS `INSERT`, `UPDATE` y `DELETE` restringidas a `private.is_coordinator_or_admin()` sobre `public.staff` (y versionar el esquema/RLS de `checkins`, `prices` e `inventory`).
5. **[P0-SQL-05] Corregir Orden de Migraciones SQL, Índice `NO_AUTORIZADA` y `pg_cron`:**
   - Incluir la definición idempotente `CREATE OR REPLACE FUNCTION private.current_active_promotora_id()` al inicio de `20261112_asistencia_evidencias_perfil_condicional.sql` para que las migraciones corran desde cero.
   - Ejecutar `DROP INDEX IF EXISTS public.idx_cronograma_deg_idempotency_active;` y reprogramar `pg_cron` apuntando a `public.ejecutar_cierre_dominical_degustaciones(NOW(), 'America/Caracas', TRUE)`.

### Fase P1 — Mejoras Altas de Filtros, Concurrencia y Rendimiento SRE *(Lleva el sistema del `~89%` al `~97%`)*

6. **[P1-SRE-06] Reordenar Middlewares, Configurar `trust proxy` y Endurecer `server.ts`:**
   - Configurar `app.set('trust proxy', 1)`, colocar `requireCronSecretAuth` **antes** de `weeklyCronRateLimiter` en `server.ts:216-221`, aplicar un rate limiter ligero por IP antes de `auth.getUser()`, acotar `express.json({ limit: '1mb' })` por ruta y agregar cabeceras `helmet`/CORS explícitas.
   - Reemplazar `xlsx@0.18.5` en `package.json` por `read-excel-file` o el tarball mantenido libre de CVEs (`>= 0.20.3`), y configurar variables privadas `SUPABASE_SERVICE_ROLE_KEY` y `CRON_SECRET` en el servidor productivo (exigiendo `SUPABASE_SERVICE_ROLE_KEY` sin caer a `ANON_KEY` en `weeklyTastingCronHandler.ts:30-42`).
7. **[P1-FLT-07] Corregir los 3 Defectos de Filtrado y Unificar Normalización de Acentos:**
   - Añadir `matrixDateFrom` y `matrixDateTo` a los arreglos de dependencias `useMemo` en `src/components/schedule/ScheduleMatrixView.tsx:231-240, 263-272` y ampliar `filteredVisits:514` a todos los productos del catálogo.
   - Aplicar `statusFilter`, `shiftFilter` y búsqueda multi-columna (`store`, `product`, `comments`) en `queryServerPaginatedHistorialSurveys` (`src/services/degustacionesWeeklyCycleService.ts:298-405`).
   - En `sanitizarTerminoIlike` (`src/services/masterDataSyncService.ts:1163`), usar valores entrecomillados PostgREST o reemplazar puntuación por comodín `_` sin duplicar espacios para no romper búsquedas con `", C.A."`, y aplicar normalización NFD insensible a tildes en `AttendanceEvidenceSubTab.tsx:254`, `ScheduleMatrixView.tsx:220` y `FieldPromotoraView.tsx:852`.
8. **[P1-PERF-08] Optimizar Subida de Evidencias, Caché LRU e Índices PostgreSQL:**
   - Consolidar la apertura/validación de jornada y devolución del `storage_path` previo (`RETURNING`) en una única RPC PostgreSQL transaccional (reduciendo ~10 roundtrips a 2 y eliminando los archivos huérfanos TOCTOU en Storage).
   - Limitar `cacheClientes` y `cacheVendedores` a un máximo de 30 claves LRU, cachear `isPortListening(5174)` por 5 segundos en `/api/health`, y crear índices secundarios en `entregas_degustacion(fecha, turno)` e índice GIN `pg_trgm` sobre `surveys.comments`.
9. **[P1-SYNC-09] Desbloquear Check-out Post-Medianoche, Roles SQL y Sincronización con Chofer/FDV:**
   - Permitir en `fn_guard_historical_degustacion_immutability` la transición de `EN_CURSO -> COMPLETADA` desde el trigger `fn_sync_ruta_progress_to_cronograma`, corregir `v_survey.store_name -> v_survey.store` y `' personas' -> 'personas'`, e incluir `'gerente_admin'` en `public.es_admin_trade()`.

### Fase P2 — Detalles Menores de Calidad, Observabilidad y Suite QA *(Lleva el sistema al `100%`)*

10. **[P2-QA-10] Timeouts Faltantes, Limpieza de `catch` Silenciosos y Regresión de Test:**
    - Añadir `AbortController` a `fetchLiveBcvRate` (no bloquear `Promise.all` en `supabaseModule1.ts:1046`), `solicitudesContraloriaService.ts` y `pdfDegustacionesExtractor.ts`; pausar el intervalo de 15 s de `useDegustacionesNotifications` cuando `document.visibilityState === 'hidden'`.
    - Instrumentar logging estructurado en los 22 bloques `catch` silenciosos, realizar apagado ordenado tras `uncaughtException` en `server.ts:40-42`, unificar el formato de guion verificador en `normalizarRifFiscal`, y actualizar `scripts/verifyCicloSemanalDegustaciones.ts` para que valide ambos estados de `ENABLE_MODULO1_CICLO_ISO_BADGE`.
