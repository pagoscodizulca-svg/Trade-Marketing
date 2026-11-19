import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import type { Request, Response } from 'express';
import {
  buildWhatsAppCloudTemplateBody,
  createTastingAlertDispatcher,
  normalizeWhatsAppRecipientE164,
  type OutboxNotificationRow,
  type StoredWebPushSubscription,
  type TastingAlertOutboxGateway,
} from '../src/server/tastingAlertDispatcher';
import {
  createVapidAuthorizationHeader,
  encryptWebPushPayload,
  generateVapidKeyPair,
} from '../src/server/webPushCrypto';

function createMockOutboxGateway(
  rows: OutboxNotificationRow[],
  subs: StoredWebPushSubscription[] = []
) {
  const updates: Array<{
    id: string;
    estado: string;
    intentos: number;
    ultimoError: string | null;
  }> = [];
  const deactivatedSubs: string[] = [];

  const gateway: TastingAlertOutboxGateway = {
    async fetchPendingBatch() {
      return rows;
    },
    async updateOutboxRow(params) {
      updates.push({
        id: params.id,
        estado: params.estado,
        intentos: params.intentos,
        ultimoError: params.ultimoError,
      });
    },
    async fetchActivePushSubscriptions() {
      return subs;
    },
    async deactivatePushSubscription(id) {
      deactivatedSubs.push(id);
    },
    async upsertPushSubscription() {},
    async deletePushSubscription() {},
  };

  return { gateway, updates, deactivatedSubs };
}

test('Normalización E.164 Venezuela y plantilla oficial WhatsApp Cloud API (5 parámetros)', () => {
  assert.equal(normalizeWhatsAppRecipientE164('0414-621-8899'), '584146218899');
  assert.equal(normalizeWhatsAppRecipientE164('+58 (412) 555-1234'), '584125551234');
  assert.equal(normalizeWhatsAppRecipientE164('REGION:ZULIA'), '');

  const body = buildWhatsAppCloudTemplateBody({
    recipientE164: '584146218899',
    templateName: 'nueva_degustacion_trade',
    payload: {
      cliente: 'Supermercado Fiorella',
      region_nombre: 'Zulia',
      productos: 'Mortadela Asturias, Arroz Vencampo',
      fecha_programada: '2026-11-22',
      turno: 'MAÑANA',
      vendedor: 'Carlos Vendedor',
    },
  });

  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.to, '584146218899');
  const template = body.template as {
    name: string;
    components: Array<{ parameters: Array<{ text: string }> }>;
  };
  assert.equal(template.name, 'nueva_degustacion_trade');
  assert.equal(template.components[0]?.parameters.length, 5);
  assert.equal(template.components[0]?.parameters[0]?.text, 'Supermercado Fiorella');
  assert.equal(template.components[0]?.parameters[1]?.text, 'Zulia');
  assert.equal(template.components[0]?.parameters[4]?.text, 'Carlos Vendedor');
});

