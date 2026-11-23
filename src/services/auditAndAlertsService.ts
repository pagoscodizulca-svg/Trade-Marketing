import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AuditLogEntry, DiscrepancyAlert, UserRole } from '../types';
import {
  isAllowedRegionCode,
  mapLegacySucursalToAllowedRegion,
  type AllowedRegionCode,
} from '../utils/regionalSyncClassifier';
import { obtenerCatalogoRegionesOficiales } from './masterDataSyncService';
import { getSupabaseCoordinatorClient, isSupabaseConfigured } from './supabaseClient';
import type { OperativeSucursal } from './userManagementService';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_AUDIT_LOG_PAGE_SIZE = 50;
export const DEFAULT_DISCREPANCY_ALERT_PAGE_SIZE = 50;
export const MAX_PERSISTED_PAGE_SIZE = 100;

export const AUDIT_ENTITY_TYPES = [
  'REQUISITION',
  'STORE_VISIT',
  'RECONCILIATION',
  'GEOFENCE',
  'EXPENSE',
  'AUDITORIA',
  'CAMPO',
] as const;

export const DISCREPANCY_SEVERITIES = ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'] as const;
export const DISCREPANCY_STATUSES = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'] as const;

export type DiscrepancyDbStatus = (typeof DISCREPANCY_STATUSES)[number];
export type DiscrepancyDbSeverity = (typeof DISCREPANCY_SEVERITIES)[number];

export interface ActiveRegionResolution {
  regionCode: AllowedRegionCode | null;
  regionId: string | null;
}

export interface PaginatedResult<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
  nextOffset: number;
}

export interface PersistAuditLogInput {
  entityType: AuditLogEntry['entityType'];
  entityId: string;
  action: string;
  actorId?: string | null;
  actorName?: string;
  actorRole: UserRole | string;
  ipAddress?: string | null;
  previousState?: string;
  newState?: string;
  justification?: string;
  regionId?: string | null;
  regionCode?: AllowedRegionCode | null;
  sucursal?: OperativeSucursal | null;
  metadata?: Record<string, unknown>;
}

export interface PersistDiscrepancyAlertInput {
  severity: DiscrepancyAlert['severity'];
  title: string;
  description: string;
  entityCode: string;
  entityType?: string;
  detectedByRule: string;
  regionId?: string | null;
  regionCode?: AllowedRegionCode | null;
  sucursal?: OperativeSucursal | null;
  metadata?: Record<string, unknown>;
}

export interface ResolveDiscrepancyAlertInput {
  alertId: string;
  resolutionNotes?: string;
  resolvedBy?: string | null;
  status?: 'RESOLVED' | 'DISMISSED';
  existingMetadata?: Record<string, unknown>;
}

const PersistAuditLogInputSchema = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES),
  entityId: z.string().trim().min(1, 'entityId es obligatorio.').max(160),
  action: z.string().trim().min(1, 'action es obligatorio.').max(160),
  actorId: z.string().trim().nullable().optional(),
  actorName: z.string().trim().max(160).optional().default(''),
  actorRole: z.string().trim().min(1, 'actorRole es obligatorio.').max(80),
  ipAddress: z.string().trim().max(64).nullable().optional(),
  previousState: z.string().max(400).optional(),
  newState: z.string().max(400).optional(),
  justification: z.string().max(1000).optional(),
  regionId: z.string().trim().nullable().optional(),
  regionCode: z.enum(['OCCIDENTE', 'CENTRO', 'ANDES']).nullable().optional(),
  sucursal: z.string().trim().max(40).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const PersistDiscrepancyAlertInputSchema = z.object({
  severity: z.enum(['MEDIA', 'ALTA', 'CRITICA']),
  title: z.string().trim().min(1, 'title es obligatorio.').max(200),
  description: z.string().trim().max(1500).optional().default(''),
  entityCode: z.string().trim().min(1, 'entityCode es obligatorio.').max(160),
  entityType: z.string().trim().min(1).max(80).optional().default('EXPENSE'),
  detectedByRule: z.string().trim().min(1, 'detectedByRule es obligatorio.').max(120),
  regionId: z.string().trim().nullable().optional(),
  regionCode: z.enum(['OCCIDENTE', 'CENTRO', 'ANDES']).nullable().optional(),
  sucursal: z.string().trim().max(40).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ResolveDiscrepancyAlertInputSchema = z.object({
  alertId: z.string().trim().regex(UUID_REGEX, 'alertId debe ser un UUID válido.'),
  resolutionNotes: z.string().trim().max(1000).optional().default(''),
  resolvedBy: z.string().trim().nullable().optional(),
  status: z.enum(['RESOLVED', 'DISMISSED']).optional().default('RESOLVED'),
  existingMetadata: z.record(z.string(), z.unknown()).optional(),
});

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

function clampPageLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_PERSISTED_PAGE_SIZE, Math.trunc(limit)));
}

function clampPageOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

function sanitizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    clean[k] = v;
  }
  return clean;
}

export async function computeAuditIntegrityHash(payload: Record<string, unknown>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const digest = await subtle.digest('SHA-256', encoded);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex}`;
  } catch {
    return '';
  }
}

function resolveSupabaseClient(clientOverride?: SupabaseClient | null): SupabaseClient {
  if (clientOverride) return clientOverride;
  if (!isSupabaseConfigured) {
    throw new Error('Supabase no está configurado en el cliente.');
  }
  const client = getSupabaseCoordinatorClient();
  if (!client) {
    throw new Error('No hay sesión/cliente Supabase disponible para operar auditoría y alertas.');
  }
  return client;
}

/**
 * Resuelve dinámicamente el `region_id` (`id_regi` de `public."Regiones"`) para el contexto regional
 * activo (`OCCIDENTE`, `CENTRO`, `ANDES`) sin hardcodear ningún UUID.
 */
export async function resolveActiveRegionContext(
  params: {
    activeSucursal?: OperativeSucursal | string | null;
    verifiedRegionId?: string | null;
  },
  clientOverride?: SupabaseClient | null
): Promise<ActiveRegionResolution> {
  const regionCode: AllowedRegionCode | null = isAllowedRegionCode(params.activeSucursal)
    ? params.activeSucursal
    : mapLegacySucursalToAllowedRegion(params.activeSucursal);

  const fallbackUuid = isValidUuid(params.verifiedRegionId)
    ? params.verifiedRegionId.trim()
    : null;

  if (!regionCode) {
    return {
      regionCode: null,
      regionId: fallbackUuid,
    };
  }

  try {
    const catalog = await obtenerCatalogoRegionesOficiales(
      clientOverride as Parameters<typeof obtenerCatalogoRegionesOficiales>[0]
    );
    const entry = catalog.get(regionCode);
    if (entry?.id_regi && isValidUuid(entry.id_regi)) {
      return {
        regionCode,
        regionId: entry.id_regi,
      };
    }
  } catch {
    // Si "Regiones" aún no está accesible en este entorno, cae al fallback validado sin romper la vista
  }

  return {
    regionCode,
    regionId: fallbackUuid,
  };
}

function normalizeAuditEntityType(raw: unknown): AuditLogEntry['entityType'] {
  const upper = String(raw || '')
    .trim()
    .toUpperCase();
  if ((AUDIT_ENTITY_TYPES as readonly string[]).includes(upper)) {
    return upper as AuditLogEntry['entityType'];
  }
  return 'AUDITORIA';
}

function normalizeAlertSeverity(raw: unknown): DiscrepancyAlert['severity'] {
  const upper = String(raw || '')
    .trim()
    .toUpperCase();
  if (upper === 'CRITICA' || upper === 'ALTA' || upper === 'MEDIA') {
    return upper;
  }
  return 'MEDIA';
}

export function mapDbRowToAuditLogEntry(row: Record<string, unknown>): AuditLogEntry {
  const metadata = sanitizeJsonObject(row.metadata);
  const strOrUndef = (v: unknown) =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined;

  return {
    id: String(row.id ?? ''),
    timestamp: String(row.created_at ?? new Date().toISOString()),
    entityType: normalizeAuditEntityType(row.entity_type),
    entityId: String(row.entity_id ?? ''),
    action: String(row.action ?? ''),
    userId: String(row.actor_id ?? metadata.userId ?? ''),
    userName: String(metadata.userName ?? ''),
    userRole: String(row.actor_role ?? 'jefe_trade') as UserRole,
    ipAddress: String(row.ip_address ?? ''),
    previousState: strOrUndef(metadata.previousState),
    newState: strOrUndef(metadata.newState),
    justification: strOrUndef(metadata.justification),
    metadata: {
      ...metadata,
      ...(row.region_id ? { regionId: String(row.region_id) } : {}),
    },
    integrityHash: String(metadata.integrityHash ?? ''),
  };
}

export function mapDbRowToDiscrepancyAlert(row: Record<string, unknown>): DiscrepancyAlert {
  const metadata = sanitizeJsonObject(row.metadata);
  const status = String(row.status ?? 'OPEN').trim().toUpperCase();
  const resolved = status === 'RESOLVED' || status === 'DISMISSED';
  const resolutionNotes =
    typeof metadata.resolutionNotes === 'string' && metadata.resolutionNotes.trim() !== ''
      ? metadata.resolutionNotes
      : undefined;

  return {
    id: String(row.id ?? ''),
    severity: normalizeAlertSeverity(row.severity),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    entityCode: String(row.entity_id ?? ''),
    timestamp: String(row.created_at ?? new Date().toISOString()),
    detectedByRule: String(metadata.detectedByRule ?? row.category ?? 'GENERAL'),
    resolved,
    resolutionNotes,
  };
}

/**
 * Carga paginada y controlada de `public.audit_logs` respetando RLS y región activa.
 */
export async function fetchAuditLogsPage(
  options: {
    regionId?: string | null;
    limit?: number;
    offset?: number;
  } = {},
  clientOverride?: SupabaseClient | null
): Promise<PaginatedResult<AuditLogEntry>> {
  const client = resolveSupabaseClient(clientOverride);
  const limit = clampPageLimit(options.limit, DEFAULT_AUDIT_LOG_PAGE_SIZE);
  const offset = clampPageOffset(options.offset);
  const regionId = isValidUuid(options.regionId) ? options.regionId.trim() : null;

  let query = client
    .from('audit_logs')
    .select(
      'id, created_at, actor_id, actor_role, action, entity_type, entity_id, region_id, metadata, ip_address',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false });

  if (regionId) {
    query = query.eq('region_id', regionId);
  }

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) {
    throw new Error(`No se pudo cargar la bitácora de auditoría: ${error.message}`);
  }

  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const items = rows.map(mapDbRowToAuditLogEntry);
  const totalCount = typeof count === 'number' ? count : offset + items.length;
  const nextOffset = offset + items.length;
  const hasMore =
    typeof count === 'number' ? nextOffset < count : items.length === limit;

  return {
    items,
    totalCount,
    hasMore,
    nextOffset,
  };
}

/**
 * Persiste una nueva entrada inmutable en `public.audit_logs` con hash SHA-256 verificable.
 */
export async function persistAuditLogEntry(
  input: PersistAuditLogInput,
  clientOverride?: SupabaseClient | null
): Promise<AuditLogEntry> {
  const parsed = PersistAuditLogInputSchema.parse(input);
  const client = resolveSupabaseClient(clientOverride);

  const actorUuid = isValidUuid(parsed.actorId) ? parsed.actorId.trim() : null;
  const regionUuid = isValidUuid(parsed.regionId) ? parsed.regionId.trim() : null;
  const clientTimestamp = new Date().toISOString();

  const integrityHash = await computeAuditIntegrityHash({
    timestamp: clientTimestamp,
    entityType: parsed.entityType,
    entityId: parsed.entityId,
    action: parsed.action,
    actorId: actorUuid ?? '',
    actorRole: parsed.actorRole,
    previousState: parsed.previousState,
    newState: parsed.newState,
    justification: parsed.justification,
    regionId: regionUuid,
  });

  const metadata: Record<string, unknown> = {
    ...sanitizeJsonObject(parsed.metadata),
    ...(parsed.actorName ? { userName: parsed.actorName } : {}),
    ...(parsed.previousState !== undefined ? { previousState: parsed.previousState } : {}),
    ...(parsed.newState !== undefined ? { newState: parsed.newState } : {}),
    ...(parsed.justification !== undefined ? { justification: parsed.justification } : {}),
    ...(parsed.regionCode ? { regionCode: parsed.regionCode } : {}),
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
    ...(integrityHash ? { integrityHash } : {}),
  };

  const { data, error } = await client
    .from('audit_logs')
    .insert({
      actor_id: actorUuid,
      actor_role: parsed.actorRole,
      action: parsed.action,
      entity_type: parsed.entityType,
      entity_id: parsed.entityId,
      region_id: regionUuid,
      metadata,
      ip_address: parsed.ipAddress || null,
    })
    .select(
      'id, created_at, actor_id, actor_role, action, entity_type, entity_id, region_id, metadata, ip_address'
    )
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo persistir el evento de auditoría (${parsed.action}): ${error?.message || 'sin respuesta'}`
    );
  }

  return mapDbRowToAuditLogEntry(data as Record<string, unknown>);
}

