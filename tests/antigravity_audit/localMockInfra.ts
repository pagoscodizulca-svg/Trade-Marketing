import crypto from 'node:crypto';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

function toBase64Url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function buildMockJwt(payload: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  return `${toBase64Url(header)}.${toBase64Url(payload)}.mock_local_sig`;
}

export const MOCK_PUBLIC_ANON_KEY = buildMockJwt({
  role: 'anon',
  iss: 'supabase-local-audit-mock',
  iat: 1700000000,
  exp: 2100000000,
});

export const MOCK_SERVICE_ROLE_KEY = buildMockJwt({
  role: 'service_role',
  iss: 'supabase-local-audit-mock',
  iat: 1700000000,
  exp: 2100000000,
});

export const MOCK_CRON_SECRET = 'local-audit-cron-secret-2026-codizulca';

export interface MockAuthActor {
  id: string;
  email: string;
  password: string;
  app_metadata: Record<string, unknown>;
  token: string;
}

export const MOCK_ACTORS = {
  admin: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin.audit@codizulca.local',
    password: 'AuditPassword123!',
    app_metadata: {
      app_role: 'admin',
      role: 'admin',
      display_name: 'Auditor Admin Local',
    },
    token: buildMockJwt({
      sub: '11111111-1111-4111-8111-111111111111',
      email: 'admin.audit@codizulca.local',
      role: 'authenticated',
      app_metadata: {
        app_role: 'admin',
        role: 'admin',
        display_name: 'Auditor Admin Local',
      },
      exp: 2100000000,
    }),
  },
  gerenteAdmin: {
    id: '12121212-1212-4121-8121-121212121212',
    email: 'gerente.audit@codizulca.local',
    password: 'AuditPassword123!',
    app_metadata: {
      app_role: 'gerente_admin',
      display_name: 'Gerente Admin Local',
    },
    token: buildMockJwt({
      sub: '12121212-1212-4121-8121-121212121212',
      email: 'gerente.audit@codizulca.local',
      role: 'authenticated',
      app_metadata: {
        app_role: 'gerente_admin',
        display_name: 'Gerente Admin Local',
      },
      exp: 2100000000,
    }),
  },
  coordinadora: {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'coordinadora.audit@codizulca.local',
    password: 'AuditPassword123!',
    app_metadata: {
      app_role: 'coordinadora',
      display_name: 'Coordinadora Trade Local',
    },
    token: buildMockJwt({
      sub: '22222222-2222-4222-8222-222222222222',
      email: 'coordinadora.audit@codizulca.local',
      role: 'authenticated',
      app_metadata: {
        app_role: 'coordinadora',
        display_name: 'Coordinadora Trade Local',
      },
      exp: 2100000000,
    }),
  },
  promotoraFija: {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'maria.pina@promotoras.codizulca.local',
    password: 'AuditPassword123!',
    app_metadata: {
      app_role: 'promotora',
      staff_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      display_name: 'María Piña',
    },
    token: buildMockJwt({
      sub: '33333333-3333-4333-8333-333333333333',
      email: 'maria.pina@promotoras.codizulca.local',
      role: 'authenticated',
      app_metadata: {
        app_role: 'promotora',
        staff_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        display_name: 'María Piña',
      },
      exp: 2100000000,
    }),
  },
  promotoraEventual: {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'scarleth.nunez@promotoras.codizulca.local',
    password: 'AuditPassword123!',
    app_metadata: {
      app_role: 'promotora',
      staff_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      display_name: 'Scarleth Núñez',
    },
    token: buildMockJwt({
      sub: '44444444-4444-4444-8444-444444444444',
      email: 'scarleth.nunez@promotoras.codizulca.local',
      role: 'authenticated',
      app_metadata: {
        app_role: 'promotora',
        staff_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        display_name: 'Scarleth Núñez',
      },
      exp: 2100000000,
    }),
  },
} as const;

export interface RecordedMockRequest {
  method: string;
  pathname: string;
  search: string;
  authHeader: string;
  timestampMs: number;
}

export interface LocalMockInfraInstance {
  baseUrl: string;
  port: number;
  tables: Record<string, Array<Record<string, any>>>;
  storageObjects: Map<string, { bucket: string; mimeType: string; size: number; sha256: string }>;
  recordedRequests: RecordedMockRequest[];
  faultInjection: {
    transientFailuresRemaining: number;
    artificialDelayMs: number;
    forceRpcMissing: Set<string>;
    forceTableMissing: Set<string>;
  };
  resetSeedData: () => void;
  close: () => Promise<void>;
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Range',
    ...extraHeaders,
  });
  res.end(payload);
}

function matchPostgrestRow(row: Record<string, any>, searchParams: URLSearchParams): boolean {
  for (const [key, rawExpr] of searchParams.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset' || key === 'on_conflict') {
      continue;
    }
    if (key === 'or') {
      const inner = rawExpr.replace(/^\(/, '').replace(/\)$/, '');
      const clauses = inner.split(',');
      const anyMatch = clauses.some((clause) => {
        const firstDot = clause.indexOf('.');
        const secondDot = clause.indexOf('.', firstDot + 1);
        if (firstDot < 0 || secondDot < 0) return false;
        const col = clause.slice(0, firstDot);
        const op = clause.slice(firstDot + 1, secondDot);
        const val = clause.slice(secondDot + 1);
        return evaluateColumnOp(row[col], op, val);
      });
      if (!anyMatch) return false;
      continue;
    }
    const dotIdx = rawExpr.indexOf('.');
    if (dotIdx < 0) continue;
    const op = rawExpr.slice(0, dotIdx);
    const val = rawExpr.slice(dotIdx + 1);
    if (!evaluateColumnOp(row[key], op, val)) {
      return false;
    }
  }
  return true;
}

