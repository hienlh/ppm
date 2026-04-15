## Code Review: New File Editor Tab Feature

### Scope
- Files: 8 (panel-utils.ts, tab-store.ts, code-editor.tsx, save-as-dialog.tsx, tab-bar.tsx, use-global-keybindings.ts, keybindings-store.ts, command-palette.tsx)
- Focus: New untitled tab lifecycle, Save As transition, entry points
- Scout findings: Race condition in metadata persistence, stale tab ID after Save As, Ctrl+S binding leak

### Overall Assessment
Feature is well-structured with clean separation between store logic, editor behavior, and UI entry points. The untitled number allocation via `getNextUntitledNumber()` scanning all panels is correct. However, the Save As transition has two critical issues that will cause user-visible bugs in production.

---

### Critical Issues

#### 1. Race condition: debounced metadata persistence overwrites Save As transition

**File:** `src/web/components/editor/code-editor.tsx` lines 272-276

**Problem:** `handleChange` sets a 2-second debounced timer to persist `unsavedContent` to tab metadata. `handleSaveAs` does NOT clear `saveTimerRef`. If the user types, then triggers Save As within the 2s debounce window, the pending timeout fires after Save As and calls:

```ts
updateTab(tabId, { metadata: { ...oldMetadata, unsavedContent: latestContent } })
```

The `oldMetadata` closure captured at the time of the keystroke still has `isUntitled: true`. This **reverts** the Save As transition, restoring the tab to untitled state. The file is written to disk but the tab loses its file association.

**Fix:** Clear `saveTimerRef` at the start of `handleSaveAs`:

```ts
const handleSaveAs = useCallback(async (targetPath: string, savedText: string) => {
  // Cancel any pending metadata persistence to prevent race condition
  if (saveTimerRef.current) {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }
  try {
    await api.put("/api/fs/write", { path: targetPath, content: savedText });
    // ... rest
```

#### 2. Tab ID not updated after Save As -- stale ID causes duplicate tabs

**File:** `src/web/components/editor/code-editor.tsx` lines 283-296

**Problem:** After Save As, `updateTab` changes the tab's metadata (filePath, removes isUntitled) but the tab ID remains `editor:untitled-N`. The `updateTab` API signature `Partial<Omit<Tab, "id">>` prevents changing the ID. Consequences:

- Opening the same file from explorer or command palette creates a **second tab** with ID `editor:/path/to/file` (dedup logic in `openTab` checks by ID)
- The `getNextUntitledNumber()` scanner still sees the old `editor:untitled-N` ID, so it considers number N as "taken" even though the tab is no longer untitled
- Tab persistence to localStorage/server keeps the stale ID

**Fix:** Replace the `updateTab` call with a close-then-open sequence:

```ts
const handleSaveAs = useCallback(async (targetPath: string, savedText: string) => {
  if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
  try {
    await api.put("/api/fs/write", { path: targetPath, content: savedText });
    if (tabId) {
      // Close the untitled tab and open as a proper file tab
      const panelStore = usePanelStore.getState();
      panelStore.closeTab(tabId);
      panelStore.openTab({
        type: "editor",
        title: basename(targetPath),
        projectId: null,
        metadata: { filePath: targetPath },
        closable: true,
      });
    }
    setShowSaveAs(false);
  } catch { /* silent */ }
}, [tabId]);
```

**Alternative (simpler but less clean):** Add a `replaceTabId` method to panel-store that atomically swaps a tab's ID.

---

### High Priority

#### 3. Ctrl+S Monaco binding leaks after Save As

**File:** `src/web/components/editor/code-editor.tsx` lines 315-320