/**
 * Carga paginada y controlada de `public.discrepancy_alerts` respetando RLS y región activa.
 */
export async function fetchDiscrepancyAlertsPage(
  options: {
    regionId?: string | null;
    limit?: number;
    offset?: number;
    statuses?: readonly DiscrepancyDbStatus[];
  } = {},
  clientOverride?: SupabaseClient | null
): Promise<PaginatedResult<DiscrepancyAlert>> {
  const client = resolveSupabaseClient(clientOverride);
  const limit = clampPageLimit(options.limit, DEFAULT_DISCREPANCY_ALERT_PAGE_SIZE);
  const offset = clampPageOffset(options.offset);
  const regionId = isValidUuid(options.regionId) ? options.regionId.trim() : null;

  let query = client
    .from('discrepancy_alerts')
    .select(
      'id, created_at, updated_at, severity, status, category, title, description, entity_type, entity_id, region_id, resolved_by, resolved_at, metadata',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false });

  if (regionId) {
    query = query.eq('region_id', regionId);
  }
  if (options.statuses && options.statuses.length > 0) {
    query = query.in('status', [...options.statuses]);
  }

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) {
    throw new Error(`No se pudieron cargar las alertas de discrepancia: ${error.message}`);
  }

  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const items = rows.map(mapDbRowToDiscrepancyAlert);
  const totalCount = typeof count === 'number' ? count : offset + items.length;
  const nextOffset = offset + items.length;
  const hasMore =
    typeof count === 'number' ? nextOffset < count : items.length === limit;

  return {
    items,
    totalCount,
    hasMore,
    nextOffset,
  };
}

