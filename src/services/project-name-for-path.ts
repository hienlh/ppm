import { configService } from "./config.service.ts";
import { projectKey } from "./project-key.ts";

export { projectKey };

/** Registered project whose folder is `projectPath`, or null. Case-folded on Windows. */
export function projectNameForPath(projectPath: string): string | null {
  const target = projectKey(projectPath);
  return configService.get("projects").find((p) => projectKey(p.path) === target)?.name ?? null;
}
