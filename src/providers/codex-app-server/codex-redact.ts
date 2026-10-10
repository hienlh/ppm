/**
 * Single redaction/truncation helper routed through every codex log/serialize
 * site (client stderr, mapper tool_result output, approval-input serialization).
 * Tool inputs/outputs may carry file contents or secrets — cap size and scrub
 * obvious credential patterns before anything is emitted or logged.
 */

const DEFAULT_MAX = 8 * 1024;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // sk-..., API keys, bearer tokens, AWS keys
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "sk-***"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "gh_***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "jwt-***"],
  [/(?<=(?:authorization|api[_-]?key|token|secret|password)["'\s:=]{1,4})[A-Za-z0-9._\-]{12,}/gi, "***"],
];

export function redactTruncate(input: unknown, max = DEFAULT_MAX): string {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try { text = JSON.stringify(input); } catch { text = String(input); }
  }
  if (text == null) return "";

  for (const [re, repl] of SECRET_PATTERNS) text = text.replace(re, repl);

  if (text.length > max) {
    text = text.slice(0, max) + `… [truncated ${text.length - max} chars]`;
  }
  return text;
}

/** Past this size a structured value is flattened back into one capped string. */
const STRUCTURED_MAX = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_ITEMS = 200;
const SECRET_KEY = /authorization|api[_-]?key|token|secret|password/i;

/**
 * `redactTruncate` applied to every string inside a value, keeping its shape. A card that
 * renders its input (an approval, a question form) needs the object itself: the JSON string
 * `redactTruncate` returns gets stringified a second time and shows as escaped JSON. Depth,
 * array length and the total size stay bounded, so the payload is never larger than before
 * by more than a constant.
 */
export function redactFields(input: unknown, max = DEFAULT_MAX): unknown {
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactTruncate(value, max);
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object" || depth >= MAX_DEPTH) return redactTruncate(value, max);
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((v) => walk(v, depth + 1));
      if (value.length > MAX_ITEMS) items.push(`… [${value.length - MAX_ITEMS} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // The credential pattern keys on the name before the value (`"token":"…"`), which a
      // field-by-field walk no longer has in the same string — so put it back for the check.
      out[k] = typeof v === "string" && SECRET_KEY.test(k)
        ? redactTruncate(`${k}=${v}`, max + k.length + 1).slice(k.length + 1)
        : walk(v, depth + 1);
    }
    return out;
  };
  const result = walk(input, 0);
  let size: number;
  try { size = JSON.stringify(result)?.length ?? 0; } catch { return redactTruncate(input, max); }
  return size > STRUCTURED_MAX ? redactTruncate(input, max) : result;
}
