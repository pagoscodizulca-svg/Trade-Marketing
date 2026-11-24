import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  formatCanonicalSucursalBadge,
  inferCanonicalSucursalFromText,
  normalizeCanonicalSucursal,
} from '../src/utils/regionalSyncClassifier';
import { matchesAssignedRegionsForExternalFdvRow } from '../src/services/supabaseModule1';
import {
  extractPublicPdvTokenFromSearch,
  obtenerDatosPdvPorToken,
  PublicPdvSecurityError,
  reportarEjecucionPdv,
} from '../src/services/publicPdvLinksService';
import { buildRegionalPdvPortalUrl, buildPromotoraWhatsAppLink } from '../src/utils/portalLinkSharing';
import { buildPendingAuthorizationReportModel } from '../src/utils/pendingAuthorizationPdf';
import { buildMonthlyTastingReportData } from '../src/utils/monthlyTastingReportPdf';
import { purgeAllSessionCaches } from '../src/services/sessionCacheHygiene';
import { PublicTokenPdvView } from '../src/components/portal/PublicTokenPdvView';
import { RegionalPdvLinkModal } from '../src/components/admin/RegionalPdvLinkModal';
import type { TastingScheduleItem } from '../src/components/field/FieldPromotoraView';

const ROOT = process.cwd();

test('T-01 / Bloques 1, 2, 3, 4, 5 y 7 · Auditoría estática de migración SQL transaccional y script de auditoría previa', () => {
  const migrationPath = path.join(
    ROOT,
    'supabase',
    'migrations',
    '20261207000100_aislamiento_estricto_multisede_centro_occidente.sql'
  );
  const mirrorPath = path.join(
    ROOT,
    'sql',
    'aislamiento_estricto_multisede_centro_occidente.sql'
  );
  const preAuditPath = path.join(
    ROOT,
    'sql',
    'auditoria_previa_multisede_centro_occidente.sql'
  );

  assert.equal(fs.existsSync(migrationPath), true, 'Debe existir la migración 20261207000100');
  assert.equal(fs.existsSync(mirrorPath), true, 'Debe existir el espejo en sql/');
  assert.equal(fs.existsSync(preAuditPath), true, 'Debe existir el script de auditoría previa');

  const sql = fs.readFileSync(migrationPath, 'utf8');
  const mirrorSql = fs.readFileSync(mirrorPath, 'utf8');
  assert.equal(sql, mirrorSql, 'La migración y su espejo en sql/ deben ser idénticos');

  // Cero prácticas prohibidas o destructivas
  assert.doesNotMatch(sql, /\buser_metadata\b/i);
  assert.doesNotMatch(sql, /\braw_user_meta_data\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);

  // Bloque 1: perfiles_usuarios + obtener_mi_sucursal()
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.perfiles_usuarios/i);
  assert.match(sql, /REFERENCES\s+auth\.users\(id\)/i);
  assert.match(sql, /CHECK\s*\(\s*sucursal\s+IN\s*\(\s*'CENTRO'\s*,\s*'OCCIDENTE'\s*\)\s*\)/i);
  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.obtener_mi_sucursal\s*\(\)/i);
  assert.match(sql, /SECURITY\s+DEFINER/i);
  assert.match(sql, /SET\s+search_path\s*=\s*public/i);

  // Bloque 2: Catálogo nacional productos + índices
  assert.match(sql, /rls_productos_catalogo_nacional_select/i);
  assert.match(sql, /idx_multisede_surveys_sucursal_type_created/i);

  // Bloque 3: Trigger puente BEFORE INSERT OR UPDATE para dashboard-fdv-planificador
  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_trg_inferir_sucursal_degustacion\s*\(\)/i);
  assert.match(sql, /BEFORE\s+INSERT\s+OR\s+UPDATE\s+ON\s+public\.surveys/i);

  // Bloque 4: RLS estricto SELECT / INSERT / UPDATE / DELETE + FORCE ROW LEVEL SECURITY
  assert.match(sql, /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.match(sql, /FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.match(sql, /rls_multisede_select/i);
  assert.match(sql, /rls_multisede_insert/i);
  assert.match(sql, /rls_multisede_update/i);
  assert.match(sql, /rls_multisede_delete/i);

  // Bloque 5: enlaces_publicos_sucursal + RPCs públicos con rechazo 42501 cruzado
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.enlaces_publicos_sucursal/i);
  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.obtener_datos_pdv_por_token/i);
  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.reportar_ejecucion_pdv/i);
  assert.match(sql, /ACCESO_DENEGADO_SUCURSAL_CRUZADA/i);

  // Bloque 7: BEGIN ... COMMIT y guarda previa a SET NOT NULL
  assert.match(sql, /^\s*BEGIN\s*;/m);
  assert.match(sql, /^\s*COMMIT\s*;/m);
  assert.match(sql, /MIGRACION_ABORTADA_REGISTROS_AMBIGUOS/i);
});

