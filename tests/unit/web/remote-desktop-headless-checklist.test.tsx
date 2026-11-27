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

  it("a host that has not answered yet is 'not known', not a failure", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(disconnectedCaps() as never));
    spies.push(spyOn(api, "post").mockResolvedValue({ ok: false, pending: true, message: "The PC has not answered yet." } as never));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const button = [...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Bring session back"));
    await click(button ?? null);
    await settle();
    const line = view.container.querySelector('[data-result]');
    expect(line?.getAttribute("data-result")).toBe("pending");
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.className).not.toContain("text-red");
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

describe("the safety net bar", () => {
  const RESCUE_PATH = "/api/remote-desktop/headless-helper/rescue";
  const deadline = Date.now() + 4 * 60_000;

  function routedGet(armed: () => unknown, caps: unknown = disconnectedCaps()) {
    return spyOn(api, "get").mockImplementation((async (path: string) => (path === RESCUE_PATH ? armed() : caps)) as never);
  }

  it("asks for \"I can still reach this PC\" while the net is armed, and goes once confirmed", async () => {
    let armed: unknown = { action: "Reattach", armedMs: deadline - 300_000, deadlineMs: deadline };
    spies.push(routedGet(() => armed));
    const post = spyOn(api, "post").mockImplementation((async () => { armed = null; return { ok: true, message: "Confirmed." }; }) as never);
    spies.push(post);
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const bar = view.container.querySelector('[data-testid="remote-desktop-rescue-bar"]');
    expect(bar?.textContent).toContain("never signs you out");
    await click(view.container.querySelector('[data-testid="remote-desktop-rescue-confirm"]'));
    await settle();
    expect(post).toHaveBeenCalledWith("/api/remote-desktop/headless-helper/confirm");
    expect(view.container.querySelector('[data-testid="remote-desktop-rescue-bar"]')).toBeNull();
  });

  it("stays over the viewer once the host is ready, without replacing it", async () => {
    const ready = { ...disconnectedCaps(), videoReady: true, inputReady: true, requirements: [] };
    spies.push(routedGet(() => ({ action: "DisplayOn", armedMs: deadline - 300_000, deadlineMs: deadline }), ready));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div data-testid="viewer" /></RemoteDesktopReadinessGate>);
    await settle();
    expect(view.container.querySelector('[data-testid="viewer"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="remote-desktop-rescue-bar"]')).not.toBeNull();
  });

  it("shows nothing for a host that is not Windows or a record it cannot read", async () => {
    spies.push(routedGet(() => ({ action: "Reattach", deadlineMs: "soon" })));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    expect(view.container.querySelector('[data-testid="remote-desktop-rescue-bar"]')).toBeNull();
  });

  it("offers Dismiss for a record the safety net never took down, so the bar cannot stay for good", async () => {
    spies.push(routedGet(() => ({ action: "Reattach", armedMs: 0, deadlineMs: Date.now() - 4 * 60_000 })));
    const post = spyOn(api, "post").mockResolvedValue({ ok: true, message: "" } as never);
    spies.push(post);
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const button = view.container.querySelector('[data-testid="remote-desktop-rescue-confirm"]');
    expect(button?.textContent).toContain("Dismiss");
    await click(button);
    expect(post).toHaveBeenCalledWith("/api/remote-desktop/headless-helper/confirm");
  });

  it("says what is happening once the deadline has passed, with no button to press", async () => {
    spies.push(routedGet(() => ({ action: "Reattach", armedMs: 0, deadlineMs: Date.now() - 1000 })));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    expect(view.container.querySelector('[data-testid="remote-desktop-rescue-bar"]')?.textContent).toContain("Safety net is running");
    expect(view.container.querySelector('[data-testid="remote-desktop-rescue-confirm"]')).toBeNull();
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
