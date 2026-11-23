import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Request, Response } from 'express';
import {
  buildPriceEvolutionSeries,
  convertAmountBimonetary,
  evaluateCompetitorPriceDrop,
  normalizePriceSurveyBimonetary,
} from '../src/utils/bimonetaryPriceMath';
import {
  clearInMemoryBcvCacheForTests,
  createBcvRateHandlers,
  type BcvRateDbRow,
  type BcvRateGateway,
} from '../src/server/bcvRateHandler';
import {
  ANTI_INJECTION_OCR_SYSTEM_PROMPT,
  buildGeminiOcrRequestConfig,
  createPriceOcrHandlers,
} from '../src/server/priceOcrHandler';
import {
  createPriceAlertsHandlers,
  type PriceAlertConfigServerRow,
  type PriceAlertServerRow,
  type PriceAlertsGateway,
} from '../src/server/priceAlertsHandler';
import {
  createRateLimiter,
  type AuthenticatedServerUser,
} from '../src/server/supabaseAdminAuth';
import { PortalPreciosTab } from '../src/components/portal/PortalPreciosTab';
import { PriceEvolutionChart } from '../src/components/field/PriceEvolutionChart';
import { PriceComparisonReportSubTab } from '../src/components/field/PriceComparisonReportSubTab';
import type { PriceComparisonThreeBrands, PriceDropAlertRecord } from '../src/types';

// Encabezado binario PNG válido (1x1 px mínimo > 12 bytes) para pruebas offline sin red
const VALID_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f80f00000101000518d84e0000000049454e44ae426082',
  'hex'
);

