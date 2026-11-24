import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type ReactType from 'react';
import type ReactDomServerType from 'react-dom/server';

const rutaRequire = createRequire(new URL('../ruta-degustacion/package.json', import.meta.url));
const React = rutaRequire('react') as typeof ReactType;
const { renderToStaticMarkup } = rutaRequire('react-dom/server') as typeof ReactDomServerType;
import type { ClientGeoRecord, EntregaVista } from '../ruta-degustacion/src/types';
import {
  buildClientGeoIndex,
  isValidVenezuelaCoord,
  resolveEntregaCoordinates,
} from '../ruta-degustacion/src/lib/clientGeoMatcher';
import {
  computeOptimalRoute,
  evaluateOffOrderCompletion,
  GOOGLE_MAPS_MAX_WAYPOINTS,
  haversineKm,
  sanitizeGoogleMapsUrl,
} from '../ruta-degustacion/src/lib/routeOptimizer';
import { OfflineRouteMap } from '../ruta-degustacion/src/components/chofer/OfflineRouteMap';
import { RouteOptimizerPanel } from '../ruta-degustacion/src/components/chofer/RouteOptimizerPanel';

function makeEntrega(overrides: Partial<EntregaVista> & { id: string; cliente: string }): EntregaVista {
  return {
    fecha: 'VIERNES 27',
    turno: 'MAÑANA',
    numero_grupo_turno: 'MAÑANA 1',
    producto: 'AHUMADO',
    vendedor: 'Vendedor Prueba',
    promotora: 'Promotora Prueba',
    stand_entregado: false,
    producto_entregado: false,
    completado: false,
    hora_entrega: null,
    notas_chofer: '',
    sucursal: 'CENTRO',
    ...overrides,
  };
}

test('clientGeoMatcher: valida coordenadas de Venezuela y descarta (0,0) o fuera de rango', () => {
  assert.equal(isValidVenezuelaCoord(10.2238, -67.9635), true);
  assert.equal(isValidVenezuelaCoord(10.6545, -71.6373), true);
  assert.equal(isValidVenezuelaCoord(0, 0), false);
  assert.equal(isValidVenezuelaCoord(null, -68), false);
  assert.equal(isValidVenezuelaCoord(40.7128, -74.006), false); // New York fuera de Venezuela
});

test('clientGeoMatcher: resuelve clientes ERP reales, atlas offline por zona y pin manual sin errores', () => {
  const catalog: ClientGeoRecord[] = [
    {
      id_clie: 'c1',
      clie_nomb: 'ALIMENTOS EL VIÑEDO 2023, C.A',
      clie_rif: 'J503581034',
      clie_lati: 10.2633602,
      clie_long: -68.0043826,
      sucursal: 'CENTRO',
    },
    {
      id_clie: 'c2',
      clie_nomb: 'CORPOSERVICIOS OCCIDENTE, C.A',
      clie_rif: '001811',
      clie_lati: 10.6940705,
      clie_long: -71.6300868,
      sucursal: 'OCCIDENTE',
    },
    {
      id_clie: 'c3',
      clie_nomb: 'CLIENTE SIN COORDENADA',
      clie_rif: 'J000000001',
      clie_lati: 0,
      clie_long: 0,
      sucursal: 'CENTRO',
    },
  ];
  const index = buildClientGeoIndex(catalog);

  // 1) Coincidencia exacta por nombre normalizado contra public."Clientes"
  const erpMatch = resolveEntregaCoordinates(
    makeEntrega({ id: 'e1', cliente: 'ALIMENTOS EL VINEDO 2023' }),
    index,
  );
  assert.equal(erpMatch.geo_source, 'clientes_erp');
  assert.equal(erpMatch.geo_precision, 'exacta');
  assert.ok(Math.abs((erpMatch.lat ?? 0) - 10.2633602) < 1e-5);

  // 2) Coincidencia por código/RIF en Occidente
  const codeMatch = resolveEntregaCoordinates(
    makeEntrega({ id: 'e2', cliente: 'NOMBRE DISTINTO', cliente_codigo: '001811', sucursal: 'ZULIA' }),
    index,
  );
  assert.equal(codeMatch.geo_source, 'clientes_erp');
  assert.ok(Math.abs((codeMatch.lat ?? 0) - 10.6940705) < 1e-5);

  // 3) Atlas offline distingue diferentes MAKRO por zona_direccion sin requerir internet
  const makroSanDiego = resolveEntregaCoordinates(
    makeEntrega({ id: 'e3', cliente: 'MAKRO', zona_direccion: 'SAN DIEGO' }),
    index,
  );
  const makroTurmero = resolveEntregaCoordinates(
    makeEntrega({ id: 'e4', cliente: 'MAKRO', zona_direccion: 'TURMERO MARACAY' }),
    index,
  );
  assert.equal(makroSanDiego.geo_source, 'zona_atlas');
  assert.equal(makroTurmero.geo_source, 'zona_atlas');
  assert.ok(haversineKm(
    { lat: makroSanDiego.lat!, lng: makroSanDiego.lng! },
    { lat: makroTurmero.lat!, lng: makroTurmero.lng! },
  ) > 35, 'Makro San Diego y Makro Turmero deben resolverse en ubicaciones distintas (>35 km)');

  // 4) Pin manual del chofer tiene prioridad absoluta
  const pinned = resolveEntregaCoordinates(
    makeEntrega({ id: 'e3', cliente: 'MAKRO', zona_direccion: 'SAN DIEGO' }),
    index,
    { e3: { lat: 10.2301, lng: -67.9602 } },
  );
  assert.equal(pinned.geo_source, 'manual_gps');
  assert.equal(pinned.lat, 10.2301);

  // 5) Cliente sin GPS y sin zona conocida nunca falla
  const unknown = resolveEntregaCoordinates(
    makeEntrega({ id: 'e5', cliente: 'TIENDA NUEVA DESCONOCIDA', zona_direccion: '' }),
    index,
  );
  assert.equal(unknown.geo_source, 'none');
  assert.equal(unknown.lat, null);
});

