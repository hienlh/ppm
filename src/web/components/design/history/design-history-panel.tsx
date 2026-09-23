import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { History, Loader2, RotateCcw, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format-date";
import { formatSize } from "@/components/os-explorer/format-file-meta";
import { listDesignHistory, restoreDesignSnapshot } from "@/lib/design/api-designs";
import { DesignResponsiveDialog } from "../dialogs/design-responsive-dialog";
import { useDesignTab } from "../design-tab-context";
import type { DesignSnapshotInfo, DesignSnapshotReason } from "../../../../shared/design-types";

/**
 * The design's snapshot history, newest first, with restore.
 *
 * Refreshed by `design:history_changed`, never by file events: `.design/` is deliberately
 * not watched. Restore replaces the working files, so it is confirmed first and refused
 * while the design's chat is mid-turn — the agent would keep writing over the restored copy.
 * The server snapshots the current state before restoring, so a restore is itself undoable
 * from this list.
 */

const REASON_LABEL: Record<DesignSnapshotReason, string> = {
  turn: "After an AI turn",
  "pre-restore": "Before a restore",
  "before-edit": "Before a canvas edit",
  manual: "Saved",
};

export function DesignHistoryPanel({ onClose, onRestored }: { onClose: () => void; onRestored: () => void }) {
  const { projectName, slug, isStreaming } = useDesignTab();
  const [items, setItems] = useState<DesignSnapshotInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DesignSnapshotInfo | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(() => {
    listDesignHistory(projectName, slug)
      .then((list) => { setItems(list); setError(null); })
      .catch((e) => setError((e as Error).message || "Could not load the history"));
  }, [projectName, slug]);

  useEffect(() => {
    load();
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; slug?: string }>).detail;
      if (d?.projectName === projectName && d.slug === slug) load();
    };
    window.addEventListener("design:history_changed", onChanged);
    return () => window.removeEventListener("design:history_changed", onChanged);
  }, [load, projectName, slug]);

  const restore = useCallback(async () => {
    if (!confirm) return;
    setRestoring(true);
    try {
      await restoreDesignSnapshot(projectName, slug, confirm.id);
      toast.success("Version restored", { description: "The previous state was saved to the history first." });
      setConfirm(null);
      onRestored();
    } catch (e) {
      toast.error("Could not restore this version", { description: (e as Error).message });
    } finally {
      setRestoring(false);
    }
  }, [confirm, projectName, slug, onRestored]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <History className="size-4 text-text-subtle" />
        <span className="flex-1 text-xs font-semibold">Version history</span>
        <button type="button" onClick={onClose} aria-label="Close history"
          className="flex size-11 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated md:size-7">
          <X className="size-4" />
        </button>
      </div>
      {isStreaming && (
        <p className="border-b border-border px-3 py-2 text-xs text-text-subtle">Restoring is paused while the AI is working on this design.</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? (
          <div className="p-3 text-xs text-destructive">
            {error} <button type="button" className="text-primary underline" onClick={load}>Retry</button>
          </div>
        ) : items === null ? (
          <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-primary" /></div>
        ) : items.length === 0 ? (
          <p className="p-3 text-xs text-text-subtle">No versions yet. One is saved after every AI turn that changes the design.</p>
        ) : items.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{REASON_LABEL[s.reason] ?? s.reason}</p>
              <p className="truncate text-xs text-text-subtle" title={s.createdAt}>
                {formatRelativeDate(s.createdAt)} · {s.fileCount} files · {formatSize(s.bytes)}
              </p>
            </div>
            <button type="button" disabled={isStreaming} onClick={() => setConfirm(s)}
              aria-label="Restore this version" title="Restore this version"
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground disabled:opacity-40 md:size-8">
              <RotateCcw className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <DesignResponsiveDialog
        open={!!confirm}
        onClose={() => { if (!restoring) setConfirm(null); }}
        title="Restore this version?"
        description={confirm ? `The design's files are replaced with the version from ${formatRelativeDate(confirm.createdAt)}. The current state is saved to the history first, so you can go back.` : undefined}
        footer={<>
          <Button variant="outline" onClick={() => setConfirm(null)} disabled={restoring}>Cancel</Button>
          <Button onClick={restore} disabled={restoring || isStreaming}>
            {restoring && <Loader2 className="size-4 animate-spin" />} Restore
          </Button>
        </>}
      />
    </div>
  );
}
