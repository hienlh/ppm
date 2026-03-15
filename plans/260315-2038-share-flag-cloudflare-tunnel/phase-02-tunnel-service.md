---
phase: 2
title: "Tunnel Service"
status: completed
effort: 1h
completed: 2026-03-15
---

# Phase 2: Tunnel Service

## Context

- Depends on: [Phase 1](phase-01-cloudflared-binary-manager.md) (needs cloudflared binary path)
- [Research report](../reports/researcher-260315-2028-tunnel-share-flag-implementation.md)

## Overview

- **Priority**: P1
- **Status**: completed
- Spawns `cloudflared tunnel --url http://localhost:{port}`, parses tunnel URL from stderr, provides cleanup
- **Implementation**: `src/services/tunnel.service.ts` created with tunnel spawning, stderr parsing, and cleanup handlers

## Key Insights

- cloudflared Quick Tunnel outputs URL to **stderr**, not stdout
- Two output formats to parse:
  1. Older: multi-line banner with `https://xxx.trycloudflare.com` on its own line
  2. Newer: `INF ... url=https://xxx.trycloudflare.com` in log line
- Regex to match both: `https://[a-z0-9-]+\.trycloudflare\.com`
- Must kill child process on shutdown -- orphaned cloudflared wastes resources
- Tunnel takes 2-5 seconds to establish

## Requirements

### Functional
- Spawn cloudflared with correct arguments via `Bun.spawn`
- Parse stderr stream to extract trycloudflare.com URL
- Return URL as string (or throw on timeout)
- Kill cloudflared process on `stopTunnel()`
- Register SIGINT/SIGTERM handlers for cleanup

### Non-functional
- Timeout after 30 seconds if URL not found (tunnel failed)
- Log cloudflared stderr to debug (not shown to user by default)

## Architecture

```
TunnelService (singleton)
  |
  +-- startTunnel(port: number): Promise<string>  -- returns public URL
  |     |-- spawn cloudflared tunnel --url http://localhost:{port}
  |     |-- read stderr line by line
  |     |-- match regex for trycloudflare.com URL
  |     +-- return URL string
  |
  +-- stopTunnel(): void  -- kill child process
  |
  +-- getTunnelUrl(): string | null  -- current URL (if running)
```

## Related Code Files

- **Create**: `src/services/tunnel.service.ts`
- **Depends**: `src/services/cloudflared.service.ts` (binary path)

## Implementation Steps

1. Create `src/services/tunnel.service.ts`
2. Import `cloudflaredService` from phase 1
3. Implement class with private state:
   ```typescript
   private process: Subprocess | null = null;
   private url: string | null = null;
   ```
4. Implement `startTunnel(port)`:
   - Get binary path: `const bin = await cloudflaredService.ensureCloudflared()`
   - Spawn: `Bun.spawn([bin, "tunnel", "--url", `http://localhost:${port}`], { stderr: "pipe" })`
   - Read stderr using `ReadableStream` reader
   - Accumulate text, match `https://[a-z0-9-]+\.trycloudflare\.com`
   - Once found, resolve promise with URL
   - Set 30s timeout -- reject if URL not found
   - Store process reference and URL
5. Implement `stopTunnel()`:
   - If `this.process`, call `this.process.kill()`
   - Set process and url to null
6. Implement `getTunnelUrl()`:
   - Return `this.url`
7. Register process exit handlers in `startTunnel`:
   ```typescript
   const cleanup = () => this.stopTunnel();
   process.on("SIGINT", cleanup);
   process.on("SIGTERM", cleanup);
   ```
8. Export singleton: `export const tunnelService = new TunnelService()`

## Todo List

- [x] Create `src/services/tunnel.service.ts`
- [x] Implement `startTunnel()` with stderr parsing
- [x] Implement `stopTunnel()` with process.kill()
- [x] Implement `getTunnelUrl()` getter
- [x] Register SIGINT/SIGTERM cleanup handlers
- [x] Export singleton instance

## Success Criteria

- `startTunnel(8080)` returns a `https://xxx.trycloudflare.com` URL
- `stopTunnel()` kills the cloudflared process
- 30s timeout if tunnel fails to establish
- Process cleanup on SIGINT/SIGTERM

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| cloudflared changes stderr format | Medium | Regex matches URL pattern, not surrounding text |
| Tunnel fails silently | Medium | 30s timeout with clear error message |
| Orphaned process on crash | Low | SIGINT/SIGTERM handlers; OS reclaims on parent exit |
| Port already in use by cloudflared | Low | Quick Tunnel uses random port internally |

## Security Considerations

- cloudflared tunnel is outbound-only (no inbound firewall rules needed)
- Quick Tunnel URL is random -- security through obscurity (acceptable for dev/demo)
- No credentials stored or transmitted
