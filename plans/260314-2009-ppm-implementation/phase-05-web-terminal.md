# Phase 5: Web Terminal

**Owner:** backend-dev (PTY + WS) + frontend-dev (xterm.js) — parallel
**Priority:** High
**Depends on:** Phase 2, Phase 3
**Effort:** Medium

## Overview

Web-based terminal: xterm.js in browser ↔ WebSocket ↔ node-pty on server. Multiple terminal sessions.

## Backend (backend-dev)

### Files
```
src/services/terminal.service.ts
src/server/ws/terminal.ts
```

### Terminal Service

**[V2 FIX]** Use `Bun.spawn()` instead of node-pty. node-pty's `posix_spawnp` crashes the entire Bun process.

```typescript
class TerminalService {
  private sessions: Map<string, TerminalSession>;

  create(options: { projectPath: string; shell?: string }): TerminalSession
  get(id: string): TerminalSession | undefined
  kill(id: string): void
  list(): TerminalSessionInfo[]
  write(id: string, data: string): void
  onData(id: string, handler: (data: string) => void): void
}

// Uses Bun.spawn with stdin/stdout pipes
// NOTE: Bun.spawn doesn't support PTY resize natively.
// Alternative: use `script -q /dev/null <shell>` wrapper for PTY allocation
// or try node-pty with mandatory try-catch around spawn

interface TerminalSession {
  id: string;
  proc: Subprocess;
  projectPath: string;
  createdAt: Date;
}
```

**Approach options (pick one):**
1. **Bun.spawn + `script` wrapper:** `Bun.spawn(["script", "-q", "/dev/null", shell])` — allocates a real PTY on macOS/Linux without node-pty
2. **node-pty with try-catch:** Keep node-pty but ALWAYS wrap `pty.spawn()` in try-catch so server doesn't crash. Accept that it may fail under `bun build --compile`
3. **Bun.spawn raw:** No PTY, just raw pipes. Shell works but no terminal features (colors, cursor). Simpler but less capable

### WebSocket Handler
```
WS /ws/terminal/:id
```

Protocol (binary frames):
- Client → Server: keystrokes (text)
- Server → Client: terminal output (text)
- Client → Server: `\x01RESIZE:cols,rows` (control message)
- Server detects client disconnect → keep PTY alive for reconnect (30s timeout)

### Flow
```
Browser (xterm.js) → WS connect /ws/terminal/:id
  If session exists → attach to existing PTY
  If not → create new PTY via TerminalService

  xterm.js keystroke → WS → pty.write()
  pty.onData() → WS → xterm.js render
  xterm.js resize → WS control msg → pty.resize()
```

## Frontend (frontend-dev)

### Files
```
src/web/components/terminal/terminal-tab.tsx
src/web/hooks/use-terminal.ts
```

### Terminal Tab Component
```typescript
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

// useTerminal hook manages WS connection + xterm instance
const useTerminal = (sessionId: string) => {
  // Create Terminal instance
  // Attach FitAddon for auto-resize
  // Connect WebSocket
  // Wire: ws.onmessage → term.write()
  // Wire: term.onData → ws.send()
  // Wire: ResizeObserver → ws.send(resize control msg)
};
```

### Features
- Auto-fit to container size
- Clickable URLs (WebLinksAddon)
- Copy/paste (mobile: long press select, paste button)
- Reconnect on WS drop (re-attach to same PTY)
- "New Terminal" button → opens new tab with new session
- Terminal font: monospace, configurable size

### Mobile Considerations
- xterm.js works on mobile but keyboard can obscure terminal
- Use `visualViewport` API to adjust terminal height when keyboard opens
- Bottom toolbar with common keys: Tab, Ctrl, Esc, arrows

## Success Criteria

- [ ] Opening terminal tab spawns real shell (bash/zsh)
- [ ] Keystrokes work bidirectionally
- [ ] Terminal auto-resizes with container
- [ ] Multiple terminal tabs work simultaneously
- [ ] WS reconnect re-attaches to existing PTY
- [ ] Works on mobile (keyboard + viewport adjustment)
