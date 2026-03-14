# Opcode Deep Analysis: Claude Code CLI Integration & Architecture

**Date:** 2026-03-15
**Scope:** Codebase architecture, Claude Code CLI integration, agent system, web server design
**Status:** Complete

---

## Executive Summary

Opcode is a sophisticated desktop/web application (Tauri + React + Rust) that provides multi-modal access to Claude Code CLI. Key architectural patterns worth adopting for PPM:

1. **Robust Binary Discovery** - 19-point fallback chain for locating claude CLI across macOS/Windows/Linux
2. **Session-Scoped Event Architecture** - Proper isolation of concurrent sessions using namespaced DOM events
3. **Stream-JSON Parsing** - Clean abstraction for parsing Claude's output format
4. **Agent System with Database Persistence** - CRUD ops for reusable agents with hooks and capabilities
5. **Dual-Mode Execution** - Desktop (Tauri IPC) + Web (REST API + WebSocket) with clean provider pattern

---

## 1. Architecture Overview

### 1.1 Tech Stack
- **Frontend:** React 18.3, TypeScript, Zustand (state), Tauri v2 / Web mode
- **Backend:** Rust (Tauri commands), Tokio async runtime, Axum web server
- **Data:** SQLite for agents DB, JSONL for session history
- **Build:** Vite, Bun, Cargo
- **Process Management:** tokio::process for subprocess spawning

### 1.2 Directory Structure
```
opcode/
├── src/                           # React/TS frontend
│   ├── components/
│   │   ├── ClaudeCodeSession.tsx
│   │   └── claude-code-session/useClaudeMessages.ts
│   ├── lib/
│   │   └── apiAdapter.ts          # Environment detection & WebSocket client
│   └── stores/
├── src-tauri/src/
│   ├── main.rs                    # Tauri setup
│   ├── lib.rs
│   ├── claude_binary.rs           # Binary discovery (694 lines)
│   ├── commands/
│   │   ├── claude.rs              # Session execution (2342 lines) ✨ CRITICAL
│   │   ├── agents.rs              # Agent management (1996 lines)
│   │   ├── mcp.rs
│   │   ├── proxy.rs
│   │   ├── storage.rs
│   │   └── slash_commands.rs
│   ├── checkpoint/                # Session checkpoints (restore to prior state)
│   ├── process/
│   │   └── registry.rs            # Process lifecycle tracking
│   └── web_server.rs              # HTTP/WS server (Axum)
├── cc_agents/                     # Pre-built agent configs
│   ├── unit-tests-bot.opcode.json
│   ├── git-commit-bot.opcode.json
│   └── security-scanner.opcode.json
└── web_server.design.md           # Design doc with known issues ⚠️
```

---

## 2. Claude Code CLI Integration (CRITICAL FOR PPM)

### 2.1 Binary Discovery Pattern

**File:** `src-tauri/src/claude_binary.rs` (694 lines)

**Pattern:** 19-point fallback discovery chain:

```rust
pub fn find_claude_binary(app_handle: &tauri::AppHandle) -> Result<String, String> {
    // 1. Check database for stored path + user preference
    // 2. Discover all system installations
    // 3. Sort by version + source preference
    // 4. Select best installation
}

fn discover_system_installations() -> Vec<ClaudeInstallation> {
    // Tries in order:
    // 1. which command (Unix) / where (Windows)
    // 2. NVM_BIN env var (active NVM)
    // 3. ~/.nvm/versions/node/*/bin/claude
    // 4. /usr/local/bin/claude
    // 5. /opt/homebrew/bin/claude
    // 6. ~/.claude/local/claude
    // 7. ~/.local/bin/claude
    // 8. ~/.npm-global/bin/claude
    // 9. ~/.yarn/bin/claude
    // 10. ~/.bun/bin/claude
    // 11. ~/bin/claude
    // 12. ~/.config/yarn/global/node_modules/.bin/claude
    // 13. PATH lookup
}
```

**Key Features:**
- Version detection via `claude --version`
- Semantic version comparison for selection
- Handles shell aliases (parses "aliased to /path" output)
- Persists user selection to SQLite
- Cross-platform (macOS, Linux, Windows)

**PPM Opportunity:** Replace simple `which claude` with this robust discovery.

### 2.2 Process Execution & Streaming

**File:** `src-tauri/src/commands/claude.rs` (2342 lines)

**Main execution functions:**

