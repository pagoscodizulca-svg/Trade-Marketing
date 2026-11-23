import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  AllowedRegionSchema,
  PromotoraCategoriaStrictSchema,
  PromotoraFilterSchema,
  PromotoraUpsertSchema,
  classifyPromotoraCategoriaOficial,
  computePromotorasCategoryStats,
  filterPromotorasByRegionAndCategory,
  mapAllowedRegionToLegacySucursal,
  mapLegacySucursalToAllowedRegion,
  type AllowedRegionCode,
  type PromotoraCategoriaOficial,
} from '../utils/regionalSyncClassifier';
import {
  createUserScopedSupabaseClient,
  getAdminSupabaseClient,
} from './supabaseAdminAuth';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PromotoraPatchSchema = z
  .object({
    nombre_completo: z.string().trim().min(2).max(180).optional(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('Correo electrónico inválido.')
      .nullable()
      .optional(),
    telefono: z.string().trim().max(40).nullable().optional(),
    ciudad: z.string().trim().max(100).nullable().optional(),
    estado: z.string().trim().max(100).nullable().optional(),
    direccion: z.string().trim().max(260).nullable().optional(),
    categoria: PromotoraCategoriaStrictSchema.optional(),
    region: AllowedRegionSchema.optional(),
    region_id: z.string().regex(UUID_REGEX, 'region_id debe ser un UUID válido.').nullable().optional(),
    supervisor_id: z
      .string()
      .regex(UUID_REGEX, 'supervisor_id debe ser un UUID válido.')
      .nullable()
      .optional(),
    activo: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'Debe proporcionar al menos un campo para actualizar.',
  });

export interface PromotoraServerRecord {
  id: string;
  nombre_completo: string;
  email: string | null;
  telefono: string | null;
  ciudad: string | null;
  estado: string | null;
  direccion: string | null;
  region?: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' | null;
  auth_user_id?: string | null;
  categoria: PromotoraCategoriaOficial;
  region_id: string | null;
  sucursal: string | null;
  supervisor_id: string | null;
  activo: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface PromotorasGateway {
  resolveRegionIdByCode(code: AllowedRegionCode): Promise<string | null>;
  listPromotoras(filters: {
    categoria?: PromotoraCategoriaOficial;
    regionId?: string;
    soloActivas?: boolean;
  }): Promise<PromotoraServerRecord[]>;
  getPromotoraById(id: string): Promise<PromotoraServerRecord | null>;
  createPromotora(payload: Record<string, unknown>): Promise<PromotoraServerRecord>;
  updatePromotora(id: string, payload: Record<string, unknown>): Promise<PromotoraServerRecord>;
}

function normalizeServerPromotoraRow(raw: Record<string, unknown>): PromotoraServerRecord {
  const emailRaw = raw.email ?? raw.correo;
  const normalizedEmail = emailRaw ? String(emailRaw).trim().toLowerCase() : null;
  const direccion = raw.direccion ? String(raw.direccion).trim() : null;
  const ciudad = raw.ciudad ? String(raw.ciudad).trim() : direccion;
  const estado = raw.estado ? String(raw.estado).trim() : null;
  const sucursalRaw = raw.sucursal ? String(raw.sucursal).trim().toUpperCase() : null;
  const explicitRegionRaw = raw.region ? String(raw.region).trim() : '';
  const explicitRegion: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' | null =
    /^andes$/i.test(explicitRegionRaw)
      ? 'Andes'
      : /^centro$/i.test(explicitRegionRaw)
        ? 'Centro'
        : /^valencia$/i.test(explicitRegionRaw)
          ? 'Valencia'
          : /^occidente$/i.test(explicitRegionRaw)
            ? 'Occidente'
            : null;
  const inferredRegion =
    (explicitRegion === 'Andes'
      ? 'ANDES'
      : explicitRegion === 'Valencia' || explicitRegion === 'Centro'
        ? 'CENTRO'
        : explicitRegion === 'Occidente'
          ? 'OCCIDENTE'
          : null) ??
    mapLegacySucursalToAllowedRegion(sucursalRaw) ??
    mapLegacySucursalToAllowedRegion(estado) ??
    mapLegacySucursalToAllowedRegion(ciudad) ??
    mapLegacySucursalToAllowedRegion(direccion) ??
    (normalizedEmail === 'joseabraham.barroso@gmail.com' ? 'OCCIDENTE' : null);

  const regionLabel: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' | null =
    explicitRegion ??
    (inferredRegion === 'OCCIDENTE'
      ? 'Occidente'
      : inferredRegion === 'CENTRO'
        ? 'Valencia'
        : inferredRegion === 'ANDES'
          ? 'Andes'
          : null);

  return {
    id: String(raw.id ?? ''),
    nombre_completo: String(raw.nombre_completo ?? raw.nombre ?? 'Sin nombre').trim(),
    email: normalizedEmail,
    telefono: raw.telefono ? String(raw.telefono).trim() : null,
    ciudad,
    estado,
    direccion,
    region: regionLabel,
    auth_user_id: raw.auth_user_id ? String(raw.auth_user_id).trim() : null,
    categoria: classifyPromotoraCategoriaOficial(raw),
    region_id: raw.region_id ? String(raw.region_id).trim() : null,
    sucursal:
      sucursalRaw ??
      (regionLabel === 'Valencia'
        ? 'VALENCIA'
        : inferredRegion
          ? mapAllowedRegionToLegacySucursal(inferredRegion)
          : null),
    supervisor_id: raw.supervisor_id ? String(raw.supervisor_id).trim() : null,
    activo: raw.activo !== false,
    created_at: raw.created_at ? String(raw.created_at) : undefined,
    updated_at: raw.updated_at ? String(raw.updated_at) : undefined,
  };
}

function createSupabasePromotorasGateway(accessToken: string): PromotorasGateway | null {
  const client = createUserScopedSupabaseClient(accessToken) || getAdminSupabaseClient();
  if (!client) return null;

  return {
    async resolveRegionIdByCode(code) {
      const { data, error } = await client
        .from('Regiones')
        .select('id_regi, regi_desd')
        .ilike('regi_desd', code)
        .limit(5);
      if (error || !Array.isArray(data)) return null;
      const hit = (data as Array<Record<string, unknown>>).find(
        (r) => String(r.regi_desd ?? '').trim().toUpperCase() === code
      );
      return hit?.id_regi ? String(hit.id_regi) : null;
    },

    async listPromotoras(filters) {
      const PAGE_SIZE = 1000;
      const rows: PromotoraServerRecord[] = [];
      let skipRegionIdFilter = false;

      for (let from = 0; ; from += PAGE_SIZE) {
        let query = client
          .from('promotoras')
          .select('*')
          .order('nombre_completo', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (filters.soloActivas) {
          query = query.eq('activo', true);
        }
        if (filters.categoria) {
          query = query.eq('categoria', filters.categoria);
        }
        if (filters.regionId && !skipRegionIdFilter) {
          query = query.eq('region_id', filters.regionId);
        }

        let { data, error } = await query;
        if (error && filters.regionId && !skipRegionIdFilter && /region_id/i.test(error.message)) {
          skipRegionIdFilter = true;
          let retryQuery = client
            .from('promotoras')
            .select('*')
            .order('nombre_completo', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
          if (filters.soloActivas) retryQuery = retryQuery.eq('activo', true);
          if (filters.categoria) retryQuery = retryQuery.eq('categoria', filters.categoria);
          const retryRes = await retryQuery;
          data = retryRes.data;
          error = retryRes.error;
        }

        if (error) {
          throw new Error(error.message);
        }
        const page = ((data ?? []) as Array<Record<string, unknown>>).map(normalizeServerPromotoraRow);
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      return rows;
    },

    async getPromotoraById(id) {
      const { data, error } = await client
        .from('promotoras')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return null;
      return normalizeServerPromotoraRow(data as Record<string, unknown>);
    },

    async createPromotora(payload) {
      const { data, error } = await client
        .from('promotoras')
        .insert(payload)
        .select('*')
        .single();
      if (error || !data) {
        throw new Error(error?.message || 'No se pudo crear la promotora.');
      }
      return normalizeServerPromotoraRow(data as Record<string, unknown>);
    },

    async updatePromotora(id, payload) {
      const { data, error } = await client
        .from('promotoras')
        .update(payload)
        .eq('id', id)
        .select('*')
        .single();
      if (error || !data) {
        throw new Error(error?.message || 'No se pudo actualizar la promotora.');
      }
      return normalizeServerPromotoraRow(data as Record<string, unknown>);
    },
  };
}

function resolveActorAllowedRegion(req: Request): {
  isGlobal: boolean;
  assignedRegion: AllowedRegionCode | null;
  assignedRegions: AllowedRegionCode[];
} {
  const user = req.authUser;
  if (!user) return { isGlobal: false, assignedRegion: null, assignedRegions: [] };
  const isGlobal = Boolean(user.isSuperAdmin) || user.sucursal === 'GLOBAL';
  if (isGlobal) {
    return { isGlobal: true, assignedRegion: null, assignedRegions: [] };
  }
  // Seguridad estricta: para actores regionales SIEMPRE usar `user.allowedRegions` / `user.sucursal`
  // verificados en servidor, jamás cabeceras enviadas por el cliente.
  const assignedRegions: AllowedRegionCode[] = [];
  if (Array.isArray(user.allowedRegions)) {
    for (const r of user.allowedRegions) {
      const mapped = mapLegacySucursalToAllowedRegion(r);
      if (mapped && !assignedRegions.includes(mapped)) assignedRegions.push(mapped);
    }
  }
  if (assignedRegions.length === 0) {
    const fallback = mapLegacySucursalToAllowedRegion(user.sucursal);
    if (fallback) assignedRegions.push(fallback);
  }
  return {
    isGlobal: false,
    assignedRegion: assignedRegions.length === 1 ? assignedRegions[0]! : null,
    assignedRegions,
  };
}

function extractRequestedHeaderRegion(req: Request): AllowedRegionCode | null {
  const rawSuc = req.headers?.['x-sucursal-activa'];
  const rawReg = req.headers?.['x-region-activa'];
  const rawVal = Array.isArray(rawReg)
    ? rawReg[0]
    : typeof rawReg === 'string' && rawReg.trim()
      ? rawReg
      : Array.isArray(rawSuc)
        ? rawSuc[0]
        : typeof rawSuc === 'string'
          ? rawSuc
          : '';
  if (!rawVal || !rawVal.trim()) return null;
  return mapLegacySucursalToAllowedRegion(rawVal);
}

export function createPromotorasHandlers(options?: {
  gatewayFactory?: (req: Request) => PromotorasGateway | null;
}) {
  const resolveGateway = (req: Request): PromotorasGateway | null => {
    if (options?.gatewayFactory) return options.gatewayFactory(req);
    const token = req.authUser?.accessToken ?? '';
    return createSupabasePromotorasGateway(token);
  };

  const handleListPromotoras = async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Autenticación requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const rawQuery = {
      categoria: typeof req.query.categoria === 'string' ? req.query.categoria : undefined,
      region: typeof req.query.region === 'string' ? req.query.region : undefined,
      regionId: typeof req.query.regionId === 'string' ? req.query.regionId : undefined,
      soloActivas:
        req.query.soloActivas === 'true'
          ? true
          : req.query.soloActivas === 'false'
            ? false
            : undefined,
      busqueda: typeof req.query.busqueda === 'string' ? req.query.busqueda : undefined,
    };

    const parsed = PromotoraFilterSchema.safeParse(rawQuery);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Parámetros de filtrado inválidos.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const actorScope = resolveActorAllowedRegion(req);
    if (!actorScope.isGlobal) {
      if (actorScope.assignedRegions.length === 0) {
        res.status(403).json({
          error: 'Tu perfil no posee una región oficial válida asignada.',
          code: 'FORBIDDEN_REGION_ACCESS',
        });
        return;
      }
      const headerRegion = extractRequestedHeaderRegion(req);
      if (headerRegion && !actorScope.assignedRegions.includes(headerRegion)) {
        res.status(403).json({
          error: `Acceso denegado: tu perfil (${actorScope.assignedRegions.join(', ')}) no puede operar sobre ${headerRegion}.`,
          code: 'FORBIDDEN_REGION_ACCESS',
        });
        return;
      }
      if (
        parsed.data.region !== 'TODAS' &&
        !actorScope.assignedRegions.includes(parsed.data.region)
      ) {
        res.status(403).json({
          error: `Acceso denegado: tu perfil (${actorScope.assignedRegions.join(', ')}) no puede consultar promotoras de ${parsed.data.region}.`,
          code: 'FORBIDDEN_REGION_ACCESS',
        });
        return;
      }
    }

    const gateway = resolveGateway(req);
    if (!gateway) {
      res.status(503).json({
        error: 'Conexión a Supabase no disponible en el servidor.',
        code: 'SUPABASE_UNCONFIGURED',
      });
      return;
    }

    try {
      const effectiveRegion =
        !actorScope.isGlobal
          ? parsed.data.region !== 'TODAS'
            ? parsed.data.region
            : actorScope.assignedRegions.length === 1
              ? actorScope.assignedRegions[0]!
              : undefined
          : parsed.data.region !== 'TODAS'
            ? parsed.data.region
            : undefined;

      let effectiveRegionId = parsed.data.regionId;
      let allowedRegionIds: Set<string> | null = null;
      if (!actorScope.isGlobal) {
        const resolvedPairs = await Promise.all(
          actorScope.assignedRegions.map(async (code) => ({
            code,
            id: await gateway.resolveRegionIdByCode(code),
          }))
        );
        allowedRegionIds = new Set(
          resolvedPairs.map((p) => p.id).filter((id): id is string => Boolean(id))
        );
        if (parsed.data.regionId && !allowedRegionIds.has(parsed.data.regionId)) {
          res.status(403).json({
            error: `Acceso denegado: tu perfil (${actorScope.assignedRegions.join(', ')}) no puede consultar promotoras de otra región.`,
            code: 'FORBIDDEN_REGION_ACCESS',
          });
          return;
        }
        if (parsed.data.regionId) {
          effectiveRegionId = parsed.data.regionId;
        } else if (effectiveRegion) {
          effectiveRegionId =
            resolvedPairs.find((p) => p.code === effectiveRegion)?.id ?? undefined;
        } else {
          effectiveRegionId = undefined;
        }
      } else if (!effectiveRegionId && effectiveRegion) {
        effectiveRegionId = (await gateway.resolveRegionIdByCode(effectiveRegion)) ?? undefined;
      }

      const rawRows = await gateway.listPromotoras({
        categoria: parsed.data.categoria !== 'TODAS' ? parsed.data.categoria : undefined,
        regionId: effectiveRegionId,
        soloActivas: parsed.data.soloActivas,
      });

      const baseFiltered = filterPromotorasByRegionAndCategory(
        rawRows as unknown as Array<Record<string, unknown>>,
        {
          categoria: parsed.data.categoria,
          region: effectiveRegion ?? 'TODAS',
          regionId: effectiveRegionId,
          soloActivas: parsed.data.soloActivas,
          busqueda: parsed.data.busqueda,
        }
      ) as unknown as PromotoraServerRecord[];

      const filtered =
        !actorScope.isGlobal && !effectiveRegion
          ? baseFiltered.filter((row) => {
              const rowReg = mapLegacySucursalToAllowedRegion(
                row.region ?? row.sucursal ?? row.estado ?? row.ciudad ?? row.direccion
              );
              if (rowReg) return actorScope.assignedRegions.includes(rowReg);
              return Boolean(row.region_id && allowedRegionIds?.has(row.region_id));
            })
          : baseFiltered;

      const stats = computePromotorasCategoryStats(
        filtered as unknown as Array<Record<string, unknown>>
      );

      res.status(200).json({
        ok: true,
        items: filtered,
        stats,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Error listando promotoras.',
        code: 'PROMOTORAS_LIST_ERROR',
      });
    }
  };

  const handleCreatePromotora = async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Autenticación requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const rawBody =
      req.body && typeof req.body === 'object' ? { ...(req.body as Record<string, unknown>) } : {};
    if (typeof rawBody.region === 'string' && rawBody.region.trim()) {
      const normalizedRegion = mapLegacySucursalToAllowedRegion(rawBody.region);
      if (normalizedRegion) {
        rawBody.region = normalizedRegion;
      }
    }

    const parsed = PromotoraUpsertSchema.safeParse(rawBody);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Datos inválidos para registrar promotora.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const actorScope = resolveActorAllowedRegion(req);
    const targetRegion: AllowedRegionCode | null =
      parsed.data.region ?? actorScope.assignedRegions[0] ?? null;

    if (!actorScope.isGlobal) {
      if (actorScope.assignedRegions.length === 0) {
        res.status(403).json({
          error: 'Tu perfil no tiene región asignada para crear promotoras.',
          code: 'FORBIDDEN_REGION_ACCESS',
        });
        return;
      }
      if (targetRegion && !actorScope.assignedRegions.includes(targetRegion)) {
        res.status(403).json({
          error: `Acceso denegado: tu perfil (${actorScope.assignedRegions.join(', ')}) no puede registrar promotoras en ${targetRegion}.`,
          code: 'FORBIDDEN_REGION_ACCESS',
        });
        return;
      }
    }

    const gateway = resolveGateway(req);
    if (!gateway) {
      res.status(503).json({
        error: 'Conexión a Supabase no disponible en el servidor.',
        code: 'SUPABASE_UNCONFIGURED',
      });
      return;
    }

    try {
      let resolvedRegionId = parsed.data.region_id ?? null;
      if (!actorScope.isGlobal) {
        const resolvedIds = await Promise.all(
          actorScope.assignedRegions.map(async (code) => ({
            code,
            id: await gateway.resolveRegionIdByCode(code),
          }))
        );
        const allowedIdSet = new Set(
          resolvedIds.map((p) => p.id).filter((id): id is string => Boolean(id))
        );
        if (parsed.data.region_id && !allowedIdSet.has(parsed.data.region_id)) {
          res.status(403).json({
            error: `Acceso denegado: tu perfil (${actorScope.assignedRegions.join(', ')}) no puede crear promotoras en otra región.`,
            code: 'FORBIDDEN_REGION_ACCESS',
          });
          return;
        }
        resolvedRegionId =
          parsed.data.region_id ??
          resolvedIds.find((p) => p.code === targetRegion)?.id ??
          resolvedIds[0]?.id ??
          null;
      } else if (!resolvedRegionId && targetRegion) {
        resolvedRegionId = await gateway.resolveRegionIdByCode(targetRegion);
      }

      const legacySucursal = targetRegion ? mapAllowedRegionToLegacySucursal(targetRegion) : null;
      const officialRegionLabel =
        targetRegion === 'CENTRO'
          ? 'Valencia'
          : targetRegion === 'ANDES'
            ? 'Andes'
            : targetRegion === 'OCCIDENTE'
              ? 'Occidente'
              : null;
      const created = await gateway.createPromotora({
        nombre_completo: parsed.data.nombre_completo,
        email: parsed.data.email ?? null,
        telefono: parsed.data.telefono ?? null,
        ciudad: parsed.data.ciudad ?? null,
        estado: parsed.data.estado ?? null,
        direccion: parsed.data.direccion ?? null,
        categoria: parsed.data.categoria,
        supervisor_id: parsed.data.supervisor_id ?? null,
        activo: parsed.data.activo,
        ...(officialRegionLabel ? { region: officialRegionLabel } : {}),
        ...(resolvedRegionId ? { region_id: resolvedRegionId } : {}),
        ...(legacySucursal ? { sucursal: legacySucursal } : {}),
      });

      res.status(201).json({ ok: true, item: created });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Error registrando promotora.',
        code: 'PROMOTORAS_CREATE_ERROR',
      });
    }
  };

  const handleUpdatePromotora = async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Autenticación requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const id = String(req.params.id ?? '').trim();
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Identificador de promotora inválido.', code: 'INVALID_ID' });
      return;
    }

    const rawBody =
      req.body && typeof req.body === 'object' ? { ...(req.body as Record<string, unknown>) } : {};
    if (typeof rawBody.region === 'string' && rawBody.region.trim()) {
      const normalizedRegion = mapLegacySucursalToAllowedRegion(rawBody.region);
      if (normalizedRegion) {
        rawBody.region = normalizedRegion;
      }
    }

    const parsed = PromotoraPatchSchema.safeParse(rawBody);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Datos inválidos para actualizar promotora.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const gateway = resolveGateway(req);
    if (!gateway) {
      res.status(503).json({
        error: 'Conexión a Supabase no disponible en el servidor.',
        code: 'SUPABASE_UNCONFIGURED',
      });
      return;
    }

    try {
      const existing = await gateway.getPromotoraById(id);
      if (!existing) {
        res.status(404).json({ error: 'Promotora no encontrada.', code: 'PROMOTORA_NOT_FOUND' });
        return;
      }

      const actorScope = resolveActorAllowedRegion(req);
      if (!actorScope.isGlobal) {
        const existingRegion = mapLegacySucursalToAllowedRegion(
          existing.region ?? existing.sucursal ?? existing.estado ?? existing.ciudad ?? existing.direccion
        );
        const resolvedIds = await Promise.all(
          actorScope.assignedRegions.map((code) => gateway.resolveRegionIdByCode(code))
        );
        const allowedIdSet = new Set(resolvedIds.filter((id): id is string => Boolean(id)));
        const existingAllowed = existingRegion
          ? actorScope.assignedRegions.includes(existingRegion)
          : Boolean(existing.region_id && allowedIdSet.has(existing.region_id));
        if (
          actorScope.assignedRegions.length === 0 ||
          !existingAllowed ||
          (parsed.data.region && !actorScope.assignedRegions.includes(parsed.data.region)) ||
          (parsed.data.region_id && !allowedIdSet.has(parsed.data.region_id))
        ) {
          res.status(403).json({
            error: 'Acceso denegado por aislamiento regional.',
            code: 'FORBIDDEN_REGION_ACCESS',
          });
          return;
        }
      }

      const updatePayload: Record<string, unknown> = { ...parsed.data };
      delete updatePayload.region;
      if (parsed.data.region) {
        const regId = await gateway.resolveRegionIdByCode(parsed.data.region);
        if (regId) updatePayload.region_id = regId;
        const legacySuc = mapAllowedRegionToLegacySucursal(parsed.data.region);
        if (legacySuc) updatePayload.sucursal = legacySuc;
      }

      const updated = await gateway.updatePromotora(id, updatePayload);
      res.status(200).json({ ok: true, item: updated });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Error actualizando promotora.',
        code: 'PROMOTORAS_UPDATE_ERROR',
      });
    }
  };

  return {
    handleListPromotoras,
    handleCreatePromotora,
    handleUpdatePromotora,
  };
}

export const defaultPromotorasHandlers = createPromotorasHandlers();
