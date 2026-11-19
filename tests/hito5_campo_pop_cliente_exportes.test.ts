import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Request, Response } from 'express';
import { analyzeMigrations, formatIssues, type MigrationFile } from './support/sqlMigrationAnalyzer';
import { runStaticCertification } from '../scripts/certifySchemaProduction';
import {
  calculateHaversineDistanceMeters,
  captureBrowserGeolocation,
  evaluateGeofenceCheck,
  normalizeGeofenceRadiusMeters,
} from '../src/utils/geofenceHaversine';
import {
  clearMemoryPortalQueueForTests,
  computeExponentialBackoffMs,
  enqueuePortalAction,
  flushPortalOfflineQueue,
  listPendingPortalActions,
} from '../src/services/portalOfflineQueueService';
import { FEATURE_FLAGS } from '../src/config/featureFlags';
import {
  computeSlaDeadlineIso,
  createUploadIncidenciaEvidenceHandler,
  type IncidenciasEvidencesGateway,
  type IncidenciaPdvDbRow,
} from '../src/server/incidenciasEvidencesHandler';
import { evaluateIncidenciaSlaStatus } from '../src/services/popIncidenciasService';
import {
  buildDocxReportBuffer,
  buildExecutiveWorkbookBuffer,
  neutralizeFormulaInjection,
} from '../src/utils/excelWordExport';
import { mapClientePortalPayload } from '../src/services/clientePortalService';
import { navigateTo, pathForTab, resolveRoute } from '../src/utils/appRouter';
import { MODULE_ALLOWED_ROLES } from '../src/components/common/Header';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase', 'migrations');
const HITO5 = '20261118000800_hito5_campo_gps_pop_incidencias_y_portal_cliente.sql';

