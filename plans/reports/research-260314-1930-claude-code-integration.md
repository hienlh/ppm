# Research Report: Claude Code CLI Integration Patterns

**Date:** 2026-03-14
**Sources:** 3 primary (vibe-kanban, claude-code-chat, Agent SDK docs) + 2 supplementary (sessions, user-input docs)

---

## Executive Summary

3 approaches exist for integrating Claude Code into a custom UI. After analyzing all sources, **Claude Agent SDK (TypeScript)** is the clear winner for PPM — it provides programmatic session management, streaming, tool approvals, and is the officially supported path. claude-code-chat validates the CLI subprocess approach works but Agent SDK is superior in every way.

---

## Source Analysis

### 1. BloopAI/vibe-kanban

**Architecture:** Rust backend + React frontend. Full IDE-like tool for managing coding agents.
- Supports Claude Code, Codex, Gemini CLI, GitHub Copilot, Amp, etc.
- Runs agents in isolated workspaces (git worktrees) with terminal + dev server per workspace
- Backend: Rust (49.4%), Frontend: TypeScript/React (46.7%)
- Requires PostgreSQL

**Integration approach:** Agent-agnostic — treats all AI tools as terminal processes in workspaces. Does NOT deeply integrate with Claude Code internals, just provides terminal environments.

**Key takeaway for PPM:** Overkill for our needs. Uses Rust + PostgreSQL which adds complexity. But the "workspace = branch + terminal + dev server" concept is interesting.

### 2. andrepimenta/claude-code-chat

**Architecture:** VSCode extension wrapping Claude Code CLI as subprocess.

**Integration method: CLI Subprocess via stdin/stdout**
- Spawns `claude` CLI process
- Captures streaming stdout for real-time response display
- Sends user messages via stdin
- WSL path support for CLI binary (`/usr/local/bin/claude`)

**Session management:**
- Automatic conversation saving/restoration (file-based)
- Resume conversations where left off
- Workspace-scoped sessions

**Tool approvals — sophisticated permission system:**
- Interactive dialog showing tool info + command previews
- Smart pattern matching (npm, git, docker auto-approved)
- "Always Allow" functionality
- "YOLO Mode" — skip all permission checks
- Workspace-level granular permissions

**Streaming:** Real-time streaming responses with typing indicators, parsing CLI stdout.

**Key takeaway for PPM:** Validates CLI wrapping works well for chat UI. But this is VSCode-specific. For a web app, Agent SDK is better since it gives programmatic control without parsing CLI output.

### 3. Claude Agent SDK (Official) — **RECOMMENDED**

**Architecture:** Library that gives same capabilities as Claude Code CLI, programmable in TypeScript and Python.

**Package:** `@anthropic-ai/claude-agent-sdk` (TypeScript) / `claude-agent-sdk` (Python)

**Core API — `query()` function:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

**Built-in tools (same as Claude Code CLI):**
| Tool | What it does |
|------|-------------|
| Read | Read files |
| Write | Create files |
| Edit | Precise edits |
| Bash | Terminal commands |
| Glob | Find files by pattern |
| Grep | Search file contents |
| WebSearch | Search web |
| WebFetch | Fetch web pages |
| AskUserQuestion | Ask user clarifying questions |
| Agent | Spawn subagents |

**Session Management — EXCELLENT:**
```typescript
// Create session — capture ID from init message
let sessionId: string;
for await (const message of query({
  prompt: "Analyze auth module",
  options: { allowedTools: ["Read", "Glob"] }
})) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
  }
}

// Resume session with full context
for await (const message of query({
  prompt: "Now find all places that call it",
  options: { resume: sessionId }
})) {
  // Has full context from first query
}

// Fork session to explore alternative
for await (const message of query({
  prompt: "Try OAuth2 instead",
  options: { resume: sessionId, forkSession: true }
})) {
  // New session branched from original
}

// Continue most recent session (no ID needed)
for await (const message of query({
  prompt: "Continue with previous task",
  options: { continue: true }
})) {}

// List all sessions
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
const sessions = await listSessions();
const messages = await getSessionMessages(sessionId);
```

**Session storage:** `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`

**Tool Approvals — Full Control:**
```typescript
for await (const message of query({
  prompt: "Refactor this code",
  options: {
    canUseTool: async (toolName, input) => {
      if (toolName === "AskUserQuestion") {
        // Handle clarifying questions from Claude
        return handleQuestions(input);
      }
      // Show approval UI to user
      const approved = await showApprovalDialog(toolName, input);
      if (approved) {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "User declined" };
    }
  }
})) {}
```

**Permission modes:** `allowedTools` pre-approves safe tools, `canUseTool` callback for interactive approval.

**Streaming:** Native async iterator — each `message` yields as it arrives. Message types:
- `system` (init with session_id)
- `assistant` (text blocks, tool calls)
- `tool` (tool results)
- `result` (final result with cost info)

**Hooks:** PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd — same as Claude Code CLI.

**MCP Support:** Connect external MCP servers:
```typescript
options: {
  mcpServers: {
    playwright: { command: "npx", args: ["@playwright/mcp@latest"] }
  }
}
```

