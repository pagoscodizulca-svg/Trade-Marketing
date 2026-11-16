# Guía de Despliegue y Verificación E2E: Portal Nativo `/portal`, Bandeja/Historial (`America/Caracas`) y Sincronización Realtime

Esta guía documenta la puesta en marcha y prueba de extremo a extremo (E2E) en el proyecto compartido de Supabase **`"dashboard de gerencia"`** para **`Programa de Trade Marketing`**.

---

## 1. Aplicar la Migración SQL en Supabase (`"dashboard de gerencia"`)

1. Ingresa al panel de Supabase y selecciona el proyecto **`"dashboard de gerencia"`**.
2. Abre **SQL Editor → New Query**.
3. Copia el contenido íntegro de [`supabase/migrations/20261114_portal_promotoras_bandeja_realtime.sql`](../supabase/migrations/20261114_portal_promotoras_bandeja_realtime.sql) y presiona **Run**.
4. Esta migración es **100 % idempotente** y configura automáticamente:
   - Función `public.fn_hoy_caracas()` evaluada en `America/Caracas` (`UTC-4`).
   - Estado oficial `'NO_AUTORIZADA'` en `public.cronograma_degustaciones`.
   - Normalización `LOWER(BTRIM(email))` e índices funcionales en `public.staff`, `public.cronograma_degustaciones` y `public.rutas_promotoras`.
   - Funciones transaccionales atómicas `public.rpc_autorizar_degustacion_trade(...)` (`ON CONFLICT DO UPDATE`) y `public.rpc_no_autorizar_degustacion_trade(...)`.
   - Políticas **Row Level Security (RLS)** estrictas para que cada promotora autenticada con su correo de **Pestaña de Personal** consulte y actualice **únicamente** sus propias rutas autorizadas vigentes/futuras (`fecha >= hoy_caracas`).
   - Publicación **Supabase Realtime** (`REPLICA IDENTITY FULL` + `supabase_realtime`) sobre `public.cronograma_degustaciones`, `public.rutas_promotoras` y `public.surveys`.

---

## 2. Configurar URLs de Autenticación en Supabase Auth

Para que el inicio de sesión de promotoras en `/portal` con **Correo electrónico y Contraseña** opere bajo la configuración oficial de **`Programa de Trade Marketing`**:

1. En el proyecto **`"dashboard de gerencia"`**, ve a **Authentication → URL Configuration**.
2. En **Redirect URLs**, agrega:
   - Entorno local: `http://localhost:3000/portal` y `http://localhost:3000/portal/*`
   - Entorno producción (Render / dominio oficial): `https://<tu-dominio-trade-marketing>/portal` y `https://<tu-dominio-trade-marketing>/portal/*`
3. Guarda los cambios (**Save**).

> **Seguridad de Variables de Entorno:** Verifica que tu archivo local `.env.local` (excluido por `.gitignore`) contenga únicamente `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` del proyecto `"dashboard de gerencia"`. Nunca incluyas `SUPABASE_SERVICE_ROLE_KEY` en variables `VITE_*` ni en el frontend.

---

## 3. Flujo Operativo de la Coordinadora en Módulo 1

### A. Registrar Correo en Pestaña de Personal y Compartir `/portal`
1. Abre **`Programa de Trade Marketing`** → **Módulo 1 (`Promotoras y Fuerza de Ventas`)** → pestaña **Personal**.
2. Verifica que cada promotora activa tenga registrado su **Correo Electrónico**, su **Contraseña** aprovisionada y opcionalmente su teléfono móvil.
3. Usa el botón **`Enviar Link por WhatsApp`** disponible tanto en la **barra superior del Módulo 1** como en la **tarjeta individual de cada promotora**:
   - Abre `https://wa.me/...` con teléfono normalizado E.164 (`584...`), mensaje personalizado con el link dinámico `${window.location.origin}/portal` y el correo con el que debe iniciar sesión.

### B. Bandeja de Entrada vs. Pestaña de Historial (`America/Caracas`, `UTC-4`)
- **Bandeja de Entrada (`Solicitudes y Agenda Vigente`):**
  - Muestra todas las degustaciones con fecha de hoy, del próximo lunes o de cualquier fecha futura (`fecha >= hoy_caracas`) que no hayan sido descartadas.
  - Para cada solicitud pendiente:
    1. Selecciona la **Promotora** (el sistema valida que cuente con correo válido en **Pestaña de Personal**).
    2. Haz clic en **`Autorizar`** para aprobarla y publicarla instantáneamente, o en **`No Autorizar`** para descartarla y enviarla a Historial con etiqueta **`No Autorizada`**.
- **Pestaña de Historial:**
  - Recibe automáticamente toda degustación cuya fecha ya pasó (`fecha < hoy_caracas` al cruzar las `00:00:00 America/Caracas`) y toda solicitud descartada.
  - Conserva la insignia **`Autorizada`** en las degustaciones que sí fueron aprobadas y muestra la insignia explícita **`No Autorizada`** en toda solicitud que nunca se aprobó antes de pasar su fecha o que fue descartada con `No Autorizar`.

---

## 4. Lista de Comprobación E2E en Tiempo Real (3 Ventanas Simultáneas)

1. **Ventana 1 (Coordinadora — Módulo 1):** `http://localhost:3000/` en **Promotoras y Fuerza de Ventas → Bandeja de Entrada**.
2. **Ventana 2 (Coordinadora — Módulo 2):** `http://localhost:3000/` en **Cronograma de productos** (observa el indicador verde **`Realtime Activo`**).
3. **Ventana 3 (Promotora — Portal Nativo, ventana incógnito o móvil):** `http://localhost:3000/portal` iniciando sesión con el **correo electrónico registrado en Pestaña de Personal**.
4. **Prueba 1 — Autorización Instantánea:**
   - En la **Ventana 1**, elige una solicitud de hoy o del próximo lunes, asigna a la promotora de prueba y pulsa **`Autorizar`**.
   - **Resultado esperado sin recargar (F5):**
     - Aparece el banner de confirmación con acceso directo **`Enviar Ruta por WhatsApp`** y **`Copiar Link /portal`**.
     - En la **Ventana 3 (`/portal`)**, la degustación aparece de inmediato ordenada por fecha y punto de venta.
     - En la **Ventana 2 (`Cronograma de productos`)**, el evento autorizado se refleja al instante en el calendario/matriz.
5. **Prueba 2 — Descarte Explícito (`No Autorizar`):**
   - En la **Ventana 1**, pulsa **`No Autorizar`** sobre una solicitud pendiente de prueba.
   - **Resultado esperado:** Sale de **Bandeja de Entrada**, aparece inmediatamente en **Pestaña de Historial** con la etiqueta roja **`No Autorizada`**, y **no** aparece en `/portal` ni como evento activo en `Cronograma de productos`.

---

## 5. Reactivación Opcional de Controles Ocultos (Feature Flags)

Los botones y paneles ocultos del Módulo 1 se conservan intactos en el código fuente y pueden reactivarse en cualquier momento cambiando su valor a `true` en [`src/config/featureFlags.ts`](../src/config/featureFlags.ts):

- `ENABLE_MODULO1_CARGAR_ARCHIVO` (`Cargar Archivo (Excel / CSV / PDF)`)
- `ENABLE_MODULO1_ENVIAR_SOLICITUD_FDV` (`+ Enviar Solicitud FDV`)
- `ENABLE_MODULO1_CICLO_ISO_BADGE` (`Ciclo ISO (...) · UTC-4`)
- `ENABLE_MODULO1_TABLAS_METRICAS` (Tarjetas y modal 360° de métricas del Módulo 1)
