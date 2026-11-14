/** Create/edit form for a schedule — bottom sheet on mobile, dialog on desktop. */
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api-client";
import { formProblems, initialForm, requestBody, withKind, type ScheduleFormState } from "@/lib/schedule-form-model";
import type { ScheduleView } from "../../../../types/scheduler";
import { Field, ScheduleKindFields, Segmented } from "./schedule-kind-fields";
import { ScheduleSheet } from "./schedule-sheet";
import { SessionChatPicker, SessionTimingFields } from "./schedule-session-fields";

const PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "default", "plan"];

interface Project { name: string; path: string }

/** Every problem the server named, else its message. */
export function serverProblems(e: unknown): string[] {
  const problems = e instanceof ApiError ? (e.body as { problems?: unknown } | null)?.problems : undefined;
  if (Array.isArray(problems) && problems.every((p) => typeof p === "string")) return problems;
  return [e instanceof Error ? e.message : String(e)];
}

export function ScheduleForm({
  open,
  schedule,
  onClose,
  onSaved,
}: {
  open: boolean;
  schedule: ScheduleView | null; // null = create
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(() => initialForm(schedule));
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setForm(initialForm(schedule));
      setErrors([]);
      api.get<Project[]>("/api/projects").then(setProjects).catch(() => setProjects([]));
    }
  }, [open, schedule]);

  const set = <K extends keyof ScheduleFormState>(key: K, value: ScheduleFormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const isSession = form.kind === "session";
  // A session schedule's chat (and so its project) is fixed once it exists.
  const chatFixed = isSession && !!schedule;
  const projectName = projects.find((p) => p.path === form.projectPath)?.name;
  // A chat belongs to one project: another project means picking its chat again.
  const setProject = (path: string) => setForm((f) => ({ ...f, projectPath: path, targetSessionId: path === f.projectPath ? f.targetSessionId : "" }));

  const submit = async () => {
    const problems = formProblems(form, schedule?.secretsSet);
    if (problems.length) { setErrors(problems); return; }
    setSaving(true);
    setErrors([]);
    try {
      const body = requestBody(form, !!schedule);
      if (schedule) await api.patch(`/api/schedules/${schedule.id}`, body);
      else await api.post("/api/schedules", body);
      onSaved();
      onClose();
    } catch (e) {
      setErrors(serverProblems(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScheduleSheet open={open} onClose={onClose} title={schedule ? `Edit: ${schedule.name}` : "New schedule"} wide={form.kind === "script"}>
      <div className="space-y-3 px-1">
        <Field label="Kind">
          <Segmented
            value={form.kind}
            options={[["prompt", "Prompt"], ["script", "Script"], ["session", "Chat"]]}
            onChange={(kind) => setForm((f) => withKind(f, kind))}
            disabled={!!schedule}
          />
          {isSession && (
            <p className="text-[11px] text-muted-foreground">
              Sends the prompt into an existing chat, on that chat&apos;s own model and permissions, once it is idle.
            </p>
          )}
        </Field>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={form.kind === "script" ? "Support inbox watcher" : isSession ? "Optional — the prompt's first line" : "Morning PR review"} className="h-11 md:h-9 text-xs" />
        </Field>
        {form.kind === "script" && (
          <Field label="Description (optional)">
            <Input value={form.description} onChange={(e) => set("description", e.target.value)} className="h-11 md:h-9 text-xs" />
          </Field>
        )}
        <Field label="Project">
          <Select value={form.projectPath} onValueChange={setProject} disabled={chatFixed}>
            <SelectTrigger className="w-full min-h-11 md:min-h-9 text-xs"><SelectValue placeholder="Select project" /></SelectTrigger>
            <SelectContent>
              {projects.map((p) => <SelectItem key={p.path} value={p.path}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        {isSession && (
          <SessionChatPicker
            projectName={projectName}
            value={form.targetSessionId}
            onChange={(id) => set("targetSessionId", id)}
            disabled={chatFixed}
            currentTitle={schedule?.target_title}
          />
        )}
        <ScheduleKindFields
          form={form}
          set={set}
          secretsSet={schedule?.secretsSet ?? []}
          afterCron={isSession && (
            <SessionTimingFields
              timezone={form.timezone}
              recurring={form.recurring}
              onTimezone={(v) => set("timezone", v)}
              onRecurring={(v) => set("recurring", v)}
            />
          )}
        />
        {!isSession && <Field label={form.kind === "script" ? "Permission mode (for ctx.ai.chat)" : "Permission mode"}>
          <Select value={form.permissionMode} onValueChange={(v) => set("permissionMode", v)}>
            <SelectTrigger className="w-full min-h-11 md:min-h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERMISSION_MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          {form.permissionMode === "bypassPermissions" && (
            <p className="text-[11px] text-warning">⚠ Unattended writes — agent can modify code and run commands</p>
          )}
        </Field>}
        <div className="flex items-center justify-between min-h-11">
          <span className="text-xs font-medium">Enabled</span>
          <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
        </div>
        {errors.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-error">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <Button onClick={submit} disabled={saving} className="w-full min-h-11 cursor-pointer">
          {saving ? "Saving…" : schedule ? "Save changes" : "Create schedule"}
        </Button>
      </div>
    </ScheduleSheet>
  );
}
