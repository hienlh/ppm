/**
 * The funnel lists DBGate's items for each type of column, in DBGate's order, and everything it
 * writes is filter text the column can read — the dialogs included.
 */
import { describe, expect, it } from "bun:test";
import {
  conditionChoices, conditionText, funnelItems, setFilterText, type FunnelItem, type FunnelKind,
} from "../../../src/web/components/database/grid/filter-funnel-menu.ts";
import { parseAnyColumnFilter, parseFilter, type FilterSyntax } from "../../../src/shared/db-filter-parser.ts";
import type { ColumnKind } from "../../../src/shared/db-column-kind.ts";

const labels = (items: FunnelItem[]) => items.map((i) => (i === "separator" ? "—" : i.label));
const item = (kind: FunnelKind, label: string) => funnelItems(kind).find((i) => i !== "separator" && i.label === label) as Exclude<FunnelItem, "separator">;

describe("the funnel's items", () => {
  it("lists a text column's filters in DBGate's order", () => {
    expect(labels(funnelItems("text"))).toEqual([
      "Clear Filter", "Filter multiple values", "Equals...", "Does Not Equal...", "Is Null", "Is Not Null",
      "Is Empty Or Null", "Has Not Empty Value",
      "—", "Greater Than...", "Greater Than Or Equal To...", "Less Than...", "Less Than Or Equal To...",
      "—", "Contains...", "Does Not Contain...", "Begins With...", "Does Not Begin With...", "Ends With...", "Does Not End With...",
      "—", "SQL condition ...", "SQL condition - right side ...",
    ]);
  });

  it("lists a number column's", () => {
    expect(labels(funnelItems("number"))).toEqual([
      "Clear Filter", "Filter multiple values", "Equals...", "Does Not Equal...", "Is Null", "Is Not Null",
      "—", "Greater Than...", "Greater Than Or Equal To...", "Less Than...", "Less Than Or Equal To...",
      "—", "SQL condition ...", "SQL condition - right side ...",
    ]);
  });

  it("lists a date column's", () => {
    expect(labels(funnelItems("date"))).toEqual([
      "Clear Filter", "Filter multiple values", "Is Null", "Is Not Null",
      "—", "Tomorrow", "Today", "Yesterday",
      "—", "Next Week", "This Week", "Last Week",
      "—", "Next Month", "This Month", "Last Month",
      "—", "Next Year", "This Year", "Last Year",
      "—", "Before...", "After...", "Between...",
      "—", "SQL condition ...", "SQL condition - right side ...",
    ]);
  });

  it("lists a boolean column's", () => {
    expect(labels(funnelItems("boolean"))).toEqual([
      "Clear Filter", "Filter multiple values", "Is Null", "Is Not Null",
      "Is True", "Is False", "Is True or NULL", "Is False or NULL",
      "—", "SQL condition ...", "SQL condition - right side ...",
    ]);
  });

  it("offers a binary column nothing it cannot read", () => {
    expect(labels(funnelItems("binary"))).toEqual(["Clear Filter", "Is Null", "Is Not Null", "—", "SQL condition ...", "SQL condition - right side ..."]);
  });

  it("offers the Multi column filter the text filters, without SQL", () => {
    expect(labels(funnelItems("multi"))).toEqual(labels(funnelItems("text")).slice(0, -3));
  });

  it("writes text the column reads, as it would have been typed", () => {
    const kinds: [FunnelKind, ColumnKind][] = [["text", "text"], ["number", "number"], ["date", "datetime"], ["boolean", "boolean"], ["binary", "binary"]];
    for (const [kind, column] of kinds) {
      for (const i of funnelItems(kind)) {
        if (i === "separator" || !("text" in i.action) || !i.action.text) continue;
        expect([kind, i.label, parseFilter(i.action.text, column).ok]).toEqual([kind, i.label, true]);
      }
    }
    expect(item("text", "Has Not Empty Value").action).toEqual({ text: "NOT EMPTY NOT NULL" });
    expect(item("date", "This Month").action).toEqual({ text: "THIS MONTH" });
    expect(funnelItems("boolean").slice(4).flatMap((i) => (i !== "separator" && "text" in i.action ? [i.action.text] : []))).toEqual([
      "TRUE", "FALSE", "TRUE, NULL", "FALSE, NULL",
    ]);
    expect(item("text", "Clear Filter").action).toEqual({ text: "" });
  });

  it("opens Filter multiple values, and Set filter on the comparison chosen", () => {
    expect(item("number", "Filter multiple values").action).toEqual({ open: { dialog: "lines" } });
    expect(item("text", "Does Not Begin With...").action).toEqual({ open: { dialog: "condition", kind: "text", first: "!^", second: "=" } });
    expect(item("multi", "Greater Than...").action).toEqual({ open: { dialog: "condition", kind: "multi", first: ">", second: "=" } });
  });

  it("opens Between... on both ends of the range, and dates on the first comparison that takes one", () => {
    expect(item("date", "Between...").action).toEqual({ open: { dialog: "condition", kind: "date", first: ">=", second: "<=" } });
    expect(item("date", "Before...").action).toEqual({ open: { dialog: "condition", kind: "date", first: "<=", second: "<" } });
    expect(item("date", "After...").action).toEqual({ open: { dialog: "condition", kind: "date", first: ">=", second: "<" } });
  });

  it("starts the second condition where it adds nothing until a value is typed", () => {
    // "is NULL" is DBGate's first choice there, and it would have joined every filter unasked.
    expect(item("boolean", "SQL condition ...").action).toEqual({ open: { dialog: "condition", kind: "boolean", first: "sql", second: "sql" } });
    expect(item("binary", "SQL condition - right side ...").action).toEqual({ open: { dialog: "condition", kind: "binary", first: "sqlRight", second: "sql" } });
  });

  it("opens Set filter only on comparisons the dialog lists", () => {
    for (const kind of ["text", "number", "date", "boolean", "binary", "multi"] as FunnelKind[]) {
      const listed = conditionChoices(kind).map((c) => c.op);
      for (const i of funnelItems(kind)) {
        if (i === "separator" || !("open" in i.action) || i.action.open.dialog !== "condition") continue;
        expect([kind, i.label, listed.includes(i.action.open.first), listed.includes(i.action.open.second)]).toEqual([kind, i.label, true, true]);
      }
    }
  });
});

