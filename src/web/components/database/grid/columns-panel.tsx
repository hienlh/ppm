/**
 * DBGate's panel beside a table's grid, inside the tab: Columns, then Filters (and References in
 * phase 04d), each folding away. Columns lists every column of the table — a checkbox that shows or
 * hides it in the grid, its key, link or # icon, its name (bold is NOT NULL), its full type, and →
 * the table a foreign key refers to — and clicking a name scrolls the grid to it. Hiding a column
 * reads nothing again: the rows keep it, since Save, the form view and references need their keys.
 *
 * The panel's edge drags it between 170 and 420px (← and → move it too). In a narrow tab it floats
 * over the grid instead of squeezing it, and Esc or a click on the grid puts it away.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowRight, Eye, EyeOff, Hash, Key, Link } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { GridColumnSchema } from "../glide-grid-types";
import { isAutoIncrement } from "../glide-grid-types";
import { EmptyState, Highlight, SearchBox, SectionHeader, linkButtonClass, toolbarButtonClass } from "../explorer/tree-parts";
import { PANEL_WIDTH, clampPanelWidth } from "./table-view-state";

/** The columns a search keeps, in the table's order. */
export function columnsMatching(schema: readonly GridColumnSchema[], query: string): GridColumnSchema[] {
  const needle = query.trim().toLowerCase();
  return needle ? schema.filter((c) => c.name.toLowerCase().includes(needle)) : [...schema];
}

/** A column's icon in the list, as on its title: # for an auto-increment key, a key, a link. */
export function ColumnIcon({ col, className }: { col: GridColumnSchema; className?: string }) {
  if (col.pk) {
    const Icon = isAutoIncrement(col) ? Hash : Key;
    return <Icon className={cn("shrink-0 text-warning", className)} aria-label={isAutoIncrement(col) ? "Auto-increment key" : "Primary key"} />;
  }
  if (col.fk) return <Link className={cn("shrink-0 text-info", className)} aria-label="Foreign key" />;
  return <span className={cn("shrink-0", className)} aria-hidden />;
}

