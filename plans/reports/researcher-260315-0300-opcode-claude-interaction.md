# Research Report: Opcode - Claude Code GUI Integration

**Date:** 2026-03-15
**Status:** Complete
**Scope:** Architecture analysis, Claude integration patterns, API design, agent system

---

## Executive Summary

**Opcode** is a sophisticated desktop GUI application that wraps and extends the Claude Code CLI with project management, agent automation, session tracking, and usage analytics. It does NOT integrate with Anthropic's Claude API directly; instead, it acts as a sophisticated launcher and monitor for the Claude Code CLI tool.

**Key finding:** Opcode's primary interaction model is process spawning—it discovers the Claude binary on the user's system, spawns child processes with specific flags, captures streaming JSON output, and relays it to the user via WebSocket or Tauri IPC. This architecture enables both desktop (Tauri) and web deployments.

---

## 1. What is Opcode?

### Project Identity
- **Description:** "A powerful GUI app and Toolkit for Claude Code"
- **Type:** Cross-platform desktop application + optional web server
- **Author:** Independent developer (not affiliated with Anthropic)
- **Licensing:** MIT (implied from code structure)

### Core Purpose
Opcode bridges the CLI-first design of Claude Code with a visual, project-centric interface by:
1. Discovering and managing Claude Code CLI installations on the user's system
2. Wrapping Claude execution in a session/project tracking framework
3. Providing autonomous agents with customizable behavior
4. Tracking API usage, costs, and performance metrics
5. Managing MCP (Model Context Protocol) servers for extended capabilities
6. Implementing checkpoint/timeline system for session versioning

### User Workflows Enabled
- **Interactive Development:** Browse projects, create/resume sessions, execute prompts with real-time output streaming
- **Agent Automation:** Define custom agents with system prompts, run them unattended with background process isolation
- **Analytics & Auditing:** Track token usage, costs, and performance across models and projects
- **Session Management:** Checkpoint current state, fork sessions, view diffs, time-travel within session history

---

## 2. Claude Code Integration Mechanism

### Binary Discovery Strategy

Opcode implements multi-layered binary discovery (not API-based):

**Discovery methods (in priority order):**
1. Check SQLite database (`agents.db`) for cached path with validity verification
2. Use system commands (`which` on Unix, `where` on Windows) to find in PATH
3. Scan Node Version Manager (NVM) installations and active environment
4. Check standard installation paths:
   - `/usr/local/bin`
   - Homebrew directories (`/opt/homebrew/bin`, etc.)
   - User-specific locations (`~/.local/bin`, `~/.cargo/bin`)

**Selection logic:** Prioritizes installations with semantic version information, prefers newer versions, and validates runtime paths.

### Process Spawning Architecture

When executing Claude, opcode constructs commands like:

```bash
claude -p "your prompt here" \
  --model claude-3-5-sonnet \
  --output-format stream-json \
  --dangerously-skip-permissions \
  [--system-prompt "agent instructions"] \
  [--resume session-id | -c]
```

**Key flags:**
- `-p` — Prompt/task input
- `--model` — Model selection (opus/sonnet/haiku)
- `--system-prompt` — Custom agent instructions
- `--output-format stream-json` — Newline-delimited JSON for structured output
- `--dangerously-skip-permissions` — Bypass safety checks (for trusted agents)
- `-c` — Continue existing session
- `--resume SESSION_ID` — Restore previous session

### Output Handling

**Async streaming pipeline:**
1. **Stdout capture:** Uses `tokio::io::BufReader` to read lines from Claude process
2. **JSON parsing:** Each line is newline-delimited JSON with format:
   ```json
   {"type": "system", "subtype": "init", "session_id": "..."}
   {"type": "message", "content": "..."}
   {"type": "system", "subtype": "done"}
   ```
3. **Session ID extraction:** Reads `session_id` from initial system message
4. **Live broadcast:** Emits via Tauri events (desktop) or WebSocket (web):
   - Desktop: `"claude-output:{session_id}"` event
   - Web: Sends JSON over persistent WebSocket connection