test('T-02 y T-04 · Clasificación estricta: Makro San Diego, Naguanagua, El Samán Maracay y Turmero Maracay jamás se filtran a OCCIDENTE', () => {
  const tiendasCentro = [
    'MAKRO SAN DIEGO',
    'Makro Naguanagua',
    'MAKRO EL SAMÁN MARACAY',
    'Makro El Saman',
    'MAKRO TURMERO MARACAY',
    'Automercado Guacara',
    'Hipermercado Cagua',
  ];

  for (const store of tiendasCentro) {
    assert.equal(
      inferCanonicalSucursalFromText(store),
      'CENTRO',
      `${store} debe clasificarse estrictamente como CENTRO`
    );

    const fdvRow = {
      id: `fdv-render:${store}`,
      type: 'Degustacion',
      store,
      comments: JSON.stringify({ client: store, estado: 'SOLICITADA' }),
    };

    assert.equal(
      matchesAssignedRegionsForExternalFdvRow(fdvRow, ['OCCIDENTE']),
      false,
      `${store} JAMÁS debe ser visible para la coordinadora de OCCIDENTE`
    );
    assert.equal(
      matchesAssignedRegionsForExternalFdvRow(fdvRow, ['CENTRO']),
      true,
      `${store} debe ser visible para la coordinadora de CENTRO`
    );
  }

  // Fila externa Render sin etiqueta geográfica verificable -> fail-closed para AMBAS sedes
  const unlabeledRenderRow = {
    id: 'fdv-render:sin-region-999',
    type: 'Degustacion',
    store: 'ABASTO GENERICO SIN CIUDAD',
    comments: JSON.stringify({ client: 'ABASTO GENERICO SIN CIUDAD', estado: 'SOLICITADA' }),
  };
  assert.equal(matchesAssignedRegionsForExternalFdvRow(unlabeledRenderRow, ['OCCIDENTE']), false);
  assert.equal(matchesAssignedRegionsForExternalFdvRow(unlabeledRenderRow, ['CENTRO']), false);

  // Fila de Occidente (Maracaibo / Cabimas / Punto Fijo) -> solo OCCIDENTE, invisible a CENTRO
  const occidenteRow = {
    id: 'fdv-render:occ-001',
    type: 'Degustacion',
    store: 'ENNE MARACAIBO FUERZAS ARMADAS',
    comments: JSON.stringify({ zona: 'Maracaibo', estado: 'SOLICITADA' }),
  };
  assert.equal(matchesAssignedRegionsForExternalFdvRow(occidenteRow, ['OCCIDENTE']), true);
  assert.equal(matchesAssignedRegionsForExternalFdvRow(occidenteRow, ['CENTRO']), false);

  assert.equal(normalizeCanonicalSucursal('ZULIA'), 'OCCIDENTE');
  assert.equal(normalizeCanonicalSucursal('VALENCIA'), 'CENTRO');
  assert.equal(formatCanonicalSucursalBadge('CENTRO'), 'SUCURSAL CENTRO');
  assert.equal(formatCanonicalSucursalBadge('OCCIDENTE'), 'SUCURSAL OCCIDENTE');
});

