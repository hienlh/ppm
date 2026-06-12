# Clickable file:line References in Chat Messages

**Date**: 2026-06-12 12:42 UTC
**Severity**: Medium (polish feature, enables better UX)
**Component**: Chat → Editor integration (markdown rendering, tab navigation)
**Status**: Complete (commit 616dacf)

## What Happened

Inline code refs like `utils.ts:6215` and ranges `utils.ts:6215-6230` in chat markdown are now clickable. Click opens the file in Monaco editor scrolled to the target line; ranges get selected/highlighted. Already-open files jump on re-click instead of ignoring the request.

## The Brutal Truth

This should have been obvious from the start: if a chat system outputs file paths with line numbers, users will click them expecting to jump. Shipping chat without this felt half-baked. The fix is small but unlocks a core convenience feature that makes the entire chat-to-editor workflow smoother.

## Technical Details

**Parsing:** `LINE_REF_RE = /^(.+?):(\d+)(?:-(\d+))?$/` (markdown-code-block.tsx:68)
- Non-greedy match (`.+?`) + `$` anchor ensures the regex binds to the LAST `:digits` sequence
- Critical for Windows absolute paths: `C:\proj\utils.ts:6215` ends in `:6215`, not `.ts`
- Old `FILE_EXT_RE` alone failed because it requires the string to END in an extension (`.ts`, `.js`, etc.), but `utils.ts:6215` ends in `:6215`
- Matches single line (`utils.ts:42`) or range (`utils.ts:42-65`)

**Reveal problem solved:** Tab metadata includes `revealAt = Date.now()` nonce (markdown-renderer.tsx:61)
- Tab dedup keys on filePath alone (ignores line number)
- Monaco reveal logic runs in `useEffect([revealAt])` on code-editor.tsx:413-416
- Without the nonce, re-clicking an already-open file or clicking a different line in the same file does nothing — the metadata changed but revealAt stayed the same, so the effect doesn't re-fire
- Nonce forces re-fire every time, enabling jump-on-re-click

**Metadata handling:** `updateTab(id, {metadata})` shallow-merges at tab level (panel-store)
- Code builds full metadata object (filePath, projectName, lineNumber, endLine, revealAt) to avoid dropping fields
- Shallow merge preserves other metadata fields added by callers

**Bonus fix:** The same metadata + useEffect pattern fixed search-panel's jump-to-line for already-open files (search-panel wasn't re-triggering on re-click either before).

## What We Tried

- Initial approach: metadata-only jump without nonce → failed for already-open files
- Solution: add revealAt timestamp nonce → forces useEffect re-fire → works

## Root Cause Analysis

The reveal effect was designed for onMount only (load file, then jump). Re-opening an already-loaded file never triggered the reveal because the dependency array didn't change. The fix recognizes that metadata can change independently of component mount, and uses a timestamp nonce to signal "re-jump now even though it's the same file."

## Lessons Learned

1. **Dependency arrays on mutable values**: When effects depend on values that can change outside the component (metadata from store), include a nonce or timestamp to force re-fire when the semantic meaning changes even if the old values haven't.
2. **Tab dedup keys matter**: Deduping by filePath alone makes sense for memory, but you need a way to signal "same file, different line" without changing the tab identity.
3. **Window paths are tricky**: Non-greedy regex + `$` anchor is safer than trying to parse file extensions after seeing `:digits`.

## Next Steps

- Watch for edge cases: ambiguous basenames (multiple files with same name) fall back to command palette and lose the line number (acceptable for now, out of scope)
- Consider surfacing line:range refs in other markdown contexts (docs, tooltips) — pattern is solid
- Monitor user feedback on ref parsing (Windows paths, edge cases)

**Files changed**:
- src/web/components/shared/markdown-code-block.tsx (parsing + click handler)
- src/web/components/shared/markdown-renderer.tsx (revealAt nonce injection)
- src/web/components/editor/code-editor.tsx (reveal effect, metadata merge)
- src/web/components/shared/markdown-context.ts (signature only)

**Status**: DONE — Code review complete (no blocking issues), typecheck clean via Docker oven/bun.
