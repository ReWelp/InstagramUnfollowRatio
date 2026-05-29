import React, { ChangeEvent, useEffect, useState } from "react";
import { render } from "react-dom";
import "./styles.scss";

import { User, UserNode } from "./model/user";
import { Toast } from "./components/Toast";
import { UserCheckIcon } from "./components/icons/UserCheckIcon";
import { UserUncheckIcon } from "./components/icons/UserUncheckIcon";
import {
  DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
  DEFAULT_TIME_BETWEEN_UNFOLLOWS,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS, INSTAGRAM_HOSTNAME
} from "./constants/constants";
import {
  assertUnreachable,
  getCookie,
  getCurrentPageUnfollowers,
  getUsersForDisplay, sleep, unfollowUserUrlGenerator, urlGenerator,
} from "./utils/utils";
import { NotSearching } from "./components/NotSearching";
import { State } from "./model/state";
import { Searching } from "./components/Searching";
import { Toolbar } from "./components/Toolbar";
import { Unfollowing } from "./components/Unfollowing";
import { Timings } from "./model/timings";
import { loadWhitelist, saveWhitelist, loadTimings, saveTimings } from "./utils/whitelist-manager";
import { getRecentFollows } from "./utils/follow-history-manager";
import { getUnfollowCandidates } from "./utils/auto-unfollow-logic";
import { installFollowTracker, onFollowHistoryChange } from "./utils/follow-tracker";
import { enrichFollowHistoryWithPosts } from "./utils/post-checker";
import {
  syncFollowHistoryFromFollowingList,
  pruneFollowHistoryToCurrentFollowing,
  trackFollowNow,
  getFollowEntryForUser,
} from "./utils/follow-date-sync";
import { fetchUserRatioCounts, RatioEnrichmentResult, needsRatioRefresh } from "./utils/ratio-fetcher";
import { getRatioCacheEntry, pruneRatioCache } from "./utils/ratio-cache";
import { recordScriptRun, recordScanPage, sessionJitter, getSessionStats } from "./utils/session-guard";

// ── Startup: prune stale ratio cache entries once per page load ─────────────
pruneRatioCache();

// pause
let scanningPaused = false;

function pauseScan() {
  scanningPaused = !scanningPaused;
}

function recalculateUnfollowCandidates(results: readonly UserNode[]): ReturnType<typeof getUnfollowCandidates> {
  const recentFollows = getRecentFollows(96);
  return getUnfollowCandidates(results, recentFollows);
}

function readScanningResults(setState: (fn: (s: State) => State) => void): readonly UserNode[] {
  let results: readonly UserNode[] = [];
  setState(prev => {
    if (prev.status === "scanning") {
      results = prev.results;
    }
    return prev;
  });
  return results;
}

// Enrichment function to fetch follower/following counts per user - FAST batch processing
async function enrichWithRatioData(
  setState: (fn: (s: State) => State) => void,
  setToast: (toast: { show: boolean; text: string }) => void,
): Promise<RatioEnrichmentResult> {
  const snapshot = readScanningResults(setState);
  const usersToEnrich = snapshot.filter(u => needsRatioRefresh(u));

  if (usersToEnrich.length === 0) {
    return { enriched: 0, failed: 0, skipped: 0, fromCache: 0, rateLimited: false };
  }

  // Batch size kept small + variable inter-batch delay to stay under radar
  const BATCH_SIZE = 2; // reduced from 3 → less parallel load on IG
  const BASE_DELAY_MS = 2500;
  let enriched = 0;
  let fromCache = 0;
  let failed = 0;
  let rateLimited = false;

  for (let i = 0; i < usersToEnrich.length; i += BATCH_SIZE) {
    const batch = usersToEnrich.slice(i, i + BATCH_SIZE);

    // Sequential within batch to avoid request bursts
    for (const user of batch) {
      try {
        const { counts, rateLimited: hitLimit, fromCache: cached } = await fetchUserRatioCounts(user.id, user.username);

        if (counts) {
          enriched += 1;
          if (cached) fromCache += 1;
          setState(prev => {
            if (prev.status !== "scanning") return prev;
            return {
              ...prev,
              results: prev.results.map(u =>
                u.id === user.id
                  ? { ...u, follower_count: counts.follower_count, following_count: counts.following_count, ratio_last_fetched: counts.fetched_at }
                  : u
              ),
              unfollowCandidates: recalculateUnfollowCandidates(prev.results),
            };
          });
        } else {
          failed += 1;
          if (hitLimit) {
            rateLimited = true;
            setToast({ show: true, text: "⚠️ Instagram rate-limited ratio requests. Pausing 15 min…" });
            await sleep(15 * 60 * 1000);
          }
          console.warn(`Could not fetch ratio for ${user.username}`);
        }
      } catch (e) {
        failed += 1;
        console.warn(`Could not fetch ratio for ${user.username}`, e);
      }

      // Small jitter between individual requests (skipped for cache hits which have no network call)
      await sleep(300 + sessionJitter());
    }

    if (enriched > 0 && enriched % 10 === 0) {
      setToast({ show: true, text: `Ratios: ${enriched} loaded (${fromCache} from cache)…` });
    }

    // Inter-batch delay — skip after the last batch
    if (i + BATCH_SIZE < usersToEnrich.length) {
      await sleep(BASE_DELAY_MS + Math.random() * 1500 + sessionJitter());
    }
  }

  const remaining = readScanningResults(setState).filter(u => needsRatioRefresh(u)).length;

  return {
    enriched,
    failed,
    skipped: remaining,
    fromCache,
    rateLimited,
  };
}


