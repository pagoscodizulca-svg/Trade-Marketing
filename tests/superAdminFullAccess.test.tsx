import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Request, Response } from 'express';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient, User as SupabaseAuthUser } from '@supabase/supabase-js';
import {
  extractVerifiedProfileFromAuthUser,
  type VerifiedAuthProfile,
} from '../src/services/authService';
import {
  canAccessModule,
  canAccessPromotoraPortal,
  canBypassFieldGeofence,
  DASHBOARD_MODULE_ALLOWED_ROLES,
  isSuperAdminProfile,
  type DashboardModuleId,
} from '../src/utils/permissions';
import { PromotoraRutaPortalView } from '../src/components/portal/PromotoraRutaPortalView';
import {
  isVerifiedServerSuperAdmin,
  requireCoordinatorOrAdminAuth,
  requireSuperAdminAuth,
} from '../src/server/supabaseAdminAuth';
import {
  canAccessChoferMode,
  canAccessOficinaMode,
  isRutaSuperAdmin,
  resolveAllowedModes,
  resolveEffectiveMode,
  verifyRutaProfileAccess,
} from '../ruta-degustacion/src/services/supabaseAuth';
import type { RutaPromotoraRecord } from '../src/types/degustacionesPipeline';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20261122000100_grant_super_admin_trade_marketing.sql'
);

const ALL_MODULES = Object.keys(DASHBOARD_MODULE_ALLOWED_ROLES) as DashboardModuleId[];

function createMockExpressRes() {
  let statusCode = 200;
  let jsonBody: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return res;
    },
  } as unknown as Response;
  return {
    res,
    getStatus: () => statusCode,
    getBody: () => jsonBody as Record<string, unknown>,
  };
}

test('Escenario 1 (Super Admin) · admin@codizulca.com posee acceso irrestricto a Dashboard, /portal (Modo Supervisión Global) y /logistica/', async () => {
  const authUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'ADMIN@CODIZULCA.COM',
    app_metadata: {
      role: 'super_admin',
      app_role: 'super_admin',
      sucursal: 'GLOBAL',
      display_name: 'Administrador General CODIZULCA',
    },
    user_metadata: {},
  } as unknown as SupabaseAuthUser;

  const verified = extractVerifiedProfileFromAuthUser(authUser);
  assert.ok(verified, 'Debe extraer perfil verificado de super_admin');
  assert.equal(verified.email, 'admin@codizulca.com');
  assert.equal(verified.iamRole, 'super_admin');
  assert.equal(verified.sucursal, 'GLOBAL');
  assert.equal(verified.staffId, null);
  assert.equal(isSuperAdminProfile(verified), true);
  assert.equal(canBypassFieldGeofence(verified), true);
  assert.equal(canAccessPromotoraPortal(verified), true, 'Super admin entra a /portal sin fila en staff');

  for (const mod of ALL_MODULES) {
    assert.equal(canAccessModule(verified, mod), true, `Super admin debe acceder al módulo ${mod}`);
  }

  // Render SSR de /portal en Modo Supervisión Global sin errores null/undefined
  const sampleRoutes: RutaPromotoraRecord[] = [
    {
      id: 'aaaaaaaa-1111-4111-8111-111111111101',
      cronograma_id: 'bbbbbbbb-1111-4111-8111-111111111101',
      promotora_id: 'cccccccc-1111-4111-8111-111111111101',
      promotora_nombre: 'María González Zulia',
      promotora_email: 'maria.zulia@codizulca.com',
      fecha: '2026-11-20',
      turno: 'MAÑANA',
      hora_inicio: '09:00',
      hora_fin: '13:00',
      cliente_nombre: 'HIPERMERCADO MARACAIBO NORTE',
      cliente_codigo: 'ZUL-001',
      zona_direccion: 'Maracaibo Norte, Zulia',
      producto_resumen: 'Mortadela Especial Asturias 0.900kg',
      productos: ['Mortadela Especial Asturias 0.900kg'],
      cantidad_kilos: 5,
      personas_estimadas: 150,
      vendedor_fdv: 'Mariana Chacín',
      aprobado_por: 'Coordinación Zulia',
      estado_ruta: 'ASIGNADA',
      observaciones: '',
      checkin_at: null,
      checkout_at: null,
      asignado_at: '2026-11-20T08:00:00.000Z',
      updated_at: '2026-11-20T08:00:00.000Z',
      sucursal: 'ZULIA',
    },
  ];

  const portalHtml = renderToStaticMarkup(
    <PromotoraRutaPortalView initialProfile={verified} initialRoutes={sampleRoutes} />
  );
  assert.match(portalHtml, /data-testid="portal-super-admin-banner"/);
  assert.match(portalHtml, /Modo Supervisión Global/);
  assert.match(portalHtml, /data-testid="portal-supervision-sucursal-select"/);
  assert.match(portalHtml, /data-testid="portal-supervision-promotora-select"/);
  assert.match(portalHtml, /HIPERMERCADO MARACAIBO NORTE/);
  assert.match(portalHtml, /María González Zulia/);

  // Acceso total en /logistica/ (Chofer + Oficina)
  let signedOut = false;
  const mockRutaClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: authUser.id,
              email: 'admin@codizulca.com',
              full_name: 'Administrador General CODIZULCA',
              role: 'super_admin',
              sucursal: 'GLOBAL',
              is_active: true,
            },
            error: null,
          }),
        }),
      }),
    }),
    realtime: { setAuth: () => {} },
    auth: {
      signOut: async () => {
        signedOut = true;
      },
    },
  } as unknown as SupabaseClient;

  const rutaAccess = await verifyRutaProfileAccess(mockRutaClient, {
    access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.valid.token',
    user: authUser,
  } as never);
  assert.equal(rutaAccess.ok, true);
  assert.equal(signedOut, false);
  if (rutaAccess.ok) {
    assert.equal(isRutaSuperAdmin(rutaAccess.user), true);
    assert.equal(rutaAccess.user.sucursal, 'GLOBAL');
    assert.equal(canAccessOficinaMode(rutaAccess.user.role), true);
    assert.equal(canAccessChoferMode(rutaAccess.user.role), true);
    assert.deepEqual(resolveAllowedModes(rutaAccess.user.role), ['chofer', 'oficina']);
  }

  // Verificador servidor super_admin
  assert.equal(
    isVerifiedServerSuperAdmin({
      canonicalEmail: 'admin@codizulca.com',
      profile: { role: 'super_admin', is_active: true },
      appMetadata: { role: 'super_admin' },
    }),
    true
  );
  assert.equal(
    isVerifiedServerSuperAdmin({
      canonicalEmail: 'admin@codizulca.com',
      profile: null,
      appMetadata: { role: 'super_admin' },
    }),
    true
  );
});

