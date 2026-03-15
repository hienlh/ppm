# PPM — Personal Project Manager

A **mobile-first web IDE** for managing code projects with AI-powered assistance. Built on Bun, React, and Hono.

```
┌─────────────────────────────────────────────────────────┐
│  File Explorer │  Code Editor  │  Terminal  │  Chat      │
│   + Git        │  + Diff View  │  Full PTY  │  + Tools   │
└─────────────────────────────────────────────────────────┘
         ↓
   Claude AI Integration
   (streaming, file attachments, tool use)
```

## Features

- **📁 File Explorer** — Browse, create, edit, delete files with syntax highlighting
- **🖥️ Terminal** — Full xterm.js with Bun PTY, multiple sessions per project
- **💬 AI Chat** — Stream Claude AI with file attachments, slash commands, tool execution
- **🔧 Git Integration** — Status, diffs, commits, branching with visual graph
- **📱 Mobile-First** — Responsive design optimized for mobile, tablet, and desktop
- **🔐 Authentication** — Token-based auth with auto-generated tokens
- **💾 PWA** — Installable web app with offline support
- **⚡ Fast** — Built on Bun runtime, sub-200ms API responses

## Quick Start

### Prerequisites
- **Bun:** v1.3.6+ ([install](https://bun.sh))
- **Git:** v2.0+ (for git operations)
- **Node.js:** Optional (if using terminal to run npm commands)

### Installation

#### Option 1: Build from Source
```bash
# Clone & install
git clone https://github.com/hienlh/ppm.git
cd ppm
bun install

# Build
bun run build

# Run
./dist/ppm start
```

#### Option 2: Pre-built Binary
```bash
# Download from releases
wget https://github.com/hienlh/ppm/releases/download/v2.0/ppm-macos-x64
chmod +x ppm-macos-x64
sudo mv ppm-macos-x64 /usr/local/bin/ppm

# Run
ppm start
```

### First-Time Setup

```bash
# Initialize config (scan for git repos)
ppm init

# Start server (foreground)
ppm start

# Or daemon mode
ppm start --daemon

# Open browser
ppm open
# → http://localhost:8080
```

### Usage

1. **Enter auth token** from `ppm.yaml` or terminal output
2. **Select a project** from the sidebar
3. **Browse files** in file explorer
4. **Open terminal** or **chat with Claude**
5. **Stage & commit** via git panel

## Development Setup

```bash
# Install dependencies
bun install

# Hot reload CLI
bun run dev

# Hot reload frontend (separate terminal)
bun run dev:web

# Type check
bun run typecheck

# Build
bun run build

# Run tests
bun test
```

## Project Structure

```
src/
├── index.ts                 # CLI entry point
├── cli/commands/            # ppm start, init, projects, git, chat
├── server/                  # Hono HTTP server, WebSocket handlers
├── services/                # Business logic (chat, git, files, terminal)
├── providers/               # AI provider adapters (Claude SDK, CLI fallback)
├── types/                   # TypeScript interfaces
└── web/                     # React frontend (Vite)
    ├── components/          # React UI components
    ├── stores/              # Zustand state (project, tab, file, settings)
    ├── hooks/               # Custom hooks (useChat, useTerminal, useWebSocket)
    ├── lib/                 # Utilities (API client, file detection)
    └── styles/              # Tailwind CSS
```

**See [`docs/codebase-summary.md`](docs/codebase-summary.md) for detailed structure.**

## Configuration

### Config File (`ppm.yaml`)

Auto-generated on `ppm init`:

```yaml
port: 8080
host: 0.0.0.0
auth:
  enabled: true
  token: "auto-generated-token"
projects:
  - name: my-project
    path: /path/to/my-project
providers:
  default: claude-agent-sdk
```

### Environment Variables

```bash
export PPM_PORT=8080
export PPM_AUTH_TOKEN="my-token"
export ANTHROPIC_API_KEY="sk-ant-..."  # For Claude integration
ppm start
```

**See [`docs/deployment-guide.md`](docs/deployment-guide.md) for detailed config options.**

## Build & Deployment

### Development
```bash
bun run dev          # CLI with hot reload
bun run dev:web      # Frontend dev server (http://localhost:5173)
```

### Production
```bash
bun run build        # Compile CLI binary to dist/ppm
./dist/ppm start     # Run compiled binary
```

### Daemon Mode
```bash
ppm start --daemon   # Background process
ppm stop             # Graceful shutdown
```

### systemd (Linux)
```bash
sudo cp dist/ppm /usr/local/bin/
# Create systemd service file (see docs/deployment-guide.md)
sudo systemctl start ppm
```

**See [`docs/deployment-guide.md`](docs/deployment-guide.md) for full deployment instructions.**

## API Overview

### REST Endpoints

```
GET    /api/health                      # Health check
GET    /api/projects                    # List projects
POST   /api/projects                    # Create project
DELETE /api/projects/:name              # Delete project

GET    /api/project/:name/chat/sessions # Chat sessions
POST   /api/project/:name/chat/sessions # Create session
GET    /api/project/:name/git/status    # Git status
POST   /api/project/:name/git/commit    # Commit changes
GET    /api/project/:name/files/tree    # File tree
PUT    /api/project/:name/files/write   # Write file
```

### WebSocket

```
WS /ws/project/:name/chat/:sessionId    # Chat streaming
WS /ws/project/:name/terminal/:id       # Terminal I/O
```

**See [`docs/system-architecture.md`](docs/system-architecture.md) for detailed architecture.**

## Code Standards

- **TypeScript strict mode** — Full type safety
- **ESLint + Prettier** — Code formatting (run before commit)
- **Conventional commits** — Clear commit history
- **Unit + integration tests** — Verify functionality

**See [`docs/code-standards.md`](docs/code-standards.md) for detailed conventions.**

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Runtime** | Bun | 1.3.6+ |
| **Backend** | Hono | 4.12.8 |
| **Frontend** | React | 19.2.4 |
| **State** | Zustand | 5.0 |
| **Editor** | CodeMirror | 6.0 |
| **Terminal** | xterm.js | 6.0 |
| **UI** | Tailwind + Radix + shadcn | Latest |
| **AI** | Claude Agent SDK | 0.2.76 |
| **Build** | Vite | 8.0 |

## Documentation

- **[Project Overview & PDR](docs/project-overview-pdr.md)** — Goals, features, decisions
- **[Codebase Summary](docs/codebase-summary.md)** — Architecture, module responsibilities
- **[Code Standards](docs/code-standards.md)** — Conventions, patterns, best practices
- **[System Architecture](docs/system-architecture.md)** — Layers, protocols, data flows
- **[Project Roadmap](docs/project-roadmap.md)** — v2 status, v3 plans, known issues
- **[Deployment Guide](docs/deployment-guide.md)** — Installation, configuration, troubleshooting
- **[Design Guidelines](docs/design-guidelines.md)** — UI framework, colors, components

## Requirements

### System
- macOS or Linux (Windows support planned for v3)
- 512 MB RAM minimum, 2 GB recommended
- 500 MB disk space

### Software
- Bun v1.3.6+
- Git v2.0+
- Node.js (optional, for running npm commands in terminal)

### API Access (Optional)
- **Anthropic API key** for Claude integration
  - Set `ANTHROPIC_API_KEY` environment variable
  - Or use Claude CLI fallback (offline mode)

## Known Issues

### v2.0
- **Terminal on Windows** — Bun PTY may not work; requires node-pty or WSL
- **Large files** — Files >10MB not streamed; should chunk reads
- **Git performance** — Large repos may slow down graph rendering
- **Session persistence** — Chat history lost on server restart (not persisted)

See [Roadmap](docs/project-roadmap.md#known-issues--gaps-v2) for full list.

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m "feat: add amazing feature"`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

**See [`docs/code-standards.md`](docs/code-standards.md) for contribution guidelines.**

## Roadmap

### v2.0 (In Progress)
- [x] Multi-project support
- [x] Project-scoped APIs
- [x] File attachments in chat
- [ ] Complete test coverage (60% done)

### v3.0 (Planned Q2 2026)
- [ ] Collaborative editing (multi-user)
- [ ] Custom tool registry
- [ ] Plugin architecture
- [ ] Windows support

**See [Project Roadmap](docs/project-roadmap.md) for detailed timeline.**

## Troubleshooting

### Port Already in Use
```bash
# Use different port
ppm start --port 3000
```

### Git Commands Failing
```bash
# Verify git is installed
git --version

# Verify project is git repository
cd /path/to/project && git status
```

### Claude Not Responding
```bash
# Check API key
echo $ANTHROPIC_API_KEY

# Try fallback provider
ppm config set providers.default claude-code-cli
```

**See [`docs/deployment-guide.md`](docs/deployment-guide.md#troubleshooting) for full troubleshooting.**

## License

MIT License — See LICENSE file for details.

## Acknowledgments

Built with:
- [Bun](https://bun.sh) — Fast JavaScript runtime
- [Hono](https://hono.dev) — Lightweight web framework
- [React](https://react.dev) — UI library
- [CodeMirror](https://codemirror.net) — Code editor
- [xterm.js](https://xtermjs.org) — Terminal emulator
- [Anthropic Claude](https://anthropic.com) — AI model
- [Tailwind CSS](https://tailwindcss.com) — Utility CSS
- [Radix UI](https://www.radix-ui.com) — Accessible components

---

**Questions?** Open an issue on [GitHub](https://github.com/hienlh/ppm/issues).

**Want to contribute?** See [Code Standards](docs/code-standards.md#contributing) for guidelines.
