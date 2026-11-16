import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadAdminQaEnv, loadPublicQaEnv, redactSensitive } from './lib/env.mjs';
import { recordLedgerEntry, registerRunInLedger } from './lib/ledger.mjs';
import { createRequestPacer } from './lib/rateLimiter.mjs';

/**
 * Calcula la próxima fecha hábil de degustación en zona horaria `America/Caracas`
 * (Jueves = 4, Viernes = 5 o Sábado = 6, estrictamente futura para cumplir reglas FDV y Trade).
 */
export function computeNextValidTastingDateCaracas() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const caracasToday = formatter.format(new Date());
  const [y, m, d] = caracasToday.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  // Avanzar al menos 2 días hacia adelante hasta encontrar Jueves(4), Viernes(5) o Sábado(6)
  cursor.setUTCDate(cursor.getUTCDate() + 2);
  for (let i = 0; i < 14; i++) {
    const dow = cursor.getUTCDay();
    if (dow === 4 || dow === 5 || dow === 6) {
      const yyyy = cursor.getUTCFullYear();
      const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(cursor.getUTCDate()).padStart(2, '0');
      return {
        caracasTodayYmd: caracasToday,
        tastingDateYmd: `${yyyy}-${mm}-${dd}`,
      };
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  throw new Error('No fue posible calcular una fecha hábil Jue/Vie/Sáb en America/Caracas.');
}

function isMissingTableOrColError(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    code === 'PGRST204' ||
    code === '42703' ||
    /does not exist|schema cache|Could not find/i.test(msg)
  );
}

/**
 * Aprovisiona programáticamente en memoria y BD los 4 usuarios QA temporales,
 * perfiles `public.staff`, vendedor auxiliar y `Cliente Prueba` ficticio.
 * Registra cada fila en `qa-ledger.json` ANTES de pasar al siguiente paso.
 */
