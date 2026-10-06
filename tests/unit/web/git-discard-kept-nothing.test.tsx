/**
 * A discard that kept no copy offers no Undo.
 *
 * A file over the journal's size cap is discarded without a copy: the server
 * answers with a record whose `paths` is empty and whose `skipped` names the
 * file. Source Control and the Review tab offered Undo for any record at all, so
 * the user was offered back a file that was gone for good — and Undo then said
 * "Restored" while restoring nothing.
 *
 * Mounted for real against a stubbed `fetch`: the decision sits in the click
 * handlers, between the answer and the toast.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { toast } = await import("sonner");
const { GitStatusPanel } = await import("../../../src/web/components/git/git-status-panel.tsx");
const { GitReviewTab } = await import("../../../src/web/components/git-review/git-review-tab.tsx");

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
const big = {
  path: "big.bin", x: ".", y: "M", untracked: false, conflict: false, staged: null,
  unstaged: { blocks: [], whole: "binary", added: 0, removed: 0 },
};

/** What the journal managed to keep a copy of. */
let kept: string[] = [];
let view: Mounted | null = null;

beforeEach(() => {
  kept = [];
  installGlobal("CSS", (window as unknown as { CSS: unknown }).CSS);
  installGlobal("fetch", async (input: string) => {
    const u = String(input);
    if (u.includes("/git/repos")) return ok({ root: "/tmp/demo", rootIsRepo: true, repos: [{ path: "/tmp/demo", name: "demo", relative: "." }] });
    if (u.includes("/git/discard")) {
      return ok({
        discarded: ["big.bin"],
        undo: { id: "d1", createdAt: 1, kind: "files", paths: kept, ...(kept.length ? {} : { skipped: ["big.bin"] }) },
      });
    }
    if (u.includes("/git/changes/file")) return ok({ ...big, unstaged: { hunks: [], whole: "binary", added: 0, removed: 0 } });
    if (u.includes("/git/changes")) {
      return ok({
        branch: { head: "main", oid: "a".repeat(40), upstream: null, upstreamGone: false, ahead: 0, behind: 0, hasRemote: false },
        operation: null, stashes: 0, lastCommit: null, truncated: false, files: [big],
      });
    }
    if (u.includes("/git/commit-draft")) return ok({ message: "", updatedAt: null });
    if (u.includes("/worktrees") || u.includes("/stashes")) return ok([]);
    return ok(null);
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

async function find(selector: string): Promise<HTMLElement> {
  await until(() => !!document.querySelector(selector));
  return document.querySelector<HTMLElement>(selector)!;
}

type Made = { title?: unknown; type?: string; action?: { label?: unknown } };
/** The toasts sonner was asked for since `from`. */
const madeSince = (from: number) => toast.getHistory().slice(from) as Made[];

/** The confirmation's destructive button: the last of its two. */
async function confirm(): Promise<void> {
  const dialog = await find('[role="alertdialog"]');
  await click([...dialog.querySelectorAll("button")].at(-1)!);
}

describe("Source Control", () => {
  async function discardBig(): Promise<number> {
    view = await mount(<GitStatusPanel metadata={{ projectName: "demo" }} />);
    const button = await find('[aria-label="Discard changes to big.bin"]');
    const from = toast.getHistory().length;
    await click(button);
    await confirm();
    return from;
  }

  it("offers Undo for a discard it kept a copy of", async () => {
    kept = ["big.bin"];
    const from = await discardBig();
    await until(() => madeSince(from).some((t) => t.action?.label === "Undo"));
  });

  it("offers none when it kept nothing, and says the file is gone", async () => {
    const from = await discardBig();
    await until(() => madeSince(from).some((t) => t.type === "warning"));
    expect(madeSince(from).filter((t) => t.action?.label === "Undo")).toEqual([]);
    expect(String(madeSince(from).find((t) => t.type === "warning")!.title)).toContain("big.bin could not be kept");
  });
});

describe("the Review tab", () => {
  const reviewToast = () => document.querySelector('[data-testid="git-review-toast"]');

  async function openReview(): Promise<number> {
    view = await mount(<GitReviewTab metadata={{ projectName: "demo" }} tabId="t1" />);
    await find('button[title="Discard this block (N)"]');
    return toast.getHistory().length;
  }

  it("offers Undo for a discarded file it kept a copy of", async () => {
    kept = ["big.bin"];
    await openReview();
    await click(document.querySelector('button[title="Discard this block (N)"]'));
    await until(() => !!reviewToast());
    expect(reviewToast()!.textContent).toContain("Undo");
  });

  it("offers none for a block whose file it kept no copy of", async () => {
    const from = await openReview();
    await click(document.querySelector('button[title="Discard this block (N)"]'));
    await until(() => madeSince(from).some((t) => t.type === "warning"));
    expect(reviewToast()).toBeNull();
    expect(document.body.textContent).not.toContain("Discarded");
  });

  it("offers none for Discard file… either", async () => {
    const from = await openReview();
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Discard file…")!;
    await click(button);
    await confirm();
    await until(() => madeSince(from).some((t) => t.type === "warning"));
    expect(reviewToast()).toBeNull();
    expect(String(madeSince(from).find((t) => t.type === "warning")!.title)).toBe("Discarded the changes to big.bin");
  });
});
