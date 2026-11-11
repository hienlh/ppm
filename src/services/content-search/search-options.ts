/**
 * Shapes and limits shared by the server's main thread, the search host
 * (`ppm __search__`) and the browser. Types and constants only: this file is
 * imported by the host, whose import graph must stay free of database/config.
 */

/** A search stops once this many matches are found (`limitHit`), like VS Code. */
export const MAX_MATCHES = 20_000;
/** The host stops the search tool after this long and answers what it found (`incomplete: "timeout"`). */
export const TIME_LIMIT_MS = 30_000;
/** At most this many characters of a match's line are kept before the match. */
export const PREVIEW_BEFORE = 26;
/** At most this many characters of a match's line are kept after the match. */
export const PREVIEW_AFTER = 250;

export interface SearchRequest {
  projectPath: string;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string[];
  exclude: string[];
  useIgnore: boolean;
  replace?: string;
  preserveCase?: boolean;
  gzip: boolean;
}

export interface SearchMatch {
  /** 1-based. */
  line: number;
  /** 0-based, UTF-16, in the full line. */
  column: number;
  /** UTF-16 length of the matched text. */
  length: number;
  /** At most `PREVIEW_BEFORE` characters before the match, leading whitespace trimmed. */
  before: string;
  /** True when `before` was cut, so the row shows "…" first. */
  cutBefore: boolean;
  /** The matched text. */
  text: string;
  /** At most `PREVIEW_AFTER` characters after the match. */
  after: string;
  /** Set when the request had `replace` and it could be computed. */
  replacement?: string;
}

export interface SearchFileResult {
  file: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  /** Sorted by path. */
  results: SearchFileResult[];
  total: number;
  files: number;
  /** `MAX_MATCHES` reached. */
  limitHit: boolean;
  /** `TIME_LIMIT_MS` reached; the matches found so far are kept. */
  incomplete?: "timeout";
  engine: "rg" | "grep";
  /** grep fallback with a pattern JavaScript cannot run: no replacements. */
  replaceUnavailable?: boolean;
}

export interface ReplaceMatch {
  line: number;
  column: number;
  text: string;
  replacement: string;
}

export interface ReplaceRequest {
  /** Added by the route, never sent by the browser. */
  projectPath: string;
  files: Array<{ file: string; matches: ReplaceMatch[] }>;
}

export interface ReplaceReport {
  replaced: number;
  files: number;
  skipped: Array<{ file: string; reason: "changed" }>;
  failed: Array<{ file: string; reason: string }>;
}
