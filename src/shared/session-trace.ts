/**
 * Shapes shared by the session trace's writers: the server (agent runs) and the browser
 * (`POST /api/trace`). See `docs/architecture/plugins-and-tracing.md`.
 */

/** Who wrote a row: a provider's stream, PPM itself (inputs, outcomes), or a browser tab. */
export type TraceSource = "agent" | "server" | "browser";

/** Which door a run came through. The browser path is `ws`; `browser` is only for client rows. */
export type TraceOrigin =
  | "ws"
  | "scheduler"
  | "ppmbot"
  | "group-chat"
  | "jira"
  | "cli"
  | "proxy"
  | "browser"
  /** A message the PPM Assistant sent into a chat, with the user's approval. */
  | "assistant"
  | "unknown";

/** Most entries one `POST /api/trace` may carry; a larger batch is refused whole. */
export const TRACE_INGEST_MAX_BATCH = 50;

/** Largest serialised payload one browser entry may carry; a larger entry is dropped. */
export const TRACE_INGEST_MAX_PAYLOAD_BYTES = 16 * 1024;

/** A device id as `device-id.ts` mints it (a UUID) — anything else is refused. */
export const TRACE_DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Row types a browser may write. Anything else in a batch is dropped. */
export const BROWSER_TRACE_TYPES = [
  "console_log",
  "console_info",
  "console_debug",
  "console_warn",
  "console_error",
  "browser_error",
  "unhandled_rejection",
  "render_error",
  "chunk_error",
  "entry_never_ran",
  "console_dropped",
] as const;

export type BrowserTraceType = (typeof BROWSER_TRACE_TYPES)[number];

export interface BrowserTraceEntry {
  /** The browser's clock when it happened; the server corrects it by `sentAt`. */
  ts: number;
  type: BrowserTraceType;
  /** The chat session the tab was showing, so the row joins that session's trace. */
  refId: string | null;
  payload: Record<string, unknown>;
}

export interface BrowserTraceBatch {
  deviceId: string;
  /** The browser's clock at send time, so a skewed clock can be corrected. */
  sentAt: number;
  entries: BrowserTraceEntry[];
}
