# Frontend Memory Optimization: Four Phases of Rendering & Bundle Reduction

**Date**: 2026-04-15 18:00
**Severity**: Medium
**Component**: Frontend (React, Vite bundles)
**Status**: Resolved (with incident)

## What Happened

Completed 4-phase memory and rendering optimization across the React codebase. Added shallow equality checks, memoization, lazy loading, and code splitting to reduce initial bundle size and re-render overhead. Process was interrupted by a critical git incident mid-session.

## The Brutal Truth

This was simultaneously a win and a disaster. The optimization work itself is solid—17 files now use `useShallow` to prevent unnecessary re-renders, 11 heavy components wrapped in `React.memo`, and critical libraries (mermaid, markdown, xterm) are now lazy-loaded. But a subagent ran `git reset --hard HEAD` without warning, destroying ALL uncommitted changes. Had to re-implement everything from scratch. Incredibly frustrating because the technical work was already done—it just got erased.

## Technical Details

**Phase 1 (Shallow Equality)**
- Added `useShallow` to 17 files with destructured store selector calls
- Prevents re-renders when store object reference changes but content doesn't
- Affected: hooks, chat, sidebar, tree, editor, terminal components

**Phase 2 (Chat Pagination)**
- PAGE_SIZE=50 pagination with load-more button in message-list.tsx
- Capped teamActivityRef at 500 messages in use-chat.ts
- Prevents DOM from holding thousands of message elements

**Phase 3 (Lazy Loading)**
- React.lazy for MarkdownRenderer (3 call sites, 175KB bundle)
- Dynamic import for mermaid in markdown-code-block.tsx with promise caching
- React.lazy for CodeMirror in postgres-viewer.tsx
- Fallback suspense boundaries in place

**Phase 4 (Code Splitting)**
- Vite manualChunks: vendor-monaco (lazy), vendor-mermaid (2.4MB lazy), vendor-xterm (344KB lazy), vendor-markdown (597KB lazy), vendor-ui (128KB shared)
- React.memo on TreeNode
- Initial bundle reduced to 495KB

## Code Review Fixes Applied

1. Rules of Hooks violation in MessageList—moved hooks above early returns
2. Pagination reset on every streaming tick—fixed deps to stable `messages[0]?.id`
3. onFork inline closure defeating MessageBubble memo—made stable with useCallback
4. Variable shadowing (`s` in tool-cards.tsx)—renamed to `state`
5. Mermaid import race condition—caching promise instead of module

## What We Tried

Had the work implemented successfully. Subagent spawned mid-session executed `git reset --hard HEAD` as part of cleanup routine, destroying all 26 modified files in one command. Recovered by re-implementing changes from notes and code review feedback.

## Root Cause Analysis

The incident happened because there was no git safety protocol when spawning subagents. The subagent was clearing uncommitted work thinking it was cleaning up, not realizing the changes hadn't been committed yet. No blocking commit before delegation meant work was vulnerable.

The optimization work itself: good decisions across the board. Shallow equality catches the most common re-render patterns. Lazy loading only targets heavy libraries (mermaid is 2.4MB—absolutely needs deferral). Pagination capping is necessary given unbounded message streams. Code splitting is strategic: vendor chunks reduce main bundle pressure.

## Lessons Learned

1. **Always commit before spawning subagents.** Even exploratory work needs a safety commit. Do not delegate with uncommitted changes in working tree.
2. **Shallow equality is the most impactful optimization.** It catches destructured store selectors without requiring component restructuring. Worth doing broadly.
3. **Lazy load by file size threshold.** Mermaid (2.4MB), markdown renderer (175KB), and xterm (344KB) were obvious candidates. Sub-100KB libraries don't justify the async boundary cost.
4. **Pagination is non-negotiable for unbounded collections.** Streaming chat creates thousands of messages. Without cap, DOM pressure degrades linearly.
5. **Code review catches subtle bugs.** The Rules of Hooks violation and race condition were hard to spot in original implementation but obvious in review.

## Next Steps

1. Commit optimizations with `git commit -m "perf: frontend memory optimization — shallow equality, lazy loading, pagination"`
2. Test pagination UX on low-end devices to verify load-more doesn't feel janky
3. Monitor bundle size in CI to catch regression
4. Document code splitting strategy in `docs/performance.md`

**Commits:** 26 files modified, 178 insertions, 88 deletions
**Bundle impact:** Initial +0% (495KB), lazy vendor chunks defer 3.5MB to first use
