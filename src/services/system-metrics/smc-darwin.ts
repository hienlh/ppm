/**
 * The System Management Controller — every temperature, fan and power rail a Mac
 * publishes, read over bun:ffi through AppleSMC's user client. This is the Mac's
 * hwmon: no privilege is needed to READ it (an ordinary process opened the
 * service and read all 2251 keys of an M1 Max).
 *
 * None of it is documented. The protocol is the one every tool that shows Mac
 * temperatures uses (smcFanControl, iStat, Stats, macmon): one 80-byte
 * `SMCKeyData_t` in and out of `IOConnectCallStructMethod` selector 2, with the
 * command in `data8` — read-by-index to list the keys, get-info for a key's type
 * and size, read for its bytes. Offsets below were checked on this hardware.
 *
 * Which key means what is not documented either, and changes with every chip, so
 * there is no per-model table here. The keys are read from the controller itself,
 * and sensors are chosen by the names those tools agree on (`Tp`/`Te` for CPU
 * cores on Apple Silicon, `Tg` for its GPU, `TC`/`TG` on Intel). A chip that
 * renames its sensors therefore reports no temperature — an em dash — rather
 * than someone else's. Which family of names applies is decided by the CPU, not
 * by which keys exist: an M1 Max publishes 24 `TC..` keys, none of them the CPU,
 * and an Intel iMac has a `Tp0P` that is its power supply.
 *
 * Every call is a round trip to the controller's firmware, measured at 0.2 ms,
 * which shapes four decisions:
 *   - Keys are found per PREFIX by binary search over the controller's own index
 *     rather than by listing all of them: the table is sorted (2251 keys strictly
 *     ascending on an M1 Max — the firmware binary-searches it itself), and a full
 *     listing cost 451 ms of blocked event loop. If a controller ever broke that
 *     order, the search would find fewer sensors, never wrong ones.
 *   - The sensors are chosen once per process (`planSmc`), not per tick.
 *   - A tick reads within a budget (`createSmcSampler`): the 41 temperature
 *     sensors of an M1 Max read in one go held the event loop for 11-19 ms.
 *   - One tick's readings are memoised for a second, so the CPU and GPU pages
 *     share one set of reads instead of paying for it twice.
 *
 * Opened lazily and kept open: the connection is a Mach port, and opening one
 * per tick would take a new right every time.
 */
import { dlopen, FFIType as T, ptr } from "bun:ffi";
import { isAppleSilicon } from "./darwin-ffi.ts";

const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const KERN_SUCCESS = 0;
/** AppleSMC's struct method: `kSMCHandleYPCEvent`. */
const SMC_SELECTOR = 2;

/** `sizeof(SMCKeyData_t)` on both x86_64 and arm64. */
export const SMC_KEY_DATA_BYTES = 80;
const OFF_KEY = 0;
const OFF_DATA_SIZE = 28;
const OFF_DATA_TYPE = 32;
const OFF_RESULT = 40;
const OFF_DATA8 = 42;
const OFF_DATA32 = 44;
const OFF_BYTES = 48;
const MAX_VALUE_BYTES = 32;

/** `data8` commands. */
const CMD_READ_BYTES = 5;
const CMD_READ_INDEX = 8;
const CMD_READ_KEYINFO = 9;

/** A key's type is a four-character code too: "flt ", "sp78", "ui8 ". */
export interface SmcKeyInfo {
  size: number;
  type: string;
}

/** What the sensor code asks of the controller. Injected, so every consumer is
 *  tested against a key table and only this file touches IOKit. */
export interface SmcReader {
  /** Every key starting with `prefix` (1-3 characters), in the controller's order. */
  keysWithPrefix(prefix: string): readonly string[];
  info(key: string): SmcKeyInfo | undefined;
  read(key: string, info: SmcKeyInfo): Uint8Array | undefined;
}

/** "TC0P" → 0x54433050: the SMC packs a key big-endian into a u32. */
export function fourCC(key: string): number {
  if (key.length !== 4) throw new Error(`SMC key must be 4 characters: "${key}"`);
  return ((key.charCodeAt(0) << 24) | (key.charCodeAt(1) << 16) | (key.charCodeAt(2) << 8) | key.charCodeAt(3)) >>> 0;
}

