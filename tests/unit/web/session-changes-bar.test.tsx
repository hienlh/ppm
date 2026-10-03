/**
 * The session changes bar above the composer: mounted, clicked, and checked on both
 * widths, because the wiring is where it can quietly do nothing — a row that opens no
 * review, a sheet whose Review button is not connected, a list that never asks for a
 * fresher answer.
 *
 * Classes rather than pixels for the touch targets: happy-dom does no layout and the
 * Tailwind stylesheet is not loaded (see branch-review-touch-targets.test.tsx).
 */
import { describe, it, expect, afterEach, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { SessionChangesBar } = await import("../../../src/web/components/chat/session-changes-bar.tsx");
const { useProjectStore } = await import("../../../src/web/stores/project-store.ts");
type SessionFileChange = import("../../../src/shared/session-file-changes").SessionFileChange;

const files: SessionFileChange[] = [
  { path: "/work/proj/src/app.ts", status: "modified", baseline: "session", additions: 3, deletions: 1, version: "1:1" },
  { path: "/work/proj/src/new.ts", status: "added", baseline: "session", additions: 1, deletions: 0, version: "1:2" },
];

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const cls = (el: Element | null) => el?.getAttribute("class") ?? "";
const byText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) ?? null;

async function render(props: Partial<Parameters<typeof SessionChangesBar>[0]> = {}) {
  const reviewed: (string | undefined)[] = [];
  const marks: [string[], boolean][] = [];
  let opened = 0;
  useProjectStore.setState({ projects: [{ name: "proj", path: "/work/proj" }] as never });
  view = await mount(
    <SessionChangesBar
      files={files}
      projectName="proj"
      onReview={(path) => reviewed.push(path)}
      onOpen={() => { opened++; }}
      onSetReviewed={(marked, value) => marks.push([marked.map((f) => f.path), value])}
      {...props}
    />,
  );
  return { container: view.container, reviewed, marks, opened: () => opened };
}

describe("session changes bar", () => {
  it("is absent while the session has changed nothing", async () => {
    const { container } = await render({ files: [] });
    expect(container.querySelector('[data-testid="session-changes-bar"]')).toBeNull();
  });

  it("sums the whole session and opens the review on its own button", async () => {
    const { container, reviewed } = await render();
    const bar = container.querySelector('[data-testid="session-changes-bar"]')!;
    expect(bar.textContent).toContain("2 files changed");
    expect(bar.textContent).toContain("+4");
    expect(bar.textContent).toContain("−1");
    await click(byText(container, "Review"));
    expect(reviewed).toEqual([undefined]);
  });

  describe("on a desktop", () => {
    it("lists the files inline once opened, asks for a fresh list, and opens a picked file", async () => {
      const { container, reviewed, opened } = await render();
      expect(container.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(0);
      await click(byText(container, "2 files changed"));
      expect(opened()).toBe(1);
      const rows = container.querySelectorAll('[data-testid="session-change-row"]');
      expect(rows).toHaveLength(2);
      // Project-relative, filename first.
      expect(rows[0]!.textContent).toContain("app.ts");
      expect(rows[0]!.textContent).toContain("src");
      expect(rows[0]!.textContent).not.toContain("/work/proj");
      expect(container.textContent).toContain("shell commands");
      await click(rows[1]!);
      expect(reviewed).toEqual(["/work/proj/src/new.ts"]);
    });

    it("marks one file from its checkbox and every file from the header", async () => {
      const { container, marks } = await render();
      await click(byText(container, "Mark all reviewed"));
      expect(marks).toEqual([[["/work/proj/src/app.ts", "/work/proj/src/new.ts"], true]]);
      await click(byText(container, "2 files changed"));
      const boxes = container.querySelectorAll('[role="checkbox"]');
      expect([...boxes].map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false"]);
      await click(boxes[1]!);
      expect(marks[1]).toEqual([["/work/proj/src/new.ts"], true]);
    });

    it("leaves a reviewed file out of the count and the list until asked, and unmarks it from there", async () => {
      const { container, marks } = await render({ files: [files[0]!, { ...files[1]!, reviewed: true }] });
      const bar = container.querySelector('[data-testid="session-changes-bar"]')!;
      expect(bar.textContent).toContain("1 file changed");
      expect(bar.textContent).toContain("+3");
      expect(bar.textContent).toContain("1 reviewed");
      await click(byText(container, "1 file changed"));
      expect(container.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(1);
      await click(byText(container, "Show"));
      const rows = container.querySelectorAll('[data-testid="session-change-item"]');
      expect(rows).toHaveLength(2);
      const box = rows[1]!.querySelector('[role="checkbox"]')!;
      expect(box.getAttribute("aria-checked")).toBe("true");
      await click(box);
      expect(marks).toEqual([[["/work/proj/src/new.ts"], false]]);
    });

    it("shrinks to one line once every file is reviewed, listing them when opened", async () => {
      const { container } = await render({ files: files.map((f) => ({ ...f, reviewed: true })) });
      const bar = container.querySelector('[data-testid="session-changes-bar"]')!;
      expect(bar.textContent).toContain("All 2 files reviewed");
      expect(byText(container, "Review")).toBeNull();
      expect(byText(container, "Mark all reviewed")).toBeNull();
      await click(byText(container, "All 2 files reviewed"));
      expect(container.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(2);
    });

    it("says what a Claude session's shell commands leave out, and that other agents' are not followed", async () => {
      const claude = await render({ providerId: "claude" });
      await click(byText(claude.container, "2 files changed"));
      expect(claude.container.textContent).toContain("Shell commands are followed through git");
      await view?.unmount();
      const codex = await render({ providerId: "codex" });
      await click(byText(codex.container, "2 files changed"));
      expect(codex.container.textContent).toContain("Files changed by shell commands are not listed");
    });
  });

  describe("on a phone", () => {
    const realWidth = window.innerWidth;
    beforeEach(() => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }));
    afterEach(() => Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }));

    it("gives both controls a 44px target", async () => {
      const { container } = await render();
      expect(cls(byText(container, "2 files changed"))).toContain("min-h-11");
      expect(cls(byText(container, "Review"))).toContain("min-h-11");
      // Marking everything is in the sheet's thumb zone, not squeezed into the bar.
      expect(byText(container, "Mark all reviewed")).toBeNull();
    });

    it("puts Mark all reviewed beside Review all, and gives each checkbox a 44px target", async () => {
      const { container, marks } = await render();
      await click(byText(container, "2 files changed"));
      const box = document.querySelector('[role="checkbox"]')!;
      expect(cls(box)).toContain("w-11");
      expect(cls(document.querySelector('[data-testid="session-change-row"]'))).toContain("min-h-[52px]");
      await click(byText(document, "Mark all reviewed"));
      expect(marks).toEqual([[["/work/proj/src/app.ts", "/work/proj/src/new.ts"], true]]);
      expect(document.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(0);
    });

    it("opens the list in a sheet whose bottom button reviews everything", async () => {
      const { container, reviewed } = await render();
      await click(byText(container, "2 files changed"));
      // The sheet is portalled out of the bar.
      const rows = document.querySelectorAll('[data-testid="session-change-row"]');
      expect(rows).toHaveLength(2);
      expect(cls(rows[0]!)).toContain("min-h-[52px]");
      await click(byText(document, "Review all 2 files"));
      expect(reviewed).toEqual([undefined]);
      expect(document.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(0);
    });
  });
});
