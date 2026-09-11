/**
 * Owns one remote-desktop connection end to end: capture lifecycle, WS backpressure,
 * heartbeat/TTL teardown, and forwarding input to the injector. "One active session per
 * host" — a new connection evicts (and awaits) any previous one before starting its own
 * capture so two `gdigrab` processes never contend for the same display.
 */
import { startCapture, type CaptureHandle } from "./remote-desktop-capture.ts";
import { workingEncoders } from "../media-transcode/ffmpeg-capabilities.ts";
import { startAudioCapture, type AudioHandle } from "./remote-desktop-audio.ts";
import { engagePrivacy, type PrivacyHandle } from "./remote-desktop-privacy.ts";
import { listHostResolutions, setHostResolution } from "./remote-desktop-resolution.ts";
import {
  clampCustomFps, clampCustomQualityPercent, customBitrateArg, ratioBitrateArg,
} from "../../shared/remote-desktop-custom-quality.ts";
import { avc1CodecString } from "./avc1-codec-string.ts";
import type { AccessUnit } from "./access-unit-assembler.ts";
import { injectPointer, injectKey, injectWheel, injectText, releaseAllModifiers, isInputAvailable } from "./remote-desktop-input.ts";
import { resolveDisplay, type RemoteDisplay } from "./remote-desktop-displays.ts";
import {
  MAX_CLIPBOARD_CHARS, pasteComboCodes, readHostClipboard, writeHostClipboard,
} from "./remote-desktop-clipboard.ts";
import {
  BACKPRESSURE_THRESHOLD_BYTES, DEFAULT_FPS, DEFAULT_PRESET_ID, QUALITY_PRESETS,
  congestionState, initialAdaptiveState, nextRatioScale, noteBackpressure, parsePresetId,
  type AdaptiveState, type QualityPresetId,
  type QualityPreset,
} from "./remote-desktop-quality.ts";

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
/** Sustained backpressure drops delta AUs until the next keyframe rather than queueing
 *  forever — a slow WAN/tunnel link must degrade to "waits for a keyframe", never to unbounded
 *  memory growth or an ever-growing latency queue. Both thresholds and the "has it lasted long
 *  enough to be real" rule live in `remote-desktop-quality.ts` (`congestionState`). */
/** Longest `text` message injected in one go — a paste, not a file; anything bigger is dropped. */
const MAX_TEXT_CHARS = 1024;
/** Binary frame kinds. Video keeps 0/1 (delta/key) so the existing client framing is unchanged;
 *  audio is a third value rather than a second socket, which would need its own auth. */
const FRAME_VIDEO_DELTA = 0;
const FRAME_VIDEO_KEY = 1;
const FRAME_AUDIO = 2;