export function fourCCString(code: number): string {
  return String.fromCharCode((code >>> 24) & 0xff, (code >>> 16) & 0xff, (code >>> 8) & 0xff, code & 0xff);
}

/**
 * A value by its declared type. The encodings are the SMC's own and mix byte
 * orders: `flt ` is a little-endian float (Apple Silicon), everything fixed-point
 * or integer is big-endian (`sp78` = signed 7.8, `fpe2` = unsigned 14.2 — Intel's
 * temperatures and fan speeds). Unknown types are not guessed at.
 */
export function decodeSmcValue(type: string, bytes: Uint8Array): number | undefined {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n: number) => bytes.byteLength >= n;
  switch (type) {
    case "flt ": return need(4) ? v.getFloat32(0, true) : undefined;
    case "ui8 ":
    case "flag": return need(1) ? v.getUint8(0) : undefined;
    case "si8 ": return need(1) ? v.getInt8(0) : undefined;
    case "ui16": return need(2) ? v.getUint16(0, false) : undefined;
    case "si16": return need(2) ? v.getInt16(0, false) : undefined;
    case "ui32": return need(4) ? v.getUint32(0, false) : undefined;
    case "sp78": return need(2) ? v.getInt16(0, false) / 256 : undefined;
    case "fpe2": return need(2) ? v.getUint16(0, false) / 4 : undefined;
    default: return undefined;
  }
}

