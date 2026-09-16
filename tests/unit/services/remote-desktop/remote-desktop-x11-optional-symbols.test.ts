/**
 * `XSetIOErrorExitHandler` landed in libX11 1.7 (2021) and Ubuntu 20.04 ships 1.6.9, so the
 * question this file answers is what happens on a host that does not have it.
 *
 * `bun:ffi`'s `dlopen` throws on the **first** missing symbol and hands back none of the
 * others, so one optional function in the table every other call goes through takes the whole
 * X11 path down: no input, no privacy mode, no monitor enumeration — while capture keeps
 * working, because ffmpeg opens the display in its own process. The user gets a picture they
 * cannot click on.
 *
 * The fake library below is written as a set of *absences* so it does not restate the real
 * symbol tables: a soname resolves everything except what it is told to miss.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";

const realFfi = await import("bun:ffi");

type Call = { fn: string; args: unknown[] };
/** Calls made through the fake libraries during the current test. */
let calls: Call[] = [];
/** Every trampoline ever handed out, by address. Xlib keeps these for the process lifetime and
 *  so does the module under test, so this deliberately outlives a single test. */
const trampolines = new Map<number, { args: readonly string[]; returns: string }>();
let nextPtr = 1000;
/** soname → the symbols this host's copy of that library does *not* have. */
let host: Record<string, { missing?: string[] }> = {};

/** What each call answers. Anything unlisted returns 0, which is "no" for every predicate here. */
const RETURNS: Record<string, unknown> = {
  XOpenDisplay: 7,
  XDefaultRootWindow: 111,
  XTestQueryExtension: 1,
};

function fakeDlopen(name: string, symbols: Record<string, unknown>) {
  const lib = host[name];
  if (!lib) throw new Error(`dlopen: cannot open shared object file: ${name}`);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(symbols)) {
    // Verified against real bun:ffi by hienlh: the first missing symbol throws and the call
    // yields no symbols at all, rather than the table minus that one.
    if (lib.missing?.includes(key)) throw new Error(`Symbol "${key}" not found in "${name}"`);
    out[key] = (...args: unknown[]) => {
      calls.push({ fn: key, args });
      return RETURNS[key] ?? 0;
    };
  }
  return { symbols: out };
}

class FakeJSCallback {
  ptr: number;
  constructor(_fn: unknown, def: { args: readonly string[]; returns: string }) {
    this.ptr = nextPtr++;
    trampolines.set(this.ptr, def);
  }
}

mock.module("bun:ffi", () => ({
  dlopen: fakeDlopen,
  JSCallback: FakeJSCallback,
  ptr: () => 1,
}));

// Two instances of the same module, deliberately. The query string makes the loader hand back
// a *fresh* one, so the error handlers below are installed by the fake `JSCallback` in this
// file rather than by whichever suite in this process opened a real X connection first — they
// are installed once for the process lifetime, because Xlib keeps the trampoline addresses
// forever. `shared` is the instance `remote-desktop-requirements.ts` imports, and the checklist
// assertions need its cached connection cleared rather than this file's.
const { getX11, resetX11, X11_EXIT_SYMBOLS } = await import(
  "../../../../src/services/remote-desktop/remote-desktop-x11.ts?optional-symbols"
);
const shared = await import("../../../../src/services/remote-desktop/remote-desktop-x11.ts");
const { remoteDesktopReadiness } = await import(
  "../../../../src/services/remote-desktop/remote-desktop-requirements.ts"
);

const SESSION = { kind: "x11", display: ":0", xauthority: null } as const;
/** A modern host: every library present, every symbol resolvable. */
const MODERN = {
  "libX11.so.6": {},
  "libXtst.so.6": {},
  "libXrandr.so.2": {},
  "libXext.so.6": {},
};

beforeEach(() => {
  calls = [];
  resetX11();
  shared.resetX11();
  host = structuredClone(MODERN);
});

afterAll(() => {
  resetX11();
  shared.resetX11();
  mock.module("bun:ffi", () => realFfi);
});

const exitCalls = () => calls.filter((c) => c.fn === "XSetIOErrorExitHandler");

describe("the libX11 ≥ 1.7 exit handler is optional", () => {
  test("it is installed, with its own trampoline, where the symbol resolves", async () => {
    const conn = await getX11(SESSION);
    expect(conn).not.toBeNull();

    expect(exitCalls()).toHaveLength(1);
    const [dpy, handler, data] = exitCalls()[0]!.args;
    expect(dpy).toBe(7); // the Display, which is why this cannot be installed before connecting
    expect(data).toBeNull();

    // The address handed to Xlib has to be the void(Display*, void*) callback and no other:
    // the three were read out of an array by index, so a fourth handler would have shifted a
    // wrongly-shaped trampoline into this call with nothing to say so until it fired.
    expect(trampolines.get(handler as number)).toEqual({ args: ["ptr", "ptr"], returns: "void" });
    const ioHandler = calls.find((c) => c.fn === "XSetIOErrorHandler")?.args[0];
    expect(handler).not.toBe(ioHandler);
  });

  test("a host on libX11 1.6.9 keeps every other symbol — input included", async () => {
    host["libX11.so.6"] = { missing: ["XSetIOErrorExitHandler"] };

    const conn = await getX11(SESSION);

    // The whole point: one absent symbol used to mean `dlopen` threw for both sonames and this
    // was null, i.e. a host with a working desktop and no mouse.
    expect(conn).not.toBeNull();
    expect(conn!.hasXTest).toBe(true);
    expect(conn!.xrandr).not.toBeNull();
    expect(exitCalls()).toHaveLength(0);
  });

  test("it is its own table, so it cannot be loaded as part of the one that must succeed", () => {
    expect(Object.keys(X11_EXIT_SYMBOLS)).toEqual(["XSetIOErrorExitHandler"]);
  });
});

describe("the checklist names the library that is actually missing", () => {
  test("no libX11 at all is an Xlib row, not an XTEST row", async () => {
    host = {}; // nothing resolves: no Xlib, no XTEST, no XRandR

    const r = await remoteDesktopReadiness("linux", SESSION);
    const input = r.requirements.filter((x) => x.gates === "input");

    expect(input.map((x) => x.id)).toEqual(["xlib"]);
    expect(input[0]!.ok).toBe(false);
    // The old row offered `apt install libxtst6` here, which fixes nothing on this host.
    expect(JSON.stringify(input[0])).not.toContain("libxtst");
    expect(input[0]!.detail).toContain(":0");
  });

  test("a reachable X server with no XTEST extension is still an XTEST row", async () => {
    host["libXtst.so.6"] = { missing: ["XTestFakeKeyEvent"] };
    delete host["libXtst.so"];

    const r = await remoteDesktopReadiness("linux", SESSION);
    const input = r.requirements.filter((x) => x.gates === "input");

    expect(input.map((x) => x.id)).toEqual(["xtest"]);
    expect(input[0]!.ok).toBe(false);
  });
});
