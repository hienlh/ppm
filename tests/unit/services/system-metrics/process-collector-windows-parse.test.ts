import { describe, test, expect } from "bun:test";
import {
  parseWindowsTick,
  ticksToEpochMs,
  splitLimited,
  decodeCommandLine,
} from "../../../../src/services/system-metrics/process-collector-windows-parse.ts";
import { buildGuardMaps } from "../../../../src/services/system-metrics/kill-identity-resolver.ts";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

// Captured from this Win11 host (paths scrubbed). CreationDate ticks are UTC —
// 637134336000000000 is 2020-01-01T00:00:00Z. CommandLine is base64(UTF-8).
const T2020 = "637134336000000000";
const TICK = [
  "P\t0\t0\tSystem Idle Process\t1234567890000000\t0\t8192\t" + T2020,
  "P\t4\t0\tSystem\t50000000\t0\t151552\t" + T2020,
  "P\t1968\t1884\tservices.exe\t3000000\t1000000\t12582912\t" + T2020,
  "P\t44824\t45560\tbun.exe\t10000000\t20000000\t196345856\t637134336010000000",
  "P\tbad\tline",
  "D\t1000000\t2000000\t50000000000\t10000000",
  "N\tIntel(R) Ethernet Controller I225-V\t500000\t250000\t133000000000000000",
  "C\t44824\t637134336010000000\t" + b64("C:\\Users\\x\\.bun\\bin\\bun.exe run\tsrc\\server\\index.ts"),
  "C\t1968\t" + T2020 + "\t",
  "__ERR__ Access denied",
  "",
].join("\r\n");

describe("ticksToEpochMs", () => {
  test("known UTC ticks → epoch ms via BigInt (value exceeds 2^53)", () => {
    expect(ticksToEpochMs(T2020)).toBe(1577836800000);
    expect(ticksToEpochMs("637134336010000000")).toBe(1577836801000);
  });

  test("empty or non-numeric → 0 (unknown)", () => {
    expect(ticksToEpochMs("")).toBe(0);
    expect(ticksToEpochMs("abc")).toBe(0);
    expect(ticksToEpochMs("1")).toBe(0);
  });
});

describe("splitLimited", () => {
  test("keeps the remainder in the last field", () => {
    expect(splitLimited("a\tb\tc\td", 3)).toEqual(["a", "b", "c\td"]);
    expect(splitLimited("a\tb", 4)).toEqual(["a", "b"]);
  });
});

describe("parseWindowsTick", () => {
  const parsed = parseWindowsTick(TICK);

  test("PID 0 (System Idle Process) is excluded — its kernel time is idle time", () => {
    expect(parsed.processes.some((p) => p.pid === 0)).toBe(false);
    expect(parsed.processes.map((p) => p.pid)).toEqual([4, 1968, 44824]);
  });

  test("names lose their .exe, times become ms, working set becomes MB, ticks become UTC epoch ms", () => {
    const bun = parsed.processes.find((p) => p.pid === 44824)!;
    expect(bun.name).toBe("bun");
    expect(bun.ppid).toBe(45560);
    expect(bun.cpuMs).toBe(3000);
    expect(bun.ramMB).toBeCloseTo(187.25, 2);
    expect(bun.startedAt).toBe(1577836801000);
    expect(bun.command).toBeNull();
    expect(parsed.processes.find((p) => p.pid === 4)!.name).toBe("System");
  });

  test("a CommandLine containing tabs survives base64 decoding intact", () => {
    const cmd = parsed.commands!.find((c) => c.pid === 44824)!;
    expect(cmd.command).toBe("C:\\Users\\x\\.bun\\bin\\bun.exe run\tsrc\\server\\index.ts");
    expect(cmd.startedAt).toBe(1577836801000);
  });

  test("a raw (non-base64) CommandLine field is refused rather than trusted", () => {
    expect(decodeCommandLine("notepad.exe --flag")).toBe("");
    expect(decodeCommandLine("")).toBe("");
    expect(decodeCommandLine(b64("x y"))).toBe("x y");
  });

  test("an access-denied (empty) CommandLine row is dropped, but the C section still counts as fetched", () => {
    expect(parsed.commands!.some((c) => c.pid === 1968)).toBe(false);
    expect(parsed.commands).not.toBeNull();
  });

  test("disk/net counters and __ERR__ lines are surfaced; malformed rows are skipped", () => {
    expect(parsed.disk).toEqual({ inBytes: 1000000, outBytes: 2000000, atSec: 5000 });
    expect(parsed.net?.inBytes).toBe(500000);
    expect(parsed.errors).toEqual(["Access denied"]);
  });

  test("a tick without a C section reports commands: null", () => {
    expect(parseWindowsTick("P\t4\t0\tSystem\t1\t1\t1\t" + T2020).commands).toBeNull();
  });
});

