/**
 * The pieces both sections of the Database sidebar are drawn from: the section header that
 * collapses it, the search box, the toolbar's icon buttons, a tree row's frame and the highlight
 * of what a search matched. Sized for a mouse above `md` and for a finger (44px) below it.
 */
import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { ChevronDown, Search, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { highlightParts } from "./explorer-model";

export const toolbarButtonClass =
  "flex size-[26px] shrink-0 items-center justify-center rounded text-text-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-40 max-md:size-11";

export function SectionHeader({ title, collapsed, onToggle, children }: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Shown at the header's end, e.g. the current database. */
  children?: ReactNode;
}) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={!collapsed}
      className="flex h-[30px] w-full shrink-0 items-center gap-1.5 pr-2.5 pl-2 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-text-secondary uppercase hover:bg-surface-hover hover:text-foreground max-md:h-11 max-md:pr-3.5 max-md:pl-3 max-md:text-xs">
      <ChevronDown className={cn("size-3 shrink-0 text-text-subtle transition-transform max-md:size-3.5", collapsed && "-rotate-90")} />
      {/* The title gives way first: what follows it — the current database — is the part that changes. */}
      <span className="min-w-0 truncate">{title}</span>
      {children}
    </button>
  );
}

export function SearchBox({ value, onChange, placeholder, inputRef }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[5px] border border-border bg-input pr-[3px] pl-2 text-xs text-text-subtle focus-within:border-primary max-md:h-11 max-md:text-sm">
      <Search className="size-3.5 shrink-0" />
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        autoComplete="off" spellCheck={false}
        className="h-full min-w-0 flex-1 border-0 bg-transparent text-foreground outline-none placeholder:text-text-subtle" />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label="Clear search" title="Clear search"
          className="flex size-[22px] shrink-0 items-center justify-center rounded text-text-subtle hover:bg-surface-hover hover:text-foreground max-md:-mr-[3px] max-md:h-[42px] max-md:w-11">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** A search match marked in `text`; `text` as it is when the search did not look at it or found nothing there. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query);
  if (!parts) return <>{text}</>;
  return <>{parts[0]}<mark className="rounded-[2px] bg-warning/35 text-inherit">{parts[1]}</mark>{parts[2]}</>;
}

interface TreeRowProps extends HTMLAttributes<HTMLDivElement> {
  rowKey: string;
  depth: number;
  /** The row the list's own state picks: DBGate's focused connection, the table last opened. */
  selected?: boolean;
  /** Where the keyboard is. */
  cursor?: boolean;
  /** Lit for a moment: the connection just saved from its tab. */
  flash?: boolean;
  level: number;
  expanded?: boolean;
}

/** One row of a tree: indented by depth, 26px (44px on a phone), text never selected by a long press. */
export const TreeRow = forwardRef<HTMLDivElement, TreeRowProps>(function TreeRow(
  { rowKey, depth, selected, cursor, flash, level, expanded, className, style, children, ...rest }, ref,
) {
  return (
    <div ref={ref} role="treeitem" aria-level={level} aria-expanded={expanded} aria-selected={selected ?? false}
      data-row-key={rowKey} data-cursor={cursor ? "" : undefined} data-flash={flash ? "edit" : undefined}
      style={{ "--d": depth, ...style } as CSSProperties}
      className={cn(
        "mx-1 flex h-[26px] cursor-pointer items-center gap-[5px] rounded-[5px] pr-1.5 pl-[calc(2px+var(--d)*16px)] text-[13px] whitespace-nowrap text-text-secondary select-none",
        "can-hover:hover:bg-surface-hover can-hover:hover:text-foreground",
        "max-md:mx-1.5 max-md:h-11 max-md:gap-[7px] max-md:pl-[calc(6px+var(--d)*18px)] max-md:text-sm",
        selected && "bg-accent-wash text-foreground can-hover:hover:bg-accent-wash",
        cursor && "group-focus-visible/tree:ring-1 group-focus-visible/tree:ring-primary group-focus-visible/tree:ring-inset",
        className,
      )}
      {...rest}>
      {children}
    </div>
  );
});

/** The trailing, dimmed part of a row: an engine's name, a count, a type. */
export function RowTail({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("ml-auto shrink-0 pl-1.5 text-[11px] text-text-subtle tabular-nums max-md:text-xs", className)}>
      {children}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="mx-3.5 my-2.5 grid justify-items-start gap-1.5 text-xs text-text-subtle max-md:text-sm">{children}</div>;
}

export const linkButtonClass = "text-primary underline-offset-2 hover:underline max-md:min-h-11";
