/** Whole-machine metrics contract shared by the collectors, the REST/SSE routes
 *  and the web client. Types + constants only, no imports, so both bundles can
 *  take it. Import RELATIVELY — the "@" alias points at src/web, not src. */

export type MetricsPlatform = "win32" | "darwin" | "linux";

/** `light` = node:os only, no child processes, status-bar cadence.
 *  `full`  = every collector, process rows, groups. */
export type MetricsTier = "light" | "full";

/** Aggregate + per-core busy percentage over the last tick (0-100, 1 decimal). */
export interface CpuMetrics {
  total: number;
  /** Index matches `os.cpus()` order. Core count is `cores.length`. */
  cores: number[];
  model: string;
}

export interface MemoryMetrics {
  totalMB: number;
  usedMB: number;
  availableMB: number;
  /** usedMB / totalMB × 100. */
  percent: number;
}

/** Whole-machine throughput, bytes/second over the last tick. */
export interface RateMetrics {
  /** Disk: read. Net: received/down. */
  inBps: number;
  /** Disk: write. Net: sent/up. */
  outBps: number;
  /** False in the light tier, on a missing OS source, and on the first tick
   *  (no baseline). The UI must render "n/a", never 0 B/s. */
  available: boolean;
}

export interface GpuMetrics {
  name: string;
  /** 0-100. */
  utilPercent: number;
  vramUsedMB: number;
  vramTotalMB: number;
}

export interface SystemMetrics {
  cpu: CpuMetrics;
  mem: MemoryMetrics;
  /** light tier: available:false. */
  disk: RateMetrics;
  /** light tier: available:false. */
  net: RateMetrics;
  /** light tier: []. Empty also when no NVIDIA GPU — the UI hides the card. */
  gpus: GpuMetrics[];
  /** light tier: 0. Processes the collector could see this tick. */
  processCount: number;
}

export interface ProcessInfo {
  pid: number;
  /** -1 when the parent is unknown. */
  ppid: number;
  /** Executable basename WITHOUT extension, lowercased for comparison by the
   *  guard: "explorer", "node", "chrome". Never "explorer.exe". */
  name: string;
  /** Command line, secrets redacted then truncated to 160 chars. Falls back to
   *  `name` when unreadable (Windows: ~53% of rows are unreadable unelevated). */
  command: string;
  /** Instantaneous machine-normalised CPU%: deltaCpuMs / (wallMs × coreCount) × 100.
   *  Always 0 on a process's first observed tick. */
  cpu: number;
  ramMB: number;
  /** Epoch ms UTC; 0 when unknown. Identity guard for CPU deltas, grouping and kill. */
  startedAt: number;
  /** PPM server, supervisor, edge forwarder, their descendants, PPM-managed
   *  cloudflared. Drives the "PPM only" filter — NOT a safety mechanism. */
  ppm: boolean;
  /** The server will refuse to kill it. Produced by the same guard the route
   *  enforces, so the disabled button and the 403 cannot disagree. */
  protected: boolean;
  /** Per-process throughput/GPU. `undefined` means this OS or tier cannot
   *  measure it — the UI must render "—", never 0. All are omitted from the
   *  JSON frame when undefined, so an unsupported host pays nothing.
   *
   *  Bytes/second, delta of a cumulative OS counter over the tick's wall
   *  interval; 0 on a process's first observed tick, like `cpu`. */
  diskReadBps?: number;
  diskWriteBps?: number;
  /** Sum of this pid's GPU engine busy percentages (3D + Copy + Video + …),
   *  clamped 0-100. Rate over the counter's OWN clock, not the wall tick. */
  gpuPct?: number;
  /** Dedicated (on-card) VRAM in MB attributed to this pid. */
  gpuMemMB?: number;
  /** macOS only: per-process network has no supported source on Windows (ETW
   *  only) or Linux (packet capture). */
  netInBps?: number;
  netOutBps?: number;
}

