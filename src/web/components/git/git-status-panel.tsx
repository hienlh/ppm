import { useEffect, useState, useCallback } from "react";
import { Loader2, Plus, Minus, GitBranch, ArrowUp, ArrowDown } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { Button } from "../ui/button.tsx";
import { api } from "../../lib/api-client.ts";
import { useTabStore } from "../../stores/tab.store.ts";
import type { GitStatus, GitFileChange } from "../../../types/git.ts";

interface Props {
  projectPath: string;
}

export function GitStatusPanel({ projectPath }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const { openTab } = useTabStore();

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<GitStatus>(
        `/api/git/status/${encodeURIComponent(projectPath)}`,
      );
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  const stage = async (files: string[]) => {
    setBusy(true);
    try {
      await api.post("/api/git/stage", { project: projectPath, files });
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const unstage = async (files: string[]) => {
    setBusy(true);
    try {
      await api.post("/api/git/unstage", { project: projectPath, files });
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!message.trim()) return;
    setBusy(true);
    try {
      await api.post("/api/git/commit", { project: projectPath, message });
      setMessage("");
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const push = async () => {
    setBusy(true);
    try {
      await api.post("/api/git/push", { project: projectPath });
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const pull = async () => {
    setBusy(true);
    try {
      await api.post("/api/git/pull", { project: projectPath });
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const openDiff = (file: GitFileChange) => {
    openTab({
      type: "git-diff",
      title: `Diff: ${file.path.split("/").pop()}`,
      closable: true,
      metadata: { projectPath, filePath: file.path },
    });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm px-4 text-center">
        {error}
      </div>
    );
  }

  if (!status) return null;

  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => !f.staged);

  const statusIcon = (s: GitFileChange["status"]) => {
    const map: Record<GitFileChange["status"], string> = {
      modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C",
    };
    return map[s];
  };

  const statusColor = (s: GitFileChange["status"]) => {
    const map: Record<GitFileChange["status"], string> = {
      modified: "text-yellow-500",
      added: "text-green-500",
      deleted: "text-red-500",
      renamed: "text-blue-500",
      copied: "text-cyan-500",
    };
    return map[s];
  };

  return (
    <div className="flex flex-col h-full">
      {/* Branch info */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-sm shrink-0">
        <GitBranch className="size-4 text-muted-foreground" />
        <span className="font-medium truncate">{status.branch}</span>
        {status.ahead > 0 && (
          <span className="flex items-center gap-0.5 text-xs text-green-500">
            <ArrowUp className="size-3" />{status.ahead}
          </span>
        )}
        {status.behind > 0 && (
          <span className="flex items-center gap-0.5 text-xs text-red-500">
            <ArrowDown className="size-3" />{status.behind}
          </span>
        )}
      </div>

      <ScrollArea className="flex-1">
        {/* Staged changes */}
        <div className="px-3 pt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Staged ({staged.length})
            </span>
            {staged.length > 0 && (
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => void unstage(staged.map((f) => f.path))}
                disabled={busy}
              >
                Unstage all
              </button>
            )}
          </div>
          {staged.length === 0 && (
            <p className="text-xs text-muted-foreground py-1">No staged changes</p>
          )}
          {staged.map((f) => (
            <FileRow
              key={`staged-${f.path}`}
              file={f}
              statusIcon={statusIcon(f.status)}
              statusColor={statusColor(f.status)}
              action={<Minus className="size-3" />}
              onAction={() => void unstage([f.path])}
              onClick={() => openDiff(f)}
              disabled={busy}
            />
          ))}
        </div>

        {/* Unstaged changes */}
        <div className="px-3 pt-3 pb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Changes ({unstaged.length})
            </span>
            {unstaged.length > 0 && (
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => void stage(unstaged.map((f) => f.path))}
                disabled={busy}
              >
                Stage all
              </button>
            )}
          </div>
          {unstaged.length === 0 && (
            <p className="text-xs text-muted-foreground py-1">No changes</p>
          )}
          {unstaged.map((f) => (
            <FileRow
              key={`unstaged-${f.path}`}
              file={f}
              statusIcon={statusIcon(f.status)}
              statusColor={statusColor(f.status)}
              action={<Plus className="size-3" />}
              onAction={() => void stage([f.path])}
              onClick={() => openDiff(f)}
              disabled={busy}
            />
          ))}
        </div>
      </ScrollArea>

      {/* Commit + Push/Pull */}
      <div className="border-t border-border p-3 space-y-2 shrink-0">
        <textarea
          className="w-full text-sm bg-muted/50 border border-border rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          rows={2}
          placeholder="Commit message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
          }}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            onClick={() => void commit()}
            disabled={busy || !message.trim() || staged.length === 0}
          >
            Commit
          </Button>
          <Button size="sm" variant="outline" onClick={() => void push()} disabled={busy}>
            <ArrowUp className="size-3 mr-1" />Push
          </Button>
          <Button size="sm" variant="outline" onClick={() => void pull()} disabled={busy}>
            <ArrowDown className="size-3 mr-1" />Pull
          </Button>
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  statusIcon,
  statusColor,
  action,
  onAction,
  onClick,
  disabled,
}: {
  file: GitFileChange;
  statusIcon: string;
  statusColor: string;
  action: React.ReactNode;
  onAction: () => void;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 group">
      <span className={`font-mono text-xs font-bold w-4 shrink-0 ${statusColor}`}>
        {statusIcon}
      </span>
      <button
        className="flex-1 text-xs text-left truncate hover:text-foreground text-muted-foreground"
        onClick={onClick}
        title={file.path}
      >
        {file.path}
      </button>
      <button
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-opacity"
        onClick={(e) => { e.stopPropagation(); onAction(); }}
        disabled={disabled}
      >
        {action}
      </button>
    </div>
  );
}