export class RemoteDesktopSession {
  private capture: CaptureHandle | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingAt = Date.now();
  private droppingUntilKey = false;
  private sentConfig = false;
  private closed = false;
  private readonly heldKeyCodes = new Set<string>();
  /** Bumped on every (re)start of capture. An ffmpeg that has been superseded by a quality
   *  change still emits buffered access units and *always* fires `onExit`; without this both
   *  would be attributed to the live capture — the exit would tear the whole session down and
   *  the stale frames would be fed to a decoder already reconfigured for another resolution. */
  private captureGeneration = 0;
  /** Resolves when the *current* ffmpeg has exited. Replaced per start, so the eviction wait in
   *  `createRemoteDesktopSession` always tracks the process that is actually running rather
   *  than one that exited during some earlier quality change. */
  private captureExited: Promise<void> = Promise.resolve();
  private presetId: QualityPresetId = DEFAULT_PRESET_ID;
  /** How much of the chosen rung's ratio is actually in force: 1 is all of it, less means a
   *  congested link has pulled the bitrate down *underneath* the user's choice. RustDesk treats
   *  a chosen image quality as the maximum ratio and keeps adapting below it; the old code made
   *  the choice a freeze instead, which left a link that could not carry the rung discarding
   *  delta frames forever — the reported continuous flicker. Never above 1. */
  private ratioScale = 1;
  private adaptive: AdaptiveState = initialAdaptiveState(Date.now());
  /** Guards against a client spamming quality changes into overlapping respawns. */
  private switchingPreset = false;
  /** When the socket's buffer first went over threshold and stayed there, or null while it is
   *  draining normally. See `BACKPRESSURE_SUSTAIN_MS`. */
  private backpressureSince: number | null = null;
  /** Last text known to be on *both* clipboards. Without it the two directions feed each other:
   *  the client pastes T, the host clipboard becomes T, the next `clipboardRead` reads T back and
   *  pushes it to the client, whose own clipboard write re-arms the loop. */
  private lastClipboardText: string | null = null;
  /** Whether the host pointer is drawn into the frames. Capture-time on every grabber, so a
   *  change is a respawn — see `restartCapture`. */
  private drawMouse: boolean;
  /** H.264 encoder this session asked for, or null to use the capability probe's first choice.
   *  Like the cursor, it is fixed for the life of an ffmpeg, so a change is a respawn. */
  private encoder: string | null;
  /** Host audio, off until the client asks — capture costs a second ffmpeg and most sessions
   *  are a screen share, not a video. */
  private audio: AudioHandle | null = null;
  /** Guards a client toggling audio faster than ffmpeg starts. */
  private switchingAudio = false;
  /** Local input blocked + host monitor blanked, while engaged. Held on the shared X
   *  connection, so it also dies with the process — see `remote-desktop-privacy.ts`. */
  private privacy: PrivacyHandle | null = null;
  /** Guards a client clicking through the resolution list faster than X can switch. */
  private switchingResolution = false;
  /** RustDesk's custom rung, or null while a named preset is in force. Its bitrate is derived
   *  from the *capture* size rather than stored, because the host can change resolution
   *  mid-session and a bitrate computed for the old size would then be wrong. */
  private custom: { percent: number; fps: number } | null = null;
  /** The mode that was live when this session first changed it, so teardown can put it back.
   *  Set once and never overwritten: after two switches the *first* value is the user's own. */
  private originalModeId: string | null = null;

  constructor(
    private readonly ws: RemoteDesktopSocket,
    private readonly display: RemoteDisplay | null,
    drawMouse = true,
    encoder: string | null = null,
  ) {
    this.drawMouse = drawMouse;
    this.encoder = encoder;
  }

  /** Resolves once the underlying ffmpeg process has actually exited (not merely asked to). */
  get exited(): Promise<void> {
    return this.captureExited;
  }

  async start(): Promise<void> {
    await this.beginCapture();
    this.heartbeatTimer = setInterval(() => this.onHeartbeatTick(), HEARTBEAT_INTERVAL_MS);
  }

  /** Spawn ffmpeg for the current preset. Also used by `applyPreset`, which is why the config
   *  and backpressure flags are reset here: the new process emits its own SPS, and the client
   *  has to be told to reconfigure its decoder before the first frame of it arrives. */
  /** The rung ffmpeg is actually given. For `custom` this keeps the *display's own* height —
   *  RustDesk's image quality never downscales, and `height` is a ceiling clamped to the
   *  source, so passing the display height means "no scaling" without a special case in the
   *  filter builder. */
  /** The fps and bitrate ffmpeg is actually given. A rung carries only a *ratio*, so the real
   *  bitrate cannot exist until the capture size does — it is `base_bitrate(w, h)` for this
   *  display times the ratio, exactly as RustDesk computes it. The resolution is never part of
   *  this: every rung streams the host's own size. */
  private effectivePreset(): QualityPreset {
    const width = this.display?.width ?? 1920;
    const height = this.display?.height ?? 1080;
    if (this.custom) {
      return {
        fps: this.custom.fps,
        bitrate: customBitrateArg(this.custom.percent, width, height),
      };
    }
    // `ratioScale` is what congestion has held back; the rung's own ratio is the ceiling.
    const ratio = QUALITY_PRESETS[this.presetId].ratio * this.ratioScale;
    return { fps: DEFAULT_FPS, bitrate: ratioBitrateArg(ratio, width, height) };
  }

