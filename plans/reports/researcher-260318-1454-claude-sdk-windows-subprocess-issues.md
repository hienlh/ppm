# Claude Agent SDK Windows Subprocess Issues Research

**Date**: 2026-03-18
**Scope**: TypeScript & Python SDKs
**Focus**: Windows subprocess hanging, stdin drain, pipe buffering, query() not yielding events

---

## Executive Summary

**Finding**: Downstream issue in Anthropic's Claude Agent SDK TypeScript is **NOT the direct cause** of PPM's Windows query() hangs. However, the upstream Python SDK **DID have an identical problem (Issue #208)** that was fixed with stdin drain. The TypeScript version appears to lack this fix.

**Critical Gap**: No equivalent `flush_stdin()` drain fix found in TypeScript SDK codebase or releases. This is a **port gap** between Python (v0.2.x fixed) and TypeScript (appears unfixed).

---

## Issues Found & Status

### 1. Python SDK - Issue #208: ClaudeSDKClient Hangs on Windows ✅ FIXED

**Repo**: [anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python/issues/208)
**Status**: Resolved
**Root Cause**: Windows subprocess stdin buffering prevents initialization request from reaching CLI child process

**Fix Applied**: stdin drain using asyncio's `StreamWriter.drain()`
- Added `flush_stdin()` to Transport base class
- Implemented Windows-specific override in SubprocessCLITransport
- Calls `drain()` after sending control requests & responses
- Tests confirm fix works on Windows

**Relevance**: **HIGH** — This is the exact problem: SDK sends init request via stdin → data stuck in buffer → child process never receives it → times out. Solution is proven to work.

---

### 2. TypeScript SDK - Issue #44: Streaming Text Deltas Pause (No Events for 3+ Minutes)

**Repo**: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues/44)
**Status**: OPEN (as of Dec 8, 2025)
**Symptoms**:
- For await (const msg of query(...)) yields **zero events** for 185+ seconds
- No text_delta events, no pings, no errors — complete silence
- Resume suddenly with burst of content
- Occurs during normal streaming, **not tool use**

**Root Cause**: Unknown (unconfirmed)
**Relevance**: **CRITICAL** — Matches "query() not yielding events" symptom exactly. Still open, unfixed.

---

### 3. TypeScript SDK - Issue #64: Bash Tool Hangs on Empty Output

**Repo**: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues/64)
**Status**: OPEN (as of Nov 17, 2025)
**Symptoms**:
- Commands with no stdout/stderr hang indefinitely
- Example: `lsof -i :8080` when port unused (exits with code 1, no output)
- Works fine if command produces any output
- Appears to be EOF/pipe handling issue

**Root Cause**: stdin/pipe handling doesn't detect EOF properly when command completes with no output
**Relevance**: **MEDIUM** — Similar pipe/stream handling problem, likely related to buffering

---

### 4. TypeScript SDK - Issue #34: Query Overhead (~12 seconds per call)

**Repo**: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34)
**Status**: CLOSED (addressed via streaming input mode)
**Symptoms**: Each `query()` spawns fresh process, ~12s overhead regardless of call

**Why Relevant**: Process spawning is where stdin buffering problems manifest. Fresh processes on Windows are more susceptible to initialization hangs.

---

### 5. TypeScript SDK - Issue #103: windowsHide Option for Visible Console Window

**Repo**: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues/103)
**Status**: CLOSED - FIXED in v0.17.1 (Dec 17, 2025)

**Fix**: Exposed `windowsHide` option to hide console windows when spawning subprocess.

**Relevance**: **LOW** — UX improvement, not related to hanging/buffering. Shows Anthropic is actively fixing Windows-specific issues.

---

### 6. TypeScript SDK - Issue #20: WSL2 Subprocess Exit Code 1

**Repo**: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues/20)
**Status**: OPEN (Oct 9, 2025)
**Symptoms**: Spawned subprocess crashes with exit code 1 before any IPC communication

**Root Cause**: Binary incompatibility with WSL2 (glibc version mismatch or syscall restrictions)
**Relevance**: **LOW-MEDIUM** — Different platform (WSL2), binary-level issue. Not stdin buffering.

---

