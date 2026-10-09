/**
 * Reading names out of SQL for the catalog check (`assistant-sql-reach-check.ts`). Everything
 * here over-approximates: a word inside a string or a comment counts as a name too. A name read
 * that names nothing only costs a catalog row; a name missed would let a view through unseen.
 */

/** More distinct names than this and the query is not checked at all: it is asked about instead. */
export const MAX_NAME_CANDIDATES = 4_000;

/** A run of identifier characters. Numbers are kept: MySQL lets a name start with a digit. */
const WORD = /[\p{L}\p{N}_$]+/gu;

/** Postgres cuts a name to NAMEDATALEN - 1 bytes, at a character boundary, before looking it up. */
const PG_NAME_BYTES = 63;
/** How far a quoted name is read: past the longest name either server keeps, with room for doubled quotes. */
const QUOTED_SCAN_CHARS = 4 * 64 * 2;

export function clipUtf8(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name, "utf8") <= maxBytes) return name;
  let out = "";
  let bytes = 0;
  for (const ch of name) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * What each `quote` character could be quoting, read from every one of them rather than in
 * pairs: a quote inside a string would otherwise pair with the wrong one and hide a real name.
 * A doubled quote inside stands for one.
 */
function quotedNames(sql: string, quote: string): string[] {
  const found: string[] = [];
  for (let i = sql.indexOf(quote); i !== -1; i = sql.indexOf(quote, i + 1)) {
    let name = "";
    for (let j = i + 1; j < sql.length && j <= i + QUOTED_SCAN_CHARS; j++) {
      if (sql[j] !== quote) { name += sql[j]; continue; }
      if (sql[j + 1] !== quote) break;
      name += quote;
      j++;
    }
    if (name) found.push(name);
  }
  return found;
}

/**
 * Every name `sql` could be referring to, for a lookup in the catalog: each word as written and
 * folded to lower case the way the server folds a bare name, and whatever each quote character
 * could be quoting. Postgres names are cut to the length Postgres keeps. Null when there are more
 * than {@link MAX_NAME_CANDIDATES}.
 */
export function nameCandidates(sql: string, dialect: "postgres" | "mysql"): string[] | null {
  const names = new Set<string>();
  const add = (name: string) => {
    const kept = dialect === "postgres" ? clipUtf8(name, PG_NAME_BYTES) : name;
    if (kept) names.add(kept);
  };
  for (const [word] of sql.matchAll(WORD)) {
    add(word);
    add(asciiLower(word));
    if (dialect === "mysql") add(word.toLowerCase());
  }
  for (const quote of dialect === "postgres" ? ['"'] : ["`", '"']) {
    for (const name of quotedNames(sql, quote)) add(name);
  }
  return names.size > MAX_NAME_CANDIDATES ? null : [...names];
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `name` occurs in any of `texts` as a whole word, ignoring case: the over-approximation of
 * "this text may name it". Doubled quotes are read as one, as inside a quoted name.
 */
export function mentionsName(texts: readonly string[], name: string): boolean {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, "iu");
  return texts.some((text) => pattern.test(text) || pattern.test(text.replaceAll('""', '"')));
}

/** The runs of operator characters in SQL `code` (strings and comments already blanked). */
export function operatorRuns(code: string): string[] {
  return code.match(/[+\-*/<>=~!@#%^&|`?]+/g) ?? [];
}

/** `value` as a hex-encoded JSON array, which reaches the server intact whatever it treats as an escape. */
export function hexJson(value: readonly string[]): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("hex");
}
