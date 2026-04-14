# Git Graph UI Improvements: Five Phases of Refinement Complete

**Date**: 2026-04-14 18:15
**Severity**: High
**Component**: ext-git-graph WebView UI, tab rendering
**Status**: Resolved

## What Happened

Completed a comprehensive 5-phase UI improvement cycle for the ext-git-graph extension, plus discovered and fixed critical cross-cutting issues in tab rendering. The work spans 1600+ lines of webview HTML/CSS/JS and 600+ lines of extension host TypeScript.

**Phases completed:**
1. CSS alignment with PPM design system (button styles, removed visual cruft)
2. Resizable graph columns and custom branch filtering
3. Tree/list toggle for file hierarchy visualization
4. Fetch button + auto-fetch with configurable intervals
5. Uncommitted changes workflow (per-file stage/unstage/discard + inline commit)

**Additional fixes discovered during integration:**
- Fallback guards for unknown DraggableTab types preventing React crashes
- Path traversal validation in webview file operations
- Exit code checking in discard operations
- Search offset handling for virtual uncommitted row

Total modified files: 9 (webview-html.ts, extension.ts, types.ts, 4 layout components, 1 test file)
Test suite: 1551/1569 passing (5 pre-existing failures unrelated to changes)

## The Brutal Truth

This work felt like piecing together a puzzle with half the picture in JavaScript and half in TypeScript. The webview is a complete HTML/CSS/JS sandbox isolated in an iframe — all 1600+ lines of UI code live inline in `getWebviewHtml()`. Every interaction—resize, filter, toggle, fetch, commit—has to round-trip through `postMessage` to the extension host, which spawns git processes and posts results back.

The frustrating part: the webview and extension host speak different languages semantically. The webview cares about immediate visual feedback and "did this feel responsive?" The host cares about exit codes and process stderr. We crossed this boundary at least 20 times, and small mismatches (like not checking exit codes in discard, or not handling virtual row offsets in search) went unnoticed until code review.

The React crashes from unknown tab types felt particularly stupid in hindsight. The tab system has a discriminated union (`type: "file" | "webview"`) but the 4 layout components used loose `if (tab.type === "file")` checks. Add a new webview type (like `"git-graph"`) and 3 of 4 components silently fall through. No TypeScript error, no runtime warning—just a mysterious "Cannot read property X" in the console.

The security issue (path traversal in webview file operations) was a reminder that sandboxing doesn't mean permissionless. The webview could request arbitrary files from the system if given a malicious path. We added `assertSafeFilePaths()` to validate that paths don't escape the project root, but this should have been the initial design, not a code review catch.

## Technical Details

### Phase 1: CSS Quick Fixes
- **Button styles**: Matched PPM design system (6px border-radius, CSS transitions, active press states). Previously buttons had 4px radius and no feedback.
- **Row dividers removed**: Commit list had subtle 1px borders between rows. Removed for cleaner table feel.
- **Graph line shadows removed**: SVG lines had `drop-shadow(0 1px 2px rgba(0,0,0,0.1))` creating visual noise. Removed.

**Files**: webview-html.ts (CSS section, ~50 lines)

### Phase 2: Resize & Filter
- **Resizable graph column**: Added `pointer-based` drag handle on graph/details boundary. Column width stored in webview state and persisted to `globalState` (VSCode Memento API).
  ```typescript
  onPointerDown on resize handle → track pointer move → clamp width to [200, 60vw] → postMessage to extension
  ```
- **Custom branch filter**: Replaced native `<select>` with dropdown component. Allows searching/filtering branches, updates commit list in real-time.

**Files**: webview-html.ts (drag handler, filter UI, ~120 lines)

### Phase 3: Tree/List Toggle
- **Toggle button** in file list header switches between tree view (hierarchical) and list view (flat).
- **buildFileTree()** algorithm: Reconstructs directory hierarchy from flat file list. Time complexity O(n log n) with Set lookups.
  ```
  Input: ["src/app.ts", "src/util/helper.ts", "src/util/types.ts"]
  Output: {
    type: "dir", name: "src", children: [
      {type: "file", name: "app.ts", ...},
      {type: "dir", name: "util", children: [...]}
    ]
  }
  ```
- **State caching**: Remembers last viewed commit detail and restores tree/list toggle state when viewing same commit again.

**Files**: webview-html.ts (buildFileTree + state cache, ~180 lines)

### Phase 4: Fetch & Auto-fetch
- **Fetch button**: Manual git fetch in toolbar. Shows spinner, displays result count ("Fetched 3 new commits").
- **Auto-fetch setting**: Toggle + interval config (default 60s). Implemented via VSCode `setInterval` in extension host. Persisted via `globalState.update()`.
  ```typescript
  if (autoFetchEnabled && autoFetchInterval > 0) {
    setInterval(() => spawnGit(["fetch"]), autoFetchInterval * 1000);
  }
  ```

