/**
 * Owns one remote-desktop connection end to end: capture lifecycle, WS backpressure,
 * heartbeat/TTL teardown, and forwarding input to the injector. "One active session per
 * host" — a new connection evicts (and awaits) any previous one before starting its own
 * capture so two `gdigrab` processes never contend for the same display.
 */
import { startCapture, type CaptureHandle } from "./remote-desktop-capture.ts";
import { avc1CodecString } from "./avc1-codec-string.ts";
import type { AccessUnit } from "./access-unit-assembler.ts";
import { injectPointer, injectKey, injectWheel, releaseAllModifiers, isInputAvailable } from "./remote-desktop-input.ts";

/** Minimal socket surface this module needs — matches Bun's `ServerWebSocket` shape closely
 *  enough to be faked in a unit test without a real connection. */
export interface RemoteDesktopSocket {
  send(data: string | Uint8Array): number;
  getBufferedAmount?(): number;
  close(code?: number, reason?: string): void;
}

/** App-level heartbeat, independent of Bun's 960s socket `idleTimeout` — a dead tunnel or a
 * sleeping laptop must not leave ffmpeg + input access live for minutes unattended. */
const HEARTBEAT_INTERVAL_MS = 5_000;
// 30s (6 missed 5s pings): tolerant of brief network jitter and of a client whose ping timer
// is throttled while its tab is briefly backgrounded, without leaving an unattended session
// (ffmpeg + input access) live for long. The client also re-pings the moment its tab is visible.
const HEARTBEAT_TIMEOUT_MS = 30_000;
/** Above this many buffered bytes, drop delta AUs until the next keyframe rather than
 *  queueing forever — a slow WAN/tunnel link must degrade to "waits ~2s for a keyframe",
 *  never to unbounded memory growth or an ever-growing latency queue. */
const BACKPRESSURE_THRESHOLD_BYTES = 512 * 1024;

export class RemoteDesktopSession {
  private capture: CaptureHandle | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingAt = Date.now();
  private droppingUntilKey = false;
  private sentConfig = false;
  private closed = false;
  private readonly heldKeyCodes = new Set<string>();
  private exitResolve: (() => void) | null = null;
  /** Resolves once the underlying ffmpeg process has actually exited (not merely asked to). */
  readonly exited: Promise<void>;

  constructor(private readonly ws: RemoteDesktopSocket) {
    this.exited = new Promise((resolve) => { this.exitResolve = resolve; });
  }

  async start(): Promise<void> {
    this.capture = await startCapture({
      onAccessUnit: (au) => this.handleAccessUnit(au),
      // `reason` is only set when ffmpeg died on its own (crash, access denied, etc) — tell
      // the client *why* before closing instead of leaving it to guess from a bare
      // disconnect (this is exactly what happens today for e.g. gdigrab failing against a
      // disconnected Windows session: "Failed to capture image (error 5)").
      onExit: (_code, reason) => {
        this.exitResolve?.();
        if (!this.closed) {
          if (reason) {
            try { this.ws.send(JSON.stringify({ type: "error", message: `Capture failed: ${reason}` })); } catch { /* closing anyway */ }
          }
          this.close();
        }
      },
    });
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  noteClientAlive(): void {
    this.lastPingAt = Date.now();
  }

  async handleClientMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "ping") { this.noteClientAlive(); return; }
    if (msg.type === "stop") { this.close(); return; }
    if (!isInputAvailable()) return; // part 1b unsupported on this OS — silently ignore

