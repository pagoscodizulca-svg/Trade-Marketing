import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const BUILD_ID_PLACEHOLDER = '__APP_BUILD_ID__';

export interface BuildVersionPayload {
  app: string;
  buildId: string;
  builtAt: string;
}

export interface BuildVersionPluginOptions {
  appName: string;
  stampFiles?: readonly string[];
  buildId?: string;
  builtAt?: string;
}

function sanitizeBuildToken(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
}

/**
 * Genera un identificador de compilación único y seguro para caché HTTP / Service Worker.
 * Incluye marca temporal UTC, prefijo de commit (si Render/CI lo provee) y entropía corta,
 * garantizando que cada build produzca un `buildId` distinto sin edición manual.
 */
export function generateBuildId(options?: {
  env?: Record<string, string | undefined>;
  now?: Date;
  randomHex?: string;
}): string {
  const env = options?.env ?? process.env;
  const now = options?.now ?? new Date();

  const explicit = sanitizeBuildToken(String(env.APP_BUILD_ID ?? '').trim());
  if (explicit) return explicit;

  const isoCompact = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

  const rawCommit = String(
    env.RENDER_GIT_COMMIT ?? env.GITHUB_SHA ?? env.VERCEL_GIT_COMMIT_SHA ?? env.SOURCE_VERSION ?? ''
  ).trim();
  const commitShort = sanitizeBuildToken(rawCommit).slice(0, 7);
  const rand = sanitizeBuildToken(options?.randomHex ?? crypto.randomBytes(3).toString('hex')).slice(0, 6);

  return commitShort ? `${isoCompact}-${commitShort}-${rand}` : `${isoCompact}-${rand}`;
}

/**
 * Reemplaza el marcador `__APP_BUILD_ID__` dentro de un archivo ya emitido en `dist/`
 * (por ejemplo `dist/sw.js`) sin tocar nunca los archivos fuente en `public/`.
 */
export function stampServiceWorkerFile(filePath: string, buildId: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const current = fs.readFileSync(filePath, 'utf8');
  if (!current.includes(BUILD_ID_PLACEHOLDER)) return false;
  const updated = current.split(BUILD_ID_PLACEHOLDER).join(buildId);
  fs.writeFileSync(filePath, updated, 'utf8');
  return true;
}

interface MinimalViteConfig {
  root?: string;
  base?: string;
  build?: { outDir?: string };
}

interface MinimalViteServer {
  middlewares: {
    use: (
      handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
    ) => void;
  };
}

interface MinimalBundleContext {
  emitFile(file: { type: 'asset'; fileName: string; source: string }): void;
}

/**
 * Plugin Vite reutilizable (cero dependencias externas) para invalidación automática de caché:
 *  1. Inyecta `__APP_BUILD_ID__` y `__APP_BUILT_AT__` en el bundle cliente.
 *  2. Emite `version.json` en la raíz del `dist/` en cada build de producción.
 *  3. Estampa el `buildId` en `dist/sw.js` (y cualquier archivo listado en `stampFiles`) para que
 *     el navegador detecte cambio byte-a-byte del Service Worker automáticamente en cada deploy.
 *  4. Expone `version.json` con `Cache-Control: no-store` en servidor de desarrollo Vite.
 */
export function createBuildVersionPlugin(options: BuildVersionPluginOptions) {
  const builtAt = options.builtAt ?? new Date().toISOString();
  const buildId = sanitizeBuildToken(options.buildId ?? generateBuildId()) || generateBuildId();
  const payload: BuildVersionPayload = {
    app: options.appName,
    buildId,
    builtAt,
  };
  const payloadJson = `${JSON.stringify(payload, null, 2)}\n`;
  const stampFiles = options.stampFiles ?? ['sw.js'];

  let resolvedRoot = process.cwd();
  let resolvedOutDir = 'dist';
  let resolvedBase = '/';

  return {
    name: 'codizulca-build-version',

    config() {
      return {
        define: {
          __APP_BUILD_ID__: JSON.stringify(buildId),
          __APP_BUILT_AT__: JSON.stringify(builtAt),
        },
      };
    },

    configResolved(config: MinimalViteConfig) {
      resolvedRoot = config.root ?? process.cwd();
      resolvedOutDir = config.build?.outDir ?? 'dist';
      resolvedBase = config.base ?? '/';
    },

    configureServer(server: MinimalViteServer) {
      const normalizedBase = resolvedBase.endsWith('/') ? resolvedBase : `${resolvedBase}/`;
      const devVersionPaths = new Set(['/version.json', `${normalizedBase}version.json`]);

      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (!devVersionPaths.has(pathname)) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.end(payloadJson);
      });
    },

    generateBundle(this: MinimalBundleContext) {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: payloadJson,
      });
    },

    closeBundle: {
      order: 'post' as const,
      sequential: true,
      handler() {
        const absOutDir = path.isAbsolute(resolvedOutDir)
          ? resolvedOutDir
          : path.resolve(resolvedRoot, resolvedOutDir);
        for (const relFile of stampFiles) {
          stampServiceWorkerFile(path.join(absOutDir, relFile), buildId);
        }
      },
    },
  };
}
