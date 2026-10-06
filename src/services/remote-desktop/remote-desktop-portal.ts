/**
 * An `org.freedesktop.portal.ScreenCast` session, spoken over libdbus through `bun:ffi`.
 *
 * This is the only way to capture a Wayland screen: there is no `x11grab` equivalent, and a
 * compositor will not hand pixels to anything that has not been through the portal. The portal
 * is D-Bus, and Bun has no D-Bus — hence FFI against `libdbus-1.so.3`, which is present on any
 * host running a desktop session (it is what the session bus itself is built on).
 *
 * Three things here are load-bearing and each was measured rather than reasoned about:
 *
 * 1. **`OpenPipeWireRemote` is deliberately never called.** The documented flow ends by asking
 *    the portal for a PipeWire file descriptor, and an fd cannot be passed to a *separate*
 *    process by any shell-out (`busctl`, `gdbus`) — which is what made this look impossible.
 *    It turns out not to be needed: the node the portal creates lives in the user's own
 *    PipeWire daemon, so `pipewiresrc path=<node>` reaches it through the ordinary
 *    `$XDG_RUNTIME_DIR/pipewire-0` socket. Measured: a plain `pipewiresrc path=N` negotiated
 *    `BGRA 1920x1080` with no fd anywhere in the pipeline.
 *
 * 2. **The connection must stay open for the node's whole life.** A portal session is owned by
 *    the D-Bus connection that created it; when that connection drops, the compositor tears the
 *    session down and the node disappears. So this returns a handle that owns the connection,
 *    and it must outlive the capture process — not be created per call and closed.
 *
 * 3. **`persist_mode: 2` + `restore_token`** is what stops the consent dialog appearing on the
 *    host's screen for every session. That matters more here than it would for a screen
 *    recorder: this is a *remote* desktop, so a prompt that only the person sitting at the
 *    machine can answer is a prompt nobody can answer. The first session still asks — there is
 *    no way around that, and there should not be — and every session after it restores
 *    silently. Verified: a second session went straight to a live node with no prompt.
 */
import { CString, dlopen, FFIType, ptr, suffix, type Pointer } from "bun:ffi";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("remote-desktop");

const BUS = "org.freedesktop.portal.Desktop";
const OBJ = "/org/freedesktop/portal/desktop";
const SCREENCAST = "org.freedesktop.portal.ScreenCast";
const REQUEST = "org.freedesktop.portal.Request";

// D-Bus type codes, as the ASCII of their signature characters.
const T_STRING = 115;   // 's'
const T_ARRAY = 97;     // 'a'
const T_VARIANT = 118;  // 'v'
const T_DICT_ENTRY = 101; // 'e'
const T_UINT32 = 117;   // 'u'
const T_BOOLEAN = 98;   // 'b'
const T_OBJECT_PATH = 111; // 'o'
const T_INVALID = 0;
const T_STRUCT = 114;   // 'r'

const DBUS_BUS_SESSION = 0;
/** `DBusMessageIter` is 72 bytes on x86-64; `DBusError` 32. Both are over-allocated rather than
 *  computed, because getting either too small corrupts the stack of the C library silently. */
const ITER_BYTES = 128;
const ERR_BYTES = 64;

/** Source types: 1 = MONITOR, 2 = WINDOW, 4 = VIRTUAL. Only whole monitors are asked for. */
const SOURCE_MONITOR = 1;
/** Cursor modes: 1 = HIDDEN, 2 = EMBEDDED (drawn into the frames), 4 = METADATA (sent apart).
 *  EMBEDDED is what `-draw_mouse` gives on the other platforms, so the two agree. */
const CURSOR_EMBEDDED = 2;
const CURSOR_HIDDEN = 1;
/** 2 = the permission persists until the user revokes it, which is what yields a restore token. */
const PERSIST_UNTIL_REVOKED = 2;

type Ptr = Pointer;