export function readSmcNumber(reader: SmcReader, key: string): number | undefined {
  const info = reader.info(key);
  if (!info) return undefined;
  const bytes = reader.read(key, info);
  if (!bytes) return undefined;
  const value = decodeSmcValue(info.type, bytes);
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------- temperatures

/** A reading outside this range is not a temperature: a powered-down core reads
 *  0, and some boards leave a key at -127 or at a raw constant. */
const MIN_PLAUSIBLE_C = 1;
const MAX_PLAUSIBLE_C = 130;

export interface SmcSensor {
  key: string;
  info: SmcKeyInfo;
}

/** The sensors behind the CPU and GPU temperatures, chosen once per process. */
export interface SmcTemperaturePlan {
  cpu: SmcSensor[];
  gpu: SmcSensor[];
}

/** Temperatures are `flt ` on Apple Silicon and `sp78` on Intel; anything else
 *  under a temperature-looking name (an M1 Max's `TG..` keys are `ioft`) is not
 *  a reading this code can decode. */
const TEMPERATURE_TYPES = new Set(["flt ", "sp78"]);

/**
 * Sensor names per CPU family, in tiers: the first tier with any sensor wins, so
 * a mean never mixes a die reading with a proximity one.
 *
 * Apple Silicon — what macmon and Stats both read: `Tp..` (performance cores,
 * and M1/M2 efficiency cores), `Te..` (efficiency cores from M3 on), `Tg..` GPU.
 * Intel: per-core `TC<n>C`, else the die (`TC<n>D/E/F`, `TCXC`), else the
 * proximity sensor `TC<n>P`; for the GPU the die before the proximity sensor.
 */
const FAMILIES = {
  appleSilicon: {
    cpu: [{ prefixes: ["Te", "Tp"], name: /^T[pe][0-9A-Za-z]{2}$/ }],
    gpu: [{ prefixes: ["Tg"], name: /^Tg[0-9A-Za-z]{2}$/ }],
  },
  intel: {
    cpu: [
      { prefixes: ["TC"], name: /^TC\dC$/ },
      { prefixes: ["TC"], name: /^(TC\d[DEF]|TCXC)$/ },
      { prefixes: ["TC"], name: /^TC\dP$/ },
    ],
    gpu: [
      { prefixes: ["TG"], name: /^TG\dD$/ },
      { prefixes: ["TG"], name: /^TG\dP$/ },
    ],
  },
} as const;

type Tier = { readonly prefixes: readonly string[]; readonly name: RegExp };

/**
 * Sensors are kept by NAME and TYPE, not by what they read today: a core that is
 * powered down while the plan is built reads 0, and dropping it then would drop
 * it for the life of the process. `meanCelsius` leaves out an implausible reading
 * per tick instead.
 */
export function planTemperatures(reader: SmcReader, appleSilicon: boolean): SmcTemperaturePlan {
  const family = appleSilicon ? FAMILIES.appleSilicon : FAMILIES.intel;
  return { cpu: firstTier(reader, family.cpu), gpu: firstTier(reader, family.gpu) };
}

function firstTier(reader: SmcReader, tiers: readonly Tier[]): SmcSensor[] {
  for (const tier of tiers) {
    const sensors: SmcSensor[] = [];
    for (const key of tier.prefixes.flatMap((prefix) => reader.keysWithPrefix(prefix))) {
      if (!tier.name.test(key)) continue;
      const info = reader.info(key);
      if (info && TEMPERATURE_TYPES.has(info.type)) sensors.push({ key, info });
    }
    if (sensors.length > 0) return sensors;
  }
  return [];
}

function readCelsius(reader: SmcReader, sensor: SmcSensor): number | undefined {
  const bytes = reader.read(sensor.key, sensor.info);
  if (!bytes) return undefined;
  const c = decodeSmcValue(sensor.info.type, bytes);
  return c !== undefined && c >= MIN_PLAUSIBLE_C && c <= MAX_PLAUSIBLE_C ? c : undefined;
}

/** Mean over the sensors that read plausibly THIS time, to one decimal. A core
 *  that is powered down reads 0 and would drag the average down, so it is left
 *  out rather than counted. */
export function meanCelsius(reader: SmcReader, sensors: readonly SmcSensor[]): number | undefined {
  let sum = 0;
  let n = 0;
  for (const sensor of sensors) {
    const c = readCelsius(reader, sensor);
    if (c === undefined) continue;
    sum += c;
    n++;
  }
  return n > 0 ? Math.round((sum / n) * 10) / 10 : undefined;
}

// ---------------------------------------------------------------- the real controller

type IoKit = {
  IOServiceMatching: (name: Uint8Array) => number | null;
  IOServiceGetMatchingService: (mainPort: number, matching: number | null) => number;
  IOServiceOpen: (service: number, task: number, type: number, connect: number) => number;
  IOObjectRelease: (object: number) => number;
  IOConnectCallStructMethod: (conn: number, selector: number, input: number, inputSize: bigint | number, output: number, outputSize: number) => number;
};

/** `undefined` until first asked for; `null` where there is no controller to open
 *  (off darwin, inside a VM with no AppleSMC, or a sandbox that denies it). */
let controller: SmcReader | null | undefined;

function openController(): SmcReader | null {
  if (process.platform !== "darwin") return null;
  let io: IoKit;
  let taskSelf: number;
  try {
    io = dlopen(IOKIT, {
      IOServiceMatching: { args: [T.ptr], returns: T.ptr },
      IOServiceGetMatchingService: { args: [T.u32, T.ptr], returns: T.u32 },
      IOServiceOpen: { args: [T.u32, T.u32, T.u32, T.ptr], returns: T.i32 },
      IOObjectRelease: { args: [T.u32], returns: T.i32 },
      IOConnectCallStructMethod: { args: [T.u32, T.u32, T.ptr, T.u64, T.ptr, T.ptr], returns: T.i32 },
    }).symbols as unknown as IoKit;
    const sys = dlopen(LIBSYSTEM, { task_self_trap: { args: [], returns: T.u32 } }).symbols;
    taskSelf = sys.task_self_trap() as number;
  } catch {
    return null;
  }

  // The matching dictionary is consumed by IOServiceGetMatchingService.
  const matching = io.IOServiceMatching(new TextEncoder().encode("AppleSMC\0"));
  if (!matching) return null;
  const service = io.IOServiceGetMatchingService(0, matching);
  if (!service) return null;
  const connOut = new Uint32Array(1);
  const kr = io.IOServiceOpen(service, taskSelf, 0, ptr(connOut));
  io.IOObjectRelease(service);
  if (kr !== KERN_SUCCESS || connOut[0] === 0) return null;
  const conn = connOut[0]!;

  // One pair of buffers for every call: the reader is synchronous and the event
  // loop is single-threaded, so nothing can interleave two calls.
  const input = new Uint8Array(SMC_KEY_DATA_BYTES);
  const inputView = new DataView(input.buffer);
  const output = new Uint8Array(SMC_KEY_DATA_BYTES);
  const outputView = new DataView(output.buffer);
  const outSize = new BigUint64Array(1);

  const call = (): boolean => {
    output.fill(0);
    outSize[0] = BigInt(SMC_KEY_DATA_BYTES);
    const r = io.IOConnectCallStructMethod(conn, SMC_SELECTOR, ptr(input), SMC_KEY_DATA_BYTES, ptr(output), ptr(outSize));
    return r === KERN_SUCCESS && output[OFF_RESULT] === 0;
  };
  const request = (cmd: number, key: number, dataSize = 0, data32 = 0) => {
    input.fill(0);
    inputView.setUint32(OFF_KEY, key, true);
    inputView.setUint32(OFF_DATA_SIZE, dataSize, true);
    input[OFF_DATA8] = cmd;
    inputView.setUint32(OFF_DATA32, data32, true);
  };

  const infoCache = new Map<string, SmcKeyInfo | null>();
  const prefixCache = new Map<string, string[]>();
  let keyCount: number | undefined;
  /** The key at an index as its numeric code, which orders the same way the
   *  controller sorts its table. */
  const keyAt = (index: number): number | undefined => {
    request(CMD_READ_INDEX, 0, 0, index);
    return call() ? outputView.getUint32(OFF_KEY, true) : undefined;
  };

  const reader: SmcReader = {
    info(key) {
      const cached = infoCache.get(key);
      if (cached !== undefined) return cached ?? undefined;
      request(CMD_READ_KEYINFO, fourCC(key));
      const info = call()
        ? { size: outputView.getUint32(OFF_DATA_SIZE, true), type: fourCCString(outputView.getUint32(OFF_DATA_TYPE, true)) }
        : null;
      const valid = info && info.size > 0 && info.size <= MAX_VALUE_BYTES ? info : null;
      infoCache.set(key, valid);
      return valid ?? undefined;
    },
    read(key, info) {
      request(CMD_READ_BYTES, fourCC(key), info.size);
      if (!call()) return undefined;
      return output.slice(OFF_BYTES, OFF_BYTES + info.size);
    },
    keysWithPrefix(prefix) {
      const cached = prefixCache.get(prefix);
      if (cached) return cached;
      keyCount ??= readSmcNumber(reader, "#KEY") ?? 0;
      const found = keysInRange(prefix, keyCount, keyAt);
      prefixCache.set(prefix, found);
      return found;
    },
  };
  return reader;
}

/** The controller on darwin, null everywhere else. Opened on first call. */
export function darwinSmc(): SmcReader | null {
  if (controller === undefined) {
    try {
      controller = openController();
    } catch {
      controller = null;
    }
  }
  return controller;
}

/**
 * Pure over `keyAt`: binary search for the first index at or after the smallest
 * key with this prefix, then read forward while keys still carry it. Stops at the
 * first index the controller refuses rather than skipping past it, because a
 * skipped key could not be told apart from the end of the range.
 */
export function keysInRange(prefix: string, count: number, keyAt: (index: number) => number | undefined): string[] {
  if (prefix.length < 1 || prefix.length > 3) throw new Error(`SMC key prefix must be 1-3 characters: "${prefix}"`);
  const lowest = fourCC(prefix.padEnd(4, "\0"));
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const code = keyAt(mid);
    if (code === undefined) return [];
    if (code < lowest) lo = mid + 1;
    else hi = mid;
  }
  const found: string[] = [];
  for (let i = lo; i < count; i++) {
    const code = keyAt(i);
    if (code === undefined) break;
    const key = fourCCString(code);
    if (!key.startsWith(prefix)) break;
    found.push(key);
  }
  return found;
}

