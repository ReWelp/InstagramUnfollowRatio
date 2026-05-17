import { updateFollowEntry, saveFollowHistory } from './follow-history-manager';
import { FollowHistoryEntry } from '../model/follow-history';
import { sleep } from './utils';

const IG_APP_ID = '936619743392459';

interface FeedItem {
  readonly taken_at?: number;
}

interface UserFeedResponse {
  readonly items?: readonly FeedItem[];
}

/** Returns true if user has a post newer than followedAt, false if not, null if unknown. */
export async function checkUserPostedSince(
  userId: string,
  followedAt: number,
): Promise<boolean | null> {
  try {
    const res = await fetch(
      `https://www.instagram.com/api/v1/feed/user/${userId}/?count=3`,
      {
        headers: { 'X-IG-App-ID': IG_APP_ID },
        credentials: 'include',
      },
    );

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as UserFeedResponse;
    const items = data.items ?? [];
    if (items.length === 0) {
      return false;
    }

    const followedAtSeconds = Math.floor(followedAt / 1000);
    return items.some(item => (item.taken_at ?? 0) > followedAtSeconds);
  } catch {
    return null;
  }
}

export async function enrichFollowHistoryWithPosts(
  entries: readonly FollowHistoryEntry[],
  onUpdated?: () => void,
): Promise<void> {
  const now = Date.now();
  const needsCheck = entries.filter(entry => {
    const hoursSince = (now - entry.followedAt) / (1000 * 60 * 60);
    return hoursSince >= 20 && hoursSince <= 96 && entry.hasPostedSinceFollow == null;
  });

  for (let i = 0; i < needsCheck.length; i++) {
    const entry = needsCheck[i];
    const posted = await checkUserPostedSince(entry.userId, entry.followedAt);

    if (posted !== null) {
      const updated = updateFollowEntry(entry.userId, {
        hasPostedSinceFollow: posted,
        lastCheckedAt: now,
      });
      saveFollowHistory(updated);
      onUpdated?.();
    }

    if (i < needsCheck.length - 1) {
      await sleep(1500 + Math.random() * 1000);
    }
  }
}