let lib: ReturnType<typeof openLibdbus> | null = null;
/** Anything whose address has been handed to C stays referenced here for the call's duration —
 *  a `Buffer` collected while libdbus still holds its pointer is a use-after-free, and Bun's GC
 *  has no idea the pointer escaped. */
let pinned: unknown[] = [];

function openLibdbus() {
  return dlopen(`libdbus-1.${suffix}.3`, {
    dbus_error_init: { args: [FFIType.ptr], returns: FFIType.void },
    dbus_error_is_set: { args: [FFIType.ptr], returns: FFIType.i32 },
    dbus_error_free: { args: [FFIType.ptr], returns: FFIType.void },
    dbus_bus_get_private: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    dbus_bus_get_unique_name: { args: [FFIType.ptr], returns: FFIType.cstring },
    dbus_bus_add_match: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    dbus_connection_close: { args: [FFIType.ptr], returns: FFIType.void },
    dbus_connection_unref: { args: [FFIType.ptr], returns: FFIType.void },
    dbus_connection_read_write: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    dbus_connection_pop_message: { args: [FFIType.ptr], returns: FFIType.ptr },
    dbus_connection_send_with_reply_and_block: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr,
    },
    dbus_message_new_method_call: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr,
    },
    dbus_message_unref: { args: [FFIType.ptr], returns: FFIType.void },
    dbus_message_is_signal: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    dbus_message_get_path: { args: [FFIType.ptr], returns: FFIType.cstring },
    dbus_message_iter_init: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    dbus_message_iter_init_append: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    dbus_message_iter_append_basic: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    dbus_message_iter_open_container: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32,
    },
    dbus_message_iter_close_container: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    dbus_message_iter_get_arg_type: { args: [FFIType.ptr], returns: FFIType.i32 },
    dbus_message_iter_recurse: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    dbus_message_iter_get_basic: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    dbus_message_iter_next: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
}

/** libdbus, or null on a host without it (no desktop session — there is nothing to capture
 *  there anyway, so this is reported as "unavailable", never thrown past the caller). */
function dbus() {
  if (lib) return lib.symbols;
  try {
    lib = openLibdbus();
  } catch {
    return null;
  }
  return lib.symbols;
}

const cstr = (s: string) => {
  const b = Buffer.from(s + "\0", "utf8");
  pinned.push(b);
  return ptr(b);
};

/** A pointer-sized cell holding the address of `value`, for the `void*` out/in params libdbus
 *  takes for every basic type. */
const cell = (value: Ptr) => {
  const b = new BigUint64Array([BigInt(value)]);
  pinned.push(b);
  return ptr(b);
};

const scratch = (bytes: number) => {
  const b = new Uint8Array(bytes);
  pinned.push(b);
  return b;
};

/** The variant types this client ever sends. */
type VariantValue =
  | { t: "s"; v: string }
  | { t: "u"; v: number }
  | { t: "b"; v: boolean };

/** Append `entries` to `iter` as an `a{sv}` — the options dictionary every portal method takes. */
function appendOptions(d: NonNullable<ReturnType<typeof dbus>>, iter: Uint8Array, entries: Record<string, VariantValue>) {
  const arr = scratch(ITER_BYTES);
  d.dbus_message_iter_open_container(ptr(iter), T_ARRAY, cstr("{sv}"), ptr(arr));
  for (const [key, val] of Object.entries(entries)) {
    const ent = scratch(ITER_BYTES);
    d.dbus_message_iter_open_container(ptr(arr), T_DICT_ENTRY, null as unknown as number, ptr(ent));
    d.dbus_message_iter_append_basic(ptr(ent), T_STRING, cell(cstr(key)));
    const varIter = scratch(ITER_BYTES);
    d.dbus_message_iter_open_container(ptr(ent), T_VARIANT, cstr(val.t), ptr(varIter));
    if (val.t === "s") {
      d.dbus_message_iter_append_basic(ptr(varIter), T_STRING, cell(cstr(val.v)));
    } else if (val.t === "u") {
      const n = new Uint32Array([val.v]);
      pinned.push(n);
      d.dbus_message_iter_append_basic(ptr(varIter), T_UINT32, ptr(n));
    } else {
      // D-Bus booleans marshal as uint32 0/1, not as a byte.
      const n = new Uint32Array([val.v ? 1 : 0]);
      pinned.push(n);
      d.dbus_message_iter_append_basic(ptr(varIter), T_BOOLEAN, ptr(n));
    }
    d.dbus_message_iter_close_container(ptr(ent), ptr(varIter));
    d.dbus_message_iter_close_container(ptr(arr), ptr(ent));
  }
  d.dbus_message_iter_close_container(ptr(iter), ptr(arr));
}

