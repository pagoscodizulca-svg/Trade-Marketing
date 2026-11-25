import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';

export const NO_STORE_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, max-age=0';
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATED_ICON_CACHE_CONTROL = 'public, max-age=3600, must-revalidate';

const STATIC_ASSET_EXTENSION_REGEX =
  /\.(?:m?js|cjs|css|map|json|webmanifest|png|jpe?g|webp|svg|ico|gif|woff2?|ttf|eot|txt|xml)$/i;

/**
 * Aplica cabeceras estrictas anti-caché para documentos de entrada (`index.html`),
 * manifiestos (`version.json`, `manifest.webmanifest`) y Service Workers (`sw.js`).
 */
export function applyNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', NO_STORE_CACHE_CONTROL);
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/**
 * Determina si una ruta corresponde a un archivo estático/asset que JAMÁS debe recibir
 * `index.html` con 200 OK cuando no existe (previene cache poisoning tras despliegues).
 */
export function isStaticAssetRequestPath(rawUrlPath: string): boolean {
  const pathname = String(rawUrlPath ?? '').split('?')[0].split('#')[0];
  if (!pathname) return false;
  if (/(?:^|\/)assets\//i.test(pathname)) return true;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (!lastSegment) return false;
  return STATIC_ASSET_EXTENSION_REGEX.test(lastSegment);
}

/**
 * Cabeceras HTTP diferenciadas por tipo de recurso estático:
 *  - `sw.js`, `registerSW.js`, `index.html`, `version.json`, `manifest.*`: `no-store` estricto.
 *  - `/assets/*` (con hash de contenido Vite): `max-age=31536000, immutable`.
 *  - Íconos/branding sin hash: `max-age=3600, must-revalidate`.
 */
export function applySpaStaticHeaders(res: Response, filePath: string): void {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalizedPath);

  if (/^(sw\.js|registerSW\.js)$/i.test(base)) {
    applyNoStoreHeaders(res);
    res.setHeader('Service-Worker-Allowed', '/');
    return;
  }

  if (/^(index\.html|version\.json|manifest\.json|manifest\.webmanifest)$/i.test(base)) {
    applyNoStoreHeaders(res);
    if (base.toLowerCase().endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    } else if (base.toLowerCase() === 'version.json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    return;
  }

  if (normalizedPath.includes('/assets/')) {
    res.setHeader('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
    return;
  }

  if (
    /^(favicon\.ico|codizulca-logo\.png)$/i.test(base) ||
    normalizedPath.includes('/icons/')
  ) {
    res.setHeader('Cache-Control', REVALIDATED_ICON_CACHE_CONTROL);
  }
}

export interface MountSpaOptions {
  onMissingDist?: (label: string, distPath: string) => void;
}

/**
 * Monta una SPA compilada con política anti-caché obsoleta:
 *  - Redirige `/subapp` -> `/subapp/` preservando query string.
 *  - Sirve estáticos con cabeceras diferenciadas (`immutable` vs `no-store`).
 *  - Responde 404 (con `no-store`) a cualquier archivo estático/chunk faltante, nunca `index.html`.
 *  - Responde `index.html` con `no-store` solo para rutas de navegación SPA válidas.
 */
export function mountSpaRoutes(
  targetApp: express.Express,
  mountPath: string,
  distPath: string,
  label: string,
  options?: MountSpaOptions
): boolean {
  const indexFile = path.join(distPath, 'index.html');
  if (!fs.existsSync(indexFile)) {
    options?.onMissingDist?.(label, distPath);
    return false;
  }

  if (mountPath !== '/') {
    targetApp.get(mountPath, (req: Request, res: Response, next: NextFunction) => {
      const qIdx = req.originalUrl.indexOf('?');
      const rawPath = qIdx >= 0 ? req.originalUrl.slice(0, qIdx) : req.originalUrl;
      if (rawPath === mountPath) {
        const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
        res.redirect(302, `${mountPath}/${qs}`);
        return;
      }
      next();
    });
  }

  const staticMw = express.static(distPath, {
    index: false,
    setHeaders(res, filePath) {
      applySpaStaticHeaders(res, filePath);
    },
  });

  targetApp.use(mountPath, staticMw);

  const fallbackPattern =
    mountPath === '/' ? /^\/(?!api(\/|$)).*/ : new RegExp(`^${mountPath}(/.*)?$`);

  targetApp.get(fallbackPattern, (req: Request, res: Response) => {
    if (isStaticAssetRequestPath(req.path)) {
      applyNoStoreHeaders(res);
      res.status(404).type('text/plain; charset=utf-8').send('Asset not found');
      return;
    }
    applyNoStoreHeaders(res);
    res.sendFile(indexFile);
  });

  return true;
}
