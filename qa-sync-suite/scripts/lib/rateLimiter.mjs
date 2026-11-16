/**
 * Controlador de ritmo (1-2 peticiones/segundo) y health-check con backoff exponencial
 * para respetar Render Free/Starter Tier y Supabase Free Tier.
 */
export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRequestPacer(requestsPerSecond = 1) {
  const safeRps = Math.min(2, Math.max(0.5, Number(requestsPerSecond) || 1));
  const minIntervalMs = Math.ceil(1000 / safeRps);
  let lastRequestAt = 0;

  return {
    minIntervalMs,
    async pace() {
      const now = Date.now();
      const elapsed = now - lastRequestAt;
      if (lastRequestAt > 0 && elapsed < minIntervalMs) {
        await sleepMs(minIntervalMs - elapsed);
      }
      lastRequestAt = Date.now();
    },
  };
}

/**
 * Health-check HTTP único con backoff exponencial (timeout total de hasta 60s)
 * hacia `https://dashboard-fdv-planificador.onrender.com/api/health` por posible cold start.
 */
export async function checkRenderHealthWithBackoff(
  renderBaseUrl,
  { maxTotalMs = 60_000, initialDelayMs = 1_500 } = {}
) {
  const normalizedBase = String(renderBaseUrl || '').replace(/\/+$/, '');
  const healthUrl = `${normalizedBase}/api/health`;
  const startedAt = Date.now();
  let attempt = 0;
  let nextDelayMs = initialDelayMs;
  let lastStatus = null;
  let lastError = null;

  while (Date.now() - startedAt < maxTotalMs) {
    attempt += 1;
    const remainingMs = Math.max(2_000, maxTotalMs - (Date.now() - startedAt));
    const perAttemptTimeoutMs = Math.min(20_000, remainingMs);

    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });
      lastStatus = response.status;

      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        return {
          ok: true,
          url: healthUrl,
          status: response.status,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
          payload: body,
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    const elapsedAfterAttempt = Date.now() - startedAt;
    if (elapsedAfterAttempt + nextDelayMs >= maxTotalMs) {
      break;
    }

    await sleepMs(nextDelayMs);
    nextDelayMs = Math.min(12_000, nextDelayMs * 2);
  }

  return {
    ok: false,
    url: healthUrl,
    status: lastStatus,
    attempts: attempt,
    elapsedMs: Date.now() - startedAt,
    error: lastError || `HTTP ${lastStatus ?? 'TIMEOUT'}`,
  };
}
