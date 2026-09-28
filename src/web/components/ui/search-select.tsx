/**
 * A select whose list can be searched: a trigger showing the current choice,
 * and a panel with a filter box over the options.
 *
 * It exists because the lists it serves are the case a native `<select>` or a
 * plain menu handles worst — dozens to hundreds of names that agree for most of
 * their length (`fix/NX-1234-…` branches, `nxsys-backend-nx5833` checkouts), where
 * the only way to the one you want is reading past the ones you do not. The shape
 * is the checkout quick pick's, and it shares that picker's keyboard arithmetic
 * (`moveSelection`) and its selection tint.
 *
 * A Radix popover rather than a panel positioned by hand, because the surfaces
 * that mount it are `overflow-hidden`: a dropdown anchored inside one is clipped at
 * its bottom edge, which shows as a list a few rows tall with no scrollbar and no
 * sign that anything was cut. The portal escapes that, and collision detection
 * keeps it on screen when the panel is docked low in the window. Below `md` it is
 * a bottom sheet instead, per the mobile rules.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ElementType } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, Search } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { usePortalContainer } from "@/components/ui/portal-container-context";
import { StartEllipsis } from "@/components/ui/start-ellipsis";
import { firstSelectable, moveSelection } from "@/lib/git-ref-picker";
import { rowIndexOf, searchRows, type SearchSelectItem } from "@/lib/search-select-rows";

export interface SearchSelectProps {
  value: string;
  items: SearchSelectItem[];
  onChange: (value: string) => void;
  /** Names the control for screen readers, and titles the sheet on mobile. */
  label: string;
  /** The filter box's placeholder — "Search branches". */
  searchPlaceholder: string;
  /** What an empty result says — "No matching branches". */
  emptyText: string;
  /** Leading icon on the trigger, if the surroundings do not already carry one. */
  icon?: ElementType;
  /** Trigger text while `value` names none of the items. */
  placeholder?: string;
  testId?: string;
  /** Width and look, from the caller — the trigger shares a row with everything else. */
  className?: string;
  /**
   * Set this inside a Radix dialog, and only there.
   *
   * A modal dialog traps focus, and the popover is portalled outside it: the
   * dialog's focus scope sees focus land on an element it does not contain and
   * pulls it straight back, so the filter box cannot be typed in at all. A
   * modal popover has a trapped scope of its own, which pushes onto Radix's
   * scope stack and pauses the dialog's — the one arrangement where both
   * behave. It costs a scroll lock and `aria-hidden` on everything behind,
   * which is why it is not the default out in a panel.
   */
  modal?: boolean;
}

