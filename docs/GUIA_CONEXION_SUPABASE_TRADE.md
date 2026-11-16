# Guía de Conexión, Seguridad y Verificación — Data Maestra en Supabase (`"Trade Marketing"`)

Esta guía documenta el procedimiento exacto y seguro para conectar la aplicación **Trade Marketing** a la Fuente Única de Verdad (**Vendedores** y **Clientes**) en **Supabase (Plan Gratuito)** garantizando cero exposición de secretos, autorización estricta por **Row Level Security (RLS)** e integridad histórica mediante **UPSERT** por lotes.

---

## 0. Acción Previa de Ciberseguridad: Rotar Llaves Secretas Expuestas

> **REGLA DE ORO:** Si en algún momento una llave administrativa (`sb_secret_...` o `service_role`) fue compartida en un chat, correo o captura:
> 1. Ingresa a **Supabase Dashboard** → proyecto **`Trade Marketing`**.
> 2. Ve a **Project Settings → API Keys → Secret keys**.
> 3. Haz clic en **Revoke / Delete** sobre la llave `sb_secret_...` expuesta y genera una nueva **únicamente si un proceso de servidor privado la necesita**.
> 4. **Jamás** coloques una llave `sb_secret_...` ni `service_role` en variables con prefijo `VITE_`. El cliente de la aplicación incluye un candado activo (`assertPublicKeyIsNotSecret`) que bloqueará el arranque si detecta una llave secreta en el frontend.

---

## 1. Copiar `Project URL` y `Publishable / Anon Key` hacia `.env.local`

1. En **Supabase Dashboard**, selecciona el proyecto **`Trade Marketing`**.
2. Para obtener la **URL raíz del proyecto**:
   - Ve a **Project Settings → Data API** y copia el campo **Project URL**.
   - **Importante:** Asegúrate de copiar únicamente el dominio raíz `https://<project-ref>.supabase.co` **sin el sufijo `/rest/v1/`**.
3. Para obtener la **Llave Pública del Cliente**:
   - Ve a **Project Settings → API Keys** y copia la **Publishable key** (`sb_publishable_...`) — o la llave `anon` en la pestaña *Legacy API Keys*.
4. En la raíz del repositorio local, crea o edita el archivo **`.env.local`** (excluido de Git por `.gitignore`):

```dotenv
# Opción A: Proyecto unificado (toda la app apunta a "Trade Marketing")
VITE_SUPABASE_URL=https://<tu-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_<tu-clave-publica>

# Opción B (Opcional): Si mantienes temporalmente otro proyecto para tablas operativas,
# puedes apuntar exclusivamente la Data Maestra al proyecto "Trade Marketing":
# VITE_SUPABASE_MASTER_URL=https://<tu-project-ref-trade-marketing>.supabase.co
# VITE_SUPABASE_MASTER_ANON_KEY=sb_publishable_<tu-clave-publica-trade-marketing>
```

5. Reinicia el servidor de desarrollo (`npm run dev`) para que Vite recargue las variables de entorno.

---

## 2. Ejecutar las Migraciones SQL y Asignar el Rol `'admin'` en `raw_app_meta_data`

### 2.1 Ejecución de Migraciones (Idempotentes)
En **Supabase Dashboard → SQL Editor → New query**, ejecuta en este orden exacto:

1. Contenido completo de [`supabase/migrations/01_schema_maestros.sql`](../supabase/migrations/01_schema_maestros.sql)
   - Crea `public.vendedores`, `public.clientes`, `public.lotes_sincronizacion`, los índices de búsqueda/llaves foráneas y los triggers automáticos de `updated_at`.
2. Contenido completo de [`supabase/migrations/02_rls_y_rpc_sync.sql`](../supabase/migrations/02_rls_y_rpc_sync.sql)
   - Activa `ROW LEVEL SECURITY` en las tres tablas, crea `public.es_admin_trade()` y despliega las funciones transaccionales `public.rpc_sincronizar_vendedores` y `public.rpc_sincronizar_clientes`.

*(Ambos scripts usan `IF NOT EXISTS` y bloques seguros, por lo que pueden re-ejecutarse sin riesgo de pérdida de datos).*

### 2.2 Asignar Rol `'admin'` o `'gerencia'` al Usuario Administrador
Las políticas RLS y las funciones RPC ignoran deliberadamente `user_metadata` (editable desde el navegador) y verifican únicamente **`raw_app_meta_data`** firmado por el servidor de Supabase Auth.

1. Primero crea tu usuario en **Authentication → Users → Add user** (si aún no existe).
2. En **SQL Editor**, ejecuta la siguiente sentencia reemplazando `<correo-administrador@codizulca.com>` por el correo real del administrador:

```sql
UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
  'role', 'admin',
  'app_role', 'admin'
)
WHERE LOWER(email) = LOWER('<correo-administrador@codizulca.com>');
```

