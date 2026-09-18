/**
 * Per-interface figures for the Performance page's network entries, from
 * `/sys/class/net/<if>/`. Throughput is the same counter Mission Center reads
 * (`statistics/rx_bytes`, `tx_bytes`); the link state comes from the kernel's
 * own `operstate`/`carrier` rather than from NetworkManager, so it is right on a
 * host that does not run NetworkManager at all.
 */
import type { NicMetrics, NicState } from "../../types/system-metrics.ts";
import { readAttr, readNumber, realLinuxFs, type LinuxFs } from "./linux-fs.ts";

export const SYS_NET = "/sys/class/net";
/** ARPHRD_LOOPBACK. Mission Center drops interfaces named `lo*`; the type is exact. */
const ARPHRD_LOOPBACK = 772;
const IFF_UP = 0x1;

export interface NicSample {
  atSec: number;
  rx: number;
  tx: number;
}

/** Previous sample per interface name. */
export type NicSampleState = Map<string, NicSample>;

/** Live wireless facts for one interface; the collector takes them as data so it
 *  never spawns anything itself. */
export interface WirelessStatus {
  ssid?: string;
  signalPercent?: number;
  frequencyMHz?: number;
}

export function listNetInterfaces(fs: Pick<LinuxFs, "list" | "read"> = realLinuxFs): string[] {
  const names = fs.list(SYS_NET);
  if (!names) return [];
  return names.filter((n) => readNumber(fs, `${SYS_NET}/${n}/type`) !== ARPHRD_LOOPBACK).sort();
}

/** `operstate` is RFC 2863's, verbatim. `unknown` is what tun, wireguard and
 *  other virtual interfaces report for their whole life, so those are decided by
 *  carrier plus the admin flag instead. */
export function nicState(
  operstate: string | undefined,
  carrier: string | undefined,
  flags: string | undefined,
): NicState {
  switch (operstate) {
    case "up": return "connected";
    case "dormant":
    case "testing": return "connecting";
    case "down": return "disconnected";
    case "notpresent":
    case "lowerlayerdown": return "unavailable";
    case "unknown": {
      const up = (Number.parseInt(flags ?? "0", 16) & IFF_UP) !== 0;
      return carrier === "1" && up ? "connected" : "unknown";
    }
    default: return "unknown";
  }
}

export interface NicDeviceCollection {
  nics: NicMetrics[];
  next: NicSampleState;
}

export function collectLinuxNicDevices(
  prev: NicSampleState,
  fs: Pick<LinuxFs, "list" | "read"> = realLinuxFs,
  now: () => number = Date.now,
  wireless: ReadonlyMap<string, WirelessStatus> = new Map(),
): NicDeviceCollection {
  const atSec = now() / 1000;
  const next: NicSampleState = new Map();
  const nics: NicMetrics[] = [];

  for (const id of listNetInterfaces(fs)) {
    const rx = readNumber(fs, `${SYS_NET}/${id}/statistics/rx_bytes`);
    const tx = readNumber(fs, `${SYS_NET}/${id}/statistics/tx_bytes`);
    if (rx === undefined || tx === undefined) continue;
    const sample: NicSample = { atSec, rx, tx };
    next.set(id, sample);

    // `speed` is -1 with no link, and reading it EINVALs on a virtual interface.
    const speed = readNumber(fs, `${SYS_NET}/${id}/speed`);
    nics.push({
      ...toNicMetrics(id, prev.get(id) ?? null, sample),
      state: nicState(
        readAttr(fs, `${SYS_NET}/${id}/operstate`),
        readAttr(fs, `${SYS_NET}/${id}/carrier`),
        readAttr(fs, `${SYS_NET}/${id}/flags`),
      ),
      ...(speed !== undefined && speed > 0 ? { linkMbps: speed } : {}),
      ...(wireless.get(id) ?? {}),
    });
  }
  return { nics, next };
}

/** Rates only — the caller adds state and link facts. */
export function toNicMetrics(id: string, prev: NicSample | null, next: NicSample): NicMetrics {
  const base: NicMetrics = {
    id, available: false, rxBps: 0, txBps: 0, rxTotal: next.rx, txTotal: next.tx, state: "unknown",
  };
  const dt = prev ? next.atSec - prev.atSec : 0;
  // The kernel zeroes these when an interface is recreated under the same name.
  if (!prev || !Number.isFinite(dt) || dt <= 0 || next.rx < prev.rx || next.tx < prev.tx) return base;
  return {
    ...base,
    available: true,
    rxBps: Math.round((next.rx - prev.rx) / dt),
    txBps: Math.round((next.tx - prev.tx) / dt),
  };
}
