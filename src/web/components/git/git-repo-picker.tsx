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
import { FolderGit2, GitBranch, ChevronsUpDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GitRepoCandidate } from "@/lib/git-repo-scope";

interface GitRepoBarProps {
  repo: GitRepoCandidate;
  repos: GitRepoCandidate[];
  onChoose: (path: string) => void;
}

export function GitRepoBar({ repo, repos, onChoose }: GitRepoBarProps) {
  // One repository under a container still gets the row: the panel is showing
  // a subfolder's history under the project's name, and that has to be visible.
  const single = repos.length < 2;
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0 text-xs text-text-secondary">
      <FolderGit2 className="size-3.5 shrink-0 text-text-subtle" />
      {single ? (
        <span className="truncate" title={repo.path}>
          {repo.relative}
        </span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* h-8 rather than the panel's icon-xs: this is a real target on a
                phone, and it is the only way back to the other repository. */}
            <Button variant="ghost" size="sm" className="h-8 min-w-0 gap-1 px-1.5 text-xs">
              <span className="truncate" title={repo.path}>{repo.relative}</span>
              <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-[min(20rem,90vw)]">
            <DropdownMenuLabel className="text-xs">Repository</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {repos.map((candidate) => (
              <DropdownMenuItem
                key={candidate.path}
                onClick={() => onChoose(candidate.path)}
                className="gap-2"
              >
                <GitBranch className="size-3.5 shrink-0" />
                <span className="truncate">{candidate.relative}</span>
                {candidate.path === repo.path && <span className="ml-auto text-text-subtle">✓</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