export function SearchSelect({
  value, items, onChange, label, searchPlaceholder, emptyText, icon: Icon, placeholder,
  testId, className, modal,
}: SearchSelectProps) {
  const isMobile = useIsMobile();
  const portalContainer = usePortalContainer();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => searchRows(items, query), [items, query]);
  const current = items.find((i) => i.value === value);

  /*
   * Highlight the choice already in force when it survives the filter, and the
   * first match otherwise. Opening on row zero instead would put Enter on an
   * option nobody asked for, and on a list this long it hides where you
   * currently are behind several screens of scrolling.
   */
  useEffect(() => {
    const at = rowIndexOf(rows, value);
    setSelected(at >= 0 ? at : firstSelectable(rows));
  }, [rows, value]);

  // A filter is a question about this opening, not a setting.
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [open, selected]);

  const pick = useCallback((next: string) => {
    onChange(next);
    setOpen(false);
  }, [onChange]);

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((i) => moveSelection(rows, i, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((i) => moveSelection(rows, i, -1));
        break;
      case "Enter": {
        e.preventDefault();
        const row = rows[selected];
        if (row?.kind === "item") pick(row.item.value);
        break;
      }
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
    }
  }

  const body = (
    <>
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2 shrink-0">
        <Search className="size-4 shrink-0 text-text-subtle" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={`Search ${label.toLowerCase()}`}
          className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle"
        />
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        className="min-h-0 flex-1 overflow-y-auto py-1"
        data-testid={testId && `${testId}-list`}
      >
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-text-subtle">{emptyText}</p>
        ) : (
          rows.map((row, i) =>
            row.kind === "separator" ? (
              <div
                key={`sep-${row.label}`}
                className="border-t border-border-soft px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-text-3 first:border-t-0 first:pt-1"
              >
                {row.label}
              </div>
            ) : (
              <OptionRow
                key={row.item.value}
                item={row.item}
                active={i === selected}
                picked={row.item.value === value}
                mobile={isMobile}
                onPick={() => pick(row.item.value)}
                onHover={() => setSelected(i)}
              />
            ),
          )
        )}
      </div>
    </>
  );

  const trigger = (
    <button
      type="button"
      aria-expanded={open}
      // A panel with a filter box in it, not a bare list — and `combobox` would
      // be a promise this button cannot keep, since the text input it would
      // have to own does not exist until the panel is open. Radix says the same
      // thing on the desktop trigger; this is for the sheet, which has no Radix
      // under it.
      aria-haspopup="dialog"
      aria-label={label}
      title={current?.title ?? current?.label ?? value}
      data-testid={testId}
      onClick={isMobile ? () => setOpen(true) : undefined}
      // h-10 under a finger: the rows this sits in are compact by design on a
      // desktop, but the trigger is the one thing in them anyone taps.
      className={cn(
        "flex h-10 items-center gap-1 rounded-md border border-border bg-panel px-2 text-xs text-text-primary min-w-0 md:h-7",
        className,
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0 text-text-3" />}
      <StartEllipsis>{current?.label ?? (value || placeholder || "")}</StartEllipsis>
      <ChevronDown className="size-3.5 shrink-0 text-text-3" />
    </button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        {/*
          No autofocus here, deliberately: the keyboard would cover most of the
          sheet before the list has been seen once, and the filter box is one
          tap away at the top of it.
        */}
        <BottomSheet open={open} onClose={() => setOpen(false)} className="popover-solid flex max-h-[80dvh] flex-col">
          <div className="shrink-0 px-3 pb-1 text-xs font-medium text-text-2">{label}</div>
          <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>{body}</div>
        </BottomSheet>
      </>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={modal}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onKeyDown={handleKeyDown}
          // Radix focuses the first focusable child, which is already the filter
          // box; saying so explicitly keeps it true if a control is ever added
          // above it.
          onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
          // `popover-solid`, or the glass themes render the list over whatever
          // is behind the panel.
          className="popover-solid z-50 flex w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-md border border-border text-popover-foreground shadow-lg max-h-[min(20rem,var(--radix-popover-content-available-height))]"
        >
          {body}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * One option.
 *
 * The active tint is `primary/15` rather than shadcn's `accent`, for the reason
 * spelled out in `branch-picker.tsx`: `accent` is a hover *surface* in this app
 * and composites to a contrast ratio of about 1.01 over the panel it sits on,
 * i.e. a keyboard selection nobody can see.
 */
function OptionRow({ item, active, picked, mobile, onPick, onHover }: {
  item: SearchSelectItem;
  active: boolean;
  picked: boolean;
  mobile: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      role="option"
      aria-selected={picked}
      data-active={active || undefined}
      data-value={item.value}
      title={item.title}
      onClick={onPick}
      onMouseEnter={onHover}
      className={cn(
        "flex w-full items-center gap-2 px-3 text-left text-sm",
        mobile ? "min-h-11 py-2" : "py-1",
        active ? "bg-primary/15 text-text-primary" : "text-text-2",
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0 text-text-3" />}
      <StartEllipsis>{item.label}</StartEllipsis>
      {item.hint && <span className="shrink-0 text-[10px] text-text-3">{item.hint}</span>}
      {picked && <Check className="size-3.5 shrink-0 text-primary" />}
    </button>
  );
}