/** Read a basic value out of `iter` according to its own arg type. Returns null for anything
 *  this client does not need (nested containers other than the ones handled by the callers). */
function readBasic(d: NonNullable<ReturnType<typeof dbus>>, iter: Uint8Array): string | number | boolean | null {
  const t = d.dbus_message_iter_get_arg_type(ptr(iter));
  if (t === T_STRING || t === T_OBJECT_PATH) {
    const out = new BigUint64Array(1);
    d.dbus_message_iter_get_basic(ptr(iter), ptr(out));
    const addr = out[0];
    if (!addr) return null;
    return new CString(Number(addr) as Pointer).toString();
  }
  if (t === T_UINT32) {
    const out = new Uint32Array(1);
    d.dbus_message_iter_get_basic(ptr(iter), ptr(out));
    return out[0] ?? null;
  }
  if (t === T_BOOLEAN) {
    const out = new Uint32Array(1);
    d.dbus_message_iter_get_basic(ptr(iter), ptr(out));
    return out[0] === 1;
  }
  return null;
}

/** Walk an `a{sv}` at `iter` and return the keys `wanted` asks for, as raw iterators resolved
 *  by `read`. Keys not in `wanted` are skipped without being decoded. */
function readOptions<T>(
  d: NonNullable<ReturnType<typeof dbus>>,
  iter: Uint8Array,
  read: (key: string, value: Uint8Array) => void,
): void {
  if (d.dbus_message_iter_get_arg_type(ptr(iter)) !== T_ARRAY) return;
  const arr = scratch(ITER_BYTES);
  d.dbus_message_iter_recurse(ptr(iter), ptr(arr));
  while (d.dbus_message_iter_get_arg_type(ptr(arr)) === T_DICT_ENTRY) {
    const ent = scratch(ITER_BYTES);
    d.dbus_message_iter_recurse(ptr(arr), ptr(ent));
    const key = readBasic(d, ent);
    d.dbus_message_iter_next(ptr(ent));
    const varIter = scratch(ITER_BYTES);
    if (d.dbus_message_iter_get_arg_type(ptr(ent)) === T_VARIANT) {
      d.dbus_message_iter_recurse(ptr(ent), ptr(varIter));
      if (typeof key === "string") read(key, varIter);
    }
    d.dbus_message_iter_next(ptr(arr));
  }
}

/** Where the restore token is kept. `getPpmDir()` rather than `homedir()`: under a test
 *  `PPM_HOME` this must not read or write the user's real grant. */
function restoreTokenPath(): string {
  return resolve(getPpmDir(), "remote-desktop", "portal-restore-token");
}

