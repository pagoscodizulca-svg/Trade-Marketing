import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MASTER_SYNC_CHUNK_SIZE,
  convertirTextoCsvAMatriz,
  dividirEnLotes,
  invalidarCacheMaestros,
  mapearClienteMaestroAStore,
  normalizarCodigoMaestro,
  normalizarRifFiscal,
  normalizarTelefonoMaestro,
  obtenerClientesMaestros,
  obtenerVendedoresMaestros,
  prepararMatrizMaestraParaSincronizacion,
  sincronizarArchivoMaestroTrade,
  sincronizarColeccionesMaestrasTrade,
} from '../src/services/masterDataSyncService';
import { assertPublicKeyIsNotSecret } from '../src/services/supabaseClient';
import type {
  Cliente,
  LoteSincronizacion,
  MasterDataDatabase,
  Vendedor,
  VendedorSincronizacionInput,
  ClienteSincronizacionInput,
} from '../src/types/masterData';

/**
 * Simulador transaccional en memoria que replica exactamente las reglas de:
 * - public.rpc_sincronizar_vendedores
 * - public.rpc_sincronizar_clientes
 * - public.lotes_sincronizacion
 * - Paginación PostgREST `.range(from, to)` con tope de 1,000 filas por página
 */
function crearClienteSupabaseMockEnMemoria() {
  const tablaVendedores = new Map<string, Vendedor>();
  const tablaClientes = new Map<string, Cliente>();
  const tablaLotes = new Map<string, LoteSincronizacion>();
  let llamadasRpcVendedores = 0;
  let llamadasRpcClientes = 0;
  let seqId = 1;

  const nextUuid = (prefix: string) =>
    `${prefix}-0000-4000-8000-${String(seqId++).padStart(12, '0')}`;

  const clientMock = {
    auth: {
      getUser: async () => ({
        data: { user: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } },
        error: null,
      }),
    },
    rpc: async (fnName: string, args: Record<string, unknown>) => {
      const nowIso = new Date().toISOString();

      if (fnName === 'rpc_sincronizar_vendedores') {
        llamadasRpcVendedores++;
        const registros = (args.p_registros as VendedorSincronizacionInput[]) ?? [];
        const desactivarAusentes = Boolean(args.p_desactivar_ausentes);
        assert.ok(
          registros.length <= MASTER_SYNC_CHUNK_SIZE,
          `El lote de vendedores excedió MASTER_SYNC_CHUNK_SIZE (${registros.length})`
        );

        const dedup = new Map<string, VendedorSincronizacionInput>();
        for (const r of registros) {
          const cod = normalizarCodigoMaestro(r.codigo_vendedor);
          const nom = String(r.nombre_completo ?? '').trim();
          if (cod && nom) {
            dedup.set(cod, { ...r, codigo_vendedor: cod, nombre_completo: nom });
          }
        }

        for (const [cod, item] of dedup.entries()) {
          const prev = tablaVendedores.get(cod);
          const row: Vendedor = {
            id: prev?.id ?? nextUuid('11111111'),
            codigo_vendedor: cod,
            nombre_completo: item.nombre_completo,
            documento_identidad: item.documento_identidad ?? prev?.documento_identidad ?? null,
            telefono: item.telefono ?? prev?.telefono ?? null,
            email: item.email ?? prev?.email ?? null,
            zona: item.zona ?? prev?.zona ?? null,
            supervisor: item.supervisor ?? prev?.supervisor ?? null,
            activo: true,
            metadata: { ...(prev?.metadata ?? {}), ...(item.metadata ?? {}) },
            ultima_sincronizacion: nowIso,
            created_at: prev?.created_at ?? nowIso,
            updated_at: nowIso,
          };
          tablaVendedores.set(cod, row);

          // Re-enlace automático sobre clientes existentes
          for (const cli of tablaClientes.values()) {
            if (cli.codigo_vendedor === cod && cli.vendedor_id !== row.id) {
              cli.vendedor_id = row.id;
            }
          }
        }

        let desactivados = 0;
        if (desactivarAusentes && dedup.size > 0) {
          for (const vend of tablaVendedores.values()) {
            if (vend.activo && !dedup.has(vend.codigo_vendedor)) {
              vend.activo = false;
              vend.updated_at = nowIso;
              desactivados++;
            }
          }
        }

        return {
          data: { procesados: dedup.size, sin_vendedor_asignado: 0, desactivados },
          error: null,
        };
      }

      if (fnName === 'rpc_sincronizar_clientes') {
        llamadasRpcClientes++;
        const registros = (args.p_registros as ClienteSincronizacionInput[]) ?? [];
        const codigosActivosTotales = (args.p_codigos_activos_totales as string[] | null) ?? null;
        assert.ok(
          registros.length <= MASTER_SYNC_CHUNK_SIZE,
          `El lote de clientes excedió MASTER_SYNC_CHUNK_SIZE (${registros.length})`
        );

        const dedup = new Map<string, ClienteSincronizacionInput>();
        for (const r of registros) {
          const cod = normalizarCodigoMaestro(r.codigo_cliente);
          const razon = String(r.razon_social ?? '').trim();
          if (cod && razon) {
            dedup.set(cod, { ...r, codigo_cliente: cod, razon_social: razon });
          }
        }

        let sinVendedor = 0;
        const faltantes = new Set<string>();

        for (const [cod, item] of dedup.entries()) {
          const prev = tablaClientes.get(cod);
          const codVend = item.codigo_vendedor
            ? normalizarCodigoMaestro(item.codigo_vendedor)
            : null;
          const vendRow = codVend ? tablaVendedores.get(codVend) ?? null : null;

          if (codVend && !vendRow) {
            sinVendedor++;
            faltantes.add(codVend);
          }

          const row: Cliente = {
            id: prev?.id ?? nextUuid('22222222'),
            codigo_cliente: cod,
            rif: item.rif ?? prev?.rif ?? null,
            razon_social: item.razon_social,
            nombre_comercial: item.nombre_comercial ?? prev?.nombre_comercial ?? null,
            canal: item.canal ?? prev?.canal ?? null,
            segmento: item.segmento ?? prev?.segmento ?? null,
            zona: item.zona ?? prev?.zona ?? null,
            ruta: item.ruta ?? prev?.ruta ?? null,
            direccion: item.direccion ?? prev?.direccion ?? null,
            ciudad: item.ciudad ?? prev?.ciudad ?? null,
            estado: item.estado ?? prev?.estado ?? null,
            telefono: item.telefono ?? prev?.telefono ?? null,
            latitud: item.latitud ?? prev?.latitud ?? null,
            longitud: item.longitud ?? prev?.longitud ?? null,
            vendedor_id: codVend !== null ? (vendRow?.id ?? null) : (prev?.vendedor_id ?? null),
            codigo_vendedor: codVend ?? prev?.codigo_vendedor ?? null,
            activo: true,
            metadata: { ...(prev?.metadata ?? {}), ...(item.metadata ?? {}) },
            ultima_sincronizacion: nowIso,
            created_at: prev?.created_at ?? nowIso,
            updated_at: nowIso,
          };
          tablaClientes.set(cod, row);
        }

        let desactivados = 0;
        if (codigosActivosTotales && codigosActivosTotales.length > 0) {
          const setTotales = new Set(codigosActivosTotales.map((c) => normalizarCodigoMaestro(c)));
          for (const cli of tablaClientes.values()) {
            if (cli.activo && !setTotales.has(cli.codigo_cliente)) {
              cli.activo = false;
              cli.updated_at = nowIso;
              desactivados++;
            }
          }
        }

        return {
          data: {
            procesados: dedup.size,
            sin_vendedor_asignado: sinVendedor,
            desactivados,
            codigos_vendedor_faltantes: Array.from(faltantes),
          },
          error: null,
        };
      }

      throw new Error(`RPC desconocida: ${fnName}`);
    },
    from: (table: string) => {
      if (table === 'lotes_sincronizacion') {
        return {
          insert: (payload: Partial<LoteSincronizacion>) => ({
            select: () => ({
              single: async () => {
                const id = nextUuid('33333333');
                const lote: LoteSincronizacion = {
                  id,
                  ejecutado_por: payload.ejecutado_por ?? null,
                  entidad: payload.entidad ?? 'sincronizacion_completa',
                  nombre_archivo: payload.nombre_archivo ?? null,
                  registros_recibidos: payload.registros_recibidos ?? 0,
                  registros_procesados: payload.registros_procesados ?? 0,
                  registros_desactivados: payload.registros_desactivados ?? 0,
                  errores_detalle: payload.errores_detalle ?? [],
                  estado: payload.estado ?? 'en_proceso',
                  created_at: new Date().toISOString(),
                };
                tablaLotes.set(id, lote);
                return { data: { id }, error: null };
              },
            }),
          }),
          update: (changes: Partial<LoteSincronizacion>) => ({
            eq: async (_col: string, id: string) => {
              const actual = tablaLotes.get(id);
              if (actual) {
                tablaLotes.set(id, { ...actual, ...changes });
              }
              return { data: null, error: null };
            },
          }),
        };
      }

      if (table === 'vendedores' || table === 'clientes') {
        const filtrosEq: Array<[string, unknown]> = [];
        let rangoInicio = 0;
        let rangoFin = 999;

        const builder = {
          select: () => builder,
          order: () => builder,
          ilike: (col: string, val: string) => {
            filtrosEq.push([`ilike:${col}`, val.toLowerCase()]);
            return builder;
          },
          or: () => builder,
          eq: (col: string, val: unknown) => {
            filtrosEq.push([col, val]);
            return builder;
          },
          range: (from: number, to: number) => {
            rangoInicio = from;
            rangoFin = Math.min(to, from + 999); // Emula tope PostgREST max-rows=1000
            return builder;
          },
          then: (
            resolve: (res: { data: unknown[]; error: null }) => void,
            reject?: (err: unknown) => void
          ) => {
            try {
              const fuente =
                table === 'vendedores'
                  ? Array.from(tablaVendedores.values())
                  : Array.from(tablaClientes.values()).map((c) => ({
                      ...c,
                      vendedor: c.codigo_vendedor
                        ? tablaVendedores.get(c.codigo_vendedor) ?? null
                        : null,
                    }));

              const filtrada = fuente.filter((item) => {
                const rec = item as Record<string, unknown>;
                return filtrosEq.every(([k, v]) => {
                  if (k.startsWith('ilike:')) {
                    const col = k.slice(6);
                    return String(rec[col] ?? '').toLowerCase() === String(v);
                  }
                  return rec[k] === v;
                });
              });

              const pagina = filtrada.slice(rangoInicio, rangoFin + 1);
              resolve({ data: pagina, error: null });
            } catch (e) {
              reject?.(e);
            }
          },
        };
        return builder;
      }

      throw new Error(`Tabla no soportada en mock: ${table}`);
    },
  };

  return {
    client: clientMock as unknown as SupabaseClient<MasterDataDatabase>,
    tablaVendedores,
    tablaClientes,
    tablaLotes,
    obtenerMetricasRpc: () => ({ llamadasRpcVendedores, llamadasRpcClientes }),
  };
}

