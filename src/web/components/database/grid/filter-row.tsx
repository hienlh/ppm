/**
 * DBGate's filter cell: the text box under a column title in the filter row, and the same box in
 * the Filters panel. A filter is applied when it is committed — Enter, or focus leaving the box —
 * never on a keystroke; Esc clears it. While typing, the box is green when the text reads and
 * rose when it does not, and a rose box says where it went wrong. Pasting several lines filters
 * by all of them, as DBGate does.
 *
 * The buttons follow the text being typed: with none, ⋮ picks from the column's values — ⋯ on a
 * foreign key, which looks the values up in the table it references — and the funnel lists the
 * filters the column's type has; once there is text, only × is left, which clears it.
 */
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Filter, MoreHorizontal, MoreVertical, X } from "@/lib/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ToolbarMenu, type MenuEntry } from "../explorer/explorer-menu";
import { funnelItems, type FilterDialogRequest, type FunnelKind } from "./filter-funnel-menu";
import { linesFilter, type FilterState } from "./grid-filters";

export interface FilterCellProps {
  /** The text in force. */
  value: string;
  /** Switched off in the Filters panel: kept, not applied. */
  off?: boolean;
  /** How a text reads in this column — or, for the Multi column filter, in any column. */
  read: (text: string) => FilterState;
  /** Stores a text: on Enter, when focus leaves, on Esc (blank), on a paste of lines, on ×. */
  onCommit: (text: string) => void;
  /** Why the server refused the filter in force, shown until the text changes. */
  serverError?: string;
  label: string;
  /** ⋮ — absent on the Multi column filter, which has no one column to list. Its dialog hands focus back with `returnFocus`. */
  chooseValues?: { column: string; onOpen: (returnFocus: () => void) => void };
  /** ⋯ in place of ⋮, on a foreign key column. */
  lookup?: { table: string; onOpen: (returnFocus: () => void) => void };
  /** The funnel: the filters `kind` offers. A "..." item asks for a dialog, which hands focus back with `returnFocus`. */
  funnel?: { kind: FunnelKind; label: string; onDialog: (request: FilterDialogRequest, returnFocus: () => void) => void };
  /** ↓ leaves the box for the rows below it. */
  onArrowDown?: () => void;
  /** A taller box, for the Filters panel. */
  size?: "row" | "panel";
  className?: string;
}

/** A blank text has nothing to read; one that cannot be read keeps its own error. */
function displayState(draft: string, props: Pick<FilterCellProps, "value" | "off" | "read" | "serverError">): FilterState {
  if (draft !== props.value) return props.read(draft);
  if (props.serverError && draft.trim()) return { state: "bad", error: { message: props.serverError, start: 0, end: 0 } };
  const state = props.read(draft);
  return state.state === "ok" && props.off ? { state: "off" } : state;
}

// Focus is shown only where the box has no colour of its own: on a green or rose box the
// colour is what says whether the text reads, and it must not go while the text is edited.
const BOX_STATE: Record<FilterState["state"], string> = {
  empty: "focus:border-primary",
  ok: "border-success/55 bg-success/9 text-success",
  bad: "border-error/70 bg-error/9 text-error",
  off: "border-dashed text-text-3 line-through focus:border-primary",
};

