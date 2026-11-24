import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  PORTAL_ASISTENCIA_DRAFT_STORAGE_KEY,
  PortalAttendanceSubmitError,
  checkAsistenciaHealth,
  clearPortalAsistenciaDraft,
  loadPortalAsistenciaDraft,
  resyncPromotoraSession,
  savePortalAsistenciaDraft,
  submitPortalAttendanceEvidence,
  toCanonicalMultisedeSucursal,
  type PortalPromotoraContext,
} from '../src/services/promotoraCampoService';

const WORKSPACE_ROOT = process.cwd();
const MIGRATION_PATH = path.join(
  WORKSPACE_ROOT,
  'supabase',
  'migrations',
  '20261209000100_fix_definitivo_rls_asistencia.sql'
);
const COPY_PASTE_SQL_PATH = path.join(WORKSPACE_ROOT, 'sql', 'FIX_DEFINITIVO_RLS_ASISTENCIA.sql');

function createTestContext(overrides?: Partial<PortalPromotoraContext>): PortalPromotoraContext {
  return {
    promotoraId: '14',
    promotoraRefId: 14,
    authUserId: '11111111-1111-4111-8111-111111111111',
    nombre: 'María Pérez',
    correo: 'maria.perez@codizulca.com',
    telefono: '0414-0000000',
    direccion: 'Maracaibo Norte',
    categoria: 'Fijas',
    perfilAsistencia: 'FIJA',
    region: 'Occidente',
    sucursal: 'ZULIA', // Valor legacy que antes disparaba error 42501 / CHECK
    isManagerOrAdmin: false,
    isMerchandisingRole: false,
    ...overrides,
  };
}

function createFakeJpegBlob(): Blob {
  // Cabecera JPEG mínima válida > 0 bytes
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])], {
    type: 'image/jpeg',
  });
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

test('SQL Maestro · Paridad byte-a-byte entre migración versionada y copia sql/FIX_DEFINITIVO_RLS_ASISTENCIA.sql', () => {
  assert.equal(fs.existsSync(MIGRATION_PATH), true, 'Debe existir la migración 20261209000100');
  assert.equal(fs.existsSync(COPY_PASTE_SQL_PATH), true, 'Debe existir sql/FIX_DEFINITIVO_RLS_ASISTENCIA.sql');

  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const copyPasteSql = fs.readFileSync(COPY_PASTE_SQL_PATH, 'utf8');
  assert.equal(migrationSql, copyPasteSql, 'Ambos archivos SQL deben ser idénticos');
});