function createMockRes() {
  const state = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
  };
  const res = {
    setHeader(key: string, value: string) {
      state.headers[key.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

function buildActor(kind: 'admin' | 'maria' | 'grecia' | 'promotora'): AuthenticatedServerUser {
  if (kind === 'admin') {
    return {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'admin@codizulca.com',
      appRole: 'super_admin',
      sucursal: 'GLOBAL',
      allowedRegions: null,
      activeSucursalHeader: null,
      isSuperAdmin: true,
      isCoordinatorOrAdmin: true,
      accessToken: 'jwt-admin-token-0000000000000001',
    };
  }
  if (kind === 'maria') {
    return {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      email: 'maria01@codizulca.com',
      appRole: 'coordinacion',
      sucursal: 'CENTRO',
      allowedRegions: ['CENTRO', 'ANDES'],
      activeSucursalHeader: null,
      isSuperAdmin: false,
      isCoordinatorOrAdmin: true,
      accessToken: 'jwt-maria-token-0000000000000001',
    };
  }
  if (kind === 'grecia') {
    return {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      email: 'grecia01@codizulca.com',
      appRole: 'coordinacion',
      sucursal: 'ZULIA',
      allowedRegions: ['OCCIDENTE'],
      activeSucursalHeader: 'ZULIA',
      isSuperAdmin: false,
      isCoordinatorOrAdmin: true,
      accessToken: 'jwt-grecia-token-000000000000001',
    };
  }
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    email: 'promotora01@codizulca.com',
    appRole: 'promotora',
    sucursal: 'ZULIA',
    allowedRegions: ['OCCIDENTE'],
    activeSucursalHeader: 'ZULIA',
    isSuperAdmin: false,
    isCoordinatorOrAdmin: false,
    accessToken: 'jwt-prom-token-00000000000000001',
  };
}

test('Matemática bimonetaria BCV normaliza capturas mixtas USD/VES, calcula brechas y evalúa caídas > X%', () => {
  // Captura mixta: Propio en VES (Bs. 380 a tasa 100 = $3.80) vs Comp 1 en USD ($4.00) y Comp 2 en VES (Bs. 320 = $3.20)
  const norm = normalizePriceSurveyBimonetary({
    ownPrice: 380,
    ownCurrency: 'VES',
    bcvRate: 100,
    competitors: [
      { name: 'Plumrose', price: 4.0, currency: 'USD' },
      { name: 'Hermo', price: 320, currency: 'VES' },
    ],
  });

  assert.equal(norm.ownCurrency, 'VES');
  assert.equal(norm.ownOriginalPrice, 380);
  assert.equal(norm.ownPriceUsd, 3.8);
  assert.equal(norm.ownPriceBs, 380);
  assert.equal(norm.primaryCompetitorCurrency, 'USD');
  assert.equal(norm.primaryCompetitorPriceUsd, 4.0);
  assert.equal(norm.brechaUsd, -0.2);
  assert.equal(norm.brechaPorcentaje, -5);
  assert.equal(norm.competitorsMeta.length, 2);
  assert.equal(norm.competitorsMeta[1].priceUsd, 3.2);
  assert.equal(norm.competitorsMeta[1].currency, 'VES');

  // Fail-closed: VES sin tasa BCV válida lanza error explícito
  assert.throws(
    () => convertAmountBimonetary({ amount: 500, currency: 'VES', bcvRate: null }),
    /tasa BCV oficial válida/i
  );

  // Evaluación de caídas de precio de competidores
  const drop15 = evaluateCompetitorPriceDrop({
    previousPriceUsd: 4.0,
    currentPriceUsd: 3.4,
    thresholdPercent: 10,
  });
  assert.equal(drop15.triggered, true);
  assert.equal(drop15.dropPercent, 15);
  assert.equal(drop15.severity, 'alta');

  const drop26 = evaluateCompetitorPriceDrop({
    previousPriceUsd: 5.0,
    currentPriceUsd: 3.7,
    thresholdPercent: 10,
  });
  assert.equal(drop26.triggered, true);
  assert.equal(drop26.severity, 'critica');

  const drop5 = evaluateCompetitorPriceDrop({
    previousPriceUsd: 4.0,
    currentPriceUsd: 3.8,
    thresholdPercent: 10,
  });
  assert.equal(drop5.triggered, false);

  const priceUp = evaluateCompetitorPriceDrop({
    previousPriceUsd: 3.8,
    currentPriceUsd: 4.2,
    thresholdPercent: 10,
  });
  assert.equal(priceUp.triggered, false);
});

test('Endpoint /api/tasa-bcv usa caché diaria, persiste BCV vivo, degrada a fallback y restringe manual a Admin Global', async () => {
  clearInMemoryBcvCacheForTests();
  const db = new Map<string, BcvRateDbRow>();
  let upstreamCalls = 0;

  const gateway: BcvRateGateway = {
    async getRateByDate(fecha) {
      return db.get(fecha) ?? null;
    },
    async getLatestRate() {
      const sorted = Array.from(db.values()).sort((a, b) => b.fecha.localeCompare(a.fecha));
      return sorted[0] ?? null;
    },
    async upsertRate(input) {
      const row: BcvRateDbRow = {
        fecha: input.fecha,
        tasa_usd_ves: input.tasa_usd_ves,
        fuente: input.fuente,
        fetched_at: '2026-11-23T12:00:00.000Z',
        updated_by: input.updated_by ?? null,
      };
      db.set(input.fecha, row);
      return row;
    },
  };

  let upstreamMode: 'ok' | 'down' = 'ok';
  const handlers = createBcvRateHandlers({
    gatewayFactory: () => gateway,
    nowProvider: () => new Date('2026-11-23T15:00:00Z'),
    upstreamFetcher: async () => {
      upstreamCalls += 1;
      return upstreamMode === 'ok' ? 92.45 : null;
    },
  });

  // 1) Primer llamado (cache miss) -> consulta upstream y guarda en tasas_bcv
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('promotora'), query: {} } as unknown as Request;
    await handlers.handleGetBcvRate(req, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as any;
    assert.equal(body.tasaUsdVes, 92.45);
    assert.equal(body.isFallback, false);
    assert.equal(body.fromCache, false);
    assert.equal(upstreamCalls, 1);
  }

  // 2) Segundo llamado del mismo día -> responde desde caché sin golpear upstream
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('promotora'), query: {} } as unknown as Request;
    await handlers.handleGetBcvRate(req, res);
    assert.equal(state.statusCode, 200);
    assert.equal((state.body as any).fromCache, true);
    assert.equal(upstreamCalls, 1);
  }

  // 3) Día siguiente con fuente externa caída -> fallback automático con isFallback: true (nunca bloquea a promotoras)
  {
    upstreamMode = 'down';
    const nextDayHandlers = createBcvRateHandlers({
      gatewayFactory: () => gateway,
      nowProvider: () => new Date('2026-11-24T15:00:00Z'),
      upstreamFetcher: async () => null,
    });
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('promotora'), query: {} } as unknown as Request;
    await nextDayHandlers.handleGetBcvRate(req, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as any;
    assert.equal(body.tasaUsdVes, 92.45);
    assert.equal(body.isFallback, true);
    assert.equal(body.fecha, '2026-11-23');
  }

  // 4) Tasa manual: Coordinadora rechazada (403); Admin Global aceptado (200)
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildActor('maria'),
      body: { tasaUsdVes: 93.1 },
    } as unknown as Request;
    await handlers.handleSetManualBcvRate(req, res);
    assert.equal(state.statusCode, 403);
    assert.equal((state.body as any).code, 'FORBIDDEN_SUPER_ADMIN_ONLY');
  }
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildActor('admin'),
      body: { tasaUsdVes: 93.1, fecha: '2026-11-23' },
    } as unknown as Request;
    await handlers.handleSetManualBcvRate(req, res);
    assert.equal(state.statusCode, 200);
    assert.equal((state.body as any).fuente, 'MANUAL_ADMIN');
    assert.equal((state.body as any).tasaUsdVes, 93.1);
  }
});

