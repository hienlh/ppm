/**
 * Whole-machine metrics: tiered subscribers, leases, one poll timer, atomic
 * delta-state commits and demand-gated children.
 *
 * The tier gates COLLECTION, not just serialisation: the status bar mounts on
 * every page, and if its stream drove full collection PPM would run a 174 ms
 * PowerShell round trip plus a 400-process grouping pass every 2 s forever to
 * render two numbers. So the PowerShell child, `nvidia-smi` and the disk/net
 * queries run only while ≥1 full subscriber exists, and the child is torn down
 * 60 s after the last one leaves (a window reopen then skips the bootstrap).
 */
import type { KillProcessResult, MetricsSnapshot, MetricsTier } from "../../types/system-metrics.ts";
import { METRICS_INTERVAL_MS, METRICS_LEASE_TIMEOUT_MS, METRICS_LIGHT_INTERVAL_MS } from "../../types/system-metrics.ts";
import { collectMemory, sampleCpuTimes } from "./cpu-memory-collector.ts";
import { assembleTick, EMPTY_DELTA_STATE, projectLight, type TickDeltaState, type TickDeps } from "./system-metrics-tick.ts";
import { createPlatformCollectors, type PlatformCollectors } from "./system-metrics-platform.ts";
import { resolveProtectedPidsLive } from "./ppm-protected-pids.ts";
import { SubscriberRegistry, type MetricsSubscriber } from "./metrics-subscriber-registry.ts";
import { PollScheduler, installProcessExitHooks } from "./metrics-poll-scheduler.ts";
import { handleKillRequest, type KillOutcome } from "./kill-request-handler.ts";
import { executeKill } from "./kill-executor.ts";
import { CollectorLock } from "./metrics-collector-lock.ts";

/** Over a proxy a closed window's lease lives until the reap; 8 leaves room for
 *  a few open/close cycles across devices without a spurious 429. */
export const MAX_STREAM_SUBSCRIBERS = 8;
/** Grace before the PowerShell child is torn down after the last full subscriber leaves. */
export const FULL_IDLE_TEARDOWN_MS = 60_000;

export interface SystemMetricsServiceOptions {
  collectors?: PlatformCollectors;
  intervals?: { full: number; light: number };
  idleTeardownMs?: number;
  leaseTimeoutMs?: number;
  now?: () => number;
  resolveProtected?: TickDeps["resolveProtected"];
  execute?: (pid: number, tree: boolean) => Promise<KillProcessResult>;
  log?: (line: string) => void;
  /** Register process exit/signal teardown of children (off in unit tests). */
  exitHooks?: boolean;
}

export type SubscribeInit = Pick<MetricsSubscriber, "tier" | "deliver" | "close">;
export interface SubscribeResult { sid: string; tier: MetricsTier; intervalMs: number }

export class SystemMetricsService {
  private readonly registry = new SubscriberRegistry();
  private readonly scheduler: PollScheduler;
  private readonly collectors: PlatformCollectors;
  private readonly intervals: { full: number; light: number };
  private readonly leaseTimeoutMs: number;
  private readonly now: () => number;
  private readonly tickDeps: TickDeps;
  private readonly execute: NonNullable<SystemMetricsServiceOptions["execute"]>;
  private readonly log: (line: string) => void;
  private readonly exitHooks: boolean;

  /** Serialises the one tick or kill collection allowed to hold the collector. */
  private readonly collectorLock = new CollectorLock();
  private state: TickDeltaState = EMPTY_DELTA_STATE;
  private latest: { light: MetricsSnapshot | null; full: MetricsSnapshot | null } = { light: null, full: null };

  constructor(opts: SystemMetricsServiceOptions = {}) {
    this.collectors = opts.collectors ?? createPlatformCollectors();
    this.intervals = opts.intervals ?? { full: METRICS_INTERVAL_MS, light: METRICS_LIGHT_INTERVAL_MS };
    this.leaseTimeoutMs = opts.leaseTimeoutMs ?? METRICS_LEASE_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.execute = opts.execute ?? executeKill;
    this.log = opts.log ?? ((line) => console.log(line));
    this.exitHooks = opts.exitHooks ?? true;
    this.tickDeps = {
      platform: this.collectors.platform,
      memory: () => collectMemory(),
      processes: this.collectors.processes,
      diskNet: this.collectors.diskNet,
      gpus: this.collectors.gpus,
      resolveProtected: opts.resolveProtected ?? resolveProtectedPidsLive,
      now: this.now,
      sampleCpu: sampleCpuTimes,
    };
    this.scheduler = new PollScheduler({
      intervals: this.intervals,
      idleTeardownMs: opts.idleTeardownMs ?? FULL_IDLE_TEARDOWN_MS,
      onTick: () => void this.runTick(),
      onIdle: () => this.collectors.processes.stop(),
      onFullStart: () => this.ensureExitHooks(),
    });
  }

