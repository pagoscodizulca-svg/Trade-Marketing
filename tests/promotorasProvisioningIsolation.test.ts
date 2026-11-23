import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildDeterministicPromotoraLoginEmail,
  parseProvisionCliArgs,
  planPromotoraIdentities1To1,
  provisionPromotoras1To1,
  validateProvisionEnv,
  type RawPromotoraDbRow,
} from '../scripts/provision-promotoras-auth';
import { createPromotoraLoginHandler } from '../src/server/promotoraLoginHandler';

function createFakeAdminClient(initialPromotoras: RawPromotoraDbRow[]) {
  const promotoras = initialPromotoras.map((r) => ({ ...r }));
  const authUsers: Array<{
    id: string;
    email: string;
    password: string;
    email_confirm: boolean;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
  }> = [];
  const profiles = new Map<string, Record<string, unknown>>();
  let authSeq = 0;

  const client = {
    auth: {
      admin: {
        async listUsers({ page }: { page: number; perPage: number }) {
          return { data: { users: page === 1 ? [...authUsers] : [] }, error: null };
        },
        async createUser(payload: {
          email: string;
          password: string;
          email_confirm: boolean;
          app_metadata: Record<string, unknown>;
          user_metadata: Record<string, unknown>;
        }) {
          authSeq += 1;
          const id = `00000000-0000-4000-8000-${String(authSeq).padStart(12, '0')}`;
          const created = { id, ...payload };
          authUsers.push(created);
          return { data: { user: created }, error: null };
        },
        async updateUserById(
          id: string,
          payload: {
            email?: string;
            password?: string;
            email_confirm?: boolean;
            app_metadata?: Record<string, unknown>;
            user_metadata?: Record<string, unknown>;
          }
        ) {
          const hit = authUsers.find((u) => u.id === id);
          if (!hit) return { data: { user: null }, error: { message: 'User not found' } };
          if (payload.email) hit.email = payload.email;
          if (payload.password) hit.password = payload.password;
          if (payload.app_metadata) hit.app_metadata = payload.app_metadata;
          if (payload.user_metadata) hit.user_metadata = payload.user_metadata;
          return { data: { user: hit }, error: null };
        },
      },
    },
    from(table: string) {
      if (table === 'Regiones') {
        return {
          select() {
            return Promise.resolve({
              data: [
                { id_regi: 'd4b09e5c-76a9-4783-99e7-03b3854bbca8', regi_desd: 'OCCIDENTE' },
                { id_regi: '618284ba-9dea-4efb-9e6b-e429b8d8960d', regi_desd: 'CENTRO' },
                { id_regi: 'cdb5248d-03a1-4b85-9953-e303b4e35dde', regi_desd: 'ANDES' },
              ],
              error: null,
            });
          },
        };
      }
      if (table === 'profiles') {
        return {
          upsert(row: Record<string, unknown>) {
            profiles.set(String(row.id), { ...row });
            return Promise.resolve({ data: row, error: null });
          },
        };
      }
      if (table === 'promotoras') {
        return {
          select() {
            return {
              order() {
                return {
                  range(from: number, to: number) {
                    return Promise.resolve({
                      data: promotoras.slice(from, to + 1).map((r) => ({ ...r })),
                      error: null,
                    });
                  },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            return {
              eq(col: string, val: unknown) {
                assert.equal(col, 'id', 'UPDATE sobre public.promotoras DEBE filtrar estrictamente por PK id');
                const hit = promotoras.find((r) => String(r.id) === String(val));
                if (!hit) return Promise.resolve({ error: { message: 'Row not found' } });
                Object.assign(hit, patch);
                return Promise.resolve({ error: null });
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
    promotoras,
    authUsers,
    profiles,
  };
}

test('Seguridad de entorno: aborta sin INITIAL_PROMOTORA_PASSWORD y jamás expone secretos', () => {
  assert.throws(
    () =>
      validateProvisionEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
      }),
    /INITIAL_PROMOTORA_PASSWORD/i
  );

  assert.throws(
    () =>
      validateProvisionEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
        INITIAL_PROMOTORA_PASSWORD: 'short',
      }),
    /al menos 8 caracteres/i
  );

  // Modo por defecto DEBE ser dry-run y must_change_password = true
  const defaultCli = parseProvisionCliArgs([], {});
  assert.equal(defaultCli.mode, 'dry-run');
  assert.equal(defaultCli.mustChangePassword, true);

  const applyCli = parseProvisionCliArgs(['--apply', '--must-change-password=false'], {});
  assert.equal(applyCli.mode, 'apply');
  assert.equal(applyCli.mustChangePassword, false);
});

test('Prohibición de fusión regional: homónimos interregionales, emails nulos y emails duplicados conservan 1:1 estricto', () => {
  const rows: RawPromotoraDbRow[] = [
    {
      id: 101,
      nombre_completo: 'María Pérez',
      correo: 'maria.occ@example.com',
      region: 'Occidente',
      activo: true,
    },
    {
      id: 202,
      nombre_completo: 'MARÍA PÉREZ', // Homónimo exacto en otra región
      correo: null, // Sin correo -> login determinístico único por (id, region)
      region: 'Valencia',
      activo: true,
    },
    {
      id: 303,
      nombre_completo: 'Ana López',
      correo: 'repetido@example.com',
      region: 'Occidente',
      activo: true,
    },
    {
      id: 404,
      nombre_completo: 'Ana López',
      correo: 'repetido@example.com', // Colisión de correo entre regiones -> CERO fusión
      region: 'Andes',
      activo: true,
    },
  ];

  const planned = planPromotoraIdentities1To1(rows);

  assert.equal(planned.plans.length, 4, 'Debe preservar las 4 filas 1 a 1 sin agrupar por nombre');
  assert.equal(
    new Set(planned.plans.map((p) => p.loginEmail)).size,
    4,
    'Cada perfil debe recibir un identificador de login único'
  );
  assert.equal(planned.interregionalHomonyms.length, 2, 'Debe reportar ambos pares de homónimos interregionales');

  const p202 = planned.plans.find((p) => p.promotoraId === '202')!;
  assert.equal(p202.regionLabel, 'Valencia');
  assert.equal(p202.loginEmail, buildDeterministicPromotoraLoginEmail(202, 'Valencia'));
  assert.equal(p202.loginEmailSource, 'deterministic_fallback');
  assert.equal(p202.shouldPersistCorreoToDb, true);

  const p303 = planned.plans.find((p) => p.promotoraId === '303')!;
  const p404 = planned.plans.find((p) => p.promotoraId === '404')!;
  assert.equal(p303.regionLabel, 'Occidente');
  assert.equal(p404.regionLabel, 'Andes');
  assert.notEqual(p303.loginEmail, p404.loginEmail);
  assert.equal(p303.fallbackReason, 'duplicate_email_collision');
  assert.equal(p404.fallbackReason, 'duplicate_email_collision');
});

test('Idempotencia total y compuerta --dry-run -> --apply (0 duplicados y conteo regional invariable)', async () => {
  const sampleRows: RawPromotoraDbRow[] = [
    {
      id: 1,
      nombre_completo: 'Nicole Godoy',
      correo: 'nicole.qa@example.com',
      region: 'Occidente',
      region_id: 'd4b09e5c-76a9-4783-99e7-03b3854bbca8',
      categoria: 'Eventuales',
      activo: true,
      auth_user_id: null,
    },
    {
      id: 25,
      nombre_completo: 'Paola Maldonado',
      correo: 'paola.qa@example.com',
      region: 'Valencia',
      region_id: '618284ba-9dea-4efb-9e6b-e429b8d8960d',
      categoria: 'Fijas',
      activo: true,
      auth_user_id: null,
    },
  ];

  const mock = createFakeAdminClient(sampleRows);
  const ephemeralPwd = 'TestInitPwd#991';

  // 1) Dry-run: CERO escrituras
  const drySummary = await provisionPromotoras1To1({
    client: mock.client,
    initialPassword: ephemeralPwd,
    mode: 'dry-run',
    mustChangePassword: true,
    delayMs: 0,
  });
  assert.equal(drySummary.mode, 'dry-run');
  assert.equal(drySummary.totalLeidos, 2);
  assert.equal(drySummary.paridad1a1Porcentaje, 100);
  assert.equal(drySummary.fusionesDetectadas, 0);
  assert.equal(mock.authUsers.length, 0, 'dry-run no debe crear usuarios Auth');
  assert.equal(mock.profiles.size, 0, 'dry-run no debe escribir en profiles');

  // 2) Apply #1
  const apply1 = await provisionPromotoras1To1({
    client: mock.client,
    initialPassword: ephemeralPwd,
    mode: 'apply',
    mustChangePassword: true,
    delayMs: 0,
  });
  assert.equal(apply1.authCreados, 2);
  assert.equal(apply1.authActualizados, 0);
  assert.equal(apply1.profilesUpserted, 2);
  assert.equal(apply1.promotorasVinculadas, 2);
  assert.equal(apply1.conteoRegionInvariable, true);
  assert.equal(mock.authUsers.length, 2);
  assert.equal(mock.promotoras[0]!.categoria, 'Eventuales', 'No debe sobrescribir categoria existente');
  assert.equal(mock.promotoras[0]!.region, 'Occidente');
  assert.equal(mock.promotoras[1]!.region, 'Valencia');

  // Verificar metadatos regionales estrictos en profiles
  const occProfile = mock.profiles.get(String(mock.promotoras[0]!.auth_user_id));
  const valProfile = mock.profiles.get(String(mock.promotoras[1]!.auth_user_id));
  assert.deepEqual(occProfile?.regiones_asignadas, ['OCCIDENTE']);
  assert.deepEqual(valProfile?.regiones_asignadas, ['CENTRO']);
  assert.equal(occProfile?.must_change_password, true);

  // 3) Apply #2 (Idempotencia): 0 duplicados, reutiliza los mismos 2 auth_user_id
  const apply2 = await provisionPromotoras1To1({
    client: mock.client,
    initialPassword: ephemeralPwd,
    mode: 'apply',
    mustChangePassword: true,
    delayMs: 0,
  });
  assert.equal(apply2.authCreados, 0);
  assert.equal(apply2.authActualizados, 2);
  assert.equal(apply2.promotorasVinculadas, 0);
  assert.equal(mock.authUsers.length, 2, 'Doble ejecución NO debe duplicar cuentas Auth');
});

test('Rate limiting en POST /api/auth/promotora-login bloquea con 429 tras 5 intentos fallidos', async () => {
  let fakeNow = 1_700_000_000_000;
  const handler = createPromotoraLoginHandler({
    maxFailedAttempts: 5,
    windowMs: 15 * 60 * 1000,
    now: () => fakeNow,
    gateway: {
      async signInWithPassword(_email, password) {
        if (password === 'ValidPass#2026') {
          return {
            ok: true,
            status: 200,
            session: { access_token: 'tok', refresh_token: 'ref' },
          };
        }
        return { ok: false, status: 401, error: 'Credenciales inválidas.' };
      },
    },
  });

  const invoke = async (email: string, password: string) => {
    let statusCode = 200;
    let body: Record<string, unknown> = {};
    const headers: Record<string, string> = {};
    const req = {
      ip: '127.0.0.1',
      body: { email, password },
    } as Parameters<typeof handler>[0];
    const res = {
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        body = payload;
        return this;
      },
    } as unknown as Parameters<typeof handler>[1];
    await handler(req, res);
    return { statusCode, body, headers };
  };

  for (let i = 1; i <= 4; i += 1) {
    const r = await invoke('promotora.test@example.com', 'wrong');
    assert.equal(r.statusCode, 401);
  }
  // 5to intento fallido -> bloquea inmediatamente con 429 + Retry-After
  const fifth = await invoke('promotora.test@example.com', 'wrong');
  assert.equal(fifth.statusCode, 429);
  assert.ok(Number(fifth.headers['retry-after']) > 0);

  // 6to intento (incluso con clave correcta) permanece bloqueado durante la ventana
  const sixth = await invoke('promotora.test@example.com', 'ValidPass#2026');
  assert.equal(sixth.statusCode, 429);

  // Tras expirar la ventana, permite autenticar nuevamente
  fakeNow += 15 * 60 * 1000 + 1;
  const afterWindow = await invoke('promotora.test@example.com', 'ValidPass#2026');
  assert.equal(afterWindow.statusCode, 200);
});

test('Auditoría estática de seguridad en migración SQL 20261205000100 y .gitignore/.env.example', () => {
  const root = process.cwd();
  const migPath = path.join(
    root,
    'supabase',
    'migrations',
    '20261205000100_promotoras_auth_1a1_aislamiento_estricto.sql'
  );
  const mirrorPath = path.join(root, 'sql', 'promotoras_auth_1a1_aislamiento_estricto.sql');

  const sql = fs.readFileSync(migPath, 'utf8');
  const mirror = fs.readFileSync(mirrorPath, 'utf8');
  assert.equal(sql, mirror, 'La migración y su espejo en sql/ deben ser byte-a-byte idénticos');

  const executableSql = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
  assert.doesNotMatch(executableSql, /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.doesNotMatch(executableSql, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(executableSql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(executableSql, /\bTO\s+anon\b/i);
  assert.doesNotMatch(executableSql, /auth\.jwt\(\)[^\n]*user_metadata/i);

  assert.match(sql, /idx_promotoras_auth_user_id_uniq/i);
  assert.match(sql, /must_change_password\s+BOOLEAN/i);
  assert.match(sql, /complete_own_password_change/i);
  assert.match(sql, /fn_trade_actor_regional_guardrail/i);
  assert.match(sql, /AS RESTRICTIVE/i);

  // Verificar .gitignore y .env.example
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.local$/m);

  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /^INITIAL_PROMOTORA_PASSWORD="CAMBIAR_EN_ENTORNO_LOCAL"$/m);
});