test('Endpoint /api/precios/ocr-hablador valida magic bytes, Gemini 4 sin parámetros deprecados, anti-prompt-injection y rate limit por usuario', async () => {
  // 1) Configuración moderna Gemini 4: usa thinkingLevel='low' y OMITE thinkingBudget, temperature, topP, topK
  const g4Config = buildGeminiOcrRequestConfig('gemini-4-flash');
  assert.equal((g4Config.thinkingConfig as any)?.thinkingLevel, 'low');
  assert.equal('thinkingBudget' in (g4Config.thinkingConfig as any), false);
  assert.equal('temperature' in g4Config, false);
  assert.equal('topP' in g4Config, false);
  assert.equal('topK' in g4Config, false);
  assert.equal(g4Config.responseMimeType, 'application/json');
  assert.match(ANTI_INJECTION_OCR_SYSTEM_PROMPT, /PROMPT INJECTION/i);

  // Modelo 3.8 / 2.5 usa responseMimeType + temperature: 0
  const g38Config = buildGeminiOcrRequestConfig('gemini-3.8-flash');
  assert.equal(g38Config.temperature, 0);
  assert.equal('thinkingConfig' in g38Config, false);

  let capturedModel = '';
  let capturedConfig: Record<string, unknown> = {};
  const handlers = createPriceOcrHandlers({
    envProvider: () => ({
      GEMINI_API_KEY: 'unit-test-placeholder-key-never-real',
      GEMINI_OCR_MODEL: 'gemini-4-flash',
    }),
    geminiClientFactory: () => ({
      models: {
        async generateContent(args) {
          capturedModel = args.model;
          capturedConfig = args.config;
          return {
            text: JSON.stringify({
              marca_detectada: 'Plumrose',
              producto_detectado: 'Mortadela Especial',
              presentacion_detectada: '1 Kg',
              monto_detectado: 365.5,
              moneda_detectada: 'VES',
              confianza: 'alta',
              notas_lectura: 'Precio en bolívares legible en hablador amarillo.',
            }),
          };
        },
      },
    }),
  });

  // 2) Rechazo sin autenticación -> 401
  {
    const { res, state } = createMockRes();
    const req = { body: VALID_PNG_BUFFER } as unknown as Request;
    await handlers.handleOcrPriceTag(req, res);
    assert.equal(state.statusCode, 401);
  }

  // 3) Rechazo de SVG malicioso disfrazado -> 415 DANGEROUS_CONTENT_DETECTED
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildActor('promotora'),
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    } as unknown as Request;
    await handlers.handleOcrPriceTag(req, res);
    assert.equal(state.statusCode, 415);
    assert.equal((state.body as any).code, 'DANGEROUS_CONTENT_DETECTED');
  }

  // 4) Rechazo de imagen > 5 MB -> 413 FILE_TOO_LARGE
  {
    const { res, state } = createMockRes();
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 16, 0);
    VALID_PNG_BUFFER.copy(oversized, 0);
    const req = { authUser: buildActor('promotora'), body: oversized } as unknown as Request;
    await handlers.handleOcrPriceTag(req, res);
    assert.equal(state.statusCode, 413);
    assert.equal((state.body as any).code, 'FILE_TOO_LARGE');
  }

  // 5) Degradación controlada sin GEMINI_API_KEY -> 503 AI_OCR_UNCONFIGURED
  {
    const unconfigured = createPriceOcrHandlers({ envProvider: () => ({}) });
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('promotora'), body: VALID_PNG_BUFFER } as unknown as Request;
    await unconfigured.handleOcrPriceTag(req, res);
    assert.equal(state.statusCode, 503);
    assert.equal((state.body as any).code, 'AI_OCR_UNCONFIGURED');
  }

  // 6) PNG válido -> 200 con JSON estructurado sanitizado y requiresHumanConfirmation: true
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('promotora'), body: VALID_PNG_BUFFER } as unknown as Request;
    await handlers.handleOcrPriceTag(req, res);
    assert.equal(state.statusCode, 200);
    assert.equal(capturedModel, 'gemini-4-flash');
    assert.equal('temperature' in capturedConfig, false);
    const body = state.body as any;
    assert.equal(body.requiresHumanConfirmation, true);
    assert.equal(body.result.marca_detectada, 'Plumrose');
    assert.equal(body.result.monto_detectado, 365.5);
    assert.equal(body.result.moneda_detectada, 'VES');
    assert.equal(body.result.confianza, 'alta');
  }

  // 7) Rate limiting básico por usuario (aisla por req.authUser.id)
  {
    const limiter = createRateLimiter({
      name: 'test-ocr-per-user',
      windowMs: 60_000,
      maxRequests: 2,
      store: null as any,
    });
    const runHit = (userId: string) =>
      new Promise<number>((resolve) => {
        const { res, state } = createMockRes();
        const req = { authUser: { id: userId }, ip: '127.0.0.1', path: '/api/precios/ocr-hablador' } as unknown as Request;
        const origJson = res.json.bind(res);
        (res as any).json = (p: unknown) => {
          origJson(p);
          resolve(state.statusCode);
          return res;
        };
        limiter(req, res, () => resolve(200));
      });

    assert.equal(await runHit('user-A'), 200);
    assert.equal(await runHit('user-A'), 200);
    assert.equal(await runHit('user-A'), 429);
    // Otro usuario en la misma IP no se ve afectado
    assert.equal(await runHit('user-B'), 200);
  }
});

