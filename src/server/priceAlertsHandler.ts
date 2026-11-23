import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createUserScopedSupabaseClient,
  getAdminSupabaseClient,
  normalizeServerAllowedRegionList,
  normalizeServerAllowedRegionToken,
  type AuthenticatedServerUser,
  type ServerAllowedRegionCode,
} from './supabaseAdminAuth';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PatchAlertSchema = z.object({
  estado: z.enum(['pendiente', 'revisada', 'descartada']),
  notas_revision: z.string().trim().max(400).nullable().optional(),
});

const UpsertAlertConfigSchema = z.object({
  region: z.string().trim().min(1).max(40),
  umbral_caida_porcentaje: z
    .number()
    .finite()
    .gt(0, 'El umbral debe ser mayor a 0%.')
    .lte(95, 'El umbral máximo es 95%.'),
  ventana_dias: z.number().int().min(1).max(365).default(30),
  activo: z.boolean().default(true),
});

export interface PriceAlertServerRow {
  id: string;
  price_id: string;
  previous_price_id: string | null;
  region: string;
  cadena: string | null;
  zona: string | null;
  store: string;
  producto_propio: string;
  marca_competidor: string;
  precio_anterior_usd: number;
  precio_actual_usd: number;
  caida_porcentaje: number;
  umbral_aplicado: number;
  severidad: 'baja' | 'media' | 'alta' | 'critica';
  estado: 'pendiente' | 'revisada' | 'descartada';
  notas_revision: string | null;
  revisada_por: string | null;
  revisada_at: string | null;
  created_at: string;
}

export interface PriceAlertConfigServerRow {
  id?: string;
  region: string;
  umbral_caida_porcentaje: number;
  ventana_dias: number;
  activo: boolean;
  updated_by?: string | null;
  updated_at?: string;
}

export interface PriceAlertsGateway {
  listAlerts(filters: { estado?: string; limit?: number }): Promise<PriceAlertServerRow[]>;
  getAlertById(id: string): Promise<PriceAlertServerRow | null>;
  updateAlert(
    id: string,
    patch: {
      estado: 'pendiente' | 'revisada' | 'descartada';
      notas_revision: string | null;
      revisada_por: string;
      revisada_at: string;
    }
  ): Promise<PriceAlertServerRow | null>;
  listConfigs(): Promise<PriceAlertConfigServerRow[]>;
  upsertConfig(input: {
    region: string;
    umbral_caida_porcentaje: number;
    ventana_dias: number;
    activo: boolean;
    updated_by: string;
  }): Promise<PriceAlertConfigServerRow>;
}

function resolveActorAllowedRegions(actor: AuthenticatedServerUser): {
  isGlobal: boolean;
  allowedRegions: ServerAllowedRegionCode[];
} {
  if (actor.isSuperAdmin || actor.sucursal === 'GLOBAL') {
    return { isGlobal: true, allowedRegions: [] };
  }
  const list =
    Array.isArray(actor.allowedRegions) && actor.allowedRegions.length > 0
      ? actor.allowedRegions
      : normalizeServerAllowedRegionList(null, actor.sucursal);
  return { isGlobal: false, allowedRegions: list };
}

