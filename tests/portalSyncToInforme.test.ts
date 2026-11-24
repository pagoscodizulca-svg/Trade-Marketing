import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { buildApiOriginGuard, buildCorsMiddleware } from '../src/server/securityMiddleware';
import {
  generateClientSubmissionId,
  getCaracasIsoTimestamp,
} from '../src/services/promotoraCampoService';

const ROOT_DIR = process.cwd();

test('Portal Promotoras -> Módulo 1 Informes: regresión de sincronización, zona horaria, CORS e idempotencia', async (t) => {
  await t.test('getCaracasIsoTimestamp preserva la fecha de Venezuela (UTC-4) después de las 8:00 p. m.', () => {
    // 2026-11-24T00:41:47.758Z === 2026-11-23 20:41:47.758 hora Caracas (UTC-4)
    const lateNightVe = new Date('2026-11-24T00:41:47.758Z');
    const caracasIso = getCaracasIsoTimestamp(lateNightVe);

    assert.equal(caracasIso, '2026-11-23T20:41:47.758-04:00');
    assert.equal(caracasIso.slice(0, 10), '2026-11-23');
    assert.equal(new Date(caracasIso).getTime(), lateNightVe.getTime());
  });

  await t.test('generateClientSubmissionId genera UUIDs válidos y únicos por borrador', () => {
    const a = generateClientSubmissionId();
    const b = generateClientSubmissionId();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    assert.match(a, uuidRe);
    assert.match(b, uuidRe);
    assert.notEqual(a, b);
  });

  await t.test('buildApiOriginGuard responde 204 a OPTIONS same-host y bloquea orígenes no autorizados con 403', async () => {
    const app = express();
    app.use('/api', buildCorsMiddleware({ allowedOrigins: [], isProduction: true }));
    app.use('/api', buildApiOriginGuard({ allowedOrigins: [], isProduction: true }));
    app.get('/api/tasa-bcv', (_req, res) => res.json({ ok: true }));

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;

      const sameOriginOpt = await fetch(`${base}/api/tasa-bcv`, {
        method: 'OPTIONS',
        headers: {
          Origin: base,
          'Access-Control-Request-Method': 'GET',
        },
      });
      assert.equal(sameOriginOpt.status, 204);
      assert.equal(sameOriginOpt.headers.get('access-control-allow-origin'), base);

      const evilOpt = await fetch(`${base}/api/tasa-bcv`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      });
      assert.equal(evilOpt.status, 403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await t.test('requireAttendanceActorAuth prioriza public.promotoras sobre public.staff (evita P0 PROMOTORA_STAFF_UNLINKED)', () => {
    const src = fs.readFileSync(
      path.join(ROOT_DIR, 'src', 'server', 'supabaseAdminAuth.ts'),
      'utf8'
    );
    const fnStart = src.indexOf('export async function requireAttendanceActorAuth');
    assert.ok(fnStart > 0, 'Debe existir requireAttendanceActorAuth');
    const fnBody = src.slice(fnStart, fnStart + 9000);
    const promIdx = fnBody.indexOf(".from('promotoras')");
    const staffIdx = fnBody.indexOf(".from('staff')");

    assert.ok(promIdx > 0, 'requireAttendanceActorAuth debe consultar public.promotoras');
    assert.ok(
      staffIdx === -1 || promIdx < staffIdx,
      'public.promotoras debe consultarse ANTES del respaldo legacy public.staff'
    );
  });

  await t.test('Migración SQL 20261206000100: idempotencia, Realtime y RLS seguro sin DDL destructivo', () => {
    const sqlPath = path.join(
      ROOT_DIR,
      'supabase',
      'migrations',
      '20261206000100_portal_sync_idempotencia_realtime_precios.sql'
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');

    assert.match(sql, /idx_inventory_client_submission_id_unique/i);
    assert.match(sql, /idx_prices_client_submission_id_unique/i);
    assert.match(sql, /idx_surveys_client_submission_id_unique/i);
    assert.match(sql, /ALTER PUBLICATION supabase_realtime ADD TABLE/i);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tasas_bcv/i);
    assert.match(sql, /REVOKE ALL ON TABLE public\.tasas_bcv FROM PUBLIC, anon/i);
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
    assert.doesNotMatch(sql, /auth\.role\(\)/i);
    assert.doesNotMatch(sql, /user_metadata/i);
  });
});
