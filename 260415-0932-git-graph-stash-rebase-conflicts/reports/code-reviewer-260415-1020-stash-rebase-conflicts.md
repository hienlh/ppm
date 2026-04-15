# Code Review: Git Graph — Stash, Rebase, Conflicts

**Date:** 2026-04-15  
**Reviewer:** code-reviewer  
**Scope:** 10 files changed, ~600 LOC net new

## Scope

| File | Role |
|------|------|
| `packages/ext-git-graph/src/types.ts` | Type definitions |
| `packages/ext-git-graph/src/extension.ts` | Backend: stash/merge-state/conflict handlers |
| `packages/ext-git-graph/src/webview-html.ts` | Webview: stash popover, merge banner, conflict UI |
| `src/web/components/editor/conflict-editor.tsx` | NEW: Monaco conflict resolution editor |
| `src/web/stores/tab-store.ts` | TabType union |
| `src/web/stores/panel-utils.ts` | `deriveTabId` for conflict-editor |
| `src/web/components/layout/editor-panel.tsx` | TAB_COMPONENTS registration |
| `src/web/components/layout/tab-content.tsx` | TAB_COMPONENTS registration |
| `src/web/components/layout/mobile-nav.tsx` | Icon mapping |
| `src/web/components/layout/tab-bar.tsx` | Icon mapping |

## Overall Assessment

Well-structured feature addition. Security practices (assertSafeFilePaths, assertValidRef, escHtml) are consistently applied to the new surface area. Three blocking issues, four informational.

---

## Critical Issues

### C1 — `detectMergeState` hardcodes `.git` path, breaks for worktrees

**File:** `extension.ts:531-562`

```typescript
const rebaseMergeDir = `${projectPath}/.git/rebase-merge`;
const checkMerge = await vscode.process.spawn("test", ["-f", `${projectPath}/.git/MERGE_HEAD`], ...);
```

For git worktrees, `.git` inside the worktree directory is a **file** (containing `gitdir: /path/to/main/.git/worktrees/<name>`), not a directory. The rebase/merge state is stored under `$GIT_DIR/rebase-merge`, where `$GIT_DIR` for a worktree is `<main>/.git/worktrees/<name>`. The current hardcoded path will always fail `test -d` / `test -f` for worktrees, silently returning `undefined` for `mergeState`.

The PPM app already heavily uses worktrees (worktree CRUD is a major feature of this same extension). Merge conflicts inside a worktree will show files as conflicted but the banner will never appear.

**Fix:** Use `git rev-parse --git-dir` to get the actual `GIT_DIR`, then construct paths from that:

```typescript
async function detectMergeState(vscode, projectPath) {
  const gitDirResult = await spawnGit(vscode, ["rev-parse", "--git-dir"], projectPath, { timeout: 2000 });
  if (gitDirResult.exitCode !== 0) return undefined;
  const gitDir = gitDirResult.stdout.trim();
  const absGitDir = gitDir.startsWith("/") ? gitDir : `${projectPath}/${gitDir}`;
  
  const checkRebase = await vscode.process.spawn("test", ["-d", `${absGitDir}/rebase-merge`], projectPath, { timeout: 2000 });
  // ... rest of checks use absGitDir instead of `${projectPath}/.git`
}
```

---

### C2 — `getDisplayCommits` excludes virtual row for conflict-only state

**File:** `webview-html.ts:1382-1383`

```javascript
function getDisplayCommits() {
  const u = state.uncommitted;
  if (!u || (u.staged.length === 0 && u.unstaged.length === 0)) return state.commits;
  // virtual row only added if staged or unstaged files exist
```

When a merge conflict exists but no staged/unstaged changes (pure merge conflict during `git merge`), `conflicted.length > 0` but `staged.length === 0 && unstaged.length === 0`. The virtual uncommitted row is **not added to the commit list**. The user sees the merge banner but cannot click into the uncommitted detail panel to reach the conflict file list and the "open conflict editor" button.

The conflict panel is properly rendered in `renderUncommittedDetail` (checks `u.conflicted`) but is unreachable because `selectCommit('uncommitted')` is only triggered by clicking the virtual row.

**Fix:**

```javascript
if (!u || (u.staged.length === 0 && u.unstaged.length === 0 && (!u.conflicted || u.conflicted.length === 0))) 
  return state.commits;
```

And update the virtual commit message:
```javascript
const totalFiles = u.staged.length + u.unstaged.length + (u.conflicted?.length || 0);
message: `Uncommitted Changes (${totalFiles} files)${u.conflicted?.length ? ' ⚠ conflicts' : ''}`,
```

---