describe("the Set filter dialog's comparisons", () => {
  const ops = (kind: FunnelKind) => conditionChoices(kind).map((c) => c.op);

  it("lists each type's own", () => {
    expect(ops("text")).toEqual(["=", "<>", "+", "~", "^", "!^", "$", "!$", "<", ">", "<=", ">=", "NULL", "NOT NULL", "sql", "sqlRight"]);
    expect(ops("number")).toEqual(["=", "<>", "<", ">", "<=", ">=", "NULL", "NOT NULL", "sql", "sqlRight"]);
    expect(ops("date")).toEqual(["<", ">", "<=", ">=", "NULL", "NOT NULL", "sql", "sqlRight"]);
    expect(ops("boolean")).toEqual(["NULL", "NOT NULL", "sql", "sqlRight"]);
    expect(ops("binary")).toEqual(ops("boolean"));
    expect(ops("multi")).toEqual(ops("text").slice(0, -2));
  });

  it("names each comparison as DBGate does", () => {
    expect(conditionChoices("text").map((c) => c.label)).toEqual([
      "equals", "does not equal", "contains", "does not contain", "begins with", "does not begin with", "ends with", "does not end with",
      "is smaller", "is greater", "is smaller or equal", "is greater or equal", "is NULL", "is not NULL",
      "SQL condition", "SQL condition - right side only",
    ]);
  });

  it("names a date comparison by time", () => {
    expect(conditionChoices("date").slice(0, 4).map((c) => c.label)).toEqual(["is before", "is after", "is before or equal", "is after or equal"]);
    expect(conditionChoices("number").find((c) => c.op === "<=")!.label).toBe("is smaller or equal");
    expect(conditionChoices("text").at(-1)!.label).toBe("SQL condition - right side only");
  });
});