test('SQL Maestro · Invariantes de seguridad (Zero-Anon, SECURITY DEFINER, search_path, triggers, ON CONFLICT, sin DDL destructivo)', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const sqlWithoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');

  // Prohibiciones absolutas (verificadas sobre SQL ejecutable sin comentarios)
  assert.doesNotMatch(sqlWithoutComments, /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\bDROP\s+COLUMN\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\bTO\s+anon\b/i, 'No debe otorgar políticas ni permisos al rol anon');
  assert.doesNotMatch(sqlWithoutComments, /\bGRANT\b[^\n;]*\bTO\b[^\n;]*\banon\b/i);

  // Funciones críticas con SECURITY DEFINER + SET search_path = public
  const requiredSecurityDefinerFns = [
    'obtener_mi_sucursal',
    'fn_trade_current_promotora_id',
    'fn_trade_is_promotora_owner',
    'fn_trade_is_asistencia_manager',
    'fn_trg_normalizar_sucursal_asistencia',
    'rpc_abrir_jornada_asistencia',
    'rpc_registrar_turno_asistencia',
    'rpc_healthcheck_asistencia',
  ];
  for (const fn of requiredSecurityDefinerFns) {
    const fnRegex = new RegExp(
      `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\b[\\s\\S]{0,600}SECURITY\\s+DEFINER[\\s\\S]{0,120}SET\\s+search_path\\s*=\\s*public`,
      'i'
    );
    assert.match(sql, fnRegex, `Función ${fn} debe tener SECURITY DEFINER y SET search_path = public`);
  }

  // Triggers en ambas tablas de asistencia
  assert.match(sql, /CREATE\s+TRIGGER\s+trg_aa_normalizar_sucursal_asistencia[\s\S]{0,120}ON\s+public\.asistencias_jornada/i);
  assert.match(sql, /CREATE\s+TRIGGER\s+trg_aa_normalizar_sucursal_asistencia[\s\S]{0,120}ON\s+public\.asistencia_evidencias/i);

  // Idempotencia ON CONFLICT + RLS + FORCE RLS + Storage + reload schema
  assert.match(sql, /ON\s+CONFLICT\s*\(\s*fecha_jornada\s*,\s*promotora_id\s*\)\s+DO\s+UPDATE/i);
  assert.match(sql, /ON\s+CONFLICT\s*\(\s*asistencia_id\s*,\s*slot_foto\s*\)\s+DO\s+UPDATE/i);
  assert.match(sql, /ALTER\s+TABLE\s+public\.asistencias_jornada\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.match(sql, /ALTER\s+TABLE\s+public\.asistencias_jornada\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.match(sql, /ALTER\s+TABLE\s+public\.asistencia_evidencias\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.match(sql, /ALTER\s+TABLE\s+public\.asistencia_evidencias\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.match(sql, /DROP\s+POLICY\s+IF\s+EXISTS/i);
  assert.match(sql, /asistencia_evidencias_storage_insert_auth/i);
  assert.match(sql, /is_torre_control_viewer\(\)/i, 'Debe preservar lectura de Contraloría');
  assert.match(sql, /NOTIFY\s+pgrst\s*,\s*'reload schema'/i);
});

test('Reglas Permanentes · AGENTS.md, rules/AGENTS.md y .agents/rules/supabase-rls-guard.md contienen la regla RLS obligatoria', () => {
  const requiredFragment =
    'Toda escritura crítica desde la App de Promotoras hacia tablas con RLS debe realizarse mediante funciones RPC `SECURITY DEFINER` idempotentes con `SET search_path = public`';

  for (const relPath of [
    'AGENTS.md',
    path.join('rules', 'AGENTS.md'),
    path.join('.agents', 'rules', 'supabase-rls-guard.md'),
  ]) {
    const abs = path.join(WORKSPACE_ROOT, relPath);
    assert.equal(fs.existsSync(abs), true, `Debe existir ${relPath}`);
    const content = fs.readFileSync(abs, 'utf8');
    assert.equal(content.includes(requiredFragment), true, `${relPath} debe incluir la regla permanente RLS`);
  }
});

test('Canonicalización multisede · ZULIA->OCCIDENTE y VALENCIA/CAPITAL->CENTRO', () => {
  assert.equal(toCanonicalMultisedeSucursal('ZULIA', 'Occidente'), 'OCCIDENTE');
  assert.equal(toCanonicalMultisedeSucursal('VALENCIA', 'Valencia'), 'CENTRO');
  assert.equal(toCanonicalMultisedeSucursal('CAPITAL', 'Occidente'), 'CENTRO');
  assert.equal(toCanonicalMultisedeSucursal('OCCIDENTE', 'Occidente'), 'OCCIDENTE');
  assert.equal(toCanonicalMultisedeSucursal('', 'Valencia'), 'CENTRO');
  assert.equal(toCanonicalMultisedeSucursal(null, 'Occidente'), 'OCCIDENTE');
});

test('Protección de borrador Android Cámara Nativa · guarda, restaura, expira por TTL y limpia', () => {
  const prevWindow = (globalThis as { window?: unknown }).window;
  const sessionStorage = createMemoryStorage();
  const localStorage = createMemoryStorage();
  (globalThis as { window?: unknown }).window = { sessionStorage, localStorage };

  try {
    savePortalAsistenciaDraft({
      activeStore: 'Hipermercado Fiorella Indio Mara',
      selectedZona: 'Maracaibo Norte',
      selectedSlot: 'JORNADA_INGRESO',
      promotoraId: '14',
    });

    assert.ok(sessionStorage.getItem(PORTAL_ASISTENCIA_DRAFT_STORAGE_KEY));
    assert.ok(localStorage.getItem(PORTAL_ASISTENCIA_DRAFT_STORAGE_KEY));

    // Simular recarga Android donde sessionStorage se vacía pero localStorage sobrevive
    sessionStorage.clear();
    const restored = loadPortalAsistenciaDraft(30 * 60 * 1000, Date.now());
    assert.ok(restored);
    assert.equal(restored.activeStore, 'Hipermercado Fiorella Indio Mara');
    assert.equal(restored.selectedSlot, 'JORNADA_INGRESO');
    assert.equal(restored.activeTab, 'asistencia');

    // Expiración por TTL (> 30 min)
    const expired = loadPortalAsistenciaDraft(1000, restored.savedAtMs + 5000);
    assert.equal(expired, null);
    assert.equal(localStorage.getItem(PORTAL_ASISTENCIA_DRAFT_STORAGE_KEY), null);

    // Limpieza manual
    savePortalAsistenciaDraft({
      activeStore: 'Sigo Sambil',
      selectedZona: 'Valencia',
      selectedSlot: 'JORNADA_SALIDA',
    });
    clearPortalAsistenciaDraft();
    assert.equal(loadPortalAsistenciaDraft(), null);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  }
});

test('submitPortalAttendanceEvidence · Ruta primaria RPC atómica exitosa + limpieza de foto anterior', async () => {
  const uploadedPaths: string[] = [];
  const removedPaths: string[][] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  const mockClient = {
    auth: {
      async getSession() {
        return {
          data: {
            session: {
              access_token: 'tok-valid',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: { id: '11111111-1111-4111-8111-111111111111', email: 'maria.perez@codizulca.com' },
            },
          },
          error: null,
        };
      },
      async refreshSession() {
        return { data: { session: null }, error: null };
      },
    },
    storage: {
      from() {
        return {
          async upload(storagePath: string) {
            uploadedPaths.push(storagePath);
            return { data: { path: storagePath }, error: null };
          },
          async remove(paths: string[]) {
            removedPaths.push(paths);
            return { data: [], error: null };
          },
          async createSignedUrl(storagePath: string) {
            return { data: { signedUrl: `https://signed.local/${storagePath}` }, error: null };
          },
        };
      },
    },
    async rpc(fn: string, args?: unknown) {
      rpcCalls.push({ fn, args });
      if (fn === 'rpc_registrar_turno_asistencia') {
        const p = (args as { p_payload: Record<string, unknown> }).p_payload;
        return {
          data: {
            ok: true,
            jornada: {
              id: 'jornada-uuid-1',
              fecha_jornada: p.fecha_jornada,
              promotora_id: '14',
              promotora_nombre: 'María Pérez',
              perfil_aplicado: 'FIJA',
              pdv_nombre: p.pdv_nombre,
              zona: p.zona,
              region: 'Occidente',
              sucursal: 'OCCIDENTE',
              opened_at_server: '2026-11-24T12:00:00Z',
              updated_at_server: '2026-11-24T12:00:00Z',
            },
            evidencia: {
              id: 'ev-uuid-1',
              asistencia_id: 'jornada-uuid-1',
              slot_foto: p.slot_foto,
              storage_bucket: 'asistencia-evidencias',
              storage_path: p.storage_path,
              mime_type: p.mime_type,
              tamano_bytes: p.tamano_bytes,
              pdv_nombre: p.pdv_nombre,
              lat: p.lat,
              lng: p.lng,
              gps_accuracy: p.gps_accuracy,
              location_source: p.location_source,
              region: 'Occidente',
              sucursal: 'OCCIDENTE',
              capturado_en_servidor: '2026-11-24T12:00:01Z',
              version: 2,
            },
            previous_storage_path: '14/asistencia/old-photo.jpg',
          },
          error: null,
        };
      }
      throw new Error(`RPC inesperada: ${fn}`);
    },
  };

  const result = await submitPortalAttendanceEvidence({
    context: createTestContext(),
    slotFoto: 'JORNADA_INGRESO',
    pdvNombre: 'Fiorella Supermarket',
    zona: 'Maracaibo',
    lat: 10.65445,
    lng: -71.64058,
    gpsAccuracy: 18,
    locationSource: 'wifi_cell',
    imageFile: createFakeJpegBlob(),
    fechaJornada: '2026-11-24',
    clientOverride: mockClient as unknown as Parameters<typeof submitPortalAttendanceEvidence>[0]['clientOverride'],
  });

  assert.equal(uploadedPaths.length, 1);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'rpc_registrar_turno_asistencia');
  assert.equal(result.jornada.sucursal, 'OCCIDENTE');
  assert.equal(result.evidencia.location_source, 'wifi_cell');
  assert.ok(result.signedUrl?.startsWith('https://signed.local/'));
  assert.deepEqual(removedPaths, [['14/asistencia/old-photo.jpg']]);
});

test('submitPortalAttendanceEvidence · Sesión expirada bloquea antes de subir foto y retorna categoría SESSION_EXPIRED', async () => {
  let uploadCalled = false;
  const mockClient = {
    auth: {
      async getSession() {
        return { data: { session: null }, error: null };
      },
      async refreshSession() {
        return { data: { session: null }, error: { message: 'Invalid Refresh Token' } };
      },
    },
    storage: {
      from() {
        return {
          async upload() {
            uploadCalled = true;
            return { data: null, error: null };
          },
        };
      },
    },
  };

  await assert.rejects(
    () =>
      submitPortalAttendanceEvidence({
        context: createTestContext(),
        slotFoto: 'JORNADA_INGRESO',
        pdvNombre: 'Fiorella Supermarket',
        lat: 10.65,
        lng: -71.64,
        imageFile: createFakeJpegBlob(),
        clientOverride: mockClient as unknown as Parameters<typeof submitPortalAttendanceEvidence>[0]['clientOverride'],
      }),
    (err: unknown) => {
      assert.ok(err instanceof PortalAttendanceSubmitError);
      assert.equal(err.category, 'SESSION_EXPIRED');
      return true;
    }
  );
  assert.equal(uploadCalled, false, 'No debe intentar subir foto a Storage si la sesión expiró');
});

test('submitPortalAttendanceEvidence · Rollback de Storage y diagnóstico SQL_MIGRATION_PENDING si falta RPC y 42501', async () => {
  const removedPaths: string[][] = [];
  let insertedSucursal: unknown = null;

  const mockClient = {
    auth: {
      async getSession() {
        return {
          data: {
            session: {
              access_token: 'tok-valid',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: { id: '11111111-1111-4111-8111-111111111111', email: 'maria.perez@codizulca.com' },
            },
          },
          error: null,
        };
      },
      async refreshSession() {
        return { data: { session: null }, error: null };
      },
    },
    storage: {
      from() {
        return {
          async upload(storagePath: string) {
            return { data: { path: storagePath }, error: null };
          },
          async remove(paths: string[]) {
            removedPaths.push(paths);
            return { data: [], error: null };
          },
        };
      },
    },
    async rpc(fn: string) {
      return {
        data: null,
        error: { code: 'PGRST202', message: `Could not find the function public.${fn}` },
      };
    },
    from(table: string) {
      assert.equal(table, 'asistencias_jornada');
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    async maybeSingle() {
                      return { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          insertedSucursal = payload.sucursal;
          return {
            async select() {
              return {
                data: null,
                error: {
                  code: '42501',
                  message: 'new row violates row-level security policy for table "asistencias_jornada"',
                },
              };
            },
          };
        },
      };
    },
  };

  await assert.rejects(
    () =>
      submitPortalAttendanceEvidence({
        context: createTestContext({ sucursal: 'ZULIA' }),
        slotFoto: 'JORNADA_INGRESO',
        pdvNombre: 'Fiorella Supermarket',
        lat: 10.65,
        lng: -71.64,
        imageFile: createFakeJpegBlob(),
        clientOverride: mockClient as unknown as Parameters<typeof submitPortalAttendanceEvidence>[0]['clientOverride'],
      }),
    (err: unknown) => {
      assert.ok(err instanceof PortalAttendanceSubmitError);
      assert.equal(err.category, 'SQL_MIGRATION_PENDING');
      assert.match(err.message, /FIX_DEFINITIVO_RLS_ASISTENCIA\.sql/);
      return true;
    }
  );

  assert.equal(insertedSucursal, 'OCCIDENTE', 'Incluso en fallback, jamás debe enviar ZULIA sino OCCIDENTE');
  assert.equal(removedPaths.length, 1, 'Debe hacer rollback inmediato del archivo en Storage al fallar BD');
});

test('checkAsistenciaHealth y resyncPromotoraSession · mapeo saludable y renovación de token', async () => {
  const mockClient = {
    async rpc(fn: string) {
      assert.equal(fn, 'rpc_healthcheck_asistencia');
      return {
        data: {
          ok: true,
          tables_ok: true,
          storage_bucket_ok: true,
          rpcs_ok: true,
          has_auth_session: true,
          mi_sucursal: 'OCCIDENTE',
          promotora_id: '14',
          timestamp: '2026-11-24T15:00:00Z',
        },
        error: null,
      };
    },
    auth: {
      async refreshSession() {
        return {
          data: {
            session: {
              access_token: 'new-jwt',
              user: { id: 'uid-1', email: 'promotora@codizulca.com' },
            },
          },
          error: null,
        };
      },
      async getSession() {
        return { data: { session: null }, error: null };
      },
    },
  };

  const health = await checkAsistenciaHealth(
    mockClient as unknown as Parameters<typeof checkAsistenciaHealth>[0]
  );
  assert.equal(health.ok, true);
  assert.equal(health.rpcAvailable, true);
  assert.equal(health.miSucursal, 'OCCIDENTE');
  assert.equal(health.promotoraId, '14');

  const resync = await resyncPromotoraSession(
    mockClient as unknown as Parameters<typeof resyncPromotoraSession>[0]
  );
  assert.equal(resync.ok, true);
  assert.equal(resync.userId, 'uid-1');
  assert.equal(resync.email, 'promotora@codizulca.com');
});
