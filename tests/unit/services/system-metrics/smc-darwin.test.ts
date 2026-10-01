/**
 * The SMC reader's pure halves against a fake controller, plus one live check on
 * a Mac. The fake keeps its keys sorted exactly as the real firmware does, and
 * answers by index, so the prefix search is exercised the way it runs for real.
 */
import { describe, expect, test } from "bun:test";
import {
  createSmcSampler, darwinSmc, decodeSmcValue, fourCC, fourCCString, keysInRange, meanCelsius, planFans, planSmc,
  planTemperatures, readSmcNumber, readSmcSensors, SMC_FULL_READ_AFTER_MS, SMC_TICK_BUDGET_MS,
  type SmcKeyInfo, type SmcReader, type SmcReadings,
} from "../../../../src/services/system-metrics/smc-darwin.ts";

const flt = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; };
const sp78 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, Math.round(v * 256), false); return b; };
const fpe2 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Math.round(v * 4), false); return b; };
const ioft = () => new Uint8Array(8);
const ui8 = (v: number) => Uint8Array.of(v);

interface FakeKey { type: string; value: () => Uint8Array }
type Table = Record<string, FakeKey>;
const key = (type: string, bytes: Uint8Array | (() => Uint8Array)): FakeKey =>
  ({ type, value: typeof bytes === "function" ? bytes : () => bytes });

/** A controller with the given keys, sorted by code like the real table, that
 *  counts every round trip. */
function fakeSmc(table: Table): SmcReader & { calls: number; indexCalls: number; reads: string[] } {
  const sorted = Object.keys(table).sort((a, b) => fourCC(a) - fourCC(b));
  const fake = {
    calls: 0,
    indexCalls: 0,
    reads: [] as string[],
    keysWithPrefix(prefix: string) {
      return keysInRange(prefix, sorted.length, (i) => {
        fake.calls++;
        fake.indexCalls++;
        const k = sorted[i];
        return k === undefined ? undefined : fourCC(k);
      });
    },
    info(k: string): SmcKeyInfo | undefined {
      fake.calls++;
      const entry = table[k];
      return entry ? { type: entry.type, size: entry.value().byteLength } : undefined;
    },
    read(k: string) {
      fake.calls++;
      fake.reads.push(k);
      return table[k]?.value();
    },
  };
  return fake;
}

describe("four-character codes", () => {
  test("a key packs big-endian into a u32, and back", () => {
    expect(fourCC("TC0P")).toBe(0x54433050);
    expect(fourCCString(0x54433050)).toBe("TC0P");
    expect(fourCCString(fourCC("#KEY"))).toBe("#KEY");
  });

  test("the code of a high key is unsigned, so ordering by it is ordering by name", () => {
    expect(fourCC("zSX0")).toBeGreaterThan(fourCC("Tp0c"));
    expect(fourCC("zSX0")).toBeGreaterThan(0);
  });

  test("anything but four characters is refused rather than padded", () => {
    expect(() => fourCC("TC0")).toThrow();
    expect(() => fourCC("TC0PX")).toThrow();
  });
});

