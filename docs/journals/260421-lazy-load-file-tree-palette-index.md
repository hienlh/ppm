# Lazy-Load File Tree + Palette Index Feature Complete

**Date**: 2026-04-21 11:58
**Severity**: Medium
**Component**: File explorer, settings, API layer
**Status**: Resolved

## What Happened

Completed a 14-hour, 5-phase feature adding VS Code-style lazy-loaded file tree + separate flat palette index with configurable per-project exclusion rules. Full stack: backend file filtering service + index cache, settings CRUD endpoints, frontend tree UI with incremental loading, settings dialog, and chat integration. Code review caught 3 critical bugs before merge. 2 schema migration tests needed updates for schema version bump.

## The Brutal Truth

This feature works now, but it shipped with three bugs that passed unit tests. Code review was the only thing that caught them—neither the author nor 126 targeted Docker tests detected data loss, missing invalidation, or dead code. That's simultaneously reassuring (review process caught them) and horrifying (we're relying on humans, not coverage). The pre-existing test brittleness (hardcoded schema versions) exploded as soon as we bumped the schema, which means our migration tests are fundamentally fragile.

## Technical Details

### Critical Bugs Fixed

**C1: Shallow Merge in Global Settings PATCH**
- `file-filter.service.ts` excludes merged shallow into existing config
- Result: global excludes clobbered by PATCH request with only per-project rules
- Error: `Object.assign(existingConfig, newRules)` vs deep merge
- Impact: Silent data loss—no error thrown, just silently overwritten

**C2: Missing Cache Invalidation on Global PATCH**
- Global settings endpoint didn't trigger watcher-based cache invalidation
- Cache remained stale after PATCH, clients saw old excludes
- Fix: Added `invalidateIndexCache()` call in global PATCH handler

**C3: Dead AbortController Code**
- `AbortController` instantiated but never used in async tree expansion
- Removed unused variable—dead code that could confuse future devs

### Bonus Fix (H1)
- Directory entries (not just files) now included in `/files/index` flat palette
- Improves chat file-picker usability when dirs need direct reference

### Test Coverage
- 126 targeted tests pass in Docker (file-filter, file-list-index, API routes, UI components)
- Full suite has pre-existing env-related failures unrelated to this feature
- 2 migration tests updated: hardcoded schema version (19 → 21) needed manual bump

### Files Created (9 total)
**Backend Services:**
- `src/services/file-filter.service.ts` — glob matching, per-project rule logic
- `src/services/file-list-index.service.ts` — flat index cache, watcher invalidation

**Frontend UI:**
- `src/web/components/settings/files-settings-section.tsx` — settings dialog
- `src/web/components/settings/glob-list-editor.tsx` — reusable exclude rule editor
- `src/web/stores/file-tree-merge-helpers.ts` — tree merge logic for incremental load

**API & Integration:**
- `src/web/lib/api-files-settings.ts` — settings CRUD client
- 3 API integration test files (files-index, files-list, files-settings)
- 1 unit test (file-filter-service)

## What We Tried

1. **Initial Code Review**: Caught all 3 bugs before merge. Author's follow-up fixes verified via unit tests.
2. **Test Updates**: Bumped schema version in migration tests—initially hardcoded, now should be dynamic.
3. **Cache Invalidation**: Switched to watcher-only (no TTL, no focus-based refresh) to avoid stale data without over-invalidating.

## Root Cause Analysis

### Why Tests Didn't Catch These

**C1 (Shallow Merge)**
- Unit tests for file-filter mocked config objects; didn't test PATCH endpoint's Object.assign behavior
- Integration tests existed but only tested happy path (all rules provided); didn't test partial updates
- Lesson: **Partial update tests must verify existing data survives the merge**

**C2 (Missing Invalidation)**
- Cache invalidation is implicit behavior, not a testable return value
- Tests mocked the cache and watcher separately; integration test didn't verify both together
- Lesson: **Cache tests must assert invalidation side effects, not just cache contents**

**C3 (Dead Code)**
- Linting doesn't catch unused parameters; static analysis missed the instantiated-but-unused controller
- Lesson: **Code review is catching what linters miss**

### Why Schema Test Brittleness Surfaced

- Migration tests hardcoded expected schema version (19)
- Feature bumped to version 21 (2 migrations: file filters table + index rebuild)
- Tests broke because `CURRENT_SCHEMA_VERSION !== 19`
- Fix: Tests should assert `schema_version = CURRENT_SCHEMA_VERSION`, not hardcoded values
- Lesson: **Any value that changes frequently (schema, version, timestamp) should never be hardcoded in tests**

## Lessons Learned

### Process Wins
- **Code review process validated**: Caught real bugs that tests missed. This is not a failure of testing—it's confirmation that human review adds critical value.
- **Parallel execution worked**: Phase 2 (backend) + Phase 4 (chat integration) dispatched simultaneously with strict file ownership boundaries. Zero conflicts.
- **Scope flexibility paid off**: Phase 3 scope expanded mid-flight to include chat input migration and file-picker updates without cascading delays.

### Code Quality Failures
- **Integrate merge tests with cache tests**: Next time, write integration tests that verify data persists through full request cycle (PATCH → merge → cache invalidation → client read).
- **Mock less, test more**: The file-filter unit tests mocked config; should have tested actual config objects with existing state.
- **Dynamic schema assertions**: Never hardcode version numbers in tests. Parameterize against `CURRENT_SCHEMA_VERSION` or use version-agnostic comparisons.

### Architecture Patterns (Confirmed)
- Auto-expand root only, everything else lazy—minimal initial load, matches VS Code behavior
- Per-project settings scoped to active project (no dropdown)—simpler UI, avoids "which project?" confusion
- Watcher-only cache invalidation (no TTL)—eliminates background noise, piggybacks on existing FS monitoring

## Next Steps

1. **High priority**: Update all migration tests to use `CURRENT_SCHEMA_VERSION` dynamically. Prevents regression when schema changes again.
   - File: `tests/integration/db/` (any migration test files)
   - Owner: QA/testing team

2. **Medium priority**: Add integration tests for partial config updates (PATCH with subset of fields)
   - Verifies shallow merge doesn't clobber existing data
   - File: `tests/integration/api/files-settings.test.ts`
   - Estimated: 2h

3. **Documentation**: System architecture already updated; no further docs needed.

## Unresolved Questions

- Should `/files/tree` endpoint be officially deprecated, or keep it as a compatibility shim indefinitely? Currently marked deprecated but functional. No breaking change planned yet.
- Cache invalidation: Should we add a manual refresh button in UI if watcher fails, or accept data staleness as acceptable in degraded scenarios?
- File-picker: Should directory entries always be in palette, or should exclude rules filter them? Currently included unconditionally.