3. Verifica que el claim quedó registrado:

```sql
SELECT id, email, raw_app_meta_data
FROM auth.users
WHERE LOWER(email) = LOWER('<correo-administrador@codizulca.com>');
```

4. **Cierra sesión y vuelve a iniciar sesión** en la aplicación para que Supabase emita un nuevo JWT con `app_metadata.role = "admin"`.

---

## 3. Prueba de Carga, Actualización e Idempotencia (5 Vendedores y 15 Clientes)

### 3.1 Verificación Automatizada Local (`Zod` + Lotes de 400 + Doble Corrida Idempotente)
Ejecuta en tu terminal:

```bash
npm run verify:maestros
```

Este comando valida automáticamente:
- Bloqueo de llaves `sb_secret_*` / `service_role` en configuración pública.
- Limpieza de encabezados, comillas triples, teléfonos y RIFs (`#N/D` → `NULL`).
- Doble ejecución consecutiva del lote de **5 vendedores y 15 clientes** comprobando **0 duplicados** e integridad de desactivación lógica (`activo = false`).
- Procesamiento por lotes (`400` registros/chunk) y paginación automática (`> 2,700` clientes).

### 3.2 Prueba Directa en Supabase SQL Editor (Ejecutar 2 Veces Seguidas)
Pega y ejecuta el siguiente bloque en **Supabase SQL Editor** **dos veces consecutivas** para comprobar en vivo sobre PostgreSQL la idempotencia (`ON CONFLICT DO UPDATE`), el enlace automático `vendedor_id` y el manejo seguro de códigos de vendedor inexistentes:

```sql
DO $$
DECLARE
  v_res_vendedores JSONB;
  v_res_clientes JSONB;
BEGIN
  -- Simular contexto JWT autenticado con rol admin en app_metadata
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","app_metadata":{"role":"admin"}}',
    true
  );

  -- 1. Sincronizar 5 Vendedores Maestros
  v_res_vendedores := public.rpc_sincronizar_vendedores(
    '[
      {"codigo_vendedor":" v-001 ","nombre_completo":"OSCAR ORTIZ","zona":"LA COSTA","supervisor":"SUPERVISOR NORTE","telefono":"0414-6001101"},
      {"codigo_vendedor":"V-002","nombre_completo":"LUIS GUANIPA","zona":"MARACAIBO SUR","supervisor":"SUPERVISOR SUR","telefono":"0414-6001102"},
      {"codigo_vendedor":"V-003","nombre_completo":"MARIA FERNANDEZ","zona":"SAN FRANCISCO","supervisor":"SUPERVISOR SUR","telefono":"0412-6001103"},
      {"codigo_vendedor":"V-004","nombre_completo":"CARLOS URDANETA","zona":"COL","supervisor":"SUPERVISOR ORIENTAL","telefono":"0424-6001104"},
      {"codigo_vendedor":"V-005","nombre_completo":"ANA VILLALOBOS","zona":"MARACAIBO NORTE","supervisor":"SUPERVISOR NORTE","telefono":"0416-6001105"}
    ]'::jsonb,
    false
  );

  -- 2. Sincronizar 15 Clientes Maestros (incluye 1 con RIF #N/D y 1 con vendedor V-999 aún inexistente)
  v_res_clientes := public.rpc_sincronizar_clientes(
    '[
      {"codigo_cliente":" c-101 ","rif":"J- 301001010 ","razon_social":"SUPERMERCADO LA POPULAR C.A.","canal":"Supermercado","zona":"LA COSTA","ruta":"R01","codigo_vendedor":"v-001"},
      {"codigo_cliente":"C-102","rif":"J-301001010","razon_social":"SUPERMERCADO LA POPULAR SUCURSAL 2 C.A.","canal":"Supermercado","zona":"LA COSTA","ruta":"R01","codigo_vendedor":"V-001"},
      {"codigo_cliente":"C-103","rif":"J-402002021","razon_social":"DISTRIBUIDORA EL SOL C.A.","canal":"Mayorista","zona":"LA COSTA","ruta":"R02","codigo_vendedor":"V-001"},
      {"codigo_cliente":"C-104","rif":"J-402002030","razon_social":"ABASTO Y CHARCUTERIA ZULIA C.A.","canal":"Tradicional","zona":"MARACAIBO SUR","ruta":"R03","codigo_vendedor":"V-002"},
      {"codigo_cliente":"C-105","rif":"#N/D","razon_social":"BODEGON EN TRAMITE FISCAL","canal":"Tradicional","zona":"MARACAIBO SUR","ruta":"R03","codigo_vendedor":"V-002"},
      {"codigo_cliente":"C-106","rif":"J-501112223","razon_social":"FARMACIA SALUD INTEGRAL C.A.","canal":"Farmacia","zona":"MARACAIBO SUR","ruta":"R04","codigo_vendedor":"V-002"},
      {"codigo_cliente":"C-107","rif":"J-501112240","razon_social":"HIPERMERCADO DEL SUR C.A.","canal":"Cuentas Claves","zona":"SAN FRANCISCO","ruta":"R05","codigo_vendedor":"V-003"},
      {"codigo_cliente":"C-108","rif":"V-123456789","razon_social":"JOSE PEREZ (INVERSIONES EL PUENTE)","canal":"Tradicional","zona":"SAN FRANCISCO","ruta":"R05","codigo_vendedor":"V-003"},
      {"codigo_cliente":"C-109","rif":"J-412223334","razon_social":"COMERCIALIZADORA COROMOTO C.A.","canal":"Mayorista","zona":"SAN FRANCISCO","ruta":"R06","codigo_vendedor":"V-003"},
      {"codigo_cliente":"C-110","rif":"J-309998887","razon_social":"AUTOMERCADO COSTA ORIENTAL C.A.","canal":"Supermercado","zona":"COL","ruta":"R07","codigo_vendedor":"V-004"},
      {"codigo_cliente":"C-111","rif":"J-309998895","razon_social":"MAYOR DE VIVERES CABIMAS C.A.","canal":"Mayorista","zona":"COL","ruta":"R07","codigo_vendedor":"V-004"},
      {"codigo_cliente":"C-112","rif":"J-309998900","razon_social":"PANADERIA Y CHARCUTERIA REAL C.A.","canal":"Tradicional","zona":"COL","ruta":"R08","codigo_vendedor":"V-004"},
      {"codigo_cliente":"C-113","rif":"J-503334445","razon_social":"SUPERMERCADO BELLA VISTA C.A.","canal":"Cuentas Claves","zona":"MARACAIBO NORTE","ruta":"R09","codigo_vendedor":"V-005"},
      {"codigo_cliente":"C-114","rif":"J-503334453","razon_social":"MINIMARKET LAS DELICIAS C.A.","canal":"Tradicional","zona":"MARACAIBO NORTE","ruta":"R09","codigo_vendedor":"V-005"},
      {"codigo_cliente":"C-115","rif":"J-504445556","razon_social":"COMERCIAL RUTA EN APERTURA C.A.","canal":"Tradicional","zona":"PERIFERIA","ruta":"R99","codigo_vendedor":"V-999"}
    ]'::jsonb,
    NULL
  );

  RAISE NOTICE 'Resumen Vendedores: %', v_res_vendedores;
  RAISE NOTICE 'Resumen Clientes: %', v_res_clientes;
END $$;
```

