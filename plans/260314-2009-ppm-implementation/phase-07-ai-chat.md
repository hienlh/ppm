# Phase 7: AI Chat

**Owner:** backend-dev (provider + WS) + frontend-dev (chat UI) — parallel
**Priority:** High
**Depends on:** Phase 2, Phase 3
**Effort:** Large

## Overview

AI chat with Claude Agent SDK as first provider. Generic AIProvider interface for multi-provider support. Chat UI with streaming, tool approvals, session management.

## Backend (backend-dev)

### Files
```
src/providers/provider.interface.ts    # Already in types, implement here
src/providers/claude-agent-sdk.ts
src/providers/cli-subprocess.ts        # Stub for future
src/providers/registry.ts
src/services/chat.service.ts
src/server/ws/chat.ts
```

### Claude Agent SDK Provider
```typescript
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

class ClaudeAgentSdkProvider implements AIProvider {
  id = 'claude';
  name = 'Claude Code';

  async createSession(config: SessionConfig): Promise<Session> {
    // Start a new query() — capture session_id from init message
    // Return session handle
  }

  async resumeSession(sessionId: string): Promise<Session> {
    // Use { resume: sessionId } option
  }

  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    const options = sessionId
      ? { resume: sessionId, allowedTools: [...] }
      : { allowedTools: [...] };

    for await (const msg of query({ prompt: message, options })) {
      // Map SDK messages → ChatEvent types
      if (msg.type === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'text') yield { type: 'text', content: block.text };
          if (block.type === 'tool_use') yield { type: 'tool_use', tool: block.name, input: block.input };
        }
      }
      if (msg.type === 'result') {
        yield { type: 'done', sessionId: msg.session_id };
      }
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    return await listSessions();
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Delete session file from ~/.claude/projects/...
  }
}
```

### Tool Approval Flow
```typescript
// In claude-agent-sdk.ts
// canUseTool callback → forward to frontend via WS

const options = {
  canUseTool: async (toolName: string, input: any) => {
    // Send approval request to frontend via WS
    const response = await this.requestApproval(sessionId, toolName, input);
    if (response.approved) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: response.reason || 'User denied' };
  }
};
```

### Provider Registry
```typescript
class ProviderRegistry {
  private providers: Map<string, AIProvider> = new Map();

  register(provider: AIProvider): void
  get(id: string): AIProvider | undefined
  list(): AIProviderInfo[]
  getDefault(): AIProvider
}
```

### Chat Service
```typescript
class ChatService {
  constructor(private registry: ProviderRegistry)

  async createSession(providerId: string, config: SessionConfig): Promise<Session>
  async resumeSession(providerId: string, sessionId: string): Promise<Session>
  async listSessions(providerId?: string): Promise<SessionInfo[]>
  async deleteSession(providerId: string, sessionId: string): Promise<void>
  sendMessage(providerId: string, sessionId: string, message: string): AsyncIterable<ChatEvent>
}
```

### WebSocket Handler
```
WS /ws/chat/:sessionId
```

Protocol (JSON messages):
```typescript
// Client → Server
{ type: 'message', content: string }
{ type: 'approval_response', requestId: string, approved: boolean, reason?: string }

// Server → Client
{ type: 'text', content: string }
{ type: 'tool_use', tool: string, input: any }
{ type: 'tool_result', output: string }
{ type: 'approval_request', requestId: string, tool: string, input: any }
{ type: 'done', sessionId: string }
{ type: 'error', message: string }
```

## Frontend (frontend-dev)

### Files
```
src/web/components/chat/chat-tab.tsx
src/web/components/chat/message-list.tsx
src/web/components/chat/message-input.tsx
src/web/components/chat/tool-approval.tsx
src/web/components/chat/session-picker.tsx
src/web/hooks/use-chat.ts
```