test('Endpoint /api/precios/alertas aplica aislamiento multi-región estricto (María Centro+Andes, Grecia Occidente, Admin Global)', async () => {
  const alertsDb: PriceAlertServerRow[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      price_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      previous_price_id: null,
      region: 'Occidente',
      cadena: 'Fiorella',
      zona: 'Maracaibo',
      store: 'Fiorella Norte',
      producto_propio: 'Mortadela Asturias 1Kg',
      marca_competidor: 'Plumrose',
      precio_anterior_usd: 4.5,
      precio_actual_usd: 3.6,
      caida_porcentaje: 20,
      umbral_aplicado: 10,
      severidad: 'alta',
      estado: 'pendiente',
      notas_revision: null,
      revisada_por: null,
      revisada_at: null,
      created_at: '2026-11-22T14:00:00Z',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      price_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      previous_price_id: null,
      region: 'Valencia',
      cadena: 'Kromí',
      zona: 'Carabobo',
      store: 'Kromí Valencia',
      producto_propio: 'Mortadela Asturias 1Kg',
      marca_competidor: 'Hermo',
      precio_anterior_usd: 4.0,
      precio_actual_usd: 3.4,
      caida_porcentaje: 15,
      umbral_aplicado: 10,
      severidad: 'alta',
      estado: 'pendiente',
      notas_revision: null,
      revisada_por: null,
      revisada_at: null,
      created_at: '2026-11-23T10:00:00Z',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      price_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      previous_price_id: null,
      region: 'Andes',
      cadena: 'Garzón',
      zona: 'Mérida',
      store: 'Garzón Mérida',
      producto_propio: 'Mortadela Asturias 1Kg',
      marca_competidor: 'Montserratina',
      precio_anterior_usd: 5.0,
      precio_actual_usd: 4.2,
      caida_porcentaje: 16,
      umbral_aplicado: 10,
      severidad: 'alta',
      estado: 'pendiente',
      notas_revision: null,
      revisada_por: null,
      revisada_at: null,
      created_at: '2026-11-23T11:00:00Z',
    },
  ];
  const configsDb: PriceAlertConfigServerRow[] = [
    { region: 'GLOBAL', umbral_caida_porcentaje: 10, ventana_dias: 30, activo: true },
  ];

  const gateway: PriceAlertsGateway = {
    async listAlerts() {
      return alertsDb;
    },
    async getAlertById(id) {
      return alertsDb.find((a) => a.id === id) ?? null;
    },
    async updateAlert(id, patch) {
      const target = alertsDb.find((a) => a.id === id);
      if (!target) return null;
      Object.assign(target, patch);
      return target;
    },
    async listConfigs() {
      return configsDb;
    },
    async upsertConfig(input) {
      const idx = configsDb.findIndex((c) => c.region === input.region);
      if (idx >= 0) configsDb[idx] = input;
      else configsDb.push(input);
      return input;
    },
  };

  const handlers = createPriceAlertsHandlers({ gatewayFactory: () => gateway });

  // 1) María ve SOLO Centro (Valencia) y Andes (0 Occidente)
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('maria'), query: {} } as unknown as Request;
    await handlers.handleListPriceAlerts(req, res);
    assert.equal(state.statusCode, 200);
    const list = (state.body as any).alertas as PriceAlertServerRow[];
    assert.equal(list.length, 2);
    assert.equal(list.some((a) => a.store === 'Fiorella Norte'), false);
    assert.equal(list.some((a) => a.store === 'Kromí Valencia'), true);
    assert.equal(list.some((a) => a.store === 'Garzón Mérida'), true);
  }

  // 2) María solicita ?region=OCCIDENTE -> 403
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('maria'), query: { region: 'OCCIDENTE' } } as unknown as Request;
    await handlers.handleListPriceAlerts(req, res);
    assert.equal(state.statusCode, 403);
  }

  // 3) María intenta marcar revisada una alerta de OCCIDENTE -> 403
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildActor('maria'),
      params: { id: '11111111-1111-4111-8111-111111111111' },
      body: { estado: 'revisada' },
    } as unknown as Request;
    await handlers.handleUpdatePriceAlertStatus(req, res);
    assert.equal(state.statusCode, 403);
  }

  // 4) María intenta cambiar umbral GLOBAL o OCCIDENTE -> 403; pero CENTRO -> 200
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildActor('maria'),
      body: { region: 'GLOBAL', umbral_caida_porcentaje: 5, ventana_dias: 15, activo: true },
    } as unknown as Request;
    await handlers.handleUpsertPriceAlertConfig(req, res);
    assert.equal(state.statusCode, 403);
  }
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildActor('maria'),
      body: { region: 'CENTRO', umbral_caida_porcentaje: 8, ventana_dias: 20, activo: true },
    } as unknown as Request;
    await handlers.handleUpsertPriceAlertConfig(req, res);
    assert.equal(state.statusCode, 200);
    assert.equal((state.body as any).config.umbral_caida_porcentaje, 8);
  }

  // 5) Grecia ve SOLO Occidente y recibe 403 al pedir ANDES
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('grecia'), query: {} } as unknown as Request;
    await handlers.handleListPriceAlerts(req, res);
    assert.equal(state.statusCode, 200);
    const list = (state.body as any).alertas as PriceAlertServerRow[];
    assert.equal(list.length, 1);
    assert.equal(list[0].store, 'Fiorella Norte');
  }
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('grecia'), query: { region: 'ANDES' } } as unknown as Request;
    await handlers.handleListPriceAlerts(req, res);
    assert.equal(state.statusCode, 403);
  }

  // 6) Admin Global ve todas (3) y puede modificar GLOBAL
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildActor('admin'), query: {} } as unknown as Request;
    await handlers.handleListPriceAlerts(req, res);
    assert.equal(state.statusCode, 200);
    assert.equal((state.body as any).alertas.length, 3);
  }
});

