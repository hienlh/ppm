/**
 * DBGate's column menu, opened from ⌄ at the end of a column's title (`grid/column-menu.ts` says
 * which items it has). The ⌄ buttons are HTML laid over the canvas, one per column, so there is
 * one menu for all of them, anchored where the button that opened it is.
 */
import { ArrowDown, ArrowUp, Copy, ExternalLink, X } from "@/lib/icons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GridSort } from "../../../shared/db-grid";
import { columnMenuItems, type ColumnMenuItem } from "./grid/column-menu";

interface HeaderMenuProps {
  column: string;
  /** Where the ⌄ that opened the menu is, in the viewport. */
  bounds: { x: number; y: number; width: number; height: number };
  sort: readonly GridSort[];
  /** The table a foreign key column refers to. */
  fkTable?: string | null;
  onSortChange?: (sort: GridSort[]) => void;
  onCopyName: () => void;
  onOpenTable?: (table: string) => void;
  onClose: () => void;
}

const sortIcon = (item: Extract<ColumnMenuItem, { kind: "sort" }>) =>
  item.sort.length === 0 ? X : item.dir === "DESC" ? ArrowDown : ArrowUp;

export function GlideHeaderMenu({ column, bounds, sort, fkTable, onSortChange, onCopyName, onOpenTable, onClose }: HeaderMenuProps) {
  const items = columnMenuItems(column, sort, onOpenTable ? fkTable : null).filter((item) => item.kind !== "sort" || !!onSortChange);
  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DropdownMenuTrigger asChild>
        {/* Stands where the ⌄ is, so the menu opens under it. */}
        <span aria-hidden className="pointer-events-none fixed" style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52" aria-label={`Column menu: ${column}`}>
        {items.map((item, i) => {
          if (item.kind === "separator") return <DropdownMenuSeparator key={`sep-${i}`} />;
          if (item.kind === "sort") {
            const Icon = sortIcon(item);
            return (
              <DropdownMenuItem key={item.label} onSelect={() => onSortChange?.(item.sort)}>
                <Icon className="size-4" />{item.label}
              </DropdownMenuItem>
            );
          }
          if (item.kind === "copy-name") {
            return <DropdownMenuItem key={item.label} onSelect={onCopyName}><Copy className="size-4" />{item.label}</DropdownMenuItem>;
          }
          return (
            <DropdownMenuItem key={`open-${item.table}`} onSelect={() => onOpenTable?.(item.table)}>
              <ExternalLink className="size-4" />{item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
