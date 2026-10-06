/**
 * The Database sidebar's menus, written once as data and drawn two ways: a row's menu inside the
 * section's adaptive context menu (right-click on a desktop, long-press into a bottom sheet on a
 * phone), and a toolbar button's menu as a dropdown on a desktop and a bottom sheet on a phone.
 */
import { useState, type ElementType, type ReactNode } from "react";
import { Check } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/adaptive-context-menu";

export type MenuEntry =
  | {
    kind: "item"; label: string; icon?: ElementType; onSelect: () => void;
    disabled?: boolean; destructive?: boolean;
    /** Said beside the label, dimmed: why it is disabled, or what it leaves alone. */
    hint?: string;
  }
  | { kind: "check"; label: string; checked: boolean; onToggle: () => void; disabled?: boolean }
  | { kind: "radio"; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }
  | { kind: "label"; label: string }
  | { kind: "separator" };

/** Separators only between entries: none leading, trailing or doubled after a condition dropped an entry. */
export function tidyMenu(entries: readonly (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e.kind === "separator" && (out.length === 0 || out.at(-1)!.kind === "separator")) continue;
    out.push(e);
  }
  while (out.at(-1)?.kind === "separator") out.pop();
  return out;
}

const hintClass = "ml-auto pl-3 text-xs text-text-subtle";

/** A row's menu, inside the section's `ContextMenu` from `@/components/ui/adaptive-context-menu`. */
export function RowMenuContent({ entries, className }: { entries: readonly MenuEntry[]; className?: string }) {
  return (
    <ContextMenuContent className={cn("min-w-52", className)}>
      {entries.map((e, i) => {
        if (e.kind === "separator") return <ContextMenuSeparator key={`sep-${i}`} />;
        if (e.kind === "label") return <div key={`label-${i}`} className="px-2 py-1.5 text-xs text-text-subtle select-none">{e.label}</div>;
        if (e.kind === "radio") return null; // not used in row menus
        if (e.kind === "check") {
          return (
            <ContextMenuItem key={e.label} disabled={e.disabled} onClick={e.onToggle} role="menuitemcheckbox" aria-checked={e.checked}>
              <span className="flex size-4 items-center justify-center">{e.checked && <Check className="size-4" />}</span>
              {e.label}
            </ContextMenuItem>
          );
        }
        const Icon = e.icon;
        return (
          <ContextMenuItem key={e.label} disabled={e.disabled} variant={e.destructive ? "destructive" : "default"} onClick={e.onSelect}>
            {Icon ? <Icon className="size-4" /> : <span className="size-4" />}
            {e.label}
            {e.hint && <span className={hintClass}>{e.hint}</span>}
          </ContextMenuItem>
        );
      })}
    </ContextMenuContent>
  );
}

interface ToolbarMenuProps {
  /** The button's tooltip and accessible name. */
  title: string;
  icon: ElementType;
  entries: readonly MenuEntry[];
  /** Drawn as switched on: a filter narrowing what is shown. */
  active?: boolean;
  className?: string;
  /** Where focus goes when the dropdown closes, for a button that an item makes disappear. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * A toolbar button with a menu: a dropdown on a desktop, a bottom sheet of 44px rows on a phone.
 * A check or a radio leaves the menu open, since those are picked several at a time.
 */
export function ToolbarMenu({ title, icon: Icon, entries, active, className, onCloseAutoFocus }: ToolbarMenuProps) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const button = (props: { onClick?: () => void }) => (
    <button type="button" title={title} aria-label={title} aria-pressed={active ? true : undefined}
      className={cn(className, active && "bg-accent-wash text-primary")} {...props}>
      <Icon className="size-4" />
    </button>
  );

  if (isMobile) {
    return (
      <>
        {button({ onClick: () => setSheetOpen(true) })}
        <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
          <SheetEntries entries={entries} close={() => setSheetOpen(false)} />
        </BottomSheet>
      </>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button({})}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56" onCloseAutoFocus={onCloseAutoFocus}>
        {entries.map((e, i) => {
          if (e.kind === "separator") return <DropdownMenuSeparator key={`sep-${i}`} />;
          if (e.kind === "label") return <DropdownMenuLabel key={`label-${i}`} className="text-xs font-normal text-text-subtle">{e.label}</DropdownMenuLabel>;
          if (e.kind === "check") {
            return (
              <DropdownMenuCheckboxItem key={e.label} checked={e.checked} disabled={e.disabled}
                onSelect={(ev) => ev.preventDefault()} onCheckedChange={() => e.onToggle()}>
                {e.label}
              </DropdownMenuCheckboxItem>
            );
          }
          if (e.kind === "radio") {
            return (
              <DropdownMenuRadioGroup key={`radio-${i}`} value={e.value} onValueChange={e.onChange}>
                {e.options.map((o) => (
                  <DropdownMenuRadioItem key={o.value} value={o.value} onSelect={(ev) => ev.preventDefault()}>{o.label}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            );
          }
          const ItemIcon = e.icon;
          return (
            <DropdownMenuItem key={e.label} disabled={e.disabled} variant={e.destructive ? "destructive" : "default"} onSelect={() => e.onSelect()}>
              {ItemIcon ? <ItemIcon className="size-4" /> : <span className="size-4" />}
              {e.label}
              {e.hint && <span className={hintClass}>{e.hint}</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SheetRow({ children, onClick, disabled, destructive, checked }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean; checked?: boolean;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      role={checked === undefined ? undefined : "menuitemcheckbox"} aria-checked={checked}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm select-none active:bg-accent disabled:opacity-50",
        destructive && "text-destructive",
      )}>
      {children}
    </button>
  );
}

function SheetEntries({ entries, close }: { entries: readonly MenuEntry[]; close: () => void }) {
  return (
    <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto px-2 pb-2">
      {entries.map((e, i) => {
        if (e.kind === "separator") return <div key={`sep-${i}`} className="my-1 h-px bg-border" />;
        if (e.kind === "label") return <p key={`label-${i}`} className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">{e.label}</p>;
        if (e.kind === "check") {
          return (
            <SheetRow key={e.label} checked={e.checked} disabled={e.disabled} onClick={e.onToggle}>
              <span className="flex size-5 items-center justify-center">{e.checked && <Check className="size-5" />}</span>{e.label}
            </SheetRow>
          );
        }
        if (e.kind === "radio") {
          return e.options.map((o) => (
            <SheetRow key={o.value} checked={e.value === o.value} onClick={() => e.onChange(o.value)}>
              <span className="flex size-5 items-center justify-center">{e.value === o.value && <Check className="size-5" />}</span>{o.label}
            </SheetRow>
          ));
        }
        const Icon = e.icon;
        return (
          <SheetRow key={e.label} disabled={e.disabled} destructive={e.destructive} onClick={() => { close(); e.onSelect(); }}>
            {Icon ? <Icon className="size-5 text-text-subtle" /> : <span className="size-5" />}
            <span className="flex-1">{e.label}</span>
            {e.hint && <span className="text-xs text-text-subtle">{e.hint}</span>}
          </SheetRow>
        );
      })}
    </div>
  );
}
