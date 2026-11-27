/**
 * The "Windows is ignoring input" bar: what the host's `inputBlocked` message turns into, that it
 * goes away when the host says input gets through again, and its dismiss button's size.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
const {
  RemoteDesktopInputBlockedBar, inputBlockedText, parseInputBlocked,
} = await import("../../../src/web/components/remote-desktop/remote-desktop-input-blocked-bar.tsx");

let view: Mounted | undefined;
afterEach(async () => { await view?.unmount(); view = undefined; });

describe("parseInputBlocked", () => {
  it("reads the host's notice and treats anything else as not blocked", () => {
    expect(parseInputBlocked({ reason: "elevated-window", app: "wireguard.exe" })).toEqual({ app: "wireguard.exe" });
    expect(parseInputBlocked({ reason: "elevated-window", app: null })).toEqual({ app: null });
    expect(parseInputBlocked(null)).toBeNull();
    expect(parseInputBlocked({ reason: "desktop" })).toBeNull();
    expect(parseInputBlocked("blocked")).toBeNull();
  });

  it("names the app, or the window in front when the host could not read it", () => {
    expect(inputBlockedText("wireguard.exe")).toBe(
      "Windows is ignoring input: wireguard.exe runs as administrator. Bring another window to the front on the PC.");
    expect(inputBlockedText(null)).toContain("the window in front runs as administrator");
  });
});

describe("RemoteDesktopInputBlockedBar", () => {
  const bar = () => view!.container.querySelector('[data-testid="remote-desktop-input-blocked"]');

  it("shows while blocked and hides by itself once input gets through", async () => {
    let setBlocked!: (b: { app: string | null } | null) => void;
    const { useState } = await import("react");
    function Harness() {
      const [blocked, set] = useState<{ app: string | null } | null>({ app: "wireguard.exe" });
      setBlocked = set;
      return <RemoteDesktopInputBlockedBar blocked={blocked} />;
    }
    view = await mount(<Harness />);
    expect(bar()?.textContent).toContain("wireguard.exe runs as administrator");
    await act(async () => { setBlocked(null); });
    expect(bar()).toBeNull();
  });

  it("can be dismissed for this block, and shows again for the next one", async () => {
    let setBlocked!: (b: { app: string | null } | null) => void;
    const { useState } = await import("react");
    function Harness() {
      const [blocked, set] = useState<{ app: string | null } | null>({ app: "wireguard.exe" });
      setBlocked = set;
      return <RemoteDesktopInputBlockedBar blocked={blocked} />;
    }
    view = await mount(<Harness />);
    const dismiss = view.container.querySelector('[data-testid="remote-desktop-input-blocked-dismiss"]');
    // Design guidelines rule 3: an icon button is 24px on desktop, 22px on a phone.
    expect(dismiss?.className).toContain("h-6");
    expect(dismiss?.className).toContain("max-md:h-[22px]");
    await click(dismiss);
    expect(bar()).toBeNull();
    await act(async () => { setBlocked({ app: "regedit.exe" }); });
    expect(bar()?.textContent).toContain("regedit.exe");
    await act(async () => { setBlocked(null); });
    await act(async () => { setBlocked({ app: "regedit.exe" }); });
    expect(bar()).not.toBeNull();
  });
});
