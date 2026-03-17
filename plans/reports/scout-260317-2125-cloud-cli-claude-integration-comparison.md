# Cloud-CLI & PPM: Claude Code Integration Comparison Report

**Scout**: cloud-cli vs ppm Claude integration analysis  
**Date**: 2026-03-17  
**Context**: Understanding how each project interacts with Claude Code and @anthropic-ai/claude-agent-sdk

---

## Executive Summary

Cloud-CLI (formerly claude-code-ui) and PPM both depend on `@anthropic-ai/claude-agent-sdk`, but their architectures differ significantly:

- **Cloud-CLI**: Web UI layer for Claude Code CLI (acts as a remote UI/wrapper)
- **PPM**: Standalone project manager with embedded Claude integration (acts as primary IDE/app)

Cloud-CLI is a **wrapper/proxy** that surfaces Claude Code's existing sessions and configuration. PPM is a **direct SDK consumer** building its own session management from scratch.

---

## Architecture Overview

### Cloud-CLI (Web UI for Claude Code)
- **npm package**: `@siteboon/claude-code-ui` (published)
- **Stack**: React + Vite + Tailwind, Express backend, SQLite, WebSocket
- **Purpose**: Remote web UI for Claude Code CLI sessions
- **Version**: 1.25.2
- **Key files**: 
  - `server/claude-sdk.js` (SDK integration, 844 lines)
  - `server/routes/mcp.js` (MCP server management via Claude CLI)
  - `server/routes/commands.js` (Custom commands support)
  - `server/routes/settings.js` (User settings)
  - Multiple AI provider integrations (Claude, Cursor, Codex, Gemini)

### PPM (Project Manager with Built-in AI)
- **npm package**: `@hienle/ppm` (private/internal)
- **Stack**: Bun (runtime), Hono (HTTP) + Bun WebSocket, React + Vite, TypeScript
- **Purpose**: Integrated project manager with AI chat as first-class feature
- **Key files**:
  - `src/providers/claude-agent-sdk.ts` (SDK integration, ~500 lines)
  - `src/server/ws/chat.ts` (WebSocket chat handler)
  - `src/web/hooks/use-chat.ts` (Frontend chat state)
  - `src/services/config.service.ts` (Config management)

---

## Key Differences

### 1. SDK Integration Approach

#### Cloud-CLI: High-Level Integration
- Uses SDK as **query wrapper** with detailed options mapping
- Maps CLI-style options to SDK format (`mapCliOptionsToSDK()`)
- Supports multiple permission modes: `'default'`, `'bypassPermissions'`, `'acceptEdits'`, `'auto_edit'`, `'plan'`, `'yolo'`
- Loads MCP servers from `~/.claude.json` (home directory global config)
- Processes CLI options through a transformation layer
- Handles tool approval UI with timeout management (default 55s, configurable)
- Supports image uploads (base64 → temp files)
- Token budget tracking from model usage data

**Key code location**: `server/claude-sdk.js:mapCliOptionsToSDK()` (lines 144-214)

#### PPM: Direct SDK Consumer
- Uses SDK for **session management** and **chat streaming**
- Implements own session persistence mapping: `~/.ppm/session-map.json`
- Minimal options transformation (just core features)
- Focuses on session lifecycle (create, resume, list, delete)
- Simpler permission model (approve/deny)
- Token budget tracked separately
- No image upload support (yet)

**Key code location**: `src/providers/claude-agent-sdk.ts:ClaudeAgentSdkProvider`

### 2. CLAUDE.md Handling

#### Cloud-CLI
- **Reads CLAUDE.md** to set project instructions
- SDK option: `systemPrompt: { type: 'preset', preset: 'claude_code' }`
- Loads from 3 sources: `settingSources: ['project', 'user', 'local']`
- Opens CLAUDE.md via `/memory` command (built-in command handler)
- Exposes CLAUDE.md path to frontend for editing
- Auto-discovers from `~/.claude` projects directory

**Related code**:
```javascript
// server/claude-sdk.js:201-206
sdkOptions.systemPrompt = {
  type: 'preset',
  preset: 'claude_code'  // Required to use CLAUDE.md
};
sdkOptions.settingSources = ['project', 'user', 'local'];
```

#### PPM
- **Does not explicitly reference CLAUDE.md** in SDK config
- Focuses on direct config file reading (`~/.ppm/config.yaml`)
- Uses config service layer for abstraction
- Session metadata from config, not from CLAUDE.md presets
- No built-in commands for accessing CLAUDE.md

### 3. Permission & Tool Management

