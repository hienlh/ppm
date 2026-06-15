/** Create/edit form for a schedule — bottom sheet on mobile, dialog on desktop. */
import { useState, useEffect, useMemo } from "react";
import { Cron } from "croner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { api } from "@/lib/api-client";
import type { Schedule } from "../../../../types/scheduler";

const PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "default", "plan"];

interface Project { name: string; path: string }

export function ScheduleForm({
  open,
  schedule,
  onClose,
  onSaved,
}: {
  open: boolean;
  schedule: Schedule | null; // null = create
  onClose: () => void;
  onSaved: () => void;
}) {
  const isMobile = useIsMobile();
  const [form, setForm] = useState(() => initialForm(schedule));
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initialForm(schedule));
      setError(null);
      api.get<Project[]>("/api/projects").then(setProjects).catch(() => setProjects([]));
    }
  }, [open, schedule]);

  const nextFires = useMemo(() => {
    try {
      return new Cron(form.cron_expr).nextRuns(3).map((d) => d.toLocaleString());
    } catch {
      return null;
    }
  }, [form.cron_expr]);

  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    if (!form.name.trim() || !form.project_path || !form.prompt.trim()) {
      setError("Name, project, and prompt are required");
      return;
    }
    if (!nextFires) { setError("Invalid cron expression"); return; }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        cron_expr: form.cron_expr,
        project_path: form.project_path,
        prompt: form.prompt,
        permission_mode: form.permission_mode,
        max_turns: form.max_turns === "" ? null : Number(form.max_turns),
        timeout_ms: Number(form.timeout_ms) || 1_800_000,
        enabled: form.enabled,
      };
      if (schedule) await api.patch(`/api/schedules/${schedule.id}`, body);
      else await api.post("/api/schedules", body);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const fields = (
    <div className="space-y-3 px-1">
      <Field label="Name">
        <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Morning PR review" className="h-11 md:h-9 text-xs" />
      </Field>
      <Field label="Cron expression (local timezone)">
        <Input value={form.cron_expr} onChange={(e) => set("cron_expr", e.target.value)} placeholder="0 7 * * *" className="h-11 md:h-9 text-xs font-mono" />
        <p className="text-[11px] text-muted-foreground">
          {nextFires ? `Next: ${nextFires.join(" · ")}` : "—"}
        </p>
      </Field>
      <Field label="Project">
        <Select value={form.project_path} onValueChange={(v) => set("project_path", v)}>
          <SelectTrigger className="w-full min-h-11 md:min-h-9 text-xs"><SelectValue placeholder="Select project" /></SelectTrigger>
          <SelectContent>
            {projects.map((p) => <SelectItem key={p.path} value={p.path}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Prompt (do not embed secrets)">
        <textarea
          value={form.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          placeholder="Check open PRs and summarize. If nothing to do, finish immediately."
          rows={4}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 resize-y"
        />
      </Field>
      <Field label="Permission mode">
        <Select value={form.permission_mode} onValueChange={(v) => set("permission_mode", v)}>
          <SelectTrigger className="w-full min-h-11 md:min-h-9 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PERMISSION_MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        {form.permission_mode === "bypassPermissions" && (
          <p className="text-[11px] text-amber-500">⚠ Unattended writes — agent can modify code and run commands</p>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Max turns (optional)">
          <Input type="number" min={1} value={form.max_turns} onChange={(e) => set("max_turns", e.target.value)} placeholder="∞" className="h-11 md:h-9 text-xs" />
        </Field>
        <Field label="Timeout (ms)">
          <Input type="number" min={10_000} value={form.timeout_ms} onChange={(e) => set("timeout_ms", e.target.value)} className="h-11 md:h-9 text-xs" />
        </Field>
      </div>
      <div className="flex items-center justify-between min-h-11">
        <span className="text-xs font-medium">Enabled</span>
        <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      <Button onClick={submit} disabled={saving} className="w-full min-h-11 cursor-pointer">
        {saving ? "Saving…" : schedule ? "Save changes" : "Create schedule"}
      </Button>
    </div>
  );

  const title = schedule ? `Edit: ${schedule.name}` : "New schedule";

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} className="max-h-[85vh] flex flex-col">
        <p className="text-sm font-semibold text-center pb-2">{title}</p>
        <ScrollArea className="flex-1 min-h-0 px-3 pb-3">{fields}</ScrollArea>
      </BottomSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="text-sm">{title}</DialogTitle></DialogHeader>
        {fields}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function initialForm(s: Schedule | null) {
  return {
    name: s?.name ?? "",
    cron_expr: s?.cron_expr ?? "0 7 * * *",
    project_path: s?.project_path ?? "",
    prompt: s?.prompt ?? "",
    permission_mode: s?.permission_mode ?? "bypassPermissions",
    max_turns: s?.max_turns != null ? String(s.max_turns) : "",
    timeout_ms: String(s?.timeout_ms ?? 1_800_000),
    enabled: s ? !!s.enabled : true,
  };
}
