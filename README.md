# PPM - Personal Project Manager

A mobile-first web IDE with AI chat, terminal, git, database tools, and file explorer — all in one browser tab.

[![npm version](https://img.shields.io/npm/v/@hienlh/ppm?style=flat-square)](https://www.npmjs.com/package/@hienlh/ppm)
[![npm downloads](https://img.shields.io/npm/dm/@hienlh/ppm?style=flat-square)](https://www.npmjs.com/package/@hienlh/ppm)
[![GitHub Downloads](https://img.shields.io/github/downloads/hienlh/ppm/total?style=flat-square&label=binary%20downloads)](https://github.com/hienlh/ppm/releases)
[![npm license](https://img.shields.io/npm/l/@hienlh/ppm?style=flat-square)](https://www.npmjs.com/package/@hienlh/ppm)
[![bun](https://img.shields.io/badge/runtime-bun-black?style=flat-square&logo=bun)](https://bun.sh)

## Demo

<table>
  <tr>
    <th>Desktop</th>
    <th>Mobile</th>
  </tr>
  <tr>
    <td width="70%"><img src="https://raw.githubusercontent.com/hienlh/ppm/main/docs/media/ppm-demo-desktop.gif" alt="PPM desktop demo" /></td>
    <td width="30%"><img src="https://raw.githubusercontent.com/hienlh/ppm/main/docs/media/ppm-demo-mobile.gif" alt="PPM mobile demo" /></td>
  </tr>
</table>

> Full-quality MP4: [desktop](https://raw.githubusercontent.com/hienlh/ppm/main/docs/media/ppm-demo-desktop.mp4) · [mobile](https://raw.githubusercontent.com/hienlh/ppm/main/docs/media/ppm-demo-mobile.mp4)

## Quick Start

Two ways to install:

- **Binary** — no dependencies, bundles its own runtime. Best for new users.
- **Via Bun** — requires the [Bun](https://bun.sh) runtime installed first (`bunx` / `bun add -g` / non-interactive setup all need it).

### Binary (no dependencies)

**macOS / Linux:**
```bash
curl -fsSL https://ppm.sh/install | sh
```

**Windows (PowerShell):**
```powershell
irm https://ppm.sh/install.ps1 | iex
```

Downloads the latest binary, adds to PATH, and shows next steps. To upgrade, run the same command again (or `ppm upgrade`).

### Via Bun

```bash
# 1. Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash

# 2. Run directly (no install needed)
bunx @hienlh/ppm start

# Or install globally
bun add -g @hienlh/ppm
ppm start
```

> **Note:** The `bunx`/`bun` method requires [Bun](https://bun.sh) runtime. The binary install method has no dependencies.

On first run, PPM walks you through interactive setup: port, auth password, project scan directory, and AI settings. Config is stored in `~/.ppm/ppm.db` (SQLite).

After setup, open the URL shown in terminal and enter your access password.

## What You Get

### AI

- **AI Chat** — tool execution, file attachments, streaming, session history, search, branching, drafts. Chat output is durable: leave the tab, come back, the turn is still there.
- **Multiple AI providers** — Claude Agent SDK built in; [OpenAI Codex](https://github.com/openai/codex) and Cursor CLI register themselves when their binaries are installed. Pick provider, model, reasoning effort and permission mode per session.
- **Slash commands, skills, subagents** — the skills, commands and plugin items in your `~/.claude` directory are discovered and runnable from chat.
- **Agent teams** — a live panel of who is working, the step they are on, elapsed time and model; open any teammate to replay its whole work session.
- **Group chat** — a multi-agent group conversation where several agents answer in turns.
- **MCP servers** — add, edit and import MCP servers (auto-imports from `~/.claude.json`).
- **Scheduled agents** — cron jobs inside PPM that wake a session to work unattended, with turn/timeout budgets and a summary notification.
- **Multi-account** — store several Claude/Codex accounts, rotate on cooldown, track usage.
- **API proxy** — expose your accounts as an Anthropic-compatible (and OpenAI-compatible) endpoint under `/proxy/v1/*`, guarded by its own auth key, with request logging.

### Workspace

- **Terminal** — full PTY terminal (xterm.js), multiple sessions per project, plus a dock terminal you can open on any folder. Send a code block from chat into a terminal, and terminal output back into chat.
- **Editor** — Monaco with syntax highlighting, plus viewers for images, PDF, CSV and video (unsupported video formats are transcoded on the fly).
- **Project explorer** — browse, edit, create, delete, upload (per-file progress, collision prompts) and drag-and-drop files across registered projects.
- **OS File Explorer** — a floating, resizable, multi-instance window that browses the whole machine: drives, known folders and the pinned folders of your OS; List/Icons/Column views; Cut/Copy/Paste, Rename, Trash, Properties; drag between windows. Full-screen sheet on mobile.
- **Git** — status, diff, stage, commit, push/pull, branches, merge, rebase, stash, worktrees, an interactive commit graph, and an inline conflict-resolution editor.
- **Database** — SQLite + PostgreSQL viewer with query editor, data grid, cell editing, and a query audit log. External `.db`/`.sqlite` files open in the same viewer.
- **System Monitor** — a task manager for the whole machine: CPU per core, RAM, disk, network and NVIDIA GPU charts, plus every process grouped by app with live usage. End a process or a whole app; PPM's own and OS-critical processes are refused.
- **Floating windows** — Explorer and System Monitor open as windows, and any tab can be popped out into one without reloading its state. Chrome/Edge can send a window into always-on-top picture-in-picture.
- **Extensions** — VSCode-compatible npm extensions run in isolated Bun workers, contributing tree views, webviews, quick picks and status bar items. See the [extension guide](docs/extension-development-guide.md).

### Access & integrations

- **Remote access** — a Cloudflare tunnel gives your machine a public URL (always enabled). Port forwarding opens a tunnel for any localhost dev server.
- **PPM Cloud** *(optional)* — permanent private link to each machine, phone dashboard to see and open them, remote restart. Stores only your email, machine names and their tunnel URLs — never your code or chats. PPM works fully without it.
- **Telegram bot (PPMBot)** — a coordinator chat that delegates project tasks to agents, keeps its own memory, and reports back.
- **Jira** — per-project credentials plus watchers that poll JQL searches and notify you on new results.
- **Notifications** — cloud push and Telegram when a turn finishes, needs approval, or asks a question.

### The app itself

- **Command palette** — fuzzy search for commands, files, tables (Shift+Shift or F1).
- **Themes** — built-in themes plus import of VSCode themes by URL or `.vsix`.
- **Stays up** — a supervisor keeps the server alive, checks for new versions, and self-replaces on a one-click upgrade. `ppm autostart` registers it at login.
- **PWA** — installable as a progressive web app.
- **Mobile-first** — responsive UI with bottom sheets, long-press menus and touch optimization.

## CLI

```bash
# Server
ppm start                  # Start (background daemon, port 3210, tunnel auto-enabled)
ppm start -p 4000          # Custom port
ppm stop                   # Stop the server (supervisor stays alive)
ppm down                   # Full shutdown (supervisor + server + tunnel)
ppm restart                # Restart, keeping the tunnel alive
ppm status                 # Show status (--json for machine-readable)
ppm open                   # Open in browser
ppm logs -f                # Tail logs
ppm upgrade                # Install updates (--check to only look)
ppm autostart enable       # Start PPM at login (also: disable, status)

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
ppm db list                            # Configured connections
ppm db tables my-db
ppm db query my-db "SELECT * FROM users LIMIT 10"
ppm db run my-db ./migration.sql

# Chat
ppm chat list
ppm chat create
ppm chat send <session-id> "message"
ppm chat resume <session-id>

# Scheduled agents
ppm schedule add
ppm schedule list
ppm schedule run-now <id>
ppm schedule runs <id>

# Extensions & skills
ppm ext list
ppm ext install <name>
ppm ext dev /path/to/extension
ppm skills list
ppm skills search <query>

# Integrations
ppm cloud login            # PPM Cloud (also: status, devices, alias, logout)
ppm bot status             # Telegram coordinator (delegate, tasks, memory, ...)
ppm jira config set <project>

# Config
ppm config get port
ppm config set port 4000

# Other
ppm init                   # Re-run setup wizard
ppm export skill           # Export the PPM skill for Claude Code
ppm report                 # File bug report on GitHub
```

## Non-Interactive / AI Agent Setup

For scripts, CI environments, or AI agents that cannot interact with prompts:

> **Prerequisite:** This method uses `bunx`, so [Bun](https://bun.sh) must be installed first (`curl -fsSL https://bun.sh/install | bash`). If you can't install Bun, use the dependency-free [Binary](#binary-no-dependencies) install instead.

```bash
# Step 1: Init without any prompts (uses defaults, auto-generates password)
bunx @hienlh/ppm init -y

# Step 2: Start — runs as a background daemon with the Cloudflare tunnel
bunx @hienlh/ppm start
```

The `-y` flag skips all prompts and applies these defaults:
- Port: `3210`
- Scan directory: `$HOME`
- Auth: enabled, password auto-generated (printed at end of `init` output)
- AI model: `claude-opus-5`

Override any default with flags:

```bash
bunx @hienlh/ppm init -y \
  --port 3210 \
  --password "your-password" \
  --scan /path/to/projects
```

`start` waits for the tunnel, prints the public URL as `➜  Share:   <url>` and exits. To read it back later in a script, use `ppm status --json` and take the `shareUrl` field.

## Use with Claude Code

Install the PPM skill so Claude Code (and other compatible AI agents) can control PPM via its CLI, HTTP API, and SQLite config DB:

```bash
ppm export skill --install
# Installs to ~/.claude/skills/ppm/ (use --scope project for per-project install).
```

Then in Claude Code: `/ppm list my projects` → Claude invokes `ppm projects list` automatically. Re-run any time to refresh (existing files are backed up with a `.bak-<timestamp>` suffix). Requires PPM v0.13.0+.

## Requirements

- **Bun** v1.3.6+ ([install](https://bun.sh)) — not needed for the binary install, which bundles its own runtime
- **Git** v2.0+ (for git features)
- **Claude Code** authenticated (`claude` CLI logged in) — for AI chat
- *Optional:* `@openai/codex` or `cursor-agent` on PATH to enable those providers

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
| [Extension Development](docs/extension-development-guide.md) | Building PPM extensions |
| [Project Roadmap](docs/project-roadmap.md) | Status and plans |
| [Changelog](CHANGELOG.md) | Release-by-release changes |

## Known Gotchas

- **SDK .env poisoning**: Projects with `ANTHROPIC_API_KEY` in `.env` can break SDK tool execution. PPM neutralizes these vars automatically.
- **Claude CLI discovery**: PPM looks for the `claude` CLI on PATH, in the usual install locations, and in the `cli/` folder shipped beside the binary. If none is found, point at it with `PPM_CLAUDE_CLI=/path/to/claude`.
- **Project Claude settings**: a project's `.claude/settings.local.json` can restrict tools even under bypass permissions; PPM overrides it with empty settings so chat tools keep working.

---

**Issues:** [GitHub](https://github.com/hienlh/ppm/issues)