export function ColumnsSection({
  schema, hidden, onHiddenChange, onJump, onOpenTable, selected, sheet = false, grow = true, collapsed, onCollapsedChange, focusSearch,
}: {
  schema: readonly GridColumnSchema[];
  hidden: ReadonlySet<string>;
  onHiddenChange: (hidden: Set<string>) => void;
  /** A name was clicked: the grid scrolls to the column. */
  onJump: (column: string) => void;
  onOpenTable?: (table: string) => void;
  /** Columns selected in the grid from their titles, lit in the list as DBGate's column manager does. */
  selected?: ReadonlySet<string>;
  /** In a phone's sheet: every row, checkbox and button 44px. */
  sheet?: boolean;
  /** Takes the panel's free height; the sheet scrolls as a whole instead. */
  grow?: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** DBGate's Find column: the search box takes the focus — the section unfolded first — and then this is called. */
  focusSearch?: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusSearch) return;
    if (collapsed) {
      onCollapsedChange(false);
      return;
    }
    // Selected, so what is typed next replaces the last search.
    searchRef.current?.focus();
    searchRef.current?.select();
    focusSearch();
  }, [!!focusSearch, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps -- asked, not a new callback
  const list = columnsMatching(schema, query);
  const setHidden = (name: string, hide: boolean) => {
    const next = new Set(hidden);
    if (hide) next.add(name);
    else next.delete(name);
    onHiddenChange(next);
  };
  const iconClass = sheet ? "size-[18px]" : "size-3.5";

  return (
    <section aria-label="Columns" className={cn("flex min-h-0 flex-col", grow && !collapsed && "min-h-24 flex-1")}>
      <SectionHeader title="Columns" collapsed={collapsed} onToggle={() => onCollapsedChange(!collapsed)} />
      {!collapsed && (
        <>
          <div className="flex shrink-0 items-center gap-0.5 pr-1.5 pb-1.5 pl-2">
            <SearchBox value={query} onChange={setQuery} placeholder="Search columns" inputRef={searchRef} />
            <button
              type="button" onClick={() => onHiddenChange(new Set(schema.map((c) => c.name)))}
              disabled={schema.length > 0 && hidden.size >= schema.length}
              title="Hide all columns" aria-label="Hide all columns" className={toolbarButtonClass}
            >
              <EyeOff className="size-4" />
            </button>
            <button
              type="button" onClick={() => onHiddenChange(new Set())} disabled={hidden.size === 0}
              title="Show all columns" aria-label="Show all columns" className={toolbarButtonClass}
            >
              <Eye className="size-4" />
            </button>
          </div>
          <div role="list" aria-label="Columns of the table" className={cn("min-h-0 pb-2.5", grow && "flex-1 overflow-auto")}>
            {list.length === 0 && schema.length > 0 && (
              <EmptyState>
                <span>No column matches “{query.trim()}”.</span>
                <button type="button" onClick={() => setQuery("")} className={linkButtonClass}>Clear search</button>
              </EmptyState>
            )}
            {list.map((col) => {
              const shown = !hidden.has(col.name);
              const lit = !!selected?.has(col.name);
              return (
                <div
                  key={col.name} role="listitem" data-selected={lit ? "" : undefined}
                  className={cn(
                    "mx-1 flex h-6 items-center gap-[5px] rounded-[5px] pr-1.5 pl-0.5 text-xs whitespace-nowrap text-text-2 select-none can-hover:hover:bg-surface-hover",
                    sheet && "relative mx-1.5 h-11 pl-0 text-sm",
                    lit && "bg-accent-wash text-text can-hover:hover:bg-accent-wash",
                  )}
                >
                  <label className={cn("grid shrink-0 cursor-pointer place-items-center", sheet ? "relative z-10 size-11" : "size-[22px]")}>
                    <input
                      type="checkbox" checked={shown} onChange={(e) => setHidden(col.name, !e.target.checked)}
                      aria-label={`Show ${col.name} in the grid`}
                      className={cn("cursor-pointer accent-primary", sheet ? "size-5" : "size-3.5")}
                    />
                  </label>
                  <ColumnIcon col={col} className={iconClass} />
                  <button
                    type="button" onClick={() => onJump(col.name)}
                    title={`${col.nullable ? "" : "NOT NULL · "}${shown ? "Go to it in the grid" : "Hidden in the grid"}`}
                    className={cn(
                      "min-w-0 shrink truncate text-left",
                      // On a phone the whole row goes to the column, bar the checkbox and the table link
                      // above it: the name alone is as narrow as its word, 12px for an `id`.
                      sheet && "self-stretch after:absolute after:inset-0",
                      !shown ? "text-text-3" : !col.nullable && "font-semibold text-text",
                    )}
                  >
                    <Highlight text={col.name} query={query} />
                  </button>
                  {col.fk && onOpenTable ? (
                    <button
                      type="button" onClick={() => onOpenTable(col.fk!.table)} title={`Open ${col.fk.table} in a new tab`}
                      className={cn(
                        "inline-flex shrink-0 items-center gap-0.5 rounded px-0.5 text-[11.5px] text-primary can-hover:hover:underline",
                        sheet && "relative z-10 h-11 px-2 text-[13px]",
                      )}
                    >
                      <ArrowRight className="size-3" aria-hidden />{col.fk.table}
                    </button>
                  ) : (
                    <span className="min-w-0 shrink truncate pl-0.5 font-mono text-[10.5px] text-text-3">{col.type}</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** ← and → on the edge: one step. */
const KEY_STEP = 16;

/**
 * The panel itself: docked left of the grid with a draggable edge, or — in a narrow tab — floating
 * over it. `children` are its sections.
 */
export function TableSidePanel({ width, onWidthChange, floating, onClose, children }: {
  width: number;
  /** The edge was dragged or moved by keys; called once a drag ends, so the tab keeps one width. */
  onWidthChange: (width: number) => void;
  floating: boolean;
  /** Esc, while it floats. */
  onClose: () => void;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const start = useRef<{ x: number; width: number } | null>(null);
  const shown = dragging ?? width;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(width);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    setDragging(clampPanelWidth(start.current.width + e.clientX - start.current.x));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const next = clampPanelWidth(start.current.width + e.clientX - start.current.x);
    start.current = null;
    setDragging(null);
    if (next !== width) onWidthChange(next);
  };
  const onSplitKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = e.key === "Home" ? PANEL_WIDTH.min : e.key === "End" ? PANEL_WIDTH.max : clampPanelWidth(width + step);
    if (next !== width) onWidthChange(next);
  };

  return (
    <>
      <aside
        aria-label="Columns and filters" data-table-panel
        onKeyDown={(e) => {
          if (!floating || e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        style={{ width: floating ? `min(${shown}px, 86%)` : shown }}
        className={cn(
          "flex shrink-0 flex-col overflow-hidden border-r border-border bg-panel",
          floating && "absolute inset-y-0 left-0 z-30 shadow-[14px_0_34px_-14px_rgb(0_0_0/0.45)]",
        )}
      >
        {children}
      </aside>
      {!floating && (
        <div
          role="separator" aria-orientation="vertical" aria-label="Resize the left panel" tabIndex={0}
          aria-valuemin={PANEL_WIDTH.min} aria-valuemax={PANEL_WIDTH.max} aria-valuenow={shown}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
          onKeyDown={onSplitKey}
          className={cn(
            "relative z-10 -mr-1 -ml-[3px] w-[7px] shrink-0 cursor-col-resize touch-none outline-none",
            "before:absolute before:inset-y-0 before:left-[3px] before:w-px before:bg-transparent",
            "can-hover:hover:before:bg-primary focus-visible:before:bg-primary",
            dragging !== null && "before:bg-primary",
          )}
        />
      )}
    </>
  );
}
