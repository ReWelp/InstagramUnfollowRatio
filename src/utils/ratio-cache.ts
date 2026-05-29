/**
 * Persistent ratio cache backed by localStorage.
 *
 * Stores follower_count / following_count / fetched_at per Instagram user ID
 * so that when the script is re-run within RATIO_CACHE_HOURS the counts are
 * injected immediately — no extra API requests needed.
 */

const RATIO_CACHE_KEY = 'iu_ratio_cache';
const RATIO_CACHE_HOURS = 4;
const RATIO_CACHE_MS = RATIO_CACHE_HOURS * 60 * 60 * 1000;

export interface RatioCacheEntry {
  readonly follower_count: number;
  readonly following_count: number;
  readonly fetched_at: number;
}

type RatioCacheStore = Record<string, RatioCacheEntry>;

// ─── Internal helpers ────────────────────────────────────────────────────────

function loadStore(): RatioCacheStore {
  try {
    const raw = localStorage.getItem(RATIO_CACHE_KEY);
    return raw ? (JSON.parse(raw) as RatioCacheStore) : {};
  } catch {
    return {};
  }
}

function saveStore(store: RatioCacheStore): void {
  try {
    localStorage.setItem(RATIO_CACHE_KEY, JSON.stringify(store));
  } catch {
    // Storage quota or private-browsing denial — silently ignore
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read cached ratio data for a user ID.
 * Returns null if the entry is missing or older than RATIO_CACHE_HOURS.
 */
export function getRatioCacheEntry(userId: string): RatioCacheEntry | null {
  const store = loadStore();
  const entry = store[userId];
  if (!entry) return null;
  if (Date.now() - entry.fetched_at > RATIO_CACHE_MS) return null;
  return entry;
}

/**
 * Write / overwrite a ratio cache entry for a user ID.
 */
export function setRatioCacheEntry(
  userId: string,
  data: Omit<RatioCacheEntry, 'fetched_at'>,
): void {
  const store = loadStore();
  store[userId] = { ...data, fetched_at: Date.now() };
  saveStore(store);
}

/**
 * Bulk-write multiple entries (more efficient than calling setRatioCacheEntry
 * in a loop because it only serialises/deserialises localStorage once).
 */
export function bulkSetRatioCacheEntries(
  entries: ReadonlyArray<{ userId: string; follower_count: number; following_count: number }>,
): void {
  const store = loadStore();
  const now = Date.now();
  for (const e of entries) {
    store[e.userId] = {
      follower_count: e.follower_count,
      following_count: e.following_count,
      fetched_at: now,
    };
  }
  saveStore(store);
}

/**
 * Purge all entries older than RATIO_CACHE_HOURS to keep storage lean.
 * Call this once on script start-up.
 */
export function pruneRatioCache(): void {
  const store = loadStore();
  const cutoff = Date.now() - RATIO_CACHE_MS;
  let changed = false;
  for (const key of Object.keys(store)) {
    if (store[key].fetched_at < cutoff) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) saveStore(store);
}

/**
 * How many entries are currently cached (unexpired).
 */
export function getRatioCacheSize(): number {
  const store = loadStore();
  const cutoff = Date.now() - RATIO_CACHE_MS;
  return Object.values(store).filter(e => e.fetched_at >= cutoff).length;
}
