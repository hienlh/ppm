import { useEffect, useState, useCallback } from "react";
import {
  Plus,
  Minus,
  RefreshCw,
  ArrowUpFromLine,
  ArrowDownToLine,
  Loader2,
} from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { GitStatus, GitFileChange } from "../../../types/git";

interface GitStatusPanelProps {
  metadata?: Record<string, unknown>;
}

const STATUS_COLORS: Record<string, string> = {
  M: "text-yellow-500",
  A: "text-green-500",
  D: "text-red-500",
  R: "text-blue-500",
  C: "text-purple-500",
  "?": "text-gray-400",
};

export function GitStatusPanel({ metadata }: GitStatusPanelProps) {
  const projectName = metadata?.projectName as string | undefined;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [acting, setActing] = useState(false);
  const { openTab } = useTabStore();

  const fetchStatus = useCallback(async () => {
    if (!projectName) return;
    try {
      setLoading(true);
      const data = await api.get<GitStatus>(
        `${projectUrl(projectName)}/git/status`,
      );
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch status");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const stageFiles = async (files: string[]) => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/stage`, { files });
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stage failed");
    } finally {
      setActing(false);
    }
  };

  const unstageFiles = async (files: string[]) => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/unstage`, { files });
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unstage failed");
    } finally {
      setActing(false);
    }
  };

  const handleCommit = async () => {
    if (!projectName || !commitMsg.trim() || !status?.staged.length) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/commit`, {
        message: commitMsg.trim(),
      });
      setCommitMsg("");
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setActing(false);
    }
  };

  const handlePush = async () => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/push`, {});
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Push failed");
    } finally {
      setActing(false);
    }
  };

  const handlePull = async () => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/pull`, {});
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setActing(false);
    }
  };

  const openDiff = (file: GitFileChange) => {
    openTab({
      type: "git-diff",
      title: file.path.split("/").pop() ?? file.path,
      closable: true,
      metadata: {
        projectName,
        filePath: file.path,
      },
      projectId: projectName ?? null,
    });
  };

  if (!projectName) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No project selected.
      </div>
    );
  }

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Loading git status...</span>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive text-sm">
        <p>{error}</p>
        <Button variant="outline" size="sm" onClick={fetchStatus}>
          Retry
        </Button>
      </div>
    );
  }

  const allUnstaged = [
    ...(status?.unstaged ?? []),
    ...(status?.untracked.map(
      (p): GitFileChange => ({ path: p, status: "?" }),
    ) ?? []),
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-sm font-medium">
          {status?.current ? `On: ${status.current}` : "Git Status"}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={fetchStatus}
          disabled={acting}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {error && (
        <div className="px-3 py-1.5 text-xs text-destructive bg-destructive/10">
          {error}
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-3">
          {/* Staged Changes */}
          <FileSection
            title="Staged Changes"
            count={status?.staged.length ?? 0}
            files={status?.staged ?? []}
            actionIcon={<Minus className="size-3" />}
            actionTitle="Unstage"
            onAction={(f) => unstageFiles([f.path])}
            onActionAll={
              status?.staged.length
                ? () => unstageFiles(status.staged.map((f) => f.path))
                : undefined
            }
            actionAllLabel="Unstage All"
            onClickFile={openDiff}
            disabled={acting}
          />

          {/* Unstaged Changes */}
          <FileSection
            title="Changes"
            count={allUnstaged.length}
            files={allUnstaged}
            actionIcon={<Plus className="size-3" />}
            actionTitle="Stage"
            onAction={(f) => stageFiles([f.path])}
            onActionAll={
              allUnstaged.length
                ? () => stageFiles(allUnstaged.map((f) => f.path))
                : undefined
            }
            actionAllLabel="Stage All"
            onClickFile={openDiff}
            disabled={acting}
          />
        </div>
      </ScrollArea>

      {/* Commit section */}
      <div className="border-t p-2 space-y-2">
        <textarea
          className="w-full h-16 px-2 py-1.5 text-sm bg-muted/50 border rounded resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Commit message..."
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              handleCommit();
            }
          }}
        />
        <Button
          size="sm"
          className="w-full"
          disabled={
            acting || !commitMsg.trim() || !status?.staged.length
          }
          onClick={handleCommit}
        >
          {acting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            `Commit (${status?.staged.length ?? 0})`
          )}
        </Button>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={acting}
            onClick={handlePush}
          >
            <ArrowUpFromLine className="size-3" />
            Push
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={acting}
            onClick={handlePull}
          >
            <ArrowDownToLine className="size-3" />
            Pull
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Reusable file list section */
function FileSection({
  title,
  count,
  files,
  actionIcon,
  actionTitle,
  onAction,
  onActionAll,
  actionAllLabel,
  onClickFile,
  disabled,
}: {
  title: string;
  count: number;
  files: GitFileChange[];
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: (f: GitFileChange) => void;
  onActionAll?: () => void;
  actionAllLabel: string;
  onClickFile: (f: GitFileChange) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {title} ({count})
        </span>
        {onActionAll && count > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onActionAll}
            disabled={disabled}
            title={actionAllLabel}
          >
            {actionAllLabel}
          </Button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground px-1">No changes</p>
      ) : (
        <div className="space-y-0.5">
          {files.map((f) => (
            <div
              key={f.path}
              className="flex items-center gap-1 group hover:bg-muted/50 rounded px-1 py-0.5"
            >
              <span
                className={`text-xs font-mono w-4 text-center shrink-0 ${STATUS_COLORS[f.status] ?? ""}`}
              >
                {f.status}
              </span>
              <button
                type="button"
                className="flex-1 text-left text-xs font-mono truncate hover:underline"
                onClick={() => onClickFile(f)}
                title={f.path}
              >
                {f.path}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onAction(f);
                }}
                disabled={disabled}
                title={actionTitle}
              >
                {actionIcon}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