**Subagents:** Spawn specialized agents from main agent.

**Claude Code features supported:** Skills, slash commands, CLAUDE.md memory, plugins.

---

## Comparative Analysis

| Feature | CLI Subprocess | Agent SDK |
|---|---|---|
| Setup complexity | Low (just spawn process) | Low (npm install) |
| Streaming | Parse stdout (fragile) | Native async iterator (robust) |
| Session CRUD | Parse filesystem | `listSessions()`, `getSessionMessages()`, `resume`, `fork` |
| Tool approvals | Parse CLI prompts (very fragile) | `canUseTool` callback (clean API) |
| Multi-session | Multiple processes (heavy) | Multiple `query()` calls (lightweight) |
| Error handling | Process exit codes | Structured error messages |
| MCP support | Via CLI config | Programmatic |
| Hooks | Via CLI config files | Programmatic callbacks |
| Authentication | CLI handles it | API key in env var |
| Maintenance | Breaks on CLI output format changes | Stable SDK contract |

**Winner: Agent SDK** — vastly superior for building a web app.

---

## Implementation Architecture for PPM

```
┌─────────────────────────────────────────────┐
│            React Frontend (Browser)          │
│                                              │
│  Chat Tab ←→ WebSocket ←→ Go Backend        │
│  - Message list (streaming)                  │
│  - Tool approval dialogs                     │
│  - AskUserQuestion UI                        │
│  - Session picker (list/resume/fork)         │
└─────────────────────────────────────────────┘
         ↕ WebSocket (bidirectional)
┌─────────────────────────────────────────────┐
│              Go Backend Server               │
│                                              │
│  Session Manager                             │
│  ├─ Map<sessionId, AgentSDKProcess>          │
│  ├─ Create: spawn node process with SDK      │
│  ├─ Resume: pass sessionId to SDK            │
│  ├─ Fork: pass sessionId + forkSession       │
│  ├─ List: call listSessions()                │
│  └─ Delete: remove session file              │
│                                              │
│  Agent SDK Bridge (Node.js sidecar)          │
│  ├─ Runs @anthropic-ai/claude-agent-sdk      │
│  ├─ Communicates with Go via stdio/WebSocket │
│  ├─ Handles query() streaming                │
│  └─ Forwards canUseTool to frontend          │
└─────────────────────────────────────────────┘
```

**Key architectural decision:** Since Agent SDK is TypeScript/Python, the Go backend needs a Node.js sidecar process to run the SDK. Communication: Go ↔ Node.js via stdio (JSON lines) or local WebSocket.

**Alternative:** Write backend in Node.js instead of Go to avoid sidecar. Trade-off: lose single binary deployment but gain simpler architecture.

---

## Recommended Approach

### Option A: Go + Node.js Sidecar (Recommended if keeping Go)
- Go handles HTTP/WS server, file ops, git ops, terminal PTY
- Node.js sidecar runs Agent SDK, communicates via JSON-over-stdio
- Go spawns/manages sidecar processes (one per active session)

### Option B: Full Node.js Backend (Simpler)
- Single runtime for everything
- Agent SDK runs directly in backend
- Use `pkg` or `bun compile` for single binary
- Lose Go's PTY management elegance, but `node-pty` works fine

### Option C: Hybrid — Go binary embeds Node.js runtime
- Complex but achievable with embedded V8 or Bun
- Not recommended for solo dev

**Recommendation:** Start with **Option A** (Go + sidecar). The Go binary handles everything except AI chat. The sidecar is only spawned when user opens a chat tab. If sidecar management becomes painful, migrate to Option B later.

---

## Key Code Patterns for PPM

### 1. Session List API
```typescript
// Node.js sidecar endpoint
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
const sessions = await listSessions(); // Returns session metadata
```

### 2. Streaming Chat via WebSocket
```typescript
// Sidecar: stream messages to Go backend
for await (const message of query({ prompt, options: { resume: sessionId } })) {
  process.stdout.write(JSON.stringify(message) + '\n'); // JSON lines to Go
}
```

### 3. Tool Approval Flow
```
User sends prompt → Go → Sidecar starts query()
Claude wants to use Bash → canUseTool fires
Sidecar → Go → WebSocket → Frontend shows approval dialog
User clicks Allow → Frontend → WebSocket → Go → Sidecar returns allow
Claude executes tool → continues
```

### 4. Multi-tab Chat
- Each chat tab = one session ID
- Frontend tracks `Map<tabId, sessionId>`
- Opening new chat tab = new `query()` call, captures new sessionId
- Switching tabs = just UI state, sessions persist on disk
- Resuming tab = `query({ options: { resume: savedSessionId } })`

---

## Remaining Questions

1. **Agent SDK + Go sidecar performance:** Spawning Node.js per session = memory overhead. Need to benchmark. Could pool sidecar processes.
2. **Agent SDK auth on VPS:** API key needed. How to securely store/inject on VPS deployment?
3. **V2 TypeScript SDK:** Preview available with `createSession()` pattern — more natural for multi-session. Worth tracking but unstable.
4. **Offline/PWA:** Agent SDK requires network. PWA caching useful for UI shell only, chat always needs connectivity.
