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
