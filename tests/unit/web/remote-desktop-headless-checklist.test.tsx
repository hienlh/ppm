/**
 * The Windows rows of the Remote Desktop checklist, mounted: the unlock warning is drawn apart
 * from the detail, the "Bring session back" button calls the host and then says what happened,
 * and the buttons take the standard 28/26px text-button size rather than the old 44px. The safety
 * net asks nobody anything: a proven picture confirms it, and only a net that ran says so.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { act, useContext, useEffect } from "react";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
const { RemoteDesktopReadinessGate } = await import("../../../src/web/components/remote-desktop/remote-desktop-readiness-gate.tsx");
const { api } = await import("../../../src/web/lib/api-client");
const { describeHelper } = await import("../../../src/web/components/settings/remote-desktop-headless-helper.tsx");
const { windowsSessionRow } = await import("../../../src/services/remote-desktop/remote-desktop-win32-session-row.ts");
const { PictureProofContext } = await import("../../../src/web/components/remote-desktop/use-picture-proof.ts");

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

  it("centres the card with auto margins, so a tall checklist scrolls from its title", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(disconnectedCaps() as never));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const gate = view.container.querySelector('[data-testid="remote-desktop-readiness-gate"]')!;
    expect(gate.className).toContain("overflow-y-auto");
    expect(gate.className).not.toContain("items-center");
    expect(gate.className).not.toContain("justify-center");
    expect((gate.firstElementChild as HTMLElement).className).toContain("m-auto");
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

describe("the session row as the host writes it", () => {
  const DISCONNECTED = { sessionId: 2, state: "disconnected", isConsole: false } as const;
  function capsWith(helper: Parameters<typeof windowsSessionRow>[1]) {
    return { ...disconnectedCaps(), requirements: [windowsSessionRow(DISCONNECTED, helper)] };
  }

  it("helper set up: numbered steps, then the cost, then the safety note, then the button", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(capsWith({ usable: true, installed: true, virtualDisplay: true }) as never));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const row = view.container.querySelector('[data-testid="remote-desktop-requirement-win-session"]')!;
    const steps = row.querySelector('[data-testid="remote-desktop-requirement-win-session-steps"]');
    expect(steps?.tagName).toBe("OL");
    expect([...steps!.querySelectorAll("li")].map((li) => li.textContent)).toHaveLength(3);
    const safety = row.querySelector('[data-testid="remote-desktop-requirement-win-session-safety"]');
    expect(safety?.textContent).toContain("never turns the virtual display off");
    // Read top to bottom: what to do, what it costs, why it is safe, then the button itself.
    const order = [...row.querySelectorAll("[data-testid], button")].map((el) => el.getAttribute("data-testid") ?? "button");
    expect(order).toEqual([
      "remote-desktop-requirement-win-session-steps",
      "remote-desktop-requirement-win-session-warning",
      "remote-desktop-requirement-win-session-safety",
      "button",
    ]);
    const button = row.querySelector("button")!;
    expect(button.textContent).toContain("Bring session back");
    expect(button.className).toContain("h-7");
    expect(button.className).toContain("max-md:h-[26px]");
  });

  it("helper missing: the steps say where to set it up, and no empty button row is drawn", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(capsWith({ usable: false, installed: false }) as never));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const row = view.container.querySelector('[data-testid="remote-desktop-requirement-win-session"]')!;
    expect(row.querySelector("button")).toBeNull();
    expect(row.querySelector(".flex-wrap")).toBeNull();
    expect(row.querySelector('[data-testid="remote-desktop-requirement-win-session-steps"]')?.textContent)
      .toContain("administrator (UAC) prompt");
  });
});

describe("Windows' fallback screen in the checklist", () => {
  function fallbackCaps() {
    return {
      platform: "win32", platformSupported: true, videoReady: true, inputReady: true,
      requirements: [{
        id: "win-display", ok: false, gates: "choice", title: "Windows' fallback screen (1024x768)",
        detail: "No monitor is plugged into this PC.",
        actions: [
          { kind: "host", label: "Turn on virtual display (1920x1080)", action: "display-on" },
          { kind: "continue", label: "Continue at 1024x768" },
        ],
      }],
    };
  }

  it("stops before streaming although the host is ready, and 'Continue at 1024x768' goes on", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(fallbackCaps() as never));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div data-testid="viewer" /></RemoteDesktopReadinessGate>);
    await settle();
    expect(view.container.querySelector('[data-testid="viewer"]')).toBeNull();
    expect(view.container.textContent).toContain("choose one");
    // The row's own two buttons are the choice; no generic Continue beside them.
    expect(view.container.querySelector('[data-testid="remote-desktop-readiness-continue"]')).toBeNull();
    await click(view.container.querySelector('[data-testid="remote-desktop-requirement-win-display-continue"]'));
    await settle();
    expect(view.container.querySelector('[data-testid="viewer"]')).not.toBeNull();
  });

  it("'Turn on virtual display' asks the host, and both buttons take the standard size", async () => {
    spies.push(spyOn(api, "get").mockResolvedValue(fallbackCaps() as never));
    const post = spyOn(api, "post").mockResolvedValue({ ok: true, message: "The virtual display is on." } as never);
    spies.push(post);
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const buttons = [...view.container.querySelectorAll('[data-testid="remote-desktop-requirement-win-display"] button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Turn on virtual display (1920x1080)", "Continue at 1024x768"]);
    for (const b of buttons) {
      expect(b.className).toContain("h-7");
      expect(b.className).toContain("max-md:h-[26px]");
    }
    await click(buttons[0]!);
    await settle();
    expect(post).toHaveBeenCalledWith("/api/remote-desktop/requirements/win-display/display-on");
  });
});

describe("the safety net, confirmed by the picture", () => {
  const RESCUE_PATH = "/api/remote-desktop/headless-helper/rescue";
  const CONFIRM_PATH = "/api/remote-desktop/headless-helper/confirm";
  const deadline = Date.now() + 4 * 60_000;
  const ARMED = { action: "Reattach", armedMs: deadline - 300_000, deadlineMs: deadline };
  const ready = () => ({ ...disconnectedCaps(), videoReady: true, inputReady: true, requirements: [] });

  function routedGet(rescue: () => unknown) {
    return spyOn(api, "get").mockImplementation((async (path: string) => (path === RESCUE_PATH ? rescue() : ready())) as never);
  }

  /** Stands in for a viewer whose frames have kept coming for the proof window. */
  function ProvenViewer() {
    const report = useContext(PictureProofContext);
    useEffect(() => { report(true); }, [report]);
    return <div data-testid="viewer" />;
  }

  afterEach(() => { try { localStorage.clear(); } catch { /* no storage */ } });

  it("shows nothing and confirms nothing while there is no picture yet", async () => {
    spies.push(routedGet(() => ({ armed: ARMED, notice: null })));
    const post = spyOn(api, "post").mockResolvedValue({ ok: true, message: "" } as never);
    spies.push(post);
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div data-testid="viewer" /></RemoteDesktopReadinessGate>);
    await settle();
    expect(view.container.querySelector('[data-testid="viewer"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid^="remote-desktop-rescue"]')).toBeNull();
    expect(view.container.textContent).not.toContain("I can still reach this PC");
    expect(post).not.toHaveBeenCalled();
  });

  it("confirms by itself once the viewer has a proven picture, once per armed record", async () => {
    let rescue: unknown = { armed: ARMED, notice: null };
    spies.push(routedGet(() => rescue));
    const post = spyOn(api, "post").mockImplementation((async () => ({ ok: true, message: "Confirmed." })) as never);
    spies.push(post);
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><ProvenViewer /></RemoteDesktopReadinessGate>);
    await settle();
    await settle();
    expect(post).toHaveBeenCalledWith(CONFIRM_PATH);
    expect(post).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-testid^="remote-desktop-rescue"]')).toBeNull();
    rescue = { armed: null, notice: null };
  });

  it("does not confirm when nothing is armed", async () => {
    spies.push(routedGet(() => ({ armed: null, notice: null })));
    const post = spyOn(api, "post").mockResolvedValue({ ok: true, message: "" } as never);
    spies.push(post);
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><ProvenViewer /></RemoteDesktopReadinessGate>);
    await settle();
    expect(post).not.toHaveBeenCalled();
  });

  it("still confirms against a host that answers with the bare record (before the notice existed)", async () => {
    spies.push(routedGet(() => ARMED));
    const post = spyOn(api, "post").mockResolvedValue({ ok: true, message: "" } as never);
    spies.push(post);
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><ProvenViewer /></RemoteDesktopReadinessGate>);
    await settle();
    await settle();
    expect(post).toHaveBeenCalledWith(CONFIRM_PATH);
  });

  it("says in one line when the net turned the virtual display on, and OK hides it for good", async () => {
    const notice = { at: "2026-11-27T08:00:00.000Z", outcome: "display-on" };
    spies.push(routedGet(() => ({ armed: null, notice })));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    const bar = view.container.querySelector('[data-testid="remote-desktop-rescue-notice"]');
    expect(bar?.textContent).toContain("PPM turned the virtual display on because nobody could see this PC for 5 minutes.");
    const ok = view.container.querySelector('[data-testid="remote-desktop-rescue-notice-dismiss"]') as HTMLElement;
    expect(ok.className).toContain("h-7");
    expect(ok.className).toContain("max-md:h-[26px]");
    expect(ok.className).not.toContain("min-h-11");
    await click(ok);
    await settle();
    expect(view.container.querySelector('[data-testid="remote-desktop-rescue-notice"]')).toBeNull();
    await view.unmount();
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    expect(view.container.querySelector('[data-testid="remote-desktop-rescue-notice"]')).toBeNull();
  });

  it("names a missing driver plainly", async () => {
    spies.push(routedGet(() => ({ armed: null, notice: { at: "2026-11-27T08:00:00.000Z", outcome: "no-driver" } })));
    view = await mount(<RemoteDesktopReadinessGate onCancel={() => {}}><div /></RemoteDesktopReadinessGate>);
    await settle();
    expect(view.container.querySelector('[data-testid="remote-desktop-rescue-notice"]')?.textContent)
      .toContain("no virtual display to turn on");
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
    expect(describeHelper({ ...base, installed: true, outdated: true, tooOld: true })).toContain("will not use it");
    // A v2 helper: still used, the update only suggested.
    const v2 = describeHelper({ ...base, installed: true, usable: true, outdated: true, tooOld: false });
    expect(v2).toContain("Set up.");
    expect(v2).toContain("optional");
    expect(describeHelper({ ...base, job: { kind: "install", state: "running", message: null } })).toContain("administrator prompt");
  });
});
