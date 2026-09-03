/**
 * Normalisation for the SendMessage tool (agent teams / cross-session peers).
 *
 * Two things make the raw tool input unfit to render directly:
 *
 * 1. The canonical schema is `{ to, message, summary?, notify_when_idle? }`, but older
 *    team instructions taught a `{ type, recipient, content }` shape. Agents that were
 *    told both send both, so the same text arrives twice in one payload.
 * 2. `message` is either plain text or a protocol object (shutdown / plan approval),
 *    and the object form also shows up as a JSON *string* when a teammate relays it.
 *
 * Everything here is pure so the card stays a thin renderer.
 */

/** Protocol payloads a teammate can send instead of prose. */
export interface SendMessageProtocol {
  type: string;
  request_id?: string;
  approve?: boolean;
  reason?: string;
  feedback?: string;
}

export interface NormalizedSendMessage {
  /** Recipient name — canonical `to`, falling back to the legacy `recipient`. */
  to: string;
  /** Author-side label for this row; never transmitted to the recipient. */
  summary?: string;
  /** Prose body. Empty when the message is a protocol payload. */
  text: string;
  /** First non-empty line of `text` — the only part the recipient previews. */
  firstLine: string;
  /** Set when the message is a protocol payload rather than prose. */
  protocol?: SendMessageProtocol;
  /** Message kind, used for the badge. `"message"` for ordinary prose. */
  kind: string;
  /** Recipient was asked to report back when it next goes idle. */
  notifyWhenIdle: boolean;
  /** Unrecognised keys, so a future schema field is surfaced instead of swallowed. */
  extras: Array<{ key: string; value: string }>;
}

/** Keys the card renders explicitly — everything else becomes an `extras` row. */
const KNOWN_KEYS = new Set([
  "to",
  "message",
  "summary",
  "notify_when_idle",
  // Legacy aliases from earlier team instructions.
  "recipient",
  "content",
  "type",
]);

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Protocol object if `v` looks like one (`{ type: string, ... }`), else null. */
function asProtocol(v: unknown): SendMessageProtocol | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (typeof p.type !== "string" || !p.type) return null;
  return {
    type: p.type,
    request_id: typeof p.request_id === "string" ? p.request_id : undefined,
    approve: typeof p.approve === "boolean" ? p.approve : undefined,
    reason: typeof p.reason === "string" ? p.reason : undefined,
    feedback: typeof p.feedback === "string" ? p.feedback : undefined,
  };
}

/** Same check for a body that arrived as a JSON string. */
function protocolFromJsonText(text: string): SendMessageProtocol | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asProtocol(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function normalizeSendMessage(input: Record<string, unknown>): NormalizedSendMessage {
  const to = str(input.to) || str(input.recipient);
  // Canonical field wins; `content` only fills in when `message` is absent. When both
  // are present they are the duplicate described above — the legacy copy is often a
  // truncated prefix, so keeping it would only add noise.
  const rawBody = input.message ?? input.content;
  const protocol = asProtocol(rawBody) ?? protocolFromJsonText(str(rawBody));
  const text = protocol ? "" : str(rawBody);
  const legacyType = str(input.type);
  const kind = protocol?.type || (legacyType && legacyType !== "message" ? legacyType : "message");
  const summary = str(input.summary).trim();

  const extras = Object.entries(input)
    .filter(([key]) => !KNOWN_KEYS.has(key))
    .map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
    }));

  return {
    to,
    summary: summary || undefined,
    text,
    firstLine: text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "",
    protocol: protocol ?? undefined,
    kind,
    notifyWhenIdle: input.notify_when_idle === true,
    extras,
  };
}

/** What the tool result says happened to the message. */
export interface SendMessageOutcome {
  ok: boolean;
  /** Human-readable detail, e.g. "Resuming agent dev-p1". */
  detail?: string;
  /** Peer name the runtime resolved the send to. */
  peer?: string;
  /** Disambiguating ref of that peer, when the runtime pinned one. */
  ref?: string;
}

/**
 * Unwrap the tool result. The SDK returns `[{ type: "text", text }]` where `text` is
 * itself the JSON status object, so a raw dump shows JSON inside JSON. Returns null
 * when the shape is anything else, so the caller can fall back to raw output.
 */
export function parseSendMessageResult(output: string): SendMessageOutcome | null {
  if (!output) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return null;
  }
  if (Array.isArray(payload)) {
    const textBlock = payload.find(
      (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text"
    ) as Record<string, unknown> | undefined;
    const inner = str(textBlock?.text);
    if (!inner) return null;
    try {
      payload = JSON.parse(inner);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const o = payload as Record<string, unknown>;
  if (typeof o.success !== "boolean") return null;
  const pin = (o.pin && typeof o.pin === "object" ? o.pin : null) as Record<string, unknown> | null;
  return {
    ok: o.success,
    detail: str(o.message) || str(o.error) || undefined,
    peer: pin ? str(pin.name) || undefined : undefined,
    ref: pin ? str(pin.ref) || undefined : undefined,
  };
}
