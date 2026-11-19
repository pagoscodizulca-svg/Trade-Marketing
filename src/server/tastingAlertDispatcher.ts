import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAdminSupabaseClient, type OperativeSucursal } from './supabaseAdminAuth';
import { serverLogger } from './logger';
import { sendWebPushNotification } from './webPushCrypto';

export interface OutboxAlertPayload {
  degustacion_id?: string;
  cliente?: string;
  region_id?: string | null;
  region_codigo?: string;
  region_nombre?: string;
  productos?: string;
  fecha_programada?: string;
  turno?: string;
  vendedor?: string;
}

export interface OutboxNotificationRow {
  id: string;
  degustacion_id: string;
  region_id: string | null;
  sucursal: OperativeSucursal | 'GLOBAL' | null;
  canal: 'whatsapp' | 'web_push';
  destinatario: string;
  payload: OutboxAlertPayload;
  estado: 'pending' | 'sent' | 'failed' | 'pending_config';
  intentos: number;
  next_retry_at: string;
  ultimo_error: string | null;
  created_at: string;
}

export interface StoredWebPushSubscription {
  id: string;
  user_id: string;
  region_id: string | null;
  sucursal: OperativeSucursal | 'GLOBAL' | null;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
}

export interface TastingAlertDispatcherEnv {
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_TEMPLATE_NAME?: string;
  WHATSAPP_TEMPLATE_LANG?: string;
  WHATSAPP_DEFAULT_RECIPIENT_E164?: string;
  WEBHOOK_VERIFY_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  CRON_SECRET?: string;
}

export interface TastingAlertOutboxGateway {
  fetchPendingBatch(limit: number): Promise<OutboxNotificationRow[]>;
  updateOutboxRow(params: {
    id: string;
    estado: 'pending' | 'sent' | 'failed' | 'pending_config';
    intentos: number;
    nextRetryAtIso?: string;
    ultimoError: string | null;
    sentAtIso?: string | null;
  }): Promise<void>;
  fetchActivePushSubscriptions(params: {
    regionId: string | null;
    sucursal: OperativeSucursal | 'GLOBAL' | null;
  }): Promise<StoredWebPushSubscription[]>;
  deactivatePushSubscription(id: string): Promise<void>;
  upsertPushSubscription(params: {
    userId: string;
    regionId: string | null;
    sucursal: OperativeSucursal | 'GLOBAL' | null;
    endpoint: string;
    p256dh: string;
    authSecret: string;
    userAgent: string;
  }): Promise<void>;
  deletePushSubscription(params: { userId: string; endpoint: string }): Promise<void>;
}

const MAX_DISPATCH_ATTEMPTS = 5;
const GRAPH_API_VERSION = 'v21.0';

/** Normaliza un teléfono venezolano o internacional a dígitos E.164 (sin +) para Meta Cloud API. */
export function normalizeWhatsAppRecipientE164(raw: unknown): string {
  let digits = String(raw ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && /^04(12|14|16|24|26)\d{7}$/.test(digits)) {
    digits = `58${digits.slice(1)}`;
  } else if (digits.length === 10 && /^4(12|14|16|24|26)\d{7}$/.test(digits)) {
    digits = `58${digits}`;
  } else if (digits.length === 12 && /^5804(12|14|16|24|26)\d{7}$/.test(digits)) {
    digits = `58${digits.slice(3)}`;
  }
  if (digits.length < 10 || digits.length > 15) return '';
  return digits;
}

function sanitizeTemplateParam(raw: unknown, fallback: string, maxLen = 120): string {
  const clean = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const val = clean || fallback;
  return val.length > maxLen ? `${val.slice(0, maxLen - 1)}…` : val;
}

/**
 * Construye el cuerpo oficial de Meta WhatsApp Cloud API (Graph API) con plantilla parametrizada:
 *   {{1}} Cliente · {{2}} Región · {{3}} Productos · {{4}} Fecha programada · {{5}} Vendedor solicitante
 */
