/**
 * The Review tab moving from one repository of a project to another.
 *
 * Two things went with it that belonged to the repository it left. The Git
 * Graph of a sub-repository opens the tab on a file of *that* repository: the
 * file was looked for in the list of the repository the tab was still on, was
 * not there, and the request counted as answered — so once the tab had moved,
 * the file was never shown. And the blocks discarded in the first repository
 * stayed in the list, each with an Undo the second repository's journal knows
 * nothing about: clicking one was a 409.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { useState } from "react";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { GitReviewTab } = await import("../../../src/web/components/git-review/git-review-tab.tsx");
const { useGitRepoStore } = await import("../../../src/web/stores/git-repo-store.ts");

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
const A = "/tmp/nest/a";
const B = "/tmp/nest/b";
const whole = (path: string) => ({
  path, x: ".", y: "M", untracked: false, conflict: false, staged: null,
  unstaged: { blocks: [], whole: "binary", added: 0, removed: 0 },
});

let files: Record<string, ReturnType<typeof whole>[]> = {};
let view: Mounted | null = null;

beforeEach(() => {
  files = { [A]: [whole("big.bin")], [B]: [whole("x.bin"), whole("y.bin")] };
  useGitRepoStore.setState({ discovery: {}, chosen: { nest: A } });
  installGlobal("CSS", (window as unknown as { CSS: unknown }).CSS);
  installGlobal("fetch", async (input: string) => {
    const url = new URL(String(input), "http://ppm.invalid");
    const repo = url.searchParams.get("repo") ?? "";
    if (url.pathname.endsWith("/git/repos")) {
      return ok({ root: "/tmp/nest", rootIsRepo: false, repos: [{ path: A, name: "a", relative: "a" }, { path: B, name: "b", relative: "b" }] });
    }
    if (url.pathname.endsWith("/git/discard")) {
      files[repo] = [];
      return ok({ discarded: ["big.bin"], undo: { id: `undo-in-${repo}`, createdAt: 1, kind: "files", paths: ["big.bin"] } });
    }
    if (url.pathname.endsWith("/git/changes/file")) {
      return ok({ ...whole(url.searchParams.get("path")!), unstaged: { hunks: [], whole: "binary", added: 0, removed: 0 } });
    }
    if (url.pathname.endsWith("/git/changes")) {
      return ok({
        branch: { head: "main", oid: "a".repeat(40), upstream: null, upstreamGone: false, ahead: 0, behind: 0, hasRemote: false },
        operation: null, stashes: 0, lastCommit: null, truncated: false, files: files[repo] ?? [],
      });
    }
    if (url.pathname.endsWith("/git/commit-draft")) return ok({ message: "", updatedAt: null });
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

const row = (path: string) => document.querySelector<HTMLElement>(`[data-testid="git-review-file"][title="${path}"]`);

/** The tab, with its metadata as the tab store would hand it over. */
let setMetadata: (metadata: Record<string, unknown>) => void = () => {};
function Tab() {
  const [metadata, set] = useState<Record<string, unknown>>({ projectName: "nest" });
  setMetadata = set;
  return <GitReviewTab metadata={metadata} tabId="review-1" />;
}

describe("the Review tab, moved to another repository", () => {
  it("shows the file the other repository's Git Graph asked for", async () => {
    view = await mount(<Tab />);
    await until(() => !!row("big.bin"));

    const { act } = await import("react");
    await act(async () => setMetadata({ projectName: "nest", select: { path: "y.bin", repo: B, at: 1 } }));
    await until(() => !!row("y.bin"));
    await until(() => row("y.bin")!.getAttribute("aria-current") === "true");
  });

  it("leaves the discards of the repository it left behind", async () => {
    view = await mount(<Tab />);
    await until(() => !!row("big.bin"));
    await click(document.querySelector('button[title="Discard this block (N)"]'));
    await until(() => !!document.querySelector('[data-testid="git-review-toast"]'));
    expect(row("big.bin")).not.toBeNull(); // shown as discarded, with its Undo

    const { act } = await import("react");
    await act(async () => useGitRepoStore.getState().choose("nest", B));
    await until(() => !!row("x.bin"));
    expect(row("big.bin")).toBeNull();
    expect(document.querySelector('[data-testid="git-review-toast"]')).toBeNull();
  });
});
