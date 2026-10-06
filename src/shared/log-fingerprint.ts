/**
 * A record's fingerprint: its area, tag and level bucket plus its message with everything that
 * varies between two copies of the same event taken out — ids, numbers, quoted values, paths,
 * addresses. 48 copies of one warning share a fingerprint, so the AI is asked about them once
 * and its answer is kept per fingerprint: a second run only pays for fingerprints it has not
 * seen before.
 */
import { levelBucket, type LogEntry } from "./logs-model.ts";

const RULES: ReadonlyArray<[RegExp, string]> = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\b(?:toolu|msg|req|call|srvtoolu)_[A-Za-z0-9]+/g, "<id>"],
  [/https?:\/\/[^\s"'<>)]+/g, "<url>"],
  [/(?:~|\/)[\w.@-]+(?:\/[\w.@-]+)+/g, "<path>"],
  [/"(?:[^"\\]|\\.)*"/g, '"…"'],
  [/'(?:[^'\\]|\\.)*'/g, "'…'"],
  [/\b[0-9a-f]{12,}\b/gi, "<hex>"],
  [/\b\d+(?:[.,:]\d+)*(?:ms|s|m|h|kb|mb|gb|k|%|x)?\b/gi, "<n>"],
  // What is left with a digit in it is an id or a counter: account `a1`, worker `w3`, port `:8081`.
  [/\b[A-Za-z_]*\d\w*\b/g, "<n>"],
  [/\s+/g, " "],
];

export function normalizeLogMessage(msg: string): string {
  let out = msg;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.trim().slice(0, 240);
}

export function logFingerprint(entry: Pick<LogEntry, "src" | "tag" | "lv" | "msg">): string {
  return `${entry.src}|${entry.tag}|${levelBucket(entry.lv)}|${normalizeLogMessage(entry.msg)}`;
}
