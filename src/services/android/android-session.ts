/**
 * One live viewing session per *device*, shared by every viewer looking at it.
 *
 * The pipeline is per device rather than per socket deliberately: a second viewer must not cost
 * a second gRPC stream and a second ffmpeg for the same pixels. What is per socket is the
 * *controller lease* — plan §5 — because two people sending touches into one guest at once is
 * not a feature, it is a fight.
 *
 * Two generations ride on every frame and are checked on every input, and they answer different
 * questions (see `src/shared/android-protocol.ts`):
 *  - `sessionGeneration` changes when the lease moves. Input from a client that has been
 *    superseded but does not know it yet is dropped rather than applied.
 *  - `geometryGeneration` changes when the emulator changes frame size or rotation. Input
 *    carrying an old geometry describes a screen that no longer exists, so it is rejected
 *    instead of being mapped onto the new one.
 *
 * A viewer that stops sending heartbeats loses the lease after `LEASE_EXPIRY_MS` — a laptop lid
 * closed mid-session must not hold the device hostage — but it keeps *watching*, because losing
 * a network for four seconds should not close the tab's picture.
 */
import { connectToEmulator, getEmulatorStatus, type EmulatorChannel } from "./android-grpc.ts";
import { startVideoPipeline, type FrameGeometry, type RunningPipeline } from "./android-video.ts";
import {
  releaseAllTouches, sendHardwareKey, sendKey, sendText, sendTouch, setRotation,
  type HardwareKey,
} from "./android-input.ts";
import { subscribeLogcat, closeDeviceLogcat, LOGCAT_RING_SIZE } from "./android-logcat.ts";
import type { RunningEmulator } from "./emulator-discovery.ts";
import {
  encodeVideoFrame, type AndroidClientMessage, type AndroidGeometry, type AndroidLogEntry,
  type AndroidQuality, type AndroidServerMessage,
} from "../../shared/android-protocol.ts";

/** Plan §5: heartbeat every 5s, lease gone after 15s of silence. */
const LEASE_EXPIRY_MS = 15_000;
const LEASE_SWEEP_MS = 2_500;

/**
 * Stop queueing delta frames for a viewer whose socket is this far behind.
 *
 * Deliberately a single threshold and not a ladder. `ws.getBufferedAmount()` is Bun's *userspace*
 * queue and drains into the kernel socket buffer, so it was measured effectively inert even at
 * 0.4 Mbit/s over a real relay (CLAUDE.md, remote desktop). Anything more elaborate built on it
 * would be untestable by construction; this exists only so a genuinely stuck socket cannot grow
 * without bound. Keyframes are never dropped — dropping one costs the client the whole GOP.
 */
const MAX_SOCKET_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Coalescing window for log entries. One WS frame per gRPC message would swamp the video. */
const LOGCAT_FLUSH_MS = 120;

export interface AndroidSocket {
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount?(): number;
  /** True once the socket's close has been handled. A socket can close while its session is
   *  still starting, and its close handler then had no viewer to remove. */
  isClosed?(): boolean;
}

interface Viewer {
  id: string;
  socket: AndroidSocket;
  lastSeen: number;
  sequence: number;
  /** A viewer cannot decode anything until a keyframe arrives, so deltas before it are noise. */
  sawKeyframe: boolean;
  visible: boolean;
  /** Set while this viewer has the log panel open; calling it stops the subscription. */
  logcatOff: (() => void) | null;
}

interface DeviceSession {
  deviceId: string;
  emulator: RunningEmulator;
  channel: EmulatorChannel;
  pipeline: RunningPipeline;
  viewers: Map<string, Viewer>;
  controllerId: string | null;
  sessionGeneration: number;
  geometryGeneration: number;
  deviceWidth: number;
  deviceHeight: number;
  quality: AndroidQuality;
  /** Last codec string announced, so a change is sent once rather than per keyframe. */
  codec: string | null;
  sweep: ReturnType<typeof setInterval>;
}

