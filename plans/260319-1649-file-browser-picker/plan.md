---
title: "File Browser Picker for Path Inputs"
description: "Add Finder/Explorer-like file browser popup to all FE path inputs with BE browse API"
status: pending
priority: P1
effort: 6h
branch: main
tags: [feature, frontend, backend, ui]
created: 2026-03-19
---

# File Browser Picker for Path Inputs

## Overview

Add a native-like file/folder browser dialog to all frontend path input fields. Users currently type paths manually — this adds visual browsing with breadcrumb nav, search, quick access sidebar, path input bar, and extension filtering.

## Context

- Brainstorm: [brainstorm-260319-1649-file-browser-picker.md](../reports/brainstorm-260319-1649-file-browser-picker.md)
- Scout: [scout-260319-1642-path-folder-inputs.md](../reports/scout-260319-1642-path-folder-inputs.md)

## Key Decisions

1. **Custom in-browser file browser** (no native API available in web)
2. **Responsive**: Dialog (desktop) + Bottom Sheet (mobile)
3. **3 modes**: file / folder / both
4. **Security**: Whitelist roots, block sensitive paths
5. **Existing `GET /api/fs/list`** returns flat recursive paths — need new `GET /api/fs/browse` for structured 1-level listing

## Phases

| # | Phase | Status | Effort | Link |
|---|-------|--------|--------|------|
| 1 | Backend: fs-browse service & route | Pending | 1.5h | [phase-01](./phase-01-backend-fs-browse.md) |
| 2 | Frontend: FileBrowserPicker component | Pending | 3h | [phase-02](./phase-02-frontend-file-browser-picker.md) |
| 3 | Integration: BrowseButton + wire into consumers | Pending | 1.5h | [phase-03](./phase-03-integration-browse-button.md) |

## Dependencies

- Phase 2 depends on Phase 1 (needs API)
- Phase 3 depends on Phase 2 (needs picker component)

## File Impact

**New files:**
- `src/services/fs-browse.service.ts`
- `src/server/routes/fs-browse.ts`
- `src/web/components/ui/file-browser-picker.tsx`
- `src/web/components/ui/browse-button.tsx`

**Modified files:**
- `src/server/index.ts` — mount new route
- `src/web/components/projects/dir-suggest.tsx` — add BrowseButton
- `src/web/components/database/connection-form-dialog.tsx` — add BrowseButton for SQLite path
