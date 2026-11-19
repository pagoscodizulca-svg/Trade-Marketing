import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeMigrations,
  checkMigrationNaming,
  formatIssues,
  type MigrationFile,
} from './support/sqlMigrationAnalyzer';

const ROOT_DIR = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'supabase', 'migrations');

function loadRealMigrations(): MigrationFile[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

/** Extrae el texto de una política (`CREATE POLICY <nombre> ... ;`) dentro de un archivo SQL. */
function extractPolicy(sql: string, policyName: string): string {
  const start = sql.indexOf(`CREATE POLICY ${policyName}`);
  assert.ok(start >= 0, `No se encontró CREATE POLICY ${policyName}`);
  const end = sql.indexOf(';', start);
  return sql.slice(start, end + 1);
}

test('HITO 0 — Orden e integridad de migraciones desde cero (analizador estático)', async (t) => {
  const real = loadRealMigrations();
  const names = real.map((f) => f.name).sort();

  await t.test('Las migraciones reales no tienen errores de orden ni de integridad', () => {
    const result = analyzeMigrations(real);
    assert.equal(result.errors.length, 0, `Errores detectados:\n${formatIssues(result.errors)}`);
  });

  await t.test('N-01: la migración de blindaje usa marca de tiempo y corre después de schema_maestros y del lockdown', () => {
    assert.ok(!names.some((n) => /^\d{1,3}_/.test(n)), 'No deben existir prefijos legados de 1-3 dígitos');
    assert.ok(!names.includes('001_blindaje_trade_sucursales.sql'), 'El nombre 001_ ya no debe existir');

    const blindaje = names.indexOf('20261118000200_blindaje_trade_sucursales.sql');
    const maestros = names.indexOf('20261001000100_schema_maestros.sql');
    const lockdown = names.indexOf('20261118000100_fase1_lockdown_rls_rbac_and_fixes.sql');
    const hito0 = names.indexOf('20261118000300_hito0_surveys_privacidad_y_lectura_contraloria.sql');

    assert.ok(blindaje > maestros, 'blindaje debe ejecutarse después de schema_maestros');
    assert.ok(blindaje > lockdown, 'blindaje debe ejecutarse después del lockdown');
    assert.ok(hito0 > blindaje, 'la migración del Hito 0 debe ejecutarse después de blindaje');
  });

  await t.test('N-01: blindaje no recrea public.clientes y solo la amplía con ALTER ... IF NOT EXISTS', () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '20261118000200_blindaje_trade_sucursales.sql'),
      'utf8'
    );
    assert.doesNotMatch(sql, /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?public\.clientes\b/i);
    assert.match(sql, /ALTER TABLE public\.clientes\s+ADD COLUMN IF NOT EXISTS sucursal/i);
    assert.match(sql, /Precondición incumplida: public\.clientes no existe/);
    // `promotoras` no la crea schema_maestros: conserva su creación idempotente
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.promotoras/i);
  });

  await t.test('N-01: el esquema final conserva vendedor_id, codigo_vendedor, sucursal y sus índices', () => {
    const result = analyzeMigrations(real);
    const clientes = result.tables.get('clientes');
    assert.ok(clientes, 'public.clientes debe existir tras la cadena completa');
    for (const col of ['vendedor_id', 'codigo_vendedor', 'zona', 'ruta', 'latitud', 'longitud', 'sucursal', 'activo']) {
      assert.ok(clientes.has(col), `public.clientes debe tener la columna ${col}`);
    }
    const maestros = fs.readFileSync(path.join(MIGRATIONS_DIR, '20261001000100_schema_maestros.sql'), 'utf8');
    assert.match(maestros, /idx_clientes_vendedor_id/);
    assert.match(maestros, /idx_clientes_codigo_vendedor/);
  });

  await t.test('Cero versiones duplicadas en supabase/migrations (reconciliadas a 14 dígitos en Compuerta G1)', () => {
    const duplicates = checkMigrationNaming(names).filter((i) => i.code === 'DUPLICATE_VERSION');
    const found = duplicates
      .map((d) => d.message.match(/Versión (\d+)/)![1]!)
      .sort();
    assert.deepEqual(
      found,
      [],
      'No deben existir versiones de migración duplicadas; cualquier colisión rompe la CLI de Supabase'
    );
  });

  await t.test('Ninguna migración usa DROP TABLE ni TRUNCATE', () => {
    const result = analyzeMigrations(real);
    assert.equal(result.issues.filter((i) => /^DESTRUCTIVE_/.test(i.code)).length, 0);
  });

  await t.test('Las funciones que usa el Hito 0 existen ANTES de su migración', () => {
    const previous = real.filter(
      (f) => f.name !== '20261118000300_hito0_surveys_privacidad_y_lectura_contraloria.sql'
    );
    const result = analyzeMigrations(previous);
    for (const fn of [
      'public.is_torre_control_viewer',
      'public.fn_is_survey_solicitada',
      'public.is_super_admin',
      'public.is_coordinadora_or_admin',
      'public.current_active_profile_role',
    ]) {
      assert.ok(result.functions.has(fn), `${fn}() debe estar definida antes del Hito 0`);
    }
  });

  await t.test('N-06: el vendedor solo lee y edita lo que él creó; la torre conserva la visibilidad', () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '20261118000300_hito0_surveys_privacidad_y_lectura_contraloria.sql'),
      'utf8'
    );

    const select = extractPolicy(sql, 'surveys_select_authenticated_roles');
    assert.match(select, /public\.is_torre_control_viewer\(\)/);
    assert.match(select, /autor_user_id\s*=\s*\(SELECT auth\.uid\(\)\)/);
    assert.match(select, /current_active_profile_role\(\)\)\s*=\s*'vendedor'/);
    // Regresión: la rama del vendedor ya no puede ser "todas las degustaciones"
    const vendedorBranch = select.slice(select.indexOf('OR ('));
    assert.match(vendedorBranch, /autor_user_id/);

    const update = extractPolicy(sql, 'surveys_update_authenticated_trade_or_fdv');
    assert.equal((update.match(/autor_user_id\s*=\s*\(SELECT auth\.uid\(\)\)/g) ?? []).length, 2, 'USING y WITH CHECK');

    assert.match(sql, /ADD COLUMN IF NOT EXISTS autor_user_id UUID REFERENCES auth\.users\(id\)/i);
    assert.match(sql, /CREATE TRIGGER trg_surveys_sellar_autor\s+BEFORE INSERT ON public\.surveys/i);
    assert.match(sql, /CREATE TRIGGER trg_surveys_proteger_autor\s+BEFORE UPDATE ON public\.surveys/i);
    assert.match(sql, /NEW\.autor_user_id := v_uid/);
  });

  await t.test('N-08: contraloría obtiene solo lectura (SELECT) sobre asistencias, evidencias y bucket', () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '20261118000300_hito0_surveys_privacidad_y_lectura_contraloria.sql'),
      'utf8'
    );
    for (const policy of [
      'asistencias_jornada_select_torre_viewer',
      'asistencia_evidencias_select_torre_viewer',
      'storage_asistencia_evidencias_select_torre_viewer',
    ]) {
      const text = extractPolicy(sql, policy);
      assert.match(text, /FOR SELECT/);
      assert.match(text, /is_torre_control_viewer\(\)/);
    }
    // Ninguna política de escritura para el visor en las tablas de asistencia
    assert.doesNotMatch(
      sql,
      /CREATE POLICY \w*torre_viewer\w*\s+ON [\w.]+\s+FOR (INSERT|UPDATE|DELETE|ALL)/i
    );
  });

  await t.test('REGRESIÓN SINTÉTICA: el analizador detecta el defecto N-01 (stub creado antes que schema_maestros)', () => {
    const stub: MigrationFile = {
      name: '20261001000050_stub_clientes.sql',
      sql: `CREATE TABLE IF NOT EXISTS public.clientes (id uuid PRIMARY KEY, codigo_cliente text);`,
    };
    const maestros: MigrationFile = {
      name: '20261001000100_schema_maestros.sql',
      sql: `
        CREATE TABLE IF NOT EXISTS public.vendedores (id uuid PRIMARY KEY, codigo_vendedor text);
        CREATE TABLE IF NOT EXISTS public.clientes (
          id uuid PRIMARY KEY,
          codigo_cliente text,
          vendedor_id uuid REFERENCES public.vendedores(id),
          codigo_vendedor text
        );
        CREATE INDEX IF NOT EXISTS idx_clientes_vendedor_id ON public.clientes(vendedor_id);
        CREATE INDEX IF NOT EXISTS idx_clientes_codigo_vendedor ON public.clientes(codigo_vendedor);`,
    };

    const broken = analyzeMigrations([stub, maestros]);
    const missing = broken.errors.filter((e) => e.code === 'COLUMN_NOT_FOUND').map((e) => e.message);
    assert.equal(missing.length, 2, formatIssues(broken.issues));
    assert.ok(missing.some((m) => m.includes('vendedor_id')));
    assert.ok(missing.some((m) => m.includes('codigo_vendedor')));

    // Con el orden correcto (maestros primero, stub sólo con ALTER) no hay errores
    const fixedStub: MigrationFile = {
      name: '20261118000200_blindaje.sql',
      sql: `ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS sucursal text;`,
    };
    const fixed = analyzeMigrations([maestros, fixedStub]);
    assert.equal(fixed.errors.length, 0, formatIssues(fixed.errors));
  });

  await t.test('REGRESIÓN REAL: el estado anterior (commit 0b926ad) habría fallado el análisis', (subtest) => {
    let oldSql = '';
    try {
      oldSql = execFileSync(
        'git',
        ['show', '0b926ad:supabase/migrations/001_blindaje_trade_sucursales.sql'],
        { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch {
      subtest.skip('Historial de git no disponible para reconstruir el estado previo');
      return;
    }
    const withOld = real
      .filter((f) => !f.name.includes('blindaje_trade_sucursales'))
      .concat({ name: '001_blindaje_trade_sucursales.sql', sql: oldSql });
    const result = analyzeMigrations(withOld);
    const codes = new Set(result.errors.map((e) => e.code));
    assert.ok(codes.has('LEGACY_PREFIX'));
    assert.ok(codes.has('COLUMN_NOT_FOUND'), 'Debe detectar los índices sobre vendedor_id/codigo_vendedor');
  });

  await t.test('El analizador detecta otras clases de defecto de orden', () => {
    const casos: Array<{ nombre: string; archivos: MigrationFile[]; codigo: string }> = [
      {
        nombre: 'índice sobre tabla inexistente',
        archivos: [{ name: '20260101000000_a.sql', sql: 'CREATE INDEX i ON public.fantasma (id);' }],
        codigo: 'TABLE_NOT_FOUND',
      },
      {
        nombre: 'FK hacia tabla aún no creada',
        archivos: [
          {
            name: '20260101000000_a.sql',
            sql: 'CREATE TABLE public.hija (id uuid, padre_id uuid REFERENCES public.padre(id));',
          },
        ],
        codigo: 'FK_TARGET_NOT_FOUND',
      },
      {
        nombre: 'política que usa una función definida después',
        archivos: [
          {
            name: '20260101000000_a.sql',
            sql: `CREATE TABLE public.t (id uuid);
                  CREATE POLICY p ON public.t FOR SELECT TO authenticated USING ((SELECT public.es_admin()));`,
          },
          {
            name: '20260102000000_b.sql',
            sql: `CREATE FUNCTION public.es_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`,
          },
        ],
        codigo: 'FUNCTION_NOT_FOUND',
      },
      {
        nombre: 'DROP TABLE destructivo',
        archivos: [{ name: '20260101000000_a.sql', sql: 'DROP TABLE public.clientes;' }],
        codigo: 'DESTRUCTIVE_DROP_TABLE',
      },
      {
        nombre: 'TRUNCATE destructivo',
        archivos: [{ name: '20260101000000_a.sql', sql: 'TRUNCATE public.clientes;' }],
        codigo: 'DESTRUCTIVE_TRUNCATE',
      },
      {
        nombre: 'ADD COLUMN duplicada sin IF NOT EXISTS',
        archivos: [
          {
            name: '20260101000000_a.sql',
            sql: 'CREATE TABLE public.t (id uuid, x text); ALTER TABLE public.t ADD COLUMN x text;',
          },
        ],
        codigo: 'DUPLICATE_COLUMN',
      },
      {
        nombre: 'prefijo legado',
        archivos: [{ name: '001_x.sql', sql: 'SELECT 1;' }],
        codigo: 'LEGACY_PREFIX',
      },
    ];

    for (const caso of casos) {
      const res = analyzeMigrations(caso.archivos);
      assert.ok(
        res.errors.some((e) => e.code === caso.codigo),
        `No se detectó "${caso.nombre}" (${caso.codigo}). Hallado: ${formatIssues(res.issues) || 'nada'}`
      );
    }
  });

  await t.test('Los bloques DO con guardas no generan falsos positivos', () => {
    const res = analyzeMigrations([
      {
        name: '20260101000000_a.sql',
        sql: `DO $$ BEGIN
                IF to_regclass('public.no_existe') IS NOT NULL THEN
                  ALTER TABLE public.no_existe ADD COLUMN x text;
                  CREATE INDEX i ON public.no_existe (x);
                END IF;
              END $$;`,
      },
    ]);
    assert.equal(res.errors.length, 0, formatIssues(res.errors));
  });
});
