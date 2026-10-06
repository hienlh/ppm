/**
 * DBGate's filter syntax — what a person types in the filter row under a
 * column title — read into the `FilterCondition`s the server turns into SQL.
 * Written from DBGate's public documentation only.
 *
 * The same text means different things on different columns, so every read
 * names the column's kind: `5` is a number on a number column and the text
 * "5" on a text one, and `2021` is the whole of that year on a date column. A
 * space joins with AND, a comma with OR, and AND binds tighter, which is the
 * `anyOf` shape (an OR of AND-groups) a `FilterGroup` carries.
 *
 * Dates are read on the device, in its own time zone: `TODAY` is the user's
 * today, and every bound carries the UTC offset in force at that moment, so a
 * column holding an instant is compared with the user's midnight. The two ends
 * of one span can fall either side of a daylight-saving change and carry
 * different offsets; a condition has only one, so such a span goes as two
 * conditions joined with AND.
 */
import type { ColumnKind } from "./db-column-kind.ts";
import {
  FILTER_MAX_IN_VALUES, FILTER_MAX_RAW_SQL,
  type FilterCondition, type FilterGroup, type FilterValue,
} from "./db-grid.ts";

export interface FilterSyntaxError {
  message: string;
  /** The part of the text that is wrong: `start` included, `end` excluded. */
  start: number;
  end: number;
}

/** A read filter. `anyOf` is empty when the text is blank, which means no filter at all. */
export type FilterParse =
  | { ok: true; anyOf: FilterCondition[][] }
  | { ok: false; error: FilterSyntaxError };

type Op = "=" | "!=" | "<>" | "<" | ">" | "<=" | ">=" | "+" | "~" | "^" | "!^" | "$" | "!$";

/** Longest first, so `<=` is not read as `<` followed by `=`. */
const OPERATORS: readonly Op[] = ["!=", "<>", "<=", ">=", "!^", "!$", "=", "<", ">", "+", "~", "^", "$"];

/** The operators that only mean something to text. */
const TEXT_ONLY: ReadonlySet<Op> = new Set<Op>(["+", "~", "^", "!^", "$", "!$"]);

/** How far one AND-group may multiply out: each `<>` on a date splits it in two. */
const MAX_ALTERNATIVES = 64;

const SPACE = /\s/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
// A zone as ISO writes it (`Z`, `+07:00`) or as Postgres prints one (`+07`, `+0530`).
const DATE_LITERAL = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?)?)?$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY = /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const DATE_HINT = "use 2021, 2021-02, 2021-02-15 or 2021-02-15 23:15";

class FilterTextError extends Error {
  constructor(message: string, readonly start: number, readonly end: number) {
    super(message);
  }
}

function fail(message: string, start: number, end: number): never {
  throw new FilterTextError(message, start, end);
}

/** One value as typed, with the operator in front of it. */
interface Term {
  op: Op | null;
  /** The value: a word, quoted text without its quotes, or the SQL inside braces. */
  text: string;
  quoted: boolean;
  sql: boolean;
  /** From the operator, if there is one, to the end of the value. */
  start: number;
  valueStart: number;
  end: number;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && SPACE.test(text[i]!)) i++;
  return i;
}

/** Quoted text from the opening quote; the quote doubled stands for itself. */
function readQuoted(text: string, open: number): { value: string; end: number } {
  const quote = text[open]!;
  let value = "";
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] !== quote) {
      value += text[i];
    } else if (text[i + 1] === quote) {
      value += quote;
      i++;
    } else {
      return { value, end: i + 1 };
    }
  }
  fail(`Missing closing ${quote}`, open, text.length);
}

/**
 * An SQL condition from its opening brace to the brace that closes it. Braces
 * inside the SQL's own strings and quoted names do not count, so
 * `{$$ in ('a}', 'b')}` is one condition.
 */
function readSql(text: string, open: number): { sql: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  let semicolon = -1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      // A doubled quote closes and opens again, which reads the same.
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === ";") {
      if (semicolon < 0) semicolon = i;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      const sql = text.slice(open + 1, i).trim();
      if (!sql) fail("The SQL condition is empty", open, i + 1);
      if (sql.length > FILTER_MAX_RAW_SQL) fail(`An SQL condition may hold at most ${FILTER_MAX_RAW_SQL} characters`, open, i + 1);
      // The condition lands inside one SELECT; a `;` would try to start a second statement.
      if (semicolon >= 0) fail(`An SQL condition may not contain ";"`, semicolon, semicolon + 1);
      return { sql, end: i + 1 };
    }
  }
  fail("Missing closing }", open, text.length);
}

