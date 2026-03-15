# Code Review: --share Flag & Default Daemon Mode

## Scope
- **Files**: 7 (2 new services, 2 modified core, 1 modified CLI, 2 new test files)
- **LOC**: ~546 total across production files
- **Tests**: 9 pass, 0 fail

## Overall Assessment

Solid implementation. Clean separation between cloudflared binary management and tunnel lifecycle. Good use of atomic writes, timeout handling, and graceful degradation. A few issues need attention -- one major code duplication, some signal handler leaks, and a security concern with auth tokens exposed in daemon output.

---

## Critical Issues

### [C1] Auth token printed to stdout in daemon mode (security)
**File**: `src/server/index.ts:179-182`
**Problem**: In foreground mode, auth token is printed. If `--share` exposes the server publicly via tunnel, printing the token to a log or shared terminal is fine for local use but risky when the URL is public. No explicit warning that auth should be enabled when sharing.
**Impact**: User might share a server with auth disabled, exposing their IDE publicly.
**Recommendation**: When `--share` is used and auth is disabled, print a warning:
```
WARNING: Sharing without auth enabled. Anyone with the URL can access your IDE.
```

---

## High Priority

### [H1] Massive WebSocket handler duplication (maintainability, 200 LOC rule violation)
**File**: `src/server/index.ts` -- 276 lines, well over the 200-line limit
**Problem**: The entire `Bun.serve()` block with WebSocket routing (lines 102-151) is copy-pasted in the `__serve__` daemon block (lines 203-251). ~50 lines of identical code.
**Impact**: Any WebSocket routing change must be updated in two places. Bug-prone.
**Recommendation**: Extract a `createBunServer(port, host)` helper function. Both foreground and daemon modes call it.

### [H2] Signal handler leak in TunnelService
**File**: `src/services/tunnel.service.ts:27-29`
**Problem**: Each call to `startTunnel()` adds new `SIGINT`/`SIGTERM` listeners without removing them. If tunnel is restarted, listeners accumulate. Also, listeners are never removed on `stopTunnel()`.
**Impact**: Memory leak; multiple cleanup calls on exit.
**Recommendation**:
```ts
// Store refs and remove on stop
private cleanupHandler: (() => void) | null = null;

async startTunnel(port: number) {
  // ...
  this.cleanupHandler = () => this.stopTunnel();
  process.on("SIGINT", this.cleanupHandler);
  process.on("SIGTERM", this.cleanupHandler);
}

stopTunnel() {
  if (this.cleanupHandler) {
    process.removeListener("SIGINT", this.cleanupHandler);
    process.removeListener("SIGTERM", this.cleanupHandler);
    this.cleanupHandler = null;
  }
  // ...existing kill logic
}
```

### [H3] Race condition: cleanup calls async import in sync signal handler
**File**: `src/server/index.ts:269-271`
**Problem**: In the daemon `__serve__` cleanup handler, `tunnelService.stopTunnel()` is called via dynamic import inside a signal handler, then immediately calls `process.exit(0)`. The `import().then()` is async -- `process.exit(0)` fires before the import resolves, so tunnel process may not be killed.
**Impact**: Orphaned cloudflared processes after daemon stop.
**Recommendation**: Import `tunnelService` eagerly at the top of the `__serve__` block when `shareFlag` is true, then call `stopTunnel()` synchronously in cleanup.

### [H4] Stderr reader not cancelled after URL found
**File**: `src/services/tunnel.service.ts:40-61`
**Problem**: After the tunnel URL is found and `resolve()` is called, the `read()` loop continues running in background, consuming stderr indefinitely. The reader is never cancelled.
**Impact**: Minor memory/CPU waste, but more importantly if cloudflared writes errors later, the buffer keeps growing with no consumer.
**Recommendation**: After resolving, call `reader.cancel()` to release the stream. Or let it drain to `/dev/null`.

---

## Medium Priority

### [M1] No Windows support silently fails
**File**: `src/services/cloudflared.service.ts:8-9`
**Problem**: `OS_MAP` only has `darwin` and `linux`. On Windows, `getDownloadUrl()` throws but `ensureCloudflared()` gives no user-friendly message about platform support.
**Impact**: Confusing error for Windows users (if any).
**Recommendation**: Fine for now if Windows is not targeted. Add a comment documenting intentional exclusion.

