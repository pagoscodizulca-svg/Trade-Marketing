-- ==============================================================================
-- FASE 4 · LECTURA AUTENTICADA RLS SOBRE CATÁLOGOS ERP DE CODIZULCA EN SUPABASE
-- ==============================================================================
-- Objetivo:
--   Habilitar lectura autenticada (`TO authenticated`, cero acceso `anon`) sobre
--   las tablas maestras reales del ERP (`"Regiones"`, `"Sucursales"`, `"Estados"`,
--   `"Municipios"`, `"Supervisores"`, `"Tipificacion_Clientes"`, `"Vendedores"`,
--   `"Clientes"`) para que la Torre de Control y el Cronograma carguen los
--   clientes de cada sede (Zulia/Occidente, Valencia, Capital, Centro) de forma
--   directa y segura.
--
-- Seguridad e Idempotencia:
--   - Cero acceso `anon` / `public`.
--   - No modifica, borra ni altera registros existentes.
--   - Protegido con `to_regclass(...) IS NOT NULL` para ejecutarse de manera
--     segura en cualquier entorno.
-- ==============================================================================

DO $$
DECLARE
  tbl text;
  policy_name text;
  erp_tables text[] := ARRAY[
    'Regiones',
    'Sucursales',
    'Estados',
    'Municipios',
    'Supervisores',
    'Tipificacion_Clientes',
    'Forecast_Vendedores_Excluidos',
    'Vendedores',
    'Clientes'
  ];
BEGIN
  FOREACH tbl IN ARRAY erp_tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', tbl);

      policy_name := format('trade_authenticated_read_%s', lower(tbl));
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, tbl);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT auth.uid()) IS NOT NULL)',
        policy_name,
        tbl
      );
    END IF;
  END LOOP;
END
$$;
