import { describe, it, expect } from "bun:test";
import { isInputAvailable, injectPointer, injectKey, injectWheel, getInputBackend, RemoteInputUnavailableError } from "../../../../src/services/remote-desktop/remote-desktop-input.ts";

/**
 * This module must be importable — and its functions must fail cleanly rather than crash the
 * process — on a platform with no backend (the Linux CI/Docker test runner, see
 * `docs/lessons-learned.md`: host Bun segfaults, tests run in `oven/bun`). No `dlopen` of
 * `user32.dll` or a macOS framework must ever be attempted there.
 *
 * Every injecting case is gated to Linux ONLY: on Windows and macOS these calls reach the real
 * desktop (they would move the developer's mouse mid-test-run).
 */
const noBackend = process.platform !== "win32" && process.platform !== "darwin";

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
    expect(getInputBackend("linux")).toBeNull();
  });

  it("no-ops for a zero delta without touching SendInput at all", async () => {
    await expect(injectWheel(0)).resolves.toBeUndefined();
  });
});