### Chat Tab Layout
```
┌─────────────────────────────────┐
│ Claude Code  ▼  [Session: abc]  │  ← provider picker + session info
├─────────────────────────────────┤
│                                 │
│  User: Fix the bug in auth.ts   │
│                                 │
│  Claude: I'll read the file...  │
│  📄 Read auth.ts                │
│  ✅ Tool result: (content)      │
│                                 │
│  ⚠️ Bash: rm -rf /tmp/test     │
│  [Allow] [Deny]                 │  ← tool approval dialog
│                                 │
├─────────────────────────────────┤
│ 📎  Type a message...    [Send] │  ← input with file attach
└─────────────────────────────────┘
```

### Message Types Rendering
- **User message:** Right-aligned bubble (or left with avatar)
- **Assistant text:** Markdown rendered (code blocks with syntax highlight)
- **Tool use:** Collapsible card showing tool name + input
- **Tool result:** Collapsible card showing output (truncated)
- **Approval request:** Highlighted card with Allow/Deny buttons + tool details
- **Error:** Red alert banner

### Session Picker
- Dropdown or modal listing all sessions
- Each session: provider icon, title (first message truncated), timestamp
- Actions: Resume, Delete, Fork (nice-to-have)
- "New Chat" button → create fresh session

### useChat Hook
```typescript
const useChat = (sessionId?: string) => {
  const ws = useWebSocket(`/ws/chat/${sessionId}`);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);

  const sendMessage = (content: string) => {
    ws.send(JSON.stringify({ type: 'message', content }));
  };

  const respondToApproval = (requestId: string, approved: boolean) => {
    ws.send(JSON.stringify({ type: 'approval_response', requestId, approved }));
  };

  return { messages, isStreaming, pendingApproval, sendMessage, respondToApproval };
};
```

### Mobile Considerations
- Chat input: sticky bottom, auto-resize textarea
- Long messages: scrollable code blocks
- Tool approval: full-width card, large touch targets for Allow/Deny
- Keyboard: input should push content up, not cover it

## Chat History & Reconnect

### REST API for Message History
- `GET /api/chat/sessions` → list all sessions (id, provider, title, createdAt)
- `GET /api/chat/sessions/:id/messages` → full message history for a session
- On WS reconnect: client loads history via REST, then subscribes to live stream
- This avoids WS replay complexity — REST is simpler and more reliable

### Reconnect Flow
```
Client disconnects
  → WS closes
  → Client: exponential backoff reconnect
  → Client reconnects to same sessionId
  → Client: GET /api/chat/sessions/:id/messages → render history
  → Server: resume streaming from where it left off (if AI still generating)
```

### Session Persistence
- Claude Agent SDK sessions persist automatically (stored in ~/.claude/)
- PPM stores session metadata in `~/.ppm/chat-sessions.json`: id, provider, title, projectName, createdAt
- Session list fetched from PPM metadata file (fast), not from SDK (slow)

## Success Criteria

- [ ] Can create new chat session → WS connects, session appears in session list
- [ ] Sending message streams AI response text in real-time (character by character)
- [ ] Tool use blocks render with tool name + collapsible input JSON
- [ ] Tool result blocks render with collapsible output
- [ ] Tool approval dialog: shows tool name + input, Allow/Deny buttons work, response sent via WS
- [ ] After Allow → tool executes and result streams back; after Deny → AI acknowledges denial
- [ ] Can resume existing session: select from picker → loads history via REST → WS reconnects
- [ ] Session list shows all sessions with provider icon, truncated title, timestamp
- [ ] "New Chat" button creates fresh session with current project context
- [ ] Multiple chat tabs work simultaneously (each with own WS connection)
- [ ] WS disconnect → reconnect → message history loaded from REST API
- [ ] Works on mobile: sticky bottom input, keyboard pushes content up, large Allow/Deny buttons
- [ ] Markdown rendering in AI messages: code blocks with syntax highlighting, lists, headers
- [ ] Error messages from AI/server shown as red alert banner (not silent failure)
