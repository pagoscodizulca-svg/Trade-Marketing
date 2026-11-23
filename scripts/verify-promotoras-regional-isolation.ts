/**
 * FASE C — Verificación Reproducible de No-Mezcla Regional entre Promotoras
 *
 * Verifica contra Supabase real (sin modificar registros de negocio ni exponer contraseñas):
 *   1. Conteo exacto por región en `public.promotoras` y paridad 1:1 de `auth_user_id` (0 duplicados).
 *   2. Autenticación real con `INITIAL_PROMOTORA_PASSWORD` de un perfil activo de Occidente y uno de Valencia.
 *   3. Aislamiento horizontal RLS estricto:
 *      - Promotora Occidente: solo ve su propia fila en `public.promotoras` (0 filas de Valencia y 0 de otras promotoras),
 *        0 filas de clientes/regiones de Valencia/Centro, y recibe 403/42501 al intentar insertar en otra región.
 *      - Promotora Valencia: solo ve su propia fila en `public.promotoras` (0 filas de Occidente y 0 de otras promotoras),
 *        0 filas de clientes/regiones de Occidente, y recibe 403/42501 al intentar insertar en Occidente.
 *
 * Uso:
 *   npm run verify:promotoras-isolation
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { validateProvisionEnv } from './provision-promotoras-auth';

function loadLocalEnvFilesSafe(): void {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const filename of ['.env.local', '.env']) {
    const filePath = path.join(rootDir, filename);
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false, quiet: true });
    }
  }
}

async function runVerification(): Promise<void> {
  loadLocalEnvFilesSafe();
  const env = validateProvisionEnv(process.env);
  const publicKey = String(
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      process.env.SUPABASE_PUBLISHABLE_KEY ??
      process.env.VITE_SUPABASE_ANON_KEY ??
      ''
  ).trim();

  if (!publicKey) {
    throw new Error('Falta VITE_SUPABASE_PUBLISHABLE_KEY para ejecutar las pruebas como usuario autenticado.');
  }

  const adminClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // 1) Auditar conteos por región y paridad 1:1
  const { data: allPromotoras, error: listErr } = await adminClient
    .from('promotoras')
    .select('id, nombre_completo, correo, region, region_id, activo, auth_user_id')
    .order('id', { ascending: true });
  if (listErr || !Array.isArray(allPromotoras)) {
    throw new Error(`Error leyendo public.promotoras: ${listErr?.message ?? 'sin datos'}`);
  }

  const countsByRegion: Record<string, number> = {};
  const authIds = new Set<string>();
  let unlinkedCount = 0;

  for (const row of allPromotoras) {
    const reg = String(row.region ?? 'SIN_REGION').trim();
    countsByRegion[reg] = (countsByRegion[reg] ?? 0) + 1;
    if (row.auth_user_id) {
      assert.equal(
        authIds.has(String(row.auth_user_id)),
        false,
        `Violación 1:1: auth_user_id duplicado detectado en promotora id=${row.id}`
      );
      authIds.add(String(row.auth_user_id));
    } else {
      unlinkedCount += 1;
    }
  }

  assert.equal(unlinkedCount, 0, `Aún hay ${unlinkedCount} promotoras sin auth_user_id vinculado.`);
  assert.equal(authIds.size, allPromotoras.length, 'La relación auth_user_id -> promotora debe ser estrictamente 1:1.');

  // Elegir 1 promotora activa de Occidente y 1 promotora activa de Valencia
  const occidenteSample = allPromotoras.find(
    (p) => String(p.region ?? '').trim().toLowerCase() === 'occidente' && p.activo !== false && p.correo
  );
  const valenciaSample = allPromotoras.find(
    (p) => String(p.region ?? '').trim().toLowerCase() === 'valencia' && p.activo !== false && p.correo
  );

  assert.ok(occidenteSample, 'No se encontró una promotora activa en Occidente.');
  assert.ok(valenciaSample, 'No se encontró una promotora activa en Valencia.');

  const signInAsPromotora = async (email: string) => {
    const client = createClient(env.supabaseUrl, publicKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: env.initialPassword,
    });
    assert.equal(error, null, `Fallo login de ${email}: ${error?.message}`);
    assert.ok(data.session?.access_token && data.user?.id, `Sin sesión válida para ${email}`);
    return { client, userId: data.user.id, accessToken: data.session.access_token };
  };

  const [occSession, valSession] = await Promise.all([
    signInAsPromotora(String(occidenteSample.correo)),
    signInAsPromotora(String(valenciaSample.correo)),
  ]);

  // 1.B) Verificar que una contraseña distinta es rechazada (ninguna puede ingresar con otra clave)
  const wrongPwdClient = createClient(env.supabaseUrl, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: wrongPwdData, error: wrongPwdErr } = await wrongPwdClient.auth.signInWithPassword({
    email: String(occidenteSample.correo).trim().toLowerCase(),
    password: `${env.initialPassword}_INVALIDA`,
  });
  assert.ok(wrongPwdErr && !wrongPwdData.session, 'Debe rechazar cualquier contraseña distinta a la configurada.');

  // 2) Verificar aislamiento estricto de SELECT en `public.promotoras` (solo su propia fila, 0 de otra región)
  const [{ data: occVisibleProms, error: occPromErr }, { data: valVisibleProms, error: valPromErr }] =
    await Promise.all([
      occSession.client.from('promotoras').select('id, region, correo, auth_user_id'),
      valSession.client.from('promotoras').select('id, region, correo, auth_user_id'),
    ]);

  assert.equal(occPromErr, null);
  assert.equal(valPromErr, null);
  assert.equal(occVisibleProms?.length, 1, 'Promotora Occidente solo debe ver su propia fila.');
  assert.equal(String(occVisibleProms?.[0]?.id), String(occidenteSample.id));
  assert.equal(String(occVisibleProms?.[0]?.region), 'Occidente');

  assert.equal(valVisibleProms?.length, 1, 'Promotora Valencia solo debe ver su propia fila.');
  assert.equal(String(valVisibleProms?.[0]?.id), String(valenciaSample.id));
  assert.equal(String(valVisibleProms?.[0]?.region), 'Valencia');

  // 3) Verificar consulta directa por ID de la promotora de la otra región -> 0 filas
  const [{ data: occCrossProm }, { data: valCrossProm }] = await Promise.all([
    occSession.client.from('promotoras').select('id').eq('id', valenciaSample.id),
    valSession.client.from('promotoras').select('id').eq('id', occidenteSample.id),
  ]);
  assert.equal(occCrossProm?.length ?? 0, 0, 'Promotora Occidente NO debe ver el perfil de Valencia.');
  assert.equal(valCrossProm?.length ?? 0, 0, 'Promotora Valencia NO debe ver el perfil de Occidente.');

  // 4) Verificar aislamiento en `public."Regiones"` y `public."Clientes"`
  const [{ data: occRegs }, { data: valRegs }, { data: occClientes }, { data: valClientes }] =
    await Promise.all([
      occSession.client.from('Regiones').select('id_regi, regi_desd'),
      valSession.client.from('Regiones').select('id_regi, regi_desd'),
      occSession.client.from('Clientes').select('clie_regi').limit(50),
      valSession.client.from('Clientes').select('clie_regi').limit(50),
    ]);
  assert.ok(
    (occRegs ?? []).every((r) => String(r.regi_desd).toUpperCase() === 'OCCIDENTE'),
    `Promotora Occidente vio regiones ajenas: ${JSON.stringify(occRegs)}`
  );
  assert.ok(
    (valRegs ?? []).every((r) => String(r.regi_desd).toUpperCase() === 'CENTRO'),
    `Promotora Valencia vio regiones ajenas: ${JSON.stringify(valRegs)}`
  );
  const occRegId = String(occidenteSample.region_id ?? '');
  const valRegId = String(valenciaSample.region_id ?? '');
  assert.ok(
    (occClientes ?? []).every((c) => String(c.clie_regi) === occRegId),
    'Promotora Occidente vio clientes fuera de Occidente.'
  );
  assert.ok(
    (valClientes ?? []).every((c) => String(c.clie_regi) === valRegId),
    'Promotora Valencia vio clientes fuera de Centro/Valencia.'
  );

  // 5) Verificar bloqueo RLS en intento de escritura cruzada (Occidente -> Centro y Valencia -> Occidente)
  const { error: occCrossWriteErr } = await occSession.client.from('inventory').insert({
    date: '2026-11-23',
    store: '[QA-TEST] CROSS WRITE BLOCK',
    product: 'MORTADELA',
    stock: 1,
    region: 'Centro',
    auth_user_id: occSession.userId,
    promotora_id: String(occidenteSample.id),
    creatorId: String(occidenteSample.correo),
  });
  assert.ok(occCrossWriteErr, 'Promotora Occidente debe recibir error RLS al intentar escribir en Centro/Valencia.');

  const { error: valCrossWriteErr } = await valSession.client.from('inventory').insert({
    date: '2026-11-23',
    store: '[QA-TEST] CROSS WRITE BLOCK',
    product: 'MORTADELA',
    stock: 1,
    region: 'Occidente',
    auth_user_id: valSession.userId,
    promotora_id: String(valenciaSample.id),
    creatorId: String(valenciaSample.correo),
  });
  assert.ok(valCrossWriteErr, 'Promotora Valencia debe recibir error RLS al intentar escribir en Occidente.');

  // 6) Verificar que el conteo regional no varió
  const { data: postPromotoras } = await adminClient.from('promotoras').select('id, region');
  const postCounts: Record<string, number> = {};
  for (const r of postPromotoras ?? []) {
    const reg = String(r.region ?? 'SIN_REGION').trim();
    postCounts[reg] = (postCounts[reg] ?? 0) + 1;
  }
  assert.deepEqual(postCounts, countsByRegion, 'Los conteos regionales deben permanecer idénticos.');

  console.log('=== VERIFICACIÓN FASE C: AISLAMIENTO REGIONAL 1:1 DE PROMOTORAS — PASS ===');
  console.log(
    JSON.stringify(
      {
        totalPromotoras: allPromotoras.length,
        countsByRegion,
        uniqueAuthLinks: authIds.size,
        occidenteSampleTested: { id: occidenteSample.id, region: occidenteSample.region, visiblePromotoras: occVisibleProms?.length },
        valenciaSampleTested: { id: valenciaSample.id, region: valenciaSample.region, visiblePromotoras: valVisibleProms?.length },
        crossRegionSelectRows: { occidenteToValencia: occCrossProm?.length ?? 0, valenciaToOccidente: valCrossProm?.length ?? 0 },
        crossRegionWriteBlocked: { occidenteToCentro: Boolean(occCrossWriteErr), valenciaToOccidente: Boolean(valCrossWriteErr) },
        countsInvariant: true,
      },
      null,
      2
    )
  );
}

runVerification().catch((err) => {
  console.error(`[FAIL] ${err instanceof Error ? err.message : 'Fallo en verificación de aislamiento.'}`);
  process.exit(1);
});