#### Cloud-CLI: Granular Permission Control
- **Tool approval workflow**:
  - Creates requestId for each tool call
  - Sends `claude-permission-request` to WebSocket
  - Waits for user decision with timeout
  - Tracks pending approvals by sessionId
  - Supports tool permission rules: exact matches + `Bash(command:*)`

- **Permission modes**:
  ```javascript
  // Exact tool name or Bash(prefix:*) shorthand
  matchesToolPermission(entry, toolName, input)  // line 109-137
  ```

- **Disallowed/Allowed tools lists** with pattern matching
- Plan mode adds default tools: `Read`, `Task`, `exit_plan_mode`, `TodoRead`, `TodoWrite`, `WebFetch`, `WebSearch`

**Related code**: `server/claude-sdk.js:520-601` (canUseTool callback)

#### PPM: Simple Approval Model
- Basic approve/deny for each tool request
- Uses `pendingApprovals` Map with simple resolution
- No pattern matching or permission rules
- Simpler but less flexible than Cloud-CLI

### 4. Session Management

#### Cloud-CLI
- **Active sessions tracking**: `activeSessions` Map with:
  - Query instance reference
  - Start time
  - Status ('active', 'aborted')
  - Temp file paths (for image cleanup)
  - WebSocket writer reference
- Session resumption via sessionId parameter
- Abort capability via `interrupt()` method
- Cleanup on completion/error
- **Session reconnection**: `reconnectSessionWriter()` for page refresh recovery

#### PPM
- **Lightweight session tracking**:
  - Active sessions Map
  - Message count tracking
  - PPM sessionId → SDK sessionId mapping (persistent in `~/.ppm/session-map.json`)
- Session persistence across restarts
- Simpler abort mechanism
- No temp file tracking

### 5. MCP Server Management

#### Cloud-CLI
- **Dual approach**:
  1. CLI-based: `spawn('claude', ['mcp', 'list/add/remove'])` via CLI
  2. SDK-based: Loads from `~/.claude.json` directly
  3. File-based access in routes: `/api/mcp/cli/list`, `/api/mcp/cli/add`
- Supports stdio, HTTP, SSE transports
- Scope management: user vs project
- Full CRUD operations via Claude CLI

**Routes**:
- `/api/mcp/cli/list`
- `/api/mcp/cli/add`
- `/api/mcp/cli/remove` (implied)
- Project-scoped MCP servers from `.claude` directory

#### PPM
- No explicit MCP server management routes (yet)
- Relies on Claude Code's built-in MCP handling
- Session-level MCP configuration from config service

### 6. Custom Commands

#### Cloud-CLI: Full Command System
- **Built-in commands** (8 total):
  - `/help`, `/clear`, `/model`, `/cost`, `/memory` (CLAUDE.md)
  - `/config`, `/status`, `/rewind`
- **Custom command scanning**:
  - Project-level: `.claude/commands/` (project-specific)
  - User-level: `~/.claude/commands/` (available in all projects)
  - Recursive directory scanning
  - Markdown files with frontmatter metadata
  - Dynamic command discovery

**Code**: `server/routes/commands.js:scanCommandsDirectory()` (lines 21-76)

#### PPM
- No custom command system (yet)
- Simpler chat interface without command palette

### 7. Configuration & Settings

#### Cloud-CLI
- **User settings stored locally** (database + files)
- API keys management (`/api/settings/api-keys`)
- Generic credentials storage (`/api/settings/credentials`)
- Notification preferences
- Push subscription management (VAPID keys)
- Tool permissions per session (allowedTools/disallowedTools)

**Settings Routes**:
- `/api/settings/api-keys` (CRUD)
- `/api/settings/credentials` (CRUD)
- `/api/settings/notifications`
- `/api/settings/push-subscriptions`
- `/api/settings/tools` (implied)

#### PPM
- **Config from YAML** (`~/.ppm/config.yaml`)
- Config service layer abstracts file access
- Simpler settings model
- Dev/production config split
- Settings in TypeScript config interface

### 8. AI Provider Support

#### Cloud-CLI: Multi-Provider
- **4 AI providers integrated**:
  1. Claude (via SDK)
  2. Cursor CLI (separate handler: `cursor-cli.js`)
  3. OpenAI Codex (separate handler: `openai-codex.js`)
  4. Gemini CLI (separate handler: `gemini-cli.js`)
- Each provider has own route handler
- Model selection per session
- Pricing calculation per provider

**Provider routes**:
- `/api/claude` (SDK queries)
- `/api/cursor`
- `/api/codex`
- `/api/gemini`

#### PPM
- Claude-only (for now)
- Future extensibility via provider interface (`AIProvider` interface)
- Single focused implementation

### 9. Error Handling & Notifications