### [M2] No verification of downloaded binary integrity
**File**: `src/services/cloudflared.service.ts:22-50`
**Problem**: Binary is downloaded over HTTPS (good) but no checksum verification. A compromised CDN/MITM on GitHub releases could serve a malicious binary.
**Impact**: Low probability but high severity supply-chain risk.
**Recommendation**: Consider adding SHA256 checksum verification against the published checksums. Low priority given HTTPS + GitHub CDN trust.

### [M3] TextDecoder created on every read iteration
**File**: `src/services/tunnel.service.ts:45`
**Problem**: `new TextDecoder().decode(value)` is called in a hot loop. Should instantiate once.
**Recommendation**:
```ts
const decoder = new TextDecoder();
// then in loop:
buffer += decoder.decode(value, { stream: true });
```

### [M4] Stale status.json from a crashed daemon
**Problem**: If daemon crashes without running cleanup (e.g. SIGKILL, OOM), `status.json` and `ppm.pid` remain. The `stop` command handles `ESRCH` correctly, but `start` does not check for stale status -- it could show outdated info or fail to detect a port conflict.
**Recommendation**: In `startServer` daemon path, check if `status.json` exists with a stale PID before spawning a new daemon.

### [M5] Hardcoded `"bun"` in daemon spawn
**File**: `src/server/index.ts:66`
**Problem**: `Bun.spawn({ cmd: ["bun", ...] })` assumes `bun` is in PATH. If PPM is installed globally but `bun` resolves differently in the spawned env, this could fail.
**Recommendation**: Use `process.execPath` instead of `"bun"` to ensure the same runtime is used.

---

## Low Priority

### [L1] Regex doesn't anchor path suffix
**File**: `src/services/tunnel.service.ts:4`
**Problem**: `TUNNEL_URL_REGEX` matches `https://xxx.trycloudflare.com` but would also match if followed by a path like `/something`. The regex works for the current use case but `match[0]` could include trailing path in edge cases.
**Recommendation**: Add `\b` or `$` boundary if strictness is desired. Current behavior is acceptable.

### [L2] Magic strings for file paths
**Problem**: `"status.json"`, `"ppm.pid"`, `".ppm"` are repeated across `stop.ts`, `server/index.ts`. Not DRY.
**Recommendation**: Extract to a shared constants file (e.g., `src/constants/paths.ts`).

---

## Positive Observations

- **Atomic binary write** (`cloudflared.service.ts:46-48`): tmp file + rename prevents corrupt partial downloads.
- **Partial download cleanup** (line 68): temp file cleaned on failure.
- **Graceful tunnel failure** (`server/index.ts:259`): share failure is non-fatal -- server keeps running.
- **Singleton pattern** matches existing `configService` convention.
- **Backward compat**: `--daemon` flag kept for compat, `ppm.pid` fallback in stop command.
- **Good test coverage** for URL parsing with multiple format variations.
- **Clean CLI interface**: `-f` for foreground, `-s` for share -- intuitive flags.

---

## Recommended Actions (Priority Order)

1. **[H3]** Fix async import race in daemon cleanup -- eager import when shareFlag is true
2. **[H1]** Extract shared `createBunServer()` to reduce duplication and get under 200 LOC
3. **[H2]** Fix signal handler leak in TunnelService
4. **[C1]** Add auth warning when sharing publicly
5. **[H4]** Cancel stderr reader after URL found
6. **[M4]** Check for stale status.json before starting new daemon
7. **[M5]** Use `process.execPath` instead of hardcoded `"bun"`
8. **[M3]** Reuse TextDecoder instance
9. **[L2]** Extract shared path constants

## Metrics

- **File size compliance**: 5/7 files under 200 LOC. `server/index.ts` at 276 -- needs splitting.
- **Test coverage**: URL parsing well-tested. No tests for daemon lifecycle, signal cleanup, or stale file handling.
- **Linting**: No syntax errors. All tests pass.

## Unresolved Questions

- Is there a plan to support `--share` with custom Cloudflare tunnels (named tunnels with auth tokens) vs. Quick Tunnels only?
- Should the daemon auto-enable auth when `--share` is used?
- Is there a maximum cloudflared binary age before re-downloading? (Currently never updates once downloaded.)