describe("decodeSmcValue", () => {
  test("flt is a little-endian float — Apple Silicon's temperatures and fan speeds", () => {
    expect(decodeSmcValue("flt ", flt(52.25))).toBe(52.25);
  });

  test("sp78 is big-endian signed 7.8 fixed point — Intel's temperatures", () => {
    expect(decodeSmcValue("sp78", new Uint8Array([0x2f, 0x80]))).toBe(47.5);
    expect(decodeSmcValue("sp78", sp78(-5))).toBe(-5);
  });

  test("fpe2 is big-endian unsigned 14.2 fixed point — Intel's fan speeds", () => {
    expect(decodeSmcValue("fpe2", new Uint8Array([0x17, 0x70]))).toBe(1500);
  });

  test("integers are big-endian, signed ones keep their sign", () => {
    expect(decodeSmcValue("ui8 ", new Uint8Array([2]))).toBe(2);
    expect(decodeSmcValue("ui16", new Uint8Array([0x01, 0x02]))).toBe(0x0102);
    expect(decodeSmcValue("ui32", new Uint8Array([0, 0, 0x08, 0xcb]))).toBe(2251);
    expect(decodeSmcValue("si8 ", new Uint8Array([0xff]))).toBe(-1);
    expect(decodeSmcValue("si16", new Uint8Array([0xff, 0xfe]))).toBe(-2);
  });

  test("a type this code does not know, or too few bytes, is not guessed at", () => {
    expect(decodeSmcValue("ioft", ioft())).toBeUndefined();
    expect(decodeSmcValue("flt ", new Uint8Array(2))).toBeUndefined();
    expect(decodeSmcValue("sp78", new Uint8Array(1))).toBeUndefined();
  });

  test("a view into a larger buffer is read from its own offset", () => {
    const whole = new Uint8Array(8);
    whole.set(flt(33.5), 4);
    expect(decodeSmcValue("flt ", whole.subarray(4))).toBe(33.5);
  });
});

describe("keysInRange", () => {
  const table: Table = {
    "#KEY": key("ui32", new Uint8Array(4)), "AC-B": key("ui8 ", new Uint8Array(1)),
    F0Ac: key("flt ", flt(1500)), FNum: key("ui8 ", new Uint8Array([1])),
    TC10: key("flt ", flt(47)), Te00: key("flt ", flt(45)), Tg05: key("flt ", flt(50)),
    Tp00: key("flt ", flt(44)), Tp01: key("flt ", flt(53)), Tp0c: key("flt ", flt(58)),
    zSX0: key("ui8 ", new Uint8Array(1)),
  };

  test("finds exactly the keys carrying the prefix", () => {
    const smc = fakeSmc(table);
    expect([...smc.keysWithPrefix("Tp")]).toEqual(["Tp00", "Tp01", "Tp0c"]);
    expect([...smc.keysWithPrefix("F")]).toEqual(["F0Ac", "FNum"]);
    expect([...smc.keysWithPrefix("T")]).toEqual(["TC10", "Te00", "Tg05", "Tp00", "Tp01", "Tp0c"]);
  });

  test("the first and last keys of the table are reachable", () => {
    const smc = fakeSmc(table);
    expect([...smc.keysWithPrefix("#")]).toEqual(["#KEY"]);
    expect([...smc.keysWithPrefix("zS")]).toEqual(["zSX0"]);
  });

  test("a prefix nothing carries is an empty list", () => {
    expect([...fakeSmc(table).keysWithPrefix("Tz")]).toEqual([]);
    expect([...fakeSmc(table).keysWithPrefix("~")]).toEqual([]);
  });

  test("a search costs a logarithm of the table, not the table", () => {
    // The point of searching: listing an M1 Max's 2251 keys one by one blocked
    // the event loop for 451 ms.
    const big: Table = {};
    for (let i = 0; i < 2000; i++) big[`A${i.toString(36).padStart(3, "0")}`] = key("ui8 ", new Uint8Array(1));
    Object.assign(big, { Tp00: table.Tp00!, Tp01: table.Tp01! });
    const smc = fakeSmc(big);
    expect([...smc.keysWithPrefix("Tp")]).toEqual(["Tp00", "Tp01"]);
    expect(smc.indexCalls).toBeLessThanOrEqual(Math.ceil(Math.log2(2002)) + 3);
  });

  test("a refused index ends the scan instead of being skipped", () => {
    // Index 2 is past everything the search probes in a table of three, so the
    // refusal lands in the forward scan.
    const keys = ["Tp00", "Tp01", "Tp02"];
    expect(keysInRange("Tp", 3, (i) => (i === 2 ? undefined : fourCC(keys[i]!)))).toEqual(["Tp00", "Tp01"]);
  });

  test("a refused index during the search finds nothing rather than a wrong range", () => {
    expect(keysInRange("Tp", 3, () => undefined)).toEqual([]);
  });

  test("a prefix must be 1-3 characters", () => {
    expect(() => keysInRange("", 1, () => 0)).toThrow();
    expect(() => keysInRange("Tp01", 1, () => 0)).toThrow();
  });
});

