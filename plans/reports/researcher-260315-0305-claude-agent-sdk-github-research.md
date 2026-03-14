# Claude Agent SDK GitHub Research Report
**Date:** 2026-03-15 | **Researcher:** Claude Code Researcher

## Executive Summary

Found comprehensive GitHub ecosystem for `@anthropic-ai/claude-agent-sdk`: official Anthropic repos, 3+ notable integration projects, extensive documentation, and production-ready code examples. SDK enables programmatic Claude Code interaction with built-in tools, streaming message loops, and session persistence.

## Official Resources

### Core Repositories
1. **anthropics/claude-agent-sdk-typescript** - Official TypeScript SDK
   - NPM: `@anthropic-ai/claude-agent-sdk`
   - Latest v0.2.76 (as of Mar 14, 2026)
   - Requires Node.js 18+
   - Bundled Claude Code CLI included

2. **anthropics/claude-agent-sdk-python** - Official Python SDK
   - PyPI: `claude-agent-sdk`
   - Parallel implementation to TypeScript
   - Python 3.10+ required

3. **anthropics/claude-agent-sdk-demos** - Official demo repository
   - 8+ complete working examples
   - V2 Session API examples
   - Production-ready patterns

## Key SDK Capabilities

### Agent Loop Architecture
The SDK provides a **streaming agentic loop** that:
1. Sends prompt to Claude with tools available
2. Claude evaluates & requests tool calls (or responds with text)
3. SDK executes tools automatically
4. Results feed back to Claude automatically
5. Loop continues until Claude produces text-only response
6. Final `ResultMessage` contains output, cost, session ID

**Message Types Yielded:**
- `SystemMessage` - Session init/lifecycle events
- `AssistantMessage` - Claude responses (text + tool calls)
- `UserMessage` - Tool results sent back to Claude
- `StreamEvent` - Partial message updates (when enabled)
- `ResultMessage` - Final result with cost, usage, session ID

### Built-in Tools Available
- **File ops:** `Read`, `Edit`, `Write`
- **Search:** `Glob`, `Grep`
- **Execution:** `Bash`
- **Web:** `WebSearch`, `WebFetch`
- **Orchestration:** `Agent`, `Skill`, `AskUserQuestion`, `TodoWrite`
- **Discovery:** `ToolSearch` (load tools on-demand)
- **Custom:** MCP servers support, custom tool handlers

### Core Configuration Options
```typescript
// TypeScript Options interface
{
  allowedTools: string[],              // Auto-approve specific tools
  disallowedTools: string[],           // Block specific tools
  permissionMode: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions",
  systemPrompt?: string,
  model?: string,                      // Pin specific Claude model
  maxTurns?: number,                   // Limit tool-use rounds
  maxBudgetUsd?: number,               // Limit spend
  effort?: "low" | "medium" | "high" | "max",
  settingSources?: string[],           // Load CLAUDE.md, skills
  includePartialMessages?: boolean,    // Enable streaming deltas
  mcpServers?: MCP[],                  // Connect external services
}
```

## Real-World Integration Projects

