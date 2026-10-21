import { resolve } from "node:path";
import { configService } from "./config.service.ts";

/**
 * A project folder in the one spelling every comparison uses: resolved, and lower-cased on
 * Windows, where `C:\Users\Me\App` and `c:\users\me\app` are the same folder. Stored beside
 * the path in any table queried by project, because SQL `=` is case-sensitive.
 */
export function projectKey(projectPath: string): string {
  const abs = resolve(projectPath);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** Registered project whose folder is `projectPath`, or null. Case-folded on Windows. */
export function projectNameForPath(projectPath: string): string | null {
  const target = projectKey(projectPath);
  return configService.get("projects").find((p) => projectKey(p.path) === target)?.name ?? null;
}
