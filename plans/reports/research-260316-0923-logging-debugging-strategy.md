# Research Report: Logging & Debugging Strategy for PPM

**Date:** 2026-03-16 | **Stack:** Bun + Hono + React + WebSocket + Claude Agent SDK

## Executive Summary

PPM currently has 148 raw `console.*` calls across 14 files with a custom `setupLogFile()` that tees to `~/.ppm/ppm.log` with redaction. No structured logging library, no request correlation, no frontend error boundaries. The existing approach is functional but makes debugging production issues (especially daemon mode + WS + AI SDK) very difficult.

**Recommendation:** Lightweight structured logger (`consola`) + Hono request ID middleware + WS session tagging + frontend error boundary with toast reporting. Zero-dep where possible, YAGNI-compliant.

## Current State Analysis

### What PPM Already Has (Good)
- `setupLogFile()` in `src/server/index.ts:15-55` — tees console to `~/.ppm/ppm.log`
- Sensitive data redaction (tokens, API keys, passwords)
- `uncaughtException` / `unhandledRejection` handlers → FATAL level
- `/api/logs/recent` endpoint for bug reports (last 30 lines)
- `/api/debug/crash` endpoint (dev only)

### What's Missing (Problems)
| Problem | Impact |
|---------|--------|
| No log levels in daemon mode | Can't filter noise from errors |
| No request/session correlation | Can't trace a user action across HTTP→WS→SDK |
| WS errors silently caught | `catch { /* ignore */ }` patterns in chat.ts:34,47 |
| No frontend error boundary | React crashes = white screen |
| No structured format | Log parsing requires regex, not `jq` |
| Console.log sprawl | 148 calls, no consistent format |

## Recommended Approach

### Option A: Consola (Recommended)
**Why:** Zero-config, auto JSON in production, elegant dev output, Bun-compatible, tree-shakeable.

```bash
bun add consola
```

```typescript
// src/lib/logger.ts (~20 lines)
import { createConsola } from "consola";

export const logger = createConsola({
  level: process.env.LOG_LEVEL ? parseInt(process.env.LOG_LEVEL) : 3,
  formatOptions: { date: true, colors: process.stdout.isTTY },
});

// Child loggers for subsystems
export const httpLog = logger.withTag("http");
export const wsLog = logger.withTag("ws");
export const sdkLog = logger.withTag("sdk");
export const chatLog = logger.withTag("chat");
```

**Dev output:**
```
[2026-03-16 09:00:00] [http] ℹ GET /api/projects 200 12ms
[2026-03-16 09:00:01] [ws]   ℹ chat session abc123 opened
[2026-03-16 09:00:02] [sdk]  ⚠ tool execution timeout for session abc123
[2026-03-16 09:00:03] [chat] ✖ provider error: rate_limit_exceeded
```

**Daemon/production:** Auto-switches to JSON structured output.

### Option B: Keep Custom (Minimal Change)
Extend existing `setupLogFile()` with tag support. Less capable but zero deps.

### Option C: Pino
Fast but has known Bun bundling issues (`pino-pretty` crashes, worker thread problems). Overkill for CLI tool.

**Verdict: Option A** — best DX/effort ratio for PPM's scale.

## Implementation Plan

### 1. Structured Logger Module
**File:** `src/lib/logger.ts`

```typescript
import { createConsola } from "consola";

const isDaemon = process.argv.includes("__serve__");

export const logger = createConsola({
  level: process.env.LOG_LEVEL ? parseInt(process.env.LOG_LEVEL) : 3,
  formatOptions: {
    date: true,
    colors: !isDaemon && process.stdout.isTTY,
    compact: isDaemon, // JSON-like in daemon
  },
});

// Subsystem loggers
export const httpLog = logger.withTag("http");
export const wsLog = logger.withTag("ws");
export const sdkLog = logger.withTag("sdk");
```

### 2. Hono Request ID Middleware
Use built-in `hono/request-id` for correlation across request lifecycle.

```typescript
// src/server/index.ts
import { requestId } from "hono/request-id";

app.use("*", requestId());

// In routes:
app.get("/api/projects", (c) => {
  httpLog.info({ reqId: c.get("requestId"), path: "/api/projects" }, "list projects");
  // ...
});
```

### 3. WebSocket Session Logging
Tag all WS logs with sessionId for traceability.

```typescript
// src/server/ws/chat.ts
import { wsLog } from "../../lib/logger";

open(ws) {
  const { sessionId } = ws.data;
  wsLog.info({ sessionId, projectName: ws.data.projectName }, "chat session opened");
  // ...
},

// Replace catch { /* ignore */ } with:
catch (e) {
  wsLog.warn({ sessionId, error: (e as Error).message }, "ping failed");
}
```

