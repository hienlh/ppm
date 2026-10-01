/**
 * CPU and GPU power and clocks on Apple Silicon, from IOReport — the private
 * framework `powermetrics` is built on, which, unlike `powermetrics`, needs no
 * root. The approach is macmon's: subscribe to a few channels once, then take one
 * sample per tick and diff it against the previous one.
 *
 * Four kinds of channel are used, each found by name:
 *   - "Energy Model" / "CPU Energy" — "DIE_<n>_CPU Energy" per die on an Ultra —
 *     the CPU complex. On an M1 Max it is exactly EACC_CPU + PACC0_CPU + PACC1_CPU,
 *     the three clusters, to the millijoule.
 *   - "Energy Model" / "GPU Energy": the GPU, equal to GPU0 + GPU SRAM0.
 *   - "CPU Stats" / "CPU Core Performance States": per core ("ECPU000",
 *     "PCPU130"), the time spent idle and in each performance state.
 *   - "GPU Stats" / "GPU Performance States" / "GPUPH": the same for the GPU.
 * No state says what clock it runs at. That is the power manager's frequency
 * table (`readPmgrDvfs`): after the idle states, the n-th state is the n-th clock
 * of the table, which is also how many states there are (5 + IDLE for an M1 Max
 * efficiency core, 15 + IDLE for a performance core).
 *
 * Measured on an M1 Max:
 *   - Finding the channels is a walk of the whole registry, once per process on
 *     the first tick that asks: `IOReportCopyAllChannels` is 188 ms for 9341
 *     channels, where one `IOReportCopyChannelsInGroup` per group walks it again
 *     for each (110 ms apiece).
 *   - Subscribing to the 13 channels used instead of their whole groups (173
 *     channels) took a tick from ~8 ms to ~3.5 ms. The rest is the drivers being
 *     asked for their counters: even a single channel costs 1.5-3 ms to sample.
 */
import { dlopen, FFIType as T, ptr } from "bun:ffi";
import { darwinCoreFoundation, type CfRef, type CoreFoundation } from "./core-foundation-darwin.ts";
import type { DvfsTables } from "./cpu-details-darwin.ts";
import { isAppleSilicon } from "./darwin-ffi.ts";

const IOREPORT = "/usr/lib/libIOReport.dylib";

export const ENERGY_GROUP = "Energy Model";
export const CPU_STATS_GROUP = "CPU Stats";
export const CPU_CORE_STATES = "CPU Core Performance States";
export const GPU_STATS_GROUP = "GPU Stats";
export const GPU_STATES = "GPU Performance States";
const GPU_CHANNEL = "GPUPH";

const isCpuEnergy = (name: string) => name.endsWith("CPU Energy");
const isGpuEnergy = (name: string) => name === "GPU Energy";

/** Whether this reader subscribes to a channel. */
export function isWantedChannel(group: string, subgroup: string, name: string): boolean {
  switch (group) {
    case ENERGY_GROUP: return isCpuEnergy(name) || isGpuEnergy(name);
    case CPU_STATS_GROUP: return subgroup === CPU_CORE_STATES;
    case GPU_STATS_GROUP: return subgroup === GPU_STATES && name === GPU_CHANNEL;
    default: return false;
  }
}

export interface IoReportState {
  name: string;
  /** Time in the state over the interval, in the channel's own ticks (24 MHz on
   *  an M1). Only ratios of it are used. */
  residency: number;
}

/** One channel of the difference between two samples. */
export interface IoReportChannel {
  group: string;
  subgroup: string;
  name: string;
  unit: string;
  /** Energy channels: how far the counter moved over the interval, in `unit`. */
  value?: number;
  /** Performance-state channels, in the order the driver lists them. */
  states?: IoReportState[];
}

export interface IoReportDelta {
  channels: IoReportChannel[];
  /** Seconds between the two samples. */
  elapsedSec: number;
}

// ---------------------------------------------------------------- figures

export interface IoReportFigures {
  cpuPowerW?: number;
  gpuPowerW?: number;
  /** The clock the cores ran at while they ran, weighted by how long each ran —
   *  what `powermetrics` calls a cluster's "HW active frequency", over every core. */
  cpuMHz?: number;
  /** The same for the GPU, over the time it was on. */
  gpuMHz?: number;
}

/** Joules from an energy counter in its own unit; undefined for a unit this code
 *  does not know, rather than a guess at its scale. */
