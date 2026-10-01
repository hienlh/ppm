/**
 * The internal SSD's temperature on Apple Silicon, from the HID event system's
 * "NAND CH<n> temp" sensors — the one source that says, in Apple's own words,
 * that a sensor sits on the drive. The SMC has keys that look the part (`TH0a`,
 * `TH0b`, `TH0x` read 36 °C beside the NAND's 34 on an M1 Max), but nothing says
 * which of them is the drive, and a guess would put some other board sensor on
 * the disk page.
 *
 * The event system is the IOKit client API the Apple Silicon temperature tools
 * read (Stats, early macmon): `IOHIDEventSystemClientCreate`, then each
 * temperature service's current event. Reading a temperature needs no entitlement
 * and no privacy grant.
 *
 * Measured on an M1 Max: finding the sensors is 33 ms, once per process (178
 * services, one property read each); one reading is 1.7 ms, more than six SMC
 * reads. A drive's temperature moves over minutes, so it is read at most once
 * every `NAND_REFRESH_MS` and the last reading stands in between.
 */
import { dlopen, FFIType as T } from "bun:ffi";
import { darwinCoreFoundation, type CfRef, type CoreFoundation } from "./core-foundation-darwin.ts";
import { isAppleSilicon } from "./darwin-ffi.ts";

const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";
/** kIOHIDEventTypeTemperature. */
const TEMPERATURE_EVENT = 15;
/** An event field is its type in the top 16 bits and its index below. */
const TEMPERATURE_FIELD = TEMPERATURE_EVENT << 16;
/** One sensor per flash channel: "NAND CH0 temp". */
export const NAND_SENSOR = /^NAND CH\d+ temp$/;
export const NAND_REFRESH_MS = 10_000;

/** The SMC's range for a plausible temperature. */
const MIN_PLAUSIBLE_C = 1;
const MAX_PLAUSIBLE_C = 130;

/** The drive's figure: its hottest channel, which is the one it throttles on. */
export function driveTemperature(readings: readonly (number | undefined)[]): number | undefined {
  let hottest: number | undefined;
  for (const c of readings) {
    if (c === undefined || !(c >= MIN_PLAUSIBLE_C && c <= MAX_PLAUSIBLE_C)) continue;
    hottest = hottest === undefined ? c : Math.max(hottest, c);
  }
  return hottest === undefined ? undefined : Math.round(hottest * 10) / 10;
}

export interface HidTemperatureSensors {
  /** One reading per sensor, °C; undefined for a sensor that did not answer. */
  read(): (number | undefined)[];
}

export interface DriveTemperatureReader {
  read(): number | undefined;
}

/** At most one reading per `NAND_REFRESH_MS`; in between, the last one. */
export function createDriveTemperatureReader(
  sensors: HidTemperatureSensors,
  now: () => number = () => performance.now(),
): DriveTemperatureReader {
  let last: { at: number; value: number | undefined } | undefined;
  return {
    read() {
      const at = now();
      if (last && at - last.at < NAND_REFRESH_MS) return last.value;
      const value = driveTemperature(sensors.read());
      last = { at, value };
      return value;
    },
  };
}

type HidLib = {
  IOHIDEventSystemClientCreate: (allocator: CfRef) => bigint;
  IOHIDEventSystemClientCopyServices: (client: CfRef) => bigint;
  IOHIDServiceClientCopyProperty: (service: CfRef, key: CfRef) => bigint;
  IOHIDServiceClientCopyEvent: (service: CfRef, type: number, options: number, timestamp: number) => bigint;
  IOHIDEventGetFloatValue: (event: CfRef, field: number) => number;
};

/**
 * The NAND sensors, found once. The client and the array of services stay alive
 * for the life of the process: a service reference is only valid while the array
 * that handed it out is.
 */
function openNandSensors(cf: CoreFoundation): HidTemperatureSensors | null {
  const R = T.u64;
  let io: HidLib;
  try {
    io = dlopen(IOKIT, {
      IOHIDEventSystemClientCreate: { args: [R], returns: R },
      IOHIDEventSystemClientCopyServices: { args: [R], returns: R },
      IOHIDServiceClientCopyProperty: { args: [R, R], returns: R },
      IOHIDServiceClientCopyEvent: { args: [R, T.i64, T.i32, T.i64], returns: R },
      IOHIDEventGetFloatValue: { args: [R, T.i32], returns: T.f64 },
    }).symbols as unknown as HidLib;
  } catch {
    return null;
  }
  const client = io.IOHIDEventSystemClientCreate(0n);
  if (client === 0n) return null;
  const services = io.IOHIDEventSystemClientCopyServices(client);
  if (services === 0n) {
    cf.release(client);
    return null;
  }
  const product = cf.string("Product");
  const nand: CfRef[] = [];
  for (let i = 0, n = cf.arrayCount(services); i < n; i++) {
    const service = cf.arrayAt(services, i);
    const name = io.IOHIDServiceClientCopyProperty(service, product);
    if (NAND_SENSOR.test(cf.text(name) ?? "")) nand.push(service);
    cf.release(name);
  }
  cf.release(product);
  if (nand.length === 0) {
    cf.release(services);
    cf.release(client);
    return null;
  }
  return {
    read: () => nand.map((service) => {
      const event = io.IOHIDServiceClientCopyEvent(service, TEMPERATURE_EVENT, 0, 0);
      if (event === 0n) return undefined;
      const c = io.IOHIDEventGetFloatValue(event, TEMPERATURE_FIELD);
      cf.release(event);
      return Number.isFinite(c) ? c : undefined;
    }),
  };
}

/** `undefined` until first asked for; `null` where there is no NAND sensor to
 *  read — an Intel Mac, a VM, or a chip that names its sensors otherwise. */
let shared: DriveTemperatureReader | null | undefined;

/** The internal SSD's temperature, °C, or undefined where this Mac has no sensor
 *  named for it. */
export function darwinDriveTemperature(): number | undefined {
  if (shared === undefined) {
    try {
      const cf = darwinCoreFoundation();
      const sensors = cf && isAppleSilicon() ? openNandSensors(cf) : null;
      shared = sensors ? createDriveTemperatureReader(sensors) : null;
    } catch {
      shared = null;
    }
  }
  return shared?.read();
}
