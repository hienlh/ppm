/**
 * Shrinks the two event types that carry other people's text before they become trace rows.
 *
 * A `tool_result` holds whatever the tool printed and a `tool_use` holds what the model wrote
 * into its call (a whole file for Write, both sides of an Edit). Most are small — 87% of results
 * measured were ≤ 4 KB — while the rest filled most of the trace's size cap, pushing older
 * sessions out early. A trace is for seeing what happened, and the start and end of a long
 * output say that, so a long text keeps its first and last 4 KB with a marker naming how much
 * was cut. An error result is kept whole: that is the one most likely to be read in full.
 *
 * Small payloads come back as the very same object, so their rows are byte-identical to before.
 */

/** Text longer than this is trimmed; at or under it is stored whole. */
export const TRACE_TEXT_LIMIT = 8192;
const HEAD_CHARS = 4096;
const TAIL_CHARS = 4096;
/** Nested tool input deeper than this is left as it is — no real tool call is shaped like that. */
const MAX_DEPTH = 8;

/** `text` itself when short enough, else its head and tail around a marker carrying the original length. */
export function trimTraceText(text: string): string {
  if (text.length <= TRACE_TEXT_LIMIT) return text;
  // Never cut between the two halves of a surrogate pair (an emoji, say): a lone half survives JSON
  // but reads back as U+FFFD. The head gives up one char there, the tail takes one more.
  const headEnd = isLowSurrogate(text.charCodeAt(HEAD_CHARS)) ? HEAD_CHARS - 1 : HEAD_CHARS;
  const tailStart = text.length - TAIL_CHARS - (isLowSurrogate(text.charCodeAt(text.length - TAIL_CHARS)) ? 1 : 0);
  const cut = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n…[trimmed ${cut} of ${text.length} chars]…\n${text.slice(tailStart)}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Trim every long string inside a tool call's input. `lengths` collects the original length of
 * each trimmed one under its dotted path (`content`, `edits.0.old_string`). Returns the input
 * itself when nothing was long.
 */
function trimInput(value: unknown, path: string, lengths: Record<string, number>, depth: number): unknown {
  if (typeof value === "string") {
    if (value.length <= TRACE_TEXT_LIMIT) return value;
    lengths[path || "input"] = value.length;
    return trimTraceText(value);
  }
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item, i) => {
      const next = trimInput(item, path ? `${path}.${i}` : String(i), lengths, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = trimInput(item, path ? `${path}.${key}` : key, lengths, depth + 1);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * The payload to store for one trace row. `tool_result` gains `outputLength` and `trimmed: true`
 * when its output was cut; `tool_use` gains `inputLengths` (original length per trimmed field)
 * and `trimmed: true`. Every other payload, and every payload with nothing long in it, is
 * returned unchanged.
 */
export function trimTracePayload(payload: unknown): unknown {
  if (!isPlainObject(payload)) return payload;
  if (payload.type === "tool_result") {
    if (payload.isError === true) return payload;
    const output = payload.output;
    if (typeof output !== "string" || output.length <= TRACE_TEXT_LIMIT) return payload;
    return { ...payload, output: trimTraceText(output), outputLength: output.length, trimmed: true };
  }
  if (payload.type === "tool_use") {
    const lengths: Record<string, number> = {};
    const input = trimInput(payload.input, "", lengths, 0);
    if (input === payload.input) return payload;
    return { ...payload, input, inputLengths: lengths, trimmed: true };
  }
  return payload;
}
