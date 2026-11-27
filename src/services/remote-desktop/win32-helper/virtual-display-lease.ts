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
 *
 * "Off" is a request, not an order: the helper refuses while the display is the only screen of
 * a session signed in at the PC (`virtual-display-safety-script.ts`), which on a headless PC is
 * the normal state once the session has been brought back. The marker then stays, and PPM asks
 * again every `RETRY_MS` while no session holds the lease — it goes through once the session has
 * left the console (an RDP sign-in, say).
 */
import { join } from "node:path";
import { createLogger } from "../../logger.ts";
import { helperPaths } from "./helper-paths.ts";
import { lateHelperAnswer, runHelperAction, type HelperRunResult } from "./helper-service.ts";
import { helperSystem } from "./helper-system.ts";
import { parseJson } from "./helper-json.ts";
import { applyVirtualDisplayMode } from "./virtual-display-mode.ts";

const log = createLogger("remote-desktop");

export const IDLE_MS = 2 * 60_000;
export const GRACE_MS = 30_000;
export const RETRY_MS = 10 * 60_000;

export interface LeaseDeps {
  run(action: "DisplayOn" | "DisplayOff"): Promise<HelperRunResult>;
  /** The answer to a `run` that came back `pending`, whenever it lands (null if never). */
  lateAnswer(action: "DisplayOn"): Promise<HelperRunResult | null>;
  /** Give the display that just came on a usable size (Windows starts it at 800x600). */
  setMode(): Promise<void>;
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
  lateAnswer: (action) => lateHelperAnswer(action),
  // The device takes a moment to appear after the task enables it, so a few short tries.
  setMode: async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (applyVirtualDisplayMode()) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
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
    if (result.ok) await this.adopt();
    // The helper may still turn it on after the request stopped waiting (measured: 27 s). PPM must
    // then still record that it did, or it never turns the display off again.
    else if (result.pending) {
      void this.deps.lateAnswer("DisplayOn").then(async (late) => {
        if (late?.ok) { log.info("virtual display came on after the request stopped waiting"); await this.adopt(); }
      });
    }
    return result;
  }

  /** The display is on because PPM asked: remember that, size it, and start the idle clock. */
  private async adopt(): Promise<void> {
    this.deps.writeMarker(true);
    await this.deps.setMode();
    if (this.holders === 0) this.schedule(IDLE_MS);
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

  private schedule(ms: number, why = "no session is using it"): void {
    this.cancel();
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.turnOff(why); }, ms);
  }

  private cancel(): void {
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
  }

  private async turnOff(why: string): Promise<void> {
    if (this.holders > 0 || !this.deps.readMarker()) return;
    const result = await this.deps.run("DisplayOff");
    log.info(`virtual display off (${why}): ok=${result.ok} ${result.message}`);
    if (result.ok) { this.deps.writeMarker(false); return; }
    // Refused (or failed): keep the marker, so a restart tries too, and ask again later unless a
    // session took the lease in the meantime.
    if (this.holders === 0) this.schedule(RETRY_MS, "kept on earlier; trying again");
  }
}

export const virtualDisplayLease = new VirtualDisplayLease();