```rust
#[tauri::command]
pub async fn execute_claude_code(
    app: AppHandle,
    project_path: String,
    prompt: String,
    model: String,
) -> Result<(), String> {
    let claude_path = find_claude_binary(&app)?;

    let args = vec![
        "-p".to_string(), prompt,
        "--model".to_string(), model,
        "--output-format".to_string(), "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    let cmd = create_system_command(&claude_path, args, &project_path);
    spawn_claude_process(app, cmd, prompt, model, project_path).await
}
```

**Key Args:**
- `-p <prompt>` - User message
- `--model sonnet|opus` - Model selection
- `--output-format stream-json` - Structured JSON output (CRITICAL)
- `--verbose` - Detailed logging
- `--dangerously-skip-permissions` - Web/API mode only
- `-c` - Continue existing session
- `--resume <session_id>` - Resume from checkpoint

**Output Format (stream-json):**

Each line is a JSON object:

```json
{ "type": "system", "subtype": "init", "session_id": "uuid-here", ... }
{ "type": "text", "content": "Hello" }
{ "type": "tool_use", "tool": "bash", "input": { "command": "ls" } }
{ "type": "response", "message": { "usage": { "input_tokens": 100, "output_tokens": 50 } } }
```

### 2.3 Session-Scoped Event Architecture

**Problem in opcode:** Generic events cause cross-session interference

**Solution in Tauri (working):**

```rust
// In claude.rs spawn_claude_process()
if let Some(ref session_id) = *session_id_holder.lock().unwrap() {
    // BOTH generic + session-scoped events for compatibility
    let _ = app.emit(&format!("claude-output:{}", session_id), &line);
    let _ = app.emit("claude-output", &line);
}
```

**Frontend (useClaudeMessages.ts):**

```typescript
// Listens on session-scoped events
await listen(`claude-output:${sessionId}`, handleOutput);
```

**Critical Issue:** Web server (apiAdapter.ts) only dispatches generic DOM events → all sessions interfere.

**PPM Fix:**

```typescript
// In web mode, dispatch both:
window.dispatchEvent(new CustomEvent('claude-output', { detail }));
window.dispatchEvent(new CustomEvent(`claude-output:${sessionId}`, { detail }));
```

### 2.4 Process Registry & Lifecycle Management

**File:** `src-tauri/src/process/registry.rs`

Tracks concurrent processes:

```rust
pub struct ProcessRegistry {
    processes: Arc<Mutex<HashMap<i64, ProcessHandle>>>,
}

pub struct ProcessInfo {
    run_id: i64,
    process_type: ProcessType, // AgentRun | ClaudeSession
    pid: u32,
    started_at: DateTime<Utc>,
    project_path: String,
}
```

**Usage in claude.rs:**

```rust
// Register session after init message arrives
registry.register_claude_session(
    claude_session_id,
    pid,
    project_path,
    prompt,
    model
)?;

// Unregister on completion
registry.unregister_process(run_id);
```

**Killing processes:**

```rust
pub async fn cancel_claude_execution() {
    // Method 1: Find in registry by session ID
    let process_info = registry.get_claude_session_by_id(&session_id)?;
    registry.kill_process(process_info.run_id).await?;

    // Method 2: Legacy via ClaudeProcessState
    let mut child = claude_state.current_process.lock().await;
    child.kill().await?;

    // Method 3: System fallback
    std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).output();
}
```

---

## 3. Agent System Design

**File:** `src-tauri/src/commands/agents.rs` (1996 lines)

### 3.1 Agent Structure

```rust
pub struct Agent {
    pub id: Option<i64>,
    pub name: String,
    pub icon: String,
    pub system_prompt: String,
    pub default_task: Option<String>,
    pub model: String,
    pub enable_file_read: bool,
    pub enable_file_write: bool,
    pub enable_network: bool,
    pub hooks: Option<String>, // JSON serialized
    pub created_at: String,
    pub updated_at: String,
}
```

### 3.2 Agent Execution Run

```rust
pub struct AgentRun {
    pub id: Option<i64>,
    pub agent_id: i64,
    pub agent_name: String,
    pub task: String,
    pub model: String,
    pub project_path: String,
    pub session_id: String,  // UUID from Claude Code
    pub status: String,      // 'pending', 'running', 'completed', 'failed'
    pub pid: Option<u32>,
    pub process_started_at: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}
```

### 3.3 Metrics from JSONL

