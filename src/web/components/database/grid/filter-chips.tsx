/**
 * The chips above a phone's grid, which has no room for the filter row or the panel beside it:
 * "Columns · N hidden" while the panel's list hides any, a chip for each filter, in the table's
 * column order, then the Multi column filter, and last the sort. A filter's chip says how it stands
 * — green when applied, dashed and struck through when switched off, rose with a warning when it
 * does not read or the server refused it. Tapping it opens the filter's sheet, and × removes the
 * filter; the sort's chip opens the sheet of the first column sorted by.
 */
import { AlertTriangle, ArrowUpDown, Columns3, Filter, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { GridSort } from "../../../../shared/db-grid";
import type { GridFiltering } from "../glide-grid-types";
import { columnFilterState, multiFilterState, withColumnFilter, withMultiFilter, type FilterState, type FilterText } from "./grid-filters";

interface Chip {
  /** Null for the Multi column filter. */
  column: string | null;
  filter: FilterText;
  state: Exclude<FilterState["state"], "empty">;
  /** The server's reason, when it refused a filter that reads. */
  refused?: string;
}

const CHIP_STATE: Record<Chip["state"], string> = {
  ok: "border-success/45 bg-success/10 text-success",
  off: "border-dashed border-border text-text-3",
  bad: "border-error/50 bg-error/10 text-error",
};

/** What a screen reader hears after the filter's text. */
const said = (chip: Chip) => (chip.refused ? ", refused" : chip.state === "bad" ? ", not understood" : chip.state === "off" ? ", switched off" : "");

/** "id ↑, name ↓": the sort, in order. */
export const sortChipText = (sort: readonly GridSort[]) => sort.map((s) => `${s.column} ${s.dir === "ASC" ? "↑" : "↓"}`).join(", ");

const plainChip = "relative inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border bg-panel-2 px-2.5 text-[12.5px] text-text-2 select-none before:absolute before:inset-x-0 before:-inset-y-[7px]";

export function FilterChips({ filtering, onOpen, sort, hidden }: {
  filtering: GridFiltering;
  /** Opens the sheet of a column's filter, or of the Multi column filter (`null`). */
  onOpen: (column: string | null) => void;
  /** The sort in force, whose chip opens its first column's sheet. */
  sort?: readonly GridSort[];
  /** Columns the panel hides, whose chip opens the Columns and filters sheet. */
  hidden?: { count: number; onOpen: () => void };
}) {
  const { filters, columns, errors, onChange } = filtering;
  const chips = columns.flatMap((c): Chip[] => {
    const filter = filters.columns[c.name];
    const { state } = columnFilterState(filter, c.kind);
    if (!filter || state === "empty") return [];
    const refused = state === "ok" ? errors?.[c.name] : undefined;
    return [{ column: c.name, filter, state: refused ? "bad" : state, refused }];
  });
  const multi = filters.multi;
  const multiState = multiFilterState(multi, columns).state;
  if (multi && multiState !== "empty") chips.push({ column: null, filter: multi, state: multiState });
  const sorted = sort?.length ? sort : null;
  if (chips.length === 0 && !sorted && !hidden?.count) return null;

  return (
    // A chip is 32px and its buttons 30px inside its border; each reaches 7px up and down into the
    // row's padding to be 44px tall, and × reaches into the 12px gap after it to be 44px wide.
    <div role="group" aria-label="Filters" className="flex shrink-0 gap-3 overflow-x-auto border-b border-border-soft px-3 py-1.5 scrollbar-none">
      {hidden && hidden.count > 0 && (
        <button type="button" onClick={hidden.onOpen} className={plainChip}>
          <Columns3 className="size-3.5 shrink-0" aria-hidden />
          <b className="font-semibold">Columns</b> · {hidden.count} hidden
        </button>
      )}
      {chips.map((chip) => {
        const name = chip.column ?? "any column";
        const Icon = chip.state === "bad" ? AlertTriangle : Filter;
        return (
          <span key={chip.column ?? "\0multi"} className={cn("inline-flex h-8 shrink-0 items-stretch rounded-full border text-[12.5px] select-none", CHIP_STATE[chip.state])}>
            <button
              type="button" onClick={() => onOpen(chip.column)}
              aria-label={`${name}: ${chip.filter.text}${said(chip)}`}
              className="relative flex min-w-0 items-center gap-1 rounded-l-full pr-1 pl-2.5 before:absolute before:inset-x-0 before:-inset-y-[7px]"
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <b className="shrink-0 font-semibold">{name}</b>
              <span className={cn("max-w-[40vw] truncate font-mono text-xs", chip.state === "off" && "line-through")}>{chip.filter.text}</span>
            </button>
            <button
              type="button" title="Remove"
              aria-label={chip.column === null ? "Remove the Multi column filter" : `Remove the ${chip.column} filter`}
              onClick={() => onChange((f) => (chip.column === null ? withMultiFilter(f, "") : withColumnFilter(f, chip.column, "")))}
              className="relative grid w-8 shrink-0 place-items-center rounded-r-full before:absolute before:-inset-y-[7px] before:left-0 before:-right-3"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        );
      })}
      {sorted && (
        <button
          type="button" onClick={() => onOpen(sorted[0]!.column)} aria-label={`Sorted by ${sortChipText(sorted)}`}
          className={plainChip}
        >
          <ArrowUpDown className="size-3.5 shrink-0" aria-hidden />
          <span className="max-w-[50vw] truncate">{sortChipText(sorted)}</span>
        </button>
      )}
    </div>
  );
}
