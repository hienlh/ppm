/**
 * Settings → Memory (requirement 11): PPM's shared memory store — the on/off switch, the folder
 * memories live in with the active project's counts, and one row per provider showing what was
 * copied in, when, and the last error, with Sync now. Below `md` the rows and Sync now are 44px
 * and Sync now spans the width under the rows (11.4).
 *
 * Switching off only stops syncing and stops sending the list to chats; no file is deleted (11.3).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Folder, Info, Loader2, RefreshCw, XCircle } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatRelativeDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { MemoryEmbeddingSource } from "./memory-embedding-source";
import {
  MEMORY_CHANGED_EVENT, getMemoryStatus, syncMemoryNow, updateMemorySettings,
  type MemoryProviderId, type MemoryProviderStatus, type MemoryStatus,
} from "@/lib/api-memory";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Each provider's name, where PPM reads its memories, and what an empty store means. */
const PROVIDERS: Array<{ id: MemoryProviderId; label: string; source: string; empty: string }> = [
  {
    id: "claude",
    label: "Claude",
    source: "~/.claude/projects/<this project>/memory",
    empty: "No memories yet. Claude Code writes them during a chat, if auto memory is on.",
  },
  {
    id: "codex",
    label: "Codex",
    source: "~/.codex/memories",
    empty: "No memories yet. Codex writes them after a chat ends, if memories are on in Codex.",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    source: "~/.gemini/antigravity/knowledge",
    empty: "No memories yet. Antigravity saves knowledge items as it works.",
  },
];

/** The line under a provider's name: its error, what it skipped, or where it reads from. */
function providerNote(status: MemoryProviderStatus | undefined, source: string, empty: string) {
  if (status?.error) return { text: status.error, error: true };
  const skipped = status?.skipped ?? [];
  if (skipped.length) {
    const items = skipped.length === 1 ? "1 item" : `${skipped.length} items`;
    return { text: `Skipped ${items}: ${skipped[0]}`, error: true };
  }
  if (!status || status.count === 0) return { text: empty, error: false };
  return { text: source, error: false };
}

function providerSummary(status: MemoryProviderStatus | undefined): string {
  if (!status?.syncedAt) return "Not synced yet";
  const count = status.count === 0 ? "0" : status.count === 1 ? "1 memory" : `${status.count} memories`;
  return `${count} · ${formatRelativeDate(status.syncedAt)}`;
}

function ProviderRow({ id, label, source, empty, status }: {
  id: MemoryProviderId;
  label: string;
  source: string;
  empty: string;
  status: MemoryProviderStatus | undefined;
}) {
  const note = providerNote(status, source, empty);
  const Icon = note.error ? XCircle : status && status.count > 0 ? Check : Info;
  // An error colours the row, so the icon inherits it and the error line is the one red element in it.
  return (
    <div
      data-testid={`memory-provider-${id}`}
      className={cn("flex min-h-11 items-start gap-3 px-3 py-2.5 md:items-center", note.error && "text-error")}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0 md:mt-0", !note.error && (status && status.count > 0 ? "text-success" : "text-muted-foreground"))} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{label}</p>
        <p className={cn("text-xs", note.error ? "break-words text-error" : "truncate text-muted-foreground")}>{note.text}</p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{providerSummary(status)}</span>
    </div>
  );
}

export function MemorySettingsSection() {
  const projectName = useProjectStore((s) => s.activeProject?.name);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await getMemoryStatus(projectName));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [projectName]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onChanged = () => { void load(); };
    window.addEventListener(MEMORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MEMORY_CHANGED_EVENT, onChanged);
  }, [load]);

  const setEnabled = async (enabled: boolean) => {
    setSaving(true);
    try {
      const saved = await updateMemorySettings({ enabled });
      setStatus((s) => (s ? { ...s, enabled: saved.enabled } : s));
      void load();
    } catch (e) {
      toast.error(`Could not save: ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      await syncMemoryNow();
      await load();
    } catch (e) {
      toast.error(`Sync failed: ${errorText(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  if (!status) {
    return loadError
      ? <p className="p-4 text-sm text-error">Could not load memory status: {loadError}</p>
      : (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      );
  }

  const { counts } = status;
  return (
    <div className="space-y-6">
      <section className="flex min-h-11 items-center justify-between gap-4">
        <label htmlFor="ppm-memory-switch" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">PPM memory</span>
          <span className="block text-xs text-muted-foreground">
            {status.enabled
              ? "One memory store for Claude, Codex and Antigravity. PPM copies each provider's own memories in and never changes them."
              : "Off: nothing is synced and chats get today's shared context. Every memory file is kept."}
          </span>
        </label>
        <Switch id="ppm-memory-switch" checked={status.enabled} disabled={saving} onCheckedChange={(on) => void setEnabled(on)} />
      </section>

      <section className="space-y-2">
        <p className="text-sm font-medium">Where memories live</p>
        <div className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 md:flex-row md:items-center md:gap-2">
          <Folder className="hidden size-4 shrink-0 text-muted-foreground md:block" />
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{status.root}</code>
          <span className="shrink-0 text-xs text-muted-foreground">
            This project {counts.project} · Global {counts.global} · Archived {counts.archived}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Plain Markdown files, one per memory. Edit them by hand if you like; PPM picks the change up on the next message.
        </p>
      </section>

      <Separator />

      {/* One Sync now button: beside the heading from md up, full width under the rows below md. */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0">
          <p className="text-sm font-medium">Copied from providers</p>
          <p className="text-xs text-muted-foreground">Synced before each chat message when a provider's memory changed.</p>
        </div>
        <Button
          variant="outline"
          onClick={() => void syncNow()}
          disabled={syncing || !status.enabled}
          className="order-last h-11 w-full md:order-none md:h-8 md:w-auto"
        >
          {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Sync now
        </Button>
        <div className="divide-y divide-border rounded-lg border border-border md:col-span-2">
          {PROVIDERS.map((p) => (
            <ProviderRow key={p.id} {...p} status={status.providers[p.id]} />
          ))}
        </div>
      </section>

      <Separator />
      <MemoryEmbeddingSource embedding={status.embedding} onChanged={load} />
    </div>
  );
}
