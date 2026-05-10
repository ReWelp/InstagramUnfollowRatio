// Ratio logic for follower/following scoring
// See ratio.ts in attachments

export type RatioTier =
  | "very_bad"
  | "bad"
  | "okay"
  | "good"
  | "great"
  | "unknown";

export interface RatioResult {
  tier: RatioTier;
  coefficient: number | null;
  label: string;
  emoji: string;
  color: string;
}

export const RATIO_THRESHOLDS = {
  VERY_BAD: 0.3,
  BAD: 1.0,
  OKAY: 2.0,
  GOOD: 5.0,
} as const;

export const DEFAULT_BAD_RATIO_THRESHOLD = 1.0;

export function getRatioResult(
  followerCount: number | undefined,
  followingCount: number | undefined
): RatioResult {
  if (followerCount == null || followingCount == null) {
    return {
      tier: "unknown",
      coefficient: null,
      label: "Unknown",
      emoji: "❓",
      color: "#8e8e93",
    };
  }
  if (followingCount === 0) {
    return {
      tier: "great",
      coefficient: Infinity,
      label: "Influencer",
      emoji: "⭐",
      color: "#ffd60a",
    };
  }
  const C = followerCount / followingCount;
  if (C < RATIO_THRESHOLDS.VERY_BAD) {
    return { tier: "very_bad", coefficient: C, label: "Very Bad", emoji: "🔴", color: "#ff3b30" };
  }
  if (C < RATIO_THRESHOLDS.BAD) {
    return { tier: "bad", coefficient: C, label: "Bad", emoji: "🟠", color: "#ff9f0a" };
  }
  if (C < RATIO_THRESHOLDS.OKAY) {
    return { tier: "okay", coefficient: C, label: "Okay", emoji: "🟡", color: "#ffd60a" };
  }
  if (C < RATIO_THRESHOLDS.GOOD) {
    return { tier: "good", coefficient: C, label: "Good", emoji: "🟢", color: "#34c759" };
  }
  return { tier: "great", coefficient: C, label: "Influencer", emoji: "⭐", color: "#ffd60a" };
}

export function hasBadRatio(
  followerCount: number | undefined,
  followingCount: number | undefined,
  threshold = DEFAULT_BAD_RATIO_THRESHOLD
): boolean {
  if (followerCount == null || followingCount == null) return false;
  if (followingCount === 0) return false;
  return followerCount / followingCount < threshold;
}

export function formatCoefficient(c: number | null): string {
  if (c === null) return "N/A";
  if (!isFinite(c)) return "∞";
  return c.toFixed(2);
}
