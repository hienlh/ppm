/**
 * The Tasks section's header row: "Tasks", New task, Search (opens a search field under it, which
 * also takes a task's code: `#82` or `ppm/82` jumps to that task), and
 * ··· with Task settings…, Filter by field (the project's declared select and date fields),
 * Clear filters, and Turn off tasks for <project>.
 */
import { ListTodo, MoreHorizontal, Plus, Search, X } from "@/lib/icons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTaskViewStore } from "@/stores/ppm-tasks-view-store";
import type { FieldDef } from "../../../shared/ppm-tasks";

const iconBtn = "grid size-7 max-md:size-11 place-items-center rounded-md text-text-3 hover:bg-surface-hover hover:text-text disabled:opacity-40";

export interface TasksSidebarHeaderProps {
  /** The project the settings and the switch act on; null in all-projects with no active project. */
  project: string | null;
  enabled: boolean;
  /** Declared fields that can be filtered on, with the values seen in the list. */
  filterFields: Array<{ def: FieldDef; values: string[] }>;
  onNewTask(): void;
  onSettings(): void;
  onTurnOff(): void;
  /** Enter in the search field: opens the task a code (`#82`, `ppm/82`) names. */
  onSubmitSearch?(): void;
}

export function TasksSidebarHeader({ project, enabled, filterFields, onNewTask, onSettings, onTurnOff, onSubmitSearch }: TasksSidebarHeaderProps) {
  const { searchOpen, query, setSearchOpen, setQuery, setFilters, clearFilters } = useTaskViewStore();
  return (
    <div className="sticky top-0 z-10 bg-panel">
      <div className="flex h-9 items-center gap-0.5 pl-3 pr-1.5 max-md:h-12 max-md:pl-4 max-md:pr-1">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-2 max-md:text-base max-md:normal-case max-md:tracking-normal max-md:text-text">
          <ListTodo aria-hidden className="size-3.5" />Tasks
        </span>
        <button type="button" className={iconBtn} title="New task" aria-label="New task" disabled={!enabled} onClick={onNewTask}><Plus className="size-3.5" /></button>
        <button type="button" className={iconBtn} title="Search" aria-label="Search tasks" aria-pressed={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><Search className="size-3.5" /></button>
        <DropdownMenu>
          <DropdownMenuTrigger className={iconBtn} title="More" aria-label="More task actions"><MoreHorizontal className="size-3.5" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem disabled={!project} onSelect={onSettings}>Task settings…</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={filterFields.length === 0}>Filter by field</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                {filterFields.map(({ def, values }) => (
                  <div key={def.key}>
                    <DropdownMenuLabel className="text-xs text-text-3">{def.label}</DropdownMenuLabel>
                    {values.length === 0 && <DropdownMenuItem disabled>No values yet</DropdownMenuItem>}
                    {values.map((v) => <DropdownMenuItem key={v} onSelect={() => setFilters({ field: { key: def.key, value: v } })}>{v}</DropdownMenuItem>)}
                  </div>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={clearFilters}>Clear filters</DropdownMenuItem>
            {project && enabled && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onTurnOff}>Turn off tasks for {project}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {searchOpen && (
        <div className="relative px-2.5 pb-1.5">
          <Search aria-hidden className="pointer-events-none absolute left-5 top-2 size-3.5 text-text-3 max-md:top-[15px]" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, or #12 to jump to a task"
            onKeyDown={(e) => { if (e.key === "Escape") setSearchOpen(false); if (e.key === "Enter") { e.preventDefault(); onSubmitSearch?.(); } }} aria-label="Search tasks"
            className="h-8 max-md:h-11 max-md:text-base w-full rounded-md border border-border-soft bg-surface pl-7 pr-7 text-xs text-text outline-none placeholder:text-text-3 focus:border-ring" />
          {query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-4 top-1.5 grid size-5 place-items-center rounded text-text-3 hover:text-text max-md:right-2.5 max-md:top-0 max-md:size-11"><X className="size-3" /></button>}
        </div>
      )}
    </div>
  );
}
