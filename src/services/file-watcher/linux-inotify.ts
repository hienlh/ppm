/**
 * Directory watches on Linux through one raw inotify instance, called over bun:ffi.
 *
 * Bun's `fs.watch` on Linux opens a descriptor for every *file* in a watched directory as well
 * as for the directory itself (4 directories holding 600 files come to 604). The live server
 * held 76,565 of them for its projects — 63k files, 13k directories — and every `Bun.spawn`
 * then took ~5.6 ms instead of 0.08 ms, so each git call, terminal and Claude session stopped
 * the event loop that long. An inotify watch on a directory already reports every entry in it:
 * here the whole process holds one descriptor, whatever it watches.
 *
 * It also sidesteps Bun's registry being keyed by path, which makes a re-watch of a deleted and
 * recreated directory silent forever (see recreated-dir-poller.ts): a recreated directory is a
 * new inode, and adding a watch for it simply returns a new watch descriptor.
 *
 * The descriptor is read on a timer. `Bun.file(fd).stream()` over it ends at once with no events
 * (measured), and a read that blocks would hold the loop; a non-blocking read that finds nothing
 * is one syscall. The file watcher batches what it reports into 500 ms windows anyway.
 */
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const IN_NONBLOCK = 0o4000;
const IN_CLOEXEC = 0o2000000;

const IN_MODIFY = 0x2;
const IN_ATTRIB = 0x4;
const IN_MOVED_FROM = 0x40;
const IN_MOVED_TO = 0x80;
const IN_CREATE = 0x100;
const IN_DELETE = 0x200;
const IN_Q_OVERFLOW = 0x4000;
/** The kernel dropped the watch: the directory is gone, its filesystem unmounted, or we removed it. */
const IN_IGNORED = 0x8000;
const IN_ONLYDIR = 0x01000000;
const IN_DONT_FOLLOW = 0x02000000;

/** The split libuv (and so Node's `fs.watch`) makes: entries appearing or vanishing vs. content. */
const RENAME_EVENTS = IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE;
const CHANGE_EVENTS = IN_MODIFY | IN_ATTRIB;
const WATCH_MASK = RENAME_EVENTS | CHANGE_EVENTS | IN_ONLYDIR | IN_DONT_FOLLOW;

/** `struct inotify_event`: int wd; uint32 mask, cookie, len; then `len` bytes of NUL-padded name. */
const EVENT_HEADER_BYTES = 16;
const READ_BUFFER_BYTES = 64 * 1024;
const POLL_MS = 50;

export type DirEventKind = "rename" | "change";
export type DirEventListener = (kind: DirEventKind, name: string) => void;

export interface DirWatch {
  close(): void;
}

interface Inotify {
  fd: number;
  addWatch: (fd: number, path: Uint8Array, mask: number) => number;
  rmWatch: (fd: number, wd: number) => number;
  read: (fd: number, buf: Pointer, size: number) => number | bigint;
  buf: Uint8Array;
  bufPtr: Pointer;
}

/** `undefined` until first asked for; `null` where inotify cannot be reached. */
let inotify: Inotify | null | undefined;

/**
 * Listeners per watch descriptor. Two trees watching one directory — a project nested inside
 * another — are handed the same descriptor by the kernel, so the watch is removed only once the
 * last of them lets go. The wrapper object keeps each registration distinct.
 */
const listeners = new Map<number, Set<{ listener: DirEventListener }>>();
const overflowListeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Watches removed between two reads of the queue.
 *
 * Every `inotify_rm_watch` queues an IN_IGNORED, and a tree takes all of its watches down in one
 * synchronous loop, so closing more directories than `max_queued_events` (16,384 by default)
 * overflowed the queue by itself. The rebuild that answers an overflow takes the tree's watches
 * down first, so a watched tree that size overflowed it again on every rebuild, for as long as
 * it stayed open: 1.6 overflows a second and a third of a core on 20,000 directories. Reading as
 * the watches go keeps the queue short. What is read waits in `pending` for the next drain, so
 * no listener runs inside a `close()`.
 */
const READ_EVERY_REMOVALS = 1024;
let removedSinceRead = 0;

/**
 * Read and not yet delivered. `kind: null` marks the kernel dropping a watch, kept in sequence so
 * what came before it is still delivered.
 */
