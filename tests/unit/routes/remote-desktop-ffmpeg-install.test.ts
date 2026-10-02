import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { remoteDesktopRoutes } from "../../../src/server/routes/remote-desktop.ts";
import { configService } from "../../../src/services/config.service.ts";
import { ffmpegInstaller } from "../../../src/services/remote-desktop/ffmpeg-install.ts";

const originalFlag = process.env.REMOTE_DESKTOP_ENABLED;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (originalFlag === undefined) delete process.env.REMOTE_DESKTOP_ENABLED;
  else process.env.REMOTE_DESKTOP_ENABLED = originalFlag;
});
const url = "http://localhost/requirements/ffmpeg/install";
function auth(enabled: boolean) {
  spies.push(spyOn(configService, "get").mockReturnValue({ enabled } as never));
  process.env.REMOTE_DESKTOP_ENABLED = "1";
}

describe("remote desktop FFmpeg install route", () => {
  it("rejects installation and status when auth is disabled", async () => {
    auth(false);
    const start = spyOn(ffmpegInstaller, "start"); spies.push(start);
    for (const method of ["POST", "GET"]) {
      expect((await remoteDesktopRoutes.request(url, { method })).status).toBe(403);
    }
    expect(start).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and disabled-feature requests before starting a job", async () => {
    auth(true);
    const start = spyOn(ffmpegInstaller, "start"); spies.push(start);
    expect((await remoteDesktopRoutes.request(url, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    process.env.REMOTE_DESKTOP_ENABLED = "0";
    expect((await remoteDesktopRoutes.request(url, { method: "POST" })).status).toBe(404);
    expect(start).not.toHaveBeenCalled();
  });
  it("returns the background job immediately and exposes status", async () => {
    auth(true);
    spies.push(spyOn(ffmpegInstaller, "start").mockReturnValue({ state: "installing" }));
    spies.push(spyOn(ffmpegInstaller, "getStatus").mockReturnValue({ state: "error", error: "WinGet unavailable" }));
    const res = await remoteDesktopRoutes.request(url, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ data: { state: "installing" } });
    const status = await remoteDesktopRoutes.request(url);
    expect(await status.json()).toMatchObject({ data: { state: "error", error: "WinGet unavailable" } });
  });
  it("returns unsupported-platform errors without falling through to the host-action route", async () => {
    auth(true);
    spies.push(spyOn(ffmpegInstaller, "start").mockImplementation(() => { throw new Error("Automatic FFmpeg installation is only supported on Windows."); }));
    const res = await remoteDesktopRoutes.request(url, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("only supported on Windows");
  });
});
