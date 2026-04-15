# Code Review: Extension Error Reporting & Logging

## Scope
- **Files**: 7 (extension.service.ts, ws/extensions.ts, extension-store.ts, use-extension-ws.ts, extension-webview.tsx, extension-host-worker.ts, ext-git-graph/extension.ts)
- **LOC changed**: ~270 additions across error tracking, toast notifications, breadcrumb logs, stash/conflict features
- **Focus**: Error propagation, type safety, memory, race conditions, toast spam

## Overall Assessment

Solid improvement to extension debugging. The silent failure path is now surfaced end-to-end: activation errors stored server-side, sent to clients on connect and broadcast, displayed in webview UI with retry. Breadcrumb logs added at each layer. A few issues need attention.

---

## Critical Issues

None found.

---

## High Priority

### H1. Type bypass: `activationErrors` piggybacked outside `ExtServerMsg` union

**Files**: `extensions.ts:78-79`, `use-extension-ws.ts:43-44`, `extension.service.ts:269-272`

The `activationErrors` field is added to `contributions:update` messages via `Record<string, unknown>` or `(msg as any).activationErrors`, bypassing the `ExtServerMsg` discriminated union type. The type definition at `extension-messages.ts:54` does not include this field.

**Impact**: Any future refactor touching `ExtServerMsg` won't catch this field. TypeScript provides zero safety on the consumer side. If the field name changes server-side, the client silently receives nothing.

**Fix**: Extend the union member:
```ts
// extension-messages.ts
| { type: "contributions:update"; contributions: ExtensionContributes; activationErrors?: Record<string, string> }
```
Then remove all `(msg as any).activationErrors` casts and `Record<string, unknown>` intermediate types.

### H2. Toast spam on every `contributions:update` broadcast

**File**: `use-extension-ws.ts:43-49`

Every `contributions:update` with `activationErrors` fires `toast.error()` for each error entry. This message is broadcast on every `activate()` AND `deactivate()` call (both call `broadcastContributions()`). If 3 extensions fail on startup and then any extension activates/deactivates later, all 3 error toasts fire again.

**Impact**: Users see repeated error toasts for errors they already acknowledged. With N failing extensions and M subsequent operations, toast count = N * M.

**Fix**: Track which errors have already been toasted (e.g., compare previous `activationErrors` keys before showing new toasts):
```ts
case "contributions:update":
  store.setContributions(msg.contributions);
  if (msg.activationErrors) {
    const prev = store.activationErrors;
    const errors = msg.activationErrors;
    store.setActivationErrors(errors);
    // Only toast NEW errors
    for (const [extId, error] of Object.entries(errors)) {
      if (!prev[extId]) {
        toast.error(`Extension "${extId}" failed to activate: ${error}`);
      }
    }
  }
  break;
```

### H3. `activationErrors` Map never cleared on `terminateWorker()` / `shutdown()`

**File**: `extension.service.ts:55-63`

`terminateWorker()` clears `activatedIds`, `extensionPaths`, `bundledIds` but not `activationErrors`. After a shutdown + restart cycle, stale errors from the previous session persist and get broadcast to new clients.

**Fix**: Add `this.activationErrors.clear()` inside `terminateWorker()`.

---

## Medium Priority

### M1. Retry loop fires commands indefinitely until panel appears

**File**: `extension-webview.tsx:86-94`

The `setInterval` fires `ext:command:execute` every 2 seconds with no upper bound (except the 10s timeout that just shows an error message, but does NOT stop the interval). The cleanup function only runs on unmount or dependency change (`[panel, viewType, projectName]`).

If the extension is broken (e.g., activation failed), this dispatches a command every 2s forever while the tab is open.

**Impact**: Wasted network/CPU; if the command triggers server-side side effects (e.g., webview creation), could cause resource leaks.

**Fix**: Cap retries (e.g., 5 attempts) or clear the interval when `timedOut` becomes true:
```ts
let attempts = 0;
const retryTimer = setInterval(() => {
  if (!cancelled && attempts++ < 5) attempt();
  else clearInterval(retryTimer);
}, 2_000);
```

### M2. `activationError` matching in extension-webview.tsx is fragile

**File**: `extension-webview.tsx:122-128`

```ts
if (extId.includes(viewType) || viewType.includes(extId.replace(/^ext-/, "")))
```

