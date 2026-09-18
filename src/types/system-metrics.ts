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
  /** Everything below is Mission Center's CPU page and is absent where this host
   *  cannot measure it — the UI hides the row rather than showing a 0.
   *
   *  Kernel-mode share, drawn as a second line under the total. */
  kernelPercent?: number;
  coreKernel?: number[];
  /** Mean current clock across the online cores, MHz. */
  currentMHz?: number;
  /** Package sensor, °C. */
  tempC?: number;
  /** Package draw over the tick, watts (RAPL energy delta / elapsed). */
  powerW?: number;
  /** Kernel-wide totals for the page's rows. Handles is open file descriptors,
   *  which is the closest Linux analogue of the Windows figure. */
  threadCount?: number;
  handleCount?: number;
  /** Seconds since boot. */
  uptimeSec?: number;
}

export interface MemoryMetrics {
  totalMB: number;
  usedMB: number;
  availableMB: number;
  /** usedMB / totalMB × 100. */
  percent: number;
  /** Mission Center's composition bar, in BYTES. The four add up to the total, so
   *  the bar needs no normalisation. Absent on a host with no /proc/meminfo. */
  inUseBytes?: number;
  /** Written-to pages not yet on disk (Dirty + Writeback). */
  modifiedBytes?: number;
  /** Reclaimable: page cache, buffers and reclaimable slab. */
  standbyBytes?: number;
  freeBytes?: number;
  cachedMB?: number;
  /** Address space promised to processes, and the kernel's ceiling for it. */
  committedMB?: number;
  commitLimitMB?: number;
  swapTotalMB?: number;
  swapUsedMB?: number;
  /** zram, summed across every device. `compressedMB` is what the compressed
   *  pages occupy; `savingsMB` is what they would have occupied uncompressed
   *  minus that, i.e. the RAM the compression bought back. Both absent on a host
   *  with no zram — which is not the same as a host whose zram is empty. */
  zramCompressedMB?: number;
  zramSavingsMB?: number;
}

/** One fan, plus the temperature its chip reports beside it — Mission Center's
 *  Fan page. Small and few, so the labels ride the tick rather than the inventory. */
export interface FanMetrics {
  /** Stable across ticks: "<hwmon name>/fan<N>", e.g. "it8689/fan1". */
  id: string;
  /** The chip's own label when it has one, else "Fan N". */
  label: string;
  rpm: number;
  /** Duty cycle, 0-100, from the matching `pwmN` (raw 0-255). */
  pwmPercent?: number;
  /** The chip's temperature sensor with the same index, °C. */
  tempC?: number;
  tempName?: string;
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
  /** Dedicated memory. `vramTotalMB` 0 = the device has none to report (an
   *  integrated GPU), so the UI shows no memory figure rather than "0 B / 0 B". */
  vramUsedMB: number;
  vramTotalMB: number;
  /** Everything below is Mission Center's GPU page. Each field is absent when this
   *  driver/host cannot measure it, and the UI hides that row or graph mode.
   *
   *  Stable device id matching `GpuInfo.id`: the PCI address ("0000:00:02.0"), or
   *  "<driver>-<n>" for a GPU with none. */
  id?: string;
  /** GTT / shared system memory (amdgpu), MB. */
  sharedUsedMB?: number;
  sharedTotalMB?: number;
  /** Video engines, 0-100. When `GpuInfo.encodeDecodeShared`, the one combined
   *  counter is reported as `encodePercent` and `decodePercent` is absent. */
  encodePercent?: number;
  decodePercent?: number;
  clockMHz?: number;
  clockMaxMHz?: number;
  memClockMHz?: number;
  memClockMaxMHz?: number;
  powerW?: number;
  powerMaxW?: number;
  tempC?: number;
}

/** Static facts about one GPU — served by the hardware inventory, never per tick. */
export interface GpuInfo {
  /** Same id as `GpuMetrics.id`. */
  id: string;
  name: string;
  vendor?: string;
  /** Kernel driver: "i915", "xe", "amdgpu", "nvidia". */
  driver?: string;
  driverVersion?: string;
  /** Highest context the driver offers: "4.6", or "ES 3.2". Absent = unknown. */
  openglVersion?: string;
  /** Vulkan API version, "1.4.354". Absent = unsupported or unknown. */
  vulkanVersion?: string;
  pcieGen?: number;
  pcieLanes?: number;
  /** Only when different from the current link (Mission Center hides an equal one). */
  pcieMaxGen?: number;
  pcieMaxLanes?: number;
  /** One combined video engine (Intel VCS): the UI shows "Video encode/decode". */
  encodeDecodeShared?: boolean;
}

export interface SystemMetrics {
  cpu: CpuMetrics;
  mem: MemoryMetrics;
  /** light tier: available:false. */
  disk: RateMetrics;
  /** light tier: available:false. */
  net: RateMetrics;
  /** light tier: []. Empty also when no GPU is readable — the UI hides the card. */
  gpus: GpuMetrics[];
  /** light tier: 0. Processes the collector could see this tick. */
  processCount: number;
  /** Per-device figures for the Performance page's drive and network entries (full
   *  tier). Absent = not collected on this host; static facts about each device are
   *  in the hardware inventory (`src/types/system-hardware.ts`), keyed by `id`. */
  disks?: DiskMetrics[];
  nics?: NicMetrics[];
  /** Absent where the host exposes no fan tachometer (most laptops, every VM). */
  fans?: FanMetrics[];
}

