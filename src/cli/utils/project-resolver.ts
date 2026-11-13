import { resolve, sep } from "node:path";
import { projectService } from "../../services/project.service.ts";
import { configService } from "../../services/config.service.ts";
import type { ProjectConfig } from "../../types/config.ts";

/**
 * CLI project resolver: CWD auto-detect + `-p` flag override.
 * Used by CLI commands that operate on a specific project.
 */
export function resolveProject(options: { project?: string }): ProjectConfig {
  // A `ppm` process holds only the defaults — no projects — until it reads the database, so
  // without this every `-p <name>` answered "Project not found".
  configService.load();
  // Explicit -p flag
  if (options.project) {
    return projectService.resolve(options.project);
  }

  // Auto-detect from CWD: the project whose folder holds it, the innermost one when projects
  // nest. Joined with the platform's separator, and case-blind on Windows, where `C:\Work\app`
  // and `c:\work\app` are one folder.
  const match = projectForDir(process.cwd(), projectService.list());

  if (match) return { name: match.name, path: match.path };

  throw new Error(
    "Not in a registered project directory. Use -p <name> or register with: ppm init",
  );
}

/** The registered project whose folder is `dir` or holds it, the deepest one first. */
export function projectForDir(
  dir: string,
  projects: ProjectConfig[],
  platform: NodeJS.Platform = process.platform,
  separator: string = sep,
): ProjectConfig | undefined {
  const norm = (p: string) => (platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const here = norm(dir);
  return projects
    .filter((p) => {
      const root = norm(p.path);
      return here === root || here.startsWith(root.endsWith(separator) ? root : root + separator);
    })
    .sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0];
}
