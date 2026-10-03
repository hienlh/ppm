/**
 * DBGate's funnel: the filters a column's type offers, in DBGate's order, and the two conditions
 * of the Set filter dialog its "..." items open. Everything here ends as filter text — what a
 * person could have typed into the cell — because the cell is the one place a filter lives
 * (see grid-filters.ts): a filter built here and one typed by hand cannot disagree.
 */
import type { FilterSyntax } from "../../../../shared/db-filter-parser";

/** The syntax a filter is read in, or the Multi column filter, which every column reads. */
export type FunnelKind = FilterSyntax | "multi";

export type ConditionOp =
  | "=" | "<>" | "+" | "~" | "^" | "!^" | "$" | "!$" | "<" | ">" | "<=" | ">="
  | "NULL" | "NOT NULL" | "sql" | "sqlRight";

export interface ConditionChoice {
  op: ConditionOp;
  label: string;
}

const choices = (list: [ConditionOp, string][]): ConditionChoice[] => list.map(([op, label]) => ({ op, label }));

const EQUALS = choices([["=", "equals"], ["<>", "does not equal"]]);
const TEXT = choices([
  ["+", "contains"], ["~", "does not contain"], ["^", "begins with"],
  ["!^", "does not begin with"], ["$", "ends with"], ["!$", "does not end with"],
]);
const ORDER = choices([["<", "is smaller"], [">", "is greater"], ["<=", "is smaller or equal"], [">=", "is greater or equal"]]);
const DATES = choices([["<", "is before"], [">", "is after"], ["<=", "is before or equal"], [">=", "is after or equal"]]);
const NULLS = choices([["NULL", "is NULL"], ["NOT NULL", "is not NULL"]]);
const SQL = choices([["sql", "SQL condition"], ["sqlRight", "SQL condition - right side only"]]);

/**
 * The comparisons the Set filter dialog lists. A boolean or binary column only has NULL and SQL;
 * the Multi column filter has no SQL, because `$$` would have no one column to name.
 */
export function conditionChoices(kind: FunnelKind): ConditionChoice[] {
  switch (kind) {
    case "text": return [...EQUALS, ...TEXT, ...ORDER, ...NULLS, ...SQL];
    case "multi": return [...EQUALS, ...TEXT, ...ORDER, ...NULLS];
    case "number": return [...EQUALS, ...ORDER, ...NULLS, ...SQL];
    case "date": return [...DATES, ...NULLS, ...SQL];
    case "boolean": case "binary": return [...NULLS, ...SQL];
  }
}

/** NULL and NOT NULL are whole conditions; every other comparison needs a value. */
export const takesValue = (op: ConditionOp): boolean => op !== "NULL" && op !== "NOT NULL";

export type FilterDialogRequest =
  | { dialog: "condition"; kind: FunnelKind; first: ConditionOp; second: ConditionOp }
  | { dialog: "lines" };

/**
 * The Set filter dialog opened on `first`. The second condition starts on "equals" where the
 * column has it, as in DBGate, and otherwise on the first comparison that needs a value — so it
 * adds nothing until one is typed, where "is NULL" would have joined every filter unasked.
 */
function conditionDialog(kind: FunnelKind, first: ConditionOp, second?: ConditionOp): FilterDialogRequest {
  const ops = conditionChoices(kind).map((c) => c.op);
  return { dialog: "condition", kind, first, second: second ?? (ops.includes("=") ? "=" : ops.find(takesValue)!) };
}

/** An item writes its text into the cell, or opens the dialog that builds one. */
export type FunnelAction = { text: string } | { open: FilterDialogRequest };
export type FunnelItem = { label: string; action: FunnelAction } | "separator";

const write = (label: string, text: string): FunnelItem => ({ label, action: { text } });

const DATE_WORDS = [["Tomorrow", "Today", "Yesterday"], ...["Week", "Month", "Year"].map((unit) => ["Next", "This", "Last"].map((step) => `${step} ${unit}`))];

/** The funnel's items for one filter, in DBGate's order. */
export function funnelItems(kind: FunnelKind): FunnelItem[] {
  const open = (label: string, first: ConditionOp, second?: ConditionOp): FunnelItem => ({ label, action: { open: conditionDialog(kind, first, second) } });
  const text = kind === "text" || kind === "multi";
  const ordered = text || kind === "number";
  const items: FunnelItem[] = [write("Clear Filter", "")];
  // A binary column reads no value at all, so a list of them could only ever be refused.
  if (kind !== "binary") items.push({ label: "Filter multiple values", action: { open: { dialog: "lines" } } });
  if (ordered) items.push(open("Equals...", "="), open("Does Not Equal...", "<>"));
  items.push(write("Is Null", "NULL"), write("Is Not Null", "NOT NULL"));
  if (text) items.push(write("Is Empty Or Null", "EMPTY, NULL"), write("Has Not Empty Value", "NOT EMPTY NOT NULL"));
  if (ordered) {
    items.push(
      "separator",
      open("Greater Than...", ">"), open("Greater Than Or Equal To...", ">="),
      open("Less Than...", "<"), open("Less Than Or Equal To...", "<="),
    );
  }
  if (text) {
    items.push(
      "separator",
      open("Contains...", "+"), open("Does Not Contain...", "~"),
      open("Begins With...", "^"), open("Does Not Begin With...", "!^"),
      open("Ends With...", "$"), open("Does Not End With...", "!$"),
    );
  }
  if (kind === "boolean") {
    items.push(write("Is True", "TRUE"), write("Is False", "FALSE"), write("Is True or NULL", "TRUE, NULL"), write("Is False or NULL", "FALSE, NULL"));
  }
  if (kind === "date") {
    for (const words of DATE_WORDS) items.push("separator", ...words.map((w) => write(w, w.toUpperCase())));
    items.push("separator", open("Before...", "<="), open("After...", ">="), open("Between...", ">=", "<="));
  }
  if (kind !== "multi") items.push("separator", open("SQL condition ...", "sql"), open("SQL condition - right side ...", "sqlRight"));
  return items;
}

export interface Condition {
  op: ConditionOp;
  value: string;
}

/** One condition as filter text; null when it needs a value and was given none. */
export function conditionText(kind: FunnelKind, { op, value }: Condition): string | null {
  if (!takesValue(op)) return op;
  const v = value.trim();
  if (!v) return null;
  if (op === "sql") return `{${v}}`;
  if (op === "sqlRight") return `{$$ ${v}}`;
  // Text is quoted so that a space or a comma stays inside the value; a number or a date is
  // written as typed, which is how `>=2024-01-01 <=2024-01-31` reads back.
  return kind === "text" || kind === "multi" ? `${op}"${v.replaceAll('"', '""')}"` : `${op}${v}`;
}

/** The Set filter dialog's two conditions as one filter: a space is AND, a comma OR. Empty when neither says anything. */
export function setFilterText(kind: FunnelKind, first: Condition, join: "and" | "or", second: Condition): string {
  const a = conditionText(kind, first);
  const b = conditionText(kind, second);
  return a && b ? `${a}${join === "and" ? " " : ","}${b}` : (a ?? b ?? "");
}
