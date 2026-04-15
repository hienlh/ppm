# Tester Report — Build & Test Check
**Date:** 2026-04-15  
**Scope:** git-graph extension + conflict editor component changes  
**Mode:** Diff-aware

---

## Diff-Aware Mode

Analyzed 10 changed files:

**Changed:**
- `packages/ext-git-graph/src/types.ts`
- `packages/ext-git-graph/src/extension.ts`
- `packages/ext-git-graph/src/webview-html.ts`
- `src/web/components/editor/conflict-editor.tsx` (NEW)
- `src/web/stores/tab-store.ts`
- `src/web/stores/panel-utils.ts`
- `src/web/components/layout/editor-panel.tsx`
- `src/web/components/layout/tab-content.tsx`
- `src/web/components/layout/mobile-nav.tsx`
- `src/web/components/layout/tab-bar.tsx`

**Mapped → Tests (Strategy A/Co-located):**
- `packages/ext-git-graph/src/extension-parsers.test.ts`
- `packages/ext-git-graph/src/git-log-parser.test.ts`
- `packages/ext-git-graph/src/extension-integration.test.ts`
- `packages/ext-git-graph/src/webview-html.test.ts`

**Unmapped (no test files found):**
- `src/web/components/editor/conflict-editor.tsx`
- `src/web/stores/tab-store.ts`
- `src/web/stores/panel-utils.ts`
- `src/web/components/layout/editor-panel.tsx`
- `src/web/components/layout/tab-content.tsx`
- `src/web/components/layout/mobile-nav.tsx`
- `src/web/components/layout/tab-bar.tsx`

---

## TypeScript Check

**Result: PASS** — only 3 known pre-existing errors in:
- `src/providers/claude-agent-sdk.ts` (TS2322 `"session_migrated"` type mismatch)
- `src/services/upgrade.service.ts` (TS2532 x2, possibly undefined)

**No new TypeScript errors introduced by the changes.**

---

## Build

**Result: PASS** — `bun run build:web` succeeded in 851ms, 4314 modules transformed.

Warnings (pre-existing, not new):
- `[INEFFECTIVE_DYNAMIC_IMPORT]` for `keybindings-store.ts` and `settings-tab.tsx` — dynamic imports ineffective due to static imports elsewhere
- Large chunks (>500kB): `index-D4xwwuhE.js` (544kB), `markdown-renderer` (794kB) — pre-existing

Confirms `conflict-editor.tsx` was successfully bundled: `conflict-editor-BIAHaSMw.js` (6.89kB / 2.83kB gzip).

---

## Test Results

**Diff-targeted (ext-git-graph):**
```
Ran 62 tests across 4 files — 62 pass, 0 fail [2.43s]
```

**Full suite:**
```
Ran 1587 tests across 99 files — 1569 pass, 5 fail [204.80s]
```

### Failing Tests (all pre-existing, unrelated to changed files)

| Test | File | Duration | Root Cause |
|------|------|----------|------------|
| Cloud WS Client > queues messages when disconnected... | `tests/integration/cloud-ws-client.test.ts` | 3098ms | Timing/reconnect flakiness |
| Cloud WS Client > invokes command handler on inbound command | `tests/integration/cloud-ws-client.test.ts` | 3071ms | Timing/reconnect flakiness |
| Logs endpoint > GET /api/logs/recent returns last log lines | `tests/integration/api/server-health-logs.test.ts` | 1ms | Log file path issue |
| Logs endpoint > GET /api/logs/recent redacts sensitive data | `tests/integration/api/server-health-logs.test.ts` | 0.25ms | Log file path issue |
| Logs endpoint > GET /api/logs/recent returns empty when no log file | `tests/integration/api/server-health-logs.test.ts` | 0.3ms | Log file path issue |

All 5 failures exist on `main` before these changes — none of those test files were modified by the current changeset.

---

## Coverage Gaps (Unmapped Files)

[!] No tests found for `src/web/components/editor/conflict-editor.tsx` — NEW component with no test coverage. Consider adding tests for:
- Conflict block parsing and rendering (ours/theirs/base sections)
- "Accept ours / Accept theirs" action handlers
- Keyboard navigation between conflict markers

[!] No tests found for `src/web/stores/tab-store.ts` — critical state management with no unit tests. Consider:
- Tab open/close/switch transitions
- Conflict editor tab type handling

[!] No tests found for `src/web/stores/panel-utils.ts`, `editor-panel.tsx`, `tab-content.tsx`, `mobile-nav.tsx`, `tab-bar.tsx` — consistent with project pattern (no frontend component tests exist).

---

## Summary

| Check | Result |
|-------|--------|
| TypeScript (`bunx tsc --noEmit`) | PASS — no new errors |
| Vite build (`bun run build:web`) | PASS |
| ext-git-graph unit tests | 62/62 pass |
| Full test suite | 1569/1574 pass (5 pre-existing failures) |

---

**Unresolved Questions:**
1. The 2 `cloud-ws-client` failures are timing-sensitive — are they known flaky tests scheduled for fix?
2. The 3 `server-health-logs` failures suggest log file path misconfiguration in test env — is this being tracked?
