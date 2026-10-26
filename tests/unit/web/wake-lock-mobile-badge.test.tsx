/**
 * The phone's "screen awake" marker used to be a pill fixed over the top of the page, covering
 * the header of whatever panel was open for as long as a turn ran. It now sits in the bottom
 * nav's own row, in the flow.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { WakeLockMobileBadge } = await import("../../../src/web/components/layout/wake-lock-indicator");
const { useWakeLockStore } = await import("../../../src/web/stores/wake-lock-store");

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  useWakeLockStore.setState({ active: false });
});

describe("WakeLockMobileBadge", () => {
  it("renders nothing while no lock is held", async () => {
    mounted = await mount(<WakeLockMobileBadge />);
    expect(mounted.container.innerHTML).toBe("");
  });

  it("is an in-flow item of the bar, never fixed over the page", async () => {
    mounted = await mount(<WakeLockMobileBadge />);
    await act(async () => { useWakeLockStore.setState({ active: true }); });
    const badge = mounted.container.querySelector('[data-slot="wake-lock-mobile"]')!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("aria-label")).toBe("Screen awake");
    expect(badge.className).not.toMatch(/\bfixed\b|\babsolute\b|\btop-0\b/);
  });

  it("is mounted in the bottom nav, not over the page from the app shell", () => {
    const web = resolve(import.meta.dir, "../../../src/web");
    expect(readFileSync(resolve(web, "components/layout/mobile-nav.tsx"), "utf8")).toContain("<WakeLockMobileBadge />");
    expect(readFileSync(resolve(web, "app.tsx"), "utf8")).not.toContain("WakeLockMobileBadge");
  });
});
