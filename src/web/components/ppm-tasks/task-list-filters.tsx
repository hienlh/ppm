/**
 * The Tasks list's tools under the header: the `<project> | All projects` switch, the project
 * chips with their counts (all-projects scope; a chip off leaves that project out), and the filter
 * chips "Waiting on you", Type, status group (default "Open"), Person, Tag, plus a declared field filter when one is
 * set from ··· "Filter by field". Filter state lives in `ppm-tasks-view-store` (per device).
 */
import type { ReactNode } from "react";
import { ChevronDown, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { typeLabel } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { useTaskViewStore, type TaskScope } from "@/stores/ppm-tasks-view-store";
import { ME_MEMBER_ID, TASK_TYPES, type BaseGroup, type TaskMember } from "../../../shared/ppm-tasks";
import type { TaskProjectSummary } from "../../../shared/ppm-tasks-api";
import { TaskWaitingOnMeToggle } from "./kit/task-waiting-on-me-toggle";

const GROUP_LABEL: Record<BaseGroup, string> = { not_started: "Not started", active: "Active", waiting: "Waiting", closed: "Closed" };

export function groupFilterLabel(groups: readonly BaseGroup[]): string {
  if (groups.length === 0) return "Open";
  if (groups.length === 1) return GROUP_LABEL[groups[0]!];
  return `${groups.length} groups`;
}

function Chip({ on, children, onClear }: { on: boolean; children: ReactNode; onClear?: () => void }) {
  return (
    <span className={cn("inline-flex max-w-full items-center rounded-full border text-xs", TEXT_CONTROL_HEIGHT,
      on ? "border-accent-wash-border bg-accent-wash text-primary" : "border-border-soft text-text-2")}>
      <DropdownMenuTrigger className="inline-flex h-full min-w-0 items-center gap-1 rounded-full pl-2.5 pr-2 outline-none hover:text-text">
        {children}<ChevronDown aria-hidden className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      {onClear && on && (
        <button type="button" aria-label="Clear filter" onClick={onClear} className="-ml-1 mr-1 grid size-5 max-md:size-[22px] place-items-center rounded-full hover:bg-surface-hover">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

export interface TaskListFiltersProps {
  project: string | null;
  projects: readonly TaskProjectSummary[];
  /** Members of the shown projects, deduped by id ("You" is added here). */
  members: readonly TaskMember[];
  tags: readonly string[];
  /** Open tasks waiting on the user in the scope, for the "Waiting on you" chip. */
  waitingOnMe: number;
}

export function TaskListFilters({ project, projects, members, tags, waitingOnMe }: TaskListFiltersProps) {
  const { scope, filters: f, hiddenProjects, setScope, setFilters, toggleProject } = useTaskViewStore();
  const scopeBtn = (s: TaskScope, label: ReactNode) => (
    <button type="button" role="tab" aria-selected={scope === s} onClick={() => setScope(s)}
      className={cn("h-7 min-w-0 flex-1 truncate rounded-md px-2 text-xs max-md:h-11 max-md:text-sm", scope === s ? "bg-panel font-medium text-text shadow-sm" : "text-text-2 hover:text-text")}>
      {label}
    </button>
  );
  const person = f.person ? (f.person === ME_MEMBER_ID ? "You" : members.find((m) => m.id === f.person)?.name ?? "Person") : "Person";
  return (
    <div className="space-y-2 px-2.5 pb-2 pt-1">
      <div role="tablist" aria-label="Scope" className="flex gap-1 rounded-lg bg-surface p-0.5">
        {scopeBtn("project", project ?? "This project")}
        {scopeBtn("all", "All projects")}
      </div>
      {scope === "all" && projects.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Projects">
          {projects.map((p) => {
            const on = !hiddenProjects.includes(p.name);
            return (
              <button key={p.name} type="button" aria-pressed={on} onClick={() => toggleProject(p.name)}
                className={cn(TEXT_CONTROL_HEIGHT, "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 text-xs",
                  on ? "border-accent-wash-border bg-accent-wash text-primary" : "border-border-soft text-text-3 line-through")}>
                <span className="truncate">{p.name}</span><span className="font-mono text-[10.5px] opacity-80">{p.open}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <TaskWaitingOnMeToggle on={!!f.waitingOnMe} count={waitingOnMe} onToggle={() => setFilters({ waitingOnMe: !f.waitingOnMe })} />
        <DropdownMenu>
          <Chip on={f.types.length > 0} onClear={() => setFilters({ types: [] })}>{f.types.length ? f.types.map(typeLabel).join(", ") : "Type"}</Chip>
          <DropdownMenuContent align="start">
            {TASK_TYPES.map((t) => (
              <DropdownMenuCheckboxItem key={t} checked={f.types.includes(t)} onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => setFilters({ types: on ? [...f.types, t] : f.types.filter((x) => x !== t) })}>{typeLabel(t)}</DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Chip on={f.groups.length > 0}>{groupFilterLabel(f.groups)}</Chip>
          <DropdownMenuContent align="start">
            <DropdownMenuCheckboxItem checked={f.groups.length === 0} onCheckedChange={() => setFilters({ groups: [] })}>Open (not closed)</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {(Object.keys(GROUP_LABEL) as BaseGroup[]).map((g) => (
              <DropdownMenuCheckboxItem key={g} checked={f.groups.includes(g)} onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => setFilters({ groups: on ? [...f.groups, g] : f.groups.filter((x) => x !== g) })}>{GROUP_LABEL[g]}</DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Chip on={!!f.person} onClear={() => setFilters({ person: null })}>{person}</Chip>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuLabel className="text-xs text-text-3">Assignee or waiting on</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={f.person ?? ""} onValueChange={(v) => setFilters({ person: v || null })}>
              <DropdownMenuRadioItem value="">Anyone</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value={ME_MEMBER_ID}>You</DropdownMenuRadioItem>
              {members.filter((m) => !m.archivedAt).map((m) => <DropdownMenuRadioItem key={m.id} value={m.id}>{m.name}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Chip on={!!f.tag} onClear={() => setFilters({ tag: null })}>{f.tag ?? "Tag"}</Chip>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {tags.length === 0 && <DropdownMenuLabel className="text-xs font-normal text-text-3">No tags on these tasks</DropdownMenuLabel>}
            <DropdownMenuRadioGroup value={f.tag ?? ""} onValueChange={(v) => setFilters({ tag: v || null })}>
              {tags.length > 0 && <DropdownMenuRadioItem value="">Any tag</DropdownMenuRadioItem>}
              {tags.map((t) => <DropdownMenuRadioItem key={t} value={t}>{t}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {f.field && (
          <span className={cn(TEXT_CONTROL_HEIGHT, "inline-flex max-w-full items-center gap-1 rounded-full border border-accent-wash-border bg-accent-wash pl-2.5 pr-1 text-xs text-primary")}>
            <span className="truncate">{f.field.key}: {f.field.value}</span>
            <button type="button" aria-label="Clear field filter" onClick={() => setFilters({ field: null })} className="grid size-5 max-md:size-[22px] place-items-center rounded-full hover:bg-surface-hover"><X className="size-3" /></button>
          </span>
        )}
      </div>
    </div>
  );
}