  private async beginCapture(): Promise<void> {
    const generation = ++this.captureGeneration;
    let resolveExit!: () => void;
    this.captureExited = new Promise<void>((resolve) => { resolveExit = resolve; });
    this.sentConfig = false;
    this.droppingUntilKey = false;
    this.capture = await startCapture({
      display: this.display,
      preset: this.effectivePreset(),
      drawMouse: this.drawMouse,
      ...(this.encoder ? { encoder: this.encoder } : {}),
      onAccessUnit: (au) => this.handleAccessUnit(au, generation),
      // `reason` is only set when ffmpeg died on its own (crash, access denied, etc) — tell
      // the client *why* before closing instead of leaving it to guess from a bare
      // disconnect (this is exactly what happens today for e.g. gdigrab failing against a
      // disconnected Windows session: "Failed to capture image (error 5)").
      onExit: (_code, reason) => {
        resolveExit();
        // A process we deliberately replaced: its exit says nothing about the session.
        if (generation !== this.captureGeneration) return;
        if (!this.closed) {
          if (reason) {
            try { this.ws.send(JSON.stringify({ type: "error", message: `Capture failed: ${reason}` })); } catch { /* closing anyway */ }
          }
          this.close();
        }
      },
    });
  }

  /** Apply a change that ffmpeg can only take at startup: stop the old process, wait for it to
   *  actually go, then start a new one. `mutate` is what the *next* spawn should differ by —
   *  it runs after the guards so a rejected restart never leaves the session claiming a setting
   *  its ffmpeg is not using. Returns false when there was nothing to restart.
   *
   *  Sequential on purpose — two grabbers on one display contend (see the note on
   *  `createRemoteDesktopSession`), so the ~400ms gap is accepted rather than overlapped. */
  private async restartCapture(mutate: () => void): Promise<boolean> {
    if (this.closed || this.switchingPreset) return false;
    this.switchingPreset = true;
    try {
      mutate();
      // Invalidate the outgoing process BEFORE killing it. `beginCapture` bumps the generation
      // too, but that happens after the old ffmpeg has already exited — so without this bump
      // its `onExit` still matches the current generation, reads as "capture died on its own"
      // and tears down the whole session on every quality change.
      this.captureGeneration++;
      const previous = this.captureExited;
      this.capture?.stop();
      await Promise.race([previous, Bun.sleep(2000)]);
      if (this.closed) return false;
      await this.beginCapture();
      return true;
    } finally {
      this.switchingPreset = false;
    }
  }

  /** Switch rung. The client is told the new rung only once the new ffmpeg is up, because that
   *  message is also what makes its decoder reconfigure. */
  private async applyPreset(next: QualityPresetId): Promise<void> {
    if (next === this.presetId && this.ratioScale === 1) return;
    const restarted = await this.restartCapture(() => {
      this.presetId = next;
      // Picking a rung is an explicit statement about bandwidth, so it also clears whatever
      // congestion had held back — otherwise choosing "Good image quality" on a link that has
      // been struggling would apply a third of it and look like the menu had not worked.
      this.ratioScale = 1;
      this.adaptive = initialAdaptiveState(Date.now());
    });
    if (restarted) this.sendQuality();
  }

  /** Apply what congestion has decided, keeping the rung the user chose. This is the whole
   *  difference from the old behaviour: the stream gets cheaper, the choice stays put, and no
   *  encoded frame is thrown away. */
  private async applyRatioScale(scale: number): Promise<void> {
    if (scale === this.ratioScale) return;
    const restarted = await this.restartCapture(() => {
      this.ratioScale = scale;
      this.adaptive = initialAdaptiveState(Date.now());
    });
    if (restarted) this.sendQuality();
  }

  /** Switch the host's own display mode, then respawn the grabber onto the new geometry.
   *
   *  The respawn is not optional: `-video_size`/`-i :0.0+X,Y` are baked at spawn, so an ffmpeg
   *  left running across a mode change keeps grabbing a rectangle that no longer matches the
   *  framebuffer — which reads as a frozen or torn picture rather than an error. The display
   *  list is re-read for the same reason, since the crop this session uses comes from it. */
  private async applyResolution(modeId: string): Promise<void> {
    if (this.closed || this.switchingResolution) return;
    this.switchingResolution = true;
    try {
      // Remember where the host started *before* the first change, not after.
      if (this.originalModeId === null) {
        const current = (await listHostResolutions()).modes.find((m) => m.current);
        if (current) this.originalModeId = current.id;
      }
      const result = await setHostResolution(modeId);
      if (!result.ok) {
        this.send({ type: "resolutionError", message: result.error ?? "The host refused the mode." });
        return;
      }
      await this.restartCapture(() => { /* geometry is read fresh by `beginCapture` */ });
      // Read back rather than echoing `result`: the picker must tick what the host is really
      // doing, and X is free to have landed on something else.
      await this.sendResolution();
    } finally {
      this.switchingResolution = false;
    }
  }