5. **Persistence:** Stores full output in JSONL files at `~/.claude/projects/{project_id}/{session_id}.jsonl`

### Environment Setup

Opcode explicitly manages environment variables to ensure Claude can find dependencies:

```rust
// Inherited: PATH, HOME, NODE_PATH, https_proxy, http_proxy
// Added conditionally:
// - NVM_BIN directories (if Claude from NVM)
// - Homebrew bin directories (if Claude from Homebrew)
```

This prevents "node not found" errors when Claude is installed via package managers.

---

## 3. Claude Code Communication Protocols

### Primary Protocol: Command-Line Interface (CLI)

Opcode does NOT use:
- REST/HTTP API to Claude
- WebSocket to Claude service
- gRPC or protobuf
- Any Anthropic SDK

Instead, it uses **local process invocation** via spawn() with structured argument passing.

### Tauri IPC (Frontend-Backend)

Frontend communicates with Rust backend via Tauri's invoke system:

```typescript
// Frontend (TypeScript)
await invoke<SessionResult>("continue_claude_code", {
  project_path: "/path/to/project",
  prompt: "user prompt",
  model: "claude-3-5-sonnet"
})

// Emitted events back to frontend:
listen("claude-output:session-123", (event) => {
  console.log(event.payload) // JSON line from Claude
})
```

### Web Server Alternative

Opcode includes an optional Axum-based HTTP server (for web deployment):

```
POST /ws/claude
{
  "project": "/path/to/project",
  "prompt": "your prompt",
  "model": "sonnet",
  "command": "execute" | "continue" | "resume"
}
```

**WebSocket flow:**
- Client sends JSON request → WebSocket upgrade
- Backend spawns Claude process
- Each stdout line → sent as JSON message on WS
- Process terminates → WS closes

**Note:** Web mode deliberately disables direct Claude execution (`POST /api/sessions/execute` returns error "Claude execution is not available in web mode"). The web server is primarily for reading session history, not execution.

### Data Format: Stream-JSON

Claude output format: **newline-delimited JSON (JSONL)**

```json
{"type":"system","subtype":"init","session_id":"abc123","model":"claude-3-5-sonnet"}
{"type":"message","content":"I'll help with that.","role":"assistant"}
{"type":"tool_call","tool":"bash","input":{"command":"ls -la"}}
{"type":"tool_result","tool":"bash","output":"total 42\n..."}
{"type":"system","subtype":"done","total_tokens":1234,"cost_usd":0.045}
```

---

## 4. Architecture & Key Components

### High-Level Diagram

```
┌──────────────────────────────────────┐
│  Frontend (React 18 + TypeScript)    │
│  - Tab manager                       │
│  - Project browser                   │
│  - Agent UI                          │
│  - Settings, usage dashboard         │
└─────────────┬────────────────────────┘
              │ Tauri invoke / WebSocket
┌─────────────▼────────────────────────┐
│  Backend (Rust + Tauri 2)            │
│  ┌──────────────────────────────────┐│
│  │ Commands Layer                   ││
│  │ ├─ claude.rs (82KB)              ││
│  │ ├─ agents.rs (70KB)              ││
│  │ ├─ mcp.rs                        ││
│  │ ├─ storage.rs / usage.rs         ││
│  │ └─ checkpoint.rs                 ││
│  └──────────────────────────────────┘│
│  ┌──────────────────────────────────┐│
│  │ Process Management               ││
│  │ ├─ registry.rs (process tracking)││
│  │ ├─ binary discovery              ││
│  │ └─ environment setup             ││
│  └──────────────────────────────────┘│
│  ┌──────────────────────────────────┐│
│  │ Data Layer                       ││
│  │ ├─ SQLite (agents.db)            ││
│  │ ├─ JSONL files (session history) ││
│  │ └─ Local filesystem              ││
│  └──────────────────────────────────┘│
└─────────────┬────────────────────────┘
              │ Process spawn / stdio
┌─────────────▼──────────────────────┐
│  Claude Code CLI (~/.claude/...)    │
│  - Session management               │
│  - Tool execution (bash, file ops)  │
│  - API calls to Claude model        │
└──────────────────────────────────────┘
```

