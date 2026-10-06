/**
 * Every Undo in Source Control and the Review tab names what it undoes.
 *
 * "Undo last commit" sends the commit the toast or the box is about, so PPM
 * refuses once another commit has landed on top: without it, the server took
 * back whatever was last by the time the click arrived. Source Control also
 * refuses it while a push is still going out, which could otherwise carry the
 * commit to the remote after it was taken back here. And "Stash all changes"
 * offers Undo for the stash PPM says it made, never the one on top of the
 * list, which is an older one when git found nothing it could save.
 *
 * Mounted for real against a stubbed `fetch`, toasts included: the bug was
 * which value each click handler sends, which no helper test would show.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's dropdowns watch their content with one; happy-dom has it, the helper does not install it.
installGlobal("MutationObserver", (window as unknown as { MutationObserver: unknown }).MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { Toaster, toast } = await import("sonner");
const { GitStatusPanel } = await import("../../../src/web/components/git/git-status-panel");
const { useGitReview } = await import("../../../src/web/hooks/use-git-review");
const { useGitRepoStore } = await import("../../../src/web/stores/git-repo-store");
const { useCommitDraftStore } = await import("../../../src/web/stores/commit-draft-store");
type GitReview = ReturnType<typeof useGitReview>;

const LAST = "a".repeat(40);
const MADE = "c".repeat(40);
const OLDER = { index: 0, hash: "f".repeat(40), base: null, branch: "main", message: "older", date: "2026-10-01T00:00:00Z" };
const MINE = { index: 0, hash: "e".repeat(40), base: null, branch: "main", message: "WIP", date: "2026-10-06T00:00:00Z" };

const FILE = {
  path: "a.txt", x: "M", y: ".", untracked: false, conflict: false,
  staged: { blocks: [{ id: "b1", index: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, added: 1, removed: 1 }], added: 1, removed: 1 },
  unstaged: null,
};
const changesWith = (files: unknown[]) => ({
  branch: { head: "main", oid: LAST, upstream: "origin/main", upstreamGone: false, ahead: 0, behind: 0, hasRemote: true },
  operation: null,
  files,
  stashes: 0,
  lastCommit: { hash: LAST, subject: "Last", author: "T", date: "2026-10-06T00:00:00Z", pushed: false, hasParent: true },
  truncated: false,
});

let files: unknown[] = [];
let stashAnswer: unknown = null;
let posts: { route: string; body: unknown }[] = [];
let pushDone: (() => void) | null = null;

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));

beforeEach(() => {
  files = [FILE];
  stashAnswer = null;
  posts = [];
  pushDone = null;
  useGitRepoStore.setState({ discovery: {}, chosen: {} });
  useCommitDraftStore.setState({ drafts: {} });
  installGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const route = path.replace(/^\/api\/project\/demo\/git/, "");
    const method = init?.method ?? "GET";
    if (method === "POST") posts.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (route === "/repos") return ok({ root: "/tmp/demo", rootIsRepo: true, repos: [{ path: "/tmp/demo", name: "demo", relative: "." }] });
    if (route === "/changes") return ok(changesWith(files));
    if (route === "/commit-draft") return ok({ message: "Fix it", updatedAt: null });
    if (route === "/commit") return ok({ hash: MADE });
    if (route === "/commit/undo") return ok({ hash: LAST, message: "Last", draft: { message: "Last", updatedAt: null } });
    if (route === "/push") {
      await new Promise<void>((resolve) => { pushDone = resolve; });
      return ok({ pushed: true });
    }
    if (route === "/stash") return ok(stashAnswer);
    if (route === "/stashes") return ok([OLDER]);
    if (route === "/stash/pop") return ok({ pop: true, indexRestored: true });
    if (route === "/worktrees") return ok([]);
    return ok(null);
  });
});

let view: Mounted | null = null;
afterEach(async () => {
  pushDone?.();
  await view?.unmount();
  view = null;
  toast.dismiss();
});

async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const button = (match: (b: HTMLButtonElement) => boolean, what: string) => {
  const found = buttons().find(match);
  if (!found) throw new Error(`no ${what}`);
  return found;
};
const press = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
};
/** A dropdown, which Radix opens on a primary-button pointerdown; then one of its items. */
async function choose(trigger: Element, label: string): Promise<void> {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((i) => i.textContent?.trim() === label);
  if (!item) throw new Error(`no "${label}" in the menu`);
  await press(item);
}
const toastsText = () => [...document.body.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent ?? "");
const toastUndo = (text: string) => {
  const t = [...document.body.querySelectorAll("[data-sonner-toast]")].find((el) => el.textContent?.includes(text));
  const undo = t && [...t.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Undo");
  if (!undo) throw new Error(`no Undo on a "${text}" toast; toasts: ${toastsText().join(" | ")}`);
  return undo;
};
const sent = (route: string) => posts.filter((p) => p.route === route).map((p) => p.body);

async function mountPanel(): Promise<void> {
  view = await mount(<><GitStatusPanel metadata={{ projectName: "demo" }} /><Toaster /></>);
}
async function commitFromComposer(): Promise<void> {
  const box = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]');
  await until(() => box()?.value === "Fix it", "the commit message");
  await press(button((b) => b.textContent?.trim() === "Commit 1 file" && !b.disabled, "Commit button"));
  await until(() => toastsText().some((t) => t.startsWith(`Committed ${MADE.slice(0, 7)}`)), "the commit toast");
}

