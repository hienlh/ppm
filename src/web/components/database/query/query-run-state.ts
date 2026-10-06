/**
 * One run of the Query tab, folded from the events `POST /query/script` streams back: the
 * statements it will run, the one running now, a result tab for every result set and the lines
 * the Messages tab shows, in DBGate's words. Pure — the runner hook only feeds it — so what a
 * script, a Stop or a lost connection leaves on screen is tested without a browser.
 *
 * Every line here is the editor's. The server counts the lines of the text it was sent, and the
 * statement at the cursor or a selection begins further down the editor than its line 1.
 */
import type { QueryResultSet, QueryScriptEvent, QueryStatementResult } from "../../../../shared/db-query-script";
import type { DialectName } from "../../../../shared/db-types";
import type { DbColumnInfo } from "../use-database";
import type { GridColumnSchema } from "../glide-grid-types";

/** What was sent: the whole script, the selection, the statement at the cursor — or its plan. */
export type QueryRunKind = "script" | "selection" | "statement" | "explain";

export interface QueryMessage {
  /** Its place in the list, which only grows. */
  id: number;
  level: "info" | "success" | "warning" | "error";
  text: string;
  /** When it came, by this browser's clock: DBGate's Time, Delta and Duration are worked out from it. */
  time: number;
  /** 0-based place in the script of the statement it is about. */
  statement?: number;
  /** The editor's line it points at: where its statement starts, or where the error is. */
  line?: number;
}

/** An event and when it arrived. */
export interface TimedQueryEvent {
  event: QueryScriptEvent;
  at: number;
}

export interface QueryResultTab {
  /** `<statement>:<result set>`: the tab's for as long as the run is shown. */
  key: string;
  /** DBGate's "Result 1…N", numbered as they arrive; an Explain's are its plans. */
  title: string;
  statement: number;
  set: number;
}

export interface QueryRun {
  runId: string;
  kind: QueryRunKind;
  /** The text sent. */
  sql: string;
  /** The editor's line of that text's line 1, less one. */
  lineOffset: number;
  maxRows: number;
  /** When the run began, by this browser's clock. */
  startedAt: number;
  /** Each statement's lines, from `start`: empty until it comes. */
  statements: { startLine: number; endLine: number }[];
  /** The statement sent last, and since when; null between statements and once the run is over. */
  running: { index: number; since: number } | null;
  /** What each statement did, in the order they ended. */
  results: QueryStatementResult[];
  tabs: QueryResultTab[];
  messages: QueryMessage[];
  /** Editor lines an error points at, for the editor to mark. */
  errorLines: number[];
  /** A statement failed or was stopped, or the run broke off. */
  failed: boolean;
  done: boolean;
  /** The whole run, as the server timed it — or the browser, when it broke off. */
  durationMs?: number;
}

/** The Messages tab's key among the result tabs. */
export const MESSAGES_TAB = "messages";

export function startQueryRun(
  options: { runId: string; kind: QueryRunKind; sql: string; lineOffset: number; maxRows: number },
  now: number,
): QueryRun {
  return {
    ...options, startedAt: now, statements: [], running: null, results: [], tabs: [],
    messages: [{ id: 0, level: "info", text: "Query execution started", time: now }],
    errorLines: [], failed: false, done: false,
  };
}

/**
 * What Stop does, as the toolbar says it. SQLite runs a statement on the server's own thread, where
 * nothing can interrupt it: there Stop only keeps the statements after it from running.
 */
export function stopTitle(dialect: DialectName | undefined): string {
  return dialect === "sqlite"
    ? "Stop before the next statement: SQLite cannot stop the one already running"
    : "Stop the statement running; the ones after it do not run";
}