### 3.3 Consulta de Verificación Tras Ejecutarlo Dos Veces Seguidas

```sql
SELECT
  (SELECT COUNT(*) FROM public.vendedores) AS total_vendedores,
  (SELECT COUNT(*) FROM public.clientes) AS total_clientes,
  (SELECT COUNT(*) FROM public.clientes WHERE activo = true) AS clientes_activos,
  (SELECT COUNT(*) FROM public.clientes WHERE vendedor_id IS NOT NULL) AS clientes_con_vendedor_enlazado,
  (SELECT COUNT(*) FROM public.clientes WHERE vendedor_id IS NULL) AS clientes_pendientes_de_vendedor;
```

**Resultado esperado tras 1, 2 o N ejecuciones:**
- `total_vendedores` = **`5`** (cero duplicados; `" v-001 "` normalizado a `"V-001"`).
- `total_clientes` = **`15`** (cero duplicados; `" c-101 "` normalizado a `"C-101"` y RIF `"J- 301001010 "` normalizado a `"J-301001010"`).
- `clientes_con_vendedor_enlazado` = **`14`**.
- `clientes_pendientes_de_vendedor` = **`1`** (`C-115`, cuyo `codigo_vendedor = 'V-999'` queda registrado como advertencia sin abortar el lote).

*(Si deseas limpiar únicamente estos 20 registros de demostración antes de subir la maestra definitiva de producción, ejecuta la carga oficial con `reconciliarCarteraClientes: true` y `desactivarVendedoresAusentes: true`, lo cual los marcará automáticamente como `activo = false` conservando la integridad referencial).*

---

## 4. Uso en la Aplicación (`masterDataSyncService` y `useMasterData`)

```tsx
import { useMasterData } from '../hooks/useMasterData';

export function SelectorClientesRuta({ codigoVendedor }: { codigoVendedor?: string }) {
  const { clientes, vendedores, cargando, sincronizarArchivo } = useMasterData({
    filtrosClientes: {
      soloActivos: true,
      codigoVendedor,
    },
    suscribirCambiosRealtime: true,
  });

  // sincronizarArchivo(file, { reconciliarCarteraClientes: true })
  // procesa automáticamente lotes de 400 vendedores + lotes de 400 clientes
  // y cierra el acta en public.lotes_sincronizacion.
}
```