function readTerm(text: string, start: number): Term {
  const op = OPERATORS.find((o) => text.startsWith(o, start)) ?? null;
  let i = start;
  if (op) {
    // `>= 5` is `>=5`: a space after an operator does not end the value.
    i = skipSpace(text, start + op.length);
    if (i === text.length || text[i] === ",") fail(`Expected a value after "${op}"`, start, start + op.length);
  }
  const ch = text[i]!;
  if (ch === "'" || ch === '"') {
    const { value, end } = readQuoted(text, i);
    return { op, text: value, quoted: true, sql: false, start, valueStart: i, end };
  }
  if (ch === "{" && !op) {
    const { sql, end } = readSql(text, i);
    return { op: null, text: sql, quoted: false, sql: true, start, valueStart: i, end };
  }
  let end = i;
  while (end < text.length && !SPACE.test(text[end]!) && text[end] !== ",") end++;
  return { op, text: text.slice(i, end), quoted: false, sql: false, start, valueStart: i, end };
}

/** The text as OR-groups of terms, before anything is known about the column. */
function readTerms(text: string): Term[][] {
  let i = skipSpace(text, 0);
  if (i === text.length) return [];
  const groups: Term[][] = [[]];
  for (;;) {
    if (text[i] === ",") fail(`Expected a value before ","`, i, i + 1);
    const term = readTerm(text, i);
    groups[groups.length - 1]!.push(term);
    const next = skipSpace(text, term.end);
    if (next === text.length) return groups;
    if (text[next] === ",") {
      i = skipSpace(text, next + 1);
      if (i === text.length) fail(`Expected a value after ","`, next, next + 1);
      groups.push([]);
    } else if (next === term.end) {
      // Only a quote or a brace can end a value without a space.
      fail("Expected a space or a comma", next, next + 1);
    } else {
      i = next;
    }
  }
}

/** A bare word: no operator, no quotes, not SQL — the only form a keyword takes. */
function wordOf(t: Term | undefined): string | null {
  return t && t.op === null && !t.quoted && !t.sql ? t.text.toUpperCase() : null;
}

export type FilterSyntax = "text" | "number" | "boolean" | "date" | "binary";

/** Which syntax a column reads its filter in. Times, JSON and unknown types read as text. */
export function filterSyntax(kind: ColumnKind): FilterSyntax {
  switch (kind) {
    case "number": case "boolean": case "binary": return kind;
    case "date": case "datetime": case "datetimetz": return "date";
    default: return "text";
  }
}

/** One condition read from the terms at `k`, as an OR of AND-groups, and how many terms it took. */
interface Read {
  alt: FilterCondition[][];
  used: number;
}

const one = (cond: FilterCondition, used = 1): Read => ({ alt: [[cond]], used });

function opFail(t: Term, columns: string): never {
  fail(`"${t.op}" does not work on ${columns} columns`, t.start, t.start + t.op!.length);
}

function readText(terms: Term[], k: number): Read {
  const t = terms[k]!;
  const word = wordOf(t);
  if (word === "EMPTY") return one({ op: "isEmpty" });
  if (word === "NOT" && wordOf(terms[k + 1]) === "EMPTY") return one({ op: "notEmpty" }, 2);
  const value = t.text;
  switch (t.op) {
    case null: case "+": return one({ op: "contains", value });
    case "~": return one({ op: "notContains", value });
    case "^": return one({ op: "startsWith", value });
    case "!^": return one({ op: "notStartsWith", value });
    case "$": return one({ op: "endsWith", value });
    case "!$": return one({ op: "notEndsWith", value });
    case "=": return one({ op: "eq", value });
    case "!=": case "<>": return one({ op: "ne", value });
    case "<": return one({ op: "lt", value });
    case ">": return one({ op: "gt", value });
    case "<=": return one({ op: "le", value });
    case ">=": return one({ op: "ge", value });
  }
}

/**
 * A number while a JS number holds it exactly — an integer up to 2^53, anything
 * else up to 15 significant digits — and otherwise the text as typed, for the
 * database to read: a JS number would round it.
 */
function numberValue(text: string): FilterValue {
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  if (/^-?\d+$/.test(text)) return Number.isSafeInteger(n) ? n : text;
  const mantissa = text.replace(/^-/, "").replace(/e.*$/i, "").replace(".", "");
  const significant = mantissa.replace(/^0+/, "").replace(/0+$/, "");
  // 1e-400 is not 0, however JS reads it.
  const exact = significant.length <= 15 && !(n === 0 && significant !== "");
  return exact ? n : text;
}