describe("planTemperatures on Apple Silicon", () => {
  const m1: Table = {
    TC10: key("flt ", flt(47.2)), TCMz: key("flt ", flt(65)),
    TG0B: key("ioft", ioft()),
    Te00: key("flt ", flt(45.2)), Te01: key("flt ", flt(58.6)),
    Tg05: key("flt ", flt(54.1)), Tg0D: key("flt ", flt(52.8)),
    Tp01: key("flt ", flt(53.3)), Tp05: key("flt ", flt(53.5)),
    TB0T: key("flt ", flt(35.1)),
  };

  test("CPU is Tp + Te, GPU is Tg", () => {
    const plan = planTemperatures(fakeSmc(m1), true);
    expect(plan.cpu.map((s) => s.key)).toEqual(["Te00", "Te01", "Tp01", "Tp05"]);
    expect(plan.gpu.map((s) => s.key)).toEqual(["Tg05", "Tg0D"]);
  });

  test("the TC keys an M1 publishes are never read as the CPU", () => {
    const plan = planTemperatures(fakeSmc(m1), true);
    expect(plan.cpu.some((s) => s.key.startsWith("TC"))).toBe(false);
  });

  test("a key of a type that is not a temperature encoding is left out", () => {
    const table = { ...m1, Tg0K: key("ioft", ioft()) };
    expect(planTemperatures(fakeSmc(table), true).gpu.map((s) => s.key)).toEqual(["Tg05", "Tg0D"]);
  });

  test("a core that reads 0 while the plan is built is kept, and counts once it wakes", () => {
    let asleep = true;
    const table: Table = {
      Tp01: key("flt ", flt(50)),
      Tp05: key("flt ", () => flt(asleep ? 0 : 60)),
    };
    const smc = fakeSmc(table);
    const plan = planTemperatures(smc, true);
    expect(plan.cpu.map((s) => s.key)).toEqual(["Tp01", "Tp05"]);
    expect(meanCelsius(smc, plan.cpu)).toBe(50);
    asleep = false;
    expect(meanCelsius(smc, plan.cpu)).toBe(55);
  });

  test("building the plan reads no values at all", () => {
    const smc = fakeSmc(m1);
    planTemperatures(smc, true);
    expect(smc.reads).toEqual([]);
  });
});

describe("planTemperatures on Intel", () => {
  test("per-core sensors win over the die and the proximity sensor", () => {
    const table: Table = {
      TC0C: key("sp78", sp78(60)), TC1C: key("sp78", sp78(62)),
      TC0D: key("sp78", sp78(65)), TC0P: key("sp78", sp78(50)),
    };
    expect(planTemperatures(fakeSmc(table), false).cpu.map((s) => s.key)).toEqual(["TC0C", "TC1C"]);
  });

  test("with no per-core sensor the die is used, never averaged with proximity", () => {
    const table: Table = { TC0D: key("sp78", sp78(65)), TC0P: key("sp78", sp78(50)), TCXC: key("sp78", sp78(66)) };
    expect(planTemperatures(fakeSmc(table), false).cpu.map((s) => s.key)).toEqual(["TC0D", "TCXC"]);
  });

  test("proximity is the last resort", () => {
    const table: Table = { TC0P: key("sp78", sp78(50)) };
    expect(planTemperatures(fakeSmc(table), false).cpu.map((s) => s.key)).toEqual(["TC0P"]);
  });

  test("an Intel iMac's Tp0P is its power supply, not the CPU", () => {
    const table: Table = { TC0P: key("sp78", sp78(50)), Tp0P: key("sp78", sp78(40)) };
    expect(planTemperatures(fakeSmc(table), false).cpu.map((s) => s.key)).toEqual(["TC0P"]);
  });

  test("GPU: the die before the proximity sensor", () => {
    const table: Table = { TG0D: key("sp78", sp78(70)), TG0P: key("sp78", sp78(55)) };
    expect(planTemperatures(fakeSmc(table), false).gpu.map((s) => s.key)).toEqual(["TG0D"]);
    expect(planTemperatures(fakeSmc({ TG0P: table.TG0P! }), false).gpu.map((s) => s.key)).toEqual(["TG0P"]);
  });
});

