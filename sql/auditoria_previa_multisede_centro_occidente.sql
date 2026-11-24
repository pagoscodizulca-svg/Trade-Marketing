-- ==============================================================================
-- AUDITORÍA PREVIA DE SOLO LECTURA — AISLAMIENTO MULTISEDE ('CENTRO' vs 'OCCIDENTE')
-- Proyecto: Trade Marketing CODIZULCA (apaxdgxtaoeyswlfblgi.supabase.co)
-- Propósito (BLOQUE 7 — Fase A):
--   Ejecutar ANTES de la migración transaccional para auditar de forma 100% no
--   destructiva:
--   1. Usuarios actuales en auth.users / public.profiles y su sucursal destino.
--   2. Políticas RLS y permisos actuales sobre public.surveys (canal FDV).
--   3. Tiendas Makro del Centro (San Diego, Naguanagua, El Samán Maracay, Turmero)
--      y promotoras/solicitudes que hoy aparecen mezcladas en Occidente.
--   4. Cualquier registro ambiguo antes de aplicar SET NOT NULL sobre sucursal.
-- ==============================================================================

-- 1) AUDITORÍA DE USUARIOS AUTH Y CLASIFICACIÓN PROPUESTA A 'CENTRO' / 'OCCIDENTE'
SELECT
  u.id AS user_id,
  u.email,
  p.role AS perfil_rol_actual,
  p.sucursal AS perfil_sucursal_actual,
  p.region AS perfil_region_actual,
  p.regiones_asignadas,
  u.raw_app_meta_data ->> 'role' AS jwt_app_role,
  u.raw_app_meta_data ->> 'sucursal' AS jwt_app_sucursal,
  CASE
    WHEN LOWER(COALESCE(p.role::text, u.raw_app_meta_data ->> 'role', '')) IN ('super_admin', 'admin', 'gerente_admin', 'admin_nacional')
      THEN 'admin_nacional'
    ELSE 'coordinador'
  END AS rol_propuesto,
  CASE
    WHEN LOWER(COALESCE(u.email, '')) LIKE 'maria01@%'
      OR UPPER(COALESCE(p.sucursal::text, '')) IN ('CENTRO', 'VALENCIA', 'CAPITAL')
      OR UPPER(COALESCE(p.region, '')) IN ('CENTRO', 'VALENCIA', 'ANDES')
      THEN 'CENTRO'
    ELSE 'OCCIDENTE'
  END AS sucursal_propuesta
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
ORDER BY u.email;

-- 2) AUDITORÍA DE CANAL DE INGESTA DE dashboard-fdv-planificador EN public.surveys
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('surveys', 'cronograma_degustaciones', 'promotoras', 'clientes')
ORDER BY tablename, policyname;

SELECT
  grantee,
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privilegios
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('surveys', 'cronograma_degustaciones', 'productos', 'promotoras', 'clientes')
  AND grantee IN ('anon', 'authenticated', 'service_role')
GROUP BY grantee, table_name
ORDER BY table_name, grantee;

-- 3) DETECCIÓN DE TIENDAS DEL CENTRO (INCLUYENDO MAKRO SAN DIEGO, NAGUANAGUA,
--    EL SAMÁN MARACAY Y TURMERO MARACAY) QUE HOY ESTÁN MAL ETIQUETADAS O SIN SEDE
SELECT
  c.id,
  c.codigo_cliente,
  c.nombre_comercial,
  c.razon_social,
  c.ciudad,
  c.estado,
  c.zona,
  c.sucursal AS sucursal_actual,
  'CENTRO' AS sucursal_corregida
FROM public.clientes c
WHERE COALESCE(c.sucursal::text, '') IS DISTINCT FROM 'CENTRO'
  AND CONCAT_WS(' ', c.nombre_comercial, c.razon_social, c.direccion, c.ciudad, c.estado, c.zona) ~*
      '(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|caracas|miranda|centro)'
ORDER BY c.nombre_comercial;

-- 4) DETECCIÓN DE PROMOTORAS DE CARABOBO / ARAGUA CLASIFICADAS ERRÓNEAMENTE EN OCCIDENTE
SELECT
  pr.id::text AS id,
  pr.nombre_completo,
  COALESCE(to_jsonb(pr) ->> 'email', to_jsonb(pr) ->> 'correo') AS correo_promotora,
  to_jsonb(pr) ->> 'ciudad' AS ciudad,
  to_jsonb(pr) ->> 'estado' AS estado,
  to_jsonb(pr) ->> 'direccion' AS direccion,
  to_jsonb(pr) ->> 'region' AS region_actual,
  to_jsonb(pr) ->> 'sucursal' AS sucursal_actual,
  'CENTRO' AS sucursal_corregida
FROM public.promotoras pr
WHERE COALESCE(to_jsonb(pr) ->> 'sucursal', '') IS DISTINCT FROM 'CENTRO'
  AND CONCAT_WS(
    ' ',
    pr.nombre_completo,
    to_jsonb(pr) ->> 'ciudad',
    to_jsonb(pr) ->> 'estado',
    to_jsonb(pr) ->> 'direccion',
    to_jsonb(pr) ->> 'region'
  ) ~*
      '(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|caracas|miranda|centro)'
ORDER BY pr.nombre_completo;

-- 5) DETECCIÓN DE SOLICITUDES DE DEGUSTACIÓN (public.surveys) DEL CENTRO MEZCLADAS EN OCCIDENTE
SELECT
  s.id,
  s.date,
  s.store,
  s.promoter,
  s.sucursal AS sucursal_actual,
  s.region AS region_actual,
  'CENTRO' AS sucursal_corregida
FROM public.surveys s
WHERE s.type = 'Degustacion'
  AND COALESCE(s.sucursal::text, '') IS DISTINCT FROM 'CENTRO'
  AND CONCAT_WS(' ', s.store, s.region, s.comments) ~*
      '(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|caracas|miranda|centro)'
ORDER BY s.created_at DESC;

-- 6) RESUMEN DE REGISTROS POTENCIALMENTE AMBIGUOS ANTES DE SET NOT NULL
WITH clasificacion_surveys AS (
  SELECT
    s.id,
    s.type,
    s.store,
    s.sucursal AS sucursal_actual,
    CASE
      WHEN CONCAT_WS(' ', s.store, s.region, s.sucursal::text, s.comments) ~*
           '(san diego|naguanagua|el sam[aá]n|saman|turmero|maracay|aragua|carabobo|valencia|guacara|tocuyito|los guayos|cagua|la victoria|puerto cabello|mariara|cojedes|guarico|caracas|distrito capital|miranda|la guaira|t[aá]chira|san crist[oó]bal|m[eé]rida|barinas|el vig[ií]a|andes|centro)'
        THEN 'CENTRO'
      WHEN CONCAT_WS(' ', s.store, s.region, s.sucursal::text, s.comments) ~*
           '(occidente|zulia|maracaibo|san francisco|cabimas|ciudad ojeda|lagunillas|machiques|la villa|mara|moj[aá]n|falc[oó]n|coro|punto fijo|paraguan[aá]|trujillo|valera|lara|barquisimeto|cabudare)'
        THEN 'OCCIDENTE'
      ELSE NULL
    END AS sucursal_inferida
  FROM public.surveys s
)
SELECT
  COALESCE(sucursal_inferida, 'AMBIGUO_REVISAR') AS clasificacion,
  COUNT(*) AS total_registros
FROM clasificacion_surveys
GROUP BY 1
ORDER BY 1;
