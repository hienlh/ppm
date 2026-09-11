import { describe, it, expect } from "bun:test";
import { remoteDesktopReadiness, runHostAction } from "../../../../src/services/remote-desktop/remote-desktop-requirements.ts";

/** Uses the real ffmpeg probe (cached after the first call) — assertions are about the checklist
 *  *shape* per platform, not about whether this runner has ffmpeg. macOS permission rows are
 *  only produced when the process really runs on darwin (they need the frameworks). */
describe("remoteDesktopReadiness", () => {
  it("unsupported platform: no requirements, nothing ready, entry hidden", async () => {
    const r = await remoteDesktopReadiness("freebsd");
    expect(r.platformSupported).toBe(false);
    expect(r.requirements).toEqual([]);
    expect(r.videoReady).toBe(false);
    expect(r.inputReady).toBe(false);
  });

  it("headless Linux is unsupported: there is no graphical session to capture", async () => {
    const r = await remoteDesktopReadiness("linux", null);
    expect(r.platformSupported).toBe(false);
    expect(r.requirements).toEqual([]);
    expect(r.inputReady).toBe(false);
  });

  it("a Wayland host keeps the entry and explains itself instead of being hidden", async () => {
    const r = await remoteDesktopReadiness("linux", { kind: "wayland", display: "wayland-0", runtimeDir: "/run/user/1000" });
    // Nothing about Linux is missing — one capture path is, and the user can pick X11 at login.
    expect(r.platformSupported).toBe(true);
    expect(r.videoReady).toBe(false);
    const session = r.requirements.find((x) => x.id === "linux-session")!;
    expect(session).toMatchObject({ ok: false, gates: "video" });
    // Input still works there, through uinput rather than XTEST.
    expect(r.requirements.find((x) => x.id === "uinput")).toMatchObject({ gates: "input" });
    expect(r.requirements.find((x) => x.id === "xtest")).toBeUndefined();
  });

  it("an X11 host is video-capable and checks XTEST rather than uinput", async () => {
    const r = await remoteDesktopReadiness("linux", { kind: "x11", display: ":0", xauthority: null });
    expect(r.platformSupported).toBe(true);
    expect(r.requirements.find((x) => x.id === "linux-session")).toMatchObject({ ok: true });
    expect(r.requirements.find((x) => x.id === "xtest")).toMatchObject({ gates: "input" });
    expect(r.requirements.find((x) => x.id === "uinput")).toBeUndefined();
  });

  it("reports clipboard support without ever gating the session on it", async () => {
    const r = await remoteDesktopReadiness("linux", { kind: "x11", display: ":0", xauthority: null });
    // Not a `requirements` row on purpose: that checklist is only rendered while video or input
    // is unmet, so a clipboard row would be invisible on exactly the hosts missing the tool.
    expect(r.requirements.some((x) => x.id === "clipboard")).toBe(false);
    expect(typeof r.clipboard.available).toBe("boolean");
    // And it must never drag `videoReady`/`inputReady` down — the viewer still has to open.
    const gated = r.requirements.map((x) => x.gates);
    expect(gated).not.toContain("clipboard");
  });

  it("a host with no clipboard tool still says how to get one", async () => {
    // Wayland without wl-clipboard is the case that has an install command on this runner.
    const r = await remoteDesktopReadiness("linux", { kind: "wayland", display: "wayland-0", runtimeDir: "/run/user/1000" });
    if (r.clipboard.available) return; // this host has wl-clipboard; nothing to explain
    if (process.platform !== "linux") return;
    expect(r.clipboard.action?.kind).toBe("terminal");
    if (r.clipboard.action?.kind === "terminal") {
      expect(r.clipboard.action.command).toContain("wl-clipboard");
    }
  });

  it("offers an install command for a package manager this host actually has", async () => {
    if (process.platform !== "linux") return;
    const r = await remoteDesktopReadiness("linux", { kind: "x11", display: ":0", xauthority: null });
    const ffmpeg = r.requirements.find((x) => x.id === "ffmpeg")!;
    const terminal = ffmpeg.actions.find((a) => a.kind === "terminal");
    // A command naming the wrong package manager is worse than none: the checklist offers to
    // type it straight into a real terminal on the host.
    if (terminal && terminal.kind === "terminal") {
      expect(terminal.command).toMatch(/^sudo (pacman|dnf|zypper|apt)/);
      expect(terminal.command.endsWith("ffmpeg")).toBe(true);
    }
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