### 1. claude-agent-kit (JimLiu)
**GitHub:** [JimLiu/claude-agent-kit](https://github.com/JimLiu/claude-agent-kit)

Utility layer providing session management, message parsing, WebSocket orchestration.

**Features:**
- `SessionManager` for lifecycle helpers
- `SimpleClaudeAgentSDKClient` wrapper
- WebSocket handlers (Node.js + Bun variants)
- Local state sync with Claude
- Multi-client real-time support

**Example Usage:**
```typescript
import { SessionManager, SimpleClaudeAgentSDKClient } from "@claude-agent-kit/server";

const sessionManager = new SessionManager();
const session = sessionManager.createSession(
  new SimpleClaudeAgentSDKClient()
);

await session.send("List open pull requests", undefined);

for (const message of session.messages) {
  console.log(`[${message.type}]`,
    message.content.map(part => part.content));
}
```

**Packages:** 4 scoped packages (@claude-agent-kit/messages, /server, /websocket, /bun-websocket)

### 2. kenneth-liao/claude-agent-sdk-intro
**GitHub:** [kenneth-liao/claude-agent-sdk-intro](https://github.com/kenneth-liao/claude-agent-sdk-intro)

Educational repository teaching fundamentals + advanced patterns.

**Modules:**
- Basic querying & streaming
- Message parsing/display
- Custom tool creation (3-step process: define → MCP server → configure agent)
- Agent configuration (options, permissions, system prompts)
- Conversation loops
- MCP integration
- Multi-agent systems

**Learning Focus:** When to use `query()` vs `ClaudeSDKClient`, tool permissions, subagent orchestration

### 3. weidwonder/claude_agent_sdk_oauth_demo
**GitHub:** [weidwonder/claude_agent_sdk_oauth_demo](https://github.com/weidwonder/claude_agent_sdk_oauth_demo)

OAuth integration patterns for Claude Pro account access via agent SDK

---

## Official Code Examples

### Basic Agent Loop (TypeScript)
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

let sessionId: string | undefined;

for await (const message of query({
  prompt: "Review utils.py for bugs that would cause crashes. Fix any issues you find.",
  options: {
    allowedTools: ["Read", "Edit", "Glob"],
    permissionMode: "acceptEdits"
  }
})) {
  // Save session ID from init message
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
  }

  // Handle output
  if (message.type === "assistant" && message.message?.content) {
    for (const block of message.message.content) {
      if ("text" in block) {
        console.log(block.text);           // Claude's reasoning
      } else if ("name" in block) {
        console.log(`Tool: ${block.name}`); // Tool being called
      }
    }
  }

  // Handle final result
  if (message.type === "result") {
    if (message.subtype === "success") {
      console.log(`Done: ${message.result}`);
    } else if (message.subtype === "error_max_turns") {
      console.log(`Hit turn limit. Resume session ${sessionId} to continue.`);
    }
    console.log(`Cost: $${message.total_cost_usd.toFixed(4)}`);
  }
}
```

### Message Type Checking (Python)
```python
from claude_agent_sdk import query, AssistantMessage, ResultMessage

async for message in query(prompt="Summarize this project"):
    if isinstance(message, AssistantMessage):
        print(f"Turn completed: {len(message.content)} content blocks")

    if isinstance(message, ResultMessage):
        if message.subtype == "success":
            print(message.result)
        else:
            print(f"Stopped: {message.subtype}")
```

### Permission Modes Comparison
```typescript
// Mode 1: Auto-approve edits only
{ permissionMode: "acceptEdits" }           // Edit files auto-approve, Bash prompts

// Mode 2: Require approval callback
{ permissionMode: "default", canUseTool: (tool) => userApproves(tool) }

// Mode 3: Plan only (no execution)
{ permissionMode: "plan" }                  // Claude produces plan, no tool execution

// Mode 4: Locked-down (TypeScript only)
{ permissionMode: "dontAsk" }               // Deny anything not in allowedTools

// Mode 5: Full automation (sandboxed only)
{ permissionMode: "bypassPermissions" }     // No prompts, all allowed tools run
```

## Official Demo Examples

**hello-world-v2** - Recommended modern example using V2 Session API
- `session.send()` and `session.stream()` methods (vs single `query()` generator)
- Multi-turn conversation patterns
- Session persistence examples

**email-agent** - IMAP email assistant with:
- Inbox display
- Agentic search
- AI-powered email assistance

**research-agent** - Multi-agent research system:
- Break research into subtopics
- Spawn parallel researcher subagents
- Aggregate findings into report
- Live activity tracking

**simple-chat-app** - React + Express with:
- WebSocket integration
- Streaming responses
- Full conversation loop

**resume-generator** - End-to-end example:
- Web-search person's name (LinkedIn, GitHub, news)
- Assemble findings into .docx resume

## Installation & Setup

### TypeScript
```bash
npm install @anthropic-ai/claude-agent-sdk
```

### Python
```bash
uv init && uv add claude-agent-sdk
# or
python3 -m venv .venv && source .venv/bin/activate
pip3 install claude-agent-sdk
```

### Authentication
```bash
# API key (default)
export ANTHROPIC_API_KEY=sk-...

# Or cloud providers
export CLAUDE_CODE_USE_BEDROCK=1          # Amazon Bedrock
export CLAUDE_CODE_USE_VERTEX=1           # Google Vertex AI
export CLAUDE_CODE_USE_FOUNDRY=1          # Microsoft Azure
```

## Session Management Patterns

### Resume Session (Continue Conversation)
```typescript
// Capture session ID from ResultMessage
const sessionId = resultMessage.session_id;

// Later: resume the same session
for await (const message of query({
  prompt: "Continue refactoring the auth module",
  options: { sessionId }  // Resume with all context
})) {
  // ...
}
```

### Session Persistence with Claude Agent Kit
```typescript
const sdkClient = new SimpleClaudeAgentSDKClient();
const wsHandler = new WebSocketHandler(sdkClient, {
  thinkingLevel: 'default_on'
});

// Clients send: { type: "chat", content, attachments }
// Server broadcasts: message_added, messages_updated, session_state_changed
```

## Cost & Performance Control

**Turn Limits (prevent runaway loops):**
```typescript
options: { maxTurns: 30 }  // Stop after 30 tool-use rounds
```

**Budget Limits (control spend):**
```typescript
options: { maxBudgetUsd: 2.50 }  // Stop if exceeds $2.50
```

**Effort Levels (token efficiency):**
```typescript
options: { effort: "low" }     // Fast, cheap, minimal reasoning
options: { effort: "high" }    // Thorough analysis (default TypeScript)
```

**Context Window Optimization:**
- Subagents start fresh (no parent history, lower context cost)
- MCP tool search loads tools on-demand instead of preloading all
- Automatic compaction when context limit approaches
- Project CLAUDE.md loaded via prompt caching (cost amortized)

## Hooks for Custom Behavior

Available hooks (both SDKs):
- `PreToolUse` - Validate/block tool calls before execution
- `PostToolUse` - Audit outputs, trigger side effects
- `UserPromptSubmit` - Inject additional context
- `Stop` - Validate result, save session state
- `SubagentStart`/`SubagentStop` - Track parallel tasks
- `PreCompact` - Archive transcript before summarization

**Example:**
```typescript
const hooks = {
  PreToolUse: (tool) => {
    if (tool.name === "Bash") {
      // Validate bash commands before execution
      if (tool.input.command.includes("rm -rf")) {
        throw new Error("Dangerous command blocked");
      }
    }
  }
}
```

## Key Architecture Decisions

**Stream vs Single-Mode:**
- **Streaming (async for loop):** Real-time progress, show Claude's reasoning as it works
- **Single-mode:** Collect all messages, process batch

**Custom Tools:**
- 3-step process: (1) define tool, (2) create MCP server, (3) configure in agent options
- TypeScript: Use `Zod` schemas for type safety
- Python: Use function annotations

**MCP Integration:**
- Connect to databases, browsers, APIs, Slack, GitHub, etc.
- Tools loaded on-demand via `ToolSearch`
- Reduces context cost vs preloading all tools

## Documentation References

- **[Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)** - Concepts & features
- **[Agent Loop Architecture](https://platform.claude.com/docs/en/agent-sdk/agent-loop)** - Message types, context, hooks
- **[TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)** - Complete API
- **[Python Reference](https://platform.claude.com/docs/en/agent-sdk/python)** - Complete API
- **[Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart)** - 5-minute start
- **[Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)** - Tool control
- **[Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)** - Custom callbacks
- **[Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)** - Resume/fork patterns
- **[MCP](https://platform.claude.com/docs/en/agent-sdk/mcp)** - External services

## Notable Integration Patterns

### WebSocket Chat Server
Tools like claude-agent-kit provide ready-made WebSocket orchestration:
```typescript
// Clients connect, send messages
// Server maintains session state, streams responses back
// Multi-client sync via broadcast events
```

### Express/Node.js Backend
```typescript
// Server instantiates SimpleClaudeAgentSDKClient
// Per-request or per-session instances
// Stream results back via Express response or WebSocket
```

### Bun Runtime Support
Several demos target Bun runtime (fast startup, native WebSocket).

## Summary for PPM Project Context

**Relevant for Claude Code CLI Integration:**
1. SDK provides programmatic access to Claude Code's loop
2. Session persistence enables multi-turn workflows
3. Streaming allows real-time progress UI feedback
4. Custom hooks enable validation/auditing of tool calls
5. Tool permission modes support various approval workflows
6. MCP servers can extend tool catalog (GitHub, Jira, etc.)

**Integration Points for PPM:**
- Use `query()` for one-shot agent tasks
- Use `ClaudeSDKClient` for conversation-based UI
- Enable streaming for real-time chat display
- Capture session IDs for multi-turn debugging workflows
- Implement hooks for security/validation if needed
- Consider WebSocket orchestration for multi-user scenarios

---

## Unresolved Questions

1. **Performance benchmarks:** No comparative latency data between Bun vs Node.js SDK versions
2. **Scalability limits:** Unknown max concurrent sessions per server, rate limit thresholds
3. **Error recovery:** How to handle mid-loop API failures and graceful degradation strategies
4. **Custom tool execution:** Performance/security implications of running untrusted tool code
5. **MCP server overhead:** Context cost of loading many MCP servers vs ToolSearch on-demand

---

## Sources

- [anthropics/claude-agent-sdk-typescript - GitHub](https://github.com/anthropics/claude-agent-sdk-typescript)
- [@anthropic-ai/claude-agent-sdk - npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [anthropics/claude-agent-sdk-python - GitHub](https://github.com/anthropics/claude-agent-sdk-python)
- [anthropics/claude-agent-sdk-demos - GitHub](https://github.com/anthropics/claude-agent-sdk-demos)
- [JimLiu/claude-agent-kit - GitHub](https://github.com/JimLiu/claude-agent-kit)
- [kenneth-liao/claude-agent-sdk-intro - GitHub](https://github.com/kenneth-liao/claude-agent-sdk-intro)
- [Agent SDK overview - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/overview)
- [How the agent loop works - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- [Agent SDK Quickstart - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/quickstart)
- [Agent SDK TypeScript Reference - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK Python Reference - Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/python)
- [Building agents with the Claude Agent SDK - Anthropic](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
