import { sleep } from './utils';

const IG_APP_ID = '936619743392459';
const RATIO_CACHE_HOURS = 4; // 4 hours cache
const RATIO_CACHE_MS = RATIO_CACHE_HOURS * 60 * 60 * 1000;

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
 * Check if a user needs fresh ratio data
 * Returns true if:
 * - Missing follower/following counts
 * - No timestamp recorded (old data)
 * - Timestamp older than RATIO_CACHE_HOURS hours
 */
export function needsRatioRefresh(user: { follower_count?: number; following_count?: number; ratio_last_fetched?: number }): boolean {
  // Never had data
  if (user.follower_count == null || user.following_count == null) {
    return true;
  }

  // No timestamp (data from before this update)
  if (user.ratio_last_fetched == null) {
    return true;
  }

  // Data is stale (older than cache hours)
  if (Date.now() - user.ratio_last_fetched > RATIO_CACHE_MS) {
    return true;
  }

  return false;
}

export async function fetchUserRatioCounts(
  userId: string,
  username: string,
): Promise<{ counts: RatioCounts | null; rateLimited: boolean }> {
  const fromProfile = await tryWebProfileInfo(username);
  if (fromProfile) {
    return {
      counts: {
        ...fromProfile,
        fetched_at: Date.now(),
      },
      rateLimited: false,
    };
  }

  const fromInfo = await tryUserInfo(userId);
  if (fromInfo) {
    return {
      counts: {
        ...fromInfo,
        fetched_at: Date.now(),
      },
      rateLimited: false,
    };
  }

  // Second profile attempt after brief pause (transient errors)
  await sleep(300);
  const retryProfile = await tryWebProfileInfo(username);
  if (retryProfile) {
    return {
      counts: {
        ...retryProfile,
        fetched_at: Date.now(),
      },
      rateLimited: false,
    };
  }

  const retryInfo = await tryUserInfo(userId);
  if (retryInfo) {
    return {
      counts: {
        ...retryInfo,
        fetched_at: Date.now(),
      },
      rateLimited: false,
    };
  }

  return { counts: null, rateLimited: true };
}

export interface RatioEnrichmentResult {
  readonly enriched: number;
  readonly failed: number;
  readonly skipped: number;
  readonly rateLimited: boolean;
}