function readNumber(t: Term): Read {
  if (t.op && TEXT_ONLY.has(t.op)) opFail(t, "number");
  if (!NUMBER.test(t.text)) fail(`"${t.text}" is not a number`, t.valueStart, t.end);
  const value = numberValue(t.text);
  switch (t.op) {
    case "!=": case "<>": return one({ op: "ne", value });
    case "<": return one({ op: "lt", value });
    case ">": return one({ op: "gt", value });
    case "<=": return one({ op: "le", value });
    case ">=": return one({ op: "ge", value });
    default: return one({ op: "eq", value });
  }
}

function readBoolean(t: Term): Read {
  if (t.op && t.op !== "=") opFail(t, "boolean");
  const v = t.text.toUpperCase();
  if (v === "TRUE" || v === "1") return one({ op: "isTrue" });
  if (v === "FALSE" || v === "0") return one({ op: "isFalse" });
  fail(`"${t.text}" is not TRUE or FALSE`, t.valueStart, t.end);
}

/** A wall-clock time: what a calendar and a clock on the wall say, in no particular zone. */
interface Civil {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** Fractional seconds as typed, `""` when there are none. */
  frac: string;
}

type Precision = "year" | "month" | "day" | "minute" | "second" | "fraction";

function civil(y: number, mo = 1, d = 1, h = 0, mi = 0, s = 0, frac = ""): Civil {
  return { y, mo, d, h, mi, s, frac };
}

/**
 * Calendar arithmetic, done in UTC so that no daylight-saving change can move
 * a wall-clock time. `setUTCFullYear` rather than `Date.UTC`, which reads a
 * year below 100 as 19xx. Months and years are only ever added to the first
 * of a month, which no month length can push over.
 */
function shift(c: Civil, unit: "year" | "month" | "day" | "minute" | "second", n: number): Civil {
  const t = new Date(0);
  t.setUTCFullYear(c.y, c.mo - 1, c.d);
  t.setUTCHours(c.h, c.mi, c.s, 0);
  if (unit === "year") t.setUTCFullYear(t.getUTCFullYear() + n);
  else if (unit === "month") t.setUTCMonth(t.getUTCMonth() + n);
  else if (unit === "day") t.setUTCDate(t.getUTCDate() + n);
  else if (unit === "minute") t.setUTCMinutes(t.getUTCMinutes() + n);
  else t.setUTCSeconds(t.getUTCSeconds() + n);
  return civil(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), c.frac);
}

/** Where the span a value names ends: one of its own smallest unit later. */
function spanEnd(start: Civil, precision: Precision): Civil {
  if (precision !== "fraction") return shift(start, precision, 1);
  const digits = start.frac.length;
  const next = Number(start.frac) + 1;
  if (next < 10 ** digits) return { ...start, frac: String(next).padStart(digits, "0") };
  return { ...shift(start, "second", 1), frac: "0".repeat(digits) };
}

function daysIn(y: number, mo: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, mo, 0);
  return t.getUTCDate();
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function wallClock(c: Civil): string {
  return `${pad(c.y, 4)}-${pad(c.mo)}-${pad(c.d)} ${pad(c.h)}:${pad(c.mi)}:${pad(c.s)}${c.frac ? `.${c.frac}` : ""}`;
}

function formatOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The device's UTC offset at that wall-clock time, e.g. `+07:00`. */
function localOffset(c: Civil): string {
  const t = new Date(2000, 0, 1);
  t.setFullYear(c.y, c.mo - 1, c.d);
  t.setHours(c.h, c.mi, c.s, 0);
  // Rounded: a zone's historical local mean time can be minutes and seconds off UTC.
  return formatOffset(-Math.round(t.getTimezoneOffset()));
}

interface DateLiteral {
  start: Civil;
  precision: Precision;
  /** Minutes east of UTC when the value says its zone (`Z`, `+07:00`); null for wall-clock time. */
  zone: number | null;
}