const pending: { wd: number; kind: DirEventKind | null; name: string }[] = [];
const pendingKeys = new Set<string>();
let pendingOverflow = false;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function open(): Inotify | null {
  if (inotify !== undefined) return inotify;
  inotify = null;
  if (process.platform !== "linux") return null;
  try {
    const { symbols } = dlopen("libc.so.6", {
      inotify_init1: { args: [FFIType.i32], returns: FFIType.i32 },
      inotify_add_watch: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      inotify_rm_watch: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    });
    const fd = symbols.inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (fd < 0) return null; // out of inotify instances: the caller falls back to fs.watch
    const buf = new Uint8Array(READ_BUFFER_BYTES);
    inotify = {
      fd,
      addWatch: (f, path, mask) => symbols.inotify_add_watch(f, ptr(path), mask),
      rmWatch: symbols.inotify_rm_watch,
      read: symbols.read,
      buf,
      bufPtr: ptr(buf),
    };
  } catch {
    // No glibc (a musl build): the caller falls back to fs.watch.
  }
  return inotify;
}

/** Whether `watchDirectory` can be used on this host. */
export function inotifyAvailable(): boolean {
  return open() !== null;
}

/**
 * Watch one directory's entries — not its subdirectories' — and report each change by entry
 * name. Null when the directory cannot be watched (gone, not a directory, a symlink, or the
 * machine's watch limit is spent), which is where `fs.watch` would have thrown.
 */
export function watchDirectory(dir: string, listener: DirEventListener): DirWatch | null {
  const lib = open();
  if (!lib) return null;
  const wd = lib.addWatch(lib.fd, encoder.encode(`${dir}\0`), WATCH_MASK);
  if (wd < 0) return null;
  const registrations = listeners.get(wd) ?? new Set();
  listeners.set(wd, registrations);
  const registration = { listener };
  registrations.add(registration);
  timer ??= setInterval(drain, POLL_MS);
  timer.unref?.();

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      // The set is gone when the kernel already dropped the watch — and its number may since
      // have been handed to another directory, which must not lose its watch.
      if (listeners.get(wd) === registrations && registrations.delete(registration) && registrations.size === 0) {
        listeners.delete(wd);
        lib.rmWatch(lib.fd, wd);
        if (++removedSinceRead >= READ_EVERY_REMOVALS) readQueue(lib);
      }
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Called when the kernel's event queue overflowed (`max_queued_events`) and events were lost,
 * so a watcher has to rebuild what it covers rather than trust it.
 */
export function onInotifyOverflow(listener: () => void): () => void {
  overflowListeners.add(listener);
  return () => { overflowListeners.delete(listener); };
}

/** Move everything queued into `pending`, one entry per distinct event, in the order they happened. */
function readQueue(lib: Inotify): void {
  removedSinceRead = 0;
  for (;;) {
    // -1 with EAGAIN when nothing is queued; any other failure is retried on the next tick.
    const n = Number(lib.read(lib.fd, lib.bufPtr, READ_BUFFER_BYTES));
    if (n <= 0) break;
    const view = new DataView(lib.buf.buffer, 0, n);
    for (let offset = 0; offset + EVENT_HEADER_BYTES <= n;) {
      const wd = view.getInt32(offset, true);
      const mask = view.getUint32(offset + 4, true);
      const nameBytes = view.getUint32(offset + 12, true);
      const raw = lib.buf.subarray(offset + EVENT_HEADER_BYTES, offset + EVENT_HEADER_BYTES + nameBytes);
      offset += EVENT_HEADER_BYTES + nameBytes;
      if (mask & IN_Q_OVERFLOW) {
        pendingOverflow = true;
        continue;
      }
      if (mask & IN_IGNORED) {
        pending.push({ wd, kind: null, name: "" });
        continue;
      }
      const end = raw.indexOf(0);
      const name = decoder.decode(end < 0 ? raw : raw.subarray(0, end));
      // Events about the watched directory itself carry no name; its parent reports those.
      if (!name) continue;
      const kind: DirEventKind = mask & RENAME_EVENTS ? "rename" : "change";
      // A file written in a thousand chunks is a thousand IN_MODIFY; one report does.
      const key = `${wd}\0${kind}\0${name}`;
      if (pendingKeys.has(key)) continue;
      pendingKeys.add(key);
      pending.push({ wd, kind, name });
    }
  }
}

/** Read everything queued, then report each distinct event once, in the order they happened. */
function drain(): void {
  const lib = inotify;
  if (!lib) return;
  readQueue(lib);
  const events = pending.splice(0);
  pendingKeys.clear();
  const overflowed = pendingOverflow;
  pendingOverflow = false;
  for (const { wd, kind, name } of events) {
    if (kind === null) {
      listeners.delete(wd);
      continue;
    }
    const registrations = listeners.get(wd);
    if (!registrations) continue;
    for (const { listener } of [...registrations]) {
      try { listener(kind, name); }
      catch (e) { console.error(`[file-watcher] listener failed: ${(e as Error).message}`); }
    }
  }
  if (overflowed) {
    console.warn("[file-watcher] inotify queue overflowed, rebuilding coverage");
    for (const listener of [...overflowListeners]) listener();
  }
}