### Core Modules

#### A. Frontend (TypeScript/React)

**Key services (src/lib/):**
- `api.ts` (53KB) — Comprehensive API abstraction wrapping all Tauri commands
- `apiAdapter.ts` (16KB) — Adapter pattern for API calls with error handling
- `sessionPersistence.ts` — Tab/session state management
- `tabPersistence.ts` — UI state persistence

**Components:**
- Project browser
- Session/chat tabs with streaming output
- Agent definition UI
- Usage analytics dashboard
- MCP server manager
- CLAUDE.md editor with markdown preview

**State management:**
- React Context for theme, output caching, tab state
- Tauri event listeners for background process updates

#### B. Backend (Rust/Tauri)

**Command handlers (src-tauri/src/commands/):**
1. **claude.rs** (82KB) — Core Claude execution
   - `execute_claude_code()` — New session
   - `continue_claude_code()` — Extend conversation
   - `resume_claude_code()` — Restore by ID
   - Process spawning and output streaming

2. **agents.rs** (70KB) — Agent system
   - Agent CRUD operations
   - Background execution with process isolation
   - Execution history and metrics calculation
   - GitHub integration for agent discovery

3. **mcp.rs** (25KB) — Model Context Protocol
   - Server configuration (stdio/SSE transport)
   - Scope management (local/project/user)
   - Import from Claude Desktop config

4. **checkpoint.rs** — Session versioning
   - Create snapshots of project state
   - Timeline navigation
   - Diff generation between checkpoints
   - Fork existing sessions

5. **storage.rs** (17KB) — Direct SQLite access
   - CRUD on arbitrary tables
   - Pagination and search
   - Raw SQL execution

6. **usage.rs** (25KB) — Analytics
   - Token counting across sessions
   - Cost calculation by model
   - Trend analysis and visualization

**Process management (src-tauri/src/process/):**
- **registry.rs** (18KB) — Process lifecycle tracking
  - Register agent runs and Claude sessions
  - Track process IDs, exit codes
  - Graceful termination (SIGTERM → SIGKILL)
  - Live output buffering
  - Cleanup of finished processes

- **claude_binary.rs** (24KB) — Binary discovery
  - Multi-strategy location algorithm
  - Version comparison and selection
  - Environment variable setup
  - NVM and Homebrew integration

#### C. Data Layer

**SQLite (agents.db):**
- Agent definitions and configurations
- Execution runs with status/timestamps
- Process metadata and output
- Cached Claude binary paths
- User preferences

**JSONL session history:**
- Location: `~/.claude/projects/{project_id}/{session_id}.jsonl`
- One JSON object per line
- Contains full chat history with tool calls/results
- Used for analytics and session restoration

**Local filesystem:**
- Project directories (`~/.claude/projects/`)
- Agent configuration files (`.opcode.json`)
- Checkpoint data

### Request Flow: Executing a Prompt

```
1. User enters prompt in UI
2. Frontend calls: invoke("execute_claude_code", {project, prompt, model})
3. Backend:
   a) Discovers Claude binary
   b) Sets up environment variables
   c) Spawns child process: `claude -p "prompt" --model sonnet --output-format stream-json`
   d) Starts async task reading stdout
4. Claude process:
   a) Generates session ID
   b) Sends system init message (JSON)
   c) Processes prompt, calls tools as needed
   d) Sends message chunks, tool calls, results (JSON lines)
   e) Exits with final summary
5. Backend:
   a) Each output line → parsed as JSON
   b) Emitted via Tauri event: "claude-output:{session_id}"
   c) Saved to JSONL file
   d) Stored in ProcessRegistry for UI querying
6. Frontend:
   a) Listens for events
   b) Renders streaming output in real-time
   c) On completion, stores session metadata in SQLite
```

---

## 5. Agent System Architecture

### Agent Configuration Format

Agents are defined as `.opcode.json` files with this structure:

