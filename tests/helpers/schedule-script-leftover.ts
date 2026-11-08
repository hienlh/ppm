import { readFileSync } from "node:fs";

/**
 * A long-lived process standing in for a schedule's child a previous server left behind,
 * carrying `token` the way a real child does.
 *
 * Bun.spawn returns while the child is still inside execve, and until the kernel has laid out
 * its new stack /proc/<pid>/environ reads empty, so `ownership()` would call a child of ours
 * nobody's. A real leftover was started by the previous server, long before the check; this
 * waits until the environment can be read.
 */
export async function spawnLeftover(token?: string): Promise<ReturnType<typeof Bun.spawn>> {
  const p = Bun.spawn(["sleep", "30"], { env: { ...process.env, ...(token && { PPM_SCHEDULE_RUN: token }) } });
  if (process.platform === "linux") {
    for (let i = 0; i < 200 && readFileSync(`/proc/${p.pid}/environ`).length === 0; i++) await Bun.sleep(5);
  }
  return p;
}