export async function seedQaEnvironment() {
  const adminEnv = loadAdminQaEnv('seed-qa-environment.mjs');
  const pacer = createRequestPacer(adminEnv.rateLimitRps);

  const hexUpper = crypto.randomBytes(4).toString('hex').toUpperCase();
  const hexLower = hexUpper.toLowerCase();
  const runId = `QA_SYNC_${Date.now()}_${hexUpper}`;
  const tagPrefix = `[QA-SYNC-TEST:${runId}]`;
  const { caracasTodayYmd, tastingDateYmd } = computeNextValidTastingDateCaracas();

  registerRunInLedger(runId);

  const adminClient = createClient(adminEnv.supabaseUrl, adminEnv.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const actorSpecs = [
    {
      key: 'qa_vendedor',
      email: `qa_vendedor.${hexLower}@qa-sync.codizulca.internal`,
      appRole: 'vendedor',
      fullName: `${tagPrefix} VENDEDOR FICTICIO QA`,
    },
    {
      key: 'qa_planificador',
      email: `qa_planificador.${hexLower}@qa-sync.codizulca.internal`,
      appRole: 'coordinadora',
      fullName: `${tagPrefix} PLANIFICADOR TRADE QA`,
    },
    {
      key: 'qa_promotora_a',
      email: `qa_promotora_a.${hexLower}@qa-sync.codizulca.internal`,
      appRole: 'promotora',
      fullName: `${tagPrefix} PROMOTORA A QA`,
    },
    {
      key: 'qa_promotora_b',
      email: `qa_promotora_b.${hexLower}@qa-sync.codizulca.internal`,
      appRole: 'promotora',
      fullName: `${tagPrefix} PROMOTORA B QA`,
    },
  ];

  // Contraseñas criptográficas efímeras mantenidas SOLO en memoria RAM del proceso
  const usersInMemory = {};

  for (const spec of actorSpecs) {
    await pacer.pace();
    const password = `Qa!9_${crypto.randomBytes(24).toString('base64url')}`;

    const { data, error } = await adminClient.auth.admin.createUser({
      email: spec.email,
      password,
      email_confirm: true,
      app_metadata: {
        app_role: spec.appRole,
        role: spec.appRole,
        qa_run_id: runId,
      },
      user_metadata: {
        full_name: spec.fullName,
        qa_run_id: runId,
      },
    });

    if (error || !data?.user?.id) {
      throw new Error(
        `Error creando usuario Auth ${spec.key}: ${redactSensitive(error?.message || 'sin ID')}`
      );
    }

    // Bitácora write-ahead ANTES del siguiente paso
    recordLedgerEntry({
      resource_type: 'auth_user',
      schema: 'auth',
      table_or_bucket: 'users',
      pk_column: 'id',
      id: data.user.id,
      run_id: runId,
      meta: { actor: spec.key, email: spec.email },
    });

    usersInMemory[spec.key] = {
      id: data.user.id,
      email: spec.email,
      password,
      appRole: spec.appRole,
      fullName: spec.fullName,
      staffId: null,
    };
  }

  // Crear filas activas en `public.staff` para `qa_promotora_a` y `qa_promotora_b`
  for (const promKey of ['qa_promotora_a', 'qa_promotora_b']) {
    await pacer.pace();
    const actor = usersInMemory[promKey];
    const staffUuid = crypto.randomUUID();
    const statusJson = JSON.stringify({
      status: 'Activo',
      category: 'FIJA',
      phone: '+584140000000',
      address: `${tagPrefix} DIRECCION PRUEBA`,
      assignedStore: `${tagPrefix} CLIENTE FICTICIO NO DESPACHAR`,
      qa_run_id: runId,
    });

    let staffRes = await adminClient
      .from('staff')
      .insert({
        id: staffUuid,
        name: actor.fullName,
        role: 'Promotora Fija',
        email: actor.email,
        status: statusJson,
        auth_user_id: actor.id,
      })
      .select('id')
      .single();

    if (staffRes.error && isMissingTableOrColError(staffRes.error)) {
      staffRes = await adminClient
        .from('staff')
        .insert({
          id: staffUuid,
          name: actor.fullName,
          role: 'Promotora Fija',
          email: actor.email,
          status: statusJson,
        })
        .select('id')
        .single();
    }

    if (staffRes.error || !staffRes.data?.id) {
      throw new Error(
        `Error insertando public.staff para ${promKey}: ${redactSensitive(
          staffRes.error?.message || 'sin ID'
        )}`
      );
    }

    recordLedgerEntry({
      resource_type: 'db_row',
      schema: 'public',
      table_or_bucket: 'staff',
      pk_column: 'id',
      id: staffRes.data.id,
      run_id: runId,
      meta: { actor: promKey },
    });

    actor.staffId = staffRes.data.id;
  }

  // Crear catálogo auxiliar `public.vendedores` (si existe en el esquema activo)
  const sellerCode = `QAVEN_${hexUpper}`;
  let vendedorRowId = null;

  await pacer.pace();
  const vendRes = await adminClient
    .from('vendedores')
    .insert({
      codigo_vendedor: sellerCode,
      nombre_completo: usersInMemory.qa_vendedor.fullName,
      zona: 'ZONA QA',
      telefono: '+584120000000',
      email: usersInMemory.qa_vendedor.email,
      activo: true,
      metadata: { qa_run_id: runId, tag: tagPrefix },
    })
    .select('id, codigo_vendedor')
    .single();

  if (!vendRes.error && vendRes.data?.id) {
    vendedorRowId = vendRes.data.id;
    recordLedgerEntry({
      resource_type: 'db_row',
      schema: 'public',
      table_or_bucket: 'vendedores',
      pk_column: 'id',
      id: vendedorRowId,
      run_id: runId,
      meta: { codigo_vendedor: sellerCode },
    });
  } else if (vendRes.error && !isMissingTableOrColError(vendRes.error)) {
    throw new Error(
      `Error creando vendedor catálogo QA: ${redactSensitive(vendRes.error.message)}`
    );
  }

  // Crear `Cliente Prueba` ficticio en `public.clientes` (o fallback `public.clients` si aplica)
  const clientCode = `QACLI_${hexUpper}`;
  const clientName = `${tagPrefix} CLIENTE FICTICIO NO DESPACHAR`;
  let clienteTableUsed = 'clientes';
  let clienteRowId = null;

  await pacer.pace();
  const cliRes = await adminClient
    .from('clientes')
    .insert({
      codigo_cliente: clientCode,
      razon_social: clientName,
      rif: `J-0000${hexUpper.slice(0, 4)}-0`,
      vendedor_id: vendedorRowId,
      codigo_vendedor: sellerCode,
      telefono: '+584140009999',
      direccion: `${tagPrefix} AVENIDA PRUEBA NO DESPACHAR`,
      zona: 'ZONA QA MARACAIBO',
      ruta: 'RUTA QA 99',
      activo: true,
      metadata: { qa_run_id: runId, synthetic_only: true },
    })
    .select('id, codigo_cliente, razon_social')
    .single();

  if (!cliRes.error && cliRes.data?.id) {
    clienteRowId = cliRes.data.id;
    clienteTableUsed = 'clientes';
    recordLedgerEntry({
      resource_type: 'db_row',
      schema: 'public',
      table_or_bucket: 'clientes',
      pk_column: 'id',
      id: clienteRowId,
      run_id: runId,
      meta: { codigo_cliente: clientCode, razon_social: clientName },
    });
  } else if (cliRes.error && isMissingTableOrColError(cliRes.error)) {
    const legacyCliRes = await adminClient
      .from('clients')
      .insert({
        client_code: clientCode,
        business_name: clientName,
        zone: 'ZONA QA MARACAIBO',
        latitude: 10.654,
        longitude: -71.634,
        geofence_radius_meters: 200,
        is_active: true,
      })
      .select('id, client_code, business_name')
      .single();

    if (legacyCliRes.error || !legacyCliRes.data?.id) {
      throw new Error(
        `No se pudo crear el Cliente Prueba ni en public.clientes ni en public.clients: ${redactSensitive(
          legacyCliRes.error?.message || cliRes.error?.message
        )}`
      );
    }

    clienteRowId = legacyCliRes.data.id;
    clienteTableUsed = 'clients';
    recordLedgerEntry({
      resource_type: 'db_row',
      schema: 'public',
      table_or_bucket: 'clients',
      pk_column: 'id',
      id: clienteRowId,
      run_id: runId,
      meta: { codigo_cliente: clientCode, razon_social: clientName },
    });
  } else {
    throw new Error(
      `Error creando Cliente Prueba en public.clientes: ${redactSensitive(cliRes.error?.message)}`
    );
  }

  return {
    runId,
    tagPrefix,
    hexUpper,
    hexLower,
    caracasTodayYmd,
    tastingDateYmd,
    users: usersInMemory,
    vendedorCatalogo: {
      id: vendedorRowId,
      codigoVendedor: sellerCode,
      nombreCompleto: usersInMemory.qa_vendedor.fullName,
    },
    clientePrueba: {
      id: clienteRowId,
      table: clienteTableUsed,
      codigoCliente: clientCode,
      razonSocial: clientName,
      zona: 'ZONA QA MARACAIBO',
      ruta: 'RUTA QA 99',
      direccion: `${tagPrefix} AVENIDA PRUEBA NO DESPACHAR`,
    },
  };
}

/**
 * Modo CLI HITO 2 (`--lifecycle-check`):
 * Ejecuta prueba en seco completa (creación -> login real de los 4 usuarios con ANON_KEY ->
 * lectura verificada del Cliente Prueba -> teardown obligatorio en `finally` -> verify zero residue).
 */
async function runCliDryRunLifecycle() {
  const { teardownQaEnvironment } = await import('./teardown-qa-environment.mjs');
  const { verifyZeroResidue } = await import('./verify-zero-residue.mjs');
  const publicEnv = loadPublicQaEnv();
  const pacer = createRequestPacer(publicEnv.rateLimitRps);

  let seeded = null;
  const activeClientsToSignOut = [];

  try {
    console.log('=== [HITO 2] INICIANDO PRUEBA EN SECO DE CICLO DE VIDA CERO-RESIDUOS ===');
    seeded = await seedQaEnvironment();
    console.log(`[SEED OK] RUN_ID=${seeded.runId}`);
    console.log(
      `[SEED OK] Cliente Prueba creado en public.${seeded.clientePrueba.table} (id=${seeded.clientePrueba.id}, codigo=${seeded.clientePrueba.codigoCliente})`
    );

    // Validar login real usuario/contraseña de los 4 usuarios con SUPABASE_ANON_KEY
    for (const key of ['qa_vendedor', 'qa_planificador', 'qa_promotora_a', 'qa_promotora_b']) {
      await pacer.pace();
      const actor = seeded.users[key];
      const anonClient = createClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      activeClientsToSignOut.push(anonClient);

      const { data, error } = await anonClient.auth.signInWithPassword({
        email: actor.email.trim().toLowerCase(),
        password: actor.password,
      });

      if (error || !data?.session?.access_token || data.user?.id !== actor.id) {
        throw new Error(
          `Fallo de autenticación real para ${key}: ${redactSensitive(error?.message || 'sesión vacía')}`
        );
      }

      const tokenRole = data.user?.app_metadata?.app_role;
      console.log(
        `[AUTH OK] ${key} autenticado vía signInWithPassword (uid=${actor.id}, app_role=${tokenRole}, staffId=${actor.staffId || 'N/A'})`
      );

      // Si es qa_planificador, comprobar lectura real del Cliente Prueba bajo RLS con ANON_KEY
      if (key === 'qa_planificador') {
        const pkVal = seeded.clientePrueba.id;
        const { data: cliCheck, error: cliErr } = await anonClient
          .from(seeded.clientePrueba.table)
          .select('*')
          .eq('id', pkVal)
          .single();

        if (cliErr || !cliCheck) {
          throw new Error(
            `qa_planificador no pudo leer Cliente Prueba bajo RLS: ${redactSensitive(cliErr?.message)}`
          );
        }
        console.log(
          `[CLIENTE OK] Lectura RLS verificada en public.${seeded.clientePrueba.table} para ${seeded.clientePrueba.codigoCliente}`
        );
      }
    }
  } finally {
    for (const c of activeClientsToSignOut) {
      await c.auth.signOut().catch(() => {});
    }
    console.log('=== [HITO 2] EJECUTANDO PURGA OBLIGATORIA EN BLOQUE FINALLY ===');
    const teardownSummary = await teardownQaEnvironment({
      runId: seeded?.runId || null,
    });
    console.log('[TEARDOWN SUMMARY]', JSON.stringify(teardownSummary, null, 2));

    const zeroCheck = await verifyZeroResidue({
      runId: seeded?.runId || null,
    });
    console.log('[ZERO-RESIDUE CHECK]', JSON.stringify(zeroCheck, null, 2));
    if (!zeroCheck.clean) {
      process.exitCode = 1;
    }
  }
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  if (process.argv.includes('--lifecycle-check')) {
    runCliDryRunLifecycle().catch((err) => {
      console.error('[HITO 2 ERROR]', redactSensitive(err?.stack || err?.message || err));
      process.exit(1);
    });
  } else {
    console.error(
      'Uso seguro: ejecuta `node scripts/seed-qa-environment.mjs --lifecycle-check` para garantizar que seed siempre corra envuelto en try...finally con teardown.'
    );
    process.exit(1);
  }
}
