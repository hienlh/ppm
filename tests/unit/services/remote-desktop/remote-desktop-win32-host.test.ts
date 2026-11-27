import { describe, expect, it } from "bun:test";
import { connectStateName } from "../../../../src/services/remote-desktop/remote-desktop-win32-session.ts";
import {
  snapshotWindowsHost, UNLOCK_WARNING, windowsHostRequirements, WIN_DISPLAY_ID, WIN_SESSION_ID, type WindowsHostApi,
} from "../../../../src/services/remote-desktop/remote-desktop-win32-host.ts";
import { remoteDesktopReadiness } from "../../../../src/services/remote-desktop/remote-desktop-requirements.ts";
import { explainCaptureFailure, SESSION_DISCONNECTED_MESSAGE } from "../../../../src/services/remote-desktop/remote-desktop-capture-error.ts";
import type { RemoteDisplay } from "../../../../src/services/remote-desktop/remote-desktop-displays.ts";

const MONITOR: RemoteDisplay = {
  id: "\\\\.\\DISPLAY1", label: "Display 1", primary: true, x: 0, y: 0, width: 1920, height: 1080, captureIndex: 0,
};

/** A fake Windows host: the session and monitors are whatever the test says, and reading the
 *  monitor list is counted so the "do not trust a disconnected session's monitors" rule shows. */
function fakeHost(session: ReturnType<WindowsHostApi["session"]>, displays: RemoteDisplay[], helperUsable = false) {
  let displayReads = 0;
  let monitorQueries = 0;
  const host: WindowsHostApi = {
    session: () => session,
    displays: () => { displayReads++; return displays; },
    helper: async () => ({ usable: helperUsable }),
    virtualDisplayAttached: () => false,
    hardwareMonitors: async () => { monitorQueries++; return 1; },
  };
  return { host, reads: () => displayReads, monitorQueries: () => monitorQueries };
}

/** What a headless Windows 11 host showed right after its session was brought to the console
 *  with the virtual display off: one stand-in screen from the GPU and no Monitor device. */
const FALLBACK: RemoteDisplay = {
  id: "\\\\.\\DISPLAY1", label: "Display 1", primary: true, x: 0, y: 0, width: 1024, height: 768, captureIndex: 0,
};
const AT_CONSOLE = { sessionId: 2, state: "active", isConsole: true } as const;

function fallbackHost(over: Partial<WindowsHostApi> = {}) {
  const fake = fakeHost(AT_CONSOLE, [FALLBACK], true);
  fake.host.helper = async () => ({ usable: true, virtualDisplay: true });
  fake.host.hardwareMonitors = async () => 0;
  Object.assign(fake.host, over);
  return fake;
}

describe("Windows' fallback screen", () => {
  it("stops the checklist to ask: a better display, or carry on at the fallback's size", async () => {
    const rows = windowsHostRequirements(await snapshotWindowsHost(fallbackHost().host));
    const row = rows.find((r) => r.id === WIN_DISPLAY_ID)!;
    expect(row.ok).toBe(false);
    expect(row.gates).toBe("choice");
    expect(row.title).toBe("Windows' fallback screen (1024x768)");
    expect(row.actions).toEqual([
      { kind: "host", label: "Turn on virtual display (1920x1080)", action: "display-on" },
      { kind: "continue", label: "Continue at 1024x768" },
    ]);
  });

  it("does not stop video: the stream works at the fallback's size", async () => {
    const r = await remoteDesktopReadiness("win32", null, fallbackHost().host);
    expect(r.requirements.find((x) => x.id === WIN_DISPLAY_ID)?.gates).toBe("choice");
    expect(r.videoReady).toBe(r.requirements.filter((x) => x.gates === "video").every((x) => x.ok));
  });

  it("is not the fallback when the PC has a monitor of its own, the virtual display is already on, or it cannot tell", async () => {
    for (const over of [
      { hardwareMonitors: async () => 1 },
      { hardwareMonitors: async () => null },
      { virtualDisplayAttached: () => true },
      { helper: async () => ({ usable: true, virtualDisplay: false }) },
      { session: () => ({ sessionId: 2, state: "active" as const, isConsole: false }) },
    ]) {
      const rows = windowsHostRequirements(await snapshotWindowsHost(fallbackHost(over as Partial<WindowsHostApi>).host));
      expect(rows.find((r) => r.id === WIN_DISPLAY_ID)?.gates).not.toBe("choice");
    }
  });

  it("does not start the PowerShell monitor query when a cheap check already rules it out", async () => {
    const fake = fakeHost({ sessionId: 2, state: "active", isConsole: false }, [MONITOR], true);
    await snapshotWindowsHost(fake.host);
    expect(fake.monitorQueries()).toBe(0);
    const attached = fallbackHost({ virtualDisplayAttached: () => true });
    let queried = 0;
    attached.host.hardwareMonitors = async () => { queried++; return 0; };
    await snapshotWindowsHost(attached.host);
    expect(queried).toBe(0);
  });
});

