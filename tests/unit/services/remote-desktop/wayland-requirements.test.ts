import { describe, expect, it } from "bun:test";
import { remoteDesktopReadiness } from "../../../../src/services/remote-desktop/remote-desktop-requirements.ts";
import type { LinuxSession } from "../../../../src/services/remote-desktop/remote-desktop-linux-session.ts";

const WAYLAND: LinuxSession = { kind: "wayland", display: "wayland-0", runtimeDir: "/run/user/1000" };
const X11: LinuxSession = { kind: "x11", display: ":0", xauthority: null };

describe("what a Wayland host is told it needs", () => {
  it("no longer blocks capture behind logging out into X11", async () => {
    const r = await remoteDesktopReadiness("linux", WAYLAND);
    // This row used to say "X11 session" and gate video unconditionally, which made Remote
    // Desktop unusable on every GNOME/KDE-Wayland host — the default on both for years.
    expect(r.requirements.some((x) => x.id === "linux-session")).toBe(false);
    expect(r.platformSupported).toBe(true);
  });

  it("names the GStreamer capture path as the thing that can be missing", async () => {
    const r = await remoteDesktopReadiness("linux", WAYLAND);
    const row = r.requirements.find((x) => x.id === "gst-pipewire");
    expect(row).toBeDefined();
    expect(row!.gates).toBe("video");
    // An unmet row is only useful if it says how to meet it — and it can name a package only on
    // a Linux host, where the checklist finds the package manager to name it for.
    if (!row!.ok && process.platform === "linux") expect(row!.actions.length).toBeGreaterThan(0);
  });

  it("still routes input through uinput, which Wayland has no protocol for", async () => {
    const r = await remoteDesktopReadiness("linux", WAYLAND);
    const row = r.requirements.find((x) => x.id === "uinput");
    expect(row?.gates).toBe("input");
  });

  it("leaves the X11 path exactly as it was", async () => {
    const r = await remoteDesktopReadiness("linux", X11);
    // X11 asks Xlib/XTEST and must not acquire GStreamer rows: ffmpeg's x11grab needs none.
    expect(r.requirements.some((x) => x.id === "gst-pipewire")).toBe(false);
    expect(r.requirements.some((x) => x.id === "gst-h264")).toBe(false);
    expect(r.requirements.some((x) => x.id === "xtest" || x.id === "xlib")).toBe(true);
  });
});
