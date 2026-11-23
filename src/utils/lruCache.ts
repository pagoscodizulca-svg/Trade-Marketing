/**
 * Caché LRU (Least Recently Used) acotada con expiración por TTL y métricas livianas.
 * Implementación pura en TypeScript (O(1) en lectura/escritura/expulsión mediante Map ordenado)
 * sin dependencias externas.
 */

export interface LRUCacheOptions {
  maxItems: number;
  ttlMs: number;
  now?: () => number;
}

export interface LRUCacheMetrics {
  size: number;
  maxItems: number;
  ttlMs: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export function resolvePositiveIntConfig(options: {
  nodeEnvKey: string;
  viteEnvKey?: string;
  fallback: number;
  min?: number;
  max?: number;
  envOverride?: Record<string, string | undefined>;
}): number {
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  const nodeSource = options.envOverride ?? (typeof process !== 'undefined' ? process.env : undefined);
  const nodeRaw = nodeSource?.[options.nodeEnvKey];
  const viteRaw =
    options.viteEnvKey && typeof import.meta !== 'undefined'
      ? (import.meta as { env?: Record<string, string | undefined> }).env?.[options.viteEnvKey]
      : undefined;

  const raw = nodeRaw ?? viteRaw;
  if (raw !== undefined && String(raw).trim() !== '') {
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= min) {
      return Math.min(max, parsed);
    }
  }
  return Math.min(max, Math.max(min, Math.trunc(options.fallback)));
}

export class LRUCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private maxItems: number;
  private ttlMs: number;
  private readonly now: () => number;

  private hitsCount = 0;
  private missesCount = 0;
  private evictionsCount = 0;

  constructor(options: LRUCacheOptions) {
    if (!Number.isFinite(options.maxItems) || options.maxItems < 1) {
      throw new RangeError('LRUCache maxItems debe ser un entero >= 1.');
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 1) {
      throw new RangeError('LRUCache ttlMs debe ser un número >= 1.');
    }
    this.maxItems = Math.trunc(options.maxItems);
    this.ttlMs = Math.trunc(options.ttlMs);
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.missesCount += 1;
      return undefined;
    }

    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      this.missesCount += 1;
      this.evictionsCount += 1;
      return undefined;
    }

    // Marcar como usada recientemente moviéndola al final del Map
    this.store.delete(key);
    this.store.set(key, entry);
    this.hitsCount += 1;
    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      this.evictionsCount += 1;
      return false;
    }
    return true;
  }

  set(key: K, value: V, ttlMsOverride?: number): void {
    const effectiveTtl =
      ttlMsOverride !== undefined && Number.isFinite(ttlMsOverride) && ttlMsOverride >= 1
        ? Math.trunc(ttlMsOverride)
        : this.ttlMs;

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxItems) {
      // Primero liberar expiradas antes de expulsar entradas vigentes
      this.purgeExpired();
      while (this.store.size >= this.maxItems) {
        const oldestKey = this.store.keys().next().value as K | undefined;
        if (oldestKey === undefined) break;
        this.store.delete(oldestKey);
        this.evictionsCount += 1;
      }
    }

    this.store.set(key, {
      value,
      expiresAt: this.now() + effectiveTtl,
    });
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  deleteWhere(predicate: (key: K, value: V) => boolean): number {
    let removed = 0;
    for (const [k, entry] of this.store.entries()) {
      if (predicate(k, entry.value)) {
        this.store.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  purgeExpired(): number {
    const currentNow = this.now();
    let purged = 0;
    for (const [k, entry] of this.store.entries()) {
      if (currentNow >= entry.expiresAt) {
        this.store.delete(k);
        this.evictionsCount += 1;
        purged += 1;
      }
    }
    return purged;
  }

  clear(): void {
    this.store.clear();
  }

  reconfigure(options: { maxItems?: number; ttlMs?: number }): void {
    if (options.maxItems !== undefined && Number.isFinite(options.maxItems) && options.maxItems >= 1) {
      this.maxItems = Math.trunc(options.maxItems);
      while (this.store.size > this.maxItems) {
        const oldestKey = this.store.keys().next().value as K | undefined;
        if (oldestKey === undefined) break;
        this.store.delete(oldestKey);
        this.evictionsCount += 1;
      }
    }
    if (options.ttlMs !== undefined && Number.isFinite(options.ttlMs) && options.ttlMs >= 1) {
      this.ttlMs = Math.trunc(options.ttlMs);
    }
  }

  getMetrics(): LRUCacheMetrics {
    return {
      size: this.store.size,
      maxItems: this.maxItems,
      ttlMs: this.ttlMs,
      hits: this.hitsCount,
      misses: this.missesCount,
      evictions: this.evictionsCount,
    };
  }

  resetMetrics(): void {
    this.hitsCount = 0;
    this.missesCount = 0;
    this.evictionsCount = 0;
  }
}
