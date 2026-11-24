import type { PriceOcrDetectionResult } from '../types';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';

const ALLOWED_OCR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_OCR_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PriceOcrClientResponse {
  model: string;
  requiresHumanConfirmation: true;
  result: PriceOcrDetectionResult;
}

/**
 * Envía la fotografía del hablador/fleje de precio al endpoint autenticado del servidor
 * (`POST /api/precios/ocr-hablador`). Cero llaves de IA en el navegador.
 */
export async function scanShelfPriceTagWithAi(file: File | Blob): Promise<PriceOcrClientResponse> {
  if (!file || file.size <= 0) {
    throw new Error('Selecciona o captura una fotografía del hablador primero.');
  }
  if (file.size > MAX_OCR_IMAGE_BYTES) {
    throw new Error('La fotografía supera el máximo permitido de 5 MB.');
  }
  const mime = String(file.type || '').trim().toLowerCase();
  if (!ALLOWED_OCR_MIMES.has(mime)) {
    throw new Error('Formato no permitido. Usa únicamente fotografías JPEG, PNG o WebP.');
  }

  if (!isSupabaseConfigured) {
    throw new Error('Supabase Auth no está configurado para autenticar la lectura IA.');
  }

  const { data } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('Debes iniciar sesión para usar la lectura asistida con IA.');
  }

  const OCR_TIMEOUT_MS = 60_000;
  let resp: Response | null = null;
  let lastNetworkErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
    try {
      resp = await fetch('/api/precios/ocr-hablador', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mime,
        },
        body: file,
        signal: controller.signal,
      });
      if (resp.status !== 502 && resp.status !== 503 && resp.status !== 504 && resp.status !== 408) {
        break;
      }
    } catch (err) {
      lastNetworkErr = err;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!resp) {
    throw new Error(
      lastNetworkErr instanceof Error && lastNetworkErr.name === 'AbortError'
        ? 'Tiempo de espera agotado al analizar el hablador. Ingresa el precio manualmente o intenta nuevamente.'
        : 'Error de red al analizar el hablador con IA. Verifica tu conexión e intenta nuevamente.'
    );
  }

  const payload = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    code?: string;
    model?: string;
    result?: PriceOcrDetectionResult;
  };

  if (!resp.ok || !payload.ok || !payload.result) {
    throw new Error(
      payload.error ||
        (resp.status === 429
          ? 'Has alcanzado el límite temporal de lecturas con IA. Ingresa el precio manualmente o espera unos minutos.'
          : 'No se pudo leer el hablador con IA. Puedes ingresar el precio manualmente.')
    );
  }

  return {
    model: String(payload.model || 'gemini'),
    requiresHumanConfirmation: true,
    result: payload.result,
  };
}
