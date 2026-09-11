import { describe, it, expect } from "bun:test";
import {
  detectLinuxSession, linuxSessionEnv,
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
