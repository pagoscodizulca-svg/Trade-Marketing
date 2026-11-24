import type { SupabaseClient } from '@supabase/supabase-js';
import { OPERATIVE_SUCURSALES, type Entrega, type EntregaVista, type OperativeSucursal } from '../types';
import { MENSAJE_REQUIERE_CONEXION, newId, type EntregasRepository } from './entregasRepository';
import { createSyncStore } from './syncStore';
import { IMMEDIATE_TIMEOUT_MS, createSyncEngine, registerBackgroundSync } from './syncEngine';
import { createRutaSupabaseClient, getRutaSupabaseClient } from './supabaseAuth';
import { applyPayload, construirCuerpoServidor, type OutboxPayload } from '../lib/deliveryOps';
import {
  buildSafeEvidenceStoragePath,
  EVIDENCIA_BUCKET_DEFAULT,
  isSafeStorageObjectPath,
  validateEvidenceImageFile,
} from '../lib/evidenceValidation';
import {
  enqueueOperation,
  getAllDeliveries,
  getMeta,
  listOutbox,
  patchDelivery,
  replaceDeliveries,
  setMeta,
  subscribeChanges,
  type OutboxItem,
  type StoredDelivery,
} from '../lib/offlineDb';
import { readShiftToken, saveAuthToken, saveConfig, TABLE } from '../lib/syncCore';
import { fetchChoferShiftBootstrap } from './shiftSessionService';

/*
 * Tabla requerida en Supabase: ver supabase/migrations/20261106_entregas_degustacion.sql
 * (y, opcional, 20261106_entregas_offline_sync.sql para la hora exacta y el «gana el último»).
 */

const PAGE = 1000;
const INSERT_CHUNK = 500;
const DELETE_CHUNK = 100;
const REFRESH_ON_FOCUS_MIN_MS = 15_000;

const mensajeDe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const esErrorDeRed = (msg: string): boolean =>
  (typeof navigator !== 'undefined' && navigator.onLine === false) ||
  /failed to fetch|networkerror|load failed|network request failed|fetch failed|aborted|timeout|timed out/i.test(msg);

function canonicalizeDbSucursal(raw: unknown): 'OCCIDENTE' | 'CENTRO' | undefined {
  const code = String(raw ?? '').trim().toUpperCase();
  if (!code) return undefined;
  if (code === 'ZULIA' || code === 'OCCIDENTE') return 'OCCIDENTE';
  if (code === 'VALENCIA' || code === 'CENTRO' || code === 'ORIENTE' || code === 'CAPITAL') {
    return 'CENTRO';
  }
  return undefined;
}

