/**
 * A failed self-replace must leave PPM running.
 *
 * A real supervisor (scratch PPM_HOME, its own port) is started through a launcher file.
 * Self-replace re-runs the supervisor's own argv, so rewriting that launcher to exit at
 * once makes the replacement fail exactly the way a broken build would, with no test hook
 * in the product. The old supervisor must notice at once, bring its server back, and keep
 * its edge — the 14/11/2026 upgrade instead left the public port with nothing behind it.
 *
 * Windows only (the supervisor takes `upgrade` through `.supervisor-cmd` there); skipped
 * with PPM_SKIP_LIVE=1 like the other live supervisor tests.
 */
import { describe as describeBase, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const live = process.platform === "win32" && process.env.PPM_SKIP_LIVE !== "1";
const describe = live ? describeBase : describeBase.skip;

const PORT = 19977;
const home = mkdtempSync(join(tmpdir(), "ppm-upgrade-fail-"));
const launcher = join(home, "launch-supervisor.ts");
const statusFile = join(home, "status.json");
const logFile = join(home, "ppm.log");
const started = new Set<number>();

const alive = (pid: unknown) => { try { process.kill(pid as number, 0); return true; } catch { return false; } };
const status = (): Record<string, unknown> => { try { return JSON.parse(readFileSync(statusFile, "utf8")); } catch { return {}; } };
const logText = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(250); }
  return false;
}
const healthy = async () => {
  try { return (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) })).ok; }
  catch { return false; }
};

afterAll(() => {
  // Every process this test caused, by exact PID: the supervisor, both servers, the edge,
  // and anything else status.json names.
  const s = status();
  for (const k of ["pid", "edgePid", "tunnelPid", "shareHostPid", "shareHostTunnelPid", "supervisorPid"]) {
    if (typeof s[k] === "number") started.add(s[k] as number);
  }
  // A quick tunnel status.json had not recorded yet, or anything else run out of the scratch
  // home: found by its command line, which names that home, and stopped by exact PID.
  if (process.platform === "win32") {
    const out = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${home.split(/[\\/]/).pop()}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.ProcessId }`,
    ]).stdout.toString();
    for (const line of out.split(/\r?\n/)) { const pid = Number(line.trim()); if (pid > 0 && pid !== process.pid) started.add(pid); }
  }
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch {} }
  console.log(`[supervisor-upgrade-self-replace] stopped PIDs: ${[...started].join(", ")}`);
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

describe("self-replace whose new supervisor dies at startup", () => {
  test("the old supervisor brings its server back at once and keeps its edge", async () => {
    const supervisorScript = resolve(import.meta.dir, "../../src/services/supervisor.ts");
    writeFileSync(launcher, `await import(${JSON.stringify(supervisorScript)});\n`);

    const { INVOCATION_ID: _i, NOTIFY_SOCKET: _n, ...inherited } = process.env;
    const logFd = openSync(logFile, "a");
    const sup = Bun.spawn({
      cmd: [process.execPath, "run", launcher, "__supervise__", String(PORT), "127.0.0.1"],
      stdio: ["ignore", logFd, logFd],
      env: { ...inherited, NODE_ENV: "test", PPM_HOME: home },
    });
    started.add(sup.pid);

    expect(await waitFor(healthy, 60_000)).toBe(true);
    const before = status();
    const firstServer = before.pid as number;
    const edge = before.edgePid as number;
    started.add(firstServer); started.add(edge);
    expect(before.supervisorPid).toBe(sup.pid);
    expect(alive(edge)).toBe(true);

    // The replacement will run this file: make it fail the way a broken build would.
    writeFileSync(launcher, "process.exit(3);\n");
    const upgradeAt = Date.now();
    writeFileSync(join(home, ".supervisor-cmd"), JSON.stringify({ action: "upgrade" }));

    expect(await waitFor(() => /Self-replace failed: New supervisor exited \(code 3\)/.test(logText()), 25_000)).toBe(true);
    const detectedMs = Date.now() - upgradeAt;
    expect(await waitFor(async () => {
      const s = status();
      return typeof s.pid === "number" && s.pid !== firstServer && (await healthy());
    }, 30_000)).toBe(true);

    const after = status();
    started.add(after.pid as number);
    expect(alive(sup.pid)).toBe(true);
    expect(after.supervisorPid).toBe(sup.pid);
    expect(after.state).toBe("running");
    // The edge is untouched: same process, still serving the public port.
    expect(after.edgePid).toBe(edge);
    expect(alive(edge)).toBe(true);
    // Fail-fast, not the old 30 s timeout; and the planned stop was not counted as a crash.
    expect(detectedMs).toBeLessThan(15_000);
    const sinceUpgrade = logText().slice(logText().lastIndexOf("Starting self-replace for upgrade"));
    expect(sinceUpgrade).not.toContain("Server crashed");
    expect((sinceUpgrade.match(/Server started \(PID/g) ?? []).length).toBe(1);
  }, 150_000);
});