const sessions = new Map<string, DeviceSession>();

/**
 * Sessions still starting, by device. `openDeviceSession` awaits twice before there is a session
 * to put in `sessions`, so without this two viewers arriving together each started a gRPC stream
 * and an ffmpeg, and the second replaced the first in the map — leaving a pipeline running that
 * nothing could reach or stop.
 */
const opening = new Map<string, Promise<DeviceSession>>();

/**
 * Viewers still waiting on a session that is starting, by device. Every waiter resumes from the
 * same promise, one after the other, so one whose socket closed in the meantime must not take an
 * empty session down while another is about to attach to it.
 */
const waiting = new Map<string, number>();

function openShared(opts: AttachOptions, open: typeof openDeviceSession): Promise<DeviceSession> {
  const pending = opening.get(opts.deviceId);
  if (pending) return pending;
  const started: Promise<DeviceSession> = open(opts.deviceId, opts.emulator, opts.quality)
    .then((session) => {
      sessions.set(opts.deviceId, session);
      return session;
    })
    .finally(() => {
      if (opening.get(opts.deviceId) === started) opening.delete(opts.deviceId);
    });
  opening.set(opts.deviceId, started);
  return started;
}

function send(viewer: Viewer, message: AndroidServerMessage): void {
  try { viewer.socket.send(JSON.stringify(message)); } catch { /* closing */ }
}

function geometryMessage(s: DeviceSession): AndroidGeometry {
  const g = s.pipeline.geometry;
  return {
    width: g.width,
    height: g.height,
    deviceWidth: s.deviceWidth,
    deviceHeight: s.deviceHeight,
    rotation: g.rotation,
    generation: s.geometryGeneration,
  };
}

// ---------------------------------------------------------------------------------------------
// The device session
// ---------------------------------------------------------------------------------------------

async function openDeviceSession(
  deviceId: string,
  emulator: RunningEmulator,
  quality: AndroidQuality,
): Promise<DeviceSession> {
  const channel = connectToEmulator(emulator);
  const status = await getEmulatorStatus(channel);

  // Placeholders until the pipeline resolves — it is the thing that knows the real geometry and
  // the real codec string, and its callbacks fire during its own startup, before either exists.
  let self: DeviceSession | null = null;
  let pipelineRef: RunningPipeline | null = null;

  const pipeline = await startVideoPipeline({
    emulator,
    quality,
    onAccessUnit: (au, ptsMs) => {
      if (!self) return;
      // A keyframe may carry a new SPS — a rung switch and a rotation both respawn the encoder,
      // and the profile/level are encoder-default, so the client must be reconfigured before it
      // decodes anything from the new bitstream.
      if (au.isKey) {
        const codec = pipelineRef?.codecString() ?? null;
        if (codec && codec !== self.codec) {
          self.codec = codec;
          for (const viewer of self.viewers.values()) send(viewer, { type: "codec", codec });
        }
      }
      for (const viewer of self.viewers.values()) {
        if (!viewer.visible) continue;
        if (au.isKey) viewer.sawKeyframe = true;
        else if (!viewer.sawKeyframe) continue;
        if (!au.isKey && (viewer.socket.getBufferedAmount?.() ?? 0) > MAX_SOCKET_BACKLOG_BYTES) continue;
        const frame = encodeVideoFrame({
          keyframe: au.isKey,
          codecConfig: false,
          sessionGeneration: self.sessionGeneration,
          geometryGeneration: self.geometryGeneration,
          sequence: viewer.sequence++,
          ptsMs,
        }, au.bytes);
        try { viewer.socket.send(frame); } catch { /* closing */ }
      }
    },
    onGeometry: (g: FrameGeometry) => {
      if (!self) return;                       // the first call is the startup one, already known
      self.geometryGeneration = (self.geometryGeneration + 1) & 0xffff;
      self.codec = null;
      // Every viewer's decoder is now holding parameters for a size that no longer exists.
      for (const viewer of self.viewers.values()) {
        viewer.sawKeyframe = false;
        send(viewer, { type: "geometry", geometry: geometryMessage(self) });
      }
      void g;
    },
    onError: (message) => {
      if (!self) return;
      for (const viewer of self.viewers.values()) send(viewer, { type: "error", message });
    },
  }).catch((e) => {
    channel.close();
    throw e;
  });

  pipelineRef = pipeline;

  const session: DeviceSession = {
    deviceId,
    emulator,
    channel,
    pipeline,
    viewers: new Map(),
    controllerId: null,
    sessionGeneration: 1,
    geometryGeneration: 1,
    // The guest's own size, which the frame is a scaled copy of. Falls back to the frame's own
    // size when the AVD does not declare one, so the viewer's coordinate maths always has a base.
    deviceWidth: status.displayWidth ?? pipeline.geometry.width,
    deviceHeight: status.displayHeight ?? pipeline.geometry.height,
    quality,
    codec: pipeline.codecString(),
    sweep: setInterval(() => sweepLease(session), LEASE_SWEEP_MS),
  };
  self = session;
  return session;
}