describe("Undo last commit in Source Control", () => {
  it("from the toast, names the commit it is about", async () => {
    await mountPanel();
    await commitFromComposer();
    await press(toastUndo("Committed"));
    await until(() => sent("/commit/undo").length === 1, "the undo");
    expect(sent("/commit/undo")).toEqual([{ hash: MADE }]);
  });

  it("from the toast, waits for a push still going out", async () => {
    await mountPanel();
    const box = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]');
    await until(() => box()?.value === "Fix it", "the commit message");
    await choose(button((b) => b.getAttribute("aria-label") === "More commit actions", "commit menu"), "Commit and push");
    await until(() => !!pushDone, "the push");
    await press(toastUndo("Committed"));
    await until(() => toastsText().some((t) => t.includes("Wait for git to finish")), "the refusal");
    expect(sent("/commit/undo")).toEqual([]);
  });

  it("from the commit box, names the last commit it shows", async () => {
    await mountPanel();
    const box = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]');
    await until(() => box()?.value === "Fix it", "the commit message");
    await choose(button((b) => b.getAttribute("aria-label") === "More commit actions", "commit menu"), "Undo last commit");
    await until(() => sent("/commit/undo").length === 1, "the undo");
    expect(sent("/commit/undo")).toEqual([{ hash: LAST }]);
  });

  it("from the clean state, names the last commit it shows", async () => {
    files = [];
    await mountPanel();
    await until(() => buttons().some((b) => b.title === "Take the commit back, keeping its changes staged"), "the Undo button");
    await press(button((b) => b.title === "Take the commit back, keeping its changes staged", "Undo button"));
    await until(() => sent("/commit/undo").length === 1, "the undo");
    expect(sent("/commit/undo")).toEqual([{ hash: LAST }]);
  });
});

describe("Stash all changes", () => {
  async function stashAll(): Promise<void> {
    await mountPanel();
    await until(() => buttons().some((b) => b.textContent?.trim() === "Commit 1 file"), "the changes");
    await choose(button((b) => b.getAttribute("aria-label") === "More actions", "More actions"), "Stash all changes");
    await until(() => sent("/stash").length === 1, "the stash");
  }

  it("offers Undo for the stash it made, not the one on top of the list", async () => {
    stashAnswer = { stashed: true, stash: MINE };
    await stashAll();
    await until(() => toastsText().some((t) => t.startsWith("Stashed 1 file")), "the stash toast");
    await press(toastUndo("Stashed 1 file"));
    await until(() => sent("/stash/pop").length === 1, "the pop");
    expect(sent("/stash/pop")).toEqual([{ index: MINE.index, hash: MINE.hash }]);
  });

  it("says nothing was stashed, with no Undo, when git found nothing it could save", async () => {
    stashAnswer = { stashed: false, stash: null };
    await stashAll();
    await until(() => toastsText().some((t) => t.startsWith("Nothing was stashed")), "the toast");
    expect(toastsText().some((t) => t.startsWith("Stashed"))).toBe(false);
  });
});

describe("Undo last commit in the Review tab", () => {
  let review: GitReview | null = null;
  function Probe() {
    review = useGitReview("demo");
    return null;
  }

  it("from the toast, names the commit it is about", async () => {
    view = await mount(<Probe />);
    await until(() => !!review?.changes, "the changes");
    await act(async () => { await review!.commit("Fix it", {}); });
    await until(() => !!review?.toast?.undo, "the commit toast");
    await act(async () => { review!.toast!.undo!(); });
    await until(() => sent("/commit/undo").length === 1, "the undo");
    expect(sent("/commit/undo")).toEqual([{ hash: MADE }]);
  });

  it("from the commit box, names the last commit it shows", async () => {
    view = await mount(<Probe />);
    await until(() => !!review?.changes, "the changes");
    await act(async () => { await review!.undoCommit(); });
    expect(sent("/commit/undo")).toEqual([{ hash: LAST }]);
  });
});
