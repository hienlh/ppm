/**
 * Under a session schedule's row in Settings: the chat it sends into (tap to open it), and when PPM
 * paused it, why, with Resume right there; when it came due and is waiting for its chat, since when.
 * Outside the row's own button, which already opens its runs: a button may not hold another.
 */
import { useState } from "react";
import { toast } from "sonner";
import { MessageSquare, Play } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { openLinkedSession } from "@/lib/session-collab-client";
import { useProjectStore } from "@/stores/project-store";
import { sessionScheduleStatus } from "@/lib/session-schedule-view";
import type { ScheduleView } from "../../../../types/scheduler";

export function ScheduleSessionTarget({ schedule: s, onChanged }: { schedule: ScheduleView; onChanged: () => void }) {
  const projectName = useProjectStore((st) => st.projects.find((p) => p.path === s.project_path)?.name);
  const [resuming, setResuming] = useState(false);
  const status = sessionScheduleStatus(s);
  const title = s.target_title || "Untitled chat";

  const openChat = () => {
    if (!projectName || !s.target_session_id) return;
    void openLinkedSession({ projectName, providerId: s.provider_id, sessionId: s.target_session_id, title });
  };
  const resume = async () => {
    setResuming(true);
    try {
      await api.patch(`/api/schedules/${s.id}`, { enabled: true });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Could not resume it");
    } finally {
      setResuming(false);
    }
  };

  return (
    <div className="space-y-1 border-t border-border/60 px-2.5 py-1.5" data-schedule-target={s.target_session_id ?? ""}>
      <button
        type="button"
        onClick={openChat}
        disabled={!projectName}
        title={projectName ? `Open "${title}"` : "Its project is not registered in PPM"}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md text-left text-[11px] min-h-11 md:min-h-7 cursor-pointer disabled:cursor-default can-hover:hover:bg-accent/30"
      >
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">Session</span>
        <span className={cn("min-w-0 truncate font-medium", projectName ? "text-primary" : "text-muted-foreground")}>{title}</span>
        {projectName && <span className="shrink-0 text-muted-foreground">· {projectName}</span>}
      </button>
      {status.detail && (
        <div className="flex items-center gap-2">
          <p className={cn("min-w-0 flex-1 break-words text-[11px]", status.tone === "bad" ? "text-error" : "text-muted-foreground")}>
            {status.detail}
          </p>
          {s.paused_reason && (
            <button
              type="button"
              onClick={resume}
              disabled={resuming}
              data-testid="schedule-resume"
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium min-h-11 md:min-h-7 cursor-pointer disabled:opacity-50 can-hover:hover:bg-accent/30"
            >
              <Play className="size-3" /> Resume
            </button>
          )}
        </div>
      )}
    </div>
  );
}