test('T-05 · Enlaces Públicos PDV por token: aislamiento de catálogo, rechazo 42501 cruzado y revocación', async () => {
  const validCentroToken = 'centro_11111111222233334444555566667777888899990000aaaabbbbccccdddd';
  assert.equal(
    extractPublicPdvTokenFromSearch(`?token=${validCentroToken}`),
    validCentroToken
  );
  assert.equal(
    buildRegionalPdvPortalUrl(validCentroToken, 'https://trade.codizulca.com'),
    `https://trade.codizulca.com/portal?token=${validCentroToken}`
  );

  const waUrl = buildPromotoraWhatsAppLink({
    regionalToken: validCentroToken,
    sucursalLabel: 'SUCURSAL CENTRO',
    storeName: 'Makro Naguanagua',
    explicitOrigin: 'https://trade.codizulca.com',
  });
  assert.match(waUrl, /token%3Dcentro_/);

  // Mock de cliente Supabase simulando RPC SECURITY DEFINER
  const mockClient = {
    async rpc(fnName: string, args: Record<string, unknown>) {
      if (fnName === 'obtener_datos_pdv_por_token') {
        if (args.p_token === validCentroToken) {
          return {
            data: {
              ok: true,
              sucursal: 'CENTRO',
              tiendas: [{ id: 't-cen-1', nombre_comercial: 'MAKRO NAGUANAGUA', ciudad: 'Naguanagua' }],
              promotoras: [{ id: 'p-cen-1', nombre_completo: 'Paola Maldonado', categoria: 'Fijas' }],
              degustaciones_autorizadas: [
                {
                  degustacion_id: 'deg-cen-1',
                  fuente: 'cronograma',
                  survey_origen_id: null,
                  fecha: '2026-11-24',
                  turno: 'MAÑANA',
                  cliente_nombre: 'MAKRO NAGUANAGUA',
                  cliente_codigo: 'CEN-10',
                  zona_direccion: 'Naguanagua',
                  producto_resumen: 'Mortadela Asturias 1Kg',
                  productos: [],
                  promotora_id: 'p-cen-1',
                  promotora_nombre: 'Paola Maldonado',
                  vendedor_fdv: 'Vendedor Centro',
                  estado: 'APROBADA',
                },
              ],
              productos: [{ id: 'sku-nac-1', codigo: 'AST-01', nombre: 'Mortadela Asturias 1Kg' }],
              server_time: '2026-11-24T12:00:00Z',
            },
            error: null,
          };
        }
        return {
          data: null,
          error: { code: '42501', message: 'TOKEN_PDV_INVALIDO_O_REVOCADO' },
        };
      }

      if (fnName === 'reportar_ejecucion_pdv') {
        const payload = args.p_payload as { degustacion_id?: string };
        if (args.p_token === validCentroToken && payload.degustacion_id === 'deg-occ-999') {
          return {
            data: null,
            error: {
              code: '42501',
              message: 'ACCESO_DENEGADO_SUCURSAL_CRUZADA: La degustación no pertenece a la sucursal CENTRO',
            },
          };
        }
        return {
          data: {
            ok: true,
            sucursal: 'CENTRO',
            inventory_id: 'inv-cen-01',
            degustacion_actualizada: true,
            client_submission_id: 'sub-cen-01',
          },
          error: null,
        };
      }
      return { data: null, error: { message: 'RPC desconocida' } };
    },
  } as unknown as SupabaseClient;

  // 1) Token CENTRO solo devuelve datos de CENTRO + catálogo nacional de productos
  const bootstrap = await obtenerDatosPdvPorToken(validCentroToken, { clientOverride: mockClient });
  assert.equal(bootstrap.sucursal, 'CENTRO');
  assert.equal(bootstrap.tiendas.length, 1);
  assert.equal(bootstrap.tiendas[0]?.nombre_comercial, 'MAKRO NAGUANAGUA');
  assert.equal(bootstrap.productos.length, 1);

  // 2) Intento de inyectar degustacion_id de OCCIDENTE usando token de CENTRO -> rechazado 42501
  await assert.rejects(
    () =>
      reportarEjecucionPdv(
        validCentroToken,
        {
          degustacionId: 'deg-occ-999',
          clienteNombre: 'MAKRO NAGUANAGUA',
          productoNombre: 'Mortadela Asturias 1Kg',
          muestrasEntregadas: 40,
          ventasAsistidas: 12,
        },
        { clientOverride: mockClient }
      ),
    (err: unknown) => {
      assert.ok(err instanceof PublicPdvSecurityError);
      assert.equal(err.code, 'CROSS_BRANCH_FORBIDDEN');
      return true;
    }
  );

  // 3) Token revocado -> rechazado con INVALID_TOKEN
  await assert.rejects(
    () =>
      obtenerDatosPdvPorToken(
        'centro_token_revocado_000000000000000000000000000000000000',
        { clientOverride: mockClient }
      ),
    (err: unknown) => {
      assert.ok(err instanceof PublicPdvSecurityError);
      assert.equal(err.code, 'INVALID_TOKEN');
      return true;
    }
  );

  // 4) SSR de vista pública PDV y modal de enlaces regionales
  const pdvHtml = renderToStaticMarkup(
    React.createElement(PublicTokenPdvView, {
      token: validCentroToken,
      initialBootstrapForQa: bootstrap,
    })
  );
  assert.match(pdvHtml, /SUCURSAL CENTRO/);
  assert.match(pdvHtml, /MAKRO NAGUANAGUA/);
  assert.match(pdvHtml, /Mortadela Asturias 1Kg/);

  const modalHtml = renderToStaticMarkup(
    React.createElement(RegionalPdvLinkModal, {
      isOpen: true,
      onClose: () => {},
      activeSucursal: 'OCCIDENTE',
    })
  );
  assert.match(modalHtml, /SUCURSAL OCCIDENTE/);
});