```rust
pub struct AgentRunMetrics {
    pub duration_ms: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub message_count: Option<i64>,
}

impl AgentRunMetrics {
    pub fn from_jsonl(jsonl_content: &str) -> Self {
        // Parse JSONL file from ~/.claude/projects/{encoded_path}/{session_id}.jsonl
        // Extract:
        // - timestamps → duration_ms
        // - usage.input_tokens + usage.output_tokens → total_tokens
        // - cost field → cost_usd
        // - line count → message_count
    }
}
```

### 3.4 .opcode.json Agent Config Format

**Example:** `cc_agents/unit-tests-bot.opcode.json`

```json
{
  "version": 1,
  "agent": {
    "name": "Unit Tests Bot",
    "icon": "code",
    "model": "opus",
    "default_task": "Generate unit tests for this codebase.",
    "system_prompt": "# System Prompt with multi-agent workflow...",
    "enable_file_read": true,
    "enable_file_write": true,
    "enable_network": false,
    "hooks": null
  },
  "exported_at": "2025-06-23T14:29:51.009370+00:00"
}
```

**Agents are fully customizable templates** - users can create agents with:
- Custom system prompts (multi-agent orchestration patterns)
- Capability toggles (file access, network, etc.)
- Model selection (sonnet vs opus for cost/quality tradeoff)
- Task templates
- Hook configurations

---

## 4. Web Server Architecture (Axum + WebSocket)

**File:** `src-tauri/src/web_server.rs`

### 4.1 Dual-Mode Execution

**Tauri Desktop Mode:**
- Direct process spawning via `std::process::Command`
- IPC events via Tauri's event system
- Session isolation via namespaced events

**Web Server Mode:**
- HTTP/WS via Axum server
- DOM events as fallback
- Subprocess execution in separate tokio runtime

### 4.2 WebSocket Flow

```typescript
// Frontend request
const req = {
    command_type: "execute|continue|resume",
    project_path: "/path/to/project",
    prompt: "user message",
    model: "sonnet",
    session_id: "uuid-for-resume"
};

// Backend streams responses as newline-delimited JSON
// Each line is a claude stream-json message:
{ "type": "system", "subtype": "init", "session_id": "..." }
{ "type": "text", "content": "response text" }
```

### 4.3 Critical Issues in Web Server (⚠️ DOCUMENTED IN web_server.design.md)

**1. Session-Scoped Event Dispatching (CRITICAL)**
- Backend only dispatches generic `claude-output` events
- Frontend expects session-scoped `claude-output:${sessionId}` events
- **Result:** Multiple concurrent sessions interfere with each other

**2. Process Management (CRITICAL)**
- `cancel_claude_execution` endpoint is a stub
- Doesn't actually terminate processes
- No process handle tracking

**3. stderr Handling (MEDIUM)**
- Only captures stdout
- Errors not displayed to user

**4. Missing claude-cancelled Events (MEDIUM)**
- No cancellation event support

---

## 5. Comparison: Opcode vs PPM Approach

| Aspect | Opcode | PPM (current) | PPM (proposed) |
|--------|--------|---------------|----------------|
| **Binary Discovery** | 19-point chain with version detection | `which claude` | Adopt opcode's robust chain |
| **Session Management** | Database + Process Registry | Map<sessionId, stream> | Registry + namespaced events |
| **Event Architecture** | Tauri IPC + DOM events (session-scoped) | Generic chat events | Adopt session-scoped pattern |
| **Stream-JSON Parsing** | Full line-by-line parser | Chunks/text accumulation | Structured JSON line parsing |
| **Agent System** | Full CRUD with DB persistence | Not yet | Design doc exists |
| **Process Termination** | Kill via registry + system fallback | Not yet | Implement registry pattern |
| **Web Mode** | Axum + WebSocket (has known issues) | HTTP streaming | Fix session isolation issues |

---

## 6. PPM Integration Recommendations

### 6.1 Phase 1: Binary Discovery (HIGH PRIORITY)

**Adopt opcode's claude_binary.rs pattern:**

```typescript
// PPM: src/services/claude-binary.ts
export async function findClaudeBinary(): Promise<string> {
    // 1. Check stored path in IndexedDB
    // 2. Run 'which claude'
    // 3. Check standard paths (Homebrew, NVM, etc.)
    // 4. Return highest version found
}
```

**Why:** Current PPM likely uses simple shell command, fails on non-standard installations.

### 6.2 Phase 2: Session-Scoped Events (HIGH PRIORITY)

**Current issue in PPM:** All sessions share same event stream

