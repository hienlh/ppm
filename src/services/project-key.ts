import { resolve } from "node:path";

/**
 * A project folder in the one spelling every comparison uses: resolved, and lower-cased on
 * Windows, where `C:\Users\Me\App` and `c:\users\me\app` are the same folder. Stored beside
 * the path in any table queried by project, because SQL `=` is case-sensitive.
 *
 * Its own module, free of config, so a worker process (the memory host) can use it.
 */
export function projectKey(projectPath: string): string {
  const abs = resolve(projectPath);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}
