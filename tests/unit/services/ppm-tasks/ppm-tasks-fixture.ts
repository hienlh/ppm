/**
 * Shared set-up for the task store tests: a fresh in-memory database per test (with every
 * migration applied), one switched-on project, and the write contexts tests act as.
 */
import { openTestDb, setDb, setSessionMetadata } from "../../../../src/services/db.service.ts";
import { setTasksEnabled } from "../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { listStatuses } from "../../../../src/services/ppm-tasks/ppm-tasks-project-config.ts";
import type { TaskStatusDef, WriteContext } from "../../../../src/shared/ppm-tasks.ts";

export const PROJECT_PATH = process.platform === "win32" ? "C:\\work\\demo" : "/work/demo";

export const USER: WriteContext = { actor: { kind: "user", label: "You" }, via: "ppm" };
export const MANAGER: WriteContext = { actor: { kind: "manager", sessionId: "mgr-1", label: "Manager demo" }, via: "tool" };
export const ASSISTANT: WriteContext = { actor: { kind: "assistant", sessionId: "asst-1", label: "Assistant" }, via: "tool" };

export interface Fixture {
  projectKey: string;
  statuses: TaskStatusDef[];
  status(name: string): TaskStatusDef;
}

/** Registers `id` as a PPM chat of the fixture project (or of `path`). */
export function chatOf(id: string, path: string = PROJECT_PATH): string {
  setSessionMetadata(id, "demo", path);
  return id;
}

/** A fresh database with one project whose store is on. */
export function freshProject(): Fixture {
  setDb(openTestDb());
  const project = setTasksEnabled(PROJECT_PATH, true, USER);
  const statuses = listStatuses(project.projectKey);
  return {
    projectKey: project.projectKey,
    statuses,
    status: (name) => {
      const found = statuses.find((s) => s.name === name);
      if (!found) throw new Error(`no status ${name}`);
      return found;
    },
  };
}