#### Cloud-CLI
- **Notification system**:
  - Notification hooks in SDK options
  - `createNotificationEvent()` for structured events
  - Push notifications (web-push integration)
  - Notification orchestrator service
  - Deduplication via dedupeKey
  - Severity levels: warning, error, info

- **Event types**:
  - `action_required`
  - `permission.required`
  - `notification` (from SDK hook)

#### PPM
- Error events streamed to WebSocket
- Basic error message propagation
- No notification system yet

---

## CLAUDE.md & SDK Configuration Comparison

| Feature | Cloud-CLI | PPM |
|---------|-----------|-----|
| **CLAUDE.md Loading** | Yes (preset) | Not yet |
| **settingSources** | ['project', 'user', 'local'] | Not configured |
| **systemPrompt** | 'claude_code' preset | Not configured |
| **Permission Mode Support** | 5+ modes | 1 basic mode |
| **Tool Approval Pattern Matching** | Yes (Bash:*) | No |
| **MCP Server Loading** | From ~/.claude.json | Not explicit |
| **Custom Commands** | Full system | Not yet |
| **Session Mapping** | In-memory | Persistent file |

---

## Interaction Patterns

### Cloud-CLI: Client → Server → Claude CLI → SDK
```
Browser UI 
  ↓ WebSocket
Server (Express)
  ↓ query() from SDK
@anthropic-ai/claude-agent-sdk
  ↓ (reads from ~/.claude/)
Claude Code ~/.claude/ directory
```

### PPM: Client → Server → SDK (Direct)
```
Browser UI (React)
  ↓ WebSocket
Server (Hono/Bun)
  ↓ query() from SDK
@anthropic-ai/claude-agent-sdk
  ↓ (reads from project/user ~/.claude/)
Claude Code ~/.claude/ directory (shared)
```

---

## Feature Matrix: What PPM Could Adopt from Cloud-CLI

| Feature | Cloud-CLI | PPM Status | Recommendation |
|---------|-----------|-----------|---|
| CLAUDE.md preset loading | ✅ | ❌ | HIGH - Core feature |
| settingSources mapping | ✅ | ❌ | HIGH - Enables CLAUDE.md |
| Permission pattern matching | ✅ | ❌ | MEDIUM - Useful for tool rules |
| Plan mode support | ✅ | ❌ | MEDIUM - For planning workflows |
| Image upload handling | ✅ | ❌ | MEDIUM - UX enhancement |
| Custom command system | ✅ | ❌ | LOW - Nice to have |
| MCP server UI management | ✅ | ❌ | MEDIUM - Power user feature |
| Multi-provider support | ✅ | ❌ | LOW - Future expansion |
| Notification system | ✅ | ❌ | LOW - Backend feature |
| Session reconnection | ✅ | ❌ | MEDIUM - Reliability feature |

---

## Code Quality & Patterns

### Cloud-CLI
- **Strengths**:
  - Comprehensive options mapping
  - Robust error handling
  - Multi-provider abstraction
  - Session tracking with cleanup
  - Notification integration
  
- **Weaknesses**:
  - Large monolithic files (844 lines in claude-sdk.js)
  - Complex permission logic mixed with query logic
  - Tight coupling to CLI commands

### PPM
- **Strengths**:
  - TypeScript for type safety
  - Clean provider interface abstraction
  - Lightweight and focused
  - Session mapping persistence
  
- **Weaknesses**:
  - Missing CLAUDE.md preset loading
  - Simple permission model
  - Less feature-complete for advanced users

---

## Unresolved Questions

1. **Does Cloud-CLI's plan mode permission rules** have documented format for users to understand `Bash(command:*)` syntax?
2. **How does Cloud-CLI handle project switching** between different ~/.claude projects? Does it re-read config?
3. **Does PPM plan to implement CLAUDE.md preset loading**, or will it rely on inline config?
4. **What's the migration path** if PPM wants to expose MCP server management UI like Cloud-CLI?
5. **How do permission timeouts interact** with long-running tool executions in Cloud-CLI?

---

## Conclusion

**Cloud-CLI** is a feature-rich wrapper that extends Claude Code's capabilities with a web UI, MCP management, custom commands, and multi-provider support. It's designed to be a **remote control for existing Claude Code setups**.

**PPM** is a focused project manager that embeds Claude as a core feature, with simpler session management and tool approval. It's designed to be a **standalone application** that happens to use Claude.

**For PPM's evolution**, prioritizing CLAUDE.md preset loading and settingSources would unlock project-specific instructions—a foundational feature that Cloud-CLI already leverages. Pattern-based permission rules and plan mode support could follow as power-user features.

