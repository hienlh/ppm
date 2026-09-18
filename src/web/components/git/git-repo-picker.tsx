/**
 * Choosing which repository a container folder's git surfaces point at.
 *
 * A workspace folder is often not a repository — a folder of checkouts, a
 * monorepo of unrelated services — and every git surface used to run `git`
 * there and report "not a git repository", which reads as PPM being broken
 * rather than as the repositories being one level down. VS Code's git extension
 * scans a workspace folder's subfolders for the same reason and lists what it
 * finds; this is the same answer with one active at a time, because PPM's git
 * panels each show one branch, one log, one status.
 *
 * Two states, deliberately different in weight. With a repository resolved,
 * `GitRepoBar` is a single quiet row saying which one — you need to know, but
 * not to be asked. With several and none chosen, `GitRepoChoice` takes the
 * whole panel: a picker tucked into a header is a picker nobody finds, and
 * until it is answered there is nothing else for the panel to show.
 */
import { useMemo } from "react";
import { FolderGit2, GitBranch, RefreshCw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import type { GitRepoCandidate } from "@/lib/git-repo-scope";
import { usePrefersCoarsePointer } from "@/components/os-explorer/use-coarse-long-press";
import { cn } from "@/lib/utils";

interface GitRepoBarProps {
  repo: GitRepoCandidate;
  repos: GitRepoCandidate[];
  onChoose: (path: string) => void;
}

export function GitRepoBar({ repo, repos, onChoose }: GitRepoBarProps) {
  // One repository under a container still gets the row: the panel is showing
  // a subfolder's history under the project's name, and that has to be visible.
  const single = repos.length < 2;
  const coarse = usePrefersCoarsePointer();
  // Searchable, because a folder of checkouts is named the way this one is —
  // `nxsys-backend-nx5833`, `…-nx5838`, `…-nx5838-ma` — and a plain menu of
  // thirty of them is read top to bottom for the last few characters.
  const items = useMemo(
    () => repos.map((c) => ({ value: c.path, label: c.relative, title: c.path, icon: GitBranch })),
    [repos],
  );
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0 text-xs text-text-secondary">
      <FolderGit2 className="size-3.5 shrink-0 text-text-subtle" />
      {single ? (
        <span className="truncate" title={repo.path}>
          {repo.relative}
        </span>
      ) : (
        <SearchSelect
          value={repo.path}
          items={items}
          onChange={onChoose}
          label="Repository"
          searchPlaceholder="Search repositories"
          emptyText="No matching repositories"
          testId="git-repo-picker"
          // Ghost, not a form field: this row says which repository, it does not
          // ask. And it is the only way back to the other repository, so a full
          // 44px target wherever the pointer is coarse — gated on the pointer
          // rather than on a width, because a touch laptop is wide and has no
          // mouse. Both heights are restated at `md:` to beat the field's own.
          className={cn(
            "border-transparent bg-transparent px-1.5 text-text-secondary hover:bg-accent",
            coarse ? "h-11 md:h-11" : "h-8 md:h-8",
          )}
        />
      )}
    </div>
  );
}

interface GitRepoChoiceProps {
  repos: GitRepoCandidate[];
  onChoose: (path: string) => void;
}

export function GitRepoChoice({ repos, onChoose }: GitRepoChoiceProps) {
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="flex items-center gap-2 mb-1">
        <FolderGit2 className="size-4 text-text-subtle shrink-0" />
        <h3 className="text-sm font-medium">
          {repos.length} repositories in this folder
        </h3>
      </div>
      <p className="text-xs text-text-secondary leading-relaxed mb-3">
        This project folder is not a git repository itself. Pick the one to work with — you can switch later from the header.
      </p>
      <div className="flex flex-col gap-1">
        {repos.map((candidate) => (
          <button
            key={candidate.path}
            type="button"
            onClick={() => onChoose(candidate.path)}
            className="flex items-center gap-2.5 min-h-11 px-3 py-2 rounded-md text-left border border-border bg-panel can-hover:hover:bg-panel-2 active:bg-panel-2"
          >
            <GitBranch className="size-4 shrink-0 text-text-subtle" />
            <span className="min-w-0">
              <span className="block text-sm truncate">{candidate.name}</span>
              {candidate.relative !== candidate.name && (
                <span className="block text-xs text-text-subtle truncate">{candidate.relative}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface GitNoRepoProps {
  onReload: () => void;
}

export function GitNoRepo({ onReload }: GitNoRepoProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <FolderGit2 className="size-8 text-text-subtle" />
      <p className="text-sm text-text-secondary leading-relaxed max-w-xs">
        No git repository in this project, or in any folder two levels below it.
      </p>
      {/* Cloning something into the folder is the usual next move, and the
          discovery result is cached — so there has to be a way to ask again. */}
      <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={onReload}>
        <RefreshCw className="size-3.5" />
        Scan again
      </Button>
    </div>
  );
}