/** Normaliza una fila remota para que la UI nunca reciba null/undefined en campos de texto. */
function normalizarFila(r: Record<string, unknown>): Entrega {
  const txt = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const rawSuc = txt(r.sucursal).trim().toUpperCase();
  const mappedSuc = rawSuc === 'OCCIDENTE' ? 'ZULIA' : rawSuc;
  const sucursal = (OPERATIVE_SUCURSALES as readonly string[]).includes(mappedSuc)
    ? (mappedSuc as OperativeSucursal)
    : undefined;
  const rawRegion = txt(r.region).trim();
  const rawSede = txt(r.chofer_sede).trim().toUpperCase();
  const choferSede: Entrega['chofer_sede'] =
    rawSede === 'VALENCIA' || rawSede === 'OCCIDENTE'
      ? rawSede
      : sucursal === 'VALENCIA' || sucursal === 'CENTRO'
        ? 'VALENCIA'
        : sucursal === 'ZULIA'
          ? 'OCCIDENTE'
          : undefined;
  const completado = r.completado === true;
  const horaSalida = typeof r.hora_salida === 'string' && r.hora_salida ? r.hora_salida : null;
  const horaSalidaReal =
    typeof r.hora_salida_real === 'string' && r.hora_salida_real ? r.hora_salida_real : null;
  const horaEntrega =
    typeof r.hora_entrega === 'string' && r.hora_entrega ? r.hora_entrega : null;
  const horaLlegada =
    typeof r.hora_llegada === 'string' && r.hora_llegada ? r.hora_llegada : horaEntrega;
  const rawEstado = txt(r.estado_logistico).trim().toUpperCase();
  const estadoLogistico: Entrega['estado_logistico'] =
    rawEstado === 'ENTREGADO' || completado
      ? 'ENTREGADO'
      : rawEstado === 'EN_RUTA' || Boolean(horaSalida)
        ? 'EN_RUTA'
        : 'PENDIENTE';
  return {
    id: txt(r.id),
    fecha: txt(r.fecha),
    turno: txt(r.turno) as Entrega['turno'],
    numero_grupo_turno: txt(r.numero_grupo_turno),
    cliente: txt(r.cliente),
    producto: txt(r.producto),
    vendedor: txt(r.vendedor),
    promotora: txt(r.promotora),
    stand_entregado: r.stand_entregado === true,
    producto_entregado: r.producto_entregado === true,
    completado,
    estado_logistico: estadoLogistico,
    hora_salida: horaSalida,
    hora_salida_real: horaSalidaReal,
    hora_llegada: horaLlegada,
    hora_entrega: horaEntrega,
    evidencia_path:
      typeof r.evidencia_path === 'string' && r.evidencia_path ? r.evidencia_path : null,
    evidencia_bucket:
      typeof r.evidencia_bucket === 'string' && r.evidencia_bucket
        ? r.evidencia_bucket
        : EVIDENCIA_BUCKET_DEFAULT,
    evidencia_subida_at:
      typeof r.evidencia_subida_at === 'string' && r.evidencia_subida_at
        ? r.evidencia_subida_at
        : null,
    cronograma_id:
      typeof r.cronograma_id === 'string' && r.cronograma_id ? r.cronograma_id : null,
    notas_chofer: txt(r.notas_chofer),
    ...(sucursal ? { sucursal } : {}),
    ...(rawRegion ? { region: rawRegion } : {}),
    ...(choferSede ? { chofer_sede: choferSede } : {}),
  };
}

/** Vista para la UI: datos de la entrega + estado de sincronización de la tarjeta. */
function aVista(d: StoredDelivery): EntregaVista {
  const { _sync, _orden: _o, ...datos } = d;
  void _o;
  if (!_sync.marcada_offline) return datos;
  return { ...datos, sync: _sync.pendiente ? 'pendiente' : 'sincronizado_offline' };
}

/**
 * Repositorio offline-first. Supabase es la fuente de verdad; IndexedDB guarda SOLO su última copia real
 * (más las acciones reales del chofer pendientes). Sin red se muestra esa copia y las acciones se encolan.
 */
