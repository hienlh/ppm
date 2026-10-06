# AI Chat & Providers

> Part of the [PPM system architecture](../system-architecture.md).

## Codex child stream lifecycle

App-server notifications with an explicit non-root thread ID are nested agent
events. They cannot end the root turn, change its active turn ID, rotate its
account, overwrite root usage, or flush its transcript. Child content stays under
its Agent card. The WebSocket consumer buffers nested content only while the
root turn is active; late child results never revive an idle session or create a
reconnect replay. The frontend updates finalized Agent cards in place for late
results/errors and ignores nested `done` events.

This prevents a completed answer from disappearing after reload when a
background agent finishes after the root response.

The live Agent-session window (below) reads a child's rollout through its own
streaming tail parser instead of this buffered nested-event path — it has no
notion of whether the root turn is active, since a background agent keeps
writing long after the root turn finishes. A child rollout carries its own
`session_meta` header first and its parent's (forked context) second; only the
first describes the file, and that tail parser ignores every one after it.

## Agent session transcripts

Tapping an Agent/Task card, or a named teammate row, opens a floating window
(a bottom sheet on mobile) that streams that agent's own transcript live and
independently of the chat turn that spawned it. This runs as its own protocol
over `/ws/global` (`src/shared/agent-transcript-protocol.ts`), not the chat
WebSocket, so it keeps following a background agent after the root turn ends
and works whether or not a chat tab is even mounted.

**Ownership before any file is named.** `src/services/agent-transcript/session-ownership.ts`
proves a requested `(providerId, sessionId)` belongs to the caller's project
before anything downstream picks a path: a Claude session's JSONL must sit
under that project's own slug directory (a DB-recorded path is accepted only
when it independently names the same project), and a Codex session must be
found through the existing fail-closed `cwd`-checked rollout search. Every file
this flow reads afterward is realpath-contained under the provider's root. A
client names only a project, a session id and a `source` (a card id or
teammate handle) — never a path or byte range.

**Sources per provider.** `agent-transcript-sources.ts` turns an owned session
plus a `source` into the file(s) the hub may read: a Claude card's own
transcript and its recorded nested descendants; a Codex card's rollout,
accepted only when its `session_meta.parent_thread_id` chain reaches the
owning session; a teammate's newest transcript, pinned to the project the same
way a session id is (a team is itself a session). Resolutions are cached
briefly per (session, card/member) and re-derived on that cadence, so a
descendant spawned after the window opened is picked up without reopening it.

**The hub.** One hub per `(providerId, sessionId)` (`agent-transcript-hub.ts`,
`agent-transcript-session-hub.ts`) owns every transcript and activity
subscription for that session. A tick reads each subscribed file from its
last-consumed byte offset, decodes only whole lines, and pages a large backlog
rather than reading or parsing it all at once; a subscription's own pace slows
once its files stop growing, and a hub with nothing subscribed tears itself
down.

**Protocol.** `agent-transcript:subscribe`/`unsubscribe` carry one card's or
teammate's steps; `agent-activity:subscribe`/`unsubscribe` carry the
running-agents bar's "who is working right now" feed, independent of any
window being open. A cursor is a byte offset per file the server itself
derived on an earlier response — never a client-named range — and
reconnecting resumes from the client's last cursor with no gap and no
duplicate, across however many backlog pages that takes. A `reset` flag tells
the client to discard everything for that subscription instead of appending,
for the rare case where the file itself rewrote its own history (a
truncated/rotated Claude transcript, a Codex compaction or rollback). Every
error the client can see is one of four fixed codes — never a path or
exception text.

**Fallback.** A window opens with whatever steps chat already holds in memory
(`agent-session-fallback-store.ts`) and shows them immediately; they are
replaced the moment the hub's first real response names a readable file, and
stay as the shown view — marked offline — when the source never resolves to
one at all (an old session, or a transcript that never existed).

**Liveness.** "Running" is derived only from whether the underlying file(s)
are still growing, never from in-memory chat state: a replayed old session
reads as finished even though its cards are still visible in the transcript.

## Codex daily guard for weekly-only accounts

Daily guard spreads a seven-day quota window across five weekdays: each weekday
unlocks another 20% of the weekly quota. Unused allowance carries forward.
Saturday/Sunday slots keep the previous cap; a window starting on a weekend
opens its first allowance on Monday. Slots are 24 hours from the weekly reset
time and use UTC weekdays, consistently in the server and browser. This does not
change Codex's reset schedule. Users can disable the guard per account.

## Chat startup

New tabs mount the composer immediately. Provider selection and permissions
prepare in the background, sharing a 60-second in-memory cache per project.
Saving AI settings invalidates that cache and pending selections; an unavailable
provider is surfaced without silently choosing another. Only selection and
permission fields are cached, not provider credentials.

An early send displays the pending message, waits for preparation and the tab's
account claim, then creates the session and sends once after the socket greeting.
Errors retain the draft for an explicit retry; reload never automatically resends.
Remote drafts hydrate without overwriting text typed, erased or submitted since
the request started. Account claims are shared by preparation and first send.

Recent history and usage show correctly scoped cached data immediately and refresh
after 500 ms. Provider/model lists load when their selectors open. These reads
never gate typing or first-send preparation.

The initial history request also covers an idle WebSocket greeting while it is
pending; completed turns and truncated replays still trigger recovery reads.
Slash commands preload when the composer is ready. Browser-memory catalogs are
shared across sessions by provider, with project-specific overrides and recents
kept per project. Cached items remain available during refresh; catalogs refresh
every 30 minutes or through the picker's reload button. A cold browser still
needs its first catalog request. The `@` picker loads a
file index on demand, scoped to its project; stale responses cannot overwrite
the index for a different project.

Monaco initializes when an editor mounts, Mermaid when a diagram renders, and
Shiki when code highlighting is needed. Theme subscriptions remain active before
those engines load. The production bundle leaves Mermaid's dynamic import out
of manual vendor grouping so shared dependencies do not pull the engine into
ordinary Markdown rendering.

The mobile desktop sidebar is not mounted, and the closed mobile explorer does
not mount its file tree. App-level file-index invalidation keeps cached paths
fresh while the drawer is closed, without fetching an unused index.

## New chat preparation

`openTab()` resolves a new chat tab's provider and permission synchronously from the
local cache (`chat-preference-local-cache.ts`): when AI settings and the project's
cached provider list both exist and the resolved provider is still in that list, the
tab opens "warm" with `permissionModeSource: "cache"`. Otherwise it opens with
`providerPending: true` and the composer's own prepare resolves it.

