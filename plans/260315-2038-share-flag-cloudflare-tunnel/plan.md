---
title: "Add --share flag + default daemon mode"
description: "Default background daemon, --share auto-downloads cloudflared and exposes public trycloudflare.com URL"
status: completed
priority: P1
effort: 5h
branch: main
tags: [cli, networking, cloudflare, tunnel, share, daemon]
created: 2026-03-15
completed: 2026-03-15
---

# --share Flag + Default Daemon Mode

## Overview

Two changes:
1. **Default daemon mode**: `ppm start` runs in background by default. Use `--foreground` / `-f` to run in foreground. `ppm stop` to stop.
2. **--share flag**: `ppm start --share` auto-downloads `cloudflared`, spawns Quick Tunnel, prints public URL. Works in both daemon and foreground modes.

## Key Decisions

- **Daemon is default** -- `ppm start` backgrounds, prints URLs, exits parent
- **`--foreground` / `-f`** -- opt-in foreground mode (replaces old `--daemon`)
- **Quick Tunnel only** -- no Cloudflare account needed, random URL each time
- **Auto-install** cloudflared to `~/.ppm/bin/cloudflared` (~50MB)
- **WebSocket works** through Quick Tunnels; SSE does not (acceptable)
- **200 concurrent in-flight requests** limit (fine for dev/demo)
- **--share works in daemon** -- child process spawns tunnel, writes URL to status file
- **Status file** `~/.ppm/status.json` -- child writes `{ pid, port, shareUrl? }`, parent reads and prints

## Research

- [Researcher report](../reports/researcher-260315-2028-tunnel-share-flag-implementation.md)

## Phases

| # | Phase | File | Status | Effort |
|---|-------|------|--------|--------|
| 1 | Cloudflared Binary Manager | [phase-01](phase-01-cloudflared-binary-manager.md) | completed | 1.5h |
| 2 | Tunnel Service | [phase-02](phase-02-tunnel-service.md) | completed | 1h |
| 3 | CLI + Server Integration | [phase-03](phase-03-cli-server-integration.md) | completed | 1.5h |
| 4 | Tests | [phase-04](phase-04-tests.md) | completed | 1h |

## Architecture

### Default (daemon mode)
```
ppm start --share
  |
  v
Parent process:
  1. Download cloudflared if needed (shows progress)
  2. Spawn child process (detached)
  3. Wait for child to write ~/.ppm/status.json (poll, max 30s)
  4. Read status.json -> print URLs
  5. Exit

Child process (__serve__):
  1. Bun.serve() on localhost:{port}
  2. If share: startTunnel(port) -> write shareUrl to status.json
  3. Write { pid, port, host, shareUrl } to ~/.ppm/status.json
  4. Run until SIGTERM
  5. Cleanup: kill tunnel, remove status.json
```

### Foreground mode (--foreground)
```
ppm start --share --foreground
  |
  v
Same process:
  1. Bun.serve() starts
  2. If share: ensureCloudflared() -> startTunnel(port)
  3. Print all URLs inline
  4. Ctrl+C -> cleanup tunnel + exit
```

## Files Changed/Created

| Action | Path | LOC est. |
|--------|------|----------|
| Create | `src/services/cloudflared.service.ts` | ~120 |
| Create | `src/services/tunnel.service.ts` | ~80 |
| Modify | `src/index.ts` | +10 lines |
| Modify | `src/server/index.ts` | +50 lines |
| Modify | `src/cli/commands/stop.ts` | +5 lines (cleanup status.json) |
| Create | `tests/unit/services/cloudflared.service.test.ts` | ~80 |
| Create | `tests/unit/services/tunnel.service.test.ts` | ~60 |

## Constraints

- Files under 200 LOC
- kebab-case filenames, named exports
- Singleton services (match existing pattern)
- No unnecessary abstractions -- two focused services, minimal integration glue
- Backward compatible: `ppm stop` still works (reads PID from status.json or ppm.pid)