**Fix (for web mode):**

```typescript
// src/server/routes/chat.ts
ws.on('message', async (msg) => {
    const { sessionId, prompt } = JSON.parse(msg);

    for await (const event of executeClaudeCode(prompt)) {
        // DISPATCH BOTH generic + scoped events
        const jsonLine = JSON.stringify(event);

        // Generic for backward compat
        ws.send(jsonLine);

        // Scoped for proper isolation
        const scopedEvent = JSON.stringify({
            ...event,
            _sessionId: sessionId
        });
        ws.send(scopedEvent);
    }
});
```

**Frontend listening:**

```typescript
const handleStreamMessage = (event) => {
    if (event._sessionId === currentSessionId) {
        // Only process messages for this session
        updateMessages(event);
    }
};
```

### 6.3 Phase 3: Stream-JSON Parsing (HIGH PRIORITY)

**Structure output properly:**

```typescript
export interface ClaudeStreamMessage {
    type: "system" | "text" | "tool_use" | "response" | "error";

    // Common fields
    timestamp?: string;

    // For "system"
    subtype?: "init" | "update";
    session_id?: string;

    // For "text"
    content?: string;

    // For "tool_use"
    tool?: string;
    input?: Record<string, unknown>;

    // For "response"
    message?: {
        usage?: {
            input_tokens: number;
            output_tokens: number;
        };
    };

    // For "error"
    error?: string;
}
```

### 6.4 Phase 4: Process Registry (MEDIUM PRIORITY)

**Implement kill support:**

```typescript
// src/server/ws/chat.ts
const activeProcesses = new Map<string, Child>();

export async function executeClaudeCode(sessionId, prompt) {
    const proc = Bun.spawn(['claude', ...args], { stdout: 'pipe', stderr: 'pipe' });
    activeProcesses.set(sessionId, proc);

    // ... stream processing ...

    activeProcesses.delete(sessionId);
}

export async function cancelExecution(sessionId: string) {
    const proc = activeProcesses.get(sessionId);
    if (proc) {
        proc.kill();
        activeProcesses.delete(sessionId);
    }
}
```

### 6.5 Phase 5: Agent System (LOWER PRIORITY)

**PPM doesn't need full CRUD yet, but consider:**

- Store reusable system prompts in database
- Version agent configs
- Allow import/export of agent definitions
- Track agent execution metrics

---

## 7. Code Patterns Worth Adopting

### 7.1 Environment Detection

**File:** `src/lib/apiAdapter.ts`

```typescript
export function getEnvironmentInfo() {
    return {
        isTauri: !!(window as any).__TAURI__,
        isWeb: typeof window !== 'undefined',
        isNode: typeof process !== 'undefined' && process.versions?.node,
    };
}
```

**PPM Use:** Detect execution context for proper event handling.

### 7.2 Async Generator Pattern for Streaming

**From claude-code-cli.ts:**

```typescript
async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    const proc = Bun.spawn(['claude', ...], { stdout: 'pipe', stderr: 'pipe' });

    try {
        const reader = proc.stdout?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                const event = JSON.parse(line);
                yield mapCliEventToChatEvent(event);
            }
        }
    } catch (e) {
        yield { type: "error", message: String(e) };
    }
}
```

**PPM Use:** Clean streaming abstraction, works with both CLI and SDK.

### 7.3 Provider Pattern

**From src/providers/registry.ts:**

```typescript
interface AIProvider {
    createSession(config: SessionConfig): Promise<Session>;
    resumeSession(sessionId: string): Promise<Session>;
    sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent>;
    listSessions(): Promise<SessionInfo[]>;
    deleteSession(sessionId: string): Promise<void>;
}

class ProviderRegistry {
    get(id: string): AIProvider | undefined;
    list(): ProviderInfo[];
}

// Multiple implementations:
// - ClaudeCodeCliProvider (spawns CLI)
// - ClaudeAgentSdkProvider (uses SDK)
// - MockProvider (for testing)
```

**PPM Use:** Allow swapping providers without UI changes.

---

## 8. Lessons from Known Issues

### 8.1 Web Server Critical Issues (from web_server.design.md)

**Issue 1: Session-Scoped Events**

> "The UI expects session-specific events like `claude-output:${sessionId}` but the backend only dispatches generic events like `claude-output`. Impact: Session isolation doesn't work — all sessions receive all events."

**Lesson:** Always namespace state/events by logical grouping (sessionId, agentId, etc.)

