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

/** Export follow history to a JSON file */
export function exportFollowHistory(): void {
  const history = loadFollowHistory();
  if (!history || history.entries.length === 0) {
    alert('No follow history to export');
    return;
  }

  const dataStr = JSON.stringify(history, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `follow-history-${new Date().toISOString().split('T')[0]}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Import follow history from a JSON file */
export function importFollowHistory(
  file: File,
  onSuccess: (entriesCount: number) => void,
  onError: (errorMessage: string) => void,
): void {
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const content = event.target?.result as string;
      if (!content) {
        onError('Empty file');
        return;
      }

      const imported = JSON.parse(content) as FollowHistory;

      // Validate structure
      if (!imported.entries || !Array.isArray(imported.entries)) {
        onError('Invalid file format: missing entries array');
        return;
      }

      // Validate entry structure
      const validEntries = imported.entries.filter(
        entry => entry.userId && entry.username && entry.followedAt
      );

      if (validEntries.length !== imported.entries.length) {
        onError(`Invalid entries found. ${imported.entries.length - validEntries.length} entries skipped.`);
        return;
      }

      // Merge with existing history (don't overwrite)
      const existing = loadFollowHistory() || { entries: [] };
      const existingIds = new Set(existing.entries.map(e => e.userId));
      
      let addedCount = 0;
      const mergedEntries = [...existing.entries];
      
      for (const entry of validEntries) {
        if (!existingIds.has(entry.userId)) {
          mergedEntries.push(entry);
          addedCount++;
        }
      }

      const merged = { entries: mergedEntries };
      saveFollowHistory(merged);
      onSuccess(addedCount);
    } catch (e) {
      onError(`Failed to parse file: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  };

  reader.onerror = () => {
    onError('Failed to read file');
  };

  reader.readAsText(file);
}
