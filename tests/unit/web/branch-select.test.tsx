/**
 * The branch combobox, mounted — because the whole feature is the wiring.
 *
 * The thing it replaced worked by virtue of being a native control: the browser
 * opened it, filtered nothing, and reported the pick. Everything here is ours,
 * so the parts that can silently stop working are the ones asserted: the panel
 * opens, typing narrows the list, Enter takes the highlighted row rather than
 * the first one, and a pick reports the branch and closes.
 *
 * The panel is portalled, so it is queried off `document`, not off the mounted
 * container.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { installDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";
import type { GitBranch } from "../../../src/types/git.ts";

installDom();

const { BranchSelect } = await import("../../../src/web/components/branch-review/branch-select.tsx");

const b = (name: string, over: Partial<GitBranch> = {}): GitBranch => ({
  name, current: false, remote: false, commitHash: "abc1234", ahead: 0, behind: 0, remotes: [], ...over,
});

const branches = [
  b("master"),
  b("fix/NX-5175-ni-rounding-unification", { current: true }),
  b("fix/NX-5838-viewer-pass-protect"),
  b("remotes/origin/NX-5175", { remote: true }),
];

let picked: string[] = [];
let view: Mounted | null = null;

beforeEach(() => { picked = []; });
afterEach(async () => { await view?.unmount(); view = null; });

async function open(value = "master") {
  view = await mount(
    <BranchSelect
      value={value}
      branches={branches}
      onChange={(name) => picked.push(name)}
      label="Base branch"
      testId="pick"
    />,
  );
  await click(document.querySelector('[data-testid="pick"]'));
  return view;
}

const rowNames = () =>
  [...document.querySelectorAll<HTMLElement>("[data-branch]")].map((el) => el.dataset.branch);
const activeRow = () => document.querySelector<HTMLElement>('[data-active="true"]')?.dataset.branch;
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Search base branch"]');

/** Type into a controlled input the way React hears it. */
async function type(text: string) {
  const el = input();
  if (!el) throw new Error("the filter box is not open");
  const { act } = await import("react");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  const el = input();
  if (!el) throw new Error("the filter box is not open");
  const { act } = await import("react");
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("the branch select", () => {
  it("shows the current value on the trigger and opens a filter box", async () => {
    const v = await open("fix/NX-5175-ni-rounding-unification");
    expect(v.container.textContent).toContain("fix/NX-5175-ni-rounding-unification");
    expect(input()).not.toBeNull();
    expect(rowNames()).toEqual(branches.map((x) => x.name));
  });

  it("narrows the list as you type, ticket number included", async () => {
    await open();
    await type("5175");
    expect(rowNames()).toEqual(["fix/NX-5175-ni-rounding-unification", "remotes/origin/NX-5175"]);
  });

  it("says so when nothing matches, instead of showing an empty panel", async () => {
    await open();
    await type("nothing-is-named-this");
    expect(rowNames()).toEqual([]);
    expect(document.body.textContent).toContain("No matching branches");
  });

  it("opens on the branch in force, not on the top of the list", async () => {
    await open("fix/NX-5838-viewer-pass-protect");
    expect(activeRow()).toBe("fix/NX-5838-viewer-pass-protect");
  });

  it("takes the highlighted row on Enter, not the first one", async () => {
    await open();
    await press("ArrowDown");
    expect(activeRow()).toBe("fix/NX-5175-ni-rounding-unification");
    await press("Enter");
    expect(picked).toEqual(["fix/NX-5175-ni-rounding-unification"]);
  });

  it("reports a clicked branch and closes", async () => {
    await open();
    await click(document.querySelector('[data-branch="remotes/origin/NX-5175"]'));
    expect(picked).toEqual(["remotes/origin/NX-5175"]);
    expect(input()).toBeNull();
  });

  it("forgets the filter between openings", async () => {
    const v = await open();
    await type("5838");
    expect(rowNames()).toEqual(["fix/NX-5838-viewer-pass-protect"]);
    await press("Escape");
    await click(v.container.querySelector('[data-testid="pick"]'));
    expect(rowNames()).toEqual(branches.map((x) => x.name));
  });
});

describe("under a finger", () => {
  // `useIsMobile` reads `window.innerWidth`, so a phone is one property away.
  const realWidth = window.innerWidth;
  beforeEach(() => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }));
  afterEach(() => Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }));

  it("opens a sheet whose rows clear the 44px minimum", async () => {
    await open();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-branch]")];
    expect(rows.length).toBe(branches.length);
    // happy-dom lays nothing out, so the class is the measurement — same
    // compromise as branch-review-touch-targets.test.tsx.
    expect(rows.every((r) => r.className.includes("min-h-11"))).toBe(true);
    // A sheet and not the desktop popover: the panel is the one with the
    // rounded top and the drag handle above it.
    const panel = document.querySelector(".rounded-t-2xl");
    expect(panel).not.toBeNull();
    expect(panel?.contains(rows[0]!)).toBe(true);
    expect(document.querySelector("[data-radix-popper-content-wrapper]")).toBeNull();
  });

  it("still reports a pick", async () => {
    await open();
    await click(document.querySelector('[data-branch="master"]'));
    expect(picked).toEqual(["master"]);
  });
});
