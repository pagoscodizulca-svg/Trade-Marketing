import http from 'node:http';
import https from 'node:https';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname) {
  const clean = String(hostname || '').trim().toLowerCase();
  return LOOPBACK_HOSTS.has(clean);
}

const originalFetch = globalThis.fetch;

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function guardedAuditFetch(input, init) {
    let rawUrl = '';
    if (typeof input === 'string') {
      rawUrl = input;
    } else if (input instanceof URL) {
      rawUrl = input.toString();
    } else if (input && typeof input === 'object' && 'url' in input) {
      rawUrl = String(input.url);
    }

    const parsed = new URL(rawUrl, process.env.AUDIT_MOCK_BASE_URL || 'http://127.0.0.1');
    if (!isLoopbackHostname(parsed.hostname)) {
      const mockBase = process.env.AUDIT_MOCK_BASE_URL;
      if (
        mockBase &&
        (parsed.hostname === 'dashboard-fdv-planificador.onrender.com' ||
          parsed.hostname === 've.dolarapi.com')
      ) {
        const redirected = new URL(
          `/mock-external/${parsed.hostname}${parsed.pathname}${parsed.search}`,
          mockBase
        );
        return originalFetch(redirected.toString(), init);
      }

      throw new Error(
        `[AUDIT_EGRESS_FIREWALL] Conexión externa bloqueada por seguridad (Regla #1): ${parsed.protocol}//${parsed.hostname}`
      );
    }

    return originalFetch(input, init);
  };
}

function wrapNodeRequest(mod, protocolLabel) {
  const origRequest = mod.request;
  mod.request = function guardedRequest(...args) {
    const first = args[0];
    let host = '127.0.0.1';
    if (typeof first === 'string' || first instanceof URL) {
      const u = new URL(first.toString());
      host = u.hostname;
    } else if (first && typeof first === 'object') {
      host = first.hostname || first.host || '127.0.0.1';
      if (typeof host === 'string' && host.includes(':') && !host.startsWith('[')) {
        host = host.split(':')[0];
      }
    }
    if (!isLoopbackHostname(host)) {
      throw new Error(
        `[AUDIT_EGRESS_FIREWALL] Socket ${protocolLabel} externo bloqueado (Regla #1): ${host}`
      );
    }
    return origRequest.apply(this, args);
  };
}

wrapNodeRequest(http, 'HTTP');
wrapNodeRequest(https, 'HTTPS');
