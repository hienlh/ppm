/**
 * The desktop status bar on a tablet. It spans only the editor area, so the sidebar decides its
 * width, not the device: a ~1030px iPad window with the sidebar open leaves it ~626px, short of
 * the ~760px its items want. Squeezed, it failed three ways at once, measured in Chromium:
 * "CPU 9%" and "MEM 32.5G" each wrapped onto two lines (33px tall in a 26px bar), the left group
 * painted its dock toggle over MEM, and the update chip was cut off at the screen edge.
 *
 * This used to be `readFileSync` on three component files plus a regex that guessed which `<div>`
 * a marker sat inside. That guess is the fragile part — rewrapping `<GitStatus />` in a fragment
 * moves the assertion onto a different element with no test failing — and it passes just as well
 * against a component that never renders.
 *
 * So the bar is mounted, the stores are seeded, and one SSE frame is delivered to give CPU/MEM
 * something to say. The assertions are still on *classes*: bun:test has no layout engine and the
 * Tailwind stylesheet is not loaded, so nothing here measures a pixel or resolves an `@container`
 * query. What the render buys is that the class is on the element that actually carries the
 * content, after `cn()` and every conditional have run.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, mount, eventSources, emitServerEvent, type Mounted } from "../../helpers/react-dom.tsx";
import type { MetricsSnapshot } from "../../../src/types/system-metrics";

installDom();
// The DOM is process-wide; hand it back so the next file in this batch is not given one.
afterAll(uninstallDom);
// Latched at module load by `upgrade-button.tsx`, so it has to be set before the import below.
sessionStorage.setItem("ppm-upgrade-test", "9.9.9");

const { StatusBar } = await import("../../../src/web/components/layout/status-bar.tsx");
const { useProjectStore } = await import("../../../src/web/stores/project-store.ts");
const { useGitStatusStore } = await import("../../../src/web/stores/git-status-store.ts");

const snapshot: MetricsSnapshot = {
  ts: Date.now(),
  platform: "linux",
  tier: "light",
  intervalMs: 2000,
  system: {
    // The two numbers that wrapped. 32.5G is the exact string from the report.
    cpu: { total: 9, cores: [9], model: "test" },
    mem: { totalMB: 64000, usedMB: 33280, availableMB: 30720, percent: 52 },
    disk: { inBps: 0, outBps: 0, available: false },
    net: { inBps: 0, outBps: 0, available: false },
    gpus: [],
    processCount: 0,
  },
  groups: [],
  processes: [],
  processColumns: { disk: false, gpu: false, net: false },
  total: { cpu: 9, ramMB: 33280, processCount: 0 },
  warnings: [],
};

type GitMeta = ReturnType<typeof useGitStatusStore.getState>["meta"] extends Map<string, infer V> ? V : never;

let view: Mounted | null = null;

function seedGit(meta: Partial<GitMeta>) {
  useProjectStore.setState({ activeProject: { name: "ppm", path: "/tmp/ppm" } as never });
  useGitStatusStore.setState({ meta: new Map([["ppm", meta as GitMeta]]) });
}

beforeEach(() => seedGit({ branch: "feat/branch-review", ahead: 2, behind: 1, tracking: "origin/main" }));
afterEach(async () => { await view?.unmount(); view = null; });

/** Mount the bar and feed it one metrics frame, so CPU/MEM are on screen. */
async function renderBar() {
  view = await mount(<StatusBar />);
  const stream = eventSources().at(-1);
  await emitServerEvent(stream, "snapshot", snapshot);
  const bar = view.container.firstElementChild;
  if (!bar) throw new Error("the status bar rendered nothing");
  return bar;
}

const classes = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/);
/** The element whose own text is `text`, ignoring the wrappers around it. */
const byText = (root: Element, text: string) =>
  [...root.querySelectorAll("*")].filter((e) => e.textContent?.includes(text)).at(-1) ?? null;

describe("status bar — narrow (tablet) layout", () => {
  it("shows CPU and MEM in a group that never shrinks, so they cannot wrap", async () => {
    // With `min-w-0` the group gave up width its items had no way to lose: the theme and update
    // chips hold their size, so all of it came out of CPU/MEM, which broke at its only spaces.
    const bar = await renderBar();
    const resources = bar.querySelector('[data-testid="status-bar-resources"]');
    expect(resources?.textContent).toContain("CPU 9%");
    expect(resources?.textContent).toContain("MEM 32.5G");

    const rightGroup = resources?.parentElement;
    expect(classes(rightGroup)).toContain("shrink-0");
    expect(classes(rightGroup)).not.toContain("min-w-0");
  });

  it("makes the left group the one that gives way, clipping rather than painting over the right", async () => {
    const bar = await renderBar();
    const dockToggle = bar.querySelector('[aria-label="Show panel"], [aria-label="Hide panel"]');
    const leftGroup = dockToggle?.parentElement;
    expect(classes(leftGroup)).toEqual(expect.arrayContaining(["min-w-0", "overflow-hidden"]));

    // The branch name is what yields first; a `shrink-0` wrapper kept its ellipsis from engaging.
    const branch = byText(bar, "feat/branch-review");
    expect(classes(branch)).toContain("truncate");
    const gitStatus = branch?.parentElement?.parentElement;
    expect(classes(gitStatus)).toContain("min-w-0");
    expect(classes(gitStatus)).not.toContain("shrink-0");
    expect(leftGroup?.contains(gitStatus ?? null)).toBe(true);
  });

  it("compacts on the bar's own width, which is what the `@max-*` variants resolve against", async () => {
    // With no `@container` ancestor a container query never matches, so every label below
    // would silently stay at full length.
    const bar = await renderBar();
    expect(classes(bar)).toContain("@container");

    const themeLabel = byText(bar, "Aurora");
    expect(classes(themeLabel)).toContain("@max-3xl:hidden");
    expect(classes(byText(bar, "New version"))).toContain("@max-3xl:hidden");
  });

  it("drops ahead/behind before the branch name has to give way", async () => {
    // Found by icon rather than by the count's text: `data-icon` is the hook the icon set
    // provides for exactly this, and "2" also occurs inside "MEM 32.5G".
    const bar = await renderBar();
    const counts = bar.querySelector('[data-icon="ArrowUp"]')?.closest("span")?.parentElement;
    expect(counts?.textContent).toBe("21");
    expect(classes(counts)).toContain("@max-xl:hidden");
    // Same slot, other state — they are mutually exclusive, so one render shows only one.
    expect(bar.querySelector('[data-icon="Check"]')).toBeNull();
  });

  it("drops the synced tick too, on a branch that has one", async () => {
    seedGit({ branch: "main", ahead: 0, behind: 0, tracking: "origin/main" });
    const bar = await renderBar();
    const synced = bar.querySelector('[data-icon="Check"]')?.parentElement;
    expect(synced?.textContent).toBe("synced");
    expect(classes(synced)).toContain("@max-xl:hidden");
    expect(bar.querySelector('[data-icon="ArrowUp"]')).toBeNull();
  });

  it("does not stop wrapping on the bar itself", async () => {
    // The update popover is a DOM child of the bar, not a portal: an inherited `nowrap` leaves
    // its release notes on single lines that its own `overflow-x-hidden` then cuts off.
    const bar = await renderBar();
    expect(classes(bar)).not.toContain("whitespace-nowrap");
  });
});
