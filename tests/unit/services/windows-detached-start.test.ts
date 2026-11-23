/**
 * `ppm start` (and the Task Scheduler watchdog, which goes through it) starts the supervisor with
 * PowerShell `Start-Process` and must return as soon as it has, not when the supervisor exits.
 * With the PID read from PowerShell's stdout pipe, Bun 1.4.4 waited for the child to close the
 * inherited pipe: a 20 s child kept it 20,228 ms, and a real `ppm start` never returned.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedStartScript, psQuote, startDetachedOnWindows } from "../../../src/services/windows-detached-start.ts";

const onWindows = process.platform === "win32";

describe("detachedStartScript", () => {
  it("quotes every argument for PowerShell and stands in for an empty one", () => {
    expect(psQuote("it's")).toBe("'it''s'");
    const script = detachedStartScript(
      { exe: "C:\\b\\bun.exe", args: ["run", "C:\\x y\\s.ts", "", "it's"], stdoutPath: "C:\\o.log", stderrPath: "C:\\e.log" },
      "C:\\t\\pid.txt", "C:\\t\\error.txt",
    );
    expect(script).toContain("-FilePath 'C:\\b\\bun.exe' -ArgumentList 'run','C:\\x y\\s.ts','_','it''s'");
    expect(script).toContain("Set-Content -LiteralPath 'C:\\t\\pid.txt' -Value $p.Id");
    expect(script).toContain("Set-Content -LiteralPath 'C:\\t\\error.txt' -Value $_.Exception.Message");
    expect(script).not.toContain("Write-Output");
  });
});

describe.skipIf(!onWindows)("startDetachedOnWindows (Windows)", () => {
  it("returns the PID at once while the child keeps running", () => {
    const dir = mkdtempSync(join(tmpdir(), "ppm-detached-test-"));
    const t0 = performance.now();
    const started = startDetachedOnWindows({
      exe: process.execPath,
      args: ["-e", "setTimeout(() => {}, 20000)"],
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
    });
    const ms = performance.now() - t0;
    try {
      expect("pid" in started).toBe(true);
      const pid = (started as { pid: number }).pid;
      expect(() => process.kill(pid, 0)).not.toThrow();
      // PowerShell's own start-up is ~200 ms; waiting on the child would take its whole 20 s.
      expect(ms).toBeLessThan(10_000);
      process.kill(pid);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* child may still hold its logs */ }
    }
  }, 30_000);

  it("reports why when the program cannot be started", () => {
    const dir = mkdtempSync(join(tmpdir(), "ppm-detached-test-"));
    const started = startDetachedOnWindows({
      exe: join(dir, "no-such-program.exe"),
      args: [],
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
    });
    expect("error" in started).toBe(true);
    expect((started as { error: string }).error.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