test('Degradación controlada a pending_config cuando faltan credenciales de Meta o VAPID', async () => {
  const rows: OutboxNotificationRow[] = [
    {
      id: 'outbox-wa-1',
      degustacion_id: 'deg-1',
      region_id: 'reg-zulia',
      sucursal: 'ZULIA',
      canal: 'whatsapp',
      destinatario: '584146218899',
      payload: { cliente: 'PDV Zulia', region_nombre: 'Zulia', productos: 'Asturias', vendedor: 'V1' },
      estado: 'pending',
      intentos: 0,
      next_retry_at: new Date().toISOString(),
      ultimo_error: null,
      created_at: new Date().toISOString(),
    },
    {
      id: 'outbox-push-1',
      degustacion_id: 'deg-1',
      region_id: 'reg-zulia',
      sucursal: 'ZULIA',
      canal: 'web_push',
      destinatario: 'REGION:ZULIA',
      payload: { cliente: 'PDV Zulia', region_nombre: 'Zulia', productos: 'Asturias', vendedor: 'V1' },
      estado: 'pending',
      intentos: 0,
      next_retry_at: new Date().toISOString(),
      ultimo_error: null,
      created_at: new Date().toISOString(),
    },
  ];

  const { gateway, updates } = createMockOutboxGateway(rows);
  const dispatcher = createTastingAlertDispatcher({ gateway, env: {} });
  const summary = await dispatcher.dispatchPendingTastingAlerts(10);

  assert.equal(summary.processed, 2);
  assert.equal(summary.pendingConfig, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(
    updates.map((u) => u.estado),
    ['pending_config', 'pending_config']
  );
});

test('Despachador envía Meta Cloud API (200), reintenta 429 con backoff y cifra Web Push VAPID (limpiando 410 Gone)', async () => {
  const vapid = generateVapidKeyPair();
  const subKey = generateVapidKeyPair();
  const authSecret = crypto.randomBytes(16).toString('base64url');

  // Validar RFC 8292 header y RFC 8291 cifrado
  const vapidHdr = createVapidAuthorizationHeader({
    audience: 'https://fcm.googleapis.com',
    subject: 'mailto:trade@codizulca.com',
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  });
  assert.ok(vapidHdr.startsWith('vapid t='));
  assert.ok(vapidHdr.includes(`, k=${vapid.publicKey}`));

  const enc = encryptWebPushPayload({
    payloadJson: JSON.stringify({ title: 'Test', body: 'Nueva degustación' }),
    subscriberPublicKey: subKey.publicKey,
    subscriberAuthSecret: authSecret,
  });
  assert.equal(enc.contentEncoding, 'aes128gcm');
  assert.ok(enc.body.length > 86);

  const rows: OutboxNotificationRow[] = [
    {
      id: 'wa-ok',
      degustacion_id: 'deg-2',
      region_id: 'reg-zulia',
      sucursal: 'ZULIA',
      canal: 'whatsapp',
      destinatario: '584146218899',
      payload: { cliente: 'Fiorella', region_nombre: 'Zulia', productos: 'Mortadela', fecha_programada: '2026-11-23', vendedor: 'Pedro' },
      estado: 'pending',
      intentos: 0,
      next_retry_at: new Date().toISOString(),
      ultimo_error: null,
      created_at: new Date().toISOString(),
    },
    {
      id: 'wa-retry',
      degustacion_id: 'deg-3',
      region_id: 'reg-val',
      sucursal: 'VALENCIA',
      canal: 'whatsapp',
      destinatario: '584121112233',
      payload: { cliente: 'Kromis', region_nombre: 'Valencia', productos: 'Arroz', fecha_programada: '2026-11-24', vendedor: 'Luis' },
      estado: 'pending',
      intentos: 0,
      next_retry_at: new Date().toISOString(),
      ultimo_error: null,
      created_at: new Date().toISOString(),
    },
    {
      id: 'push-1',
      degustacion_id: 'deg-2',
      region_id: 'reg-zulia',
      sucursal: 'ZULIA',
      canal: 'web_push',
      destinatario: 'REGION:ZULIA',
      payload: { cliente: 'Fiorella', region_nombre: 'Zulia', productos: 'Mortadela', fecha_programada: '2026-11-23', vendedor: 'Pedro' },
      estado: 'pending',
      intentos: 0,
      next_retry_at: new Date().toISOString(),
      ultimo_error: null,
      created_at: new Date().toISOString(),
    },
  ];

  const subs: StoredWebPushSubscription[] = [
    {
      id: 'sub-live',
      user_id: 'u1',
      region_id: 'reg-zulia',
      sucursal: 'ZULIA',
      endpoint: 'https://fcm.googleapis.com/fcm/send/live-sub',
      p256dh: subKey.publicKey,
      auth_secret: authSecret,
    },
    {
      id: 'sub-gone',
      user_id: 'u2',
      region_id: 'reg-zulia',
      sucursal: 'ZULIA',
      endpoint: 'https://fcm.googleapis.com/fcm/send/gone-sub',
      p256dh: subKey.publicKey,
      auth_secret: authSecret,
    },
  ];

  let waCall = 0;
  const mockFetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('graph.facebook.com')) {
      waCall += 1;
      if (waCall === 1) {
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
      }
      return new Response('rate limited', { status: 429 });
    }
    if (url.endsWith('/live-sub')) return new Response('', { status: 201 });
    if (url.endsWith('/gone-sub')) return new Response('Gone', { status: 410 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const { gateway, updates, deactivatedSubs } = createMockOutboxGateway(rows, subs);
  const dispatcher = createTastingAlertDispatcher({
    gateway,
    env: {
      WHATSAPP_ACCESS_TOKEN: 'EAAG-test-token',
      WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:trade@codizulca.com',
      WEBHOOK_VERIFY_TOKEN: 'meta-verify-secret-token',
    },
    fetchImpl: mockFetch,
  });

  const summary = await dispatcher.dispatchPendingTastingAlerts(10);
  assert.equal(summary.sent, 2);
  assert.equal(summary.retried, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(deactivatedSubs, ['sub-gone']);
  assert.equal(updates.find((u) => u.id === 'wa-ok')?.estado, 'sent');
  assert.equal(updates.find((u) => u.id === 'wa-retry')?.estado, 'pending');
  assert.equal(updates.find((u) => u.id === 'push-1')?.estado, 'sent');

  // Verificación del webhook oficial de Meta (`GET /api/webhooks/whatsapp`)
  let status = 0;
  let sentBody: unknown = null;
  const mockRes = {
    setHeader() {},
    status(c: number) {
      status = c;
      return mockRes;
    },
    type() {
      return mockRes;
    },
    send(v: unknown) {
      sentBody = v;
      return mockRes;
    },
    json(v: unknown) {
      sentBody = v;
      return mockRes;
    },
  } as unknown as Response;

  dispatcher.handleMetaWhatsAppWebhookVerify(
    {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'meta-verify-secret-token',
        'hub.challenge': 'challenge_12345',
      },
    } as unknown as Request,
    mockRes
  );
  assert.equal(status, 200);
  assert.equal(sentBody, 'challenge_12345');

  dispatcher.handleMetaWhatsAppWebhookVerify(
    {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge_12345',
      },
    } as unknown as Request,
    mockRes
  );
  assert.equal(status, 403);
});
