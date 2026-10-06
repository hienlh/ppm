/**
 * A filter on a phone, opened from its chip, its column's title or ⌄: the filter box, what its text
 * would do, the column menu's items — its sort, Copy column name, Hide column, the table a foreign
 * key refers to — and the funnel's items as a list. Nothing is applied until Apply or Enter —
 * closing the sheet leaves the filter as it was. A funnel item that writes a filter applies it at
 * once; one that asks for a dialog, ⋮ and ⋯ make way for that dialog's own sheet. With no column it
 * is the Multi column filter's, which has neither a column menu nor ⋮.
 */
import { useId, useState, type ClipboardEvent, type ElementType, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Check, Columns, Copy, ExternalLink, EyeOff, Filter, Key, Link, MoreHorizontal, MoreVertical, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { filterSyntax } from "../../../../shared/db-filter-parser";
import type { GridSort } from "../../../../shared/db-grid";
import type { GridColumnSchema, GridFiltering } from "../glide-grid-types";
import { inputClass } from "../connection-form/form-controls";
import { funnelItems, type FunnelItem } from "./filter-funnel-menu";
import { columnFilterState, linesFilter, multiFilterState, withColumnFilter, withMultiFilter } from "./grid-filters";
import { canChooseValues } from "./value-filter-text";
import { columnMenuItems, type ColumnMenuItem } from "./column-menu";

/** What a column's sheet does besides filtering: the column menu's items. */
export interface FilterSheetColumnMenu {
  /** The sort in force; its items change it as the column menu's do. Absent where rows cannot be sorted. */
  sort?: { sort: readonly GridSort[]; onChange: (sort: GridSort[]) => void };
  onCopyName: (column: string) => void;
  /** The Columns panel's checkbox, from the sheet. */
  onHide?: (column: string) => void;
  onOpenTable?: (table: string) => void;
}

const sortItemIcon = (item: Extract<ColumnMenuItem, { kind: "sort" }>) =>
  item.sort.length === 0 ? X : item.dir === "DESC" ? ArrowDown : ArrowUp;

// The box keeps its colour while focused: the colour is what says whether the text reads.
const BOX_STATE = {
  empty: "",
  ok: "border-success/55 focus:border-success/55 text-success",
  off: "border-dashed text-text-3 line-through",
  bad: "border-error/70 focus:border-error/70 text-error",
} as const;

// Dialogs open from here hand focus back to nothing: on a phone that would only raise the keyboard.
const noFocus = () => {};

export function FilterSheet({ filtering, column, schema, menu, onClose }: {
  filtering: GridFiltering;
  /** Null for the Multi column filter. */
  column: string | null;
  schema: readonly GridColumnSchema[];
  menu?: FilterSheetColumnMenu;
  onClose: () => void;
}) {
  const titleId = useId();
  const kind = column === null ? null : filtering.columns.find((c) => c.name === column)?.kind ?? "other";
  const committed = column === null ? filtering.filters.multi : filtering.filters.columns[column];
  const [draft, setDraft] = useState(committed?.text ?? "");
  const col = column === null ? undefined : schema.find((c) => c.name === column);

  const read = kind === null ? multiFilterState({ text: draft }, filtering.columns) : columnFilterState({ text: draft }, kind);
  const unchanged = draft === (committed?.text ?? "");
  const refused = unchanged && read.state === "ok" && column !== null ? filtering.errors?.[column] : undefined;
  const state = refused ? "bad" : unchanged && read.state === "ok" && committed?.off ? "off" : read.state;
  const status = refused ? `Refused: ${refused}`
    : read.state === "bad" ? `${read.error.message} — it would not be applied`
    : state === "off" ? "Switched off · Apply switches it on"
    : state === "ok" ? "Understood · Apply filters the rows"
    : column === null ? "No filter on any column" : "No filter on this column";

  const commit = (text: string) => {
    onClose();
    filtering.onChange((f) => (column === null ? withMultiFilter(f, text) : withColumnFilter(f, column, text)));
  };
  const apply = () => {
    if (read.state !== "bad") commit(draft);
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // Put the caret on the part that does not read, as Enter in the filter row does.
    if (read.state === "bad" && read.error.end > read.error.start) e.currentTarget.setSelectionRange(read.error.start, read.error.end);
    apply();
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\n")) return;
    e.preventDefault();
    const filter = linesFilter("is", text);
    if (filter) setDraft(filter);
  };

  /** Closes the sheet, then opens a dialog over where it was. */
  const handOff = (open: () => void) => {
    onClose();
    open();
  };
  const picker = column === null || kind === null ? null
    : col?.fk && filtering.onLookup ? { icon: MoreHorizontal, label: `Lookup from ${col.fk.table}`, open: () => filtering.onLookup!(column, noFocus) }
    : filtering.onChooseValues && canChooseValues(kind) ? { icon: MoreVertical, label: `Choose value from ${column}`, open: () => filtering.onChooseValues!(column, noFocus) }
    : null;

  // Clear Filter is the sheet's own button, and a list has no use for separators.
  const items = funnelItems(kind === null ? "multi" : filterSyntax(kind))
    .filter((item): item is Exclude<FunnelItem, "separator"> => item !== "separator" && item.label !== "Clear Filter")
    .filter((item) => "text" in item.action || !!filtering.onDialog);
  const menuItems = column !== null && menu
    ? columnMenuItems(column, menu.sort?.sort ?? [], menu.onOpenTable ? col?.fk?.table : null)
    : [];
  const sortItems = menu?.sort ? menuItems.filter((item) => item.kind === "sort") : [];
  const fkItem = menuItems.find((item) => item.kind === "open-table");
  const HeadIcon = column === null ? Filter : col?.pk ? Key : col?.fk ? Link : Columns;

  return (
    <BottomSheet open onClose={onClose} className="popover-solid">
      <div
        role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
        className="flex max-h-[calc(var(--sheet-vh,100dvh)*0.85)] flex-col"
      >
        <div className="flex shrink-0 items-center gap-2.5 pr-1.5 pb-1 pl-4">
          <HeadIcon className={cn("size-5 shrink-0", col?.pk ? "text-warning" : col?.fk ? "text-info" : "text-text-2")} aria-hidden />
          <h2 id={titleId} className="min-w-0 flex-1 text-[15px] font-semibold">
            <span className="block truncate">{column ?? "Multi column filter"}</span>
            <small className="block truncate text-xs font-normal text-text-3">
              {col ? `${col.type}${col.nullable ? "" : " · NOT NULL"}${col.fk ? ` · → ${col.fk.table}.${col.fk.column}` : ""}` : column === null ? "Every column of the table reads it" : null}
            </small>
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-11 shrink-0 place-items-center rounded-lg text-text-2 active:bg-surface-hover">
            <X className="size-5" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto pb-3">
          <SectionTitle>Filter</SectionTitle>
          <div className="flex items-center gap-2 px-4">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onInputKeyDown}
              onPaste={onPaste}
              placeholder="Filter"
              aria-label={column === null ? "Multi column filter" : `Filter ${column}`}
              aria-invalid={state === "bad"}
              aria-describedby={`${titleId}-status`}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className={cn(inputClass, "font-mono", BOX_STATE[state])}
            />
            {picker && (
              <button
                type="button" onClick={() => handOff(picker.open)} aria-label={picker.label} title={picker.label}
                className="grid size-11 shrink-0 place-items-center rounded-md border border-border text-text-2 active:bg-surface-hover"
              >
                <picker.icon className="size-5" />
              </button>
            )}
          </div>
          <p
            id={`${titleId}-status`} aria-live="polite"
            className={cn("mt-1.5 px-4 text-[12.5px]", state === "bad" ? "text-error" : state === "ok" ? "text-success" : "text-text-3")}
          >
            {status}
          </p>

          {sortItems.length > 0 && (
            <>
              <SectionTitle>Sort</SectionTitle>
              {sortItems.map((item) => (
                <SheetItem
                  key={item.label} icon={sortItemIcon(item)} label={item.label} checked={item.checked}
                  onSelect={() => handOff(() => menu!.sort!.onChange(item.sort))}
                />
              ))}
            </>
          )}

          {column !== null && menu && (
            <>
              <SectionTitle>Column</SectionTitle>
              <SheetItem icon={Copy} label="Copy column name" onSelect={() => handOff(() => menu.onCopyName(column))} />
              {menu.onHide && <SheetItem icon={EyeOff} label="Hide column" onSelect={() => handOff(() => menu.onHide!(column))} />}
              {fkItem && <SheetItem icon={ExternalLink} label={`Open ${fkItem.table}`} onSelect={() => handOff(() => menu.onOpenTable!(fkItem.table))} />}
            </>
          )}

          <SectionTitle>Filter options</SectionTitle>
          {items.map((item) => (
            <SheetItem
              key={item.label} label={item.label}
              onSelect={() => {
                const action = item.action;
                if ("text" in action) commit(action.text);
                else handOff(() => filtering.onDialog!(column, action.open, noFocus));
              }}
            />
          ))}
        </div>

        <div className="flex shrink-0 gap-2 border-t border-border-soft px-3 pt-2.5">
          <Button type="button" variant="outline" onClick={() => commit("")} className="h-11 flex-1 text-sm">Clear Filter</Button>
          <Button type="button" onClick={apply} disabled={read.state === "bad"} className="h-11 flex-[2] text-sm">Apply</Button>
        </div>
      </div>
    </BottomSheet>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mx-4 mt-3.5 mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-text-3 uppercase">{children}</h3>;
}

function SheetItem({ icon: Icon, label, checked, onSelect }: { icon?: ElementType; label: string; checked?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button" onClick={onSelect}
      aria-pressed={checked === undefined ? undefined : checked}
      className="flex min-h-[52px] w-full items-center gap-3 border-b border-border-soft px-4 text-left text-[15px] select-none active:bg-surface-hover"
    >
      {Icon ? <Icon className="size-5 shrink-0 text-text-2" aria-hidden /> : <span className="size-5 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1">{label}</span>
      {checked && <Check className="size-5 shrink-0 text-primary" aria-hidden />}
    </button>
  );
}