/** One whole disk (a /sys/block entry), for Mission Center's per-drive page. */
export interface DiskMetrics {
  /** Kernel name, the key into the inventory: "nvme0n1", "sda". */
  id: string;
  /** False on this device's first sample: the rates below need two of them, so the
   *  UI says "measuring…" rather than a confident 0. The two totals are absolutes
   *  and are always real. */
  available: boolean;
  /** "Active time": share of the tick with I/O in flight (iostat %util), 0-100. */
  busyPercent: number;
  /** "Avg. response time": ms per completed request (read + write + discard +
   *  flush) over the tick; 0 when none completed. */
  responseMs: number;
  readBps: number;
  writeBps: number;
  /** Bytes since boot ("Total Read" / "Total Written"). */
  readTotal: number;
  writeTotal: number;
  /** Drive sensor, °C (NVMe composite, SATA via drivetemp); absent when none. */
  tempC?: number;
}

export type NicState = "connected" | "connecting" | "disconnected" | "unavailable" | "unknown";

/** One network interface, for Mission Center's per-interface page. */
export interface NicMetrics {
  /** Interface name, the key into the inventory: "enp3s0". */
  id: string;
  /** False on this interface's first sample (the rates need two). The totals are
   *  absolutes and are always real. */
  available: boolean;
  rxBps: number;
  txBps: number;
  /** Bytes since the interface came up ("Total Received" / "Total Sent"). */
  rxTotal: number;
  txTotal: number;
  state: NicState;
  /** Negotiated link speed, Mbit/s — Mission Center's "Maximum Bitrate", and the
   *  throughput axis ceiling when dynamic scaling is off. Absent when unknown. */
  linkMbps?: number;
  /** Wireless only. */
  ssid?: string;
  signalPercent?: number;
  frequencyMHz?: number;
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
  /** Anonymous memory the kernel has pushed out to swap, MB — Mission Center's
   *  Swap column. `undefined` = this OS does not report it per process; a kernel
   *  thread, which has no address space at all, reports 0. */
  swapMB?: number;
  /** `"<scope>:<unit>"` — the Services row this pid belongs to, read from its
   *  cgroup ("system:sshd.service"). The scope is part of the key because
   *  `dbus-broker.service` exists in BOTH on an ordinary desktop. Absent on a
   *  host with no systemd, for a pid in no unit, and for another user's units.
   *  The Services page's live figures are summed over it. */
  unitKey?: string;
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
  swapMB?: number;
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
  /** Linux only so far: `VmSwap` in `/proc/<pid>/status`. */
  swap: boolean;
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
  /** Linux desktop apps (full tier). Absent on other hosts and from older servers. */
  apps?: AppInfo[];
  /** Signals this host can deliver. Absent = an older server (kill route only). */
  signals?: ProcessSignal[];
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

/** Mission Center's process menu: "Stop" is TERM, "Force Stop" is KILL, and the
 *  "Send Signal" submenu offers all eight. Names without the `SIG` prefix. */
export type ProcessSignal = "TERM" | "KILL" | "STOP" | "CONT" | "HUP" | "INT" | "USR1" | "USR2";

export const PROCESS_SIGNALS: readonly ProcessSignal[] = ["TERM", "KILL", "STOP", "CONT", "HUP", "INT", "USR1", "USR2"];

export interface SignalProcessRequest {
  pid: number;
  /** Identity guard, exactly as for a kill: 409 when the live process started at
   *  another time, so a recycled pid is never signalled against a stale name. */
  startedAt: number;
  signal: ProcessSignal;
  /** Deliver to the whole collected tree as well. Suspending an app means
   *  suspending its helpers, which signalling the root alone does not do. */
  tree?: boolean;
}

export interface SignalProcessResult {
  pid: number;
  signal: ProcessSignal;
  tree: boolean;
  method: "taskkill" | "signal";
  /** Pids actually signalled (win32 + tree: `[pid]`, as for a kill). */
  signalled: number[];
}

/** On-demand facts for the Details dialog — fetched when it opens, never per tick.
 *  Live figures (CPU, memory, …) come from the snapshot row, not from here. Every
 *  field is null when this OS or this pid's permissions do not expose it. */
export interface ProcessDetails {
  pid: number;
  ppid: number;
  name: string;
  startedAt: number;
  /** Full command line, secrets redacted but NOT truncated to the row's 160 chars. */
  command: string | null;
  exe: string | null;
  cwd: string | null;
  user: string | null;
  /** Kernel state, e.g. "S (sleeping)", "T (stopped)". */
  state: string | null;
  threads: number | null;
  nice: number | null;
  /** Linux cgroup path — which systemd unit or app scope the process runs in. */
  cgroup: string | null;
}

/** A running desktop application — Mission Center's "Apps" section. Linux only:
 *  identified from the user's app cgroups and `.desktop` Exec matching. */
export interface AppInfo {
  /** Desktop file id without `.desktop`: "org.kde.konsole". Stable across ticks. */
  id: string;
  /** The entry's unlocalised `Name=`. */
  name: string;
  /** The entry's `Icon=`: a theme icon name or an absolute path; resolved to an
   *  image by `/api/system/app-icon`. Null when the entry has none. */
  icon: string | null;
  /** Primary pids: app pids whose parent is not also one of this app's pids. Each
   *  stands for its whole subtree, which is what an app row's figures sum over. */
  pids: number[];
}

/** Sort columns offered by the process table. `disk` sorts by read + write,
 *  `net` by in + out; rows without a value sort last. */
export type SortKey = "cpu" | "ram" | "swap" | "disk" | "gpu" | "gpuMem" | "net" | "name" | null;
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
