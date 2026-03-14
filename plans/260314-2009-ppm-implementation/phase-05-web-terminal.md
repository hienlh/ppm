# Phase 5: Web Terminal

**Owner:** backend-dev (PTY + WS) + frontend-dev (xterm.js) — parallel
**Priority:** High
**Depends on:** Phase 2, Phase 3
**Effort:** Medium

## Overview

Web-based terminal: xterm.js in browser ↔ WebSocket ↔ Bun.spawn() native Terminal API on server. Multiple terminal sessions.

## Backend (backend-dev)

### Files
```
src/services/terminal.service.ts
src/server/ws/terminal.ts
```

### Terminal Service

**[V2 FIX]** Use `Bun.spawn()` with **native Terminal API** (NOT node-pty).

**Why:** node-pty uses NAN (pre-2015 C++ bindings), Bun only supports NAPI. This is a hard incompatibility — segfault crashes entire process, no try-catch possible. See [research report](../reports/researcher-260314-2232-node-pty-bun-crash-analysis.md).

**Chosen approach:** `Bun.spawn()` with `terminal` option — built-in, zero dependencies, full PTY support (colors, cursor, resize).

```typescript
class TerminalService {
  private sessions: Map<string, TerminalSession> = new Map();
  private outputBuffers: Map<string, string> = new Map(); // Last 10KB per session

  create(projectPath: string, shell?: string): string {
    const id = crypto.randomUUID();
    const proc = Bun.spawn([shell || process.env.SHELL || 'bash'], {
      cwd: projectPath,
      terminal: {
        cols: 80,
        rows: 24,
        data: (terminal, chunk) => {
          // Buffer last 10KB for reconnect
          this.appendBuffer(id, chunk.toString());
          // Emit to connected WS clients via event bus
        },
      },
    });
    this.sessions.set(id, { id, proc, projectPath, createdAt: new Date() });
    return id;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.terminal?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.proc.terminal?.resize(cols, rows);
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.proc.terminal?.close();
      session.proc.kill();
      this.sessions.delete(id);
      this.outputBuffers.delete(id);
    }
  }

  getBuffer(id: string): string {
    return this.outputBuffers.get(id) ?? '';
  }

  list(): TerminalSessionInfo[] { /* ... */ }
  get(id: string): TerminalSession | undefined { /* ... */ }
}
```

**Limitation:** POSIX only (macOS/Linux). Acceptable for dev environment — Windows users use WSL.

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

## State Persistence & Reconnect

### Output Buffer
- Server keeps a circular buffer (last 10KB) of terminal output per session
- On WS reconnect → server sends buffered output before live stream
- Client clears xterm and replays buffer for seamless experience

### Session Persistence
- Terminal sessions survive server restart: save session metadata (id, projectPath, shell, cwd) to `~/.ppm/sessions.json`
- On server start → attempt to restore sessions from file (re-spawn shell in last known cwd)
- Sessions that fail to restore → mark as "dead", remove from list
- Idle session timeout: configurable, default 1 hour — kill PTY + remove from sessions

### WS Reconnect Flow
```
Client disconnects (network drop, tab switch on mobile)
  → WS closes
  → Client: exponential backoff reconnect (1s, 2s, 4s... max 30s)
  → Server: PTY stays alive, output buffers
  → Client reconnects: sends { type: 'attach', sessionId: 'xxx' }
  → Server: sends buffered output, then pipes live
```

## Success Criteria

- [ ] Opening terminal tab spawns real shell (bash/zsh) with correct CWD
- [ ] Keystrokes sent from browser appear in shell; shell output renders in xterm.js
- [ ] Terminal auto-resizes when browser window/container resizes — sends RESIZE control message
- [ ] Multiple terminal tabs work simultaneously (each with own PTY session)
- [ ] WS disconnect → reconnect → terminal shows buffered output + continues working
- [ ] Works on mobile: keyboard opens without covering terminal, bottom toolbar has Tab/Ctrl/Esc/arrows
- [ ] `visualViewport` API adjusts terminal height when mobile keyboard opens
- [ ] Terminal session persists if server stays running (navigate away + come back = same session)
- [ ] Idle sessions killed after configured timeout (default 1h)
- [ ] Clickable URLs in terminal output (WebLinksAddon)