function readDateLiteral(text: string): DateLiteral | null {
  const m = DATE_LITERAL.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const start = civil(Number(y), mo ? Number(mo) : 1, d ? Number(d) : 1, h ? Number(h) : 0, mi ? Number(mi) : 0, s ? Number(s) : 0, frac ?? "");
  if (start.mo < 1 || start.mo > 12 || start.d < 1 || start.d > daysIn(start.y, start.mo)) return null;
  if (start.h > 23 || start.mi > 59 || start.s > 59) return null;
  const precision: Precision = frac ? "fraction" : s ? "second" : mi ? "minute" : d ? "day" : mo ? "month" : "year";
  let minutes: number | null = null;
  if (zone) {
    if (zone.toUpperCase() === "Z") {
      minutes = 0;
    } else {
      const hours = Number(zone.slice(1, 3));
      const mins = Number(zone.slice(3).replace(":", "") || "0");
      if (hours > 23 || mins > 59) return null;
      minutes = (zone[0] === "-" ? -1 : 1) * (hours * 60 + mins);
    }
  }
  return { start, precision, zone: minutes };
}

/**
 * The conditions a span `[start, end)` makes under an operator. A bare value
 * or `=` is inside the span, `<>` outside it, and the comparisons are against
 * the edge that makes them true to the whole span: `>2021` is after all of
 * 2021, `<=2021` up to its end. An end past the year 9999 is no bound at all.
 */
function spanConditions(t: Term, start: Civil, end: Civil, zone: string | null): FilterCondition[][] {
  const bound = (c: Civil) => ({ at: wallClock(c), offset: zone ?? localOffset(c) });
  const a = bound(start);
  const b = end.y <= 9999 ? bound(end) : null;
  const from = (x: { at: string; offset: string }): FilterCondition => ({ op: "dateRange", from: x.at, offset: x.offset });
  const to = (x: { at: string; offset: string }): FilterCondition => ({ op: "dateRange", to: x.at, offset: x.offset });
  switch (t.op) {
    case "!=": case "<>": return b ? [[to(a)], [from(b)]] : [[to(a)]];
    case ">":
      if (!b) fail("Nothing comes after the year 9999", t.start, t.end);
      return [[from(b)]];
    case ">=": return [[from(a)]];
    case "<": return [[to(a)]];
    case "<=": return b ? [[to(b)]] : [[{ op: "notNull" }]];
    default:
      if (!b) return [[from(a)]];
      return a.offset === b.offset
        ? [[{ op: "dateRange", from: a.at, to: b.at, offset: a.offset }]]
        : [[from(a), to(b)]];
  }
}

const DAY_WORDS: Readonly<Record<string, number>> = { YESTERDAY: -1, TODAY: 0, TOMORROW: 1 };
const PERIOD_STEP: Readonly<Record<string, number>> = { LAST: -1, THIS: 0, NEXT: 1 };

/** `THIS WEEK` and the like, on the device's calendar. A week starts on Monday. */
function periodSpan(now: Date, step: number, unit: string): [Civil, Civil] {
  const today = civil(now.getFullYear(), now.getMonth() + 1, now.getDate());
  if (unit === "WEEK") {
    const monday = shift(today, "day", 7 * step - ((now.getDay() + 6) % 7));
    return [monday, shift(monday, "day", 7)];
  }
  if (unit === "MONTH") {
    const first = shift(civil(today.y, today.mo), "month", step);
    return [first, shift(first, "month", 1)];
  }
  const first = civil(today.y + step);
  return [first, shift(first, "year", 1)];
}

function readDate(terms: Term[], k: number, now: Date): Read {
  const t = terms[k]!;
  const next = terms[k + 1];
  if (t.op && TEXT_ONLY.has(t.op)) opFail(t, "date");
  if (!t.quoted) {
    const word = t.text.toUpperCase();
    const days = DAY_WORDS[word];
    if (days !== undefined) {
      const start = shift(civil(now.getFullYear(), now.getMonth() + 1, now.getDate()), "day", days);
      return { alt: spanConditions(t, start, shift(start, "day", 1), null), used: 1 };
    }
    const step = PERIOD_STEP[word];
    if (step !== undefined) {
      const unit = wordOf(next);
      if (unit !== "WEEK" && unit !== "MONTH" && unit !== "YEAR") fail(`Expected WEEK, MONTH or YEAR after ${word}`, t.valueStart, t.end);
      const [start, end] = periodSpan(now, step, unit);
      return { alt: spanConditions({ ...t, end: next!.end }, start, end, null), used: 2 };
    }
  }
  // `2021-02-15 23:15` is one value: a time joins the date in front of it.
  const joined = !t.quoted && DATE_ONLY.test(t.text) && wordOf(next) !== null && TIME_ONLY.test(next!.text);
  const term = joined ? { ...t, text: `${t.text} ${next!.text}`, end: next!.end } : t;
  const literal = readDateLiteral(term.text) ?? fail(`"${term.text}" is not a date — ${DATE_HINT}`, term.valueStart, term.end);
  const used = joined ? 2 : 1;
  if (literal.zone === null) {
    return { alt: spanConditions(term, literal.start, spanEnd(literal.start, literal.precision), null), used };
  }
  // A value that names its zone is an instant: compared in UTC, whatever zone the device is in.
  const start = shift(literal.start, "minute", -literal.zone);
  return { alt: spanConditions(term, start, spanEnd(start, literal.precision), "+00:00"), used };
}

