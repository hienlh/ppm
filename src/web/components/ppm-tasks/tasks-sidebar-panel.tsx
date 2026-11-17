/**
 * The Tasks section of the project sidebar (variant-3 screen 01), on a desktop and in the phone
 * drawer. It owns the data (one list query per scope and filters, the projects' settings, live
 * link states) and the actions; the list it renders only draws. Selecting a row opens the task
 * (`openTask`: its window on a desktop, a sheet on a phone), and the selection follows the task tab
 * that is active. Searching for a code
 * the chats use (`#82`, `ppm/82`) shows that one task and jumps to it.
 *
 * Below `md` the phone list draws the same props (`mobile/task-list-mobile.tsx`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTaskViewStore } from "@/stores/ppm-tasks-view-store";
import { ppmTasksStore, usePpmTasksStore } from "@/stores/ppm-tasks-store";
import { usePpmTaskLinkStates, usePpmTaskList } from "@/hooks/use-ppm-tasks";
import { usePpmTaskProjects } from "@/hooks/use-ppm-task-projects";
import { ppmTasksClient } from "@/lib/ppm-tasks/ppm-tasks-client";
import { childProgress, countingQueryFor, groupTasks, listQueryFor, visibleTasks } from "@/lib/ppm-tasks/task-list-view";
import { openTaskChat, workingProvider } from "@/lib/ppm-tasks/open-task-tab";
import { openTask } from "@/lib/ppm-tasks/open-task";
import { taskIdOfTab } from "@/lib/ppm-tasks/task-tab-preview";
import { lookupTasksByCode, tasksMatchingCode } from "@/lib/ppm-tasks/task-code-lookup";
import { parseTaskCodeQuery } from "../../../shared/ppm-tasks-refs";
import type { TaskMember } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { TaskListDesktop } from "./task-list-desktop";
import { TaskListFilters } from "./task-list-filters";
import { TasksSidebarHeader } from "./tasks-sidebar-header";
import { TasksOffEmptyState } from "./tasks-off-empty-state";
import { TaskNewDialog } from "./task-new-dialog";
import { TaskProjectSettingsDialog } from "./settings/task-project-settings-dialog";
import { TaskManagerPromptHost } from "./task-manager-prompt-toast";
import { useTaskConfirm } from "./task-confirm-dialog";
import { useTaskWrite } from "./use-task-write";
import { useTaskProjectSettingsMap } from "./use-task-project-settings-map";
import type { TaskListViewProps } from "./task-list-view-props";
import { TaskListMobile } from "./mobile/task-list-mobile";

export function TasksSidebarPanel({ onNavigate }: { onNavigate?: () => void }) {
  const isMobile = useIsMobile();
  const ListView: (p: TaskListViewProps) => React.ReactNode = isMobile ? TaskListMobile : TaskListDesktop;
  const activeProject = useProjectStore(useShallow((s) => s.activeProject?.name ?? null));
  const { scope, filters, query, hiddenProjects } = useTaskViewStore(useShallow((s) => ({ scope: s.scope, filters: s.filters, query: s.query, hiddenProjects: s.hiddenProjects })));
  const { projects, refresh: refreshProjects } = usePpmTaskProjects();
  const own = projects.find((p) => p.name === activeProject) ?? null;
  const enabledProjects = useMemo(() => projects.filter((p) => p.enabled), [projects]);
  const showList = scope === "all" ? enabledProjects.length > 0 : !!own?.enabled;

  // Typing in search asks the server once it pauses, not on every key.
  const [searched, setSearched] = useState(query);
  useEffect(() => { const t = setTimeout(() => setSearched(query), 250); return () => clearTimeout(t); }, [query]);
  // A code search (`#82`, `ppm/82`) asks for the whole scope and picks one task out of it, so it
  // need not wait for the pause.
  // While the pause runs out after leaving a code (`#82` → `#82x`), the filtered list without text
  // stands in, rather than the whole scope a code asks for.
  const codeQuery = parseTaskCodeQuery(query) ? query : "";
  const listQuery = showList ? listQueryFor(scope, activeProject, filters, codeQuery || (parseTaskCodeQuery(searched) ? "" : searched)) : null;
  const { tasks, loading, error } = usePpmTaskList(listQuery);
  // Child progress and the tag/field pickers count the whole scope, not what the filters let
  // through (a status filter would otherwise turn 1/3 into 0/2). Same request when no filter is on.
  const counting = usePpmTaskList(showList ? countingQueryFor(scope, activeProject) : null);
  const everyTask = counting.loading || counting.error ? tasks : counting.tasks;
  const filtersOn = !!(filters.groups.length || filters.types.length || filters.person || filters.tag || filters.field || query.trim());
  const shown = useMemo(() => visibleTasks(tasks, filters, hiddenProjects, scope, codeQuery), [tasks, filters, hiddenProjects, scope, codeQuery]);

  const activeTaskId = useTabStore((s) => { const t = s.tabs.find((x) => x.id === s.activeTabId); return t ? taskIdOfTab(t) : null; });
  const storeSelected = usePpmTasksStore((s) => s.selectedId);
  const selectedId = activeTaskId ?? storeSelected;
  const expanded = useMemo(() => {
    const sel = shown.find((t) => t.id === selectedId);
    return new Set([selectedId, sel?.parentId].filter((x): x is string => !!x));
  }, [shown, selectedId]);
  const groups = useMemo(() => groupTasks(shown, expanded), [shown, expanded]);
  const progress = useMemo(() => childProgress(everyTask), [everyTask]);

  const shownProjects = useMemo(() => (scope === "all" ? enabledProjects.map((p) => p.name) : activeProject && own?.enabled ? [activeProject] : []), [scope, enabledProjects, activeProject, own]);
  const settings = useTaskProjectSettingsMap(shownProjects);
  const live = usePpmTaskLinkStates(useMemo(() => shown.map((t) => t.id), [shown]), scope === "all" ? "all" : activeProject);

  const [confirm, confirmElement] = useTaskConfirm();
  const write = useTaskWrite(confirm);
  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const onSelect = useCallback((task: TaskDto, keep: boolean) => {
    ppmTasksStore.getState().select(task.id);
    // A window on a desktop, a sheet on a phone: the drawer stays open under the sheet, so
    // closing it goes back to the list.
    openTask(task, { keep });
  }, []);
  const onOpenChat = useCallback((task: TaskDto, sessionId: string) => {
    const now = { ...task, workingSession: live[task.id]?.workingSession ?? task.workingSession };
    openTaskChat(task.project, sessionId, workingProvider(now), now);
    onNavigate?.();
  }, [live, onNavigate]);
  const onStartChat = useCallback((task: TaskDto) => void write.startChat(task), [write]);

  // A code that names one task in the list previews it at once on a desktop (the search field keeps
  // the focus); Enter keeps its tab. A phone waits for Enter: opening the task closes the drawer.
  // Only a code typed here jumps: one still in the search when the panel comes back, or when the
  // project changes under it, opens nothing by itself.
  const contextProject = scope === "all" ? null : activeProject;
  const code = codeQuery ? parseTaskCodeQuery(codeQuery) : null;
  const codeMatch = code && !loading ? tasksMatchingCode(shown, code, contextProject) : [];
  const jumpTo = codeMatch.length === 1 ? codeMatch[0]! : null;
  const lastQuery = useRef(query);
  const jumpPending = useRef(false);
  useEffect(() => {
    if (query === lastQuery.current) return;
    lastQuery.current = query;
    jumpPending.current = !!parseTaskCodeQuery(query);
  }, [query]);
  useEffect(() => {
    if (!jumpPending.current || !jumpTo || isMobile) return;
    jumpPending.current = false;
    ppmTasksStore.getState().select(jumpTo.id);
    openTask(jumpTo);
  }, [jumpTo, isMobile, query]);
  // `beta/3` typed in alpha's list names a task the list cannot hold: Enter looks it up.
  const codeNamesElsewhere = !!code?.project && code.project.toLowerCase() !== contextProject?.toLowerCase();
  const onSubmitSearch = useCallback(async () => {
    const typed = parseTaskCodeQuery(query);
    if (!typed) return;
    if (codeMatch.length > 1) {
      toast.error(`${codeMatch.length} projects have a task ${query.trim()}: type it as project/${typed.number}`);
      return;
    }
    const found = codeMatch[0] ?? (typed.project ? (await lookupTasksByCode(query, contextProject))?.[0] : undefined);
    if (found) onSelect(found, true);
    else toast.error(`No task ${query.trim()}${contextProject && !typed.project ? ` in ${contextProject}` : ""}`);
  }, [query, codeMatch, contextProject, onSelect]);
  const onMove = useCallback<TaskListViewProps["onMove"]>((task, to) => {
    void write.run(null, () => ("urgency" in to ? write.actions.update(task, { urgency: to.urgency }) : write.actions.reorder(task, to.reorder)));
  }, [write]);

  const turnOff = useCallback(async () => {
    if (!activeProject) return;
    const yes = await confirm({
      title: `Turn off tasks for ${activeProject}?`,
      body: "Its tasks are hidden from PPM, the AI tools and Telegram. Nothing is deleted: turning tasks back on shows them again.",
      confirmLabel: "Turn off", destructive: true,
    });
    if (yes) { await ppmTasksClient.saveSettings(activeProject, { enabled: false }); refreshProjects(); }
  }, [activeProject, confirm, refreshProjects]);

  const members = useMemo(() => {
    const byId = new Map<string, TaskMember>();
    for (const s of Object.values(settings)) for (const m of s.members) if (!byId.has(m.id)) byId.set(m.id, m);
    return [...byId.values()];
  }, [settings]);
  const tags = useMemo(() => [...new Set(everyTask.flatMap((t) => t.tags))].sort(), [everyTask]);
  const filterFields = useMemo(() => {
    const defs = activeProject ? settings[activeProject]?.fieldDefs ?? [] : [];
    return defs.filter((d) => d.type === "select" || d.type === "date").map((def) => ({
      def,
      values: def.type === "select" && def.options?.length ? def.options : [...new Set(everyTask.map((t) => t.fields[def.key]).filter((v) => v != null).map(String))].sort(),
    }));
  }, [activeProject, settings, everyTask]);

  const settingsProject = activeProject && projects.some((p) => p.name === activeProject) ? activeProject : null;

  return (
    <div className="flex min-h-full flex-col" data-tasks-panel="">
      <TasksSidebarHeader project={settingsProject} enabled={showList} filterFields={filterFields} onSubmitSearch={() => void onSubmitSearch()}
        onNewTask={() => setNewOpen(true)} onSettings={() => setSettingsOpen(true)} onTurnOff={() => void turnOff()} />
      <TaskListFilters project={activeProject} projects={enabledProjects} members={members} tags={tags} />
      {!activeProject && scope === "project" ? (
        <p className="px-4 py-8 text-center text-xs text-text-3">Select a project to see its tasks</p>
      ) : scope === "project" && own && !own.enabled ? (
        <TasksOffEmptyState project={own.name} hasManager={own.hasManager}
          onTurnOn={async () => { await ppmTasksClient.saveSettings(own.name, { enabled: true }); refreshProjects(); }} />
      ) : scope === "all" && enabledProjects.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-text-3">No project has tasks turned on yet</p>
      ) : error ? (
        <p className="px-4 py-6 text-center text-xs text-error">{error}</p>
      ) : loading ? (
        <p className="px-4 py-6 text-center text-xs text-text-3">Loading tasks…</p>
      ) : shown.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-text-3">
          {codeQuery ? (codeNamesElsewhere ? `${codeQuery.trim()} is not in this list. Press Enter to open it.` : `No task ${codeQuery.trim()} here.`) : tasks.length || filtersOn ? "No task matches these filters" : "No tasks yet. Add one with +, or ask a chat to."}
          {filtersOn && <button type="button" onClick={() => { useTaskViewStore.getState().clearFilters(); useTaskViewStore.getState().setQuery(""); }} className="mt-2 block w-full text-primary hover:underline">Clear filters</button>}
        </div>
      ) : (
        <ListView groups={groups} progress={progress} showProject={scope === "all"} selectedId={selectedId} settings={settings} live={live}
          onSelect={onSelect} onOpenChat={onOpenChat} onStartChat={onStartChat} onMove={onMove} />
      )}
      <TaskNewDialog open={newOpen} onOpenChange={setNewOpen} scope={scope} project={activeProject} projects={enabledProjects}
        onCreated={(task) => onSelect(task, true)} />
      {settingsProject && <TaskProjectSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} project={settingsProject} />}
      {confirmElement}
      <TaskManagerPromptHost />
    </div>
  );
}