export function joules(value: number, unit: string): number | undefined {
  switch (unit.trim()) {
    case "mJ": return value / 1e3;
    case "uJ": return value / 1e6;
    case "nJ": return value / 1e9;
    default: return undefined;
  }
}

/** Idle states come first and run at no clock: "IDLE" and "DOWN" for a core (the
 *  latter on some chips), "OFF" for the GPU. */
const IDLE_STATES = new Set(["IDLE", "DOWN", "OFF"]);

/**
 * Cycles (residency × MHz) and active time of one channel against its clock
 * table. Undefined when the channel spent time in a state the table has no clock
 * for: the table then describes some other chip, and a figure from it would be a
 * made-up one.
 */
export function activeCycles(
  states: readonly IoReportState[],
  clocksMHz: readonly number[],
): { cycles: number; time: number } | undefined {
  const first = states.findIndex((s) => !IDLE_STATES.has(s.name));
  let cycles = 0;
  let time = 0;
  if (first < 0) return { cycles, time };
  for (let i = first; i < states.length; i++) {
    const residency = states[i]!.residency;
    if (!(residency > 0)) continue;
    const mhz = clocksMHz[i - first];
    if (mhz === undefined) return undefined;
    cycles += residency * mhz;
    time += residency;
  }
  return { cycles, time };
}

/** Watts from every matching energy channel. Undefined when none matched, when
 *  one is in a unit this code does not know, or when a counter went backwards. */
function watts(delta: IoReportDelta, match: (name: string) => boolean): number | undefined {
  let total = 0;
  let found = false;
  for (const c of delta.channels) {
    if (c.group !== ENERGY_GROUP || !match(c.name) || c.value === undefined) continue;
    const j = joules(c.value, c.unit);
    if (j === undefined || j < 0) return undefined;
    total += j;
    found = true;
  }
  // Milliwatts, as the Linux page's RAPL figure is rounded.
  return found && delta.elapsedSec > 0 ? Math.round((total / delta.elapsedSec) * 1000) / 1000 : undefined;
}

/**
 * The residency-weighted clock over every channel `table` maps. Every channel
 * must map: a core of a kind the tables do not describe would otherwise drop out
 * of the mean silently, and a mean over some of the cores is not the CPU's.
 */
function weightedClock(
  channels: readonly IoReportChannel[],
  table: (channel: IoReportChannel) => readonly number[] | undefined,
): number | undefined {
  let cycles = 0;
  let time = 0;
  for (const channel of channels) {
    const clocks = table(channel);
    if (!clocks?.length || !channel.states) return undefined;
    const active = activeCycles(channel.states, clocks);
    if (!active) return undefined;
    cycles += active.cycles;
    time += active.time;
  }
  return time > 0 ? Math.round(cycles / time) : undefined;
}

export function summarizeIoReport(delta: IoReportDelta, tables: DvfsTables | undefined): IoReportFigures {
  const out: IoReportFigures = {};
  const cpuPowerW = watts(delta, isCpuEnergy);
  const gpuPowerW = watts(delta, isGpuEnergy);
  if (cpuPowerW !== undefined) out.cpuPowerW = cpuPowerW;
  if (gpuPowerW !== undefined) out.gpuPowerW = gpuPowerW;
  if (!tables) return out;

  const cores = delta.channels.filter((c) => c.group === CPU_STATS_GROUP && c.subgroup === CPU_CORE_STATES);
  const cpuMHz = weightedClock(cores, (c) =>
    c.name.startsWith("ECPU") ? tables.ecpuMHz : c.name.startsWith("PCPU") ? tables.pcpuMHz : undefined);
  if (cpuMHz !== undefined) out.cpuMHz = cpuMHz;

  // The GPU table opens with a 0 MHz entry: the off state, which the residencies
  // list separately as "OFF". The CPU tables have no such entry.
  const gpuClocks = tables.gpuMHz.filter((mhz) => mhz > 0);
  const gpu = delta.channels.filter((c) => c.group === GPU_STATS_GROUP && c.subgroup === GPU_STATES && c.name === GPU_CHANNEL);
  const gpuMHz = weightedClock(gpu, () => gpuClocks);
  if (gpuMHz !== undefined) out.gpuMHz = gpuMHz;
  return out;
}

// ---------------------------------------------------------------- sampling