describe("meanCelsius", () => {
  const sensors = (smc: SmcReader, keys: string[]) => keys.map((k) => ({ key: k, info: smc.info(k)! }));

  test("the mean of every plausible reading, to one decimal", () => {
    const smc = fakeSmc({ Tp01: key("flt ", flt(50)), Tp05: key("flt ", flt(51)), Tp09: key("flt ", flt(51)) });
    expect(meanCelsius(smc, sensors(smc, ["Tp01", "Tp05", "Tp09"]))).toBe(50.7);
  });

  test("readings outside 1-130 °C are left out, not averaged in", () => {
    const smc = fakeSmc({
      Tp01: key("flt ", flt(50)), Tp05: key("flt ", flt(0)),
      Tp09: key("flt ", flt(-127)), Tp0D: key("flt ", flt(200)), Tp0H: key("flt ", flt(Number.NaN)),
    });
    expect(meanCelsius(smc, sensors(smc, ["Tp01", "Tp05", "Tp09", "Tp0D", "Tp0H"]))).toBe(50);
  });

  test("nothing plausible is no temperature, not 0 °C", () => {
    const smc = fakeSmc({ Tp01: key("flt ", flt(0)) });
    expect(meanCelsius(smc, sensors(smc, ["Tp01"]))).toBeUndefined();
    expect(meanCelsius(smc, [])).toBeUndefined();
  });

  test("a read the controller refuses is skipped", () => {
    const smc = fakeSmc({ Tp01: key("flt ", flt(50)) });
    const list = [...sensors(smc, ["Tp01"]), { key: "Tp05", info: { type: "flt ", size: 4 } }];
    expect(meanCelsius(smc, list)).toBe(50);
  });
});

describe("readSmcNumber", () => {
  test("decodes by the key's own type", () => {
    const smc = fakeSmc({ FNum: key("ui8 ", new Uint8Array([2])), F0Ac: key("fpe2", fpe2(1500)) });
    expect(readSmcNumber(smc, "FNum")).toBe(2);
    expect(readSmcNumber(smc, "F0Ac")).toBe(1500);
  });

  test("a key the controller does not have is undefined", () => {
    expect(readSmcNumber(fakeSmc({}), "PCPC")).toBeUndefined();
  });
});

describe("planFans", () => {
  const twoFans: Table = {
    FNum: key("ui8 ", ui8(2)),
    F0Ac: key("flt ", flt(1515.7)), F0Mn: key("flt ", flt(1499)), F0Mx: key("flt ", flt(5348)),
    F1Ac: key("flt ", flt(1647.2)), F1Mn: key("flt ", flt(1499)), F1Mx: key("flt ", flt(5776)),
  };

  test("every fan FNum counts, with the keys of its speed and its range", () => {
    expect(planFans(fakeSmc(twoFans)).map((f) => [f.index, f.actual.key, f.min?.key, f.max?.key])).toEqual([
      [0, "F0Ac", "F0Mn", "F0Mx"],
      [1, "F1Ac", "F1Mn", "F1Mx"],
    ]);
  });

  test("a Mac with no fans has none to list, however it says so", () => {
    expect(planFans(fakeSmc({ FNum: key("ui8 ", ui8(0)) }))).toEqual([]);
    expect(planFans(fakeSmc({}))).toEqual([]);
  });

  test("Intel's fixed-point speeds are fans too; a key of another type is not", () => {
    const table: Table = {
      FNum: key("ui8 ", ui8(2)),
      F0Ac: key("fpe2", fpe2(1200)), F0Mn: key("fpe2", fpe2(1200)),
      F1Ac: key("ioft", ioft()),
    };
    expect(planFans(fakeSmc(table)).map((f) => [f.actual.key, f.min?.key, f.max?.key])).toEqual([["F0Ac", "F0Mn", undefined]]);
  });

  test("a count past the one-digit keys stops at the last key there can be", () => {
    const table: Table = { FNum: key("ui8 ", ui8(40)), F9Ac: key("flt ", flt(900)) };
    expect(planFans(fakeSmc(table)).map((f) => f.index)).toEqual([9]);
  });
});

