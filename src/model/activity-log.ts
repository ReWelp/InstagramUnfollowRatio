export type ActivityAction = 'follow' | 'unfollow';

export interface ActivityLogEntry {
  readonly id: string;
  readonly action: ActivityAction;
  readonly userId: string;
  readonly username: string;
  readonly timestamp: number;
  readonly undoable?: boolean;
}

export interface ActivityLog {
  readonly entries: readonly ActivityLogEntry[];
}
