export interface AutoUnfollowSettings {
  enable24hRule: boolean;
  enable48hRule: boolean;
  enableEgoAuraRule: boolean;
  threshold24h: number;  // hours
  threshold48h: number;  // hours
  egoRatioThreshold: number;
}

export const DEFAULT_AUTO_UNFOLLOW_SETTINGS: AutoUnfollowSettings = {
  enable24hRule: true,
  enable48hRule: true,
  enableEgoAuraRule: true,
  threshold24h: 24,
  threshold48h: 48,
  egoRatioThreshold: 1.0,
};