export function createSupabaseRepository(url: string, anonKey: string): EntregasRepository {
  const store = createSyncStore({
    status: 'sincronizando',
    errorMessage: null,
    lastSyncAt: null,
    realtime: false,
    pendingCount: 0,
    flushing: false,
    offline: typeof navigator !== 'undefined' ? navigator.onLine === false : false,
    aviso: null,
  });

  let cachedClient: SupabaseClient | null = null;
  const getClient = async (): Promise<SupabaseClient> => {
    if (!cachedClient) {
      cachedClient =
        getRutaSupabaseClient() ?? createRutaSupabaseClient({ url, publicKey: anonKey });
    }
    return cachedClient;
  };

  // IndexedDB disponible (false en modos privados/bloqueados: la app sigue funcionando solo en línea).
  let idbOk = true;
  let started = false;
  let secuencia = 0;
  let ultimoPull = 0;
  let realtimeAbierto = false;
  let activeChannel: ReturnType<SupabaseClient['channel']> | null = null;
  let stopDeliveriesSub: (() => void) | null = null;
  const cleanupDomListeners: Array<() => void> = [];

  // Serializa lecturas/escrituras locales para que la UI nunca vea estados intermedios.
  let cola: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = cola.then(() => fn());
    cola = p.catch(() => undefined);
    return p;
  };

  const engine = createSyncEngine({
    onDrained: () => cargar(false),
    onNetworkResult: () => {},
  });
  engine.subscribe(() => {
    const s = engine.getState();
    store.setState({ pendingCount: s.pendingCount, flushing: s.flushing, offline: s.offline, aviso: s.aviso });
  });

  /** Relee IndexedDB y refleja el resultado en pantalla (tras ack de la cola, cambios de otra pestaña o del SW). */
  const recargarDesdeDb = () =>
    serial(async () => {
      if (!idbOk) return;
      const filas = await getAllDeliveries();
      filas.sort((a, b) => a._orden - b._orden);
      store.setEntregas(filas.map(aVista));
    }).catch((err) => console.warn('[RutaDegustación] No se pudo leer el almacenamiento local:', mensajeDe(err)));

  let recargaPendiente: ReturnType<typeof setTimeout> | null = null;
  const programarRecarga = () => {
    if (recargaPendiente) return;
    recargaPendiente = setTimeout(() => {
      recargaPendiente = null;
      void recargarDesdeDb();
    }, 30);
  };

  /** Garantiza sesión activa y sincroniza el token JWT hacia la cola offline / Realtime. */
  async function syncSessionToken(client: SupabaseClient): Promise<string> {
    const { data, error } = await client.auth.getSession();
    const token = data.session?.access_token ?? '';
    if (error || !token) {
      throw new Error('Sesión expirada o inactiva. Inicie sesión nuevamente.');
    }
    if (idbOk) {
      await saveAuthToken(token).catch(() => undefined);
    }
    client.realtime.setAuth(token);
    return token;
  }

  /** Descarga todas las filas (paginadas) del servidor con la sesión autenticada o enlace de jornada firmado. */
  async function traerTodo(): Promise<Record<string, unknown>[]> {
    const shiftToken = idbOk ? await readShiftToken().catch(() => null) : null;
    if (shiftToken) {
      const boot = await fetchChoferShiftBootstrap(shiftToken);
      return boot.entregas;
    }

    const client = await getClient();
    await syncSessionToken(client);
    const filas: Record<string, unknown>[] = [];
    for (let desde = 0; ; desde += PAGE) {
      const { data, error } = await client
        .from(TABLE)
        .select('*')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(desde, desde + PAGE - 1);
      if (error) throw new Error(error.message);
      filas.push(...((data ?? []) as Record<string, unknown>[]));
      if (!data || data.length < PAGE) break;
    }

    // Excluir entregas cuyo cronograma origen fue cancelado o rechazado en Trade Marketing
    const cronogramaIds = Array.from(
      new Set(
        filas
          .map((f) => (typeof f.cronograma_id === 'string' ? f.cronograma_id.trim() : ''))
          .filter(Boolean)
      )
    );
    if (cronogramaIds.length > 0) {
      const cancelledCronIds = new Set<string>();
      for (let i = 0; i < cronogramaIds.length; i += 200) {
        const chunk = cronogramaIds.slice(i, i + 200);
        const { data: cronRows, error: cronErr } = await client
          .from('cronograma_degustaciones')
          .select('id, estado')
          .in('id', chunk);
        if (!cronErr && Array.isArray(cronRows)) {
          for (const cr of cronRows as Array<{ id?: string; estado?: string }>) {
            const st = String(cr.estado ?? '').trim().toUpperCase();
            if (cr.id && (st === 'CANCELADA' || st === 'RECHAZADA')) {
              cancelledCronIds.add(cr.id);
            }
          }
        }
      }
      if (cancelledCronIds.size > 0) {
        return filas.filter((f) => {
          const cid = typeof f.cronograma_id === 'string' ? f.cronograma_id.trim() : '';
          return !cid || !cancelledCronIds.has(cid);
        });
      }
    }

    return filas;
  }

  /**
   * Descarga la copia real del servidor, la guarda en synced_deliveries y SUPERPONE las acciones del chofer
   * que aún están en la cola (para que nada de lo que marcó «salte hacia atrás»). Nunca lanza.
   */
  async function cargar(mostrarSincronizando: boolean): Promise<void> {
    const mia = ++secuencia;
    if (mostrarSincronizando) store.setState({ status: 'sincronizando' });
    try {
      const filas = await traerTodo();
      if (mia !== secuencia) return; // llegó una respuesta más reciente
      engine.reportNetwork(true);
      const servidor = filas.map(normalizarFila);
      ultimoPull = Date.now();
      const ahoraIso = new Date().toISOString();

      await serial(async () => {
        let pendientes: OutboxItem[] = [];
        let previas = new Map<string, StoredDelivery>();
        if (idbOk) {
          try {
            pendientes = await listOutbox();
            previas = new Map((await getAllDeliveries()).map((d) => [d.id, d]));
          } catch (err) {
            idbOk = false;
            console.warn('[RutaDegustación] Almacenamiento local no disponible:', mensajeDe(err));
          }
        }
        const porEntrega = new Map<string, OutboxItem[]>();
        for (const op of pendientes) {
          const l = porEntrega.get(op.delivery_id) ?? [];
          l.push(op);
          porEntrega.set(op.delivery_id, l);
        }
        const guardadas: StoredDelivery[] = servidor.map((row, i) => {
          const ops = porEntrega.get(row.id) ?? [];
          let d: Entrega = row;
          for (const op of ops) d = applyPayload(d, op.payload);
          const previa = previas.get(row.id);
          return {
            ...d,
            _orden: i,
            _sync: {
              pendiente: ops.length > 0,
              marcada_offline: previa?._sync.marcada_offline ?? false,
              sincronizada_at_iso: previa?._sync.sincronizada_at_iso ?? null,
            },
          };
        });
        if (idbOk) {
          try {
            await replaceDeliveries(guardadas);
            await setMeta('last_full_sync_iso', ahoraIso);
          } catch (err) {
            idbOk = false;
            console.warn('[RutaDegustación] No se pudo guardar la copia local:', mensajeDe(err));
          }
        }
        store.commit(guardadas.map(aVista), { status: 'sincronizado', errorMessage: null, lastSyncAt: new Date(ahoraIso) });
      });
      void abrirRealtime();
    } catch (err) {
      if (mia !== secuencia) return;
      const msg = mensajeDe(err);
      if (esErrorDeRed(msg)) {
        // Sin red: se mantiene (y se sigue mostrando) la última copia real guardada en el teléfono.
        engine.reportNetwork(false);
        store.setState({ status: 'offline', errorMessage: msg });
      } else {
        console.error('[RutaDegustación] Error cargando entregas:', msg);
        store.setState({ status: 'error', errorMessage: msg || 'Error desconocido' });
      }
    }
  }

  async function abrirRealtime(): Promise<void> {
    if (realtimeAbierto || !started) return;
    const shiftToken = idbOk ? await readShiftToken().catch(() => null) : null;
    if (shiftToken) return; // Las jornadas firmadas operan sobre bootstrap + sync HTTPS sin abrir canal amplio
    realtimeAbierto = true;
    try {
      const client = await getClient();
      await syncSessionToken(client);
      let t: ReturnType<typeof setTimeout> | null = null;
      const channel = client
        .channel('entregas-degustacion-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, () => {
          if (t) clearTimeout(t);
          t = setTimeout(() => void cargar(false), 300);
        })
        .subscribe((status) => {
          store.setState({ realtime: status === 'SUBSCRIBED' });
        });
      activeChannel = channel;
    } catch (err) {
      realtimeAbierto = false;
      console.error('[RutaDegustación] Error abriendo el canal en tiempo real:', mensajeDe(err));
    }
  }

  async function arrancar(): Promise<void> {
    try {
      if (url && anonKey) {
        await saveConfig({ url, anonKey });
      }
      const activeShiftToken = await readShiftToken().catch(() => null);
      if (!activeShiftToken && url && anonKey) {
        const client = await getClient();
        await syncSessionToken(client).catch(() => undefined);
      }
      const filas = await getAllDeliveries();
      const iso = await getMeta<string>('last_full_sync_iso');
      // Las marcas «Sincronizado en servidor» de la sesión anterior se limpian al abrir la app.
      const limpias = filas.map((d) =>
        !d._sync.pendiente && d._sync.marcada_offline ? { ...d, _sync: { ...d._sync, marcada_offline: false } } : d,
      );
      if (limpias.some((d, i) => d !== filas[i])) await replaceDeliveries(limpias);
      limpias.sort((a, b) => a._orden - b._orden);
      // Lo primero que ve el chofer es su última ruta real guardada (sin esperar a la red).
      store.commit(limpias.map(aVista), {
        lastSyncAt: iso ? new Date(iso) : null,
        status: navigator.onLine ? 'sincronizando' : 'offline',
      });
    } catch (err) {
      idbOk = false;
      console.warn('[RutaDegustación] Almacenamiento local no disponible; solo modo en línea:', mensajeDe(err));
    }

    if (!started) return;

    stopDeliveriesSub?.();
    stopDeliveriesSub = subscribeChanges((kind) => {
      if (kind === 'deliveries') programarRecarga();
    });
    engine.start();

    const onOnline = () => {
      void engine.flushNow({ force: true }).then(() => cargar(false));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine && Date.now() - ultimoPull > REFRESH_ON_FOCUS_MIN_MS) {
        void engine.flushNow({ force: true }).then(() => cargar(false));
      }
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    cleanupDomListeners.push(
      () => window.removeEventListener('online', onOnline),
      () => document.removeEventListener('visibilitychange', onVisible),
    );

    if (navigator.onLine) {
      await engine.flushNow({ force: true });
      await cargar(false);
    } else {
      store.setState({ status: 'offline' });
    }
  }

  function detener(): void {
    if (!started) return;
    started = false;
    secuencia += 1;
    if (recargaPendiente) {
      clearTimeout(recargaPendiente);
      recargaPendiente = null;
    }
    cleanupDomListeners.splice(0).forEach((fn) => fn());
    stopDeliveriesSub?.();
    stopDeliveriesSub = null;
    engine.stop();
    if (activeChannel && cachedClient) {
      const ch = activeChannel;
      activeChannel = null;
      void cachedClient.removeChannel(ch).catch(() => undefined);
    }
    realtimeAbierto = false;
    store.commit([], {
      status: 'sincronizando',
      errorMessage: null,
      realtime: false,
      aviso: null,
    });
  }

  /**
   * Aplica una acción del chofer: pantalla + copia local al instante (0 latencia), la guarda en la cola
   * ANTES de enviarla (write-ahead) y luego intenta enviarla con un tope de 4 s. Si no se confirma, queda
   * en la cola y la tarjeta lo indica.
   */
  async function aplicarAccion(id: string, payload: OutboxPayload, createdAtIso: string): Promise<void> {
    const anterior = store.getEntregas();
    if (!anterior.some((e) => e.id === id)) return;

    // 1) Actualización optimista inmediata en pantalla
    store.setEntregas(anterior.map((e) => (e.id === id ? applyPayload(e, payload) : e)));

    if (!idbOk) {
      // Sin almacenamiento local: escritura directa (requiere red); se revierte si falla.
      try {
        const client = await getClient();
        await syncSessionToken(client);
        let res = await client
          .from(TABLE)
          .update(construirCuerpoServidor(payload, createdAtIso, true))
          .eq('id', id)
          .select('id');
        if (res.error && /PGRST204|42703|does not exist/i.test(`${res.error.code || ''} ${res.error.message || ''}`)) {
          res = await client
            .from(TABLE)
            .update(construirCuerpoServidor(payload, createdAtIso, false))
            .eq('id', id)
            .select('id');
        }
        if (res.error) throw new Error(res.error.message);
        const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
        if (rows.length === 0) {
          throw new Error('0 filas actualizadas en entregas_degustacion (verifica permisos RLS).');
        }
      } catch (err) {
        store.setEntregas(anterior);
        throw new Error(`No se pudo guardar: ${mensajeDe(err)}`);
      }
      return;
    }

    try {
      await serial(async () => {
        await patchDelivery(id, (cur) => ({ ...applyPayload(cur, payload), _sync: { ...cur._sync, pendiente: true } }));
        await enqueueOperation({ delivery_id: id, payload, created_at_iso: createdAtIso });
      });
    } catch (err) {
      store.setEntregas(anterior);
      throw new Error(`No se pudo guardar en el teléfono: ${mensajeDe(err)}`);
    }

    void registerBackgroundSync();
    void engine.refreshPending();

    // 2) Intento inmediato (tope 4 s); si queda pendiente se marca la tarjeta «Guardado en teléfono».
    void engine.flushNow({ timeoutMs: IMMEDIATE_TIMEOUT_MS, force: true }).then(() =>
      serial(async () => {
        await patchDelivery(id, (cur) =>
          cur._sync.pendiente && !cur._sync.marcada_offline ? { ...cur, _sync: { ...cur._sync, marcada_offline: true } } : null,
        );
      }).catch(() => undefined),
    );
  }

  /** Ejecuta una escritura en línea (alta/importación); si falla lanza el error y resincroniza. */
  const run = async (op: (c: SupabaseClient) => PromiseLike<{ error: { message: string } | null }>) => {
    if (store.getState().offline) throw new Error(MENSAJE_REQUIERE_CONEXION);
    try {
      const client = await getClient();
      await syncSessionToken(client);
      const { error } = await op(client);
      if (error) throw new Error(error.message);
    } catch (err) {
      void cargar(false);
      throw new Error(`No se pudo guardar en Supabase: ${mensajeDe(err)}`);
    }
    await cargar(false);
  };

  return {
    kind: 'supabase',
    start() {
      if (started) return;
      started = true;
      void arrancar();
    },
    stop() {
      detener();
    },
    getSnapshot: store.getEntregas,
    subscribe: store.subscribe,
    getSyncState: store.getState,
    get status() {
      return store.getState().status;
    },
    get errorMessage() {
      return store.getState().errorMessage;
    },
    get lastSyncAt() {
      return store.getState().lastSyncAt;
    },
    async refresh() {
      await engine.flushNow({ force: true });
      await cargar(true);
    },
    async flushNow() {
      await engine.flushNow({ force: true });
    },
    async toggleEntrega(id) {
      const actual = store.getEntregas().find((e) => e.id === id);
      if (!actual) return;
      const completar = !actual.completado;
      const ahoraIso = new Date().toISOString(); // hora EXACTA del toque, sin importar cuándo se suba
      await aplicarAccion(
        id,
        {
          completado: completar,
          stand_entregado: completar,
          producto_entregado: completar,
          estado_logistico: completar ? 'ENTREGADO' : actual.hora_salida ? 'EN_RUTA' : 'PENDIENTE',
          hora_llegada_real: completar ? ahoraIso : null,
          hora_entrega_real: completar ? ahoraIso : null,
        },
        ahoraIso,
      );
    },
    async confirmarSalida(id) {
      const actual = store.getEntregas().find((e) => e.id === id);
      if (!actual) return;
      const ahoraIso = new Date().toISOString();
      await aplicarAccion(
        id,
        {
          estado_logistico: actual.completado ? 'ENTREGADO' : 'EN_RUTA',
          hora_salida_real: ahoraIso,
        },
        ahoraIso,
      );
    },
    async confirmarLlegada(id) {
      const actual = store.getEntregas().find((e) => e.id === id);
      if (!actual) return;
      const ahoraIso = new Date().toISOString();
      await aplicarAccion(
        id,
        {
          estado_logistico: 'ENTREGADO',
          completado: true,
          stand_entregado: true,
          producto_entregado: true,
          hora_llegada_real: ahoraIso,
          hora_entrega_real: ahoraIso,
        },
        ahoraIso,
      );
    },
    async subirEvidencia(id, file) {
      const validation = validateEvidenceImageFile(file);
      if (!validation.ok) {
        throw new Error(validation.error);
      }
      if (store.getState().offline) {
        throw new Error(MENSAJE_REQUIERE_CONEXION);
      }

      const objectPath = buildSafeEvidenceStoragePath(id, validation.ext);
      const bucket = EVIDENCIA_BUCKET_DEFAULT;
      const nowIso = new Date().toISOString();
      const client = await getClient();
      await syncSessionToken(client);

      const uploadRes = await client.storage.from(bucket).upload(objectPath, file, {
        contentType: validation.mime,
        upsert: false,
        cacheControl: '3600',
      });

      if (uploadRes.error) {
        console.error('[RutaDegustación] Error subiendo evidencia a Storage:', {
          message: uploadRes.error.message,
          bucket,
          objectPath,
        });
        throw new Error(
          uploadRes.error.message ||
            'No se pudo subir la evidencia fotográfica al bucket de Supabase Storage.'
        );
      }

      const updRes = await client
        .from(TABLE)
        .update({
          evidencia_path: objectPath,
          evidencia_bucket: bucket,
          evidencia_subida_at: nowIso,
          actualizado_chofer_at: nowIso,
        })
        .eq('id', id)
        .select('id, evidencia_path, evidencia_bucket, evidencia_subida_at');

      const updatedRows = Array.isArray(updRes.data)
        ? updRes.data
        : updRes.data
          ? [updRes.data]
          : [];

      if (updRes.error || updatedRows.length === 0) {
        // Rollback inmediato en Storage para no dejar archivos huérfanos
        await client.storage.from(bucket).remove([objectPath]).catch(() => undefined);
        console.error('[RutaDegustación] Error vinculando evidencia en entregas_degustacion (rollback ejecutado):', {
          code: updRes.error?.code,
          message: updRes.error?.message,
          hint: updRes.error?.hint,
          id,
          rowsCount: updatedRows.length,
        });
        throw new Error(
          updRes.error?.message ||
            'No se pudo registrar la referencia de la evidencia en Supabase (0 filas afectadas). Verifica permisos RLS.'
        );
      }

      const evidencePayload: OutboxPayload = {
        evidencia_path: objectPath,
        evidencia_bucket: bucket,
        evidencia_subida_at: nowIso,
      };
      store.setEntregas(
        store.getEntregas().map((e) => (e.id === id ? applyPayload(e, evidencePayload) : e))
      );
      if (idbOk) {
        await serial(async () => {
          await patchDelivery(id, (cur) => applyPayload(cur, evidencePayload));
        }).catch(() => undefined);
      }

      const signed = await client.storage.from(bucket).createSignedUrl(objectPath, 3600);
      return {
        path: objectPath,
        bucket,
        signedUrl: signed.data?.signedUrl ?? null,
      };
    },
    async obtenerUrlEvidencia(path, bucket) {
      if (!isSafeStorageObjectPath(path)) return null;
      try {
        const client = await getClient();
        await syncSessionToken(client);
        const targetBucket =
          typeof bucket === 'string' && bucket.trim() ? bucket.trim() : EVIDENCIA_BUCKET_DEFAULT;
        const { data, error } = await client.storage
          .from(targetBucket)
          .createSignedUrl(path, 3600);
        if (error || !data?.signedUrl) return null;
        return data.signedUrl;
      } catch {
        return null;
      }
    },
    async setNota(id, nota) {
      await aplicarAccion(id, { notas_chofer: nota }, new Date().toISOString());
    },
    async add(entrega) {
      const canonicalSucursal = canonicalizeDbSucursal(entrega.sucursal);
      await run((c) =>
        c.from(TABLE).insert({
          ...entrega,
          ...(canonicalSucursal ? { sucursal: canonicalSucursal } : {}),
          id: newId(),
        })
      );
    },
    async importMany(entregas, modo) {
      await run(async (c) => {
        // Orden seguro: primero se inserta lo nuevo; solo si tiene éxito se eliminan los registros anteriores.
        const idsAnteriores: string[] = [];
        if (modo === 'reemplazar') {
          for (let desde = 0; ; desde += PAGE) {
            const { data, error } = await c.from(TABLE).select('id').order('id', { ascending: true }).range(desde, desde + PAGE - 1);
            if (error) return { error };
            idsAnteriores.push(...((data ?? []) as { id: string }[]).map((r) => r.id));
            if (!data || data.length < PAGE) break;
          }
        }
        for (let i = 0; i < entregas.length; i += INSERT_CHUNK) {
          const ins = await c.from(TABLE).insert(
            entregas.slice(i, i + INSERT_CHUNK).map((e) => {
              const canonicalSucursal = canonicalizeDbSucursal(e.sucursal);
              return {
                ...e,
                ...(canonicalSucursal ? { sucursal: canonicalSucursal } : {}),
                id: newId(),
              };
            })
          );
          if (ins.error) return ins;
        }
        for (let i = 0; i < idsAnteriores.length; i += DELETE_CHUNK) {
          const del = await c.from(TABLE).delete().in('id', idsAnteriores.slice(i, i + DELETE_CHUNK));
          if (del.error) return del;
        }
        return { error: null };
      });
    },
  };
}