export interface ProcessGroup {
  /** Stable across ticks: "root:<pid>" for an ancestor roll-up, "exe:<name>" for
   *  the orphan bucket. React key and history-series key. */
  key: string;
  label: string;
  /** Roll-up root pid; null for an "exe:" bucket. */
  rootPid: number | null;
  cpu: number;
  ramMB: number;
  count: number;
  /** True when any member is PPM-owned. */
  ppm: boolean;
  /** Member pids, CPU-desc. Full rows are in `MetricsSnapshot.processes`. */
  pids: number[];
  /** Roll-ups of the optional per-process columns, with the same optionality:
   *  the sum over the members that HAVE a value, and `undefined` when no member
   *  has one — so "nothing measurable" never renders as a hard 0. */
  diskReadBps?: number;
  diskWriteBps?: number;
  /** Summed engine busy across members, clamped 0-100. */
  gpuPct?: number;
  gpuMemMB?: number;
  netInBps?: number;
  netOutBps?: number;
}

/** Per-host availability of the optional process columns. A column is offered
 *  once the collector has actually produced a value for it on this host. */
export interface ProcessColumnAvailability {
  disk: boolean;
  gpu: boolean;
  net: boolean;
}

/** CLIENT-SIDE history element: aggregates only. There is no server ring. */
export interface MetricsHistoryPoint {
  ts: number;
  system: SystemMetrics;
  /** group.key → roll-up, so group sparklines survive across ticks. */
  groups: Record<string, { cpu: number; ramMB: number }>;
}

export interface MetricsSnapshot {
  ts: number;
  platform: MetricsPlatform;
  tier: MetricsTier;
  /** Poll cadence in ms for THIS tier, so the client can label chart axes. */
  intervalMs: number;
  system: SystemMetrics;
  /** Empty in the light tier. */
  groups: ProcessGroup[];
  /** Empty in the light tier. Latest snapshot only — never retained. */
  processes: ProcessInfo[];
  /** Which optional process columns THIS host can actually fill, so the UI can
   *  hide the unavailable ones instead of showing a wall of "—". All false in
   *  the light tier (no process rows at all). */
  processColumns: ProcessColumnAvailability;
  /** DEPRECATED, remove one release after this ships. Mirrors cpu/mem/count so a
   *  PWA-cached old bundle's `resource-status-bar.tsx:41` destructure of
   *  `latest.total` does not TypeError on every page. */
  total: { cpu: number; ramMB: number; processCount: number };
  /** Non-fatal collector failures, human readable. Rendered in the UI. */
  warnings: string[];
}

export interface KillProcessRequest {
  pid: number;
  /** Identity guard: the `startedAt` the client saw. The server re-queries the
   *  live process and returns 409 on mismatch, so a recycled pid cannot be
   *  killed against a stale name. */
  startedAt: number;
  /** Kill descendants too (`taskkill /T` on Windows, collected tree on POSIX). */
  tree?: boolean;
}

export interface KillProcessResult {
  pid: number;
  tree: boolean;
  method: "taskkill" | "signal";
  /** Pids actually signalled. On win32 with tree:true this is always `[pid]` —
   *  `taskkill /T` walks and kills the tree inside the OS and reports no member
   *  list, so the real count is unknowable from here. */
  killed: number[];
}

/** Sort columns offered by the process table. `disk` sorts by read + write,
 *  `net` by in + out; rows without a value sort last. */
export type SortKey = "cpu" | "ram" | "disk" | "gpu" | "gpuMem" | "net" | "name" | null;
export type SortDir = "asc" | "desc";

/** Full-tier poll cadence. A Windows tick (one CIM round trip) costs ~175-200 ms,
 *  so 2 s leaves an order of magnitude of headroom before ticks would overlap. */
export const METRICS_INTERVAL_MS = 2000;
/** Light-tier poll cadence — node:os only, costs <0.1 ms. */
export const METRICS_LIGHT_INTERVAL_MS = 5000;
/** Client history cap: 30 min at METRICS_INTERVAL_MS. */
export const METRICS_HISTORY_MAX = 900;
/** Subscriber lease: client pings every 10 s, server reaps after 30 s silence. */
export const METRICS_PING_INTERVAL_MS = 10_000;
export const METRICS_LEASE_TIMEOUT_MS = 30_000;
