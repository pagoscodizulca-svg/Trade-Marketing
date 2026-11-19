import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createUserScopedSupabaseClient,
  extractRawActiveSucursalHeader,
  getAdminSupabaseClient,
  isOperativeServerSucursal,
  normalizeServerSucursal,
  OPERATIVE_SUCURSALES,
  type AuthenticatedServerUser,
  type OperativeSucursal,
  type ServerSucursalCodigo,
} from './supabaseAdminAuth';
import { defaultTastingAlertDispatcher } from './tastingAlertDispatcher';

export { OPERATIVE_SUCURSALES, type OperativeSucursal };
export type FdvTurno = 'MAÑANA' | 'TARDE' | 'COMPLETO';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEGUSTACION_ID_REGEX = /^[A-Za-z0-9._:-]{3,120}$/;

function isValidCalendarYmd(ymd: string): boolean {
  if (!ISO_DATE_REGEX.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function getCaracasTodayYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function normalizeTurno(raw: unknown): FdvTurno | null {
  const clean = String(raw ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  if (clean === 'MANANA' || clean === 'AM') return 'MAÑANA';
  if (clean === 'TARDE' || clean === 'PM') return 'TARDE';
  if (clean === 'COMPLETO' || clean === 'TODO EL DIA' || clean === 'JORNADA COMPLETA') {
    return 'COMPLETO';
  }
  return null;
}

function defaultHoraForTurno(turno: FdvTurno): string {
  if (turno === 'TARDE') return '02:00 PM - 06:00 PM';
  if (turno === 'COMPLETO') return '09:00 AM - 05:00 PM';
  return '09:00 AM - 01:00 PM';
}

export function normalizeDegustacionKey(rawId: string): string {
  return String(rawId || '')
    .trim()
    .replace(/^DEG-/i, '')
    .trim()
    .toLowerCase()
    .slice(0, 128);
}

export function normalizeRequestedBranch(raw: unknown): OperativeSucursal | 'GLOBAL' | null {
  return normalizeServerSucursal(raw);
}

export const FdvSolicitudDegustacionSchema = z
  .object({
    degustacionId: z
      .string()
      .trim()
      .regex(
        DEGUSTACION_ID_REGEX,
        'degustacionId debe contener entre 3 y 120 caracteres alfanuméricos (._:- permitidos).'
      )
      .optional(),
    clienteCodigo: z.string().trim().max(64).optional().default(''),
    clienteNombre: z.string().trim().min(2).max(200).optional(),
    store: z.string().trim().min(2).max(200).optional(),
    vendedorId: z.string().trim().max(64).optional().default(''),
    vendedorNombre: z.string().trim().max(160).optional(),
    ruta: z.string().trim().max(120).optional().default(''),
    fecha: z
      .string()
      .trim()
      .refine(isValidCalendarYmd, 'fecha debe tener formato YYYY-MM-DD válido.'),
    turno: z
      .string()
      .trim()
      .optional()
      .default('MAÑANA')
      .transform((v, ctx) => {
        const norm = normalizeTurno(v);
        if (!norm) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'turno inválido. Valores permitidos: MAÑANA, TARDE o COMPLETO.',
          });
          return z.NEVER;
        }
        return norm;
      }),
    hora: z.string().trim().max(64).optional(),
    productos: z
      .array(z.string().trim().min(1).max(160))
      .min(1, 'Debe especificar al menos 1 producto para la degustación.')
      .max(30, 'Máximo 30 productos por solicitud.'),
    kilosEstimados: z.coerce.number().finite().min(0).max(500).optional().default(3.5),
    personasEstimadas: z.coerce.number().int().min(1).max(5000).optional().default(80),
    observaciones: z.string().trim().max(1000).optional().default(''),
    contactoPunto: z.string().trim().max(160).optional().default(''),
    telefonoContacto: z.string().trim().max(40).optional().default(''),
    materialPop: z.enum(['SI', 'NO']).optional().default('SI'),
    requierePromotora: z.boolean().optional().default(true),
    promoterType: z.enum(['Fija', 'Rotativa']).optional().default('Fija'),
    sucursal: z.string().trim().max(80).optional(),
  })
  .superRefine((val, ctx) => {
    const storeName = (val.clienteNombre || val.store || '').trim();
    if (storeName.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clienteNombre'],
        message: 'Se requiere clienteNombre (o store) con al menos 2 caracteres.',
      });
    }
    const todayCaracas = getCaracasTodayYmd();
    if (val.fecha < todayCaracas) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fecha'],
        message: `La fecha (${val.fecha}) no puede ser anterior al día actual en Venezuela (${todayCaracas}).`,
      });
    }
  });

