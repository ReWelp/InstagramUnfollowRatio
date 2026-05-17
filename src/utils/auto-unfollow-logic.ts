import { UserNode } from '../model/user';
import { FollowHistoryEntry } from '../model/follow-history';
import { hasBadRatio } from '../ratio';

export enum UnfollowReason {
  POSTED_NO_FOLLOWBACK = 'POSTED_NO_FOLLOWBACK', // 24h + posted + no followback
  TIMEOUT_NO_FOLLOWBACK = 'TIMEOUT_NO_FOLLOWBACK', // 48h regardless
  EGO_AURA = 'EGO_AURA', // bad ratio + they followed back
}

export interface UnfollowCandidate {
  readonly user: UserNode;
  readonly reason: UnfollowReason;
  readonly followEntry: FollowHistoryEntry;
  readonly hoursSinceFollow: number;
}

export function shouldUnfollowUser(
  user: UserNode,
  followEntry: FollowHistoryEntry,
  currentFollowerCount?: number,
  currentFollowingCount?: number
): UnfollowCandidate | null {
  const hoursSinceFollow = (Date.now() - followEntry.followedAt) / (1000 * 60 * 60);
  
  // Only process if within 4 days (96 hours)
  if (hoursSinceFollow > 96) {
    return null; // Too old, requires manual intervention
  }

  // Check if they followed back
  const hasFollowedBack = user.follows_viewer;

  // Ego/Aura method: Bad ratio + they followed back + 24h since they followed back
  if (hasFollowedBack && hoursSinceFollow >= 24) {
    if (hasBadRatio(currentFollowerCount, currentFollowingCount, 1.0)) {
      return {
        user,
        reason: UnfollowReason.EGO_AURA,
        followEntry,
        hoursSinceFollow,
      };
    }
  }

  // 24 hours + they posted + no followback
  if (hoursSinceFollow >= 24 && !hasFollowedBack) {
    if (followEntry.hasPostedSinceFollow) {
      return {
        user,
        reason: UnfollowReason.POSTED_NO_FOLLOWBACK,
        followEntry,
        hoursSinceFollow,
      };
    }
  }

  // 48 hours regardless of posting + no followback
  if (hoursSinceFollow >= 48 && !hasFollowedBack) {
    return {
      user,
      reason: UnfollowReason.TIMEOUT_NO_FOLLOWBACK,
      followEntry,
      hoursSinceFollow,
    };
  }

  return null;
}

export function getUnfollowCandidates(
  users: readonly UserNode[],
  followHistory: readonly FollowHistoryEntry[]
): UnfollowCandidate[] {
  const candidates: UnfollowCandidate[] = [];
  
  for (const user of users) {
    const followEntry = followHistory.find(entry => entry.userId === user.id);
    if (!followEntry) continue;
    
    const candidate = shouldUnfollowUser(
      user,
      followEntry,
      user.follower_count,
      user.following_count
    );
    
    if (candidate) {
      candidates.push(candidate);
    }
  }
  
  return candidates;
}

export function getUnfollowReasonLabel(reason: UnfollowReason): string {
  switch (reason) {
    case UnfollowReason.POSTED_NO_FOLLOWBACK:
      return 'Posted but no followback (24h)';
    case UnfollowReason.TIMEOUT_NO_FOLLOWBACK:
      return 'Timeout no followback (48h)';
    case UnfollowReason.EGO_AURA:
      return 'Ego/Aura (bad ratio)';
    default:
      return 'Unknown';
  }
}