function readRestoreToken(): string | null {
  try {
    const t = readFileSync(restoreTokenPath(), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** True when the token was written — for the log line only. */
function saveRestoreToken(token: string): boolean {
  try {
    const p = restoreTokenPath();
    mkdirSync(dirname(p), { recursive: true });
    // 0600: the token is a standing grant to capture this user's screen.
    writeFileSync(p, token, { mode: 0o600 });
    return true;
  } catch (e) {
    log.warn(`could not save the portal restore token: ${(e as Error).message}`);
    return false;
  }
}

/** Forget the stored grant, so the next session asks the user again. */
export function clearPortalRestoreToken(): void {
  try {
    writeFileSync(restoreTokenPath(), "", { mode: 0o600 });
  } catch {
    /* nothing stored yet */
  }
}

export interface PortalScreenCast {
  /** The PipeWire node to hand to `pipewiresrc path=`. */
  nodeId: number;
  width: number | null;
  height: number | null;
  /** Close the session and drop the connection. The node dies with it — call only once the
   *  capture process has exited, or GStreamer loses its source mid-stream. */
  stop(): void;
  isStopped(): boolean;
}

export class PortalUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PortalUnavailableError";
  }
}

export interface PortalOptions {
  /** Draw the host pointer into the frames, matching `-draw_mouse` elsewhere. */
  drawMouse?: boolean;
  /** How long to wait for the user to answer the consent dialog, first time round. */
  timeoutMs?: number;
}

/**
 * Open a ScreenCast session and return its PipeWire node.
 *
 * Rejects with `PortalUnavailableError` when there is no libdbus, no portal on the bus, or the
 * user dismissed the dialog — all three are ordinary states on a host that simply has not been
 * set up, so the caller reports them as an unmet requirement rather than a crash.
 */
export async function startPortalScreenCast(opts: PortalOptions = {}): Promise<PortalScreenCast> {
  const d = dbus();
  if (!d) throw new PortalUnavailableError("libdbus-1 is not installed on this host");

  const err = scratch(ERR_BYTES);
  d.dbus_error_init(ptr(err));
  // A *private* connection: a shared one is reference-counted process-wide, so closing it
  // could tear down a session belonging to another caller, and not closing it would leak the
  // portal session for the life of PPM.
  const conn = d.dbus_bus_get_private(DBUS_BUS_SESSION, ptr(err));
  if (!conn) throw new PortalUnavailableError("no D-Bus session bus (is a desktop session running?)");

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      d.dbus_connection_close(conn);
      d.dbus_connection_unref(conn);
    } catch { /* already gone */ }
  };

  try {
    const unique = String(d.dbus_bus_get_unique_name(conn) ?? "");
    if (!unique) throw new PortalUnavailableError("the D-Bus connection has no unique name");
    // ":1.234" -> "1_234", which is how the portal builds the Request object path.
    const sender = unique.replace(/^:/, "").replace(/\./g, "_");

    d.dbus_bus_add_match(conn, cstr(`type='signal',interface='${REQUEST}',member='Response'`), ptr(err));

    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    const call = (method: string, build: (iter: Uint8Array, handleToken: string) => void) =>
      portalCall(d, conn, sender, method, build, deadline);

    const created = call("CreateSession", (iter, handleToken) => {
      appendOptions(d, iter, {
        handle_token: { t: "s", v: handleToken },
        session_handle_token: { t: "s", v: `ppm${randomToken()}` },
      });
    });
    const session = stringField(await created, "session_handle");
    if (!session) throw new PortalUnavailableError("the portal returned no session handle");

    const restore = readRestoreToken();
    await call("SelectSources", (iter, handleToken) => {
      appendPath(d, iter, session);
      appendOptions(d, iter, {
        handle_token: { t: "s", v: handleToken },
        types: { t: "u", v: SOURCE_MONITOR },
        multiple: { t: "b", v: false },
        cursor_mode: { t: "u", v: opts.drawMouse === false ? CURSOR_HIDDEN : CURSOR_EMBEDDED },
        persist_mode: { t: "u", v: PERSIST_UNTIL_REVOKED },
        ...(restore ? { restore_token: { t: "s" as const, v: restore } } : {}),
      });
    });

    const started = await call("Start", (iter, handleToken) => {
      appendPath(d, iter, session);
      // parent_window: an X11/Wayland handle the portal would parent its dialog to. PPM has no
      // window on the host, so this is empty — the dialog appears unparented, which is correct.
      d.dbus_message_iter_append_basic(ptr(iter), T_STRING, cell(cstr("")));
      appendOptions(d, iter, { handle_token: { t: "s", v: handleToken } });
    });

    const token = stringField(started, "restore_token");
    const saved = token ? saveRestoreToken(token) : false;

    const stream = firstStream(started);
    if (!stream) {
      throw new PortalUnavailableError(
        "the portal granted no stream — the screen-share dialog was dismissed",
      );
    }
    // Whether a stored grant was offered says whether the host's user was likely asked on their
    // own screen. Never the token: it is a standing grant to capture this screen.
    log.info(
      `portal session opened node=${stream.nodeId} size=${stream.width ?? "?"}x${stream.height ?? "?"} stored-grant=${!!restore}`,
    );
    // The portal hands out a fresh token every session, so only the first one is news.
    if (saved) {
      if (restore) log.debug("portal grant refreshed");
      else log.info("portal grant saved");
    }

    return {
      nodeId: stream.nodeId,
      width: stream.width,
      height: stream.height,
      stop: close,
      isStopped: () => closed,
    };
  } catch (e) {
    close();
    throw e;
  } finally {
    pinned = [];
  }
}