describe("windowsHostRequirements with the headless helper", () => {
  it("offers to bring the session back, and says the PC will be left unlocked", async () => {
    const { host } = fakeHost({ sessionId: 2, state: "disconnected", isConsole: false }, [], true);
    const row = windowsHostRequirements(await snapshotWindowsHost(host))[0]!;
    expect(row.actions).toEqual([{ kind: "host", label: "Bring session back", action: "reattach" }]);
    expect(row.warning).toBe(UNLOCK_WARNING);
    expect(row.warning).toContain("unlocked");
  });

  it("offers the virtual display when the helper has it and no monitor is there", async () => {
    const { host } = fakeHost({ sessionId: 1, state: "active", isConsole: true }, [], true);
    host.helper = async () => ({ usable: true, virtualDisplay: true });
    const row = windowsHostRequirements(await snapshotWindowsHost(host)).find((r) => r.id === WIN_DISPLAY_ID)!;
    expect(row.actions).toEqual([{ kind: "host", label: "Turn on virtual display", action: "display-on" }]);
    expect(row.detail).toContain("turns it off again when the session ends");
  });

  it("without the helper there is no button, only the way to set it up", async () => {
    const { host } = fakeHost({ sessionId: 2, state: "disconnected", isConsole: false }, [], false);
    const row = windowsHostRequirements(await snapshotWindowsHost(host))[0]!;
    expect(row.actions).toEqual([]);
    expect(row.warning).toBeUndefined();
    expect(row.steps?.[0]).toContain("Settings → Remote Desktop");
  });

  it("passes the helper's whole status to the row, so a v2 helper still gets the button", async () => {
    const { host } = fakeHost({ sessionId: 2, state: "disconnected", isConsole: false }, [], true);
    host.helper = async () => ({ usable: true, installed: true, outdated: true, tooOld: false, virtualDisplay: true });
    const row = windowsHostRequirements(await snapshotWindowsHost(host))[0]!;
    expect(row.actions).toEqual([{ kind: "host", label: "Bring session back", action: "reattach" }]);
    expect(row.safety).toContain("optional");
  });
});

describe("connectStateName", () => {
  it("maps WTS_CONNECTSTATE_CLASS in enum order", async () => {
    expect(connectStateName(0)).toBe("active");
    expect(connectStateName(1)).toBe("connected");
    expect(connectStateName(4)).toBe("disconnected");
    expect(connectStateName(9)).toBe("init");
  });

  it("refuses anything outside the enum", async () => {
    expect(connectStateName(10)).toBeNull();
    expect(connectStateName(-1)).toBeNull();
    expect(connectStateName(1.5)).toBeNull();
  });
});

describe("windowsHostRequirements", () => {
  it("an active session with a monitor passes both rows", async () => {
    const { host } = fakeHost({ sessionId: 1, state: "active", isConsole: true }, [MONITOR]);
    const rows = windowsHostRequirements(await snapshotWindowsHost(host));
    expect(rows.map((r) => [r.id, r.ok])).toEqual([[WIN_SESSION_ID, true], [WIN_DISPLAY_ID, true]]);
    expect(rows.every((r) => r.gates === "video")).toBe(true);
  });

  it("an RDP-connected session counts as on screen", async () => {
    const { host } = fakeHost({ sessionId: 2, state: "active", isConsole: false }, [MONITOR]);
    expect(windowsHostRequirements(await snapshotWindowsHost(host))[0]!.ok).toBe(true);
  });

  it("an active session with no monitor fails only the display row", async () => {
    const { host } = fakeHost({ sessionId: 1, state: "active", isConsole: true }, []);
    const rows = windowsHostRequirements(await snapshotWindowsHost(host));
    expect(rows.find((r) => r.id === WIN_SESSION_ID)!.ok).toBe(true);
    const display = rows.find((r) => r.id === WIN_DISPLAY_ID)!;
    expect(display.ok).toBe(false);
    expect(display.detail).toContain("dummy plug");
  });

  it("a disconnected session shows only the session row and never reads its monitors", async () => {
    const { host, reads } = fakeHost({ sessionId: 2, state: "disconnected", isConsole: false }, [MONITOR]);
    const rows = windowsHostRequirements(await snapshotWindowsHost(host));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: WIN_SESSION_ID, ok: false });
    expect(rows[0]!.detail).toContain("#2");
    expect(rows[0]!.detail).toContain("Remote Desktop (RDP)");
    expect(reads()).toBe(0);
  });

  it("no session information means no rows rather than a guess", async () => {
    const { host } = fakeHost(null, []);
    expect(windowsHostRequirements(await snapshotWindowsHost(host))).toEqual([]);
  });
});

