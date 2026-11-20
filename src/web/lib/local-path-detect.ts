/**
 * Finding the folder and file paths an AI answer names, so they can become links that open the
 * file browser (a folder) or the file.
 *
 * Detection only says "this looks like a path"; nothing becomes a link until the server has
 * checked that it exists and may be shown (`POST /api/fs/locate`). Detection still has to be
 * strict, because every candidate costs a check and a sentence is full of slashes that are not
 * paths: URLs, "and/or", fractions (1/2), dates (20/11/2026), ratios (16/9).
 *
 * What counts, in running text:
 * - absolute: `C:\…`, `D:/…`, `~/…`, `/a/b` (a POSIX path needs two names, or one with an extension);
 * - relative (`src/app.ts`, `docs/`, `src/web/components`): only with an extension, a trailing
 *   separator or at least two separators — `a/b` in a sentence is never one.
 * In an inline code span, which an AI uses to quote a path, the whole span counts as one path
 * (spaces allowed), and any relative path with a separator counts.
 *
 * Pure (no stores, no DOM), so the rules are unit-tested.
 */

import { splitSourceLocation, type SourceLine } from "./source-location";

export interface DetectedPath {
  /** Where the path starts and ends in the text it was found in (the `:line` suffix included). */
  start: number;
  end: number;
  /** The path itself, without a `:line` suffix. */
  path: string;
  line?: SourceLine;
}

const MAX_PATH_CHARS = 1024;
/** Characters that never sit inside a path in prose (quotes, brackets, shell metacharacters, globs). */
const FORBIDDEN = /["<>|*?{}\[\]`]/;
const LEADING_STRIP = /^[("'«“‘]+/;
const TRAILING_STRIP = /[)"'.,;:!?»”’]+$/;
const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;
const HOME_REL = /^~[\\/]/;
/** A name: letters (any script), digits and the punctuation file names use. */
const SEGMENT = /^[\p{L}\p{N}_.@+\-~() ,]+$/u;
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
const NUMERIC = /^[\d.,:-]+$/;

/** The path and line a token names, or null. */
function splitLine(token: string): { path: string; line?: SourceLine } | null {
  const located = splitSourceLocation(token);
  if (!located || !located.path) return null;
  return located;
}

/** Names a path splits into, empty ones (a root, a doubled or trailing separator) dropped. */
const segmentsOf = (path: string) => path.split(/[\\/]+/).filter(Boolean);

/** Whether every name in `path` (after its root) is a plausible file or folder name. */
function plausibleNames(names: string[]): boolean {
  return names.length > 0
    && names.every((n) => n === "." || n === ".." || SEGMENT.test(n))
    && !names.every((n) => NUMERIC.test(n));
}

/**
 * Whether `path` reads as a path. `quoted` is true inside an inline code span, where the author
 * marked the whole text as one name.
 */
export function looksLikeLocalPath(path: string, quoted = false): boolean {
  if (!path || path.length > MAX_PATH_CHARS || /[\u0000-\u001f]/.test(path)) return false;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path) || /^www\./i.test(path) || path.startsWith("//") || path.startsWith("\\\\")) return false;
  if (FORBIDDEN.test(path)) return false;
  if (!quoted && /\s/.test(path)) return false;

  if (WINDOWS_ABS.test(path)) {
    const names = segmentsOf(path.slice(3));
    return names.length === 0 ? quoted : plausibleNames(names);
  }
  if (HOME_REL.test(path)) return plausibleNames(segmentsOf(path.slice(2)));
  if (path.startsWith("/")) {
    const names = segmentsOf(path);
    if (!plausibleNames(names)) return false;
    // `/usr` alone is a word with a slash in front as often as it is a folder.
    return names.length >= 2 || EXTENSION.test(names[0]!) || quoted;
  }
  // Relative: never a bare word, and only with a separator between two names.
  if (!/[\\/]/.test(path)) return false;
  const names = segmentsOf(path);
  // One name counts only with a trailing separator (`docs/`), which is how a folder is written.
  if (names.length < 2 && !(names.length === 1 && /[\\/]$/.test(path))) return false;
  if (!plausibleNames(names)) return false;
  if (quoted) return true;
  const separators = (path.match(/[\\/]/g) ?? []).length;
  return EXTENSION.test(names[names.length - 1]!) || /[\\/]$/.test(path) || separators >= 2;
}

/** The path an inline code span quotes, or null when the span is not one. */
export function inlineCodePath(text: string): { path: string; line?: SourceLine } | null {
  const raw = text.trim();
  if (!raw || !/[\\/]/.test(raw)) return null;
  const located = splitLine(raw);
  if (!located || !looksLikeLocalPath(located.path, true)) return null;
  return located;
}

/** Every path a run of prose names, in order. */
export function findPathsInText(text: string): DetectedPath[] {
  const found: DetectedPath[] = [];
  if (!/[\\/]/.test(text)) return found;
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    if (!/[\\/]/.test(word) || word.includes("://")) continue;
    const lead = word.match(LEADING_STRIP)?.[0].length ?? 0;
    let token = word.slice(lead);
    token = token.replace(TRAILING_STRIP, "");
    // A path at the end of a sentence keeps a trailing separator ("see docs/.") but not the dot.
    if (!token) continue;
    const located = splitLine(token);
    if (!located || !looksLikeLocalPath(located.path)) continue;
    const start = match.index! + lead;
    found.push({ start, end: start + token.length, path: located.path, ...(located.line ? { line: located.line } : {}) });
  }
  return found;
}
