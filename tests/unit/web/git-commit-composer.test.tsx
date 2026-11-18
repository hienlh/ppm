/**
 * What the commit box holds once a commit is made.
 *
 * A commit can take a while — its hooks run first — and the box stays open the
 * whole time. Whatever was typed into it meanwhile is the next message, and the
 * commit used to clear it all the same, because it cleared the box rather than
 * the text it had committed.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { GitCommitComposer } = await import("../../../src/web/components/git/git-commit-composer.tsx");
const { useCommitDraftStore } = await import("../../../src/web/stores/commit-draft-store.ts");
const { useGitRepoStore } = await import("../../../src/web/stores/git-repo-store.ts");

const DRAFT_URL = "/api/project/demo/git/commit-draft";
const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
let view: Mounted | null = null;

beforeEach(() => {
  useGitRepoStore.setState({ discovery: {}, chosen: {} });
  useCommitDraftStore.setState({ drafts: {} });
  installGlobal("fetch", async (input: string) => {
    const u = String(input);
    if (u.includes("/git/repos")) return ok({ root: "/tmp/demo", rootIsRepo: true, repos: [{ path: "/tmp/demo", name: "demo", relative: "." }] });
    if (u.includes("/git/commit-draft")) return ok({ message: "First", updatedAt: null });
    return ok(null);
  });
});

afterEach(async () => {
  // Nothing typed here may still be waiting to be saved into the next test.
  const pending = useCommitDraftStore.getState().drafts[DRAFT_URL]?.message;
  if (pending !== undefined) useCommitDraftStore.getState().consumed(DRAFT_URL, pending);
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

const box = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]');
const commitButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Commit 1 file")) ?? null;

/** The composer with "First" loaded, and a commit that waits for the test to finish it. */
async function composer(): Promise<{ committed: string[]; finish: () => Promise<void> }> {
  const committed: string[] = [];
  let resolve!: (done: boolean) => void;
  view = await mount(
    <GitCommitComposer
      projectName="demo"
      branch="main"
      totals={{ files: 1, filesStaged: 1, blocks: 1, blocksStaged: 1, conflicts: 0 }}
      lastCommit={null}
      busy={null}
      onCommit={(message) => {
        committed.push(message);
        return new Promise<boolean>((r) => { resolve = r; });
      }}
      onUndoCommit={async () => {}}
    />,
  );
  await until(() => box()?.value === "First");
  return { committed, finish: () => act(async () => { resolve(true); }) };
}

describe("GitCommitComposer after a commit", () => {
  it("empties the box when it still holds what was committed", async () => {
    const { committed, finish } = await composer();
    await click(commitButton());
    await until(() => committed.length === 1);
    await finish();
    expect(committed).toEqual(["First"]);
    expect(box()?.value).toBe("");
  });

  it("keeps what was typed while the commit ran", async () => {
    const { committed, finish } = await composer();
    await click(commitButton());
    await until(() => committed.length === 1);
    // What the box's onChange does with each keystroke.
    await act(async () => { useCommitDraftStore.getState().edit(DRAFT_URL, "Second"); });
    await finish();
    expect(committed).toEqual(["First"]);
    expect(box()?.value).toBe("Second");
  });
});

describe("GitCommitComposer's Draft message with AI", () => {
  const draftButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Draft message with AI"]');

  /** Every request the page made, and the answer `/git/commit-message` gives. */
  function serve(answer: () => Promise<Response>, discovery: unknown) {
    const calls: Array<{ url: string; method: string }> = [];
    installGlobal("fetch", async (input: string, init?: RequestInit) => {
      const u = String(input);
      calls.push({ url: u, method: init?.method ?? "GET" });
      if (u.includes("/git/repos")) return ok(discovery);
      if (u.includes("/git/commit-message")) return answer();
      if (u.includes("/git/commit-draft")) return ok({ message: "", updatedAt: null });
      return ok(null);
    });
    return calls;
  }

  async function mountComposer(filesStaged: number): Promise<void> {
    view = await mount(
      <GitCommitComposer
        projectName="demo"
        branch="main"
        totals={{ files: 1, filesStaged, blocks: 1, blocksStaged: filesStaged, conflicts: 0 }}
        lastCommit={null}
        busy={null}
        onCommit={async () => true}
        onUndoCommit={async () => {}}
      />,
    );
  }

  it("fills the repository's draft with the message the server drafted, scoped by ?repo=", async () => {
    const repoPath = "/tmp/demo/app";
    const calls = serve(
      async () => ok({ message: "feat(app): add the thing" }),
      { root: "/tmp/demo", rootIsRepo: false, repos: [{ path: repoPath, name: "app", relative: "app" }] },
    );
    await mountComposer(1);
    const scopedDraft = "/api/project/demo/git/commit-draft?repo=" + encodeURIComponent(repoPath);
    await until(() => useCommitDraftStore.getState().drafts[scopedDraft]?.loaded === true);

    await click(draftButton());
    await until(() => box()?.value === "feat(app): add the thing");

    const post = calls.find((c) => c.url.includes("/git/commit-message"));
    expect(post).toEqual({ url: "/api/project/demo/git/commit-message?repo=" + encodeURIComponent(repoPath), method: "POST" });
    expect(useCommitDraftStore.getState().drafts[scopedDraft]?.message).toBe("feat(app): add the thing");
    useCommitDraftStore.getState().consumed(scopedDraft, "feat(app): add the thing");
  });

  it("spins while the AI works and leaves the box alone when it fails", async () => {
    let fail!: () => void;
    serve(
      () => new Promise<Response>((r) => {
        fail = () => r(new Response(JSON.stringify({ ok: false, error: "Codex is not available right now" }), { status: 502 }));
      }),
      { root: "/tmp/demo", rootIsRepo: true, repos: [{ path: "/tmp/demo", name: "demo", relative: "." }] },
    );
    await mountComposer(1);
    await until(() => useCommitDraftStore.getState().drafts[DRAFT_URL]?.loaded === true);

    await click(draftButton());
    await until(() => draftButton()?.disabled === true && !!draftButton()?.querySelector(".animate-spin"));
    await act(async () => { fail(); });
    await until(() => draftButton()?.disabled === false);
    expect(box()?.value).toBe("");
  });

  it("is off until something is staged", async () => {
    const calls = serve(async () => ok({ message: "x" }), { root: "/tmp/demo", rootIsRepo: true, repos: [{ path: "/tmp/demo", name: "demo", relative: "." }] });
    await mountComposer(0);
    await until(() => useCommitDraftStore.getState().drafts[DRAFT_URL]?.loaded === true);
    expect(draftButton()?.disabled).toBe(true);
    await click(draftButton());
    expect(calls.some((c) => c.url.includes("/git/commit-message"))).toBe(false);
  });
});
