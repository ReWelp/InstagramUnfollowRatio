export interface FollowHistoryEntry {
  readonly userId: string;
  readonly username: string;
  readonly followedAt: number; // timestamp
  readonly hasPostedSinceFollow?: boolean; // tracked if we can detect posts
  readonly lastCheckedAt?: number; // last time we checked for posts
}

export interface FollowHistory {
  readonly entries: readonly FollowHistoryEntry[];
}

export const FOLLOW_HISTORY_STORAGE_KEY = 'instagram_follow_history';
