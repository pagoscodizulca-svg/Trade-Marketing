import { GoogleGenAI, Type } from '@google/genai';
import type { RawExtractedDegustacionRow } from '../utils/degustacionesTabularParser';
import {
  MAX_UPLOAD_FILE_BYTES,
  parseFechaCronograma,
  resolveScheduleWindow,
  sanitizeCellText,
} from '../utils/degustacionesTabularParser';
import { redactString, serverLogger } from './logger';

export const DEFAULT_AI_EXTRACTOR_TIMEOUT_MS = 45_000;
const MAX_AI_EXTRACTOR_TIMEOUT_MS = 180_000;

export interface PdfExtractionResult {
  provider: 'gemini' | 'openai';
  model: string;
  rows: RawExtractedDegustacionRow[];
}

export interface GeminiModelsLike {
  generateContent(params: {
    model: string;
    contents: unknown;
    config?: Record<string, unknown> & { abortSignal?: AbortSignal };
  }): Promise<{ text?: string }>;
}

export interface PdfExtractionOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  geminiClientFactory?: (apiKey: string) => { models: GeminiModelsLike };
}

export function resolveAiExtractorTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined) {
    if (Number.isFinite(overrideMs) && overrideMs > 0) {
      return Math.min(MAX_AI_EXTRACTOR_TIMEOUT_MS, Math.max(1, Math.trunc(overrideMs)));
    }
    return DEFAULT_AI_EXTRACTOR_TIMEOUT_MS;
  }

  const raw = (process.env.AI_EXTRACTOR_TIMEOUT_MS || '').trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_AI_EXTRACTOR_TIMEOUT_MS, parsed);
    }
  }
  return DEFAULT_AI_EXTRACTOR_TIMEOUT_MS;
}

function isAbortLikeError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  const msg = err.message.toLowerCase();
  return (
    name === 'aborterror' ||
    name === 'timeouterror' ||
    msg.includes('aborted') ||
    msg.includes('the operation was aborted')
  );
}

