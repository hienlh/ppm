---
phase: 3
title: "CLI + Server Integration (Default Daemon + Share)"
status: completed
effort: 1.5h
completed: 2026-03-15
---

# Phase 3: CLI + Server Integration

## Context

- Depends on: [Phase 1](phase-01-cloudflared-binary-manager.md), [Phase 2](phase-02-tunnel-service.md)
- CLI entry: `src/index.ts`
- Server entry: `src/server/index.ts`
- Stop command: `src/cli/commands/stop.ts`

## Overview

- **Priority**: P1
- **Status**: completed
- Two changes: (1) default daemon mode, (2) wire `--share` flag in both modes
- **Implementation**: CLI flags updated, server rewritten for daemon/foreground logic, stop.ts updated for status.json

## Key Insights

- Current: `--daemon` flag opts INTO daemon. New: daemon is default, `--foreground` opts OUT.
- Daemon + share challenge: parent exits immediately, but tunnel takes 2-5s. Solution: child writes status file, parent polls it.
- Status file `~/.ppm/status.json` replaces `~/.ppm/ppm.pid`:
  ```json
  { "pid": 12345, "port": 8080, "host": "0.0.0.0", "shareUrl": "https://xxx.trycloudflare.com" }
  ```
- `ppm stop` reads PID from status.json (fallback to ppm.pid for backward compat)
- In daemon mode, cloudflared download happens in PARENT process (shows progress to user), but tunnel spawn happens in CHILD (lives as long as server)

## Requirements

### Functional
- `ppm start` → daemon by default (background)
- `ppm start -f` / `--foreground` → foreground mode
- `ppm start --share` → daemon + tunnel (download in parent, tunnel in child)
- `ppm start --share -f` → foreground + tunnel
- `ppm stop` → reads status.json, kills PID, removes files
- Status file written by child process after all services ready
- Parent polls status file for up to 30s, prints URLs, exits

### Non-functional
- Backward compat: old `--daemon` flag still works (maps to default behavior, no-op)
- Tunnel failure non-fatal: server runs without share URL
- Clean shutdown removes status.json + ppm.pid

## Related Code Files

- **Modify**: `src/index.ts` — change CLI flags
- **Modify**: `src/server/index.ts` — rewrite daemon/foreground logic, add share/status
- **Modify**: `src/cli/commands/stop.ts` — read status.json, cleanup

## Implementation Steps

### 1. src/index.ts — CLI Flags

Replace `--daemon` with `--foreground`, add `--share`:

```typescript
program
  .command("start")
  .description("Start the PPM server (background by default)")
  .option("-p, --port <port>", "Port to listen on")
  .option("-f, --foreground", "Run in foreground (default: background daemon)")
  .option("-d, --daemon", "Run as background daemon (default, kept for compat)")
  .option("-s, --share", "Share via public URL (Cloudflare tunnel)")
  .option("-c, --config <path>", "Path to config file")
  .action(async (options) => {
    const { startServer } = await import("./server/index.ts");
    await startServer(options);
  });
```

### 2. src/server/index.ts — startServer() rewrite

Update options type:
```typescript
export async function startServer(options: {
  port?: string;
  foreground?: boolean;
  daemon?: boolean;  // compat, ignored
  config?: string;
  share?: boolean;
})
```

**Daemon mode logic** (default, when NOT foreground):

```typescript
const isDaemon = !options.foreground;

if (isDaemon) {
  // Step 1: If --share, download cloudflared in parent (shows progress)
  if (options.share) {
    const { ensureCloudflared } = await import("../services/cloudflared.service.ts");
    console.log("  Downloading cloudflared (if needed)...");
    await ensureCloudflared();
  }

  // Step 2: Spawn child process
  const args = ["bun", "run", import.meta.dir + "/index.ts", "__serve__",
    String(port), host, options.config ?? "", options.share ? "share" : ""];
  const child = Bun.spawn({ cmd: args, stdio: ["ignore", "ignore", "ignore"], env: process.env });
  child.unref();

  // Step 3: Write PID file (compat)
  writeFileSync(pidFile, String(child.pid));

  // Step 4: Poll for status.json (child writes it when ready)
  const statusFile = resolve(ppmDir, "status.json");
  const startTime = Date.now();
  let status: any = null;
  while (Date.now() - startTime < 30_000) {
    if (existsSync(statusFile)) {
      status = JSON.parse(readFileSync(statusFile, "utf-8"));
      break;
    }
    await Bun.sleep(200);
  }

  // Step 5: Print URLs
  if (status) {
    console.log(`\n  PPM daemon started (PID: ${status.pid})\n`);
    console.log(`  ➜  Local:   http://localhost:${status.port}/`);
    if (status.shareUrl) {
      console.log(`  ➜  Share:   ${status.shareUrl}`);
    }
  } else {
    console.log(`  PPM daemon started (PID: ${child.pid}) but status not confirmed.`);
  }

  process.exit(0);
}
```

**Foreground mode** (same as current but with share support):

```typescript
// Existing Bun.serve() code stays the same...
// After printing network URLs:

