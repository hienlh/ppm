# Scout Report: Cloud-CLI vs PPM Claude Integration — Key Findings

**Date**: 2026-03-17 | **Scout**: Codebase Scout | **Task**: Compare Claude Code integration patterns

---

## TLDR: What's Different?

| | Cloud-CLI | PPM | Impact |
|---|----------|-----|--------|
| **Purpose** | Remote UI wrapper for Claude Code | Standalone IDE with built-in Claude | Architectural difference |
| **CLAUDE.md** | ✅ Fully supported | ❌ Not used | PPM missing core feature |
| **Permission modes** | 6 modes (plan, yolo, bypassPermissions) | 1 mode (basic approve/deny) | Cloud-CLI more powerful |
| **Session persistence** | In-memory | File-based (`~/.ppm/session-map.json`) | PPM more resilient |
| **Custom commands** | 8 built-in + dynamic discovery | None | Cloud-CLI more extensible |
| **MCP management** | Full CRUD UI via Claude CLI | None (config-driven) | Cloud-CLI more user-friendly |
| **Multi-provider** | Claude, Cursor, Gemini, Codex | Claude only | Cloud-CLI broader scope |
| **Image uploads** | Base64 → temp files | Not supported | Cloud-CLI better UX |
| **SDK code lines** | 844 | ~500 | PPM leaner but less featured |

---

## Critical Gap #1: CLAUDE.md Missing in PPM

### What Cloud-CLI Does
```javascript
// server/claude-sdk.js:199-206
sdkOptions.systemPrompt = {
  type: 'preset',
  preset: 'claude_code'
};
sdkOptions.settingSources = ['project', 'user', 'local'];
```
This makes the SDK load project instructions from `./CLAUDE.md`, `~/.claude/CLAUDE.md`, and local directories.

### What PPM Does
- Creates `./CLAUDE.md` but **doesn't configure SDK to use it**
- Config is read from `~/.ppm/config.yaml` instead
- Instructions are not passed to Claude

### Recommendation
**HIGH PRIORITY**: Add CLAUDE.md loading to PPM. Two lines of code in `src/providers/claude-agent-sdk.ts`:
```typescript
systemPrompt: { type: 'preset', preset: 'claude_code' },
settingSources: ['project', 'user', 'local'],
```

---

## Critical Gap #2: Permission Modes

### Cloud-CLI Permission Flexibility
```javascript
// Supports 6+ permission modes
'default'           // Ask for each tool
'bypassPermissions' // Allow all tools (no approval)
'acceptEdits'       // Auto-approve file edits
'auto_edit'         // Like acceptEdits
'plan'              // Special tools only (Read, Task, etc)
'yolo'              // Extreme bypass
```

Plus **pattern-based rules**: `Bash(git:*)` allows git commands, `Bash(npm:*)` allows npm commands.

### PPM Permission Model
```typescript
// Simple binary choice
allow: boolean
```

### Recommendation
**MEDIUM PRIORITY**: Implement at least 'plan' mode for planning workflows. Pattern matching is nice-to-have.

---

## Gap #3: Custom Commands System

### Cloud-CLI
```
/help      - Show help
/memory    - Edit CLAUDE.md
/model     - Switch model
/cost      - Show token usage
/config    - Open settings
/status    - System info
/clear     - Clear history
/rewind    - Undo last message

PLUS: Dynamic discovery from:
- Project: .claude/commands/
- User: ~/.claude/commands/
```

### PPM
- Simple chat interface only
- No command system

### Recommendation
**LOW PRIORITY**: Nice to have, but not essential for core functionality.

---

## Advantage: PPM's Session Persistence

### Cloud-CLI (In-Memory)
```javascript
activeSessions.set(sessionId, {
  instance, startTime, status, ...
})
// Lost when server restarts
```

### PPM (File-Based) ✅
```typescript
const SESSION_MAP_FILE = "~/.ppm/session-map.json"
// Survives server restarts!
```

**This is actually better than Cloud-CLI** for reliability.

---

## Multi-Provider Architecture

### Cloud-CLI Routes
```
/api/claude/     - SDK-based
/api/cursor/     - Cursor CLI
/api/codex/      - OpenAI Codex
/api/gemini/     - Gemini CLI
```

### PPM
- Claude only
- But has `AIProvider` interface for future expansion

**Not a blocker**, just scope difference.

---

