import { describe, test, expect } from "bun:test";
import {
  collectProcessTree,
  killPids,
  terminateTree,
} from "../../../src/services/windows-process-tree.ts";

const describePosix = process.platform === "win32" ? describe.skip : describe;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Spawn `sh` holding a `sleep` child, and return both PIDs. */
async function spawnParentWithChild(): Promise<{ parent: number; child: number; kill: () => void }> {
  const proc = Bun.spawn(["sh", "-c", "sleep 30 & wait"], {
    stdout: "ignore", stderr: "ignore", stdin: "ignore",
  });
  const parent = proc.pid;

  // Wait for the grandchild `sleep` to actually appear.
  let child = 0;
  for (let i = 0; i < 50 && child === 0; i++) {
    await Bun.sleep(100);
    child = collectProcessTree(parent).find((p) => p !== parent) ?? 0;
  }

  return {
    parent,
    child,
    kill: () => { for (const p of [child, parent]) { if (p) { try { process.kill(p, "SIGKILL"); } catch {} } } },
  };
}

describePosix("collectProcessTree (POSIX)", () => {
  test("finds descendants that are not in their own process group", async () => {
    const { parent, child, kill } = await spawnParentWithChild();
    try {
      expect(child).toBeGreaterThan(0);

      const tree = collectProcessTree(parent);
      expect(tree[0]).toBe(parent); // root first
      expect(tree).toContain(child);

      // The bug this replaces: the child shares the supervisor's process group,
      // so `kill(-parent)` targeted a group that does not exist and no-oped.
      expect(() => process.kill(-parent, 0)).toThrow();
    } finally {
      kill();
    }
  });

  test("returns just the pid when it has no children", () => {
    expect(collectProcessTree(process.pid)).toContain(process.pid);
  });
});

describePosix("terminateTree (POSIX)", () => {
  test("reaps the whole tree, not just the root", async () => {
    const { parent, child, kill } = await spawnParentWithChild();
    try {
      expect(child).toBeGreaterThan(0);

      await terminateTree(collectProcessTree(parent), 2000);

      expect(isAlive(parent)).toBe(false);
      expect(isAlive(child)).toBe(false);
    } finally {
      kill();
    }
  });

  test("is a no-op for an empty tree", async () => {
    await terminateTree([], 100);
  });
});

describePosix("killPids guards", () => {
  test("never signals init or the calling process", () => {
    // If the guard regressed, this would terminate the test runner itself.
    killPids([1, process.pid], "SIGKILL");
    expect(isAlive(process.pid)).toBe(true);
  });
});