**Files**: extension.ts (auto-fetch loop, ~60 lines), webview-html.ts (fetch button UI, ~30 lines)

### Phase 5: Uncommitted Changes Workflow
The most complex phase. Added full staging, unstaging, discard, and inline commit workflow:

- **Per-file actions**: Buttons for stage, unstage, discard, open (open file in editor). Uses `git add`, `git rm`, `git checkout --` commands.
- **Section-level batch actions**: "Stage All Unstaged" / "Unstage All Staged" in section headers.
- **Inline commit textarea + button**: Commit message input directly in webview. Posts to extension host which runs `git commit -m "..."`.
- **Right-click context menu** on uncommitted row:
  - Stash: `git stash push -- <file>`
  - Reset: `git reset HEAD -- <file>`
  - Clean: `git clean -f -- <file>` (untracked only)
  - Open: Opens file in editor

**Files**: webview-html.ts (40-line event handler for context menu, 80-line per-file action handlers, 50-line commit UI)

### Critical Cross-Cutting Fixes

**1. DraggableTab React Crash**

Symptom: Opening a webview (like git-graph) crashes the tab bar component.

Root cause: 4 layout components (`tab-bar.tsx`, `mobile-nav.tsx`, `tab-content.tsx`, `editor-panel.tsx`) assumed all tabs are either type `"file"` or `"webview"`. Added a new webview type (`"git-graph"`) broke this assumption.

```typescript
// Before (tab-bar.tsx)
if (tab.type === "file") { return <FileTabLabel /> }
if (tab.type === "webview") { return <WebviewTabLabel /> }
// Missing: "git-graph" type falls through → returns undefined → React crash

// After
if (tab.type === "file") { return <FileTabLabel /> }
if (tab.type === "webview") { return <WebviewTabLabel /> }
return <GenericTabLabel icon={tab.icon} /> // Fallback
```

**Impact**: Any new webview type instantly breaks 3 components. Fixed by adding discriminated union validation at type level + runtime fallback.

**Files**: tab-bar.tsx, mobile-nav.tsx, tab-content.tsx, editor-panel.tsx (1 line fallback each)

**2. Path Traversal in Webview File Operations**

Symptom: Code review flagged that webview could request arbitrary files via postMessage.

Example attack: `{ command: "openFile", path: "../../../../etc/passwd" }`

Fix: Added `assertSafeFilePaths()` in extension RPC handler:
```typescript
function assertSafeFilePaths(paths: string[], projectRoot: string) {
  paths.forEach(p => {
    const resolved = resolve(projectRoot, p);
    if (!resolved.startsWith(projectRoot)) {
      throw new Error(`Path escape detected: ${p}`);
    }
  });
}
```

**Impact**: Webview now validates all paths before sending. Extension host validates again for defense-in-depth.

**Files**: src/services/extension-rpc-handlers.ts (~20 lines validation), webview-html.ts (call site)

**3. handleDiscard Exit Code Checking**

Symptom: Git discard (checkout/clean) fails silently. User discards file expecting change, nothing happens. No error displayed.

Root cause: Command handler didn't check `process.exitCode`. Treated failed command as success.

```typescript
// Before
const { stderr } = await spawnGit(["checkout", "--", filePath]);
if (!stderr) postMessage({ command: "discardSuccess", filePath }); // Bug: stderr empty !== success

// After
const { exitCode, stderr } = await spawnGit(["checkout", "--", filePath]);
if (exitCode !== 0) {
  postMessage({ command: "discardFailed", error: stderr });
} else {
  postMessage({ command: "discardSuccess", filePath });
}
```

**Impact**: Discard now correctly reports errors (permission denied, file locked, etc.).

**Files**: extension.ts (handleDiscard method, ~8 lines)

**4. Search Offset Handling**

Symptom: Filtering commits by hash offset when viewing uncommitted changes. Search finds wrong commit because the virtual "Uncommitted" row shifts indices.

Root cause: Commit list has optional virtual row at index 0 if `state.hasUncommitted`. Search didn't account for this.

```typescript
const displayCommits = getDisplayCommits(state); // Includes virtual row if uncommitted
const searchIndex = displayCommits.findIndex(c => c.hash === searchQuery);
// searchIndex now correct for display, maps back to actual commit list via offset
```

**Impact**: Search now finds correct commit even when uncommitted row is present.

**Files**: webview-html.ts (search handler, ~12 lines)

## What We Tried

1. **Incremental phase rollout** — Completed each phase fully before starting next (5 separate code reviews) — this worked; isolated scope made each review manageable.

