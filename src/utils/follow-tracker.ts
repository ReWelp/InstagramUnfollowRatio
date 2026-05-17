import {
  addFollowEntry,
  removeFollowEntry,
  saveFollowHistory,
  loadFollowHistory,
} from './follow-history-manager';

const FOLLOW_URL_PATTERN = /\/web\/friendships\/(\d+)\/follow\/?/;
const UNFOLLOW_URL_PATTERN = /\/web\/friendships\/(\d+)\/unfollow\/?/;

let trackerInstalled = false;
const historyChangeListeners = new Set<() => void>();

export function onFollowHistoryChange(listener: () => void): () => void {
  historyChangeListeners.add(listener);
  return () => historyChangeListeners.delete(listener);
}

function notifyHistoryChange(): void {
  historyChangeListeners.forEach(listener => listener());
}

function extractUserIdFromUrl(url: string, pattern: RegExp): string | null {
  try {
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    const match = path.match(pattern);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function recordFollow(userId: string, username?: string): void {
  const history = addFollowEntry(userId, username ?? userId, { followDateSource: 'live' });
  saveFollowHistory(history);
  console.info(`[FollowTracker] Recorded follow: ${username ?? userId}`);
  notifyHistoryChange();
}

export function recordUnfollow(userId: string): void {
  const history = removeFollowEntry(userId);
  saveFollowHistory(history);
  console.info(`[FollowTracker] Removed follow history for user ${userId}`);
  notifyHistoryChange();
}

export function installFollowTracker(): void {
  if (trackerInstalled || typeof window === 'undefined') {
    return;
  }
  trackerInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    const response = await originalFetch(input, init);

    if (method === 'POST' && response.ok) {
      const followUserId = extractUserIdFromUrl(url, FOLLOW_URL_PATTERN);
      if (followUserId) {
        recordFollow(followUserId);
      }

      const unfollowUserId = extractUserIdFromUrl(url, UNFOLLOW_URL_PATTERN);
      if (unfollowUserId) {
        recordUnfollow(unfollowUserId);
      }
    }

    return response;
  };

  console.info('[FollowTracker] Installed — follows/unfollows on Instagram will be tracked automatically');
}

export function getTrackedFollowCount(): number {
  return loadFollowHistory()?.entries.length ?? 0;
}
