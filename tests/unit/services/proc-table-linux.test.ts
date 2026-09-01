import { describe, test, expect } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROC_AVAILABLE,
  readProcTable,
  readProcCmdline,
  readProcComm,
  readProcPpidMap,
} from "../../../src/services/proc-table-linux.ts";

// /proc exists only on Linux; on macOS and Windows the callers keep their own
// path and these readers are expected to return null.
const describeLinux = PROC_AVAILABLE ? describe : describe.skip;

describeLinux("proc-table-linux", () => {
  test("readProcTable finds this process with plausible values", () => {
    const table = readProcTable();
    expect(table).not.toBeNull();

    const self = table!.find((p) => p.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.ppid).toBe(process.ppid);
    // The test runner is bun, so argv must mention it — proves cmdline parsing.
    expect(self!.args.toLowerCase()).toContain("bun");
    // A running JS runtime is never a few KB and never a terabyte.
    expect(self!.rssKB).toBeGreaterThan(1000);
    expect(self!.rssKB).toBeLessThan(50_000_000);
    expect(self!.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(self!.elapsedSec).toBeGreaterThan(0);
    // Started in the past, and not before this machine could have booted.
    expect(self!.startedAtMs).toBeLessThanOrEqual(Date.now());
    expect(self!.startedAtMs).toBeGreaterThan(Date.now() - 365 * 24 * 3600 * 1000);
  });

  test("readProcTable survives a process name containing spaces and parens", async () => {
    // `/proc/<pid>/stat` is `pid (comm) state ppid …`. A naive whitespace split
    // shifts every field for such a process, silently corrupting ppid and rss.
    // `exec -a` is a bash-ism the container's dash lacks, so give the binary the
    // awkward name on disk instead.
    const dir = mkdtempSync(join(tmpdir(), "ppm-proc-name-"));
    const weird = join(dir, "we ird (name)");
    copyFileSync("/bin/sleep", weird);
    chmodSync(weird, 0o755);
    const proc = Bun.spawn([weird, "5"], {
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    try {
      await Bun.sleep(300);
      const entry = readProcTable()!.find((p) => p.pid === proc.pid);
      expect(entry).toBeDefined();
      // comm is truncated to 15 chars by the kernel, but the parens must survive.
      expect(entry!.comm).toContain("we ird (name");
      expect(entry!.ppid).toBe(process.pid);
      expect(entry!.rssKB).toBeGreaterThan(0);
      expect(entry!.startedAtMs).toBeLessThanOrEqual(Date.now());
    } finally {
      proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readProcPpidMap agrees with readProcTable", () => {
    const map = readProcPpidMap();
    expect(map).not.toBeNull();
    expect(map!.get(process.pid)).toBe(process.ppid);
  });

  test("readProcCmdline and readProcComm read this process", () => {
    expect(readProcCmdline(process.pid)).toContain("bun");
    expect(readProcComm(process.pid)).toBeTruthy();
  });

  test("readers return null for a pid that does not exist", () => {
    // 0x7FFFFFFF is above any real pid_max, so it can never be live.
    const absent = 0x7fffffff;
    expect(readProcCmdline(absent)).toBeNull();
    expect(readProcComm(absent)).toBeNull();
    expect(readProcTable()!.some((p) => p.pid === absent)).toBe(false);
  });
});
