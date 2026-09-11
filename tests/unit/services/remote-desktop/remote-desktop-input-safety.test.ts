import { describe, it, expect } from "bun:test";
import { isInputAvailable, injectPointer, injectKey, injectWheel, getInputBackend, RemoteInputUnavailableError } from "../../../../src/services/remote-desktop/remote-desktop-input.ts";

/**
 * This module must be importable — and its functions must fail cleanly rather than crash the
 * process — on a host with no backend (the Linux CI/Docker test runner, see
 * `docs/lessons-learned.md`: host Bun segfaults, tests run in `oven/bun`). No `dlopen` of
 * `user32.dll`, a macOS framework or libXtst must ever be attempted there.
 *
 * The gate asks the registry rather than testing `process.platform`, and that matters now that
 * Linux HAS backends: a developer's Linux desktop resolves an X11 session and these calls would
 * reach the real screen, moving their mouse mid-test-run. Only a host that genuinely has no
 * backend — a headless container, which is what CI is — runs the injecting cases.
 */
const noBackend = getInputBackend() === null;

describe("remote-desktop-input — no-backend platform safety", () => {
  it("reports unavailable where no backend is registered", () => {
    if (!noBackend) return;
    expect(isInputAvailable()).toBe(false);
  });

  it("rejects with RemoteInputUnavailableError instead of attempting dlopen", async () => {
    if (!noBackend) return;
    await expect(injectPointer(0.5, 0.5, null, null)).rejects.toBeInstanceOf(RemoteInputUnavailableError);
    await expect(injectKey("KeyA", true)).rejects.toBeInstanceOf(RemoteInputUnavailableError);
  });

  it("rejects wheel injection too (a non-zero delta still reaches the backend)", async () => {
    if (!noBackend) return;
    await expect(injectWheel(120)).rejects.toBeInstanceOf(RemoteInputUnavailableError);
  });

  it("registers exactly the platforms that have a backend", () => {
    expect(getInputBackend("win32")?.id).toBe("win32-sendinput");
    expect(getInputBackend("darwin")?.id).toBe("darwin-cgevent");
    expect(getInputBackend("freebsd")).toBeNull();
  });

  it("picks the Linux backend by session type, not by platform", () => {
    // XTEST is an X server extension, so Wayland has to go in as a virtual input device.
    expect(getInputBackend("linux", { kind: "x11", display: ":0", xauthority: null })?.id).toBe("linux-xtest");
    expect(getInputBackend("linux", { kind: "wayland", display: "wayland-0", runtimeDir: "/run/user/1000" })?.id)
      .toBe("linux-uinput");
    // No graphical session at all: a headless server, a CI container.
    expect(getInputBackend("linux", null)).toBeNull();
  });

  it("uinput has no text path, so the facade tells the caller to fall back to key events", () => {
    const wayland = getInputBackend("linux", { kind: "wayland", display: "wayland-0", runtimeDir: "/run/user/1000" });
    // uinput carries key codes, not characters — there is no KEYEVENTF_UNICODE equivalent.
    expect(wayland?.text).toBeUndefined();
    expect(getInputBackend("linux", { kind: "x11", display: ":0", xauthority: null })?.text).toBeDefined();
  });

  it("no-ops for a zero delta without touching SendInput at all", async () => {
    await expect(injectWheel(0)).resolves.toBeUndefined();
  });
});