function readCondition(terms: Term[], k: number, syntax: FilterSyntax, now: Date): Read {
  const t = terms[k]!;
  if (t.sql) return one({ op: "rawSql", sql: t.text });
  const word = wordOf(t);
  if (word === "NULL") return one({ op: "isNull" });
  if (word === "NOT" && wordOf(terms[k + 1]) === "NULL") return one({ op: "notNull" }, 2);
  switch (syntax) {
    case "text": return readText(terms, k);
    case "number": return readNumber(t);
    case "boolean": return readBoolean(t);
    case "date": return readDate(terms, k, now);
    case "binary": fail("A binary column can only be filtered with NULL, NOT NULL or an SQL condition in braces", t.start, t.end);
  }
}

/** Terms joined with spaces: every condition must hold, so the alternatives multiply out. */
function readAndGroup(terms: Term[], syntax: FilterSyntax, now: Date): FilterCondition[][] {
  let all: FilterCondition[][] = [[]];
  for (let k = 0; k < terms.length;) {
    const { alt, used } = readCondition(terms, k, syntax, now);
    if (all.length * alt.length > MAX_ALTERNATIVES) fail("Too many conditions joined with spaces", terms[k]!.start, terms[k + used - 1]!.end);
    all = all.flatMap((left) => alt.map((right) => [...left, ...right]));
    k += used;
  }
  return all;
}

/**
 * Alternatives that are each one plain `=` become one `in`: a pasted list or a
 * pick of values is many of them, and `IN (…)` is the statement a person
 * expects to see, and the one databases plan best.
 */
function foldEquals(anyOf: FilterCondition[][], text: string): FilterCondition[][] {
  const isEq = (group: FilterCondition[]) => group.length === 1 && group[0]!.op === "eq";
  const values = anyOf.filter(isEq).map((group) => group[0]!.value!);
  if (values.length < 2) return anyOf;
  if (values.length > FILTER_MAX_IN_VALUES) fail(`More than ${FILTER_MAX_IN_VALUES} values`, 0, text.length);
  const at = anyOf.findIndex(isEq);
  const rest = anyOf.filter((group) => !isEq(group));
  return [...rest.slice(0, at), [{ op: "in", values }], ...rest.slice(at)];
}

function caught(e: unknown): { ok: false; error: FilterSyntaxError } {
  if (!(e instanceof FilterTextError)) throw e;
  return { ok: false, error: { message: e.message, start: e.start, end: e.end } };
}

/** Read one column's filter text. `now` is when `TODAY` and the like are; tests pass their own. */
export function parseFilter(text: string, kind: ColumnKind, now: Date = new Date()): FilterParse {
  try {
    const syntax = filterSyntax(kind);
    const anyOf = readTerms(text).flatMap((terms) => readAndGroup(terms, syntax, now));
    return { ok: true, anyOf: foldEquals(anyOf, text) };
  } catch (e) {
    return caught(e);
  }
}

export interface FilterableColumn {
  name: string;
  kind: ColumnKind;
}

/**
 * The Multi column filter: one text read for every column in that column's
 * own syntax, the columns joined with OR. A column the text means nothing to —
 * `abc` on a number column — is left out rather than failing the filter; the
 * text is wrong only when no column can read it. An SQL condition names one
 * column with `$$`, so it has no place here.
 */
export function parseAnyColumnFilter(
  text: string,
  columns: readonly FilterableColumn[],
  now: Date = new Date(),
): { ok: true; groups: FilterGroup[] } | { ok: false; error: FilterSyntaxError } {
  try {
    const sql = readTerms(text).flat().find((t) => t.sql);
    if (sql) fail("An SQL condition only works in one column's own filter", sql.start, sql.end);
  } catch (e) {
    return caught(e);
  }
  const groups = columns.flatMap((c): FilterGroup[] => {
    const read = parseFilter(text, c.kind, now);
    return read.ok && read.anyOf.length > 0 ? [{ column: c.name, anyOf: read.anyOf }] : [];
  });
  if (groups.length === 0 && text.trim()) {
    return { ok: false, error: { message: "No column can read this filter", start: 0, end: text.length } };
  }
  return { ok: true, groups };
}
