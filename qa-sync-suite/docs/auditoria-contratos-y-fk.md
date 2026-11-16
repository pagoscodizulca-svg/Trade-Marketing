# Auditoría de Contratos de Datos, Autenticación, Triggers y Árbol FK (`qa-sync-suite`)

Documento técnico de referencia generado a partir de la inspección estática (solo lectura) de las tres carpetas de aplicaciones productivas del ecosistema Codizulca.

---

## 1. Matriz de Autenticación por Aplicación

| Aplicación | Carpeta Productiva (Solo Lectura) | Método de Autenticación | Tabla / Claim de Perfil y Autorización |
| :--- | :--- | :--- | :--- |
| **App de Vendedores / Supervisión FDV** | `App para los bot/dashboard-fdv---planificador` | Diccionario local `vendorCredentials` en `src/App.tsx:155-204` (`localStorage` + inserción opcional en `public.trazabilidad_login` en línea 238). | `userRole` local (`'ADMIN'` \| `'VENDEDOR'`). No usa `signInWithPassword` en el formulario actual. |
| **Dashboard Planificador / Módulo de Degustaciones** | `Trade Marketing` (Módulos 1 y 2) | `supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })` (`src/services/authService.ts:283-315`). | `auth.users.raw_app_meta_data->>'app_role'` (`'admin'` \| `'coordinadora'` \| `'gerencia'`) verificado por `private.is_coordinator_or_admin()`. |
| **App de las Promotoras (`/portal`)** | `Trade Marketing/src/components/portal/PromotoraRutaPortalView.tsx` | `supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })` (`src/services/authService.ts:321-355`). | `auth.users` + fila activa en `public.staff` (`status = 'Activo'`, `role` sin `'merchandising'`, `auth_user_id = auth.uid()`) verificado por `private.current_active_promotora_id()`. |

---

## 2. Contratos de Sincronización Entre Aplicaciones

### 2.1 Contrato A — `App de Vendedores -> Bandeja de Entrada (public.surveys)`
- **Origen en código:** `dashboard-fdv---planificador/src/services/degustacionesService.ts:312-497` (`syncToGerenciaDashboard`).
- **Operación:**
  1. Verificación previa de existencia:
     `GET /rest/v1/surveys?type=eq.Degustacion&comments=ilike.*<cleanId>*&limit=1`
  2. Si no existe: `POST /rest/v1/surveys` (`Prefer: return=representation`). Si existe: `PATCH /rest/v1/surveys?id=eq.<existingId>`.
- **Estructura exacta de fila en `public.surveys`:**
  - `type`: `'Degustacion'`
  - `date`: `'YYYY-MM-DD'` (Jueves, Viernes o Sábado `>= fn_hoy_caracas()`)
  - `store`: Razón social del cliente
  - `promoter`: Nombre del vendedor solicitante (hasta ser asignada una promotora)
  - `product`: Lista CSV de productos a degustar
  - `creatorId`: Identificador/nombre del vendedor
  - `leido_trade`: `false` (solicitud nueva)
  - `visto_en_trade_at`: `null`
  - `comments`: JSON serializado con las llaves:
    `isTasting: true`, `source: 'vendedor_app'`, `degustacionId`, `id`, `client`, `cliente`, `clienteCodigo`, `store`, `vendedor`, `salesRep`, `vendedorId`, `promoter`, `promotoraAsignada`, `ruta`, `date`, `turno` (`'MAÑANA'` \| `'TARDE'`), `shift`, `time`, `products` (`string[]`), `product`, `kilos`, `kg`, `personas`, `personasEstimadas`, `estado: 'SOLICITADA'`, `status: 'pendiente'`, `leido_trade: false`, `visto_en_trade_at: null`, `created_at`, `requierePromotora: true`, `promoterType`, `materialPop`, `contactoPunto`, `telefonoContacto`, `address`, `notes`, `originalComments`, `observaciones`, `notasTradeMarketing`, `resultado`.
- **Canal Realtime receptor en Bandeja:** `trade-marketing-degustaciones-realtime` (`postgres_changes` sobre `public.surveys` con filtro `type=eq.Degustacion`, `src/hooks/useDegustacionesNotifications.ts:271-315`).

### 2.2 Contrato B (Ida) — `Bandeja / Módulo de Degustaciones -> App de Promotoras (/portal)`
- **Origen en código:** `Trade Marketing/src/services/degustacionesPipelineService.ts:922-999` (`autorizarDegustacionTradeViaRpc`).
- **Operación transaccional:** RPC `public.rpc_autorizar_degustacion_trade(p_promotora_id, p_survey_id, p_cronograma_id, p_aprobado_por)` (con fallback `public.asignar_degustacion_aceptada_a_ruta`).
- **Efectos atómicos en PostgreSQL:**
  1. Verifica `private.is_coordinator_or_admin()` sobre el JWT del actor (`qa_planificador`).
  2. Valida que `p_promotora_id` exista activa en `public.staff` con email válido y rol de promotora.
  3. Actualiza `public.surveys` (`leido_trade = true`, `visto_en_trade_at = NOW()`, `promoter = v_staff.name`, y dentro de `comments` actualiza `estado = 'APROBADA'`, `promotoraId`, `promotoraEmail`, `promotoraAsignada`).
  4. Hace `UPSERT` idempotente en `public.cronograma_degustaciones` (`survey_origen_id = p_survey_id`, `estado = 'APROBADA'`, `promotora_id = p_promotora_id`).
  5. Dispara `trg_sync_cronograma_to_rutas_promotoras`, proyectando mediante `ON CONFLICT (cronograma_id) DO UPDATE` la fila en `public.rutas_promotoras` con `estado_ruta = 'ASIGNADA'`.