```json
{
  "version": 1,
  "exported_at": "2025-01-23T14:29:58.156063+00:00",
  "agent": {
    "name": "Security Scanner",
    "icon": "shield",
    "model": "opus",
    "system_prompt": "You are a security specialist...",
    "default_task": "Review the codebase for security issues."
  }
}
```

**Supported icons:** bot, shield, code, terminal, database, globe, file-text, git-branch

### Agent Execution Model

Agents run as **isolated background processes**, not within the main Claude session:

```rust
// Backend spawns:
claude --system-prompt "agent instructions" \
       -p "task" \
       --model opus \
       --output-format stream-json \
       --dangerously-skip-permissions

// Frontend polls for status:
polling: get_agent_run_status(run_id)
          → AgentRun { status: "running"/"completed", output: [...] }
```

**Process isolation benefits:**
- Agents don't block the main UI
- Crash in one agent doesn't affect others
- Can run multiple agents in parallel
- Resources (CPU/memory) scoped per agent

### Multi-Agent Orchestration Example

**Security Scanner Agent** demonstrates parent-child architecture:

```
Parent: Security Scanner
├─ Child 1: Codebase Intelligence Analyzer
│   (extracts tech stack, auth, storage)
├─ Child 2: Threat Modeling Specialist
│   (maps assets, STRIDE analysis)
├─ Child 3: Vulnerability Scanner
│   (OWASP Top 10, CWE classification)
├─ Child 4: Exploit Developer
│   (POC demonstrations)
├─ Child 5: Security Architect
│   (remediation strategies)
└─ Child 6: Security Report Writer
    (produce professional assessment)
```

Each child agent is spawned as a separate process with focused instructions, enabling specialized analysis and parallel execution.

### Pre-built Agents

**Git Commit Bot** (Sonnet)
- Analyzes staged changes
- Generates Conventional Commits
- Auto-resolves merge conflicts
- Pushes to remote

**Security Scanner** (Opus)
- 6-phase orchestration
- OWASP/CWE framework
- CVSS scoring
- PoC exploitation verification

**Unit Tests Bot** (Opus)
- Test generation
- Coverage optimization
- Quality validation

### Agent Discovery & Import

Agents can be:
- Defined in the UI and exported as `.opcode.json`
- Imported from GitHub (via GitHub API)
- Imported from local filesystem
- Shared via pull requests to opcode repo

---

## 6. Technology Stack

### Frontend
- **Framework:** React 18.3.1
- **Language:** TypeScript
- **Build:** Vite 6
- **UI Components:** Radix UI + shadcn/ui
- **Styling:** Tailwind CSS 3
- **Animations:** Framer Motion
- **Markdown:** React Markdown with syntax highlighting
- **Forms:** React Hook Form
- **Validation:** Zod
- **Data visualization:** Recharts
- **Analytics:** PostHog
- **Desktop bridge:** Tauri API + plugins (dialog, shell, global-shortcut, opener, filesystem)

### Backend (Rust)
- **Desktop framework:** Tauri 2
- **Web framework:** Axum 0.8 (optional)
- **Async runtime:** Tokio 1.0
- **HTTP client:** Reqwest 0.12
- **WebSocket:** Tower, Axum upgrades
- **Database:** Rusqlite 0.32 (SQLite)
- **Serialization:** Serde + Serde JSON + Serde YAML
- **Crypto:** SHA2
- **Utilities:** Chrono, UUID, Base64, Regex, Walkdir
- **System:** Clap (CLI), Dirs (platform paths), Which (binary location)

### Deployment Platforms
- macOS (10.15+), Linux (AppImage/deb/rpm), Windows (.exe/.msi)
- Cross-platform via Tauri

---

## 7. Integration Patterns for Third-Party Projects

### Option A: Consume Opcode's Web API

If building a tool that needs to integrate with opcode:

```bash
# Start opcode web server (if available)
./opcode --web-server --port 3000

# Call REST endpoints
POST http://localhost:3000/api/projects
POST http://localhost:3000/ws/claude
GET http://localhost:3000/api/usage/stats
```

