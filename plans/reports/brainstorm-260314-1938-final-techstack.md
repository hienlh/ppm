# PPM Final Tech Stack Decision

**Date:** 2026-03-14
**Status:** Approved

---

## Project Overview

PPM (Personal Project Manager) — mobile-first web-based tool to manage code projects from phone/browser. Runs as CLI, serves web UI, deployable to VPS or accessible via Tailscale.

---

## Requirements

### Core

- **Mobile-first UI:** Ưu tiên mobile UX, có thể làm việc hoàn toàn từ điện thoại
- **CLI gateway:** Chạy background như daemon, serve web UI (giống openclaw pattern)
- **Tab system:** Mọi thứ mở trong tab giống VSCode — terminal, chat, editor, git graph, git diff, settings
- **PWA:** Installable trên điện thoại, offline UI shell caching

### Project Management

- **Project list:** Xem các folder project đã add vào
- **Auto-scan:** Khi `ppm init`, quét folder có `.git` và gợi ý add vào
- **File explorer:** Duyệt file tree trong project
  - CRUD: tạo, xóa, rename, move files/folders
  - Select 2 files để compare (diff) giống VSCode
  - Drag & drop support (nice-to-have)

### Code Editor

- **Syntax highlighting:** Xem và sửa code trong browser
- **Autocomplete:** Không bắt buộc nhưng dùng CM6 built-in autocomplete nếu có sẵn
- **File compare:** Mở diff view khi select 2 files từ explorer

### Git Integration

