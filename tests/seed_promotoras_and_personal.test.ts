import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient, User as SupabaseAuthUser } from '@supabase/supabase-js';
import {
  loadPromotorasSeedDataset,
  syncPromotorasCatalogAndAuth,
  validateSeedEnv,
} from '../scripts/seed-promotoras';
import { normalizeErpPromotorasDataset } from '../src/utils/erpMasterAdapter';
import {
  extractVerifiedProfileFromAuthUser,
  findActivePromotoraInStaff,
} from '../src/services/authService';
import { normalizeServerSucursal } from '../src/server/supabaseAdminAuth';

const REG_OCC_ID = 'd4b09e5c-76a9-4783-99e7-03b3854bbca8';
const REG_CEN_ID = '618284ba-9dea-4efb-9e6b-e429b8d8960d';
const REG_AND_ID = 'cdb5248d-03a1-4b85-9953-e303b4e35dde';

const MOCK_REGIONES = [
  { id_regi: REG_OCC_ID, regi_desd: 'OCCIDENTE', regi_saba: true },
  { id_regi: REG_CEN_ID, regi_desd: 'CENTRO', regi_saba: false },
  { id_regi: REG_AND_ID, regi_desd: 'ANDES', regi_saba: false },
];

/**
 * Cliente Supabase Admin en memoria (paginado) para probar idempotencia real de
 * `syncPromotorasCatalogAndAuth` sin tocar red ni credenciales reales.
 */