function sanitizeExtractorErrorMessage(raw: unknown): string {
  const base = raw instanceof Error ? raw.message : String(raw ?? 'Error desconocido');
  const redacted = redactString(base)
    .replace(/\b(AIza[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z_-]{10,})\b/g, '[REDACTED_API_KEY]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return redacted.slice(0, 180) || 'Fallo inesperado en el proveedor de IA.';
}

export class PdfExtractionError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'PDF_EXTRACTION_ERROR') {
    super(message);
    this.name = 'PdfExtractionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const EXTRACTION_SYSTEM_PROMPT = `Eres un motor determinista de extracción de datos operativos para Trade Marketing de CODIZULCA C.A.
Tu tarea es leer el documento PDF adjunto (puede ser una tabla digital nativa, un reporte de ventas FDV o un documento escaneado) y extraer TODAS las solicitudes o filas de planificación de degustaciones presentes en el documento.

REGLAS ESTRICTAS:
1. PROHIBIDO inventar filas o rellenar datos ficticios. Si el documento no contiene degustaciones o tablas de planificación, devuelve "rows": [].
2. Convierte todas las fechas al formato estricto "YYYY-MM-DD" cuando el día/mes/año sean identificables. Si una fila no tiene fecha legible, devuelve "" en "fecha".
3. Convierte las horas a formato 24h "HH:MM" (ej. "09:00", "14:00"). Si solo dice "Mañana", usa horaInicio="09:00", horaFin="13:00", turno="MAÑANA". Si dice "Tarde", usa horaInicio="14:00", horaFin="18:00", turno="TARDE". Si dice "Día Completo", usa horaInicio="09:00", horaFin="18:00", turno="COMPLETO".
4. En "productos" devuelve la lista limpia de productos solicitados (ej. ["MORTADELA", "ESPALDA"]).
5. Si no se especifica cantidad en kilos/unidades, usa 1. Si no se especifica promotora sugerida, devuelve "" en "promotoraSugerida".`;

/**
 * Valida la firma binaria `%PDF-` y el tamaño máximo permitido antes de enviar a IA.
 */
export function assertValidPdfBuffer(pdfBuffer: Buffer): void {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.byteLength === 0) {
    throw new PdfExtractionError('No se recibió ningún contenido binario PDF.', 400, 'EMPTY_PDF');
  }
  if (pdfBuffer.byteLength > MAX_UPLOAD_FILE_BYTES) {
    throw new PdfExtractionError(
      'El archivo PDF supera el límite máximo permitido de 15 MB.',
      413,
      'PDF_TOO_LARGE'
    );
  }
  const magicHeader = pdfBuffer.subarray(0, 5).toString('ascii');
  if (magicHeader !== '%PDF-') {
    throw new PdfExtractionError(
      'El archivo rechazado no posee una cabecera binaria PDF válida (%PDF-).',
      415,
      'INVALID_PDF_SIGNATURE'
    );
  }
}

function sanitizeAiRows(rawRows: unknown): RawExtractedDegustacionRow[] {
  if (!Array.isArray(rawRows)) return [];

  return rawRows
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => {
      const rawFecha = sanitizeCellText(item.fecha, 100);
      const parsedDate = parseFechaCronograma(rawFecha);
      const schedule = resolveScheduleWindow({
        rawHoraInicio: sanitizeCellText(item.horaInicio, 40),
        rawHoraFin: sanitizeCellText(item.horaFin, 40),
        rawHorarioOrTurno: sanitizeCellText(item.turno, 40),
      });

      const rawProds = Array.isArray(item.productos)
        ? item.productos.map((p) => sanitizeCellText(p, 120)).filter(Boolean)
        : sanitizeCellText(item.productos, 250)
            .split(/[,+/|;]+/)
            .map((p) => sanitizeCellText(p, 120))
            .filter(Boolean);

      const rawKilos = Number(item.cantidadKilos);
      const cantidadKilos =
        Number.isFinite(rawKilos) && rawKilos > 0 ? Math.round(rawKilos * 100) / 100 : 1;

      const rawPersonas = Number(item.personasEstimadas);
      const personasEstimadas =
        Number.isFinite(rawPersonas) && rawPersonas >= 0 ? Math.round(rawPersonas) : 0;

      return {
        fecha: parsedDate.ymd,
        fechaFormateada: parsedDate.fechaFormateada,
        fechaTimestamp: parsedDate.fechaTimestamp,
        fechaOrigenParcial: parsedDate.fechaOrigenParcial,
        horaInicio: schedule.horaInicio,
        horaFin: schedule.horaFin,
        turno: schedule.turno,
        clienteNombre: sanitizeCellText(item.clienteNombre),
        clienteCodigo: sanitizeCellText(item.clienteCodigo, 80),
        zonaDireccion: sanitizeCellText(item.zonaDireccion),
        productos: rawProds,
        cantidadKilos,
        personasEstimadas,
        vendedorFdv: sanitizeCellText(item.vendedorFdv, 120),
        promotoraSugerida: sanitizeCellText(item.promotoraSugerida, 120),
        observaciones: sanitizeCellText(item.observaciones),
      };
    })
    .filter((r) => Boolean(r.clienteNombre || r.fecha || r.productos.length > 0));
}

async function extractWithGemini(
  pdfBuffer: Buffer,
  apiKey: string,
  options?: PdfExtractionOptions
): Promise<PdfExtractionResult> {
  const ai = options?.geminiClientFactory
    ? options.geminiClientFactory(apiKey)
    : new GoogleGenAI({ apiKey });
  const model = (process.env.GEMINI_PDF_MODEL || 'gemini-2.5-flash').trim();
  const timeoutMs = resolveAiExtractorTimeoutMs(options?.timeoutMs);

  const controller = new AbortController();
  let onAbortListener: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbortListener = () => {
      const abortErr = new Error('AI extraction aborted by timeout');
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    controller.signal.addEventListener('abort', onAbortListener, { once: true });
  });

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let generatePromise: Promise<{ text?: string }> | null = null;

  try {
    generatePromise = ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: pdfBuffer.toString('base64'),
              },
            },
            {
              text: 'Extrae todas las filas de planificación o solicitud de degustaciones de este PDF devolviendo estrictamente el JSON requerido.',
            },
          ],
        },
      ],
      config: {
        abortSignal: controller.signal,
        systemInstruction: EXTRACTION_SYSTEM_PROMPT,
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['rows'],
          properties: {
            rows: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: [
                  'fecha',
                  'horaInicio',
                  'horaFin',
                  'turno',
                  'clienteNombre',
                  'clienteCodigo',
                  'zonaDireccion',
                  'productos',
                  'cantidadKilos',
                  'personasEstimadas',
                  'vendedorFdv',
                  'promotoraSugerida',
                  'observaciones',
                ],
                properties: {
                  fecha: { type: Type.STRING },
                  horaInicio: { type: Type.STRING },
                  horaFin: { type: Type.STRING },
                  turno: { type: Type.STRING, enum: ['MAÑANA', 'TARDE', 'COMPLETO'] },
                  clienteNombre: { type: Type.STRING },
                  clienteCodigo: { type: Type.STRING },
                  zonaDireccion: { type: Type.STRING },
                  productos: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  cantidadKilos: { type: Type.NUMBER },
                  personasEstimadas: { type: Type.INTEGER },
                  vendedorFdv: { type: Type.STRING },
                  promotoraSugerida: { type: Type.STRING },
                  observaciones: { type: Type.STRING },
                },
              },
            },
          },
        },
      },
    });
    // Evitar unhandledRejection si la promesa subyacente falla tras expirar el timeout
    generatePromise.catch(() => undefined);

    const response = await Promise.race([generatePromise, abortPromise]);

    const jsonText = response.text || '{"rows":[]}';
    const parsed = JSON.parse(jsonText) as { rows?: unknown };
    return {
      provider: 'gemini',
      model,
      rows: sanitizeAiRows(parsed.rows),
    };
  } catch (err) {
    if (isAbortLikeError(err, controller.signal)) {
      serverLogger.warn('ai_pdf_extraction_timeout', {
        provider: 'gemini',
        model,
        timeoutMs,
      });
      throw new PdfExtractionError(
        'Tiempo de espera agotado al procesar el PDF con el motor de IA. Intente nuevamente.',
        504,
        'AI_EXTRACTION_TIMEOUT'
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (onAbortListener) {
      controller.signal.removeEventListener('abort', onAbortListener);
    }
  }
}

async function extractWithOpenAi(
  pdfBuffer: Buffer,
  apiKey: string,
  options?: PdfExtractionOptions
): Promise<PdfExtractionResult> {
  const model = (process.env.OPENAI_PDF_MODEL || 'gpt-4o-mini').trim();
  const timeoutMs = resolveAiExtractorTimeoutMs(options?.timeoutMs);
  const fetchFn = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: EXTRACTION_SYSTEM_PROMPT }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_file',
                filename: 'planificacion.pdf',
                file_data: `data:application/pdf;base64,${pdfBuffer.toString('base64')}`,
              },
              {
                type: 'input_text',
                text: 'Extrae todas las filas de degustaciones del PDF según el esquema JSON estricto.',
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'extraccion_degustaciones_codizulca',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['rows'],
              properties: {
                rows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'fecha',
                      'horaInicio',
                      'horaFin',
                      'turno',
                      'clienteNombre',
                      'clienteCodigo',
                      'zonaDireccion',
                      'productos',
                      'cantidadKilos',
                      'personasEstimadas',
                      'vendedorFdv',
                      'promotoraSugerida',
                      'observaciones',
                    ],
                    properties: {
                      fecha: { type: 'string' },
                      horaInicio: { type: 'string' },
                      horaFin: { type: 'string' },
                      turno: { type: 'string', enum: ['MAÑANA', 'TARDE', 'COMPLETO'] },
                      clienteNombre: { type: 'string' },
                      clienteCodigo: { type: 'string' },
                      zonaDireccion: { type: 'string' },
                      productos: { type: 'array', items: { type: 'string' } },
                      cantidadKilos: { type: 'number' },
                      personasEstimadas: { type: 'integer' },
                      vendedorFdv: { type: 'string' },
                      promotoraSugerida: { type: 'string' },
                      observaciones: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });

    if (!res.ok) {
      throw new PdfExtractionError(
        `El servicio de extracción PDF no pudo completar la solicitud (HTTP ${res.status}).`,
        502,
        'OPENAI_UPSTREAM_ERROR'
      );
    }

    const body = (await res.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const rawText =
      body.output_text ||
      body.output?.flatMap((o) => o.content || []).find((c) => c.text)?.text ||
      '{"rows":[]}';
    const parsed = JSON.parse(rawText) as { rows?: unknown };
    return {
      provider: 'openai',
      model,
      rows: sanitizeAiRows(parsed.rows),
    };
  } catch (err) {
    if (err instanceof PdfExtractionError) throw err;
    if (isAbortLikeError(err, controller.signal)) {
      serverLogger.warn('ai_pdf_extraction_timeout', {
        provider: 'openai',
        model,
        timeoutMs,
      });
      throw new PdfExtractionError(
        'Tiempo de espera agotado al procesar el PDF con el motor de IA. Intente nuevamente.',
        504,
        'AI_EXTRACTION_TIMEOUT'
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Servicio principal de extracción estructurada para PDFs nativos y escaneados.
 */
export async function extractDegustacionesFromPdfBuffer(
  pdfBuffer: Buffer,
  options?: PdfExtractionOptions
): Promise<PdfExtractionResult> {
  assertValidPdfBuffer(pdfBuffer);

  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  const openAiKey = (process.env.OPENAI_API_KEY || '').trim();

  if (!geminiKey && !openAiKey) {
    throw new PdfExtractionError(
      'Falta configurar GEMINI_API_KEY (u OPENAI_API_KEY) en el archivo .env.local del servidor para extraer archivos PDF con IA estructurada. Los archivos Excel (.xlsx, .xls) y CSV (.csv) funcionan sin necesidad de API Key.',
      503,
      'AI_KEY_MISSING'
    );
  }

  try {
    if (geminiKey) {
      return await extractWithGemini(pdfBuffer, geminiKey, options);
    }
    return await extractWithOpenAi(pdfBuffer, openAiKey, options);
  } catch (err) {
    if (err instanceof PdfExtractionError) throw err;
    const safeMsg = sanitizeExtractorErrorMessage(err);
    serverLogger.error('ai_pdf_extraction_failed', {
      provider: geminiKey ? 'gemini' : 'openai',
      detail: safeMsg,
    });
    throw new PdfExtractionError(
      `No se pudo extraer la estructura del PDF: ${safeMsg}`,
      502,
      'AI_EXTRACTION_FAILED'
    );
  }
}
