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

---

## Public tunnel URL stability

### Why the public URL used to rotate on every upgrade

**Problem**: a quick trycloudflare tunnel dies with its `cloudflared` process and the URL cannot be
recovered. The supervisor kept that process alive across a self-replace upgrade, but a tunnel is
pinned to one *origin port*. When the server could not rebind that port it moved to a nearby one,
the supervisor re-pointed the tunnel, and the URL changed. The port moved because of a zombie port.

**Zombie port**: on Windows a child spawned with fd stdio inherits every inheritable handle,
including a listening socket. The server spawns chat/tool/MCP subprocesses constantly; when one is
orphaned it keeps the server's socket open, so the port stays in LISTEN under a dead PID and can
never be rebound. Three different debris shapes caused this within two weeks — `nohup` coreutils,
a `bun run dev:web` tree, and orphaned `mcp-remote` MCP-connector processes. Whitelisting each new
shape was a losing game.

**Fix**: the server no longer needs a stable port. A dedicated **edge forwarder** owns the public
port and pipes raw TCP to whatever loopback port the server happened to bind, so `cloudflared`
stays pinned to the edge forever.

What makes it work: **the edge spawns no child processes**, so its socket can never be inherited
and its port can never zombie. A test enforces that invariant (`supervisor-resilience.test.ts` →
"the edge forwarder never spawns a child process"). Any subprocess call added to
`src/services/edge-forwarder.ts` reintroduces the original bug.

**Files**: `src/services/edge-forwarder.ts`, `src/services/edge-target-resolver.ts`,
`src/services/supervisor.ts`

### Bun drops socket data that arrives while a socket is paused

Forwarding means resolving the upstream first, so the client's first bytes usually arrive before
there is anywhere to send them. The obvious guard — `socket.pause()` until `.pipe()` is wired —
silently loses them on Bun 1.3.13. So does leaving the socket with no `data` listener. Both
variants swallowed the first HTTP request and the connection simply hung.

A standalone repro compared four variants (`pause`→`pipe`, `pause`→`pipe`→`resume`, no pause, and
buffering). Only buffering worked: attach a `data` listener synchronously on the connection tick,
buffer the chunks (bounded — an unbounded buffer is a memory DoS during an upgrade window), then
replay them into the upstream and pipe. Removing the listener and piping must happen in the same
tick so no chunk slips through the gap.

### `_opts.port` in the supervisor means the PUBLIC port, not the server's

After the edge took over the public port, three call sites still read that value as the server's,
and none of them failed a test:

- the **server health probe** — a dead edge looks like a dead server, so the supervisor would kill
  a healthy one every third cycle;
- the **pre-self-replace port wait**, which tree-kills whatever holds the port — that is the edge,
  during an upgrade, which is exactly the URL rotation being fixed;
- the **stopped page**, which bound the public port directly and collided with the edge.

The health probe now reads the server's own `.server-port`, the self-replace wait is skipped when
an edge is running, and the stopped page binds loopback and publishes itself so the edge routes to
it. **When you change what a widely-read variable means, audit every reader — tests will not find
these.**

### Adoption must come before any bind probe

`ensureBindablePort` treats a live PPM process holding the port as debris and tree-kills it, so
probing the public port before adopting the edge kills the healthy edge it was about to adopt.
Adopt first; probe only when there is nothing to adopt.

Related: `findPortListenerPid` needs `netstat` on Windows and `lsof` on POSIX, and returns `0` when
the tool is missing. Treating "cannot tell" as "does not match" refused every adoption on such a
box and spawned a duplicate edge that then could not bind.

---

## Process enumeration must not depend on `ps`

**Problem**: `collectProcessTree` and `isPpmProcess` shelled out to `ps`, which ships in `procps` —
a package slim Debian images leave out, including the one PPM's own suite runs in. Both functions
swallow the spawn error and return "no descendants" / "not a PPM process", so a missing binary
**silently disables orphan reaping** rather than failing loudly. Two tests had been timing out for
weeks and were written off as environmental.

**Fix**: read `/proc` directly on Linux (`/proc/<pid>/stat` for the pid→ppid map,
`/proc/<pid>/cmdline` for argv) and keep `ps` only as the macOS path. No subprocess, no hidden
dependency, and much faster — the two tests went from 5s timeouts to ~100ms.

Parsing note: `/proc/<pid>/stat` is `pid (comm) state ppid …` and `comm` may contain spaces **and
parentheses**, so anchor on the last `)` instead of splitting the line naively.

Still unconverted for the same reason (`ps` may be absent): `resource-monitor.service.ts` and
`tunnel-registry.service.ts`. Both degrade rather than corrupt, but they are the same latent bug.

## Bun on Linux cannot re-watch a deleted-and-recreated directory

**Problem**: `WatchTree` releases a watcher when a directory disappears and re-covers it when it
comes back. On Bun 1.3.13 + Linux the new watcher is silent forever: Bun keys its `fs.watch`
registry by the literal path string and reuses the dead inotify watch. Closing the old handle
first, or waiting seconds before re-watching, makes no difference.

**Evidence** (`spike-bun-recursive-watch-probe.mjs`): plain recursive and non-recursive watches
both deliver; both go silent for a recreated directory. On **Windows** (bun 1.3.10) every case
delivers, so the defect is Linux-only.

**No clean workaround.** A trailing separator is a different key and works exactly once; `//` and
`///` normalise to the same key, so a rotating-spelling scheme fails from the second cycle.

**Consequence**: on Linux, changes inside a directory that was deleted and recreated (a `git
checkout` across branches, `rm -rf build && mkdir build`) stop being reported until the server
restarts. The test asserting re-attachment is skipped on Linux with this reason and still runs
elsewhere. Fixing it properly needs a different watch mechanism (or a polling fallback) for
re-covered directories — deliberately not added, given the file watcher's history with watch-count
blowups.