### 7. TypeScript SDK - Issue #219: MCP Server Processes Remain as Zombies

**Repo**: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues/219)
**Status**: OPEN (Mar 7, 2026)
**Symptoms**: After session ends, MCP server child processes don't clean up properly

**Relevance**: **LOW** — Process cleanup, not initialization/communication. Related to process lifecycle, not stdin buffering.

---

## Key Findings

### Finding 1: Python SDK Had Identical Problem → Fixed with stdin Drain

The Python SDK (Issue #208) experienced **the exact same symptom**: subprocess hangs during initialization on Windows because stdin-buffered control requests never reach the child process.

**Fix was straightforward**: Call `asyncio.StreamWriter.drain()` after writing to stdin.

### Finding 2: No Equivalent TypeScript SDK Fix Visible

Despite searching:
- ✗ No `flush_stdin()` method found in TypeScript SDK codebase
- ✗ No changelog entries mentioning "drain" or "Windows stdin"
- ✗ No PRs fixing Windows subprocess communication post-v0.2.76
- ✗ Issue #44 (no events) remains OPEN and unfixed

**Conclusion**: TypeScript SDK likely **lacks the Python drain fix**. This is a port gap.

### Finding 3: Node.js Subprocess Handling Differs from Python

- **Python**: Uses `anyio.open_process()` with explicit `StreamWriter.drain()` control
- **TypeScript**: Likely uses Node's `child_process.spawn()` with different buffer semantics

Node.js may need **different approach** than Python's drain():
- Consider `stdio: 'pipe'` with explicit stream flushing
- Node's streams work differently (may need `readable.pause()` / `resume()`)
- Or use `{ stdio: 'inherit' }` for direct passthrough (no buffering)

### Finding 4: Issue #44 (No Events for 3+ Minutes) is Still Unfixed

This is the most direct match to "query() not yielding events". It's been open since December 2025 with no resolution. This could be:
- Network backoff/retry delay not emitting progress events
- Internal model processing (extended thinking) without event emission
- Resource exhaustion/throttling with silent failures
- Or... stdin/pipe buffering causing events to batch and arrive as silent bursts

---

## Unresolved Questions

1. **Has Anthropic TypeScript team received/seen issue #208 Python fix?** (No evidence of port in TS SDK)
2. **Is issue #44 (no events for 3+ min) related to stdin buffering or separate?** (Needs investigation)
3. **What is the correct stdin flushing method for Node.js child_process?** (Drain != applicable; need Node equivalent)
4. **Does PPM's issue occur on first query or after warm process?** (Helps distinguish initialization vs. stream buffering)
5. **Is PPM using SDK in query mode (new process) or session mode (reuse)?** (Query mode more susceptible to init hangs)

---

## Action Items for PPM

1. **Verify SDK Version**: Check if PPM uses TypeScript SDK v0.17.1+ (has windowsHide fix but may lack drain fix)
2. **Implement Fallback**: Add workaround in PPM to flush/drain stdin after writing to SDK subprocess
3. **Test Query Mode**: Reproduce hang in query mode (new process each call) vs. session mode
4. **File TypeScript Issue**: If drain fix confirmed missing, file issue in [claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) linking to Python #208
5. **Monitor Issue #44**: If issue #44 fix released, test PPM to see if no-events problem resolves

---

## Source Materials

- [Python SDK Issue #208](https://github.com/anthropics/claude-agent-sdk-python/issues/208) - Windows initialization hang (FIXED via drain)
- [TypeScript SDK Issue #44](https://github.com/anthropics/claude-agent-sdk-typescript/issues/44) - No events for 3+ minutes (OPEN)
- [TypeScript SDK Issue #64](https://github.com/anthropics/claude-agent-sdk-typescript/issues/64) - Bash tool hangs on empty output (OPEN)
- [TypeScript SDK Issue #34](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) - 12s query overhead (CLOSED)
- [TypeScript SDK Issue #103](https://github.com/anthropics/claude-agent-sdk-typescript/issues/103) - windowsHide option (CLOSED, v0.17.1)
- [TypeScript SDK Issue #20](https://github.com/anthropics/claude-agent-sdk-typescript/issues/20) - WSL2 exit code 1 (OPEN)

