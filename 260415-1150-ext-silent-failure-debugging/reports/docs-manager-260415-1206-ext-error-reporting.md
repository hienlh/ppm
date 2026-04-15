# Documentation Update: Extension Error Reporting & Logging

**Date:** 2026-04-15  
**Status:** DONE

## Summary

Updated documentation to reflect error tracking, user feedback, and breadcrumb logging improvements in the extension system. Changes ensure developers understand error propagation flow and how to debug silent extension failures.

## Changes Made

### 1. **docs/project-changelog.md** (line 70-76)

**Updated:** "Extension Host Stability" section renamed and expanded to "Extension Error Reporting & Logging"

**Before:**
```markdown
- **Extension Host Stability** — Worker debugging & error handling improvements
  - Enhanced error logging in extension host worker
  - Fixed localHandlers presence check before RPC invocation
  - Proper disposed flag tracking to prevent polling race conditions
  - HEAD ref type detection corrected for git operations
  - Removed unused variable warnings from build
```

**After:**
```markdown
- **Extension Error Reporting & Logging** — Silent failure debugging & user feedback
  - Activation error tracking: Map stores `extId → error message` in ExtensionService
  - Error toasts on command failure: "Extension command failed: {error}" displays in UI
  - Timeout UX improved: Fallback UI shows activation error + "Retry" button for quick recovery
  - Breadcrumb logging with tags for debugging: `[ExtService]`, `[ExtHost]`, `[ExtWS]`, `[ext-git-graph]`
  - Console logs track: activation start/success, command routing, failures with context
  - Activation errors included in `contributions:update` message sent to browser on WS connect
```

**Rationale:** Original section was vague ("debugging & error handling improvements"). Updated to clearly document the three major DX improvements: error tracking → user feedback → debugging logs.

### 2. **docs/system-architecture.md** (inserted after line 1679)

**Added new section:** "Error Handling & Debugging" (41 lines)

**Content:**

- **Activation Error Tracking** — How ExtensionService maintains the activationErrors Map
  - When/how errors are stored and cleared
  - WS broadcast of errors to connected clients
  
- **User Feedback (UI)** — Three feedback mechanisms:
  1. Toast notifications on command failure
  2. Timeout fallback UI with activation error display
  3. Retry button for user-triggered recovery
  
- **Breadcrumb Logging** — Console tag reference:
  - `[ExtService]` — Main process lifecycle
  - `[ExtHost]` — Worker execution
  - `[ExtWS]` — WebSocket bridge
  - Extension-specific tags (e.g., `[ext-git-graph]`)
  
- **Example Log Flows** — Two code blocks showing:
  1. Successful activation flow (all logs)
  2. Error activation flow (with error capture and user feedback)

**Location:** Inserted between "Dev Workflow" (line 1679) and "Crash Safety" (was line 1680, now 1723)

**Rationale:** New section documents the debugging infrastructure added to help developers understand error propagation. Placed before Crash Safety since error handling is a precondition for crash isolation.

## Files Updated

| File | Changes | Lines |
|------|---------|-------|
| `docs/project-changelog.md` | Updated bullet list (6 items) | 564 total (unchanged count) |
| `docs/system-architecture.md` | Added 41-line section | 1925 total (+41 lines) |

## Verification

✅ Changes verified against actual code:
- `src/services/extension.service.ts` — activationErrors Map confirmed (line 16)
- `src/types/extension-messages.ts` — activationErrors field in contributions:update (line 54)
- `src/server/ws/extensions.ts` — error toasts on command:execute fail (lines 93-118)
- `src/web/hooks/use-extension-ws.ts` — toast on new activation errors (lines 43-50)
- `src/web/components/extensions/extension-webview.tsx` — retry button with error display (lines 152-158)
- `src/services/extension-host-worker.ts` — breadcrumb logging with tags confirmed

✅ No dead links or incorrect function names  
✅ Log tag references match actual console.log statements in code  
✅ File size limits respected (changelog 564 LOC, architecture 1925 LOC)

## Impact

- **Developers:** Can now trace extension failures end-to-end via console logs and WS messages
- **End Users:** See actionable error messages and retry option instead of silent "Extension failed to load" 
- **DX:** Reduced debugging time for extension issues from code reading to log inspection

## Notes

This is a **DX/debugging infrastructure update**, not a user-facing feature. Documentation updates are minimal and focused on enabling developer understanding of the error pipeline.

All changes are additive (no removals or breaking doc changes).