test('routeOptimizer: fija el punto elegido por el chofer como #1 y reduce km frente a orden en zig-zag', () => {
  // Ruta intencionalmente en zig-zag (Oeste -> Este -> Oeste -> Este)
  const paradas: EntregaVista[] = [
    makeEntrega({ id: 'nag', cliente: 'MAKRO', zona_direccion: 'MANANTIAL', lat: 10.2512, lng: -68.0079 }), // Oeste (Naguanagua)
    makeEntrega({ id: 'tur', cliente: 'MAKRO', zona_direccion: 'TURMERO MARACAY', lat: 10.2248, lng: -67.4981 }), // Lejano Este (Turmero)
    makeEntrega({ id: 'sd', cliente: 'MAKRO', zona_direccion: 'SAN DIEGO', lat: 10.2238, lng: -67.9635 }), // Oeste-Centro (San Diego)
    makeEntrega({ id: 'sam', cliente: 'MAKRO', zona_direccion: 'EL SAMAN MARACAY', lat: 10.2219, lng: -67.5718 }), // Este (Maracay)
  ];

  // El chofer decide iniciar en MANANTIAL (Naguanagua)
  const plan = computeOptimalRoute({
    deliveries: paradas,
    originMode: 'stop',
    startDeliveryId: 'nag',
    driverGps: null,
  });

  const ids = plan.orderedPending.map((s) => s.entrega.id);
  // Orden óptimo real de Oeste a Este: Manantial -> San Diego -> El Samán Maracay -> Turmero Maracay
  assert.deepEqual(ids, ['nag', 'sd', 'sam', 'tur']);
  assert.equal(plan.orderedPending[0].isPinnedStart, true);
  assert.ok(plan.savedDistanceKm > 40, `Debe ahorrar >40 km frente al zig-zag (ahorro=${plan.savedDistanceKm})`);
  assert.ok(plan.googleMapsPrimaryUrl?.startsWith('https://www.google.com/maps/dir/?api=1'));
  assert.ok(plan.googleMapsPrimaryUrl?.includes('travelmode=driving'));
  assert.ok(plan.googleMapsPrimaryUrl?.includes('waypoints='));
});

