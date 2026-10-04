/**
 * The Review tab's one-key answers belong to the tab, not to what it opens.
 *
 * Y stages and N discards the block in focus. Discard file… asks first, in a
 * popover portalled out of the tab — but React bubbles a key press in a portal
 * through the component that rendered it, so N typed with that question open
 * (its Cancel button has focus) discarded the block behind it, and Y staged it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { GitReviewTab } = await import("../../../src/web/components/git-review/git-review-tab.tsx");

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
const big = {
  path: "big.bin", x: ".", y: "M", untracked: false, conflict: false, staged: null,
  unstaged: { blocks: [], whole: "binary", added: 0, removed: 0 },
};

let writes: string[] = [];
let view: Mounted | null = null;

beforeEach(() => {
  writes = [];
  installGlobal("CSS", (window as unknown as { CSS: unknown }).CSS);
  installGlobal("fetch", async (input: string, init?: RequestInit) => {
    const u = String(input);
    if (init?.method === "POST") writes.push(u.slice(u.indexOf("/git/")));
    if (u.includes("/git/repos")) return ok({ root: "/tmp/demo", rootIsRepo: true, repos: [{ path: "/tmp/demo", name: "demo", relative: "." }] });
    if (u.includes("/git/changes/file")) return ok({ ...big, unstaged: { hunks: [], whole: "binary", added: 0, removed: 0 } });
    if (u.includes("/git/changes")) {
      return ok({
        branch: { head: "main", oid: "a".repeat(40), upstream: null, upstreamGone: false, ahead: 0, behind: 0, hasRemote: false },
        operation: null, stashes: 0, lastCommit: null, truncated: false, files: [big],
      });
    }
    if (u.includes("/git/commit-draft")) return ok({ message: "", updatedAt: null });
    return ok({ undo: null });
  });
});

afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function press(target: Element, key: string): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

async function openReview(): Promise<HTMLElement> {
  view = await mount(<GitReviewTab metadata={{ projectName: "demo" }} tabId="t1" />);
  await until(() => !!document.querySelector('button[title="Discard this block (N)"]'));
  return document.querySelector<HTMLElement>('[data-testid="git-review"]')!;
}

describe("the Review tab's keys", () => {
  it("answer the block in focus when pressed in the tab", async () => {
    const tab = await openReview();
    await press(tab, "n");
    await until(() => writes.includes("/git/discard"));
  });

  it("do nothing while the tab's Discard file… question is open", async () => {
    await openReview();
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Discard file…")!);
    await until(() => !!document.querySelector('[role="alertdialog"]'));
    const cancel = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === "Cancel")!;

    await press(cancel, "y");
    await press(cancel, "n");
    await new Promise((r) => setTimeout(r, 100));
    expect(writes).toEqual([]);
  });
});
