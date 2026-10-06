/**
 * `git init` for a freshly created project folder. It gets a kill timer like
 * every other spawn here: git can hang on a broken hooks template or a wedged
 * filesystem, and the directory already exists by then, so a stuck init must
 * not hold the HTTP request open.
 */
import { createLogger } from "../logger.ts";

const log = createLogger("fs");

const GIT_INIT_TIMEOUT_MS = 5_000;

export async function runGitInit(path: string): Promise<void> {
  const proc = Bun.spawn(["git", "init", path], { stdout: "ignore", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, GIT_INIT_TIMEOUT_MS);
  let code: number;
  try {
    code = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  // Nothing reads the outcome — the mkdir route answers `gitInitialized: true` either way — so
  // this line is the only trace of a folder that was created without its repository.
  if (timedOut) log.error(`git init failed in ${path}: timed out after ${GIT_INIT_TIMEOUT_MS / 1000} s`);
  else if (code !== 0) log.error(`git init failed in ${path}: exit ${code}`);
  else log.debug(`git init in ${path}`);
}
