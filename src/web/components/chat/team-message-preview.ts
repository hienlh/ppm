/**
 * Readable preview for an agent-team inbox message.
 *
 * A teammate's `text` is usually a JSON protocol payload, not prose — a
 * task_assignment carries `{ type, taskId, subject, description, assignedBy }`.
 * Rendering that raw dumps a wall of escaped JSON into the activity panel, so
 * every payload is reduced to a headline plus an optional body here.
 *
 * Pure module: the panel stays a thin renderer and this stays unit-testable.
 */

/** Field order for the one-line headline. First non-empty wins. */
const TITLE_FIELDS = ["subject", "summary", "text", "message", "content", "description", "reason", "feedback"];

/** Fields worth showing under the headline when they say more than it does. */
const DETAIL_FIELDS = ["description", "message", "content", "reason", "feedback"];

/** Structural keys that describe the envelope, never the content. */
const ENVELOPE_KEYS = new Set(["type", "taskId", "task_id", "assignedBy", "assigned_by", "timestamp", "request_id", "requestId"]);

export interface TeamMessagePreview {
  /** One-line headline — never raw JSON. */
  title: string;
  /** Longer body when the payload carries one beyond the headline. */
  detail?: string;
  /** Task id from a task_assignment, for a compact `#4` chip. */
  taskId?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

/** First non-empty value among `fields`, plus the key it came from. */
function pick(obj: Record<string, unknown>, fields: string[], skip?: string): { key: string; value: string } | null {
  for (const key of fields) {
    if (key === skip) continue;
    const value = str(obj[key]);
    if (value) return { key, value };
  }
  return null;
}

/** `key: value` pairs for a payload none of the known fields matched. */
function describeUnknownPayload(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([k, v]) => !ENVELOPE_KEYS.has(k) && str(v))
    .map(([k, v]) => `${k}: ${str(v)}`)
    .join(" · ");
}

/**
 * Reduce a raw inbox `text` to a headline and optional body.
 *
 * @param raw     The message's `text` — JSON payload or plain prose.
 * @param summary Author-supplied label; outranks anything inside the payload.
 */
export function previewTeamMessage(raw: string, summary?: string): TeamMessagePreview {
  const authored = str(summary);
  const text = str(raw);
  if (!text) return { title: authored };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Plain prose: first line is the headline, the rest is the body.
    const [first, ...rest] = text.split("\n");
    const detail = rest.join("\n").trim();
    return { title: authored || str(first), ...(detail ? { detail } : {}) };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { title: authored || text };
  }

  const obj = parsed as Record<string, unknown>;
  const taskId = str(obj.taskId) || str(obj.task_id);
  const head = pick(obj, TITLE_FIELDS);
  // Never repeat the headline as the body — skip whichever field supplied it.
  const body = pick(obj, DETAIL_FIELDS, head?.key);

  const title = authored || head?.value || describeUnknownPayload(obj) || str(obj.type) || text;
  return {
    title,
    ...(body ? { detail: body.value } : {}),
    ...(taskId ? { taskId } : {}),
  };
}
