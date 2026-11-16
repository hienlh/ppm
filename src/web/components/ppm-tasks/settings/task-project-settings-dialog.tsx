/**
 * Task settings for one project: the switch, how often handed-off work is checked, statuses,
 * members and custom fields. Every change saves on its own (the server applies a settings write
 * all or nothing) and the dialog shows what the server answered. A bottom sheet below `md`.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { usePpmTaskProjectSettings } from "@/hooks/use-ppm-task-projects";
import { CHECK_INTERVAL_DEFAULT_MIN, CHECK_INTERVAL_MAX_MIN, CHECK_INTERVAL_MIN_MIN } from "../../../../shared/ppm-tasks";
import type { TaskProjectSettingsUpdate } from "../../../../shared/ppm-tasks-api";
import { CommitInput } from "./task-settings-parts";
import { TaskStatusesEditor } from "./task-statuses-editor";
import { TaskMembersEditor } from "./task-members-editor";
import { TaskFieldsEditor } from "./task-fields-editor";

type Section = "general" | "statuses" | "members" | "fields";
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "general", label: "General" }, { id: "statuses", label: "Statuses" }, { id: "members", label: "Members" }, { id: "fields", label: "Fields" },
];

export interface TaskProjectSettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  project: string;
  initialSection?: Section;
}

export function TaskProjectSettingsDialog({ open, onOpenChange, project, initialSection = "general" }: TaskProjectSettingsDialogProps) {
  const { settings, error, save } = usePpmTaskProjectSettings(open ? project : null);
  const [section, setSection] = useState<Section>(initialSection);
  const apply = (update: TaskProjectSettingsUpdate) => {
    save(update).catch((e: Error) => toast.error(`Could not save: ${e.message}`));
  };
  const interval = settings?.project.checkIntervalMin ?? CHECK_INTERVAL_DEFAULT_MIN;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-task-settings-dialog={project}
        className="max-h-[85vh] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-2xl max-md:bottom-0 max-md:top-auto max-md:max-w-full max-md:translate-y-0 max-md:rounded-b-none">
        <DialogHeader>
          <DialogTitle>Task settings · {project}</DialogTitle>
          <DialogDescription>Statuses, people and fields are this project's own.</DialogDescription>
        </DialogHeader>
        <div role="tablist" className="flex gap-1 border-b border-border">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={section === s.id} onClick={() => setSection(s.id)}
              className={cn("-mb-px h-9 border-b-2 px-3 text-sm", section === s.id ? "border-primary font-medium text-text" : "border-transparent text-text-2 hover:text-text")}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 overflow-y-auto pr-1">
          {error && <p className="text-sm text-error">{error}</p>}
          {!settings && !error && <p className="text-sm text-text-3">Loading…</p>}
          {settings && section === "general" && (
            <div className="space-y-4">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="block font-medium text-text">Tasks for {project}</span>
                  <span className="text-xs text-text-3">Off hides the tasks from PPM, the AI tools and Telegram. Nothing is deleted.</span>
                </span>
                <Switch checked={settings.project.enabled} onCheckedChange={(enabled) => apply({ enabled })} aria-label={`Tasks for ${project}`} />
              </label>
              <div className="flex flex-wrap items-center gap-2 text-sm text-text">
                Check handed-off work every
                <CommitInput label="Check interval in minutes" className="w-16 text-center" value={String(interval)}
                  onCommit={(v) => {
                    const n = Math.round(Number(v));
                    if (!Number.isFinite(n) || n < CHECK_INTERVAL_MIN_MIN || n > CHECK_INTERVAL_MAX_MIN) {
                      toast.error(`Pick ${CHECK_INTERVAL_MIN_MIN} to ${CHECK_INTERVAL_MAX_MIN} minutes`);
                      return;
                    }
                    apply({ checkIntervalMin: n });
                  }} />
                minutes
                <p className="w-full text-xs text-text-3">A chat a task was handed to is checked until the task has a result. A stalled chat, or one that finished without reporting, wakes the manager.</p>
              </div>
            </div>
          )}
          {settings && section === "statuses" && <TaskStatusesEditor statuses={settings.statuses} save={apply} />}
          {settings && section === "members" && <TaskMembersEditor members={settings.members} save={apply} />}
          {settings && section === "fields" && <TaskFieldsEditor fields={settings.fieldDefs} save={apply} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
