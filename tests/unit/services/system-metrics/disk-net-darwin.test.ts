/**
 * The Overview's Disk and Network cards on macOS, from the real `ioreg` and
 * `netstat` captures — the same reads the per-device pages parse, so the cards
 * are the sums of the pages.
 */
import { describe, test, expect } from "bun:test";
import { collectDarwinDiskNet } from "../../../../src/services/system-metrics/disk-net-collector-darwin.ts";
import { createDarwinToolReads } from "../../../../src/services/system-metrics/darwin-tool-reads.ts";
import type { Runner } from "../../../../src/services/host-info/spawn-runner.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const ANSWERS: Record<string, string> = {
  ioreg: darwinFixture("ioreg-block-devices.xml"),
  netstat: darwinFixture("netstat-ib.txt"),
};

const runner = (fail: string[] = []): Runner => async (argv) => {
  const tool = argv[0]!;
  return fail.includes(tool) || !ANSWERS[tool]
    ? { stdout: "", stderr: "boom", code: 1, timedOut: false }
    : { stdout: ANSWERS[tool]!, stderr: "", code: 0, timedOut: false };
};

describe("collectDarwinDiskNet", () => {
  test("the disk card is the internal SSD alone — the mounted disk image is not counted twice", async () => {
    const r = await collectDarwinDiskNet(createDarwinToolReads(runner(), () => 7000));
    expect(r.disk).toEqual({ inBytes: 669290475520, outBytes: 236940701696, atSec: 7 });
    expect(r.warnings).toEqual([]);
  });

  test("the network card is every interface but loopback, each link row counted once", async () => {
    const r = await collectDarwinDiskNet(createDarwinToolReads(runner(), () => 7000));
    expect(r.net).toEqual({ inBytes: 54462080808, outBytes: 46300221096, atSec: 7 });
  });

  test("degrades each source independently with a warning", async () => {
    const r = await collectDarwinDiskNet(createDarwinToolReads(runner(["netstat"]), () => 7000));
    expect(r.disk).not.toBeNull();
    expect(r.net).toBeNull();
    expect(r.warnings).toHaveLength(1);
  });

  test("a runner that throws (binary missing) yields warnings, not an exception", async () => {
    const r = await collectDarwinDiskNet(createDarwinToolReads(async () => { throw new Error("ENOENT"); }));
    expect(r.disk).toBeNull();
    expect(r.net).toBeNull();
    expect(r.warnings).toHaveLength(2);
  });
});
