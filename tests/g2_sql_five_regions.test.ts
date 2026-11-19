import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeMigrations,
  formatIssues,
  type MigrationFile,
} from './support/sqlMigrationAnalyzer';
import {
  CRITICAL_SCHEMA_TABLES,
  evaluateRemoteCatalogReport,
  EXPECTED_ACTIVE_REGIONAL_HUBS,
  EXPECTED_SUCURSAL_ENUM_LABELS,
  REQUIRED_SCHEMA_FUNCTIONS,
  runStaticCertification,
  type RemoteCatalogPayload,
} from '../scripts/certifySchemaProduction';

const ROOT_DIR = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'supabase', 'migrations');
const G2_MIGRATION = '20261119000100_cinco_regiones_motor_correo_rls_y_comparativo.sql';

const ALL_TWENTY_NINE_REGION_ID_TABLES = [
  // Identidad y maestros (8)
  'profiles',
  'clientes',
  'promotoras',
  'vendedores',
  'supervisores',
  'staff',
  'cadenas_comerciales',
  'zonas',
  // Operativas y financieras (21)
  'surveys',
  'cronograma_degustaciones',
  'rutas_promotoras',
  'ejecuciones_pdv_promotora',
  'alertas_geocerca_auditoria',
  'asistencias_jornada',
  'asistencia_evidencias',
  'material_pop_inventario',
  'material_pop_entregas',
  'incidencias_pdv',
  'cliente_portal_accesos',
  'solicitudes_contraloria',
  'contraloria_requisiciones',
  'contraloria_conciliaciones',
  'contraloria_facturas',
  'certificados_paz_y_salvo',
  'campanas_trade',
  'presupuestos_trade',
  'tarifario_costos_trade',
  'entregas_degustacion',
  'reportes_trade',
] as const;

const EXPECTED_COMPARATIVO_COLUMNS: ReadonlyArray<[string, string]> = [
  ['region_id', 'UUID'],
  ['region_codigo', 'TEXT'],
  ['region_nombre', 'TEXT'],
  ['clientes_activos', 'BIGINT'],
  ['promotoras_activas', 'BIGINT'],
  ['vendedores_activos', 'BIGINT'],
  ['rutas_programadas', 'BIGINT'],
  ['rutas_completadas', 'BIGINT'],
  ['cumplimiento_rutas_pct', 'NUMERIC(5,2)'],
  ['degustaciones_programadas', 'BIGINT'],
  ['degustaciones_ejecutadas', 'BIGINT'],
  ['muestras_entregadas', 'BIGINT'],
  ['ventas_asistidas', 'BIGINT'],
  ['presupuesto_asignado_usd', 'NUMERIC(14,2)'],
  ['presupuesto_ejecutado_usd', 'NUMERIC(14,2)'],
  ['ejecucion_presupuestaria_pct', 'NUMERIC(6,2)'],
  ['requisiciones_mp07_total', 'BIGINT'],
  ['requisiciones_conciliadas', 'BIGINT'],
  ['pop_items_activos', 'BIGINT'],
  ['pop_stock_critico_count', 'BIGINT'],
  ['incidencias_totales', 'BIGINT'],
  ['incidencias_abiertas', 'BIGINT'],
  ['incidencias_en_sla_count', 'BIGINT'],
  ['cumplimiento_sla_pct', 'NUMERIC(5,2)'],
];

