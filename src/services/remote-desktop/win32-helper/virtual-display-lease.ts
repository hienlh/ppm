/**
 * When the virtual display PPM turned on is turned off again.
 *
 * The driver listens on a pipe anyone may write to, so the device must not stay on longer than
 * a Remote Desktop session needs it. Rules:
 * - PPM only ever turns off a display it turned on itself (a marker file records that), never
 *   one the user enabled by hand.
 * - Turned on but no session starts within `IDLE_MS` (the user pressed the button and then
 *   Cancel) → off.
 * - Every session holds the lease while it runs; when the last one closes → off after
 *   `GRACE_MS`, so a reconnect or a quality change that reopens the socket does not flap it.
 * - PPM starts and finds the marker (it died mid-session) → off.
 */
import { join } from "node:path";
import { createLogger } from "../../logger.ts";
import { helperPaths } from "./helper-paths.ts";
import { runHelperAction, type HelperRunResult } from "./helper-service.ts";
import { helperSystem } from "./helper-system.ts";
import { parseJson } from "./helper-json.ts";

const log = createLogger("remote-desktop");

export const IDLE_MS = 2 * 60_000;
export const GRACE_MS = 30_000;

export interface LeaseDeps {
  run(action: "DisplayOn" | "DisplayOff"): Promise<HelperRunResult>;
  readMarker(): boolean;
  writeMarker(on: boolean): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

function markerPath(): string {
  return join(helperPaths().stagingDir, "virtual-display-on.json");
}

const realDeps: LeaseDeps = {
  run: (action) => runHelperAction(action),
  readMarker: () => parseJson<{ on?: boolean }>(helperSystem().readText(markerPath()))?.on === true,
  writeMarker: (on) => helperSystem().writeText(markerPath(), JSON.stringify({ on, at: new Date().toISOString() })),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class VirtualDisplayLease {
  private holders = 0;
  private timer: unknown = null;

  constructor(private readonly deps: LeaseDeps = realDeps) {}

  /** Turn the display on for a session about to start. */
  async turnOn(): Promise<HelperRunResult> {
    const result = await this.deps.run("DisplayOn");
    if (result.ok) {
      this.deps.writeMarker(true);
      if (this.holders === 0) this.schedule(IDLE_MS);
    }
    return result;
  }

  /** A remote-desktop session started. */
  acquire(): void {
    this.holders++;
    this.cancel();
  }

  /** A remote-desktop session ended. */
  release(): void {
    this.holders = Math.max(0, this.holders - 1);
    if (this.holders === 0 && this.deps.readMarker()) this.schedule(GRACE_MS);
  }

  /** PPM just started: a marker left behind means a display PPM turned on outlived it. */
  async sweepOnStartup(): Promise<void> {
    if (this.deps.readMarker()) await this.turnOff("left on by a previous run");
  }

  private schedule(ms: number): void {
    this.cancel();
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.turnOff("no session is using it"); }, ms);
  }

  private cancel(): void {
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
  }

  private async turnOff(why: string): Promise<void> {
    if (this.holders > 0 || !this.deps.readMarker()) return;
    const result = await this.deps.run("DisplayOff");
    // Keep the marker when the helper could not do it, so the next start tries again.
    if (result.ok) this.deps.writeMarker(false);
    log.info(`virtual display off (${why}): ok=${result.ok} ${result.message}`);
  }
}

export const virtualDisplayLease = new VirtualDisplayLease();
