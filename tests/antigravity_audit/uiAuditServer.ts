import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  MOCK_CRON_SECRET,
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
  startLocalMockInfra,
} from './localMockInfra';

const UI_PORT = 4177;

async function startIsolatedUiAuditServer() {
  const mock = await startLocalMockInfra(0);

  // Add extra rich mock rows for thorough UI filter & edge-case testing
  mock.tables.surveys.push(
    {
      id: '88884444-4444-4444-8444-444444444444',
      type: 'Degustacion',
      date: '2026-11-16',
      fecha_evento: '2026-11-16',
      store: 'SUPERMERCADO ÉXITO CAÑADA',
      promoter: 'María Piña',
      product: 'ESPALDA AHUMADA ASTURIAS',
      creatorId: 'CARLOS PEÑA',
      leido_trade: false,
      en_historial: false,
      comments: JSON.stringify({
        isTasting: true,
        source: 'vendedor_app',
        degustacionId: 'deg-local-004',
        cliente: 'SUPERMERCADO ÉXITO CAÑADA',
        clienteCodigo: 'CLI-004',
        vendedor: 'CARLOS PEÑA',
        ruta: 'LA CAÑADA',
        date: '2026-11-16',
        turno: 'TARDE',
        products: ['ESPALDA AHUMADA ASTURIAS'],
        kilos: 4,
        personasEstimadas: 110,
        estado: 'APROBADA',
        status: 'aprobada',
        promotoraAsignada: 'María Piña',
        promotoraId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promotoraEmail: 'maria.pina@promotoras.codizulca.local',
        leido_trade: false,
      }),
      created_at: '2026-11-16T10:30:00.000Z',
    }
  );

  // Configure process env strictly to local mock
  process.env.AUDIT_MOCK_BASE_URL = mock.baseUrl;
  process.env.VITE_SUPABASE_URL = mock.baseUrl;
  process.env.SUPABASE_URL = mock.baseUrl;
  process.env.VITE_SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
  process.env.SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
  process.env.VITE_SUPABASE_MASTER_URL = '';
  process.env.VITE_SUPABASE_MASTER_ANON_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;
  process.env.CRON_SECRET = MOCK_CRON_SECRET;

  // Create isolated Vite envDir so root .env.local is NEVER read by Vite
  const isolatedEnvDir = path.resolve('tests/antigravity_audit/env_isolated');
  fs.mkdirSync(isolatedEnvDir, { recursive: true });
  fs.writeFileSync(
    path.join(isolatedEnvDir, '.env'),
    [
      `VITE_SUPABASE_URL=${mock.baseUrl}`,
      `VITE_SUPABASE_ANON_KEY=${MOCK_PUBLIC_ANON_KEY}`,
      `VITE_SUPABASE_MASTER_URL=`,
      `VITE_SUPABASE_MASTER_ANON_KEY=`,
    ].join('\n'),
    'utf8'
  );

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', env: 'audit_isolated_mock', mockUrl: mock.baseUrl });
  });

  const browserGuardScript = `
<script>
(function() {
  const MOCK_BASE = ${JSON.stringify(mock.baseUrl)};
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    let urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input && input.url ? input.url : ''));
    try {
      const u = new URL(urlStr, window.location.origin);
      const host = u.hostname.toLowerCase();
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
        if (host === 'dashboard-fdv-planificador.onrender.com' || host === 've.dolarapi.com') {
          return origFetch(MOCK_BASE + '/mock-external/' + host + u.pathname + u.search, init);
        }
        return Promise.reject(new Error('[BROWSER_AUDIT_FIREWALL] Blocked external origin: ' + host));
      }
    } catch (_e) {}
    return origFetch(input, init);
  };
  // Intercept WebSocket to prevent external WS connections and cleanly stub local HTTP mock WS
  const OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const u = new URL(String(url), window.location.origin);
    const h = u.hostname.toLowerCase();
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]') {
      throw new Error('[BROWSER_AUDIT_FIREWALL] Blocked external WebSocket: ' + h);
    }
    if (String(u.port) === ${JSON.stringify(String(mock.port))}) {
      // Return inert mock WebSocket for local HTTP PostgREST mock so Vite HMR WebSocket still uses real OrigWS
      const fake = {
        readyState: 1,
        protocol: '',
        extensions: '',
        bufferedAmount: 0,
        binaryType: 'blob',
        url: String(url),
        send: function() {},
        close: function() { this.readyState = 3; },
        addEventListener: function() {},
        removeEventListener: function() {},
      };
      setTimeout(() => { if (typeof fake.onopen === 'function') fake.onopen(new Event('open')); }, 10);
      return fake;
    }
    return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
  };
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;
})();
</script>`;

  const vite = await createViteServer({
    envDir: isolatedEnvDir,
    server: { middlewareMode: true },
    appType: 'spa',
    plugins: [
      {
        name: 'antigravity-audit-browser-egress-guard',
        transformIndexHtml(html) {
          return html.replace('<head>', `<head>${browserGuardScript}`);
        },
      },
    ],
  });

  app.use(vite.middlewares);

  const server = app.listen(UI_PORT, '127.0.0.1', () => {
    console.log(`✅ Isolated Audit UI Server ready at http://localhost:${UI_PORT}/ (Mock DB: ${mock.baseUrl})`);
  });

  const shutdown = async () => {
    server.close();
    await vite.close();
    await mock.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void startIsolatedUiAuditServer();
