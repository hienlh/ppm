# Custom Project Avatar Upload Feature Complete

**Date**: 2026-06-21 01:31
**Severity**: Low
**Component**: Project switcher, avatar storage, image processing
**Status**: Resolved

## What Happened

Shipped v0.14.9 with custom project avatar upload. Users can now upload PNG/JPG images to override project initials+color avatars in desktop switcher context menu and mobile bottom sheet. Images are content-addressed as webp, stored in `~/.ppm/avatars/`, and persisted to the database. Full stack: new `avatar-storage.service.ts` for disk I/O, client-side canvas center-crop + 128×128 webp resize, three API routes (`POST/DELETE/GET /api/projects/:name/image`), and a shared `ProjectAvatar` component replacing three duplicated inline implementations. Code review caught a latent bug in `projectService.update()` that silently wiped the new `image` field on project rename, orphaning avatar files. Fixed and locked with a regression test. 27/27 tests pass via Docker Bun; typecheck clean; shipped and published.

## The Brutal Truth

This feature was straightforward to implement but exposed a pre-existing data-loss bug we'd never noticed. The rename operation was rebuilding project entries with only `{path, name}` fields, silently discarding `color` and now `image`. We shipped this risk because tests only exercised the happy path (create avatar, fetch, delete) and never tested rename-after-upload. Code review was the sole line of defense—and it worked. That's terrifying: we ship data-loss bugs as long as tests don't explicitly verify the scenario. Tests need to cover not just the feature but all interactions with existing operations.

## Technical Details

### Two Non-Obvious Decisions

**1. Multipart Upload Bypasses api-client**
- `api-client.ts` forces `application/json` Content-Type globally
- File upload needs `multipart/form-data` with preserved boundary
- Solution: Use raw `fetch()` with manual Bearer auth header, not api-client
- Impact: Slight code duplication in upload route, but eliminates the abstraction violation

**2. Image Route Auth via Query Token**
- `<img>` tags cannot send Authorization headers
- Avatar URLs needed public GET but private write/delete
- Solution: Extended auth middleware to accept `?token={jwt}` for `/image` routes only
- Same pattern as `/files/raw` — existing precedent prevented over-engineering

### Bug Caught by Code Review

**Regression in projectService.update()**
- Original code: `entries[idx] = {path: entry.path, name: newName}`
- Problem: Spreads only `path` and `name`, discarding `color` + new `image` field
- Impact: Renaming project with avatar orphans file on disk; color resets to system default
- Fix: Changed to `entries[idx] = {...entry, name: newName}`
- Test: Added `projectService.rename-then-avatar-fetch.test.ts` to prevent regression

### Environment Risk (Resolved)

Unknown: Does Bun's `c.req.formData()` work on Windows?
- Tested via Docker `oven/bun` (host Bun segfaults on test/tsc per MEMORY.md)
- Verified: 9 image route tests pass; formData parsing works on Bun
- Risk eliminated

## Root Cause Analysis

Latent bug in `projectService.update()` existed before avatars. It was pre-existing dead code: `color` field was never updated after creation, so rename never tested it. Avatars made the bug surface by adding a new optional field that rename would also silently drop. Tests only checked "happy avatar lifecycle" (upload→fetch→delete) and never tested "avatar persists across rename." This is a pattern: feature tests often don't test cross-feature interactions. Future avatar-like features need explicit "does new field survive rename/copy/export?" test cases.

## Lessons Learned

1. **Reconstruct vs. Spread**: Never rebuild objects with hardcoded field subsets. Always use spread + selective override: `{...existing, field: newValue}`. Catches this class of bug automatically.
2. **Cross-feature test coverage**: New optional fields must have integration tests with all update operations (rename, copy, export, etc.), not just CRUD on the field itself.
3. **Multipart + Bearer**: Raw fetch for multipart is acceptable when global middleware enforces a different content-type. Document why and link to precedent (here: `/files/raw`).

## Next Steps

1. **Quick**: Audit other `projectService` methods for similar field-dropping patterns. Look for `{field1: x, field2: y}` object literals instead of spreads.
2. **Medium**: Add test helper `testFieldPersistence(field, operations)` to parameterize "field survives rename/copy/export" assertions.

## Unresolved Questions

- Should orphaned avatar files be garbage-collected on rename, or is the orphan acceptable? Currently no GC—disk waste is small but could accumulate.
- Should avatar upload show progress bar for slow networks, or is instant feedback adequate? Currently no progress—spec was silent on this.
