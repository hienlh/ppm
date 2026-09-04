import { describe, test, expect } from "bun:test";
import {
  parseNettopCsv,
  createDarwinProcessNetCollector,
  NETTOP_ARGV,
} from "../../../../src/services/system-metrics/process-net-collector-darwin.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false });

// Shape with the leading timestamp column some macOS releases emit. UNVERIFIED
// against real hardware — this is the documented `-L 1 -J` CSV layout.
const WITH_TIME = `time,,bytes_in,bytes_out,
14:33:05.976,Google Chrome.1234,1441792,262144,
14:33:05.976,com.apple.WebKit.Networking.431,4096,8192,
`;
// Shape without it.
const WITHOUT_TIME = `,bytes_in,bytes_out,
Google Chrome.1234,1441792,262144,
mDNSResponder.234,0,0,
`;

describe("parseNettopCsv", () => {
  test("pid comes from the last dotted segment, so a dotted bundle id survives", () => {
    const m = parseNettopCsv(WITH_TIME);
    expect(m.get(1234)).toEqual({ inBytes: 1441792, outBytes: 262144 });
    expect(m.get(431)).toEqual({ inBytes: 4096, outBytes: 8192 });
  });

  test("the leading timestamp cell is not mistaken for a pid", () => {
    // "14:33:05.976" matches <name>.<digits> shape but has no letter in the name.
    expect(parseNettopCsv(WITH_TIME).size).toBe(2);
    expect(parseNettopCsv(WITH_TIME).has(976)).toBe(false);
  });

  test("the layout without a timestamp column parses identically; the header is ignored", () => {
    const m = parseNettopCsv(WITHOUT_TIME);
    expect(m.size).toBe(2);
    expect(m.get(1234)!.inBytes).toBe(1441792);
    expect(m.get(234)).toEqual({ inBytes: 0, outBytes: 0 });
  });

  test("a pid split across interfaces is summed", () => {
    expect(parseNettopCsv("a.5,10,20,\na.5,1,2,\n").get(5)).toEqual({ inBytes: 11, outBytes: 22 });
  });

  test("rows without two numeric cells are dropped rather than half-read", () => {
    expect(parseNettopCsv("Finder.99,\nFinder.99,onlyone,\n").size).toBe(0);
    expect(parseNettopCsv("").size).toBe(0);
  });
});

describe("createDarwinProcessNetCollector", () => {
  test("runs nettop in one-shot raw CSV mode and logs its cost exactly once", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const c = createDarwinProcessNetCollector(async (argv) => {
      calls.push(argv);
      return ok("Safari.7,1,2,\n");
    }, (m) => logs.push(m));
    expect((await c.collect())!.get(7)).toEqual({ inBytes: 1, outBytes: 2 });
    await c.collect();
    expect(calls[0]).toEqual(NETTOP_ARGV);
    expect(NETTOP_ARGV).toEqual(["nettop", "-P", "-x", "-L", "1", "-J", "bytes_in,bytes_out"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("nettop sample");
  });

  test("a failing or missing nettop yields null — the Net column stays unmeasured — and is given up on", async () => {
    let calls = 0;
    const c = createDarwinProcessNetCollector(async () => {
      calls++;
      throw new Error("ENOENT");
    }, () => {});
    expect(await c.collect()).toBeNull();
    expect(await c.collect()).toBeNull();
    expect(await c.collect()).toBeNull();
    expect(c.isDisabled()).toBe(true);
    await c.collect();
    expect(calls).toBe(3);
  });

  test("a timeout is a failure, not an empty sample", async () => {
    const c = createDarwinProcessNetCollector(
      async () => ({ stdout: "Safari.7,1,2,\n", stderr: "", code: null, timedOut: true }),
      () => {},
    );
    expect(await c.collect()).toBeNull();
  });
});
