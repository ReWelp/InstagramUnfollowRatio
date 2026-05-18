import React from "react";
import { assertUnreachable, getCurrentPageUnfollowers, getMaxPage, getUsersForDisplay, isWithoutProfilePicture } from "../utils/utils";
import { State } from "../model/state";
import { UserNode } from "../model/user";
import { WHITELISTED_RESULTS_STORAGE_KEY } from "../constants/constants";
import { hasBadRatio } from "../ratio";
import { RatioBadge } from "./RatioBadge";
import { addTestFollowEntry, cleanupOldFollows, exportFollowHistory, importFollowHistory } from "../utils/follow-history-manager";
import { getUnfollowReasonBadge } from "../utils/auto-unfollow-logic";
import { FOLLOW_HISTORY_STORAGE_KEY, FollowHistoryEntry } from "../model/follow-history";
import { getFollowEntryForUser } from "../utils/follow-date-sync";


export interface SearchingProps {
  state: State;
  setState: (state: State) => void;
  scanningPaused: boolean;
  pauseScan: () => void;
  handleScanFilter: (e: React.ChangeEvent<HTMLInputElement>) => void;
  toggleUser: (checked: boolean, user: UserNode) => void;
  UserCheckIcon: React.FC;
  UserUncheckIcon: React.FC;
  onSyncFollowHistory: () => void;
  onTrackFollow: (user: UserNode) => void;
  onRetryRatioFetch: () => void;
}

// Hidden file input ref for import
let importFileInput: HTMLInputElement | null = null;

function formatFollowAge(entry: FollowHistoryEntry): string {
  const hours = (Date.now() - entry.followedAt) / (1000 * 60 * 60);
  const estimated = entry.followDateSource === "estimated";
  const prefix = estimated ? "~" : "";
  if (hours < 1) {
    return `${prefix}<1h`;
  }
  if (hours < 48) {
    return `${prefix}${Math.round(hours)}h`;
  }
  return `${prefix}${Math.round(hours / 24)}d`;
}