describe("createSmcSampler", () => {
  // Twelve CPU sensors whose values say which one they are, one GPU sensor, one fan.
  const cpuKeys = Array.from({ length: 12 }, (_, i) => `Tp0${"0123456789AB"[i]}`);
  function rig(overrides: Table = {}) {
    const clock = { ms: 0 };
    const values = new Map<string, number>(cpuKeys.map((k, i) => [k, 40 + i]));
    const table: Table = {
      FNum: key("ui8 ", ui8(1)),
      F0Ac: key("flt ", () => flt(values.get("F0Ac") ?? 1500)),
      F0Mn: key("flt ", flt(1200)), F0Mx: key("flt ", flt(6000)),
      Tg05: key("flt ", () => flt(values.get("Tg05") ?? 50)),
      ...Object.fromEntries(cpuKeys.map((k) => [k, key("flt ", () => flt(values.get(k)!))])),
      ...overrides,
    };
    const smc = fakeSmc(table);
    // Every read costs 1 ms, so the 4 ms budget fits the fan and three more keys.
    const timed: SmcReader = { ...smc, read(k, info) { clock.ms += 1; return smc.read(k, info); } };
    const sampler = createSmcSampler(timed, planSmc(timed, true), () => clock.ms);
    const readsOf = (fn: () => void) => { const before = smc.reads.length; fn(); return smc.reads.slice(before); };
    return { clock, values, smc, sampler, readsOf };
  }

  test("the first tick reads everything", () => {
    const { sampler, readsOf } = rig();
    let out: SmcReadings | undefined;
    const reads = readsOf(() => { out = sampler.read(); });
    expect(reads.length).toBe(1 + 12 + 1 + 2);
    expect(out).toEqual({
      temperatures: { cpuC: 45.5, gpuC: 50 },
      fans: [{ index: 0, rpm: 1500, minRpm: 1200, maxRpm: 6000 }],
    });
  });

  test("later ticks read the fan, then as many other keys as the budget leaves", () => {
    const { sampler, readsOf, clock } = rig();
    sampler.read();
    clock.ms += 2000;
    const reads = readsOf(() => sampler.read());
    expect(reads[0]).toBe("F0Ac");
    expect(reads.length).toBe(SMC_TICK_BUDGET_MS);
  });

  test("round-robin reaches every key, and the mean is over every latest reading", () => {
    const { sampler, readsOf, clock, values } = rig();
    sampler.read();
    for (const k of cpuKeys) values.set(k, 70);
    const seen = new Set<string>();
    const means: (number | undefined)[] = [];
    for (let tick = 0; tick < 5; tick++) {
      clock.ms += 2000;
      readsOf(() => means.push(sampler.read().temperatures.cpuC)).forEach((k) => seen.add(k));
    }
    // Three keys a tick: the mean climbs as the twelve CPU sensors are re-read,
    // rather than jumping to whatever the three read this tick say.
    expect(means).toEqual([52.8, 59.3, 65, 70, 70]);
    // Fifteen slow keys at three a tick: all of them within five ticks.
    expect(seen.size).toBe(1 + 15);
  });

  test("a controller too slow for the budget still reads one more key a tick", () => {
    const { sampler, readsOf, clock, smc } = rig();
    sampler.read();
    const slowRead: SmcReader["read"] = (k, info) => { clock.ms += 10; return smc.read(k, info); };
    const s = createSmcSampler({ ...smc, read: slowRead }, planSmc(smc, true), () => clock.ms);
    s.read();
    clock.ms += 2000;
    expect(readsOf(() => s.read()).length).toBe(2);
  });

  test("after a gap the readings are all taken again", () => {
    const { sampler, readsOf, clock } = rig();
    sampler.read();
    clock.ms += SMC_FULL_READ_AFTER_MS + 1;
    expect(readsOf(() => sampler.read()).length).toBe(16);
  });

  test("a stopped fan is listed at 0; a negative speed is no reading", () => {
    const { sampler, values, clock } = rig();
    values.set("F0Ac", 0);
    expect(sampler.read().fans).toEqual([{ index: 0, rpm: 0, minRpm: 1200, maxRpm: 6000 }]);
    values.set("F0Ac", -3);
    clock.ms += 2000;
    expect(sampler.read().fans).toEqual([]);
  });

  test("a floor above the ceiling is a misread, and neither is shown", () => {
    const { sampler } = rig({ F0Mn: key("flt ", flt(7000)) });
    expect(sampler.read().fans).toEqual([{ index: 0, rpm: 1500 }]);
  });

  test("a sensor that stops reading plausibly leaves the mean until it does again", () => {
    const { sampler, values, clock } = rig();
    sampler.read();
    values.set("Tg05", 0);
    for (let tick = 0; tick < 5; tick++) { clock.ms += 2000; sampler.read(); }
    expect(sampler.read().temperatures.gpuC).toBeUndefined();
    values.set("Tg05", 44);
    for (let tick = 0; tick < 5; tick++) { clock.ms += 2000; sampler.read(); }
    expect(sampler.read().temperatures.gpuC).toBe(44);
  });
});

