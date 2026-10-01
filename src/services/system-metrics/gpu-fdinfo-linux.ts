/**
 * Per-process GPU accounting from DRM fdinfo — the same source nvtop and Mission
 * Center use, and the only one that works for Intel and AMD without root.
 *
 * `/proc/<pid>/fdinfo/<fd>` of a DRM file carries cumulative engine busy time in
 * nanoseconds. Two things make it trickier than a counter read:
 *
 *  - walking every fd of every process costs ~140 ms on a desktop with 3000
 *    threads, which a 2 s tick cannot pay. Only a handful of processes ever hold
 *    a DRM fd (15 of 558 here), so the full scan runs on a slow cadence and every
 *    other tick re-reads just those — measured at ~2 ms, a 70x saving.
 *  - a client's fds are SHARED across its threads and often dup'd, so the same
 *    counters appear many times; `drm-client-id` identifies the real client and
 *    is what deduplicates them. Summing without that multiplies a browser's GPU
 *    use by its thread count.
 *  - the counter is per engine, so "GPU %" is engine busy over WALL time, not
 *    over some total — an engine can only ever be busy for the time that passed.
 */
import { realLinuxFs, type LinuxFs } from "./linux-fs.ts";

const PROC = "/proc";
const DRI_PREFIX = "/dev/dri/";

export interface DrmClient {
  /** PCI address the client is rendering on, e.g. "0000:00:02.0". */
  pdev: string;
  /** Unique per open client on that device; the deduplication key with `pdev`. */
  clientId: string;
  driver: string;
  pid: number;
  /** Engine name ("render", "copy", "video", "video-enhance", "compute") → ns. */
  engines: Map<string, number>;
  /** Dedicated (VRAM) bytes this client holds; 0 on an integrated GPU. */
  vramBytes: number;
  /** System/GTT bytes this client holds. */
  sharedBytes: number;
}

/** One fdinfo file. Null when it is not a DRM fd (the overwhelming majority). */
export function parseDrmFdinfo(text: string, pid: number): DrmClient | null {
  let pdev = "";
  let clientId = "";
  let driver = "";
  let vramBytes = 0;
  let sharedBytes = 0;
  const engines = new Map<string, number>();

  for (const line of text.split("\n")) {
    if (!line.startsWith("drm-")) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep);
    const value = line.slice(sep + 1).trim();

    if (key === "drm-pdev") pdev = value;
    else if (key === "drm-client-id") clientId = value;
    else if (key === "drm-driver") driver = value;
    else if (key.startsWith("drm-engine-")) {
      const ns = Number(value.split(/\s+/)[0]);
      if (Number.isFinite(ns)) engines.set(key.slice("drm-engine-".length), ns);
    } else if (key.startsWith("drm-total-")) {
      // `drm-total-vram0`/`-vram` is dedicated; `-system0`/`-gtt` is shared.
      const region = key.slice("drm-total-".length);
      const bytes = parseMemoryValue(value);
      if (region.startsWith("vram")) vramBytes += bytes;
      else if (region.startsWith("system") || region.startsWith("gtt")) sharedBytes += bytes;
    }
  }

  if (!pdev || !clientId) return null;
  return { pdev, clientId, driver, pid, engines, vramBytes, sharedBytes };
}

/** fdinfo writes memory as "74920 KiB" (i915) or a bare byte count (amdgpu). */
export function parseMemoryValue(value: string): number {
  const [raw, unit] = value.split(/\s+/);
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  switch (unit) {
    case "KiB": return n * 1024;
    case "MiB": return n * 1024 ** 2;
    case "GiB": return n * 1024 ** 3;
    default: return n;
  }
}

/**
 * Every distinct DRM client on the machine, deduplicated by (pdev, client-id).
 *
 * Only fds whose `/proc/<pid>/fd/<n>` link points into `/dev/dri` are read: one
 * `readlink` beats an `open`+`read`+`close` on every fd of every process, and on
 * a desktop with ~3000 threads that is the difference between a few ms and a
 * tick that misses its deadline.
 */
export function collectDrmClients(
  fs: Pick<LinuxFs, "list" | "read" | "readlink"> = realLinuxFs,
  onlyPids?: readonly number[],
): DrmClient[] {
  const byKey = new Map<string, DrmClient>();
  const candidates = onlyPids ?? (fs.list(PROC) ?? []).map(Number);
  for (const entry of candidates) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    for (const fd of fs.list(`${PROC}/${pid}/fd`) ?? []) {
      if (!fs.readlink(`${PROC}/${pid}/fd/${fd}`)?.startsWith(DRI_PREFIX)) continue;
      const text = fs.read(`${PROC}/${pid}/fdinfo/${fd}`);
      if (!text) continue;
      const client = parseDrmFdinfo(text, pid);
      if (!client) continue;
      const key = `${client.pdev}/${client.clientId}`;
      // The lowest pid holding a client is its owner; a dup in a child would
      // otherwise attribute the parent's rendering to whichever fd came last.
      const existing = byKey.get(key);
      if (!existing || client.pid < existing.pid) byKey.set(key, client);
    }
  }
  return [...byKey.values()];
}

/** Cumulative engine ns per client, plus the clock they were read at. */
export interface DrmEngineState {
  atSec: number;
  /** "<pdev>/<clientId>" → engine → ns. */
  byClient: Map<string, Map<string, number>>;
}

