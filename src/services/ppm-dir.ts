import { resolve } from "node:path";
import { homedir } from "node:os";

let _dir: string | undefined;

/** Centralized PPM directory resolution. Respects PPM_HOME env var for test isolation. */
export function getPpmDir(): string {
  return (_dir ??= resolve(process.env.PPM_HOME || resolve(homedir(), ".ppm")));
}

/** Reset cached dir (for test teardown if needed) */
export function _resetPpmDir(): void {
  _dir = undefined;
}
