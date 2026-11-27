import { describe, expect, it } from "bun:test";
import {
  UNLOCK_WARNING, WIN_SESSION_ID, windowsSessionRow, type SessionRowHelper,
} from "../../../../src/services/remote-desktop/remote-desktop-win32-session-row.ts";

const DISCONNECTED = { sessionId: 2, state: "disconnected", isConsole: false } as const;
const BRING_BACK = { kind: "host", label: "Bring session back", action: "reattach" };

function row(helper: SessionRowHelper) {
  return windowsSessionRow(DISCONNECTED, helper);
}

describe("windowsSessionRow — helper usable", () => {
  const current: SessionRowHelper = { usable: true, installed: true, outdated: false, tooOld: false, virtualDisplay: true };

  it("gives the button, three steps in order, the cost and what protects the PC", () => {
    const r = row(current);
    expect(r).toMatchObject({ id: WIN_SESSION_ID, ok: false, gates: "video", title: "Windows session on screen" });
    expect(r.actions).toEqual([BRING_BACK]);
    expect(r.steps).toHaveLength(3);
    expect(r.steps![0]).toContain("Bring session back");
    expect(r.steps![1]).toContain("turns green by itself");
    expect(r.steps![2]).toContain("Continue");
    expect(r.warning).toBe(UNLOCK_WARNING);
  });

  it("says why it is safe: the 5-minute net, the virtual display never turned off as the only screen, no sign-out", () => {
    const safety = row(current).safety!;
    expect(safety).toContain("5 minutes");
    expect(safety).toContain("never turns the virtual display off while it is the PC's only screen");
    expect(safety).toContain("never signs you out");
    expect(safety).not.toContain("optional");
  });

  it("claims nothing about a virtual display the install does not have", () => {
    const safety = row({ ...current, virtualDisplay: false }).safety!;
    expect(safety).not.toContain("virtual display");
    expect(safety).toContain("never signs you out");
  });

  it("a v2 helper keeps the button and only suggests the update", () => {
    const r = row({ ...current, outdated: true });
    expect(r.actions).toEqual([BRING_BACK]);
    expect(r.safety).toContain("older version with the same safety rules");
    expect(r.safety).toContain("optional");
  });

  it("explains why there is no picture, in words a phone user knows", () => {
    expect(row(current).detail).toContain("Remote Desktop (RDP) app on another device was closed");
    expect(row(current).detail).toContain("#2");
  });
});

describe("windowsSessionRow — no usable helper", () => {
  it("not installed: no button; set it up once at the PC or over RDP, approving the UAC prompt", () => {
    const r = row({ usable: false, installed: false });
    expect(r.actions).toEqual([]);
    expect(r.warning).toBeUndefined();
    expect(r.safety).toBeUndefined();
    expect(r.steps).toHaveLength(3);
    expect(r.steps![0]).toContain("At the PC, or over Remote Desktop (RDP)");
    expect(r.steps![0]).toContain("press Set up");
    expect(r.steps![1]).toContain("administrator (UAC) prompt");
    expect(r.steps![2]).toContain("Bring session back");
  });

  it("says what works until then, and that closing RDP disconnects again", () => {
    const { detail } = row({ usable: false });
    expect(detail).toContain("TeamViewer");
    expect(detail).toContain("closing it disconnects the session again");
  });

  it("too old, another user's or damaged: says which, and asks for Reinstall", () => {
    const cases: [SessionRowHelper, string][] = [
      [{ usable: false, installed: true, tooOld: true }, "older PPM without the safety net"],
      [{ usable: false, installed: true, otherUser: true }, "another Windows user"],
      [{ usable: false, installed: true }, "damaged"],
    ];
    for (const [helper, reason] of cases) {
      const r = row(helper);
      expect(r.actions).toEqual([]);
      expect(r.detail).toContain(reason);
      expect(r.steps![0]).toContain("press Reinstall");
    }
  });
});

describe("windowsSessionRow — session on screen", () => {
  it("is met for an active session, whatever the helper", () => {
    expect(windowsSessionRow({ sessionId: 1, state: "active", isConsole: true }, { usable: false }).ok).toBe(true);
  });
});