**Issue 2: Process Management**

> "The cancel endpoint is just a stub that doesn't actually terminate running Claude processes."

**Lesson:** Don't mock critical functionality; implement fully or fail clearly.

**Issue 3: stderr Handling**

> "Claude processes can write errors to stderr, but the web server only captures stdout."

**Lesson:** Always capture both stdout + stderr; both contain actionable information.

---

## 9. File-by-File Reference

### Essential Files for PPM

| File | Lines | Purpose | Priority |
|------|-------|---------|----------|
| `claude_binary.rs` | 694 | Binary discovery algorithm | HIGH |
| `commands/claude.rs` | 2342 | Execution, streaming, cancellation | HIGH |
| `process/registry.rs` | ~200 | Process lifecycle tracking | MEDIUM |
| `web_server.design.md` | - | Known issues + architecture | HIGH (reference) |
| `src/providers/claude-code-cli.ts` | ~180 | CLI streaming implementation | MEDIUM |
| `src/providers/claude-agent-sdk.ts` | ~195 | SDK provider pattern | LOW |
| `cc_agents/*.opcode.json` | - | Agent config format | REFERENCE |

### Code Snippets Worth Copy-Pasting

1. **Binary discovery fallback loop** (lines 156-166 in claude_binary.rs)
2. **Stream-JSON line parser** (lines 1230-1280 in claude.rs)
3. **Session registration on init** (lines 1244-1260 in claude.rs)
4. **Async generator stream processing** (claude-code-cli.ts lines 108-150)

---

## 10. Unresolved Questions & Clarifications Needed

1. **Session Persistence:** Does opcode persist session history across restarts? (Appears to via JSONL files in ~/.claude/projects/)

2. **Checkpoint System:** What's the use case for checkpoints? (Allow branching/forking sessions to different states)

3. **Hooks Configuration:** What do agent hooks do? (JSON field exists but not documented in code)

4. **Cost Calculation:** Where does `cost` field in JSONL come from? (Not obvious from stream-json parsing)

5. **Model Fallback:** If user specifies "opus" but only "sonnet" CLI is available, what happens? (Likely CLI error)

6. **Web Server Status:** Is web_server.rs actively maintained? (design.md marked as having critical issues)

7. **CLAUDE.md Discovery:** How is CLAUDE.md path resolved in multi-root workspaces? (Searches recursively, stops at first found)

---

## 11. Summary & Next Steps

### Key Takeaways for PPM

1. **Adopt robust binary discovery** - 19-point chain beats simple `which`
2. **Use session-scoped events** - Prevents multi-session interference
3. **Parse stream-json line-by-line** - Cleaner than chunk accumulation
4. **Implement process registry** - Track/cancel/monitor executions
5. **Support both CLI & SDK** - Provider pattern allows flexibility
6. **Document known limitations** - opcode's web_server.design.md is honest about gaps

### Recommended Implementation Order

1. **Phase 1:** Adopt claude_binary.rs pattern
2. **Phase 2:** Implement session-scoped events for web mode
3. **Phase 3:** Full stream-json parsing
4. **Phase 4:** Process registry for termination
5. **Phase 5:** Agent system (lower urgency)

### Files to Reference During Implementation

- Copy binary discovery logic from `claude_binary.rs`
- Study `commands/claude.rs` for execution patterns
- Review `web_server.design.md` section 4 for event architecture
- Use `providers/claude-code-cli.ts` as streaming template

---

## Appendix: Quick Reference

**Stream-JSON Message Types:**
```
system → init message, session_id first
text → assistant response chunks
tool_use → tool invocation
response → final message with usage/cost
error → execution error
```

**Claude CLI Common Args:**
```bash
claude -p "prompt text" --model opus --output-format stream-json
claude -c -p "follow-up" --model opus --output-format stream-json
claude --resume <session_id> -p "continuation" --output-format stream-json
claude --cancel <session_id>  # Not available in recent versions
```

**Session File Locations:**
```
~/.claude/projects/{encoded_path}/{session_id}.jsonl
~/.claude/sessions/  # Deprecated?
~/.claude/CLAUDE.md
~/.claude/settings.json
```

**Database Schema (agents.db):**
```sql
agents (id, name, icon, system_prompt, default_task, model,
        enable_file_read, enable_file_write, enable_network, hooks, created_at, updated_at)
agent_runs (id, agent_id, task, model, project_path, session_id, status, pid, ...)
app_settings (key, value, created_at, updated_at)
```