describe("remoteDesktopReadiness on win32", () => {
  it("a disconnected session blocks video", async () => {
    const { host } = fakeHost({ sessionId: 2, state: "disconnected", isConsole: false }, []);
    const r = await remoteDesktopReadiness("win32", null, host);
    expect(r.platformSupported).toBe(true);
    expect(r.requirements.find((x) => x.id === WIN_SESSION_ID)?.ok).toBe(false);
    expect(r.videoReady).toBe(false);
  });

  it("no display blocks video", async () => {
    const { host } = fakeHost({ sessionId: 1, state: "active", isConsole: true }, []);
    const r = await remoteDesktopReadiness("win32", null, host);
    expect(r.requirements.find((x) => x.id === WIN_DISPLAY_ID)?.ok).toBe(false);
    expect(r.videoReady).toBe(false);
  });

  it("other platforms never get the Windows rows", async () => {
    const { host } = fakeHost({ sessionId: 2, state: "disconnected", isConsole: false }, []);
    const r = await remoteDesktopReadiness("linux", { kind: "x11", display: ":0", xauthority: null }, host);
    expect(r.requirements.some((x) => x.id.startsWith("win-"))).toBe(false);
  });
});

describe("explainCaptureFailure", () => {
  it("names a disconnected or locked session for gdigrab error 5, keeping the raw text", async () => {
    const raw = "[gdigrab @ 0000021b] Failed to capture image (error 5) | Output file does not contain any stream";
    const msg = explainCaptureFailure("win32", raw);
    expect(msg).toContain("disconnected");
    expect(msg).toContain("locked");
    expect(msg).toContain(raw);
  });

  it("names a missing display when DXGI has no output", async () => {
    const msg = explainCaptureFailure("win32", "[Parsed_ddagrab_0 @ 0000] Failed to enumerate DXGI output 0");
    expect(msg).toContain("no display");
  });

  it("leaves other failures and other platforms as they were", async () => {
    expect(explainCaptureFailure("win32", "boom")).toBe("Capture failed: boom");
    expect(explainCaptureFailure("linux", "Failed to capture image (error 5)")).toBe("Capture failed: Failed to capture image (error 5)");
  });

  it("says the session is disconnected when Windows says so, whatever ffmpeg wrote", () => {
    // The 27/11 failure: the phone's RDP app closed, then gdigrab reported only the missing stream.
    const raw = "[out#0/h264 @ 000001] Output file does not contain any stream";
    const msg = explainCaptureFailure("win32", raw, { sessionId: 2, state: "disconnected", isConsole: false });
    expect(msg.startsWith(SESSION_DISCONNECTED_MESSAGE)).toBe(true);
    expect(msg).toContain("Bring session back");
    expect(msg).toContain(raw);
    expect(explainCaptureFailure("win32", "boom", { sessionId: 2, state: "disconnected", isConsole: false }))
      .toContain("disconnected");
  });

  it("maps a missing output stream without session state, and ignores an active session", () => {
    const raw = "[out#0/h264 @ 000001] Output file does not contain any stream";
    expect(explainCaptureFailure("win32", raw)).toContain("Windows refused the screen capture");
    expect(explainCaptureFailure("win32", raw, { sessionId: 1, state: "active", isConsole: true }))
      .toContain("Windows refused the screen capture");
    expect(explainCaptureFailure("win32", "boom", { sessionId: 1, state: "active", isConsole: true })).toBe("Capture failed: boom");
  });

  it("never reads Windows session state off Windows", () => {
    expect(explainCaptureFailure("linux", "boom", { sessionId: 2, state: "disconnected", isConsole: false }))
      .toBe("Capture failed: boom");
  });
});