### C3 — Style injection in `ConflictEditor.handleMount` is not idempotent

**File:** `conflict-editor.tsx:286-301`

```typescript
const handleMount: OnMount = (editor, monaco) => {
  // ...
  const styleEl = document.createElement("style");
  styleEl.textContent = `...conflict styles...`;
  editor.getDomNode()?.ownerDocument?.head?.appendChild(styleEl);
```

`handleMount` fires each time the Monaco editor mounts. If the conflict editor tab is opened, closed, and reopened, the style tag accumulates in `<head>`. This doesn't cause broken behavior (CSS rules are idempotent) but leaks DOM nodes.

**Fix:** Add an ID guard:
```typescript
const DOC_STYLE_ID = "conflict-editor-styles";
if (!editor.getDomNode()?.ownerDocument?.getElementById(DOC_STYLE_ID)) {
  const styleEl = document.createElement("style");
  styleEl.id = DOC_STYLE_ID;
  styleEl.textContent = `...`;
  editor.getDomNode()?.ownerDocument?.head?.appendChild(styleEl);
}
```

---

## High Priority

### H1 — Content widget removal uses an invalid fake object

**File:** `conflict-editor.tsx:145-148`

```typescript
for (const wid of widgetIdsRef.current) {
  const w = editor.getLayoutInfo() && { getId: () => wid } as MonacoType.editor.IContentWidget;
  try { editor.removeContentWidget(w); } catch { /* ignore */ }
}
```

`editor.getLayoutInfo()` always returns a truthy object when the editor is alive; `&&` effectively just evaluates to `{ getId: () => wid }`. Monaco's `removeContentWidget` accepts `IContentWidget`, which requires `getDomNode()` and `getPosition()` methods. Monaco's implementation internally looks up widgets by their ID string, so this happens to work — but it is type-unsafe and relies on Monaco's internal implementation detail.

The silent `try/catch` hides any future Monaco version breaking this. The real widgets are never stored, so they cannot be properly removed.

**Fix:** Store actual widget references:
```typescript
const widgetsRef = useRef<MonacoType.editor.IContentWidget[]>([]);

// In refreshConflicts — removal:
for (const w of widgetsRef.current) {
  editor.removeContentWidget(w);
}
widgetsRef.current = [];

// When adding:
editor.addContentWidget(widget);
widgetsRef.current.push(widget);
```

---

### H2 — `ResizeObserver` re-subscribes unnecessarily on `loading`/`error` changes

**File:** `conflict-editor.tsx:109-117`

```typescript
useEffect(() => {
  const el = containerRef.current;
  if (!el) return;
  const ro = new ResizeObserver(...);
  ro.observe(el);
  return () => ro.disconnect();
}, [loading, error]);  // ← problem
```

The dependency array `[loading, error]` causes the `ResizeObserver` to be torn down and recreated every time loading/error state changes. The intent is to observe after the container renders (post-loading). However, the container `<div ref={containerRef}>` is always mounted (it wraps the Monaco editor), so `containerRef.current` is stable. The correct approach is `[]` (observe once on mount):

```typescript
}, []);  // containerRef is stable; re-observe not needed on state changes
```

---

## Medium Priority

### M1 — `acceptConflict` resolves by region ID but re-parses the full file

**File:** `conflict-editor.tsx:224-263`

```typescript
const acceptConflict = useCallback((regionId: number, ...) => {
  const value = model.getValue();
  const regions = parseConflicts(value);
  const region = regions.find((r) => r.id === regionId);
```

Region IDs are assigned sequentially (0, 1, 2, ...) in `parseConflicts`. After resolving region `id=0`, the model is updated, then `refreshConflicts` re-parses — and the remaining regions are now renumbered starting from 0. If the user clicks "Accept Current" on region 1 (now rendered as `conflict-widget-1`), then resolves region 0 without refreshing, the ID lookup will still find the correct region because `acceptConflict` re-parses the current model state. This is actually correct.

However, the `setTimeout(() => refreshConflicts(), 50)` is a fragile way to wait for model stabilization. Monaco's `pushEditOperations` is synchronous; the model is updated before the call returns. `refreshConflicts` can be called directly:

```typescript
saveFile(model.getValue());
refreshConflicts(); // synchronous - no timeout needed
```

### M2 — Merge banner `action.includes('Abort')` is fragile string matching

**File:** `webview-html.ts:927`

```javascript
const action = btn.dataset.mergeAction;
if (action.includes('Abort')) {
```

This works for the current action names (`rebaseAbort`, `mergeAbort`, `cherryPickAbort`) but is fragile if new actions are added. Prefer an explicit set:

