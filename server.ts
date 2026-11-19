import express, { NextFunction, Request, Response } from 'express';
import { ChildProcess, spawn } from 'child_process';
import dotenv from 'dotenv';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildApiOriginGuard,
  buildCorsMiddleware,
  buildRequestLogger,
  buildSecurityHeaders,
  parseAllowedOrigins,
} from './src/server/securityMiddleware';
import { serverLogger, usageMetrics } from './src/server/logger';
import {
  extractDegustacionesFromPdfBuffer,
  PdfExtractionError,
} from './src/server/pdfDegustacionesExtractor';
import {
  createRateLimiter,
  handleCreateCorporateUser,
  handleProvisionStaffAuth,
  requireAttendanceActorAuth,
  requireCadenaLogoViewerAuth,
  requireCoordinatorOrAdminAuth,
  requireFdvOrTradeAuth,
  requireIncidenciaActorAuth,
  requireSuperAdminAuth,
  requireTorreControlAuth,
} from './src/server/supabaseAdminAuth';
import {
  handleBatchAttendanceSignedUrls,
  handleUploadAttendanceEvidence,
} from './src/server/attendanceEvidencesHandler';
import {
  handleBatchFiscalReceiptSignedUrls,
  handleUploadFiscalReceipt,
} from './src/server/contraloriaInvoicesHandler';
import {
  handleBatchIncidenciaSignedUrls,
  handleUploadIncidenciaEvidence,
} from './src/server/incidenciasEvidencesHandler';
import {
  handleDeleteCadenaLogo,
  handleGetCadenaLogo,
  handleUploadCadenaLogo,
} from './src/server/cadenaLogoHandler';
import { handleCreateFdvSolicitudDegustacion } from './src/server/fdvSolicitudesHandler';
import {
  handleWeeklyTastingCutoffCron,
  requireCronSecretAuth,
} from './src/server/weeklyTastingCronHandler';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Si el servidor corre compilado (`dist-server/server.js`), la raíz del proyecto es el directorio padre
const PROJECT_ROOT =
  path.basename(__dirname) === 'dist-server' ? path.resolve(__dirname, '..') : __dirname;
const app = express();
app.disable('x-powered-by');
// Detrás de un proxy (Render, nginx, Docker) `req.ip` debe reflejar al cliente real para el limitador
const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS ?? '', 10);
if (Number.isFinite(trustProxyHops) && trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
}

const parsedPort = parseInt(process.env.PORT ?? '', 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
const CHOFER_PORT = 5174;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Resiliencia ante errores transitorios de sockets/promesas para evitar caída del servidor
process.on('uncaughtException', (err) => {
  serverLogger.error('uncaught_exception', { err });
});
process.on('unhandledRejection', (reason) => {
  serverLogger.error('unhandled_rejection', { reason });
});

function getLanIpv4(): string | null {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (alive: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(alive);
      }
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

let choferChild: ChildProcess | null = null;
let shuttingDown = false;

async function ensureChoferPwaServer() {
  if (IS_PRODUCTION || process.env.SKIP_CHOFER_SERVER === 'true') return;

  const rutaDir = path.join(__dirname, 'ruta-degustacion');
  const viteBin = path.join(rutaDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) return;

  const alreadyUp = (await isPortListening(CHOFER_PORT, '127.0.0.1')) || (await isPortListening(CHOFER_PORT, '::1'));
  if (alreadyUp) {
    console.log(`✅ RutaDegustación (Chofer PWA) ya está activo en http://localhost:${CHOFER_PORT}`);
    return;
  }

  const spawnChofer = () => {
    if (shuttingDown) return;
    choferChild = spawn(process.execPath, [viteBin, '--host', '--port', String(CHOFER_PORT)], {
      cwd: rutaDir,
      stdio: 'inherit',
      env: { ...process.env },
    });

    choferChild.on('exit', (code) => {
      choferChild = null;
      if (!shuttingDown && code !== 0) {
        console.warn(`⚠️ RutaDegustación (:5174) finalizó (código ${code}). Reintentando en 1.5s...`);
        setTimeout(() => {
          void isPortListening(CHOFER_PORT).then((up) => {
            if (!up && !shuttingDown) spawnChofer();
          });
        }, 1500);
      }
    });
  };

  spawnChofer();
}

function cleanupChildren() {
  shuttingDown = true;
  if (choferChild && !choferChild.killed) {
    choferChild.kill();
    choferChild = null;
  }
}

process.on('SIGINT', () => {
  cleanupChildren();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupChildren();
  process.exit(0);
});
process.on('exit', cleanupChildren);

// Cabeceras de seguridad (helmet + CSP en producción), CORS por origen y trazas JSON (P-04 / M-05)
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const SUPABASE_PUBLIC_ORIGIN = (() => {
  try {
    const raw = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
    return raw ? new URL(raw).origin : '';
  } catch {
    return '';
  }
})();

for (const mw of buildSecurityHeaders({
  isProduction: IS_PRODUCTION,
  extraConnectSrc: SUPABASE_PUBLIC_ORIGIN ? [SUPABASE_PUBLIC_ORIGIN] : [],
})) {
  app.use(mw);
}
app.use(buildRequestLogger(serverLogger));
app.use('/api', buildCorsMiddleware({ allowedOrigins: ALLOWED_ORIGINS, isProduction: IS_PRODUCTION }));
app.use('/api', buildApiOriginGuard({ allowedOrigins: ALLOWED_ORIGINS, isProduction: IS_PRODUCTION }));

app.use(express.json({ limit: '10mb' }));

// ============================================================================
// 1. HEALTH CHECK MÍNIMO (sin puertos, entorno ni versiones) + MÉTRICAS PROTEGIDAS
// ============================================================================
app.get('/api/health', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.get('/api/admin/metrics', requireSuperAdminAuth, (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...usageMetrics,
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
  });
});

// ============================================================================
// 1.B. MOTOR DE EXTRACCIÓN ESTRUCTURADA DE PDF CON IA (PROTEGIDO POR JWT + RATE LIMIT)
// ============================================================================
const pdfExtractRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 12,
});

const adminAuthRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 30,
});

app.post(
  '/api/degustaciones/extract-pdf',
  requireCoordinatorOrAdminAuth,
  pdfExtractRateLimiter,
  express.raw({
    type: ['application/pdf', 'application/x-pdf', 'application/octet-stream'],
    limit: '15mb',
  }),
  async (req: Request, res: Response) => {
    try {
      const pdfBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const extraction = await extractDegustacionesFromPdfBuffer(pdfBuffer);
      res.status(200).json(extraction);
    } catch (err) {
      if (err instanceof PdfExtractionError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      const message = err instanceof Error ? err.message : 'Error interno procesando el PDF.';
      res.status(500).json({
        error: message,
        code: 'INTERNAL_PDF_ERROR',
      });
    }
  }
);

// ============================================================================
// 1.C. APROVISIONAMIENTO ADMINISTRATIVO DE CUENTAS SUPABASE AUTH (SOLO SERVIDOR)
// ============================================================================
app.post(
  '/api/admin/staff-auth',
  requireCoordinatorOrAdminAuth,
  adminAuthRateLimiter,
  handleProvisionStaffAuth
);

app.post(
  '/api/admin/corporate-users',
  requireSuperAdminAuth,
  adminAuthRateLimiter,
  handleCreateCorporateUser
);

// ============================================================================
// 1.D. TAREA PROGRAMADA DE CIERRE DOMINICAL DE DEGUSTACIONES (SOLO CRON SECRET)
// ============================================================================
const weeklyCronRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 6,
});

app.post(
  '/api/cron/degustaciones-cierre-semanal',
  weeklyCronRateLimiter,
  requireCronSecretAuth,
  handleWeeklyTastingCutoffCron
);

// ============================================================================
// 1.E. EVIDENCIAS FOTOGRÁFICAS CONDICIONALES DE ASISTENCIA (STORAGE PRIVADO + ZOD + MAGIC BYTES)
// ============================================================================
const attendanceUploadRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 40,
});

const attendanceSignedUrlRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
});

app.post(
  '/api/asistencia/evidencias',
  requireAttendanceActorAuth,
  attendanceUploadRateLimiter,
  express.raw({
    type: ['image/webp', 'image/jpeg', 'image/png', 'application/octet-stream', '*/*'],
    limit: '6mb',
  }),
  handleUploadAttendanceEvidence
);

app.post(
  '/api/asistencia/evidencias/signed-urls',
  requireAttendanceActorAuth,
  attendanceSignedUrlRateLimiter,
  handleBatchAttendanceSignedUrls
);

// ============================================================================
// 1.F. INGESTA AUTENTICADA DE SOLICITUDES FDV (ZERO-ANON + ZOD + IDEMPOTENCIA ATÓMICA)
// ============================================================================
const fdvSolicitudesRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 30,
});

app.post(
  '/api/fdv/solicitudes-degustacion',
  requireFdvOrTradeAuth,
  fdvSolicitudesRateLimiter,
  handleCreateFdvSolicitudDegustacion
);

// ============================================================================
// 1.G. FACTURAS FISCALES PRIVADAS DE CONTRALORÍA (MAGIC BYTES PDF/IMG + STORAGE PRIVADO)
// ============================================================================
const contraloriaInvoiceUploadRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 30,
});

const contraloriaInvoiceSignedUrlRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
});

app.post(
  '/api/contraloria/facturas/upload',
  requireTorreControlAuth,
  contraloriaInvoiceUploadRateLimiter,
  express.raw({
    type: [
      'application/pdf',
      'application/x-pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/octet-stream',
      '*/*',
    ],
    limit: '11mb',
  }),
  handleUploadFiscalReceipt
);

