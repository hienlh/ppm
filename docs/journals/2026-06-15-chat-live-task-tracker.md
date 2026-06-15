# Chat Live Task Tracker — Task* Tool Rendering & State Aggregation

**Date**: 2026-06-15 11:30  
**Severity**: Medium  
**Component**: Chat UI, Task State, Session Persistence  
**Status**: Resolved

## What Shipped

Implemented "Chat Live Task Tracker" feature. Claude's Task* tool calls (TaskCreate/TaskUpdate/TaskStop) now tracked, aggregated into a pinned FE widget, and rendered as readable status summaries (not raw JSON).

**Deliverables:**
- `src/services/task-status-aggregator.ts` — Pure fold: `aggregateTasks(messages): TaskItem[]`. Parses TaskCreate tool_result for id (`Task #N`), keys TaskUpdate/TaskStop by taskId. 7 unit tests.
- `src/server/routes/chat.ts` — New `GET /api/project/:name/chat/sessions/:id/tasks` endpoint. Rebuilds full task state from session JSONL (fixes FE truncation; BE is source of truth).
- `src/web/hooks/use-tasks.ts` + `src/web/components/chat/task-tracker.tsx` — Pinned tracker above scroll area, collapsed by default, auto-hides when done, fetches endpoint on Task events.
- `src/web/components/chat/tool-cards.tsx` — TaskCreate/TaskUpdate/TaskStop now show subject + status badge instead of raw JSON.

## The Brutal Truth

Windows path encoding silently broke the entire feature end-to-end. Task endpoint returned `[]` on Windows even with valid sessions. Caught during e2e only because I tested on the real dev machine, not in a Docker mock. Would have shipped broken on Windows.

## Technical Details

**Two platform bugs caught:**

1. **Path encoding mismatch**: `project_path` stored as `C:\Users\PC\ppm` (Windows native). SDK stores transcripts in `~/.claude/projects/c--Users-PC-ppm/` (drive lowercased, all separators → `-`). Endpoint path resolution only replaced `/` → file not found on Windows. **Fix**: Match session JSONL by scanning `~/.claude/projects/*/` prefix + drive-case-insensitive fallback.

2. **Jail check broken on Windows**: `validateJsonlPath()` compared paths with forward-slash concat, but `realpathSync()` returns backslashes. Legitimate files rejected as "path traversal detected". Also broke pre-existing `/pre-compact-messages`. **Fix**: Use path-agnostic comparison (`path.normalize` + backslash-aware separator).

## Decisions Made

**FE vs BE state ownership**: Initial plan was "FE folds local messages, no endpoint." User reversed during validation: BE must rebuild from full JSONL (truncation-proof). Replan: extract pure fold reused by both; FE fetches BE endpoint. This proved critical on Windows (FE paginated window would miss tasks).

**UI collapse behavior**: Pinned above chat, collapsed by default, auto-hides when all tasks terminal. Neutral glyph (■) for stopped tasks. Rationale: high-signal widget, low cruft when idle.

## Lessons Learned

- **Test on host platform first**. Docker tests passed but Windows host caught real bugs. Windows path handling in transcripts is a landmine (case-sensitivity, separator inconsistency).
- **Jail checks must be separator-agnostic**. Comparing paths with `+` and fixed delimiters breaks on Windows; normalize + compare canonical form.
- **Task ID lives in tool_result, not input**. SDK doesn't assign IDs; messages only know task ID retroactively from tool execution response.

## Next Steps

- Commit: Feature complete, 9/9 tests green, code review approved.
- Add Windows integration test (Windows host path encoding) to prevent regression.
- Monitor: Task endpoint perf under large sessions (fold is O(n), may want index cache).

**Status**: DONE
