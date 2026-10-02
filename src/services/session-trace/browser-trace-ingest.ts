import {
  BROWSER_TRACE_TYPES,
  TRACE_DEVICE_ID_RE,
  TRACE_INGEST_MAX_BATCH,
  TRACE_INGEST_MAX_PAYLOAD_BYTES,
  type BrowserTraceBatch,
  type BrowserTraceEntry,
} from "../../shared/session-trace.ts";
import { redactSecrets } from "../redact-secrets.ts";
import type { TraceRow } from "./session-trace-store.ts";

/**
 * The server half of browser logging: what `POST /api/trace` accepts, from whom, and how often.
 *
 * The body is hostile by default — it arrives from any tab holding the token, including one
 * stuck in a render loop — so it is shape-checked here, entries that do not fit are dropped,
 * and a whole batch that does not fit is refused.
 */

/** A body past this is refused before it is parsed: 50 entries at the 16 KB cap plus framing. */
export const TRACE_INGEST_MAX_BODY_BYTES = TRACE_INGEST_MAX_BATCH * TRACE_INGEST_MAX_PAYLOAD_BYTES + 64 * 1024;

const ALLOWED_TYPES: ReadonlySet<string> = new Set(BROWSER_TRACE_TYPES);
const REF_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** How far back a corrected timestamp may land; older is a broken clock, not a buffered error. */
const MAX_BACKDATE_MS = 30 * 24 * 60 * 60 * 1000;

export type ParsedBatch =
  | { ok: true; batch: BrowserTraceBatch; dropped: number }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a batch. Refuses the whole thing only when its envelope is wrong or it is too big. */
export function parseBrowserBatch(raw: unknown): ParsedBatch {
  if (!isPlainObject(raw)) return { ok: false, error: "body must be an object" };
  const { deviceId, sentAt, entries } = raw;
  if (typeof deviceId !== "string" || !TRACE_DEVICE_ID_RE.test(deviceId)) return { ok: false, error: "invalid deviceId" };
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) return { ok: false, error: "invalid sentAt" };
  if (!Array.isArray(entries)) return { ok: false, error: "entries must be an array" };
  if (entries.length > TRACE_INGEST_MAX_BATCH) return { ok: false, error: `at most ${TRACE_INGEST_MAX_BATCH} entries per batch` };

  const kept: BrowserTraceEntry[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const { ts, type, refId, payload } = entry;
    if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) continue;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (refId !== null && refId !== undefined && (typeof refId !== "string" || !REF_ID_RE.test(refId))) continue;
    if (!isPlainObject(payload)) continue;
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(payload)); } catch { continue; }
    if (size > TRACE_INGEST_MAX_PAYLOAD_BYTES) continue;
    kept.push({ ts, type: type as BrowserTraceEntry["type"], refId: (refId as string | null | undefined) ?? null, payload });
  }
  return { ok: true, batch: { deviceId, sentAt, entries: kept }, dropped: entries.length - kept.length };
}

/**
 * Redact every string inside a value, one string at a time. Redacting the serialised JSON
 * instead would let a rule like `password: <rest>` eat a closing quote and corrupt the row.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
  return out;
}

/**
 * Rows for a validated batch. Timestamps are moved onto the server's clock by the offset the
 * batch itself reveals (`sentAt` against now), which keeps the delay of an error buffered
 * offline while removing a skewed clock — so browser rows sort correctly against agent rows.
 */
export function browserRows(batch: BrowserTraceBatch, now = Date.now()): TraceRow[] {
  const offset = now - batch.sentAt;
  return batch.entries.map((entry) => ({
    traceId: `browser:${batch.deviceId}`,
    turnId: null,
    ts: Math.round(Math.min(now, Math.max(now - MAX_BACKDATE_MS, entry.ts + offset))),
    source: "browser",
    origin: "browser",
    providerId: null,
    refId: entry.refId,
    type: entry.type,
    payloadJson: JSON.stringify({ type: entry.type, ...(redactDeep(entry.payload) as Record<string, unknown>) }),
  }));
}

export interface RateLimits {
  windowMs: number;
  maxRequests: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: RateLimits = { windowMs: 60_000, maxRequests: 60, maxEntries: 1_000 };

/**
 * A fixed-window limit per device id. Never per IP: behind a Cloudflare tunnel every client is
 * one IP, so a per-IP limit would let one machine in a render loop lock out all the others.
 */
export class DeviceRateLimiter {
  private windows = new Map<string, { start: number; requests: number; entries: number }>();

  constructor(private readonly limits: RateLimits = DEFAULT_LIMITS, private readonly now: () => number = Date.now) {}

  /** Count a request, or say how long until this device may send again. */
  take(deviceId: string, entries: number): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = this.now();
    let w = this.windows.get(deviceId);
    if (!w || now - w.start >= this.limits.windowMs) {
      w = { start: now, requests: 0, entries: 0 };
      this.windows.set(deviceId, w);
      if (this.windows.size > 1_000) this.prune(now);
    }
    if (w.requests + 1 > this.limits.maxRequests || w.entries + entries > this.limits.maxEntries) {
      return { allowed: false, retryAfterMs: Math.max(1, w.start + this.limits.windowMs - now) };
    }
    w.requests += 1;
    w.entries += entries;
    return { allowed: true };
  }

  private prune(now: number): void {
    for (const [id, w] of this.windows) if (now - w.start >= this.limits.windowMs) this.windows.delete(id);
  }
}
