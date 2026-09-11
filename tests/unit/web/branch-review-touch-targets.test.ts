import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The review tree is the one surface in this feature that is a *list of small
 * rows*, and it is used on a phone through a bottom sheet.
 *
 * Measured in a real browser at 390x844 before this was pinned: each row came
 * out **24px** tall with a **16px** checkbox, against the 44x44 minimum in
 * `docs/design-guidelines.md`. Nothing about that is visible in review — the
 * rows look fine on a desktop, which is where the classes were written — so it
 * is asserted from the source rather than left to the next person to notice.
 *
 * Missing the checkbox is worse than missing an ordinary control: the tap falls
 * through to the row, which *selects* the file instead of marking it reviewed.
 */

const SOURCE = readFileSync(
  resolve(import.meta.dir, "../../../src/web/components/branch-review/branch-review-tab.tsx"),
  "utf8",
);

/** The JSX element that carries `data-testid="<id>"`, back to its `<`. */
function elementWith(testId: string): string {
  const marker = `data-testid="${testId}"`;
  const at = SOURCE.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = SOURCE.lastIndexOf("<", at);
  const close = SOURCE.indexOf(">", at);
  return SOURCE.slice(open, close);
}

describe("branch review touch targets", () => {
  it("gives a file row a 44px minimum height on touch", () => {
    expect(elementWith("branch-review-file")).toContain("min-h-11");
  });

  it("keeps desktop rows compact", () => {
    // A 44px row on a 60-file branch would cost most of the pane's height, so
    // the floor is lifted again above the `md` breakpoint.
    expect(elementWith("branch-review-file")).toContain("md:min-h-0");
  });

  it("gives the reviewed checkbox a 44px tap area", () => {
    const check = elementWith("branch-review-check");
    expect(check).toContain("size-11");
    expect(check).toContain("md:size-4");
  });

  it("draws the checkbox itself at 16px inside that tap area", () => {
    // The tap area may not be what is drawn: a 44px filled box beside a 12px
    // filename is not the design, it is a bug of the opposite kind.
    const after = SOURCE.slice(SOURCE.indexOf('data-testid="branch-review-check"'));
    const inner = after.slice(0, after.indexOf("</button>"));
    expect(inner).toMatch(/<span\s+className=\{`size-4 rounded border/);
  });

  it("makes a folder row reachable too, since it is the way into a subtree", () => {
    const folderRow = SOURCE.slice(SOURCE.indexOf("onClick={() => onToggleCollapse"));
    const className = SOURCE.slice(0, SOURCE.indexOf("onClick={() => onToggleCollapse"));
    expect(className + folderRow).toContain("min-h-11 md:min-h-0 hover:bg-surface-hover text-left");
  });

  it("marks the selected row with something other than the hover colour", () => {
    // `bg-surface-hover` is also every row's hover state, so using it for
    // selection makes every row under the cursor look like the open file — and
    // leaves nothing to read the selection from at all.
    const row = elementWith("branch-review-file");
    expect(row).toContain('data-selected=');
    expect(row).toContain("aria-current=");
    expect(row).toContain("bg-primary/10");
  });
});
