# Claude Agent SDK on Windows + Bun: Investigation Report

**Date:** 2026-03-18 | **Status:** Completed

## Executive Summary

The issue of `query()` never yielding async iterator events on Windows with Bun is a known Windows subprocess pipe buffering problem affecting the Claude Agent SDK ecosystem. The Python SDK has a documented fix; the TypeScript SDK has known Windows issues but hasn't reported this exact scenario. **Bun IPC is fundamentally limited on Windows**, making async iteration pattern problematic.

## Root Causes Identified

### 1. **Windows Subprocess stdin/stdout Buffering (PRIMARY)**

**Status:** Confirmed on Python SDK, likely affects TypeScript SDK on Bun

When spawning CLI subprocesses on Windows, stdin/stdout pipes enter a buffered state where:
- Data written to stdin never reaches the subprocess (stays in buffer)
- Subprocess never receives init control request, hangs indefinitely
- Async iterator never gets response events

**Evidence:**
- [Python SDK Issue #208](https://github.com/anthropics/claude-agent-sdk-python/issues/208) - ClaudeSDKClient hangs on Windows initialization
- Same command works fine in PowerShell manually - confirms subprocess works, pipes are issue
- Only affects streaming/interactive mode; non-interactive `query()` works

**Python SDK Fix:** Added `drain()` call on asyncio StreamWriter after all control protocol writes to flush Windows pipe buffers.

---

### 2. **Bun IPC Limitations on Windows (ARCHITECTURAL)**

**Status:** Documented limitation

Bun's `ipc` option has critical Windows constraints:
- **IPC only works between Bun processes** (not with arbitrary CLI executables)
- **Sending IPC sockets not supported on Windows** at all
- Bun's terminal I/O unavailable on Windows

**Impact:** Even if TypeScript SDK attempts IPC-based communication with CLI subprocess, it won't work on Windows. Falls back to stdio pipes, which have the buffering issue above.

---

### 3. **Bun stdio Pipe Issues on Windows**

**Status:** Multiple reported issues

- [Issue #24690](https://github.com/oven-sh/bun/issues/24690) - `Bun.spawn()` with `stdout: 'pipe'` returns empty output when run inside `bun test`
- [Issue #1498](https://github.com/oven-sh/bun/issues/1498) - Killing subprocess while reading buffered stdout causes Bun to hang indefinitely
- [Issue #1199](https://github.com/thedotmack/claude-mem/issues/1199) - Windows stdio connections fail with `.cmd` files and backslash paths

Bun's Windows subprocess pipe handling is unreliable, especially when reading piped output. SDK spawning CLI with stdio pipes will encounter these issues.

---

### 4. **TypeScript SDK Windows Fixes (INCOMPLETE)**

**Status:** Issue #103 addressed console visibility, not subprocess communication

- Fixed v0.1.71: Added `windowsHide` option to hide conhost.exe window
- Fixed v0.2.63: `pathToClaudeCodeExecutable` PATH resolution
- **NOT fixed:** Subprocess stdin/stdout buffering issue on Windows

TypeScript SDK hasn't documented the Windows pipe buffering problem that Python SDK had to fix.

---

## Specific Failure Scenario: PPM on Windows

When `query()` from `@anthropic-ai/claude-agent-sdk` runs on Windows with Bun:

```
1. SDK spawns: bun.spawn() → claude.exe with stdio: ['pipe', 'pipe', 'pipe']
2. SDK writes control_request to stdin
3. Windows pipe enters buffered state; data doesn't reach subprocess
4. SDK reads from stdout async iterator
5. No events come back; iterator hangs forever
6. CLI works fine when run directly (subprocess is functional)
```

## Solutions & Workarounds

### ✅ Solution 1: Explicit stdin Flushing (RECOMMENDED)

Implement Windows-specific `drain()` call after stdio writes, similar to Python SDK fix:

```typescript
// In SDK wrapper code
if (process.platform === 'win32' && process.stdin?.writable) {
  await process.stdin.drain?.();  // Flush Windows pipe buffers
}
```

**Pros:** Directly addresses root cause
**Cons:** Requires SDK modification; adds small latency

---

### ✅ Solution 2: Use WSL for Subprocess Spawning

Redirect the SDK query execution through WSL (Windows Subsystem for Linux):

```bash
# Instead of spawning claude.exe directly, spawn via WSL
wsl -- claude query --system <prompt>
```

**Pros:** Avoids entire Windows pipe buffering issue; subprocess runs in Linux environment
**Cons:** Requires WSL installation; adds subprocess layer; performance overhead

---

### ✅ Solution 3: Switch to Non-Interactive Query Mode

Avoid async iterator pattern; use Promise-based query mode (if available):

```typescript
// Instead of: for await (const event of query(...))
const result = await query(...);  // Wait for complete result
```

**Pros:** Circumvents streaming/async issues
**Cons:** Less responsive UX; requires buffering entire response

---

### ✅ Solution 4: Use Named Pipes Instead of stdio

On Windows, use named pipes (`\\.\pipe\...`) instead of anonymous pipes for subprocess communication:

```typescript
const process = spawn('claude.exe', [...], {
  stdio: ['pipe', 'ipc', 'pipe']  // Use ipc for bidirectional
});
```

**Pros:** More reliable inter-process communication on Windows
**Cons:** Non-standard SDK modification; requires native Windows API knowledge

---

## Bun-Specific Alternatives

### Use `Bun.spawnSync()` Instead

If iterating async events is optional:

```typescript
const result = Bun.spawnSync(['claude', 'query', '--system', prompt]);
```

**Status:** Synchronous; blocks event loop but more reliable on Windows
**Caveat:** Not suitable for long-running queries

---

## Related Known Issues

| Issue | Repo | Status | Impact |
|-------|------|--------|--------|
| Subprocess stdin/stdout buffering on Windows | python SDK | ✅ Fixed in #208 | Exact issue you're seeing |
| Bun stdio pipe in tests returns empty | oven-sh/bun #24690 | Open | Affects test execution |
| Bun hang on buffered stdout read + kill | oven-sh/bun #1498 | Open | Can leave Bun hanging |
| Windows IPC socket sending | oven-sh/bun | Limitation | Architectural |
| .cmd file resolution in stdio | oven-sh/bun #1199 | Open | Windows-specific |

---

## Recommendation

**Priority:** Implement Solution 1 (stdin flushing) + Solution 3 (fallback to Promise mode)

1. **Short-term:** Patch SDK query wrapper to call `drain()` on stdout after writes on Windows
2. **Medium-term:** Report issue to TypeScript SDK maintainers (python SDK has fix, TypeScript doesn't)
3. **Long-term:** Advocate for Bun to improve Windows subprocess pipe reliability

The Python SDK fix is proof this is solvable without architectural changes.

---

## Unresolved Questions

1. Does TypeScript SDK version used in PPM already include any Windows buffering fixes? (Check `package.json` version)
2. Is `query()` being called with specific options (e.g., custom env vars) that might worsen buffering?
3. Can PPM temporarily upgrade to Python-based Claude CLI for Windows until TypeScript SDK is patched?
4. Does PPM have access to Bun source code to contribute Windows subprocess pipe fix?

---

## Sources

- [Claude Agent SDK TypeScript GitHub](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Python SDK Issue #208: ClaudeSDKClient hangs on Windows](https://github.com/anthropics/claude-agent-sdk-python/issues/208)
- [TypeScript SDK Issue #103: Windows console window visibility](https://github.com/anthropics/claude-agent-sdk-typescript/issues/103)
- [Bun Issue #24690: spawn stdout pipe empty in tests](https://github.com/oven-sh/bun/issues/24690)
- [Bun Issue #1498: buffered stdout read hang](https://github.com/oven-sh/bun/issues/1498)
- [Bun Spawn Documentation](https://bun.com/docs/runtime/child-process)
- [Bun IPC Limitations Documentation](https://bun.com/reference/node/child_process/spawn)
