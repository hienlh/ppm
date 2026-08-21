# Lessons Learned

Knowledge and gotchas discovered during PPM development.

---

## Claude Agent SDK

### .env poisoning via project cwd

**Problem**: SDK spawns a CLI process in the project's `cwd`. The CLI auto-loads `.env` via dotenv. If the project has `ANTHROPIC_API_KEY=dummy` or `ANTHROPIC_BASE_URL=http://localhost:...`, the CLI uses those instead of the user's subscription → "Invalid API key" or empty responses with no tool execution.

**Symptoms**:
- Model returns empty response, no text or tool_use events
- `result.subtype === "error_during_execution"`
- Text response: "Invalid API key · Fix external API key"
- `totalCostUsd: 0` in usage

**Fix**: Neutralize `ANTHROPIC_*` env vars by setting them to empty string (not deleting — dotenv won't override existing vars):
```ts
env: {
  ...process.env,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_AUTH_TOKEN: "",
},
```

**File**: `src/providers/claude-agent-sdk.ts`

---

### Project-local Claude settings restrict tools

**Problem**: Projects may have `.claude/settings.local.json` with restrictive `permissions.allow` lists (e.g., only `Bash(python:*)`, `Bash(ls:*)`). Even with `permissionMode: "bypassPermissions"`, the SDK CLI still reads these and restricts available tools.

**Fix**: Override with explicit empty settings and no setting sources:
```ts
settings: { permissions: { allow: [], deny: [] } },
settingSources: [],
```

---

### Windows: SDK query() hangs — executable: "node" fix

**Problem**: On Windows + Bun, SDK `query()` yields zero events — appears to hang forever.

**Root cause**: SDK detects Bun runtime and spawns `child_process.spawn("bun", ["cli.js", ...])`. On Windows, `child_process.spawn("bun")` fails with ENOENT (can't resolve `bun` binary). The error is swallowed internally → no events → looks like a hang.

**Fix**: Pass `executable: "node"` in SDK query options. Forces SDK to spawn `node cli.js` instead of `bun cli.js`. Node is always in PATH on Windows.

**File**: `src/providers/claude-agent-sdk.ts` — `queryOptions` in `sendMessage()`

---

## WebSocket Chat Architecture

### Event flow: SDK → Provider → WS → Frontend

1. SDK emits: `system` → `stream_event`* → `assistant` → `rate_limit_event` → `user` (tool_result) → `result`
2. Provider extracts text from `stream_event.event.delta.text` and tool_use from `assistant.message.content`
3. Provider yields: `text`, `tool_use`, `tool_result`, `usage`, `done`
4. WS handler sends JSON to frontend

Key: `stream_event` contains raw API events (`content_block_delta` with `text_delta`). The `assistant` event contains the full message with all content blocks.

### tool_result lives in `user` events

SDK returns tool results as `user` type messages (not `assistant`). Provider fetches them via `getSessionMessages()` after detecting `pendingToolCount > 0`.

---

## Panel / Tab Layout

### Eagerly mounting every saved tab makes boot O(saved tabs)

**Problem**: `TabPool` rendered every tab of every open project on mount, hiding the
inactive ones with `display: none`. Hidden still means mounted, so every tab ran its
full data-fetch effects at boot. A saved workspace with 18 chat tabs cost **515
requests / 36.7 MB / 169 failed requests**, with the last request landing 31.6s after
reload.

**Symptom that misleads**: individual endpoints appear slow (8-16s for handlers that
normally take milliseconds). The server is not slow — Bun is single-threaded and 347
requests arrived in the first 3 seconds, so everything queued. The tab the user was
waiting on sat behind requests for tabs they could not see.

**Fix**: mount a tab only once it has been visible (`isActive`, computed per panel so
splits still mount both), then keep it mounted for the rest of the session so
keep-alive still holds. See `src/web/stores/mounted-tabs-store.ts` and
`filterMountableEntries` in `src/web/components/layout/tab-pool-collect.ts`.

**Do not** derive the mount set by adding a "mark activated" call at each site that
assigns `activeTabId` — there are ~8 of them (`setActiveTab`, `openTab`, `moveTab`,
`splitPanel`, `closeTab`, `redockTab`, `openInDock`, `pickDockActiveTab`) and a new one
will be added without the call. Deriving it from `isActive` on the next render covers
every present and future assignment site.

**Never persist the mount set.** It is session-only by design; persisting it would
restore the storm on the next reload.

**Never prefetch terminal tabs.** Mounting a terminal spawns a PTY process, so
speculative mounting starts real processes the user never asked for.

**Measure with**: `bun tests/e2e/boot-network-audit.mjs [port] [--mobile]`.

### HTTP 400 as a normal control-flow signal costs a request per occurrence

**Problem**: `GET /chat/sessions/:id/versions` returned 400 to mean "this message has
no edited versions", and the frontend rendered one switcher per user message. Measured
**169 requests, 165 of them 400s**, on a single boot. Each call also walked the branch
ancestor chain with one DB query per hop (up to 100 sequential queries).

**Fix**: ship the whole answer with the data the caller already fetches. `/messages`
now returns `versionMap` (`ordinal → { ids, currentIndex }`), computed for the entire
session in 2 queries via `resolveVersionMap`. Absence of an ordinal replaces the 400.

**Watch out**: rows predating the `fork_ordinal` migration have it `NULL`. SQL
`WHERE fork_ordinal = NULL` never matches, so per-ordinal code silently skipped them —
batch code building an in-memory index must skip them explicitly or it emits a bogus
`null` key.

### requestIdleCallback's `timeout` is a deadline, not a delay

Passing a delay as `requestIdleCallback(fn, { timeout: 2500 })` does **not** wait 2.5s.
It means "run by 2.5s at the latest", so the callback fires at the first idle moment —
which during boot is almost immediately. Idle prefetching scheduled this way fired all
its work ~1.5s into boot, competing with the visible tabs. Use `setTimeout` for the
spacing and `requestIdleCallback` only to avoid landing in the middle of other work.
See `src/web/hooks/use-tab-prefetch.ts`.

---

## File Watching

### `fs.watch(dir, { recursive: true })` costs one inotify watch per subdirectory

One call, but on Linux the runtime expands it into a watch per directory in the tree —
`node_modules` included. Filtering unwanted paths when the event *arrives* still pays the
full registration cost: PPM held **359,058** inotify watches on one machine (68.5% of the
524,288 default `fs.inotify.max_user_watches`, with the box at 91.6% overall), which starves
every other process on the system — editors, language servers, dev servers.

A directory census of this repo shows why: 18,731 directories total, of which `node_modules`
is 16,926 (90.4%) and `.git` 286. Only ~200 are worth watching.

**Rule:** prune at registration, never at event time. `src/services/file-watcher/watch-tree.ts`
scans once, then attaches the fewest watchers that cover the tree without ever handing an
ignored directory to the runtime: one native recursive watch for any subtree that contains no
ignored directory, and a non-recursive watch plus per-child recursion wherever one sits. Keeping
the handle count low also keeps `fs.inotify.max_user_instances` (default 128) out of play.

Raising the sysctl limit is not a fix — each watch pins ~1KB of kernel memory, so a 2M ceiling
reserves ~2GB to paper over waste.