test('T-06 · Higiene de sesión en signOut y aislamiento estricto en Exportar PDF Autorización e Informe Global', async () => {
  const purgeReport = await purgeAllSessionCaches({
    reason: 'sign_out',
    preserveAuthSession: false,
  });
  assert.equal(purgeReport.reason, 'sign_out');
  assert.ok(purgeReport.memoryCallbacksInvoked >= 3);

  const mixedPool: TastingScheduleItem[] = [
    {
      id: 'req-cen-makro-1',
      degustacionId: 'deg-cen-makro-1',
      date: '2026-11-25',
      timeRange: '09:00 - 13:00',
      shift: 'MAÑANA',
      activityTitle: 'Degustación Makro San Diego',
      productName: 'Mortadela Asturias 1Kg',
      responsibleName: 'POR ASIGNAR (Trade Marketing)',
      storeName: 'MAKRO SAN DIEGO',
      zone: 'San Diego, Carabobo',
      status: 'PENDIENTE',
      requestedQty: 5,
      currentSamples: 0,
      targetSamples: 80,
      sellerApplicant: 'Carlos Pérez',
      isArchived: false,
      enHistorial: false,
    },
    {
      id: 'req-occ-mcbo-1',
      degustacionId: 'deg-occ-mcbo-1',
      date: '2026-11-25',
      timeRange: '09:00 - 13:00',
      shift: 'MAÑANA',
      activityTitle: 'Degustación Enne Maracaibo',
      productName: 'Mortadela Asturias 1Kg',
      responsibleName: 'POR ASIGNAR (Trade Marketing)',
      storeName: 'ENNE MARACAIBO',
      zone: 'Maracaibo, Zulia',
      status: 'PENDIENTE',
      requestedQty: 4,
      currentSamples: 0,
      targetSamples: 60,
      sellerApplicant: 'Luis Gómez',
      isArchived: false,
      enHistorial: false,
    },
  ];

  const fixedNow = new Date('2026-11-24T14:00:00.000Z');

  // PDF Autorización para OCCIDENTE: 0 filas de Makro San Diego
  const authOccidente = buildPendingAuthorizationReportModel({
    items: mixedPool,
    activeSucursal: 'OCCIDENTE',
    now: fixedNow,
  });
  assert.equal(authOccidente.rows.length, 1);
  assert.equal(authOccidente.rows[0]?.clientNameDisplay, 'ENNE MARACAIBO');
  assert.match(authOccidente.scopeHeaderLabel, /SUCURSAL OCCIDENTE/);
  assert.match(authOccidente.fileName, /_OCCIDENTE_/);

  // PDF Autorización para CENTRO: 0 filas de Maracaibo
  const authCentro = buildPendingAuthorizationReportModel({
    items: mixedPool,
    activeSucursal: 'CENTRO',
    now: fixedNow,
  });
  assert.equal(authCentro.rows.length, 1);
  assert.equal(authCentro.rows[0]?.clientNameDisplay, 'MAKRO SAN DIEGO');
  assert.match(authCentro.scopeHeaderLabel, /SUCURSAL CENTRO/);
  assert.match(authCentro.fileName, /_CENTRO_/);

  // Informe Global PDF para OCCIDENTE vs CENTRO
  const globalOccidente = buildMonthlyTastingReportData(mixedPool, {
    activeSucursal: 'OCCIDENTE',
    targetYearMonth: '2026-11',
  });
  assert.equal(globalOccidente.totals.totalActivities, 1);
  assert.match(globalOccidente.periodLabel, /SUCURSAL OCCIDENTE/);
  assert.match(globalOccidente.fileSuffix, /^OCCIDENTE_/);

  const globalCentro = buildMonthlyTastingReportData(mixedPool, {
    activeSucursal: 'CENTRO',
    targetYearMonth: '2026-11',
  });
  assert.equal(globalCentro.totals.totalActivities, 1);
  assert.match(globalCentro.periodLabel, /SUCURSAL CENTRO/);
  assert.match(globalCentro.fileSuffix, /^CENTRO_/);
});