describe("the text the Set filter dialog writes", () => {
  it("quotes text, doubling a quote inside it, and writes numbers and dates as typed", () => {
    expect(conditionText("text", { op: "^", value: ' say "hi", ok ' })).toBe('^"say ""hi"", ok"');
    expect(conditionText("multi", { op: "=", value: "a b" })).toBe('="a b"');
    expect(conditionText("number", { op: ">=", value: "5" })).toBe(">=5");
    expect(conditionText("date", { op: "<", value: "2024-01-01 10:00" })).toBe("<2024-01-01 10:00");
  });

  it("writes NULL as it is and SQL in braces, the right side after `$$`", () => {
    expect(conditionText("number", { op: "NOT NULL", value: "ignored" })).toBe("NOT NULL");
    expect(conditionText("text", { op: "sql", value: "$$ in ('a', 'b')" })).toBe("{$$ in ('a', 'b')}");
    expect(conditionText("boolean", { op: "sqlRight", value: "is distinct from true" })).toBe("{$$ is distinct from true}");
  });

  it("leaves out a condition that needs a value and has none", () => {
    expect(conditionText("text", { op: "=", value: "  " })).toBeNull();
    expect(setFilterText("number", { op: ">", value: "" }, "and", { op: "=", value: "" })).toBe("");
    expect(setFilterText("number", { op: ">", value: "" }, "or", { op: "<", value: "3" })).toBe("<3");
  });

  it("joins the two with a space for And and a comma for Or", () => {
    expect(setFilterText("number", { op: ">=", value: "5" }, "and", { op: "<=", value: "10" })).toBe(">=5 <=10");
    expect(setFilterText("text", { op: "^", value: "a" }, "or", { op: "NULL", value: "" })).toBe('^"a",NULL');
  });

  it("is read back as the conditions chosen", () => {
    const syntaxes: [FilterSyntax, ColumnKind, string][] = [
      ["number", "number", setFilterText("number", { op: ">=", value: "5" }, "and", { op: "<=", value: "10" })],
      ["text", "text", setFilterText("text", { op: "~", value: 'a "b", c' }, "or", { op: "$", value: "z" })],
    ];
    expect(parseFilter(syntaxes[0]![2], "number")).toEqual({ ok: true, anyOf: [[{ op: "ge", value: 5 }, { op: "le", value: 10 }]] });
    expect(parseFilter(syntaxes[1]![2], "text")).toEqual({ ok: true, anyOf: [[{ op: "notContains", value: 'a "b", c' }], [{ op: "endsWith", value: "z" }]] });
    // Between two days keeps the whole of the last one.
    const between = setFilterText("date", { op: ">=", value: "2024-01-01" }, "and", { op: "<=", value: "2024-01-31" });
    expect(between).toBe(">=2024-01-01 <=2024-01-31");
    const read = parseFilter(between, "datetime");
    expect(read.ok && read.anyOf[0]!.map((c) => ("from" in c ? `from ${c.from}` : `to ${c.to}`))).toEqual(["from 2024-01-01 00:00:00", "to 2024-02-01 00:00:00"]);
    // A date with a time stays one value.
    expect(parseFilter(setFilterText("date", { op: ">", value: "2024-01-01 10:00" }, "and", { op: "<", value: "" }), "datetime").ok).toBe(true);
    expect(parseAnyColumnFilter(setFilterText("multi", { op: "=", value: "x y" }, "and", { op: "=", value: "" }), [{ name: "t", kind: "text" }]).ok).toBe(true);
  });
});
