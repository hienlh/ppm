/**
 * Sidebar "Specs": the project's specs, newest first — where each stands, its tasks done, its
 * check level, and whether it waits for you. Tap opens the spec's chat with the spec beside it;
 * a spec with no chat yet (started from `ppm spec new`) gets one.
 */
import { useState } from "react";
import { toast } from "sonner";
import { ClipboardList, FlaskConical, Loader2, Plus } from "@/lib/icons";
import { api, projectUrl } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { formatRelativeDate } from "@/lib/format-date";
import { specsApi } from "@/lib/api-specs";
import { openSpecChat } from "@/lib/open-spec-chat";
import { useSpecList } from "@/hooks/use-spec";
import type { Session } from "../../../types/chat";
import type { SpecSummary } from "../../../shared/spec-types";

const STAGE: Record<string, string> = { requirements: "Requirements", design: "Design", tasks: "Tasks", execution: "Tasks" };

export function SpecsSidebarPanel({ onNavigate }: { onNavigate?: () => void }) {
  const projectName = useProjectStore((s) => s.activeProject?.name ?? "");
  const { specs } = useSpecList(projectName);
  const [opening, setOpening] = useState<string | null>(null);

  const open = async (s: SpecSummary) => {
    if (s.sessionId) {
      await openSpecChat(projectName, s.sessionId, s.title);
      onNavigate?.();
      return;
    }
    setOpening(s.slug);
    try {
      const session = await api.post<Session>(`${projectUrl(projectName)}/chat/sessions`, { title: s.title });
      await specsApi.attachSession(projectName, s.slug, session.id);
      await openSpecChat(projectName, session.id, s.title, session.providerId);
      onNavigate?.();
    } catch (e) {
      toast.error("Could not open the spec", { description: (e as Error).message });
    } finally {
      setOpening(null);
    }
  };

  const newSpec = () => {
    useTabStore.getState().openTab({
      type: "chat", title: "New spec", projectId: projectName,
      metadata: { projectName, specStart: { workflow: "spec", startFrom: "requirements", checks: "standard" } }, closable: true,
    });
    onNavigate?.();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-specs-panel="">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Specs</span>
        <span className="flex-1" />
        <button type="button" onClick={newSpec} className="flex size-11 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground md:size-7" aria-label="New spec" title="New spec">
          <Plus className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {specs === null && <div className="flex justify-center p-4"><Loader2 className="size-4 animate-spin text-text-subtle" /></div>}
        {specs?.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-text-subtle">No specs yet. Start a chat and pick Spec, or press +.</p>
        )}
        {specs?.map((s) => (
          <button
            key={s.slug}
            type="button"
            onClick={() => void open(s)}
            className="flex w-full min-h-11 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover"
            title={`specs/${s.slug}/`}
          >
            {opening === s.slug ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-text-subtle" /> : <ClipboardList className="mt-0.5 size-4 shrink-0 text-text-subtle" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-text">{s.title}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-text-3">
                <span>{STAGE[s.current] ?? s.current}</span>
                {s.current === "execution" && s.tasksTotal > 0 && <span className="tabular-nums">· {s.tasksDone}/{s.tasksTotal}</span>}
                {s.checks === "thorough" && <FlaskConical className="size-3 text-success" aria-label="Thorough" />}
                {s.red > 0 && <span className="text-error">· {s.red} red</span>}
                <span className="truncate">· {formatRelativeDate(s.updatedAt)}</span>
              </span>
            </span>
            {s.waitingForYou && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-warning" title="Waiting for your approval" />}
          </button>
        ))}
      </div>
    </div>
  );
}