test('routeOptimizer: recálculo dinámico inmediato cuando el chofer entrega A -> C en lugar de A -> B', () => {
  // Supongamos 4 paradas en corredor Valencia -> Maracay -> Turmero -> La Victoria:
  // Plan inicial desde Valencia GPS: A (Naguanagua) -> B (San Diego) -> C (El Samán Maracay) -> D (Turmero)
  const paradas: EntregaVista[] = [
    makeEntrega({ id: 'A', cliente: 'PDV A', zona_direccion: 'MANANTIAL', lat: 10.2512, lng: -68.0079 }),
    makeEntrega({ id: 'B', cliente: 'PDV B', zona_direccion: 'SAN DIEGO', lat: 10.2238, lng: -67.9635 }),
    makeEntrega({ id: 'C', cliente: 'PDV C', zona_direccion: 'EL SAMAN MARACAY', lat: 10.2219, lng: -67.5718 }),
    makeEntrega({ id: 'D', cliente: 'PDV D', zona_direccion: 'TURMERO', lat: 10.2248, lng: -67.4981 }),
  ];

  const planInicial = computeOptimalRoute({
    deliveries: paradas,
    originMode: 'stop',
    startDeliveryId: 'A',
    driverGps: null,
  });
  const plannedIds = planInicial.orderedPending.map((s) => s.entrega.id);
  assert.deepEqual(plannedIds, ['A', 'B', 'C', 'D']);

  // El chofer ya entregó A, le correspondía B, pero decide ir directo a C y entregar C (A -> C)
  const pendientesTrasA = paradas.filter((p) => p.id !== 'A');
  const planEsperadoTrasA = ['B', 'C', 'D'];

  // Caso 1: Con GPS activo cerca de C (El Samán Maracay)
  const gpsEnC = { lat: 10.222, lng: -67.5715 };
  const deviationWithGps = evaluateOffOrderCompletion({
    plannedPendingIds: planEsperadoTrasA,
    deliveriesBefore: pendientesTrasA,
    deliveredId: 'C',
    driverGps: gpsEnC,
  });

  assert.equal(deviationWithGps.deviated, true);
  assert.ok(deviationWithGps.message?.includes('PDV C'));
  assert.equal(deviationWithGps.recalculatedAnchor?.kind, 'gps');

  // Recalcular restantes [B, D] desde su ubicación actual (cerca de C):
  // D (Turmero, ~8 km) es MUCHO más cercano que B (San Diego, ~43 km) -> debe ir primero a D y luego a B!
  const restantesTrasC = pendientesTrasA.filter((p) => p.id !== 'C');
  const planRecalculado = computeOptimalRoute({
    deliveries: restantesTrasC,
    originMode: 'gps',
    startDeliveryId: null,
    driverGps: gpsEnC,
    lastCompletedAnchor: deviationWithGps.recalculatedAnchor,
  });
  assert.deepEqual(
    planRecalculado.orderedPending.map((s) => s.entrega.id),
    ['D', 'B'],
    'Tras desviarse a C, el recálculo debe enviar primero a D (más cercano) y luego a B',
  );

  // Caso 2: Sin GPS del teléfono (offline / interiores) -> usa coordenadas exactas de C como ancla
  const deviationSinGps = evaluateOffOrderCompletion({
    plannedPendingIds: planEsperadoTrasA,
    deliveriesBefore: pendientesTrasA,
    deliveredId: 'C',
    driverGps: null,
  });
  assert.equal(deviationSinGps.deviated, true);
  assert.equal(deviationSinGps.recalculatedAnchor?.kind, 'completed_stop');
  const planRecalculadoSinGps = computeOptimalRoute({
    deliveries: restantesTrasC,
    originMode: 'gps',
    startDeliveryId: null,
    driverGps: null,
    lastCompletedAnchor: deviationSinGps.recalculatedAnchor,
  });
  assert.deepEqual(
    planRecalculadoSinGps.orderedPending.map((s) => s.entrega.id),
    ['D', 'B'],
  );
});

test('routeOptimizer: segmenta correctamente > 9 waypoints en Google Maps y sanitiza URLs', () => {
  const muchasParadas: EntregaVista[] = Array.from({ length: 13 }, (_, idx) =>
    makeEntrega({
      id: `p-${idx + 1}`,
      cliente: `CLIENTE ${idx + 1}`,
      lat: 10.2 + idx * 0.01,
      lng: -68.0 + idx * 0.01,
    }),
  );

  const plan = computeOptimalRoute({
    deliveries: muchasParadas,
    originMode: 'gps',
    startDeliveryId: null,
    driverGps: { lat: 10.18, lng: -68.02 },
  });

  assert.equal(plan.googleMapsSegments.length, 2, '13 paradas con GPS origen deben dividirse en 2 tramos');
  for (const seg of plan.googleMapsSegments) {
    const parsed = new URL(seg.url);
    const waypoints = parsed.searchParams.get('waypoints')?.split('|').filter(Boolean) ?? [];
    assert.ok(waypoints.length <= GOOGLE_MAPS_MAX_WAYPOINTS);
    assert.equal(parsed.hostname, 'www.google.com');
  }

  // Defensa XSS en URLs externas
  assert.equal(sanitizeGoogleMapsUrl('javascript:alert(1)'), 'https://www.google.com/maps/');
  assert.equal(sanitizeGoogleMapsUrl('https://evil.example/maps/dir/'), 'https://www.google.com/maps/');
});

