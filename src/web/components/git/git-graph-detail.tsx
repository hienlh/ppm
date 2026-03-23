import { Button } from "@/components/ui/button";
import { useTabStore } from "@/stores/tab-store";
import { basename } from "@/lib/utils";
import type { GitCommit } from "../../../types/git";

interface GitGraphDetailProps {
  commit: GitCommit;
  files: Array<{ path: string; additions: number; deletions: number }>;
  loadingDetail: boolean;
  projectName: string;
  onClose: () => void;
  copyHash: (hash: string) => void;
}

export function GitGraphDetail({
  commit,
  files,
  loadingDetail,
  projectName,
  onClose,
  copyHash,
}: GitGraphDetailProps) {
  const { openTab } = useTabStore();

  return (
    <div className="border-t bg-muted/30 max-h-[40%] overflow-auto">
      <div className="px-3 py-2 border-b flex items-center justify-between">
        <span className="text-sm font-medium truncate">
          {commit.abbreviatedHash} — {commit.subject}
        </span>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div className="px-3 py-2 text-xs space-y-1">
        <div className="flex gap-4">
          <span className="text-muted-foreground w-12 shrink-0">Author</span>
          <span>
            {commit.authorName} &lt;{commit.authorEmail}&gt;
          </span>
        </div>
        <div className="flex gap-4">
          <span className="text-muted-foreground w-12 shrink-0">Date</span>
          <span>{new Date(commit.authorDate).toLocaleString()}</span>
        </div>
        <div className="flex gap-4">
          <span className="text-muted-foreground w-12 shrink-0">Hash</span>
          <span
            className="font-mono cursor-pointer hover:text-primary"
            onClick={() => copyHash(commit.hash)}
          >
            {commit.hash}
          </span>
        </div>
        {commit.parents.length > 0 && (
          <div className="flex gap-4">
            <span className="text-muted-foreground w-12 shrink-0">Parents</span>
            <span className="font-mono">
              {commit.parents.map((p) => p.slice(0, 7)).join(", ")}
            </span>
          </div>
        )}
        {commit.body && (
          <div className="mt-2 p-2 bg-background rounded text-xs whitespace-pre-wrap">
            {commit.body}
          </div>
        )}
      </div>
      {/* Changed files */}
      <div className="px-3 py-1 border-t">
        <div className="text-xs text-muted-foreground py-1">
          {loadingDetail
            ? "Loading files..."
            : `${files.length} file${files.length !== 1 ? "s" : ""} changed`}
        </div>
        {files.map((file) => (
          <div
            key={file.path}
            className="flex items-center gap-2 py-0.5 text-xs hover:bg-muted/50 rounded px-1 cursor-pointer"
            onClick={() =>
              openTab({
                type: "git-diff",
                title: `Diff ${basename(file.path)}`,
                closable: true,
                metadata: {
                  projectName,
                  ref1: commit.parents[0] ?? undefined,
                  ref2: commit.hash,
                  filePath: file.path,
                },
                projectId: projectName,
              })
            }
          >
            <span className="flex-1 truncate font-mono">{file.path}</span>
            {file.additions > 0 && (
              <span className="text-green-500">+{file.additions}</span>
            )}
            {file.deletions > 0 && (
              <span className="text-red-500">-{file.deletions}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