// ---------------------------------------------------------------- fans

/** Fan speeds are `flt ` on Apple Silicon and `fpe2` on Intel. */
const FAN_TYPES = new Set(["flt ", "fpe2"]);
/** A fan's keys carry its index as one digit. */
const MAX_FANS = 10;

export interface SmcFanPlan {
  /** The controller's index, the `n` of `F<n>Ac`. */
  index: number;
  /** `F<n>Ac`: the speed now, RPM. */
  actual: SmcSensor;
  /** `F<n>Mn` / `F<n>Mx`: the range the controller keeps the fan in. */
  min?: SmcSensor;
  max?: SmcSensor;
}

/**
 * Every fan `FNum` counts. A Mac without one (a MacBook Air) counts none or has no
 * `FNum` at all, and so gets no Fans page — as a fanless Linux laptop does.
 */
export function planFans(reader: SmcReader): SmcFanPlan[] {
  const count = readSmcNumber(reader, "FNum");
  if (count === undefined || !Number.isInteger(count) || count <= 0) return [];
  const fans: SmcFanPlan[] = [];
  for (let n = 0; n < Math.min(count, MAX_FANS); n++) {
    const actual = fanSensor(reader, `F${n}Ac`);
    if (!actual) continue;
    const min = fanSensor(reader, `F${n}Mn`);
    const max = fanSensor(reader, `F${n}Mx`);
    fans.push({ index: n, actual, ...(min ? { min } : {}), ...(max ? { max } : {}) });
  }
  return fans;
}

