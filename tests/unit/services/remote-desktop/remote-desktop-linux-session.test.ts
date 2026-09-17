import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLinuxSession, linuxSessionEnv, resetLinuxSession,
} from "../../../../src/services/remote-desktop/remote-desktop-linux-session.ts";

/** Every case pins `env` so the result does not depend on whether the runner has a desktop. */
describe("detectLinuxSession", () => {
  it("reads an X11 session out of the environment", () => {
    expect(detectLinuxSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":1", XAUTHORITY: "/nope/x" }))
      .toMatchObject({ kind: "x11", display: ":1" });
  });

  it("reads a Wayland session out of the environment", () => {
    expect(detectLinuxSession({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/9" }))
      .toEqual({ kind: "wayland", display: "wayland-1", runtimeDir: "/run/user/9" });
  });

  it("prefers Wayland when BOTH are set — XWayland answers x11grab with the wrong picture", () => {
    // A Wayland session almost always runs XWayland too, which sets DISPLAY and captures only
    // XWayland clients: a black or half-empty screen rather than an error.
    const s = detectLinuxSession({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/9" });
    expect(s?.kind).toBe("wayland");
  });

  it("honours an explicit XDG_SESSION_TYPE=x11 even when a WAYLAND_DISPLAY is lying around", () => {
    const s = detectLinuxSession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" });
    expect(s).toMatchObject({ kind: "x11", display: ":0" });
  });

  it("drops an XAUTHORITY that does not exist rather than passing a dead path to ffmpeg", () => {
    const s = detectLinuxSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XAUTHORITY: "/definitely/not/here" });
    expect(s).toMatchObject({ kind: "x11" });
    if (s?.kind === "x11") expect(s.xauthority).not.toBe("/definitely/not/here");
  });
});

/**
 * The memo only engages for the ambient environment, so these drive `process.env` directly and
 * put it back afterwards. Time is stubbed rather than waited on: the point is which side of the
 * expiry a call falls on, not how long a test takes.
 */
describe("the memo for the ambient environment", () => {
  const SESSION_TTL_MS = 5_000; // mirrors the module
  const realNow = Date.now;
  const saved = { ...process.env };
  const emptyRuntimeDirs: string[] = [];

  afterEach(() => {
    Date.now = realNow;
    for (const key of ["DISPLAY", "XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY"]) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
    for (const dir of emptyRuntimeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    resetLinuxSession();
  });

  /**
   * No session, on any host.
   *
   * Deleting the variables is not enough: with none set, the probe falls through to the
   * filesystem — `/tmp/.X11-unix` and the runtime dir — and answers truthfully on a Linux
   * workstation, so these cases would be green here and red on the platform they are about.
   * Declaring `wayland` skips the X11 branch outright, and an empty runtime dir leaves the
   * Wayland branch nothing to find.
   */
  function pretendNoSession(): void {
    for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) delete process.env[key];
    process.env.XDG_SESSION_TYPE = "wayland";
    process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "ppm-rd-empty-"));
    emptyRuntimeDirs.push(process.env.XDG_RUNTIME_DIR);
  }

  it("reuses the answer within the window, so input does not re-probe the filesystem per event", () => {
    let now = 1_000_000;
    Date.now = () => now;
    pretendNoSession();
    resetLinuxSession();
    expect(detectLinuxSession()).toBeNull();

    // A session appears, but not enough time has passed for anyone to ask again.
    process.env.XDG_SESSION_TYPE = "x11";
    process.env.DISPLAY = ":7";
    now += SESSION_TTL_MS - 1;

    expect(detectLinuxSession()).toBeNull();
  });

  it("forgets a null, so a desktop that starts after PPM is still found", () => {
    // PPM can easily come up first — a boot-time systemd unit, an ssh start, a greeter. Caching
    // the null for the life of the process reported Remote Desktop unsupported on a host that
    // had a desktop by the time anyone asked, and nothing short of a restart fixed it.
    let now = 2_000_000;
    Date.now = () => now;
    pretendNoSession();
    resetLinuxSession();
    expect(detectLinuxSession()).toBeNull();

    process.env.XDG_SESSION_TYPE = "x11";
    process.env.DISPLAY = ":7";
    now += SESSION_TTL_MS;

    expect(detectLinuxSession()).toMatchObject({ kind: "x11", display: ":7" });
  });

  it("follows a session that changes kind, rather than routing input at a display that is gone", () => {
    let now = 3_000_000;
    Date.now = () => now;
    pretendNoSession();
    process.env.XDG_SESSION_TYPE = "x11";
    process.env.DISPLAY = ":7";
    resetLinuxSession();
    expect(detectLinuxSession()).toMatchObject({ kind: "x11" });

    delete process.env.DISPLAY;
    process.env.XDG_SESSION_TYPE = "wayland";
    process.env.WAYLAND_DISPLAY = "wayland-0";
    process.env.XDG_RUNTIME_DIR = "/run/user/9";
    now += SESSION_TTL_MS;

    expect(detectLinuxSession()).toMatchObject({ kind: "wayland", display: "wayland-0" });
  });
});

describe("linuxSessionEnv", () => {
  it("hands ffmpeg the X display, and the auth file only when there is one", () => {
    expect(linuxSessionEnv({ kind: "x11", display: ":3", xauthority: "/run/user/1/xauth_a" }))
      .toEqual({ DISPLAY: ":3", XAUTHORITY: "/run/user/1/xauth_a" });
    // An empty XAUTHORITY would override a working inherited one, so it is omitted instead.
    expect(linuxSessionEnv({ kind: "x11", display: ":3", xauthority: null })).toEqual({ DISPLAY: ":3" });
  });

  it("hands a Wayland child both the display and its runtime dir", () => {
    expect(linuxSessionEnv({ kind: "wayland", display: "wayland-0", runtimeDir: "/run/user/7" }))
      .toEqual({ WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/7" });
  });
});
