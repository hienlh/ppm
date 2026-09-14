/**
 * The review tree is the one surface in this feature that is a *list of small
 * rows*, and it is used on a phone through a bottom sheet.
 *
 * Measured in a real browser at 390x844 before this was pinned: each row came
 * out **24px** tall with a **16px** checkbox, against the 44x44 minimum in
 * `docs/design-guidelines.md`. Nothing about that is visible in review — the
 * rows look right on a desktop, which is where the classes were written.
 *
 * These used to read the component's source back with `readFileSync` and match
 * strings in it, which passes just as well against a component that never
 * renders and breaks on a `cn()` refactor that changes nothing a user sees.
 * `TreeRow` is its own module now, so the assertions are against a mounted row.
 *
 * They still assert *classes* rather than pixels: happy-dom does no layout and
 * the app's Tailwind stylesheet is not loaded, so `getBoundingClientRect` is
 * zero everywhere. What the render buys is that the element exists, carries the
 * class after `cn()` has run, and responds to a real click.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { installDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();

const { TreeRow } = await import("../../../src/web/components/branch-review/branch-review-tree-row.tsx");
const { buildTree, compactTree } = await import("../../../src/web/lib/git-file-tree.ts");
type BranchDiffFile = import("../../../src/types/git").BranchDiffFile;

const file = (path: string, over: Partial<BranchDiffFile> = {}): BranchDiffFile => ({
  path, status: "M", additions: 3, deletions: 1, binary: false, blob: `blob-${path}`, ...over,
});

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

interface RenderOpts {
  files?: BranchDiffFile[];
  reviewed?: Record<string, string>;
  selectedPath?: string | null;
  collapsed?: Set<string>;
  onSelect?: (p: string) => void;
  onToggleReviewed?: (f: BranchDiffFile) => void;
  onToggleCollapse?: (p: string) => void;
}

async function render(opts: RenderOpts = {}) {
  const files = opts.files ?? [file("src/app.ts")];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const tree = compactTree(buildTree(files.map((f) => ({ path: f.path, status: f.status }))));
  view = await mount(
    <>
      {tree.map((node) => (
        <TreeRow
          key={node.fullPath}
          node={node}
          depth={0}
          byPath={byPath}
          reviewed={opts.reviewed ?? {}}
          selectedPath={opts.selectedPath ?? null}
          collapsed={opts.collapsed ?? new Set()}
          onToggleCollapse={opts.onToggleCollapse ?? (() => {})}
          onSelect={opts.onSelect ?? (() => {})}
          onToggleReviewed={opts.onToggleReviewed ?? (() => {})}
        />
      ))}
    </>,
  );
  return view.container;
}

const cls = (el: Element | null) => el?.getAttribute("class") ?? "";

describe("branch review touch targets", () => {
  it("gives a file row a 44px minimum height on touch and lifts it on desktop", async () => {
    // A 44px row on a 60-file branch would cost most of the pane's height, so
    // the floor is raised again above the `md` breakpoint.
    const c = await render();
    const row = c.querySelector('[data-testid="branch-review-file"]');
    expect(row).toBeTruthy();
    expect(cls(row)).toContain("min-h-11");
    expect(cls(row)).toContain("md:min-h-0");
  });

  it("gives the reviewed checkbox a 44px tap area while drawing it at 16px", async () => {
    // The tap area may not be what is drawn: a 44px filled box beside a 12px
    // filename is not the design, it is a bug of the opposite kind.
    const c = await render();
    const button = c.querySelector('[data-testid="branch-review-check"]');
    expect(cls(button)).toContain("size-11");
    expect(cls(button)).toContain("md:size-4");
    expect(cls(c.querySelector('[data-testid="branch-review-check-box"]'))).toContain("size-4");
  });

  it("reviews the file when the checkbox is tapped, and does not select it", async () => {
    // Missing the checkbox is worse than missing an ordinary control: without
    // `stopPropagation` the tap falls through to the row and *selects* the
    // file, which is the opposite action.
    const selected: string[] = [];
    const toggled: string[] = [];
    const c = await render({
      onSelect: (p) => selected.push(p),
      onToggleReviewed: (f) => toggled.push(f.path),
    });
    await click(c.querySelector('[data-testid="branch-review-check"]'));
    expect(toggled).toEqual(["src/app.ts"]);
    expect(selected).toEqual([]);
  });

  it("selects the file when the row itself is tapped", async () => {
    const selected: string[] = [];
    const c = await render({ onSelect: (p) => selected.push(p) });
    await click(c.querySelector('[data-testid="branch-review-file"]'));
    expect(selected).toEqual(["src/app.ts"]);
  });

  it("makes a folder row reachable too, since it is the way into a subtree", async () => {
    const opened: string[] = [];
    const c = await render({
      files: [file("src/a/one.ts"), file("src/b/two.ts")],
      onToggleCollapse: (p) => opened.push(p),
    });
    const folder = c.querySelector('[data-testid="branch-review-folder"]');
    expect(cls(folder)).toContain("min-h-11");
    expect(cls(folder)).toContain("md:min-h-0");
    await click(folder);
    expect(opened).toHaveLength(1);
  });

  it("marks the selected row with something other than the hover colour", async () => {
    // `bg-surface-hover` is also every row's hover state, so using it for
    // selection makes every row under the cursor look like the open file — and
    // leaves nothing to read the selection from at all.
    const c = await render({ selectedPath: "src/app.ts" });
    const row = c.querySelector('[data-testid="branch-review-file"]');
    expect(cls(row)).toContain("bg-primary/10");
    expect(row?.getAttribute("aria-current")).toBe("true");
    expect(row?.getAttribute("data-selected")).toBe("true");
  });

  it("says in the label which way the checkbox will go", async () => {
    const unchecked = await render();
    expect(unchecked.querySelector('[data-testid="branch-review-check"]')
      ?.getAttribute("aria-label")).toBe("Mark src/app.ts reviewed");
    await view?.unmount(); view = null;

    const checked = await render({ reviewed: { "src/app.ts": "blob-src/app.ts" } });
    expect(checked.querySelector('[data-testid="branch-review-check"]')
      ?.getAttribute("aria-label")).toBe("Mark src/app.ts unreviewed");
    expect(checked.querySelector('[data-testid="branch-review-file"]')
      ?.getAttribute("data-reviewed")).toBe("true");
  });
});
