/**
 * The normal form of an output line, so a child that prints the same thing again and again — a
 * wait loop logging "memory 86% committed; waiting" every five minutes — is seen as making no
 * progress, while any genuinely new line is. Lower-cased; ANSI codes stripped; timestamps become
 * `<t>`, long hex runs `<h>`, numbers and percentages `#`; whitespace collapsed. Empty lines and
 * lines of only punctuation or symbols (spinners, rules) have no normal form at all.
 */

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// 2026-11-16T02:37:11.123Z, 2026-11-16 02:37:11, 2026-11-16, 02:37:11, 02:37 (with optional zone).
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?|\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s?[ap]m)?\b/g;
// A run of 8+ hex digits holding at least one digit: hashes, ids, addresses.
const LONG_HEX = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/g;
const NUMBER = /[+-]?\d+(?:[.,]\d+)*%?/g;
const PUNCT_ONLY = /^[\p{P}\p{S}\s]*$/u;

/** Longest normal form kept; anything after is cut. */
export const MAX_FORM_CHARS = 200;

export const stripAnsi = (line: string): string => line.replace(ANSI, "");

/** The line's normal form, or null when it carries nothing (empty, punctuation or symbols only). */
export function normalizeLine(raw: string): string | null {
  const line = stripAnsi(raw).trim();
  if (!line || PUNCT_ONLY.test(line)) return null;
  const form = line.toLowerCase()
    .replace(TIMESTAMP, "<t>")
    .replace(LONG_HEX, "<h>")
    .replace(NUMBER, "#")
    .replace(/\s+/g, " ")
    .trim();
  return form ? form.slice(0, MAX_FORM_CHARS) : null;
}

/** Splits text into lines on `\n` and `\r` (a progress bar redrawn with `\r` is many lines). */
export const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);
