/** The shared macOS tool reads: one spawn per tool per window, whoever asks. */
import { describe, expect, test } from "bun:test";
import {
  createDarwinToolReads, SERVICE_ORDER_TTL_MS, TOOL_MEMO_MS,
} from "../../../../src/services/system-metrics/darwin-tool-reads.ts";
import type { RunResult, Runner } from "../../../../src/services/host-info/spawn-runner.ts";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false });
const failed: RunResult = { stdout: "", stderr: "boom", code: 1, timedOut: false };

function fakeRunner(answer: (argv: string[]) => RunResult | Promise<RunResult>) {
  const calls: string[] = [];
  const run: Runner = async (argv) => {
    calls.push(argv[0]!);
    return answer(argv);
  };
  return { run, calls };
}

describe("createDarwinToolReads", () => {
  test("two callers in one window share one spawn, and the time it started", async () => {
    let clock = 10_000;
    const { run, calls } = fakeRunner(() => ok("Name Mtu\n"));
    const reads = createDarwinToolReads(run, () => clock);
    const [a, b] = await Promise.all([reads.netstat(), reads.netstat()]);
    clock += TOOL_MEMO_MS - 1;
    const c = await reads.netstat();
    expect(calls).toEqual(["netstat"]);
    expect(a).toEqual({ value: "Name Mtu\n", atSec: 10 });
    expect(b).toBe(a!);
    expect(c).toBe(a!);
    clock += 1;
    await reads.netstat();
    expect(calls).toEqual(["netstat", "netstat"]);
  });

  test("a failure is shared for the window too, rather than respawned by every caller", async () => {
    const { run, calls } = fakeRunner(() => failed);
    const reads = createDarwinToolReads(run, () => 0);
    expect(await reads.ifconfig()).toBeUndefined();
    expect(await reads.ifconfig()).toBeUndefined();
    expect(calls).toEqual(["ifconfig"]);
  });

  test("a runner that throws is a failed read, not an exception in the tick", async () => {
    const reads = createDarwinToolReads(async () => { throw new Error("spawn failed"); }, () => 0);
    expect(await reads.blockDevices()).toBeUndefined();
  });

  test("plist tools arrive parsed, and output that is not a plist reads as a failure", async () => {
    const { run } = fakeRunner((argv) => ok(argv[0] === "ioreg"
      ? '<?xml version="1.0"?><plist version="1.0"><array><dict><key>a</key><integer>1</integer></dict></array></plist>'
      : "not xml"));
    const reads = createDarwinToolReads(run, () => 0);
    expect((await reads.blockDevices())?.value).toEqual([{ a: 1 }]);
    expect(await reads.diskutilList()).toBeUndefined();
  });

  test("the service list keeps its last good answer through a failed refresh", async () => {
    let clock = 0;
    let fail = false;
    const { run } = fakeRunner(() => (fail ? failed : ok("(Hardware Port: Wi-Fi, Device: en0)\n")));
    const reads = createDarwinToolReads(run, () => clock);
    const first = await reads.serviceOrder();
    fail = true;
    clock += SERVICE_ORDER_TTL_MS;
    // Which interfaces exist must not blink out because networksetup timed out once.
    expect(await reads.serviceOrder()).toEqual(first);
    // The counters do not get the same treatment: a stale netstat is no rate at all.
    expect(await reads.netstat()).toBeUndefined();
  });

  test("the service list is read once a minute, not once a tick", async () => {
    let clock = 0;
    const { run, calls } = fakeRunner(() => ok("(Hardware Port: Wi-Fi, Device: en0)\n"));
    const reads = createDarwinToolReads(run, () => clock);
    await reads.serviceOrder();
    clock += SERVICE_ORDER_TTL_MS - 1;
    await reads.serviceOrder();
    expect(calls).toEqual(["networksetup"]);
  });
});