describe("parseWindowsTick — per-process disk and GPU sections", () => {
  const ENG = "pid_44824_luid_0x00000000_0x0000A1B2_phys_0_eng_0_engtype_3D";
  const MEM = "pid_44824_luid_0x00000000_0x0000A1B2_phys_0";
  const TICK10 = [
    // 10-field P rows: …CreationDateUtcTicks, ReadTransferCount, WriteTransferCount.
    "P\t44824\t45560\tbun.exe\t10000000\t20000000\t196345856\t" + T2020 + "\t123456789\t987654321",
    // Access denied / property empty for this row: both counts blank.
    "P\t1968\t1884\tservices.exe\t3000000\t1000000\t12582912\t" + T2020 + "\t\t",
    "G\t" + ENG + "\t5000000\t133000000000000000",
    "M\t" + MEM + "\t1073741824",
  ].join("\r\n");
  const parsed = parseWindowsTick(TICK10);

  test("the two transfer counts land as CUMULATIVE bytes for the rows that have them", () => {
    const bun = parsed.processes.find((p) => p.pid === 44824)!;
    expect(bun.diskReadBytes).toBe(123456789);
    expect(bun.diskWriteBytes).toBe(987654321);
    // Everything else about the row still parses with the wider field list.
    expect(bun.name).toBe("bun");
    expect(bun.startedAt).toBe(1577836800000);
  });

  test("an empty counter field is 'unmeasured', not 0 — and is absent from JSON", () => {
    const services = parsed.processes.find((p) => p.pid === 1968)!;
    expect(services.diskReadBytes).toBeUndefined();
    expect(services.diskWriteBytes).toBeUndefined();
    expect(JSON.stringify(services)).not.toContain("diskReadBytes");
  });

  test("G and M lines are handed to the GPU module, keyed by the pid in the instance name", () => {
    expect(parsed.gpu.present).toBe(true);
    expect(parsed.gpu.engines).toHaveLength(1);
    expect(parsed.gpu.engines[0]!.pid).toBe(44824);
    expect(parsed.gpu.memBytesByPid.get(44824)).toBe(1073741824);
  });

  test("an 8-field P row (older shape / host without the properties) still parses, just without disk", () => {
    const old = parseWindowsTick("P\t7\t1\tx.exe\t0\t0\t1048576\t" + T2020).processes[0]!;
    expect(old.ramMB).toBe(1);
    expect(old.diskReadBytes).toBeUndefined();
  });

  test("a tick with no GPU section reports present:false — the column is then hidden, not zeroed", () => {
    expect(parsed.gpu.present).toBe(true);
    expect(parseWindowsTick(TICK).gpu.present).toBe(false);
  });
});

describe("hostile CommandLine cannot forge rows or truncate the reply", () => {
  // A local process chooses its own argv. Before base64 encoding, `Out-String
  // -Stream` split embedded CR/LF into separate lines, so this argv would have
  // produced a second `P` row renaming lsass (pid 1996) to notepad, plus an
  // end marker that truncates the reply. Encoded, it is one opaque field.
  const hostileArgv = 'evil.exe --x="\nP\t1996\t0\tnotepad.exe\t0\t0\t0\t' + T2020 + '\n__END_1__\n__ERR__ fake"';
  const REAL_LSASS = "P\t1996\t1968\tlsass.exe\t1\t1\t1\t" + T2020;
  const encodedTick = [REAL_LSASS, "C\t5555\t" + T2020 + "\t" + b64(hostileArgv)].join("\r\n");

  test("encoded: the argv stays inside its own C row; no extra P row, no error line", () => {
    const parsed = parseWindowsTick(encodedTick);
    expect(parsed.processes.map((p) => [p.pid, p.name])).toEqual([[1996, "lsass"]]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.commands![0]!.command).toBe(hostileArgv);
    expect(encodedTick).not.toContain("__END_1__");
  });

  test("even if a forged P row got through, the first row for a pid wins and the duplicate is refused", () => {
    // Simulate the pre-encoding transport: the argv split into real lines.
    const forgedTick = [REAL_LSASS, "C\t5555\t" + T2020 + '\tevil.exe --x="', ...hostileArgv.split("\n").slice(1)].join("\r\n");
    const parsed = parseWindowsTick(forgedTick);
    expect(parsed.processes).toHaveLength(2); // the forged row parses as a row…
    const maps = buildGuardMaps(parsed.processes);
    expect(maps.byPid.get(1996)!.name).toBe("lsass"); // …but cannot overwrite the real one
    expect(maps.byPid.size).toBe(1);
    expect(maps.warnings).toEqual(['Duplicate row for PID 1996 ignored (name "notepad")']);
  });
});
