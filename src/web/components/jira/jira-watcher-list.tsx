import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useJiraStore } from "@/stores/jira-store";
import { JiraWatcherForm } from "./jira-watcher-form";
import { Plus, Trash2, Play, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import type { JiraWatcher } from "../../../../src/types/jira";

interface Props { configId: number }

export function JiraWatcherList({ configId }: Props) {
  const { watchers, deleteWatcher, toggleWatcher, pullWatcher } = useJiraStore();
  const [addOpen, setAddOpen] = useState(false);
  const [editingWatcher, setEditingWatcher] = useState<JiraWatcher | null>(null);
  const [pulling, setPulling] = useState<number | null>(null);

  const handlePull = async (id: number) => {
    setPulling(id);
    try {
      const res = await pullWatcher(id);
      toast.success(`Pulled ${res.newIssues} new issue${res.newIssues !== 1 ? "s" : ""}`);
    } catch (e: any) {
      toast.error(e.message ?? "Pull failed");
    }
    setPulling(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Watchers</h4>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="min-h-[44px]">
              <Plus className="size-4 mr-1" /> Add
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md overflow-hidden">
            <DialogHeader><DialogTitle>New Watcher</DialogTitle></DialogHeader>
            <JiraWatcherForm configId={configId} onDone={() => setAddOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

      {watchers.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">No watchers yet.</p>
      )}

      {watchers.map((w) => (
        <div key={w.id} className="flex items-center gap-2 p-2 rounded-md border text-sm">
          <Switch
            checked={w.enabled}
            onCheckedChange={(val) => toggleWatcher(w.id, val)}
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{w.name}</div>
            <div className="text-xs text-muted-foreground truncate font-mono">{w.jql}</div>
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {w.mode === "notify" ? "notify" : "debug"} · {formatInterval(w.intervalMs)}
          </span>
          <Button size="icon" variant="ghost" className="size-8" onClick={() => setEditingWatcher(w)}>
            <Pencil className="size-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="size-8" onClick={() => handlePull(w.id)} disabled={pulling === w.id}>
            {pulling === w.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => deleteWatcher(w.id)}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}

      {/* Edit dialog */}
      <Dialog open={!!editingWatcher} onOpenChange={(open) => { if (!open) setEditingWatcher(null); }}>
        <DialogContent className="max-w-md overflow-hidden">
          <DialogHeader><DialogTitle>Edit Watcher</DialogTitle></DialogHeader>
          {editingWatcher && (
            <JiraWatcherForm
              configId={configId}
              existing={editingWatcher}
              onDone={() => setEditingWatcher(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatInterval(ms: number): string {
  if (ms >= 3600000) return `${ms / 3600000}h`;
  if (ms >= 60000) return `${ms / 60000}m`;
  return `${ms / 1000}s`;
}