function evaluateColumnOp(cellVal: any, op: string, rawOperand: string): boolean {
  if (op === 'eq') {
    if (rawOperand === 'true') return cellVal === true;
    if (rawOperand === 'false') return cellVal === false;
    return String(cellVal ?? '') === rawOperand;
  }
  if (op === 'neq') {
    return String(cellVal ?? '') !== rawOperand;
  }
  if (op === 'is') {
    if (rawOperand === 'null') return cellVal === null || cellVal === undefined;
    if (rawOperand === 'true') return cellVal === true;
    if (rawOperand === 'false') return cellVal === false;
    return false;
  }
  if (op === 'lt') {
    return cellVal != null && String(cellVal) < rawOperand;
  }
  if (op === 'lte') {
    return cellVal != null && String(cellVal) <= rawOperand;
  }
  if (op === 'gt') {
    return cellVal != null && String(cellVal) > rawOperand;
  }
  if (op === 'gte') {
    return cellVal != null && String(cellVal) >= rawOperand;
  }
  if (op === 'in') {
    const inner = rawOperand.replace(/^\(/, '').replace(/\)$/, '');
    const items = inner
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    return items.includes(String(cellVal ?? ''));
  }
  if (op === 'ilike') {
    const text = String(cellVal ?? '');
    const regexStr =
      '^' +
      rawOperand
        .replace(/[.*+?^${}()|[\]]/g, '\\$&')
        .replace(/\\\\%/g, '\u0000')
        .replace(/\\\\_/g, '\u0001')
        .replace(/[%*]/g, '.*')
        .replace(/_/g, '.')
        .replace(/\u0000/g, '%')
        .replace(/\u0001/g, '_') +
      '$';
    return new RegExp(regexStr, 'i').test(text);
  }
  return true;
}

