import { describe, test, expect } from "bun:test";
import {
  parseIoregBytes,
  parseNetstatIb,
  collectDarwinDiskNet,
} from "../../../../src/services/system-metrics/disk-net-collector-darwin.ts";
import type { Runner } from "../../../../src/services/host-info/spawn-runner.ts";

// Hand-authored from documented `ioreg -rc IOBlockStorageDriver -w0` output.
// UNVERIFIED on real macOS hardware — a wrong guess degrades to available:false.
const IOREG = [
  "+-o AppleAPFSMedia  <class IOBlockStorageDriver>",
  '    "Statistics" = {"Bytes (Read)"=1000000,"Bytes (Write)"=500000,"Operations (Read)"=10}',
  "+-o disk1  <class IOBlockStorageDriver>",
  '    "Statistics" = {"Bytes (Write)"=250000,"Bytes (Read)"=2000000}',
].join("\n");

// Hand-authored from documented `netstat -ib` output: an interface repeats per
// address family; only the <Link#N> row carries the hardware counters. utun has
// no Address column, which shifts the positional layout.
const NETSTAT = [
  "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
  "lo0        16384 <Link#1>                          1000     0     900000     1000     0     900000     0",
  "lo0        16384 127           127.0.0.1           1000     -     900000     1000     -     900000     -",
  "en0        1500  <Link#4>      a4:83:e7:aa:bb:cc  50000     0   60000000    40000     0   30000000     0",
  "en0        1500  192.168.1     192.168.1.20       50000     -   60000000    40000     -   30000000     -",
  "utun3      1380  <Link#20>                         2000     0    1000000     2500     0    2000000     0",
].join("\n");

describe("parseIoregBytes", () => {
  test("sums read/write across every driver", () => {
    expect(parseIoregBytes(IOREG)).toEqual({ inBytes: 3000000, outBytes: 750000 });
  });

  test("returns null when the keys are absent", () => {
    expect(parseIoregBytes("+-o disk0\n    \"Statistics\" = {}")).toBeNull();
  });
});

describe("parseNetstatIb", () => {
  test("takes the first (<Link#>) row per interface, skips lo0, tolerates a blank Address column", () => {
    expect(parseNetstatIb(NETSTAT)).toEqual({ inBytes: 61000000, outBytes: 32000000 });
  });

  test("returns null with only a header", () => {
    expect(parseNetstatIb(NETSTAT.split("\n")[0]!)).toBeNull();
  });
});

describe("collectDarwinDiskNet", () => {
  test("degrades each source independently with a warning", async () => {
    const run: Runner = async (argv) => {
      if (argv[0] === "ioreg") return { stdout: IOREG, stderr: "", code: 0, timedOut: false };
      return { stdout: "", stderr: "boom", code: 1, timedOut: false };
    };
    const r = await collectDarwinDiskNet(run, () => 7000);
    expect(r.disk).toEqual({ inBytes: 3000000, outBytes: 750000, atSec: 7 });
    expect(r.net).toBeNull();
    expect(r.warnings).toHaveLength(1);
  });

  test("a runner that throws (binary missing) yields warnings, not an exception", async () => {
    const run: Runner = async () => { throw new Error("ENOENT"); };
    const r = await collectDarwinDiskNet(run);
    expect(r.disk).toBeNull();
    expect(r.net).toBeNull();
    expect(r.warnings).toHaveLength(2);
  });
});