app.post(
  '/api/contraloria/facturas/signed-urls',
  requireTorreControlAuth,
  contraloriaInvoiceSignedUrlRateLimiter,
  handleBatchFiscalReceiptSignedUrls
);

// ============================================================================
// 1.H. EVIDENCIAS FOTOGRÁFICAS PRIVADAS DE INCIDENCIAS EN PDV (`M-01`)
// ============================================================================
const incidenciaUploadRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 30,
});

const incidenciaSignedUrlRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
});

app.post(
  '/api/incidencias/evidencias',
  requireIncidenciaActorAuth,
  incidenciaUploadRateLimiter,
  express.raw({
    type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream', '*/*'],
    limit: '6mb',
  }),
  handleUploadIncidenciaEvidence
);

app.post(
  '/api/incidencias/evidencias/signed-urls',
  requireIncidenciaActorAuth,
  incidenciaSignedUrlRateLimiter,
  handleBatchIncidenciaSignedUrls
);

// ============================================================================
// 1.I. CO-BRANDING B2B: LOGOTIPOS SECUNDARIOS DE CADENAS COMERCIALES (v1.8.0)
//      Magic Bytes PNG/WebP <= 512 KB, Cero SVG/HTML, Bucket Privado + Rollback
// ============================================================================
const cadenaLogoWriteRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 25,
});

const cadenaLogoReadRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
});

app.post(
  '/api/cadenas-comerciales/:id/logo',
  requireCoordinatorOrAdminAuth,
  cadenaLogoWriteRateLimiter,
  express.raw({
    type: ['image/png', 'image/webp', 'image/svg+xml', 'application/octet-stream', '*/*'],
    limit: '600kb',
  }),
  handleUploadCadenaLogo
);

app.delete(
  '/api/cadenas-comerciales/:id/logo',
  requireCoordinatorOrAdminAuth,
  cadenaLogoWriteRateLimiter,
  handleDeleteCadenaLogo
);

app.get(
  '/api/cadenas-comerciales/:id/logo',
  requireCadenaLogoViewerAuth,
  cadenaLogoReadRateLimiter,
  handleGetCadenaLogo
);

// ============================================================================
// 2. API 404 + MANEJO DE ERRORES
// ============================================================================
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint no encontrado.' });
});

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) {
    serverLogger.error('unhandled_error', { path: req.path, method: req.method, err });
  }
  res.status(status).json({
    error: status === 413 ? 'El cuerpo de la solicitud es demasiado grande.' : status < 500 ? 'Solicitud inválida.' : 'Error interno del servidor.',
  });
});

// ============================================================================
// 3. VITE MIDDLEWARE & STATIC SERVING (UN SOLO EXPRESS: `/`, `/portal`, `/logistica`)
// ============================================================================
function serveSpa(mountPath: string, distPath: string, label: string): void {
  const indexFile = path.join(distPath, 'index.html');
  if (!fs.existsSync(indexFile)) {
    serverLogger.warn('spa_dist_missing', { label, distPath });
    return;
  }

  const staticMw = express.static(distPath, {
    index: false,
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (/^(sw\.js|index\.html|manifest\.json|registerSW\.js)$/i.test(base)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.use(mountPath, staticMw);
  const fallbackPattern = mountPath === '/' ? /^\/(?!api(\/|$)).*/ : new RegExp(`^${mountPath}(/.*)?$`);
  app.get(fallbackPattern, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });
}

async function startServer() {
  if (IS_PRODUCTION) {
    const distPath = path.join(PROJECT_ROOT, 'dist');
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      serverLogger.error('dist_missing', {
        hint: 'Ejecuta "npm run build" antes de iniciar en producción.',
      });
      process.exit(1);
    }
    // La PWA de logística se publica bajo `/logistica` (build con base `/logistica/`)
    serveSpa('/logistica', path.join(PROJECT_ROOT, 'ruta-degustacion', 'dist'), 'logistica');
    serveSpa('/', distPath, 'torre');
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Escucha Dual-Stack (IPv6 :: + IPv4 0.0.0.0) para que tanto localhost (::1 / 127.0.0.1) como LAN Wi-Fi respondan siempre
  const server = app.listen(PORT, () => {
    const lanIp = getLanIpv4();
    serverLogger.info('server_started', {
      port: PORT,
      env: IS_PRODUCTION ? 'production' : 'development',
      local: `http://localhost:${PORT}/`,
      ...(lanIp && !IS_PRODUCTION ? { lan: `http://${lanIp}:${PORT}/` } : {}),
    });
    void ensureChoferPwaServer();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      serverLogger.error('port_in_use', { port: PORT });
    } else {
      serverLogger.error('server_error', { err });
    }
    process.exit(1);
  });
}

startServer().catch((err) => {
  serverLogger.error('server_start_failed', { err });
  process.exit(1);
});