**Problem:** `handleEditorMount` registers `Ctrl+S -> setShowSaveAs(true)` once when `isUntitled` is true. After Save As transitions the tab, the Monaco command is never removed. Pressing Ctrl+S re-opens the Save As dialog instead of doing nothing (the global `save-prevent` handler only `preventDefault()`s the browser dialog, it doesn't trigger actual file save).

**Impact:** After saving an untitled file, every subsequent Ctrl+S opens Save As again instead of silently auto-saving.

**Fix (combined with Issue #2):** If using the close-then-open approach from Issue #2, this is automatically resolved since the new editor instance mounts without the untitled binding. If keeping `updateTab`, add a `useEffect` that removes and re-registers commands when `isUntitled` changes, or guard the callback:

```ts
editor.addCommand(
  monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
  () => {
    // Check current state at invocation time, not registration time
    if (metadata?.isUntitled) setShowSaveAs(true);
  },
);
```

However, this still requires `metadata` to be current. A better approach uses a ref:

```ts
const isUntitledRef = useRef(isUntitled);
isUntitledRef.current = isUntitled;

// In handleEditorMount:
editor.addCommand(
  monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
  () => { if (isUntitledRef.current) setShowSaveAs(true); },
);
```

#### 4. Metadata replacement (not merge) loses context in `handleChange`

**File:** `src/web/components/editor/code-editor.tsx` line 275

`updateTab` in panel-store does shallow spread: `{ ...t, ...updates }`. When `updates` contains `{ metadata: {...} }`, the entire `metadata` object is replaced, not deep-merged. Currently this is fine because untitled tabs only have `isUntitled`, `untitledNumber`, and `unsavedContent`. But if any code adds additional metadata keys to the tab between creation and the debounced save, they would be silently dropped.

**Recommendation:** Use explicit merge:

```ts
updateTab(tabId, { metadata: { ...(ownTab?.metadata ?? {}), unsavedContent: latestContentRef.current } });
```

Or better yet, read current metadata from the store at timeout fire time rather than closing over the render-time value.

---

### Medium Priority

#### 5. `handleEditorMount` has incomplete dependency array

**File:** `src/web/components/editor/code-editor.tsx` line 388

```ts
}, [sqlSchemaInfo]); // eslint-disable-line react-hooks/exhaustive-deps
```

The `useCallback` for `handleEditorMount` lists only `[sqlSchemaInfo]` as a dependency but uses `isUntitled`, `lineNumber`, `isSql`, and several refs. The eslint suppression hides stale closure bugs. Specifically, if `isUntitled` changes (impossible in practice for mount, but the lint suppression is risky for future changes).

**Recommendation:** This was pre-existing and the new code (`isUntitled` check inside) works because `handleEditorMount` only fires once per editor instance. No action needed now, but note for future.

#### 6. New tab dropdown menu: custom implementation vs existing dropdown component

**File:** `src/web/components/layout/tab-bar.tsx` lines 98-107, 240-262

The dropdown uses a manual `showNewMenu` state + `mousedown` outside click handler. This:
- Doesn't handle Escape key to close
- Doesn't handle focus management / trap
- Doesn't handle mobile touch events properly (no long-press activation)

Per the design guidelines ("Context menus -> long-press on mobile"), the tab bar dropdown is `hidden md:flex` so it only shows on desktop. No mobile issue, but missing Escape handling is a usability gap.

**Recommendation:** Use `DropdownMenu` from shadcn/ui for built-in keyboard navigation and accessibility.

#### 7. Save As dialog: `filename` validation allows path traversal characters

**File:** `src/web/components/editor/save-as-dialog.tsx` line 27

```ts
if (/[/\\]/.test(trimmed)) { setError("Filename cannot contain / or \\"); return; }
```

This blocks slashes but allows other potentially problematic characters (`..`, null bytes, colons on Windows, etc.). The server-side `writeSystemFile` has `isAllowedPath` guard which mitigates exploitation, but client-side validation could be more robust.

**Recommendation:** Also reject filenames starting with `.` (hidden files), containing `..`, or with special chars like `:`, `*`, `?`, `"`, `<`, `>`, `|` (Windows-unsafe).

---

### Low Priority

#### 8. Tab bar dropdown shortcut labels are hardcoded

**File:** `src/web/components/layout/tab-bar.tsx` lines 251-256

Shortcuts are hardcoded as strings (`"⌘L"`, `"⌘N"`, etc.) instead of reading from the keybindings store. If a user customizes their keybindings, the dropdown would show wrong shortcuts.

**Recommendation:** Use `formatCombo(getBinding("new-file"))` etc., matching the command palette's approach.

#### 9. Minor: `getNextUntitledNumber` is O(all tabs) on every new file creation

**File:** `src/web/stores/panel-utils.ts` lines 77-86

Scans all tabs in all panels to find max untitled number. Negligible with normal tab counts (< 100), but worth noting.

---

### Positive Observations

- Clean separation: untitled logic in store, persistence in editor, UI in dialog
- `getNextUntitledNumber` correctly scans all panels (multi-panel aware)
- Server-side `isAllowedPath` guard protects Save As writes
- `deriveTabId` correctly handles the untitled pattern
- Multiple entry points (dropdown, Ctrl+N, command palette) all route through `openNewFile()` -- single source of truth
- Keyboard shortcut added to keybindings store (customizable)
- The `isUntitled` check in the file load effect correctly skips API call and restores from metadata

### Recommended Actions (Priority Order)

1. **[CRITICAL]** Clear `saveTimerRef` in `handleSaveAs` to prevent metadata race condition
2. **[CRITICAL]** Fix tab ID persistence after Save As -- either close+reopen or add a `replaceTabId` store method
3. **[HIGH]** Fix Ctrl+S Monaco binding to check current untitled state via ref, not mount-time closure
4. **[MEDIUM]** Consider using shadcn DropdownMenu for the tab bar "+" menu
5. **[LOW]** Read shortcut labels from keybindings store in tab bar dropdown

### Unresolved Questions

- Should there be a "close without saving" confirmation for untitled tabs with content? Currently closing an untitled tab silently discards content (metadata is removed, localStorage entry is gone). This could surprise users.
- Should the Save As dialog support saving within a project (relative paths) or only absolute paths? Currently it always uses `/api/fs/write` which writes to absolute paths. After Save As, the file is treated as an "external file" even if it's inside the active project directory.
