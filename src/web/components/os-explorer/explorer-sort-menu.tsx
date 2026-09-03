/**
 * Toolbar "Sort" menu: the only sort control reachable from Icons and Column view, which
 * have no clickable column header of their own (List view keeps that shortcut too — see
 * `views/list-view.tsx`). Backed by the same `prefs.sort` every view already reads.
 */

import { ArrowUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useExplorerStore, type SortDir, type SortKey } from "./explorer-store";
import { SORT_DIR_OPTIONS, SORT_KEY_OPTIONS, sortDirLabel, sortKeyLabel } from "./sort-options";
import { toolbarButtonClass } from "./toolbar-icon-button";

export interface ExplorerSortMenuProps {
  coarse: boolean;
}

export function ExplorerSortMenu({ coarse }: ExplorerSortMenuProps) {
  const sort = useExplorerStore((s) => s.sort);
  const setPrefs = useExplorerStore((s) => s.setPrefs);

  // No skin currently defines a `vocab` slot for this label, so both the Windows and
  // macOS chrome fall back to the same plain word.
  const label = "Sort";
  const title = `${label}: ${sortKeyLabel(sort.key)}, ${sortDirLabel(sort.dir)}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={label} title={title} className={toolbarButtonClass(coarse)}>
          <ArrowUpDown className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort.key}
          onValueChange={(key) => setPrefs({ sort: { key: key as SortKey, dir: sort.dir } })}
        >
          {SORT_KEY_OPTIONS.map(({ key, label: keyLabel }) => (
            <DropdownMenuRadioItem key={key} value={key}>
              {keyLabel}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Order</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort.dir}
          onValueChange={(dir) => setPrefs({ sort: { key: sort.key, dir: dir as SortDir } })}
        >
          {SORT_DIR_OPTIONS.map(({ dir, label: dirLabel }) => (
            <DropdownMenuRadioItem key={dir} value={dir}>
              {dirLabel}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