  /** Engage or release privacy mode. Always answers with the state that actually holds: a
   *  failed engage (another client already holds a grab — a screen locker, an open menu) must
   *  report "off" rather than leave a switch claiming the host is locked out when it is not. */
  private async setPrivacy(enabled: boolean): Promise<void> {
    if (this.closed) return;
    if (!enabled) {
      this.privacy?.release();
      this.privacy = null;
      this.send({ type: "privacy", enabled: false, blanked: false });
      return;
    }
    if (this.privacy) return;
    const handle = await engagePrivacy();
    // Engaging and then immediately closing would leave the grab held with nobody to release
    // it — the one sequence that could lock the local user out for real.
    if (this.closed) { handle?.release(); return; }
    this.privacy = handle;
    this.send({
      type: "privacy",
      enabled: handle !== null,
      blanked: handle?.blanked === true,
      ...(handle ? {} : { reason: "Another program already holds the keyboard (a screen lock, or an open menu)." }),
    });
  }

  /** Start or stop the audio ffmpeg. Independent of the video capture on purpose: audio must
   *  survive a quality change (which respawns the video encoder), and a host with no loopback
   *  device must not fail to share its screen. */
  private async setAudio(enabled: boolean): Promise<void> {
    if (this.closed || this.switchingAudio || enabled === (this.audio !== null)) return;
    this.switchingAudio = true;
    try {
      if (!enabled) {
        this.audio?.stop();
        this.audio = null;
        this.send({ type: "audio", enabled: false });
        return;
      }
      const handle = await startAudioCapture({
        onPacket: (packet) => this.handleAudioPacket(packet),
        onStreamInfo: (info) => this.send({ type: "audio", enabled: true, ...info }),
        // Audio dying is not a session failure — the picture keeps going and the client is
        // told the switch is back off, unlike the video capture whose exit closes everything.
        onExit: () => {
          if (this.audio === null || this.closed) return;
          this.audio = null;
          this.send({ type: "audio", enabled: false });
        },
      });
      // A host with no loopback device: say so rather than leaving the toggle looking on.
      if (!handle || this.closed) { handle?.stop(); this.send({ type: "audio", enabled: false }); return; }
      this.audio = handle;
    } finally {
      this.switchingAudio = false;
    }
  }

  /** Audio is dropped under congestion rather than queued, and never triggers the video's
   *  drop-until-keyframe path: Opus packets are independent, so a gap is a short click that
   *  heals itself, where a dropped H.264 delta freezes the picture until the next keyframe. */
  private handleAudioPacket(packet: Uint8Array): void {
    if (this.closed || this.audio === null) return;
    if ((this.ws.getBufferedAmount?.() ?? 0) > BACKPRESSURE_THRESHOLD_BYTES) return;
    const framed = new Uint8Array(1 + packet.length);
    framed[0] = FRAME_AUDIO;
    framed.set(packet, 1);
    try { this.ws.send(framed); } catch { /* socket going away */ }
  }

  private send(msg: Record<string, unknown>): void {
    try { this.ws.send(JSON.stringify(msg)); } catch { /* socket going away */ }
  }

  private sendCodec(): void {
    try {
      this.ws.send(JSON.stringify({ type: "codec", encoder: this.encoder }));
    } catch { /* socket going away */ }
  }

  /** The mode that is live now, so the picker ticks what the host is really doing rather than
   *  what was asked for — a refused switch must not leave the menu lying. */
  private async sendResolution(): Promise<void> {
    const { output, modes } = await listHostResolutions();
    const current = modes.find((m) => m.current);
    try {
      this.ws.send(JSON.stringify({
        type: "resolution", output, modeId: current?.id ?? null,
        width: current?.width ?? 0, height: current?.height ?? 0,
        // RustDesk's `isOriginalResolutionSet`: what to offer as "Original". Null until this
        // session has actually changed something, so a session that never did offers nothing.
        original: this.originalModeId,
      }));
    } catch { /* socket going away */ }
  }

