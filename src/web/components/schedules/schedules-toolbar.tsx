/**
 * The Schedules window's filters: the project (every project by default), the chips with their
 * counts, a search over names, prompts, chats and tasks, and New. One line on a wide window that
 * wraps on a narrow one; on a phone the chips scroll sideways under the project and search.
 */
import { Plus, Search } from "@/lib/icons";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import { CHIP_LABELS, SCHEDULE_CHIPS, type ScheduleChip, type SchedulesFilter } from "@/lib/schedules/schedules-view";
import { CHIP, PRIMARY_BUTTON } from "./schedules-ui";

export function SchedulesToolbar({ filter, onFilter, projects, counts, onNew, phone }: {
  filter: SchedulesFilter;
  onFilter: (next: SchedulesFilter) => void;
  projects: string[];
  counts: Record<ScheduleChip, number>;
  onNew: () => void;
  phone?: boolean;
}) {
  const projectPicker = (
    <select
      aria-label="Project"
      value={filter.project ?? ""}
      onChange={(e) => onFilter({ ...filter, project: e.target.value || null })}
      className={cn("min-w-0 max-w-[180px] cursor-pointer rounded-md border border-border bg-bg px-2 text-xs text-foreground", TEXT_CONTROL_HEIGHT)}
    >
      <option value="">All projects</option>
      {projects.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  );
  const search = (
    <label className={cn("flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2 text-text-3", TEXT_CONTROL_HEIGHT, phone ? "flex-1" : "w-[200px]")}>
      <Search aria-hidden className="size-3.5 shrink-0" />
      <input
        type="search"
        aria-label="Search schedules"
        placeholder="Search"
        value={filter.query}
        onChange={(e) => onFilter({ ...filter, query: e.target.value })}
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-text-3"
      />
    </label>
  );
  const chips = SCHEDULE_CHIPS.map((chip) => (
    <button key={chip} type="button" data-chip={chip} aria-pressed={filter.chip === chip} className={CHIP}
      onClick={() => onFilter({ ...filter, chip })}>
      {CHIP_LABELS[chip]}
      <span className={cn("text-[10.5px]", filter.chip === chip ? "text-primary" : "text-text-3")}>{counts[chip]}</span>
    </button>
  ));
  const newButton = <button type="button" className={PRIMARY_BUTTON} onClick={onNew}><Plus />New</button>;

  if (phone) {
    return (
      <div className="flex flex-col gap-2 px-2.5 pb-2 pt-2">
        <div className="flex items-center gap-1.5">{projectPicker}{search}{newButton}</div>
        <div className="-mx-2.5 flex gap-1.5 overflow-x-auto px-2.5 scrollbar-none">{chips}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pt-2.5">
      {projectPicker}
      {chips}
      <span className="flex-1" />
      {search}
      {newButton}
    </div>
  );
}
