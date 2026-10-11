/**
 * The tunnel registry's list when the machine-wide cloudflared scan works, fails, or is asked for
 * by several callers at once — driven by fake runners and scans, so no PowerShell, `ps` or `lsof`
 * is ever spawned. The case that matters most: a scan that times out must still list this PPM's
 * own forwards exactly and say the list is incomplete, never pass an empty list off as "none".
 */
import { describe, expect, it } from "bun:test";
import { createTunnelLister, type PpmTunnelInput } from "../../../src/services/tunnel-registry-lister.ts";
import { enumerateWindows, isCloudflaredPid, type RawProc } from "../../../src/services/tunnel-registry-process-scan.ts";
import type { Runner, RunResult } from "../../../src/services/host-info/spawn-runner.ts";

const answer = (over: Partial<RunResult>): Runner => async () => ({ stdout: "", stderr: "", code: 0, timedOut: false, ...over });
/** What `defaultRunner` answers for a process it had to kill at its timeout. */
const timedOut = answer({ code: null, timedOut: true });
/** No listening ports, so URL recovery never fetches anything. */
const quietRun = answer({});
const noApp = () => ({ shareUrl: null, tunnelPid: null, serverPort: null });

const OWN: PpmTunnelInput = { pid: 4242, port: 5173, url: "https://mine.trycloudflare.com", startedAt: 1 };
const THEIRS: RawProc = { pid: 7000, cmdline: "cloudflared tunnel --url http://localhost:8000", imagePath: "C:\\cf\\cloudflared.exe", identity: "t1" };

function lister(scan: () => Promise<RawProc[]>) {
  const warnings: string[] = [];
  const l = createTunnelLister({ scan, run: quietRun, appShare: noApp, warn: (m) => warnings.push(m) });
  return { l, warnings };
}

describe("a scan that fails", () => {
  it("still lists this PPM's own forwards exactly, and says the scan failed", async () => {
    // The scan as production runs it on Windows, with PowerShell killed at its timeout.
    const { l, warnings } = lister(() => enumerateWindows(timedOut));
    const r = await l.list([OWN], { force: true });
    expect(r.scanFailed).toBe(true);
    expect(r.tunnels).toEqual([{ pid: 4242, port: 5173, url: "https://mine.trycloudflare.com", source: "ppm", protected: false, status: "running", startedAt: 1 }]);
    expect(warnings[0]).toContain("timed out after 12000 ms");
  });

  it("serves other programs' tunnels as last seen, still flagged, with PPM's own as they are now", async () => {
    let fail = false;
    const { l } = lister(async () => { if (fail) throw new Error("powershell.exe (Win32_Process) timed out after 12000 ms"); return [THEIRS]; });
    const good = await l.list([], { force: true });
    expect(good.scanFailed).toBe(false);
    expect(good.tunnels.map((t) => [t.pid, t.source])).toEqual([[7000, "external"]]);

    fail = true;
    const after = await l.list([OWN], { force: true });
    expect(after.scanFailed).toBe(true);
    expect(after.tunnels.map((t) => [t.pid, t.source]).sort()).toEqual([[4242, "ppm"], [7000, "external"]]);
  });
});

describe("a scan that works", () => {
  it("answers complete, and is cached briefly unless forced", async () => {
    let scans = 0;
    const { l } = lister(async () => { scans++; return [THEIRS]; });
    const first = await l.list([OWN]);
    expect(first.scanFailed).toBe(false);
    expect(first.tunnels.map((t) => t.pid).sort()).toEqual([4242, 7000]);
    expect((await l.list([OWN])).scanFailed).toBe(false);
    expect(scans).toBe(1);
    await l.list([OWN], { force: true });
    expect(scans).toBe(2);
  });

  it("shares one scan between callers that ask at the same time", async () => {
    let scans = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { l } = lister(async () => { scans++; await gate; return [THEIRS]; });
    const both = Promise.all([l.list([], { force: true }), l.list([], { force: true })]);
    release();
    const [a, b] = await both;
    expect(scans).toBe(1);
    expect(a.tunnels.map((t) => t.pid)).toEqual([7000]);
    expect(b.tunnels.map((t) => t.pid)).toEqual([7000]);
  });

  it("does not cache a scan that a start or stop overtook", async () => {
    let scans = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { l } = lister(async () => { scans++; if (scans === 1) await gate; return [THEIRS]; });
    const stale = l.list();
    l.invalidate();
    release();
    await stale;
    await l.list();
    expect(scans).toBe(2);
  });
});

describe("the Windows process scan", () => {
  it("parses PowerShell's tab-separated lines", async () => {
    const out = "7000\t638000000000000000\tC:\\cf\\cloudflared.exe\tcloudflared tunnel --url http://localhost:8000\r\n\r\n";
    expect(await enumerateWindows(answer({ stdout: out }))).toEqual([{ ...THEIRS, identity: "638000000000000000" }]);
  });

  it("throws, rather than answering an empty list, when PowerShell timed out, failed or could not start", async () => {
    await expect(enumerateWindows(timedOut)).rejects.toThrow("timed out");
    await expect(enumerateWindows(answer({ code: 1, stderr: "WMI is unavailable" }))).rejects.toThrow("exit 1");
    await expect(enumerateWindows(answer({ code: null, stderr: "Executable not found in $PATH" }))).rejects.toThrow("Executable not found");
  });
});

describe("the image check before a kill", () => {
  it("fails closed when its query times out or the pid is not a pid", async () => {
    // A pid no OS hands out, so the Linux /proc shortcut finds nothing and the runner is asked.
    expect(await isCloudflaredPid(2_000_000_000, timedOut)).toBe(false);
    expect(await isCloudflaredPid(0, quietRun)).toBe(false);
    expect(await isCloudflaredPid(-5, quietRun)).toBe(false);
  });

  it.if(process.platform === "win32")("accepts a process whose executable is cloudflared.exe", async () => {
    expect(await isCloudflaredPid(7000, answer({ stdout: "C:\\cf\\cloudflared.exe\r\n" }))).toBe(true);
    expect(await isCloudflaredPid(7000, answer({ stdout: "C:\\Windows\\notepad.exe\r\n" }))).toBe(false);
  });
});
