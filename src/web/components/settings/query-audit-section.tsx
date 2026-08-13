import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Trash2 } from "lucide-react";
import {
  getQueryAuditSettings,
  updateQueryAuditSettings,
  clearQueryAuditLogs,
  type QueryAuditSettings,
} from "@/lib/api-settings";

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function QueryAuditSection() {
  const [settings, setSettings] = useState<QueryAuditSettings | null>(null);
  const [days, setDays] = useState("");
  const [sizeMb, setSizeMb] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  function apply(next: QueryAuditSettings) {
    setSettings(next);
    setDays(String(next.retention_days));
    setSizeMb(String(next.max_size_mb));
  }

  useEffect(() => {
    getQueryAuditSettings()
      .then(apply)
      .catch((e: Error) => toast.error("Could not load audit settings", { description: e.message }));
  }, []);

  async function save() {
    setSaving(true);
    try {
      apply(await updateQueryAuditSettings({
        retention_days: Number(days),
        max_size_mb: Number(sizeMb),
      }));
      toast.success("Audit retention updated");
    } catch (e) {
      toast.error("Could not save", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function clearAll() {
    if (!confirm("Delete every recorded query? This cannot be undone.")) return;
    setClearing(true);
    try {
      await clearQueryAuditLogs();
      apply(await getQueryAuditSettings());
      toast.success("Query audit log cleared");
    } catch (e) {
      toast.error("Could not clear the log", { description: (e as Error).message });
    } finally {
      setClearing(false);
    }
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  const dirty = days !== String(settings.retention_days) || sizeMb !== String(settings.max_size_mb);

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted-foreground">
        Every statement run from the SQL editor, the data grid and the <code>ppm db</code> CLI is
        recorded, together with a sample of the result. Entries are pruned once they pass either
        limit below — whichever comes first.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs font-medium">Keep for (days)</span>
          <Input
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="h-8 text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium">Max size (MB)</span>
          <Input
            type="number"
            min={10}
            value={sizeMb}
            onChange={(e) => setSizeMb(e.target.value)}
            className="h-8 text-xs"
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {settings.entry_count.toLocaleString()} entries · {formatSize(settings.size_bytes)} on disk
        </span>
        <Button size="sm" className="h-8 text-xs" disabled={!dirty || saving} onClick={save}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="h-8 w-full gap-1.5 text-xs text-destructive"
        disabled={clearing || settings.entry_count === 0}
        onClick={clearAll}
      >
        {clearing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        Clear all recorded queries
      </Button>
    </div>
  );
}
