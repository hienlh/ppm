/**
 * Ships the browser's console and its errors to the session trace (`POST /api/trace`), so a bug
 * seen on a phone — or in any tab nobody had devtools open on — can be read on the server later,
 * next to the chat turn the tab was showing.
 *
 * Every console level is sent, batched: errors within a second, everything else within a few.
 * Each error-level entry also carries the last 50 console lines before it, so it still reads
 * on its own when a flood got the lines around it rate-limited away.
 *
 * Installed by `trace-boot.ts`, the first import of `main.tsx`, so it is in the boot shell and
 * running before the rest of the app evaluates: the failure that matters most, a chunk that
 * will not load, is exactly what a lazily loaded reporter could never report. The case where
 * the entry never runs at all belongs to the inline watchdog in `index.html`.
 *
 * Nothing here may make things worse than the failure it reports. It never throws, never
 * produces an unhandled rejection of its own, and caps what it records per minute — a tab has
 * been measured throwing ~87k rejections a second, and that must cost a counter, not a network.
 */
import {
  TRACE_INGEST_MAX_BATCH,
  type BrowserTraceEntry,
  type BrowserTraceType,
} from "../../shared/session-trace";
import { getDeviceId, uuidV4 } from "./device-id";

export const TRACE_QUEUE_KEY = "ppm-trace-queue";
export const MAX_QUEUE = 300;
export const MAX_BREADCRUMBS = 50;
export const MAX_ENTRIES_PER_MINUTE = 300;
/** Under the server's 16 KB per entry, with room for multi-byte characters. */
export const MAX_PAYLOAD_CHARS = 12_000;
/** Browsers refuse a keepalive request once the in-flight keepalive bodies pass 64 KB. */
export const KEEPALIVE_BUDGET_CHARS = 60_000;
export const ERROR_FLUSH_MS = 1_000;
export const LOG_FLUSH_MS = 5_000;
const MIN_BACKOFF_MS = 5_000;
/** How often a refused tab looks for a sign-in: a storage read, never a request. */
export const AUTH_RECHECK_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const PERSIST_DEBOUNCE_MS = 1_000;
const MAX_PERSIST_CHARS = 256 * 1024;
const MAX_ARG_CHARS = 2_000;
const MAX_BREADCRUMB_CHARS = 300;
/** Nodes one logged object may cost to describe; past it, the rest is elided. */
const MAX_DESCRIBE_NODES = 500;