test('routeOptimizer: GPS remoto (>120 km) no distorsiona km ni mapa al elegir parada inicial, y deduplica PDVs co-ubicados en Google Maps', () => {
  const paradasCentro: EntregaVista[] = [
    makeEntrega({ id: 'm1', cliente: 'MAKRO', zona_direccion: 'MANANTIAL', lat: 10.2512, lng: -68.0079 }),
    makeEntrega({ id: 'm2', cliente: 'MAKRO', zona_direccion: 'MANANTIAL', lat: 10.2512, lng: -68.0079 }),
    makeEntrega({ id: 'sd1', cliente: 'MAKRO', zona_direccion: 'SAN DIEGO', lat: 10.2238, lng: -67.9635 }),
    makeEntrega({ id: 'sam1', cliente: 'MAKRO', zona_direccion: 'EL SAMAN MARACAY', lat: 10.2219, lng: -67.5718 }),
    makeEntrega({ id: 'tur1', cliente: 'MAKRO', zona_direccion: 'TURMERO MARACAY', lat: 10.2286, lng: -67.4742 }),
  ];

  // GPS del dispositivo en Maracaibo (>500 km de Carabobo/Aragua)
  const gpsMaracaibo = { lat: 10.586843, lng: -71.684677 };
  const plan = computeOptimalRoute({
    deliveries: paradasCentro,
    originMode: 'stop',
    startDeliveryId: 'm1',
    driverGps: gpsMaracaibo,
  });

  assert.equal(plan.anchor.kind, 'stop');
  assert.ok(plan.totalDistanceKm < 100, `Distancia real de ruta Centro debe ser <100 km (fue ${plan.totalDistanceKm} km)`);
  const parsedUrl = new URL(plan.googleMapsPrimaryUrl!);
  assert.equal(parsedUrl.searchParams.get('origin'), '10.251200,-68.007900');
  const wps = parsedUrl.searchParams.get('waypoints')?.split('|') ?? [];
  assert.deepEqual(wps, ['10.223800,-67.963500', '10.221900,-67.571800'], 'No debe repetir Manantial duplicado en waypoints');

  // Desvío A -> C con GPS remoto debe anclarse en las coordenadas reales de C (El Samán)
  const dev = evaluateOffOrderCompletion({
    plannedPendingIds: ['m1', 'm2', 'sd1', 'sam1', 'tur1'],
    deliveriesBefore: paradasCentro,
    deliveredId: 'sam1',
    driverGps: gpsMaracaibo,
  });
  assert.equal(dev.deviated, true);
  assert.equal(dev.recalculatedAnchor?.kind, 'completed_stop');
  assert.equal(dev.recalculatedAnchor?.lat, 10.2219);
});

test('UI OfflineRouteMap & RouteOptimizerPanel: renderizan sin errores en SSR con clientes reales y sin GPS', () => {
  const paradas: EntregaVista[] = [
    makeEntrega({
      id: 'm1',
      cliente: 'MAKRO',
      zona_direccion: 'SAN DIEGO',
      lat: 10.2238,
      lng: -67.9635,
      geo_source: 'zona_atlas',
      geo_precision: 'zona',
    }),
    makeEntrega({
      id: 'm2',
      cliente: 'MAKRO',
      zona_direccion: 'TURMERO MARACAY',
      lat: 10.2248,
      lng: -67.4981,
      geo_source: 'zona_atlas',
      geo_precision: 'zona',
    }),
    makeEntrega({
      id: 'm3',
      cliente: 'CLIENTE SIN COORD',
      zona_direccion: '',
      lat: null,
      lng: null,
      geo_source: 'none',
      geo_precision: 'sin_gps',
    }),
  ];

  const plan = computeOptimalRoute({
    deliveries: paradas,
    originMode: 'stop',
    startDeliveryId: 'm1',
    driverGps: { lat: 10.19, lng: -67.99 },
  });

  const mapHtml = renderToStaticMarkup(
    React.createElement(OfflineRouteMap, {
      plan,
      driverGps: { lat: 10.19, lng: -67.99 },
      onSelectStartStop: () => {},
    }),
  );
  assert.ok(mapHtml.includes('Mapa Offline Activo'));
  assert.ok(mapHtml.includes('mapa-pin-m1'));
  assert.ok(mapHtml.includes('mapa-pin-gps'));

  const panelHtml = renderToStaticMarkup(
    React.createElement(RouteOptimizerPanel, {
      plan,
      pendingForSelect: paradas,
      originMode: 'stop',
      startDeliveryId: 'm1',
      ordenOptimoActivo: true,
      driverGps: { lat: 10.19, lng: -67.99 },
      gpsStatus: 'watching',
      gpsError: null,
      recalcNotice: 'Ruta recalculada automáticamente.',
      onSelectOriginModeGps: () => {},
      onSelectStartStop: () => {},
      onToggleOrdenOptimo: () => {},
      onRequestGpsRecalculate: () => {},
      onDismissRecalcNotice: () => {},
    }),
  );
  assert.ok(panelHtml.includes('ruta-inicio-select'));
  assert.ok(panelHtml.includes('btn-abrir-google-maps-ruta'));
  assert.ok(panelHtml.includes('Ruta recalculada automáticamente.'));
  assert.ok(panelHtml.includes('Funciona Offline'));
});