function createSupabasePriceAlertsGateway(accessToken: string): PriceAlertsGateway | null {
  // Prefer user-scoped JWT client so PostgreSQL RLS enforces multi-region isolation in defense in depth
  const client = createUserScopedSupabaseClient(accessToken) || getAdminSupabaseClient();
  if (!client) return null;

  return {
    async listAlerts(filters) {
      let query = client
        .from('alertas_precios')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(filters.limit ?? 200);
      if (filters.estado && filters.estado !== 'TODAS') {
        query = query.eq('estado', filters.estado);
      }
      const { data, error } = await query;
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return [];
        throw new Error(`No se pudieron cargar las alertas de precios (${error.message}).`);
      }
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        id: String(r.id),
        price_id: String(r.price_id),
        previous_price_id: r.previous_price_id ? String(r.previous_price_id) : null,
        region: String(r.region ?? ''),
        cadena: r.cadena ? String(r.cadena) : null,
        zona: r.zona ? String(r.zona) : null,
        store: String(r.store ?? ''),
        producto_propio: String(r.producto_propio ?? ''),
        marca_competidor: String(r.marca_competidor ?? ''),
        precio_anterior_usd: Number(r.precio_anterior_usd ?? 0),
        precio_actual_usd: Number(r.precio_actual_usd ?? 0),
        caida_porcentaje: Number(r.caida_porcentaje ?? 0),
        umbral_aplicado: Number(r.umbral_aplicado ?? 10),
        severidad: (String(r.severidad ?? 'media') as PriceAlertServerRow['severidad']),
        estado: (String(r.estado ?? 'pendiente') as PriceAlertServerRow['estado']),
        notas_revision: r.notas_revision ? String(r.notas_revision) : null,
        revisada_por: r.revisada_por ? String(r.revisada_por) : null,
        revisada_at: r.revisada_at ? String(r.revisada_at) : null,
        created_at: String(r.created_at ?? ''),
      }));
    },

    async getAlertById(id) {
      const { data, error } = await client
        .from('alertas_precios')
        .select('*')
        .eq('id', id)
        .limit(1);
      if (error || !Array.isArray(data) || data.length === 0) return null;
      const r = data[0] as Record<string, unknown>;
      return {
        id: String(r.id),
        price_id: String(r.price_id),
        previous_price_id: r.previous_price_id ? String(r.previous_price_id) : null,
        region: String(r.region ?? ''),
        cadena: r.cadena ? String(r.cadena) : null,
        zona: r.zona ? String(r.zona) : null,
        store: String(r.store ?? ''),
        producto_propio: String(r.producto_propio ?? ''),
        marca_competidor: String(r.marca_competidor ?? ''),
        precio_anterior_usd: Number(r.precio_anterior_usd ?? 0),
        precio_actual_usd: Number(r.precio_actual_usd ?? 0),
        caida_porcentaje: Number(r.caida_porcentaje ?? 0),
        umbral_aplicado: Number(r.umbral_aplicado ?? 10),
        severidad: String(r.severidad ?? 'media') as PriceAlertServerRow['severidad'],
        estado: String(r.estado ?? 'pendiente') as PriceAlertServerRow['estado'],
        notas_revision: r.notas_revision ? String(r.notas_revision) : null,
        revisada_por: r.revisada_por ? String(r.revisada_por) : null,
        revisada_at: r.revisada_at ? String(r.revisada_at) : null,
        created_at: String(r.created_at ?? ''),
      };
    },

    async updateAlert(id, patch) {
      const { data, error } = await client
        .from('alertas_precios')
        .update(patch)
        .eq('id', id)
        .select('*')
        .limit(1);
      if (error) {
        throw new Error(`No se pudo actualizar la alerta (${error.message}).`);
      }
      if (!Array.isArray(data) || data.length === 0) return null;
      const r = data[0] as Record<string, unknown>;
      return {
        id: String(r.id),
        price_id: String(r.price_id),
        previous_price_id: r.previous_price_id ? String(r.previous_price_id) : null,
        region: String(r.region ?? ''),
        cadena: r.cadena ? String(r.cadena) : null,
        zona: r.zona ? String(r.zona) : null,
        store: String(r.store ?? ''),
        producto_propio: String(r.producto_propio ?? ''),
        marca_competidor: String(r.marca_competidor ?? ''),
        precio_anterior_usd: Number(r.precio_anterior_usd ?? 0),
        precio_actual_usd: Number(r.precio_actual_usd ?? 0),
        caida_porcentaje: Number(r.caida_porcentaje ?? 0),
        umbral_aplicado: Number(r.umbral_aplicado ?? 10),
        severidad: String(r.severidad ?? 'media') as PriceAlertServerRow['severidad'],
        estado: String(r.estado ?? 'pendiente') as PriceAlertServerRow['estado'],
        notas_revision: r.notas_revision ? String(r.notas_revision) : null,
        revisada_por: r.revisada_por ? String(r.revisada_por) : null,
        revisada_at: r.revisada_at ? String(r.revisada_at) : null,
        created_at: String(r.created_at ?? ''),
      };
    },

    async listConfigs() {
      const { data, error } = await client
        .from('configuracion_alertas_precios')
        .select('id, region, umbral_caida_porcentaje, ventana_dias, activo, updated_by, updated_at')
        .order('region', { ascending: true });
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') {
          return [{ region: 'GLOBAL', umbral_caida_porcentaje: 10, ventana_dias: 30, activo: true }];
        }
        throw new Error(`No se pudo cargar la configuración de alertas (${error.message}).`);
      }
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        id: r.id ? String(r.id) : undefined,
        region: String(r.region ?? 'GLOBAL'),
        umbral_caida_porcentaje: Number(r.umbral_caida_porcentaje ?? 10),
        ventana_dias: Number(r.ventana_dias ?? 30),
        activo: r.activo !== false,
        updated_by: r.updated_by ? String(r.updated_by) : null,
        updated_at: r.updated_at ? String(r.updated_at) : undefined,
      }));
    },

    async upsertConfig(input) {
      const { data, error } = await client
        .from('configuracion_alertas_precios')
        .upsert(
          {
            region: input.region,
            umbral_caida_porcentaje: input.umbral_caida_porcentaje,
            ventana_dias: input.ventana_dias,
            activo: input.activo,
            updated_by: input.updated_by,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'region' }
        )
        .select('id, region, umbral_caida_porcentaje, ventana_dias, activo, updated_by, updated_at')
        .limit(1);
      if (error) {
        throw new Error(`No se pudo guardar el umbral de alertas (${error.message}).`);
      }
      const r = (Array.isArray(data) && data[0] ? data[0] : input) as Record<string, unknown>;
      return {
        id: r.id ? String(r.id) : undefined,
        region: String(r.region ?? input.region),
        umbral_caida_porcentaje: Number(r.umbral_caida_porcentaje ?? input.umbral_caida_porcentaje),
        ventana_dias: Number(r.ventana_dias ?? input.ventana_dias),
        activo: r.activo !== false,
        updated_by: r.updated_by ? String(r.updated_by) : input.updated_by,
        updated_at: r.updated_at ? String(r.updated_at) : new Date().toISOString(),
      };
    },
  };
}