export type FdvSolicitudDegustacionInput = z.infer<typeof FdvSolicitudDegustacionSchema>;

export interface StoredFdvSurveyRow {
  id: string;
  type: string;
  date: string;
  store: string;
  promoter: string;
  product: string;
  comments: string;
  creatorId?: string | null;
  autor_user_id: string | null;
  sucursal: ServerSucursalCodigo | null;
  degustacion_key: string | null;
  leido_trade: boolean;
  visto_en_trade_at: string | null;
  en_historial?: boolean;
  created_at?: string;
}

export interface PersistFdvSurveyRecord {
  type: 'Degustacion';
  date: string;
  store: string;
  promoter: string;
  product: string;
  comments: string;
  creatorId: string;
  autor_user_id: string;
  sucursal: OperativeSucursal;
  degustacion_key: string;
  leido_trade: false;
  visto_en_trade_at: null;
  created_at: string;
}

export interface FdvSolicitudesGateway {
  findActiveByKey(
    authUser: AuthenticatedServerUser,
    degustacionKey: string
  ): Promise<StoredFdvSurveyRow | null>;
  insertSolicitud(
    authUser: AuthenticatedServerUser,
    record: PersistFdvSurveyRecord
  ): Promise<{ status: 'inserted'; row: StoredFdvSurveyRow } | { status: 'conflict' }>;
  updateSolicitud(
    authUser: AuthenticatedServerUser,
    id: string,
    record: Omit<PersistFdvSurveyRecord, 'created_at' | 'autor_user_id'>
  ): Promise<StoredFdvSurveyRow>;
}

function isUniqueViolationError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (String(err.code || '') === '23505') return true;
  return /duplicate key|unique constraint|uq_surveys_degustacion_key_active/i.test(
    String(err.message || '')
  );
}

function isMissingDegustacionKeyColumnError(
  err: { code?: string; message?: string } | null | undefined
): boolean {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  return (
    (code === '42703' || code === 'PGRST204') &&
    /degustacion_key/i.test(msg)
  );
}

function extractSurveyEstado(commentsRaw: unknown): string {
  if (!commentsRaw) return 'SOLICITADA';
  try {
    const obj =
      typeof commentsRaw === 'string'
        ? (JSON.parse(commentsRaw) as Record<string, unknown>)
        : (commentsRaw as Record<string, unknown>);
    return String(obj?.estado || obj?.status || 'SOLICITADA')
      .trim()
      .toUpperCase();
  } catch {
    return 'SOLICITADA';
  }
}

function isEditableSolicitudEstado(estado: string): boolean {
  return estado === 'SOLICITADA' || estado === 'PENDIENTE' || estado === 'PENDIENTE_APROBACION';
}

