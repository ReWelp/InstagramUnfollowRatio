import React from "react";
import { getRatioResult, formatCoefficient } from "../ratio";

export interface RatioBadgeProps {
  followerCount?: number;
  followingCount?: number;
}

export const RatioBadge: React.FC<RatioBadgeProps> = ({ followerCount, followingCount }) => {
  const ratio = getRatioResult(followerCount, followingCount);

  // Don't clutter cards when data isn't available
  if (ratio.tier === "unknown") return null;

  const isBad = ratio.tier === "very_bad" || ratio.tier === "bad";

  return (
    <div
      title={`Followers: ${followerCount?.toLocaleString() ?? "?"} · Following: ${followingCount?.toLocaleString() ?? "?"} · Ratio: ${formatCoefficient(ratio.coefficient)}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 20,
        fontSize: "0.72rem",
        fontWeight: 600,
        letterSpacing: "-0.01em",
        background: `${ratio.color}18`,
        border: `1px solid ${ratio.color}55`,
        color: ratio.color,
        // Pulse animation for bad accounts to draw attention
        animation: isBad ? "ratio-pulse 2s ease-in-out infinite" : "none",
        flexShrink: 0,
      }}
    >
      {ratio.emoji} {formatCoefficient(ratio.coefficient)}
    </div>
  );
};
