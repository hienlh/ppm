# PPM Deployment Guide

## Prerequisites

### System Requirements
- **OS:** macOS, Linux or Windows (all three are supported targets)
- **RAM:** 512 MB minimum, 2 GB recommended
- **Disk:** ~500 MB for the binary, plus ~15 MB for the cloudflared binary PPM downloads on first start
- **Network:** localhost is enough; internet access is needed for the tunnel and for AI providers

### Required Software
- **Bun** v1.3.6+ (https://bun.sh) — **only** for the `bunx`/`bun add -g`/from-source paths. The
  released binary bundles its own runtime and needs nothing installed.
- **Git** v2.0+ — for the git features
- **Claude Code** (`claude` CLI, logged in) — for AI chat via the Claude Agent SDK

### Optional
- `@openai/codex` or `cursor-agent` on PATH — each registers an extra AI provider when present
- `ffmpeg` — on-the-fly transcoding for video formats the browser cannot play
- `psql` / a PostgreSQL server — for the Postgres side of the database viewer

---

## Installation

### Option 1: Installer script (recommended)

**macOS / Linux:**
```bash
curl -fsSL https://ppm.sh/install | sh
```

**Windows (PowerShell):**
```powershell
irm https://ppm.sh/install.ps1 | iex
```

Downloads the matching release archive, unpacks it to `~/.ppm/bin` (override with `PPM_INSTALL_DIR`)
and adds it to PATH. Re-run to upgrade, or use `ppm upgrade`.

### Option 2: Via Bun

```bash
bunx @hienlh/ppm start        # run without installing
bun add -g @hienlh/ppm        # or install globally
```

### Option 3: Build from source (development)

```bash
git clone https://github.com/hienlh/ppm.git
cd ppm
bun install
bun run build          # frontend + compiled binary → dist/ppm
./dist/ppm start
```

---

## Configuration

### Initial Setup

```bash
ppm init          # interactive wizard
ppm init -y       # non-interactive: defaults + auto-generated password
```

Writes `~/.ppm/ppm.db` (SQLite) and generates an auth token. `ppm start` runs the wizard
automatically if no config exists.

### Dev vs Production Config

| Profile | Database | Conventional port |
|---|---|---|
| Production | `~/.ppm/ppm.db` | 3210 (what `ppm init` writes) |
| Development | `~/.ppm/ppm.dev.db` | 8081 |

`bun dev:server` selects the dev database via the `dev` profile; `ppm start --profile dev` does the
same for a compiled binary. On a new machine run `ppm init`, then `ppm config set port 8081` for dev.

> Both databases live in the same directory, and so does `.server-port`. Running `dev:server` while
> production is up can therefore steal the tunnel's route — stop one before starting the other.

### Config Structure (SQLite)

Config lives in the `config` table as dotted key/value pairs. The shape is defined by
`DEFAULT_CONFIG` in `src/types/config.ts` — that struct is the source of truth:

```
port                              8080   ← struct default; `ppm init` writes 3210
host                              0.0.0.0
theme.style / theme.mode          aurora / system
auth.enabled / auth.token         true / auto-generated
ai.default_provider               claude
ai.providers.claude.model         claude-opus-5
ai.providers.claude.effort        high
ai.providers.claude.permission_mode   bypassPermissions
```

Projects, accounts, sessions, schedules, usage and audit logs each live in their own table.

Never build a `~/.ppm` path by hand in service code — import `getPpmDir()` from
`src/services/ppm-dir.ts` so `PPM_HOME` can redirect it in tests.

### Customize Configuration

```bash
# Port
ppm config set port 3000
ppm start -p 3000                  # or per-start

# Projects
ppm projects add my-project /path/to/my-project
ppm projects list
ppm projects remove my-project

# AI provider / model
ppm config set ai.default_provider claude       # claude | codex | cursor
ppm config set ai.providers.claude.model claude-opus-5

# Auth
ppm config set auth.enabled true
```

---

## Running the Server

`ppm start` always runs as a **background daemon under a supervisor**, and always brings up a
Cloudflare Quick Tunnel. There is no foreground mode.

```bash
ppm start                  # daemon + tunnel; blocks until the URL is known, then exits 0
ppm start -p 4000          # custom port
ppm start --profile dev    # use ppm.dev.db

ppm status                 # human-readable
ppm status --json          # machine-readable — `.shareUrl` is the public URL
ppm logs -f                # follow ~/.ppm/ppm.log
ppm restart                # reload, keeping the tunnel URL
```

Startup prints `➜  Local`, `➜  Share` and a QR code for the share URL. It waits up to 35s for the
tunnel; if the URL has not appeared it warns and tells you to check `ppm status`.

### Stopping: `stop` vs `down`

| Command | Server | Supervisor | Tunnel / Cloud link |
|---|---|---|---|
| `ppm stop` | stopped | **stays alive** (`stopped` state) | **stays up** |
| `ppm down` (= `ppm stop --kill`) | stopped | stopped | stopped |
| `ppm stop --all` | stopped | stopped | kills every PPM + cloudflared process, tracked or not |

The split exists so a restart does not rotate the public URL. Use `down` for a real shutdown; use
`stop --all` only when something is wedged — it kills by scan, not by tracked PID.

### Logs

The daemon writes to `~/.ppm/ppm.log` (inside `getPpmDir()`). `ppm logs -n 200`, `ppm logs -f` and
`ppm logs --clear` read and manage it. There is no separate logging config.

---

## Start at Boot

Use the built-in command rather than hand-writing a service file:

```bash
ppm autostart enable
ppm autostart status
ppm autostart disable
```

It generates the right artifact per OS:

| OS | Artifact |
|---|---|
| macOS | `~/Library/LaunchAgents/com.hienlh.ppm.plist` |
| Linux | `~/.config/systemd/user/ppm.service` (`Type=notify`) |
| Windows | Task Scheduler task `PPM`, registered from an XML task definition at logon |

`ppm start` enables autostart on first run and migrates a stale systemd unit, so in most cases you
never call this directly. On Windows the task is created from XML rather than plain `schtasks
/SC ONLOGON` — that flag cannot target a single user's logon without an all-users change, and it
would otherwise impose a 72-hour run limit.

---

## Public URL Sharing via Cloudflare Tunnel

1. `ppm start` spawns the supervisor and server
2. cloudflared is downloaded to `~/.ppm/bin/` on first use (~15 MB, cached)
3. The tunnel runs as a child process; its URL is parsed from stderr
4. The URL is written to `~/.ppm/status.json` and printed with a QR code

**The quick-tunnel URL rotates on every fresh tunnel.** For a stable address, either link the machine
to PPM Cloud (`ppm cloud login`) for a permanent alias, or set up a named tunnel on a domain you
already have on Cloudflare — see the next section.

**Security:** if `auth.enabled` is false while the tunnel is up, PPM warns that the IDE is publicly
reachable. Always keep auth on when sharing. The session token is required on the WebSocket
handshake too, not just on HTTP.

Per-port forwarding for local dev servers is separate: the dock's Cloudflare Tunnels panel drives
`/api/tunnels`, which spawns one quick tunnel per port.

---

## Stable Public URL with Your Own Domain

A named tunnel pins PPM to `https://<prefix>.<your-zone>` — the same hostname across restarts,
hibernate, and crashes, unlike the quick tunnel's rotating `*.trycloudflare.com` URL. It requires:

- A domain already added as a zone in your Cloudflare account.
- `auth.enabled` set to `true` — a stable, guessable hostname must never be reachable by an
  unauthenticated request, so the setup popup stays hidden and every mutating endpoint 403s while
  auth is off.

### Setup flow

A first-run popup asks whether you have a domain on Cloudflare. Answering yes opens a Cloudflare
login link — copy it to a phone or another browser if this machine has no browser of its own. The
login stays open while you finish it: after 60 seconds idle you get a "still logging in?" prompt
(the login keeps running), and after 5 minutes with no login it times out and lets you retry with a
fresh link. Once logged in, PPM reads the zone from the new credential and proposes a hostname
(`ppm.<zone>` by default) — you can pick a different prefix, but it must be exactly one label under
the zone (no apex record, no `www`; Cloudflare's free certificate only covers one subdomain level,
and anything deeper would serve a TLS error).

The Tunnel Manager section (in the app, alongside the quick-tunnel controls) is where the flow lives
permanently — the popup only covers first-run:

- **Disable** switches back to the quick tunnel. The named-tunnel configuration is kept (not deleted)
  so re-enabling doesn't require logging in again.
- **Re-login** ("Log in again") is what to use when the domain's zone changes, or whenever PPM
  reports the Cloudflare credential looks stale (wrong account, unreadable file). It moves the
  existing credential aside (`cert.pem` → `cert.pem.bak-<timestamp>`) rather than deleting it, then
  starts a fresh login — never edit or delete `~/.cloudflared/cert.pem` by hand.

### Troubleshooting

**"Hostname unreachable" warning** — shown when the DNS record for your named tunnel stops
resolving (for example, the CNAME was deleted in the Cloudflare dashboard outside PPM). PPM restarts
the tunnel connector once to rule out a transient failure; if the hostname is still unreachable after
that it stops retrying and leaves the warning up rather than restarting forever. Recreate the DNS
record in Cloudflare (or use Re-login if the whole zone changed) to clear it.

**Setup finishes but says "pending" / asks you to run `ppm restart`** — the setup call always
succeeds once cloudflared provisions the tunnel; picking it up without a full restart needs a
supervisor version that understands the `retunnel` command. On an older supervisor (from before a
PPM upgrade), run `ppm restart` once to finish applying it.

---

## Environment Variables

Only these are read by PPM:

| Variable | Read by | Purpose |
|---|---|---|
| `PPM_HOME` | `src/services/ppm-dir.ts` | Override the `~/.ppm` directory. Used for test isolation. |
| `PPM_CLAUDE_CLI` | Claude provider / CLI resolver | Explicit path to the `claude` binary when discovery fails |
| `PPM_SKILLS_DIR` | `slash-discovery` | Extra directory to discover skills from |
| `PPM_TERMINAL` | `ppm cloud` | Set to `1` to force terminal-mode output |
| `PPM_INSTALL_DIR` | `scripts/install.sh` / `install.ps1` | Install location (default `~/.ppm/bin`) |
| `PPM_DEV_API` | `vite.config.ts` | Dev-server proxy target (default `http://localhost:8081`) |

There is **no** `PPM_PORT`, `PPM_HOST`, `PPM_DB_PATH` or `PPM_DEFAULT_PROVIDER` — all of those are
config keys, set with `ppm config set`.

### AI provider environment

The SDK authenticates through the logged-in `claude` CLI; an `ANTHROPIC_API_KEY` is not required.
Note that a *project's* `.env` containing `ANTHROPIC_API_KEY` can break SDK tool execution, so the
provider neutralizes those variables for spawned tools. See `lessons-learned.md`.

---

## Build & Deployment Commands

```bash
bun install
bun run typecheck        # bunx tsc --noEmit
bun run build:web        # frontend only
bun run build            # frontend + compiled binary → dist/ppm
bun test
```

### Output Artifacts

```
dist/
├── ppm                    # compiled binary (embeds the runtime)
└── web/                   # frontend assets served by the binary
    ├── index.html
    ├── assets/            # JS/CSS chunks
    └── manifest.json      # PWA manifest
```

Typical sizes: frontend ~400–500 KB gzipped; binary ~80–120 MB (the runtime dominates).

---

## Releasing (Maintainers)

Releases publish to **npm** (`@hienlh/ppm`) and attach **platform binaries** to a matching **GitHub Release**. GitHub Actions release is disabled (billing), so binaries are built and uploaded **locally** by `scripts/release.sh`. The npm version and the GitHub binary tag always share the same version, so `bunx @hienlh/ppm` and the `curl … | sh` installers stay in sync.

### Prerequisites (one-time)

- `bun`, `git`, `gh`, `zip`, `tar` on PATH (Git Bash provides these on Windows).
- `gh auth login` (repo write access) and `npm login` (publish access to `@hienlh`).

### Step 1 — commit your changes (manual)

The release script does **not** commit source. Do this yourself first:

```bash
# 1. Commit your feature/fix work
git add <files> && git commit -m "fix: …"

# 2. Update CHANGELOG.md — read every commit since the last version bump
#    and document ALL user-facing changes, not just this session's.
git log --oneline <last-version-tag>..HEAD

# 3. Bump package.json version (PATCH by default: 0.17.7 → 0.17.8;
#    minor/major only when explicitly warranted)

# 4. Commit the bump and push — the script refuses to run if local is
#    ahead of or behind origin/main.
git add CHANGELOG.md package.json && git commit -m "chore: bump version to X.Y.Z"
git push origin main
```

> **Multi-device note:** PPM is released from multiple machines. Another device may have already bumped/published while you worked. Always `git fetch origin` and rebase before bumping so you don't reuse a version. The release script's preflight enforces this (aborts if not on `main`, tree dirty, or out of sync with `origin/main`).

### Step 2 — run the release script

```bash
bash scripts/release.sh            # version from package.json
bash scripts/release.sh 0.17.8     # or explicit (must match package.json)
```

It performs, in order:

1. **Preflight** — on `main`, clean tracked tree, in sync with `origin/main`, package.json version matches.
2. **Regenerate skill assets + build frontend** (`generate:skill` + `build:web`). If `assets/skills/**` changed, it commits `chore: regenerate skill assets for vX` and pushes.
3. **npm publish** — idempotent; skipped if that version is already on npm.
4. **Compile binaries** for all targets.
5. **Package** each binary with `dist/web` (`.tar.gz` for Unix, `.zip` for Windows). Names match the installers.
6. **Tag + push** `vX`, then **create/update the GitHub Release** and upload the archives.

Every step is idempotent — safe to re-run if it fails partway (e.g. npm already published but binaries not yet uploaded).

### Binary targets & artifact names

| bun `--target` | Artifact | Installer archive |
|---|---|---|
| `bun-darwin-arm64` | `ppm-darwin-arm64` | `ppm-darwin-arm64.tar.gz` |
| `bun-darwin-x64-baseline` | `ppm-darwin-x64` | `ppm-darwin-x64.tar.gz` |
| `bun-linux-x64-baseline` | `ppm-linux-x64` | `ppm-linux-x64.tar.gz` |
| `bun-linux-arm64` | `ppm-linux-arm64` | `ppm-linux-arm64.tar.gz` |
| `bun-windows-x64-baseline` | `ppm-windows-x64.exe` | `ppm-windows-x64.zip` |

`scripts/install.sh` downloads `ppm-{os}-{arch}.tar.gz`; `scripts/install.ps1` downloads `ppm-windows-x64.zip`. If you change target/artifact names, update both installers.

---

## Upgrading

```bash
ppm upgrade --check     # see whether a newer version exists
ppm upgrade             # download, verify and swap the binary in place
```

The supervisor also polls for new versions and surfaces a one-click upgrade banner in the UI. For
Bun installs, `bun update -g @hienlh/ppm` works as well; for installer-script installs, re-running
the installer is equivalent.

Config carries over — `~/.ppm/ppm.db` is untouched by an upgrade. Back it up first if you want a
guaranteed rollback point:

```bash
cp ~/.ppm/ppm.db ~/.ppm/ppm.db.backup
```

---

## First-Time Setup Checklist

```bash
# 1. Install
curl -fsSL https://ppm.sh/install | sh

# 2. Initialize (interactive: port, password, scan dir, AI settings)
ppm init

# 3. Start — prints Local + Share URLs and a QR code
ppm start

# 4. Open the printed URL, enter the access password

# 5. Verify: browse files, open a terminal, run a git status, send a chat message
```

---

## Troubleshooting

### Port already in use
```bash
ppm status                 # is PPM itself already running?
lsof -i :3210              # macOS/Linux
netstat -ano | findstr :3210   # Windows
ppm start -p 4000          # or just move
```
If PPM was killed uncleanly the port can stay wedged by an orphaned child. `ppm stop --all` clears
tracked and untracked PPM/cloudflared processes; on Windows a zombie-port reaper also runs at start.

### Server won't start
```bash
ppm status --json
ppm logs -n 200            # the daemon logs to ~/.ppm/ppm.log
ppm config get port
ppm down && ppm start      # full restart, including the supervisor
```

### Tunnel URL missing or unreachable
```bash
ppm status                 # shareUrl present?
ls ~/.ppm/bin/cloudflared  # binary downloaded?
ppm down && ppm start      # re-establish; the URL will change
```
A resolver that filters `*.trycloudflare.com` (some VPN/DNS setups) will make a *valid* URL look
dead — test the same URL from another network before assuming the tunnel failed.

### Chat not responding
```bash
claude --version           # is Claude Code installed and logged in?
ppm logs -f                # provider errors are logged here
```
If the CLI cannot be found, set `PPM_CLAUDE_CLI=/path/to/claude`. If the project has an `.env` with
`ANTHROPIC_API_KEY`, see the SDK note above.

### Terminal not working
```bash
which bash zsh             # macOS/Linux
```
Windows uses ConPTY via `@skitee3000/bun-pty`; macOS and Linux use Bun's native PTY. Both are behind
one `PtyHandle` interface in `terminal.service.ts`.

### Git commands failing
```bash
git --version
cd /path/to/project && git status    # is it actually a repo?
```

### Permission denied on file operations
Confirm the PPM process user can read/write the project directory. PPM refuses paths outside its
allowed scope by design — protected system roots and the PPM directory itself are shielded, so a
403 on `~/.ppm` is expected behaviour, not a bug.

---

## Security Checklist

- [ ] Keep `auth.enabled` true — mandatory whenever the tunnel is up
- [ ] Rotate the token if it leaks: `ppm config set auth.token "$(openssl rand -hex 32)"`
- [ ] Restrict the config DB: `chmod 600 ~/.ppm/ppm.db` (it holds account credentials)
- [ ] Review which projects are registered: `ppm projects list`
- [ ] Keep the proxy auth key secret if the API proxy is enabled
- [ ] Keep Bun and PPM updated: `bun upgrade`, `ppm upgrade`
- [ ] Prefer the tunnel over opening a firewall port

### Direct network exposure (not recommended)

The tunnel is the supported path. If you must expose the port directly, terminate TLS in front:

```nginx
upstream ppm { server localhost:3210; }

server {
    listen 443 ssl http2;
    server_name ppm.example.com;

    ssl_certificate     /etc/letsencrypt/live/ppm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ppm.example.com/privkey.pem;

    location / {
        proxy_pass http://ppm;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Monitoring

### Health check (no auth)
```bash
curl http://localhost:3210/api/health
# {"ok":true,"data":{"status":"running"}}

curl http://localhost:3210/api/info
# version, device_name, tunnel_active — used by the login screen
```

### Host metrics
`/api/system/resources*` streams CPU, memory, disk, network, GPU and per-process data over SSE, in a
light and a full tier with leases. It is the backend for the System Monitor window and is behind
PPM auth. On Windows a single long-lived PowerShell collector serves every tick — never spawn one
per tick.

### Daemon state
```bash
ppm status --json      # pid, port, host, shareUrl, tunnel state
cat ~/.ppm/status.json # same file the supervisor writes
ppm logs -f
```

---

## Performance Tuning

### File descriptor limit (Linux)
```bash
ulimit -n                  # check
ulimit -n 4096             # raise for this shell
# permanent: /etc/security/limits.conf → * soft nofile 4096 / * hard nofile 4096
```

### File watching
PPM never registers a recursive watch on a project root — on Linux that is one inotify watch per
subdirectory, `node_modules` included. Ignored directories are pruned at registration time in
`src/services/file-watcher/watch-tree.ts`. If you add watch surfaces, keep that invariant or you
will exhaust the inotify limit.

### Memory
Long chat sessions are the usual growth source; the transcript is windowed rather than fully
materialized. If memory climbs, check for orphaned transcode or tunnel children with the System
Monitor, filtered to PPM's own processes.

---

## Support

1. **Bug report:** `ppm report` pre-fills a GitHub issue with environment info and recent logs
2. **Issues:** https://github.com/hienlh/ppm/issues
3. **Logs:** `ppm logs -f` (`~/.ppm/ppm.log`)
4. **Status:** `ppm status --json`
5. **Known traps:** [`lessons-learned.md`](lessons-learned.md)