**Limitations:** Web mode does NOT support Claude execution, only read-only operations.

### Option B: Spawn Claude Directly

Don't depend on opcode; spawn Claude CLI yourself:

```typescript
import { spawn } from "child_process";

const process = spawn("claude", [
  "-p", "your prompt",
  "--model", "claude-3-5-sonnet",
  "--output-format", "stream-json"
]);

process.stdout.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  lines.forEach(line => {
    if (line) console.log(JSON.parse(line));
  });
});
```

**Advantages:** Direct control, no opcode dependency

### Option C: Use Opcode as a Library

Opcode is not published as an npm package, but:
1. Fork and embed its command layer
2. Use Tauri's codebase as reference for process management
3. Adapt the API abstraction layer for your needs

### Option D: Create Custom Agents

Define agents in `.opcode.json` format and distribute:

```json
{
  "version": 1,
  "agent": {
    "name": "Custom Analyzer",
    "icon": "bot",
    "model": "sonnet",
    "system_prompt": "You are a specialized analyzer...",
    "default_task": "Analyze and report."
  }
}
```

Users can import via Opcode UI → Agents → Import from file.

---

## 8. Key Design Decisions & Implications

### 1. Process Spawning vs. API Integration

**Decision:** Spawn Claude CLI as child processes instead of calling Anthropic API.