### 4. File Transport (Replace setupLogFile)
Keep the file logging but route through consola:

```typescript
// In setupLogFile, replace monkey-patching with consola reporter:
import { createConsola } from "consola";
import { appendFileSync } from "node:fs";

logger.addReporter({
  log(logObj) {
    const line = `[${new Date().toISOString()}] [${logObj.tag || "app"}] [${logObj.type}] ${
      logObj.args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
    }\n`;
    try { appendFileSync(logPath, redact(line)); } catch {}
  },
});
```

### 5. Frontend Error Boundary
```typescript
// src/web/components/error-boundary.tsx
import { Component, type ReactNode } from "react";
import { toast } from "sonner";

export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[UI]", error, info.componentStack);
    toast.error(`UI Error: ${error.message}`);
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <div className="p-4 text-red-500">
          <h2>Something went wrong</h2>
          <pre className="text-xs mt-2">{this.state.error.message}</pre>
          <button onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

Wrap in `app.tsx`:
```tsx
<ErrorBoundary>
  <App />
</ErrorBoundary>
```

### 6. SDK/Provider Error Logging
```typescript
// src/providers/claude-agent-sdk.ts
import { sdkLog } from "../lib/logger";

// On tool execution:
sdkLog.debug({ sessionId, tool: toolName }, "tool start");
sdkLog.info({ sessionId, tool: toolName, duration }, "tool complete");
sdkLog.error({ sessionId, tool: toolName, error: err.message }, "tool failed");
```

## Bun Debugging Tools

| Tool | Command | Use Case |
|------|---------|----------|
| Inspector | `bun --inspect src/index.ts` | Step-through debugging |
| Break on start | `bun --inspect-brk src/index.ts` | Debug startup issues |
| Web debugger | `debug.bun.sh` | Visual debugging in browser |
| Network debug | `BUN_CONFIG_VERBOSE_FETCH=1` | Debug API/SDK calls |
| Heap snapshot | V8 heap via Chrome DevTools | Memory leak debugging |

### Quick Debug Commands
```bash
# Tail daemon logs live
tail -f ~/.ppm/ppm.log

# Filter by level
grep "\[ERROR\]" ~/.ppm/ppm.log
grep "\[FATAL\]" ~/.ppm/ppm.log

# Filter by subsystem
grep "\[ws\]" ~/.ppm/ppm.log
grep "\[sdk\]" ~/.ppm/ppm.log

# Debug with inspector (foreground mode)
bun --inspect run src/index.ts start -f

# Verbose fetch (see all HTTP from SDK)
BUN_CONFIG_VERBOSE_FETCH=1 bun run src/index.ts start -f
```

## Log Levels Strategy

| Level | When | Example |
|-------|------|---------|
| `fatal` | Process about to exit | uncaughtException, OOM |
| `error` | Operation failed, needs attention | SDK auth failure, WS crash |
| `warn` | Degraded but recoverable | Timeout retry, fallback used |
| `info` | Normal operations (default) | Server started, session opened |
| `debug` | Development tracing | Tool execution details, message parsing |
| `trace` | Verbose (never in production) | Raw WS frames, full SDK payloads |

**Dev default:** `debug` (level 4)
**Daemon default:** `info` (level 3)
**Override:** `LOG_LEVEL=4 ppm start`

## Migration Path

1. Add `consola` dependency
2. Create `src/lib/logger.ts` with tagged loggers
3. Replace `console.log/error/warn` in server files → `httpLog`, `wsLog`, `sdkLog`
4. Add `requestId` middleware to Hono
5. Update `setupLogFile` → consola reporter (keep redaction)
6. Add `ErrorBoundary` to frontend
7. Remove silent `catch {}` blocks → proper `wsLog.warn()`

**Estimated scope:** ~200 lines changed across ~15 files. No new architecture, just replace console calls with tagged logger calls.

## What NOT To Do (YAGNI)

- No log aggregation service (Datadog, ELK) — this is a CLI tool
- No distributed tracing (OpenTelemetry) — single process
- No log rotation library — `~/.ppm/ppm.log` is fine, user can truncate
- No Sentry/error reporting SaaS — overkill for dev tool
- No custom transport layer — consola reporters are sufficient
- No winston — heavy, Node.js-centric, unnecessary abstractions

## Key References

- [Consola](https://github.com/unjs/consola) — Elegant console logger for Node/Bun
- [Hono requestId middleware](https://hono.dev/docs/middleware/builtin/request-id)
- [Hono onError](https://hono.dev/docs/api/hono#error-handling)
- [Bun debugger](https://bun.sh/docs/runtime/debugger)
- [`BUN_CONFIG_VERBOSE_FETCH`](https://bun.sh/docs/runtime/configuration)
