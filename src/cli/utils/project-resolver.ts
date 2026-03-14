import { resolve } from "node:path";
import { projectService } from "../../services/project.service.ts";
import type { ProjectConfig } from "../../types/config.ts";

/**
 * CLI project resolver: CWD auto-detect + `-p` flag override.
 * Used by CLI commands that operate on a specific project.
 */
export function resolveProject(options: { project?: string }): ProjectConfig {
  // Explicit -p flag
  if (options.project) {
    return projectService.resolve(options.project);
  }

  // Auto-detect from CWD
  const cwd = process.cwd();
  const projects = projectService.list();
  const match = projects.find(
    (p) => cwd === resolve(p.path) || cwd.startsWith(resolve(p.path) + "/"),
  );

  if (match) return { name: match.name, path: match.path };

  throw new Error(
    "Not in a registered project directory. Use -p <name> or register with: ppm init",
  );
}
