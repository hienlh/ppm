/**
 * The macOS tools more than one collector needs in the same tick, each run at most
 * once per `TOOL_MEMO_MS` and shared by whoever asks.
 *
 * On Linux the whole-machine Disk card and the per-drive pages read the same sysfs
 * counters for free. On a Mac both come out of one `ioreg` call, and the Network
 * card and the per-interface pages out of one `netstat`, so without sharing a tick
 * would spawn each tool twice — and measure the two figures a few milliseconds
 * apart, enough for a drive page and the card to disagree about one transfer. The
 * trick is the one `createDrmGpuCollector` uses on Linux (`DRM_MEMO_MS`).
 *
 * A read that fails answers `undefined`, and that answer is shared too: the second
 * caller in a tick does not respawn a tool that just failed. Concurrent callers get
 * the same in-flight promise.
 */
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import { parsePlistXml, type PlistValue } from "./plist-xml.ts";

/** Under the 2 s tick, so every tick reads fresh counters. */
export const TOOL_MEMO_MS = 1000;
/** The service list changes when someone edits System Settings → Network. */
export const SERVICE_ORDER_TTL_MS = 60_000;

const TOOL_TIMEOUT_MS = 3000;

export interface ToolRead<T> {
  value: T;
  /** When the tool was started, seconds. None of these tools print a clock of
   *  their own, so this is what a rate is measured against. */
  atSec: number;
}

export interface DarwinToolReads {
  /** Every block storage device with its driver and whole-disk media:
   *  `ioreg -a -r -l -d 3 -c IOBlockStorageDevice` (~20 ms). */
  blockDevices(): Promise<ToolRead<PlistValue> | undefined>;
  /** Each GPU with its utilisation and every client process's GPU time:
   *  `ioreg -a -r -l -d 2 -c IOAccelerator` (~35 ms). */
  accelerators(): Promise<ToolRead<PlistValue> | undefined>;
  /** `netstat -ib` (~40 ms): per-interface byte counters. */
  netstat(): Promise<ToolRead<string> | undefined>;
  /** `ifconfig -a -v` (~10 ms): link state, rate, type and the VPN flags. */
  ifconfig(): Promise<ToolRead<string> | undefined>;
  /** `networksetup -listnetworkserviceorder` (~30 ms): the services System
   *  Settings shows, which decide what counts as a real interface. A failed
   *  refresh keeps answering the last good list — this decides which interfaces
   *  exist at all, and one timeout must not take Wi-Fi off the page for a minute. */
  serviceOrder(): Promise<ToolRead<string> | undefined>;
  /** `diskutil list -plist` (~30 ms): partitions, APFS containers and volumes.
   *  Only the inventory asks for it. */
  diskutilList(): Promise<ToolRead<PlistValue> | undefined>;
  /** `mount` (~5 ms): what is mounted where, with its filesystem — the Mac's
   *  `/proc/self/mountinfo`. Only the inventory asks for it. */
  mounts(): Promise<ToolRead<string> | undefined>;
}

export function createDarwinToolReads(run: Runner = defaultRunner, now: () => number = Date.now): DarwinToolReads {
  const text = (argv: string[], timeoutMs = TOOL_TIMEOUT_MS) => async () => {
    const r = await run(argv, timeoutMs);
    return r.code === 0 && r.stdout.length > 0 ? r.stdout : undefined;
  };
  const plist = (argv: string[], timeoutMs?: number) => {
    const read = text(argv, timeoutMs);
    return async () => {
      const xml = await read();
      return xml === undefined ? undefined : parsePlistXml(xml);
    };
  };
  return {
    blockDevices: memoised(TOOL_MEMO_MS, now, plist(["ioreg", "-a", "-r", "-l", "-d", "3", "-c", "IOBlockStorageDevice"])),
    accelerators: memoised(TOOL_MEMO_MS, now, plist(["ioreg", "-a", "-r", "-l", "-d", "2", "-c", "IOAccelerator"])),
    netstat: memoised(TOOL_MEMO_MS, now, text(["netstat", "-ib"])),
    ifconfig: memoised(TOOL_MEMO_MS, now, text(["ifconfig", "-a", "-v"])),
    serviceOrder: memoised(
      SERVICE_ORDER_TTL_MS, now, text(["networksetup", "-listnetworkserviceorder"], 5000), { keepLastGood: true },
    ),
    diskutilList: memoised(TOOL_MEMO_MS, now, plist(["diskutil", "list", "-plist"], 10_000)),
    mounts: memoised(TOOL_MEMO_MS, now, text(["mount"])),
  };
}

function memoised<T>(
  ttlMs: number,
  now: () => number,
  fetch: () => Promise<T | undefined>,
  { keepLastGood = false } = {},
): () => Promise<ToolRead<T> | undefined> {
  let last: { at: number; read: Promise<ToolRead<T> | undefined> } | null = null;
  let good: ToolRead<T> | undefined;
  return () => {
    const at = now();
    if (last && at - last.at < ttlMs) return last.read;
    const read = fetch()
      .then((value) => (value === undefined ? undefined : { value, atSec: at / 1000 }))
      .catch(() => undefined)
      .then((result) => {
        if (result) good = result;
        return result ?? (keepLastGood ? good : undefined);
      });
    last = { at, read };
    return read;
  };
}

let shared: DarwinToolReads | null = null;

/** The one instance the tick, the aggregate counters and the inventory share. */
export function darwinToolReads(): DarwinToolReads {
  return (shared ??= createDarwinToolReads());
}
