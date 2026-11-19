import crypto from 'node:crypto';

/**
 * Implementación nativa sin dependencias externas de Web Push:
 *  - RFC 8292: Autenticación VAPID (JWT ES256 sobre curva P-256 / prime256v1)
 *  - RFC 8291 + RFC 8188: Cifrado de payload `aes128gcm` (ECDH P-256 + HKDF-SHA256 + AES-128-GCM)
 *
 * Mantiene 0 dependencias npm de terceros y compatibilidad total con Node 22+.
 */

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface WebPushSubscriptionTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushSendResult {
  ok: boolean;
  status: number;
  gone: boolean;
  error?: string;
}

function toBase64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function fromBase64Url(raw: string): Buffer {
  return Buffer.from(String(raw || '').trim(), 'base64url');
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function hkdfExpandSingleBlock(prk: Buffer, info: Buffer, length: number): Buffer {
  // RFC 5869 para L <= 32 bytes (una sola iteración T(1) = HMAC(PRK, info || 0x01))
  const input = Buffer.concat([info, Buffer.from([0x01])]);
  return hmacSha256(prk, input).subarray(0, length);
}

/** Genera un par de llaves VAPID EC P-256 en base64url (útil para tests y configuración inicial). */
export function generateVapidKeyPair(): VapidKeyPair {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: toBase64Url(ecdh.getPublicKey()),
    privateKey: toBase64Url(ecdh.getPrivateKey()),
  };
}

function createVapidPrivateKeyObject(
  publicKeyBase64Url: string,
  privateKeyBase64Url: string
): crypto.KeyObject {
  const pubBytes = fromBase64Url(publicKeyBase64Url);
  const privBytes = fromBase64Url(privateKeyBase64Url);

  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY debe ser una llave P-256 sin comprimir de 65 bytes en base64url.');
  }
  if (privBytes.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY debe ser una llave escalar P-256 de 32 bytes en base64url.');
  }

  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(pubBytes.subarray(1, 33)),
      y: toBase64Url(pubBytes.subarray(33, 65)),
      d: toBase64Url(privBytes),
    },
    format: 'jwk',
  });
}

/** Construye la cabecera `Authorization: vapid t=<jwt>, k=<pub>` según RFC 8292. */
export function createVapidAuthorizationHeader(params: {
  audience: string;
  subject: string;
  publicKey: string;
  privateKey: string;
  expirationSeconds?: number;
  nowSec?: number;
}): string {
  const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = nowSec + Math.min(24 * 3600, Math.max(60, params.expirationSeconds ?? 12 * 3600));

  const headerB64 = toBase64Url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const claimsB64 = toBase64Url(
    Buffer.from(
      JSON.stringify({
        aud: params.audience,
        exp,
        sub: params.subject,
      }),
      'utf8'
    )
  );

  const signingInput = `${headerB64}.${claimsB64}`;
  const keyObj = createVapidPrivateKeyObject(params.publicKey, params.privateKey);
  const sig = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: keyObj,
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${signingInput}.${toBase64Url(sig)}, k=${params.publicKey.trim()}`;
}

/**
 * Cifra un payload JSON UTF-8 bajo RFC 8291 (`aes128gcm`) para un suscriptor Web Push.
 */
export function encryptWebPushPayload(params: {
  payloadJson: string;
  subscriberPublicKey: string;
  subscriberAuthSecret: string;
  saltOverride?: Buffer;
}): { body: Buffer; contentEncoding: 'aes128gcm' } {
  const uaPublic = fromBase64Url(params.subscriberPublicKey);
  const authSecret = fromBase64Url(params.subscriberAuthSecret);

  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Llave pública p256dh del suscriptor inválida.');
  }
  if (authSecret.length < 16) {
    throw new Error('Secreto auth del suscriptor inválido.');
  }

  const serverEcdh = crypto.createECDH('prime256v1');
  serverEcdh.generateKeys();
  const asPublic = serverEcdh.getPublicKey();
  const sharedSecret = serverEcdh.computeSecret(uaPublic);

  // RFC 8291 Sección 3.3: IKM derivado con auth_secret y contexto "WebPush: info\0" || ua_pub || as_pub
  const prkKey = hmacSha256(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = hkdfExpandSingleBlock(prkKey, keyInfo, 32);

  const salt = params.saltOverride ?? crypto.randomBytes(16);
  const prk = hmacSha256(salt, ikm);
  const cek = hkdfExpandSingleBlock(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpandSingleBlock(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // RFC 8188: bloque único terminado con delimitador 0x02
  const plaintext = Buffer.concat([Buffer.from(params.payloadJson, 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // Cabecera RFC 8188: salt (16) + rs (4 bytes uint32be = 4096) + idlen (1 byte = 65) + asPublic (65)
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublic.length]), asPublic]);

  return {
    body: Buffer.concat([header, encrypted]),
    contentEncoding: 'aes128gcm',
  };
}

/**
 * Envía una notificación Web Push cifrada (VAPID + aes128gcm) al Push Service del navegador.
 */
export async function sendWebPushNotification(params: {
  subscription: WebPushSubscriptionTarget;
  payload: Record<string, unknown>;
  vapid: { publicKey: string; privateKey: string; subject: string };
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<WebPushSendResult> {
  const endpointUrl = new URL(params.subscription.endpoint);
  if (endpointUrl.protocol !== 'https:') {
    return { ok: false, status: 400, gone: false, error: 'El endpoint Web Push debe usar HTTPS.' };
  }

  const authHeader = createVapidAuthorizationHeader({
    audience: endpointUrl.origin,
    subject: params.vapid.subject,
    publicKey: params.vapid.publicKey,
    privateKey: params.vapid.privateKey,
  });

  const encrypted = encryptWebPushPayload({
    payloadJson: JSON.stringify(params.payload),
    subscriberPublicKey: params.subscription.p256dh,
    subscriberAuthSecret: params.subscription.auth,
  });

  const fetchFn = params.fetchImpl ?? fetch;
  const res = await fetchFn(endpointUrl.toString(), {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Encoding': encrypted.contentEncoding,
      'Content-Type': 'application/octet-stream',
      TTL: String(params.ttlSeconds ?? 3600),
      Urgency: 'high',
    },
    body: new Uint8Array(encrypted.body),
  });

  if (res.status >= 200 && res.status < 300) {
    return { ok: true, status: res.status, gone: false };
  }

  const errText = await res.text().catch(() => '');
  return {
    ok: false,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
    error: `HTTP ${res.status}${errText ? `: ${errText.slice(0, 140)}` : ''}`,
  };
}