function createSupabaseFdvSolicitudesGateway(): FdvSolicitudesGateway {
  const getClientForActor = (authUser: AuthenticatedServerUser) => {
    const userScoped = authUser.accessToken
      ? createUserScopedSupabaseClient(authUser.accessToken, authUser.activeSucursalHeader)
      : null;
    const client = userScoped || getAdminSupabaseClient();
    if (!client) {
      throw new Error('SUPABASE_SERVER_UNCONFIGURED');
    }
    return client;
  };

  const selectColumnsFull =
    'id, type, date, store, promoter, product, comments, "creatorId", autor_user_id, sucursal, degustacion_key, leido_trade, visto_en_trade_at, en_historial, created_at';
  const selectColumnsLegacy =
    'id, type, date, store, promoter, product, comments, "creatorId", autor_user_id, sucursal, leido_trade, visto_en_trade_at, en_historial, created_at';

  return {
    async findActiveByKey(authUser, degustacionKey) {
      const client = getClientForActor(authUser);
      const { data, error } = await client
        .from('surveys')
        .select(selectColumnsFull)
        .eq('type', 'Degustacion')
        .eq('degustacion_key', degustacionKey)
        .eq('en_historial', false)
        .limit(1)
        .maybeSingle();

      if (!error) {
        return (data as StoredFdvSurveyRow | null) ?? null;
      }

      if (isMissingDegustacionKeyColumnError(error)) {
        const fallback = await client
          .from('surveys')
          .select(selectColumnsLegacy)
          .eq('type', 'Degustacion')
          .eq('en_historial', false)
          .ilike('comments', `%${degustacionKey}%`)
          .limit(1)
          .maybeSingle();
        if (fallback.error) {
          throw new Error(fallback.error.message);
        }
        return fallback.data
          ? ({ ...(fallback.data as Record<string, unknown>), degustacion_key: null } as StoredFdvSurveyRow)
          : null;
      }

      throw new Error(error.message);
    },

    async insertSolicitud(authUser, record) {
      const client = getClientForActor(authUser);
      const res = await client
        .from('surveys')
        .insert(record)
        .select(selectColumnsFull)
        .single();

      if (!res.error && res.data) {
        return { status: 'inserted', row: res.data as StoredFdvSurveyRow };
      }

      if (isUniqueViolationError(res.error)) {
        return { status: 'conflict' };
      }

      if (isMissingDegustacionKeyColumnError(res.error)) {
        const { degustacion_key: _omit, ...legacyRecord } = record;
        void _omit;
        const retry = await client
          .from('surveys')
          .insert(legacyRecord)
          .select(selectColumnsLegacy)
          .single();
        if (retry.error) {
          if (isUniqueViolationError(retry.error)) return { status: 'conflict' };
          throw new Error(retry.error.message);
        }
        return {
          status: 'inserted',
          row: { ...(retry.data as Record<string, unknown>), degustacion_key: null } as StoredFdvSurveyRow,
        };
      }

      throw new Error(res.error?.message || 'Error insertando solicitud de degustación.');
    },

    async updateSolicitud(authUser, id, record) {
      const client = getClientForActor(authUser);
      const res = await client
        .from('surveys')
        .update(record)
        .eq('id', id)
        .select(selectColumnsFull)
        .single();

      if (!res.error && res.data) {
        return res.data as StoredFdvSurveyRow;
      }

      if (isMissingDegustacionKeyColumnError(res.error)) {
        const { degustacion_key: _omit, ...legacyRecord } = record;
        void _omit;
        const retry = await client
          .from('surveys')
          .update(legacyRecord)
          .eq('id', id)
          .select(selectColumnsLegacy)
          .single();
        if (retry.error || !retry.data) {
          throw new Error(retry.error?.message || 'Error actualizando solicitud.');
        }
        return {
          ...(retry.data as Record<string, unknown>),
          degustacion_key: null,
        } as StoredFdvSurveyRow;
      }

      throw new Error(res.error?.message || 'Error actualizando solicitud de degustación.');
    },
  };
}

/**
 * Fábrica del handler `POST /api/fdv/solicitudes-degustacion`:
 * - Valida estrictamente el payload con Zod.
 * - Sella `autor_user_id` y `sucursal` desde la sesión verificada del servidor (anti-suplantación y anti-cruce de sede).
 * - Impide auto-aprobación (fuerza estado `SOLICITADA`).
 * - Garantiza idempotencia atómica ante reintentos secuenciales o doble envío paralelo (`Promise.all`).
 */
