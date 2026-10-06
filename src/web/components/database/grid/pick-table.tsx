/**
 * The list ⋮ and ⋯ pick from: a row a value, ticked by its checkbox or anywhere on the row, under
 * a header that stays put while the list scrolls. What is in the cells is the dialog's.
 */
import type { ReactNode } from "react";
import { Search } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { inputClass } from "../connection-form/form-controls";

export interface PickRow {
  key: string;
  /** Names the row to a screen reader: "Pick <label>". */
  label: string;
  cells: ReactNode[];
}

export interface PickColumn {
  label: string;
  /** A Tailwind width, e.g. `w-[38%]`; a column without one takes what is left. */
  width?: string;
}

export function PickTable({ headers, rows, picked, onToggle, children }: {
  headers: readonly PickColumn[];
  rows: readonly PickRow[];
  picked: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Shown under the rows: what the list is still doing, or why it is empty. */
  children?: ReactNode;
}) {
  const head = "sticky top-0 z-10 h-7 border-b border-border-soft bg-panel px-2.5 text-left text-[11px] font-semibold text-text-3";
  const cell = "h-[30px] border-b border-border-soft px-2.5 max-md:h-11";
  return (
    <div className="max-h-80 min-h-24 overflow-auto rounded-md border border-border bg-panel-2 max-md:max-h-[50dvh]">
      {/* Fixed, so a long value is cut short in its cell rather than widening the list. */}
      <table className="w-full table-fixed border-collapse text-[12.5px] max-md:text-sm">
        <thead>
          <tr>
            <th className={cn(head, "w-[34px] max-md:w-11")}><span className="sr-only">Picked</span></th>
            {headers.map((h) => <th key={h.label} className={cn(head, h.width)}>{h.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const on = picked.has(row.key);
            return (
              <tr
                key={row.key}
                onClick={(e) => { if (!(e.target as HTMLElement).closest("input")) onToggle(row.key); }}
                className={cn("cursor-pointer select-none [&:last-child>td]:border-b-0", on ? "bg-accent-wash" : "can-hover:hover:bg-surface-hover")}
              >
                <td className={cell}>
                  <input
                    type="checkbox" checked={on} onChange={() => onToggle(row.key)} aria-label={`Pick ${row.label}`}
                    className="block size-3.5 accent-primary max-md:size-5"
                  />
                </td>
                {row.cells.map((c, i) => <td key={i} className={cn(cell, "truncate")}>{c}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {children}
    </div>
  );
}

/** A value in a pick list: NULL and the empty text marked, so neither reads as a blank row. */
export function PickValue({ text, isNull, mono }: { text: string; isNull?: boolean; mono?: boolean }) {
  if (isNull) return <span className="font-mono text-text-3 italic">NULL</span>;
  if (text === "") return <span className="text-text-3 italic">(empty)</span>;
  return <span className={cn(mono && "font-mono")} title={text}>{text}</span>;
}

/**
 * The search over a pick list. Enter searches at once rather than OK-ing the dialog: what has
 * been ticked is not done with because a search was typed. Focus does not start here on a phone,
 * where it would put the keyboard over the list.
 */
export function PickSearch({ value, onChange, onSearchNow, label }: {
  value: string;
  onChange: (value: string) => void;
  onSearchNow: () => void;
  label: string;
}) {
  return (
    <span className="relative flex min-w-0">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-subtle" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          onSearchNow();
        }}
        placeholder="Search"
        aria-label={label}
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn(inputClass, "pl-8")}
      />
    </span>
  );
}
