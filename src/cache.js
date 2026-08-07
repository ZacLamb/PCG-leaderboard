/**
 * In-memory cache with single-flight de-duplication.
 *
 * A full location sync can be dozens of paginated GHL calls. Without
 * single-flight, five dashboards refreshing at once would trigger five
 * concurrent syncs and blow the rate limit. Concurrent callers share one
 * in-flight promise instead.
 */

const store = new Map();   // key -> { value, expiresAt }
const inFlight = new Map(); // key -> Promise

export async function cached(key, ttlMs, producer) {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return { value: hit.value, fresh: false, cachedAt: hit.cachedAt };
  }

  if (inFlight.has(key)) {
    const value = await inFlight.get(key);
    return { value, fresh: false, cachedAt: Date.now() };
  }

  const promise = (async () => {
    try {
      const value = await producer();
      store.set(key, { value, expiresAt: Date.now() + ttlMs, cachedAt: Date.now() });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  const value = await promise;
  return { value, fresh: true, cachedAt: Date.now() };
}

/** Serve stale data rather than erroring if GHL is briefly unreachable. */
export function getStale(key) {
  const hit = store.get(key);
  return hit ? hit.value : null;
}

export function invalidate(keyPrefix) {
  for (const key of store.keys()) {
    if (key.startsWith(keyPrefix)) store.delete(key);
  }
}

export function cacheMeta(key) {
  const hit = store.get(key);
  if (!hit) return null;
  return { cachedAt: hit.cachedAt, expiresAt: hit.expiresAt };
}