export function createFdvSolicitudesHandler(gatewayOverride?: FdvSolicitudesGateway) {
  const gateway = gatewayOverride ?? createSupabaseFdvSolicitudesGateway();

  return async function handleCreateFdvSolicitud(req: Request, res: Response): Promise<void> {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({
        error: 'Autenticación requerida.',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const parsed = FdvSolicitudDegustacionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Payload inválido para solicitud de degustación.',
        code: 'INVALID_SOLICITUD_PAYLOAD',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const input = parsed.data;

    // Resolver sucursal autoritativa desde la identidad del servidor + x-sucursal-activa
    const requestedBranch = input.sucursal ? normalizeRequestedBranch(input.sucursal) : null;
    if (input.sucursal && !requestedBranch) {
      res.status(400).json({
        error:
          'Sucursal inválida. Hubs operativos permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
        code: 'INVALID_BRANCH',
      });
      return;
    }

    const rawHeaderBranch = extractRawActiveSucursalHeader(req);
    const headerBranch = rawHeaderBranch ? normalizeRequestedBranch(rawHeaderBranch) : null;
    if (rawHeaderBranch && !headerBranch) {
      res.status(400).json({
        error:
          'Cabecera x-sucursal-activa inválida. Hubs operativos permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
        code: 'INVALID_BRANCH',
      });
      return;
    }

    let effectiveSucursal: OperativeSucursal;
    if (isOperativeServerSucursal(authUser.sucursal)) {
      if (requestedBranch && requestedBranch !== authUser.sucursal) {
        res.status(403).json({
          error: `Cruce de sede bloqueado: tu perfil pertenece a ${authUser.sucursal} y no puede registrar solicitudes para ${requestedBranch}.`,
          code: 'FORBIDDEN_BRANCH',
        });
        return;
      }
      if (headerBranch && headerBranch !== authUser.sucursal) {
        res.status(403).json({
          error: `Cruce de sede bloqueado: tu perfil pertenece a ${authUser.sucursal} y no puede operar bajo ${headerBranch}.`,
          code: 'FORBIDDEN_BRANCH',
        });
        return;
      }
      effectiveSucursal = authUser.sucursal;
    } else if (authUser.sucursal === 'GLOBAL') {
      if (requestedBranch === 'GLOBAL' || headerBranch === 'GLOBAL') {
        res.status(400).json({
          error:
            'Un perfil GLOBAL debe especificar explícitamente un hub operativo (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) y no GLOBAL.',
          code: 'BRANCH_REQUIRED',
        });
        return;
      }
      if (requestedBranch && headerBranch && requestedBranch !== headerBranch) {
        res.status(400).json({
          error: `Conflicto entre body.sucursal (${requestedBranch}) y x-sucursal-activa (${headerBranch}).`,
          code: 'INVALID_BRANCH',
        });
        return;
      }
      const candidate =
        (requestedBranch && isOperativeServerSucursal(requestedBranch) ? requestedBranch : null) ??
        (headerBranch && isOperativeServerSucursal(headerBranch) ? headerBranch : null);
      if (!candidate) {
        res.status(400).json({
          error:
            'Un perfil GLOBAL debe especificar explícitamente el hub operativo (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) de la degustación.',
          code: 'BRANCH_REQUIRED',
        });
        return;
      }
      effectiveSucursal = candidate;
    } else {
      res.status(403).json({
        error: 'Su cuenta no tiene una sucursal operativa asignada en public.profiles.',
        code: 'BRANCH_UNASSIGNED',
      });
      return;
    }

    const scopedAuthUser: AuthenticatedServerUser = {
      ...authUser,
      activeSucursalHeader: effectiveSucursal,
    };

    const storeName = (input.clienteNombre || input.store || '').trim();
    const vendedorNombre = (input.vendedorNombre || authUser.email || 'Vendedor FDV').trim();
    const hora = (input.hora && input.hora.trim()) || defaultHoraForTurno(input.turno);
    const rawDegustacionId = input.degustacionId || `fdv-${crypto.randomUUID()}`;
    const cleanDegustacionId = rawDegustacionId.trim().replace(/^DEG-/i, '');
    const degustacionKey = normalizeDegustacionKey(cleanDegustacionId);
    const productCsv = input.productos.join(', ');
    const isoNow = new Date().toISOString();

    const commentsPayload = {
      isTasting: true,
      source: 'vendedor_app_api',
      degustacionId: cleanDegustacionId,
      id: cleanDegustacionId,
      autorUserId: authUser.id,
      sucursal: effectiveSucursal,
      client: storeName,
      cliente: storeName,
      clienteCodigo: input.clienteCodigo,
      store: storeName,
      vendedor: vendedorNombre,
      salesRep: vendedorNombre,
      vendedorId: input.vendedorId,
      promoter: 'POR ASIGNAR (Trade Marketing)',
      promotoraAsignada: '',
      ruta: input.ruta,
      date: input.fecha,
      turno: input.turno,
      shift: `${input.turno} (${hora})`,
      time: hora,
      products: input.productos,
      product: productCsv,
      kilos: input.kilosEstimados,
      kg: input.kilosEstimados,
      personas: input.personasEstimadas,
      personasEstimadas: input.personasEstimadas,
      // Anti auto-aprobación: el servidor fuerza siempre el estado inicial `SOLICITADA`
      estado: 'SOLICITADA',
      status: 'pendiente',
      leido_trade: false,
      visto_en_trade_at: null,
      created_at: isoNow,
      requierePromotora: input.requierePromotora,
      promoterType: input.promoterType,
      materialPop: input.materialPop,
      contactoPunto: input.contactoPunto,
      telefonoContacto: input.telefonoContacto,
      address: input.ruta
        ? `Ruta: ${input.ruta}${input.contactoPunto ? ` | Contacto: ${input.contactoPunto}` : ''}`
        : input.contactoPunto,
      notes: input.observaciones,
      originalComments: input.observaciones,
      observaciones: input.observaciones,
      notasTradeMarketing: '',
      resultado: null,
    };

    const record: PersistFdvSurveyRecord = {
      type: 'Degustacion',
      date: input.fecha,
      store: storeName,
      promoter: vendedorNombre,
      product: productCsv,
      comments: JSON.stringify(commentsPayload),
      creatorId: vendedorNombre,
      autor_user_id: authUser.id,
      sucursal: effectiveSucursal,
      degustacion_key: degustacionKey,
      leido_trade: false,
      visto_en_trade_at: null,
      created_at: isoNow,
    };

    try {
      // 1. Verificar si ya existe una solicitud activa con esta clave canónica
      const existing = await gateway.findActiveByKey(scopedAuthUser, degustacionKey);
      if (existing) {
        if (
          existing.autor_user_id &&
          existing.autor_user_id !== authUser.id &&
          !authUser.isCoordinatorOrAdmin
        ) {
          res.status(409).json({
            error: 'El identificador de degustación pertenece a otro usuario.',
            code: 'DEGUSTACION_ID_CONFLICT',
          });
          return;
        }
        const currentEstado = extractSurveyEstado(existing.comments);
        if (!isEditableSolicitudEstado(currentEstado) && !authUser.isCoordinatorOrAdmin) {
          res.status(409).json({
            error: `La solicitud ya se encuentra en estado ${currentEstado} y no puede modificarse.`,
            code: 'SOLICITUD_LOCKED',
          });
          return;
        }

        const { created_at: _c, autor_user_id: _a, ...updatable } = record;
        void _c;
        void _a;
        const updated = await gateway.updateSolicitud(scopedAuthUser, existing.id, updatable);
        res.status(200).json({
          ok: true,
          idempotentHit: true,
          wasUpdate: true,
          solicitud: updated,
        });
        return;
      }

      // 2. Inserción atómica protegida por `uq_surveys_degustacion_key_active` (PG 23505)
      const insertResult = await gateway.insertSolicitud(scopedAuthUser, record);
      if (insertResult.status === 'inserted') {
        // Despacho asíncrono no bloqueante de alertas Outbox (WhatsApp + Web Push) sin frenar al vendedor FDV
        if (!gatewayOverride) {
          void defaultTastingAlertDispatcher
            .dispatchPendingTastingAlerts(10)
            .catch(() => undefined);
        }
        res.status(201).json({
          ok: true,
          idempotentHit: false,
          wasUpdate: false,
          solicitud: insertResult.row,
        });
        return;
      }

      // 3. Resolución atómica de carrera concurrente (`Promise.all` / doble clic simultáneo)
      const winner = await gateway.findActiveByKey(scopedAuthUser, degustacionKey);
      if (
        winner &&
        (!winner.autor_user_id ||
          winner.autor_user_id === authUser.id ||
          authUser.isCoordinatorOrAdmin)
      ) {
        res.status(200).json({
          ok: true,
          idempotentHit: true,
          wasUpdate: false,
          solicitud: winner,
        });
        return;
      }

      res.status(409).json({
        error: 'Conflicto de identificador de degustación: el registro ya existe bajo otro propietario.',
        code: 'DEGUSTACION_ID_CONFLICT',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error interno procesando la solicitud.';
      if (msg === 'SUPABASE_SERVER_UNCONFIGURED') {
        res.status(503).json({
          error: 'Servicio de base de datos no configurado en el servidor.',
          code: 'SUPABASE_SERVER_UNCONFIGURED',
        });
        return;
      }
      if (/42501|row-level security|Cruce de sede/i.test(msg)) {
        res.status(403).json({
          error: 'Operación denegada por las políticas de seguridad de la base de datos.',
          code: 'RLS_DENIED',
        });
        return;
      }
      res.status(500).json({
        error: 'No se pudo registrar la solicitud de degustación.',
        code: 'FDV_SOLICITUD_INTERNAL_ERROR',
      });
    }
  };
}

export const handleCreateFdvSolicitudDegustacion = createFdvSolicitudesHandler();
