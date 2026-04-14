# Git-Graph Extension Port — Phase 1-4 Complete

**Date**: 2026-04-14 14:00
**Severity**: Medium (architectural pattern addition)
**Component**: @ppm/ext-git-graph (new extension), process:spawn RPC handler, extension RPC security
**Status**: Resolved (phases 1-4), Phase 5 deferred to v0.2

## What Happened

Completed port of vscode-git-graph concepts to PPM as a self-contained extension. Full implementation of phases 1-4 per plan at `plans/260414-1132-ext-git-graph-port/plan.md`:

1. **Extension scaffold** — Created `packages/ext-git-graph/` with clean-room rewrite (not copy-paste from vscode-git-graph)
2. **Git log parsing** — Implemented `GitLogParser` to parse `git log --pretty=fuller --numstat` into SVG-compatible commit graph (7 source files)
3. **RPC infrastructure** — Added `process:spawn` handler to PPM core enabling extensions to execute subprocesses from Worker threads
4. **Security hardening** — Fixed critical vulnerability in process:spawn with command allowlist + CWD sandboxing + env var filtering
5. **Tests** — 62 new tests, all 1269 suite passing, zero TypeScript regressions

Committed as `451811c` with 2304 lines across 14 files.

## The Brutal Truth

This was **exciting but risky**. We shipped a brand-new capability (process spawning from extensions) and initially did it with zero security guardrails. The security review caught it immediately, but that's a pattern we need to kill: **never add execution capabilities without threat modeling first.**

The temptation to just make git work from the webview was strong enough that we cut corners on the design phase. We got lucky the code reviewer was paranoid. Next time it won't be.

## Technical Details

### Process Spawn Handler (src/services/extension-rpc-handlers.ts)

Added `process:spawn` RPC handler enabling extensions to execute commands. Initial implementation had **no restrictions** — any command, any args, any env.

```typescript
// BEFORE: Wide open execution
const { command, args, options } = message.payload;
const process = spawn(command, args, options);

// AFTER: Allowlist + constraints
const ALLOWED_COMMANDS = new Set(['git', 'node', 'bun', 'npx', 'sqlite3']);
if (!ALLOWED_COMMANDS.has(command)) {
  throw new Error(`Command not allowed: ${command}`);
}
// CWD sandboxed to project directory
// ANTHROPIC_API_KEY and auth env vars filtered
```

### Git Log Parsing (packages/ext-git-graph/src/git-log-parser.ts)

Switched from `--stat` to `--numstat` for reliable file change counts. `--stat` produces human-readable output that varies by terminal width; `--numstat` is machine-parseable and deterministic.

```bash
# Used:
git log --pretty=fuller --numstat --graph

# Output: additions<tab>deletions<tab>filename
1    0    src/app.ts
14   2    package.json
```

### Security Fixes

**Root cause**: Added new capability without threat model. Extensions running in Worker threads got full subprocess execution permission.

**Fix**:
- Command allowlist (git, node, bun, npx, sqlite3 only)
- CWD constrained to project directory (no filesystem escape)
- Env var blocklist (ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, etc.)
- No shell interpolation (`{ shell: false }`)
- Timeout enforced (30s default)

## What We Tried

1. **Direct webview subprocess execution** — Blocked by Bun WebSocket limitations, webviews can't spawn processes
2. **Defer to v0.2** — Initial plan (phases 1-4 in one sprint was ambitious)
3. **Generic "any command" RPC** — Code review rejected immediately, security concern
4. **Allowlist approach** — Accepted, provides extension developers clear expectations

## Root Cause Analysis

**Why did we design process:spawn without security guardrails?**

1. **Pressure to ship**: Phase 4 (webview integration) drove implementation speed over design
2. **Assumption of trust**: Thought "extensions are trusted code," forgot that extensions can be community-written
3. **No threat model**: Skipped asking "what can go wrong?" before coding
4. **Copy-paste instinct**: Wanted to make it "work like vscode," forgot PPM runs user code differently (in Workers, not main thread)

We got lucky. The code reviewer (rightfully paranoid) caught it. But this is a pattern we need to break: **new capabilities require threat modeling before implementation, not after.**

## Lessons Learned

1. **New execution paths need threat model before code**
   - process:spawn is the second execution handler (after tool execution in SDK provider)
   - Both need documented threat models and allowlist rationale
   - Code review should include security architect, not just functionality check

2. **Allowlist is better than blocklist for subprocess execution**
   - `{ shell: false }` is good but not sufficient (can still exec arbitrary binaries)
   - Command allowlist is explicit and auditable
   - Future: move allowlist to config for self-hosted extensions

3. **--numstat vs --stat for parsing**
   - Machine-readable output first, always
   - Human formatting should be applied on render, not parsing
   - This decision unblocks future work (avatars, statistics)

4. **Phases should be strict — defer aggressively**
   - Phase 5 (avatars, auto-refresh, settings, GPG, multi-repo) deferred to v0.2
   - Shipping 4 phases in one sprint was tight; no time for complexity
   - v0.2 roadmap is now clear (these are committed features)

## Next Steps

1. **Document process:spawn threat model** — Add to `docs/system-architecture.md` (extension security section)
   - Allowed commands and rationale
   - Environment filtering rules
   - Timeout behavior
   - Future: community extension sandboxing

2. **Phase 5 for v0.2** — Deferred features:
   - Avatar rendering in commit nodes (requires image caching)
   - Auto-refresh on file watch (requires debounced git log polling)
   - User preferences (dark mode, node size, graph direction)
   - GPG signature verification (requires gpg in allowlist)
   - Multi-repository support (requires RPC batching)

3. **Extension RPC security audit** — Review other RPC handlers for similar gaps
   - `file:read`, `file:write`, `git:*` handlers
   - Document allowlist for each
   - Add to security review checklist

4. **Extension marketplace trust model** — When we ship ext marketplace (v1.0), need:
   - Permission declaration (like Android APKs)
   - Audit log of extension subprocess calls
   - User warning on suspicious commands

## Files Changed

- `packages/ext-git-graph/` — 7 source files (2047 lines)
- `src/services/extension-rpc-handlers.ts` — Added process:spawn handler
- `packages/vscode-compat/src/process.ts` — ProcessService API
- 4 new test files, 62 new tests
- `packages/ext-git-graph/tests/git-log-parser.test.ts` — 28 parsing tests

**Commit**: `451811c` | **Lines**: +2304 / -12 | **Tests**: 1269 passing (62 new)

---

**Written by**: Engineering diarist | **Next review**: Before Phase 5 planning (v0.2 scope meeting)
