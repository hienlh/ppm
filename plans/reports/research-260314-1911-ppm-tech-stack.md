# Research Report: PPM Tech Stack Selection

**Date:** 2026-03-14
**Sources consulted:** 15+
**Key search terms:** mobile-first code editor, web terminal, git graph visualization, Claude Code CLI integration, Go CLI web gateway

---

## Executive Summary

PPM (Personal Project Manager) cần: CLI backend chạy background serving web UI, mobile-first tab system giống VSCode, terminal/editor/git/AI chat trong browser. Sau khi research, recommend stack:

- **Backend:** Go + Cobra CLI + embedded SPA + WebSocket
- **Frontend:** React (Vite) + Tailwind CSS + shadcn/ui mobile
- **Editor:** CodeMirror 6 (mobile-first, 300KB vs Monaco 5-10MB)
- **Terminal:** xterm.js + WebSocket → PTY
- **Git:** go-git + custom SVG git graph + diff2html
- **AI Chat:** Claude Agent SDK / Anthropic API streaming via SSE
- **Tab System:** Custom React tab manager (inspired by VSCode workbench)

---

## Key Findings

### 1. CLI Backend: Go

| Criteria | Go | Node.js | Rust |
|---|---|---|---|
| Single binary deploy | Yes | No (runtime needed) | Yes |
| Build speed | Fast (~2s) | N/A | Slow (~30s+) |
| Concurrency | Goroutines (lightweight) | Event loop + workers | Async/Tokio |
| WebSocket support | gorilla/websocket, nhooyr | ws, socket.io | tokio-tungstenite |
| PTY support | creack/pty | node-pty | portable-pty |
| Embed static files | embed.FS (built-in) | pkg/nexe (hacky) | rust-embed |
| Learning curve | Low-medium | Low | High |
| Dev productivity (solo) | High | High | Medium |

**Recommendation: Go**
- Single binary = dễ deploy lên VPS, chỉ cần copy binary + config
- `embed.FS` cho phép nhúng toàn bộ frontend build vào binary
- Cobra CLI framework cho CLI commands (init, start, config)
- gorilla/websocket cho terminal + chat streaming
- creack/pty cho PTY spawning

**Key libraries:**
- `spf13/cobra` - CLI framework
- `gorilla/websocket` - WebSocket server
- `creack/pty` - PTY management
- `go-git/go-git` - Pure Go git implementation (no git binary needed)
- `embed` (stdlib) - Embed frontend assets

### 2. Frontend: React + Vite + Tailwind

**Tại sao React thay vì Svelte?**

Gemini recommend Svelte nhưng tôi counter-argue:
- Ecosystem cho tab system, code editor wrappers, terminal components **lớn hơn nhiều** ở React
- `@anthropic-ai/claude-agent-sdk-demos` dùng React - dễ reference
- CodeMirror 6 có `@uiw/react-codemirror` wrapper tốt
- xterm.js có nhiều React wrappers
- shadcn/ui + Radix UI cho mobile-first components
- Solo dev đã quen React → productivity cao hơn

**Bundle size concern:** Vite tree-shaking + code splitting giải quyết. Lazy load tabs (terminal, editor, git graph) = initial load nhỏ.

**Key libraries:**
- `vite` - Build tool
- `tailwindcss` + `shadcn/ui` - Mobile-first UI
- `@tanstack/react-router` - File-based routing (nếu cần)
- `zustand` - State management (nhẹ, simple)
- `react-resizable-panels` - Split panes cho tab layout

### 3. Code Editor: CodeMirror 6

| Criteria | CodeMirror 6 | Monaco |
|---|---|---|
| Bundle size | ~300KB (core) | 5-10MB |
| Mobile/touch support | Native, built-in | Not officially supported |
| Modular | Yes, tree-shakable | Monolithic |
| Syntax highlighting | 100+ languages via @codemirror/lang-* | Built-in, extensive |
| Diff view | @codemirror/merge | Built-in, excellent |

**Winner: CodeMirror 6** - mobile-first requirement makes this a no-brainer.
- Replit switched to CM6, mobile retention tăng 70%
- Sourcegraph migrated Monaco → CM6 vì performance

**Key packages:**
- `@uiw/react-codemirror` - React wrapper
- `@codemirror/lang-*` - Language support
- `@codemirror/merge` - Diff/merge view
- `@codemirror/theme-one-dark` - Dark theme