export function FilterCell(props: FilterCellProps) {
  const { value, onCommit, label, chooseValues, lookup, funnel, onArrowDown, size = "row", className } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  // A commit here, in the Filters panel or from a dialog replaces what the box shows.
  useEffect(() => { setDraft(value); }, [value]);

  const shown = displayState(draft, props);
  const error = shown.state === "bad" ? shown.error : null;

  const commit = (text: string) => {
    setDraft(text);
    onCommit(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit(draft);
      // Put the caret on the part that does not read.
      if (error && error.end > error.start) e.currentTarget.setSelectionRange(error.start, error.end);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      commit("");
    } else if (e.key === "ArrowDown" && onArrowDown) {
      e.preventDefault();
      onArrowDown();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\n")) return;
    e.preventDefault();
    const filter = linesFilter("is", text);
    if (filter) commit(filter);
  };

  // × clears what is in force; without this, focus leaving the box would first apply the draft.
  const keepFocus = (e: MouseEvent) => e.preventDefault();

  const returnFocus = () => inputRef.current?.focus();
  const funnelEntries = (f: NonNullable<FilterCellProps["funnel"]>): MenuEntry[] =>
    funnelItems(f.kind).map((item) => item === "separator" ? { kind: "separator" } : {
      kind: "item",
      label: item.label,
      onSelect: () => ("text" in item.action ? commit(item.action.text) : f.onDialog(item.action.open, returnFocus)),
    });

  const button = "pointer-events-auto grid size-5 shrink-0 place-items-center rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text aria-expanded:bg-surface-hover aria-expanded:text-text";

  return (
    <Tooltip open={!!error && (focused || hovered)}>
      <TooltipTrigger asChild>
        <div
          className={cn("pointer-events-auto flex min-w-0 items-center gap-px", className)}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (draft !== value) onCommit(draft);
            }}
            placeholder="Filter"
            aria-label={label}
            aria-invalid={!!error}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className={cn(
              "w-full min-w-0 rounded-[5px] border border-border-soft bg-input px-1.5 font-mono text-[11.5px] text-text outline-none placeholder:text-text-3/70",
              size === "panel" ? "h-[26px]" : "h-[22px]",
              BOX_STATE[shown.state],
            )}
          />
          {draft ? (
            <button type="button" className={button} onMouseDown={keepFocus} onClick={() => commit("")} aria-label="Clear filter" title="Clear filter">
              <X className="size-3" />
            </button>
          ) : (
            <>
              {lookup ? (
                <button type="button" className={button} onClick={() => lookup.onOpen(returnFocus)} aria-label={`Lookup from ${lookup.table}`} title={`Lookup from ${lookup.table}`}>
                  <MoreHorizontal className="size-3" />
                </button>
              ) : chooseValues ? (
                <button type="button" className={button} onClick={() => chooseValues.onOpen(returnFocus)} aria-label={`Choose value from ${chooseValues.column}`} title={`Choose value from ${chooseValues.column}`}>
                  <MoreVertical className="size-3" />
                </button>
              ) : null}
              {funnel && (
                <ToolbarMenu
                  title={funnel.label}
                  icon={FunnelIcon}
                  entries={funnelEntries(funnel)}
                  className={button}
                  // An item that writes a filter takes this button away with the empty box; focus
                  // goes where the filter now is. A dialog an item opened has focus by now, and
                  // hands it back itself when it closes.
                  onCloseAutoFocus={(e) => {
                    e.preventDefault();
                    if (document.activeElement === document.body || !document.activeElement?.isConnected) returnFocus();
                  }}
                />
              )}
            </>
          )}
        </div>
      </TooltipTrigger>
      {error && (
        <TooltipContent side="bottom" align="start" sideOffset={4} className="max-w-[min(360px,90vw)] text-left">
          <FilterErrorText text={draft} error={error} />
        </TooltipContent>
      )}
    </Tooltip>
  );
}

/** The funnel at the filter row's size, where `ToolbarMenu` would draw its icon at `size-4`. */
function FunnelIcon() {
  return <Filter className="size-3" />;
}

/** The error, under the text with the part that does not read marked. */
function FilterErrorText({ text, error }: { text: string; error: { message: string; start: number; end: number } }) {
  const marked = error.end > error.start || error.start > 0;
  return (
    <div className="space-y-1">
      {marked && (
        <div className="whitespace-pre-wrap break-all font-mono">
          {text.slice(0, error.start)}
          {error.end > error.start ? (
            <span className="rounded-sm bg-error px-px text-white">{text.slice(error.start, error.end)}</span>
          ) : (
            <span className="inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-error" aria-hidden />
          )}
          {text.slice(error.end)}
        </div>
      )}
      <div>{error.message}</div>
    </div>
  );
}