## SDK Configuration Comparison

### Cloud-CLI: Full Option Mapping
```javascript
mapCliOptionsToSDK(options) {
  cwd
  permissionMode (5+ modes)
  allowedTools [] / disallowedTools []
  model
  systemPrompt { type, preset }  ← CLAUDE.md loading
  settingSources ['project', 'user', 'local']
  mcpServers (from ~/.claude.json)
  tools { type: 'preset', preset: 'claude_code' }
  hooks { Notification: [...] }
  canUseTool callback (permission logic)
}
```

### PPM: Minimal Mapping
```typescript
cwd
permissionMode ('default' or 'bypassPermissions')
model
tools
// Missing all the advanced features ↑
```

---

## File Structure Insights

### Cloud-CLI Core: 844 lines in one file
- `server/claude-sdk.js` handles everything
- Massive but comprehensive
- Tight coupling between query, permissions, session, images

### PPM Core: ~500 lines in TypeScript
- `src/providers/claude-agent-sdk.ts` (cleaner interface)
- Less features but better code organization
- Separated concerns (provider, hooks, config)

**PPM's approach is better for maintainability, but needs more features.**

---

## MCP Server Management

### Cloud-CLI
```
/api/mcp/cli/list         spawn('claude', ['mcp', 'list'])
/api/mcp/cli/add          spawn('claude', ['mcp', 'add', ...])
/api/mcp/cli/remove       (implied)
```
Full CLI integration + loads from `~/.claude.json`

### PPM
- Reads from config
- No UI for adding/removing
- Relies on Claude Code's built-in defaults

**Cloud-CLI is more user-friendly for power users.**

---

## Notification System

### Cloud-CLI
```javascript
hooks: {
  Notification: [{
    matcher: '',
    hooks: [async (input) => {
      createNotificationEvent({ code, message, severity })
      notifyUserIfEnabled()
    }]
  }]
}
```
Includes web-push integration, deduplication, severity levels.

### PPM
- Simple error/completion messages
- No notification system

**Low priority unless building multi-user features.**

---

## Session Reconnection

### Cloud-CLI
```javascript
reconnectSessionWriter(sessionId, newRawWs) {
  // Page refresh → reconnect writer
  session.writer.updateWebSocket(newRawWs)
}
```

### PPM
- Not implemented
- Page refresh = new session

**MEDIUM PRIORITY** for UX: Keep chat alive on page refresh.

---

## Quick Implementation Roadmap for PPM

### Phase 1 (HIGH PRIORITY - Do First)
- [ ] Add CLAUDE.md preset loading: 2 lines
- [ ] Add settingSources configuration: 1 line
- Total effort: 30 minutes

### Phase 2 (MEDIUM PRIORITY)
- [ ] Implement 'plan' permission mode
- [ ] Session reconnection on page refresh
- [ ] Image upload support
- Total effort: 3-5 hours

### Phase 3 (LOW PRIORITY)
- [ ] Custom command system (/.claude/commands/)
- [ ] Permission pattern matching (Bash(git:*))
- [ ] MCP server UI management
- [ ] Notification system
- Total effort: Multiple sessions

---

## Code Locations for Reference

### Cloud-CLI Core Files
1. **CLAUDE.md loading**: `server/claude-sdk.js:199-206`
2. **Permission modes**: `server/claude-sdk.js:144-214`
3. **Tool approval**: `server/claude-sdk.js:520-601`
4. **Session management**: `server/claude-sdk.js:223-257`
5. **Custom commands**: `server/routes/commands.js:21-130`
6. **MCP management**: `server/routes/mcp.js:16-150`

### PPM Equivalent Files
1. **SDK provider**: `src/providers/claude-agent-sdk.ts` (lines 1-150)
2. **WebSocket handler**: `src/server/ws/chat.ts`
3. **Config service**: `src/services/config.service.ts`

---

## Conclusion

**Cloud-CLI and PPM serve different purposes but share the same SDK foundation.**

Cloud-CLI is a **wrapper** that surfaces existing Claude Code capabilities as a web UI.
PPM is a **first-class application** that embeds Claude as a core feature.

**The most impactful improvement for PPM: Add CLAUDE.md support.** It's foundational—enables developers to store project instructions that Claude automatically reads, supporting repeatable workflows and custom project guidance.

Everything else (permission modes, commands, MCP UI) is nice-to-have but not critical for core functionality.