- **Git graph:** Visualize commit history — giống [vscode-git-graph](https://github.com/mhutchie/vscode-git-graph)
  - **Rendering:** SVG-based (same approach as vscode-git-graph: SVG paths for branch lines, SVG circles for commit nodes, color-coded lanes)
  - **Data:** `git log --format=<custom>` + `git branch` + `git for-each-ref` (parsed server-side, sent as JSON)
  - **Context menu actions on commits:** Checkout, Cherry Pick, Revert, Create Branch, Create Tag, Copy Hash
  - **Context menu actions on branches:** Checkout, Merge into current, Delete, Rename, Push, Pull, Rebase
  - **PR:** Mở browser URL tới GitHub/GitLab create PR page (không dùng `gh` CLI)
  - **Branch visualization:** Lane allocation algorithm — mỗi branch 1 lane, color rotation, merge/fork lines
- **Git diff:** Xem thay đổi giữa commits/branches (CodeMirror 6 merge view)
- **Git status panel:**
  - Xem files changed (modified, added, deleted)
  - Xem files staged vs unstaged
  - Stage/unstage individual files
  - Commit input box + commit button
  - Push/pull buttons
- **Git blame:** (nice-to-have) inline blame annotations

### CLI (AI/Automation-friendly)

- **Mục đích:** CLI cho AI agents và automation điều khiển PPM, không cần CLI cho mọi feature
- **Project resolution:** CWD auto-detect (nếu trong registered project) + `-p <name>` flag override
  ```bash
  ppm git status              # auto-detect từ CWD
  ppm git status -p my-app    # explicit project
  ```

**CLI commands (chỉ những gì AI cần):**
- `ppm init` — onboarding wizard
- `ppm start [-d] [-c config.yaml]` / `ppm stop` — server lifecycle
- `ppm open` — mở browser tới web UI
- `ppm projects list|add|remove`
- `ppm config get|set`
- `ppm git status|log|diff` — đọc git state
- `ppm git stage|unstage|commit|push|pull` — git write actions
- `ppm git branch create|checkout|delete|merge`
- `ppm chat create|list|resume|delete|send` — AI-to-AI orchestration

**Không cần CLI (web-only hoặc đã có native CLI):**
- File operations → AI dùng `ls`, `cat`, `mv`, `rm` trực tiếp
- Terminal management → web-only feature
- Git graph visual → web-only
- Cherry-pick, revert, tag, rebase → AI dùng `git` CLI trực tiếp

### Terminal

- **Web terminal:** Mở terminal thật trong tab, tương tác đầy đủ với shell

### AI Chat

- **Claude Code integration:** Tương tác giống hệt Claude Code extension trên VSCode
- **Multi-provider:** Generic interface, bắt đầu với Claude, mở rộng sang provider khác sau
- **Session management:** CRUD sessions — tạo, xem, resume, xóa
- **Multi-tab chat:** Mở nhiều chat sessions cùng lúc trên nhiều tab
- **Tool approvals:** Hiển thị và xử lý tool permission requests trong UI

### Deployment

- **Local:** `ppm init` → onboarding wizard → tạo config → `ppm start`
- **VPS:** Copy binary + config file → `ppm start -c config.yaml` (không cần onboarding)
- **Tailscale:** Chạy local, truy cập từ xa qua Tailscale IP
- **Single binary:** Deploy dễ dàng, không cần runtime

### Open Source

- **OSS-friendly:** MIT/Apache 2.0 license
- **Cross-platform:** Build binaries cho Linux, macOS (ARM + x64)
- **Extensible:** Community có thể contribute AI providers, themes, plugins

---

## Tech Stack

### Backend


| Component      | Technology                         | Version | Why                                                                                        |
| -------------- | ---------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| Runtime        | **Bun**                            | 1.2+    | Single binary (`bun build --compile`), native TS, fast startup (~30ms), built-in WebSocket |
| HTTP Framework | **Hono**                           | 4.x     | 14KB, fastest TS framework, runtime-agnostic                                               |
| CLI            | **Commander.js**                   | 13.x    | Simple, proven CLI framework                                                               |
| Config         | **js-yaml**                        | 4.x     | Parse ppm.yaml config                                                                      |
| PTY (terminal) | **node-pty**                       | 1.x     | Spawn real shell processes, battle-tested                                                  |
| Git            | **simple-git**                     | 3.x     | Wrapper over git binary, simple API                                                        |
| AI Chat        | **@anthropic-ai/claude-agent-sdk** | latest  | Claude Code as library — first provider                                                    |
| WebSocket      | **Bun built-in**                   | —       | No extra dependency needed                                                                 |


### Frontend


| Component  | Technology                 | Version | Why                                          |
| ---------- | -------------------------- | ------- | -------------------------------------------- |
| Framework  | **React**                  | 19.x    | Largest ecosystem, Agent SDK demos use React |
| Build      | **Vite**                   | 6.x     | Fast HMR, tree-shaking, code splitting       |
| Styling    | **Tailwind CSS**           | 4.x     | Mobile-first utility classes                 |
| Components | **shadcn/ui**              | latest  | Accessible, customizable, Radix UI based     |
| State      | **zustand**                | 5.x     | Lightweight (~1KB), simple API               |
| Editor     | **CodeMirror 6**           | 6.x     | Mobile-first (300KB), modular, touch support |
| Terminal   | **xterm.js**               | 5.x     | Industry standard (VSCode uses it)           |
| Git Diff   | **diff2html**              | 3.x     | Parse unified diff → HTML                    |
| Git Graph  | **Custom SVG**             | —       | No good maintained lib, build with basic SVG |
| PWA        | **vite-plugin-pwa**        | latest  | Service worker, offline shell, installable   |
| Panels     | **react-resizable-panels** | latest  | Split panes for tab layout                   |


### Infrastructure


| Component         | Technology                | Why                                               |
| ----------------- | ------------------------- | ------------------------------------------------- |
| Deploy (binary)   | `bun build --compile`     | Single executable, copy to VPS                    |
| Deploy (fallback) | Docker                    | If native addon (node-pty) fails with bun compile |
| Background daemon | Built-in (detach process) | `ppm start -d`                                    |
| Remote access     | Tailscale / direct VPS    | Zero config networking                            |
| Auth              | Simple token header       | Extensible to OAuth later                         |


---

## Architecture

```
ppm (single binary)
│
├── CLI Layer (Commander.js) — calls same Service Layer as API
│   │   Project resolution: CWD auto-detect + `-p <name>` override
│   ├── ppm init / start / stop / open
│   ├── ppm projects list|add|remove
│   ├── ppm config get|set
│   ├── ppm git status|log|diff|stage|unstage|commit|push|pull
│   ├── ppm git branch create|checkout|delete|merge
│   └── ppm chat create|list|resume|delete|send
│
├── Server Layer (Hono + Bun) — thin wrapper over Service Layer
│   ├── GET /                 # Serve React SPA (embedded)
│   ├── GET /api/projects     # List managed projects
│   ├── CRUD /api/files/*     # File tree + read/write/create/delete/rename/move
│   ├── GET /api/git/*        # Git status, log, diff, graph
│   ├── POST /api/git/*       # Stage, unstage, commit, push, pull, branch ops
│   ├── WS  /ws/terminal/:id  # PTY sessions (xterm.js ↔ node-pty)
│   └── WS  /ws/chat/:id      # AI chat sessions (streaming)
│
├── Service Layer (shared business logic)
│   ├── project.service.ts     # Project CRUD
│   ├── file.service.ts        # File operations
│   ├── git.service.ts         # All git operations (simple-git)
│   ├── terminal.service.ts    # PTY management
│   └── chat.service.ts        # AI provider sessions
│
├── AI Provider Layer (generic)
│   ├── provider.interface.ts  # AIProvider interface
│   ├── claude-agent-sdk.ts    # Claude adapter (first)
│   ├── cli-subprocess.ts      # Generic CLI adapter (future: Gemini, Aider...)
│   └── registry.ts            # Provider registry + factory
│
├── Terminal Manager
│   └── node-pty pool ↔ WebSocket bridge
│
├── Git Service (simple-git)
│   └── status, log, diff, graph data extraction
│
└── Config (js-yaml)
    └── ppm.yaml
```

### AI Provider Interface (generic, multi-provider ready)

```typescript
interface AIProvider {
  id: string;
  name: string;
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: string): Promise<Session>;
  listSessions(): Promise<SessionInfo[]>;
  deleteSession(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent>;
  onToolApproval?: (callback: ToolApprovalHandler) => void;
}

type ChatEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; tool: string; input: any }
  | { type: 'tool_result'; output: string }
  | { type: 'approval_request'; tool: string; input: any }
  | { type: 'error'; message: string }
  | { type: 'done'; sessionId: string }
```

### Frontend Tab System

```
┌─────────────────────────────────────────────┐
│ [Projects] [Terminal 1] [Chat: main] [app.ts]│
├─────────────────────────────────────────────┤
│          Active Tab Content                  │
│   (lazy-loaded per tab type)                 │
└─────────────────────────────────────────────┘

Tab types: projects | terminal | chat | editor | git-graph | git-diff | settings
Each tab = { id, type, title, metadata, component }
State managed by zustand
Mobile: scrollable tab bar, swipe gestures
```

---

## Config File (ppm.yaml)

```yaml
port: 8080
host: 0.0.0.0
auth:
  enabled: true
  token: "your-secret-token"
projects:
  - path: /home/user/project-a
    name: Project A
  - path: /home/user/project-b
    name: Project B
ai:
  default_provider: claude
  providers:
    claude:
      type: agent-sdk
      api_key_env: ANTHROPIC_API_KEY  # Read from env var
    # Future:
    # gemini:
    #   type: cli
    #   command: gemini
```

---

## Key Design Decisions

1. **Bun over Go:** Agent SDK is TypeScript-only → single runtime, no sidecar complexity
2. **Bun over Node.js:** `bun build --compile` for single binary, 3-5x faster startup
3. **Hono over Express:** 14KB vs 200KB+, faster, modern API
4. **CodeMirror 6 over Monaco:** Mobile-first (300KB vs 5-10MB), touch native
5. **simple-git over go-git:** Same runtime, proven wrapper, basic ops sufficient
6. **Provider adapter pattern:** Start with Claude, extend to any AI tool later
7. **zustand over Redux:** 1KB, zero boilerplate, perfect for tab state
8. **PWA:** Installable on phone, offline UI shell caching
9. **WebSocket only (no Socket.IO, no SSE):** Terminal requires bidirectional binary; chat needs bidirectional for tool approvals; Bun has WS built-in = zero deps, one protocol for everything
10. **Open-source:** MIT/Apache 2.0 license, CI/CD for cross-platform binaries, contributor-friendly stack

---

## Risk Register


| Risk                                      | Impact                   | Mitigation                                                       |
| ----------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| node-pty fails with `bun build --compile` | Can't ship single binary | Fallback: Docker container or Node.js runtime                    |
| Agent SDK incompatible with Bun           | Chat feature broken      | Test early (Phase 1). Fallback: run SDK in Node.js child process |
| CodeMirror 6 keyboard issues on iOS       | Bad mobile editing UX    | Test early on real device. CM6 known to work well on mobile      |
| WebSocket drops on mobile network         | Lost terminal/chat state | Auto-reconnect logic + session resume                            |


---

## Realtime Communication

**Decision: WebSocket only** (no Socket.IO, no SSE)


| Connection                           | Direction             | Protocol              |
| ------------------------------------ | --------------------- | --------------------- |
| Terminal (xterm.js ↔ PTY)            | Bidirectional, binary | WS `/ws/terminal/:id` |
| AI Chat (streaming + tool approvals) | Bidirectional         | WS `/ws/chat/:id`     |
| File/git watcher (optional)          | Server→Client         | WS `/ws/events`       |


**Why not Socket.IO:** +45KB client bundle, rooms/namespaces not needed, overkill.
**Why not SSE:** Terminal & chat both need bidirectional. Mixing SSE+HTTP POST = more complexity than single WS.
**Why WebSocket:** Bun built-in (zero deps), one protocol for all realtime, binary frame support for terminal.

---

## Open Source Considerations


| Item           | Detail                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| License        | MIT or Apache 2.0                                                       |
| Config         | `.env.example` + `ppm.yaml` schema validation                           |
| CI/CD          | GitHub Actions — build binaries for linux-x64, darwin-arm64, darwin-x64 |
| Cross-platform | `bun build --compile --target=bun-{platform}-{arch}`                    |
| Plugin docs    | Guide for contributing new AI providers                                 |
| node-pty       | Prebuilt binaries in CI for each platform                               |


---

## References

- [Tech stack research](../reports/research-260314-1911-ppm-tech-stack.md)
- [Claude Code integration research](../reports/research-260314-1930-claude-code-integration.md)
- [Claude Agent SDK docs](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Hono](https://hono.dev)
- [CodeMirror 6](https://codemirror.net)
- [xterm.js](https://xtermjs.org)
- [simple-git](https://github.com/steveukx/git-js)

