/**
 * Task store changes out to every open PPM over `/ws/global`, as ids only: each view re-reads what
 * it shows. Changes are gathered per project for 100 ms, so an AI updating twenty tasks in a row
 * sends one `tasks:changed` with twenty ids rather than twenty pushes. A project PPM no longer
 * has registered (no name to show it under) is not announced.
 */
import { ppmTasksEvents, type PpmTasksEvent } from "../../services/ppm-tasks/ppm-tasks-events.ts";
import { getTaskProject } from "../../services/ppm-tasks/ppm-tasks-projects.service.ts";
import { projectNameForPath } from "../../services/project-name-for-path.ts";
import type { TasksGlobalEvent } from "../../shared/ppm-tasks-api.ts";
import { broadcastGlobalEvent } from "./global.ts";

export const TASKS_BROADCAST_DELAY_MS = 100;

interface Pending {
  taskIds: Set<string>;
  project: boolean;
  linkStates: boolean;
}

export interface PpmTasksBroadcasterEnv {
  send(event: TasksGlobalEvent): void;
  /** The project's PPM name, or null when PPM does not know it any more. */
  nameOf(projectKey: string): string | null;
  delayMs: number;
}

const liveEnv: PpmTasksBroadcasterEnv = {
  send: broadcastGlobalEvent,
  nameOf: (projectKey) => {
    const path = getTaskProject(projectKey)?.projectPath;
    return path ? projectNameForPath(path) : null;
  },
  delayMs: TASKS_BROADCAST_DELAY_MS,
};

export function createPpmTasksBroadcaster(env: PpmTasksBroadcasterEnv = liveEnv) {
  const pending = new Map<string, Pending>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function entry(projectKey: string): Pending {
    let p = pending.get(projectKey);
    if (!p) pending.set(projectKey, p = { taskIds: new Set(), project: false, linkStates: false });
    return p;
  }

  function flush(): void {
    timer = null;
    const batch = [...pending];
    pending.clear();
    for (const [projectKey, p] of batch) {
      const project = env.nameOf(projectKey);
      if (!project) continue;
      if (p.project) env.send({ type: "tasks:project_changed", project });
      if (p.taskIds.size > 0) env.send({ type: "tasks:changed", project, taskIds: [...p.taskIds] });
      if (p.linkStates) env.send({ type: "tasks:link_states", project });
    }
  }

  function handle(event: PpmTasksEvent): void {
    if (event.type === "task") for (const id of event.taskIds) entry(event.projectKey).taskIds.add(id);
    else if (event.type === "project") entry(event.projectKey).project = true;
    else for (const key of event.projectKeys) entry(key).linkStates = true;
    if (!timer) {
      timer = setTimeout(flush, env.delayMs);
      timer.unref?.();
    }
  }

  let unsubscribe: (() => void) | null = null;
  return {
    handle,
    flush,
    start(): void {
      unsubscribe ??= ppmTasksEvents.on(handle);
    },
    stop(): void {
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

let live: ReturnType<typeof createPpmTasksBroadcaster> | null = null;

/** Starts pushing task changes to `/ws/global`; once per process. */
export function startPpmTasksBroadcast(): void {
  live ??= createPpmTasksBroadcaster();
  live.start();
}