describe("readSmcSensors", () => {
  test("no controller is no temperatures and no fans — any platform but darwin", () => {
    expect(readSmcSensors(null)).toEqual({ temperatures: {}, fans: [] });
  });

  test("CPU and GPU from one reader", () => {
    const smc = fakeSmc({ Tg05: key("flt ", flt(48)), Tp01: key("flt ", flt(52)), Tp05: key("flt ", flt(54)) });
    expect(readSmcSensors(smc, Date.now, () => true).temperatures).toEqual({ cpuC: 53, gpuC: 48 });
  });

  test("a Mac with no GPU sensor has no GPU figure, rather than 0", () => {
    const smc = fakeSmc({ Tp01: key("flt ", flt(52)) });
    const t = readSmcSensors(smc, Date.now, () => true).temperatures;
    expect(t.cpuC).toBe(52);
    expect("gpuC" in t).toBe(false);
  });

  test.if(process.platform === "darwin")("this Mac's fans, and a tick within the budget", () => {
    const smc = darwinSmc()!;
    const s = createSmcSampler(smc, planSmc(smc, process.arch === "arm64"));
    const first = s.read();
    for (const fan of first.fans) {
      expect(fan.rpm).toBeGreaterThanOrEqual(0);
      if (fan.minRpm !== undefined && fan.maxRpm !== undefined) expect(fan.minRpm).toBeLessThan(fan.maxRpm);
    }
    const started = performance.now();
    s.read();
    // The budget plus the one read that may start just before it runs out.
    expect(performance.now() - started).toBeLessThan(SMC_TICK_BUDGET_MS + 2);
  });
});

describe("readSmcSensors on the real controller", () => {
  test.if(process.platform === "darwin")("this Mac's controller answers, and a second call within a second is free", () => {
    const smc = darwinSmc();
    expect(smc).not.toBeNull();
    const at = Date.now();
    const first = readSmcSensors(smc, () => at);
    expect(first.temperatures.cpuC).toBeGreaterThan(1);
    expect(first.temperatures.cpuC).toBeLessThan(130);
    expect(readSmcSensors(smc, () => at + 500)).toBe(first);
    expect(readSmcSensors(smc, () => at + 1500)).not.toBe(first);
  });

  test.if(process.platform !== "darwin")("off darwin there is no controller to open", () => {
    expect(darwinSmc()).toBeNull();
    expect(readSmcSensors()).toEqual({ temperatures: {}, fans: [] });
  });
});