const CONSOLE_LEVELS = ["log", "info", "debug", "warn", "error"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

const ERROR_TYPES: ReadonlySet<BrowserTraceType> = new Set([
  "console_error",
  "browser_error",
  "unhandled_rejection",
  "render_error",
  "chunk_error",
]);

export interface SendResult {
  status: number;
  retryAfterMs?: number;
}

export interface TraceClientDeps {
  send: (body: string, keepalive: boolean, token: string | null) => Promise<SendResult>;
  /** The token a request would carry now. After a 401, only a change to it is worth a retry. */
  authToken: () => string | null;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  deviceId: () => string;
  refId: () => string | null;
  /** Fields stamped on every entry: which page load, which route. */
  context: () => Record<string, unknown>;
}

interface Breadcrumb {
  ts: number;
  level: string;
  text: string;
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more]`;
}

export function errorText(error: Error): string {
  const head = `${error.name || "Error"}: ${error.message}`;
  const stack = typeof error.stack === "string" ? error.stack : "";
  // V8 starts the stack with the head; Firefox and Safari do not.
  return stack.startsWith(head) ? stack : stack ? `${head}\n${stack}` : head;
}

/** One console argument as text, at a bounded cost however large the object logged. */
export function describe(value: unknown): string {
  if (typeof value === "string") return cap(value, MAX_ARG_CHARS);
  if (value instanceof Error) return cap(errorText(value), MAX_ARG_CHARS * 2);
  if (value === undefined) return "undefined";
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (value === null || typeof value !== "object") return String(value);
  if (typeof Node !== "undefined" && value instanceof Node) {
    return `<${(value as Element).tagName?.toLowerCase() ?? value.nodeName}>`;
  }
  if (typeof Event !== "undefined" && value instanceof Event) return describeEvent(value);
  const seen = new WeakSet<object>();
  let nodes = 0;
  try {
    const json = JSON.stringify(value, (_key, v: unknown) => {
      if (++nodes > MAX_DESCRIBE_NODES) return "[…]";
      if (typeof v === "bigint") return `${v}n`;
      if (v instanceof Error) return errorText(v);
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
    return cap(json ?? String(value), MAX_ARG_CHARS);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * An Event keeps its fields on the prototype, so JSON sees only `{"isTrusted":true}` — which is
 * all a promise rejected with a script's or a socket's `error` event used to leave in the log.
 */
function describeEvent(event: Event): string {
  const target = event.target as (EventTarget & { tagName?: string; src?: string; href?: string; url?: string }) | null;
  let on = "";
  if (target) {
    const name = target.tagName ? `<${target.tagName.toLowerCase()}>` : (target.constructor?.name ?? "");
    const where = target.src || target.href || target.url || "";
    on = ` on ${name}${where ? ` ${where}` : ""}`;
  }
  return cap(`[${event.constructor?.name ?? "Event"} ${event.type}${on}]`, MAX_ARG_CHARS);
}

/** A thrown value — an Error or anything else — as the fields an error entry carries. */
export function errorPayload(value: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (value instanceof Error) {
    return { name: value.name, message: cap(value.message, MAX_ARG_CHARS), stack: cap(errorText(value), MAX_ARG_CHARS * 3), ...extra };
  }
  return { message: describe(value), ...extra };
}

/** Shrink a payload until it fits one entry: oldest breadcrumbs first, then long strings, then a head. */
function fit(payload: Record<string, unknown>): Record<string, unknown> {
  let json = JSON.stringify(payload);
  if (json.length <= MAX_PAYLOAD_CHARS) return payload;
  const out = { ...payload };
  if (Array.isArray(out.breadcrumbs)) {
    const crumbs = [...(out.breadcrumbs as unknown[])];
    while (crumbs.length > 0 && json.length > MAX_PAYLOAD_CHARS) {
      crumbs.shift();
      out.breadcrumbs = crumbs;
      json = JSON.stringify(out);
    }
    if (json.length <= MAX_PAYLOAD_CHARS) return out;
  }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.length > 1_000) out[k] = cap(v, 1_000);
    if (Array.isArray(v) && k === "args") out[k] = v.map((a) => (typeof a === "string" ? cap(a, 1_000) : a));
  }
  json = JSON.stringify(out);
  if (json.length <= MAX_PAYLOAD_CHARS) return out;
  return { truncated: true, head: json.slice(0, MAX_PAYLOAD_CHARS - 200) };
}

export interface TraceClient {
  record(type: BrowserTraceType, payload: Record<string, unknown>): void;
  console(level: ConsoleLevel, args: unknown[]): void;
  flush(): Promise<void>;
  /** The page is going away: send what fits in one keepalive request, persist the rest. */
  flushOnHide(): void;
  pending(): number;
}

export function createTraceClient(deps: TraceClientDeps): TraceClient {
  let queue: BrowserTraceEntry[] = restore();
  /** Entries in a request that has not answered yet — never put in a second one. */
  const sending = new Set<BrowserTraceEntry>();
  const breadcrumbs: Breadcrumb[] = [];
  let flushTimer: unknown = null;
  let flushDueAt = Infinity;
  let persistTimer: unknown = null;
  let inFlight = false;
  let backoffMs = 0;
  let blockedUntil = 0;
  /** The token a 401 answered; undefined while nothing has been refused. */
  let rejectedToken: string | null | undefined;
  let windowStart = deps.now();
  let windowCount = 0;
  let droppedInWindow = 0;

  function restore(): BrowserTraceEntry[] {
    try {
      const raw = deps.storage?.getItem(TRACE_QUEUE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(parsed) ? (parsed as BrowserTraceEntry[]).slice(-MAX_QUEUE) : [];
    } catch {
      return [];
    }
  }

  function persistNow(): void {
    if (persistTimer != null) { deps.clearTimer(persistTimer); persistTimer = null; }
    try {
      if (queue.length === 0) { deps.storage?.removeItem(TRACE_QUEUE_KEY); return; }
      let kept = queue;
      let json = JSON.stringify(kept);
      while (json.length > MAX_PERSIST_CHARS && kept.length > 1) {
        kept = kept.slice(Math.ceil(kept.length / 4));
        json = JSON.stringify(kept);
      }
      deps.storage?.setItem(TRACE_QUEUE_KEY, json);
    } catch {
      // Quota or disabled storage: the in-memory queue is still sent.
    }
  }

  function schedulePersist(): void {
    if (persistTimer != null) return;
    persistTimer = deps.setTimer(() => { persistTimer = null; persistNow(); }, PERSIST_DEBOUNCE_MS);
  }

  function schedule(ms: number): void {
    const due = deps.now() + ms;
    if (flushTimer != null && flushDueAt <= due) return;
    if (flushTimer != null) deps.clearTimer(flushTimer);
    flushDueAt = due;
    flushTimer = deps.setTimer(() => {
      flushTimer = null;
      flushDueAt = Infinity;
      void flush();
    }, ms);
  }

  function refId(): string | null {
    try { return deps.refId(); } catch { return null; }
  }

  function token(): string | null {
    try { return deps.authToken(); } catch { return null; }
  }

  /** Refused, and no sign-in since: a request would only be refused again. */
  function awaitingSignIn(current: string | null): boolean {
    return rejectedToken !== undefined && current === rejectedToken;
  }

  function push(type: BrowserTraceType, payload: Record<string, unknown>, now: number): void {
    let context: Record<string, unknown> = {};
    try { context = deps.context(); } catch { /* entry without context */ }
    queue.push({ ts: now, type, refId: refId(), payload: fit({ ...context, ...payload }) });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    schedulePersist();
  }

  /** The per-minute budget. Returns false once spent, counting what it turned away. */
  function admit(now: number): boolean {
    if (now - windowStart >= 60_000) {
      const dropped = droppedInWindow;
      windowStart = now;
      windowCount = 0;
      droppedInWindow = 0;
      if (dropped > 0) {
        windowCount++;
        push("console_dropped", { count: dropped }, now);
      }
    }
    if (windowCount >= MAX_ENTRIES_PER_MINUTE) {
      droppedInWindow++;
      return false;
    }
    windowCount++;
    return true;
  }

  function record(type: BrowserTraceType, payload: Record<string, unknown>): void {
    try {
      const now = deps.now();
      if (!admit(now)) return;
      const isError = ERROR_TYPES.has(type);
      push(type, isError ? { ...payload, breadcrumbs: breadcrumbs.slice() } : payload, now);
      schedule(isError ? ERROR_FLUSH_MS : LOG_FLUSH_MS);
    } catch {
      // Recording must never be the thing that breaks the page.
    }
  }

  function consoleLine(level: ConsoleLevel, args: unknown[]): void {
    try {
      const now = deps.now();
      if (!admit(now)) return;
      const texts = args.map(describe);
      const type = `console_${level}` as BrowserTraceType;
      const isError = ERROR_TYPES.has(type);
      // The line itself is not its own breadcrumb: breadcrumbs are what came before.
      push(type, isError ? { args: texts, breadcrumbs: breadcrumbs.slice() } : { args: texts }, now);
      breadcrumbs.push({ ts: now, level, text: cap(texts.join(" "), MAX_BREADCRUMB_CHARS) });
      if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift();
      schedule(isError ? ERROR_FLUSH_MS : LOG_FLUSH_MS);
    } catch {
      // See record().
    }
  }

  function takeBatch(budgetChars: number): BrowserTraceEntry[] {
    const batch: BrowserTraceEntry[] = [];
    let chars = 200;
    for (const entry of queue) {
      if (sending.has(entry)) continue;
      if (batch.length >= TRACE_INGEST_MAX_BATCH) break;
      const size = JSON.stringify(entry).length + 1;
      if (batch.length > 0 && chars + size > budgetChars) break;
      batch.push(entry);
      chars += size;
    }
    return batch;
  }

  function body(batch: BrowserTraceEntry[]): string {
    return JSON.stringify({ deviceId: deps.deviceId(), sentAt: deps.now(), entries: batch });
  }

  function remove(batch: BrowserTraceEntry[]): void {
    const sent = new Set(batch);
    queue = queue.filter((e) => !sent.has(e));
  }

  function backOff(retryAfter?: number): void {
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, backoffMs * 2));
    blockedUntil = deps.now() + Math.max(backoffMs, retryAfter ?? 0);
    schedule(blockedUntil - deps.now());
  }

  /** Worth another try: offline, rate-limited, or a server in trouble. */
  function retryable(status: number): boolean {
    return status === 0 || status === 429 || status >= 500;
  }

  async function flush(): Promise<void> {
    try {
      if (queue.length === 0) return;
      const now = deps.now();
      if (inFlight || now < blockedUntil) {
        schedule(Math.max(blockedUntil - now, ERROR_FLUSH_MS));
        return;
      }
      const auth = token();
      if (awaitingSignIn(auth)) {
        schedule(AUTH_RECHECK_MS);
        return;
      }
      const batch = takeBatch(Infinity);
      if (batch.length === 0) return;
      inFlight = true;
      for (const e of batch) sending.add(e);
      let result: SendResult;
      try {
        result = await deps.send(body(batch), false, auth);
      } catch {
        result = { status: 0 };
      } finally {
        inFlight = false;
        for (const e of batch) sending.delete(e);
      }
      if (result.status >= 200 && result.status < 300) {
        remove(batch);
        backoffMs = 0;
        blockedUntil = 0;
        rejectedToken = undefined;
        if (queue.length > 0) schedule(0);
      } else if (result.status === 401) {
        // Logged out, or a token that stopped working: kept for the sign-in that replaces it,
        // so a fresh device's login screen is not the one page that cannot be debugged. The
        // rows still only ever reach the server authenticated.
        rejectedToken = auth;
        schedule(AUTH_RECHECK_MS);
      } else if (retryable(result.status)) {
        backOff(result.retryAfterMs);
      } else {
        // 400/403/413: this batch will never be accepted, and retrying it forever would pin
        // the queue.
        remove(batch);
      }
      schedulePersist();
    } catch {
      inFlight = false;
    }
  }

  function flushOnHide(): void {
    try {
      const auth = token();
      // Refused already: storage carries them to the next load instead.
      if (queue.length > 0 && !awaitingSignIn(auth)) {
        const batch = takeBatch(KEEPALIVE_BUDGET_CHARS);
        if (batch.length > 0) {
          remove(batch);
          // Removed first so a page that does unload does not resend them from storage on the
          // next load; put back if this page lives on and the request turns out to have failed.
          const putBack = (status: number, retryAfter?: number) => {
            queue.unshift(...batch);
            if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
            schedulePersist();
            if (status === 401) {
              rejectedToken = auth;
              schedule(AUTH_RECHECK_MS);
            } else {
              backOff(retryAfter);
            }
          };
          deps.send(body(batch), true, auth)
            .then((r) => { if (r.status === 401 || retryable(r.status)) putBack(r.status, r.retryAfterMs); })
            .catch(() => putBack(0));
        }
      }
      persistNow();
    } catch {
      // Unloading; nothing left to do.
    }
  }

  if (queue.length > 0) schedule(2_000);

  return {
    record,
    console: consoleLine,
    flush,
    flushOnHide,
    pending: () => queue.length,
  };
}

/**
 * Wrap each console method so the line also reaches the client. The original always runs first
 * and with the same arguments; a line produced while recording one is not recorded again.
 */
export function patchConsole(target: Console, client: Pick<TraceClient, "console">): void {
  let recording = false;
  for (const level of CONSOLE_LEVELS) {
    const original = target[level];
    if (typeof original !== "function") continue;
    target[level] = function (this: Console, ...args: unknown[]) {
      original.apply(this, args);
      if (recording) return;
      recording = true;
      try { client.console(level, args); } finally { recording = false; }
    } as Console[typeof level];
  }
}

let installed: TraceClient | null = null;
let refResolver: () => string | null = () => null;

/** Which chat session the tab is showing, so its rows join that session's trace. Set by the app. */
export function setTraceRefResolver(resolver: () => string | null): void {
  refResolver = resolver;
}

/** Report a failure the app caught itself (the root boundary, chunk recovery). No-op until installed. */
export function reportTraceError(type: "render_error" | "chunk_error", error: unknown, extra: Record<string, unknown> = {}): void {
  installed?.record(type, errorPayload(error, extra));
}

function retryAfterMs(res: Response): number | undefined {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
}

export function installTraceClient(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  const pageId = uuidV4();
  let storage: TraceClientDeps["storage"] = null;
  try { storage = window.localStorage; } catch { /* private mode */ }

  const client = createTraceClient({
    send: async (payload, keepalive, token) => {
      const res = await fetch("/api/trace", {
        method: "POST",
        keepalive,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: payload,
      });
      return { status: res.status, retryAfterMs: retryAfterMs(res) };
    },
    authToken: () => storage?.getItem("ppm-auth-token") ?? null,
    storage,
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    deviceId: getDeviceId,
    refId: () => refResolver(),
    context: () => ({ page: pageId, path: location.pathname }),
  });
  installed = client;

  patchConsole(console, client);
  window.addEventListener("error", (event) => {
    client.record("browser_error", errorPayload(event.error ?? event.message, {
      ...(event.filename ? { source: event.filename, line: event.lineno, col: event.colno } : {}),
      ua: navigator.userAgent,
    }));
  });
  window.addEventListener("unhandledrejection", (event) => {
    client.record("unhandled_rejection", errorPayload(event.reason, { ua: navigator.userAgent }));
  });
  // Mobile browsers often skip pagehide; `hidden` is the last event they reliably deliver.
  window.addEventListener("pagehide", () => client.flushOnHide());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") client.flushOnHide();
  });
  window.addEventListener("online", () => { void client.flush(); });
}
