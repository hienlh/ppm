/**
 * The branch picker — Branch Review's two, and Add Worktree's.
 *
 * These were native `<select>`s, on the argument that the OS picker scrolls well
 * and is a good touch target. What that missed is the list: a working repository
 * here has a few dozen local branches and several hundred remote-tracking ones,
 * all named `fix/NX-1234-…`, and a native picker cannot be searched. So it is a
 * `SearchSelect` over the repository's branches; what a branch row says and the
 * order the groups come in are `branchItems`.
 */
import { useMemo } from "react";
import { GitBranch as GitBranchIcon } from "@/lib/icons";
import { SearchSelect, type SearchSelectProps } from "@/components/ui/search-select";
import { branchItems } from "@/lib/branch-select-items";
import type { GitBranch } from "../../../types/git";

type BranchSelectProps = Omit<
  SearchSelectProps,
  "items" | "icon" | "placeholder" | "searchPlaceholder" | "emptyText"
> & { branches: GitBranch[] };

export function BranchSelect({ branches, ...rest }: BranchSelectProps) {
  const items = useMemo(() => branchItems(branches), [branches]);
  return (
    <SearchSelect
      {...rest}
      items={items}
      icon={GitBranchIcon}
      placeholder="Select a branch"
      searchPlaceholder="Search branches"
      emptyText="No matching branches"
    />
  );
}
