# Plugins & Tracing

Two rules adopted on 2026-09-11, borrowed from DeepSeek Harness: **Everything is a Plugin. Every
run is traceable.** PPM is a platform that embeds things around an AI agent — the IDE is one of
those things, not the product.

**Status: design only. Nothing in this document is built.** Current priority is finishing the
features already in flight; this exists so the work starts from a decision instead of a guess.

Rewriting the backend in Go was considered and rejected on the same day — see `docs/lessons-learned.md`.

---

## What is actually broken today

Both rules are aspirational right now, and the gaps are specific.

### Tracing: PPM keeps no log of its own

`ChatService.sendMessage` is a twelve-line pass-through, and `db.service.ts` has 38 tables with no
`messages` and no `events`. Session history lives in **Claude Code's** JSONL under
`~/.claude/projects/`, which PPM reads (`jsonl-transcript-parser.ts`) and even rewrites
(`transcript-images-file.ts`).

Six callers reach `chatService.sendMessage()` without going through the browser path at all:

| Caller | Runs |
|---|---|
| `src/services/scheduler-runner.ts:72` | scheduled jobs |
| `src/services/ppmbot/ppmbot-service.ts:422`, `ppmbot-delegation.ts:46` | Telegram bot |
| `src/services/group-chat/group-chat.service.ts:330` | group chat |
| `src/services/jira-debug-session.service.ts:187` | Jira auto-debug |
| `src/cli/commands/chat-cmd.ts:170,213` | CLI |

None of them records anything structured. The one that tries — jira-debug, via
`forwardEventToSession` — hits this first line (`src/server/ws/chat.ts:290`):

```ts
if (!entry || entry.clients.size === 0) return; // no connected clients, silently drop
```

So **a scheduled run at 3am with no browser open leaves no trace at all.** That is the bug this
rule exists to kill, and it lands hardest on exactly the surfaces that make PPM a platform rather
than an editor.