function loadMigrations(): MigrationFile[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

function mockRes() {
  const state: { status: number; body: any } = { status: 0, body: null };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

function metaHeader(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

test('Hito 5 · migración SQL 20261118000800 (estática)', async (t) => {
  await t.test('analizador: 0 errores, sin DDL destructivo, RLS + FORCE en tablas nuevas', () => {
    const files = loadMigrations();
    assert.ok(files.some((f) => f.name === HITO5));
    const result = analyzeMigrations(files);
    assert.equal(result.errors.length, 0, formatIssues(result.errors));

    const sql = files.find((f) => f.name === HITO5)!.sql;
    assert.ok(!/\bDROP\s+TABLE\b/i.test(sql));
    assert.ok(!/\bTRUNCATE\b/i.test(sql));
    for (const table of [
      'ejecuciones_pdv_promotora',
      'alertas_geocerca_auditoria',
      'material_pop_inventario',
      'material_pop_entregas',
      'incidencias_pdv',
      'cliente_portal_accesos',
    ]) {
      assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
      assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`));
    }
    assert.match(sql, /'incidencias-evidencias'[\s\S]*?false/);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.alertas_geocerca_auditoria/);
    assert.ok(!/GRANT[^;]*DELETE[^;]*alertas_geocerca_auditoria/i.test(sql));
  });

  await t.test('certificador estático: 22+ migraciones y PASS', () => {
    const report = runStaticCertification(MIGRATIONS_DIR);
    assert.ok(report.migrationCount >= 22);
    assert.equal(report.passed, true);
  });
});

test('Hito 5 · B-08 Haversine, geocerca y cola offline', async (t) => {
  await t.test('distancia Haversine conocida y dentro/fuera de geocerca', () => {
    assert.equal(calculateHaversineDistanceMeters(10, -71, 10, -71), 0);
    // 0.001° de latitud ≈ 111.19 m
    const d = calculateHaversineDistanceMeters(10, -71, 10.001, -71);
    assert.ok(d > 110 && d < 112, `d=${d}`);

    const inside = evaluateGeofenceCheck({
      capturedLat: 10.0005, capturedLng: -71, pdvLat: 10, pdvLng: -71, allowedRadiusMeters: 150,
    });
    assert.equal(inside.insideGeofence, true);
    const outside = evaluateGeofenceCheck({
      capturedLat: 10.01, capturedLng: -71, pdvLat: 10, pdvLng: -71, allowedRadiusMeters: 150,
    });
    assert.equal(outside.insideGeofence, false);
    assert.equal(outside.requiresAuditJustification, true);
    assert.ok(outside.excessMeters > 900);

    const noCoords = evaluateGeofenceCheck({ capturedLat: 10, capturedLng: -71 });
    assert.equal(noCoords.hasPdvCoordinates, false);
    assert.equal(noCoords.insideGeofence, null);
    assert.equal(normalizeGeofenceRadiusMeters(undefined), 150);
    assert.equal(normalizeGeofenceRadiusMeters(5), 20);
    assert.throws(() => calculateHaversineDistanceMeters(95, 0, 0, 0));
  });

  await t.test('captura GPS con API inyectada y errores de permiso', async () => {
    const ok = await captureBrowserGeolocation({
      geolocationApi: {
        getCurrentPosition: (success: PositionCallback) =>
          success({ coords: { latitude: 10.5, longitude: -71.6, accuracy: 12.34 } } as GeolocationPosition),
      } as unknown as Geolocation,
    });
    assert.equal(ok.lat, 10.5);
    assert.equal(ok.accuracyMeters, 12.3);
    await assert.rejects(
      captureBrowserGeolocation({
        geolocationApi: {
          getCurrentPosition: (_s: PositionCallback, err: PositionErrorCallback) =>
            err({ code: 1 } as GeolocationPositionError),
        } as unknown as Geolocation,
      }),
      /denegado/
    );
    await assert.rejects(captureBrowserGeolocation({ geolocationApi: null }), /no soporta/);
  });

  await t.test('backoff exponencial acotado y cola offline idempotente', async () => {
    const noJitter = { jitterRatio: 0, baseDelayMs: 1000, maxDelayMs: 10_000 };
    assert.equal(computeExponentialBackoffMs(0, noJitter), 1000);
    assert.equal(computeExponentialBackoffMs(2, noJitter), 4000);
    assert.equal(computeExponentialBackoffMs(10, noJitter), 10_000);

    clearMemoryPortalQueueForTests();
    const a = await enqueuePortalAction({
      id: 'sub-a', rutaId: 'r1', accion: 'CHECKIN', clienteNombre: 'PDV A', lat: 1, lng: 1, accuracyMeters: 5, nowMs: 1000,
    });
    await enqueuePortalAction({ id: 'sub-a', rutaId: 'r1', accion: 'CHECKIN', clienteNombre: 'PDV A', lat: 1, lng: 1, accuracyMeters: 5, nowMs: 1000 });
    await enqueuePortalAction({ id: 'sub-b', rutaId: 'r2', accion: 'CHECKOUT', clienteNombre: 'PDV B', lat: null, lng: null, accuracyMeters: null, nowMs: 2000 });
    assert.equal(a.attemptCount, 0);
    assert.equal((await listPendingPortalActions()).length, 2, 'mismo id no duplica');

    // 1er flush: sub-a falla -> backoff; sub-b sincroniza
    const seen: string[] = [];
    const r1 = await flushPortalOfflineQueue(
      async (act) => {
        if (act.id === 'sub-a') throw new Error('Failed to fetch');
        seen.push(act.id);
      },
      { nowMs: 5000, jitterRatio: 0 } as never
    );
    assert.equal(r1.succeeded, 1);
    assert.equal(r1.failed, 1);
    assert.equal(r1.remaining, 1);
    const [pend] = await listPendingPortalActions();
    assert.equal(pend.attemptCount, 1);
    assert.ok(pend.nextRetryAtMs > 5000);

    // antes del plazo no reintenta; con red recuperada (force) sí
    const early = await flushPortalOfflineQueue(async () => {}, { nowMs: 5001 });
    assert.equal(early.attempted, 0);
    const forced = await flushPortalOfflineQueue(async () => {}, { forceIgnoreSchedule: true });
    assert.equal(forced.succeeded, 1);
    assert.equal(forced.remaining, 0);
  });
});

test('Hito 5 · P-07 flags y M-01 POP/Incidencias', async (t) => {
  await t.test('los 4 flags de Módulo 1 están habilitados', () => {
    assert.deepEqual(Object.values(FEATURE_FLAGS), [true, true, true, true]);
  });

  await t.test('SLA por severidad y estado de vencimiento', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    assert.equal(computeSlaDeadlineIso('CRITICA', base).slaHoras, 4);
    assert.equal(computeSlaDeadlineIso('ALTA', base).slaHoras, 12);
    assert.equal(computeSlaDeadlineIso('MEDIA', base).slaHoras, 24);
    assert.equal(computeSlaDeadlineIso('BAJA', base).slaVenceEnIso, '2026-01-04T00:00:00.000Z');

    const overdue = evaluateIncidenciaSlaStatus(
      { estado: 'ABIERTA', slaVenceEn: '2026-01-01T04:00:00.000Z', resueltaEn: null },
      Date.parse('2026-01-01T10:00:00.000Z')
    );
    assert.equal(overdue.isOverdue, true);
    const inSla = evaluateIncidenciaSlaStatus(
      { estado: 'RESUELTA', slaVenceEn: '2026-01-01T04:00:00.000Z', resueltaEn: '2026-01-01T02:00:00.000Z' },
      Date.parse('2026-01-02T00:00:00.000Z')
    );
    assert.equal(inSla.isOverdue, false);
  });

  await t.test('handler de foto: magic bytes, contraloría solo lectura, rollback y sede', async () => {
    const inserted: IncidenciaPdvDbRow[] = [];
    const stored = new Set<string>();
    let failInsert = false;
    const gateway: IncidenciasEvidencesGateway = {
      async uploadPrivateObject({ path: p }) { stored.add(p); },
      async deletePrivateObjects(_b, paths) { paths.forEach((p) => stored.delete(p)); },
      async insertIncidenciaRow(params) {
        if (failInsert) throw new Error('db down');
        const row = {
          id: '99999999-9999-4999-8999-999999999991',
          codigo_incidencia: 'INC-0001',
          sucursal: params.sucursal,
          foto_storage_path: params.storagePath,
          severidad: params.severidad,
          sla_horas: params.slaHoras,
        } as unknown as IncidenciaPdvDbRow;
        inserted.push(row);
        return row;
      },
      async findIncidenciasByIds() { return []; },
      async createSignedUrls() { return {}; },
    };
    const handler = createUploadIncidenciaEvidenceHandler(() => gateway);
    const meta = metaHeader({
      pdvNombre: 'PDV Test', tipoIncidencia: 'QUIEBRE_STOCK', severidad: 'CRITICA', descripcion: 'Sin stock total',
    });
    const mkReq = (role: string, sucursal: string, body: Buffer) =>
      ({
        authUser: { id: '88888888-8888-4888-8888-888888888810', email: 'a@b.c', appRole: role, sucursal, isCoordinatorOrAdmin: false, accessToken: 'tok' },
        headers: { 'x-incidencia-meta': meta },
        body,
      }) as unknown as Request;

    let m = mockRes();
    await handler(mkReq('promotora', 'ZULIA', JPEG), m.res);
    assert.equal(m.state.status, 201);
    assert.equal(inserted[0].sla_horas, 4);
    assert.equal(inserted[0].sucursal, 'ZULIA');
    assert.match(String(inserted[0].foto_storage_path), /^incidencias\/ZULIA\/\d{4}-\d{2}-\d{2}\/.+\.jpg$/);

    m = mockRes();
    await handler(mkReq('contraloria', 'GLOBAL', JPEG), m.res);
    assert.equal(m.state.status, 403);

    m = mockRes();
    await handler(mkReq('promotora', 'ZULIA', Buffer.from('<svg xmlns="x"></svg>padding-padding')), m.res);
    assert.equal(m.state.status, 415);

    const before = stored.size;
    failInsert = true;
    m = mockRes();
    await handler(mkReq('promotora', 'VALENCIA', JPEG), m.res);
    assert.equal(m.state.status, 500);
    assert.equal(stored.size, before, 'rollback del objeto de Storage ante fallo de BD');
  });
});

test('Hito 5 · M-02/M-03/M-04 exportes, cliente y enrutamiento', async (t) => {
  await t.test('neutraliza inyección de fórmulas', () => {
    assert.equal(neutralizeFormulaInjection('=1+1'), "'=1+1");
    assert.equal(neutralizeFormulaInjection('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(neutralizeFormulaInjection('Normal'), 'Normal');
  });

  await t.test('.xlsx real: hojas, formatos y texto literal', async () => {
    const buf = await buildExecutiveWorkbookBuffer({
      title: 'Prueba',
      generatedBy: 'test',
      sheets: [
        {
          name: 'Datos',
          headers: ['Nombre', 'Monto'],
          rows: [['=HYPERLINK("http://x")', 12.5], ['Ok', 3]],
          currencyColumns: [1],
        },
      ],
    });
    const bytes = Buffer.from(buf as ArrayBuffer);
    assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK');

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as never);
    const ws = wb.getWorksheet('Datos')!;
    assert.ok(ws);
    assert.equal(ws.getRow(4).getCell(1).value, 'Nombre');
    const evil = ws.getRow(5).getCell(1).value;
    assert.equal(typeof evil, 'string');
    assert.ok(String(evil).startsWith("'="), 'fórmula neutralizada');
    assert.equal(ws.getRow(5).getCell(2).value, 12.5);
    assert.match(String(ws.getRow(5).getCell(2).numFmt), /\$/);
  });

  await t.test('.docx real: ZIP con word/document.xml y contenido', async () => {
    const buf = await buildDocxReportBuffer({
      title: 'Acta de Prueba',
      metadata: [['Campo', 'Valor']],
      sections: [{ heading: 'Detalle', table: { headers: ['A'], rows: [['dato-unico-123']] } }],
      pazYSalvo: { codigo: 'PYS-MP-07-0099', sha256: 'a'.repeat(64) },
    });
    const bytes = Buffer.from(buf);
    assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    assert.ok(xml.includes('Acta de Prueba'));
    assert.ok(xml.includes('dato-unico-123'));
    assert.ok(xml.includes('PYS-MP-07-0099'));
  });

  await t.test('portal cliente: mapeo solo lectura y KPIs', () => {
    const r = mapClientePortalPayload({
      pdvs_autorizados: [{ id: 'p1', nombre_comercial: 'PDV 1', cadena_nombre: 'Cadena X' }],
      activaciones: [
        { id: 'a1', estado: 'COMPLETADA', muestras_entregadas: 40, ventas_asistidas_unidades: 8 },
        { id: 'a2', estado: 'APROBADA', muestras_entregadas: 0, ventas_asistidas_unidades: 0 },
      ],
    });
    assert.equal(r.kpis.totalPdvs, 1);
    assert.equal(r.kpis.completadas, 1);
    assert.equal(r.kpis.cumplimientoPct, 50);
    assert.equal(r.kpis.muestras, 40);
    assert.deepEqual(mapClientePortalPayload(null).activaciones, []);
  });

  await t.test('RBAC: cliente no accede a módulos de Torre; POP lectura para contraloría', () => {
    for (const roles of Object.values(MODULE_ALLOWED_ROLES)) {
      assert.ok(!(roles as readonly string[]).includes('cliente'));
    }
    assert.ok(MODULE_ALLOWED_ROLES.pop_incidencias.includes('contraloria'));
    assert.ok(!MODULE_ALLOWED_ROLES.pop_incidencias.includes('vendedor'));
  });

  await t.test('enrutador: URL <-> vista bidireccional', () => {
    for (const tab of Object.keys(MODULE_ALLOWED_ROLES) as Array<keyof typeof MODULE_ALLOWED_ROLES>) {
      const r = resolveRoute(pathForTab(tab));
      assert.deepEqual(r, { kind: 'tab', tab });
    }
    assert.deepEqual(resolveRoute('/portal/ruta'), { kind: 'standalone', route: 'portal' });
    assert.deepEqual(resolveRoute('/Cliente/'), { kind: 'standalone', route: 'cliente' });
    assert.deepEqual(resolveRoute('/usuarios'), { kind: 'tab', tab: 'gestion_usuarios' });
    assert.deepEqual(resolveRoute('/'), { kind: 'home' });
    assert.deepEqual(resolveRoute('/kpis?x=1'), { kind: 'tab', tab: 'kpis_trazabilidad' });
    assert.doesNotThrow(() => navigateTo('/kpis')); // sin window: no-op
  });
});
