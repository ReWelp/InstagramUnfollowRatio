import { UserNode } from '../model/user';
import { FollowHistoryEntry, FollowDateSource } from '../model/follow-history';
import {
  addFollowEntry,
  loadFollowHistory,
  saveFollowHistory,
} from './follow-history-manager';
import {
  estimateFollowDateFromListIndex,
  fetchFriendshipFollowDatesBatch,
  fetchUserInfoFollowDate,
} from './follow-date-resolver';
import { sleep } from './utils';

export const FOLLOWING_SNAPSHOT_STORAGE_KEY = 'iu_following_snapshot';

export interface FollowingSnapshot {
  readonly userIds: readonly string[];
  readonly scannedAt: number;
}

export interface SyncProgress {
  readonly phase: string;
  readonly current: number;
  readonly total: number;
}

function loadFollowingSnapshot(): FollowingSnapshot | null {
  try {
    const raw = localStorage.getItem(FOLLOWING_SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as FollowingSnapshot;
  } catch {
    return null;
  }
}

function saveFollowingSnapshot(snapshot: FollowingSnapshot): void {
  localStorage.setItem(FOLLOWING_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
}

function upsertEntry(
  userId: string,
  username: string,
  followedAt: number,
  source: FollowDateSource,
): void {
  addFollowEntry(userId, username, {
    followedAt,
    followDateSource: source,
  });
}

/**
 * Sync follow history for everyone in the following scan:
 * - Snapshot diff (new follows since last scan, including other devices)
 * - Instagram friendship API where available
 * - List-order estimate as fallback (newest follows first)
 */
export async function syncFollowHistoryFromFollowingList(
  results: readonly UserNode[],
  scanCompletedAt: number,
  onProgress?: (progress: SyncProgress) => void,
): Promise<number> {
  if (results.length === 0) {
    return 0;
  }

  const history = loadFollowHistory() || { entries: [] };
  const knownIds = new Set(history.entries.map(e => e.userId));
  const prevSnapshot = loadFollowingSnapshot();
  const prevIds = new Set(prevSnapshot?.userIds ?? []);
  let added = 0;

  onProgress?.({ phase: 'Detecting new follows since last scan…', current: 0, total: results.length });

  // Cross-device / new follows: appeared since last snapshot
  for (let index = 0; index < results.length; index++) {
    const user = results[index];
    if (prevIds.has(user.id) || knownIds.has(user.id)) {
      continue;
    }

    const followedAt =
      index < 48
        ? scanCompletedAt - index * 60 * 60 * 1000
        : estimateFollowDateFromListIndex(index, results.length, scanCompletedAt);

    upsertEntry(user.id, user.username, followedAt, 'snapshot');
    knownIds.add(user.id);
    added++;
  }

  saveFollowingSnapshot({
    userIds: results.map(r => r.id),
    scannedAt: scanCompletedAt,
  });

  const missing = results.filter(r => !knownIds.has(r.id));
  if (missing.length === 0) {
    return added;
  }

  onProgress?.({
    phase: 'Fetching follow dates from Instagram…',
    current: 0,
    total: missing.length,
  });

  const apiLimit = Math.min(missing.length, 120);
  const apiTargets = missing.slice(0, apiLimit);
  const resolved = await fetchFriendshipFollowDatesBatch(
    apiTargets.map(r => r.id),
    (done, total) => {
      onProgress?.({
        phase: 'Fetching follow dates from Instagram…',
        current: done,
        total,
      });
    },
  );

  // Fallback: user info for a few unresolved recent entries
  const unresolvedRecent = apiTargets
    .filter(r => !resolved.has(r.id))
    .slice(0, 15);

  for (const user of unresolvedRecent) {
    const ts = await fetchUserInfoFollowDate(user.id);
    if (ts != null) {
      resolved.set(user.id, ts);
    }
    await sleep(400);
  }

  onProgress?.({
    phase: 'Estimating follow dates from list order…',
    current: 0,
    total: missing.length,
  });

  for (let i = 0; i < missing.length; i++) {
    const user = missing[i];
    const index = results.findIndex(r => r.id === user.id);
    const apiDate = resolved.get(user.id);
    const followedAt =
      apiDate ??
      estimateFollowDateFromListIndex(index >= 0 ? index : i, results.length, scanCompletedAt);

    upsertEntry(user.id, user.username, followedAt, apiDate != null ? 'api' : 'estimated');
    knownIds.add(user.id);
    added++;

    if (i > 0 && i % 50 === 0) {
      onProgress?.({
        phase: 'Estimating follow dates from list order…',
        current: i,
        total: missing.length,
      });
      await sleep(50);
    }
  }

  return added;
}

export function trackFollowNow(userId: string, username: string): void {
  upsertEntry(userId, username, Date.now(), 'manual');
}

export function getFollowEntryForUser(userId: string): FollowHistoryEntry | null {
  const history = loadFollowHistory();
  return history?.entries.find(e => e.userId === userId) ?? null;
}

export function pruneFollowHistoryToCurrentFollowing(currentUserIds: ReadonlySet<string>): void {
  const history = loadFollowHistory();
  if (!history) {
    return;
  }
  const pruned = {
    entries: history.entries.filter(e => currentUserIds.has(e.userId)),
  };
  saveFollowHistory(pruned);
}
