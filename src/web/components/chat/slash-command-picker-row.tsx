/**
 * One row of the `/` picker: a tinted tile for the item's type, `/name` with the typed match
 * marked, the argument hint, a one-line description (two lines on the selected row) and the
 * scope as a small outlined tag.
 */
import { Bot, Sparkles, SquareTerminal, Zap } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { SlashItem } from "./slash-command-picker";
import { HighlightMatch, HIDE_WHEN_NARROW_OR_TOUCH } from "./composer-picker-parts";

const TILE: Record<SlashItem["type"], { Icon: typeof Bot; className: string }> = {
  skill: { Icon: Sparkles, className: "bg-accent-2/15 text-accent-2" },
  agent: { Icon: Bot, className: "bg-info/15 text-info" },
  command: { Icon: SquareTerminal, className: "bg-surface-hover text-text-2" },
  builtin: { Icon: Zap, className: "bg-success/15 text-success" },
};

/** Where the item comes from: Global, Project or PPM — or Codex for a `$` skill. */
export function slashScopeLabel(item: SlashItem): string {
  if (item.invokeSigil === "$") return "Codex";
  if (item.scope === "bundled") return "PPM";
  if (item.scope === "user") return "Global";
  if (item.scope === "project") return "Project";
  return item.type === "builtin" ? "Built-in" : item.type.charAt(0).toUpperCase() + item.type.slice(1);
}

export function SlashCommandPickerRow({ item, index, selected, query, onHover, onPick }: {
  item: SlashItem;
  index: number;
  selected: boolean;
  /** The typed filter, marked where it appears in the name. */
  query: string;
  onHover: () => void;
  onPick: () => void;
}) {
  const tile = TILE[item.type] ?? TILE.command;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-picker-index={index}
      className={cn(
        "grid min-h-11 w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
        selected ? "bg-accent-wash" : "can-hover:hover:bg-surface-hover",
      )}
      onMouseEnter={onHover}
      onClick={onPick}
    >
      <span className={cn("grid size-6 place-items-center rounded-[7px]", tile.className)}>
        {item.iconDataUri ? (
          // The runtime shipped its own artwork (codex system skills).
          // Decorative: the name beside it already labels the row.
          <img src={item.iconDataUri} alt="" className="size-4 object-contain" />
        ) : (
          <tile.Icon className="size-3.5" />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="flex min-w-0 items-baseline gap-2">
          {/* Invocation string, shown with the sigil that will actually be sent — codex
              resolves its skills from `$name`, not `/name`. */}
          <span className="min-w-0 truncate text-[13px] font-medium text-text">
            {item.invokeSigil ?? "/"}<HighlightMatch text={item.name} query={query} />
          </span>
          {item.displayName && item.displayName !== item.name && (
            <span className="min-w-0 shrink truncate text-xs text-text-2">{item.displayName}</span>
          )}
          {item.argumentHint && (
            <span className={cn("min-w-0 shrink truncate font-mono text-[11px] text-text-3", HIDE_WHEN_NARROW_OR_TOUCH)}>
              {item.argumentHint}
            </span>
          )}
        </span>
        {item.description && (
          <span
            className={cn(
              "text-xs",
              selected ? "line-clamp-2 break-words text-text-2" : "truncate text-text-3",
            )}
          >
            {item.description}
          </span>
        )}
      </span>
      <span className="mt-[3px] self-start rounded-full border border-border-soft px-[7px] py-px text-[10px] font-medium whitespace-nowrap text-text-3">
        {slashScopeLabel(item)}
      </span>
    </button>
  );
}
