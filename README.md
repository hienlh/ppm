# PPM - Personal Project Manager

A mobile-first web IDE with AI chat, terminal, git, database tools, and file explorer — all in one browser tab.

[![npm version](https://img.shields.io/npm/v/@hienlh/ppm?style=flat-square)](https://www.npmjs.com/package/@hienlh/ppm)
[![npm downloads](https://img.shields.io/npm/dm/@hienlh/ppm?style=flat-square)](https://www.npmjs.com/package/@hienlh/ppm)
[![npm license](https://img.shields.io/npm/l/@hienlh/ppm?style=flat-square)](https://www.npmjs.com/package/@hienlh/ppm)
[![bun](https://img.shields.io/badge/runtime-bun-black?style=flat-square&logo=bun)](https://bun.sh)

## Quick Start

```bash
# 1. Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash
# or via npm
npm install -g bun

# 2. Run directly (no install needed)
bunx @hienlh/ppm start

# Or install globally
bun add -g @hienlh/ppm
ppm start
```

> **Note:** PPM requires [Bun](https://bun.sh) runtime (uses `bun:sqlite` and native Bun APIs). `npx`/`npm` won't work — use `bunx`/`bun` instead.

On first run, PPM walks you through interactive setup: port, auth password, project scan directory, and AI settings. Config is stored in `~/.ppm/ppm.db` (SQLite).

After setup, open the URL shown in terminal and enter your access password.

## What You Get

- **AI Chat** — Claude AI with tool execution, file attachments, streaming, session history, slash commands
- **Terminal** — Full PTY terminal (xterm.js), multiple sessions per project
- **File Explorer** — Browse, edit, create, delete files with Monaco editor
- **Git** — Status, diff, commit, push/pull, branching, merge, rebase, commit graph
- **Database** — SQLite + PostgreSQL viewer with query editor, data grid, cell editing
- **Notifications** — Web Push + Telegram bot integration
- **Remote Access** — Cloudflare tunnel for public URL sharing (`--share` flag)
- **Command Palette** — Fuzzy search for commands, files, tables (Shift+Shift or F1)
- **PWA** — Installable as a progressive web app
- **Mobile-First** — Responsive UI with bottom sheets and touch optimization

## CLI

```bash
# Server
ppm start                  # Start (background daemon, default port 3210)
ppm start -f               # Foreground mode (for debugging)
ppm start --share          # Start + Cloudflare tunnel for public URL
ppm start -p 4000          # Custom port
ppm stop                   # Stop daemon
ppm restart                # Restart
ppm status                 # Show status
ppm open                   # Open in browser
ppm logs -f                # Tail logs

# Projects
ppm projects list
ppm projects add my-app /path/to/my-app
ppm projects remove my-app

# Git
ppm git status
ppm git log
ppm git commit -m "message"
ppm git push

# Database
ppm db connections         # List DB connections
ppm db query my-db "SELECT * FROM users LIMIT 10"

# Config
ppm config get port
ppm config set port 4000

# Chat (CLI mode)
ppm chat

# Other
ppm init                   # Re-run setup wizard
ppm report                 # File bug report on GitHub
```

## Non-Interactive / AI Agent Setup

For scripts, CI environments, or AI agents that cannot interact with prompts:

```bash
# Step 1: Init without any prompts (uses defaults, auto-generates password)
bunx @hienlh/ppm init -y

# Step 2: Start with Cloudflare tunnel in foreground
bunx @hienlh/ppm start -f --share
```

The `-y` flag skips all prompts and applies these defaults:
- Port: `3210`
- Scan directory: `$HOME`
- Auth: enabled, password auto-generated (printed at end of `init` output)
- AI model: `claude-sonnet-4-6`

Override any default with flags:

```bash
bunx @hienlh/ppm init -y \
  --port 3210 \
  --password "your-password" \
  --scan /path/to/projects \
  --share
```

Once running, the Cloudflare public URL is printed to stdout — parse it to share with users.

## Requirements

- **Bun** v1.3.6+ ([install](https://bun.sh))
- **Git** v2.0+ (for git features)
- **Claude Code** authenticated (`claude` CLI logged in) — for AI chat

## Development

```bash
git clone https://github.com/hienlh/ppm.git
cd ppm && bun install

bun dev:server    # Backend (port 8081, uses dev profile)
bun dev:web       # Vite frontend (port 5173)
bun test          # Run tests
bun run build     # Build frontend + CLI binary -> dist/ppm
```

Dev uses a separate SQLite database (`ppm.dev.db`) from production (`ppm.db`), both in `~/.ppm/`.

For architecture details, API reference, and contribution guidelines, see the [docs](docs/) directory.

## Documentation

| Doc | Purpose |
|-----|---------|
| [Project Overview](docs/project-overview-pdr.md) | Goals, features, decisions |
| [System Architecture](docs/system-architecture.md) | Layers, protocols, data flows |
| [Codebase Summary](docs/codebase-summary.md) | Module responsibilities |
| [Code Standards](docs/code-standards.md) | Conventions and patterns |
| [Deployment Guide](docs/deployment-guide.md) | Installation, config, troubleshooting |
| [Design Guidelines](docs/design-guidelines.md) | UI framework, colors, components |
| [Project Roadmap](docs/project-roadmap.md) | Status and plans |

## Known Gotchas

- **SDK .env poisoning**: Projects with `ANTHROPIC_API_KEY` in `.env` can break SDK tool execution. PPM neutralizes these vars automatically.
- **Windows**: SDK uses CLI fallback (`claude -p`) due to Bun pipe buffering issues. Ensure `claude` is in PATH.

---

**Issues:** [GitHub](https://github.com/hienlh/ppm/issues)
