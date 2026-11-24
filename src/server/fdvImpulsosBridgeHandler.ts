import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  normalizeRegionName,
  type AllowedRegionCode,
} from '../utils/regionalSyncClassifier';
import {
  createUserScopedSupabaseClient,
  getAdminSupabaseClient,
  type AuthenticatedServerUser,
} from './supabaseAdminAuth';
import { resolveAuthorizedSucursalScope } from './masterDataErpHandler';
import { serverLogger } from './logger';

/**
 * Puente Oficial Bidireccional: App de Vendedores (`public."Impulsos_Actividades"`) <->
 * Módulo de Degustación Trade Marketing (Occidente & Centro).
 *
 * - Lee las solicitudes reales que los vendedores envían desde su app (Occidente y Centro)
 *   mediante `Impulsos_Actividades` + `Impulsos_Productos` + `Impulsos_Fechas` + `Impulsos_Motivos`
 *   (o respaldo seguro `app_impulsos_listar` bajo JWT `authenticated`).
 * - Aplica aislamiento estricto multi-región en servidor (`OCCIDENTE` vs `CENTRO`, 403 en cruce).
 * - Sincroniza decisiones (Aprobada/Confirmada, No Autorizada/Cancelada, Completada/Ejecutada)
 *   de vuelta a `Impulsos_Actividades` para trazabilidad en tiempo real con el vendedor.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRADE_IMPULSOS_ACTOR_USER = 'mcontreras';

export interface ImpulsoActividadCanonicalItem {
  idImpu: string;
  idEnvio: string;
  tipo: 'DEGUSTACION' | 'IMPULSO';
  estado: 'PENDIENTE' | 'CONFIRMADA' | 'EJECUTADA' | 'CANCELADA';
  fdes: string;
  fhas: string;
  hini: string;
  hfin: string;
  fechas: Array<{ fecha: string; hini: string; hfin: string }>;
  clienteId: string | null;
  clienteNombre: string;
  clienteRif: string;
  clienteEstado: string;
  clienteLat: number | null;
  clienteLon: number | null;
  vendedorId: string | null;
  vendedorCodigo: string;
  vendedorNombre: string;
  sucursalDesc: string;
  region: AllowedRegionCode | null;
  motivo: string;
  productos: Array<{ id?: string; codigo?: string; nombre: string; um?: string; cant?: number | null }>;
  observaciones: string;
  impulsadora: string | null;
  telefono: string | null;
  resumen: string | null;
  cancelMotivo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdaptedImpulsoSurveyRow {
  id: string;
  type: 'Degustacion';
  date: string;
  store: string;
  promoter: string;
  product: string;
  comments: string;
  creatorId: string;
  created_at: string;
  sucursal: 'OCCIDENTE' | 'CENTRO';
  region: 'Occidente' | 'Centro' | 'Andes';
  degustacion_key: string;
  leido_trade: boolean;
  visto_en_trade_at: string | null;
  en_historial: boolean;
}

export interface FdvImpulsosBridgeGateway {
  listImpulsosActividades(actor: AuthenticatedServerUser): Promise<ImpulsoActividadCanonicalItem[]>;
  syncImpulsoEstado(
    actor: AuthenticatedServerUser,
    params: {
      idEnvio: string;
      estado: 'CONFIRMADA' | 'CANCELADA' | 'EJECUTADA';
      promotoraNombre?: string;
      promotoraTelefono?: string;
      motivoCancelacion?: string;
      resumen?: string;
    }
  ): Promise<{ ok: boolean; estado: string }>;
}

export const SyncImpulsoEstadoBodySchema = z.object({
  estado: z.enum(['APROBADA', 'NO_AUTORIZADA', 'RECHAZADA', 'CANCELADA', 'EN_CURSO', 'COMPLETADA', 'CONFIRMADA', 'EJECUTADA']),
  promotoraAsignada: z.string().trim().max(160).optional(),
  promotoraTelefono: z.string().trim().max(40).optional(),
  notasTradeMarketing: z.string().trim().max(1000).optional(),
  motivoCancelacion: z.string().trim().max(500).optional(),
});

function cleanStr(raw: unknown, maxLen = 240): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normalizeIsoDate(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : '';
}

function normalizeHourText(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return '';
  return `${m[1]!.padStart(2, '0')}:${m[2]!}`;
}

function inferTurnoFromHours(hini: string, hfin: string): { turno: 'MAÑANA' | 'TARDE' | 'COMPLETO'; timeRange: string } {
  const startH = Number(hini.split(':')[0]);
  const endH = Number(hfin.split(':')[0]);
  const validStart = Number.isFinite(startH) && hini.includes(':');
  const validEnd = Number.isFinite(endH) && hfin.includes(':');

  const formatAmPm = (hhmm: string): string => {
    const [hStr, mStr] = hhmm.split(':');
    const h = Number(hStr);
    if (!Number.isFinite(h)) return hhmm;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${String(h12).padStart(2, '0')}:${mStr || '00'} ${suffix}`;
  };

  if (validStart && validEnd && startH > 0 && endH > startH) {
    const timeRange = `${formatAmPm(hini)} - ${formatAmPm(hfin)}`;
    if (startH < 12 && endH >= 15) {
      return { turno: 'COMPLETO', timeRange };
    }
    if (startH >= 12) {
      return { turno: 'TARDE', timeRange };
    }
    return { turno: 'MAÑANA', timeRange };
  }

  if (validEnd && endH >= 15 && (!validStart || startH === 0)) {
    return { turno: 'TARDE', timeRange: `01:00 PM - ${formatAmPm(hfin)}` };
  }

  return { turno: 'MAÑANA', timeRange: '09:00 AM - 01:00 PM' };
}

export function mapAllowedRegionToCanonicalSucursal(
  region: AllowedRegionCode | null
): 'OCCIDENTE' | 'CENTRO' | null {
  if (region === 'OCCIDENTE') return 'OCCIDENTE';
  if (region === 'CENTRO' || region === 'ANDES') return 'CENTRO';
  return null;
}

function mapRegionLabel(region: AllowedRegionCode): 'Occidente' | 'Centro' | 'Andes' {
  if (region === 'OCCIDENTE') return 'Occidente';
  if (region === 'ANDES') return 'Andes';
  return 'Centro';
}

function mapImpulsoEstadoToTradeEstado(
  estado: ImpulsoActividadCanonicalItem['estado']
): { estado: 'SOLICITADA' | 'APROBADA' | 'COMPLETADA' | 'NO_AUTORIZADA'; status: string; enHistorial: boolean } {
  switch (estado) {
    case 'CONFIRMADA':
      return { estado: 'APROBADA', status: 'aprobada', enHistorial: false };
    case 'EJECUTADA':
      return { estado: 'COMPLETADA', status: 'completada', enHistorial: true };
    case 'CANCELADA':
      return { estado: 'NO_AUTORIZADA', status: 'no_autorizada', enHistorial: true };
    default:
      return { estado: 'SOLICITADA', status: 'pendiente', enHistorial: false };
  }
}

export function adaptImpulsoActividadToSurveyRows(
  item: ImpulsoActividadCanonicalItem
): AdaptedImpulsoSurveyRow[] {
  if (!item.region) return [];
  const canonicalSucursal = mapAllowedRegionToCanonicalSucursal(item.region);
  if (!canonicalSucursal) return [];

  const fechasList =
    item.fechas.length > 0
      ? item.fechas
      : item.fdes
        ? [{ fecha: item.fdes, hini: item.hini, hfin: item.hfin }]
        : [];
  if (fechasList.length === 0) return [];

  const productNames = item.productos
    .map((p) => cleanStr(p.nombre, 140))
    .filter(Boolean);
  const productSummary =
    productNames.length > 0
      ? productNames.join(', ').slice(0, 240)
      : item.tipo === 'IMPULSO'
        ? 'Impulso Portafolio Codizulca'
        : 'Degustación Solicitada FDV';

  const totalKilos = item.productos.reduce((acc, p) => {
    const n = typeof p.cant === 'number' && Number.isFinite(p.cant) && p.cant > 0 ? p.cant : 0;
    return acc + n;
  }, 0);

  const mappedState = mapImpulsoEstadoToTradeEstado(item.estado);
  const regionLabel = mapRegionLabel(item.region);
  const routeLabel = [item.sucursalDesc, item.clienteEstado]
    .filter((v, i, arr) => Boolean(v) && arr.indexOf(v) === i)
    .join(' · ') || regionLabel;

  const isMultiDate = fechasList.length > 1;
  const rows: AdaptedImpulsoSurveyRow[] = [];

  for (const fEntry of fechasList) {
    const ymd = normalizeIsoDate(fEntry.fecha);
    if (!ymd) continue;
    const hini = normalizeHourText(fEntry.hini || item.hini);
    const hfin = normalizeHourText(fEntry.hfin || item.hfin);
    const { turno, timeRange } = inferTurnoFromHours(hini, hfin);

    const degKey = isMultiDate
      ? `impulso-${item.idEnvio}-${ymd}`
      : `impulso-${item.idEnvio}`;

    const notesParts = [
      item.tipo === 'IMPULSO' ? '[Impulso]' : '[Degustación FDV]',
      item.motivo ? `Motivo: ${item.motivo}` : '',
      item.observaciones,
      item.cancelMotivo ? `Motivo cancelación: ${item.cancelMotivo}` : '',
    ].filter(Boolean);

    const commentsObj = {
      isTasting: true,
      source: 'app_vendedores_impulsos',
      origin: 'app_vendedores_impulsos',
      impulsoId: item.idImpu,
      idEnvio: item.idEnvio,
      tipoActividad: item.tipo,
      degustacionId: degKey,
      id: degKey,
      sucursal: canonicalSucursal,
      region: regionLabel,
      client: item.clienteNombre,
      cliente: item.clienteNombre,
      clienteCodigo: item.clienteRif,
      store: item.clienteNombre,
      vendedor: item.vendedorNombre,
      salesRep: item.vendedorNombre,
      vendedorId: item.vendedorCodigo || item.vendedorId || '',
      promoter: item.impulsadora || 'POR ASIGNAR (Trade Marketing)',
      promotoraAsignada: item.impulsadora || '',
      telefonoContacto: item.telefono || '',
      ruta: routeLabel,
      estadoGeo: item.clienteEstado,
      date: ymd,
      turno,
      shift: `${turno} (${timeRange})`,
      time: timeRange,
      products: productNames.length > 0 ? productNames : [productSummary],
      product: productSummary,
      kilos: totalKilos > 0 ? totalKilos : 2,
      kg: totalKilos > 0 ? totalKilos : 2,
      personas: 80,
      personasEstimadas: 80,
      estado: mappedState.estado,
      status: mappedState.status,
      leido_trade: item.estado !== 'PENDIENTE',
      visto_en_trade_at: item.estado !== 'PENDIENTE' ? item.updatedAt : null,
      created_at: item.createdAt,
      requierePromotora: true,
      materialPop: 'SI',
      notes: notesParts.join(' · '),
      observaciones: notesParts.join(' · '),
      originalComments: item.observaciones,
      resultado: item.resumen ? { comentarios: item.resumen } : null,
      lat: item.clienteLat,
      lon: item.clienteLon,
    };

    rows.push({
      id: degKey,
      type: 'Degustacion',
      date: ymd,
      store: item.clienteNombre,
      promoter: item.impulsadora || item.vendedorNombre || 'Vendedor FDV',
      product: productSummary,
      comments: JSON.stringify(commentsObj),
      creatorId: item.vendedorNombre || item.vendedorCodigo || 'Vendedor FDV',
      created_at: item.createdAt,
      sucursal: canonicalSucursal,
      region: regionLabel,
      degustacion_key: degKey,
      leido_trade: item.estado !== 'PENDIENTE',
      visto_en_trade_at: item.estado !== 'PENDIENTE' ? item.updatedAt : null,
      en_historial: mappedState.enHistorial,
    });
  }

  return rows;
}

async function fetchImpulsosViaAdminClient(
  adminClient: SupabaseClient
): Promise<ImpulsoActividadCanonicalItem[]> {
  const [
    impRes,
    prodLinkRes,
    fechRes,
    motRes,
    regsRes,
    sucusRes,
    estasRes,
    vendsRes,
    allProdsRes,
  ] = await Promise.all([
    adminClient.from('Impulsos_Actividades').select('*').order('created_at', { ascending: false }).limit(500),
    adminClient.from('Impulsos_Productos').select('*').limit(2000),
    adminClient.from('Impulsos_Fechas').select('*').limit(2000),
    adminClient.from('Impulsos_Motivos').select('*').limit(200),
    adminClient.from('Regiones').select('id_regi,regi_desd').limit(50),
    adminClient.from('Sucursales').select('id_sucu,sucu_desc,id_regi').limit(200),
    adminClient.from('Estados').select('id_esta,esta_desc,id_regi').limit(200),
    adminClient.from('Vendedores').select('id_vend,vend_codi,vend_nomb,id_sucu').limit(1000),
    adminClient.from('Productos').select('id_prod,prod_codi,prod_desc,prod_unid').limit(2000),
  ]);

  if (impRes.error) {
    throw new Error(impRes.error.message);
  }

  const actividades = (impRes.data ?? []) as Array<Record<string, unknown>>;
  if (actividades.length === 0) return [];

  const clieIds = Array.from(
    new Set(actividades.map((a) => cleanStr(a.id_clie, 64)).filter((id) => UUID_REGEX.test(id)))
  );
  const clieRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < clieIds.length; i += 200) {
    const chunk = clieIds.slice(i, i + 200);
    const { data } = await adminClient
      .from('Clientes')
      .select('id_clie,clie_rif,clie_nomb,clie_regi,id_esta,clie_lati,clie_long')
      .in('id_clie', chunk);
    if (Array.isArray(data)) {
      clieRows.push(...(data as Array<Record<string, unknown>>));
    }
  }

  const regById = new Map<string, AllowedRegionCode>();
  for (const r of (regsRes.data ?? []) as Array<Record<string, unknown>>) {
    const code = normalizeRegionName(r.regi_desd);
    if (r.id_regi && code) regById.set(String(r.id_regi), code);
  }

  const sucuById = new Map<string, { desc: string; region: AllowedRegionCode | null }>();
  for (const s of (sucusRes.data ?? []) as Array<Record<string, unknown>>) {
    if (!s.id_sucu) continue;
    const reg = (s.id_regi ? regById.get(String(s.id_regi)) : null) ?? normalizeRegionName(s.sucu_desc);
    sucuById.set(String(s.id_sucu), { desc: cleanStr(s.sucu_desc, 80), region: reg });
  }

  const estaById = new Map<string, { desc: string; region: AllowedRegionCode | null }>();
  for (const e of (estasRes.data ?? []) as Array<Record<string, unknown>>) {
    if (!e.id_esta) continue;
    const reg = (e.id_regi ? regById.get(String(e.id_regi)) : null) ?? normalizeRegionName(e.esta_desc);
    estaById.set(String(e.id_esta), { desc: cleanStr(e.esta_desc, 80), region: reg });
  }

  const vendById = new Map<string, { codi: string; nomb: string; sucuDesc: string; region: AllowedRegionCode | null }>();
  for (const v of (vendsRes.data ?? []) as Array<Record<string, unknown>>) {
    if (!v.id_vend) continue;
    const sucu = v.id_sucu ? sucuById.get(String(v.id_sucu)) : undefined;
    vendById.set(String(v.id_vend), {
      codi: cleanStr(v.vend_codi, 40),
      nomb: cleanStr(v.vend_nomb, 140),
      sucuDesc: sucu?.desc ?? '',
      region: sucu?.region ?? null,
    });
  }

  const clieById = new Map<
    string,
    { rif: string; nomb: string; estado: string; region: AllowedRegionCode | null; lat: number | null; lon: number | null }
  >();
  for (const c of clieRows) {
    if (!c.id_clie) continue;
    const esta = c.id_esta ? estaById.get(String(c.id_esta)) : undefined;
    const region =
      (c.clie_regi ? regById.get(String(c.clie_regi)) : null) ??
      esta?.region ??
      normalizeRegionName(esta?.desc);
    const lat = typeof c.clie_lati === 'number' && Number.isFinite(c.clie_lati) ? c.clie_lati : null;
    const lon = typeof c.clie_long === 'number' && Number.isFinite(c.clie_long) ? c.clie_long : null;
    clieById.set(String(c.id_clie), {
      rif: cleanStr(c.clie_rif, 40),
      nomb: cleanStr(c.clie_nomb, 180),
      estado: esta?.desc ?? '',
      region,
      lat,
      lon,
    });
  }

  const prodById = new Map<string, { codi: string; desc: string; unid: string }>();
  for (const p of (allProdsRes.data ?? []) as Array<Record<string, unknown>>) {
    if (!p.id_prod) continue;
    prodById.set(String(p.id_prod), {
      codi: cleanStr(p.prod_codi, 40),
      desc: cleanStr(p.prod_desc, 160),
      unid: cleanStr(p.prod_unid || 'KG', 20),
    });
  }

  const motById = new Map<string, string>();
  for (const m of (motRes.data ?? []) as Array<Record<string, unknown>>) {
    if (m.id_moti) motById.set(String(m.id_moti), cleanStr(m.moti_desc, 160));
  }

  const prodsByImpu = new Map<string, Array<{ id?: string; codigo?: string; nombre: string; um?: string; cant?: number | null }>>();
  for (const pl of (prodLinkRes.data ?? []) as Array<Record<string, unknown>>) {
    const idImpu = cleanStr(pl.id_impu, 64);
    const idProd = cleanStr(pl.id_prod, 64);
    if (!idImpu) continue;
    const p = prodById.get(idProd);
    const list = prodsByImpu.get(idImpu) ?? [];
    const cantRaw = Number(pl.impp_cant ?? pl.cant ?? 0);
    list.push({
      id: idProd || undefined,
      codigo: p?.codi || undefined,
      nombre: p?.desc || cleanStr(pl.prod_desc, 140) || 'Producto Codizulca',
      um: p?.unid || 'KG',
      cant: Number.isFinite(cantRaw) && cantRaw > 0 ? cantRaw : null,
    });
    prodsByImpu.set(idImpu, list);
  }

  const fechasByImpu = new Map<string, Array<{ fecha: string; hini: string; hfin: string }>>();
  for (const f of (fechRes.data ?? []) as Array<Record<string, unknown>>) {
    const idImpu = cleanStr(f.id_impu, 64);
    const fecha = normalizeIsoDate(f.impf_fech);
    if (!idImpu || !fecha) continue;
    const list = fechasByImpu.get(idImpu) ?? [];
    list.push({
      fecha,
      hini: normalizeHourText(f.impf_hini),
      hfin: normalizeHourText(f.impf_hfin),
    });
    fechasByImpu.set(idImpu, list);
  }

  return actividades.map((a) => {
    const idImpu = cleanStr(a.id_impu, 64);
    const idEnvio = cleanStr(a.id_envio, 64) || idImpu;
    const vend = a.id_vend ? vendById.get(String(a.id_vend)) : undefined;
    const clie = a.id_clie ? clieById.get(String(a.id_clie)) : undefined;
    const region = clie?.region ?? vend?.region ?? null;
    const rawTipo = cleanStr(a.impu_tipo, 32).toUpperCase();
    const tipo: 'DEGUSTACION' | 'IMPULSO' = rawTipo === 'IMPULSO' ? 'IMPULSO' : 'DEGUSTACION';
    const rawEsta = cleanStr(a.impu_esta, 32).toUpperCase();
    const estado: ImpulsoActividadCanonicalItem['estado'] =
      rawEsta === 'CONFIRMADA'
        ? 'CONFIRMADA'
        : rawEsta === 'EJECUTADA'
          ? 'EJECUTADA'
          : rawEsta === 'CANCELADA'
            ? 'CANCELADA'
            : 'PENDIENTE';

    return {
      idImpu,
      idEnvio,
      tipo,
      estado,
      fdes: normalizeIsoDate(a.impu_fdes),
      fhas: normalizeIsoDate(a.impu_fhas),
      hini: normalizeHourText(a.impu_hini),
      hfin: normalizeHourText(a.impu_hfin),
      fechas: fechasByImpu.get(idImpu) ?? [],
      clienteId: a.id_clie ? String(a.id_clie) : null,
      clienteNombre: clie?.nomb || 'Cliente PDV',
      clienteRif: clie?.rif || '',
      clienteEstado: clie?.estado || '',
      clienteLat: clie?.lat ?? null,
      clienteLon: clie?.lon ?? null,
      vendedorId: a.id_vend ? String(a.id_vend) : null,
      vendedorCodigo: vend?.codi || cleanStr(a.impu_crea, 40),
      vendedorNombre: vend?.nomb || cleanStr(a.impu_crea_nomb, 140) || 'Vendedor FDV',
      sucursalDesc: vend?.sucuDesc || clie?.estado || '',
      region,
      motivo: a.id_moti ? motById.get(String(a.id_moti)) ?? '' : '',
      productos: prodsByImpu.get(idImpu) ?? [],
      observaciones: cleanStr(a.impu_obse, 600),
      impulsadora: cleanStr(a.impu_impu_nomb, 140) || null,
      telefono: cleanStr(a.impu_impu_tele, 40) || null,
      resumen: cleanStr(a.impu_resu, 500) || null,
      cancelMotivo: cleanStr(a.impu_canc_moti, 400) || null,
      createdAt: String(a.created_at || new Date().toISOString()),
      updatedAt: String(a.updated_at || a.created_at || new Date().toISOString()),
    };
  });
}

async function fetchImpulsosViaAuthenticatedRpc(
  userClient: SupabaseClient
): Promise<ImpulsoActividadCanonicalItem[]> {
  const { data, error } = await userClient.rpc('app_impulsos_listar', {
    p_user: TRADE_IMPULSOS_ACTOR_USER,
  });
  if (error) {
    throw new Error(error.message);
  }
  const envelope = data as { ok?: boolean; actividades?: Array<Record<string, unknown>> } | null;
  const list = Array.isArray(envelope?.actividades) ? envelope!.actividades! : [];
  if (list.length === 0) return [];

  return list.map((raw) => {
    const clie = (raw.cliente && typeof raw.cliente === 'object' ? raw.cliente : {}) as Record<string, unknown>;
    const vend = (raw.vendedor && typeof raw.vendedor === 'object' ? raw.vendedor : {}) as Record<string, unknown>;
    const solic = (raw.solicitante && typeof raw.solicitante === 'object' ? raw.solicitante : {}) as Record<string, unknown>;
    const mot = (raw.motivo && typeof raw.motivo === 'object' ? raw.motivo : {}) as Record<string, unknown>;
    const estadoGeo = cleanStr(clie.estado, 80);
    const region = normalizeRegionName(estadoGeo);
    const idEnvio = cleanStr(raw.id_envio, 64);
    const rawTipo = cleanStr(raw.tipo, 32).toUpperCase();
    const rawEsta = cleanStr(raw.estado, 32).toUpperCase();

    const fechasRaw = Array.isArray(raw.fechas) ? (raw.fechas as Array<Record<string, unknown>>) : [];
    const prodsRaw = Array.isArray(raw.productos) ? (raw.productos as Array<Record<string, unknown>>) : [];

    return {
      idImpu: idEnvio,
      idEnvio,
      tipo: rawTipo === 'IMPULSO' ? 'IMPULSO' : 'DEGUSTACION',
      estado:
        rawEsta === 'CONFIRMADA'
          ? 'CONFIRMADA'
          : rawEsta === 'EJECUTADA'
            ? 'EJECUTADA'
            : rawEsta === 'CANCELADA'
              ? 'CANCELADA'
              : 'PENDIENTE',
      fdes: normalizeIsoDate(raw.fdes),
      fhas: normalizeIsoDate(raw.fhas),
      hini: normalizeHourText(raw.hini),
      hfin: normalizeHourText(raw.hfin),
      fechas: fechasRaw
        .map((f) => ({
          fecha: normalizeIsoDate(f.fecha),
          hini: normalizeHourText(f.hini),
          hfin: normalizeHourText(f.hfin),
        }))
        .filter((f) => Boolean(f.fecha)),
      clienteId: clie.id ? String(clie.id) : null,
      clienteNombre: cleanStr(clie.nombre, 180) || 'Cliente PDV',
      clienteRif: cleanStr(clie.rif, 40),
      clienteEstado: estadoGeo,
      clienteLat: typeof clie.lat === 'number' && Number.isFinite(clie.lat) ? clie.lat : null,
      clienteLon: typeof clie.lon === 'number' && Number.isFinite(clie.lon) ? clie.lon : null,
      vendedorId: vend.id ? String(vend.id) : null,
      vendedorCodigo: cleanStr(solic.usuario, 40),
      vendedorNombre: cleanStr(vend.nombre || solic.nombre, 140) || 'Vendedor FDV',
      sucursalDesc: estadoGeo,
      region,
      motivo: cleanStr(mot.nombre, 160),
      productos: prodsRaw.map((p) => ({
        id: p.id ? String(p.id) : undefined,
        codigo: cleanStr(p.codigo, 40) || undefined,
        nombre: cleanStr(p.nombre, 160) || 'Producto Codizulca',
        um: cleanStr(p.um || 'KG', 20),
        cant: typeof p.cant === 'number' && Number.isFinite(p.cant) ? p.cant : null,
      })),
      observaciones: cleanStr(raw.obse, 600),
      impulsadora: cleanStr(raw.impulsadora, 140) || null,
      telefono: cleanStr(raw.telefono, 40) || null,
      resumen: cleanStr(raw.resumen, 500) || null,
      cancelMotivo: cleanStr(raw.canc_moti, 400) || null,
      createdAt: String(raw.creado || new Date().toISOString()),
      updatedAt: String(raw.ejec_at || raw.conf_at || raw.creado || new Date().toISOString()),
    };
  });
}

export function createSupabaseFdvImpulsosBridgeGateway(): FdvImpulsosBridgeGateway {
  return {
    async listImpulsosActividades(actor) {
      const adminClient = getAdminSupabaseClient();
      const userClient = actor.accessToken
        ? createUserScopedSupabaseClient(actor.accessToken, actor.activeSucursalHeader)
        : null;

      if (adminClient) {
        try {
          return await fetchImpulsosViaAdminClient(adminClient);
        } catch (err) {
          serverLogger.warn('fdv_impulsos_admin_fallback_to_rpc', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (userClient) {
        return fetchImpulsosViaAuthenticatedRpc(userClient);
      }

      throw new Error('SUPABASE_SERVER_UNCONFIGURED');
    },

    async syncImpulsoEstado(actor, params) {
      const adminClient = getAdminSupabaseClient();
      const userClient = actor.accessToken
        ? createUserScopedSupabaseClient(actor.accessToken, actor.activeSucursalHeader)
        : null;
      const rpcClient = adminClient || userClient;
      if (!rpcClient) {
        throw new Error('SUPABASE_SERVER_UNCONFIGURED');
      }

      if (params.estado === 'CONFIRMADA') {
        const { error } = await rpcClient.rpc('app_impulsos_confirmar', {
          p_user: TRADE_IMPULSOS_ACTOR_USER,
          p_envio: params.idEnvio,
          p_c: {
            impulsadora: params.promotoraNombre || null,
            telefono: params.promotoraTelefono || null,
          },
        });
        if (error) throw new Error(error.message);
        return { ok: true, estado: 'CONFIRMADA' };
      }

      if (params.estado === 'CANCELADA') {
        const { error } = await rpcClient.rpc('app_impulsos_cancelar', {
          p_user: TRADE_IMPULSOS_ACTOR_USER,
          p_envio: params.idEnvio,
          p_moti: params.motivoCancelacion || 'No autorizada por Coordinación Trade Marketing',
        });
        if (error) throw new Error(error.message);
        return { ok: true, estado: 'CANCELADA' };
      }

      const { error } = await rpcClient.rpc('app_impulsos_ejecutar', {
        p_user: TRADE_IMPULSOS_ACTOR_USER,
        p_envio: params.idEnvio,
        p_e: {
          resumen: params.resumen || 'Ejecutada y verificada en Trade Marketing.',
        },
      });
      if (error) throw new Error(error.message);
      return { ok: true, estado: 'EJECUTADA' };
    },
  };
}

export function createFdvImpulsosBridgeHandlers(
  gateway: FdvImpulsosBridgeGateway = createSupabaseFdvImpulsosBridgeGateway()
) {
  return {
    async handleListImpulsosDegustaciones(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_REQUIRED' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const allItems = await gateway.listImpulsosActividades(actor);
        const allowedRegions: AllowedRegionCode[] | null =
          scope.regions && scope.regions.length > 0
            ? scope.regions
            : scope.region
              ? [scope.region]
              : scope.sucursal
                ? (() => {
                    const mapped = normalizeRegionName(scope.sucursal);
                    return mapped ? [mapped] : null;
                  })()
                : null;

        const scopedItems = allItems.filter((item) => {
          if (!item.region) return false;
          if (!allowedRegions) return true;
          return allowedRegions.includes(item.region);
        });

        const surveys: AdaptedImpulsoSurveyRow[] = [];
        for (const item of scopedItems) {
          surveys.push(...adaptImpulsoActividadToSurveyRows(item));
        }

        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({
          ok: true,
          source: 'supabase_impulsos_actividades',
          region: scope.region ?? (allowedRegions?.join(',') || 'ALL'),
          totalActividades: scopedItems.length,
          total: surveys.length,
          data: surveys,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error consultando solicitudes de vendedores.';
        serverLogger.error('fdv_impulsos_list_failed', {
          userId: actor.id,
          message: msg,
        });
        res.status(msg === 'SUPABASE_SERVER_UNCONFIGURED' ? 503 : 500).json({
          error: 'No se pudieron sincronizar las solicitudes de degustación desde la App de Vendedores.',
          code: msg === 'SUPABASE_SERVER_UNCONFIGURED' ? 'SUPABASE_SERVER_UNCONFIGURED' : 'FDV_IMPULSOS_ERROR',
        });
      }
    },

    async handleSyncImpulsoEstado(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_REQUIRED' });
        return;
      }

      const rawIdEnvio = String(req.params.idEnvio ?? '').trim();
      if (!UUID_REGEX.test(rawIdEnvio)) {
        res.status(400).json({
          error: 'Identificador idEnvio inválido (se requiere UUID).',
          code: 'INVALID_ID_ENVIO',
        });
        return;
      }

      const parsed = SyncImpulsoEstadoBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message || 'Payload de sincronización inválido.',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, undefined, undefined, undefined);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const allItems = await gateway.listImpulsosActividades(actor);
        const target = allItems.find((item) => item.idEnvio === rawIdEnvio || item.idImpu === rawIdEnvio);
        if (!target) {
          res.status(404).json({
            error: 'Solicitud de vendedor no encontrada en Impulsos_Actividades.',
            code: 'IMPULSO_NOT_FOUND',
          });
          return;
        }

        const allowedRegions: AllowedRegionCode[] | null =
          scope.regions && scope.regions.length > 0
            ? scope.regions
            : scope.region
              ? [scope.region]
              : null;

        if (allowedRegions && (!target.region || !allowedRegions.includes(target.region))) {
          res.status(403).json({
            error: `Acceso denegado: tu cuenta (${allowedRegions.join(', ')}) no puede modificar solicitudes de ${target.region || 'otra región'}.`,
            code: 'FORBIDDEN_REGION_ACCESS',
          });
          return;
        }

        const targetEstado: 'CONFIRMADA' | 'CANCELADA' | 'EJECUTADA' =
          parsed.data.estado === 'COMPLETADA' || parsed.data.estado === 'EJECUTADA'
            ? 'EJECUTADA'
            : parsed.data.estado === 'NO_AUTORIZADA' ||
                parsed.data.estado === 'RECHAZADA' ||
                parsed.data.estado === 'CANCELADA'
              ? 'CANCELADA'
              : 'CONFIRMADA';

        const result = await gateway.syncImpulsoEstado(actor, {
          idEnvio: target.idEnvio,
          estado: targetEstado,
          promotoraNombre: parsed.data.promotoraAsignada,
          promotoraTelefono: parsed.data.promotoraTelefono,
          motivoCancelacion: parsed.data.motivoCancelacion || parsed.data.notasTradeMarketing,
          resumen: parsed.data.notasTradeMarketing,
        });

        res.status(200).json({
          ok: result.ok,
          idEnvio: target.idEnvio,
          estado: result.estado,
          region: target.region,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error actualizando solicitud en App de Vendedores.';
        serverLogger.error('fdv_impulsos_sync_estado_failed', {
          userId: actor.id,
          idEnvio: rawIdEnvio,
          message: msg,
        });
        res.status(500).json({
          error: 'No se pudo sincronizar el estado hacia la App de Vendedores.',
          code: 'FDV_IMPULSOS_SYNC_ERROR',
        });
      }
    },
  };
}

export const defaultFdvImpulsosBridgeHandlers = createFdvImpulsosBridgeHandlers();
