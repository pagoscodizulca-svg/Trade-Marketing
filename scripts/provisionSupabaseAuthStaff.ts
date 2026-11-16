import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const rawUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1\/?$/, '');
const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const initialCoordEmail = (process.env.INITIAL_COORDINATOR_EMAIL || '').trim().toLowerCase();
const initialCoordPassword = (process.env.INITIAL_COORDINATOR_PASSWORD || '').trim();

function buildLoginEmail(rawEmail: string | null | undefined, name: string, id: string): string {
  const clean = String(rawEmail || '').trim().toLowerCase();
  if (clean && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    return clean;
  }
  const slug = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  const shortId = id.slice(0, 6).toLowerCase();
  return `${slug || 'promotora'}.${shortId}@promotoras.codizulca.local`;
}

async function runProvisioning(): Promise<void> {
  console.log('=========================================================================');
  console.log(' CODIZULCA C.A. - APROVISIONAMIENTO SUPABASE AUTH + RBAC (app_metadata)');
  console.log('=========================================================================');

  if (!rawUrl || !serviceRoleKey) {
    console.log(
      '\n⚠️  CONFIGURACIÓN REQUERIDA EN `.env.local` (SOLO SERVIDOR):\n' +
        '   1. Define `SUPABASE_SERVICE_ROLE_KEY=<service_role_key>` (sin prefijo VITE_).\n' +
        '   2. Opcionalmente define `INITIAL_COORDINATOR_EMAIL` e `INITIAL_COORDINATOR_PASSWORD` (mín. 8 caracteres).\n' +
        '   3. Ejecuta nuevamente: `npm run auth:provision`\n'
    );
    return;
  }

  const admin = createClient(rawUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existingUsersPage, error: listErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listErr) {
    throw new Error(`No se pudo listar auth.users: ${listErr.message}`);
  }

  const usersByEmail = new Map<string, string>();
  for (const u of existingUsersPage.users || []) {
    if (u.email) usersByEmail.set(u.email.toLowerCase(), u.id);
  }

  // 1. Aprovisionar cuenta Coordinadora / Admin inicial si se definió en entorno
  if (initialCoordEmail && initialCoordPassword) {
    if (initialCoordPassword.length < 8) {
      throw new Error('INITIAL_COORDINATOR_PASSWORD debe tener al menos 8 caracteres.');
    }
    const existingCoordId = usersByEmail.get(initialCoordEmail);
    const coordMeta = {
      app_role: 'coordinadora',
      display_name: 'Coordinación Trade Marketing',
    };

    if (existingCoordId) {
      const { error } = await admin.auth.admin.updateUserById(existingCoordId, {
        password: initialCoordPassword,
        email_confirm: true,
        app_metadata: coordMeta,
      });
      if (error) throw new Error(`Error actualizando Coordinadora: ${error.message}`);
      console.log(`  [OK] Cuenta Coordinadora actualizada: ${initialCoordEmail}`);
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: initialCoordEmail,
        password: initialCoordPassword,
        email_confirm: true,
        app_metadata: coordMeta,
      });
      if (error || !data.user) {
        throw new Error(`Error creando Coordinadora: ${error?.message || 'desconocido'}`);
      }
      usersByEmail.set(initialCoordEmail, data.user.id);
      console.log(`  [OK] Cuenta Coordinadora creada: ${initialCoordEmail}`);
    }
  }

  // 2. Migrar personal activo de public.staff -> auth.users y limpiar passwords legacy en status
  const { data: staffRows, error: staffErr } = await admin
    .from('staff')
    .select('id, name, role, email, status, auth_user_id');

  if (staffErr) {
    throw new Error(
      `No se pudo consultar public.staff (${staffErr.message}). Asegúrate de haber ejecutado primero la migración SQL 20261112.`
    );
  }

  let provisionedCount = 0;
  let skippedNoPasswordCount = 0;

  for (const row of staffRows || []) {
    let parsedStatus: Record<string, unknown> = {};
    if (typeof row.status === 'string' && row.status.trim().startsWith('{')) {
      try {
        parsedStatus = JSON.parse(row.status) as Record<string, unknown>;
      } catch {
        parsedStatus = {};
      }
    }

    const isActive = String(parsedStatus.status || 'Activo').toLowerCase() !== 'inactivo';
    const category = String(parsedStatus.category || '').toLowerCase();
    const isMerch =
      category === 'merchandising' || String(row.role || '').toLowerCase().includes('merchandising');

    if (!isActive || isMerch) continue;

    const loginEmail = buildLoginEmail(row.email, row.name, row.id);
    const legacyPassword = String(parsedStatus.password || '').trim();
    const appMetadata = {
      app_role: 'promotora',
      staff_id: row.id,
      display_name: String(row.name || '').trim(),
    };

    let targetAuthId =
      (row as { auth_user_id?: string | null }).auth_user_id || usersByEmail.get(loginEmail) || null;

    if (targetAuthId) {
      const { error: updErr } = await admin.auth.admin.updateUserById(targetAuthId, {
        email: loginEmail,
        email_confirm: true,
        ...(legacyPassword.length >= 8 ? { password: legacyPassword } : {}),
        app_metadata: appMetadata,
      });
      if (updErr) {
        console.warn(`  [AVISO] No se pudo actualizar ${row.name}: ${updErr.message}`);
        continue;
      }
    } else {
      if (legacyPassword.length < 8) {
        skippedNoPasswordCount++;
        console.log(
          `  [PENDIENTE PASSWORD] ${row.name} (${loginEmail}): define su contraseña (>=8 caracteres) desde el modal Personal en Trade Marketing.`
        );
        continue;
      }
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: loginEmail,
        password: legacyPassword,
        email_confirm: true,
        app_metadata: appMetadata,
      });
      if (createErr || !created.user) {
        console.warn(`  [AVISO] No se pudo crear cuenta para ${row.name}: ${createErr?.message}`);
        continue;
      }
      targetAuthId = created.user.id;
      usersByEmail.set(loginEmail, targetAuthId);
    }

    delete parsedStatus.password;
    await admin
      .from('staff')
      .update({
        auth_user_id: targetAuthId,
        email: loginEmail,
        status: JSON.stringify(parsedStatus),
      })
      .eq('id', row.id);

    provisionedCount++;
    console.log(`  [OK] Promotora vinculada: ${row.name} -> ${loginEmail}`);
  }

  console.log(
    `\n✅ Resumen Auth: ${provisionedCount} promotora(s) vinculadas en auth.users | ${skippedNoPasswordCount} pendiente(s) de asignar contraseña >= 8 caracteres.`
  );
}

runProvisioning().catch((err) => {
  console.error('\n❌ Error en aprovisionamiento Auth:', err instanceof Error ? err.message : err);
  process.exit(1);
});
