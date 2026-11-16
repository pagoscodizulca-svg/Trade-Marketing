/**
 * Utilidades seguras (anti-XSS y sanitización estricta) para compartir el enlace nativo
 * del Portal de Promotoras (`/portal`) desde el Módulo 1 de Trade Marketing.
 */

const CONTROL_AND_BIDI_CHARS_REGEX =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Sanitiza texto libre eliminando caracteres de control o bidireccionales invisibles.
 */
export function sanitizePortalShareText(raw: unknown, maxLength = 160): string {
  if (raw === null || raw === undefined) return '';
  const cleaned = String(raw)
    .replace(CONTROL_AND_BIDI_CHARS_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

/**
 * Construye dinámicamente la URL absoluta segura del portal nativo `${window.location.origin}/portal`.
 * Solo acepta orígenes `http:` o `https:` válidos.
 */
export function getPromotorasPortalUrl(explicitOrigin?: string): string {
  const candidateOrigin =
    explicitOrigin ??
    (typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:3000');

  try {
    const parsed = new URL(candidateOrigin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'http://localhost:3000/portal';
    }
    return `${parsed.origin}/portal`;
  } catch {
    return 'http://localhost:3000/portal';
  }
}

/**
 * Sanitiza un número telefónico para `https://wa.me/<digitos>`:
 * - Elimina todo carácter no numérico (`+`, espacios, guiones, paréntesis, scripts).
 * - Convierte prefijo internacional `00` -> sin `00`.
 * - Convierte formato local venezolano de 11 dígitos (`0412...`, `0414...`, `0424...`, `0416...`, `0426...`)
 *   al formato internacional `584...`.
 * - Convierte 10 dígitos móviles venezolanos (`412...`, `414...`, `424...`, `416...`, `426...`) a `584...`.
 * - Retorna `''` si no cumple longitud E.164 válida (`8..15` dígitos).
 */
export function sanitizePhoneForWhatsApp(rawPhone: unknown): string {
  if (rawPhone === null || rawPhone === undefined) return '';
  let digits = String(rawPhone).replace(/\D+/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.length === 11 && /^04(12|14|16|24|26)\d{7}$/.test(digits)) {
    digits = `58${digits.slice(1)}`;
  } else if (digits.length === 10 && /^4(12|14|16|24|26)\d{7}$/.test(digits)) {
    digits = `58${digits}`;
  } else if (digits.length === 12 && /^5804(12|14|16|24|26)\d{7}$/.test(digits)) {
    digits = `58${digits.slice(3)}`;
  }

  if (digits.length < 8 || digits.length > 15) {
    return '';
  }

  return digits;
}

export interface PromotoraWhatsAppLinkOptions {
  promotoraName?: string | null;
  promotoraEmail?: string | null;
  phone?: string | null;
  storeName?: string | null;
  dateYmd?: string | null;
  explicitOrigin?: string;
}

/**
 * Construye una URL `https://wa.me/...` 100 % sanitizada y codificada con `encodeURIComponent`
 * para enviar el enlace de `/portal` directamente a una promotora (o abrir el selector de WhatsApp
 * cuando no hay teléfono válido registrado).
 */
export function buildPromotoraWhatsAppLink(options: PromotoraWhatsAppLinkOptions = {}): string {
  const portalUrl = getPromotorasPortalUrl(options.explicitOrigin);
  const cleanName = sanitizePortalShareText(options.promotoraName, 80);
  const cleanEmail = sanitizePortalShareText(options.promotoraEmail, 120).toLowerCase();
  const cleanStore = sanitizePortalShareText(options.storeName, 100);
  const cleanDate = sanitizePortalShareText(options.dateYmd, 20);
  const cleanPhone = sanitizePhoneForWhatsApp(options.phone);

  const lines: string[] = [
    cleanName
      ? `Hola ${cleanName}, te escribimos desde Coordinación de Trade Marketing (CODIZULCA C.A.).`
      : 'Hola, te compartimos el acceso al Portal de Ruta de Promotoras (CODIZULCA C.A.).',
  ];

  if (cleanStore) {
    lines.push(
      cleanDate
        ? `Tienes una degustación autorizada en *${cleanStore}* (${cleanDate}).`
        : `Tienes una degustación autorizada en *${cleanStore}*.`
    );
  }

  lines.push(`Ingresa a tu Módulo de Ruta aquí: ${portalUrl}`);

  if (cleanEmail && cleanEmail.includes('@')) {
    lines.push(`Inicia sesión con tu correo registrado: ${cleanEmail}`);
  }

  const encodedText = encodeURIComponent(lines.join('\n'));
  return cleanPhone
    ? `https://wa.me/${cleanPhone}?text=${encodedText}`
    : `https://wa.me/?text=${encodedText}`;
}
