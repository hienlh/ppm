/**
 * `defaultRunner` against a binary that is not there.
 *
 * This is the normal case rather than an edge one: every provider built on this
 * runner shells out to a tool that belongs to one OS — `systemctl`, `plutil`,
 * `powershell.exe`, `findmnt`, `xdg-user-dir`, `nvidia-smi` — so on any other
 * host the binary is simply absent. And `Bun.spawn` does not report that through
 * an exit code, it **throws synchronously**, which escaped the
 * `Promise<RunResult>` this signature promises.
 *
 * Measured consequence before the fix: `collectServices` rejected on macOS and
 * Windows, so `/api/system/services` answered 500 and the Services page rendered
 * the exception text — where the collector is written to answer
 * `supported: false` and the page has a branch that says "this host has no
 * service manager PPM can read". The failure was invisible on Linux, which is
 * the only platform this repository can run.
 *
 * These tests spawn for real (a missing name and a present one), because the
 * behaviour under test is Bun's and a stubbed spawn would assert nothing.
 */
import { describe, test, expect } from "bun:test";
import { defaultRunner } from "../../../../src/services/host-info/spawn-runner.ts";

describe("a binary that is not on PATH", () => {
  test("resolves as a failed run instead of throwing", async () => {
    const result = await defaultRunner(["ppm-no-such-binary-a7f3c1"], 2000);
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
    // The reason is kept: a provider's warning is the only thing that will say
    // why a page is empty on a host nobody can attach a debugger to.
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("answers the same shape a real failure does", async () => {
    // Every caller branches on `timedOut || code !== 0`, so "missing" has to be
    // indistinguishable from "ran and failed" rather than a third case.
    const missing = await defaultRunner(["ppm-no-such-binary-a7f3c1"], 2000);
    const failed = await defaultRunner(["sh", "-c", "exit 3"], 2000);
    expect(Object.keys(missing).sort()).toEqual(Object.keys(failed).sort());
    for (const r of [missing, failed]) {
      expect(r.timedOut).toBe(false);
      expect(typeof r.stdout).toBe("string");
      expect(typeof r.stderr).toBe("string");
      expect(r.code === null || typeof r.code === "number").toBe(true);
    }
  });

  test("an absolute path that does not exist is the same case", async () => {
    // Windows and macOS providers name their tool by path in places, and a bad
    // path throws from the same call.
    const result = await defaultRunner(["/nonexistent/ppm-no-such-binary"], 2000);
    expect(result.code).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe("a binary that is there still behaves as before", () => {
  test("stdout, stderr and a zero exit code all come back", async () => {
    const result = await defaultRunner(["sh", "-c", "printf out; printf err >&2"], 2000);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.timedOut).toBe(false);
  });

  test("a process that outlives its timeout is killed and reported", async () => {
    const result = await defaultRunner(["sh", "-c", "sleep 5"], 150);
    expect(result.timedOut).toBe(true);
  });
});