/** A sample older than this is not diffed against: an average over a gap in the
 *  ticks — nobody had the page open — is not the current figure. */
export const MAX_SAMPLE_GAP_SEC = 10;

/** The FFI half, injected so the baseline logic is tested without IOReport. */
export interface IoReportSubscription {
  /** A new sample the caller owns and must `free`; `0n` when the call failed. */
  sample(): CfRef;
  /** The channels between two samples; undefined when IOReport would not diff them. */
  diff(older: CfRef, newer: CfRef): IoReportChannel[] | undefined;
  free(sample: CfRef): void;
}

export interface IoReportSampler {
  /** The change since the previous call. Undefined on the first call, after a gap,
   *  and when a sample failed — a failed sample keeps the previous baseline. */
  delta(): IoReportDelta | undefined;
}

export function createIoReportSampler(
  subscription: IoReportSubscription,
  now: () => number = () => performance.now(),
): IoReportSampler {
  let previous: { ref: CfRef; atMs: number } | undefined;
  return {
    delta() {
      const ref = subscription.sample();
      const atMs = now();
      if (ref === 0n) return undefined;
      const older = previous;
      previous = { ref, atMs };
      if (!older) return undefined;
      try {
        const elapsedSec = (atMs - older.atMs) / 1000;
        if (!(elapsedSec > 0) || elapsedSec > MAX_SAMPLE_GAP_SEC) return undefined;
        const channels = subscription.diff(older.ref, ref);
        return channels ? { channels, elapsedSec } : undefined;
      } finally {
        subscription.free(older.ref);
      }
    },
  };
}

type IoReportLib = {
  IOReportCopyAllChannels: (a: bigint, b: bigint) => bigint;
  IOReportCreateSubscription: (alloc: CfRef, desired: CfRef, subscribed: number, id: bigint, b: CfRef) => bigint;
  IOReportCreateSamples: (sub: CfRef, channels: CfRef, b: CfRef) => bigint;
  IOReportCreateSamplesDelta: (a: CfRef, b: CfRef, c: CfRef) => bigint;
  IOReportChannelGetGroup: (item: CfRef) => bigint;
  IOReportChannelGetSubGroup: (item: CfRef) => bigint;
  IOReportChannelGetChannelName: (item: CfRef) => bigint;
  IOReportChannelGetUnitLabel: (item: CfRef) => bigint;
  IOReportSimpleGetIntegerValue: (item: CfRef, index: number) => bigint;
  IOReportStateGetCount: (item: CfRef) => number;
  IOReportStateGetNameForIndex: (item: CfRef, index: number) => bigint;
  IOReportStateGetResidency: (item: CfRef, index: number) => bigint;
};

function loadIoReport(): IoReportLib | null {
  const R = T.u64;
  try {
    return dlopen(IOREPORT, {
      IOReportCopyAllChannels: { args: [T.u64, T.u64], returns: R },
      IOReportCreateSubscription: { args: [R, R, T.ptr, T.u64, R], returns: R },
      IOReportCreateSamples: { args: [R, R, R], returns: R },
      IOReportCreateSamplesDelta: { args: [R, R, R], returns: R },
      IOReportChannelGetGroup: { args: [R], returns: R },
      IOReportChannelGetSubGroup: { args: [R], returns: R },
      IOReportChannelGetChannelName: { args: [R], returns: R },
      IOReportChannelGetUnitLabel: { args: [R], returns: R },
      IOReportSimpleGetIntegerValue: { args: [R, T.i32], returns: T.i64 },
      IOReportStateGetCount: { args: [R], returns: T.i32 },
      IOReportStateGetNameForIndex: { args: [R, T.i32], returns: R },
      IOReportStateGetResidency: { args: [R, T.i32], returns: T.i64 },
    }).symbols as unknown as IoReportLib;
  } catch {
    return null;
  }
}

/**
 * The real subscription: every channel `isWantedChannel` names, and nothing else.
 * The channel list is filtered by copying IOReport's own array and removing the
 * rest, which keeps the array's CF callbacks without looking them up.
 *
 * The subscription and its channel dictionaries are kept for the life of the
 * process; each tick then costs one sample and one diff, both released.
 */
