# PPM Deployment Guide

## Prerequisites

### System Requirements
- **OS:** Linux or macOS (Windows support planned for v3)
- **RAM:** 512 MB minimum, 2 GB recommended
- **Disk:** 500 MB for binary + dependencies
- **Network:** localhost only (single-machine deployment)

### Required Software
- **Bun:** v1.3.6 or later (https://bun.sh)
- **Git:** v2.0+ (for git operations in chat/CLI)
- **Node.js or Bun:** For running npm/node commands in terminal

### Optional
- **ngrok or similar:** For exposing to network (not recommended for production)
- **systemd or launchd:** For daemon management

---

## Installation

### Option 1: Build from Source (Development)

#### Prerequisites
```bash
# Check Bun is installed
bun --version  # Should be 1.3.6+

# Clone repository
git clone https://github.com/hienlh/ppm.git
cd ppm
```

#### Install & Build
```bash
# Install dependencies
bun install

# Build frontend + CLI binary
bun run build

# Output: dist/ppm (compiled binary)
```

#### Run
```bash
# Run directly from source (development)
bun run start

# Or use compiled binary
./dist/ppm start
```

---

### Option 2: Pre-built Binary (Production)

#### Download
```bash
# Download latest release from GitHub Releases
wget https://github.com/hienlh/ppm/releases/download/v2.0/ppm-macos-x64
chmod +x ppm-macos-x64

# Or for Linux
wget https://github.com/hienlh/ppm/releases/download/v2.0/ppm-linux-x64
chmod +x ppm-linux-x64
```

#### Run
```bash
# Copy to PATH for global access
sudo cp ppm-macos-x64 /usr/local/bin/ppm

# Verify installation
ppm --version
```

---

## Configuration

### Initial Setup

```bash
# Generate config and scan for git repositories
ppm init

# Output: ~/.ppm/config.yaml
# Auto-generates auth token
```

### Dev vs Production Config

- **Production:** `~/.ppm/config.yaml` — port **8080** (default)
- **Development:** `~/.ppm/config.dev.yaml` — port **8081**

`bun dev:server` automatically passes `-c ~/.ppm/config.dev.yaml`. Create dev config by copying `ppm.example.yaml` and setting `port: 8081`.

### Config File Structure (config.yaml)

```yaml
port: 8080
host: 0.0.0.0
auth:
  enabled: true
  token: "auto-generated-random-token"
projects:
  - name: project-a
    path: /path/to/project-a
  - name: project-b
    path: /path/to/project-b
providers:
  default: claude-agent-sdk  # or mock for testing
```

### Customize Configuration

#### Change Port
```bash
# Edit ppm.yaml manually
ppm config set port 3000

# Or start with custom port (CLI flag)
ppm start --port 3000
```

#### Add/Remove Projects
```bash
# Add project
ppm projects add my-project /path/to/my-project

# List projects
ppm projects list

# Remove project
ppm projects remove my-project
```

#### Set AI Provider
```bash
# Use mock provider (for testing)
ppm config set providers.default mock

# Switch back to SDK (default)
ppm config set providers.default claude-agent-sdk
```

#### Change Authentication Token
```bash
# Generate new random token
ppm config set auth.token "$(openssl rand -hex 32)"
```

---

## Running the Server

### Foreground Mode (Development)

```bash
ppm start

# Output:
# PPM server listening on http://localhost:8080
# Token: <token from config>
# Projects: 2
```

Server runs in foreground. Press `Ctrl+C` to stop.

### Daemon Mode (Production)

**Daemon is now the default** — `ppm start` runs in background. Use `--foreground/-f` to run with logs visible (for debugging).

```bash
# Start as background daemon (default)
ppm start

# Start with public URL via Cloudflare Quick Tunnel (v2+)
ppm start --share

# Start in foreground (debugging, shows logs)
ppm start --foreground

# Server status stored in ~/.ppm/status.json
cat ~/.ppm/status.json

# Check if running
ps aux | grep ppm

# Stop daemon
ppm stop

# Graceful shutdown: SIGTERM sent, tunnel stopped, cleanup files removed
```

**Status File Format (v2+):**
```json
{
  "pid": 12345,
  "port": 8080,
  "host": "0.0.0.0",
  "shareUrl": "https://abc-123.trycloudflare.com"
}
```

**Backward Compatibility:** If `~/.ppm/status.json` doesn't exist, `ppm stop` falls back to reading `~/.ppm/ppm.pid`.

### Public URL Sharing via Cloudflare Tunnel (v2+)

**Feature:** `ppm start --share` creates a temporary public URL for your local PPM instance via Cloudflare Quick Tunnel.

**How It Works:**
1. `ppm start --share` (or `-s`) spawns a background daemon
2. Parent process downloads cloudflared binary to `~/.ppm/bin/` if missing (shows download progress)
3. Daemon spawns cloudflared tunnel process
4. Tunnel URL extracted from stderr (e.g., `https://abc-123.trycloudflare.com`)
5. URL saved to `~/.ppm/status.json` for easy access
6. Parent displays: "Share: https://abc-123.trycloudflare.com"

**Requirements:**
- Internet connectivity (tunnel uses Cloudflare's infrastructure)
- ~15 MB disk space for cloudflared binary (downloaded once, cached)

**Security Warning:**
If `auth.enabled` is false in `~/.ppm/config.yaml`, PPM displays warning:
```
⚠ Warning: auth is disabled — your IDE is publicly accessible!
  Enable auth in ~/.ppm/config.yaml or restart without --share.
```

Recommended: Always enable auth before using `--share`.

**Example:**
```bash
# Share with auth enabled
ppm start --share          # Safe: public URL, but auth required

# Share without auth (not recommended)
ppm start --share          # Warning: anyone can access your IDE

# Disable sharing
ppm stop                   # Tunnel process stopped automatically
```

**Cleanup:**
- `ppm stop` gracefully shuts down the tunnel
- Cloudflared process killed via SIGTERM
- No dangling tunnels left behind

### Via systemd (Linux)

Create `/etc/systemd/system/ppm.service`:

```ini
[Unit]
Description=PPM Web IDE Server
After=network.target

[Service]
Type=simple
User=<username>
WorkingDirectory=/home/<username>
ExecStart=/usr/local/bin/ppm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable ppm
sudo systemctl start ppm

# Check status
sudo systemctl status ppm

# View logs
sudo journalctl -u ppm -f
```

### Via launchd (macOS)

Create `~/Library/LaunchAgents/com.ppm.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ppm.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/ppm</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/ppm.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/ppm-error.log</string>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.ppm.server.plist
launchctl status com.ppm.server
```

---

## Environment Variables

### Optional Configuration via ENV

Instead of `ppm.yaml`, configure via environment variables:

```bash
export PPM_PORT=8080
export PPM_HOST=0.0.0.0
export PPM_AUTH_TOKEN="my-secure-token"
export PPM_DEFAULT_PROVIDER="claude-agent-sdk"
export PPM_CONFIG_PATH="/etc/ppm/config.yaml"  # Custom config location

ppm start
```

### For Claude Integration

If using Claude Agent SDK:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."  # Your Anthropic API key
ppm start
```

**Note:** On Windows, SDK uses CLI fallback (`claude` binary) for Bun subprocess pipe buffering issues. Ensure `claude` is in PATH.

---

## Build & Deployment Commands

### Full Build Pipeline

```bash
# 1. Install dependencies
bun install

# 2. Type check
bun run typecheck

# 3. Build frontend
bun run build:web

# 4. Compile CLI binary (single executable)
bun run build

# Output: dist/ppm (~50-150 MB depending on platform)

# 5. Test (optional, currently partial coverage)
bun test
```

### Output Artifacts

After `bun run build`:

```
dist/
├── ppm                    # Compiled CLI binary (executable)
└── web/                   # Frontend assets (embedded in binary)
    ├── index.html
    ├── assets/
    │   ├── index-*.js     # Main JS bundle
    │   ├── index-*.css    # Tailwind styles
    │   └── ...            # Other chunks
    └── manifest.json      # PWA manifest
```

### Size Optimization

```bash
# Check bundle size before/after
bun run build:web
du -sh dist/web/assets/

# Typical sizes:
# - JS bundles: 200-300 KB gzipped
# - CSS: 100-150 KB gzipped
# - Total frontend: 400-500 KB gzipped
# - CLI binary: 80-120 MB (includes runtime)
```

---

## First-Time Setup Checklist

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc  # or ~/.zshrc

# 2. Clone/build PPM
git clone https://github.com/hienlh/ppm.git
cd ppm
bun install
bun run build

# 3. Initialize config
./dist/ppm init
# Follow prompts to add projects

# 4. Start server
./dist/ppm start
# Output: http://localhost:8080 + token

# 5. Open browser
# Navigate to http://localhost:8080
# Enter token from step 4
# Select project and start using

# 6. Verify functionality
# - Browse files in file explorer
# - Open terminal and run commands
# - Chat with Claude (requires ANTHROPIC_API_KEY)
```

---

## Troubleshooting

### Port Already in Use

```bash
# Check what's using port 8080
lsof -i :8080
# Kill process
kill -9 <PID>

# Or use different port
ppm start --port 3000
```

### Permission Denied (File Operations)

```bash
# Ensure PPM has read/write access to project directory
chmod -R u+rw /path/to/project

# Or run PPM with appropriate user
sudo -u <username> ppm start
```

### Git Commands Failing

```bash
# Verify git is installed
git --version

# Verify project is git repository
cd /path/to/project
git status

# If not a repo
git init
```

### Terminal Not Working

```bash
# Verify shell is available
which bash zsh

# Check PTY support (Linux/macOS only)
# Windows may require WSL or special configuration
```

### Chat/Claude Not Responding

```bash
# Check API key is set
echo $ANTHROPIC_API_KEY

# Verify network connectivity
curl https://api.anthropic.com

# Check provider is working
ppm chat send "test message" 2>&1
```

### Server Won't Start

```bash
# Check status (v2+)
cat ~/.ppm/status.json

# Verify server is running
ps aux | grep ppm

# View logs (foreground mode only)
ppm start --foreground    # Shows real-time logs

# Verify config is valid YAML
ppm config get port

# Clear cache and restart
rm -rf ~/.ppm/cache
ppm start
```

**Note:** Daemon mode doesn't write to a log file by default. Use `ppm start --foreground` to see logs for debugging, or set up systemd with log redirection (see "Via systemd" section above).

---

## Security Checklist

### Before Production Deployment

- [ ] Change default auth token: `ppm config set auth.token "$(openssl rand -hex 32)"`
- [ ] Verify only necessary projects are in `ppm.yaml`
- [ ] Set appropriate file permissions: `chmod 600 ~/.ppm/config.yaml ~/.ppm/ppm.db`
- [ ] Keep Bun updated: `bun upgrade`
- [ ] Keep dependencies updated: `bun update`
- [ ] Review firewall rules (localhost only recommended)
- [ ] Disable password-less sudo if running as daemon
- [ ] Use HTTPS if exposing to network (via reverse proxy, e.g., nginx)
- [ ] Regularly backup `ppm.yaml` and project data

### Network Exposure (Not Recommended)

If you must expose to network:

```nginx
# nginx reverse proxy with SSL
upstream ppm {
    server localhost:8080;
}

server {
    listen 443 ssl http2;
    server_name ppm.example.com;

    ssl_certificate /etc/letsencrypt/live/ppm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ppm.example.com/privkey.pem;

    location / {
        proxy_pass http://ppm;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then access via `https://ppm.example.com` with SSL certificate.

---

## Upgrade Instructions

### From v1 to v2

```bash
# 1. Backup existing config
cp ~/.ppm/config.yaml ~/.ppm/config.yaml.backup

# 2. Stop running server
ppm stop
# Or Ctrl+C if foreground

# 3. Download/build v2 binary
# (See "Installation" section above)

# 4. Verify new binary works
./dist/ppm --version
# Should output: v2.0.0

# 5. Start new version
./dist/ppm start

# 6. Test in browser
# All projects and auth token should carry over
```

### Rollback to v1 (If Needed)

```bash
# 1. Stop v2 server
ppm stop

# 2. Switch back to v1 binary
# cp path/to/v1/ppm ./ppm-v1
# ./ppm-v1 start

# 3. Restore backup if config changed
# cp ~/.ppm/config.yaml.backup ~/.ppm/config.yaml
```

---

## Performance Tuning

### Increase File Descriptor Limit (Linux)

```bash
# Check current limit
ulimit -n

# Increase to 4096 (temporary)
ulimit -n 4096

# Permanent: edit /etc/security/limits.conf
# Add: * soft nofile 4096
#      * hard nofile 4096
```

### Memory Management

```bash
# Monitor memory usage
# Linux
ps aux | grep ppm
free -h

# macOS
ps aux | grep ppm
vm_stat | grep page

# If using too much memory:
# 1. Reduce number of open projects
# 2. Clear browser cache
# 3. Restart server
```

### Network Latency

```bash
# Test WebSocket latency
# From browser console:
console.time('ws');
ws.send({type: 'message', content: 'ping'});
// Measure response time
```

---

## Monitoring

### Health Check Endpoint

```bash
# Health check (no auth required)
curl http://localhost:8080/api/health

# Output: { ok: true, data: { status: "healthy" } }
```

### Activity Logging

PPM logs to stdout in foreground mode. In daemon mode, configure:

```yaml
# ppm.yaml
logging:
  level: info  # debug, info, warn, error
  file: ~/.ppm/server.log
  rotation: daily
  retention: 7  # days
```

### Metrics Collection

For monitoring integrations (Prometheus, DataDog):

```bash
# Future: /api/metrics endpoint
# Currently not implemented; planned for v2.1
```

---

## Support & Troubleshooting

### Getting Help

1. **GitHub Issues:** https://github.com/hienlh/ppm/issues
2. **Logs:** Run `ppm start --foreground` to see real-time logs; check `~/.ppm/status.json` for daemon status
3. **Configuration:** Validate `ppm.yaml` syntax
4. **Dependencies:** Ensure Bun, Git, Node are installed and up-to-date
5. **Tunnel Issues:** Check `~/.ppm/bin/cloudflared` exists; re-download if corrupted

