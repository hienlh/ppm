/**
 * The one PPM Tasks store of the page (logic in `lib/ppm-tasks/ppm-tasks-store-core.ts`). It
 * follows `/ws/global`: `tasks:changed` re-reads the shown lists and details it names,
 * `tasks:project_changed` everything of that project, and a reconnect everything shown, since a
 * change announced while the socket was down never arrived. Link states have their own hook.
 */
import { toast } from "sonner";
import { useStore } from "zustand";
import { ppmTasksClient } from "@/lib/ppm-tasks/ppm-tasks-client";
import { createPpmTasksStore, type PpmTasksActions, type PpmTasksState } from "@/lib/ppm-tasks/ppm-tasks-store-core";
import type { TasksGlobalEvent } from "../../shared/ppm-tasks-api";

export const ppmTasksStore = createPpmTasksStore({ client: ppmTasksClient, toast: (m) => toast.info(m) });

export function usePpmTasksStore<T>(selector: (s: PpmTasksState & PpmTasksActions) => T): T {
  return useStore(ppmTasksStore, selector);
}

let following = false;

/** Starts following task events; a no-op after the first call. */
export function ensurePpmTasksEvents(): void {
  if (following || typeof window === "undefined") return;
  following = true;
  window.addEventListener("tasks:changed", (event) => {
    const d = (event as CustomEvent<Extract<TasksGlobalEvent, { type: "tasks:changed" }>>).detail;
    if (d && typeof d.project === "string" && Array.isArray(d.taskIds)) ppmTasksStore.getState().onTasksChanged(d.project, d.taskIds);
  });
  window.addEventListener("tasks:project_changed", (event) => {
    const d = (event as CustomEvent<Extract<TasksGlobalEvent, { type: "tasks:project_changed" }>>).detail;
    if (d && typeof d.project === "string") ppmTasksStore.getState().onProjectChanged(d.project);
  });
}

/** After a `/ws/global` reconnect: re-read what is shown, forget what is not. */
export function resyncPpmTasks(): void {
  if (following) ppmTasksStore.getState().resync();
}