  private sendQuality(): void {
    try {
      this.ws.send(JSON.stringify({
        type: "quality", preset: this.presetId,
        // Not "which rung am I on" — that is `preset`, and it is whatever the user chose. This
        // is how much of it the link is currently allowing, so the picker can show that the
        // choice stands while the stream is temporarily cheaper.
        held: this.ratioScale < 1 ? Number(this.ratioScale.toFixed(2)) : undefined,
        ...(this.custom ? { custom: this.custom } : {}),
      }));
    } catch { /* socket going away; the next message will fail the same way */ }
  }

  noteClientAlive(): void {
    this.lastPingAt = Date.now();
  }

  async handleClientMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "ping") { this.noteClientAlive(); return; }
    if (msg.type === "stop") { this.close(); return; }
    if (msg.type === "quality") {
      // RustDesk's custom rung: a bitrate percentage and an fps, both re-clamped here because
      // they arrive off the wire from a device whose localStorage the user can edit. `More` is
      // not sent — the ceiling it unlocks is the wire maximum, and the *client* is what decides
      // whether to offer it, so the host allows the full range rather than second-guessing.
      if (msg.preset === "custom") {
        const { percent, fps } = msg as { percent?: unknown; fps?: unknown };
        const next = {
          percent: clampCustomQualityPercent(percent, true),
          fps: clampCustomFps(fps),
        };
        if (this.custom && this.custom.percent === next.percent && this.custom.fps === next.fps) return;
        const restarted = await this.restartCapture(() => {
          this.custom = next;
          // Typed numbers replace whatever congestion had held back, the same as a named rung.
          this.ratioScale = 1;
          this.adaptive = initialAdaptiveState(Date.now());
        });
        if (restarted) this.sendQuality();
        return;
      }
      // Anything that is not a rung id is garbage off the wire, not a request for `auto`: there
      // is no `auto` any more, because the adaptation always runs (see `considerRatioScale`).
      const chosen = parsePresetId(msg.preset);
      if (!chosen) return;
      // Leaving custom has to clear it, or the named rung it switches to would keep the custom
      // bitrate and fps and only look like it changed.
      if (this.custom) {
        const leaving = this.custom;
        this.custom = null;
        if (chosen === this.presetId) {
          // Same rung id as before custom: `applyPreset` would early-return and the capture
          // would keep running with `leaving`'s numbers.
          const restarted = await this.restartCapture(() => {
            this.ratioScale = 1;
            this.adaptive = initialAdaptiveState(Date.now());
          });
          if (restarted) this.sendQuality();
          return;
        }
      }
      await this.applyPreset(chosen);
      return;
    }
    if (msg.type === "privacy") {
      const { enabled } = msg as { enabled?: unknown };
      if (typeof enabled !== "boolean") return;
      await this.setPrivacy(enabled);
      return;
    }
    if (msg.type === "audio") {
      const { enabled } = msg as { enabled?: unknown };
      if (typeof enabled !== "boolean") return;
      await this.setAudio(enabled);
      return;
    }
    if (msg.type === "codec") {
      // Checked against the probe rather than a hardcoded list: naming an encoder this build
      // or GPU cannot run makes ffmpeg exit immediately, which would surface to the user as
      // "Capture failed" on a menu item the UI itself offered.
      const { encoder } = msg as { encoder?: unknown };
      if (typeof encoder !== "string" || encoder === this.encoder) return;
      if (!(await workingEncoders()).includes(encoder)) return;
      const restarted = await this.restartCapture(() => { this.encoder = encoder; });
      if (restarted) this.sendCodec();
      return;
    }
    if (msg.type === "resolution") {
      const { modeId } = msg as { modeId?: unknown };
      if (typeof modeId !== "string" || modeId.length === 0) return;
      await this.applyResolution(modeId);
      return;
    }
    if (msg.type === "cursor") {
      // The pointer is burned into the frames by the grabber, so this is a respawn rather than
      // an overlay the client could draw or hide by itself. Not echoed back: unlike `quality`
      // (which `auto` lets the *session* change), nothing here moves it but the client.
      const { show } = msg as { show?: unknown };
      if (typeof show !== "boolean" || show === this.drawMouse) return;
      await this.restartCapture(() => { this.drawMouse = show; });
      return;
    }
    // Both clipboard directions sit *above* the input gate: moving text is not input
    // injection, so it keeps working on a view-only host (only the paste keystroke needs it).
    if (msg.type === "clipboard") {
      const { text, paste, shift } = msg as { text?: unknown; paste?: unknown; shift?: unknown };
      if (typeof text !== "string" || text.length === 0 || text.length > MAX_CLIPBOARD_CHARS) return;
      const wrote = await writeHostClipboard(text);
      if (wrote) this.lastClipboardText = text;
      if (paste !== true || !isInputAvailable()) return;
      // The client swallows its own Ctrl+V (it has to: `preventDefault` on that keydown is what
      // cancels the browser's `paste` event, so the text would never arrive) — so the paste
      // keystroke is ours to deliver, and only after the write has actually landed.
      if (wrote) await this.injectPasteCombo(shift === true);
      // No clipboard tool on the host: type the text instead of dropping the paste on the
      // floor. Slower and subject to the host's IME, but a paste that arrives beats silence —
      // and `/capabilities` already told the client to offer the install command.
      else if (text.length <= MAX_TEXT_CHARS) await injectText(text);
      return;
    }
    if (msg.type === "clipboardRead") {
      await this.sendHostClipboard();
      return;
    }
    if (!isInputAvailable()) return; // part 1b unsupported on this OS — silently ignore

    if (msg.type === "pointer") {
      const { xFrac, yFrac, button, down } = msg as { xFrac?: unknown; yFrac?: unknown; button?: unknown; down?: unknown };
      if (typeof xFrac === "number" && typeof yFrac === "number") {
        const btn = button === "left" || button === "right" ? button : null;
        await injectPointer(xFrac, yFrac, btn, typeof down === "boolean" ? down : null, this.display);
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
    if (msg.type === "text") {
      // Layout-independent text entry (mobile keyboards, non-ASCII). Backends without a text
      // path report false and the message is dropped — the client keeps its per-key fallback.
      const { text } = msg as { text?: unknown };
      if (typeof text === "string" && text.length > 0 && text.length <= MAX_TEXT_CHARS) await injectText(text);
      return;
    }
    if (msg.type === "releaseAll") {
      await this.releaseHeldKeys();
    }
  }

  /** Read the host clipboard and push it to the client, skipping text the client already has.
   *  Silent when the host has no clipboard tool — `clipboardAvailable` is reported up front in
   *  `/capabilities`, so the UI explains it once instead of per keystroke. */
  private async sendHostClipboard(): Promise<void> {
    const text = await readHostClipboard();
    if (this.closed || text === null || text === this.lastClipboardText) return;
    this.lastClipboardText = text;
    try { this.ws.send(JSON.stringify({ type: "clipboard", text })); } catch { /* socket going away */ }
  }

  /** Press the host's paste shortcut. `releaseHeldKeys` first because the client *did* forward
   *  the modifier keydown before swallowing the V (keydown order is Control, then Shift, then V,
   *  then `paste`), and a stale Ctrl/Shift held from that would turn this into another shortcut.
   *
   *  `shift` mirrors what the user actually pressed — see `pasteComboCodes`. */
  private async injectPasteCombo(shift: boolean): Promise<void> {
    const combo = pasteComboCodes(process.platform, shift);
    await this.releaseHeldKeys();
    for (const code of combo) await injectKey(code, true);
    for (const code of [...combo].reverse()) await injectKey(code, false);
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
    this.audio?.stop();
    this.audio = null;
    // Before anything that could throw: a held grab is the only piece of state here that
    // degrades the *host* rather than the session.
    this.privacy?.release();
    this.privacy = null;
    // Fire-and-forget, like `releaseHeldKeys` below: `close()` is synchronous (it runs from the
    // socket's close handler) and this is an async X round trip. Restoring is not optional —
    // leaving the host at 1280x720 after the remote user disconnects means its owner comes back
    // to a desktop with every window crammed into a corner, and no way to know why.
    if (this.originalModeId !== null) {
      const restore = this.originalModeId;
      this.originalModeId = null;
      setHostResolution(restore).catch(() => {});
    }
    activeSessions.delete(this);
    if (this.heldKeyCodes.size > 0) {
      this.releaseHeldKeys().catch(() => {});
    }
    try { this.ws.close(); } catch { /* already closing */ }
  }

  /** The heartbeat tick is also where an *upgrade* is considered: a quiet link produces no
   *  events at all, so there is nothing else to hang "things have been fine for a while" on. */
  private onHeartbeatTick(): void {
    if (Date.now() - this.lastPingAt > HEARTBEAT_TIMEOUT_MS) {
      console.warn("[remote-desktop] heartbeat timeout — tearing down session");
      this.close();
      return;
    }
    this.considerRatioScale();
  }

  /** Runs whatever the user picked — a named rung is a ceiling, not an off switch. */
  private considerRatioScale(): void {
    if (this.closed || this.switchingPreset) return;
    // The custom dialog's numbers are exempt: the user typed a bitrate, and quietly encoding at
    // a third of it would make the dialog lie about what the host is doing.
    if (this.custom) return;
    const next = nextRatioScale(this.ratioScale, this.adaptive, Date.now());
    if (next !== null) void this.applyRatioScale(next);
  }

  private handleAccessUnit(au: AccessUnit, generation: number): void {
    if (this.closed) return;
    // Frames still draining out of an ffmpeg we replaced: the client's decoder has already been
    // reconfigured for the new rung, so these would decode as corruption at best.
    if (generation !== this.captureGeneration) return;
    if (!this.sentConfig) {
      const sps = this.capture?.cachedSps();
      if (!sps) return; // nothing decodable yet — wait for the encoder's first SPS
      const codec = avc1CodecString(sps);
      if (!codec) return;
      this.ws.send(JSON.stringify({
        type: "config", codec, preset: this.presetId,
        encoder: this.encoder,
      }));
      this.sentConfig = true;
    }

    // A backlog has to persist before it costs the client a resync — see `congestionState`.
    const now = Date.now();
    const congestion = congestionState(this.backpressureSince, this.ws.getBufferedAmount?.() ?? 0, now);
    this.backpressureSince = congestion.since;
    if (congestion.congested && !au.isKey) {
      this.droppingUntilKey = true;
      // Only sustained congestion feeds the ladder too: degrading a rung respawns ffmpeg for
      // ~400ms, which is a worse hiccup than the one a spike would have caused.
      this.adaptive = noteBackpressure(this.adaptive, now);
      this.considerRatioScale();
      return;
    }
    if (this.droppingUntilKey && !au.isKey) return;
    if (au.isKey) this.droppingUntilKey = false;

    const framed = new Uint8Array(1 + au.bytes.length);
    framed[0] = au.isKey ? FRAME_VIDEO_KEY : FRAME_VIDEO_DELTA;
    framed.set(au.bytes, 1);
    this.ws.send(framed);
  }
}

