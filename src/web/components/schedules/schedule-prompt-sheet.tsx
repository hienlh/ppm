/**
 * "Open prompt": the whole prompt (or script) of one schedule, read-only, with Edit beside it. A
 * dialog on a desktop and a bottom sheet on a phone, through the Settings schedules' own frame.
 */
import { Copy, Pencil } from "@/lib/icons";
import { toast } from "sonner";
import { ScheduleSheet } from "@/components/settings/schedules/schedule-sheet";
import type { ScheduleOverview } from "../../../types/scheduler";
import { TEXT_BUTTON } from "./schedules-ui";

export function SchedulePromptSheet({ schedule, onClose, onEdit }: {
  schedule: ScheduleOverview | null;
  onClose: () => void;
  onEdit: () => void;
}) {
  const text = schedule ? (schedule.kind === "script" ? schedule.script ?? "" : schedule.prompt) : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  };
  return (
    <ScheduleSheet open={!!schedule} onClose={onClose} title={schedule ? schedule.name : ""} wide>
      {schedule && (
        <div data-schedule-prompt={schedule.id} className="flex flex-col gap-2">
          <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel-2 p-2.5 font-mono text-xs leading-relaxed text-foreground">
            {text || "—"}
          </pre>
          <div className="flex gap-1.5">
            <button type="button" className={TEXT_BUTTON} onClick={() => void copy()}><Copy />Copy</button>
            <button type="button" className={TEXT_BUTTON} onClick={onEdit}><Pencil />Edit</button>
          </div>
        </div>
      )}
    </ScheduleSheet>
  );
}