This substring matching can produce false positives. Example: viewType `"graph"` would match extId `"ext-git-graph"` and also hypothetically `"ext-graph-viz"`, `"ext-photography"`. Also, an extId like `"ext-editor"` stripped to `"editor"` would match a viewType of `"editor-settings"`.

**Fix**: Use exact matching or a registry-based lookup:
```ts
const extensionId = metadata?.extensionId as string | undefined;
const activationError = useExtensionStore((s) =>
  extensionId ? s.activationErrors[extensionId] : undefined
);
```

### M3. `detectMergeState` path construction not Windows-safe

**File**: `ext-git-graph/extension.ts:543`

```ts
if (!gitDir.startsWith("/")) gitDir = `${projectPath}/${gitDir}`;
```

On Windows, git returns paths with backslashes or drive letters (e.g., `C:\...`). The `startsWith("/")` check fails. String concatenation with `/` produces mixed separators.

Per project memory (`feedback_cross_platform_paths.md`): file/path features must work on Windows too.

**Fix**: Use `path.resolve()` or `path.isAbsolute()`:
```ts
const path = require("path");
if (!path.isAbsolute(gitDir)) gitDir = path.resolve(projectPath, gitDir);
```

### M4. `getActivationErrors()` returns mutable reference

**File**: `extension.service.ts:263`

```ts
getActivationErrors(): Map<string, string> { return this.activationErrors; }
```

Callers (ws/extensions.ts) get a direct reference to the internal Map. If any consumer mutates it, the service state is corrupted silently.

**Fix**: Return a snapshot:
```ts
getActivationErrors(): Map<string, string> { return new Map(this.activationErrors); }
```

---

## Low Priority

### L1. `broadcastExtMsg` type mismatch with `Record<string, unknown>`

**File**: `extensions.ts:78-80`

`readyMsg` is typed as `Record<string, unknown>` but passed to `ws.send(JSON.stringify(readyMsg))` directly, bypassing the `broadcastExtMsg(msg: ExtServerMsg)` type check. This is consistent with the H1 issue -- fixing H1 resolves this.

### L2. Error messages in command:execute notifications could leak internal paths

**File**: `extensions.ts:98, 112-116`

`result?.error` and `e.message` are sent directly to browser clients. These can contain stack traces with server file paths (e.g., `/Users/hienlh/Projects/ppm/...`).

**Fix**: Truncate or sanitize error messages before broadcasting:
```ts
const safeMsg = (msg: string) => msg.split('\n')[0].slice(0, 200);
```

### L3. `broadcastExtMsg` used for command errors sends to ALL clients

**File**: `extensions.ts:94-116`

When one client's command fails, the error notification is broadcast to all connected clients via `broadcastExtMsg`. Only the requesting client should see the error.

**Fix**: Send error only to the requesting socket:
```ts
ws.send(JSON.stringify({ type: "notification", ... }));
```

---

## Positive Observations

1. **Breadcrumb logging** at each layer (ExtService, ExtHost, ExtWS, extension) creates clear trail for debugging
2. **Activation error storage** with Map allows per-extension tracking and clearing on successful retry
3. **Error display in webview** with retry button is good UX -- users get actionable feedback
4. **Existing security**: `assertSafeFilePaths` properly validates all user-supplied paths in git-graph
5. **Timeout handling** in activation (10s in worker) and webview loading (10s in UI) prevents indefinite hangs
6. **Stash and conflict detection** implementations are clean and well-structured

---

## Recommended Actions (Priority Order)

1. **[H1]** Add `activationErrors?` to `ExtServerMsg` type union, remove `as any` casts
2. **[H2]** Deduplicate toasts by tracking previously shown errors
3. **[H3]** Clear `activationErrors` in `terminateWorker()`
4. **[M1]** Cap retry attempts in extension-webview reload loop
5. **[M2]** Use exact extension ID matching instead of substring
6. **[M3]** Fix Windows path handling in `detectMergeState`
7. **[M4]** Return Map copy from `getActivationErrors()`

---

## Unresolved Questions

- Is there an intentional reason `activationErrors` is not part of the `ExtServerMsg` type? If so, document the rationale.
- Should `activationErrors` be cleared when an extension is uninstalled/removed? Currently `remove()` calls `deactivate()` but doesn't touch `activationErrors`.