/** A handle token unique to this process and call. Only has to be unique within our own
 *  sender name, which the portal already scopes the Request path by. */
function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function appendPath(d: NonNullable<ReturnType<typeof dbus>>, iter: Uint8Array, path: string): void {
  d.dbus_message_iter_append_basic(ptr(iter), T_OBJECT_PATH, cell(cstr(path)));
}

/**
 * Invoke one portal method and wait for its `Response` signal.
 *
 * Every ScreenCast method answers immediately with a Request object path and delivers the real
 * answer later as a signal on it — so the match rule has to be in place *before* the call, and
 * the path is derived from the `handle_token` we choose rather than read from the reply (the
 * portal spec documents that derivation precisely so a client can subscribe first; racing the
 * reply is how a fast portal's signal gets missed).
 */
async function portalCall(
  d: NonNullable<ReturnType<typeof dbus>>,
  conn: Ptr,
  sender: string,
  method: string,
  build: (iter: Uint8Array, handleToken: string) => void,
  deadline: number,
): Promise<Record<string, unknown>> {
  const token = `ppm${randomToken()}`;
  const wantPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;

  const msg = d.dbus_message_new_method_call(cstr(BUS), cstr(OBJ), cstr(SCREENCAST), cstr(method));
  if (!msg) throw new PortalUnavailableError(`could not build the ${method} call`);
  const iter = scratch(ITER_BYTES);
  d.dbus_message_iter_init_append(msg, ptr(iter));
  build(iter, token);
  // `build` receives the token and must put it in the options dict as `handle_token`: it has
  // to match the path subscribed above, or the Response is delivered somewhere nothing is
  // listening and the call hangs until the deadline. `session_handle_token` on CreateSession
  // is a *different* token naming the session, not the request.
  const err = scratch(ERR_BYTES);
  d.dbus_error_init(ptr(err));
  const reply = d.dbus_connection_send_with_reply_and_block(conn, msg, 25_000, ptr(err));
  d.dbus_message_unref(msg);
  if (!reply) throw new PortalUnavailableError(`${method} was refused by the portal`);
  d.dbus_message_unref(reply);

  for (;;) {
    if (Date.now() > deadline) {
      throw new PortalUnavailableError(
        `${method} timed out — the screen-share dialog on the host was not answered`,
      );
    }
    // 200 ms so a dismissed dialog still unblocks the loop promptly; this runs on the event
    // loop, and a long block here would stall the whole server.
    d.dbus_connection_read_write(conn, 200);
    for (;;) {
      const sig = d.dbus_connection_pop_message(conn);
      if (!sig) break;
      const isResponse = d.dbus_message_is_signal(sig, cstr(REQUEST), cstr("Response")) === 1;
      const path = isResponse ? String(d.dbus_message_get_path(sig) ?? "") : "";
      if (isResponse && path === wantPath) {
        const out = decodeResponse(d, sig);
        d.dbus_message_unref(sig);
        if (out.code !== 0) {
          throw new PortalUnavailableError(
            out.code === 1
              ? `${method} was cancelled on the host (the dialog was dismissed)`
              : `${method} failed with portal code ${out.code}`,
          );
        }
        return out.results;
      }
      d.dbus_message_unref(sig);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** A Response signal is `(u a{sv})`: a result code then the method's own fields. */
function decodeResponse(
  d: NonNullable<ReturnType<typeof dbus>>,
  msg: Ptr,
): { code: number; results: Record<string, unknown> } {
  const iter = scratch(ITER_BYTES);
  if (d.dbus_message_iter_init(msg, ptr(iter)) !== 1) return { code: -1, results: {} };
  const code = readBasic(d, iter);
  d.dbus_message_iter_next(ptr(iter));
  const results: Record<string, unknown> = {};
  readOptions(d, iter, (key, value) => {
    results[key] = key === "streams" ? decodeStreams(d, value) : readBasic(d, value);
  });
  return { code: typeof code === "number" ? code : -1, results };
}

/** `streams` is `a(ua{sv})` — one entry per shared monitor, each a node id plus properties.
 *  Only `size` is read out of the properties; `position` matters for a multi-monitor crop,
 *  which the portal does not offer (it shares whole outputs, already cropped). */
function decodeStreams(
  d: NonNullable<ReturnType<typeof dbus>>,
  iter: Uint8Array,
): Array<{ nodeId: number; width: number | null; height: number | null }> {
  const out: Array<{ nodeId: number; width: number | null; height: number | null }> = [];
  if (d.dbus_message_iter_get_arg_type(ptr(iter)) !== T_ARRAY) return out;
  const arr = scratch(ITER_BYTES);
  d.dbus_message_iter_recurse(ptr(iter), ptr(arr));
  while (d.dbus_message_iter_get_arg_type(ptr(arr)) === T_STRUCT) {
    const st = scratch(ITER_BYTES);
    d.dbus_message_iter_recurse(ptr(arr), ptr(st));
    const nodeId = readBasic(d, st);
    d.dbus_message_iter_next(ptr(st));
    let width: number | null = null;
    let height: number | null = null;
    readOptions(d, st, (key, value) => {
      if (key !== "size") return;
      // `size` is `(ii)`, a struct of two int32 — read through the same recurse.
      if (d.dbus_message_iter_get_arg_type(ptr(value)) !== T_STRUCT) return;
      const sz = scratch(ITER_BYTES);
      d.dbus_message_iter_recurse(ptr(value), ptr(sz));
      const w = new Int32Array(1);
      d.dbus_message_iter_get_basic(ptr(sz), ptr(w));
      d.dbus_message_iter_next(ptr(sz));
      const h = new Int32Array(1);
      d.dbus_message_iter_get_basic(ptr(sz), ptr(h));
      width = w[0] || null;
      height = h[0] || null;
    });
    if (typeof nodeId === "number") out.push({ nodeId, width, height });
    d.dbus_message_iter_next(ptr(arr));
  }
  return out;
}

function stringField(results: Record<string, unknown>, key: string): string | null {
  const v = results[key];
  return typeof v === "string" && v ? v : null;
}

function firstStream(
  results: Record<string, unknown>,
): { nodeId: number; width: number | null; height: number | null } | null {
  const streams = results.streams;
  if (!Array.isArray(streams) || streams.length === 0) return null;
  return streams[0] as { nodeId: number; width: number | null; height: number | null };
}

/** Is there a portal on this host at all? Used by the requirements checklist, which must be
 *  able to say "install xdg-desktop-portal" rather than failing at capture time. */
export function portalLibraryPresent(): boolean {
  return dbus() !== null;
}