function fanSensor(reader: SmcReader, key: string): SmcSensor | undefined {
  const info = reader.info(key);
  return info && FAN_TYPES.has(info.type) ? { key, info } : undefined;
}

function readSensorValue(reader: SmcReader, sensor: SmcSensor): number | undefined {
  const bytes = reader.read(sensor.key, sensor.info);
  const value = bytes ? decodeSmcValue(sensor.info.type, bytes) : undefined;
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** A negative speed is not a speed; a stopped fan (0) is. */
function readRpm(reader: SmcReader, sensor: SmcSensor): number | undefined {
  const rpm = readSensorValue(reader, sensor);
  return rpm !== undefined && rpm >= 0 ? Math.round(rpm) : undefined;
}

function readFanLimit(reader: SmcReader, sensor: SmcSensor): number | undefined {
  const rpm = readSensorValue(reader, sensor);
  return rpm !== undefined && rpm > 0 ? Math.round(rpm) : undefined;
}

// ---------------------------------------------------------------- one tick's reads

export interface SmcPlan {
  temperatures: SmcTemperaturePlan;
  fans: SmcFanPlan[];
}

export function planSmc(reader: SmcReader, appleSilicon: boolean): SmcPlan {
  return { temperatures: planTemperatures(reader, appleSilicon), fans: planFans(reader) };
}

export interface SmcTemperatures {
  cpuC?: number;
  gpuC?: number;
}

export interface SmcFanReading {
  index: number;
  rpm: number;
  minRpm?: number;
  maxRpm?: number;
}

export interface SmcReadings {
  temperatures: SmcTemperatures;
  fans: SmcFanReading[];
}

/**
 * What one tick may spend waiting on the controller, against a 5 ms target for
 * the whole of it. A read is 0.24 ms in a tight loop and up to 0.46 ms beside the
 * rest of a tick, and the event loop waits for every one of them.
 */
export const SMC_TICK_BUDGET_MS = 4;

/** Readings older than this — the page was closed — are all taken again rather
 *  than refreshed a slice at a time. */
export const SMC_FULL_READ_AFTER_MS = 10_000;

export interface SmcSampler {
  read(): SmcReadings;
}

/**
 * One tick of the controller, within `SMC_TICK_BUDGET_MS`.
 *
 * Each fan's speed is read every tick: it is the figure the page shows moving.
 * Everything else — every temperature sensor, every fan's limits — keeps its
 * latest reading and is refreshed round-robin with what is left of the budget.
 * Measured on an M1 Max, that is 8-20 keys a tick in 4.1-4.7 ms, so its 45 are
 * all re-read within three to six ticks. A temperature is then the mean of every
 * sensor's latest reading. A mean of only the keys read this tick would jump by
 * several degrees from tick to tick, because the sensors of one site read low,
 * middle and high (Tp00, Tp01 and Tp02 at 43, 52 and 62 °C).
 *
 * The budget is checked between reads, so one read the firmware is slow to answer
 * still overruns it (one of twelve ticks took 10.8 ms). The first call, and the
 * first after `SMC_FULL_READ_AFTER_MS`, reads everything: 47 reads, 10.5 ms.
 */
export function createSmcSampler(
  reader: SmcReader,
  plan: SmcPlan,
  clock: () => number = () => performance.now(),
): SmcSampler {
  const slow = [
    ...[...plan.temperatures.cpu, ...plan.temperatures.gpu].map((sensor) => ({ sensor, read: readCelsius })),
    ...plan.fans.flatMap((fan) => [fan.min, fan.max])
      .filter((sensor): sensor is SmcSensor => sensor !== undefined)
      .map((sensor) => ({ sensor, read: readFanLimit })),
  ];
  const latest = new Map<string, number>();
  let cursor = 0;
  let lastAt: number | undefined;

  const refresh = ({ sensor, read }: (typeof slow)[number]) => {
    const value = read(reader, sensor);
    if (value === undefined) latest.delete(sensor.key);
    else latest.set(sensor.key, value);
  };
  const mean = (sensors: readonly SmcSensor[]): number | undefined => {
    let sum = 0;
    let n = 0;
    for (const sensor of sensors) {
      const c = latest.get(sensor.key);
      if (c === undefined) continue;
      sum += c;
      n++;
    }
    return n > 0 ? Math.round((sum / n) * 10) / 10 : undefined;
  };

  return {
    read() {
      const start = clock();
      const speeds = plan.fans.map((fan) => readRpm(reader, fan.actual));
      if (lastAt === undefined || start - lastAt > SMC_FULL_READ_AFTER_MS) {
        slow.forEach(refresh);
        cursor = 0;
      } else {
        // At least one a tick, so a controller slow enough to spend the budget on
        // the fans alone still gets round to every sensor.
        for (let done = 0; done < slow.length && (done === 0 || clock() - start < SMC_TICK_BUDGET_MS); done++) {
          refresh(slow[cursor]!);
          cursor = (cursor + 1) % slow.length;
        }
      }
      lastAt = start;

      const cpuC = mean(plan.temperatures.cpu);
      const gpuC = mean(plan.temperatures.gpu);
      const fans: SmcFanReading[] = [];
      plan.fans.forEach((fan, i) => {
        const rpm = speeds[i];
        if (rpm === undefined) return;
        const minRpm = fan.min && latest.get(fan.min.key);
        const maxRpm = fan.max && latest.get(fan.max.key);
        // A floor above the ceiling is a misread, and neither half can be trusted.
        const range = minRpm !== undefined && maxRpm !== undefined && minRpm > maxRpm
          ? {}
          : { ...(minRpm !== undefined ? { minRpm } : {}), ...(maxRpm !== undefined ? { maxRpm } : {}) };
        fans.push({ index: fan.index, rpm, ...range });
      });
      return {
        temperatures: { ...(cpuC !== undefined ? { cpuC } : {}), ...(gpuC !== undefined ? { gpuC } : {}) },
        fans,
      };
    },
  };
}

const MEMO_MS = 1000;
let sampler: SmcSampler | undefined;
let memo: { at: number; value: SmcReadings } | undefined;

/**
 * This tick's temperatures and fans, each absent when this Mac has no sensor this
 * code recognises. The plan is built on the first call (~30 ms, once per process)
 * and every later call within a second of the last answers from memory.
 */
export function readSmcSensors(
  reader: SmcReader | null = darwinSmc(),
  now: () => number = Date.now,
  appleSilicon: () => boolean = () => isAppleSilicon(),
): SmcReadings {
  if (!reader) return { temperatures: {}, fans: [] };
  // Only the real controller's readings are kept: a reader handed in by a caller
  // is someone else's key table, and remembering it would leak into the next.
  if (reader !== controller) return createSmcSampler(reader, planSmc(reader, appleSilicon())).read();
  const at = now();
  if (memo && at - memo.at >= 0 && at - memo.at < MEMO_MS) return memo.value;
  sampler ??= createSmcSampler(reader, planSmc(reader, appleSilicon()));
  const value = sampler.read();
  memo = { at, value };
  return value;
}