/** `n` and its noun, `1 row` or `1,000 rows`. */
export function countOf(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

/** A result set worth a tab: a SELECT's, also with no rows. A write that returned nothing has no columns. */
function hasColumns(set: QueryResultSet): boolean {
  return set.columns.length > 0;
}

/** The result with its lines moved into the editor's. */
function inEditorLines(result: QueryStatementResult, offset: number): QueryStatementResult {
  if (offset === 0) return result;
  return {
    ...result,
    startLine: result.startLine + offset,
    endLine: result.endLine + offset,
    ...(result.errorLine !== undefined ? { errorLine: result.errorLine + offset } : {}),
  };
}

type NewMessage = Omit<QueryMessage, "id" | "time">;

/** What Messages says about one statement, notices first, as DBGate words it. */
function statementMessages(result: QueryStatementResult): NewMessage[] {
  const about = { statement: result.index, line: result.startLine };
  const out: NewMessage[] = (result.notices ?? []).map((text) => ({ ...about, level: "info", text }));
  const main: NewMessage[] = [];
  result.resultSets.filter(hasColumns).forEach((set, i) => {
    const rows = countOf(set.rows.length, "row");
    // One statement is timed once: a CALL's later results came in the same time.
    const took = i === 0 ? ` in ${result.durationMs.toLocaleString("en-US")} ms` : "";
    main.push(set.truncated
      ? { ...about, level: "warning", text: `Query returned the first ${rows}${took}; the rest were cut off by the row limit` }
      : { ...about, level: "success", text: `Query returned ${rows}${took}` });
  });
  if (result.rowsAffected !== undefined) main.push({ ...about, level: "success", text: `${countOf(result.rowsAffected, "row")} affected` });
  if (result.error !== undefined) {
    main.push({
      ...about, level: "error", line: result.errorLine ?? result.startLine,
      text: result.stopped === "user" ? `Stopped: ${result.error}` : result.error,
    });
  } else if (result.stopped) {
    // MySQL ends a SLEEP() it was told to stop as if it had finished.
    main.push({ ...about, level: "warning", text: result.stopped === "user" ? "Stopped" : "Stopped: the connection's query timeout was reached" });
  }
  if (main.length === 0) main.push({ ...about, level: "success", text: `${result.command ?? "Statement"} executed` });
  return [...out, ...main];
}

function tabTitle(kind: QueryRunKind, n: number): string {
  if (kind === "explain") return n === 1 ? "Plan" : `Plan ${n}`;
  return `Result ${n}`;
}

/**
 * `run` with `events` applied, in order. The arrays are copied once for the whole batch: a script
 * of thousands of statements arrives as thousands of events, and the hook hands them over in batches.
 */
export function applyQueryEvents(run: QueryRun, events: readonly TimedQueryEvent[]): QueryRun {
  if (events.length === 0) return run;
  const next: QueryRun = {
    ...run, results: [...run.results], tabs: [...run.tabs], messages: [...run.messages], errorLines: [...run.errorLines],
  };
  for (const { event, at } of events) {
    const say = (message: NewMessage) => { next.messages.push({ ...message, id: next.messages.length, time: at }); };
    switch (event.type) {
      case "start":
        next.statements = event.statements.map((s) => ({ startLine: s.startLine + run.lineOffset, endLine: s.endLine + run.lineOffset }));
        break;
      case "running":
        next.running = { index: event.index, since: at };
        break;
      case "statement": {
        const result = inEditorLines(event.result, run.lineOffset);
        next.results.push(result);
        if (next.running?.index === result.index) next.running = null;
        result.resultSets.forEach((set, i) => {
          if (!hasColumns(set)) return;
          next.tabs.push({ key: `${result.index}:${i}`, title: tabTitle(run.kind, next.tabs.length + 1), statement: result.index, set: i });
        });
        for (const message of statementMessages(result)) say(message);
        if (result.error !== undefined || result.stopped) next.failed = true;
        if (result.error !== undefined) next.errorLines.push(result.errorLine ?? result.startLine);
        break;
      }
      case "message":
        say({ level: event.level, text: event.text });
        if (event.level === "error") next.failed = true;
        break;
      case "done": {
        next.running = null;
        if (event.error !== undefined) {
          say({ level: "error", text: event.error });
          next.failed = true;
        }
        const notRun = next.statements.length - next.results.length;
        if (notRun > 0) say({ level: "info", text: `${countOf(notRun, "statement")} did not run` });
        say({ level: "info", text: "Query execution finished" });
        next.done = true;
        next.durationMs = event.durationMs;
        break;
      }
    }
  }
  return next;
}

/** The run broke off on this side — refused before it began, or the connection to the server went. */
export function failQueryRun(run: QueryRun, error: string, now: number): QueryRun {
  if (run.done) return run;
  return {
    ...run, running: null, failed: true, done: true, durationMs: Math.max(0, Math.round(now - run.startedAt)),
    messages: [...run.messages, { id: run.messages.length, level: "error", text: error, time: now }],
  };
}

/** A line of Messages added after the run, about it: a result read again after a save. */
export function noteOnQueryRun(run: QueryRun, message: NewMessage, now: number): QueryRun {
  return { ...run, messages: [...run.messages, { ...message, id: run.messages.length, time: now }] };
}

export function resultOfTab(run: QueryRun, tab: QueryResultTab): { result: QueryStatementResult; set: QueryResultSet } | null {
  const result = run.results.find((r) => r.index === tab.statement);
  const set = result?.resultSets[tab.set];
  return result && set ? { result, set } : null;
}

/** The rows of `tabKey` as they read now, in place of the ones the run had read. */
export function replaceResultSet(run: QueryRun, tabKey: string, set: QueryResultSet): QueryRun {
  const tab = run.tabs.find((t) => t.key === tabKey);
  if (!tab) return run;
  return {
    ...run,
    results: run.results.map((r) => (r.index === tab.statement
      ? { ...r, resultSets: r.resultSets.map((s, i) => (i === tab.set ? set : s)) }
      : r)),
  };
}

/**
 * The tab shown, as DBGate picks it: Messages until a result arrives, then the first result —
 * and Messages again only when asked for, an error included. A tab the user picked stays picked.
 */
export function shownResultTab(run: QueryRun | null, picked: string | null): string {
  if (!run) return MESSAGES_TAB;
  if (picked === MESSAGES_TAB || (picked && run.tabs.some((t) => t.key === picked))) return picked;
  return run.tabs[0]?.key ?? MESSAGES_TAB;
}

/** Whether a result's cells can be changed, and if not, the chip's reason. */
export type ResultEditability =
  | { editable: true; rowKey: string[]; schema: GridColumnSchema[] }
  /** `reason` is null while the table's columns are still being read. */
  | { editable: false; reason: string | null };

/**
 * A result is saved back to the one table it was read from, by that table's primary key: only a
 * result that carries every key column, and nothing that is not one of the table's columns, can
 * say which row an edit belongs to and which column it changes. DBGate keeps this for Premium.
 */
export function resultEditability(options: {
  readonly: boolean;
  explain: boolean;
  /** The table the statement reads, when it reads one alone (`extractQueryTable`). */
  table: { table: string; schema: string } | null;
  /** That table's columns: undefined while being read, null when they could not be. */
  tableColumns: DbColumnInfo[] | null | undefined;
  /** The result's columns as the driver named them. */
  columns: readonly string[];
}): ResultEditability {
  if (options.readonly) return { editable: false, reason: "read-only connection" };
  if (options.explain) return { editable: false, reason: "read-only: a plan" };
  if (!options.table) return { editable: false, reason: "read-only: not a single table" };
  if (options.tableColumns === undefined) return { editable: false, reason: null };
  if (options.tableColumns === null) return { editable: false, reason: "read-only: the table's columns could not be read" };
  // No columns: what the FROM names is no table — a function such as generate_series, a CTE.
  if (options.tableColumns.length === 0) return { editable: false, reason: "read-only: not a single table" };
  const byName = new Map(options.tableColumns.map((c) => [c.name, c]));
  if (new Set(options.columns).size !== options.columns.length) return { editable: false, reason: "read-only: a column name repeats" };
  if (!options.columns.every((c) => byName.has(c))) return { editable: false, reason: "read-only: not every column is the table's" };
  const rowKey = options.tableColumns.filter((c) => c.pk).map((c) => c.name);
  if (rowKey.length === 0) return { editable: false, reason: "read-only: no primary key" };
  if (!rowKey.every((c) => options.columns.includes(c))) return { editable: false, reason: "read-only: the primary key is not in the result" };
  return { editable: true, rowKey, schema: options.columns.map((c) => byName.get(c)!) };
}