export interface DrmUsage {
  /** pdev → engine → busy percent over the interval (0-100 per engine). */
  perDevice: Map<string, Map<string, number>>;
  /** pid → summed engine percent (clamped 0-100) and memory in MB. */
  perProcess: Map<number, { gpuPct: number; vramMB: number; sharedMB: number }>;
  /**
   * pdev → system/GTT memory its clients hold, MB. This is the ONLY whole-device
   * memory figure an integrated GPU has: i915 publishes no `mem_info_*` sysfs
   * attribute, so without it the page can say nothing at all.
   *
   * A buffer shared between two clients is counted twice, because fdinfo's
   * `drm-total-*` is per client and the `drm-shared-*` line does not say WHO it
   * is shared with. Mission Center sums the same way — measured against it live,
   * 2.54 GiB here against its 2.52 GiB.
   */
  sharedByDevice: Map<string, number>;
}

export function toEngineState(clients: readonly DrmClient[], atSec: number): DrmEngineState {
  const byClient = new Map<string, Map<string, number>>();
  for (const c of clients) byClient.set(`${c.pdev}/${c.clientId}`, c.engines);
  return { atSec, byClient };
}

/**
 * Engine busy over the wall interval. A client that did not exist on the previous
 * sample contributes nothing this tick — measuring its whole lifetime against one
 * interval is how a freshly launched window reads as 4000 % GPU.
 */
export function computeDrmUsage(
  prev: DrmEngineState | null,
  clients: readonly DrmClient[],
  atSec: number,
): DrmUsage {
  const perDevice = new Map<string, Map<string, number>>();
  const perProcess = new Map<number, { gpuPct: number; vramMB: number; sharedMB: number }>();
  const sharedByDevice = new Map<string, number>();
  const dtNs = prev ? (atSec - prev.atSec) * 1e9 : 0;

  for (const c of clients) {
    const MB = 1024 ** 2;
    const row = perProcess.get(c.pid) ?? { gpuPct: 0, vramMB: 0, sharedMB: 0 };
    row.vramMB += c.vramBytes / MB;
    row.sharedMB += c.sharedBytes / MB;
    // Every device a client was seen on gets an entry, even at 0 bytes: "this
    // GPU's clients hold nothing" is a reading, and no entry at all is not.
    sharedByDevice.set(c.pdev, (sharedByDevice.get(c.pdev) ?? 0) + c.sharedBytes / MB);

    if (dtNs > 0) {
      const before = prev!.byClient.get(`${c.pdev}/${c.clientId}`);
      if (before) {
        const engines = perDevice.get(c.pdev) ?? new Map<string, number>();
        for (const [engine, ns] of c.engines) {
          const delta = ns - (before.get(engine) ?? 0);
          if (delta <= 0) continue;
          const pct = Math.min(100, delta / dtNs * 100);
          engines.set(engine, (engines.get(engine) ?? 0) + pct);
          row.gpuPct += pct;
        }
        perDevice.set(c.pdev, engines);
      }
    }
    row.gpuPct = Math.min(100, row.gpuPct);
    perProcess.set(c.pid, row);
  }

  // A device's engine can only be busy for the interval that passed.
  for (const engines of perDevice.values()) {
    for (const [engine, pct] of engines) engines.set(engine, Math.min(100, round1(pct)));
  }
  for (const row of perProcess.values()) {
    row.gpuPct = round1(row.gpuPct);
    row.vramMB = round1(row.vramMB);
    row.sharedMB = round1(row.sharedMB);
  }
  for (const [pdev, mb] of sharedByDevice) sharedByDevice.set(pdev, round1(mb));
  return { perDevice, perProcess, sharedByDevice };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ------------------------------------------------------- stateful collector

/** How long one walk's result is reused. Both the whole-GPU figures and the
 *  process rows are built from the same tick, so whichever asks first pays for
 *  the walk and the other reads the same numbers — they can never disagree. */
export const DRM_MEMO_MS = 1000;
/** Full `/proc` rescans are this far apart; in between, only the pids already
 *  known to hold a DRM fd are re-read. A window opened now shows GPU use within
 *  one rescan rather than immediately, which is the cost of not paying 140 ms
 *  every 2 s forever. */
export const DRM_RESCAN_MS = 10_000;

export interface DrmGpuCollector {
  /** This tick's usage, walking `/proc` at most once per `DRM_MEMO_MS`. */
  usage(): DrmUsage;
}

export function createDrmGpuCollector(
  fs: Pick<LinuxFs, "list" | "read" | "readlink"> = realLinuxFs,
  now: () => number = Date.now,
): DrmGpuCollector {
  let state: DrmEngineState | null = null;
  let knownPids: number[] = [];
  let lastFullScanAt = 0;
  let memo: { at: number; usage: DrmUsage } | null = null;

  return {
    usage(): DrmUsage {
      const at = now();
      if (memo && at - memo.at < DRM_MEMO_MS) return memo.usage;

      const full = knownPids.length === 0 || at - lastFullScanAt >= DRM_RESCAN_MS;
      const clients = collectDrmClients(fs, full ? undefined : knownPids);
      if (full) {
        lastFullScanAt = at;
        knownPids = [...new Set(clients.map((c) => c.pid))];
      }

      const atSec = at / 1000;
      const usage = computeDrmUsage(state, clients, atSec);
      state = toEngineState(clients, atSec);
      memo = { at, usage };
      return usage;
    },
  };
}
