import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useJiraStore } from "@/stores/jira-store";
import { JiraFilterBuilder } from "./jira-filter-builder";
import { Plus, Trash2, Play, Loader2 } from "lucide-react";
import type { JiraWatcher, JiraWatcherMode } from "../../../../src/types/jira";

const INTERVALS = [
  { label: "30s", value: 30000 }, { label: "1m", value: 60000 },
  { label: "2m", value: 120000 }, { label: "5m", value: 300000 },
  { label: "10m", value: 600000 }, { label: "30m", value: 1800000 },
  { label: "1h", value: 3600000 },
];

interface Props { configId: number }

export function JiraWatcherList({ configId }: Props) {
  const { watchers, createWatcher, deleteWatcher, toggleWatcher, pullWatcher } = useJiraStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pulling, setPulling] = useState<number | null>(null);

  const handlePull = async (id: number) => {
    setPulling(id);
    try { await pullWatcher(id); } catch {}
    setPulling(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Watchers</h4>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="min-h-[44px]">
              <Plus className="size-4 mr-1" /> Add
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>New Watcher</DialogTitle></DialogHeader>
            <AddWatcherForm configId={configId} onDone={() => setDialogOpen(false)} />
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
          <Button size="icon" variant="ghost" className="size-8" onClick={() => handlePull(w.id)} disabled={pulling === w.id}>
            {pulling === w.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => deleteWatcher(w.id)}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function formatInterval(ms: number): string {
  if (ms >= 3600000) return `${ms / 3600000}h`;
  if (ms >= 60000) return `${ms / 60000}m`;
  return `${ms / 1000}s`;
}

function AddWatcherForm({ configId, onDone }: { configId: number; onDone: () => void }) {
  const { createWatcher } = useJiraStore();
  const [name, setName] = useState("");
  const [jql, setJql] = useState("");
  const [intervalMs, setIntervalMs] = useState(120000);
  const [mode, setMode] = useState<JiraWatcherMode>("debug");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !jql) return;
    setSaving(true);
    try {
      await createWatcher({ configId, name, jql, intervalMs, mode, promptTemplate: prompt || undefined });
      onDone();
    } catch {}
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="text-xs text-muted-foreground">Name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bug watcher" className="h-9" />
      </div>
      <JiraFilterBuilder value={jql} onChange={setJql} configId={configId} />
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs text-muted-foreground">Interval</label>
          <Select value={String(intervalMs)} onValueChange={(v) => setIntervalMs(Number(v))}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {INTERVALS.map((i) => <SelectItem key={i.value} value={String(i.value)}>{i.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1">
          <label className="text-xs text-muted-foreground">Mode</label>
          <Select value={mode} onValueChange={(v) => setMode(v as JiraWatcherMode)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="debug">Debug + Notify</SelectItem>
              <SelectItem value="notify">Notify only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground">Prompt template (optional)</label>
        <textarea
          value={prompt} onChange={(e) => setPrompt(e.target.value)}
          className="w-full h-16 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Debug Jira issue {issue_key}: {summary}"
        />
      </div>
      <Button type="submit" size="sm" disabled={saving || !name || !jql} className="min-h-[44px] w-full">
        {saving ? <Loader2 className="size-4 animate-spin" /> : "Create Watcher"}
      </Button>
    </form>
  );
}
