/**
 * Settings → Storage → Session trace: how big `session-trace.db` is against its cap, how far
 * back it reaches, and the two limits its daily cleanup applies. The inputs mirror the Query
 * Audit block below it on purpose, so the two retention forms read as one design.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "@/lib/icons";
import { updateSessionTraceLimits } from "@/lib/api-settings";
import { checkSessionTraceLimits, traceUsage } from "@/lib/storage-settings-view";
import { cn } from "@/lib/utils";
import {
  SESSION_TRACE_MIN_RETENTION_DAYS,
  SESSION_TRACE_MIN_SIZE_MB,
  type StorageSessionTrace,
} from "../../../shared/storage-settings";

export function StorageSessionTraceBlock({ trace, onSaved }: {
  trace: StorageSessionTrace;
  onSaved: (next: StorageSessionTrace) => void;
}) {
  const [days, setDays] = useState(String(trace.retention_days));
  const [sizeMb, setSizeMb] = useState(String(trace.max_size_mb));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A refreshed overview (after a save, or a reload) resets the fields to what the server holds.
  useEffect(() => {
    setDays(String(trace.retention_days));
    setSizeMb(String(trace.max_size_mb));
  }, [trace.retention_days, trace.max_size_mb]);

  const usage = traceUsage(trace.sizeBytes, trace.max_size_mb);
  const dirty = days !== String(trace.retention_days) || sizeMb !== String(trace.max_size_mb);

  async function save() {
    const check = checkSessionTraceLimits(days, sizeMb);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      onSaved(await updateSessionTraceLimits(check.value));
      toast.success("Session trace limits updated");
    } catch (e) {
      // A 400 carries the route's own explanation; show it where the fields are.
      const message = (e as Error).message;
      setError(message);
      toast.error("Could not save", { description: message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="font-medium">{usage.label}</span>
          <span className="text-muted-foreground">
            {trace.oldestTs === null
              ? "No events yet"
              : `Since ${new Date(trace.oldestTs).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
          </span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-border"
          role="meter"
          aria-label="Session trace size"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(usage.fraction * 100)}
        >
          <div
            className={cn("h-full rounded-full", usage.over ? "bg-destructive" : "bg-primary")}
            style={{ width: `${usage.fraction * 100}%` }}
          />
        </div>
        <p className="break-all text-[11px] text-muted-foreground">{trace.path}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs font-medium">Keep for (days)</span>
          <Input
            type="number"
            inputMode="numeric"
            min={SESSION_TRACE_MIN_RETENTION_DAYS}
            value={days}
            onChange={(e) => { setDays(e.target.value); setError(null); }}
            className="h-8 text-xs pointer-coarse:h-11"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium">Max size (MB)</span>
          <Input
            type="number"
            inputMode="numeric"
            min={SESSION_TRACE_MIN_SIZE_MB}
            value={sizeMb}
            onChange={(e) => { setSizeMb(e.target.value); setError(null); }}
            className="h-8 text-xs pointer-coarse:h-11"
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className={cn("text-[11px]", error ? "text-destructive" : "text-muted-foreground")} role={error ? "alert" : undefined}>
          {error ?? "Older events are pruned once either limit is passed."}
        </span>
        <Button
          size="sm"
          className="h-8 shrink-0 text-xs pointer-coarse:h-11 pointer-coarse:min-w-11"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}
