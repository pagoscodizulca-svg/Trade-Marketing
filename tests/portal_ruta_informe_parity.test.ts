import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  pathForPortalSubTab,
  resolvePortalSubTab,
  resolveRoute,
} from '../src/utils/appRouter';
import {
  buildSanitizedPortalStoragePath,
  validatePortalImageFile,
} from '../src/services/promotoraCampoService';
import { filterAttendanceViewModels } from '../src/components/field/AttendanceEvidenceSubTab';
import { PromotoraRutaPortalView } from '../src/components/portal/PromotoraRutaPortalView';
import type { DailyPromotoraAttendanceViewModel } from '../src/types/attendanceEvidences';
import {
  extractVerifiedProfileFromAuthUser,
  type VerifiedAuthProfile,
} from '../src/services/authService';
import type { User as SupabaseAuthUser } from '@supabase/supabase-js';

test('Portal Ruta Parity · appRouter resuelve todas las subrutas /portal/* sin romper /portal', () => {
  assert.deepEqual(resolveRoute('/portal'), { kind: 'standalone', route: 'portal' });
  assert.deepEqual(resolveRoute('/portal/ruta'), { kind: 'standalone', route: 'portal' });
  assert.deepEqual(resolveRoute('/portal/asistencia'), { kind: 'standalone', route: 'portal' });
  assert.deepEqual(resolveRoute('/portal/checkin'), { kind: 'standalone', route: 'portal' });
  assert.deepEqual(resolveRoute('/portal/inventario'), { kind: 'standalone', route: 'portal' });
  assert.deepEqual(resolveRoute('/portal/encuestas'), { kind: 'standalone', route: 'portal' });
  assert.deepEqual(resolveRoute('/portal/precios'), { kind: 'standalone', route: 'portal' });
  assert.deepEqual(resolveRoute('/portal/merchandising'), { kind: 'standalone', route: 'portal' });
  assert.deepEqual(resolveRoute('/portal/perfil'), { kind: 'standalone', route: 'portal' });

  assert.equal(resolvePortalSubTab('/portal'), 'ruta');
  assert.equal(resolvePortalSubTab('/portal/ruta'), 'ruta');
  assert.equal(resolvePortalSubTab('/portal/checkin'), 'asistencia');
  assert.equal(resolvePortalSubTab('/portal/asistencia'), 'asistencia');
  assert.equal(resolvePortalSubTab('/portal/inventario'), 'inventario');
  assert.equal(resolvePortalSubTab('/portal/encuestas'), 'encuestas');
  assert.equal(resolvePortalSubTab('/portal/precios'), 'precios');
  assert.equal(resolvePortalSubTab('/portal/merchandising'), 'merchandising');
  assert.equal(resolvePortalSubTab('/portal/perfil'), 'perfil');
  assert.equal(pathForPortalSubTab('inventario'), '/portal/inventario');
});

test('Portal Ruta Parity · validación estricta de evidencias (MIME <= 5MB) y rutas sanitizadas sin path traversal', () => {
  const validPng = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], {
    type: 'image/png',
  });
  assert.deepEqual(validatePortalImageFile(validPng), { mimeType: 'image/png', ext: 'png' });

  const invalidSvg = new Blob(['<svg></svg>'], { type: 'image/svg+xml' });
  assert.throws(() => validatePortalImageFile(invalidSvg), /Formato de imagen no permitido/);

  const emptyBlob = new Blob([], { type: 'image/jpeg' });
  assert.throws(() => validatePortalImageFile(emptyBlob), /vacía/);

  const oversized = new Blob([new Uint8Array(5 * 1024 * 1024 + 10)], { type: 'image/jpeg' });
  assert.throws(() => validatePortalImageFile(oversized), /5 MB/);

  const safePath = buildSanitizedPortalStoragePath({
    promotoraId: '1',
    modulo: 'asistencia',
    ext: 'png',
    prefix: 'qa-test',
  });
  assert.match(safePath, /^1\/asistencia\/qa-test_[0-9a-f-]+\.png$/);
  assert.ok(!safePath.includes('..'));
  assert.ok(!safePath.startsWith('/'));

  assert.throws(
    () =>
      buildSanitizedPortalStoragePath({
        promotoraId: '../../etc',
        modulo: 'asistencia',
        ext: 'png',
      }),
    /inválido|path-traversal/i
  );
});

