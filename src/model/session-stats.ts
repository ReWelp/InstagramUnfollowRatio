export interface SessionStats {
  sessionStartedAt: number;
  followsMade: number;
  unfollowsMade: number;
  scansCompleted: number;
  rateLimitHits: number;
}

export function createEmptySessionStats(): SessionStats {
  return {
    sessionStartedAt: Date.now(),
    followsMade: 0,
    unfollowsMade: 0,
    scansCompleted: 0,
    rateLimitHits: 0,
  };
}