- **Canal Realtime receptor en `/portal`:** `portal-ruta:<userId>:<staffId>` (`postgres_changes` sobre `public.rutas_promotoras` con filtro `promotora_id=eq.<staffId>`, `src/hooks/usePromotoraRutaRealtime.ts:127-221`).

### 2.3 Contrato C (Vuelta) — `App de Promotoras (/portal) -> Módulo de Degustaciones`
- **Origen en código:** `Trade Marketing/src/services/promotoraRutaPortalService.ts:104-127` (`registrarAvanceRutaPortal`).
- **Operación transaccional:** RPC `public.registrar_avance_ruta_promotora(p_ruta_id, p_accion)` donde `p_accion IN ('CHECKIN', 'CHECKOUT')`.
- **Efectos atómicos en PostgreSQL:**
  1. Bloquea la fila con `FOR UPDATE` en `public.rutas_promotoras` y verifica propiedad estricta (`promotora_id = private.current_active_promotora_id()` o coordinador/admin).
  2. `'CHECKIN'` transiciona `estado_ruta` a `'EN_CURSO'` y sella `checkin_at = COALESCE(checkin_at, NOW())`.
  3. `'CHECKOUT'` exige check-in previo, transiciona `estado_ruta` a `'COMPLETADA'` y sella `checkout_at = COALESCE(checkout_at, NOW())`.
  4. El trigger `trg_guard_rutas_promotoras_immutable_cols` protege todas las columnas comerciales planificadas (`cliente_nombre`, `cantidad_kilos`, `observaciones`, `promotora_id`, etc.) contra alteración por parte de promotoras.
  5. El trigger `trg_sync_ruta_progress_to_cronograma` propaga `estado = NEW.estado_ruta` (`'EN_CURSO'` / `'COMPLETADA'`) hacia `public.cronograma_degustaciones`.
- **Canal Realtime receptor en Módulo 2:** `trade-cronograma-productos-realtime` (`postgres_changes` sobre `public.cronograma_degustaciones` y `public.rutas_promotoras`, `src/hooks/useCronogramaRealtimeSync.ts:50-74`).
- **Evidencias fotográficas de jornada:** `public.asistencias_jornada` + `public.asistencia_evidencias` + bucket privado `asistencia-evidencias` con path determinista `asistencia/YYYY-MM-DD/<promotora_uuid>/<SLOT>_<uuid>.(jpg|png|webp)`.

---

## 3. Árbol de Dependencias FK y Orden Inverso Obligatorio de Purga

Debido a que `public.asistencias_jornada`, `public.rutas_promotoras` y `public.cronograma_degustaciones` declaran **`REFERENCES public.staff(id) ON DELETE RESTRICT`**, el borrado administrativo debe ejecutarse estrictamente en la siguiente secuencia:

1. **Paso A — Storage:** Objetos en `storage.objects` (`bucket_id = 'asistencia-evidencias'`).
2. **Paso B — Tablas Hijas Operativas:**
   - `public.asistencia_evidencias` (`ON DELETE CASCADE` desde `asistencias_jornada`)
   - `public.asistencias_jornada` (`ON DELETE RESTRICT` hacia `staff`)
   - `public.rutas_promotoras` (`ON DELETE RESTRICT` hacia `staff`, `ON DELETE CASCADE` desde `cronograma_degustaciones`)
   - `public.trazabilidad_login` (si existiera fila etiquetada con `RUN_ID`)
3. **Paso C — Módulo de Degustaciones y Bandeja de Entrada:**
   - `public.cronograma_degustaciones` (`ON DELETE RESTRICT` hacia `staff`, `ON DELETE SET NULL` hacia `surveys`)
   - `public.cargas_archivos` (si existiera cabecera auxiliar con `RUN_ID`)
   - `public.surveys` (solicitudes en Bandeja de Entrada etiquetadas con `RUN_ID`)
4. **Paso D — Cliente Ficticio y Catálogo Auxiliar:**
   - `public.clientes` (`Cliente Prueba`, `vendedor_id REFERENCES vendedores(id) ON DELETE SET NULL`)
   - `public.vendedores` (Vendedor QA auxiliar)
5. **Paso E — Perfiles Públicos y Cuentas `auth.users`:**
   - `public.staff` (`qa_promotora_a`, `qa_promotora_b`)
   - Revocación global de sesiones + `auth.admin.deleteUser` en `auth.users` (`qa_vendedor`, `qa_planificador`, `qa_promotora_a`, `qa_promotora_b`).
