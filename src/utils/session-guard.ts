/**
 * Session guard — tracks daily API request counts and enforces cooldowns
 * to prevent Instagram from rate-limiting / warning the account.
 *
 * All state is persisted in localStorage so it survives page reloads and
 * multiple script runs throughout the same day.
 *
 * Strategy:
 *  - Count every "scan page fetch" and every "ratio fetch" separately.
 *  - If a daily limit is exceeded → force a HARD_COOLDOWN_MS pause and warn.
 *  - If the user has run the script many times today → lengthen delays.
 *  - Expose helpers that main.tsx can call before each request.
 */

const SESSION_GUARD_KEY = 'iu_session_guard';

// ─── Limits ───────────────────────────────────────────────────────────────────
/** Max following-list pages to fetch per day before forcing a hard cooldown. */
const MAX_SCAN_PAGES_PER_DAY = 300;
/** Max ratio-profile fetches per day. */
const MAX_RATIO_FETCHES_PER_DAY = 200;
/** Max times the whole script can be "Run" in one day without extra warning. */
const MAX_RUNS_PER_DAY = 6;

/** How long to pause (ms) when a daily limit is reached. */
const HARD_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

/** Minimum gap (ms) between two consecutive script runs. */
const MIN_RUN_GAP_MS = 8 * 60 * 1000; // 8 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionGuardData {
  /** ISO date string "YYYY-MM-DD" for the current day bucket. */
  day: string;
  scanPages: number;
  ratioFetches: number;
  runCount: number;
  lastRunAt: number;
  /** ms of extra per-request jitter to add when usage is high. */
  jitterMultiplier: number;
}

export interface SessionGuardStatus {
  ok: boolean;
  /** Human-readable warning if ok === false. */
  warning?: string;
  /** Suggested extra delay in ms before the next request. */
  extraDelayMs: number;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function load(): SessionGuardData {
  try {
    const raw = localStorage.getItem(SESSION_GUARD_KEY);
    if (raw) {
      const data = JSON.parse(raw) as SessionGuardData;
      // Reset counts on a new calendar day
      if (data.day !== today()) {
        return freshDay();
      }
      return data;
    }
  } catch { /* ignore */ }
  return freshDay();
}

function freshDay(): SessionGuardData {
  return {
    day: today(),
    scanPages: 0,
    ratioFetches: 0,
    runCount: 0,
    lastRunAt: 0,
    jitterMultiplier: 1,
  };
}

function save(data: SessionGuardData): void {
  try {
    localStorage.setItem(SESSION_GUARD_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

/** Recalculate jitter multiplier based on daily usage. */
function computeJitter(data: SessionGuardData): number {
  // Scale from 1× at 0 runs up to 4× at MAX_RUNS_PER_DAY runs
  const runRatio = Math.min(data.runCount / MAX_RUNS_PER_DAY, 1);
  const pageRatio = Math.min(data.scanPages / MAX_SCAN_PAGES_PER_DAY, 1);
  const ratio = Math.max(runRatio, pageRatio);
  return 1 + ratio * 3; // 1×..4×
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call once when the user hits "Run".
 * Returns a status object; if ok===false the caller should warn + optionally abort.
 */
export function recordScriptRun(): SessionGuardStatus {
  const data = load();
  const now = Date.now();

  // Too soon after previous run?
  const gap = now - data.lastRunAt;
  if (data.lastRunAt > 0 && gap < MIN_RUN_GAP_MS) {
    const waitSec = Math.ceil((MIN_RUN_GAP_MS - gap) / 1000);
    return {
      ok: false,
      warning: `⚠️ You ran the script ${Math.round(gap / 1000)}s ago. Please wait ${waitSec}s before re-running to avoid Instagram warnings.`,
      extraDelayMs: MIN_RUN_GAP_MS - gap,
    };
  }

  data.runCount += 1;
  data.lastRunAt = now;
  data.jitterMultiplier = computeJitter(data);
  save(data);

  if (data.runCount > MAX_RUNS_PER_DAY) {
    return {
      ok: true, // still proceed but warn loudly
      warning: `⚠️ You've run this script ${data.runCount} times today (safe limit: ${MAX_RUNS_PER_DAY}). Instagram may flag unusual activity. Consider stopping for today.`,
      extraDelayMs: 5000 * (data.runCount - MAX_RUNS_PER_DAY),
    };
  }

  return { ok: true, extraDelayMs: 0 };
}

/**
 * Call after each following-list page is fetched.
 * Returns how many extra ms to sleep before the next request.
 */
export function recordScanPage(): SessionGuardStatus {
  const data = load();
  data.scanPages += 1;
  data.jitterMultiplier = computeJitter(data);
  save(data);

  if (data.scanPages > MAX_SCAN_PAGES_PER_DAY) {
    return {
      ok: false,
      warning: `🛑 Daily scan limit reached (${data.scanPages} pages). Pausing ${HARD_COOLDOWN_MS / 60000} min to protect your account.`,
      extraDelayMs: HARD_COOLDOWN_MS,
    };
  }

  // Progressive slow-down as we approach the limit
  const ratio = data.scanPages / MAX_SCAN_PAGES_PER_DAY;
  const extra = ratio > 0.7 ? Math.round(ratio * 3000 * data.jitterMultiplier) : 0;
  return { ok: true, extraDelayMs: extra };
}

/**
 * Call before each ratio-profile fetch.
 * Returns how many extra ms to sleep (or a hard-stop warning).
 */
export function recordRatioFetch(): SessionGuardStatus {
  const data = load();
  data.ratioFetches += 1;
  save(data);

  if (data.ratioFetches > MAX_RATIO_FETCHES_PER_DAY) {
    return {
      ok: false,
      warning: `🛑 Daily ratio-fetch limit reached (${data.ratioFetches}). Wait 15–30 min before retrying ratios.`,
      extraDelayMs: HARD_COOLDOWN_MS,
    };
  }

  const ratio = data.ratioFetches / MAX_RATIO_FETCHES_PER_DAY;
  const extra = ratio > 0.6 ? Math.round(ratio * 2000 * data.jitterMultiplier) : 0;
  return { ok: true, extraDelayMs: extra };
}

/**
 * Get current day stats for display in the UI.
 */
export function getSessionStats(): SessionGuardData {
  return load();
}

/**
 * Extra random jitter (ms) based on current daily usage.
 * Add this on top of your normal sleeps.
 */
export function sessionJitter(): number {
  const data = load();
  return Math.round(Math.random() * 1000 * data.jitterMultiplier);
}
