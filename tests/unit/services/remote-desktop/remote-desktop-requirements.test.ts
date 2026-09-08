import { describe, it, expect } from "bun:test";
import { remoteDesktopReadiness, runHostAction } from "../../../../src/services/remote-desktop/remote-desktop-requirements.ts";

/** Uses the real ffmpeg probe (cached after the first call) — assertions are about the checklist
 *  *shape* per platform, not about whether this runner has ffmpeg. macOS permission rows are
 *  only produced when the process really runs on darwin (they need the frameworks). */
describe("remoteDesktopReadiness", () => {
  it("unsupported platform: no requirements, nothing ready, entry hidden", async () => {
    const r = await remoteDesktopReadiness("linux");
    expect(r.platformSupported).toBe(false);
    expect(r.requirements).toEqual([]);
    expect(r.videoReady).toBe(false);
    expect(r.inputReady).toBe(false);
  });

  it("win32 checklist: ffmpeg with a winget terminal action and a client-side download link", async () => {
    const r = await remoteDesktopReadiness("win32");
    expect(r.platformSupported).toBe(true);
    const ffmpeg = r.requirements.find((x) => x.id === "ffmpeg")!;
    expect(ffmpeg.gates).toBe("video");
    expect(ffmpeg.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "terminal", command: expect.stringContaining("winget") }),
      expect.objectContaining({ kind: "link", url: expect.stringContaining("ffmpeg.org") }),
    ]));
    // videoReady tracks the ffmpeg row exactly
    expect(r.videoReady).toBe(ffmpeg.ok);
  });

  it("darwin (when running there): permission rows are host actions, never client URLs", async () => {
    if (process.platform !== "darwin") return;
    const r = await remoteDesktopReadiness("darwin");
    const ids = r.requirements.map((x) => x.id);
    expect(ids).toEqual(["ffmpeg", "screen-recording", "accessibility"]);
    for (const req of r.requirements.slice(1)) {
      for (const a of req.actions) expect(a.kind).toBe("host");
    }
    expect(r.requirements[1].gates).toBe("video");
    expect(r.requirements[2].gates).toBe("input");
  });

  it("runHostAction: unknown requirement → null (route answers 404)", async () => {
    expect(await runHostAction("ffmpeg", "request")).toBeNull();
    expect(await runHostAction("nope", "open-settings")).toBeNull();
  });
});
