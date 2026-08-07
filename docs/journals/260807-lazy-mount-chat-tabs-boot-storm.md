# Lazy-mount chat tabs — kill boot request storm

**Date:** 2026-08-07 · **Plan:** `plans/260807-1120-chat-boot-lazy-mount-tabs/` · **Phases:** 6 complete

## What shipped

Reloading PPM took ~30s before any chat tab rendered. Root cause: `tab-pool.tsx` mounted every saved tab (18 chat + 2 group) at boot, even invisible ones. Hidden still means mounted → all effects fire → 515 requests / 36.7 MB / 169 failures fire in the first 3 seconds, so the visible tab queues behind invisible ones. Server is not slow; the client drowns itself.

**The four changes:**

1. **Lazy-mount with derived mount set** — New store `src/web/stores/mounted-tabs-store.ts` (session-only, never persisted). Pure `filterMountableEntries()` derives the mount set from per-panel `isActive` flags on every render, avoiding scattered `markTabActivated()` calls across ~8 sites (setActiveTab, openTab, moveTab, splitPanel, closeTab, redockTab, openInDock, pickDockActiveTab). Design choice: derive rather than scatter — that scatter approach silently breaks the moment a 9th site is added and someone forgets it.

2. **Running-session indicator without lazy-mount regression** — `GET /chat/sessions/running` reads the in-memory session registry (no DB), so the tab-strip spinner survives when the active chat tab hasn't mounted yet.

3. **Batched versionMap** — `/versions` storm: 169 requests, **165 of them HTTP 400 as the normal "no versions here" signal**. Each ran `resolveVersionGroup` walking the branch ancestor chain, one DB query per hop (up to 100 sequential). Replaced with `versionMap` computed server-side in 2 queries and shipped alongside `/messages`. Also discovered `VersionSwitcher` only ever needed `{ids, currentIndex}`, so the expensive `getSessionInfoById` loop was dead weight. Killed it.

4. **Idle prefetch 3 tabs, desktop only** — After first paint, prefetch 3 recently-used chat tabs (serialized, never terminals). Skipped entirely on mobile (no cellular waste).

**Results:**

| Metric | Before (prod build) | After (dev build) |
|--------|--------|-------|
| API requests | 423 | desktop 175 / mobile 87 |
| Failed requests | 169 | **0** |
| `/versions` requests | 169 | **0** |
| API payload | 36.7 MB | desktop 34.3 MB / mobile 5.1 MB |
| Slowest single API | 16256 ms | 553 ms |
| Tabs mounted at boot | 20 | **2** |

33 new tests; full suite clean vs HEAD.

## Four things worth reflecting on

**1. Code review caught a load-bearing accident I completely missed.**

`startWatching()` only called from `chatWebSocket.open`, and `broadcastGlobalEvent` only iterated chat sockets. Lazy-mounting silently killed project file watching, editor live-reload, docx/pdf preview reload, file-tree invalidation and cross-device unread sync — *only when no visible tab happened to be a chat tab*. It had worked before purely by accident: every saved chat tab used to mount, so some socket always existed. No test covered it; it fails silently with no error. This forced an unplanned Phase 6: a dedicated `/ws/global` bus. **Lesson:** an incidental guarantee that nothing documents and nothing tests quietly becomes load-bearing. Code review was the only catch here.

**2. `requestIdleCallback`'s `timeout` is a deadline, not a delay.**

First prefetch passed the 2.5s delay as `timeout`, meaning "run by then at the latest" — so all 3 prefetches fired ~1.5s into boot, competing with exactly the visible tabs they were supposed to yield to. Caught only because the harness printed a mount timeline; assuming it worked would have shipped it. Fix: `setTimeout` owns the spacing, `requestIdleCallback` only avoids landing mid-work. Timeline after the fix — visible tabs at 1255ms, content settled 2324ms, then one tab per ~1.1s (4072 → 5184 → 7952ms), stopping at 5 mounted.

**3. A synthetic test fixture missed a real-data bug.**

`resolveVersionMap` keyed the in-memory index on `fork_ordinal`, but rows predating that migration have it `NULL`. SQL `WHERE fork_ordinal = NULL` never matches (three-valued logic), so the old per-ordinal path silently skipped them; the batch path emitted a bogus `null` key. Hand-built test tree never had NULL rows. Sweeping all 32 real nodes × 80 ordinals against the actual dev database surfaced it immediately. Fixed the batch function to skip non-integer ordinals and added two regression tests that mutate a row to `NULL` — the case the fixture generator could not produce, since `recordBranch` always writes an integer.

**4. Declined one reviewer suggestion on principle.**

Reviewer suggested gating dock tab mounting on `dock.visible` so a collapsed dock doesn't spawn a PTY at boot. Declined: on `main`, all dock tabs already mounted at boot — so this change had already *reduced* that. Gating further would change pre-existing restore behavior rather than fix a regression I introduced. Recorded the suggestion rather than silently changed. (User might depend on the current restore semantics; better to ask.)

## Honest gaps

- **Dev-build numbers.** Vite serves unbundled ESM and React StrictMode double-invokes effects, so dev API counts read roughly 2× production. The cleaner metrics (failures, `/versions` count, slowest-API, mounted-tab count) all moved as intended, but a prod-build re-measure is owed at release time.

- **Desktop prefetch payload still ~34 MB** because 3 heavy session histories dominate (one session alone is 1.95 MB). Mobile skips prefetch entirely (5.1 MB total). Real fix is `/messages` pagination — deliberately deferred to its own plan.

- **Found but not fixed: double-fetch on mount.** Every session fetches its full history twice per mount (initial session-change load + a `refetchMessages` from the WS `session_state` path). Pre-existing, doubles the heaviest endpoint, left alone because it touches documented edit→fork edge cases. Would need explicit scope.

## Verification

- Full suite via Docker (host Bun segfaults on `bun test`): 2434 pass / 40 fail out of 2488. Clean HEAD worktree gives 43 fail out of 2455 — so **zero new failures**, verified by diffing normalized failure-name sets. Remainder are container-environment (systemd, Claude SDK auth, git-graph, root-permission fs) plus a timing-flaky supervisor suite that fails different tests each run. 33 tests added.
- `tsc --noEmit` clean (Docker).
- CDP harness `tests/e2e/boot-network-audit.mjs` — cold reload with cache cleared, captures every request plus a mount timeline. 0 failed requests, 0 `/versions`, 2 of 20 tabs mounted, slowest API 553ms. `--mobile` confirms zero prefetch.
- `tests/e2e/lazy-mount-interaction.mjs` — clicking an unmounted tab mounts it (2→3) and it stays mounted after switching away (keep-alive intact).
- `tests/e2e/version-switcher-check.mjs` — deep-links a real 9-version session; switcher renders `1/9` with correct disabled states.
- File watcher decoupling: `tests/integration/ws/global-events.test.ts` asserts delivery with **zero chat sessions in existence** and relays a real `fs.watch` write. Browser run confirms `[file-watcher] Started watching: ppm` in the server log with no chat-session log lines at all.
