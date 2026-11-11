import dotenv from 'dotenv';
import {
  buildDegustacionCanonicalSeed,
  computeDegustacionIdempotencyHash,
} from '../src/utils/degustacionIdempotency';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const rawUrl = (process.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_REST_URL = rawUrl.endsWith('/rest/v1') ? rawUrl : `${rawUrl}/rest/v1`;
const SUPABASE_ANON_KEY = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();

function assert(cond: boolean, label: string): void {
  if (!cond) {
    throw new Error(`[FALLO VERIFICACIÓN FASE 1] ${label}`);
  }
  console.log(`  [OK] ${label}`);
}

function coordHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'x-codizulca-scope': 'trade_coordinator',
    ...extra,
  };
}

function promotoraHeaders(promotoraId: string): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'x-promotora-id': promotoraId,
  };
}

async function runVerification(): Promise<void> {
  console.log('=========================================================================');
  console.log(' CODIZULCA C.A. - VERIFICACIÓN FASE 1 (ESQUEMA, TRIGGERS, IDEMPOTENCIA Y RLS)');
  console.log('=========================================================================');

  // 1. Pruebas deterministas locales del motor de idempotencia
  console.log('\n[1/3] Validando normalización determinista de idempotency_hash...');
  const h1 = await computeDegustacionIdempotencyHash({
    fecha: '2026-11-20',
    clienteNombre: 'FAMILIA CENTER, C.A.',
    horaInicio: '9:00 am',
    productoResumen: 'Mortadela, Espalda',
  });
  const h2 = await computeDegustacionIdempotencyHash({
    fecha: '2026-11-20',
    clienteNombre: 'familia center c.a',
    horaInicio: '09:00',
    productoResumen: 'ESPALDA + MORTADELA',
  });
  assert(
    h1 === h2 && h1.length === 64,
    `Idempotencia determinista verificada (${buildDegustacionCanonicalSeed({
      fecha: '2026-11-20',
      clienteNombre: 'FAMILIA CENTER, C.A.',
      horaInicio: '9:00 am',
      productoResumen: 'Mortadela, Espalda',
    })})`
  );

  if (!SUPABASE_REST_URL || !SUPABASE_ANON_KEY) {
    console.log('\n[AVISO] Sin credenciales en .env.local; omitiendo verificación remota.');
    return;
  }

  // 2. Comprobar si la migración SQL de Fase 1 ya fue ejecutada en Supabase
  console.log('\n[2/3] Comprobando tablas de Fase 1 en Supabase...');
  const checkTable = await fetch(`${SUPABASE_REST_URL}/cronograma_degustaciones?limit=1`, {
    headers: coordHeaders(),
  });

  if (checkTable.status === 404) {
    console.log(
      '\n⚠️  PENDIENTE APLICAR MIGRACIÓN EN SUPABASE:\n' +
        '   Ejecuta el archivo `supabase/migrations/20261111_fase1_flujo_degustaciones_rutas.sql`\n' +
        '   en el SQL Editor de tu proyecto Supabase (`uterioexpfweghxfbvoa`) y vuelve a correr:\n' +
        '   `npm run verify:fase1` para ejecutar la batería transaccional E2E.'
    );
    return;
  }

  assert(checkTable.ok, `Tabla public.cronograma_degustaciones activa (HTTP ${checkTable.status})`);

  // 3. Prueba transaccional completa en vivo con 2 promotoras activas reales y limpieza total al final
  console.log('\n[3/3] Ejecutando pruebas de Máquina de Estados, Candado sin Promotora, Reasignación y RLS...');
  const staffRes = await fetch(
    `${SUPABASE_REST_URL}/staff?select=id,name,role,status&limit=20`,
    { headers: coordHeaders() }
  );
  const rawStaff = (await staffRes.json()) as Array<{
    id: string;
    name: string;
    role: string;
    status: string;
  }>;
  const activePromotoras = rawStaff.filter((s) => {
    const roleLower = String(s.role || '').toLowerCase();
    if (roleLower.includes('merchandising')) return false;
    try {
      const parsed = JSON.parse(s.status || '{}');
      return String(parsed.status || 'Activo').toLowerCase() !== 'inactivo';
    } catch {
      return true;
    }
  });

  assert(activePromotoras.length >= 2, `Se encontraron ${activePromotoras.length} promotoras activas reales en public.staff`);
  const promA = activePromotoras[0]!;
  const promB = activePromotoras[1]!;

  let createdCargaId: string | null = null;
  let createdCronogramaId: string | null = null;
  const testHash = await computeDegustacionIdempotencyHash({
    fecha: '2099-12-31',
    clienteNombre: `QA_FASE1_${Date.now()}`,
    horaInicio: '09:00',
    productoResumen: 'MORTADELA',
  });

  try {
    // 3.a Volcado por lote (RPC volcar_lote_cronograma) -> PENDIENTE_APROBACION + Idempotencia
    const rpcRes = await fetch(`${SUPABASE_REST_URL}/rpc/volcar_lote_cronograma`, {
      method: 'POST',
      headers: coordHeaders(),
      body: JSON.stringify({
        p_carga: {
          nombre_archivo: 'verificacion_fase1.xlsx',
          extension: 'xlsx',
          mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          tamano_bytes: 2048,
          archivo_sha256: testHash,
          metodo_extraccion: 'TABULAR_DETERMINISTA',
          cargado_por: 'QA Arquitecto Fase 1',
        },
        p_filas: [
          {
            idempotency_hash: testHash,
            fecha: '2099-12-31',
            hora_inicio: '09:00',
            hora_fin: '13:00',
            turno: 'MAÑANA',
            cliente_nombre: 'PDV VERIFICACIÓN FASE 1',
            zona_direccion: 'MARACAIBO',
            producto_resumen: 'MORTADELA',
            productos: ['MORTADELA'],
            cantidad_kilos: 2.5,
            personas_estimadas: 80,
            vendedor_fdv: 'FDV QA',
            observaciones: 'Registro efímero de verificación Fase 1',
          },
          // Duplicado intencional en el mismo lote para verificar idempotencia
          {
            idempotency_hash: testHash,
            fecha: '2099-12-31',
            hora_inicio: '09:00',
            hora_fin: '13:00',
            turno: 'MAÑANA',
            cliente_nombre: 'PDV VERIFICACIÓN FASE 1',
            zona_direccion: 'MARACAIBO',
            producto_resumen: 'MORTADELA',
            productos: ['MORTADELA'],
            cantidad_kilos: 2.5,
            personas_estimadas: 80,
            vendedor_fdv: 'FDV QA',
          },
        ],
      }),
    });

    assert(rpcRes.ok, `RPC volcar_lote_cronograma respondió HTTP ${rpcRes.status}`);
    const rpcBody = (await rpcRes.json()) as {
      carga_id: string;
      total_insertadas: number;
      total_duplicadas: number;
      ids_insertados: string[];
    };
    createdCargaId = rpcBody.carga_id;
    createdCronogramaId = rpcBody.ids_insertados[0] || null;
    assert(
      rpcBody.total_insertadas === 1 && rpcBody.total_duplicadas === 1 && Boolean(createdCronogramaId),
      'Idempotencia en BD verificada (1 insertada, 1 duplicada omitida automáticamente)'
    );

    // 3.b Intentar aprobar SIN promotora_id -> DEBE SER BLOQUEADO POR POSTGRES
    const badApprove = await fetch(
      `${SUPABASE_REST_URL}/cronograma_degustaciones?id=eq.${createdCronogramaId}`,
      {
        method: 'PATCH',
        headers: coordHeaders(),
        body: JSON.stringify({ estado: 'APROBADA', aprobado_por: 'Coordinadora QA' }),
      }
    );
    assert(!badApprove.ok, `Candado de seguridad activo: Postgres bloqueó aprobar sin promotora_id (HTTP ${badApprove.status})`);

    // 3.c Asignar Promotora A + Aprobar -> Debe aparecer automáticamente en rutas_promotoras SOLO para Promotora A
    const okApprove = await fetch(
      `${SUPABASE_REST_URL}/cronograma_degustaciones?id=eq.${createdCronogramaId}`,
      {
        method: 'PATCH',
        headers: coordHeaders(),
        body: JSON.stringify({
          promotora_id: promA.id,
          estado: 'APROBADA',
          aprobado_por: 'Coordinadora QA',
        }),
      }
    );
    assert(okApprove.ok, `Aprobación con Promotora A (${promA.name}) exitosa`);

    const rutaPromARes = await fetch(
      `${SUPABASE_REST_URL}/rutas_promotoras?cronograma_id=eq.${createdCronogramaId}`,
      { headers: promotoraHeaders(promA.id) }
    );
    const rutaPromA = (await rutaPromARes.json()) as Array<{ id: string; promotora_id: string }>;
    assert(rutaPromA.length === 1 && rutaPromA[0]?.promotora_id === promA.id, 'Trigger insertó automáticamente la degustación en la ruta de Promotora A');

    const rutaPromBLeakCheck = await fetch(
      `${SUPABASE_REST_URL}/rutas_promotoras?cronograma_id=eq.${createdCronogramaId}`,
      { headers: promotoraHeaders(promB.id) }
    );
    const rutaPromBLeak = (await rutaPromBLeakCheck.json()) as unknown[];
    assert(rutaPromBLeak.length === 0, 'Aislamiento RLS verificado: Promotora B ve 0 registros ajenos');

    // 3.d Reasignar de Promotora A -> Promotora B estando APROBADA
    const reassignRes = await fetch(
      `${SUPABASE_REST_URL}/cronograma_degustaciones?id=eq.${createdCronogramaId}`,
      {
        method: 'PATCH',
        headers: coordHeaders(),
        body: JSON.stringify({ promotora_id: promB.id }),
      }
    );
    assert(reassignRes.ok, `Reasignación en caliente hacia Promotora B (${promB.name}) exitosa`);

    const afterReassignA = (await (
      await fetch(`${SUPABASE_REST_URL}/rutas_promotoras?cronograma_id=eq.${createdCronogramaId}`, {
        headers: promotoraHeaders(promA.id),
      })
    ).json()) as unknown[];
    const afterReassignB = (await (
      await fetch(`${SUPABASE_REST_URL}/rutas_promotoras?cronograma_id=eq.${createdCronogramaId}`, {
        headers: promotoraHeaders(promB.id),
      })
    ).json()) as Array<{ promotora_id: string }>;
    assert(
      afterReassignA.length === 0 && afterReassignB.length === 1,
      'Consistencia de reasignación verificada: desapareció de Promotora A y cargó en Promotora B'
    );

    // 3.e Revertir a RECHAZADA -> Debe desaparecer de la ruta de Promotora B inmediatamente
    const rejectRes = await fetch(
      `${SUPABASE_REST_URL}/cronograma_degustaciones?id=eq.${createdCronogramaId}`,
      {
        method: 'PATCH',
        headers: coordHeaders(),
        body: JSON.stringify({ estado: 'RECHAZADA', motivo_rechazo: 'Prueba QA reversión' }),
      }
    );
    assert(rejectRes.ok, 'Cambio a estado RECHAZADA exitoso');

    const afterRejectB = (await (
      await fetch(`${SUPABASE_REST_URL}/rutas_promotoras?cronograma_id=eq.${createdCronogramaId}`, {
        headers: promotoraHeaders(promB.id),
      })
    ).json()) as unknown[];
    assert(afterRejectB.length === 0, 'Reversión verificada: tarea retirada inmediatamente de rutas_promotoras');
  } finally {
    if (createdCronogramaId) {
      await fetch(`${SUPABASE_REST_URL}/cronograma_degustaciones?id=eq.${createdCronogramaId}`, {
        method: 'DELETE',
        headers: coordHeaders(),
      });
    }
    if (createdCargaId) {
      await fetch(`${SUPABASE_REST_URL}/cargas_archivos?id=eq.${createdCargaId}`, {
        method: 'DELETE',
        headers: coordHeaders(),
      }).catch(() => {});
    }
  }

  console.log('\n✅ FASE 1 VERIFICADA INTEGRALMENTE AL 100% EN SUPABASE.');
}

runVerification().catch((err) => {
  console.error('\n❌ ERROR EN VERIFICACIÓN FASE 1:', err);
  process.exit(1);
});
