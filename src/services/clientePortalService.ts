import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabaseClient';

export interface ClientePortalPdv {
  id: string;
  codigoCliente: string;
  nombreComercial: string;
  cadenaId: string | null;
  cadenaCodigo: string | null;
  cadenaNombre: string;
  cadenaHasLogo: boolean;
  cadenaLogoMimeType: string | null;
  cadenaLogoUpdatedAt: string | null;
  ciudad: string;
  estado: string;
  sucursal: string | null;
}

export interface ClientePortalCadenaBranding {
  id: string;
  codigo: string;
  nombre: string;
  tipoCanal: string;
  sucursal: string | null;
  hasLogo: boolean;
  logoMimeType: string | null;
  logoUpdatedAt: string | null;
}

export interface ClientePortalActivacion {
  id: string;
  fecha: string;
  turno: string;
  horaInicio: string;
  horaFin: string;
  clienteNombre: string;
  productoResumen: string;
  estado: string;
  promotoraNombre: string;
  muestrasEntregadas: number;
  ventasAsistidasUnidades: number;
  dentroGeocerca: boolean | null;
}

export interface ClientePortalResumen {
  pdvs: ClientePortalPdv[];
  cadenasBranding: ClientePortalCadenaBranding[];
  activaciones: ClientePortalActivacion[];
  kpis: {
    totalPdvs: number;
    totalActivaciones: number;
    completadas: number;
    programadas: number;
    muestras: number;
    ventasAsistidas: number;
    cumplimientoPct: number;
  };
}

export function computeClienteKpis(
  pdvs: ClientePortalPdv[],
  activaciones: ClientePortalActivacion[]
): ClientePortalResumen['kpis'] {
  const completadas = activaciones.filter((a) => a.estado === 'COMPLETADA').length;
  const muestras = activaciones.reduce((s, a) => s + (a.muestrasEntregadas || 0), 0);
  const ventas = activaciones.reduce((s, a) => s + (a.ventasAsistidasUnidades || 0), 0);
  return {
    totalPdvs: pdvs.length,
    totalActivaciones: activaciones.length,
    completadas,
    programadas: activaciones.length - completadas,
    muestras,
    ventasAsistidas: ventas,
    cumplimientoPct:
      activaciones.length > 0 ? Math.round((completadas / activaciones.length) * 1000) / 10 : 0,
  };
}

export function mapClientePortalPayload(raw: unknown): ClientePortalResumen {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const pdvRaw = Array.isArray(obj.pdvs_autorizados) ? obj.pdvs_autorizados : [];
  const cadRaw = Array.isArray(obj.cadenas_branding) ? obj.cadenas_branding : [];
  const actRaw = Array.isArray(obj.activaciones) ? obj.activaciones : [];

  const pdvs: ClientePortalPdv[] = pdvRaw.map((r) => {
    const x = r as Record<string, unknown>;
    return {
      id: String(x.id || ''),
      codigoCliente: String(x.codigo_cliente || ''),
      nombreComercial: String(x.nombre_comercial || ''),
      cadenaId: x.cadena_id ? String(x.cadena_id) : null,
      cadenaCodigo: x.cadena_codigo ? String(x.cadena_codigo) : null,
      cadenaNombre: String(x.cadena_nombre || ''),
      cadenaHasLogo: Boolean(x.cadena_has_logo),
      cadenaLogoMimeType: x.cadena_logo_mime_type ? String(x.cadena_logo_mime_type) : null,
      cadenaLogoUpdatedAt: x.cadena_logo_updated_at ? String(x.cadena_logo_updated_at) : null,
      ciudad: String(x.ciudad || ''),
      estado: String(x.estado || ''),
      sucursal: x.sucursal ? String(x.sucursal) : null,
    };
  });

  const cadenasMap = new Map<string, ClientePortalCadenaBranding>();
  for (const r of cadRaw) {
    const x = r as Record<string, unknown>;
    const id = String(x.id || '').trim();
    if (!id) continue;
    cadenasMap.set(id, {
      id,
      codigo: String(x.codigo || ''),
      nombre: String(x.nombre || ''),
      tipoCanal: String(x.tipo_canal || 'Supermercado'),
      sucursal: x.sucursal ? String(x.sucursal) : null,
      hasLogo: Boolean(x.has_logo),
      logoMimeType: x.logo_mime_type ? String(x.logo_mime_type) : null,
      logoUpdatedAt: x.logo_updated_at ? String(x.logo_updated_at) : null,
    });
  }

  // Respaldo de compatibilidad si `cadenas_branding` aún no viene poblado pero el PDV referencia cadena
  for (const pdv of pdvs) {
    if (pdv.cadenaId && !cadenasMap.has(pdv.cadenaId)) {
      cadenasMap.set(pdv.cadenaId, {
        id: pdv.cadenaId,
        codigo: pdv.cadenaCodigo || '',
        nombre: pdv.cadenaNombre || 'Cadena Comercial',
        tipoCanal: 'Supermercado',
        sucursal: pdv.sucursal,
        hasLogo: pdv.cadenaHasLogo,
        logoMimeType: pdv.cadenaLogoMimeType,
        logoUpdatedAt: pdv.cadenaLogoUpdatedAt,
      });
    }
  }

  const activaciones: ClientePortalActivacion[] = actRaw.map((r) => {
    const x = r as Record<string, unknown>;
    return {
      id: String(x.id || ''),
      fecha: String(x.fecha || ''),
      turno: String(x.turno || ''),
      horaInicio: String(x.hora_inicio || ''),
      horaFin: String(x.hora_fin || ''),
      clienteNombre: String(x.cliente_nombre || ''),
      productoResumen: String(x.producto_resumen || ''),
      estado: String(x.estado || ''),
      promotoraNombre: String(x.promotora_nombre || ''),
      muestrasEntregadas: Number(x.muestras_entregadas ?? 0) || 0,
      ventasAsistidasUnidades: Number(x.ventas_asistidas_unidades ?? 0) || 0,
      dentroGeocerca: typeof x.checkin_dentro_geocerca === 'boolean' ? x.checkin_dentro_geocerca : null,
    };
  });

  return {
    pdvs,
    cadenasBranding: Array.from(cadenasMap.values()),
    activaciones,
    kpis: computeClienteKpis(pdvs, activaciones),
  };
}

/** Solo lectura: invoca la RPC `rpc_obtener_resumen_portal_cliente` (aislada por RLS/sucursal). */
export async function fetchClientePortalResumen(
  customClient?: SupabaseClient
): Promise<ClientePortalResumen> {
  const client = customClient ?? getSupabaseClient();
  const { data, error } = await client.rpc('rpc_obtener_resumen_portal_cliente');
  if (error) {
    throw new Error(error.message || 'No se pudo cargar el portal del cliente.');
  }
  return mapClientePortalPayload(data);
}
