/**
 * Short in-memory TTL cache for hot staff polls (RID 20261111320000).
 * Kill-switch: call_queue_settings flag.perf_poll_cache_off = "1" disables
 * caches and write-throttles (absent or any other value = ON).
 * Never changes journal_mode / synchronous.
 */
import { queryRow } from "./crm-db";

export const PERF_POLL_CACHE_OFF_FLAG = "flag.perf_poll_cache_off";

const FLAG_TTL_MS = 5_000;
let flagOnUntil = 0;
let flagOnCached = true;

export function perfPollCacheOn(): boolean {
  const now = Date.now();
  if (now < flagOnUntil) return flagOnCached;
  let on = true;
  try {
    on = queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [PERF_POLL_CACHE_OFF_FLAG])?.value !== "1";
  } catch { on = true; }
  flagOnCached = on;
  flagOnUntil = now + FLAG_TTL_MS;
  return on;
}

/** Test hook: pin or clear the kill-switch cache. */
export function __setPerfPollCacheOn(on: boolean | null): void {
  if (on == null) { flagOnUntil = 0; return; }
  flagOnCached = on;
  flagOnUntil = Date.now() + 60 * 60_000;
}

type Entry = { exp: number; value: unknown };
const store = new Map<string, Entry>();
let hits = 0, misses = 0, sets = 0;

export function perfCacheGet<T>(key: string): T | undefined {
  if (!perfPollCacheOn()) return undefined;
  const e = store.get(key);
  if (!e) { misses++; return undefined; }
  if (e.exp <= Date.now()) { store.delete(key); misses++; return undefined; }
  hits++;
  return e.value as T;
}

export function perfCacheSet<T>(key: string, value: T, ttlMs: number): T {
  if (!perfPollCacheOn() || ttlMs <= 0) return value;
  sets++;
  store.set(key, { exp: Date.now() + ttlMs, value });
  return value;
}

export function perfCacheGetOrSet<T>(key: string, ttlMs: number, fn: () => T): T {
  const hit = perfCacheGet<T>(key);
  if (hit !== undefined) return hit;
  return perfCacheSet(key, fn(), ttlMs);
}

export function perfCacheInvalidate(prefix = ""): number {
  if (!prefix) { const n = store.size; store.clear(); return n; }
  let n = 0;
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) { store.delete(k); n++; }
  return n;
}

/** Skip a write if the same key was written less than minMs ago (kill-switch off → never skip). */
const lastWrite = new Map<string, number>();
export function perfWriteFresh(key: string, minMs: number): boolean {
  if (!perfPollCacheOn() || minMs <= 0) return true;
  const now = Date.now();
  if ((lastWrite.get(key) ?? 0) + minMs > now) return false;
  lastWrite.set(key, now);
  return true;
}

export function __perfCacheStats() { return { hits, misses, sets, size: store.size }; }
export function __perfCacheReset(): void {
  store.clear(); lastWrite.clear(); hits = 0; misses = 0; sets = 0; flagOnUntil = 0;
}