    if (msg.type === "pointer") {
      const { xFrac, yFrac, button, down } = msg as { xFrac?: unknown; yFrac?: unknown; button?: unknown; down?: unknown };
      if (typeof xFrac === "number" && typeof yFrac === "number") {
        const btn = button === "left" || button === "right" ? button : null;
        await injectPointer(xFrac, yFrac, btn, typeof down === "boolean" ? down : null);
      }
      return;
    }
    if (msg.type === "wheel") {
      const { dy } = msg as { dy?: unknown };
      if (typeof dy === "number" && Number.isFinite(dy)) await injectWheel(dy);
      return;
    }
    if (msg.type === "key") {
      const { code, down } = msg as { code?: unknown; down?: unknown };
      if (typeof code === "string" && typeof down === "boolean") {
        if (down) this.heldKeyCodes.add(code); else this.heldKeyCodes.delete(code);
        await injectKey(code, down);
      }
      return;
    }
    if (msg.type === "releaseAll") {
      await this.releaseHeldKeys();
    }
  }

  /** Force a keyup for every key this session has tracked as held, then run the modifier
   *  backstop too — `heldKeyCodes` covers whatever the client actually pressed (letters,
   *  digits, etc, not just modifiers); `releaseAllModifiers()` is a second backstop for a
   *  modifier that raced a disconnect before its keydown was ever tracked. Previously this
   *  only ran the modifier backstop and *cleared* `heldKeyCodes` without releasing them,
   *  so a held non-modifier key (e.g. a letter) stayed logically down on the host. */
  private async releaseHeldKeys(): Promise<void> {
    const codes = [...this.heldKeyCodes];
    this.heldKeyCodes.clear();
    await Promise.all(codes.map((code) => injectKey(code, false).catch(() => {})));
    await releaseAllModifiers();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.capture?.stop();
    activeSessions.delete(this);
    if (this.heldKeyCodes.size > 0) {
      this.releaseHeldKeys().catch(() => {});
    }
    try { this.ws.close(); } catch { /* already closing */ }
  }

  private checkHeartbeat(): void {
    if (Date.now() - this.lastPingAt > HEARTBEAT_TIMEOUT_MS) {
      console.warn("[remote-desktop] heartbeat timeout — tearing down session");
      this.close();
    }
  }

  private handleAccessUnit(au: AccessUnit): void {
    if (this.closed) return;
    if (!this.sentConfig) {
      const sps = this.capture?.cachedSps();
      if (!sps) return; // nothing decodable yet — wait for the encoder's first SPS
      const codec = avc1CodecString(sps);
      if (!codec) return;
      this.ws.send(JSON.stringify({ type: "config", codec }));
      this.sentConfig = true;
    }

    const buffered = this.ws.getBufferedAmount?.() ?? 0;
    if (buffered > BACKPRESSURE_THRESHOLD_BYTES && !au.isKey) {
      this.droppingUntilKey = true;
      return;
    }
    if (this.droppingUntilKey && !au.isKey) return;
    if (au.isKey) this.droppingUntilKey = false;

    const framed = new Uint8Array(1 + au.bytes.length);
    framed[0] = au.isKey ? 1 : 0;
    framed.set(au.bytes, 1);
    this.ws.send(framed);
  }
}

const activeSessions = new Set<RemoteDesktopSession>();

/** Evict any previous session (awaiting its ffmpeg exit, capped so a wedged process can't
 *  hang a reconnect) before starting the new one. */
export async function createRemoteDesktopSession(ws: RemoteDesktopSocket): Promise<RemoteDesktopSession> {
  for (const existing of [...activeSessions]) {
    existing.close();
    await Promise.race([existing.exited, Bun.sleep(2000)]);
  }
  const session = new RemoteDesktopSession(ws);
  await session.start();
  activeSessions.add(session);
  return session;
}

/** Process-exit sweep so ffmpeg never outlives a server crash/exit — a clean WS close or an
 *  idle heartbeat timeout is handled by the session itself; this covers everything else
 *  (SIGINT/SIGTERM, uncaught crash unwind). */
let sweepRegistered = false;
export function registerRemoteDesktopExitSweep(): void {
  if (sweepRegistered) return;
  sweepRegistered = true;
  const sweep = () => { for (const s of [...activeSessions]) s.close(); };
  process.on("exit", sweep);
  process.on("SIGINT", sweep);
  process.on("SIGTERM", sweep);
}