function loadRealMigrations(): MigrationFile[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

function buildCompliantFiveRegionCatalog(): RemoteCatalogPayload {
  const functions: Record<string, boolean> = {
    vincular_mi_usuario_auth: false,
  };
  for (const fn of REQUIRED_SCHEMA_FUNCTIONS) {
    functions[fn] = true;
  }

  return {
    certified_at: new Date().toISOString(),
    schema: 'public',
    sucursal_codigo_enum: [...EXPECTED_SUCURSAL_ENUM_LABELS],
    regiones_catalog: {
      exists: true,
      has_codigo_column: true,
      has_nombre_column: true,
      has_activo_column: true,
      active_hubs: [...EXPECTED_ACTIVE_REGIONAL_HUBS],
    },
    tables: CRITICAL_SCHEMA_TABLES.map((table_name) => ({
      table_name,
      exists: true,
      rls_enabled: true,
      force_rls: true,
      has_sucursal_column: table_name !== 'regiones',
      has_region_id_column: table_name !== 'regiones',
      sucursal_type: table_name === 'regiones' ? null : 'sucursal_codigo',
      policy_count: table_name === 'regiones' ? 1 : 4,
      anon_policy_count: 0,
      unfiltered_legacy_policies: [],
    })),
    legacy_tables: {
      perfiles_acceso_exists: false,
      perfiles_acceso_deprecado_exists: true,
    },
    functions,
    indexes: {
      uq_surveys_degustacion_key_active: true,
      idx_surveys_autor_user_id: true,
      idx_clientes_vendedor_id: true,
      idx_clientes_codigo_vendedor: true,
      idx_clientes_region_id: true,
      idx_profiles_region_id: true,
    },
    surveys_columns: {
      autor_user_id: true,
      sucursal: true,
      region_id: true,
      degustacion_key: true,
    },
    anon_table_grants: [],
  };
}

test('COMPUERTA G2 — SQL 5 Regiones Oficiales, Motor Canónico Correo->Región, RLS Multi-Hub y Comparativo Ejecutivo', async (t) => {
  const migrations = loadRealMigrations();
  const g2Sql = fs.readFileSync(path.join(MIGRATIONS_DIR, G2_MIGRATION), 'utf8');
  const analysis = analyzeMigrations(migrations);

  await t.test('1) Regla PostgreSQL 15+/17 (anti SQLSTATE 55P04) y cero DDL destructivo en toda la cadena', () => {
    assert.equal(
      analysis.errors.length,
      0,
      `El analizador estático reportó errores:\n${formatIssues(analysis.errors)}`
    );

    const beginIdx = g2Sql.search(/^\s*BEGIN\s*;/m);
    assert.ok(beginIdx > 0, 'La migración G2 debe declarar BEGIN; explícito tras expandir el ENUM');

    const beforeBegin = g2Sql.slice(0, beginIdx);
    for (const hub of ['CENTRO', 'ORIENTE', 'CAPITAL']) {
      assert.match(
        beforeBegin,
        new RegExp(
          `ALTER\\s+TYPE\\s+public\\.sucursal_codigo\\s+ADD\\s+VALUE\\s+IF\\s+NOT\\s+EXISTS\\s+'${hub}'\\s*;`,
          'i'
        ),
        `ALTER TYPE ... ADD VALUE '${hub}' debe ejecutarse ANTES de BEGIN;`
      );
    }

    const enumLabels = analysis.enumValues.get('sucursal_codigo');
    assert.ok(enumLabels, 'El analizador debe rastrear etiquetas de public.sucursal_codigo');
    for (const expected of EXPECTED_SUCURSAL_ENUM_LABELS) {
      assert.equal(
        enumLabels.has(expected),
        true,
        `public.sucursal_codigo debe contener la etiqueta ${expected}`
      );
    }

    // Regresión sintética: ALTER TYPE ... ADD VALUE dentro de BEGIN..COMMIT debe fallar el análisis
    const badTxEnum = analyzeMigrations([
      {
        name: '20260101000000_enum.sql',
        sql: `CREATE TYPE public.sucursal_codigo AS ENUM ('ZULIA', 'VALENCIA', 'GLOBAL');`,
      },
      {
        name: '20260102000000_bad_tx.sql',
        sql: `BEGIN;\nALTER TYPE public.sucursal_codigo ADD VALUE IF NOT EXISTS 'CENTRO';\nCOMMIT;`,
      },
    ]);
    assert.ok(
      badTxEnum.errors.some((e) => e.code === 'UNSAFE_ENUM_ADD_IN_TX'),
      'El analizador debe detectar ALTER TYPE ... ADD VALUE dentro de BEGIN..COMMIT'
    );

    // Prohibición absoluta de DDL/DML destructivo e identidades inseguras
    assert.doesNotMatch(g2Sql, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(g2Sql, /\bDROP\s+COLUMN\b/i);
    assert.doesNotMatch(g2Sql, /\bTRUNCATE\b/i);
    assert.doesNotMatch(g2Sql, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(g2Sql, /\buser_metadata\b/i);
    assert.doesNotMatch(g2Sql, /\braw_user_meta_data\b/i);
    assert.doesNotMatch(g2Sql, /\bauth\.role\s*\(/i);
  });

  await t.test('2) Reutilización aditiva de regiones/supervisores/productos, 5 hubs canónicos y region_id + índices en 29 tablas', () => {
    for (const existingCatalog of ['regiones', 'supervisores', 'productos']) {
      assert.doesNotMatch(
        g2Sql,
        new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?public\\.${existingCatalog}\\b`, 'i'),
        `G2 no debe recrear public.${existingCatalog}`
      );
      assert.match(
        g2Sql,
        new RegExp(`ALTER\\s+TABLE\\s+public\\.${existingCatalog}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i')
      );
      assert.match(
        g2Sql,
        new RegExp(`ALTER\\s+TABLE\\s+public\\.${existingCatalog}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i')
      );
      assert.match(
        g2Sql,
        new RegExp(`REVOKE\\s+ALL\\s+ON\\s+TABLE\\s+public\\.${existingCatalog}\\s+FROM\\s+PUBLIC,\\s*anon`, 'i')
      );
      assert.match(
        g2Sql,
        new RegExp(`GRANT\\s+SELECT\\s+ON\\s+TABLE\\s+public\\.${existingCatalog}\\s+TO\\s+authenticated`, 'i')
      );
    }

    assert.match(
      g2Sql,
      /CREATE POLICY regiones_select_authenticated\s+ON public\.regiones\s+FOR SELECT\s+TO authenticated\s+USING \(\(SELECT auth\.uid\(\)\) IS NOT NULL\)/i
    );
    assert.match(
      g2Sql,
      /CREATE POLICY productos_select_authenticated\s+ON public\.productos\s+FOR SELECT\s+TO authenticated\s+USING \(\(SELECT auth\.uid\(\)\) IS NOT NULL\)/i
    );
    assert.match(
      g2Sql,
      /CREATE POLICY supervisores_select_sede[\s\S]*?public\.tiene_acceso_region\(region_id,\s*sucursal\)/i
    );

    for (const [code, name] of [
      ['ZULIA', 'Zulia'],
      ['VALENCIA', 'Valencia'],
      ['CENTRO', 'Centro'],
      ['ORIENTE', 'Oriente'],
      ['CAPITAL', 'Capital'],
    ] as const) {
      assert.match(g2Sql, new RegExp(`'${code}',\\s*'${name}'`));
    }

    const regCols = analysis.tables.get('regiones');
    assert.ok(regCols, 'public.regiones debe existir');
    for (const col of ['id', 'codigo', 'nombre', 'activo', 'updated_at']) {
      assert.equal(regCols.has(col), true, `public.regiones debe poseer la columna ${col}`);
    }

    for (const tbl of ALL_TWENTY_NINE_REGION_ID_TABLES) {
      const cols = analysis.tables.get(tbl);
      assert.ok(cols, `La tabla public.${tbl} debe existir en el esquema resultante`);
      assert.equal(
        cols.has('region_id'),
        true,
        `La tabla public.${tbl} debe poseer region_id UUID REFERENCES public.regiones(id)`
      );
      assert.match(
        g2Sql,
        new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+idx_${tbl}_region_id\\s+ON\\s+public\\.${tbl}\\s*\\(\\s*region_id\\s*\\)`, 'i'),
        `Falta índice B-Tree idx_${tbl}_region_id en public.${tbl}`
      );
    }
  });

  await t.test('3) Expansión de CHECK constraints a 5 hubs, semilla de tarifario y políticas Storage multi-hub', () => {
    assert.match(
      g2Sql,
      /ADD CONSTRAINT chk_profiles_sucursal_por_rol[\s\S]*?'CENTRO'::public\.sucursal_codigo[\s\S]*?'ORIENTE'::public\.sucursal_codigo[\s\S]*?'CAPITAL'::public\.sucursal_codigo/i
    );
    assert.match(
      g2Sql,
      /ADD CONSTRAINT chk_contraloria_facturas_storage_path[\s\S]*?\^facturas\/\(ZULIA\|VALENCIA\|CENTRO\|ORIENTE\|CAPITAL\)\//i
    );
    assert.match(
      g2Sql,
      /ALTER TABLE public\.certificados_paz_y_salvo[\s\S]*?ADD CONSTRAINT chk_certificados_paz_y_salvo_sucursal_regional[\s\S]*?'ZULIA'::public\.sucursal_codigo[\s\S]*?'VALENCIA'::public\.sucursal_codigo[\s\S]*?'CENTRO'::public\.sucursal_codigo[\s\S]*?'ORIENTE'::public\.sucursal_codigo[\s\S]*?'CAPITAL'::public\.sucursal_codigo/i
    );
    assert.match(
      g2Sql,
      /CREATE TRIGGER trg_sellar_sucursal_certificados_paz_y_salvo[\s\S]*?ON public\.certificados_paz_y_salvo[\s\S]*?EXECUTE FUNCTION public\.fn_sellar_y_proteger_sucursal_operativa\(\)/i
    );
    assert.match(
      g2Sql,
      /INSERT INTO public\.tarifario_costos_trade[\s\S]*?'CENTRO'::public\.sucursal_codigo[\s\S]*?'ORIENTE'::public\.sucursal_codigo[\s\S]*?'CAPITAL'::public\.sucursal_codigo[\s\S]*?ON CONFLICT \(line_id,\s*sucursal,\s*vigente_desde\) DO NOTHING/i
    );

    for (const bucket of ['asistencia-evidencias', 'incidencias-evidencias', 'contraloria-facturas']) {
      assert.match(g2Sql, new RegExp(`bucket_id\\s*=\\s*'${bucket}'`));
    }
  });

  await t.test('4) Motor canónico Correo -> Región, x-sucursal-activa solo GLOBAL y candado REGION_CONTEXT_REQUIRED', () => {
    assert.match(
      g2Sql,
      /CREATE OR REPLACE FUNCTION public\.obtener_mi_correo_jwt\(\)[\s\S]*?NULLIF\(lower\(btrim\(COALESCE\(\(SELECT auth\.jwt\(\)\) ->> 'email',\s*''\)\)\),\s*''\)/i
    );

    // Cobertura geográfica de los 5 hubs en fn_inferir_sucursal_codigo
    const fnInferStart = g2Sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_inferir_sucursal_codigo');
    const fnInferEnd = g2Sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_normalizar_sucursal_codigo');
    assert.ok(fnInferStart > 0 && fnInferEnd > fnInferStart);
    const fnInferBody = g2Sql.slice(fnInferStart, fnInferEnd);

    for (const cityOrState of [
      'maracaibo',
      'ciudad ojeda',
      'col',
      'valencia',
      'carabobo',
      'puerto cabello',
      'aragua',
      'maracay',
      'lara',
      'barquisimeto',
      'yaracuy',
      'portuguesa',
      'acarigua',
      'cojedes',
      'guarico',
      'anzoategui',
      'barcelona',
      'puerto la cruz',
      'lecheria',
      'monagas',
      'maturin',
      'cumana',
      'nueva esparta',
      'margarita',
      'porlamar',
      'puerto ordaz',
      'ciudad guayana',
      'caracas',
      'distrito capital',
      'chacao',
      'baruta',
      'el hatillo',
      'los teques',
      'guarenas',
      'guatire',
      'valles del tuy',
      'la guaira',
      'vargas',
    ]) {
      assert.match(
        fnInferBody,
        new RegExp(`\\b${cityOrState}\\b`, 'i'),
        `fn_inferir_sucursal_codigo debe clasificar "${cityOrState}"`
      );
    }

    assert.match(g2Sql, /current_setting\('request\.headers',\s*true\)/i);
    assert.match(g2Sql, /'x-sucursal-activa'/i);
    assert.match(g2Sql, /REGION_CONTEXT_REQUIRED/i);
    assert.match(g2Sql, /ERRCODE\s*=\s*'42501'/i);
  });

  await t.test('5) RPCs regionales y firma exacta de rpc_comparativo_regiones_resumen (24 columnas + SECURITY DEFINER)', () => {
    for (const fn of [
      'public.obtener_mi_correo_jwt',
      'public.fn_resolver_region_id',
      'public.obtener_mi_region_id',
      'public.obtener_sucursal_contexto_activo',
      'public.tiene_acceso_region',
      'public.rpc_listar_regiones_activas',
      'public.rpc_listar_personal_sucursal',
      'public.rpc_comparativo_regiones_resumen',
    ]) {
      assert.equal(analysis.functions.has(fn), true, `Debe existir la función ${fn}()`);
    }

    const compStart = g2Sql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_comparativo_regiones_resumen(');
    const compEnd = g2Sql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_certificar_esquema_trade()');
    assert.ok(compStart > 0 && compEnd > compStart);
    const compSection = g2Sql.slice(compStart, compEnd);

    assert.match(
      compSection,
      /p_periodo_inicio\s+DATE\s+DEFAULT\s+NULL,\s*p_periodo_fin\s+DATE\s+DEFAULT\s+NULL/i
    );
    assert.match(compSection, /\bSTABLE\b/i);
    assert.match(compSection, /\bSECURITY\s+DEFINER\b/i);
    assert.match(compSection, /SET\s+search_path\s*=\s*public\b/i);
    assert.match(compSection, /public\.is_contraloria_or_admin\(\)/i);
    assert.match(
      compSection,
      /REVOKE ALL ON FUNCTION public\.rpc_comparativo_regiones_resumen\(DATE,\s*DATE\) FROM PUBLIC,\s*anon/i
    );
    assert.match(
      compSection,
      /GRANT EXECUTE ON FUNCTION public\.rpc_comparativo_regiones_resumen\(DATE,\s*DATE\) TO authenticated,\s*service_role/i
    );

    for (const [colName, colType] of EXPECTED_COMPARATIVO_COLUMNS) {
      const escapedType = colType.replace(/[()]/g, '\\$&');
      assert.match(
        compSection,
        new RegExp(`\\b${colName}\\s+${escapedType}(?:\\s*,|\\s*\\))`, 'i'),
        `rpc_comparativo_regiones_resumen debe retornar columna "${colName} ${colType}"`
      );
    }
  });

  await t.test('6) Certificador estático y remoto validan las 6 etiquetas ENUM, catálogo regiones y nuevas RPCs', () => {
    const staticReport = runStaticCertification(MIGRATIONS_DIR);
    assert.equal(staticReport.passed, true);
    assert.ok(staticReport.migrationCount >= 24);

    const remoteOk = evaluateRemoteCatalogReport(
      buildCompliantFiveRegionCatalog(),
      'apaxdgxtaoeyswlfblgi.supabase.co'
    );
    assert.equal(remoteOk.passed, true);

    // Si falta ORIENTE en el ENUM remoto -> FAIL en remote.sucursal_enum
    const missingEnum = buildCompliantFiveRegionCatalog();
    missingEnum.sucursal_codigo_enum = ['ZULIA', 'VALENCIA', 'CENTRO', 'CAPITAL', 'GLOBAL'];
    const failEnum = evaluateRemoteCatalogReport(missingEnum, 'apaxdgxtaoeyswlfblgi.supabase.co');
    assert.equal(failEnum.passed, false);
    assert.equal(
      failEnum.checks.find((c) => c.id === 'remote.sucursal_enum')?.passed,
      false
    );

    // Si falta CAPITAL activo en public.regiones -> FAIL en remote.regiones_five_hubs
    const missingHub = buildCompliantFiveRegionCatalog();
    missingHub.regiones_catalog!.active_hubs = ['ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE'];
    const failHub = evaluateRemoteCatalogReport(missingHub, 'apaxdgxtaoeyswlfblgi.supabase.co');
    assert.equal(failHub.passed, false);
    assert.equal(
      failHub.checks.find((c) => c.id === 'remote.regiones_five_hubs')?.passed,
      false
    );

    // Si falta rpc_comparativo_regiones_resumen -> FAIL en remote.required_functions
    const missingRpc = buildCompliantFiveRegionCatalog();
    missingRpc.functions!.rpc_comparativo_regiones_resumen = false;
    const failRpc = evaluateRemoteCatalogReport(missingRpc, 'apaxdgxtaoeyswlfblgi.supabase.co');
    assert.equal(failRpc.passed, false);
    assert.equal(
      failRpc.checks.find((c) => c.id === 'remote.required_functions')?.passed,
      false
    );
  });
});