export interface PriceAlertsHandlerDeps {
  gatewayFactory?: (req: Request) => PriceAlertsGateway | null;
}

export function createPriceAlertsHandlers(deps?: PriceAlertsHandlerDeps) {
  const resolveGateway = (req: Request): PriceAlertsGateway | null => {
    if (deps?.gatewayFactory) return deps.gatewayFactory(req);
    const token = req.authUser?.accessToken;
    if (!token) return null;
    return createSupabasePriceAlertsGateway(token);
  };

  return {
    async handleListPriceAlerts(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveActorAllowedRegions(actor);
      const requestedRegionRaw = typeof req.query.region === 'string' ? req.query.region.trim() : '';
      const requestedRegion = requestedRegionRaw
        ? normalizeServerAllowedRegionToken(requestedRegionRaw)
        : null;

      if (!scope.isGlobal) {
        if (scope.allowedRegions.length === 0) {
          res.status(403).json({
            error: 'Tu perfil no tiene regiones asignadas para consultar alertas de precios.',
            code: 'FORBIDDEN_REGION_ACCESS',
          });
          return;
        }
        if (requestedRegion && !scope.allowedRegions.includes(requestedRegion)) {
          res.status(403).json({
            error: `Acceso denegado: tu perfil (${scope.allowedRegions.join(', ')}) no puede consultar alertas de ${requestedRegion}.`,
            code: 'FORBIDDEN_REGION_ACCESS',
          });
          return;
        }
      }

      const gateway = resolveGateway(req);
      if (!gateway) {
        res.status(503).json({ error: 'Supabase no configurado en el servidor.', code: 'SUPABASE_UNCONFIGURED' });
        return;
      }

      try {
        const estadoFilter = typeof req.query.estado === 'string' ? req.query.estado.trim() : undefined;
        const [allAlerts, allConfigs] = await Promise.all([
          gateway.listAlerts({ estado: estadoFilter }),
          gateway.listConfigs(),
        ]);

        const scopedAlerts = allAlerts.filter((a) => {
          const normAlertReg = normalizeServerAllowedRegionToken(a.region);
          if (!scope.isGlobal) {
            if (!normAlertReg || !scope.allowedRegions.includes(normAlertReg)) return false;
          }
          if (requestedRegion && normAlertReg !== requestedRegion) return false;
          return true;
        });

        const scopedConfigs = allConfigs.filter((c) => {
          const upper = String(c.region || '').trim().toUpperCase();
          if (scope.isGlobal || upper === 'GLOBAL') return true;
          const normCfg = normalizeServerAllowedRegionToken(upper);
          return Boolean(normCfg && scope.allowedRegions.includes(normCfg));
        });

        const pendingCount = scopedAlerts.filter((a) => a.estado === 'pendiente').length;
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({
          ok: true,
          alertas: scopedAlerts,
          configs: scopedConfigs,
          pendingCount,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Error listando alertas de precios.',
          code: 'PRICE_ALERTS_LIST_ERROR',
        });
      }
    },

    async handleUpdatePriceAlertStatus(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const id = String(req.params.id ?? '').trim();
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: 'ID de alerta inválido.', code: 'INVALID_ID' });
        return;
      }

      const parsed = PatchAlertSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message || 'Estado de alerta inválido.',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const gateway = resolveGateway(req);
      if (!gateway) {
        res.status(503).json({ error: 'Supabase no configurado en el servidor.', code: 'SUPABASE_UNCONFIGURED' });
        return;
      }

      try {
        const existing = await gateway.getAlertById(id);
        if (!existing) {
          res.status(404).json({ error: 'Alerta no encontrada.', code: 'ALERT_NOT_FOUND' });
          return;
        }

        const scope = resolveActorAllowedRegions(actor);
        if (!scope.isGlobal) {
          const alertReg = normalizeServerAllowedRegionToken(existing.region);
          if (!alertReg || !scope.allowedRegions.includes(alertReg)) {
            res.status(403).json({
              error: `Acceso denegado: no puedes gestionar alertas de la región ${existing.region}.`,
              code: 'FORBIDDEN_REGION_ACCESS',
            });
            return;
          }
        }

        const updated = await gateway.updateAlert(id, {
          estado: parsed.data.estado,
          notas_revision: parsed.data.notas_revision ?? null,
          revisada_por: actor.id,
          revisada_at: new Date().toISOString(),
        });

        res.status(200).json({ ok: true, alerta: updated });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'No se pudo actualizar la alerta.',
          code: 'PRICE_ALERT_UPDATE_ERROR',
        });
      }
    },

    async handleUpsertPriceAlertConfig(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const parsed = UpsertAlertConfigSchema.safeParse({
        region: req.body?.region,
        umbral_caida_porcentaje: Number(req.body?.umbral_caida_porcentaje),
        ventana_dias: req.body?.ventana_dias !== undefined ? Number(req.body.ventana_dias) : 30,
        activo: req.body?.activo !== undefined ? Boolean(req.body.activo) : true,
      });
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message || 'Configuración de alerta inválida.',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const rawRegionUpper = parsed.data.region.toUpperCase();
      const targetRegion =
        rawRegionUpper === 'GLOBAL'
          ? 'GLOBAL'
          : normalizeServerAllowedRegionToken(rawRegionUpper);
      if (!targetRegion) {
        res.status(400).json({
          error: 'Región inválida. Usa GLOBAL, OCCIDENTE, CENTRO o ANDES.',
          code: 'INVALID_REGION',
        });
        return;
      }

      const scope = resolveActorAllowedRegions(actor);
      if (!scope.isGlobal) {
        if (targetRegion === 'GLOBAL') {
          res.status(403).json({
            error: 'Solo un Administrador Global puede modificar el umbral GLOBAL.',
            code: 'FORBIDDEN_GLOBAL_CONFIG',
          });
          return;
        }
        if (!scope.allowedRegions.includes(targetRegion)) {
          res.status(403).json({
            error: `Acceso denegado: tu perfil (${scope.allowedRegions.join(', ')}) no puede configurar alertas de ${targetRegion}.`,
            code: 'FORBIDDEN_REGION_ACCESS',
          });
          return;
        }
      }

      const gateway = resolveGateway(req);
      if (!gateway) {
        res.status(503).json({ error: 'Supabase no configurado en el servidor.', code: 'SUPABASE_UNCONFIGURED' });
        return;
      }

      try {
        const config = await gateway.upsertConfig({
          region: targetRegion,
          umbral_caida_porcentaje: Math.round(parsed.data.umbral_caida_porcentaje * 100) / 100,
          ventana_dias: parsed.data.ventana_dias,
          activo: parsed.data.activo,
          updated_by: actor.id,
        });
        res.status(200).json({ ok: true, config });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'No se pudo guardar la configuración de alertas.',
          code: 'PRICE_ALERT_CONFIG_ERROR',
        });
      }
    },
  };
}

export const defaultPriceAlertsHandlers = createPriceAlertsHandlers();