test('Portal Ruta Parity · filterAttendanceViewModels filtra por región, promotora y fechas sin fallar ante campos vacíos', () => {
  const rows: DailyPromotoraAttendanceViewModel[] = [
    {
      key: '2026-11-23__1',
      asistenciaId: 'a1',
      fechaJornada: '2026-11-23',
      fechaSlash: '23/11/2026',
      fechaLongEs: 'LUNES 23 DE NOVIEMBRE DE 2026',
      promotoraId: '1',
      promotoraNombre: 'Nicole Godoy',
      promotoraInitials: 'NG',
      promotoraEmail: 'godoyaraujonicole@gmail.com',
      pdvNombre: '351 EUROMARKET, C.A',
      zona: 'CORO',
      region: 'Occidente',
      perfilAplicado: 'FIJA',
      perfilFuente: 'SNAPSHOT_HISTORICO',
      compliance: {
        perfilAplicado: 'FIJA',
        uploadedCount: 1,
        requiredCount: 2,
        fractionLabel: '1/2',
        status: 'INCOMPLETA',
        statusLabel: 'Incompleta',
      },
      evidencesBySlot: {},
    },
    {
      key: '2026-11-22__25',
      asistenciaId: 'a2',
      fechaJornada: '2026-11-22',
      fechaSlash: '22/11/2026',
      fechaLongEs: 'DOMINGO 22 DE NOVIEMBRE DE 2026',
      promotoraId: '25',
      promotoraNombre: 'Promotora Valencia',
      promotoraInitials: 'PV',
      promotoraEmail: 'val@codizulca.com',
      pdvNombre: 'KROMI MARKET',
      zona: 'NAGUANAGUA',
      region: 'Valencia',
      perfilAplicado: 'EVENTUAL',
      perfilFuente: 'SNAPSHOT_HISTORICO',
      compliance: {
        perfilAplicado: 'EVENTUAL',
        uploadedCount: 4,
        requiredCount: 4,
        fractionLabel: '4/4',
        status: 'COMPLETA',
        statusLabel: 'Completa',
      },
      evidencesBySlot: {},
    },
  ];

  assert.equal(filterAttendanceViewModels(rows, { regionFilter: 'Occidente' }).length, 1);
  assert.equal(filterAttendanceViewModels(rows, { regionFilter: 'Valencia' }).length, 1);
  assert.equal(filterAttendanceViewModels(rows, { promoterFilter: '1' }).length, 1);
  assert.equal(
    filterAttendanceViewModels(rows, { dateFrom: '2026-11-23', dateTo: '2026-11-23' }).length,
    1
  );
  assert.equal(filterAttendanceViewModels(rows, { searchQuery: null }).length, 2);
});

test('Portal Ruta Parity · SSR de PromotoraRutaPortalView renderiza shell 6 pestañas y controles Super Admin', () => {
  const adminProfile = extractVerifiedProfileFromAuthUser({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@codizulca.com',
    app_metadata: {
      role: 'super_admin',
      app_role: 'super_admin',
      sucursal: 'GLOBAL',
      display_name: 'Admin CODIZULCA',
    },
    user_metadata: {},
  } as unknown as SupabaseAuthUser) as VerifiedAuthProfile;
  assert.ok(adminProfile);
  const html = renderToStaticMarkup(
    React.createElement(PromotoraRutaPortalView, {
      initialProfile: adminProfile,
      initialRoutes: [],
    })
  );
  assert.match(html, /Codizulca/);
  assert.match(html, /data-testid="portal-tab-ruta"/);
  assert.match(html, /data-testid="portal-tab-asistencia"/);
  assert.match(html, /data-testid="portal-tab-encuestas"/);
  assert.match(html, /data-testid="portal-tab-precios"/);
  assert.match(html, /data-testid="portal-tab-inventario"/);
  assert.match(html, /data-testid="portal-tab-merchandising"/);
  assert.match(html, /data-testid="portal-super-admin-banner"/);
});

test('Portal Ruta Parity · auditoría estática de seguridad en migración 20261130000200', () => {
  const sqlPath = path.resolve(
    'supabase/migrations/20261130000200_integracion_portal_ruta_informe.sql'
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const sqlNoComments = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(sql, /uterioexpfweghxfbvoa\.supabase\.co/i);
  assert.doesNotMatch(sqlNoComments, /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(sqlNoComments, /\bDROP\s+TABLE\b|\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /SERVICE_ROLE_KEY/i);
  assert.match(sql, /TO\s+authenticated/i);
  assert.match(sql, /REVOKE\s+ALL\s+ON\s+TABLE\s+public\.inventory\s+FROM\s+PUBLIC,\s*anon/i);
  assert.match(sql, /asistencia-evidencias/);
  assert.match(sql, /5242880/);
});
