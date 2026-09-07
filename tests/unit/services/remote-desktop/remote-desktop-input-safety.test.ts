import { describe, it, expect } from "bun:test";
import { isInputAvailable, injectPointer, injectKey, injectWheel, RemoteInputUnavailableError } from "../../../../src/services/remote-desktop/remote-desktop-input.ts";

/**
 * This module must be importable — and its non-Windows-guarded functions must fail cleanly
 * rather than crash the process — on the Linux CI/Docker test runner (see
 * `docs/lessons-learned.md`: host Bun segfaults, tests run in `oven/bun`). `dlopen("user32.dll")`
 * must never be attempted here.
 */
describe("remote-desktop-input — non-Windows safety", () => {
  it("reports unavailable off Windows", () => {
    if (process.platform === "win32") return; // this guard only matters for Linux/macOS CI
    expect(isInputAvailable()).toBe(false);
  });

  it("rejects with RemoteInputUnavailableError instead of attempting dlopen off Windows", async () => {
    if (process.platform === "win32") return;
    await expect(injectPointer(0.5, 0.5, null, null)).rejects.toBeInstanceOf(RemoteInputUnavailableError);
    await expect(injectKey("KeyA", true)).rejects.toBeInstanceOf(RemoteInputUnavailableError);
  });

  it("rejects wheel injection off Windows too (a non-zero delta still reaches SendInput)", async () => {
    if (process.platform === "win32") return;
    await expect(injectWheel(120)).rejects.toBeInstanceOf(RemoteInputUnavailableError);
  });

  it("no-ops for a zero delta without touching SendInput at all", async () => {
    await expect(injectWheel(0)).resolves.toBeUndefined();
  });
});
