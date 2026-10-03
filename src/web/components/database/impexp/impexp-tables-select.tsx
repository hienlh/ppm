/**
 * DBGate's Tables / views box: the chosen ones as chips, a list under it that typing narrows, and
 * a click or Enter adds the one picked; Backspace in the empty box takes the last chip off. Under
 * it, All tables / All views / All matviews add every one of a kind — each button there only when
 * the database has one of that kind — after those already chosen, and Remove all empties it.
 *
 * A Radix popover holds the list, because the column it sits in scrolls: a list positioned inside
 * it would be clipped at its edge.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Popover } from "radix-ui";
import { X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { usePortalContainer } from "@/components/ui/portal-container-context";
import type { DbObject, DbObjectKind } from "../../../../shared/db-structure";
import { formButtonClass } from "./impexp-parts";

/** Options listed at once; past this, typing narrows the list. */
const MAX_LISTED = 300;

const KIND_BUTTONS: { kind: DbObjectKind; label: string }[] = [
  { kind: "table", label: "All tables" },
  { kind: "view", label: "All views" },
  { kind: "matview", label: "All matviews" },
];

export function TablesSelect({ relations, value, loading, onChange, onAdd }: {
  relations: readonly DbObject[];
  value: readonly string[];
  /** The list is being read. */
  loading: boolean;
  onChange: (names: string[]) => void;
  /** Adds these after the chosen ones. */
  onAdd: (names: string[]) => void;
}) {
  const id = useId();
  const container = usePortalContainer();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const options = useMemo(() => {
    const chosen = new Set(value);
    const needle = query.trim().toLowerCase();
    return relations.filter((r) => !chosen.has(r.name) && (!needle || r.name.toLowerCase().includes(needle)));
  }, [relations, value, query]);
  const listed = options.slice(0, MAX_LISTED);

  const add = (name: string) => {
    onChange([...value, name]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  };
  const remove = (name: string) => onChange(value.filter((v) => v !== name));

  const move = (by: number) => {
    if (listed.length === 0) return;
    const next = (active + by + listed.length) % listed.length;
    setActive(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      else move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      const pick = open ? listed[active] : undefined;
      if (pick) {
        e.preventDefault();
        add(pick.name);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Backspace" && !query && value.length > 0) {
      remove(value[value.length - 1]!);
    }
  };

  const kinds = new Set(relations.map((r) => r.kind));
  return (
    <div className="grid min-w-0 gap-[5px]">
      <label htmlFor={`${id}-input`} className="text-xs font-medium text-text-2">Tables / views</label>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div
            ref={boxRef}
            onMouseDown={(e) => {
              if (e.target === inputRef.current) return;
              e.preventDefault();
              inputRef.current?.focus();
              setOpen(true);
            }}
            className="flex max-h-[132px] min-h-[30px] w-full min-w-0 cursor-text flex-wrap content-start items-center gap-1 overflow-y-auto rounded-md border border-border bg-surface px-1.5 py-[3px] focus-within:border-ring"
          >
            {value.map((name) => (
              <span key={name} className="flex h-[22px] max-w-full min-w-0 items-center gap-0.5 rounded bg-surface-hover pr-0.5 pl-1.5 text-xs text-text-primary">
                <span className="truncate" title={name}>{name}</span>
                <button
                  type="button" aria-label={`Remove ${name}`} title={`Remove ${name}`}
                  onMouseDown={(e) => e.stopPropagation()} onClick={() => remove(name)}
                  className="grid size-[18px] shrink-0 place-items-center rounded text-text-subtle can-hover:hover:bg-surface-hover can-hover:hover:text-text-primary"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              ref={inputRef} id={`${id}-input`} value={query} autoComplete="off" spellCheck={false}
              role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
              aria-activedescendant={open && listed[active] ? `${id}-option-${active}` : undefined}
              placeholder={value.length ? "" : "Choose tables or views"}
              onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              className="h-[22px] min-w-[90px] flex-1 border-0 bg-transparent px-1 text-xs text-text-primary outline-none placeholder:text-text-subtle"
            />
          </div>
        </Popover.Anchor>
        <Popover.Portal container={container}>
          <Popover.Content
            align="start" sideOffset={3} collisionPadding={8}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            // The box it hangs from is outside it, and is where the typing happens.
            onInteractOutside={(e) => { if (boxRef.current?.contains(e.target as Node)) e.preventDefault(); }}
            className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[220px] rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-md"
          >
            <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Tables and views" aria-multiselectable className="max-h-[260px] overflow-y-auto">
              {listed.map((r, i) => (
                <div
                  key={`${r.kind}:${r.name}`} id={`${id}-option-${i}`} data-index={i} role="option" aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => add(r.name)}
                  className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1", i === active && "bg-surface-hover")}
                >
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {r.kind !== "table" && <span className="shrink-0 text-[11px] text-text-subtle">{r.kind === "view" ? "view" : "matview"}</span>}
                </div>
              ))}
              {listed.length === 0 && (
                <div className="px-2 py-1.5 text-text-subtle">
                  {loading ? "Reading the tables…" : relations.length === 0 ? "This database has no tables or views" : query.trim() ? `Nothing matches “${query.trim()}”` : "Every one is chosen"}
                </div>
              )}
              {options.length > listed.length && (
                <div className="px-2 py-1.5 text-text-subtle">{options.length - listed.length} more: type to narrow the list</div>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="flex flex-wrap gap-1.5">
        {KIND_BUTTONS.filter((b) => kinds.has(b.kind)).map((b) => (
          <button key={b.kind} type="button" className={formButtonClass} onClick={() => onAdd(relations.filter((r) => r.kind === b.kind).map((r) => r.name))}>
            {b.label}
          </button>
        ))}
        <button type="button" className={formButtonClass} disabled={value.length === 0} onClick={() => onChange([])}>Remove all</button>
      </div>
    </div>
  );
}
