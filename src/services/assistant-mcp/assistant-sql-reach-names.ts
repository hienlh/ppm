/**
 * Reading names, whole-row reads and operator uses out of SQL for the catalog check
 * (`assistant-sql-reach-check.ts`). Everything
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

/**
 * The tokens of Postgres `code` from `sqlCode`: a blanked string (`''`) or quoted name (`""`),
 * `::`, a word (lower case, as the server folds it), a number, a run of operator characters,
 * or one punctuation character.
 */
export function codeTokens(code: string): string[] {
  const found = code.match(/""|''|::|[\p{L}_][\p{L}\p{N}_$]*|\p{N}[\p{L}\p{N}_.]*|[+\-*/<>=~!@#%^&|`?]+|\S/gu) ?? [];
  return found.map(asciiLower);
}

/** Words after which a word is a clause, not the alias of the relation before it. */
const NOT_AN_ALIAS = new Set(`
where join inner left right full cross natural on using group order limit offset fetch for window union intersect
except having tablesample returning select values into lateral with as
`.trim().split(/\s+/));
/** Words that end a FROM list at the depth they are written at. */
const ENDS_FROM = new Set("where group having order limit offset fetch for window union intersect except returning select values".split(" "));

export interface RowUse {
  /** Every column of every relation the query reaches may be read: `*`, `t.*`, `TABLE t`, NATURAL JOIN, a quoted name read whole. */
  all: boolean;
  /** Relations (by name) a row of which the query reads whole, or whose columns it renames (`FROM t AS x(a, b)`). */
  whole: Set<string>;
}

/**
 * Where `code` (one statement from `sqlCode`) may read columns it never names: `*` and `t.*`, a
 * `TABLE` command, a NATURAL JOIN (which compares every column two relations share), a relation
 * whose columns an alias list renames, and a whole-row reference — `t` or its alias written as a
 * value (`SELECT t FROM t`, `to_json(x) … FROM t x`), which reads every column of `t`. `relations`
 * are the names whose whole-row reads matter. Over-approximates: a quoted name read as a value
 * where a quoted relation is in the FROM list counts as a whole row, since its text is blanked.
 */
export function rowUse(code: string, relations: ReadonlySet<string>): RowUse {
  const t = codeTokens(code);
  const use: RowUse = { all: false, whole: new Set() };
  const declared = new Set<number>();
  const aliases = new Map<string, string>();
  const opener: string[] = [];
  const inFrom: boolean[] = [false];
  let expect = false;
  let quotedRelation = false;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    const depth = opener.length;
    if (tok === "table" || tok === "natural") use.all = true;
    if (tok === "*" && ["select", "distinct", "all", ",", ".", ")"].includes(t[i - 1] ?? "")) {
      // `count(*) * 2` is not a star; `DISTINCT ON (a) *` is.
      if (t[i - 1] !== ")" || closesAfter(t, i - 1) === "on") use.all = true;
    }
    if (tok === "(" || tok === "[") { opener.push(t[i - 1] ?? ""); inFrom.push(false); continue; }
    if (tok === ")" || tok === "]") { opener.pop(); inFrom.pop(); if (!inFrom.length) inFrom.push(false); expect = false; continue; }
    if (tok === "from" || tok === "join") { inFrom[depth] = true; expect = true; continue; }
    if (ENDS_FROM.has(tok)) { inFrom[depth] = false; expect = false; continue; }
    if (tok === "on" || tok === "using") { expect = false; continue; }
    if (tok === "," && inFrom[depth]) { expect = true; continue; }
    if (!expect || tok === "only" || tok === "lateral") continue;
    if (!/^[\p{L}_"]/u.test(tok)) { expect = false; continue; }
    // A relation, possibly schema-qualified: the last part names it.
    let at = i;
    while (t[at + 1] === "." && t[at + 2] && /^[\p{L}_"]/u.test(t[at + 2]!)) { declared.add(at); at += 2; }
    declared.add(at);
    const relation = t[at]!;
    const watched = relation === '""' || relations.has(relation);
    if (relation === '""') quotedRelation = true;
    let next = at + 1;
    if (t[next] === "as") next++;
    const alias = t[next];
    if (alias && /^[\p{L}_"]/u.test(alias) && !NOT_AN_ALIAS.has(alias)) {
      declared.add(next);
      if (watched) aliases.set(alias, relation);
      if (alias === '""') quotedRelation = watched || quotedRelation;
      if (t[next + 1] === "(" && watched) {
        if (relation === '""') use.all = true;
        else use.whole.add(relation);
      }
      i = next;
    } else i = at;
    expect = false;
  }
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (declared.has(i) || t[i + 1] === "." || t[i + 1] === "(" || [".", "::", "as"].includes(t[i - 1] ?? "")) continue;
    if (tok === '""') { if (quotedRelation) use.all = true; continue; }
    const relation = relations.has(tok) ? tok : aliases.get(tok);
    if (relation === '""') use.all = true;
    else if (relation) use.whole.add(relation);
  }
  return use;
}

/** The word before the parenthesis that the `)` at `close` closes. */
function closesAfter(t: readonly string[], close: number): string {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (t[i] === ")") depth++;
    else if (t[i] === "(" && --depth === 0) return t[i - 1] ?? "";
  }
  return "";
}

/** One place a statement may resolve an operator by name, and whether an untyped literal may stand on each side. */
export interface OperatorUse {
  /** The operator characters as written, or the operator a keyword stands for. */
  symbol: string;
  /** Written as operator characters, a run of which may hold several operators. */
  written: boolean;
  leftLiteral: boolean;
  rightLiteral: boolean;
}

/**
 * Operators Postgres looks up by name for a keyword rather than a symbol in the text: `IN` is
 * `=` (or `<>` for NOT IN), `BETWEEN` two comparisons, `LIKE` `~~`, `SIMILAR TO` `~`, and `IS
 * DISTINCT FROM`, `NULLIF`, a simple `CASE`, `USING` and `NATURAL` an equality.
 */
const KEYWORD_OPERATORS: Readonly<Record<string, readonly string[]>> = {
  in: ["=", "<>"],
  between: ["<", "<=", ">", ">="],
  like: ["~~", "!~~"],
  ilike: ["~~*", "!~~*"],
  similar: ["~", "!~"],
  distinct: ["="],
  nullif: ["="],
  case: ["="],
  using: ["="],
  natural: ["="],
};

/** Words before a parenthesis that only groups, so what it closes may be a bare literal: `x = ('a')`. */
const GROUPING_AFTER = new Set("select where and or not on when then else in by having distinct is like ilike similar to between case from using as values return".split(" "));
/** `E'…'`, `B'…'`, `X'…'`, `N'…'`, `U&'…'`: a letter the lexer may leave in front of a string. */
const STRING_PREFIX = new Set(["e", "b", "x", "n", "u"]);

/** Whether the operand ending at token `i` may be an untyped literal: a string, NULL, or a parenthesis that is not a call. */
function literalEndsAt(t: readonly string[], i: number): boolean {
  const tok = t[i] ?? "";
  if (tok === "''" || tok === "null") return true;
  if (tok !== ")") return false;
  const before = closesAfter(t, i);
  return !/^[\p{L}_"]/u.test(before) || GROUPING_AFTER.has(before);
}

/** Whether the operand starting at token `i` may be an untyped literal (or a list or array of them). */
function literalStartsAt(t: readonly string[], i: number): boolean {
  const tok = t[i] ?? "";
  if (["''", "null", "(", "any", "some", "all"].includes(tok)) return true;
  return STRING_PREFIX.has(tok) && ["''", "&"].includes(t[i + 1] ?? "");
}

/** The operator uses the keyword at token `i` stands for, with where its operands are. */
function keywordUses(t: readonly string[], i: number, anyLiteral: boolean): OperatorUse[] {
  const tok = t[i]!;
  const symbols = KEYWORD_OPERATORS[tok];
  if (!symbols) return [];
  const before = t[i - 1] === "not" ? i - 2 : i - 1;
  let left = anyLiteral;
  let right = anyLiteral;
  if (["in", "between", "like", "ilike", "similar"].includes(tok)) {
    left = literalEndsAt(t, before);
    const after = t[i + 1] === "symmetric" || t[i + 1] === "to" ? i + 2 : i + 1;
    right = tok === "in" || tok === "between" ? true : literalStartsAt(t, after);
  } else if (tok === "distinct") {
    // `IS [NOT] DISTINCT FROM`; a SELECT's DISTINCT sorts with the type's operator class instead.
    if (t[before] !== "is") return [];
    left = literalEndsAt(t, before - 1);
    right = literalStartsAt(t, i + 2);
  } else if (tok === "using" || tok === "natural") {
    left = right = false;
  }
  return symbols.map((symbol) => ({ symbol, written: false, leftLiteral: left, rightLiteral: right }));
}

/**
 * Every place Postgres `code` (one statement from `sqlCode`) may resolve an operator by name.
 * A literal side means what stands there may be a value of no type yet — a string, NULL, or
 * something parenthesised — which Postgres may convert to whatever an operator takes. Where a
 * keyword's operands cannot be located (NULLIF, CASE), either side counts as a literal whenever
 * the statement has one.
 */
export function operatorUses(code: string): OperatorUse[] {
  const t = codeTokens(code);
  const anyLiteral = t.some((tok) => tok === "''" || tok === "null");
  const uses: OperatorUse[] = [];
  for (let i = 0; i < t.length; i++) {
    uses.push(...keywordUses(t, i, anyLiteral));
    if (!/^[+\-*/<>=~!@#%^&|`?]+$/.test(t[i]!)) continue;
    uses.push({ symbol: t[i]!, written: true, leftLiteral: literalEndsAt(t, i - 1), rightLiteral: literalStartsAt(t, i + 1) });
  }
  return uses;
}

/**
 * Whether `use` may name the operator `name`. A run of operator characters may hold several
 * (`=-` is `=` then `-`), so any operator inside it counts, and `!=` is `<>`.
 */
export function usesOperator(use: OperatorUse, name: string): boolean {
  if (!use.written) return use.symbol === name;
  return use.symbol.includes(name) || (name === "<>" && use.symbol.includes("!="));
}

/** `value` as a hex-encoded JSON array, which reaches the server intact whatever it treats as an escape. */
export function hexJson(value: readonly string[]): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("hex");
}