async function main() {
  console.log('🔍 Iniciando suite de verificación Master Data (Vendedores y Clientes)...');

  // ---------------------------------------------------------------------------
  // TEST 1: Candado de Ciberseguridad Anti-Secretos en Frontend
  // ---------------------------------------------------------------------------
  assert.throws(
    () => assertPublicKeyIsNotSecret('sb_secret_ficticia_no_real_12345', 'VITE_SUPABASE_ANON_KEY'),
    /SEGURIDAD CRÍTICA/
  );
  const fakeServiceRoleJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
    JSON.stringify({ role: 'service_role' })
  ).toString('base64url')}.firma`;
  assert.throws(
    () => assertPublicKeyIsNotSecret(fakeServiceRoleJwt, 'VITE_SUPABASE_ANON_KEY'),
    /service_role/
  );
  assert.doesNotThrow(() =>
    assertPublicKeyIsNotSecret('sb_publishable_clave_ficticia_segura', 'VITE_SUPABASE_ANON_KEY')
  );
  console.log('  ✅ [1/4] Candado anti-llaves secretas (sb_secret_* / service_role) verificado.');

  // ---------------------------------------------------------------------------
  // TEST 2: Normalización de RIF, Teléfonos, Comillas Triples y Errores por Fila
  // ---------------------------------------------------------------------------
  assert.equal(normalizarRifFiscal('  v- 11722409   '), 'V-11722409');
  assert.equal(normalizarRifFiscal('j301234567'), 'J-301234567');
  assert.equal(normalizarRifFiscal('#N/D'), null);
  assert.equal(normalizarTelefonoMaestro('+58 (414) 600-11-22'), '+584146001122');

  const csvConErrores = [
    ';;REPORTE PRUEBA;;;',
    'SUPERVISOR;ID VENDEDOR;Vendedor;Id;Razón Social;RIF',
    'SUP NORTE; v01 ;OSCAR ORTIZ; c100 ;"""COMERCIAL YULY-RICH, C.A.""";J- 401112223 ',
    'SUP NORTE;V01;OSCAR ORTIZ;;CLIENTE SIN CODIGO;J-401112224',
    'SUP NORTE;V01;OSCAR ORTIZ;C102;;J-401112225',
    ';;;;;#N/D',
  ].join('\n');

  const prepErrores = prepararMatrizMaestraParaSincronizacion(
    convertirTextoCsvAMatriz(csvConErrores)
  );
  assert.equal(prepErrores.vendedoresValidos.length, 1);
  assert.equal(prepErrores.clientesValidos.length, 1);
  assert.equal(prepErrores.clientesValidos[0]?.codigo_cliente, 'C100');
  assert.equal(prepErrores.clientesValidos[0]?.razon_social, 'COMERCIAL YULY-RICH, C.A.');
  assert.equal(prepErrores.clientesValidos[0]?.rif, 'J-401112223');
  assert.equal(prepErrores.filasOmitidasVacias, 1);
  assert.equal(prepErrores.erroresDetalle.length, 2);
  assert.equal(prepErrores.erroresDetalle[0]?.fila, 4);
  assert.equal(prepErrores.erroresDetalle[1]?.fila, 5);
  console.log('  ✅ [2/4] Limpieza Zod, comillas escapadas, RIF #N/D y reporte de filas inválidas verificado.');

  // ---------------------------------------------------------------------------
  // TEST 3: Prueba Oficial TAREA 4 — 5 Vendedores y 15 Clientes (2 Corridas Idempotentes + Reconciliación)
  // ---------------------------------------------------------------------------
  const mockEnv = crearClienteSupabaseMockEnMemoria();

  const cincoVendedores = [
    { codigo_vendedor: ' v-001 ', nombre_completo: 'OSCAR ORTIZ', zona: 'LA COSTA', supervisor: 'SUP NORTE' },
    { codigo_vendedor: 'V-002', nombre_completo: 'LUIS GUANIPA', zona: 'MARACAIBO SUR', supervisor: 'SUP SUR' },
    { codigo_vendedor: 'V-003', nombre_completo: 'MARIA FERNANDEZ', zona: 'SAN FRANCISCO', supervisor: 'SUP SUR' },
    { codigo_vendedor: 'V-004', nombre_completo: 'CARLOS URDANETA', zona: 'COL', supervisor: 'SUP ORIENTAL' },
    { codigo_vendedor: 'V-005', nombre_completo: 'ANA VILLALOBOS', zona: 'MARACAIBO NORTE', supervisor: 'SUP NORTE' },
  ];

  const quinceClientes = Array.from({ length: 15 }, (_, idx) => {
    const num = idx + 1;
    const codVendedor = num === 15 ? 'V-999' : `V-00${((idx % 5) + 1)}`;
    return {
      codigo_cliente: idx === 0 ? ` c-${100 + num} ` : `C-${100 + num}`,
      rif: num === 5 ? '#N/D' : `J-3010010${String(num).padStart(2, '0')}`,
      razon_social: `CLIENTE COMERCIAL DEMO ${num} (BODEGON DEMO ${num})`,
      canal: num % 2 === 0 ? 'Supermercado' : 'Mayorista',
      zona: idx < 5 ? 'LA COSTA' : 'MARACAIBO SUR',
      ruta: `R0${(idx % 3) + 1}`,
      codigo_vendedor: codVendedor,
    };
  });

  // Primera corrida
  const corrida1 = await sincronizarColeccionesMaestrasTrade(
    { vendedores: cincoVendedores, clientes: quinceClientes },
    { nombreArchivo: 'prueba_5v_15c_corrida1.json', supabaseClient: mockEnv.client }
  );

  assert.equal(corrida1.vendedores.procesados, 5);
  assert.equal(corrida1.clientes.procesados, 15);
  assert.equal(corrida1.clientes.sinVendedorAsignado, 1);
  assert.deepEqual(corrida1.clientes.codigosVendedorFaltantes, ['V-999']);
  assert.equal(corrida1.estado, 'con_observaciones');

  // Segunda corrida consecutiva (Idempotencia estricta + actualización de razón social en C-101)
  const clientesCorrida2 = quinceClientes.map((c, i) =>
    i === 0 ? { ...c, razon_social: 'CLIENTE COMERCIAL DEMO 1 ACTUALIZADO C.A.' } : c
  );

  const corrida2 = await sincronizarColeccionesMaestrasTrade(
    { vendedores: cincoVendedores, clientes: clientesCorrida2 },
    { nombreArchivo: 'prueba_5v_15c_corrida2.json', supabaseClient: mockEnv.client }
  );

  assert.equal(corrida2.vendedores.procesados, 5);
  assert.equal(corrida2.clientes.procesados, 15);
  assert.equal(mockEnv.tablaVendedores.size, 5, 'No deben crearse vendedores duplicados en la 2da corrida');
  assert.equal(mockEnv.tablaClientes.size, 15, 'No deben crearse clientes duplicados en la 2da corrida');
  assert.equal(
    mockEnv.tablaClientes.get('C-101')?.razon_social,
    'CLIENTE COMERCIAL DEMO 1 ACTUALIZADO C.A.'
  );

  // Tercera corrida: Reconciliación lógica retirando los últimos 2 clientes sin borrarlos físicamente
  const corridaReconciliacion = await sincronizarColeccionesMaestrasTrade(
    { vendedores: cincoVendedores, clientes: clientesCorrida2.slice(0, 13) },
    {
      nombreArchivo: 'prueba_reconciliacion.json',
      reconciliarCarteraClientes: true,
      supabaseClient: mockEnv.client,
    }
  );

  assert.equal(corridaReconciliacion.clientes.desactivados, 2);
  assert.equal(mockEnv.tablaClientes.size, 15, 'Prohibido borrar filas físicamente');

  invalidarCacheMaestros();
  const activosConsultados = await obtenerClientesMaestros({ soloActivos: true }, mockEnv.client);
  const vendedoresConsultados = await obtenerVendedoresMaestros({ soloActivos: true }, mockEnv.client);
  assert.equal(activosConsultados.length, 13);
  assert.equal(vendedoresConsultados.length, 5);
  assert.equal(mapearClienteMaestroAStore(activosConsultados[0]!).clientCode.startsWith('C-'), true);
  console.log('  ✅ [3/4] Idempotencia doble (5 vendedores + 15 clientes) y desactivación lógica verificada.');

  // ---------------------------------------------------------------------------
  // TEST 4: Escala Real Plan Gratuito (>2,700 clientes -> lotes de 400 + paginación >1,000)
  // ---------------------------------------------------------------------------
  const rutaCsvAdjunto =
    'C:/Users/JAVIER CASTELLANOS/.gemini/antigravity/brain/8ebf5091-4ec0-40b7-a374-7c5387d48d87/.user_uploaded/media_1794592739207_0cc44fd9.csv';

  let csvEscala: string;
  if (fs.existsSync(rutaCsvAdjunto)) {
    csvEscala = fs.readFileSync(rutaCsvAdjunto, 'utf8');
  } else {
    // Fallback sintético determinista de 2,717 filas con la misma estructura exacta
    const filasSinteticas = [
      ';;MAESTRA CLIENTES ACTIVOS NOVIEMBRE 2026;;;',
      'SUPERVISOR;ID VENDEDOR;Vendedor;Id;Razón Social;RIF',
    ];
    for (let i = 1; i <= 2716; i++) {
      const vId = String((i % 30) + 1);
      filasSinteticas.push(
        `SUPERVISOR ZULIA;${vId};VENDEDOR RUTA ${vId};${5000 + i};COMERCIAL CLIENTE ${i} C.A.;${i <= 116 ? '#N/D' : `J-${300000000 + i}`}`
      );
    }
    // Duplicado intra-archivo deliberado (como Id=8377) + 67 filas vacías #N/D
    filasSinteticas.push('SUPERVISOR ZULIA;40;LUIS GUANIPA;5001;COMERCIAL CLIENTE 1 ACTUALIZADO C.A.;J-300000001');
    for (let k = 0; k < 67; k++) {
      filasSinteticas.push(';;;;;#N/D');
    }
    csvEscala = filasSinteticas.join('\n');
  }

  const mockMasivo = crearClienteSupabaseMockEnMemoria();
  const resMasivo = await sincronizarArchivoMaestroTrade(csvEscala, {
    nombreArchivo: 'MAESTRA_ACTIVA_ultima_version.csv',
    reconciliarCarteraClientes: true,
    supabaseClient: mockMasivo.client,
  });

  assert.equal(resMasivo.vendedores.recibidosUnicos, 30);
  assert.equal(resMasivo.vendedores.lotesRpcEnviados, 1);
  assert.equal(resMasivo.clientes.recibidosUnicos, 2716);
  assert.equal(
    resMasivo.clientes.lotesRpcEnviados,
    Math.ceil(2716 / MASTER_SYNC_CHUNK_SIZE),
    '2,716 clientes deben enviarse en exactamente 7 lotes de máximo 400 registros'
  );
  assert.equal(dividirEnLotes(Array.from({ length: 2716 }), MASTER_SYNC_CHUNK_SIZE).length, 7);

  const todosActivosPaginados = await obtenerClientesMaestros(
    { soloActivos: true, forzarRefresco: true },
    mockMasivo.client
  );
  assert.equal(
    todosActivosPaginados.length,
    2716,
    'La lectura paginada debe superar el límite de 1,000 filas de PostgREST y traer los 2,716 clientes'
  );

  console.log(
    `  ✅ [4/4] Escala Free Tier verificada: ${resMasivo.vendedores.procesados} vendedores (1 lote) + ${resMasivo.clientes.procesados} clientes (${resMasivo.clientes.lotesRpcEnviados} lotes de ${MASTER_SYNC_CHUNK_SIZE}) y lectura paginada completa (${todosActivosPaginados.length} filas).`
  );
  console.log('🎉 Todas las pruebas de Master Data finalizaron con 0 errores.');
}

main().catch((err) => {
  console.error('❌ Fallo en verifyMasterDataSync:', err);
  process.exit(1);
});
