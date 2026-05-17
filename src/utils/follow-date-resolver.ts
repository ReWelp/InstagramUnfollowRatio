import { sleep } from './utils';

const IG_APP_ID = '936619743392459';
const MS_DAY = 24 * 60 * 60 * 1000;

function normalizeTimestamp(value: number): number {
  // Unix seconds vs milliseconds
  return value > 1e12 ? value : value * 1000;
}

function extractTimestampFromRecord(record: Record<string, unknown>): number | null {
  const keys = [
    'following_timestamp',
    'followed_at',
    'created_at',
    'timestamp',
    'followed_at_time',
  ];

  for (const key of keys) {
    const val = record[key];
    if (typeof val === 'number' && val > 1e9) {
      return normalizeTimestamp(val);
    }
    if (typeof val === 'string') {
      const parsed = Date.parse(val);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function walkForTimestamp(obj: unknown, depth = 0): number | null {
  if (depth > 4 || obj == null) {
    return null;
  }

  if (typeof obj === 'object' && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    const direct = extractTimestampFromRecord(record);
    if (direct != null) {
      return direct;
    }

    for (const value of Object.values(record)) {
      const nested = walkForTimestamp(value, depth + 1);
      if (nested != null) {
        return nested;
      }
    }
  }

  return null;
}

/** Instagram following lists are roughly reverse-chronological (newest first). */
export function estimateFollowDateFromListIndex(
  index: number,
  totalCount: number,
  scanCompletedAt: number,
): number {
  const total = Math.max(totalCount, 1);
  // Spread estimates across up to 30 days for the full list
  const maxSpreadMs = Math.min(30 * MS_DAY, total * 60 * 60 * 1000);
  const msPerIndex = maxSpreadMs / total;
  return scanCompletedAt - index * msPerIndex;
}

export async function fetchFriendshipFollowDate(userId: string): Promise<number | null> {
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/friendships/show/${userId}/`, {
      headers: { 'X-IG-App-ID': IG_APP_ID },
      credentials: 'include',
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return walkForTimestamp(data);
  } catch {
    return null;
  }
}

export async function fetchFriendshipFollowDatesBatch(
  userIds: readonly string[],
  onBatchDone?: (done: number, total: number) => void,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const BATCH_SIZE = 30;

  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(
        `https://www.instagram.com/api/v1/friendships/show_many/?user_ids=${batch.join(',')}`,
        {
          headers: { 'X-IG-App-ID': IG_APP_ID },
          credentials: 'include',
        },
      );

      if (res.ok) {
        const data = await res.json();
        const statuses =
          (data as { friendship_statuses?: Record<string, unknown> }).friendship_statuses ?? data;

        for (const id of batch) {
          const status = (statuses as Record<string, unknown>)[id];
          const ts = walkForTimestamp(status);
          if (ts != null) {
            result.set(id, ts);
          }
        }
      }
    } catch {
      // continue with estimates for this batch
    }

    onBatchDone?.(Math.min(i + BATCH_SIZE, userIds.length), userIds.length);

    if (i + BATCH_SIZE < userIds.length) {
      await sleep(600 + Math.random() * 400);
    }
  }

  return result;
}

export async function fetchUserInfoFollowDate(userId: string): Promise<number | null> {
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/users/${userId}/info/`, {
      headers: { 'X-IG-App-ID': IG_APP_ID },
      credentials: 'include',
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    const user = (data as { user?: unknown }).user;
    return walkForTimestamp(user) ?? walkForTimestamp(
      (user as Record<string, unknown> | undefined)?.friendship_status,
    );
  } catch {
    return null;
  }
}
