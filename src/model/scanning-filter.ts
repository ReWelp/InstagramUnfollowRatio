export interface ScanningFilter {
  readonly showNonFollowers: boolean;
  readonly showFollowers: boolean;
  readonly showVerified: boolean;
  readonly showPrivate: boolean;
  readonly showWithOutProfilePicture: boolean;
  readonly showBadRatioOnly: boolean;
  readonly badRatioThreshold: number;
  readonly showAutoUnfollowOnly: boolean;
}
