/**
 * Per-device logcat: one gRPC stream, many watchers, a bounded ring buffer and nothing on disk.
 *
 * Plan §Phase 3 is specific about the shape: filter, pause, clear-view and a ring buffer, with
 * **nothing written to the database**. So this holds a fixed number of entries in memory and
 * hands a new watcher that backlog; filtering, pausing and clearing the view are the client's,
 * because all three are about what one person is looking at, not about what the device said.
 *
 * ## `sort: Parsed` does not work, and fails by being silently empty
 *
 * The proto offers `LogMessage.LogType.Parsed`, which would deliver `LogcatEntry` records with
 * level, tag, pid and tid already separated — exactly what this file wants. Measured against
 * emulator **36.5.10.0** it is not implemented:
 *
 *  - `streamLogcat({sort: "Parsed"})` → **334 messages in 8 seconds, every one of them with an
 *    empty `entries` list AND an empty `contents` string**, each echoing `sort: Text` back. Not
 *    an error, not `UNIMPLEMENTED`: a busy stream of nothing, which reads exactly like a device
 *    that is not logging.
 *  - The same with the numeric enum value (`sort: 1`) — 57 empty messages in 8 seconds.
 *  - `streamLogcat({})` — the default, `Text` — delivers the real log.
 *  - The deprecated unary `getLogcat` answers **12 UNIMPLEMENTED** outright, so there is no
 *    snapshot RPC either; the ring buffer is the only backlog there is.
 *
 * So the lines are parsed here. Two more measured details that shape the parser: each gRPC
 * message carries **exactly one line** with **no trailing newline** (so nothing has to buffer a
 * partial line across messages — though the split still handles it, since a future build
 * batching lines would otherwise silently concatenate them into one entry), and the format is
 * logcat's `threadtime`, which carries no year.
 */
import type { EmulatorChannel } from "./android-grpc.ts";
import type { AndroidLogEntry, AndroidLogLevel } from "../../shared/android-protocol.ts";

/** Enough to scroll back through a crash, far too little to be a storage decision. */
export const LOGCAT_RING_SIZE = 2_000;

/** logcat's one-letter levels. `A` is assert, which Android also calls FATAL. */
const LEVELS: Record<string, AndroidLogLevel> = {
  V: "verbose", D: "debug", I: "info", W: "warn", E: "error", F: "fatal", A: "fatal", S: "verbose",
};

/** `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message` — logcat's `threadtime`, which is the default. */
const THREADTIME = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+([A-Z])\s+([^:]*?)\s*:\s?(.*)$/;

/**
 * Turn one logcat line into an entry.
 *
 * A line that does not parse is **kept**, not dropped: it is a continuation of the line above
 * (a stack trace written with embedded newlines) or a banner like `--------- beginning of main`,
 * and losing either would quietly cut a crash in half. It gets no level and no tag rather than
 * an invented one.
 */
export function parseLogcatLine(line: string, id: number, now = new Date()): AndroidLogEntry | null {
  if (line.length === 0) return null;
  const m = THREADTIME.exec(line);
  if (!m) return { id, timestamp: now.getTime(), pid: 0, tid: 0, level: "verbose", tag: "", message: line };

  const [, mo, day, hh, mm, ss, ms, pid, tid, level, tag, message] = m;
  // threadtime has no year. Assume this one, and step back if that puts the line in the future
  // by more than a day — which is what reading a December log on January 1st looks like.
  let at = new Date(now.getFullYear(), Number(mo) - 1, Number(day), Number(hh), Number(mm), Number(ss), Number(ms));
  if (at.getTime() - now.getTime() > 24 * 60 * 60_000) at = new Date(at.getTime() - 365 * 24 * 60 * 60_000);

  return {
    id,
    timestamp: at.getTime(),
    pid: Number(pid),
    tid: Number(tid),
    level: LEVELS[level!] ?? "verbose",
    tag: tag ?? "",
    message: message ?? "",
  };
}

export type LogcatListener = (entries: AndroidLogEntry[]) => void;

interface DeviceLogcat {
  channel: EmulatorChannel;
  /** The live gRPC stream, or null while nobody is watching. */
  call: any;
  ring: AndroidLogEntry[];
  listeners: Set<LogcatListener>;
  nextId: number;
}

const streams = new Map<string, DeviceLogcat>();

/**
 * Start watching a device's logcat.
 *
 * The channel is the caller's and is NOT closed here: it belongs to the session, which may still
 * be sending input on it long after the log panel is closed.
 */
export function subscribeLogcat(
  deviceId: string,
  channel: EmulatorChannel,
  listener: LogcatListener,
): () => void {
  let stream = streams.get(deviceId);
  if (!stream) {
    stream = { channel, call: null, ring: [], listeners: new Set(), nextId: 1 };
    streams.set(deviceId, stream);
  }
  // A session that reconnected has a new channel; the ring belongs to the device, not to it.
  stream.channel = channel;
  if (!stream.call) openStream(deviceId, stream);
  stream.listeners.add(listener);
  // Hand over what has already been said, so opening the panel does not show an empty box on a
  // device that has been running for an hour.
  if (stream.ring.length > 0) listener([...stream.ring]);

  return () => {
    const s = streams.get(deviceId);
    if (!s) return;
    s.listeners.delete(listener);
    // Plan gate: "logs hidden ngừng subscription". Nobody watching means nothing streaming.
    if (s.listeners.size === 0) closeStream(deviceId);
  };
}

function openStream(deviceId: string, stream: DeviceLogcat): void {
  // No `sort` field: the default is Text, and Parsed is the empty-stream trap described above.
  const call = stream.channel.client.streamLogcat({}, stream.channel.metadata);
  stream.call = call;
  call.on("data", (msg: any) => {
    const contents: string = msg?.contents ?? "";
    if (contents.length === 0) return;
    const entries: AndroidLogEntry[] = [];
    for (const line of contents.split("\n")) {
      const entry = parseLogcatLine(line.replace(/\r$/, ""), stream.nextId);
      if (entry) { stream.nextId++; entries.push(entry); }
    }
    if (entries.length === 0) return;
    stream.ring.push(...entries);
    if (stream.ring.length > LOGCAT_RING_SIZE) {
      stream.ring.splice(0, stream.ring.length - LOGCAT_RING_SIZE);
    }
    for (const l of stream.listeners) l(entries);
  });
  call.on("error", (e: any) => {
    // code 1 is CANCELLED, which is how the last watcher leaving ends it.
    if (e?.code !== 1) console.warn(`[android] logcat stream for ${deviceId} failed: ${e?.details ?? e?.message ?? e}`);
  });
}

/**
 * Stop the gRPC stream but **keep the ring**.
 *
 * The plan's gate is that hiding the log stops the subscription, which this does. Throwing the
 * backlog away as well is a different thing and a worse one: closing the panel to read a stack
 * trace on another screen and reopening it would show an empty box. The cost is that a reopened
 * panel has a gap where nothing was being watched — the timestamps say so.
 */
function closeStream(deviceId: string): void {
  const stream = streams.get(deviceId);
  if (!stream?.call) return;
  try { stream.call.cancel(); } catch { /* already gone */ }
  stream.call = null;
}

/** Tear everything down for a device — the session closing, or the emulator stopping. */
export function closeDeviceLogcat(deviceId: string): void {
  closeStream(deviceId);
  streams.delete(deviceId);
}

/** What a watcher would be handed right now. Exposed for tests and for a snapshot download. */
export function logcatBacklog(deviceId: string): AndroidLogEntry[] {
  return [...(streams.get(deviceId)?.ring ?? [])];
}
