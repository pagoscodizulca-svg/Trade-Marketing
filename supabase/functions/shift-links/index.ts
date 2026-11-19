// Supabase Edge Function espejo (Deno) para Enlaces Dinámicos Firmados (v1.9.0)
// Rutas soportadas:
//   POST /generate-shift-link
//   POST /verify-shift-link
//   POST /revoke-shift-link
//
// Seguridad:
//   - Firma exclusiva en servidor con HMAC-SHA256 (`SHIFT_LINK_SECRET` >= 32 bytes).
//   - Almacena únicamente `SHA-256(token)` en `public.sesiones_jornada`.
//   - Cero PII en la URL (`?t=<payload_opaco>.<firma>`).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,256}\.[A-Za-z0-9_-]{43}$/;
const ALLOWED_ROLES = new Set(['super_admin', 'coordinacion', 'coordinadora', 'admin']);

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Método no permitido.' }, 405);
  }

  const secret = (Deno.env.get('SHIFT_LINK_SECRET') ?? '').trim();
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim();
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  const publicOrigin = (
    Deno.env.get('PUBLIC_APP_ORIGIN') ?? 'https://trade-marketing-qi6j.onrender.com'
  ).replace(/\/+$/, '');

  if (secret.length < 32 || !supabaseUrl || !serviceKey) {
    return jsonResponse(
      { ok: false, code: 'SERVER_MISCONFIGURED', error: 'Secretos de servidor no configurados.' },
      503
    );
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const pathname = new URL(req.url).pathname.replace(/\/+$/, '');
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (pathname.endsWith('/verify-shift-link')) {
    const token = String(body.token ?? req.headers.get('x-shift-token') ?? '').trim();
    if (!TOKEN_REGEX.test(token)) {
      return jsonResponse({ ok: false, valid: false, code: 'MALFORMED_TOKEN' }, 401);
    }
    const [payloadB64, sigB64] = token.split('.');
    const expected = await hmacSha256(secret, payloadB64!);
    const provided = fromBase64Url(sigB64!);
    if (!timingSafeEqualBytes(expected, provided)) {
      return jsonResponse({ ok: false, valid: false, code: 'INVALID_SIGNATURE' }, 401);
    }
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64!))) as {
      v?: number;
      sid?: string;
      exp?: number;
    };
    if (payload.v !== 1 || !payload.exp || payload.exp * 1000 <= Date.now()) {
      return jsonResponse({ ok: false, valid: false, code: 'TOKEN_EXPIRED' }, 401);
    }
    const tokenHash = await sha256Hex(token);
    const { data, error } = await admin.rpc('rpc_validar_sesion_jornada', {
      p_token_hash: tokenHash,
    });
    if (error || !data?.valid) {
      return jsonResponse({ ok: false, valid: false, code: data?.code ?? 'SESSION_INVALID' }, 401);
    }
    return jsonResponse({ ok: true, valid: true, session: data.session }, 200);
  }

  // Rutas administrativas requieren JWT válido de Coordinación o Super Admin
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!bearer) {
    return jsonResponse({ ok: false, code: 'AUTH_REQUIRED' }, 401);
  }
  const { data: userData, error: userErr } = await admin.auth.getUser(bearer);
  if (userErr || !userData?.user) {
    return jsonResponse({ ok: false, code: 'INVALID_JWT' }, 401);
  }
  const { data: profile } = await admin
    .from('profiles')
    .select('id, role, sucursal, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  const role = String(profile?.role ?? '').toLowerCase();
  if (!profile || profile.is_active === false || !ALLOWED_ROLES.has(role)) {
    return jsonResponse({ ok: false, code: 'FORBIDDEN_ROLE' }, 403);
  }

  if (pathname.endsWith('/revoke-shift-link')) {
    const sessionId = String(body.sessionId ?? '').trim();
    if (!UUID_REGEX.test(sessionId)) {
      return jsonResponse({ ok: false, code: 'INVALID_SESSION_ID' }, 400);
    }
    const { data: existing } = await admin
      .from('sesiones_jornada')
      .select('id, sucursal, revoked_at')
      .eq('id', sessionId)
      .maybeSingle();
    if (!existing) {
      return jsonResponse({ ok: false, code: 'NOT_FOUND' }, 404);
    }
    if (profile.sucursal !== 'GLOBAL' && existing.sucursal !== profile.sucursal) {
      return jsonResponse({ ok: false, code: 'FORBIDDEN_BRANCH' }, 403);
    }
    const { data: updated, error: updErr } = await admin
      .from('sesiones_jornada')
      .update({ revoked_at: existing.revoked_at ?? new Date().toISOString(), revoked_by: userData.user.id })
      .eq('id', sessionId)
      .select('id, rol, sucursal, ruta_codigo, expires_at, revoked_at')
      .single();
    if (updErr) return jsonResponse({ ok: false, code: 'REVOKE_ERROR' }, 500);
    return jsonResponse({ ok: true, session: updated }, 200);
  }

  if (pathname.endsWith('/generate-shift-link')) {
    const rol = body.rol === 'chofer' ? 'chofer' : body.rol === 'promotora' ? 'promotora' : null;
    const duracion = [8, 12, 24].includes(Number(body.duracionHoras))
      ? (Number(body.duracionHoras) as 8 | 12 | 24)
      : 12;
    const rutaCodigo = String(body.rutaCodigo ?? '').trim().toUpperCase();
    const targetSucursal =
      profile.sucursal === 'GLOBAL'
        ? String(body.sucursal ?? '').trim().toUpperCase()
        : String(profile.sucursal).toUpperCase();

    if (!rol || !rutaCodigo || !['ZULIA', 'VALENCIA', 'CENTRO', 'ORIENTE', 'CAPITAL'].includes(targetSucursal)) {
      return jsonResponse({ ok: false, code: 'INVALID_PAYLOAD' }, 400);
    }
    if (profile.sucursal !== 'GLOBAL' && body.sucursal && String(body.sucursal).toUpperCase() !== targetSucursal) {
      return jsonResponse({ ok: false, code: 'FORBIDDEN_BRANCH' }, 403);
    }

    const { data: region } = await admin
      .from('regiones')
      .select('id, nombre')
      .ilike('codigo', targetSucursal)
      .eq('activo', true)
      .maybeSingle();
    if (!region) {
      return jsonResponse({ ok: false, code: 'REGION_NOT_FOUND' }, 404);
    }

    const sid = crypto.randomUUID();
    const expEpochSec = Math.floor((Date.now() + duracion * 3600 * 1000) / 1000);
    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const payloadB64 = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ v: 1, sid, nonce, exp: expEpochSec }))
    );
    const sigB64 = toBase64Url(await hmacSha256(secret, payloadB64));
    const token = `${payloadB64}.${sigB64}`;
    const tokenHash = await sha256Hex(token);

    const { data: inserted, error: insErr } = await admin
      .from('sesiones_jornada')
      .insert({
        id: sid,
        token_hash: tokenHash,
        rol,
        personal_id:
          typeof body.personalId === 'string' && UUID_REGEX.test(body.personalId)
            ? body.personalId
            : null,
        personal_nombre: String(body.personalNombre ?? '').trim().slice(0, 140),
        region_id: region.id,
        sucursal: targetSucursal,
        ruta_codigo: rutaCodigo.slice(0, 120),
        duracion_horas: duracion,
        created_by: userData.user.id,
        expires_at: new Date(expEpochSec * 1000).toISOString(),
      })
      .select('id, rol, personal_id, personal_nombre, region_id, sucursal, ruta_codigo, duracion_horas, expires_at, revoked_at, created_at')
      .single();

    if (insErr || !inserted) {
      return jsonResponse({ ok: false, code: 'INSERT_FAILED' }, 500);
    }

    const basePath = rol === 'chofer' ? '/logistica/' : '/portal';
    return jsonResponse(
      {
        ok: true,
        url: `${publicOrigin}${basePath}?t=${encodeURIComponent(token)}`,
        session: { ...inserted, region_nombre: region.nombre },
      },
      201
    );
  }

  return jsonResponse({ ok: false, code: 'NOT_FOUND' }, 404);
});
