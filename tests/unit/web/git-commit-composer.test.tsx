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
