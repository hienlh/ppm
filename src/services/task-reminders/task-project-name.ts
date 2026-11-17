/** The project a task store key belongs to, by its registered name (else its folder's last part). */
import { basename } from "node:path";
import { getTaskProject } from "../ppm-tasks/ppm-tasks-projects.service.ts";
import { projectNameForPath } from "../project-name-for-path.ts";

export function taskProjectName(projectKey: string): string {
  const path = getTaskProject(projectKey)?.projectPath ?? projectKey;
  let name: string | null = null;
  // A config that cannot be read names no project; the folder still does.
  try { name = projectNameForPath(path); } catch { /* unreadable config */ }
  return name ?? basename(path);
}