  /** Null when the cap of live subscribers is reached (expired leases are reaped first). */
  subscribe(init: SubscribeInit): SubscribeResult | null {
    this.reapExpired();
    if (this.registry.count() >= MAX_STREAM_SUBSCRIBERS) return null;
    const sid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    this.registry.add({ sid, ...init, lastPingAt: this.now() });
    this.reconcile();
    // A newcomer on an already-running tier would otherwise wait a whole
    // interval. Deferred so the caller can write its `session` frame first.
    const latest = this.latest[init.tier];
    if (latest) queueMicrotask(() => { if (this.registry.has(sid)) init.deliver(latest); });
    return { sid, tier: init.tier, intervalMs: this.intervals[init.tier] };
  }

  unsubscribe(sid: string): boolean {
    const removed = this.registry.remove(sid);
    if (removed) this.reconcile();
    return removed;
  }

  ping(sid: string): boolean {
    return this.registry.ping(sid, this.now());
  }

  getLatest(tier: MetricsTier): MetricsSnapshot | null {
    return this.latest[tier];
  }

  liveCount(tier?: MetricsTier): number {
    return this.registry.count(tier);
  }

  activeTier(): MetricsTier | null {
    return this.scheduler.activeTier();
  }

  /** Drop leases silent for longer than the timeout; returns how many. */
  reapExpired(): number {
    const expired = this.registry.reap(this.now(), this.leaseTimeoutMs);
    if (expired.length > 0) this.reconcile();
    return expired.length;
  }

  /**
   * A kill re-collects the process table through the same collector the tick
   * uses, and the PowerShell session accepts one request at a time — so the
   * kill waits for an in-flight tick, and ticks skip while a kill holds the
   * collector, instead of one of them failing with "request already in flight".
   */
  async kill(body: unknown): Promise<KillOutcome> {
    this.ensureExitHooks();
    try {
      return await this.collectorLock.runExclusive(() => handleKillRequest(body, {
        platform: this.collectors.platform,
        collector: this.collectors.processes,
        resolveProtected: this.tickDeps.resolveProtected,
        execute: this.execute,
        log: this.log,
      }));
    } finally {
      // The re-query may have started the PowerShell child with no window open.
      if (this.registry.count("full") === 0) this.scheduler.armIdle();
    }
  }

  /** One poll: assemble for the active tier, commit the baseline, publish. */
  async runTick(): Promise<void> {
    // A Windows tick is ~174 ms and can slip, and a kill re-collects through the
    // same collector: an overlapping collection would consume the delta baseline
    // twice (CPU% in the hundreds) or fail with "request already in flight".
    // Dropping a poll instead is harmless — metrics are lossy by nature.
    await this.collectorLock.tryRun(() => this.assembleAndPublish());
  }

  private async assembleAndPublish(): Promise<void> {
    try {
      this.reapExpired();
      const tier = this.scheduler.activeTier();
      if (!tier) return;
      const { snapshot, nextState } = await assembleTick(tier, this.state, this.tickDeps, this.latest.full);
      this.state = nextState;
      this.publish(snapshot);
    } catch (e) {
      console.error("[SystemMetrics] tick failed:", (e as Error)?.message ?? e);
    }
  }

  /** Drop every subscriber, stop timers and kill children. */
  shutdown(): void {
    this.registry.clear();
    this.scheduler.stop();
    this.teardownChildren();
  }

  private publish(snapshot: MetricsSnapshot): void {
    if (snapshot.tier === "full") {
      this.latest.full = snapshot;
      this.latest.light = projectLight(snapshot);
    } else {
      this.latest.light = snapshot;
    }
    for (const s of this.registry.list("full")) if (this.latest.full) s.deliver(this.latest.full);
    for (const s of this.registry.list("light")) if (this.latest.light) s.deliver(this.latest.light);
  }

  private reconcile(): void {
    const changed = this.scheduler.reconcile(this.registry.count("full"), this.registry.count("light"));
    // Leaving the full tier: its baselines would be stale by the time it resumes.
    if (changed && this.scheduler.activeTier() !== "full") {
      this.state = { ...this.state, procCpu: null, procIo: null, disk: null, net: null };
    }
  }

  private teardownChildren = (): void => {
    try { this.collectors.processes.stop(); } catch { /* already gone */ }
  };

  private ensureExitHooks(): void {
    if (this.exitHooks) installProcessExitHooks(this.teardownChildren);
  }
}

export const systemMetricsService = new SystemMetricsService();