### 4. Web Terminal: xterm.js

Industry standard, powers VSCode terminal. Architecture:

```
Browser (xterm.js) ←WebSocket→ Go server ←PTY→ bash/zsh
```

**Key packages:**
- `@xterm/xterm` - Core terminal emulator
- `@xterm/addon-fit` - Auto-resize
- `@xterm/addon-web-links` - Clickable links
- `@xterm/addon-attach` - WebSocket attachment

Go side: `creack/pty` spawns PTY, `gorilla/websocket` bridges to frontend.

### 5. Git Integration

**Git operations:** `go-git/go-git` (pure Go, no git binary dependency)
- Clone, log, diff, status, branch - all natively
- Fallback to `os/exec` + `git` binary for complex ops

**Git graph visualization:**
- `gitgraph.js` archived → NOT recommended
- **Custom SVG rendering** using commit data from go-git
  - Parse commit graph → layout algorithm → SVG/Canvas render
  - Reference: VSCode Git Graph extension approach
  - Libraries: `react-flow` hoặc custom SVG with D3 basics

**Git diff viewer:**
- `diff2html` (2.5k stars) - Parse unified diff → HTML
- Alternative: `@codemirror/merge` for inline editing + diff

### 6. AI Chat Integration

**Approach 1 (Recommended): Wrap Claude Code CLI**
```
Frontend Chat UI ←WebSocket→ Go server ←stdin/stdout→ claude CLI process
```
- Spawn `claude` process with PTY (giống terminal nhưng parse output)
- Giống hệt VSCode extension approach
- Hỗ trợ tool approvals, streaming, MCP
- Session = 1 claude process, CRUD = start/stop processes

**Approach 2: Direct API**
- Anthropic API streaming via SSE
- Mất hết claude code features (tools, MCP, permissions)

**Approach 3: Claude Agent SDK**
- TypeScript SDK cho building agents
- Phức tạp hơn nhưng flexible hơn

**Reference projects:**
- `siteboon/claudecodeui` - Self-hosted web UI for Claude Code sessions
- `Jinn` - Gateway daemon extending Claude CLI with web UI
- Claude Agent SDK demos - React + Express chat app

### 7. Tab System Architecture

```
┌─────────────────────────────────────────┐
│ Tab Bar (scrollable on mobile)          │
│ [Terminal 1] [Chat: main] [editor.ts] X │
├─────────────────────────────────────────┤
│                                         │
│          Active Tab Content              │
│   (lazy-loaded React component)         │
│                                         │
└─────────────────────────────────────────┘
```

- Each tab = `{ id, type, title, component, metadata }`
- Types: `terminal`, `chat`, `editor`, `git-graph`, `git-diff`, `settings`
- State: zustand store with tab CRUD
- Mobile: swipe gestures, bottom tab bar option
- Desktop: draggable tabs, split panes

### 8. Deployment & Config

**Config file (`ppm.yaml`):**
```yaml
port: 8080
host: 0.0.0.0
projects:
  - path: /home/user/project-a
    name: Project A
  - path: /home/user/project-b
    name: Project B
auth:
  enabled: true
  token: "xxx"  # simple token auth for VPS
```

**Local onboarding:**
```bash
ppm init          # Interactive setup, scan for .git folders
ppm start         # Start server
ppm start -d      # Daemon mode (background)
```

**VPS deployment:**
```bash
# Copy binary + config
scp ppm user@vps:/usr/local/bin/
scp ppm.yaml user@vps:/etc/ppm/
ssh user@vps "ppm start -c /etc/ppm/ppm.yaml -d"
```

**Tailscale:** Just run `ppm start` on local machine, access via Tailscale IP.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│                   PPM Binary (Go)                 │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Cobra CLI│  │ HTTP/WS  │  │ Embedded SPA   │  │
│  │ Commands │  │ Server   │  │ (React build)  │  │
│  └──────────┘  └────┬─────┘  └────────────────┘  │
│                     │                              │
│  ┌──────────┐  ┌────┴─────┐  ┌────────────────┐  │
│  │ PTY Mgr  │  │ WS Hub   │  │ Session Mgr    │  │
│  │(terminal)│  │(routing) │  │ (AI processes) │  │
│  └──────────┘  └──────────┘  └────────────────┘  │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ go-git   │  │ Config   │  │ File System    │  │
│  │ (git ops)│  │ Manager  │  │ Watcher        │  │
│  └──────────┘  └──────────┘  └────────────────┘  │
└──────────────────────────────────────────────────┘
         ↕ WebSocket / HTTP
