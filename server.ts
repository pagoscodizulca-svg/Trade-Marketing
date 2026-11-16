import express, { NextFunction, Request, Response } from 'express';
import { ChildProcess, spawn } from 'child_process';
import dotenv from 'dotenv';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractDegustacionesFromPdfBuffer,
  PdfExtractionError,
} from './src/server/pdfDegustacionesExtractor';
import {
  createRateLimiter,
  handleProvisionStaffAuth,
  requireAttendanceActorAuth,
  requireCoordinatorOrAdminAuth,
} from './src/server/supabaseAdminAuth';
import {
  handleBatchAttendanceSignedUrls,
  handleUploadAttendanceEvidence,
} from './src/server/attendanceEvidencesHandler';
import {
  handleWeeklyTastingCutoffCron,
  requireCronSecretAuth,
} from './src/server/weeklyTastingCronHandler';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

const parsedPort = parseInt(process.env.PORT ?? '', 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
const CHOFER_PORT = 5174;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Resiliencia ante errores transitorios de sockets/promesas para evitar caída del servidor
process.on('uncaughtException', (err) => {
  console.error('⚠️ [Resiliencia] Excepción no controlada capturada:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [Resiliencia] Promesa rechazada no manejada:', reason);
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

app.use(express.json({ limit: '10mb' }));

// ============================================================================
// 1. HEALTH CHECK
// ============================================================================
app.get('/api/health', async (_req: Request, res: Response) => {
  const choferOnline = await isPortListening(CHOFER_PORT);
  res.json({
    status: 'ok',
    env: IS_PRODUCTION ? 'production' : 'development',
    ports: {
      tradetrack: PORT,
      rutaDegustacion: CHOFER_PORT,
      rutaDegustacionActive: choferOnline,
    },
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
// 2. API 404 + MANEJO DE ERRORES
// ============================================================================
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint no encontrado.' });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) console.error('Error no controlado:', err);
  res.status(status).json({
    error: status === 413 ? 'El cuerpo de la solicitud es demasiado grande.' : status < 500 ? 'Solicitud inválida.' : 'Error interno del servidor.',
  });
});

// ============================================================================
// 3. VITE MIDDLEWARE & STATIC SERVING (DUAL-STACK IPv4 + IPv6)
// ============================================================================
async function startServer() {
  if (IS_PRODUCTION) {
    const distPath = path.join(__dirname, 'dist');
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      console.error('❌ No se encontró "dist/index.html". Ejecuta "npm run build" antes de iniciar en producción.');
      process.exit(1);
    }
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
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
    console.log(`🚀 Codizulca TradeTrack activo en:`);
    console.log(`   ➜ Local:   http://localhost:${PORT}/`);
    if (lanIp) {
      console.log(`   ➜ Red LAN: http://${lanIp}:${PORT}/`);
    }
    void ensureChoferPwaServer();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ El puerto ${PORT} ya está en uso. Define otro con la variable PORT.`);
    } else {
      console.error('❌ Error del servidor:', err);
    }
    process.exit(1);
  });
}

startServer().catch((err) => {
  console.error('❌ No se pudo iniciar el servidor:', err);
  process.exit(1);
});