const activeSessions = new Set<RemoteDesktopSession>();

export interface CreateRemoteDesktopSessionOptions {
  /** One of `/capabilities`' `displays[].id`; absent/unknown = the host's primary. */
  displayId?: string;
  /** Draw the host pointer from the very first frame. Taken at create time rather than left to
   *  a `cursor` message so a client that keeps the pointer off does not pay for a respawn
   *  immediately after connecting. */
  showCursor?: boolean;
  /** H.264 encoder to start on, for the same reason. Dropped if this host cannot run it: the
   *  pref is device-local, so the same browser reaching a second host arrives asking for that
   *  first host's GPU encoder — and an encoder ffmpeg cannot open makes it exit at once, i.e. a
   *  viewer that never shows a frame and blames "Capture failed". */
  encoder?: string;
}

/** Evict any previous session (awaiting its ffmpeg exit, capped so a wedged process can't
 *  hang a reconnect) before starting the new one. */
export async function createRemoteDesktopSession(
  ws: RemoteDesktopSocket,
  { displayId, showCursor = true, encoder }: CreateRemoteDesktopSessionOptions = {},
): Promise<RemoteDesktopSession> {
  for (const existing of [...activeSessions]) {
    existing.close();
    await Promise.race([existing.exited, Bun.sleep(2000)]);
  }
  const usable = encoder && (await workingEncoders()).includes(encoder) ? encoder : null;
  const session = new RemoteDesktopSession(
    ws, await resolveDisplay(displayId), showCursor, usable,
  );
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