┌──────────────────────────────────────────────────┐
│              React SPA (Browser)                   │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Tab Mgr  │  │ xterm.js │  │ CodeMirror 6   │  │
│  │ (zustand)│  │(terminal)│  │ (editor)       │  │
│  └──────────┘  └──────────┘  └────────────────┘  │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Chat UI  │  │ Git Graph│  │ File Explorer  │  │
│  │(streaming│  │ (SVG)    │  │ (tree view)    │  │
│  └──────────┘  └──────────┘  └────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## Final Tech Stack Summary

| Component | Technology | Why |
|---|---|---|
| CLI + Backend | Go + Cobra | Single binary, embed frontend, fast, easy deploy |
| HTTP Server | Go stdlib `net/http` | No framework needed |
| WebSocket | gorilla/websocket | Battle-tested, Go standard |
| PTY | creack/pty | Terminal spawning |
| Git | go-git | Pure Go, no git binary dep |
| Frontend | React 19 + Vite | Ecosystem, AI SDK demos, component libs |
| Styling | Tailwind CSS + shadcn/ui | Mobile-first, accessible |
| State | zustand | Simple, lightweight |
| Editor | CodeMirror 6 | Mobile-first, 300KB, modular |
| Terminal | xterm.js v5 | Industry standard (VSCode uses it) |
| Git Graph | Custom SVG + D3 basics | No good maintained lib exists |
| Git Diff | diff2html or CM6 merge | Proven solutions |
| AI Chat | Claude CLI process via PTY | Full feature parity with VSCode ext |
| Config | YAML (viper) | Go standard for config |
| Auth | Simple token (VPS) | KISS for personal tool |

---

## Implementation Recommendations

### Quick Start Order
1. Go CLI skeleton (Cobra) + config loading
2. HTTP server + embed empty React app
3. React tab system + routing
4. Terminal tab (xterm.js ↔ WebSocket ↔ PTY)
5. File explorer + CodeMirror editor tab
6. Git operations (status, log, diff)
7. Git graph visualization
8. AI chat integration (claude CLI wrapper)
9. Onboarding flow (`ppm init`)
10. VPS deployment mode

### Common Pitfalls
- Monaco Editor on mobile = broken. Use CodeMirror 6
- Don't use gitgraph.js (archived since 2023)
- PTY resize events must sync between xterm.js and server
- Claude CLI process management: handle crashes, timeouts, cleanup
- WebSocket reconnection logic essential for mobile (network drops)
- `go-git` doesn't support all git features — fallback to `git` binary

---

## References

- [CodeMirror 6 vs Monaco comparison](https://agenthicks.com/research/codemirror-vs-monaco-editor-comparison)
- [Sourcegraph Monaco → CM6 migration](https://sourcegraph.com/blog/migrating-monaco-codemirror)
- [Replit code editor comparison](https://blog.replit.com/code-editors)
- [xterm.js](https://xtermjs.org/)
- [go-git](https://github.com/go-git/go-git)
- [Cobra CLI](https://github.com/spf13/cobra)
- [creack/pty](https://github.com/creack/pty)
- [gorilla/websocket](https://github.com/gorilla/websocket)
- [diff2html](https://github.com/rtfpessoa/diff2html)
- [Claude Agent SDK demos](https://github.com/anthropics/claude-agent-sdk-demos)
- [claudecodeui](https://github.com/siteboon/claudecodeui)
- [shadcn/ui](https://ui.shadcn.com/)

---

## User Decisions (2026-03-14)

1. **Claude Code integration:** Reference projects: [vibe-kanban](https://github.com/BloopAI/vibe-kanban), [claude-code-chat](https://github.com/andrepimenta/claude-code-chat), [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
2. **Git scope:** Basic only (status, log, diff, graph). No advanced features (rebase, submodules)
3. **Auth:** Simple token OK. Design for extensibility (pluggable auth later)
4. **Editor:** CodeMirror 6 confirmed — works well on mobile
5. **PWA:** Yes, will implement PWA (offline caching, add to homescreen)

## Remaining Questions

1. **Claude CLI output parsing:** Exact JSON output format? Need to study vibe-kanban and claude-code-chat implementations
2. **Agent SDK vs CLI wrapping:** Which approach fits better? SDK = more control, CLI = full feature parity
