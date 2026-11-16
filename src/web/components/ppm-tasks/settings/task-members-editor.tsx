/**
 * A project's people: a name and the Jira, GitHub and Slack accounts that tie a ticket's assignee
 * or a PR's reviewer to them. Archived members stay readable on old tasks.
 */
import { Archive, Plus, RotateCcw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskMember } from "../../../../shared/ppm-tasks";
import type { TaskProjectSettingsUpdate } from "../../../../shared/ppm-tasks-api";
import { CommitInput, EditorHint, rowBtn } from "./task-settings-parts";

type MemberPatch = Partial<Pick<TaskMember, "name" | "jiraAccountId" | "githubLogin" | "slackUserId">> & { archived?: boolean };

export function TaskMembersEditor({ members, save }: { members: TaskMember[]; save(u: TaskProjectSettingsUpdate): void }) {
  const sorted = [...members].sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.position - b.position);
  const set = (id: string, patch: MemberPatch) => save({ members: { update: [{ id, ...patch }] } });
  return (
    <div className="space-y-2" data-task-members-editor="">
      <EditorHint>You are always a member; add the people tasks wait on or are assigned to.</EditorHint>
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5 px-0.5 text-[10.5px] font-medium uppercase tracking-wide text-text-3">
        <span>Name</span><span>Jira account id</span><span>GitHub login</span><span>Slack id</span><span className="w-8" />
      </div>
      {sorted.map((m) => (
        <div key={m.id} className={cn("grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5", m.archivedAt && "opacity-60")}>
          <CommitInput label="Name" value={m.name} required onCommit={(name) => set(m.id, { name })} />
          <CommitInput label="Jira account id" value={m.jiraAccountId ?? ""} onCommit={(v) => set(m.id, { jiraAccountId: v || null })} />
          <CommitInput label="GitHub login" value={m.githubLogin ?? ""} onCommit={(v) => set(m.id, { githubLogin: v || null })} />
          <CommitInput label="Slack id" value={m.slackUserId ?? ""} onCommit={(v) => set(m.id, { slackUserId: v || null })} />
          <button type="button" className={rowBtn} aria-label={m.archivedAt ? `Restore ${m.name}` : `Archive ${m.name}`} title={m.archivedAt ? "Restore" : "Archive"}
            onClick={() => set(m.id, { archived: !m.archivedAt })}>
            {m.archivedAt ? <RotateCcw className="size-3.5" /> : <Archive className="size-3.5" />}
          </button>
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => save({ members: { add: [{ name: "New member" }] } })}><Plus className="size-3.5" />Add member</Button>
    </div>
  );
}