test('Escenario 2 (Prevención de Escalamiento OWASP A01) · Usuarios operativos conservan restricciones y user_metadata jamás escala privilegios', async () => {
  // Intento malicioso de escalar privilegios vía user_metadata editado por cliente (incluso con el email maestro)
  const spoofedUser = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'admin@codizulca.com',
    app_metadata: {
      role: 'promotora',
      sucursal: 'ZULIA',
    },
    user_metadata: {
      role: 'super_admin',
      app_role: 'super_admin',
      is_admin: true,
      sucursal: 'GLOBAL',
    },
  } as unknown as SupabaseAuthUser;

  const spoofedProfile = extractVerifiedProfileFromAuthUser(spoofedUser);
  assert.ok(spoofedProfile);
  assert.equal(spoofedProfile.iamRole, 'promotora', 'Jamás debe leer role desde user_metadata');
  assert.equal(isSuperAdminProfile(spoofedProfile), false);
  assert.equal(canBypassFieldGeofence(spoofedProfile), false);
  assert.equal(canAccessModule(spoofedProfile, 'gestion_usuarios'), false);
  assert.equal(canAccessModule(spoofedProfile, 'promotoras'), false);

  // Servidor bloquea cuenta suspendida aunque tenga email admin@codizulca.com y app_metadata super_admin
  assert.equal(
    isVerifiedServerSuperAdmin({
      canonicalEmail: 'admin@codizulca.com',
      profile: { role: 'super_admin', is_active: false },
      appMetadata: { role: 'super_admin' },
    }),
    false,
    'Cuenta suspendida debe fallar cerrada'
  );

  // Servidor bloquea rol operativo intentando impersonar super_admin
  assert.equal(
    isVerifiedServerSuperAdmin({
      canonicalEmail: 'coordinadora.zulia@codizulca.com',
      profile: { role: 'coordinacion', is_active: true },
      appMetadata: { role: 'super_admin' },
    }),
    false
  );

  // Coordinación mantiene acceso acotado y no es super_admin
  const coordProfile: VerifiedAuthProfile = {
    userId: '33333333-3333-4333-8333-333333333333',
    email: 'coord.zulia@codizulca.com',
    displayName: 'Coordinadora Zulia',
    appRole: 'coordinadora',
    iamRole: 'coordinacion',
    sucursal: 'ZULIA',
    rawAppRole: 'coordinacion',
    legacyRole: 'jefe_trade',
    staffId: null,
    isCoordinatorOrAdmin: true,
    canAccessTorreControl: true,
    mustChangePassword: false,
  };
  assert.equal(isSuperAdminProfile(coordProfile), false);
  assert.equal(canBypassFieldGeofence(coordProfile), false);
  assert.equal(canAccessPromotoraPortal(coordProfile), false);

  // Chofer en /logistica/ sigue restringido a modo chofer (jamás oficina)
  assert.equal(resolveEffectiveMode('oficina', 'chofer'), 'chofer');
  assert.equal(canAccessOficinaMode('chofer'), false);

  // Vendedor rechazado en /logistica/ con signOut
  let vendorSignedOut = false;
  const mockVendorClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: '44444444-4444-4444-8444-444444444444',
              email: 'vendedor@codizulca.com',
              full_name: 'Vendedor Zulia',
              role: 'vendedor',
              sucursal: 'ZULIA',
              is_active: true,
            },
            error: null,
          }),
        }),
      }),
    }),
    realtime: { setAuth: () => {} },
    auth: {
      signOut: async () => {
        vendorSignedOut = true;
      },
    },
  } as unknown as SupabaseClient;

  const vendorRuta = await verifyRutaProfileAccess(mockVendorClient, {
    access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.vendor.token',
    user: { id: '44444444-4444-4444-8444-444444444444', email: 'vendedor@codizulca.com' },
  } as never);
  assert.equal(vendorRuta.ok, false);
  assert.equal(vendorSignedOut, true);
  if (!vendorRuta.ok) {
    assert.equal(vendorRuta.code, 'FORBIDDEN_ROLE');
  }
});

