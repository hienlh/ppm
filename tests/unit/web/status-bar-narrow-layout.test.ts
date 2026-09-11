/**
 * The desktop status bar on a tablet. It spans only the editor area, so the sidebar decides its
 * width, not the device: a ~1030px iPad window with the sidebar open leaves it ~626px, short of
 * the ~760px its items want. Squeezed, it failed three ways at once, measured in Chromium:
 * "CPU 9%" and "MEM 32.5G" each wrapped onto two lines (33px tall in a 26px bar), the left group
 * painted its dock toggle over MEM, and the update chip was cut off at the screen edge. bun:test
 * has no layout engine, so the layout is pinned against the source the way
 * `remote-desktop-scale-layout.test.ts` pins its own.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "../../../src/web/components", path), "utf-8");
const statusBar = read("layout/status-bar.tsx");
const themePicker = read("settings/theme-picker.tsx");
const upgradeButton = read("layout/upgrade-button.tsx");

const classes = (className: string | undefined) => (className ?? "").split(/\s+/);

/** Class tokens of the nearest `<div className="…">` opened before `marker`. */
function divClassesBefore(marker: string): string[] {
  const at = statusBar.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = statusBar.lastIndexOf('<div className="', at) + '<div className="'.length;
  return classes(statusBar.slice(open, statusBar.indexOf('"', open)));
}

const bar = classes(statusBar.match(/className="([^"]*h-\[26px\][^"]*)"/)?.[1]);
const leftGroup = divClassesBefore("<GitStatus />");
const rightGroup = divClassesBefore("<ResourceStatusBar compact />");
const gitStatus = classes(statusBar.slice(statusBar.indexOf("const GitStatus")).match(/<span className="([^"]*)"/)?.[1]);

describe("status bar — narrow (tablet) layout", () => {
  it("never lets the right group shrink, so CPU/MEM cannot wrap", () => {
    // With `min-w-0` the group gave up width its items had no way to lose: the theme and update
    // chips hold their size, so all of it came out of CPU/MEM, which broke at its only spaces.
    expect(rightGroup).toContain("shrink-0");
    expect(rightGroup).not.toContain("min-w-0");
  });

  it("makes the left group the one that gives way, clipping rather than painting over the right", () => {
    expect(leftGroup).toEqual(expect.arrayContaining(["min-w-0", "overflow-hidden"]));
    // The branch name is what yields first; a `shrink-0` wrapper kept its ellipsis from engaging.
    expect(gitStatus).toContain("min-w-0");
    expect(gitStatus).not.toContain("shrink-0");
  });

  it("compacts on the bar's own width, which is what the `@max-*` variants resolve against", () => {
    // With no `@container` ancestor a container query never matches, so every label below
    // would silently stay at full length.
    expect(bar).toContain("@container");
    expect(themePicker).toMatch(/className="[^"]*@max-3xl:hidden[^"]*">\{active\.name\}/);
    expect(upgradeButton).toContain('<span className="@max-3xl:hidden">New version · </span>');
    // Ahead/behind and "synced" give way before the branch name has to.
    expect(statusBar.match(/@max-xl:hidden/g)).toHaveLength(2);
  });

  it("does not stop wrapping on the bar itself", () => {
    // The update popover is a DOM child of the bar, not a portal: an inherited `nowrap` leaves
    // its release notes on single lines that its own `overflow-x-hidden` then cuts off.
    expect(bar).not.toContain("whitespace-nowrap");
  });
});