```javascript
const ABORT_ACTIONS = new Set(['rebaseAbort', 'mergeAbort', 'cherryPickAbort']);
if (ABORT_ACTIONS.has(action)) {
```

### M3 — Stash popover and worktree popover do not close each other

**File:** `webview-html.ts:763-764, 953-954`

Two separate `document.addEventListener('click', ...)` handlers: one closes the worktree popover when clicking outside `.worktree-dropdown`, another closes the stash popover when clicking outside `.stash-dropdown`. But clicking the stash button while the worktree popover is open does NOT close the worktree popover (the stash button is inside `.stash-dropdown`, not `.worktree-dropdown`, so the worktree handler runs and closes it). Actually this works correctly by accident — the worktree click handler fires on every click and checks `closest('.worktree-dropdown')`.

Testing shows this is fine, but it's worth adding a mutual close for clarity:
```javascript
btnStash.addEventListener('click', (e) => {
  wtPopover.classList.add('hidden'); // close sibling
  // ...
});
```

---

## Low Priority

### L1 — `conflict-editor.tsx`: `filePath.split("/")` is not cross-platform

**File:** `conflict-editor.tsx:306`

```typescript
const fileName = filePath?.split("/").pop() ?? "unknown";
```

On Windows paths use `\`. Prefer a regex: `.split(/[\\/]/).pop()`. (Consistent with the extension's existing pattern.)

### L2 — Empty conflict resolution leaves a blank line

When "Accept Current" or "Accept Incoming" is used on a conflict where one side is empty (e.g., `<<<<<<< HEAD\n=======\n>>>>>>> branch`), `replacement` = `""` and `text: "" + "\n"` inserts a single blank line. Minor but can leave stray newlines in the file. Low impact.

### L3 — `parseConflicts` doesn't handle diff3-style conflicts

`git` can be configured to use `diff3` style which adds a base section between `<<<` and `===`. The parser looks for `=======` but diff3 adds `||||||| base` between `<<<<` and `=====`. In diff3 mode, the parser would put the base content into `currentContent` and miss the real separator. Not broken but results in "Accept Current" keeping the diff3 base section too.

---

## Edge Cases Found

1. **Conflict-only state (C2 above):** No virtual uncommitted row = no access to conflict file list. Blocking.
2. **Worktree rebase detection (C1 above):** Hardcoded `.git/rebase-merge` fails for all worktrees.
3. **Empty conflict sides:** Resolving an empty-vs-content conflict inserts a blank line (L2).
4. **diff3 style conflicts:** Parser misidentifies `||||||| base` as current content (L3).
5. **stash popover and worktree popover open simultaneously:** Both can be visible together until a click. Minor UX.

---

## Positive Observations

- `assertSafeFilePaths` is applied to `openConflictFile` consistently.
- `escHtml` is applied to all user-visible git data in the webview (stash messages, branch names, file paths).
- `assertValidRef` correctly blocks the commit hash passed to `rebase` from the context menu (no injection possible).
- Stash message parsing correctly handles pipe characters in stash messages via `.slice(2).join("|")`.
- The 500-file limit in `handleUncommittedStatus` applies globally, preventing unbounded memory use.
- ResizeObserver cleanup (`return () => ro.disconnect()`) is present.
- Git stash index is always a safe integer (enforced by both parsing paths).
- Stash drop/abort operations correctly use confirmation dialogs.
- `rebaseContinue`/`rebaseAbort`/`mergeAbort` correctly added to `buildGitActionArgs` with no extra args needed (safe).

---

## Recommended Actions

1. **[C1 — BLOCK]** Fix `detectMergeState` to use `git rev-parse --git-dir` before constructing paths.
2. **[C2 — BLOCK]** Fix `getDisplayCommits` to include virtual row when `conflicted.length > 0`.
3. **[C3 — BLOCK]** Add ID guard to style injection in `handleMount`.
4. **[H1]** Store actual widget references instead of fake objects for `removeContentWidget`.
5. **[H2]** Change ResizeObserver dependency to `[]`.
6. **[M1]** Remove `setTimeout` before `refreshConflicts` call in `acceptConflict`.
7. **[M2]** Replace `action.includes('Abort')` with a `Set` check.

---

## Unresolved Questions

1. Is the git graph webview ever shown for a worktree project path? If not, C1 is lower priority, but the worktree feature exists so it should be assumed yes.
2. Is diff3 conflict style expected to be supported? If users have `merge.conflictstyle=diff3` in their gitconfig, the parser will silently produce wrong results.
3. Should "Accept Both" include a separator between current and incoming content? Some editors insert `--- current ---` / `--- incoming ---` comments when accepting both.