async function closeDeviceSession(session: DeviceSession): Promise<void> {
  clearInterval(session.sweep);
  // Only what is this session's own: the device may already have a newer one, and both the map
  // entry and the logcat stream are keyed by device.
  if (sessions.get(session.deviceId) === session) {
    sessions.delete(session.deviceId);
    // The logcat stream holds this same channel, so it has to go before the channel is closed —
    // and it would not be dropped by the last viewer leaving if that viewer died without a close.
    closeDeviceLogcat(session.deviceId);
  }
  await session.pipeline.stop().catch(() => {});
  // Leave no finger down on a guest PPM is walking away from: the emulator does expire a touch
  // slot on its own, but only after 120 seconds.
  await releaseAllTouches(session.channel).catch(() => {});
  session.channel.close();
}

/** A controller that has stopped heartbeating loses the lease; it keeps watching. */
function sweepLease(session: DeviceSession): void {
  const controller = session.controllerId ? session.viewers.get(session.controllerId) : undefined;
  if (!controller) return;
  if (Date.now() - controller.lastSeen <= LEASE_EXPIRY_MS) return;
  void releaseAllTouches(session.channel).catch(() => {});
  send(controller, { type: "controller", controller: false, reason: "lease expired" });
  session.controllerId = null;
  session.sessionGeneration = (session.sessionGeneration + 1) & 0xffff;
  // Hand it to whoever has been alive most recently rather than leaving the device unusable.
  const next = [...session.viewers.values()]
    .filter((v) => v.id !== controller.id && Date.now() - v.lastSeen <= LEASE_EXPIRY_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen)[0];
  if (next) {
    session.controllerId = next.id;
    send(next, { type: "controller", controller: true, reason: "the previous controller went away" });
  }
}

function grantControl(session: DeviceSession, viewer: Viewer): void {
  if (session.controllerId === viewer.id) return;
  const previous = session.controllerId ? session.viewers.get(session.controllerId) : undefined;
  session.controllerId = viewer.id;
  session.sessionGeneration = (session.sessionGeneration + 1) & 0xffff;
  // The outgoing controller may have fingers down; nothing else will ever release them.
  void releaseAllTouches(session.channel).catch(() => {});
  if (previous) send(previous, { type: "controller", controller: false, reason: "another viewer took control" });
  send(viewer, { type: "controller", controller: true });
}

// ---------------------------------------------------------------------------------------------
// The per-socket viewer
// ---------------------------------------------------------------------------------------------

export interface AndroidViewerSession {
  handleClientMessage(text: string): Promise<void>;
  close(): void;
}

export interface AttachOptions {
  deviceId: string;
  emulator: RunningEmulator;
  quality: AndroidQuality;
}

