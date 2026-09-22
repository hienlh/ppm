# AI Chat & Providers

> Part of the [PPM system architecture](../system-architecture.md).

## Codex daily guard for weekly-only accounts

Daily guard spreads a seven-day quota window across five weekdays: each weekday
unlocks another 20% of the weekly quota. Unused allowance carries forward.
Saturday/Sunday slots keep the previous cap; a window starting on a weekend
opens its first allowance on Monday. Slots are 24 hours from the weekly reset
time and use UTC weekdays, consistently in the server and browser. This does not
change Codex's reset schedule. Users can disable the guard per account.

## Model discovery cache

The chat model picker shares successful model lists across chat tabs, keyed by
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

### WebSocket Reconnection Sync

Chat sockets receive a server heartbeat every 15 seconds. The client reconnects
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
