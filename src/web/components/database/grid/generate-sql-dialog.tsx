/**
 * DBGate's Generate SQL from data: the query type, the value columns and the WHERE columns side by
 * side, each list with its All and None, the SQL as it reads under them, and OK, which opens it in
 * a new Query tab. A list the query type does not use is greyed. On a phone, a bottom sheet with
 * the three stacked.
 */
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CheckRow, RadioRow } from "../connection-form/form-controls";
import { FilterDialogFrame } from "./filter-dialog-frame";
import type { CopySqlTarget } from "./copy-as";
import {
  GENERATED_SQL_MAX_CHARS, PREVIEW_STATEMENTS, STATEMENT_TYPES, generateSql, takesValues, takesWhere,
  type GeneratedStatement, type SqlSourceRow,
} from "./generate-sql";

export function GenerateSqlDialog({ rows, allColumns, selectedColumns, keyColumns, target, onOk, onClose, returnFocus }: {
  /** The rows the selection lies on, read again whenever a choice changes. */
  rows: Iterable<SqlSourceRow>;
  /** The table's columns, in its order: the lists show them all, hidden ones included. */
  allColumns: readonly string[];
  /** The columns the selection lies in: the value columns ticked to start with. */
  selectedColumns: readonly string[];
  /** The primary key, else the first column: the WHERE columns ticked to start with. */
  keyColumns: readonly string[];
  target: Omit<CopySqlTarget, "keyColumns">;
  /** Takes the SQL, which opens in a new Query tab. */
  onOk: (sql: string) => void;
  onClose: () => void;
  /** Where focus goes when the dialog is closed without OK; after OK, the Query tab has it. */
  returnFocus?: () => void;
}) {
  const id = useId();
  const [type, setType] = useState<GeneratedStatement>("INSERT");
  const [values, setValues] = useState<ReadonlySet<string>>(() => new Set(selectedColumns.filter((c) => allColumns.includes(c))));
  const [where, setWhere] = useState<ReadonlySet<string>>(() => new Set(keyColumns.filter((c) => allColumns.includes(c))));
  const opened = useRef(false);

  // In the table's order, whichever order they were ticked in.
  const result = useMemo(
    () => generateSql(type, rows, allColumns.filter((c) => values.has(c)), allColumns.filter((c) => where.has(c)), target, GENERATED_SQL_MAX_CHARS),
    [type, rows, allColumns, values, where, target],
  );
  const canOpen = result.ok && !result.overLimit;

  const ok = () => {
    if (!result.ok || result.overLimit) return;
    opened.current = true;
    onOk(result.statements.join("\n"));
    onClose();
  };

  return (
    <FilterDialogFrame
      title="Generate SQL from data"
      description="INSERT, UPDATE or DELETE statements for the rows selected. OK opens them in a new Query tab."
      onOk={ok} okDisabled={!canOpen} onClose={onClose}
      returnFocus={() => { if (!opened.current) returnFocus?.(); }}
      className="sm:max-w-[760px]"
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-[13px] font-medium text-text-2 md:text-xs">Choose query type</legend>
          <div className="flex flex-wrap gap-x-5 md:flex-col md:gap-1.5">
            {STATEMENT_TYPES.map((t) => (
              <RadioRow key={t} name={`${id}-type`} value={t} checked={type === t} onChange={() => setType(t)}>{t}</RadioRow>
            ))}
          </div>
        </fieldset>
        <ColumnChoice
          id={`${id}-values`} legend="Value columns" columns={allColumns} chosen={values} onChange={setValues}
          disabled={!takesValues(type)}
        />
        <ColumnChoice
          id={`${id}-where`} legend="WHERE columns" columns={allColumns} chosen={where} onChange={setWhere}
          disabled={!takesWhere(type)}
        />
      </div>

      <pre
        role="region" aria-label="SQL preview" tabIndex={0}
        className="h-[20vh] min-h-24 min-w-0 overflow-auto md:h-[25vh] rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-xs leading-normal text-text-primary focus:outline-none focus-visible:border-ring"
      >
        {result.ok
          ? result.statements.slice(0, PREVIEW_STATEMENTS).join("\n")
          : <span className="whitespace-normal font-sans text-[13px] text-text-subtle">{result.reason}</span>}
      </pre>
      {result.ok && result.overLimit ? (
        <p role="alert" className="text-[12.5px] text-error">
          The SQL would be over {GENERATED_SQL_MAX_CHARS.toLocaleString("en-US")} characters, more than a Query tab can keep. Select fewer rows.
        </p>
      ) : result.ok && result.statements.length > PREVIEW_STATEMENTS ? (
        <p className="text-[12.5px] text-text-subtle">
          Showing the first {PREVIEW_STATEMENTS} of {result.statements.length.toLocaleString("en-US")} statements. OK opens them all.
        </p>
      ) : null}
    </FilterDialogFrame>
  );
}

/** One of the column lists: All, None, and a box for each column, which scrolls past a quarter of the screen — less on a phone, where the three are stacked. */
function ColumnChoice({ id, legend, columns, chosen, onChange, disabled }: {
  id: string;
  legend: ReactNode;
  columns: readonly string[];
  chosen: ReadonlySet<string>;
  onChange: (chosen: ReadonlySet<string>) => void;
  disabled: boolean;
}) {
  const toggle = (column: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(column);
    else next.delete(column);
    onChange(next);
  };
  const small = "h-7 px-2.5 text-xs max-md:h-11 max-md:px-4 max-md:text-sm";
  return (
    <fieldset disabled={disabled} className="grid min-w-0 content-start gap-1.5">
      <legend className={cn("mb-1.5 text-[13px] font-medium md:text-xs", disabled ? "text-text-subtle" : "text-text-2")}>{legend}</legend>
      <div className="flex gap-1.5">
        <Button type="button" size="sm" variant="outline" className={small} onClick={() => onChange(new Set(columns))}>All</Button>
        <Button type="button" size="sm" variant="outline" className={small} onClick={() => onChange(new Set())}>None</Button>
      </div>
      <div className="max-h-[18vh] min-w-0 select-none overflow-y-auto md:max-h-[25vh] rounded-md border border-border px-2 py-1 md:py-1.5">
        {columns.map((column, i) => (
          <CheckRow
            key={column} id={`${id}-${i}`} title={column} checked={chosen.has(column)} disabled={disabled}
            onChange={(on) => toggle(column, on)} className="md:py-0.5 [&_b]:wrap-anywhere"
          />
        ))}
      </div>
    </fieldset>
  );
}
