import { sleep } from './utils';
import { getRatioCacheEntry, setRatioCacheEntry } from './ratio-cache';
import { recordRatioFetch } from './session-guard';

const IG_APP_ID = '936619743392459';

export interface RatioCounts {
  readonly follower_count: number;
  readonly following_count: number;
  readonly fetched_at: number;
}

function buildHeaders(): Record<string, string> {
  return {
    'X-IG-App-ID': IG_APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': '*/*',
  };
}

export function isHtmlOrBlockedResponse(response: Response, bodyText: string): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return (
    bodyText.trimStart().startsWith('<') ||
    contentType.includes('text/html') ||
    response.status === 429 ||
    response.status === 403
  );
}

function parseCountsFromUserObject(user: Record<string, unknown>): Omit<RatioCounts, 'fetched_at'> | null {
  const follower =
    (user.follower_count as number | undefined) ??
    (user as { edge_followed_by?: { count?: number } }).edge_followed_by?.count;
  const following =
    (user.following_count as number | undefined) ??
    (user as { edge_follow?: { count?: number } }).edge_follow?.count;

  if (typeof follower === 'number' && typeof following === 'number') {
    return { follower_count: follower, following_count: following };
  }
  return null;
}

async function tryWebProfileInfo(username: string): Promise<Omit<RatioCounts, 'fetched_at'> | null> {
  try {
    const res = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      { headers: buildHeaders(), credentials: 'include' },
    );
    const text = await res.text();
    if (isHtmlOrBlockedResponse(res, text)) {
      return null;
    }
    const data = JSON.parse(text) as { data?: { user?: Record<string, unknown> } };
    const user = data.data?.user;
    return user ? parseCountsFromUserObject(user) : null;
  } catch {
    return null;
  }
}

async function tryUserInfo(userId: string): Promise<Omit<RatioCounts, 'fetched_at'> | null> {
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/users/${userId}/info/`, {
      headers: buildHeaders(),
      credentials: 'include',
    });
    const text = await res.text();
    if (isHtmlOrBlockedResponse(res, text)) {
      return null;
    }
    const data = JSON.parse(text) as { user?: Record<string, unknown> };
    const user = data.user;
    return user ? parseCountsFromUserObject(user) : null;
  } catch {
    return null;
  }
}

/**
 * Check if a user needs fresh ratio data.
 * Returns true if:
 * - Missing follower/following counts
 * - No timestamp recorded (old data without cache)
 * - The persistent localStorage cache has no valid entry for this user
 *
 * NOTE: The 4-hour freshness check is now handled by the localStorage cache
 * (getRatioCacheEntry returns null for stale entries). The ratio_last_fetched
 * field on UserNode is kept for backward-compat but is no longer the sole source
 * of truth.
 */
export function needsRatioRefresh(user: {
  id: string;
  follower_count?: number;
  following_count?: number;
  ratio_last_fetched?: number;
}): boolean {
  // Check the persistent cache first — this is the fast path on re-runs
  const cached = getRatioCacheEntry(user.id);
  if (cached) return false;

  // Fall back to in-memory state for users fetched in the current session
  if (user.follower_count == null || user.following_count == null) return true;
  if (user.ratio_last_fetched == null) return true;

  return false;
}

/**
 * Fetch follower/following counts for a user.
 *
 * - First checks the localStorage cache (4-hour TTL).
 * - If cached and fresh, returns immediately without any network request.
 * - Otherwise hits Instagram's API with two fallback endpoints.
 * - Successful results are written back to the localStorage cache.
 * - Honours the session-guard daily limit; if the limit is hit, the caller
 *   should surface the warning to the user and pause.
 */
export async function fetchUserRatioCounts(
  userId: string,
  username: string,
): Promise<{ counts: RatioCounts | null; rateLimited: boolean; fromCache: boolean }> {
  // ── 1. Cache hit ───────────────────────────────────────────────────────────
  const cached = getRatioCacheEntry(userId);
  if (cached) {
    return {
      counts: cached,
      rateLimited: false,
      fromCache: true,
    };
  }

  // ── 2. Session guard check ─────────────────────────────────────────────────
  const guard = recordRatioFetch();
  if (!guard.ok) {
    // Hard daily limit — tell the caller to stop
    return { counts: null, rateLimited: true, fromCache: false };
  }
  // Apply any progressive extra delay suggested by the guard
  if (guard.extraDelayMs > 0) {
    await sleep(guard.extraDelayMs);
  }

  // ── 3. Live fetch ──────────────────────────────────────────────────────────
  const fromProfile = await tryWebProfileInfo(username);
  if (fromProfile) {
    const counts: RatioCounts = { ...fromProfile, fetched_at: Date.now() };
    setRatioCacheEntry(userId, fromProfile);
    return { counts, rateLimited: false, fromCache: false };
  }

  const fromInfo = await tryUserInfo(userId);
  if (fromInfo) {
    const counts: RatioCounts = { ...fromInfo, fetched_at: Date.now() };
    setRatioCacheEntry(userId, fromInfo);
    return { counts, rateLimited: false, fromCache: false };
  }

  // Second attempt after brief pause (transient errors)
  await sleep(500 + Math.random() * 500);
  const retryProfile = await tryWebProfileInfo(username);
  if (retryProfile) {
    const counts: RatioCounts = { ...retryProfile, fetched_at: Date.now() };
    setRatioCacheEntry(userId, retryProfile);
    return { counts, rateLimited: false, fromCache: false };
  }

  const retryInfo = await tryUserInfo(userId);
  if (retryInfo) {
    const counts: RatioCounts = { ...retryInfo, fetched_at: Date.now() };
    setRatioCacheEntry(userId, retryInfo);
    return { counts, rateLimited: false, fromCache: false };
  }

  return { counts: null, rateLimited: true, fromCache: false };
}

export interface RatioEnrichmentResult {
  readonly enriched: number;
  readonly failed: number;
  readonly skipped: number;
  readonly fromCache: number;
  readonly rateLimited: boolean;
}