export async function startLocalMockInfra(port = 0): Promise<LocalMockInfraInstance> {
  const tables: Record<string, Array<Record<string, any>>> = {};
  const storageObjects = new Map<
    string,
    { bucket: string; mimeType: string; size: number; sha256: string }
  >();
  const recordedRequests: RecordedMockRequest[] = [];
  const authUsersById = new Map<string, MockAuthActor>();
  const authUsersByToken = new Map<string, MockAuthActor>();

  const faultInjection = {
    transientFailuresRemaining: 0,
    artificialDelayMs: 0,
    forceRpcMissing: new Set<string>(),
    forceTableMissing: new Set<string>(),
  };

  function resetSeedData() {
    authUsersById.clear();
    authUsersByToken.clear();
    for (const actor of Object.values(MOCK_ACTORS)) {
      const cloned: MockAuthActor = {
        ...actor,
        app_metadata: { ...actor.app_metadata },
      };
      authUsersById.set(cloned.id, cloned);
      authUsersByToken.set(cloned.token, cloned);
    }

    storageObjects.clear();
    recordedRequests.length = 0;

    tables.staff = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'María Piña',
        role: 'Promotora Fija',
        email: 'maria.pina@promotoras.codizulca.local',
        auth_user_id: MOCK_ACTORS.promotoraFija.id,
        status: JSON.stringify({
          status: 'Activo',
          category: 'fija',
          assignedLocation: 'SUPERMERCADO FIORELLA (NORTE)',
          address: 'Zona Norte Maracaibo',
          phone: '04141234567',
        }),
        created_at: '2026-10-01T12:00:00.000Z',
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'Scarleth Núñez',
        role: 'Promotora Eventual',
        email: 'scarleth.nunez@promotoras.codizulca.local',
        auth_user_id: MOCK_ACTORS.promotoraEventual.id,
        status: JSON.stringify({
          status: 'Activo',
          category: 'eventual',
          assignedLocation: 'HIPERMERCADO NASA',
          address: 'San Francisco',
          phone: '04129876543',
        }),
        created_at: '2026-10-02T12:00:00.000Z',
      },
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name: 'Pedro Merchandising',
        role: 'Mercaderista / Merchandising',
        email: 'pedro.merch@promotoras.codizulca.local',
        auth_user_id: null,
        status: JSON.stringify({
          status: 'Activo',
          category: 'merchandising',
          assignedLocation: 'RUTA ZULIA',
          address: 'Maracaibo',
        }),
        created_at: '2026-10-03T12:00:00.000Z',
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        name: 'Ana Retirada',
        role: 'Promotora Fija',
        email: 'ana.inactiva@promotoras.codizulca.local',
        auth_user_id: null,
        status: JSON.stringify({
          status: 'Inactivo',
          category: 'fija',
        }),
        created_at: '2026-09-01T12:00:00.000Z',
      },
    ];

    tables.vendedores = [
      {
        id: 'eeee1111-1111-4111-8111-111111111111',
        codigo_vendedor: 'V001',
        nombre_completo: 'CARLOS PEÑA',
        documento_identidad: 'V-15000111',
        telefono: '04140001111',
        email: 'carlos.pena@codizulca.local',
        zona: 'MARACAIBO NORTE',
        supervisor: 'LUIS MÉNDEZ',
        activo: true,
        metadata: {},
        ultima_sincronizacion: '2026-11-15T12:00:00.000Z',
      },
    ];

    tables.clientes = [
      {
        id: 'ffff1111-1111-4111-8111-111111111111',
        codigo_cliente: 'CLI-001',
        rif: 'J-30111222-3',
        razon_social: 'INVERSIONES EL SOL, C.A. (SUPERMERCADO EL SOL)',
        nombre_comercial: 'SUPERMERCADO EL SOL',
        canal: 'Supermercado',
        segmento: 'A',
        zona: 'MARACAIBO NORTE',
        ruta: 'RUTA 01',
        direccion: 'AV. FUERZAS ARMADAS',
        ciudad: 'MARACAIBO',
        estado: 'ZULIA',
        telefono: '02617001122',
        latitud: 10.6945,
        longitud: -71.6342,
        vendedor_id: 'eeee1111-1111-4111-8111-111111111111',
        codigo_vendedor: 'V001',
        activo: true,
        metadata: {},
        ultima_sincronizacion: '2026-11-15T12:00:00.000Z',
      },
      {
        id: 'ffff2222-2222-4222-8222-222222222222',
        codigo_cliente: 'CLI-002',
        rif: 'J-40222333-4',
        razon_social: 'DISTRIBUIDORA LA ÑAPA EXPRESS C.A.',
        nombre_comercial: 'LA ÑAPA EXPRESS',
        canal: 'Mayorista',
        segmento: 'B',
        zona: 'SAN FRANCISCO',
        ruta: 'RUTA 02',
        direccion: 'ZONA INDUSTRIAL SUR',
        ciudad: 'SAN FRANCISCO',
        estado: 'ZULIA',
        telefono: '02617334455',
        latitud: 10.5812,
        longitud: -71.6481,
        vendedor_id: 'eeee1111-1111-4111-8111-111111111111',
        codigo_vendedor: 'V001',
        activo: true,
        metadata: {},
        ultima_sincronizacion: '2026-11-15T12:00:00.000Z',
      },
    ];

    tables.lotes_sincronizacion = [];
    tables.cargas_archivos = [];
    tables.cronograma_degustaciones = [
      {
        id: '77771111-1111-4111-8111-111111111111',
        carga_id: null,
        survey_origen_id: '88881111-1111-4111-8111-111111111111',
        idempotency_hash: 'a'.repeat(64),
        fecha: '2026-11-17',
        hora_inicio: '09:00',
        hora_fin: '13:00',
        turno: 'MAÑANA',
        cliente_nombre: 'SUPERMERCADO FIORELLA (NORTE)',
        cliente_codigo: 'CLI-001',
        zona_direccion: 'MARACAIBO NORTE',
        producto_resumen: 'MORTADELA ESPECIAL ASTURIAS',
        productos: ['MORTADELA ESPECIAL ASTURIAS'],
        cantidad_kilos: 3,
        personas_estimadas: 90,
        insumos_calculados: {},
        vendedor_fdv: 'CARLOS PEÑA',
        promotora_sugerida: 'María Piña',
        promotora_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promotora_nombre: 'María Piña',
        promotora_email: 'maria.pina@promotoras.codizulca.local',
        observaciones: 'Activación confirmada zona norte',
        estado: 'APROBADA',
        en_historial: false,
        created_at: '2026-11-16T12:00:00.000Z',
        updated_at: '2026-11-16T12:00:00.000Z',
      },
    ];

    tables.rutas_promotoras = [
      {
        id: '99991111-1111-4111-8111-111111111111',
        cronograma_id: '77771111-1111-4111-8111-111111111111',
        promotora_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promotora_nombre: 'María Piña',
        promotora_email: 'maria.pina@promotoras.codizulca.local',
        fecha: '2026-11-17',
        hora_inicio: '09:00',
        hora_fin: '13:00',
        turno: 'MAÑANA',
        cliente_nombre: 'SUPERMERCADO FIORELLA (NORTE)',
        cliente_codigo: 'CLI-001',
        zona_direccion: 'MARACAIBO NORTE',
        producto_resumen: 'MORTADELA ESPECIAL ASTURIAS',
        productos: ['MORTADELA ESPECIAL ASTURIAS'],
        cantidad_kilos: 3,
        personas_estimadas: 90,
        vendedor_fdv: 'CARLOS PEÑA',
        observaciones: 'Activación confirmada zona norte',
        estado_ruta: 'ASIGNADA',
        checkin_at: null,
        checkout_at: null,
        aprobado_por: 'coordinadora.audit@codizulca.local',
        asignado_at: '2026-11-16T12:00:00.000Z',
        updated_at: '2026-11-16T12:00:00.000Z',
      },
    ];

    tables.surveys = [
      {
        id: '88881111-1111-4111-8111-111111111111',
        type: 'Degustacion',
        date: '2026-11-17',
        fecha_evento: '2026-11-17',
        store: 'SUPERMERCADO FIORELLA (NORTE)',
        promoter: 'María Piña',
        product: 'MORTADELA ESPECIAL ASTURIAS',
        creatorId: 'CARLOS PEÑA',
        leido_trade: true,
        en_historial: false,
        comments: JSON.stringify({
          isTasting: true,
          source: 'vendedor_app',
          degustacionId: 'deg-local-001',
          cliente: 'SUPERMERCADO FIORELLA (NORTE)',
          clienteCodigo: 'CLI-001',
          vendedor: 'CARLOS PEÑA',
          ruta: 'MARACAIBO NORTE',
          date: '2026-11-17',
          turno: 'MAÑANA',
          products: ['MORTADELA ESPECIAL ASTURIAS'],
          kilos: 3,
          personasEstimadas: 90,
          estado: 'APROBADA',
          status: 'aprobada',
          promotoraAsignada: 'María Piña',
          promotoraId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          promotoraEmail: 'maria.pina@promotoras.codizulca.local',
          leido_trade: true,
        }),
        created_at: '2026-11-16T12:00:00.000Z',
      },
      {
        id: '88882222-2222-4222-8222-222222222222',
        type: 'Degustacion',
        date: '2026-11-18',
        fecha_evento: '2026-11-18',
        store: 'LA ÑAPA EXPRESS',
        promoter: 'CARLOS PEÑA',
        product: 'ARROZ VENCAMPO',
        creatorId: 'CARLOS PEÑA',
        leido_trade: false,
        en_historial: false,
        comments: JSON.stringify({
          isTasting: true,
          source: 'vendedor_app',
          degustacionId: 'deg-local-002',
          cliente: 'LA ÑAPA EXPRESS',
          clienteCodigo: 'CLI-002',
          vendedor: 'CARLOS PEÑA',
          ruta: 'SAN FRANCISCO',
          date: '2026-11-18',
          turno: 'TARDE',
          products: ['ARROZ VENCAMPO'],
          kilos: 2,
          personasEstimadas: 60,
          estado: 'SOLICITADA',
          status: 'pendiente',
          promotoraAsignada: '',
          leido_trade: false,
        }),
        created_at: '2026-11-16T13:00:00.000Z',
      },
      {
        id: '88883333-3333-4333-8333-333333333333',
        type: 'Degustacion',
        date: '2026-11-05',
        fecha_evento: '2026-11-05',
        store: 'ABASTO MÉRIDA GOURMET',
        promoter: 'Scarleth Núñez',
        product: 'ESPALDA AHUMADA ASTURIAS',
        creatorId: 'CARLOS PEÑA',
        leido_trade: true,
        en_historial: true,
        comments: JSON.stringify({
          isTasting: true,
          source: 'vendedor_app',
          degustacionId: 'deg-hist-001',
          cliente: 'ABASTO MÉRIDA GOURMET',
          vendedor: 'CARLOS PEÑA',
          ruta: 'SAN FRANCISCO',
          date: '2026-11-05',
          turno: 'TARDE',
          products: ['ESPALDA AHUMADA ASTURIAS'],
          kilos: 2.5,
          estado: 'NO_AUTORIZADA',
          status: 'no_autorizada',
          en_historial: true,
        }),
        created_at: '2026-11-04T14:00:00.000Z',
      },
    ];

    tables.solicitudes_contraloria = [
      {
        id: '66661111-1111-4111-8111-111111111111',
        codigo_correlativo: 'MP-07-0072',
        fecha_solicitud: '16/11/2026',
        fecha_iso: '2026-11-16',
        dirigido_a: 'CONTRALORÍA',
        para_ser_utilizado: 'DEGUSTACIÓN SEMANAL ZONA NORTE Y SAN FRANCISCO',
        items: [
          { itemNumber: 1, producto: 'MORTADELA ESPECIAL ASTURIAS 1KG', cantidad: 6 },
          { itemNumber: 2, producto: 'ARROZ VENCAMPO 1KG', cantidad: 4 },
        ],
        total_unidades: 10,
        observacion: 'LOTE PRUEBA LOCAL AUDITORÍA',
        solicitado_por: 'Coordinación Trade Marketing',
        firma_digital_texto: 'Coordinación Trade Marketing',
        firma_digital_imagen: null,
        departamento_solicitante: 'MERCADEO Y PUBLICIDAD',
        estado: 'PENDIENTE_APROBACION',
        nota_contraloria: null,
        resuelto_por: null,
        resuelto_at: null,
        leido_contraloria: false,
        created_at: '2026-11-16T11:00:00.000Z',
        updated_at: '2026-11-16T11:00:00.000Z',
      },
    ];

    tables.asistencias_jornada = [];
    tables.asistencia_evidencias = [];
    tables.checkins = [];
    tables.prices = [
      {
        id: 'price-001',
        date: '2026-11-15',
        store: 'SUPERMERCADO FIORELLA (NORTE)',
        ourProduct: 'MORTADELA ESPECIAL ASTURIAS 1KG',
        ourPrice: 12.0,
        competitor1Brand: 'MARCA A',
        competitor1Price: 12.8,
        promoter: 'María Piña',
        created_at: '2026-11-15T15:00:00.000Z',
      },
    ];
    tables.inventory = [
      {
        id: 'inv-001',
        date: '2026-11-15',
        store: 'SUPERMERCADO FIORELLA (NORTE)',
        product: 'MORTADELA ESPECIAL ASTURIAS',
        initialQuantity: 24,
        finalQuantity: 18,
        degustations: 6,
        promoter: 'María Piña',
        created_at: '2026-11-15T16:00:00.000Z',
      },
    ];
    tables.entregas_degustacion = [];
    tables.profiles = [
      {
        id: MOCK_ACTORS.admin.id,
        email: 'admin@codizulca.com',
        full_name: 'Administrador General Codizulca',
        role: 'super_admin',
        is_active: true,
        must_change_password: false,
        created_at: '2026-11-01T08:00:00.000Z',
        updated_at: '2026-11-16T10:00:00.000Z',
      },
      {
        id: MOCK_ACTORS.coordinadora.id,
        email: MOCK_ACTORS.coordinadora.email,
        full_name: 'Coordinadora Trade Local',
        role: 'coordinacion',
        is_active: true,
        must_change_password: false,
        created_at: '2026-11-02T09:00:00.000Z',
        updated_at: '2026-11-16T10:00:00.000Z',
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        email: 'carlos.pena@codizulca.local',
        full_name: 'Carlos Peña',
        role: 'vendedor',
        is_active: true,
        must_change_password: true,
        created_at: '2026-11-05T11:30:00.000Z',
        updated_at: '2026-11-15T14:20:00.000Z',
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        email: 'luis.morales@codizulca.local',
        full_name: 'Luis Morales',
        role: 'vendedor',
        is_active: false,
        must_change_password: false,
        created_at: '2026-11-06T10:15:00.000Z',
        updated_at: '2026-11-14T16:45:00.000Z',
      },
    ];
    tables.user_management_audit = [
      {
        id: '99990001-0000-4000-8000-000000000001',
        actor_id: MOCK_ACTORS.admin.id,
        target_user_id: '66666666-6666-4666-8666-666666666666',
        target_email: 'luis.morales@codizulca.local',
        action: 'USER_SUSPENDED',
        details: {
          previous: { role: 'vendedor', is_active: true },
          next: { role: 'vendedor', is_active: false },
        },
        created_at: '2026-11-14T16:45:00.000Z',
      },
      {
        id: '99990002-0000-4000-8000-000000000002',
        actor_id: MOCK_ACTORS.admin.id,
        target_user_id: '55555555-5555-4555-8555-555555555555',
        target_email: 'carlos.pena@codizulca.local',
        action: 'USER_CREATED',
        details: {
          full_name: 'Carlos Peña',
          role: 'vendedor',
          is_active: true,
          must_change_password: true,
        },
        created_at: '2026-11-05T11:30:00.000Z',
      },
    ];
  }

  resetSeedData();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      });
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', `http://127.0.0.1`);
    const pathname = urlObj.pathname;
    const authHeader = String(req.headers.authorization || '');

    recordedRequests.push({
      method: req.method || 'GET',
      pathname,
      search: urlObj.search,
      authHeader: authHeader ? (authHeader.startsWith('Bearer ') ? 'Bearer [PRESENT]' : '[OTHER]') : '',
      timestampMs: Date.now(),
    });

    if (faultInjection.artificialDelayMs > 0) {
      await new Promise((r) => setTimeout(r, faultInjection.artificialDelayMs));
    }

    if (faultInjection.transientFailuresRemaining > 0) {
      faultInjection.transientFailuresRemaining -= 1;
      sendJson(res, 503, { error: 'Simulated transient upstream 503' });
      return;
    }

    // 0. Mock external endpoints (Render FDV + DolarAPI BCV)
    if (pathname.startsWith('/mock-external/dashboard-fdv-planificador.onrender.com')) {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          success: true,
          count: 1,
          data: [
            {
              id: 'deg-render-only-001',
              clienteCodigo: 'CLI-001',
              clienteNombre: 'SUPERMERCADO FIORELLA (NORTE)',
              vendedorNombre: 'CARLOS PEÑA',
              ruta: 'MARACAIBO NORTE',
              fecha: '2026-11-19',
              turno: 'MAÑANA',
              productos: ['MORTADELA ESPECIAL ASTURIAS'],
              kilosEstimados: 2,
              personasEstimadas: 75,
              estado: 'SOLICITADA',
              observaciones: 'Solicitud mock local desde Render emulado',
              createdAt: '2026-11-16T14:00:00.000Z',
            },
          ],
        });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/mock-external/ve.dolarapi.com')) {
      sendJson(res, 200, { promedio: 46.25, fechaActualizacion: '2026-11-16T12:00:00.000Z' });
      return;
    }

    // 1. Supabase Auth endpoints
    if (pathname === '/auth/v1/user' && req.method === 'GET') {
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      const actor = authUsersByToken.get(token);
      if (!actor) {
        sendJson(res, 401, { message: 'Invalid JWT token in local mock' });
        return;
      }
      sendJson(res, 200, {
        id: actor.id,
        aud: 'authenticated',
        role: 'authenticated',
        email: actor.email,
        email_confirmed_at: '2026-10-01T00:00:00.000Z',
        app_metadata: actor.app_metadata,
        user_metadata: {},
      });
      return;
    }

    if (pathname === '/auth/v1/token' && req.method === 'POST') {
      const bodyBuf = await readBodyBuffer(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}') as {
        email?: string;
        password?: string;
      };
      const emailLower = String(body.email || '').trim().toLowerCase();
      const matched = Array.from(authUsersById.values()).find(
        (u) => u.email.toLowerCase() === emailLower && u.password === body.password
      );
      if (!matched) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return;
      }
      sendJson(res, 200, {
        access_token: matched.token,
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token',
        user: {
          id: matched.id,
          aud: 'authenticated',
          role: 'authenticated',
          email: matched.email,
          app_metadata: matched.app_metadata,
          user_metadata: {},
        },
      });
      return;
    }

    if (pathname === '/auth/v1/logout' && req.method === 'POST') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }

    if (pathname === '/auth/v1/signup' && req.method === 'POST') {
      const bodyBuf = await readBodyBuffer(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}') as Record<string, any>;
      const email = String(body.email || '').trim().toLowerCase();
      const duplicate = Array.from(authUsersById.values()).some(
        (u) => u.email.toLowerCase() === email
      ) || (tables.profiles || []).some((p) => String(p.email || '').toLowerCase() === email);

      if (duplicate) {
        sendJson(res, 400, { message: 'User already registered' });
        return;
      }

      const newId = crypto.randomUUID();
      const token = buildMockJwt({
        sub: newId,
        email,
        role: 'authenticated',
        app_metadata: {},
        exp: 2100000000,
      });
      const newActor: MockAuthActor = {
        id: newId,
        email,
        password: String(body.password || crypto.randomUUID()),
        app_metadata: {},
        token,
      };
      authUsersById.set(newId, newActor);
      authUsersByToken.set(token, newActor);
      sendJson(res, 200, {
        user: {
          id: newId,
          aud: 'authenticated',
          role: 'authenticated',
          email,
          identities: [{ id: newId, provider: 'email' }],
          app_metadata: {},
          user_metadata: body.data || {},
        },
        session: null,
      });
      return;
    }

    if (pathname.startsWith('/auth/v1/admin/users')) {
      const bodyBuf = await readBodyBuffer(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}') as Record<string, any>;
      if (req.method === 'POST') {
        const newId = crypto.randomUUID();
        const email = String(body.email || '').toLowerCase();
        const appMeta = (body.app_metadata || {}) as Record<string, unknown>;
        const token = buildMockJwt({
          sub: newId,
          email,
          role: 'authenticated',
          app_metadata: appMeta,
          exp: 2100000000,
        });
        const newActor: MockAuthActor = {
          id: newId,
          email,
          password: String(body.password || 'AuditPassword123!'),
          app_metadata: appMeta,
          token,
        };
        authUsersById.set(newId, newActor);
        authUsersByToken.set(token, newActor);
        sendJson(res, 200, {
          user: { id: newId, email, app_metadata: appMeta, user_metadata: {} },
        });
        return;
      }
      if (req.method === 'PUT') {
        const userId = pathname.split('/').pop() || '';
        const existing = authUsersById.get(userId);
        if (!existing) {
          sendJson(res, 404, { message: 'User not found' });
          return;
        }
        existing.email = String(body.email || existing.email).toLowerCase();
        existing.app_metadata = { ...existing.app_metadata, ...(body.app_metadata || {}) };
        if (body.password) existing.password = String(body.password);
        sendJson(res, 200, {
          user: {
            id: existing.id,
            email: existing.email,
            app_metadata: existing.app_metadata,
            user_metadata: {},
          },
        });
        return;
      }
    }

    // 2. Supabase Storage endpoints
    if (pathname.startsWith('/storage/v1/object/sign/')) {
      const bucket = pathname.replace('/storage/v1/object/sign/', '').split('/')[0] || '';
      const bodyBuf = await readBodyBuffer(req);
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}') as {
        paths?: string[];
        expiresIn?: number;
      };
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const out = paths.map((p) => {
        const key = `${bucket}/${p}`;
        if (!storageObjects.has(key)) {
          return { path: p, signedURL: null, error: 'Object not found' };
        }
        return {
          path: p,
          signedURL: `/object/sign/${bucket}/${p}?token=mock_signed_ttl_${body.expiresIn || 900}`,
          error: null,
        };
      });
      sendJson(res, 200, out);
      return;
    }

    if (pathname.startsWith('/storage/v1/object/')) {
      const restPath = pathname.replace('/storage/v1/object/', '');
      const slashIdx = restPath.indexOf('/');
      const bucket = slashIdx >= 0 ? restPath.slice(0, slashIdx) : restPath;
      const objPath = slashIdx >= 0 ? decodeURIComponent(restPath.slice(slashIdx + 1)) : '';

      if (req.method === 'POST') {
        const buf = await readBodyBuffer(req);
        const key = `${bucket}/${objPath}`;
        const upsertHeader = String(req.headers['x-upsert'] || 'false').toLowerCase() === 'true';
        if (!upsertHeader && storageObjects.has(key)) {
          sendJson(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
          return;
        }
        storageObjects.set(key, {
          bucket,
          mimeType: String(req.headers['content-type'] || 'application/octet-stream'),
          size: buf.byteLength,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        });
        sendJson(res, 200, { Key: key, Id: crypto.randomUUID() });
        return;
      }

      if (req.method === 'DELETE') {
        const bodyBuf = await readBodyBuffer(req);
        const body = JSON.parse(bodyBuf.toString('utf8') || '{}') as { prefixes?: string[] };
        const prefixes = Array.isArray(body.prefixes) ? body.prefixes : objPath ? [objPath] : [];
        for (const p of prefixes) {
          storageObjects.delete(`${bucket}/${p}`);
        }
        sendJson(res, 200, prefixes.map((p) => ({ name: p })));
        return;
      }
    }

    // 3. Supabase PostgREST RPC endpoints
    if (pathname.startsWith('/rest/v1/rpc/')) {
      const rpcName = pathname.replace('/rest/v1/rpc/', '');
      if (faultInjection.forceRpcMissing.has(rpcName)) {
        sendJson(res, 404, { code: 'PGRST202', message: `Could not find the function public.${rpcName}` });
        return;
      }
      const bodyBuf = await readBodyBuffer(req);
      const args = JSON.parse(bodyBuf.toString('utf8') || '{}') as Record<string, any>;

      const callerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
      const callerActor = authUsersByToken.get(callerToken);
      const callerProfile = callerActor
        ? (tables.profiles || []).find((p) => p.id === callerActor.id)
        : null;
      const isCallerSuperAdmin =
        Boolean(callerProfile) &&
        callerProfile!.role === 'super_admin' &&
        callerProfile!.is_active === true;

      if (rpcName === 'is_active_super_admin') {
        sendJson(res, 200, isCallerSuperAdmin);
        return;
      }

      if (rpcName === 'admin_list_profiles') {
        if (!isCallerSuperAdmin) {
          sendJson(res, 403, { code: '42501', message: 'Acceso denegado: se requiere un perfil super_admin activo.' });
          return;
        }
        const rank = (r: string) => (r === 'super_admin' ? 1 : r === 'coordinacion' ? 2 : 3);
        const sorted = [...(tables.profiles || [])].sort((a, b) => {
          const dr = rank(String(a.role)) - rank(String(b.role));
          if (dr !== 0) return dr;
          return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'es');
        });
        sendJson(res, 200, sorted);
        return;
      }

      if (rpcName === 'admin_update_user_access') {
        if (!isCallerSuperAdmin || !callerActor) {
          sendJson(res, 403, { code: '42501', message: 'Acceso denegado: se requiere un perfil super_admin activo.' });
          return;
        }
        const targetId = String(args.p_target_user_id || '');
        const fullName = String(args.p_full_name || '').trim();
        const role = String(args.p_role || '').trim().toLowerCase();
        const isActive = Boolean(args.p_is_active);
        const mustChange = args.p_must_change_password;

        if (targetId === callerActor.id && (!isActive || role !== 'super_admin')) {
          sendJson(res, 400, {
            code: 'P0001',
            message: 'Operación bloqueada (anti auto-bloqueo): no puedes suspender ni degradar tu propia cuenta de super_admin.',
          });
          return;
        }

        const idx = (tables.profiles || []).findIndex((p) => p.id === targetId);
        if (idx < 0) {
          sendJson(res, 404, { code: 'P0002', message: 'No existe el perfil solicitado.' });
          return;
        }
        const prev: Record<string, any> = { ...(tables.profiles[idx] || {}) };
        const nextRow: Record<string, any> = {
          ...prev,
          full_name: fullName,
          role,
          is_active: isActive,
          must_change_password:
            typeof mustChange === 'boolean' ? mustChange : Boolean(prev.must_change_password),
          updated_at: new Date().toISOString(),
        };
        tables.profiles[idx] = nextRow;

        const action =
          prev.is_active && !nextRow.is_active
            ? 'USER_SUSPENDED'
            : !prev.is_active && nextRow.is_active
              ? 'USER_REACTIVATED'
              : prev.role !== nextRow.role
                ? 'USER_ROLE_CHANGED'
                : 'USER_ACCESS_UPDATED';

        tables.user_management_audit.unshift({
          id: crypto.randomUUID(),
          actor_id: callerActor.id,
          target_user_id: nextRow.id,
          target_email: nextRow.email,
          action,
          details: { previous: prev, next: nextRow },
          created_at: new Date().toISOString(),
        });

        sendJson(res, 200, [nextRow]);
        return;
      }

      if (rpcName === 'admin_finalize_created_user') {
        if (!isCallerSuperAdmin || !callerActor) {
          sendJson(res, 403, { code: '42501', message: 'Acceso denegado: se requiere un perfil super_admin activo.' });
          return;
        }
        const targetId = String(args.p_target_user_id || '');
        const targetActor = authUsersById.get(targetId);
        if (!targetActor) {
          sendJson(res, 404, { code: 'P0002', message: 'El usuario objetivo no existe en auth.users.' });
          return;
        }
        const nowIso = new Date().toISOString();
        const createdProfile = {
          id: targetId,
          email: targetActor.email,
          full_name: String(args.p_full_name || '').trim(),
          role: String(args.p_role || 'vendedor').trim().toLowerCase(),
          is_active: true,
          must_change_password: Boolean(args.p_must_change_password),
          created_at: nowIso,
          updated_at: nowIso,
        };
        targetActor.app_metadata = {
          role: createdProfile.role,
          app_role: createdProfile.role,
          display_name: createdProfile.full_name,
          is_active: true,
        };
        tables.profiles.push(createdProfile);
        tables.user_management_audit.unshift({
          id: crypto.randomUUID(),
          actor_id: callerActor.id,
          target_user_id: createdProfile.id,
          target_email: createdProfile.email,
          action: 'USER_CREATED',
          details: {
            full_name: createdProfile.full_name,
            role: createdProfile.role,
            is_active: true,
            must_change_password: createdProfile.must_change_password,
          },
          created_at: nowIso,
        });
        sendJson(res, 200, [createdProfile]);
        return;
      }

      if (rpcName === 'rpc_sincronizar_vendedores') {
        const regs = Array.isArray(args.p_registros) ? args.p_registros : [];
        const byCode = new Map<string, Record<string, any>>();
        for (const r of regs) {
          const code = String(r.codigo_vendedor || '').trim().toUpperCase();
          if (code && r.nombre_completo) byCode.set(code, { ...r, codigo_vendedor: code });
        }
        for (const [code, item] of byCode.entries()) {
          const idx = tables.vendedores.findIndex((v) => v.codigo_vendedor === code);
          if (idx >= 0) {
            tables.vendedores[idx] = { ...tables.vendedores[idx], ...item, activo: true };
          } else {
            tables.vendedores.push({
              id: crypto.randomUUID(),
              ...item,
              activo: true,
              ultima_sincronizacion: new Date().toISOString(),
            });
          }
        }
        let desactivados = 0;
        if (args.p_desactivar_ausentes && byCode.size > 0) {
          for (const v of tables.vendedores) {
            if (v.activo && !byCode.has(v.codigo_vendedor)) {
              v.activo = false;
              desactivados++;
            }
          }
        }
        sendJson(res, 200, {
          procesados: byCode.size,
          sin_vendedor_asignado: 0,
          desactivados,
        });
        return;
      }

      if (rpcName === 'rpc_sincronizar_clientes') {
        const regs = Array.isArray(args.p_registros) ? args.p_registros : [];
        const byCode = new Map<string, Record<string, any>>();
        for (const r of regs) {
          const code = String(r.codigo_cliente || '').trim().toUpperCase();
          if (code && r.razon_social) byCode.set(code, { ...r, codigo_cliente: code });
        }
        let sinVendedor = 0;
        const faltantes = new Set<string>();
        for (const [code, item] of byCode.entries()) {
          const vend = item.codigo_vendedor
            ? tables.vendedores.find((v) => v.codigo_vendedor === item.codigo_vendedor)
            : null;
          if (item.codigo_vendedor && !vend) {
            sinVendedor++;
            faltantes.add(item.codigo_vendedor);
          }
          const enriched = {
            ...item,
            vendedor_id: vend ? vend.id : null,
            activo: true,
            ultima_sincronizacion: new Date().toISOString(),
          };
          const idx = tables.clientes.findIndex((c) => c.codigo_cliente === code);
          if (idx >= 0) {
            tables.clientes[idx] = { ...tables.clientes[idx], ...enriched };
          } else {
            tables.clientes.push({ id: crypto.randomUUID(), ...enriched });
          }
        }
        let desactivados = 0;
        if (Array.isArray(args.p_codigos_activos_totales)) {
          const activeSet = new Set(
            args.p_codigos_activos_totales.map((c: string) => String(c || '').trim().toUpperCase())
          );
          for (const c of tables.clientes) {
            if (c.activo && !activeSet.has(c.codigo_cliente)) {
              c.activo = false;
              desactivados++;
            }
          }
        }
        sendJson(res, 200, {
          procesados: byCode.size,
          sin_vendedor_asignado: sinVendedor,
          desactivados,
          codigos_vendedor_faltantes: Array.from(faltantes),
        });
        return;
      }

      if (rpcName === 'volcar_lote_cronograma') {
        const carga = args.p_carga || {};
        const filas = Array.isArray(args.p_filas) ? args.p_filas : [];
        const cargaId = crypto.randomUUID();
        let insertadas = 0;
        let duplicadas = 0;
        const insertedIds: string[] = [];

        for (const f of filas) {
          const hash = String(f.idempotency_hash || '').trim().toLowerCase();
          const dup = tables.cronograma_degustaciones.some(
            (c) =>
              c.idempotency_hash === hash &&
              c.estado !== 'RECHAZADA' &&
              c.estado !== 'CANCELADA'
          );
          if (dup) {
            duplicadas++;
            continue;
          }
          const newId = crypto.randomUUID();
          tables.cronograma_degustaciones.push({
            id: newId,
            carga_id: cargaId,
            ...f,
            idempotency_hash: hash,
            estado: 'PENDIENTE_APROBACION',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          insertadas++;
          insertedIds.push(newId);
        }

        tables.cargas_archivos.push({
          id: cargaId,
          ...carga,
          total_filas_extraidas: filas.length,
          total_filas_insertadas: insertadas,
          total_filas_duplicadas: duplicadas,
          created_at: new Date().toISOString(),
        });

        sendJson(res, 200, {
          carga_id: cargaId,
          total_recibidas: filas.length,
          total_insertadas: insertadas,
          total_duplicadas: duplicadas,
          ids_insertados: insertedIds,
        });
        return;
      }

      if (rpcName === 'ejecutar_cierre_dominical_degustaciones') {
        const cutoffYmd = String(args.p_now || new Date().toISOString()).slice(0, 10);
        let archived = 0;
        for (const s of tables.surveys) {
          if (s.type !== 'Degustacion') continue;
          const evDate = String(s.fecha_evento || s.date || '').slice(0, 10);
          if (evDate && evDate <= cutoffYmd && !s.en_historial) {
            s.en_historial = true;
            archived++;
          }
        }
        sendJson(res, 200, {
          ok: true,
          estado: 'OK',
          idempotent_noop: archived === 0,
          fecha_corte: cutoffYmd,
          registros_archivados: archived,
          timezone: args.p_timezone || 'America/Caracas',
        });
        return;
      }

      if (rpcName === 'registrar_avance_ruta_promotora') {
        const ruta = tables.rutas_promotoras.find((r) => r.id === args.p_ruta_id);
        if (!ruta) {
          sendJson(res, 404, { code: 'P0002', message: 'Ruta no encontrada' });
          return;
        }
        const nowIso = new Date().toISOString();
        if (args.p_accion === 'CHECKIN') {
          ruta.estado_ruta = 'EN_CURSO';
          ruta.checkin_at = ruta.checkin_at || nowIso;
        } else if (args.p_accion === 'CHECKOUT') {
          ruta.estado_ruta = 'COMPLETADA';
          ruta.checkin_at = ruta.checkin_at || nowIso;
          ruta.checkout_at = ruta.checkout_at || nowIso;
        }
        ruta.updated_at = nowIso;
        sendJson(res, 200, ruta);
        return;
      }

      sendJson(res, 404, { code: 'PGRST202', message: `Unmocked RPC ${rpcName}` });
      return;
    }

    // 4. Supabase PostgREST Table CRUD endpoints
    if (pathname.startsWith('/rest/v1/')) {
      const tableName = pathname.replace('/rest/v1/', '').split('/')[0] || '';
      if (faultInjection.forceTableMissing.has(tableName) || !(tableName in tables)) {
        sendJson(res, 404, {
          code: 'PGRST205',
          message: `Could not find the table 'public.${tableName}' in the schema cache`,
        });
        return;
      }

      const collection = tables[tableName]!;
      const acceptHeader = String(req.headers.accept || '');
      const preferHeader = String(req.headers.prefer || '');
      const wantsSingle = acceptHeader.includes('application/vnd.pgrst.object+json');

      if (req.method === 'GET') {
        let matched = collection.filter((row) => matchPostgrestRow(row, urlObj.searchParams));

        // Join enrichment for `clientes` -> `vendedor`
        const selectParam = urlObj.searchParams.get('select') || '*';
        if (tableName === 'clientes' && selectParam.includes('vendedor:vendedores')) {
          matched = matched.map((c) => ({
            ...c,
            vendedor: tables.vendedores.find((v) => v.id === c.vendedor_id) ?? null,
          }));
        }

        // Order
        const orderParam = urlObj.searchParams.get('order');
        if (orderParam) {
          const firstOrder = orderParam.split(',')[0] || '';
          const [col, dir] = firstOrder.split('.');
          if (col) {
            const desc = dir === 'desc';
            matched = [...matched].sort((a, b) => {
              const va = String(a[col] ?? '');
              const vb = String(b[col] ?? '');
              return desc ? vb.localeCompare(va) : va.localeCompare(vb);
            });
          }
        }

        const totalCount = matched.length;

        // Range header or limit param
        const rangeUnit = String(req.headers['range-unit'] || '');
        const rangeHeader = String(req.headers.range || '');
        const limitParam = urlObj.searchParams.get('limit');
        if (rangeHeader && (rangeUnit === 'items' || /^\d+-\d+$/.test(rangeHeader))) {
          const m = rangeHeader.match(/(\d+)-(\d+)/);
          if (m) {
            const from = Number(m[1]);
            const to = Number(m[2]);
            matched = matched.slice(from, to + 1);
          }
        } else if (limitParam) {
          matched = matched.slice(0, Math.max(0, Number(limitParam)));
        } else {
          matched = matched.slice(0, 1000);
        }

        const extraHeaders: Record<string, string> = {};
        if (preferHeader.includes('count=exact')) {
          const endIdx = matched.length > 0 ? matched.length - 1 : 0;
          extraHeaders['Content-Range'] =
            totalCount > 0 ? `0-${endIdx}/${totalCount}` : `*/0`;
        }

        if (wantsSingle) {
          if (matched.length === 0) {
            // maybeSingle uses application/vnd.pgrst.object+json too; PostgREST returns 406 on 0 rows
            sendJson(res, 406, {
              code: 'PGRST116',
              details: 'The result contains 0 rows',
              message: 'JSON object requested, multiple (or no) rows returned',
            });
            return;
          }
          sendJson(res, 200, matched[0], extraHeaders);
          return;
        }

        sendJson(res, 200, matched, extraHeaders);
        return;
      }

      if (req.method === 'POST') {
        const bodyBuf = await readBodyBuffer(req);
        const rawPayload = JSON.parse(bodyBuf.toString('utf8') || '{}');
        const items = Array.isArray(rawPayload) ? rawPayload : [rawPayload];
        const onConflict = urlObj.searchParams.get('on_conflict') || '';
        const isUpsert = preferHeader.includes('resolution=merge-duplicates');
        const saved: Record<string, any>[] = [];

        for (const item of items) {
          // Enforce unique constraints in memory
          if (tableName === 'asistencias_jornada') {
            const dup = collection.find(
              (r) =>
                r.fecha_jornada === item.fecha_jornada && r.promotora_id === item.promotora_id
            );
            if (dup && !isUpsert) {
              sendJson(res, 409, {
                code: '23505',
                message: 'duplicate key value violates unique constraint "uq_asistencias_jornada_fecha_promotora"',
              });
              return;
            }
          }

          if (tableName === 'solicitudes_contraloria') {
            const dup = collection.find(
              (r) =>
                String(r.codigo_correlativo).toUpperCase() ===
                String(item.codigo_correlativo).toUpperCase()
            );
            if (dup && !isUpsert) {
              sendJson(res, 409, {
                code: '23505',
                message: 'duplicate key value violates unique constraint "solicitudes_contraloria_codigo_correlativo_key"',
              });
              return;
            }
          }

          if (isUpsert && onConflict) {
            const conflictCols = onConflict.split(',').map((s) => s.trim());
            const existingIdx = collection.findIndex((r) =>
              conflictCols.every((col) => r[col] === item[col])
            );
            if (existingIdx >= 0) {
              const merged = {
                ...collection[existingIdx],
                ...item,
                updated_at: new Date().toISOString(),
              };
              collection[existingIdx] = merged;
              saved.push(merged);
              continue;
            }
          }

          const newRow = {
            id: item.id || crypto.randomUUID(),
            created_at: item.created_at || new Date().toISOString(),
            ...item,
          };
          if (tableName === 'surveys' && newRow.type === 'Degustacion' && !newRow.fecha_evento) {
            newRow.fecha_evento = String(newRow.date || '').slice(0, 10) || null;
          }
          collection.push(newRow);
          saved.push(newRow);
        }

        sendJson(res, 201, wantsSingle ? saved[0] : saved);
        return;
      }

      if (req.method === 'PATCH') {
        const bodyBuf = await readBodyBuffer(req);
        const patch = JSON.parse(bodyBuf.toString('utf8') || '{}') as Record<string, any>;
        const updated: Record<string, any>[] = [];
        for (let i = 0; i < collection.length; i++) {
          if (matchPostgrestRow(collection[i]!, urlObj.searchParams)) {
            collection[i] = {
              ...collection[i],
              ...patch,
              updated_at: new Date().toISOString(),
            };
            updated.push(collection[i]!);
          }
        }
        sendJson(res, 200, wantsSingle ? updated[0] ?? null : updated);
        return;
      }

      if (req.method === 'DELETE') {
        const removed: Record<string, any>[] = [];
        for (let i = collection.length - 1; i >= 0; i--) {
          if (matchPostgrestRow(collection[i]!, urlObj.searchParams)) {
            removed.push(...collection.splice(i, 1));
          }
        }
        sendJson(res, 200, removed);
        return;
      }
    }

    sendJson(res, 404, { error: `Mock route not found: ${pathname}` });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    port: addr.port,
    tables,
    storageObjects,
    recordedRequests,
    faultInjection,
    resetSeedData,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
