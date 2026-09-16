/**
 * A repository's branches, as items for the searchable select.
 *
 * Local branches are listed before remote-tracking ones, under their own headings,
 * because that is the order a choice is made in — and because a repository with a
 * few dozen local branches routinely has hundreds of remote ones, and ungrouped the
 * handful anyone is choosing between is lost among them. The label is the whole
 * name, `remotes/origin/` included, so typing `origin` narrows to one remote.
 */
import { Cloud, GitBranch as GitBranchIcon } from "@/lib/icons";
import type { SearchSelectItem } from "./search-select-rows";
import type { GitBranch } from "../../types/git";

function branchItem(branch: GitBranch): SearchSelectItem {
  return {
    value: branch.name,
    label: branch.name,
    group: branch.remote ? "Remote branches" : "Branches",
    icon: branch.remote ? Cloud : GitBranchIcon,
    hint: branch.current ? "current" : undefined,
  };
}

export function branchItems(branches: GitBranch[]): SearchSelectItem[] {
  return [
    ...branches.filter((b) => !b.remote),
    ...branches.filter((b) => b.remote),
  ].map(branchItem);
}
