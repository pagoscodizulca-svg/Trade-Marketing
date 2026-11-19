// Supabase Edge Function espejo (Deno): `dispatch-tasting-alert` (v1.9.0)
// Procesa filas `pending` de `public.notificaciones_outbox`:
//  - Envía plantilla estructurada vía Meta WhatsApp Cloud API (Graph API v21.0) al responsable regional.
//  - Degradación controlada (`pending_config`) si las credenciales de Meta aún no están cargadas.
//  - Reintentos seguros con backoff exponencial (máx. 5 intentos).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const GRAPH_VERSION = 'v21.0';
const MAX_ATTEMPTS = 5;

function normalizeE164(raw: unknown): string {
  let digits = String(raw ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && /^04(12|14|16|24|26)\d{7}$/.test(digits)) {
    digits = `58${digits.slice(1)}`;
  } else if (digits.length === 10 && /^4(12|14|16|24|26)\d{7}$/.test(digits)) {
    digits = `58${digits}`;
  }
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

function cleanParam(val: unknown, fallback: string, maxLen = 120): string {
  const s = String(val ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const out = s || fallback;
  return out.length > maxLen ? `${out.slice(0, maxLen - 1)}…` : out;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResp({ ok: false, error: 'Método no permitido.' }, 405);
  }

  const verifyToken = (Deno.env.get('WEBHOOK_VERIFY_TOKEN') ?? '').trim();
  const providedToken = (req.headers.get('x-webhook-token') ?? '').trim();
  if (!verifyToken || providedToken !== verifyToken) {
    return jsonResp({ ok: false, code: 'UNAUTHORIZED' }, 401);
  }

  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim();
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  if (!supabaseUrl || !serviceKey) {
    return jsonResp({ ok: false, code: 'SUPABASE_UNCONFIGURED' }, 503);
  }

  const waToken = (Deno.env.get('WHATSAPP_ACCESS_TOKEN') ?? '').trim();
  const waPhoneId = (Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') ?? '').trim();
  const waTemplate = (Deno.env.get('WHATSAPP_TEMPLATE_NAME') ?? 'nueva_degustacion_trade').trim();
  const waDefaultTo = normalizeE164(Deno.env.get('WHATSAPP_DEFAULT_RECIPIENT_E164') ?? '');

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error } = await admin
    .from('notificaciones_outbox')
    .select('*')
    .eq('estado', 'pending')
    .eq('canal', 'whatsapp')
    .lte('next_retry_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(25);

  if (error) {
    return jsonResp({ ok: false, code: 'OUTBOX_READ_ERROR' }, 500);
  }

  let sent = 0;
  let pendingConfig = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    if (!waToken || !waPhoneId) {
      await admin
        .from('notificaciones_outbox')
        .update({
          estado: 'pending_config',
          ultimo_error: 'WHATSAPP_CREDENTIALS_NOT_CONFIGURED',
        })
        .eq('id', row.id);
      pendingConfig += 1;
      continue;
    }

    const to = normalizeE164(row.destinatario) || waDefaultTo;
    if (!to) {
      await admin
        .from('notificaciones_outbox')
        .update({
          estado: 'pending_config',
          ultimo_error: 'WHATSAPP_RECIPIENT_NOT_CONFIGURED',
        })
        .eq('id', row.id);
      pendingConfig += 1;
      continue;
    }

    const p = (row.payload ?? {}) as Record<string, unknown>;
    const attempts = Number(row.intentos ?? 0) + 1;

    try {
      const resp = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(waPhoneId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${waToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'template',
            template: {
              name: waTemplate,
              language: { code: 'es' },
              components: [
                {
                  type: 'body',
                  parameters: [
                    { type: 'text', text: cleanParam(p.cliente, 'Punto de Venta', 120) },
                    { type: 'text', text: cleanParam(p.region_nombre ?? p.region_codigo, 'Nacional', 60) },
                    { type: 'text', text: cleanParam(p.productos, 'Productos CODIZULCA', 180) },
                    { type: 'text', text: cleanParam(p.fecha_programada, 'Por definir', 32) },
                    { type: 'text', text: cleanParam(p.vendedor, 'Vendedor FDV', 100) },
                  ],
                },
              ],
            },
          }),
        }
      );

      if (resp.ok) {
        await admin
          .from('notificaciones_outbox')
          .update({ estado: 'sent', intentos: attempts, ultimo_error: null, sent_at: new Date().toISOString() })
          .eq('id', row.id);
        sent += 1;
      } else {
        const bodyTxt = (await resp.text().catch(() => '')).slice(0, 200);
        const transient = resp.status === 429 || resp.status >= 500;
        const delaySec = Math.min(3600, 60 * Math.pow(2, Math.max(0, attempts - 1)));
        await admin
          .from('notificaciones_outbox')
          .update({
            estado: transient && attempts < MAX_ATTEMPTS ? 'pending' : 'failed',
            intentos: attempts,
            next_retry_at: new Date(Date.now() + delaySec * 1000).toISOString(),
            ultimo_error: `Meta HTTP ${resp.status}: ${bodyTxt}`,
          })
          .eq('id', row.id);
        if (!transient || attempts >= MAX_ATTEMPTS) failed += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await admin
        .from('notificaciones_outbox')
        .update({
          estado: attempts < MAX_ATTEMPTS ? 'pending' : 'failed',
          intentos: attempts,
          next_retry_at: new Date(Date.now() + 120_000).toISOString(),
          ultimo_error: msg.slice(0, 180),
        })
        .eq('id', row.id);
      if (attempts >= MAX_ATTEMPTS) failed += 1;
    }
  }

  return jsonResp({ ok: true, processed: (rows ?? []).length, sent, pendingConfig, failed }, 200);
});
