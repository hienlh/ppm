/**
 * The cell menu (grid/cell-menu.ts), drawn where it was asked for: DBGate's menu at the pointer on a
 * desktop; on a phone a bottom sheet of 44px rows, whose submenus open in its place with Back.
 *
 * Not `adaptive-context-menu`: that one is opened by its own trigger, and this menu's trigger is a
 * cell drawn on Glide's canvas, opened at the point Glide reports. It is drawn from the same parts —
 * Radix's menu, PPM's bottom sheet.
 *
 * The desktop menu is Radix's dropdown anchored on a point, and **not modal**: a modal menu traps
 * focus, and the copy fallback a plain-HTTP origin needs selects the text in a textarea of its own,
 * so trapped focus pulls the selection away and nothing is copied.
 */
import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { formatCombo } from "@/stores/keybindings-store";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuShortcut,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CellMenuEntry } from "./cell-menu";

interface CellContextMenuProps {
  entries: readonly CellMenuEntry[];
  /** Where it was asked for, in the viewport. */
  position: { x: number; y: number };
  mobile: boolean;
  /** A phone's sheet says what it is for: the table and column, then the row. */
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** The grid's keys back, once the menu has gone — unless an item gave them to something else. */
  returnFocus: () => void;
}

const ITEM = "gap-2 py-1 text-xs";

function DesktopEntries({ entries }: { entries: readonly CellMenuEntry[] }) {
  return entries.map((e, i) => {
    if (e.kind === "separator") return <DropdownMenuSeparator key={`sep-${i}`} />;
    const Icon = e.icon;
    const icon = Icon ? <Icon className="size-3.5" /> : <span className="size-3.5 shrink-0" aria-hidden />;
    if (e.kind === "submenu") {
      return (
        <DropdownMenuSub key={e.label}>
          <DropdownMenuSubTrigger className={ITEM}>{icon}<span className="flex-1">{e.label}</span></DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) min-w-52 overflow-y-auto">
              <DesktopEntries entries={e.entries} />
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      );
    }
    return (
      <DropdownMenuItem
        key={e.label} disabled={e.disabled} variant={e.destructive ? "destructive" : "default"} onSelect={e.onSelect}
        className={cn(ITEM, e.accent && "text-primary focus:text-primary")}
      >
        {icon}
        <span className="flex-1">{e.label}</span>
        {e.hint && <DropdownMenuShortcut className="pl-4 text-[10.5px] tracking-normal">{formatCombo(e.hint)}</DropdownMenuShortcut>}
      </DropdownMenuItem>
    );
  });
}

export function CellContextMenu({ entries, position, mobile, title, subtitle, onClose, returnFocus }: CellContextMenuProps) {
  if (mobile) return <CellMenuSheet entries={entries} title={title} subtitle={subtitle} onClose={onClose} />;
  return (
    <DropdownMenu open modal={false} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DropdownMenuTrigger asChild>
        {/* Stands at the point asked for, so the menu opens there. */}
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: position.x, top: position.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start" sideOffset={2} className="min-w-56" aria-label="Cell menu" data-cell-menu=""
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          // Find column puts the cursor in the panel's search box: that is where the keys go then.
          if (!document.activeElement || document.activeElement === document.body) returnFocus();
        }}
      >
        <DesktopEntries entries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CellMenuSheet({ entries, title, subtitle, onClose }: Pick<CellContextMenuProps, "entries" | "title" | "subtitle" | "onClose">) {
  // The submenu open in the sheet's place.
  const [sub, setSub] = useState<Extract<CellMenuEntry, { kind: "submenu" }> | null>(null);
  const shown = sub ? sub.entries : entries;
  return (
    <BottomSheet open onClose={onClose} className="popover-solid">
      <div className="min-w-0 px-4 pb-1">
        <p className="truncate text-[15px] font-semibold">{sub ? sub.label : title}</p>
        <p className="truncate text-xs text-text-3">{sub ? title : subtitle}</p>
      </div>
      <div
        role="menu" aria-label={sub ? sub.label : "Cell menu"} data-cell-menu=""
        className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      >
        {sub && (
          <>
            <SheetRow onClick={() => setSub(null)}>
              <ChevronLeft className="size-5 text-text-subtle" aria-hidden /><span className="flex-1">Back</span>
            </SheetRow>
            <div role="separator" className="my-1 h-px bg-border" />
          </>
        )}
        {shown.map((e, i) => {
          if (e.kind === "separator") return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />;
          const Icon = e.icon;
          const icon = Icon ? <Icon className="size-5 text-text-subtle" aria-hidden /> : <span className="size-5 shrink-0" aria-hidden />;
          if (e.kind === "submenu") {
            return (
              <SheetRow key={e.label} onClick={() => setSub(e)} haspopup>
                {icon}<span className="flex-1">{e.label}</span><ChevronRight className="size-4 text-text-subtle" aria-hidden />
              </SheetRow>
            );
          }
          return (
            // The sheet goes first: what the item opens — a sheet, a dialog — must not open under it.
            <SheetRow key={e.label} disabled={e.disabled} destructive={e.destructive} accent={e.accent} onClick={() => { onClose(); e.onSelect(); }}>
              {icon}<span className="flex-1">{e.label}</span>
            </SheetRow>
          );
        })}
      </div>
    </BottomSheet>
  );
}

function SheetRow({ children, onClick, disabled, destructive, accent, haspopup }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean; accent?: boolean; haspopup?: boolean;
}) {
  return (
    <button
      type="button" role="menuitem" disabled={disabled} onClick={onClick} aria-haspopup={haspopup ? "menu" : undefined}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm select-none active:bg-accent disabled:opacity-50",
        destructive && "text-destructive",
        accent && "text-primary",
      )}
    >
      {children}
    </button>
  );
}
