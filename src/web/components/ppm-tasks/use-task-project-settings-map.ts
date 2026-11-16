/**
 * Task settings (statuses, members, fields) for several projects at once: the list needs every
 * project it shows to name people and statuses. One read per project, re-read when PPM says that
 * project's tasks or settings changed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ppmTasksClient } from "@/lib/ppm-tasks/ppm-tasks-client";
import type { TaskProjectSettings } from "../../../shared/ppm-tasks-api";

export type SettingsMap = Record<string, TaskProjectSettings>;

export function useTaskProjectSettingsMap(projects: readonly string[]): SettingsMap {
  const key = [...projects].sort().join("\u0000");
  const [map, setMap] = useState<SettingsMap>({});
  const alive = useRef(true);
  // Set in the effect, not only at creation: StrictMode unmounts and remounts once in development.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback((names: readonly string[]) => {
    for (const name of names) {
      ppmTasksClient.settings(name)
        .then((s) => { if (alive.current) setMap((m) => ({ ...m, [name]: s })); })
        .catch(() => { /* a project switched off or gone: its rows show raw ids */ });
    }
  }, []);
  useEffect(() => { if (key) load(key.split("\u0000")); }, [key, load]);
  useEffect(() => {
    const on = (e: Event) => {
      const p = (e as CustomEvent<{ project?: string; type?: string }>).detail?.project;
      if (p && key.split("\u0000").includes(p) && e.type === "tasks:project_changed") load([p]);
    };
    window.addEventListener("tasks:project_changed", on);
    return () => window.removeEventListener("tasks:project_changed", on);
  }, [key, load]);
  return map;
}
