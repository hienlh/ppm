import { describe, it, expect } from "bun:test";
import { parseProcStatus, readNativeMemory } from "../../../src/services/memory-diagnostics-native.ts";
import { SpawnTracker, spawnLabel } from "../../../src/services/memory-diagnostics-spawns.ts";
import { attributeGrowth, buildReport, parseDiagLog, splitRuns } from "../../../src/services/memory-diagnostics-report.ts";

describe("spawnLabel", () => {
  it("names git by its subcommand, skipping value-taking global flags", () => {
    expect(spawnLabel(["git", "-c", "core.quotepath=off", "-C", "/repo", "status", "--porcelain=v2"])).toBe("git status");
    expect(spawnLabel(["C:\\Program Files\\Git\\cmd\\git.exe", "log"])).toBe("git log");
  });

  it("names a script runner by its script and a shell by the program it runs", () => {
    expect(spawnLabel(["bun", "/home/u/.bun/install/cli.js", "--print"])).toBe("bun cli.js");
    expect(spawnLabel(["cmd", "/c", "git", "status"])).toBe("cmd git");
    expect(spawnLabel(["powershell.exe", "-NoProfile", "-Command", "Get-CimInstance Win32_Process"])).toBe("powershell get-ciminstance");
  });

  it("never carries an argument beyond the first word", () => {
    const label = spawnLabel(["sh", "-c", "curl -H 'Authorization: Bearer sk-secret' https://x"]);
    expect(label).toBe("sh curl");
    expect(spawnLabel(["claude", "--prompt", "my private prompt"])).toBe("claude");
  });

  it("keeps no secret from an inline script, an env assignment or a positional argument", () => {
    const cases: Array<[string[], string]> = [
      [["sh", "-c", "GITHUB_TOKEN=ghp_abcdef1234567890 gh pr list"], "sh"],
      [["node", "--eval", "process.env.X='sk-ant-api03-abcdefghijk'"], "node --eval"],
      [["bun", "-e", "fetch('https://x/v1?key=sk-SECRETSECRET')"], "bun -e"],
      [["python", "-c", "print('hunter2password')"], "python -c"],
      [["node", "sk-ant-api03-abcdefghijk"], "node"],
      [["bash", "-c", "$HOME/bin/tool --token abc"], "bash"],
    ];
    for (const [argv, label] of cases) expect(spawnLabel(argv)).toBe(label);
  });

  it("names PowerShell by what -Command runs, not by a flag's value", () => {
    expect(spawnLabel(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Get-Process | ConvertTo-Json"])).toBe("powershell get-process");
    expect(spawnLabel(["pwsh", "-NoLogo", "-File", "C:\\scripts\\collect.ps1"])).toBe("pwsh collect.ps1");
    expect(spawnLabel(["powershell.exe", "-NoProfile", "-EncodedCommand", "SQBFAFgA"])).toBe("powershell");
  });

  it("names a runner's subcommand and an npx package without its scope or version", () => {
    expect(spawnLabel(["bun", "x", "tsc", "--noEmit"])).toBe("bun x");
    expect(spawnLabel(["npx", "-y", "@anthropic-ai/claude-code@2.1.0", "--version"])).toBe("npx claude-code");
    expect(spawnLabel(["git", "status", "--porcelain=v2"])).toBe("git status");
  });

  it("falls back for empty or non-string argv", () => {
    expect(spawnLabel([])).toBe("unknown");
    expect(spawnLabel([42 as unknown as string])).toBe("unknown");
  });
});

describe("SpawnTracker", () => {
  it("counts per interval, keeps totals, and forgets a child once it exits", async () => {
    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => { resolveExit = r; });
    const t = new SpawnTracker(() => 1_000);
    t.record("git status", { pid: 11, exited });
    t.record("git status");
    t.record("claude", { pid: 12, exited: new Promise(() => {}) });

    const first = t.snapshot();
    expect(first.spawned).toEqual({ "git status": 2, claude: 1 });
    expect(first.live).toEqual({ "git status": 1, claude: 1 });
    expect(first.total).toBe(3);

    resolveExit();
    await exited;
    await Promise.resolve();
    const second = t.snapshot();
    expect(second.spawned).toEqual({});
    expect(second.live).toEqual({ claude: 1 });
    expect(t.topTotals(5)).toEqual({ "git status": 2, claude: 1 });
    expect(t.oldestLive(5)).toEqual([{ pid: 12, label: "claude", ageMin: 0 }]);
  });

  it("does not lose a new child when its pid was reused before the old one's exit settled", async () => {
    let endOld!: () => void;
    const oldExited = new Promise<void>((r) => { endOld = r; });
    const t = new SpawnTracker(() => 0);
    t.record("git status", { pid: 7, exited: oldExited });
    t.record("claude", { pid: 7, exited: new Promise(() => {}) });
    endOld();
    await oldExited;
    await Promise.resolve();
    expect(t.snapshot().live).toEqual({ claude: 1 });
  });
});

describe("native memory", () => {
  it("reads Linux /proc/self/status with private = anonymous + swap", () => {
    const status = "Name:\tbun\nVmHWM:\t  204800 kB\nVmSize:\t 4194304 kB\nRssAnon:\t  102400 kB\nVmSwap:\t   51200 kB\nThreads:\t17\n";
    expect(parseProcStatus(status)).toEqual({ privateMB: 150, peakRssMB: 200, virtualMB: 4096, threads: 17 });
  });

  it("leaves a field out rather than reporting zero when it cannot be read", () => {
    expect(parseProcStatus("Name:\tbun\n")).toEqual({ privateMB: undefined, peakRssMB: undefined, virtualMB: undefined, threads: undefined });
  });

  it("measures this process on a platform that supports it", async () => {
    const m = await readNativeMemory();
    if (process.platform === "win32" || process.platform === "linux") {
      expect(m.privateMB).toBeGreaterThan(0);
      expect(m.handles).toBeGreaterThan(0);
    } else {
      expect(m).toEqual({});
    }
  });
});

describe("mem-diag report", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ role: "server", rssMB: 100, heapMB: 50, ...o });

  it("splits runs on a new pid or uptime going backwards", () => {
    const lines = parseDiagLog([
      line({ t: "2026-10-20T00:00:00Z", pid: 1, upMin: 0 }),
      line({ t: "2026-10-20T00:01:00Z", pid: 1, upMin: 1 }),
      line({ t: "2026-10-20T00:02:00Z", pid: 2, upMin: 5 }),
      "{torn",
      // A line from before pids were logged: only the uptime says it is a new run.
      line({ t: "2026-10-20T00:03:00Z", upMin: 0 }),
    ].join("\n"));
    expect(splitRuns(lines).map((r) => r.length)).toEqual([2, 1, 1]);
  });

  it("attributes private growth to the command whose spawns move with it", () => {
    const run = parseDiagLog(Array.from({ length: 10 }, (_, i) => line({
      t: `2026-10-20T00:${String(i).padStart(2, "0")}:00Z`,
      pid: 1,
      upMin: i,
      privateMB: 1000 + i * 64,
      privateDeltaMB: i % 2 ? 128 : 0,
      spawned: { "powershell get-ciminstance": i % 2 ? 4 : 0, "git status": 3 },
    })).join("\n"));
    const [top, other] = attributeGrowth(run);
    expect(top.label).toBe("powershell get-ciminstance");
    expect(top.mbPerSpawn).toBeCloseTo(32, 5);
    expect(top.correlation).toBeCloseTo(1, 5);
    expect(other.label).toBe("git status");
    expect(other.correlation).toBeCloseTo(0, 5);
  });

  it("says so when the log has no samples, and flags runs from before private bytes were sampled", () => {
    expect(buildReport("")).toEqual(["No samples in the log. Is PPM_MEM_DIAG=1 set for the process?"]);
    const old = buildReport(JSON.stringify({ t: "2026-10-13T00:00:00Z", upMin: 0, rssMB: 300, heapMB: 40 }));
    expect(old.join("\n")).toContain("predates private-byte sampling");
  });
});
