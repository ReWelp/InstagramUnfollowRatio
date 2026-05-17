import {
  FollowHistory,
  FollowHistoryEntry,
  FollowDateSource,
  FOLLOW_HISTORY_STORAGE_KEY,
} from '../model/follow-history';

export function loadFollowHistory(): FollowHistory | null {
  try {
    const stored = localStorage.getItem(FOLLOW_HISTORY_STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as FollowHistory;
  } catch (e) {
    console.error('Failed to load follow history:', e);
    return null;
  }
}

export function saveFollowHistory(history: FollowHistory): void {
  try {
    localStorage.setItem(FOLLOW_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch (e) {
    console.error('Failed to save follow history:', e);
  }
}

export function addFollowEntry(
  userId: string,
  username: string,
  options?: {
    followedAt?: number;
    hasPostedSinceFollow?: boolean;
    followDateSource?: FollowDateSource;
  },
): FollowHistory {
  const history = loadFollowHistory() || { entries: [] };
  const existing = history.entries.find(entry => entry.userId === userId);

  const newEntry: FollowHistoryEntry = {
    userId,
    username,
    followedAt: options?.followedAt ?? existing?.followedAt ?? Date.now(),
    hasPostedSinceFollow: options?.hasPostedSinceFollow ?? existing?.hasPostedSinceFollow,
    lastCheckedAt: existing?.lastCheckedAt,
    followDateSource: options?.followDateSource ?? existing?.followDateSource ?? 'live',
  };

  const entries = existing
    ? history.entries.map(entry => (entry.userId === userId ? newEntry : entry))
    : [...history.entries, newEntry];

  const updated = { entries };
  saveFollowHistory(updated);
  return updated;
}

export function removeFollowEntry(userId: string): FollowHistory {
  const history = loadFollowHistory();
  if (!history) return { entries: [] };
  const updated = {
    entries: history.entries.filter(entry => entry.userId !== userId),
  };
  saveFollowHistory(updated);
  return updated;
}

export function updateFollowEntry(userId: string, updates: Partial<FollowHistoryEntry>): FollowHistory {
  const history = loadFollowHistory();
  if (!history) return { entries: [] };
  const updated = {
    entries: history.entries.map(entry =>
      entry.userId === userId ? { ...entry, ...updates } : entry,
    ),
  };
  saveFollowHistory(updated);
  return updated;
}

export function getFollowEntry(userId: string): FollowHistoryEntry | null {
  const history = loadFollowHistory();
  if (!history) return null;
  return history.entries.find(entry => entry.userId === userId) || null;
}

export function getRecentFollows(hoursAgo: number = 96): readonly FollowHistoryEntry[] {
  const history = loadFollowHistory();
  if (!history) return [];
  const cutoffTime = Date.now() - hoursAgo * 60 * 60 * 1000;
  return history.entries.filter(entry => entry.followedAt > cutoffTime);
}

export function cleanupOldFollows(daysToKeep: number = 30): FollowHistory {
  const history = loadFollowHistory();
  if (!history) return { entries: [] };
  const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const updated = {
    entries: history.entries.filter(entry => entry.followedAt > cutoffTime),
  };
  saveFollowHistory(updated);
  return updated;
}

/** For testing: mark a user as followed N hours ago */
export function addTestFollowEntry(
  userId: string,
  username: string,
  hoursAgo: number,
  hasPosted = true,
): FollowHistory {
  return addFollowEntry(userId, username, {
    followedAt: Date.now() - hoursAgo * 60 * 60 * 1000,
    hasPostedSinceFollow: hasPosted,
  });
}