Every sessionless chat tab (new, `/clear`, a design's chat, a reload mid-resolution)
fires exactly one `POST /api/project/:name/chat/prepare` on mount
(`new-chat-prepare-client.ts`), deduped per tab id so a re-render or remount inside the
post-settle join window does not POST again. Body: `{providerId?, focusedProvider?,
skipPick?}` — `skipPick` is set once the tab already holds an account claim for the
provider it is about to prepare, so one tab never consumes two accounts. Response
(`src/services/chat-prepare/chat-prepare.service.ts`): `{resolvedProviderId,
providerId, settings, providers, pickedAccount, usage, draft, tags, slash}`, where
`pickedAccount` is `{id, label} | null | "timeout" | "skipped"`.

Draft, tags and slash items each run under their own budget via `settleWithinBudget`
(`src/services/chat-prepare/settle-within-budget.ts`) and fall back to `null` instead
of delaying the response: slash 400ms, everything else 1000ms as a defensive cap on
otherwise-instant reads. The account pick and its usage run as one sequential part
beside those — Codex's pick is itself budgeted at 1500ms, and a picked account's usage
gets its own 800ms budget. A timed-out Codex pick skips selection outright rather than
risk advancing the round-robin or double-claiming an account.

The response seeds every cache a consumer would otherwise fetch separately (settings,
provider list, slash items, tags, usage, the account claim). On first send, the tab
awaits its own prepare and applies the fresh permission only when its
`permissionModeSource` is still `"cache"` — a mode the user picked, or one a
resumed/inherited session carries, is never overwritten by a stale prepare.

`GET /chat/usage` honours `?accountId=` for the Claude provider only when `?session=`
is absent — a session's own binding always wins once one exists.

## Model discovery cache

When opened, the chat model picker shares successful model lists across chat tabs, keyed by
project and provider, in browser memory for five minutes. Expired lists remain
visible while a refresh runs; failed or empty refreshes retain the last usable
list. Reloading the page clears this browser cache. Codex discovery also keeps
a five-minute server memory cache, shares concurrent discovery requests, and
serves its previous list while refreshing. The first uncached request still
waits for Codex app-server initialization and model discovery.

## Codex context settings

**AI Settings → Codex** exposes **Context window (tokens)** and **Auto-compact
threshold (tokens)**. These map to Codex's documented `model_context_window` and
`model_auto_compact_token_limit` keys under `ai.providers.codex`.

Both controls offer presets, Codex default and Custom entry. Presets are numeric
shortcuts, not advertised model capabilities. Existing non-preset values appear
as Custom. Both values are optional positive safe integers. The compact threshold cannot
exceed an explicitly configured window. The form saves the pair together;
`PUT /api/settings/ai` also validates merged partial updates before persisting.
Clearing a field sends `null`, which removes the PPM override. An omitted field
in a partial update preserves the existing setting.

PPM passes configured values in the `config` map of app-server `thread/start`
and `thread/resume`, including account rotation. It does not edit account
`config.toml` files. Unset values inherit native Codex configuration and model
defaults. Changes apply on the next provider connection/resumption; an already
running session keeps its current limits. Restart PPM and resume an existing
session to apply changed limits to it.

Increasing these values does not increase the model/account's supported limit.
Codex can reserve part of the configured window, so runtime token usage may
report a smaller effective window. Local compacted rollouts inspected on
2026-09-15 reported 258,400 tokens (272,000 × 95%); this is runtime evidence for
this installation, not a hardcoded application default.

References: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
and [App Server](https://learn.chatgpt.com/docs/app-server).

## Provider Layer (AI Adapters)

### Shared instructions and memory

**Settings → AI → Share rules and memory between providers** controls
`ai.share_provider_context`. It defaults to `true`, including existing configs.
PPM checks sources for each project-chat message and sends a snapshot only when
it differs from the last delivered snapshot for that provider/session. Live
follow-ups use the same check. Compaction, failed delivery, explicit resume,
server restart, or eviction from the bounded 512-session cache causes a fresh
snapshot on the next message. Slash commands retain their native parser behavior.
Disabling stops future injections, but does not
remove context already present in an existing conversation. Start a new session
for a clean context. The isolated HTTP API proxy is outside this project-chat flow.

Sources include project `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, provider
`.{providerId}/rules/` and `.{providerId}/memory/` directories,
user Claude rules, Codex account `AGENTS.md`, and Claude auto-memory for the exact
project path. PPM does not import account credentials, runtime settings/hooks,
conversation transcripts, or another project's auto-memory.

PPM reads existing native memory directly, including knowledge created before
PPM was installed. It does not create or maintain an intermediate memory store.
Claude's native `MEMORY.md` index is prioritized and its topic files remain
readable at their original paths. `CLAUDE_CONFIG_DIR` is respected. Codex native
memory is read from its memory database with exact project attribution from its
thread database; databases are opened read-only. New memory stays in the native
provider's storage. Conversation transcripts are not treated as memory.

Snapshots omit rules already loaded by the receiving provider (Codex AGENTS and
rules, Claude instructions/rules/auto-memory, Cursor rules). Codex's native memory
is supplied only to other providers. Unknown providers retain conventional sources.
Memory directories contribute their index and a directory reference, with topic
files read on demand. A compact revision tracks file metadata changes, including
omitted topics, within the bounded scan.

Snapshots are bounded to 48 content files, 4 KB excerpts per file and 12,000 content
characters, with limited directory traversal and a 1,500-character directory list.
Large files retain their original paths and a truncation notice so agents can
read the remainder on demand. Unreadable files are skipped. Rule scopes/frontmatter
remain part of the supplied instructions.

New registered providers automatically receive the common context and contribute
conventional `.providerId/rules` and `.providerId/memory` directories. For custom
paths, implement `AIProvider.getSharedContextSources(projectPath)`. Implement
`supportsSharedContext = true` to consume `SendMessageOpts.sharedContext` separately
from raw user text; `CliProvider` already does this. Other implementations receive
a prefixed prompt automatically. Keep titles based on raw user text and use
`stripSharedContext` when importing native transcripts. Claude, Codex and Cursor
already implement this separation.

**Component:** Provider interface + implementations

**Responsibilities:**
- Abstract AI model differences behind common interface
- Stream responses as async generators
- Handle tool use and approval flows
- Track token usage

**Interface (src/providers/provider.interface.ts):**
```typescript
interface AIProvider {
  createSession(): Promise<Session>;
  sendMessage(sessionId: string, message: string, context?: FileContext[]): AsyncIterable<ChatEvent>;
  onToolApproval(sessionId: string, requestId: string, approved: boolean, data?: unknown): Promise<void>;
}
```

**Implementations:**
- **claude-agent-sdk** (Primary) — @anthropic-ai/claude-agent-sdk, streaming, tool use. Reads model/effort/maxTurns/budget/thinking from config. Settings refreshed per query. Windows CLI fallback for Bun subprocess pipe issues. .env poisoning mitigation. **Multi-account support:** Injects account API token from AccountService instead of relying on ANTHROPIC_API_KEY env var when accounts configured.
- **mock-provider** (Testing) — Returns canned responses
- **cursor-cli** (CLI-based) — Spawns `cursor-agent` CLI binary with NDJSON streaming. Extends `CliProvider` base class.
- **codex/gemini** (Planned) — Pluggable via `CliProvider` extension (~100-150 lines each)

### Multi-Provider Architecture (v0.8.61+)

PPM supports multiple AI providers through a generic `AIProvider` interface and extensible base classes:

**Provider Types:**
1. **SDK-based** (claude-agent-sdk) — Uses Anthropic SDK for rich features (approvals, thinking blocks)
2. **CLI-based** (cursor-cli, codex, gemini) — Spawns external binary with NDJSON streaming

**Base Classes:**
- `AIProvider` interface — Defines required methods (createSession, sendMessage) + optional capabilities (abortQuery, getMessages, listSessionsByDir, ensureProjectPath)
- `CliProvider` abstract class — Shared spawn/parse/abort logic for all CLI-spawning providers
- Provider-specific subclasses implement: `buildArgs()`, `mapEvent()`, `extractSessionId()`, `isAvailable()`

**Streaming Infrastructure:**
- `parseNdjsonLines()` utility — Async generator that buffers partial TCP packets, yields complete JSON lines
- `ChatEvent` union type — Normalized event format across all providers (text, tool_use, thinking, approval_request, system, done, error)
- Event mappers translate provider-specific JSON → ChatEvent (e.g., Cursor's `reasoning` type → `thinking` event)

**Provider Registration & Bootstrap:**
- `ProviderRegistry` maintains active provider instances
- `bootstrapProviders()` async function checks `isAvailable()` on CLI providers before registering
- Graceful fallback: if Cursor binary not found, provider skips registration (no crash, logged as info)
- Config type `AIProviderConfig.type` union: `"agent-sdk" | "cli" | "mock"`

**CLI-Provider Features:**
- **Session capture** — Extract session ID from provider's init event, re-key process tracking
- **Workspace trust auto-retry** — Detect trust prompts in stderr, retry once with `--trust` flag
- **Process lifecycle** — Track active processes per session, escalate SIGTERM → SIGKILL on abort
- **History loading** — Override `listSessions()` to read native provider history (e.g., Cursor SQLite DAG)
- **Graceful degradation** — Missing binary → provider skipped, not fatal

**New Files (v0.8.61):**
- `src/utils/ndjson-line-parser.ts` — NDJSON streaming parser
- `src/providers/cli-provider-base.ts` — Abstract base class for CLI providers
- `src/providers/cursor-cli/cursor-provider.ts` — CursorCliProvider implementation
- `src/providers/cursor-cli/cursor-event-mapper.ts` — NDJSON → ChatEvent mapping
- `src/providers/cursor-cli/cursor-history.ts` — SQLite DAG reader for Cursor history
- `src/web/components/chat/provider-selector.tsx` — UI component for provider selection

---

## AI Provider Configuration

PPM exposes AI settings as global configuration (not per-session) via REST API and Settings UI. Configuration is stored in SQLite (`~/.ppm/ppm.db`) and read fresh per query.

### Configuration Shape

Stored as dotted keys in the `config` table; shown here as a tree for readability. The authoritative
shape is `DEFAULT_CONFIG` / `PpmConfig` in `src/types/config.ts`.

```
ai.default_provider                      claude
ai.providers.claude.type                 agent-sdk
ai.providers.claude.api_key_env          ANTHROPIC_API_KEY
ai.providers.claude.model                claude-opus-5
ai.providers.claude.effort               high
ai.providers.claude.max_turns            1000
ai.providers.claude.permission_mode      bypassPermissions
ai.providers.claude.inherit_claude_mcp   true
```

**Fields:**
- `default_provider`: Active provider id (`claude`, `codex`, `cursor`). Falls back to `claude` when the configured id matches no registered provider
- `type`: Provider type (`agent-sdk` or `mock`)
- `api_key_env`: Environment variable holding the API key. Not required when the `claude` CLI is logged in
- `model`: Model ID (e.g. `claude-opus-5`, `claude-sonnet-5`). Default: `claude-opus-5`
- `effort`: Reasoning level — `low`, `medium`, `high`, `xhigh`, `max` (validated against `VALID_EFFORTS`; an out-of-enum value is rejected rather than passed through)
- `max_turns`: Maximum interaction turns. Default 1000
- `permission_mode`: SDK permission mode, default `bypassPermissions`
- `inherit_claude_mcp`: Reuse MCP servers configured for Claude Code
- `max_budget_usd`: Spending limit in USD (optional)
- `thinking_budget_tokens`: Extended thinking, tri-state (optional). Omitted = adaptive (model picks depth, guided by `effort`); `0` = disabled; a positive number = fixed token budget. Per-session Thinking toggle overrides this.

### API Endpoints

**GET /api/settings/ai** — Fetch current AI config
```json
{
  "ok": true,
  "data": {
    "default_provider": "claude",
    "providers": { "claude": {...} }
  }
}
```

**PUT /api/settings/ai** — Update AI config (shallow merge per provider)
```json
{
  "providers": {
    "claude": {
      "model": "claude-opus-5",
      "max_turns": 50
    }
  }
}
```
Returns full updated config. Validates ranges/enums before writing.

### How Provider Uses Settings

1. **SDK Provider (`sendMessage`)**
   - Calls `getProviderConfig()` to read fresh config from `configService`
   - Maps snake_case config to camelCase SDK options
   - Passes `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `thinkingBudgetTokens` to `query()`
   - Falls back to defaults if fields not set

2. **Mock Provider**
   - Ignores AI settings (always returns canned responses for testing)

3. **Changes Take Effect**
   - Immediately on next query (config read fresh each time)
   - No active queries affected (config mid-flight not re-evaluated)

---

## Chat Streaming Flow (Persistent AsyncGenerator Sessions)

### Architecture Overview (v0.8.55+)

PPM uses a **persistent streaming session** model instead of per-message query execution:

**Key Changes:**
- Provider maintains **long-lived AsyncGenerator streaming input** per chat session (not per message)
- Follow-up messages **push into the existing generator** instead of abort-and-replace
- **Single streaming loop** per session decoupled from WebSocket message handler
- Message priority support: `now` (interrupt current), `next` (queue first), `later` (queue at end)
- Supports image attachments in messages

**Design Benefits:**
- Continuous context preservation — multi-turn conversations flow naturally
- No SDK subprocess restarts between messages (faster)
- Clean separation: BE owns Claude connection, FE disconnect doesn't abort
- Message buffering on reconnect — clients that lose WS connection sync turn events
- Tool approvals don't restart the query — integrated into streaming loop

### Message Flow

```
User types: "Debug this function"
    ↓
MessageInput.tsx calls useChat.sendMessage()
    ↓
useChat opens WebSocket: WS /ws/project/:name/chat/:sessionId
    ↓
Sends: { type: "message", content: "Debug...", priority?: "now"|"next"|"later" }
    ↓
WS handler in chat.ts receives message
    ↓
If already streaming with different content → abort previous + wait cleanup
If streaming, new message priority determines queue behavior:
    • priority: "now" → abort current, restart with new content
    • priority: "next" → push into pending queue (higher priority)
    • priority: "later" → push to end of queue (FIFO)
    ↓
runStreamLoop() executes in detached async context
    ↓
ChatService calls provider.sendMessage() (async generator)
    ↓
Provider (Claude SDK) yields events:
    1. { type: "text", content: "Here's what..." }
    2. { type: "text", content: " happens..." }
    3. { type: "tool_use", tool: "read_file", input: {...} }
    ↓
Stream loop buffers + broadcasts to all connected clients:
    { type: "text", content: "Here's what..." }
    { type: "text", content: " happens..." }
    { type: "tool_use", tool: "read_file", input: {...} }
    { type: "approval_request", requestId, tool, input }
    ↓
Client receives, displays message incrementally
    ↓
User sees tool approval prompt, clicks "Approve"
    ↓
Client sends: { type: "approval_response", requestId, approved: true }
    ↓
Provider continues streaming with tool result (no restart)
    ↓
If multiple messages queued, next message processes after done event
    ↓
Final response streamed, then: { type: "done", sessionId }
    ↓
Phase transitions to idle, clients can send new message
    ↓
useChat saves message to store, displays in chat history
```

### Session State Management

**Session Entry** (BE-owned, persists across FE disconnections):
```typescript
interface SessionEntry {
  providerId: string;              // Which AI provider (e.g., "claude")
  clients: Set<ChatWsSocket>;      // Connected FE clients (may be empty)
  abort?: AbortController;         // Current stream abort handle
  projectPath?: string;            // Project context
  projectName?: string;
  pingIntervals: Map<...>;         // Per-client keepalive
  phase: SessionPhase;             // "initializing" | "connecting" | "thinking" | "streaming" | "idle"
  cleanupTimer?: ReturnType<...>;  // Auto-cleanup if no FE reconnects (5min)
  pendingApprovalEvent?: {...};    // Current tool approval waiting
  turnEvents: unknown[];           // Buffered events (for reconnect sync)
  streamPromise?: Promise<void>;   // Track ongoing runStreamLoop
  permissionMode?: string;         // Sticky permission mode for session
}
```

**Client Connection States:**
- **Active streaming + FE connected** → Events broadcast to all clients in real-time
- **Active streaming + FE disconnected** → Events buffered in turnEvents array, BE stream continues
- **FE reconnects** → Receive session_state + buffered turnEvents, resync with stream
- **Idle (no query running)** → Phase is "idle", ready for next message
- **Idle + no FE for 5min** → Cleanup timer removes session from memory
- **…unless its subprocess is still held** → the cleanup timer reschedules itself while a
  prompt-cache release is pending, so the session entry outlives 5min only when there is a
  warm subprocess to protect (1h on a subscription, 5min on an API key)

### Follow-up Messages

**Abort-and-Replace Pattern:**
```typescript
if (entry.phase !== "idle" && entry.abort) {
  console.log(`[chat] aborting current query for new message`);
  entry.abort.abort();
  await entry.streamPromise;  // Wait for cleanup
  // Re-fetch entry — may have been mutated during cleanup
  entry = activeSessions.get(sessionId)!;
}
```

**Multiple Message Queueing:**
- First message: immediately starts runStreamLoop
- Second message (while streaming): abort current, wait, start new runStreamLoop
- Priority modes (future): could queue messages for intelligent interleaving

### Draft recovery

Chat drafts are saved synchronously to browser `sessionStorage`, scoped by
project, chat tab and session, alongside the debounced server save. A page
reload during session creation or connection restores the local text to the
composer without automatically sending it. Creating or editing into a new
session moves the local draft to that session; handing the message to the
socket clears it. This protects reloads in the same browser tab, not delivery
after the socket accepts a message or recovery after browser storage is cleared.

### WebSocket Reconnection Sync

Codex history loaded from disk uses asynchronous file reads and yields between
parser batches so usage, health and other requests can run during a long read.
Subagent lookups share a directory index within that history request. The
synchronous reader remains available for provider operations that require it.

Chat sockets receive a server heartbeat every 5 seconds. The client reconnects
after 45 seconds without any incoming frame, including sockets that still report
OPEN, and checks for a stale connection when the tab becomes visible. Replay
finishes before queued live frames are applied. If a turn becomes idle without a
usable finalized answer, the client reloads history; healthy completions retain
their richer live metadata. Recovery responses are discarded after new activity
or a session switch, and older initial loads cannot overwrite applied recovery.
Replacing a socket during a session ID migration does not signal a network
failure. A `session_state` acknowledgement clears the reconnect overlay even
when an active turn has no buffered events yet. Session ID migration carries
explicit model, effort and thinking choices to the provider's real thread ID.

```
FE WebSocket closes (network issue, tab closes)
    ↓
BE keeps session alive, streaming continues
    ↓
FE reconnects: WS /ws/project/:name/chat/:sessionId
    ↓
open() handler checks activeSessions.get(sessionId)
    ↓
If exists (entry found):
    1. Clear cleanup timer (FE is back)
    2. Send session_state with current phase + pendingApproval
    3. If phase !== "idle", send buffered turnEvents
    4. Add WS to clients Set
    ↓
FE processes session_state, renders current phase
    ↓
FE applies buffered events to rebuild turn state
    ↓
FE displays: "reconnected, current phase: streaming" etc.
```

### Phase Transitions

```
idle → initializing → connecting → thinking/streaming ↔ thinking/streaming → idle
  ^                                      ↑                                    ↓
  └──────────────────────────────────────────────────────────────────────────┘
```

**Phase Descriptions:**
- **idle** — No query running, ready to accept new message
- **initializing** — Preparing (permission checks, session resume)
- **connecting** — Waiting for first SDK event (heartbeat: "connecting" with elapsed time every 5s)
- **thinking** — Receiving thinking content (extended thinking)
- **streaming** — Receiving text/tool_use content (dynamic switch between thinking/streaming)

### Image Attachment Support

Messages can now include images:
```typescript
type ChatWsClientMessage =
  | { type: "message"; content: string; images?: { id: string; data: string }[]; priority?: string }
  | ...
```

Images are passed to provider's message context and included in tool input/output.


## Reply to a chat message

Standard chat can reply to completed user or assistant text. The composer retains its
text and attachments while showing a cancellable quote preview. Thinking, tool output
and injected context are excluded. A quote has a 12,000 Unicode code-point limit with
visible truncation. Group and teammate chat do not expose Reply.

`src/shared/chat-reply.ts` defines `ReplyReference` and a versioned trailing prompt
block. The WebSocket carries raw body plus `replyTo`; the server validates its shape
and current session/provider, rewrites skills on the raw body, then encodes the quote
before dispatch through either `sendMessage` or `pushMessage`. The quote is ordinary
user-supplied historical data, never a system/developer instruction. A built-in PPM
command with Reply selected is rejected until Reply is cancelled. Every reply the composer
makes travels as `replyTo`, an edit's included; a block typed or pasted into the text is not
one, and goes through unchecked. The composer ignores a reply naming another session or
provider than the tab's, which the server would refuse on every send.

Native provider transcripts preserve that block. The UI decodes it before parsing
attachments and system tags; title and search use the new body. Drafts use the same
codec in their existing content column and browser storage, without a schema migration.
The draft body retains its existing 50K-character limit; its validated quote is preserved
separately from that limit. Rejection events include a `clientMessageId` to recover the
right optimistic send even when two inputs are identical.

Navigation requires a matching provider/session and an unambiguous source: native SDK
UUID with matching quote, or message ID/timestamp/quote, then unique timestamp/quote
fallback. The snapshot stays visible when history has compacted, IDs changed or the
source is not loaded. Editing into a fork, or forking into a new tab, carries the snapshot
over as the fork's own reply; recalling a message with the arrow keys restores just the new
body.

Validation includes native transcript fixtures for Claude/Codex/Cursor, actual WS
send/push/echo/replay, mounted composer tests, and `tests/e2e/chat-reply-e2e.mjs`.
That browser test builds into a temporary output directory and serves the production
bundle alongside a recording mock provider on an isolated `PPM_HOME` and port. Set
`PPM_PLAYWRIGHT_MODULE` to an installed Playwright `index.mjs` when it is not a local
dependency, and optionally `PPM_PLAYWRIGHT_EXECUTABLE` to a Chromium executable.

## Session changes and review

The bar above the composer (`src/web/components/chat/session-changes-bar.tsx`) lists every
file one chat session has changed, across all its turns, and its Review button opens a
`session-review` tab (`src/web/components/session-review/session-review-tab.tsx`) that goes
through those changes block by block, the way Cursor and Zed review an agent's edits: each
block of each file, compared with the state the file was in **before the session first wrote
it**, is kept or reverted on disk where it sits. The pill under each answer
(`turn-change-rollup.tsx`) still covers that turn only, and answers it from the same list
(see "From the chat" below).

**The "before" is PPM's own copy**, because nothing else holds it. Claude Code's transcript
drops a tool's `toolUseResult.originalFile` above ~10 KB (measured: kept at 9,836 B, gone from
13.6 KB), an Edit's `old_string` is a fragment at an unknown offset, SDK file checkpointing is
off, and git HEAD also holds whatever was uncommitted before the session began.
`src/services/session-file-baselines/session-file-baselines.service.ts` keeps one record per
file at `<ppm dir>/session-baselines/<session id>/<sha256 of the path>.json`. A record is
written to a temp file and hard-linked into place, so the **first capture wins** — a later one
fails with `EEXIST` and can never replace the real "before" with a state the session itself
produced. Files over 5 MB and binary files are recorded without content; credential paths
(`isCredentialPath`) are never copied. Records go with the session (`DELETE /chat/sessions`)
and are pruned after 30 days without a capture or a write recorded in their history
(`pruneSessionBaselines`, at start and daily).

How each provider takes it:

- **Claude** — a PreToolUse hook for `Write|Edit|MultiEdit|NotebookEdit`
  (`buildToolHooks` / `fileWriteTarget` in `claude-agent-sdk-query-options.ts`) awaits
  `captureBaseline` before the CLI runs the tool, and returns `{}` so it makes no permission
  decision. It runs in **every** permission mode, and on warm spares through
  `SpareHandlers.fileWrite`: in bypass mode as a hook of its own, elsewhere from the permission
  hook once that has allowed the write, so a denied write records nothing and an edit made
  while the prompt was open is not put on the session. Verified against the real CLI in bypass
  mode: the main agent's Edit and a sub-agent's Write both left a record.
- **Claude, shell commands** — a `Bash`/`PowerShell` call names no file, so
  `shell-change-tracker.ts` brackets it with `git status --porcelain=v2 -z --untracked-files=all`
  (with `GIT_OPTIONAL_LOCKS=0`, ~6 ms on this repository) in every repository the command can
  reach: the hook's `cwd`, which follows a `cd` (measured with the real CLI), the paths it
  names (`cd`/`pushd`/`-C` targets and path-like words), and the last four the session worked
  in. A PreToolUse hook takes the snapshot and reads every listed file, recorded or not, since
  the command's own two states go in the file's history (32 MB budget per command); PostToolUse
  and PostToolUseFailure take a second one.
  A file listed before whose stat moved keeps the bytes read before; a file listed only after
  was clean, i.e. HEAD, so its record is the blob from the *pre-command* HEAD through
  `cat-file --filters` (the checked-out form — under `core.autocrlf` a raw blob would diff every
  line). A HEAD move of up to 200 files is followed too, which is what finds an edit committed
  in the same command; a larger one (a branch switch, a pull) came from commits and is not. An
  index-only move (`reset --soft`) records nothing, because the post-status names the blob on
  disk. Outside bypass mode the permission hook runs the shell hook itself once it has allowed
  the command, so an edit made while the prompt was open is not put on it (checked with the
  real CLI in default mode); a file another session's file tool wrote during the command is
  skipped (`noteFileToolWrite`). A repository whose status times out (5 s) or lists over 20,000
  files is skipped for 10 minutes, and a home directory kept in git is never bracketed.
- **Codex** — the patch is applied before PPM is notified, so `codex-file-baselines.ts` runs at
  `item/completed` and works the "before" out: an added file did not exist, a deleted file's
  content is in the change, and an update is the unified diff reverse-applied to the file on
  disk (`reverse-unified-diff.ts`, which refuses a hunk that does not match rather than guess).
  The session id is `live.threadId`; the routes resolve migrated ids.

The routes are `POST /chat/sessions/:id/file-changes` (`{ paths? }` → every changed file with
status, line counts, a `version` = size:mtime of the file on disk, its blocks by key with the
kept ones flagged, and `base`, a hash of the text the blocks were cut against) and
`GET /chat/sessions/:id/file-changes/diff?path=` (the same plus both sides), in
`src/server/routes/chat-file-changes.ts` over `session-file-changes.service.ts`. A file with
no record falls back to git HEAD only if it is **inside the project** and named in `paths` —
which is how a session from before baselines still gets a review — and every read goes
through the generic file routes' `assertReadPermitted`. Edited versions and forks read their
parents' records too (`getBranchRow` chain), since files are not rewound when one is made.
Files whose two sides are equal are left out. Shapes are in `src/shared/session-file-changes.ts`.
Every route of the file first answers 404 for a session that is not the project's: the
project PPM recorded for it decides (a provider records it when the session starts, the Claude
capture hooks when PPM first keeps a write of a session started elsewhere), and one with no
record passes only while PPM keeps none of its writes.

In the browser, `use-session-file-changes.ts` asks again (400 ms debounce) when the
transcript names a new file, when a file write or a shell command finishes
(`sessionFileWrites` counts those tool calls whose result has arrived — an announced write
has not touched the disk yet, and a shell command's files are known only to the server), and
when a turn starts or ends; not on every streamed token. Each answer is broadcast as
`SESSION_CHANGES_EVENT` so an open Review tab follows along; the tab also fetches on its own
with the paths stored in its metadata, because after a reload its chat may never have
mounted. A diff on screen is refetched on `changeKey` (path, status, baseline kind, version
and review state), since one edit undoing another changes the content without changing the
counts.
Codex patches over several files are one Edit/Write card with `input.files` listing them all
(`changeToToolUse`), which both the turn chip and the session list read.

**Marking files reviewed** hides them from the bar, its totals and the Review tab until the
agent changes them again (Cursor's Keep). A row's checkbox and the bar's "Mark all reviewed"
call `POST /chat/sessions/:id/file-changes/reviewed` (`{ files: { path, version }[], reviewed }`);
the Review tab marks a file through its answers instead (below). A mark is a snapshot of the
file as it was marked, under `<session dir>/reviewed/` (`session-review-marks.ts`): content for
text, a SHA-256 for anything under the 5 MB cap, the version otherwise. The listing still
returns a marked file, flagged `reviewed` while its bytes are unchanged (a rewrite with the
same content stays reviewed) and `sinceReview` once they move; a `sinceReview` file's counts
and blocks are against the marked state, so only what is new is left to answer, while its
status letter stays the session's. Two rules keep a mark honest. It is written only for a file
that is still one of the session's changes **and still at the `version` the browser showed**,
so a file the agent moved on while it was being read is left unhidden and named in `stale`;
and the snapshot comes from that same guarded read, so a path the read guard refuses is never
copied. Unmarking writes a `cleared` record rather than deleting one, because marks are read
along the session's lineage like its "before"s and a deleted record would let a parent's mark
show through. Both lists update at once and ask the server again once the marks are saved,
fetching nothing meanwhile (a list answered before the marks landed would bring the rows
back); a mark saved from the tab is announced as `SESSION_REVIEW_MARKS_EVENT` for the bar.
With every file reviewed the bar shrinks to "All N files reviewed".

**Blocks.** `src/shared/review-blocks.ts` cuts a file into blocks: the hunks of a line diff
(jsdiff `diffLines`, 200 ms timeout) with three lines of context, changes at most six
unchanged lines apart merged into one block. It is shared because both halves must cut exactly the same
blocks — the browser names the block the user answered by its key, and the server cuts the
blocks again from the disk before it does anything. A key is the block's place in the *base*
plus a hash of its lines, so an edit elsewhere in the file leaves it alone, while the agent
touching the block again gives it a new key, which is what reopens a kept block. Lines keep
their terminators while blocks are cut and pasted, so a revert puts back the base's exact
bytes, CRLF and a missing final newline included. A diff that times out (a large file
rewritten wholesale), a binary file and one over the size cap have no blocks: the tab answers
them whole.

**Answers.** `POST /chat/sessions/:id/file-changes/answer`
(`{ answer: "keep" | "open" | "revert", files: [{ path, version, keys? }] }`, no `keys` = every
block) is `session-review-actions.ts`. A file not at the `version` the browser drew it at is
left alone and answered `stale`, so nothing is ever kept or reverted on lines nobody saw. Keep
and open write the session's kept-block record, `<session dir>/reviewed/<sha256 of the
path>.blocks.json` (`session-review-blocks.ts`), which carries the base's hash and is ignored
once the base moves; a file left with every block kept is marked reviewed, exactly as the
bar's checkbox does, so a later agent edit comes back as `sinceReview` with only its new blocks
open. A revert writes the base's lines back on disk — the "before", or the marked state for a
`sinceReview` file — and needs no record, because a reverted block is no longer a change; a
file that is not plain UTF-8 or is over 64 MB is refused. Each answer is journalled under
`<session dir>/undo/` (dropped after 24 h) with the session's records for every file it touched
and, for a revert, the file's bytes before and after. `POST …/file-changes/undo { undoId }`
puts a revert's change back even after other blocks of the file were answered, wherever its
lines are still as the revert left them (`reapply`, a three-way placement through `lineMap`),
and the records only while nothing has answered the file since. One file it cannot put back
makes the whole undo `stale`, so a multi-file answer never comes back half.

**The tab.** `use-session-review.ts` holds the state and `session-review-model.ts` the pure
half (blocks per file, what each was answered, where focus goes next). Answers show at once
and go to the server one at a time: a revert moves a file's version, so a second answer on the
same file drawn before the first landed is sent with the version the first one left, never
with one the agent made. A list asked for before the last answer landed is dropped, since it
would bring answered blocks back. A reverted block drops out of the server's list, so the tab
keeps it to show in place (and `gone` for a file with nothing left) until the agent writes
over its lines. The rows are cut from the diff on screen while the kept flags come from the
list: a keep or reopen does not move `changeKey`, so the diff is not fetched again for it, and
the last four cuts are cached so an answer does not re-diff the file. Lines are coloured by
the app's shiki adapter like the chat's code blocks, the changed part of a line marked over
the tokens (`review-tokens.tsx`). The desktop layout (`review-desktop.tsx`) is a file rail
beside the blocks with J/K/Y/N keys, Undo in a toast, Revert file… behind a confirmation and
Keep all remaining; the rail folds behind an "N files" button below 760px of the tab's own
width (a container query, since a split is not a phone). Below `md` (`review-phone.tsx`) the
blocks carry no buttons: a 44px bottom bar answers the block in focus, and the file list and
file actions are bottom sheets.

**Which turn wrote what.** Every call that writes a file reports the file as it was just before
the call and just after it: the Claude file-write hook on PreToolUse and PostToolUse (the hook
that takes the "before"), the shell hooks for each file a command moved, and
`codex-file-baselines.ts` for a patch. `session-file-history.ts` appends those states to
`<session dir>/history/<sha256 of the path>.jsonl`, each stored as a line delta from the state
before it (a state that is not text keeps only a hash), so a file edited two hundred times costs
two hundred small deltas rather than two hundred copies. `session-file-blame.ts` replays that
log from the base the blocks were cut against, the way `git blame` walks commits, and the
listing gives each block the `calls` that put its lines in or took them out. A change between
one call's "after" and the next call's "before" — the user's own edit, a formatter on save —
names no call. Replays are cached per file and base, so asking again costs only what the log
gained since. The browser turns calls into turns (`src/web/lib/session-turns.ts`): a turn is a
user message with the tool calls that answered it, sub-agent steps included, numbered from the
last compaction ("Earlier turn" before it). The chat publishes its turns to
`session-turns-store.ts` as it renders them; a Review tab with no chat open reads the transcript
itself (`use-session-turns.ts`), and not again for a call it could not place. A block's chip
opens the turn's prompt, and Show in chat goes through `chat-jump-store.ts` to the chat tab,
which scrolls to the call's tool card and flashes it.

**From the chat.** The pill under each answer reads the session's list through
`SessionChangesContext` (provided by `chat-tab.tsx`, so the bar, the pill and an open tab never
disagree) and says how the turn's edits stand (`src/web/lib/turn-review.ts`): an edit is open
while any block its call wrote is open, kept once all are, and reverted once no block holds it
any more. Where the list names no calls — a session from before the history, a binary file —
the edit is unknown and the pill says nothing, rather than calling it reverted. The tray
(`turn-change-tray.tsx`, a bottom sheet on a phone in `turn-change-sheet.tsx`, both over
`turn-change-review.tsx` and `use-turn-review.ts`) keeps or reverts an edit's blocks through
the same `/file-changes/answer`, at the version on screen, keeps every open block of the turn at
once, and reverts the turn with `POST …/file-changes/revert-turn { calls, apply? }`
(`session-turn-revert.ts`). Without `apply` it is a preview and writes nothing: each file's part
of the turn is cut into runs of the turn's calls with no other change between them, each run
into hunks with no context, and a hunk goes back only where its lines are all still there,
together. One a later change wrote over stays, named with the calls that did, which the
confirmation turns into "Turn 3 changed it again". `apply` names every previewed file at the
version it was previewed at and works everything out again; one file that moved makes the whole
revert `stale`, and the browser shows the newer preview instead. A revert is journalled like a
revert answer, so the same Undo puts it back. Answering one edit is per block: a block that
holds two calls' lines goes back whole.

Not covered, and said in the list (`shellChangesHint`, which knows the provider): files a
shell command changed that git ignores or that sit outside any repository, anything a
background command writes after its call returns, and every Codex shell command — Codex
reports a command only once it is running, so a snapshot taken then would race it. Source
Control shows everything on disk.

Verify with `bun tests/e2e/session-changes-e2e.mjs` (set `PPM_PLAYWRIGHT_MODULE`): a scripted
provider writes real files over four turns on an isolated `PPM_HOME`, and the test checks the
bar, the inline list and the phone sheet, the changes against the pre-session state (an
uncommitted hand edit included), review marks set and undone from the bar, and the Review tab
on a desktop and a phone: keep and revert by key and by button with the disk and the server
checked after each, Undo and Change, Keep file, Revert file… restoring a deleted file and
undoing it, a kept file changed again coming back with only its new block, the rail folding
in a narrow window, Keep all remaining, and every answer surviving a reload; each block's turn
chips, a turn's prompt and Show in chat; an opened fold's lines measured to share a block's
columns, line numbers and code alike; and the chat's pill and tray on a desktop and a phone —
an edit kept, another reverted and undone, Keep all, and Revert turn previewed (a created file
removed, a line a later turn changed again left alone), applied and undone, a shell command's
files included. The fixture records each call's states the way the hooks do.
`PPM_CHANGES_ONLY=desktop-tray,mobile-tray` runs only the named scenarios.

## AI tab tools

PPM's own answer to claude.ai's Artifact tool. The AI writes a file and calls a tool, and the
file opens in a PPM tab on the device the user is chatting from: `open_file` (optional
`line`) for any file the user asks to see, `open_preview` for a page, chart, report or mockup
the AI made, which also returns how the page rendered. Because PPM serves the page, it works
wherever PPM is reached — LAN, tunnel, phone — and a script, stylesheet or font may come from
the design CDNs.

**The setting.** Settings → AI Provider → *Let the AI open tabs in PPM* (`ai.tab_tools`, off by
default). While it is on, every chat that is not a design session is given both tools (a
design session checks its canvas with `design_check` instead), and Claude is spawned with
`CLAUDE_CODE_DISABLE_ARTIFACT=1`, which removes `Artifact`, `ArtifactComments` and
`ArtifactData`. A chat keeps the MCP servers its process started with, so turning the setting
on reaches chats started afterwards, and turning it off is enforced by the endpoint itself:
a call made after that is refused with a message that says why.

**How a call travels.**

1. `chatService.prepareSendOptions` adds `tabToolsMcp` — `{ url, token }` from
   `tabToolsMcpAccessFor`, on the port the server actually bound — to every turn.
2. Claude gets it as the `http` MCP server `ppm-tabs` (`tabToolsMcpServers`), the token in
   `Authorization`, a 60 s timeout, and both tools allowed by the PreToolUse hook without a
   prompt (`CLAUDE_TAB_TOOLS`). A warm spare is started with the server but no token; the token
   is minted when the spare is adopted, for the session id it is adopted with, and
   `withSessionTokenMasked` keeps it out of the spawn fingerprint. Codex gets
   `mcp_servers.ppm_tabs` on `thread/start`/`thread/resume` (`tabToolsMcpConfig`) with
   `bearer_token_env_var`, so the token lives only in that app-server's environment, plus
   `enabled_tools`, `default_tools_approval_mode = "approve"` and `tool_timeout_sec = 60`.
3. `/api/tab-tools-mcp` (`tab-tools-mcp-endpoint.ts`, mounted before auth) resolves the token
   to its session, checks the setting, and resolves `path` (`tab-target.ts`): absolute, `~`, or
   relative to the session's project; it must exist and be a file, and it goes through the
   editor's own read rules (`assertReadPermitted`, so the PPM directory and `~/.cloudflared`
   are refused) — checked here so the AI hears why rather than the user seeing a tab that
   cannot load. A file inside the project is named relative to it, the way the file explorer
   names it, so a tab the user already has open for it is the one reused.
4. `tab-open-broker.ts` sends `tab_open` (`src/shared/tab-open-protocol.ts`) through
   `deliverTabOpen` in `src/server/ws/chat.ts`: to the socket that sent the turn's message
   (`lastSender`), or, when that one has gone, to every socket showing the chat. It is never
   buffered into `turnEvents` — a device reconnecting later must not open the tab again. The
   first `tab_open_result` settles the call: 8 s for `open_file`, 40 s for `open_preview`.
5. In the browser, `use-chat.ts` hands `tab_open` to `answerTabOpen` (`src/web/lib/open-ai-tab.ts`)
   ahead of any replay queue, because the server is waiting. It brings up the chat's workspace
   if another project is on screen, opens the tab, and for an HTML page waits for a load newer
   than the one it saw before (`html-preview-loads.ts`, up to 12 s), lets the page's scripts
   draw for 1.5 s, and runs the design canvas's self-check through the preview's bridge
   (`runCanvasCheck`): script errors, failed loads, CSP violations, layout findings and a
   screenshot. Every outcome is answered, including failures, so the AI never waits out the
   timeout because a device stayed silent.
6. The endpoint turns the report into text (`formatPreviewCheck`: viewport, page size, each
   problem fenced as untrusted, "fix them and call again") with the screenshot as an MCP image
   block, unless the AI passed `screenshot: false`. Markdown, images, PDF and CSV open in PPM's
   viewers and are not checked.

**Where the tab goes** (`ai-tab-placement.ts`, pure). On a desktop the chat stays on screen:
the file opens in another panel, and when the chat's panel is the only one it is split so the
file sits to the chat's right. A tab already showing the file is brought to the front, or
moved out beside the chat when it was hidden behind it in the chat's own panel. A phone shows
one panel at a time, so there the tab opens in the first panel and takes the screen; the tab
bar leads back to the chat. Every call stamps `aiView` and `aiOpenAt` on the tab's metadata,
which `code-editor.tsx` reads: `line` switches the tab to code at that line, `open_preview` to
the preview and reloads it, in a tab that was already open too.

**The HTML preview** now serves the design canvas's policy (`buildDesignCsp`): the same
`sandbox allow-scripts`, plus scripts, styles, fonts and images from the design CDNs, with
`connect-src` still limited to the preview's own files. An HTML page up to 32 MB is served with
`design/bridge/html-preview-bridge.ts` as the first thing in its `<head>` — the design bridge's
core and its self-check, with nothing that selects, edits or blocks links — and every load has
its own nonce (`?n=`). A bigger page is served as it is, unchecked, and so is a UTF-16 one,
which the browser reads by its byte-order mark (Windows PowerShell's `Out-File` writes them).

**The card.** `tab-tool-call.ts` recognises both providers' names — `mcp__ppm-tabs__<tool>`
for Claude, `ppm_tabs:<tool>` for Codex, whose input is wrapped as
`{ server, tool, arguments }` both live and in history — and `tool-cards.tsx` renders
`tab-tool-card.tsx`: what was opened, the check's problem count, the result text (Codex's
`[image]` label dropped), and an Open button that brings the tab back through the same
`openAiTab` — from history, after the tab was closed, or on another device. The screenshot
is not in the chat's history (images are stripped from tool results), so the card does not
show it; Open shows the live page.

**A renamed session.** Codex renames a new chat to its thread id during the first turn, after
the token was minted under PPM's id, and `ws/chat.ts` moves the chat's sockets to the new id.
The broker keys its pending calls, limits and delivery by `resolveMigratedSession`
(`setTabOpenDelivery(deliverTabOpen, resolveMigratedSession)`), so a call made under the old
id still reaches the chat. Before that, every call in a new Codex chat answered "no device".

**Limits and trust.** The token can do exactly one thing — open a tab on its own session's
devices, for a file the agent could already read — and is held in memory only, looked up by
its SHA-256 (`mcp-session-tokens.ts`, shared with `/api/design-mcp`). Deleting the chat
revokes it and a restart revokes every one; the token a Codex chat was given under PPM's id,
before the rename, outlives the chat's deletion until that restart. The
endpoint (`mcp-http-endpoint.ts`, also shared) refuses a request carrying an `Origin` and caps
a body at 64 KB. A session may have 4 calls in flight and 20 a minute (64 pending in all), so an
agent talked into opening tabs in a loop stops there. A device's answer settles only a call
pending for its own session, and is parsed like a design check's (`parseTabOpenResult`),
since the page's own scripts can write anything into the report; the device's error text has
its control characters stripped and its fences neutralised before the AI reads it.

**What real models did** (Opus 5.5 at effort high, Codex 0.160, on a scratch PPM):

| Scenario | Outcome |
|---|---|
| Claude, sales dashboard | `open_preview` 5 s after the Write; the check found nothing, but the screenshot showed the table's last columns cut off at 541 px — fixed, called again |
| Claude, page with a 404'd chart library | problem reported → fixed → clean, 73 s |
| Claude, `open_file` with a line | the config file, then line 20, 28 s |
| Claude, from a phone | opened full screen; the check ran at 390x748 |
| Claude, no browser open | told at once; it named the file's path instead |
| Codex, the same broken page | 2 problems → fixed → clean, 107 s |
| Codex, `open_file` with a line | 38 s |

Two findings shaped the tool description. With the user's Playwright MCP available, the first
description made Opus check the page in its own headless browser for four minutes (28
Playwright calls) and open the tab only at the very end, so the user watched nothing; saying
*when* to call — as soon as the file is written, because the user watches while you fix — and
that the check needs no browser of its own moved the call to 5 s after the Write (Codex's came
34 s after its Write). Opus still opened its own browser afterwards, but only for what the
check cannot see: hover tooltips and dark mode. That first run had also inherited a max
effort, so the two changes are not separated. And Claude Code 2.1.280+ defers MCP tools, so a session's first call to either tool
is preceded by a `ToolSearch`.

Verify with `PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs node tests/e2e/ai-tab-tools-e2e.mjs`:
a scripted provider (`tests/e2e/fixtures/tab-tools-server.ts`) calls the real endpoint with the
token each turn was handed, on the production bundle and an isolated `PPM_HOME`, and the test
checks where the tab lands on a desktop and a phone, a tab that was already open being reloaded,
a line in code view, the card's Open button, the setting turned off, and a chat with no browser.
`PPM_TAB_TOOLS_WEB_DIR` reuses a scratch build. `tests/e2e/html-preview-cdn-check-e2e.mjs`
covers the preview's CDN loads and its self-check on their own. Both need internet for the CDNs.
