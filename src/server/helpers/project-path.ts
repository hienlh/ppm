import { resolve, sep } from "node:path";

/**
 * Whether the absolute path `abs` is the project root or inside it. A bare
 * `abs.startsWith(projectPath)` is not enough: for the project `/home/u/app` it also lets
 * `/home/u/app-secrets/…` through, i.e. `?path=../app-secrets/…`.
 */
export function isInsideProject(projectPath: string, abs: string): boolean {
  const root = resolve(projectPath);
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}