test('Escenario 3 (Usuarios no autenticados / anon) · Rechazo estricto en cliente, backend y migración SQL', async () => {
  assert.equal(extractVerifiedProfileFromAuthUser(null), null);
  assert.equal(isSuperAdminProfile(null), false);
  assert.equal(canBypassFieldGeofence(null), false);
  assert.equal(canAccessPromotoraPortal(null), false);
  for (const mod of ALL_MODULES) {
    assert.equal(canAccessModule(null, mod), false);
  }

  const rutaAnon = await verifyRutaProfileAccess({} as SupabaseClient, null);
  assert.equal(rutaAnon.ok, false);
  if (!rutaAnon.ok) {
    assert.equal(rutaAnon.code, 'NO_SESSION');
  }

  // Middlewares Express rechazan peticiones sin Bearer con 401
  const reqNoAuth = { headers: {} } as unknown as Request;
  const superRes = createMockExpressRes();
  let nextCalled = false;
  await requireSuperAdminAuth(reqNoAuth, superRes.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(superRes.getStatus(), 401);
  assert.equal(superRes.getBody().code, 'AUTH_TOKEN_MISSING');

  const coordRes = createMockExpressRes();
  await requireCoordinatorOrAdminAuth(reqNoAuth, coordRes.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(coordRes.getStatus(), 401);
  assert.equal(coordRes.getBody().code, 'AUTH_TOKEN_MISSING');

  // Auditoría de seguridad sobre la migración SQL 20261122000100_grant_super_admin_trade_marketing.sql
  assert.equal(fs.existsSync(MIGRATION_PATH), true, 'Debe existir la migración SQL de super_admin');
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.is_super_admin\(\)/);
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path = public, auth/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.is_super_admin\(\) FROM PUBLIC, anon/);
  assert.match(sql, /CREATE TRIGGER trg_auto_grant_super_admin_codizulca/);
  assert.match(sql, /CREATE TRIGGER trg_guard_profiles_self_escalation/);
  assert.match(sql, /super_admin_full_select/);
  assert.match(sql, /super_admin_full_insert/);
  assert.match(sql, /super_admin_full_update/);
  assert.match(sql, /super_admin_full_delete/);
  assert.match(sql, /super_admin_storage_trade_select/);
  assert.match(sql, /super_admin_storage_trade_update/);
  assert.match(sql, /super_admin_bypass/);

  // Reglas inquebrantables sobre SQL ejecutable (sin comentarios):
  // cero DISABLE RLS, cero políticas TO anon, cero contraseñas/secretos, cero user_metadata
  const executableSql = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\r\n]*/g, '');
  assert.ok(!/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(executableSql), 'PROHIBIDO deshabilitar RLS');
  assert.ok(!/CREATE\s+POLICY[\s\S]{0,160}\bTO\s+anon\b/i.test(executableSql), 'PROHIBIDO abrir políticas a anon');
  assert.ok(!/encrypted_password|crypt\(|gen_salt\(/i.test(executableSql), 'PROHIBIDO quemar contraseñas en SQL');
  assert.ok(!/raw_user_meta_data\s*->>/i.test(executableSql), 'PROHIBIDO leer roles desde raw_user_meta_data');
});
