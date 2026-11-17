import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Generador local seguro de `supabase/.temp/run_seed_local.sql`:
 * - Lee exclusivamente `SEED_SUPER_ADMIN_PASSWORD` y `SEED_COORDINADORA_PASSWORD`
 *   desde variables de entorno locales (`.env.local` ignorado por Git).
 * - Jamás imprime contraseñas ni contenido sensible en consola.
 * - Escribe el resultado únicamente dentro de `supabase/.temp/run_seed_local.sql`
 *   (ruta protegida en `.gitignore`).
 */
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function main(): void {
  const superAdminPwd = (process.env.SEED_SUPER_ADMIN_PASSWORD ?? '').trim();
  const coordinadoraPwd = (process.env.SEED_COORDINADORA_PASSWORD ?? '').trim();

  if (superAdminPwd.length < 6 || coordinadoraPwd.length < 6) {
    console.error(
      'ℹ️ Define SEED_SUPER_ADMIN_PASSWORD y SEED_COORDINADORA_PASSWORD (>= 6 caracteres) en tu .env.local para generar supabase/.temp/run_seed_local.sql.'
    );
    process.exit(1);
  }

  const templatePath = path.resolve('supabase/seed_3_usuarios.template.sql');
  const outputDir = path.resolve('supabase/.temp');
  const outputPath = path.join(outputDir, 'run_seed_local.sql');

  const templateSql = fs.readFileSync(templatePath, 'utf8');
  const renderedSql = templateSql
    .replace("'<CLAVE_SUPER_ADMIN>'", `'${escapeSqlLiteral(superAdminPwd)}'`)
    .replace("'<CLAVE_COORDINADORA>'", `'${escapeSqlLiteral(coordinadoraPwd)}'`);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, renderedSql, { encoding: 'utf8', mode: 0o600 });

  console.log('✅ Archivo temporal generado en: supabase/.temp/run_seed_local.sql');
  console.log(
    '⚠️ SEGURIDAD: Cópialo al SQL Editor de Supabase y elimina supabase/.temp/run_seed_local.sql inmediatamente después de ejecutarlo.'
  );
}

main();