test('UI SSR: PortalPreciosTab, PriceEvolutionChart y PriceComparisonReportSubTab renderizan bimonetario, gráficas y aislamiento por rol', () => {
  // 1) App Promotora: selectores USD/Bs independientes y botón captura hablador IA
  const portalHtml = renderToStaticMarkup(
    React.createElement(PortalPreciosTab, {
      context: {
        promotoraId: '1',
        promotoraRefId: 1,
        authUserId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        nombre: 'Nicole Godoy',
        correo: 'godoyaraujonicole@gmail.com',
        telefono: '0412-0000000',
        direccion: 'Maracaibo',
        categoria: 'Fijas',
        perfilAsistencia: 'FIJA',
        region: 'Occidente',
        sucursal: 'ZULIA',
        isManagerOrAdmin: false,
        isMerchandisingRole: false,
      },
      clients: [{ id: 'c1', codigo: 'C1', nombre: 'Fiorella Norte', zona: 'Maracaibo', cadena: 'Fiorella', region: 'Occidente' }],
      products: [{ id: 'p1', codigo: 'P1', nombre: 'Mortadela Asturias 1Kg', categoria: 'Embutidos', presentacion: 'KG' }],
      activeStore: 'Fiorella Norte',
      onActiveStoreChange: () => undefined,
      onNotify: () => undefined,
    })
  );
  assert.match(portalHtml, /own-currency-USD/);
  assert.match(portalHtml, /own-currency-VES/);
  assert.match(portalHtml, /comp-0-currency-VES/);
  assert.match(portalHtml, /Capturar Foto del Hablador/i);

  // 2) Gráfica histórica SVG
  const sampleRows: PriceComparisonThreeBrands[] = [
    {
      id: 'r1',
      date: '2026-11-20',
      storeName: 'Kromí Valencia',
      cadena: 'Kromí',
      zone: 'Carabobo',
      region: 'Centro',
      promotora: 'Paola Maldonado',
      category: 'Embutidos',
      ownProduct: 'Mortadela Asturias 1Kg',
      ownPriceUsd: 3.8,
      ownPriceBs: 351.31,
      ownOriginalPrice: 351.31,
      ownCurrency: 'VES',
      bcvRate: 92.45,
      bcvRateDate: '2026-11-20',
      competitorBrand: 'Plumrose',
      competitorPriceUsd: 4.2,
      competitorPriceBs: 388.29,
      gapPercent: -9.5,
      competitorsList: [{ brand: 'Plumrose', product: 'Comp', priceUsd: 4.2, priceBs: 388.29, diffPercent: -9.5, originalPrice: 4.2, currency: 'USD' }],
      competitor1: { brand: 'Plumrose', product: 'Comp', priceUsd: 4.2, priceBs: 388.29, diffPercent: -9.5 },
      competitor2: { brand: '—', product: '—', priceUsd: 0, priceBs: 0, diffPercent: 0 },
      competitor3: { brand: '—', product: '—', priceUsd: 0, priceBs: 0, diffPercent: 0 },
      averageCompetitorPriceUsd: 4.2,
      averageCompetitorPriceBs: 388.29,
      overallDiffPercent: -9.5,
      status: 'SINCRONIZADO',
      ocrAsistido: true,
      ocrConfianza: 'alta',
    },
    {
      id: 'r2',
      date: '2026-11-22',
      storeName: 'Fiorella Maracaibo',
      cadena: 'Fiorella',
      zone: 'Maracaibo',
      region: 'Occidente',
      promotora: 'Nicole Godoy',
      category: 'Embutidos',
      ownProduct: 'Mortadela Asturias 1Kg',
      ownPriceUsd: 3.9,
      ownPriceBs: 360.56,
      ownOriginalPrice: 3.9,
      ownCurrency: 'USD',
      bcvRate: 92.45,
      bcvRateDate: '2026-11-22',
      competitorBrand: 'Plumrose',
      competitorPriceUsd: 3.5,
      competitorPriceBs: 323.58,
      gapPercent: 11.4,
      competitorsList: [{ brand: 'Plumrose', product: 'Comp', priceUsd: 3.5, priceBs: 323.58, diffPercent: 11.4, originalPrice: 3.5, currency: 'USD' }],
      competitor1: { brand: 'Plumrose', product: 'Comp', priceUsd: 3.5, priceBs: 323.58, diffPercent: 11.4 },
      competitor2: { brand: '—', product: '—', priceUsd: 0, priceBs: 0, diffPercent: 0 },
      competitor3: { brand: '—', product: '—', priceUsd: 0, priceBs: 0, diffPercent: 0 },
      averageCompetitorPriceUsd: 3.5,
      averageCompetitorPriceBs: 323.58,
      overallDiffPercent: 11.4,
      status: 'SINCRONIZADO',
    },
  ];

  const seriesData = buildPriceEvolutionSeries(sampleRows);
  const chartHtml = renderToStaticMarkup(
    React.createElement(PriceEvolutionChart, {
      dates: seriesData.dates,
      series: seriesData.series,
    })
  );
  assert.match(chartHtml, /<svg/);
  assert.match(chartHtml, /Codizulca \(Propio\)/);
  assert.match(chartHtml, /Plumrose/);

  // 3) Subpestaña Comparativa para María (Centro y Andes): ve Kromí Valencia, NO ve Fiorella Maracaibo ni botón Contingencia Manual
  const sampleAlerts: PriceDropAlertRecord[] = [
    {
      id: 'al-occ',
      price_id: 'r2',
      previous_price_id: null,
      region: 'Occidente',
      cadena: 'Fiorella',
      zona: 'Maracaibo',
      store: 'Fiorella Maracaibo',
      producto_propio: 'Mortadela Asturias 1Kg',
      marca_competidor: 'Plumrose',
      precio_anterior_usd: 4.5,
      precio_actual_usd: 3.5,
      caida_porcentaje: 22.2,
      umbral_aplicado: 10,
      severidad: 'alta',
      estado: 'pendiente',
      notas_revision: null,
      revisada_por: null,
      revisada_at: null,
      created_at: '2026-11-22T12:00:00Z',
    },
  ];

  const mariaSubtabHtml = renderToStaticMarkup(
    React.createElement(PriceComparisonReportSubTab, {
      priceComparisons: sampleRows,
      isStrictAdmin: false,
      isRegionalRestricted: true,
      assignedRegionCodes: ['CENTRO', 'ANDES'],
      assignedRegions: ['Centro', 'Andes'],
      canSwitchAmongAssignedRegions: true,
      qaInitialState: {
        bcvSnapshot: {
          fecha: '2026-11-23',
          tasaUsdVes: 92.45,
          fuente: 'BCV_OFICIAL',
          fetchedAt: '2026-11-23T12:00:00Z',
          isFallback: false,
        },
        alertas: sampleAlerts,
        configs: [{ region: 'GLOBAL', umbral_caida_porcentaje: 10, ventana_dias: 30, activo: true }],
      },
    })
  );
  assert.match(mariaSubtabHtml, /Regiones:\s*Centro y Andes/i);
  assert.match(mariaSubtabHtml, /92\.45 Bs\/USD/);
  assert.match(mariaSubtabHtml, /Kromí Valencia/);
  assert.doesNotMatch(mariaSubtabHtml, /Fiorella Maracaibo/);
  assert.doesNotMatch(mariaSubtabHtml, /Contingencia Manual/);

  // 4) Subpestaña Comparativa para Admin Global: sí muestra Contingencia Manual y todas las regiones
  const adminSubtabHtml = renderToStaticMarkup(
    React.createElement(PriceComparisonReportSubTab, {
      priceComparisons: sampleRows,
      isStrictAdmin: true,
      isRegionalRestricted: false,
      assignedRegionCodes: [],
      assignedRegions: [],
      canSwitchAmongAssignedRegions: false,
      qaInitialState: {
        bcvSnapshot: {
          fecha: '2026-11-23',
          tasaUsdVes: 92.45,
          fuente: 'BCV_OFICIAL',
          fetchedAt: '2026-11-23T12:00:00Z',
          isFallback: false,
        },
        alertas: sampleAlerts,
        configs: [{ region: 'GLOBAL', umbral_caida_porcentaje: 10, ventana_dias: 30, activo: true }],
      },
    })
  );
  assert.match(adminSubtabHtml, /Contingencia Manual/);
  assert.match(adminSubtabHtml, /Kromí Valencia/);
  assert.match(adminSubtabHtml, /Fiorella Maracaibo/);
  assert.match(adminSubtabHtml, /-22\.2%/);
});