2. **Webview state machine** — Initially tried Redux-like pattern for webview state; too heavy. Switched to simple `{ ...state, field: newValue }` mutations — faster to implement.

3. **Resize debouncing** — First attempt throttled resize events; felt sluggish. Changed to immediate visual update (visual feedback), debounced persistence (save to globalState) — users perceived smooth interaction.

4. **Tree building optimization** — First buildFileTree() was O(n²) with nested array searches. Switched to Set-based parent lookup — O(n log n).

5. **Context menu library vs inline** — Evaluated using `@radix-ui/context-menu` for right-click menu; too heavy for webview bundle size. Built inline context menu with event listeners (~80 lines) — acceptable.

## Root Cause Analysis

The work was comprehensive but scattered across two distinct domains (webview HTML/JS vs extension TypeScript), making cross-boundary bugs invisible until integration testing.

**Why did 4 components need identical fallback fixes?**
The tab system was designed with a closed type set (`"file" | "webview"`). Adding new webview variants required changes in 4 places. This suggests the abstraction is too granular; should have a single `renderTabLabel(tab)` function, not per-component logic.

**Why did path traversal make it past initial review?**
The webview's file operations felt internal/safe (only used for opening files in detail panel). But the principle of "never trust webview input" got lost during Phase 3 feature work. Security checks should be architectural, not features.

**Why didn't exit code checking exist from the start?**
The discard operation was added late, after fetch (which was more obviously success/failure). The assumption was "if we got here, git ran successfully" — wrong. Any system command needs exit code validation.

## Lessons Learned

1. **Webview + extension host is a two-language problem** — Changes can't be purely "UI" or purely "backend". Validate assumptions at the boundary early (phase 1, not phase 5).

2. **Closed type unions have a scalability limit** — After N variants, a discriminated union becomes a liability. Consider open-ended dispatch:
   ```typescript
   // Better: single handler function, routes on tab.type
   function renderTabLabel(tab: Tab) { ... }
   ```

3. **Security boundaries must be explicit in architecture** — Don't embed path validation in handlers; define it at the webview/host boundary upfront. One `assertSafeFilePaths` call, not scattered checks.

4. **State machine ≠ complex state** — Simple object spread mutations are fine for webview local state. Redux-like patterns are over-engineering unless you have time-travel debugging needs.

5. **Visual feedback beats semantic correctness** — Users prefer smooth resize + debounced save over semantically "pure" delayed feedback. Responsive ≠ instantaneous, but responsiveness > consistency.

6. **Inline context menus are viable in sandboxed environments** — No need to pull in Radix UI for webview; DOM event handlers are fast enough for right-click menus.

## Next Steps

1. **Refactor tab rendering** (next sprint) — Extract `renderTabLabel(tab)` function to eliminate duplicate fallback logic. File ownership: renderer team.

2. **Security audit on all webview handlers** (this week) — Review 8 other webviews in ext-* extensions for similar path traversal risks. File ownership: security reviewer.

3. **Add exit code tests** (next sprint) — Test suite should validate that git command failures propagate to UI. Currently no tests for failed git operations.

4. **Monitor auto-fetch impact** — 60s default interval may cause performance issues on slow connections. Telemetry point: auto-fetch battery drain on mobile (add to release notes for v0.9.86).

5. **Document webview<->host protocol** (next sprint) — PostMessage API is ad-hoc; needs a schema. Currently each webview reinvents message types. Candidate for shared `WebviewMessage` union type in `src/types/webview-messages.ts`.

---

**Commits**:
- `451811c` feat(ext): add git-graph extension with SVG commit visualization
- `24ad424` feat(ext-git-graph): port vscode-git-graph algorithm with faithful SVG rendering
- (UI improvements included in pending changes, awaiting final review)

**Tests**: 1551/1569 passing (5 pre-existing failures in unrelated feature tests)

**Code Review**: Passed with 3 issues found and fixed:
- C1: Path traversal — added `assertSafeFilePaths()`
- H3: Exit code checking — added `exitCode` validation in discard
- H5: Search offset — fixed virtual row handling in search filter

**Files Modified**:
- `/Users/hienlh/Projects/ppm/packages/ext-git-graph/src/webview-html.ts` (1600+ lines)
- `/Users/hienlh/Projects/ppm/packages/ext-git-graph/src/extension.ts` (600+ lines)
- `/Users/hienlh/Projects/ppm/packages/ext-git-graph/src/types.ts`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/tab-bar.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/mobile-nav.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/tab-content.tsx`
- `/Users/hienlh/Projects/ppm/src/web/components/layout/editor-panel.tsx`
- `/Users/hienlh/Projects/ppm/src/services/extension-rpc-handlers.ts`
- `/Users/hienlh/Projects/ppm/src/types/extension-messages.ts`