function openIoReportSubscription(cf: CoreFoundation, io: IoReportLib | null = loadIoReport()): IoReportSubscription | null {
  if (!io) return null;
  const channelsKey = cf.string("IOReportChannels");
  const all = io.IOReportCopyAllChannels(0n, 0n);
  if (all === 0n) return null;
  let desired: CfRef = 0n;
  try {
    const list = cf.dictGet(all, channelsKey);
    if (list === 0n) return null;
    const count = cf.arrayCount(list);
    const keep: boolean[] = [];
    for (let i = 0; i < count; i++) {
      const channel = cf.arrayAt(list, i);
      // The group first: all but a few of 9341 channels stop there, which keeps
      // this walk at a third of the string reads.
      const group = cf.text(io.IOReportChannelGetGroup(channel)) ?? "";
      keep.push(
        (group === ENERGY_GROUP || group === CPU_STATS_GROUP || group === GPU_STATS_GROUP)
        && isWantedChannel(
          group,
          cf.text(io.IOReportChannelGetSubGroup(channel)) ?? "",
          cf.text(io.IOReportChannelGetChannelName(channel)) ?? "",
        ),
      );
    }
    if (!keep.includes(true)) return null;
    const filtered = cf.arrayMutableCopy(list);
    for (let i = count - 1; i >= 0; i--) if (!keep[i]) cf.arrayRemoveAt(filtered, i);
    desired = cf.dictMutableCopy(all);
    cf.dictSet(desired, channelsKey, filtered);
    cf.release(filtered);
  } finally {
    cf.release(all);
  }

  const subscribedOut = new BigUint64Array(1);
  const subscription = io.IOReportCreateSubscription(0n, desired, ptr(subscribedOut), 0n, 0n);
  if (subscription === 0n) {
    cf.release(desired);
    return null;
  }
  // Sampled by what IOReport says it subscribed; the request is the same list.
  const channels = subscribedOut[0] || desired;

  /** A channel's unit and state names never change, so each is read once. */
  const labels = new Map<string, { unit: string; states: string[] }>();
  const labelsOf = (item: CfRef, id: string, stateCount: number) => {
    let known = labels.get(id);
    if (!known || known.states.length !== stateCount) {
      const states: string[] = [];
      for (let s = 0; s < stateCount; s++) states.push(cf.text(io.IOReportStateGetNameForIndex(item, s)) ?? "");
      known = { unit: (cf.text(io.IOReportChannelGetUnitLabel(item)) ?? "").trim(), states };
      labels.set(id, known);
    }
    return known;
  };

  return {
    sample: () => io.IOReportCreateSamples(subscription, channels, 0n),
    free: (sample) => cf.release(sample),
    diff(older, newer) {
      const delta = io.IOReportCreateSamplesDelta(older, newer, 0n);
      if (delta === 0n) return undefined;
      try {
        const items = cf.dictGet(delta, channelsKey);
        if (items === 0n) return undefined;
        const out: IoReportChannel[] = [];
        for (let i = 0, n = cf.arrayCount(items); i < n; i++) {
          const item = cf.arrayAt(items, i);
          const group = cf.text(io.IOReportChannelGetGroup(item)) ?? "";
          const subgroup = cf.text(io.IOReportChannelGetSubGroup(item)) ?? "";
          const name = cf.text(io.IOReportChannelGetChannelName(item)) ?? "";
          const energy = group === ENERGY_GROUP;
          const stateCount = energy ? 0 : io.IOReportStateGetCount(item);
          const { unit, states } = labelsOf(item, `${group}\0${subgroup}\0${name}`, stateCount);
          out.push(energy
            ? { group, subgroup, name, unit, value: Number(io.IOReportSimpleGetIntegerValue(item, 0)) }
            : {
              group, subgroup, name, unit,
              states: states.map((stateName, s) => ({ name: stateName, residency: Number(io.IOReportStateGetResidency(item, s)) })),
            });
        }
        return out;
      } finally {
        cf.release(delta);
      }
    },
  };
}

/** `undefined` until first asked for; `null` where there is nothing to read — an
 *  Intel Mac, whose power manager publishes none of these channels. */
let shared: IoReportSampler | null | undefined;

export function darwinIoReport(): IoReportSampler | null {
  if (shared === undefined) {
    try {
      const cf = darwinCoreFoundation();
      const subscription = cf && isAppleSilicon() ? openIoReportSubscription(cf) : null;
      shared = subscription ? createIoReportSampler(subscription) : null;
    } catch {
      shared = null;
    }
  }
  return shared;
}