export function buildWhatsAppCloudTemplateBody(params: {
  recipientE164: string;
  templateName: string;
  languageCode?: string;
  payload: OutboxAlertPayload;
}): Record<string, unknown> {
  const fechaYTurno = [
    sanitizeTemplateParam(params.payload.fecha_programada, 'Por definir', 24),
    params.payload.turno ? `(${sanitizeTemplateParam(params.payload.turno, '', 24)})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.recipientE164,
    type: 'template',
    template: {
      name: params.templateName,
      language: { code: params.languageCode || 'es' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: sanitizeTemplateParam(params.payload.cliente, 'Punto de Venta', 120) },
            { type: 'text', text: sanitizeTemplateParam(params.payload.region_nombre || params.payload.region_codigo, 'Nacional', 60) },
            { type: 'text', text: sanitizeTemplateParam(params.payload.productos, 'Productos CODIZULCA', 180) },
            { type: 'text', text: fechaYTurno },
            { type: 'text', text: sanitizeTemplateParam(params.payload.vendedor, 'Vendedor FDV', 100) },
          ],
        },
      ],
    },
  };
}

function computeNextRetryIso(attempts: number, nowMs: number = Date.now()): string {
  const delaySec = Math.min(3600, 60 * Math.pow(2, Math.max(0, attempts - 1)));
  return new Date(nowMs + delaySec * 1000).toISOString();
}

function timingSafeStringMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// =============================================================================
// GATEWAY SUPABASE POR DEFECTO
// =============================================================================

function createSupabaseTastingAlertGateway(): TastingAlertOutboxGateway {
  const requireAdmin = () => {
    const client = getAdminSupabaseClient();
    if (!client) throw new Error('SUPABASE_SERVER_UNCONFIGURED');
    return client;
  };

  return {
    async fetchPendingBatch(limit) {
      const admin = requireAdmin();
      const nowIso = new Date().toISOString();
      const { data, error } = await admin
        .from('notificaciones_outbox')
        .select('*')
        .eq('estado', 'pending')
        .lte('next_retry_at', nowIso)
        .order('created_at', { ascending: true })
        .limit(Math.max(1, Math.min(50, limit)));

      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as OutboxNotificationRow[];
    },

    async updateOutboxRow({ id, estado, intentos, nextRetryAtIso, ultimoError, sentAtIso }) {
      const admin = requireAdmin();
      const { error } = await admin
        .from('notificaciones_outbox')
        .update({
          estado,
          intentos,
          ...(nextRetryAtIso ? { next_retry_at: nextRetryAtIso } : {}),
          ultimo_error: ultimoError,
          ...(sentAtIso !== undefined ? { sent_at: sentAtIso } : {}),
        })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },

    async fetchActivePushSubscriptions({ regionId, sucursal }) {
      const admin = requireAdmin();
      const { data, error } = await admin
        .from('web_push_subscriptions')
        .select('id, user_id, region_id, sucursal, endpoint, p256dh, auth_secret')
        .eq('activo', true)
        .limit(200);

      if (error || !Array.isArray(data)) return [];
      return (data as unknown as StoredWebPushSubscription[]).filter((sub) => {
        if (!sub.sucursal || sub.sucursal === 'GLOBAL') return true;
        if (regionId && sub.region_id === regionId) return true;
        if (sucursal && sucursal !== 'GLOBAL' && sub.sucursal === sucursal) return true;
        return false;
      });
    },

    async deactivatePushSubscription(id) {
      const admin = requireAdmin();
      await admin.from('web_push_subscriptions').update({ activo: false }).eq('id', id);
    },

    async upsertPushSubscription({
      userId,
      regionId,
      sucursal,
      endpoint,
      p256dh,
      authSecret,
      userAgent,
    }) {
      const admin = requireAdmin();
      const { error } = await admin.from('web_push_subscriptions').upsert(
        {
          user_id: userId,
          region_id: regionId,
          sucursal,
          endpoint,
          p256dh,
          auth_secret: authSecret,
          user_agent: userAgent.slice(0, 240),
          activo: true,
        },
        { onConflict: 'endpoint' }
      );
      if (error) throw new Error(error.message);
    },

    async deletePushSubscription({ userId, endpoint }) {
      const admin = requireAdmin();
      await admin
        .from('web_push_subscriptions')
        .update({ activo: false })
        .eq('user_id', userId)
        .eq('endpoint', endpoint);
    },
  };
}

// =============================================================================
// MOTOR DE DESPACHO (`dispatch-tasting-alert`)
// =============================================================================

export interface DispatchBatchSummary {
  processed: number;
  sent: number;
  pendingConfig: number;
  retried: number;
  failed: number;
}

export function createTastingAlertDispatcher(options?: {
  gateway?: TastingAlertOutboxGateway;
  env?: TastingAlertDispatcherEnv;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}) {
  const gateway = options?.gateway ?? createSupabaseTastingAlertGateway();
  const getEnv = (): TastingAlertDispatcherEnv => options?.env ?? (process.env as TastingAlertDispatcherEnv);
  const fetchFn = options?.fetchImpl ?? fetch;
  const nowMsFn = options?.nowMs ?? (() => Date.now());

  async function dispatchPendingTastingAlerts(limit = 25): Promise<DispatchBatchSummary> {
    const env = getEnv();
    const rows = await gateway.fetchPendingBatch(limit);
    const summary: DispatchBatchSummary = {
      processed: rows.length,
      sent: 0,
      pendingConfig: 0,
      retried: 0,
      failed: 0,
    };

    for (const row of rows) {
      const nextAttempts = (row.intentos ?? 0) + 1;

      if (row.canal === 'whatsapp') {
        const waToken = String(env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
        const phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
        const templateName = String(env.WHATSAPP_TEMPLATE_NAME ?? '').trim() || 'nueva_degustacion_trade';
        const templateLang = String(env.WHATSAPP_TEMPLATE_LANG ?? '').trim() || 'es';

        if (!waToken || !phoneNumberId) {
          await gateway.updateOutboxRow({
            id: row.id,
            estado: 'pending_config',
            intentos: row.intentos,
            ultimoError: 'WHATSAPP_CREDENTIALS_NOT_CONFIGURED: configura WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID en servidor.',
          });
          summary.pendingConfig += 1;
          continue;
        }

        const recipientE164 =
          normalizeWhatsAppRecipientE164(row.destinatario) ||
          normalizeWhatsAppRecipientE164(env.WHATSAPP_DEFAULT_RECIPIENT_E164);

        if (!recipientE164) {
          await gateway.updateOutboxRow({
            id: row.id,
            estado: 'pending_config',
            intentos: row.intentos,
            ultimoError: 'WHATSAPP_RECIPIENT_NOT_CONFIGURED: configura regiones.whatsapp_responsable_telefono o WHATSAPP_DEFAULT_RECIPIENT_E164.',
          });
          summary.pendingConfig += 1;
          continue;
        }

        try {
          const graphUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;
          const body = buildWhatsAppCloudTemplateBody({
            recipientE164,
            templateName,
            languageCode: templateLang,
            payload: row.payload || {},
          });

          const res = await fetchFn(graphUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${waToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });

          if (res.ok) {
            await gateway.updateOutboxRow({
              id: row.id,
              estado: 'sent',
              intentos: nextAttempts,
              ultimoError: null,
              sentAtIso: new Date(nowMsFn()).toISOString(),
            });
            summary.sent += 1;
          } else {
            const errTxt = (await res.text().catch(() => '')).slice(0, 220);
            const isTransient = res.status === 429 || res.status >= 500;
            if (isTransient && nextAttempts < MAX_DISPATCH_ATTEMPTS) {
              await gateway.updateOutboxRow({
                id: row.id,
                estado: 'pending',
                intentos: nextAttempts,
                nextRetryAtIso: computeNextRetryIso(nextAttempts, nowMsFn()),
                ultimoError: `Meta Graph API HTTP ${res.status}: ${errTxt}`,
              });
              summary.retried += 1;
            } else {
              await gateway.updateOutboxRow({
                id: row.id,
                estado: 'failed',
                intentos: nextAttempts,
                ultimoError: `Meta Graph API HTTP ${res.status}: ${errTxt}`,
              });
              summary.failed += 1;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (nextAttempts < MAX_DISPATCH_ATTEMPTS) {
            await gateway.updateOutboxRow({
              id: row.id,
              estado: 'pending',
              intentos: nextAttempts,
              nextRetryAtIso: computeNextRetryIso(nextAttempts, nowMsFn()),
              ultimoError: `Error red WhatsApp: ${msg.slice(0, 180)}`,
            });
            summary.retried += 1;
          } else {
            await gateway.updateOutboxRow({
              id: row.id,
              estado: 'failed',
              intentos: nextAttempts,
              ultimoError: `Error red WhatsApp (agotado): ${msg.slice(0, 180)}`,
            });
            summary.failed += 1;
          }
        }
        continue;
      }

      // Canal WEB_PUSH (VAPID RFC 8292 + RFC 8291)
      const vapidPublic = String(env.VAPID_PUBLIC_KEY ?? '').trim();
      const vapidPrivate = String(env.VAPID_PRIVATE_KEY ?? '').trim();
      const vapidSubject =
        String(env.VAPID_SUBJECT ?? '').trim() || 'mailto:trade-marketing@codizulca.com';

      if (!vapidPublic || !vapidPrivate) {
        await gateway.updateOutboxRow({
          id: row.id,
          estado: 'pending_config',
          intentos: row.intentos,
          ultimoError: 'VAPID_KEYS_NOT_CONFIGURED: configura VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en servidor.',
        });
        summary.pendingConfig += 1;
        continue;
      }

      const subscriptions = await gateway.fetchActivePushSubscriptions({
        regionId: row.region_id,
        sucursal: row.sucursal,
      });

      if (subscriptions.length === 0) {
        await gateway.updateOutboxRow({
          id: row.id,
          estado: 'sent',
          intentos: nextAttempts,
          ultimoError: null,
          sentAtIso: new Date(nowMsFn()).toISOString(),
        });
        summary.sent += 1;
        continue;
      }

      const cliente = sanitizeTemplateParam(row.payload?.cliente, 'Punto de Venta', 80);
      const region = sanitizeTemplateParam(
        row.payload?.region_nombre || row.payload?.region_codigo,
        'Regional',
        40
      );
      const vendedor = sanitizeTemplateParam(row.payload?.vendedor, 'Vendedor FDV', 60);
      const pushPayload = {
        title: `Nueva Degustación FDV · ${region}`,
        body: `${vendedor} solicitó degustación en ${cliente} (${row.payload?.fecha_programada || 'Próxima'}).`,
        url: '/promotoras',
        tag: `degustacion-${row.degustacion_id}`,
        degustacionId: row.degustacion_id,
      };

      let deliveredCount = 0;
      let transientError: string | null = null;

      for (const sub of subscriptions) {
        try {
          const pushRes = await sendWebPushNotification({
            subscription: {
              endpoint: sub.endpoint,
              p256dh: sub.p256dh,
              auth: sub.auth_secret,
            },
            payload: pushPayload,
            vapid: {
              publicKey: vapidPublic,
              privateKey: vapidPrivate,
              subject: vapidSubject,
            },
            fetchImpl: fetchFn,
          });
          if (pushRes.ok) {
            deliveredCount += 1;
          } else if (pushRes.gone) {
            await gateway.deactivatePushSubscription(sub.id);
          } else if (pushRes.status === 429 || pushRes.status >= 500) {
            transientError = pushRes.error || `HTTP ${pushRes.status}`;
          }
        } catch (err) {
          transientError = err instanceof Error ? err.message : String(err);
        }
      }

      if (deliveredCount > 0 || !transientError) {
        await gateway.updateOutboxRow({
          id: row.id,
          estado: 'sent',
          intentos: nextAttempts,
          ultimoError: null,
          sentAtIso: new Date(nowMsFn()).toISOString(),
        });
        summary.sent += 1;
      } else if (nextAttempts < MAX_DISPATCH_ATTEMPTS) {
        await gateway.updateOutboxRow({
          id: row.id,
          estado: 'pending',
          intentos: nextAttempts,
          nextRetryAtIso: computeNextRetryIso(nextAttempts, nowMsFn()),
          ultimoError: transientError.slice(0, 200),
        });
        summary.retried += 1;
      } else {
        await gateway.updateOutboxRow({
          id: row.id,
          estado: 'failed',
          intentos: nextAttempts,
          ultimoError: transientError.slice(0, 200),
        });
        summary.failed += 1;
      }
    }

    return summary;
  }

  // ===========================================================================
  // HANDLERS EXPRESS
  // ===========================================================================

  const WebPushSubscribeSchema = z.object({
    endpoint: z.string().trim().url().refine((u) => u.startsWith('https://'), 'Endpoint debe usar HTTPS.'),
    keys: z.object({
      p256dh: z.string().trim().min(16).max(200),
      auth: z.string().trim().min(8).max(120),
    }),
  });

  const handleGetWebPushPublicKey = (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    const env = getEnv();
    const publicKey = String(env.VAPID_PUBLIC_KEY ?? '').trim();
    const privateKey = String(env.VAPID_PRIVATE_KEY ?? '').trim();
    res.status(200).json({
      ok: true,
      configured: Boolean(publicKey && privateKey),
      publicKey: publicKey && privateKey ? publicKey : null,
    });
  };

  const handleSubscribeWebPush = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ ok: false, error: 'Autenticación requerida.' });
      return;
    }
    const parsed = WebPushSubscribeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Suscripción Web Push inválida.' });
      return;
    }

    try {
      let regionId: string | null = null;
      const admin = getAdminSupabaseClient();
      if (admin && authUser.sucursal && authUser.sucursal !== 'GLOBAL') {
        const { data: reg } = await admin
          .from('regiones')
          .select('id')
          .ilike('codigo', authUser.sucursal)
          .maybeSingle();
        if (reg?.id) regionId = String(reg.id);
      }

      await gateway.upsertPushSubscription({
        userId: authUser.id,
        regionId,
        sucursal: authUser.sucursal ?? null,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        authSecret: parsed.data.keys.auth,
        userAgent: String(req.headers['user-agent'] ?? ''),
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      serverLogger.error('web_push_subscribe_failed', { err });
      res.status(500).json({ ok: false, error: 'No se pudo guardar la suscripción Web Push.' });
    }
  };

  const handleUnsubscribeWebPush = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ ok: false, error: 'Autenticación requerida.' });
      return;
    }
    const endpoint = String((req.body as { endpoint?: unknown } | undefined)?.endpoint ?? '').trim();
    if (!endpoint.startsWith('https://')) {
      res.status(400).json({ ok: false, error: 'Endpoint requerido.' });
      return;
    }
    try {
      await gateway.deletePushSubscription({ userId: authUser.id, endpoint });
      res.status(200).json({ ok: true });
    } catch (err) {
      serverLogger.error('web_push_unsubscribe_failed', { err });
      res.status(500).json({ ok: false, error: 'No se pudo desactivar la suscripción Web Push.' });
    }
  };

  const handleDispatchTastingAlert = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const env = getEnv();
    const cronHeader = String(req.headers['x-cron-secret'] ?? '').trim();
    const webhookHeader = String(req.headers['x-webhook-token'] ?? '').trim();

    const validCron = Boolean(env.CRON_SECRET && timingSafeStringMatch(cronHeader, env.CRON_SECRET.trim()));
    const validWebhook = Boolean(
      env.WEBHOOK_VERIFY_TOKEN && timingSafeStringMatch(webhookHeader, env.WEBHOOK_VERIFY_TOKEN.trim())
    );
    const validAdminJwt = Boolean(req.authUser?.isCoordinatorOrAdmin);

    if (!validCron && !validWebhook && !validAdminJwt) {
      res.status(401).json({
        ok: false,
        code: 'DISPATCH_UNAUTHORIZED',
        error: 'Se requiere x-cron-secret, x-webhook-token o sesión de Coordinación/Super Admin.',
      });
      return;
    }

    try {
      const summary = await dispatchPendingTastingAlerts(25);
      res.status(200).json({ ok: true, ...summary });
    } catch (err) {
      serverLogger.error('dispatch_tasting_alert_failed', { err });
      res.status(500).json({
        ok: false,
        code: 'DISPATCH_INTERNAL_ERROR',
        error: 'Error procesando la cola de notificaciones.',
      });
    }
  };

  const handleMetaWhatsAppWebhookVerify = (req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    const env = getEnv();
    const expectedToken = String(env.WEBHOOK_VERIFY_TOKEN ?? '').trim();
    const mode = String(req.query['hub.mode'] ?? '');
    const token = String(req.query['hub.verify_token'] ?? '');
    const challenge = String(req.query['hub.challenge'] ?? '');

    if (
      mode === 'subscribe' &&
      expectedToken &&
      timingSafeStringMatch(token, expectedToken) &&
      /^[A-Za-z0-9._-]{1,128}$/.test(challenge)
    ) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.status(403).json({ ok: false, error: 'Verificación de Webhook rechazada.' });
  };

  return {
    dispatchPendingTastingAlerts,
    handleGetWebPushPublicKey,
    handleSubscribeWebPush,
    handleUnsubscribeWebPush,
    handleDispatchTastingAlert,
    handleMetaWhatsAppWebhookVerify,
  };
}

export const defaultTastingAlertDispatcher = createTastingAlertDispatcher();