`turnEvents` is not a substitute and was never meant to be one. It is gated by `BUFFERABLE_TYPES`
(10 of `ChatEvent`'s 16 variants — `status_update`, `session_migrated`, `team_*` fall through),
capped at `MAX_TURN_EVENTS`, held in RAM, and it **mutates already-buffered events** (folding a
`tool_result` into the matching `tool_use` so a reconnecting client sees it). It is a correct
reconnect-replay buffer and the opposite of an append-only log.

Browser-side, an unhandled render error reaches `console.error` in
`src/web/components/root-error-boundary.tsx:87` and dies in the user's tab. There is no ingest
endpoint; `/api/logs/recent` reads the *server's* log.

### Plugins: two real seams, and the rest is wired in

| Seam today | Where |
|---|---|
| AI provider | `src/providers/registry.ts` + `AIProvider` in `src/types/chat.ts` — four providers, `isAvailable()` gating, required vs optional capabilities |
| Extension UI contributions | `src/services/contribution-registry.ts` — commands, views, menus, keybindings, config; clean `unregister(extId)` |

Not seams: the tool registry (tools belong to the SDK; an extension cannot give the model a tool),
the agent loop, fs/shell/sandbox (`fs-ops/`, `fs-path-guard.service.ts`), session persistence,
chat-node rendering (a hard `switch` over `ChatEvent`), and the LSP server list
(`src/services/lsp/server-registry.ts` is a table in code).

---

## Rule 1 — Every run is traceable

### The invariant, in the form PPM can assert

> **Anything PPM renders must be reconstructable from PPM's own log.**

Deliberately weaker than Harness's "model-visible means logged": the log the *model* sees belongs to
Claude Code, and PPM does not decide what goes into it. PPM-visible is ours, and it is testable —
reduce a turn's raw stream to its final state, rebuild the same turn from the log, and the two must
be equal.

Two things the first draft got wrong, both fixed below. A run is not only what the model *emitted*:
the user's message, each approval decision and the abort are **inputs**, they never pass through the
yield, and a log without them replays a conversation with no questions in it. And "equal to the
stream" cannot mean delta-for-delta — see *Store*.

### Where the append happens

`ChatService.sendMessage()` — the one chokepoint all eight call sites cross. **Not** `ws/chat.ts`,
which only the browser path reaches; putting it there reproduces today's hole.

Two inputs bypass it today — `ws/chat.ts` calls `provider.abortQuery()` and
`provider.resolveApproval()` directly at four sites — so those grow a `ChatService` wrapper too, and
the wrapper is where their row is written (`turn_aborted{reason}`, `approval_resolved`).

This also gives the roadmap's *"Simplify ChatService streaming"* debt a point: the function stops
being a pass-through that does nothing and becomes the one place a run is recorded.

### Store

A separate database file, `session-trace.db` under `getPpmDir()`, for the reason `query-audit.db` is
already separate: event volume must not bloat config and workspace state in `ppm.db`. It is also
**outside `db-backup`** on purpose — a log, not state — and runs `synchronous = NORMAL`, because
losing the last few milliseconds on power loss is the right trade for a log.

```sql
CREATE TABLE session_events (
  trace_id     TEXT NOT NULL,    -- PPM session id (session_map.ppm_id) for agent runs;
                                 -- 'browser:<deviceId>' for client rows
  seq          INTEGER NOT NULL, -- monotonic per trace_id; ordering is ours, not a timestamp's
  turn_id      TEXT,             -- NULL outside a turn
  ts           INTEGER NOT NULL, -- epoch ms
  source       TEXT NOT NULL,    -- 'agent' | 'server' | 'browser'
  origin       TEXT NOT NULL,    -- 'ws' | 'scheduler' | 'ppmbot' | 'group-chat' | 'jira' | 'cli' | 'unknown'
  provider_id  TEXT,
  ref_id       TEXT,             -- browser rows: the chat session the tab was viewing
  type         TEXT NOT NULL,    -- ChatEvent['type'], or user_message | approval_resolved |
                                 -- turn_aborted | browser_error | entry_never_ran | ...
  payload_json TEXT NOT NULL,
  PRIMARY KEY (trace_id, seq)
);
CREATE INDEX idx_session_events_ref ON session_events(ref_id, ts);
```

**`trace_id` is the PPM id, never the SDK's.** `session_map` already holds two id spaces, and
`session_migrated` (`claude-agent-sdk.ts:824`) swaps the SDK id in the middle of a stream — a log
keyed on it would split one turn across two sessions.

**Coalesced, not deltas.** `text` and `thinking` events are stream deltas
(`claude-agent-sdk.ts:1488`, `:1723`), so a 2 000-token reply is several hundred events. Logging each
is ~100× the rows in exchange for a replay of *how it streamed*, which nobody has asked for; the log
keeps one row per block and the invariant compares final states. `tool_use`, `tool_result` and the
rest are 1:1.

**Batched, and the append can never break the yield.** One synchronous `INSERT` per event is
hundreds of sync writes per turn on the one event loop — the very `self` culprit
`event-loop-lag.ts` was written to catch. The writer buffers and commits one transaction every
~250 ms or at turn end, and a failed write logs and drops. `GET /api/system/event-loop` before and
after a long streaming session is the acceptance test: `byCause.self` and `worstMs` must not move.

Append-only: no `UPDATE`, no `DELETE` outside the retention job. The `tool_result`-into-`tool_use`
folding that `turnEvents` does stays where it is — a read-model concern, computed on read.

### Browser errors live in the same log

This is the point of `source` and `ref_id`. A client error written to its own table answers "what
broke" but not "which turn was running when it broke" without correlating two stores. Here a browser
row carries `ref_id` = the chat session its tab was viewing, so the question is
`WHERE trace_id = ? OR ref_id = ? ORDER BY ts`.

A tab has no session of its own, so browser rows are keyed by **device**:
`trace_id = 'browser:<deviceId>'`, a UUID minted once into localStorage
(`src/web/lib/device-id.ts` — nothing like it exists yet). "Which machine does this happen on" is a
real question too, and it keeps one `seq` space per key.

"All of the browser's logs" is read as: `console.error` and `console.warn` are sent; `console.log`
and `info` go into a **50-entry ring buffer** that rides along as breadcrumbs on the next error. That
is what a failure needs — the lines just before it — without paying for logging while nothing is
wrong.

Ingest is one route — `POST /api/trace` — taking a small batch. It sits behind `authMiddleware` like
the rest of `/api/*` (`index.ts:177`), so an error raised while logged out is lost; accepted. Three
things it needs, none optional:

- **A cap and a schema check.** Batch ≤ 50, payload ≤ 16 KB each; treat the body as hostile and drop
  what does not fit.
- **A rate limit keyed by device id, not IP.** PPM is reached through a Cloudflare tunnel, behind
  which every client is one IP — a per-IP limit lets one machine in a render loop lock out all the
  others.
- **No PII beyond what is already in the log.** Stack traces and breadcrumbs only.

Client side, `root-error-boundary.tsx:87` and `chunk-recovery.ts` already know something went wrong;
`window.onerror` / `unhandledrejection` cover the rest. The client is **statically imported from
`main.tsx`** so it lives in the boot shell — in a lazy chunk it could not report the one failure that
matters most, a missing chunk. The case where the entry never runs at all (`__ppmEntryRan` false)
gets a bundle-free beacon in `index.html`'s inline watchdog, reading the Bearer token from
`localStorage["ppm-auth-token"]`. Buffer locally and flush with `sendBeacon`/`keepalive` on
`pagehide`, because the common case for a fatal client error is that the network is also what broke.

### Retention

Mirror `src/services/query-audit/`: prune by age, then by size, `PRAGMA auto_vacuum = INCREMENTAL`
set before the first table exists, and measure size from page counts so an active WAL does not
distort the reading. That module already solved this; do not solve it twice.

### What changes once the log exists

`getMessages()` reads PPM's log, and Claude Code's JSONL demotes to a **backfill** source for
sessions that predate the log or were created outside PPM. That is the point where the borrowed-log
tax gets repaid: cross-provider history stops depending on `getFullMessages` being implemented
(only Claude implements it today, so the search index is better for one provider than the others).

---

## Rule 2 — Everything is a plugin

### The test for a seam

A capability is a seam only with all three roles present: a **definition** (the interface), a
**provider** (an implementation), and a **consumer** (something that uses it without knowing which
provider answered). One or two of those is not a seam, it is an interface nobody swaps. Use this as
a review question, not as a framework — PPM is not adopting Cordis.

### Order

| # | Seam | Why it is first | Notes |
|---|---|---|---|
| 1 | **Hooks / interception** | This *is* the unbuilt "Hooks system" (High, v0.11), which the roadmap already calls the foundation for a Skills API | Copy Harness's shape, not just the name: a waterfall with `next()`, so a listener can rewrite or reject, not fire-and-forget |
| 2 | **Tool registry** | Answers the roadmap's open question — *"a stable internal AI-facing API is still unbuilt — decide whether it is still wanted"*. Lets an extension give the model a tool instead of only drawing a panel | Has to route through in-process MCP; tools belong to the SDK |
| 3 | **fs / shell / sandbox** | One provider swap moves Bash, PTY and LSP together, which is what makes remote/container execution cheap rather than a fork per consumer | Largest blast radius; do it last of the big three |
| 4 | **Session persistence** | Nearly free once Rule 1 is done | |
| 5 | **Chat-node rendering** | Today a hard `switch` over `ChatEvent`, so an extension cannot add a card | |

### Deliberately not seams

- **The agent loop.** Each provider owns its own; abstracting it buys nothing PPM needs.
- **Profile / bundle / `--dump-config` layering.** The most expensive part of Harness, and it exists
  because Harness composes five profiles (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`). PPM has
  one deployment shape. Buying this is paying for flexibility nobody uses.

### ACP, later

[ACP](https://agentclientprotocol.com/) is JSON-RPC 2.0 over stdio for exactly the editor↔agent
seam, and its client handlers are `requestPermission` and `sessionUpdate` — the two things
`AIProvider` needs, in-protocol rather than bolted on. Adopted by JetBrains, Google and 25+ agents;
Claude Code and Codex connect through adapters.

Worth doing **after** Rule 1, as an adapter *behind* `AIProvider` — never as a replacement for it,
because ACP v2 is still a draft that warns it "may change incompatibly in any SDK release". Target
v1. The payoff is consuming any ACP agent without writing a provider, which answers the roadmap's
open *"Tier 3"* row better than a bespoke adapter would.

---

## Phases

Tracing comes first, and not because it is easier: a seam with no trace cannot be verified. After
swapping the fs provider for a container, the log is the only thing that can show behaviour did not
change.

```
0  session-trace.db + coalesce/batch pipeline + append in ChatService (inputs included) + replay test
   → no UI change; on its own this closes the scheduler/bot/CLI hole
1  POST /api/trace + boot-shell client + watchdog beacon; browser errors land in the same log
2  getMessages() reads PPM's log; JSONL demotes to backfill
3  Hooks seam (closes the v0.11 High item)
4  Tool registry (answers the Skills API question)
5  fs / shell / sandbox; ACP adapter
```

Phases 0 and 1 are the ten tasks in `session-trace.md` at the repository root. Nothing later is
blocked if the work stops after them.

---

## Measured: `forwardSubagentText` removes a workaround, not a feature

Run `bun test-subagent-stream.mjs` to reproduce. Raw SDK, two runs, identical nested prompt (an
agent told to spawn an agent), bundled `claude` **2.1.251**:

| | flag OFF (today's default) | flag ON |
|---|---|---|
| messages carrying `parent_tool_use_id` | 3 | 10 |
| **distinct parent ids** | **1** | **2** |
| `Agent` tool calls announced | 2 | 2 |

Both runs announce two `Agent` calls, so both runs *spawned* a grandchild. With the flag off, only
one id ever appears as a parent: the grandchild's `tool_use` id is announced and then **nothing
carries it** — its Bash call, its result and its text are invisible to the stream. With the flag on,
both ids appear and the grandchild's whole conversation arrives, parent chain intact.

So the gotcha in `CLAUDE.md` — *"Nested subagents are never streamed"* — is a statement about the
**default**, not about the SDK. `src/services/nested-subagent-spy.ts` (206 lines of tailing
`<session>/subagents/*.jsonl` mid-turn) is replaceable by one option, and
`subagent-transcript-merger.ts` (161 lines, the reload path) stops being needed for new sessions
once Rule 1's log exists.

Two things to check before deleting anything. PPM runs with `includePartialMessages: true`, which
this test turned off to keep the trace readable — confirm the picture holds with partials on. And
the flag raises event volume for nested runs, which is what `MAX_NESTED_TURN_EVENTS = 2_000` is
already budgeting against; a chatty three-level run should be measured against that cap.