export const Searching = ({
  state,
  setState,
  scanningPaused,
  pauseScan,
  handleScanFilter,
  toggleUser,
  UserCheckIcon,
  UserUncheckIcon,
  onSyncFollowHistory,
  onTrackFollow,
  onRetryRatioFetch,
}: SearchingProps) => {
  if (state.status !== "scanning") {
    return null;
  }

  const autoUnfollowIds = new Set(state.unfollowCandidates.map(c => c.user.id));
  const usersForDisplay = getUsersForDisplay(
    state.results,
    state.whitelistedResults,
    state.currentTab,
    state.searchTerm,
    state.filter,
    autoUnfollowIds,
  );

  const bumpFollowHistory = () => {
    setState({
      ...state,
      followHistoryVersion: state.followHistoryVersion + 1,
    });
  };
  let currentLetter = "";

  const onNewLetter = (firstLetter: string) => {
    currentLetter = firstLetter;
    return <div className="alphabet-character">{currentLetter}</div>;
  };

  return (
    <section className="flex">
      <aside className="app-sidebar">
        <div className="sidebar-content">
          <menu className="sidebar-filters-grid">
            <p>Filter</p>
            <label className="badge m-small">
              <input
                type="checkbox"
                name="showNonFollowers"
                checked={state.filter.showNonFollowers}
                onChange={handleScanFilter}
              />
              &nbsp;Non-Followers
            </label>
            <label className="badge m-small">
              <input
                type="checkbox"
                name="showFollowers"
                checked={state.filter.showFollowers}
                onChange={handleScanFilter}
              />
              &nbsp;Followers
            </label>
            <label className="badge m-small">
              <input
                type="checkbox"
                name="showVerified"
                checked={state.filter.showVerified}
                onChange={handleScanFilter}
              />
              &nbsp;Verified
            </label>
            <label className="badge m-small">
              <input
                type="checkbox"
                name="showPrivate"
                checked={state.filter.showPrivate}
                onChange={handleScanFilter}
              />
              &nbsp;Private
            </label>
            <label className="badge m-small">
              <input
                type="checkbox"
                name="showWithOutProfilePicture"
                checked={state.filter.showWithOutProfilePicture}
                onChange={handleScanFilter}
              />
              &nbsp;No Pic
            </label>
          </menu>

          {/* Ratio Filter Section */}
          <div style={{ padding: "8px 0" }}>
            <div style={{ 
              border: "none", 
              borderTop: "1px solid rgba(255,255,255,0.1)", 
              margin: "8px 0" 
            }} />
            
            <label className="badge m-small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={state.filter.showBadRatioOnly}
                onChange={(e) => {
                  if (state.status !== "scanning") return;
                  if (state.selectedResults.length > 0 && !confirm("Changing filter options will clear selected users")) {
                    return;
                  }
                  setState({ 
                    ...state, 
                    selectedResults: [],
                    filter: { ...state.filter, showBadRatioOnly: e.currentTarget.checked }
                  });
                }}
              />
              🔴 Bad Ratio Only
            </label>

            {state.filter.showBadRatioOnly && (
              <div
                style={{
                  padding: "8px 10px",
                  background: "rgba(255,59,48,0.08)",
                  border: "1px solid rgba(255,59,48,0.2)",
                  borderRadius: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  marginTop: 8,
                }}
              >
                <span style={{ fontSize: "0.78rem", color: "rgba(255,255,255,0.6)" }}>
                  Flag if <strong style={{ color: "#fff" }}>Followers ÷ Following</strong> is below:
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="range"
                    min={0.1}
                    max={3}
                    step={0.1}
                    value={state.filter.badRatioThreshold}
                    onChange={(e) => {
                      if (state.status !== "scanning") return;
                      setState({ 
                        ...state, 
                        filter: { ...state.filter, badRatioThreshold: parseFloat(e.currentTarget.value) }
                      });
                    }}
                    style={{ flex: 1, accentColor: "#ff3b30" }}
                  />
                  <span
                    style={{
                      minWidth: 36,
                      textAlign: "center",
                      fontWeight: 700,
                      color: "#ff3b30",
                      fontSize: "0.9rem",
                    }}
                  >
                    {state.filter.badRatioThreshold.toFixed(1)}
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                  <span style={{
                    fontSize: "0.7rem",
                    padding: "2px 6px",
                    borderRadius: 10,
                    background: state.filter.badRatioThreshold > 0.3 ? "#ff3b3022" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${state.filter.badRatioThreshold > 0.3 ? "#ff3b30" : "rgba(255,255,255,0.1)"}`,
                    color: state.filter.badRatioThreshold > 0.3 ? "#ff3b30" : "rgba(255,255,255,0.35)",
                  }}>
                    Very Bad (&lt; 0.3)
                  </span>
                  <span style={{
                    fontSize: "0.7rem",
                    padding: "2px 6px",
                    borderRadius: 10,
                    background: state.filter.badRatioThreshold > 0.3 && state.filter.badRatioThreshold <= 1.0 ? "#ff9f0a22" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${state.filter.badRatioThreshold > 0.3 && state.filter.badRatioThreshold <= 1.0 ? "#ff9f0a" : "rgba(255,255,255,0.1)"}`,
                    color: state.filter.badRatioThreshold > 0.3 && state.filter.badRatioThreshold <= 1.0 ? "#ff9f0a" : "rgba(255,255,255,0.35)",
                  }}>
                    Bad (0.3–1.0)
                  </span>
                  <span style={{
                    fontSize: "0.7rem",
                    padding: "2px 6px",
                    borderRadius: 10,
                    background: state.filter.badRatioThreshold > 1.0 ? "#ffd60a22" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${state.filter.badRatioThreshold > 1.0 ? "#ffd60a" : "rgba(255,255,255,0.1)"}`,
                    color: state.filter.badRatioThreshold > 1.0 ? "#ffd60a" : "rgba(255,255,255,0.35)",
                  }}>
                    Okay (1.0–2.0)
                  </span>
                  <span style={{
                    fontSize: "0.7rem",
                    padding: "2px 6px",
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: "rgba(255,255,255,0.35)",
                  }}>
                    Good (2.0+)
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="auto-unfollow-section">
            <div style={{
              border: "none",
              borderTop: "1px solid rgba(255,255,255,0.1)",
              margin: "8px 0",
            }} />
            <label className="badge m-small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={state.filter.showAutoUnfollowOnly}
                onChange={(e) => {
                  if (state.status !== "scanning") return;
                  if (state.selectedResults.length > 0 && !confirm("Changing filter options will clear selected users")) {
                    return;
                  }
                  setState({
                    ...state,
                    selectedResults: [],
                    filter: { ...state.filter, showAutoUnfollowOnly: e.currentTarget.checked },
                  });
                }}
              />
              🔴 Auto-Unfollow Only
            </label>
            <p className="auto-unfollow-hint">
              Syncs follow dates from your following list (API + order estimate). Works for follows before install or on other devices.
            </p>
            <button
              type="button"
              className="button-secondary"
              style={{ width: "100%", marginTop: 6 }}
              onClick={onSyncFollowHistory}
              disabled={state.percentage < 100}
            >
              🔄 Sync Follow Dates
            </button>
            <button
              type="button"
              className="button-secondary"
              style={{ width: "100%", marginTop: 6 }}
              onClick={onRetryRatioFetch}
              disabled={state.percentage < 100}
            >
              📊 Retry Ratios
            </button>
          </div>

          <div className="sidebar-buttons-grid">
            <button
              className="button-secondary danger-text"
              onClick={() => {
                const candidateUsers = state.unfollowCandidates.map(c => c.user);
                const currentIds = new Set(state.selectedResults.map(u => u.id));
                const toAdd = candidateUsers.filter(u => !currentIds.has(u.id));
                setState({ ...state, selectedResults: [...state.selectedResults, ...toAdd] });
              }}
              disabled={state.unfollowCandidates.length === 0}
            >
              ⚡ Select Auto-Unfollow
            </button>
            <button
              className="button-secondary"
              onClick={() => {
                const verifiedUsers = usersForDisplay.filter(u => u.is_verified);
                const currentIds = new Set(state.selectedResults.map(u => u.id));
                const toAdd = verifiedUsers.filter(u => !currentIds.has(u.id));
                setState({ ...state, selectedResults: [...state.selectedResults, ...toAdd] });
              }}
            >
              Verified
            </button>
            <button
              className="button-secondary"
              onClick={() => {
                const privateUsers = usersForDisplay.filter(u => u.is_private);
                const currentIds = new Set(state.selectedResults.map(u => u.id));
                const toAdd = privateUsers.filter(u => !currentIds.has(u.id));
                setState({ ...state, selectedResults: [...state.selectedResults, ...toAdd] });
              }}
            >
              Private
            </button>
            <button
              className="button-secondary"
              onClick={() => {
                const noPicUsers = usersForDisplay.filter(u => isWithoutProfilePicture(u));
                const currentIds = new Set(state.selectedResults.map(u => u.id));
                const toAdd = noPicUsers.filter(u => !currentIds.has(u.id));
                setState({ ...state, selectedResults: [...state.selectedResults, ...toAdd] });
              }}
            >
              No Pic
            </button>
            <button
              className="button-secondary danger-text"
              onClick={() => {
                const badRatioUsers = usersForDisplay.filter(u => 
                  hasBadRatio(u.follower_count, u.following_count, state.filter.badRatioThreshold)
                );
                const currentIds = new Set(state.selectedResults.map(u => u.id));
                const toAdd = badRatioUsers.filter(u => !currentIds.has(u.id));
                setState({ ...state, selectedResults: [...state.selectedResults, ...toAdd] });
              }}
            >
              🔴 Bad Ratio
            </button>
            <button
              className="button-secondary danger-text"
              onClick={() => setState({ ...state, selectedResults: [] })}
            >
              Clear
            </button>
            <button
              className="button-secondary"
              onClick={() => {
                if (usersForDisplay.length === 0) return;
                const testUser = usersForDisplay[0];
                addTestFollowEntry(testUser.id, testUser.username, 25, true);
                alert(`Test: ${testUser.username} marked as followed 25h ago (posted, no followback)`);
                bumpFollowHistory();
              }}
            >
              🧪 Test 25h
            </button>
            <button
              className="button-secondary"
              onClick={() => {
                if (usersForDisplay.length === 0) return;
                const testUser = usersForDisplay[0];
                addTestFollowEntry(testUser.id, testUser.username, 50, false);
                alert(`Test: ${testUser.username} marked as followed 50h ago (48h timeout)`);
                bumpFollowHistory();
              }}
            >
              🧪 Test 50h
            </button>
            {/* Follow History Management */}
            <div style={{ 
              border: "none", 
              borderTop: "1px solid rgba(255,255,255,0.1)", 
              margin: "8px 0" 
            }} />
            <p style={{ fontSize: "0.75rem", color: "rgba(255,255,255,0.4)", marginBottom: "6px" }}>
              Follow History
            </p>
            <button
              className="button-secondary"
              onClick={() => {
                exportFollowHistory();
              }}
              title="Export follow history to a JSON file for backup"
            >
              📥 Export History
            </button>
            <button
              className="button-secondary"
              onClick={() => {
                importFileInput?.click();
              }}
              title="Import follow history from a backup JSON file"
            >
              📤 Import History
            </button>
            <input
              ref={(el) => { importFileInput = el; }}
              type="file"
              accept=".json"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (!file) return;
                importFollowHistory(
                  file,
                  (count) => {
                    alert(`Imported ${count} entries from backup`);
                    bumpFollowHistory();
                  },
                  (error) => {
                    alert(`Import failed: ${error}`);
                  }
                );
                e.currentTarget.value = "";
              }}
            />
            <button
              className="button-secondary danger-text"
              onClick={() => {
                const confirmed = confirm(
                  '⚠️ Clear Follow History?\n\n' +
                  'This will PERMANENTLY DELETE all tracked follow dates.\n\n' +
                  'What this does:\n' +
                  '• Removes all records of when you followed people\n' +
                  '• Resets auto-unfollow timers (24h/48h rules)\n' +
                  '• You will need to re-sync follow dates to use auto-unfollow\n\n' +
                  '💡 Tip: Export your history first if you want to keep a backup!\n\n' +
                  'Are you sure you want to proceed?'
                );
                if (!confirmed) return;
                localStorage.removeItem(FOLLOW_HISTORY_STORAGE_KEY);
                cleanupOldFollows(0);
                alert('Follow history cleared');
                bumpFollowHistory();
              }}
              title="Permanently delete all tracked follow dates (use Export first to backup)"
            >
              🗑️ Clear History
            </button>
          </div>
          <div className="sidebar-stats">
            <p>Displayed: {usersForDisplay.length}</p>
            <p>Total Scanned: {state.results.length}</p>
            <p className="whitelist-counter">
              <span className="whitelist-badge">★</span> Whitelisted: {state.whitelistedResults.length}
            </p>
            <p className="unfollow-counter">
              <span className="unfollow-badge">⚠️</span> Auto-Unfollow: {state.unfollowCandidates.length}
            </p>
            {state.unfollowCandidates.length > 0 && (
              <div className="unfollow-stats">
                <span className="stat-title">Candidates by rule</span>
                <div className="unfollow-stats-grid">
                  <span>📵 24h: {state.unfollowCandidates.filter(c => c.reason === 'POSTED_NO_FOLLOWBACK').length}</span>
                  <span>⏰ 48h: {state.unfollowCandidates.filter(c => c.reason === 'TIMEOUT_NO_FOLLOWBACK').length}</span>
                  <span>🎯 Ego: {state.unfollowCandidates.filter(c => c.reason === 'EGO_AURA').length}</span>
                </div>
              </div>
            )}
          </div>

          {state.percentage === 100 && (
            <div className="sidebar-summary">
              <h4>Scan Summary</h4>
              <div className="summary-grid">
                <div className="summary-item">
                  <span>Non-Followers</span>
                  <strong>{state.results.filter(u => !u.follows_viewer).length}</strong>
                </div>
                <div className="summary-item">
                  <span>Verified</span>
                  <strong>{state.results.filter(u => u.is_verified).length}</strong>
                </div>
                <div className="summary-item">
                  <span>Private</span>
                  <strong>{state.results.filter(u => u.is_private).length}</strong>
                </div>
              </div>
            </div>
          )}
          <div className="sidebar-footer-controls">
            <button
              className="button-control button-pause"
              onClick={pauseScan}
            >
              {scanningPaused ? "Resume" : "Pause"}
            </button>
            <div className="sidebar-pagination">
              <div className="pagination-controls">
                <a
                  onClick={() => {
                    if (state.page - 1 > 0) {
                      setState({
                        ...state,
                        page: state.page - 1,
                      });
                    }
                  }}
                >
                  ❮
                </a>
                <span>
                  {state.page}/{getMaxPage(usersForDisplay)}
                </span>
                <a
                  onClick={() => {
                    if (state.page < getMaxPage(usersForDisplay)) {
                      setState({
                        ...state,
                        page: state.page + 1,
                      });
                    }
                  }}
                >
                  ❯
                </a>
              </div>
            </div>
          </div>
        </div>
        <button
          className="unfollow"
          onClick={() => {
            if (!confirm("Are you sure?")) {
              return;
            }
            //TODO TEMP until types are properly fixed
            // @ts-ignore
            setState(prevState => {
              if (prevState.status !== "scanning") {
                return prevState;
              }
              if (prevState.selectedResults.length === 0) {
                alert("Must select at least a single user to unfollow");
                return prevState;
              }
              const newState: State = {
                ...prevState,
                status: "unfollowing",
                percentage: 0,
                unfollowLog: [],
                filter: {
                  showSucceeded: true,
                  showFailed: true,
                },
              };
              return newState;
            });
          }}
        >
          UNFOLLOW ({state.selectedResults.length})
        </button>
      </aside>
      <article className="results-container">
        <nav className="tabs-container">
          <div
            className={`tab ${state.currentTab === "non_whitelisted" ? "tab-active" : ""}`}
            onClick={() => {
              if (state.currentTab === "non_whitelisted") {
                return;
              }
              setState({
                ...state,
                currentTab: "non_whitelisted",
                selectedResults: [],
              });
            }}
          >
            Non-Whitelisted
          </div>
          <div
            className={`tab ${state.currentTab === "whitelisted" ? "tab-active" : ""}`}
            onClick={() => {
              if (state.currentTab === "whitelisted") {
                return;
              }
              setState({
                ...state,
                currentTab: "whitelisted",
                selectedResults: [],
              });
            }}
          >
            Whitelisted
          </div>
        </nav>
        {getCurrentPageUnfollowers(usersForDisplay, state.page).map(user => {
          const firstLetter = user.username.substring(0, 1).toUpperCase();
          const candidate = state.unfollowCandidates.find(c => c.user.id === user.id);
          const isUnfollowCandidate = candidate != null;
          const reasonBadge = candidate ? getUnfollowReasonBadge(candidate.reason) : null;
          const followEntry = getFollowEntryForUser(user.id);
          return (
            <>
              {firstLetter !== currentLetter && onNewLetter(firstLetter)}
              <label className={`result-item ${isUnfollowCandidate ? 'unfollow-pulse' : ''}`}>
                <div className="flex grow align-center">
                  <div
                    className={`avatar-container ${isUnfollowCandidate ? 'avatar-unfollow-pulse' : ''}`}
                    onClick={(e: React.MouseEvent<HTMLDivElement>) => {
                      // Prevent selecting result when trying to add to whitelist.
                      e.preventDefault();
                      e.stopPropagation();
                      let whitelistedResults: readonly UserNode[] = [];
                      switch (state.currentTab) {
                        case "non_whitelisted":
                          whitelistedResults = [...state.whitelistedResults, user];
                          break;

                        case "whitelisted":
                          whitelistedResults = state.whitelistedResults.filter(
                            result => result.id !== user.id,
                          );
                          break;

                        default:
                          assertUnreachable(state.currentTab);
                      }
                      localStorage.setItem(
                        WHITELISTED_RESULTS_STORAGE_KEY,
                        JSON.stringify(whitelistedResults),
                      );
                      setState({ ...state, whitelistedResults });
                    }}
                  >
                    <img
                      className="avatar"
                      alt={user.username}
                      src={user.profile_pic_url}
                    />
                    <div className="avatar-preview">
                      <img src={user.profile_pic_url.replace("s150x150/", "s320x320/")} alt={user.username} />
                    </div>
                    <span className="avatar-icon-overlay-container">
                      {state.currentTab === "non_whitelisted" ? (
                        <UserCheckIcon />
                      ) : (
                        <UserUncheckIcon />
                      )}
                    </span>
                  </div>
                  <div className="flex column m-medium">
                    <a
                      className="fs-xlarge"
                      target="_blank"
                      href={`/${user.username}`}
                      rel="noreferrer"
                    >
                      {user.username}
                    </a>
                    <span className="fs-medium">{user.full_name}</span>
                    {followEntry && (
                      <span className="follow-tracked-label" title={`Source: ${followEntry.followDateSource ?? "unknown"}`}>
                        Followed {formatFollowAge(followEntry)} ago
                        {followEntry.followDateSource === "estimated" ? " (est.)" : ""}
                      </span>
                    )}
                  </div>
                  {user.is_verified && <div className="verified-badge">✔</div>}
                  {user.is_private && (
                    <div className="flex justify-center w-100">
                      <span className="private-indicator">Private</span>
                    </div>
                  )}
                  <RatioBadge
                    followerCount={user.follower_count}
                    followingCount={user.following_count}
                  />
                  {reasonBadge && (
                    <div className="unfollow-reason-badge" title={`Auto-unfollow: ${reasonBadge.text}`}>
                      {reasonBadge.emoji} {reasonBadge.text}
                    </div>
                  )}
                </div>
                <div className="flex align-center gap-small">
                  <button
                    type="button"
                    className={`track-follow-button ${followEntry ? "tracked" : ""}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onTrackFollow(user);
                    }}
                    title={followEntry
                      ? "Reset follow time to now (restarts 24h/48h timers — confirm)"
                      : "Track as followed now"}
                  >
                    {followEntry ? "✓" : "+"}
                  </button>
                  <button
                    className={`whitelist-star-button ${state.currentTab === "whitelisted" ? "active" : ""}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      let whitelistedResults: readonly UserNode[] = [];
                      if (state.whitelistedResults.some(r => r.id === user.id)) {
                        // Remove from whitelist
                        whitelistedResults = state.whitelistedResults.filter(r => r.id !== user.id);
                      } else {
                        // Add to whitelist
                        whitelistedResults = [...state.whitelistedResults, user];
                      }
                      
                      localStorage.setItem(
                        WHITELISTED_RESULTS_STORAGE_KEY,
                        JSON.stringify(whitelistedResults),
                      );
                      setState({ ...state, whitelistedResults });
                    }}
                    title={state.whitelistedResults.some(r => r.id === user.id) ? "Remove from whitelist" : "Add to whitelist"}
                  >
                    ★
                  </button>
                  <input
                    className="account-checkbox"
                    type="checkbox"
                    checked={state.selectedResults.indexOf(user) !== -1}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => toggleUser(e.currentTarget.checked, user)}
                  />
                </div>
              </label>
            </>
          );
        })}
      </article>
    </section>
  );
};