if (options.share) {
  try {
    const { tunnelService } = await import("../services/tunnel.service.ts");
    console.log("\n  Starting share tunnel...");
    const shareUrl = await tunnelService.startTunnel(server.port);
    console.log(`  ➜  Share:   ${shareUrl}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗  Share failed: ${msg}`);
  }
}
```

**Child process (__serve__) update**:

The `__serve__` block at bottom of file needs:
```typescript
if (process.argv.includes("__serve__")) {
  // ... existing port/host/config parsing ...
  const shareFlag = process.argv[idx + 4] === "share";

  // ... existing Bun.serve() setup ...

  // After server ready:
  let shareUrl: string | undefined;
  if (shareFlag) {
    try {
      const { tunnelService } = await import("../services/tunnel.service.ts");
      shareUrl = await tunnelService.startTunnel(port);
    } catch { /* non-fatal */ }
  }

  // Write status file for parent to read
  const statusFile = resolve(homedir(), ".ppm", "status.json");
  writeFileSync(statusFile, JSON.stringify({ pid: process.pid, port, host, shareUrl }));

  // Cleanup on exit
  const cleanup = () => {
    try { unlinkSync(statusFile); } catch {}
    try { unlinkSync(resolve(homedir(), ".ppm", "ppm.pid")); } catch {}
    if (shareFlag) {
      import("../services/tunnel.service.ts").then(m => m.tunnelService.stopTunnel());
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
```

### 3. src/cli/commands/stop.ts — Update

Read PID from status.json (fallback to ppm.pid):

```typescript
const STATUS_FILE = resolve(homedir(), ".ppm", "status.json");

export async function stopServer() {
  let pid: number | null = null;

  // Try status.json first
  if (existsSync(STATUS_FILE)) {
    try {
      const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      pid = status.pid;
    } catch {}
  }

  // Fallback to ppm.pid
  if (!pid && existsSync(PID_FILE)) {
    pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  }

  if (!pid || isNaN(pid)) {
    console.log("No PPM daemon running.");
    // Cleanup stale files
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    return;
  }

  try {
    process.kill(pid);
    // Cleanup files
    if (existsSync(STATUS_FILE)) unlinkSync(STATUS_FILE);
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    console.log(`PPM daemon stopped (PID: ${pid}).`);
  } catch (e) {
    // ... existing error handling ...
  }
}
```

## Terminal Output

### `ppm start`
```
  PPM daemon started (PID: 12345)

  ➜  Local:   http://localhost:8080/
```

### `ppm start --share`
```
  Downloading cloudflared (if needed)...

  PPM daemon started (PID: 12345)

  ➜  Local:   http://localhost:8080/
  ➜  Share:   https://random-words.trycloudflare.com
```

### `ppm start --share -f`
```
  PPM v0.1.5 ready

  ➜  Local:   http://localhost:8080/
  ➜  Network: http://192.168.1.x:8080/

  Starting share tunnel...
  ➜  Share:   https://random-words.trycloudflare.com

  Auth: enabled
  Token: abc123
```

### `ppm stop`
```
  PPM daemon stopped (PID: 12345).
```

## Todo List

- [x] Update CLI flags in `src/index.ts` (replace --daemon with --foreground, add --share)
- [x] Rewrite daemon logic in `startServer()` (default daemon, poll status.json)
- [x] Add cloudflared download in parent process when --share + daemon
- [x] Add share tunnel in foreground mode
- [x] Update `__serve__` block: accept share flag, write status.json, cleanup
- [x] Update `stop.ts`: read status.json, fallback ppm.pid
- [x] Test all 4 combinations: daemon, daemon+share, fg, fg+share
- [x] Test `ppm stop` kills daemon and cleans up files

## Success Criteria

- `ppm start` → runs in background, prints local URL, exits
- `ppm start --share` → runs in background + tunnel, prints share URL, exits
- `ppm start -f` → runs in foreground (Ctrl+C to stop)
- `ppm start -f --share` → foreground + tunnel
- `ppm stop` → kills daemon, cleans up status.json + ppm.pid
- Old `--daemon` flag still accepted (no-op, compat)
- Tunnel failure doesn't crash server

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Status file race (parent reads before child writes) | Medium | Poll with 200ms interval, 30s timeout |
| Child crashes before writing status | Medium | Parent prints "started but not confirmed" warning |
| Orphaned cloudflared in daemon mode | Low | SIGTERM handler in child kills tunnel |
| User runs `ppm start` twice | Low | Check if status.json exists and PID alive → warn |
