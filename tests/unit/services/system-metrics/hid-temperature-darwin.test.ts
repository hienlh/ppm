/** The internal SSD's temperature from the HID event system's NAND sensors. */
import { describe, expect, test } from "bun:test";
import {
  createDriveTemperatureReader, darwinDriveTemperature, driveTemperature, NAND_REFRESH_MS, NAND_SENSOR,
  type HidTemperatureSensors,
} from "../../../../src/services/system-metrics/hid-temperature-darwin.ts";

describe("NAND_SENSOR", () => {
  test("one sensor per flash channel, by Apple's name for it", () => {
    expect(NAND_SENSOR.test("NAND CH0 temp")).toBe(true);
    expect(NAND_SENSOR.test("NAND CH12 temp")).toBe(true);
  });

  test("nothing else the event system lists", () => {
    for (const name of ["PMU tdie1", "PMU tdev8", "gas gauge battery", "NAND CH0 temp2", "NAND temp"]) {
      expect(NAND_SENSOR.test(name)).toBe(false);
    }
  });
});

describe("driveTemperature", () => {
  test("the hottest channel, to one decimal", () => {
    expect(driveTemperature([34, 36.04, 35])).toBe(36);
    expect(driveTemperature([34.26])).toBe(34.3);
  });

  test("an implausible reading is left out, and none plausible is no figure", () => {
    expect(driveTemperature([0, 200, Number.NaN, undefined, 41])).toBe(41);
    expect(driveTemperature([0, undefined])).toBeUndefined();
    expect(driveTemperature([])).toBeUndefined();
  });
});

describe("createDriveTemperatureReader", () => {
  function counted(values: (number | undefined)[][]) {
    let calls = 0;
    const sensors: HidTemperatureSensors = { read: () => values[Math.min(calls++, values.length - 1)]! };
    return { sensors, calls: () => calls };
  }

  test("reads once per refresh period and repeats that reading in between", () => {
    const clock = { ms: 0 };
    const fake = counted([[34], [37]]);
    const reader = createDriveTemperatureReader(fake.sensors, () => clock.ms);
    expect(reader.read()).toBe(34);
    clock.ms = NAND_REFRESH_MS - 1;
    expect(reader.read()).toBe(34);
    expect(fake.calls()).toBe(1);
    clock.ms = NAND_REFRESH_MS;
    expect(reader.read()).toBe(37);
    expect(fake.calls()).toBe(2);
  });

  test("a sensor that did not answer is asked again at the next period, not every tick", () => {
    const clock = { ms: 0 };
    const fake = counted([[undefined], [35]]);
    const reader = createDriveTemperatureReader(fake.sensors, () => clock.ms);
    expect(reader.read()).toBeUndefined();
    clock.ms = 2000;
    expect(reader.read()).toBeUndefined();
    expect(fake.calls()).toBe(1);
    clock.ms = NAND_REFRESH_MS;
    expect(reader.read()).toBe(35);
  });
});

test.if(process.platform === "darwin" && process.arch === "arm64")("this Mac's NAND sensor reads plausibly, and a repeat is free", () => {
  const c = darwinDriveTemperature();
  expect(c).toBeGreaterThanOrEqual(1);
  expect(c).toBeLessThanOrEqual(130);
  const started = performance.now();
  expect(darwinDriveTemperature()).toBe(c);
  expect(performance.now() - started).toBeLessThan(0.5);
});

test.if(process.platform !== "darwin")("off darwin there is no drive sensor", () => {
  expect(darwinDriveTemperature()).toBeUndefined();
});