/**
 * Persiste una nueva alerta de discrepancia / antifraude en `public.discrepancy_alerts`.
 */
export async function persistDiscrepancyAlert(
  input: PersistDiscrepancyAlertInput,
  clientOverride?: SupabaseClient | null
): Promise<DiscrepancyAlert> {
  const parsed = PersistDiscrepancyAlertInputSchema.parse(input);
  const client = resolveSupabaseClient(clientOverride);
  const regionUuid = isValidUuid(parsed.regionId) ? parsed.regionId.trim() : null;

  const metadata: Record<string, unknown> = {
    ...sanitizeJsonObject(parsed.metadata),
    detectedByRule: parsed.detectedByRule,
    ...(parsed.regionCode ? { regionCode: parsed.regionCode } : {}),
    ...(parsed.sucursal ? { sucursal: parsed.sucursal } : {}),
  };

  const { data, error } = await client
    .from('discrepancy_alerts')
    .insert({
      severity: parsed.severity,
      status: 'OPEN',
      category: parsed.detectedByRule,
      title: parsed.title,
      description: parsed.description,
      entity_type: parsed.entityType,
      entity_id: parsed.entityCode,
      region_id: regionUuid,
      metadata,
    })
    .select(
      'id, created_at, updated_at, severity, status, category, title, description, entity_type, entity_id, region_id, resolved_by, resolved_at, metadata'
    )
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo persistir la alerta de discrepancia (${parsed.title}): ${error?.message || 'sin respuesta'}`
    );
  }

  return mapDbRowToDiscrepancyAlert(data as Record<string, unknown>);
}

/**
 * Marca una alerta de discrepancia como resuelta o descartada en `public.discrepancy_alerts`.
 */
export async function resolveDiscrepancyAlertInSupabase(
  input: ResolveDiscrepancyAlertInput,
  clientOverride?: SupabaseClient | null
): Promise<DiscrepancyAlert> {
  const parsed = ResolveDiscrepancyAlertInputSchema.parse(input);
  const client = resolveSupabaseClient(clientOverride);
  const resolvedByUuid = isValidUuid(parsed.resolvedBy) ? parsed.resolvedBy.trim() : null;

  const nextMetadata: Record<string, unknown> = {
    ...sanitizeJsonObject(parsed.existingMetadata),
    ...(parsed.resolutionNotes ? { resolutionNotes: parsed.resolutionNotes } : {}),
  };

  const { data, error } = await client
    .from('discrepancy_alerts')
    .update({
      status: parsed.status,
      resolved_by: resolvedByUuid,
      resolved_at: new Date().toISOString(),
      metadata: nextMetadata,
    })
    .eq('id', parsed.alertId)
    .select(
      'id, created_at, updated_at, severity, status, category, title, description, entity_type, entity_id, region_id, resolved_by, resolved_at, metadata'
    )
    .single();

  if (error || !data) {
    throw new Error(
      `No se pudo actualizar la alerta de discrepancia (${parsed.alertId}): ${error?.message || 'sin respuesta'}`
    );
  }

  return mapDbRowToDiscrepancyAlert(data as Record<string, unknown>);
}

/**
 * Ejecuta una inserción optimista con sincronización exacta y rollback automático
 * si falla la escritura persistente en base de datos.
 */
export async function executeOptimisticAppendWithRollback<T extends { id: string }>(params: {
  tempItem: T;
  updateState: (updater: (prev: T[]) => T[]) => void;
  persist: () => Promise<T>;
  onError?: (message: string, rawError: unknown) => void;
}): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { tempItem, updateState, persist, onError } = params;

  updateState((prev) => [tempItem, ...prev]);

  try {
    const persisted = await persist();
    updateState((prev) => {
      const existsTemp = prev.some((item) => item.id === tempItem.id);
      if (existsTemp) {
        return prev.map((item) => (item.id === tempItem.id ? persisted : item));
      }
      if (prev.some((item) => item.id === persisted.id)) {
        return prev;
      }
      return [persisted, ...prev];
    });
    return { ok: true, data: persisted };
  } catch (err) {
    updateState((prev) => prev.filter((item) => item.id !== tempItem.id));
    const message =
      err instanceof Error && err.message.trim()
        ? err.message.trim()
        : 'Error persistiendo el registro en la base de datos.';
    onError?.(message, err);
    return { ok: false, error: message };
  }
}

/**
 * Ejecuta una actualización optimista por `id` con rollback exacto al snapshot previo si falla BD.
 */
export async function executeOptimisticUpdateWithRollback<T extends { id: string }>(params: {
  targetId: string;
  optimisticUpdate: (current: T) => T;
  updateState: (updater: (prev: T[]) => T[]) => void;
  persist: (previous: T) => Promise<T>;
  onError?: (message: string, rawError: unknown) => void;
}): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { targetId, optimisticUpdate, updateState, persist, onError } = params;

  let snapshot: T | undefined;
  updateState((prev) =>
    prev.map((item) => {
      if (item.id !== targetId) return item;
      snapshot = item;
      return optimisticUpdate(item);
    })
  );

  if (!snapshot) {
    const notFoundMsg = `Registro ${targetId} no encontrado en el estado activo.`;
    onError?.(notFoundMsg, new Error(notFoundMsg));
    return { ok: false, error: notFoundMsg };
  }

  try {
    const persisted = await persist(snapshot);
    updateState((prev) => prev.map((item) => (item.id === targetId ? persisted : item)));
    return { ok: true, data: persisted };
  } catch (err) {
    const previousRow = snapshot;
    updateState((prev) => prev.map((item) => (item.id === targetId ? previousRow : item)));
    const message =
      err instanceof Error && err.message.trim()
        ? err.message.trim()
        : 'Error actualizando el registro en la base de datos.';
    onError?.(message, err);
    return { ok: false, error: message };
  }
}