**Rationale:**
- Claude Code CLI handles authentication (via `.claude/config` or `ANTHROPIC_API_KEY`)
- Leverages Claude's full tool ecosystem (bash, file operations, git)
- Sessions persist across CLI invocations (opcode doesn't manage API tokens)
- Runs locally; opcode is offline-capable

**Trade-off:** Opcode depends on Claude Code CLI installation; cannot run without it.

### 2. SQLite for Metadata Only

**Decision:** Use SQLite for agents, runs, settings; session history in JSONL files.

**Rationale:**
- SQLite fast for structured queries (agent lookups, run status)
- JSONL preserves full streaming output without schema migrations
- Session history stays compatible with Claude's own JSONL format

**Trade-off:** No relational guarantees between SQLite and JSONL; must keep in sync.

### 3. Tauri Desktop + Optional Web Server

**Decision:** Primary deployment is Tauri desktop app; optional Axum server for web/headless.

**Rationale:**
- Tauri provides native OS integration (file dialogs, clipboard, global shortcuts)
- Web server useful for teams/CI environments
- Single codebase serves both contexts

**Trade-off:** Web mode is read-only by design (Claude execution restricted to desktop).

### 4. Agent Isolation via Separate Processes

**Decision:** Each agent runs in a dedicated background process, not within parent agent's stdio.

**Rationale:**
- Prevents cascading failures
- Enables parallel execution
- Clear resource boundaries

**Trade-off:** Complex orchestration; parent agents must parse child output via JSONL.

### 5. No Direct Claude API Dependency

**Decision:** Never import Anthropic's Claude SDK or REST client.

**Rationale:**
- Avoids token/authentication management
- Reduces dependency surface
- Leverages Claude Code's environment setup

**Trade-off:** Cannot access Claude API directly; must use CLI as proxy.

---

## 9. Security Considerations

### Permission Model
- `--dangerously-skip-permissions` flag opts OUT of Claude's safety checks (for trusted agents only)
- Agents run in user context with full filesystem access
- MCP server scope (local/project/user) controls capability visibility

### Process Isolation
- Each agent runs as separate OS process
- Can be killed independently
- Signals handled gracefully (SIGTERM → SIGKILL escalation)

### Data Storage
- Session history stored locally in `~/.claude/projects/`
- SQLite database in `~/.claude/`
- No data sent to opcode servers (open source, local-first design)

### Supply Chain
- Dependencies pinned in Cargo.lock and package-lock.json
- No auto-updates to Claude CLI; users manage manually
- Opcode checks for binary validity before execution

---

## 10. How PPM Can Integrate with Opcode

### Scenario 1: Use Opcode as Session Manager

If PPM wants to delegate session/project management to opcode:

```typescript
// PPM calls opcode's REST API (if web server enabled)
const sessions = await fetch("http://localhost:3000/api/projects/myproject/sessions");
const result = await fetch("http://localhost:3000/ws/claude", {
  method: "POST",
  body: JSON.stringify({
    project: "/path/to/project",
    prompt: "Generate tests",
    model: "sonnet",
    command: "execute"
  })
});
```

**Benefits:** Opcode handles binary discovery, output streaming, JSONL persistence.
**Drawbacks:** Web mode read-only; requires running opcode service.

### Scenario 2: Adopt Opcode's Agent Format

If PPM wants to support agent definitions:

```json
{
  "version": 1,
  "agent": {
    "name": "PPM Code Reviewer",
    "icon": "code",
    "model": "opus",
    "system_prompt": "Review code quality for the PPM project...",
    "default_task": "Review the pull request."
  }
}
```

Export/import via `.opcode.json`; integrate with PPM's CI/CD.

### Scenario 3: Reference Opcode's Architecture

If PPM wants to build its own Claude integration (not depending on opcode):

**Key patterns to adopt:**
1. Multi-strategy binary discovery (PATH → NVM → Homebrew → standard paths)
2. Stream-JSON output format with async parsing
3. Process registry for background execution tracking
4. SQLite for agent metadata, JSONL for session history
5. Tauri for desktop, optional Axum server for web
6. Environment variable setup for Node.js dependencies

### Scenario 4: Create PPM-Specific Agents

Define agents that know PPM's codebase structure:

```json
{
  "version": 1,
  "agent": {
    "name": "PPM Debugger",
    "icon": "terminal",
    "model": "opus",
    "system_prompt": "You are debugging the PPM project. PPM is a Git UI tool written in TypeScript/React with Tauri backend...",
    "default_task": "Debug the failing test case and propose fixes."
  }
}
```

Then opcode (or PPM's own agent runner) executes this agent on PPM's codebase.

---

## 11. Unresolved Questions / Gaps

1. **Hot-reload for agents:** How does opcode reload agent definitions if edited in UI while execution is running?

2. **Streaming cancellation:** Can users cancel a running Claude process mid-execution? How is SIGTERM handled if stdout is mid-JSON line?

3. **Multi-session conflicts:** If two agents modify the same project file simultaneously, how does opcode handle file locks or conflict detection?

4. **Web server authentication:** The optional Axum web server—does it support authentication (Basic, JWT, OAuth)? Or is it intended for trusted local networks only?

5. **MCP server protocol:** How does opcode's MCP integration differ from Claude Code's native MCP support? Does it proxy or extend?

6. **Checkpoint diff algorithm:** How are diffs generated between checkpoint states? Are they line-based, AST-based, or semantic-aware?

7. **Cost calculation accuracy:** How does opcode infer token counts from JSONL output? Does it parse `total_tokens` field from Claude response, or does it estimate?

8. **Agent versioning:** Can agents be versioned? If an agent's system_prompt changes, does opcode track history or warn about breaking changes?

9. **Process timeout:** What happens if a Claude process hangs or never returns? Is there a configurable timeout mechanism?

10. **Parallel execution limits:** When running multiple agents in parallel, is there a cap on concurrent processes? How are resources managed?

---

## Summary

**Opcode is a sophisticated desktop UI + optional web server wrapper around Claude Code CLI.** It excels at:

- **Project-centric session management** — browse, organize, and resume coding sessions
- **Agent automation** — define reusable agents with custom instructions, run in isolation
- **Usage analytics** — track tokens, costs, and performance trends
- **Session checkpointing** — snapshot and restore project state

**Integration approach:** Opcode abstracts Claude via process spawning, not API calls. For PPM, the most relevant patterns are:
1. Binary discovery and environment setup (adopt for robustness)
2. Stream-JSON output parsing (compatible format)
3. Process registry design (for background task tracking)
4. Agent configuration format (standardized, shareable)

PPM can either integrate with opcode as a service, adopt its architecture patterns, or remain independent while consuming its standardized agent format.

---

**End Report**