test('Auditoría estática de seguridad en migración 20261203000100, cliente sin llaves IA y .env.example', () => {
  const root = process.cwd();
  const migPath = path.join(
    root,
    'supabase',
    'migrations',
    '20261203000100_comparativa_precios_bcv_ia_alertas.sql'
  );
  const sqlMirrorPath = path.join(root, 'sql', 'comparativa_precios_bcv_ia_alertas.sql');

  const sql = fs.readFileSync(migPath, 'utf8');
  const mirror = fs.readFileSync(sqlMirrorPath, 'utf8');
  assert.equal(sql, mirror, 'Migración SQL y espejo sql/ deben ser idénticos');

  // Cero prácticas inseguras o destructivas
  const nonCommentSql = sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(nonCommentSql, /\buser_metadata\b/i);
  assert.doesNotMatch(nonCommentSql, /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.doesNotMatch(nonCommentSql, /\bauth\.role\s*\(/i);
  assert.doesNotMatch(nonCommentSql, /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b/i);

  // Objetos obligatorios y seguridad en profundidad
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tasas_bcv/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.configuracion_alertas_precios/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.alertas_precios/i);
  assert.match(sql, /CREATE OR REPLACE VIEW public\.comparativa_precios[\s\S]*security_invoker\s*=\s*true/i);
  assert.match(sql, /AS RESTRICTIVE/i);
  assert.match(sql, /public\.can_access_region\s*\(/i);
  assert.match(sql, /public\.is_global_admin\s*\(\)/i);
  assert.match(sql, /fn_detectar_alerta_caida_precio_competidor/i);
  assert.match(sql, /SET search_path = public/i);

  // Cero llaves de Gemini en código frontend (`src/components`, `src/services`, `src/context`)
  const scanClientDir = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scanClientDir(full);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const content = fs.readFileSync(full, 'utf8');
        assert.doesNotMatch(content, /GEMINI_API_KEY|VITE_GEMINI|@google\/genai/i, `Fuga de IA en cliente: ${full}`);
      }
    }
  };
  scanClientDir(path.join(root, 'src', 'components'));
  scanClientDir(path.join(root, 'src', 'services'));
  scanClientDir(path.join(root, 'src', 'context'));

  // .env.example documenta GEMINI_API_KEY= y GEMINI_OCR_MODEL= vacías (sin prefijo VITE_)
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /^GEMINI_API_KEY=$/m);
  assert.match(envExample, /^GEMINI_OCR_MODEL=$/m);
  assert.doesNotMatch(envExample, /^VITE_GEMINI/m);
});
