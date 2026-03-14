# Phase 6: Git Integration — Implementation Report

**Status:** Completed
**Date:** 2026-03-14

## Files Created
- `src/services/git.service.ts` — GitService class (status, diff, stage/unstage, commit, push/pull, branches, graph, cherry-pick, revert, tag, PR URL)
- `src/server/routes/git.ts` — 17 Hono routes (GET + POST) for all git operations
- `src/web/components/git/git-status-panel.tsx` — Full status panel with stage/unstage/commit/push/pull
- `src/web/components/git/git-graph.tsx` — Commit graph with lane coloring, branch/tag labels, context menus

## Files Modified
- `src/server/index.ts` — Added git routes import + mount at `/api/git`
- `src/web/components/editor/diff-viewer.tsx` — Replaced placeholder with real @codemirror/merge unified diff viewer
- `src/web/components/layout/tab-content.tsx` — Wired real GitGraph + GitStatusPanel instead of placeholders

## Backend Summary
- **GitService**: Uses simple-git for all operations. `graphData()` uses `.log({ '--all': null, maxCount })` + raw `--format=%H %P` for parent hashes (per v1 lesson). PR URL parsing supports GitHub + GitLab SSH/HTTPS remotes.
- **Routes**: 5 GET + 12 POST endpoints. All use `ok()`/`err()` envelope. Project resolved by name via `resolveProjectPath()`.

## Frontend Summary
- **GitStatusPanel**: Two sections (Staged/Changes), per-file +/- stage/unstage, commit textarea with Cmd+Enter, push/pull buttons. Auto-refresh after actions.
- **GitGraph**: Scrollable commit list with lane-colored dots, abbreviated hash, subject, author, relative date. Branch labels as colored badges, tag labels in amber. Nested ContextMenus on both commits (checkout, create branch, cherry pick, revert, tag, copy hash, view diff) and branch labels (checkout, merge, push, create PR, delete).
- **DiffViewer**: Fetches diff from API, parses unified diff into original/modified, renders with `@codemirror/merge` `unifiedMergeView`. Syntax highlighting by file extension.

## Tests Status
- Type check: PASS (0 errors)
- Build: PASS (368ms)

## Design Decisions
- Git graph uses simple list layout (colored dots per lane) instead of SVG — KISS for v1, performant, works well on mobile
- Diff viewer uses inline unified merge view rather than side-by-side — better mobile experience
- Branch/tag labels parsed from both `git branch -a` and commit refs field
