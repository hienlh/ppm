/**
 * `git init` for a freshly created project folder. It gets a kill timer like
 * every other spawn here: git can hang on a broken hooks template or a wedged
 * filesystem, and the directory already exists by then, so a stuck init must
 * not hold the HTTP request open.
 */
const GIT_INIT_TIMEOUT_MS = 5_000;

export async function runGitInit(path: string): Promise<void> {
  const proc = Bun.spawn(["git", "init", path], { stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, GIT_INIT_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}
