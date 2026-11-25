/**
 * The Windows rows of the Remote Desktop checklist, mounted: the unlock warning is drawn apart
 * from the detail, the "Bring session back" button calls the host and then says what happened,
 * and the buttons take the standard 28/26px text-button size rather than the old 44px.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
const { RemoteDesktopReadinessGate } = await import("../../../src/web/components/remote-desktop/remote-desktop-readiness-gate.tsx");
const { api } = await import("../../../src/web/lib/api-client");
const { describeHelper } = await import("../../../src/web/components/settings/remote-desktop-headless-helper.tsx");

const WARNING = "Bringing the session back signs it in at this PC's own screen and leaves it unlocked.";

function disconnectedCaps() {
  return {
    platform: "win32", platformSupported: true, videoReady: false, inputReady: true,
    requirements: [{
      id: "win-session", ok: false, gates: "video", title: "Windows session on screen",
      detail: "Your Windows session (#2) is disconnected.", warning: WARNING,
      actions: [{ kind: "host", label: "Bring session back", action: "reattach" }],
    }],
  };
}

let view: Mounted | undefined;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

describe("Windows checklist rows", () => {
  it("draws the unlock warning apart from the detail", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(disconnectedCaps() as never));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const warning = view.container.querySelector('[data-testid="remote-desktop-requirement-win-session-warning"]');
    expect(warning?.textContent).toContain("unlocked");
  });

  it("runs the host action and shows the helper's answer", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(disconnectedCaps() as never));
    const post = spyOn(api, "post").mockResolvedValue({ ok: true, message: "Session 2 is back on the PC screen." } as never);
    spies.push(post);
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const button = [...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Bring session back"));
    await click(button ?? null);
    await settle();
    expect(post).toHaveBeenCalledWith("/api/remote-desktop/requirements/win-session/reattach");
    expect(view.container.textContent).toContain("Session 2 is back on the PC screen.");
  });

  it("uses the standard text-button size, not a 44px minimum", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(disconnectedCaps() as never));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const buttons = [...view.container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) {
      expect(b.className).toContain("h-7");
      expect(b.className).toContain("max-md:h-[26px]");
      expect(b.className).not.toContain("min-h-11");
    }
  });
});

describe("headless helper status line", () => {
  const base = {
    supported: true, usable: false, installed: false, outdated: false, otherUser: false,
    virtualDisplay: false, lastRun: null, job: null,
  };
  it("says what the user can do next in each state", () => {
    expect(describeHelper(base)).toBe("Not set up.");
    expect(describeHelper({ ...base, installed: true, usable: true })).toContain("Set up.");
    expect(describeHelper({ ...base, installed: true, otherUser: true })).toContain("another Windows user");
    expect(describeHelper({ ...base, installed: true, outdated: true })).toContain("older PPM");
    expect(describeHelper({ ...base, job: { kind: "install", state: "running", message: null } })).toContain("administrator prompt");
  });
});
