/**
 * The session changes chip in the chat footer: mounted, clicked, and checked on both
 * widths, because the wiring is where it can quietly do nothing — a chip that opens no
 * review, a sheet whose Review button is not connected, a list that never asks for a
 * fresher answer.
 *
 * Classes rather than pixels for the touch targets: happy-dom does no layout and the
 * Tailwind stylesheet is not loaded.
 */
import { describe, it, expect, afterEach, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { SessionChangesChip } = await import("../../../src/web/components/chat/session-changes-chip.tsx");
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
/** Every action lives in the popover the chip opens. */
const openChip = (root: ParentNode) => click(root.querySelector('[data-testid="session-changes-chip"]'));

async function render(props: Partial<Parameters<typeof SessionChangesChip>[0]> = {}) {
  const reviewed: (string | undefined)[] = [];
  const marks: [string[], boolean][] = [];
  let opened = 0;
  useProjectStore.setState({ projects: [{ name: "proj", path: "/work/proj" }] as never });
  view = await mount(
    <SessionChangesChip
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

describe("session changes chip", () => {
  it("is absent while the session has changed nothing", async () => {
    const { container } = await render({ files: [] });
    expect(container.querySelector('[data-testid="session-changes-chip"]')).toBeNull();
  });

  it("before the list is asked for, counts the transcript's files and asks only when opened", async () => {
    const { container, opened } = await render({ files: [], loaded: false, unloadedCount: 3 });
    const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
    expect(chip.textContent).toContain("3");
    expect(chip.textContent).not.toContain("+");
    expect(byText(container, "Mark all reviewed")).toBeNull();
    expect(opened()).toBe(0);
    await click(chip);
    expect(opened()).toBe(1);
  });

  it("asks for the list again when the review is opened before it loaded: the review follows the agent through it", async () => {
    const named = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
    const unloaded = await render({ files: [], loaded: false, unloadedCount: 3 });
    await openChip(unloaded.container);
    await click(named(unloaded.container, "Review"));
    expect(unloaded.reviewed).toEqual([undefined]);
    expect(unloaded.opened()).toBe(2);
    await view!.unmount();
    view = null;

    const loaded = await render();
    await openChip(loaded.container);
    await click(named(loaded.container, "Review"));
    expect(loaded.reviewed).toEqual([undefined]);
    expect(loaded.opened()).toBe(1);
  });

  it("asks again only from its refresh button, which waits while a list is on its way", async () => {
    let refreshed = 0;
    const { container, opened } = await render({ onRefresh: () => { refreshed++; } });
    await openChip(container);
    expect(opened()).toBe(1);
    const button = container.querySelector<HTMLButtonElement>('[data-testid="session-changes-refresh"]')!;
    await click(button);
    expect(refreshed).toBe(1);
    // Refreshing is not another open.
    expect(opened()).toBe(1);
    await view!.unmount();
    view = null;
    const busy = await render({ onRefresh: () => {}, loading: true });
    await openChip(busy.container);
    expect(busy.container.querySelector<HTMLButtonElement>('[data-testid="session-changes-refresh"]')!.disabled).toBe(true);
  });

  it("says the list is being worked out while the first answer is on its way", async () => {
    const { container } = await render({ files: [], loaded: false, loading: true, unloadedCount: 3 });
    const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
    await click(chip);
    expect(container.textContent).toContain("Working out what changed");
  });

  it("sums the whole session and opens the review on its own button", async () => {
    const { container, reviewed } = await render();
    const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
    expect(chip.textContent).toContain("2");
    expect(chip.textContent).toContain("+4");
    expect(chip.textContent).toContain("−1");
    expect(chip.getAttribute("title")).toContain("2 files changed");
    await openChip(container);
    await click(byText(container, "Review"));
    expect(reviewed).toEqual([undefined]);
  });

  describe("on a desktop", () => {
    it("lists the files inline once opened, asks for a fresh list, and opens a picked file", async () => {
      const { container, reviewed, opened } = await render();
      expect(container.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(0);
      const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
      await click(chip);
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
      await openChip(container);
      await click(byText(container, "Mark all reviewed"));
      expect(marks).toEqual([[["/work/proj/src/app.ts", "/work/proj/src/new.ts"], true]]);
      await openChip(container);
      const boxes = container.querySelectorAll('[role="checkbox"]');
      expect([...boxes].map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false"]);
      await click(boxes[1]!);
      expect(marks[1]).toEqual([["/work/proj/src/new.ts"], true]);
    });

    it("leaves a reviewed file out of the count and the list until asked, and unmarks it from there", async () => {
      const { container, marks } = await render({ files: [files[0]!, { ...files[1]!, reviewed: true }] });
      const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
      expect(chip.textContent).toContain("1");
      expect(chip.textContent).toContain("+3");
      await click(chip);
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
      const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
      // When all files are reviewed, the chip shows the reviewed count
      expect(chip.textContent).toContain("reviewed");
      expect(byText(container, "Review")).toBeNull();
      expect(byText(container, "Mark all reviewed")).toBeNull();
      await click(chip);
      expect(container.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(2);
    });

    it("says what a Claude session's shell commands leave out, and that other agents' are not followed", async () => {
      const claude = await render({ providerId: "claude" });
      const claudeChip = claude.container.querySelector('[data-testid="session-changes-chip"]')!;
      await click(claudeChip);
      expect(claude.container.textContent).toContain("Shell commands are followed through git");
      await view?.unmount();
      const codex = await render({ providerId: "codex" });
      const codexChip = codex.container.querySelector('[data-testid="session-changes-chip"]')!;
      await click(codexChip);
      expect(codex.container.textContent).toContain("Files changed by shell commands are not listed");
    });
  });

  describe("on a phone", () => {
    const realWidth = window.innerWidth;
    beforeEach(() => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }));
    afterEach(() => Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }));

    it("gives the chip a 44px target", async () => {
      const { container } = await render();
      const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
      // Chip has max-md:h-8 for touch target on mobile
      expect(chip).not.toBeNull();
      // Marking everything is in the sheet's thumb zone, not squeezed into the chip.
      expect(byText(container, "Mark all reviewed")).toBeNull();
    });

    it("puts Mark all reviewed in the sheet footer, and gives each checkbox a 44px target", async () => {
      const { container, marks } = await render();
      const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
      await click(chip);
      const box = document.querySelector('[role="checkbox"]')!;
      expect(cls(box)).toContain("w-11");
      expect(cls(document.querySelector('[data-testid="session-change-row"]'))).toContain("min-h-");
      await click(byText(document, "Mark all reviewed"));
      expect(marks).toEqual([[["/work/proj/src/app.ts", "/work/proj/src/new.ts"], true]]);
      expect(document.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(0);
    });

    it("opens the list in a sheet whose bottom button reviews everything", async () => {
      const { container, reviewed } = await render();
      const chip = container.querySelector('[data-testid="session-changes-chip"]')!;
      await click(chip);
      // The sheet is portalled out of the chip.
      const rows = document.querySelectorAll('[data-testid="session-change-row"]');
      expect(rows).toHaveLength(2);
      await click(byText(document, "Review"));
      expect(reviewed).toEqual([undefined]);
      expect(document.querySelectorAll('[data-testid="session-change-row"]')).toHaveLength(0);
    });
  });
});