function createInMemorySeedSupabaseMock(initialPromotoras: Array<Record<string, unknown>> = []) {
  let nextAuthSeq = 1;
  let nextDbId = initialPromotoras.length + 1;

  const authUsers: Array<{
    id: string;
    email: string;
    password: string;
    email_confirm: boolean;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
  }> = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'admin.existente@codizulca.com',
      password: 'existing-admin-pass',
      email_confirm: true,
      app_metadata: { role: 'super_admin' },
      user_metadata: {},
    },
  ];

  const promotorasTable: Array<Record<string, unknown>> = initialPromotoras.map((r) => ({ ...r }));

  const client = {
    auth: {
      admin: {
        async listUsers({ page = 1, perPage = 10 }: { page?: number; perPage?: number } = {}) {
          // Forzar múltiples páginas usando lotes pequeños en el test (p. ej. 200 cubre todo, o podemos verificar paginación)
          const start = (page - 1) * perPage;
          const slice = authUsers.slice(start, start + perPage);
          return { data: { users: slice }, error: null };
        },
        async createUser(attrs: {
          email: string;
          password: string;
          email_confirm?: boolean;
          app_metadata?: Record<string, unknown>;
          user_metadata?: Record<string, unknown>;
        }) {
          const emailNorm = attrs.email.trim().toLowerCase();
          if (authUsers.some((u) => u.email.toLowerCase() === emailNorm)) {
            return { data: { user: null }, error: { message: 'User already registered' } };
          }
          const hex = String(nextAuthSeq++).padStart(12, '0');
          const created = {
            id: `11111111-1111-4111-8111-${hex}`,
            email: emailNorm,
            password: attrs.password,
            email_confirm: Boolean(attrs.email_confirm),
            app_metadata: { ...(attrs.app_metadata ?? {}) },
            user_metadata: { ...(attrs.user_metadata ?? {}) },
          };
          authUsers.push(created);
          return { data: { user: created }, error: null };
        },
        async updateUserById(
          id: string,
          attrs: {
            password?: string;
            email_confirm?: boolean;
            app_metadata?: Record<string, unknown>;
            user_metadata?: Record<string, unknown>;
          }
        ) {
          const target = authUsers.find((u) => u.id === id);
          if (!target) {
            return { data: { user: null }, error: { message: 'User not found' } };
          }
          if (attrs.password) target.password = attrs.password;
          if (attrs.email_confirm !== undefined) target.email_confirm = attrs.email_confirm;
          if (attrs.app_metadata) target.app_metadata = { ...attrs.app_metadata };
          if (attrs.user_metadata) target.user_metadata = { ...attrs.user_metadata };
          return { data: { user: target }, error: null };
        },
      },
    },
    from(table: string) {
      if (table === 'Regiones') {
        return {
          async select() {
            return { data: MOCK_REGIONES, error: null };
          },
        };
      }
      if (table === 'promotoras') {
        return {
          async select() {
            return { data: promotorasTable.map((r) => ({ ...r })), error: null };
          },
          update(payload: Record<string, unknown>) {
            return {
              eq(col: string, val: unknown) {
                return {
                  select() {
                    return {
                      async single() {
                        const row = promotorasTable.find((r) => r[col] === val);
                        if (!row) return { data: null, error: { message: 'Row not found' } };
                        Object.assign(row, payload);
                        return { data: { ...row }, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
          insert(payload: Record<string, unknown>) {
            return {
              select() {
                return {
                  async single() {
                    const row = {
                      id: nextDbId++,
                      region: null,
                      auth_user_id: null,
                      region_id: null,
                      ...payload,
                    };
                    promotorasTable.push(row);
                    return { data: { ...row }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Tabla inesperada en mock: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    authUsers,
    promotorasTable,
  };
}

test('Dataset promotoras-seed.json: 33 registros exactos (24 Occidente + 9 Valencia), correos únicos y casos especiales', () => {
  const records = loadPromotorasSeedDataset();
  assert.equal(records.length, 33, 'Debe contener exactamente 33 promotoras oficiales');

  const occidente = records.filter((r) => r.region === 'Occidente');
  const valencia = records.filter((r) => r.region === 'Valencia');
  assert.equal(occidente.length, 24, 'Bloque A debe contener exactamente 24 promotoras en Occidente');
  assert.equal(valencia.length, 9, 'Bloque B debe contener exactamente 9 promotoras en Valencia');

  const uniqueEmails = new Set(records.map((r) => r.correo));
  assert.equal(uniqueEmails.size, 33, 'Los 33 correos deben ser únicos');
  for (const rec of records) {
    assert.equal(rec.correo, rec.correo.trim().toLowerCase(), 'Correos normalizados en minúsculas');
    assert.equal(rec.activo, true, 'Todas las promotoras del dataset deben estar activas');
  }

  const jose = records.find((r) => r.correo === 'joseabraham.barroso@gmail.com');
  assert.ok(jose, 'Jose Barroso debe existir');
  assert.equal(jose.region, 'Occidente');
  assert.equal(jose.direccion, null, 'Jose Barroso debe conservar direccion = null');

  const scarleth = records.find((r) => r.correo === 'scarmichell22@gmail.com');
  assert.equal(scarleth?.nombre_completo, 'Scarleth Piña');

  const scarlett = records.find((r) => r.correo === 'scarlett060219@gmail.com');
  assert.ok(scarlett, 'Scarlett Selena León Román debe existir');
  assert.equal(scarlett.nombre_completo, 'Scarlett Selena León Román');
  assert.equal(scarlett.region, 'Valencia');
  assert.equal(scarlett.created_at, '2026-11-19T15:20:00Z');

  // Maracay y Caracas preservan su dirección real pero pertenecen al perfil "Valencia"
  const maracay = records.find((r) => r.correo === 'maizdajan04@gmail.com');
  assert.equal(maracay?.region, 'Valencia');
  assert.equal(maracay?.direccion, 'Maracay');

  const caracas = records.find((r) => r.correo === 'rinconastrid10@gmail.com');
  assert.equal(caracas?.region, 'Valencia');
  assert.equal(caracas?.direccion, 'Plaza Venezuela, Caracas');
});

test('validateSeedEnv: aborta con mensaje claro si falta alguna variable obligatoria y nunca expone secretos', () => {
  assert.throws(
    () => validateSeedEnv({ SUPABASE_URL: 'https://example.supabase.co' }),
    /SUPABASE_SERVICE_ROLE_KEY.*PROMOTORA_UNIVERSAL_PASSWORD/
  );
  assert.throws(
    () =>
      validateSeedEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
      }),
    /PROMOTORA_UNIVERSAL_PASSWORD/
  );
  const ok = validateSeedEnv({
    SUPABASE_URL: 'https://example.supabase.co/',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
    PROMOTORA_UNIVERSAL_PASSWORD: 'TestOnlyPassword123',
  });
  assert.equal(ok.supabaseUrl, 'https://example.supabase.co');
});

test('Idempotencia total: ejecutar syncPromotorasCatalogAndAuth 2 veces produce exactamente 33 registros únicos (24 Occidente, 9 Valencia) y 0 duplicados', async () => {
  const records = loadPromotorasSeedDataset();

  // Simular las 33 filas ya presentes en BD con nombres en MAYÚSCULAS en Occidente y sin region/auth_user_id
  const preExistingDbRows = records.map((r, idx) => ({
    id: idx + 1,
    nombre_completo: r.region === 'Occidente' ? r.nombre_completo.toUpperCase() : r.nombre_completo,
    direccion: r.direccion,
    telefono: r.telefono,
    correo: r.correo.toUpperCase(), // Probar coincidencia case-insensitive
    activo: true,
    categoria: 'Fijas',
    region: null,
    auth_user_id: null,
    region_id: null,
    created_at: r.created_at ?? '2026-11-18T22:02:14.139192+00:00',
  }));

  const mock = createInMemorySeedSupabaseMock(preExistingDbRows);
  const testPassword = 'TestUniversalPass#2026';

  // Corrida 1: crea los 33 usuarios Auth y actualiza las 33 filas existentes sin duplicar
  const run1 = await syncPromotorasCatalogAndAuth({
    client: mock.client,
    records,
    universalPassword: testPassword,
    delayMs: 0,
  });

  assert.equal(run1.totalProcesados, 33);
  assert.equal(run1.authCreados, 33);
  assert.equal(run1.authActualizados, 0);
  assert.equal(run1.perfilesCreados, 0);
  assert.equal(run1.perfilesActualizados, 33);
  assert.equal(run1.perfilesOccidente, 24);
  assert.equal(run1.perfilesValencia, 9);
  assert.equal(run1.errores.length, 0);

  // Corrida 2: 100% idempotente — 0 creaciones, 33 actualizaciones, 0 duplicados
  const run2 = await syncPromotorasCatalogAndAuth({
    client: mock.client,
    records,
    universalPassword: testPassword,
    delayMs: 0,
  });

  assert.equal(run2.totalProcesados, 33);
  assert.equal(run2.authCreados, 0);
  assert.equal(run2.authActualizados, 33);
  assert.equal(run2.perfilesCreados, 0);
  assert.equal(run2.perfilesActualizados, 33);
  assert.equal(run2.perfilesOccidente, 24);
  assert.equal(run2.perfilesValencia, 9);
  assert.equal(run2.errores.length, 0);

  // Estado final en BD y Auth
  assert.equal(mock.promotorasTable.length, 33, 'Exactamente 33 filas en public.promotoras');
  assert.equal(mock.authUsers.length, 34, '1 admin preexistente + 33 promotoras = 34 usuarios Auth');

  const occRows = mock.promotorasTable.filter((r) => r.region === 'Occidente');
  const valRows = mock.promotorasTable.filter((r) => r.region === 'Valencia');
  assert.equal(occRows.length, 24);
  assert.equal(valRows.length, 9);

  // Verificar metadatos Auth y vínculo auth_user_id para Scarlett y Jose Barroso
  const scarlettDb = mock.promotorasTable.find((r) => r.correo === 'scarlett060219@gmail.com');
  assert.ok(scarlettDb?.auth_user_id);
  assert.equal(scarlettDb?.region, 'Valencia');
  assert.equal(scarlettDb?.region_id, REG_CEN_ID);

  const scarlettAuth = mock.authUsers.find((u) => u.email === 'scarlett060219@gmail.com');
  assert.equal(scarlettAuth?.email_confirm, true);
  assert.equal(scarlettAuth?.app_metadata.role, 'promotora');
  assert.equal(scarlettAuth?.app_metadata.region, 'Valencia');
  assert.equal(scarlettAuth?.app_metadata.sucursal, 'VALENCIA');
  assert.equal(scarlettAuth?.app_metadata.must_change_password, false);
  assert.equal(scarlettAuth?.user_metadata.nombre_completo, 'Scarlett Selena León Román');
  assert.equal(scarlettAuth?.user_metadata.region, 'Valencia');
  assert.equal(scarlettAuth?.user_metadata.rol, 'promotora');

  const joseDb = mock.promotorasTable.find((r) => r.correo === 'joseabraham.barroso@gmail.com');
  assert.equal(joseDb?.region, 'Occidente');
  assert.equal(joseDb?.region_id, REG_OCC_ID);
  assert.equal(joseDb?.direccion, null);
});

test('Adaptador ERP y flujo de login de promotoras: resuelven 24 Occidente + 9 Valencia y rechazan escalamiento por user_metadata', async () => {
  const records = loadPromotorasSeedDataset();
  const normalized = normalizeErpPromotorasDataset(
    records.map((r, i) => ({
      id: i + 1,
      nombre_completo: r.nombre_completo,
      direccion: r.direccion,
      telefono: r.telefono,
      correo: r.correo,
      region: r.region,
      activo: r.activo,
      categoria: r.categoria,
      created_at: r.created_at ?? '2026-11-18T22:02:14Z',
    })),
    MOCK_REGIONES
  );

  assert.equal(normalized.filter((p) => p.region === 'Occidente').length, 24);
  assert.equal(normalized.filter((p) => p.region === 'Valencia').length, 9);

  // Seguridad: incluso si un atacante manipula user_metadata, solo app_metadata gobierna el rol
  const forgedUser = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'scarlett060219@gmail.com',
    app_metadata: {
      role: 'promotora',
      app_role: 'promotora',
      region: 'Valencia',
      sucursal: 'VALENCIA',
      must_change_password: false,
    },
    user_metadata: {
      role: 'super_admin',
      rol: 'super_admin',
      region: 'GLOBAL',
    },
  } as unknown as SupabaseAuthUser;

  const extracted = extractVerifiedProfileFromAuthUser(forgedUser);
  assert.ok(extracted);
  assert.equal(extracted.appRole, 'promotora');
  assert.equal(extracted.iamRole, 'promotora');
  assert.equal(extracted.canAccessTorreControl, false);
  assert.equal(extracted.regionLabel, 'Valencia');
  assert.equal(extracted.sucursal, 'VALENCIA');
  assert.equal(extracted.mustChangePassword, false);

  // Resolución directa desde `public.promotoras` cuando `public.staff` no existe (404)
  const mockPromClient = {
    from(table: string) {
      if (table === 'promotoras') {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return {
                      data: {
                        id: 27,
                        nombre_completo: 'Scarlett Selena León Román',
                        correo: 'scarlett060219@gmail.com',
                        region: 'Valencia',
                        region_id: REG_CEN_ID,
                        activo: true,
                      },
                      error: null,
                    };
                  },
                };
              },
              ilike() {
                return {
                  async limit() {
                    return { data: [], error: null };
                  },
                };
              },
            };
          },
        };
      }
      return {
        select() {
          return {
            ilike() {
              return { async limit() { return { data: null, error: { message: 'relation staff does not exist' } }; } };
            },
            eq() {
              return { async maybeSingle() { return { data: null, error: { message: 'relation staff does not exist' } }; } };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const active = await findActivePromotoraInStaff(
    '22222222-2222-4222-8222-222222222222',
    'scarlett060219@gmail.com',
    mockPromClient
  );
  assert.ok(active);
  assert.equal(active.name, 'Scarlett Selena León Román');
  assert.equal(active.regionLabel, 'Valencia');
  assert.equal(active.sucursal, 'VALENCIA');
  assert.equal(active.regionId, REG_CEN_ID);

  // Normalización backend de regiones
  assert.equal(normalizeServerSucursal('Occidente'), 'ZULIA');
  assert.equal(normalizeServerSucursal('Valencia'), 'VALENCIA');
});

test('Migración SQL 20261128000200: cumple RLS estricto, cero anon, cero user_metadata y cero DDL destructivo', () => {
  const sqlPath = path.resolve(
    process.cwd(),
    'supabase',
    'migrations',
    '20261128000200_promotoras_personal_auth_rls.sql'
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');

  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.promotoras FROM anon/i);
  assert.match(sql, /uq_promotoras_correo_lower/i);
  assert.match(sql, /ALTER COLUMN direccion DROP NOT NULL/i);
  assert.match(sql, /promotoras_select_admin_or_own/i);
  assert.match(sql, /promotoras_update_admin_only/i);
  assert.match(sql, /promotoras_delete_admin_only/i);
  const sqlExecutable = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(sqlExecutable, /\buser_metadata\b/i, 'Jamás usar user_metadata en funciones o políticas RLS');
  assert.doesNotMatch(sqlExecutable, /\bTRUNCATE\b/i, 'Prohibido TRUNCATE en migración');
  assert.doesNotMatch(sqlExecutable, /\bDROP TABLE\b/i, 'Prohibido DROP TABLE en migración');
});
