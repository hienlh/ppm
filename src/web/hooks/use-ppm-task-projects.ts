/**
 * Projects as the task views see them: every registered project with its switch, manager and
 * counts, and one project's task settings (statuses, members, fields, check interval). Both are
 * re-read when PPM says a project's tasks or settings changed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ppmTasksClient } from "@/lib/ppm-tasks/ppm-tasks-client";
import type { TaskProjectSettings, TaskProjectSettingsUpdate, TaskProjectSummary } from "../../shared/ppm-tasks-api";

const CHANGE_EVENTS = ["tasks:changed", "tasks:project_changed"] as const;

function useOnTaskEvents(load: () => void, project?: string | null): void {
  useEffect(() => {
    const on = (event: Event) => {
      const d = (event as CustomEvent<{ project?: string }>).detail;
      if (!project || d?.project === project) load();
    };
    for (const type of CHANGE_EVENTS) window.addEventListener(type, on);
    return () => { for (const type of CHANGE_EVENTS) window.removeEventListener(type, on); };
  }, [load, project]);
}

/** Every registered project with its task switch and counts. */
export function usePpmTaskProjects() {
  const [projects, setProjects] = useState<TaskProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    ppmTasksClient.projects()
      .then((p) => { setProjects(p); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useOnTaskEvents(load);
  return { projects, enabled: projects.filter((p) => p.enabled), loading, error, refresh: load };
}

/** One project's task settings, and saving them (the answer replaces what is shown). */
export function usePpmTaskProjectSettings(project: string | null) {
  const [settings, setSettings] = useState<TaskProjectSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const load = useCallback(() => {
    const n = ++asked.current;
    if (!project) { setSettings(null); return; }
    // Only the latest read lands: a slow answer for the previous project is dropped.
    ppmTasksClient.settings(project)
      .then((s) => { if (n === asked.current) { setSettings(s); setError(null); } })
      .catch((e: Error) => { if (n === asked.current) setError(e.message); });
  }, [project]);
  useEffect(load, [load]);
  useOnTaskEvents(load, project);
  const save = useCallback(async (update: TaskProjectSettingsUpdate) => {
    if (!project) return null;
    const next = await ppmTasksClient.saveSettings(project, update);
    ++asked.current; // a read sent before the save would show the old settings
    setSettings(next);
    return next;
  }, [project]);
  return { settings, error, save, refresh: load };
}