function App() {
  const [state, setState] = useState<State>({
    status: "initial",
  });

  const [toast, setToast] = useState<{ readonly show: false } | { readonly show: true; readonly text: string }>({
    show: false,
  });

  const [timings, setTimings] = useState<Timings>(() => {
    const storedTimings = loadTimings();
    return storedTimings ?? {
      timeBetweenSearchCycles: DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
      timeToWaitAfterFiveSearchCycles: DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
      timeBetweenUnfollows: DEFAULT_TIME_BETWEEN_UNFOLLOWS,
      timeToWaitAfterFiveUnfollows: DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS,
    };
  });

  // Save timings whenever they change
  useEffect(() => {
    saveTimings(timings);
  }, [timings]);

  // Track follows/unfollows made on Instagram while this script runs
  useEffect(() => {
    installFollowTracker();
    return onFollowHistoryChange(() => {
      setState(prev => {
        if (prev.status !== "scanning") return prev;
        const candidates = recalculateUnfollowCandidates(prev.results);
        return {
          ...prev,
          unfollowCandidates: candidates,
          followHistoryVersion: prev.followHistoryVersion + 1,
        };
      });
    });
  }, []);


  let isActiveProcess: boolean;
  switch (state.status) {
    case "initial":
      isActiveProcess = false;
      break;
    case "scanning":
    case "unfollowing":
      isActiveProcess = state.percentage < 100;
      break;
    default:
      assertUnreachable(state);
  }

  const onScan = async () => {
    if (state.status !== "initial") {
      return;
    }

    // ── Session guard: enforce run gap + daily limit ──────────────────────────
    const guardResult = recordScriptRun();
    if (!guardResult.ok) {
      setToast({ show: true, text: guardResult.warning! });
      // Wait out the required gap then allow the run
      if (guardResult.extraDelayMs > 0) {
        await sleep(guardResult.extraDelayMs);
      }
    } else if (guardResult.warning) {
      // Soft warning — show but don't block
      setToast({ show: true, text: guardResult.warning });
      await sleep(3000);
    }

    // ── Session stats toast ───────────────────────────────────────────────────
    const stats = getSessionStats();
    if (stats.runCount > 1) {
      setToast({
        show: true,
        text: `📊 Today: ${stats.runCount} runs · ${stats.scanPages} pages · ${stats.ratioFetches} ratio fetches`,
      });
      await sleep(2500);
    }

    const whitelistedResults = loadWhitelist();
    setState({
      status: "scanning",
      page: 1,
      searchTerm: "",
      currentTab: "non_whitelisted",
      percentage: 0,
      results: [],
      selectedResults: [],
      whitelistedResults,
      filter: {
        showNonFollowers: true,
        showFollowers: false,
        showVerified: true,
        showPrivate: true,
        showWithOutProfilePicture: true,
        showBadRatioOnly: false,
        badRatioThreshold: 1.0,
        showAutoUnfollowOnly: false,
      },
      unfollowCandidates: [],
      followHistoryVersion: 0,
    });
  };

  const handleScanFilter = (e: ChangeEvent<HTMLInputElement>) => {
    if (state.status !== "scanning") {
      return;
    }
    if (state.selectedResults.length > 0) {
      if (!confirm("Changing filter options will clear selected users")) {
        // Force re-render. Bit of a hack but had an issue where the checkbox state was still
        // changing in the UI even even when not confirming. So updating the state fixes this
        // by synchronizing the checkboxes with the filter statuses in the state.
        setState({ ...state });
        return;
      }
    }
    setState({
      ...state,
      // Make sure to clear selected results when changing filter options. This is to avoid having
      // users selected in the unfollow queue but not visible in the UI, which would be confusing.
      selectedResults: [],
      filter: {
        ...state.filter,
        [e.currentTarget.name]: e.currentTarget.checked,
      },
    });
  };

  const handleUnfollowFilter = (e: ChangeEvent<HTMLInputElement>) => {
    if (state.status !== "unfollowing") {
      return;
    }
    setState({
      ...state,
      filter: {
        ...state.filter,
        [e.currentTarget.name]: e.currentTarget.checked,
      },
    });
  };

  const toggleUser = (newStatus: boolean, user: UserNode) => {
    if (state.status !== "scanning") {
      return;
    }
    if (newStatus) {
      setState({
        ...state,
        selectedResults: [...state.selectedResults, user],
      });
    } else {
      setState({
        ...state,
        selectedResults: state.selectedResults.filter(result => result.id !== user.id),
      });
    }
  };

  const toggleAllUsers = (e: ChangeEvent<HTMLInputElement>) => {
    if (state.status !== "scanning") {
      return;
    }
    if (e.currentTarget.checked) {
      setState({
        ...state,
        selectedResults: getUsersForDisplay(
          state.results,
          state.whitelistedResults,
          state.currentTab,
          state.searchTerm,
          state.filter,
          state.status === "scanning"
            ? new Set(state.unfollowCandidates.map(c => c.user.id))
            : undefined,
        ),
      });
    } else {
      setState({
        ...state,
        selectedResults: [],
      });
    }
  };

  // it will work the same as toggleAllUsers, but it will select everyone on the current page.
  const toggleCurrentePageUsers = (e: ChangeEvent<HTMLInputElement>) => {
    if (state.status !== "scanning") {
      return;
    }
    if (e.currentTarget.checked) {
      setState({
        ...state,
        selectedResults: getCurrentPageUnfollowers(
          getUsersForDisplay(
            state.results,
            state.whitelistedResults,
            state.currentTab,
            state.searchTerm,
            state.filter,
            new Set(state.unfollowCandidates.map(c => c.user.id)),
          ),
          state.page,
        ),
      });
    } else {
      setState({
        ...state,
        selectedResults: [],
      });
    }
  };

  const onWhitelistUpdate = (updatedWhitelist: readonly UserNode[]) => {
    saveWhitelist(updatedWhitelist);
    if (state.status === "scanning") {
      setState({
        ...state,
        whitelistedResults: updatedWhitelist,
      });
    }
  };

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Prompt user if he tries to leave while in the middle of a process (searching / unfollowing / etc..)
      // This is especially good for avoiding accidental tab closing which would result in a frustrating experience.
      if (!isActiveProcess) {
        return;
      }

      // `e` Might be undefined in older browsers, so silence linter for this one.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      e = e || window.event;

      // `e` Might be undefined in older browsers, so silence linter for this one.
      // For IE and Firefox prior to version 4
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (e) {
        e.returnValue = "Changes you made may not be saved.";
      }

      // For Safari
      return "Changes you made may not be saved.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isActiveProcess, state]);

  useEffect(() => {
    const scan = async () => {
      if (state.status !== "scanning") {
        return;
      }
      const results = [...state.results];
      let scrollCycle = 0;
      let url = urlGenerator();
      let hasNext = true;
      let currentFollowedUsersCount = 0;
      let totalFollowedUsersCount = -1;

      while (hasNext) {
        let receivedData: User;
        try {
          receivedData = (await fetch(url).then(res => res.json())).data.user.edge_follow;
        } catch (e) {
          console.error(e);
          continue;
        }

        if (totalFollowedUsersCount === -1) {
          totalFollowedUsersCount = receivedData.count;
        }

        hasNext = receivedData.page_info.has_next_page;
        url = urlGenerator(receivedData.page_info.end_cursor);
        currentFollowedUsersCount += receivedData.edges.length;
        receivedData.edges.forEach(x => {
          const node = x.node;
          const owner = node.reel?.owner;
          const followerCount = node.follower_count ?? owner?.edge_followed_by?.count;
          const followingCount = node.following_count ?? owner?.edge_follow?.count;

          // ── Preload from persistent ratio cache if available ──────────────
          const cachedRatio = getRatioCacheEntry(node.id);
          const resolvedFollowers = followerCount ?? cachedRatio?.follower_count;
          const resolvedFollowing = followingCount ?? cachedRatio?.following_count;
          const resolvedFetchedAt =
            (followerCount && followingCount) ? Date.now()
            : cachedRatio ? cachedRatio.fetched_at
            : undefined;

          const enhancedNode = {
            ...node,
            follower_count: resolvedFollowers,
            following_count: resolvedFollowing,
            ratio_last_fetched: resolvedFetchedAt,
          };
          results.push(enhancedNode);
        });

        setState(prevState => {
          if (prevState.status !== "scanning") {
            return prevState;
          }
          const newState: State = {
            ...prevState,
            // Fix: Changed from Math.floor to Math.round to ensure progress reaches 100%
            // Math.floor would leave progress at 99% when near completion
            percentage: Math.round((currentFollowedUsersCount / totalFollowedUsersCount) * 100),
            results,
          };
          return newState;
        });

        // Pause scanning if user requested so.
        while (scanningPaused) {
          await sleep(1000);
          console.info("Scan paused");
        }

        // ── Session guard: record page + apply progressive extra delay ──────
        const pageGuard = recordScanPage();
        if (!pageGuard.ok) {
          // Hard daily limit — pause and warn
          setToast({ show: true, text: pageGuard.warning! });
          await sleep(pageGuard.extraDelayMs);
        } else if (pageGuard.extraDelayMs > 0) {
          await sleep(pageGuard.extraDelayMs);
        }

        // Human-like behavior: Micro-pause between fetching chunks
        // Scale up micro-pause based on session jitter (usage-aware)
        const microPause = Math.floor(Math.random() * 1500) + 500 + sessionJitter(); // 500ms–2000ms + jitter
        await sleep(microPause);

        // Standard delay between cycles
        await sleep(Math.floor(Math.random() * (timings.timeBetweenSearchCycles - timings.timeBetweenSearchCycles * 0.7)) + timings.timeBetweenSearchCycles);

        scrollCycle++;
        if (scrollCycle > 6) {
          scrollCycle = 0;
          // Variable long sleep to avoid patterns — jitter scales with daily usage
          const longSleepVar = Math.max(
            0,
            timings.timeToWaitAfterFiveSearchCycles + (Math.random() * 10000 - 5000) + sessionJitter() * 2,
          );
          setToast({ show: true, text: `Sleeping ${Math.round(longSleepVar / 1000)} seconds to prevent getting temp blocked` });
          await sleep(longSleepVar);
        }
        setToast({ show: false });
      }
      setToast({ show: true, text: "Scanning completed!" });
    };
    scan();
    // Dependency array not entirely legit, but works this way. TODO: Find a way to fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  useEffect(() => {
    if (state.status !== "scanning" || state.results.length === 0) {
      return;
    }

    const candidates = recalculateUnfollowCandidates(state.results);
    setState(prev => {
      if (prev.status !== "scanning") return prev;
      return { ...prev, unfollowCandidates: candidates };
    });
  }, [
    state.status === "scanning" ? state.results : [],
    state.status === "scanning" ? state.followHistoryVersion : 0,
  ]);

  useEffect(() => {
    if (state.status !== "scanning" || state.percentage !== 100 || state.results.length === 0) {
      return;
    }

    let cancelled = false;

    const runAfterScan = async () => {
      setToast({ show: true, text: "Syncing follow history from Instagram…" });

      const added = await syncFollowHistoryFromFollowingList(
        state.results,
        Date.now(),
        progress => {
          if (cancelled) return;
          setToast({
            show: true,
            text: `${progress.phase} (${progress.current}/${progress.total})`,
          });
        },
      );

      if (cancelled) return;

      pruneFollowHistoryToCurrentFollowing(new Set(state.results.map(u => u.id)));

      setState(prev => {
        if (prev.status !== "scanning") return prev;
        return {
          ...prev,
          followHistoryVersion: prev.followHistoryVersion + 1,
          unfollowCandidates: recalculateUnfollowCandidates(prev.results),
        };
      });

      setToast({
        show: true,
        text: added > 0
          ? `Synced ${added} follow dates. Checking posts…`
          : "Follow history up to date. Checking posts…",
      });

      const recentFollows = getRecentFollows(96);
      if (recentFollows.length > 0) {
        await enrichFollowHistoryWithPosts(recentFollows, () => {
          if (cancelled) return;
          setState(prev => {
            if (prev.status !== "scanning") return prev;
            return {
              ...prev,
              unfollowCandidates: recalculateUnfollowCandidates(prev.results),
              followHistoryVersion: prev.followHistoryVersion + 1,
            };
          });
        });
      }

      if (!cancelled) {
        setToast({ show: true, text: "Auto-unfollow scan ready." });
      }

      if (!cancelled) {
        await sleep(8000);
      }

      if (!cancelled) {
        const missing = readScanningResults(setState).filter(u => needsRatioRefresh(u)).length;
        if (missing > 0) {
          setToast({ show: true, text: `Loading ratios for ${missing} profiles…` });
          const ratioResult = await enrichWithRatioData(setState, setToast);
          if (!cancelled) {
            if (ratioResult.rateLimited) {
              setToast({
                show: true,
                text: `⚠️ Instagram limited ratio requests (${ratioResult.enriched} ok, ${ratioResult.fromCache} from cache). Wait 15–30 min, then use Retry Ratios.`,
              });
            } else if (ratioResult.skipped > 0) {
              setToast({
                show: true,
                text: `Ratios: ${ratioResult.enriched} loaded (${ratioResult.fromCache} cached), ${ratioResult.skipped} still missing.`,
              });
            } else {
              const cacheNote = ratioResult.fromCache > 0 ? ` (${ratioResult.fromCache} from cache ⚡)` : '';
              setToast({ show: true, text: `Ratios loaded for ${ratioResult.enriched} profiles${cacheNote}.` });
            }
          }
        } else {
          // All ratios came from cache — let user know
          const allCached = readScanningResults(setState).filter(
            u => u.follower_count != null && u.following_count != null
          ).length;
          if (allCached > 0) {
            setToast({ show: true, text: `⚡ All ${allCached} ratio profiles loaded from cache (no extra requests).` });
          }
        }
      }
    };

    runAfterScan();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.status === "scanning" ? state.percentage : 0,
    state.status === "scanning" ? state.results.length : 0,
  ]);

  const handleSyncFollowHistory = async () => {
    if (state.status !== "scanning" || state.results.length === 0) {
      return;
    }

    setToast({ show: true, text: "Syncing follow dates…" });
    const added = await syncFollowHistoryFromFollowingList(
      state.results,
      Date.now(),
      progress => {
        setToast({
          show: true,
          text: `${progress.phase} (${progress.current}/${progress.total})`,
        });
      },
    );

    pruneFollowHistoryToCurrentFollowing(new Set(state.results.map(u => u.id)));

    setState(prev => {
      if (prev.status !== "scanning") return prev;
      return {
        ...prev,
        followHistoryVersion: prev.followHistoryVersion + 1,
        unfollowCandidates: recalculateUnfollowCandidates(prev.results),
      };
    });

    setToast({ show: true, text: `Synced ${added} follow date(s).` });
  };

  const handleTrackFollow = (user: UserNode) => {
    const existing = getFollowEntryForUser(user.id);
    if (existing) {
      const ok = window.confirm(
        "Reset follow time to now?\n\nThis restarts the 24h/48h auto-unfollow timers. Ego/Aura will not apply until 24 hours after this reset.",
      );
      if (!ok) {
        return;
      }
    }
    trackFollowNow(user.id, user.username);
    if (state.status === "scanning") {
      setState({
        ...state,
        followHistoryVersion: state.followHistoryVersion + 1,
        unfollowCandidates: recalculateUnfollowCandidates(state.results),
      });
    }
  };

  const handleRetryRatioFetch = async () => {
    if (state.status !== "scanning" || state.results.length === 0) {
      return;
    }
    const missing = state.results.filter(u => needsRatioRefresh(u)).length;
    if (missing === 0) {
      setToast({ show: true, text: "⚡ All profiles already have ratio data (served from cache)." });
      return;
    }
    setToast({ show: true, text: `Retrying ratios for ${missing} profiles…` });
    const ratioResult = await enrichWithRatioData(setState, setToast);
    if (ratioResult.rateLimited) {
      setToast({
        show: true,
        text: `⚠️ Still rate-limited (${ratioResult.enriched} loaded, ${ratioResult.fromCache} from cache). Wait 15–30 min before retrying.`,
      });
    } else {
      const cacheNote = ratioResult.fromCache > 0 ? ` (${ratioResult.fromCache} from cache ⚡)` : '';
      setToast({
        show: true,
        text: ratioResult.skipped > 0
          ? `Loaded ${ratioResult.enriched}${cacheNote}; ${ratioResult.skipped} still missing.`
          : `Loaded ratios for ${ratioResult.enriched} profiles${cacheNote}.`,
      });
    }
  };

  useEffect(() => {
    const unfollow = async () => {
      if (state.status !== "unfollowing") {
        return;
      }

      const csrftoken = getCookie("csrftoken");
      if (csrftoken === null) {
        throw new Error("csrftoken cookie is null");
      }

      let counter = 0;
      for (const user of state.selectedResults) {
        counter += 1;
        // Fix: Changed from Math.floor to Math.round to ensure progress reaches 100%
        // Math.floor would leave progress at 99% when near completion
        const percentage = Math.round((counter / state.selectedResults.length) * 100);
        try {
          await fetch(unfollowUserUrlGenerator(user.id), {
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-csrftoken": csrftoken,
            },
            method: "POST",
            mode: "cors",
            credentials: "include",
          });
          setState(prevState => {
            if (prevState.status !== "unfollowing") {
              return prevState;
            }
            return {
              ...prevState,
              percentage,
              unfollowLog: [
                ...prevState.unfollowLog,
                {
                  user,
                  unfollowedSuccessfully: true,
                },
              ],
            };
          });
        } catch (e) {
          console.error(e);
          setState(prevState => {
            if (prevState.status !== "unfollowing") {
              return prevState;
            }
            return {
              ...prevState,
              percentage,
              unfollowLog: [
                ...prevState.unfollowLog,
                {
                  user,
                  unfollowedSuccessfully: false,
                },
              ],
            };
          });
        }
        // If unfollowing the last user in the list, no reason to wait.
        if (user === state.selectedResults[state.selectedResults.length - 1]) {
          break;
        }
        await sleep(Math.floor(Math.random() * (timings.timeBetweenUnfollows * 1.2 - timings.timeBetweenUnfollows)) + timings.timeBetweenUnfollows);

        if (counter % 5 === 0) {
          setToast({ show: true, text: `Sleeping ${timings.timeToWaitAfterFiveUnfollows / 60000} minutes to prevent getting temp blocked` });
          await sleep(timings.timeToWaitAfterFiveUnfollows);
        }
        setToast({ show: false });
      }
    };
    unfollow();
    // Dependency array not entirely legit, but works this way. TODO: Find a way to fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  let markup: React.JSX.Element;
  switch (state.status) {
    case "initial":
      markup = <NotSearching onScan={onScan}></NotSearching>;
      break;

    case "scanning": {
      markup = <Searching
        state={state}
        handleScanFilter={handleScanFilter}
        toggleUser={toggleUser}
        pauseScan={pauseScan}
        setState={setState}
        scanningPaused={scanningPaused}
        UserCheckIcon={UserCheckIcon}
        UserUncheckIcon={UserUncheckIcon}
        onSyncFollowHistory={handleSyncFollowHistory}
        onTrackFollow={handleTrackFollow}
        onRetryRatioFetch={handleRetryRatioFetch}
      ></Searching>;
      break;
    }

    case "unfollowing":
      markup = <Unfollowing
        state={state}
        handleUnfollowFilter={handleUnfollowFilter}
      ></Unfollowing>;
      break;

    default:
      assertUnreachable(state);
  }

  return (
    <main id="main" role="main" className="iu">
      <section className="overlay">
        <Toolbar
          state={state}
          setState={setState}
          isActiveProcess={isActiveProcess}
          toggleAllUsers={toggleAllUsers}
          toggleCurrentePageUsers={toggleCurrentePageUsers}
          setTimings={setTimings}
          currentTimings={timings}
          whitelistedUsers={state.status === "scanning" ? state.whitelistedResults : loadWhitelist()}
          onWhitelistUpdate={onWhitelistUpdate}
        ></Toolbar>

        {markup}

        {toast.show && <Toast show={toast.show} message={toast.text} onClose={() => setToast({ show: false })} />}
      </section>
    </main>
  );
}

if (location.hostname !== INSTAGRAM_HOSTNAME) {
  alert("Can be used only on Instagram routes");
} else {
  document.title = "InstagramUnfollowers";
  document.body.innerHTML = "";
  render(<App />, document.body);
}
