import { sleep } from './utils';

const IG_APP_ID = '936619743392459';

export interface RatioCounts {
  readonly follower_count: number;
  readonly following_count: number;
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

function parseCountsFromUserObject(user: Record<string, unknown>): RatioCounts | null {
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

async function tryWebProfileInfo(username: string): Promise<RatioCounts | null> {
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

async function tryUserInfo(userId: string): Promise<RatioCounts | null> {
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

export async function fetchUserRatioCounts(
  userId: string,
  username: string,
): Promise<{ counts: RatioCounts | null; rateLimited: boolean }> {
  const fromProfile = await tryWebProfileInfo(username);
  if (fromProfile) {
    return { counts: fromProfile, rateLimited: false };
  }

  const fromInfo = await tryUserInfo(userId);
  if (fromInfo) {
    return { counts: fromInfo, rateLimited: false };
  }

  // Second profile attempt after brief pause (transient errors)
  await sleep(300);
  const retryProfile = await tryWebProfileInfo(username);
  if (retryProfile) {
    return { counts: retryProfile, rateLimited: false };
  }

  const retryInfo = await tryUserInfo(userId);
  if (retryInfo) {
    return { counts: retryInfo, rateLimited: false };
  }

  return { counts: null, rateLimited: true };
}

export interface RatioEnrichmentResult {
  readonly enriched: number;
  readonly failed: number;
  readonly skipped: number;
  readonly rateLimited: boolean;
}