/** `open` is what a test stands in for: the real one needs a running emulator. */
export async function attachAndroidViewer(
  socket: AndroidSocket,
  opts: AttachOptions,
  open: typeof openDeviceSession = openDeviceSession,
): Promise<AndroidViewerSession> {
  // Counted in this function rather than a helper of its own: an `await` on a helper would put
  // a tick between the count going down and the check below, and every waiter would then see an
  // empty count before the live one had attached.
  let session: DeviceSession;
  const known = sessions.get(opts.deviceId);
  if (known) {
    session = known;
  } else {
    waiting.set(opts.deviceId, (waiting.get(opts.deviceId) ?? 0) + 1);
    try {
      session = await openShared(opts, open);
    } finally {
      const left = (waiting.get(opts.deviceId) ?? 1) - 1;
      if (left > 0) waiting.set(opts.deviceId, left);
      else waiting.delete(opts.deviceId);
    }
  }

  // Closed while the session was starting: nothing else will ever remove this viewer, so it is
  // never added. The session goes too if nobody is on it and nobody else is still waiting for
  // it, or a device with no viewer left keeps its ffmpeg encoding for good.
  if (socket.isClosed?.()) {
    if (session.viewers.size === 0 && !waiting.has(opts.deviceId)) void closeDeviceSession(session);
    return { async handleClientMessage() {}, close() {} };
  }

  const viewer: Viewer = {
    id: crypto.randomUUID(),
    socket,
    lastSeen: Date.now(),
    sequence: 0,
    sawKeyframe: false,
    visible: true,
    logcatOff: null,
  };
  session.viewers.set(viewer.id, viewer);

  // First one in gets the lease; later ones watch until they ask for it.
  if (!session.controllerId) session.controllerId = viewer.id;

  send(viewer, {
    type: "ready",
    sessionId: viewer.id,
    sessionGeneration: session.sessionGeneration,
    geometry: geometryMessage(session),
    controller: session.controllerId === viewer.id,
    codec: session.codec,
    encoder: session.pipeline.encoder,
  });

  const isController = () => session.controllerId === viewer.id;

  /**
   * Logcat is delivered in batches on a timer rather than per gRPC message.
   *
   * A device that is logging hard produces hundreds of entries a second, and one WS frame each
   * would both flood the socket and starve the video frames sharing it. `LOGCAT_FLUSH_MS` is the
   * coalescing window; a viewer whose socket is already backed up is skipped entirely, because
   * the ring buffer means the entries are not lost — they are re-sent from the backlog when the
   * panel is reopened.
   */
  let logBatch: AndroidLogEntry[] = [];
  let logTimer: ReturnType<typeof setTimeout> | null = null;

  function flushLog(): void {
    logTimer = null;
    const entries = logBatch;
    logBatch = [];
    if (entries.length === 0) return;
    if ((viewer.socket.getBufferedAmount?.() ?? 0) > MAX_SOCKET_BACKLOG_BYTES) return;
    send(viewer, { type: "log", entries });
  }

  function startLogcat(): void {
    if (viewer.logcatOff) return;
    viewer.logcatOff = subscribeLogcat(session.deviceId, session.channel, (entries) => {
      logBatch.push(...entries);
      // Never let the pending batch outgrow the ring it came from.
      if (logBatch.length > LOGCAT_RING_SIZE) logBatch = logBatch.slice(-LOGCAT_RING_SIZE);
      if (!logTimer) logTimer = setTimeout(flushLog, LOGCAT_FLUSH_MS);
    });
  }

  function stopLogcat(): void {
    viewer.logcatOff?.();
    viewer.logcatOff = null;
    if (logTimer) { clearTimeout(logTimer); logTimer = null; }
    logBatch = [];
  }

  async function handle(message: AndroidClientMessage): Promise<void> {
    viewer.lastSeen = Date.now();

    switch (message.type) {
      case "heartbeat":
        send(viewer, { type: "heartbeat" });
        return;

      case "visibility":
        viewer.visible = message.visible;
        // The pipeline only pauses when *nobody* is watching: another viewer's tab being open is
        // reason enough to keep encoding.
        session.pipeline.setPaused(![...session.viewers.values()].some((v) => v.visible));
        if (message.visible) viewer.sawKeyframe = false;   // resync from the next keyframe
        return;

      case "take-control":
        grantControl(session, viewer);
        return;

      case "quality":
        if (!isController()) return;
        if (message.quality === session.quality) return;
        session.quality = message.quality;
        session.codec = null;
        await session.pipeline.setQuality(message.quality);
        for (const v of session.viewers.values()) {
          v.sawKeyframe = false;
          send(v, { type: "quality", quality: message.quality });
        }
        return;

      case "input-reset":
        if (!isController()) return;
        await releaseAllTouches(session.channel);
        return;

      case "logcat":
        // Above the lease gate on purpose: reading the log is not controlling the device, and a
        // second person watching a crash while someone else drives is the normal case. Putting
        // this in the switch below would silently refuse every viewer without the lease.
        if (message.subscribe) startLogcat(); else stopLogcat();
        return;
    }

    // Everything below this line is input, and input needs the lease.
    if (!isController()) {
      send(viewer, { type: "controller", controller: false, reason: "another viewer holds control" });
      return;
    }

    switch (message.type) {
      case "touch":
        // Coordinates describe a geometry; if it has changed they describe nothing.
        if (message.geometryGeneration !== session.geometryGeneration) return;
        await sendTouch(session.channel, message.touches);
        return;
      case "key":
        if (message.geometryGeneration !== session.geometryGeneration) return;
        await sendKey(session.channel, message.key, message.action);
        return;
      case "text":
      case "paste":
        // `sendText` picks the path: ASCII types, anything else goes via the clipboard, because
        // `sendKey.text` silently drops every non-ASCII character (measured in Phase 0).
        await sendText(session.channel, message.text);
        return;
      case "hardware":
        await sendHardwareKey(session.channel, message.key as HardwareKey);
        return;
      case "rotate":
        await setRotation(session.channel, message.rotation);
        // Nothing is announced here: the next frame carries the emulator's own rotation and the
        // pipeline's `onGeometry` is what tells every viewer.
        return;
    }
  }

  const viewerSession: AndroidViewerSession = {
    async handleClientMessage(text: string) {
      let message: AndroidClientMessage;
      try { message = JSON.parse(text); } catch { return; }
      if (!message || typeof message.type !== "string") return;
      try {
        await handle(message);
      } catch (e) {
        send(viewer, { type: "error", message: (e as Error).message });
      }
    },

    close() {
      stopLogcat();
      session.viewers.delete(viewer.id);
      if (session.controllerId === viewer.id) {
        session.controllerId = null;
        void releaseAllTouches(session.channel).catch(() => {});
        // Hand the lease on rather than leaving the device uncontrollable for 15 seconds.
        const next = [...session.viewers.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (next) {
          session.controllerId = next.id;
          session.sessionGeneration = (session.sessionGeneration + 1) & 0xffff;
          send(next, { type: "controller", controller: true, reason: "the previous controller disconnected" });
        }
      }
      if (session.viewers.size === 0) void closeDeviceSession(session);
    },
  };
  return viewerSession;
}

/** The emulator keeps running; only PPM's view of it is torn down. */
export async function closeAllAndroidSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => closeDeviceSession(s)));
}

let sweepRegistered = false;
export function registerAndroidExitSweep(): void {
  if (sweepRegistered) return;
  sweepRegistered = true;
  // ffmpeg would otherwise outlive PPM: it is spawned detached from any shell job control.
  for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { void closeAllAndroidSessions(); });
  }
}
