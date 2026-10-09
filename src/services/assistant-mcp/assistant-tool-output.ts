import { textResult, type Json } from "../mcp-http-endpoint.ts";

/**
 * How the Assistant's tools hand data back: JSON in one text block, every free-text field cut
 * to a length, and the whole answer held under a byte budget, so one tool call cannot fill the
 * agent's context. Whatever was cut says so, so the agent knows to narrow its next call.
 */

/** Largest answer one tool call returns, in UTF-8 bytes. */
export const MAX_TOOL_RESULT_BYTES = 48 * 1024;

/** `text` cut to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters cut]`;
}

/**
 * A JSON answer. `items` is the list the budget is spent on: when the whole payload is over
 * {@link MAX_TOOL_RESULT_BYTES}, items are dropped from the end until it fits, and the answer
 * says how many were left out.
 */
export function jsonResult<T>(payload: Record<string, unknown>, items?: { key: string; list: T[] }): Json {
  const render = (value: Record<string, unknown>) => JSON.stringify(value, null, 1);
  let text = render(payload);
  if (items && Buffer.byteLength(text) > MAX_TOOL_RESULT_BYTES) {
    let kept = items.list.length;
    while (kept > 0) {
      kept = Math.floor(kept * 0.8);
      text = render({ ...payload, [items.key]: items.list.slice(0, kept), omitted: `${items.list.length - kept} more left out to keep this answer small; narrow the request to see them` });
      if (Buffer.byteLength(text) <= MAX_TOOL_RESULT_BYTES) break;
    }
  }
  if (Buffer.byteLength(text) > MAX_TOOL_RESULT_BYTES) {
    text = `${Buffer.from(text).subarray(0, MAX_TOOL_RESULT_BYTES - 120).toString("utf8")}\n… [answer cut at ${MAX_TOOL_RESULT_BYTES} bytes; narrow the request]`;
  }
  return textResult(text);
}

export const errorResult = (message: string): Json => textResult(message, true);

/**
 * A call PPM did not carry out because it needs the user's approval first: closing a tab that
 * holds unsaved work, reading outside the registered projects. Marked as an error, since
 * nothing happened, and shaped so the agent can say exactly what it wanted and why.
 */
export function needsApprovalResult(action: string, reason: string, details: Record<string, unknown> = {}): Json {
  return textResult(JSON.stringify({
    outcome: "needs-approval",
    action,
    reason,
    ...details,
    note: "Nothing was done. This needs the user's approval, which this tool cannot ask for yet: tell the user what you "
      + "wanted to do and why, and let them do it themselves.",
  }, null, 1), true);
}

/** A whole number argument within bounds, its default when absent; null when it is malformed. */
export function intArg(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}
