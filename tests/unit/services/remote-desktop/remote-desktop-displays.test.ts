import { describe, it, expect } from "bun:test";
import { listDisplays, resolveDisplay } from "../../../../src/services/remote-desktop/remote-desktop-displays.ts";
import { captureInputForPlatform } from "../../../../src/services/remote-desktop/remote-desktop-capture-input.ts";

describe("remote-desktop-displays", () => {
  it("win32 exposes exactly one 'All displays' surface (gdigrab desktop + VIRTUALDESK input)", async () => {
    const d = await listDisplays("win32");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ id: "desktop", primary: true, captureIndex: 0 });
  });

  it("platforms without a grabber list nothing", async () => {
    expect(await listDisplays("linux")).toEqual([]);
  });

  it("darwin (when running there): one entry per active display, exactly one primary, capture index = list position", async () => {
    if (process.platform !== "darwin") return;
    const d = await listDisplays("darwin");
    expect(d.length).toBeGreaterThan(0);
    expect(d.filter((x) => x.primary)).toHaveLength(1);
    d.forEach((x, i) => {
      expect(x.captureIndex).toBe(i);
      expect(x.width).toBeGreaterThan(0);
      expect(captureInputForPlatform("darwin", x.captureIndex)).toEqual({ kind: "avfoundation", screen: `Capture screen ${i}` });
    });
  });

  it("resolveDisplay falls back to the primary for an unknown/unplugged id", async () => {
    const all = await listDisplays();
    const resolved = await resolveDisplay("no-such-display");
    if (all.length === 0) expect(resolved).toBeNull();
    else expect(resolved?.primary).toBe(true);
  });
});
