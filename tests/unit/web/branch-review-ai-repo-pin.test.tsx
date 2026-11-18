/**
 * `open_branch_review` in a project folder holding several repositories names one of them. That
 * repository is the review tab's own: the one the user has chosen for Source Control stays chosen.
 * The first version made the AI's repository the device's choice, so asking for a review moved
 * Source Control, the Review tab and every other git panel to another repository.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { answerTabOpen } = await import("../../../src/web/lib/open-ai-tab.ts");
const { BranchReviewTab } = await import("../../../src/web/components/branch-review/branch-review-tab.tsx");
const { useGitRepoStore } = await import("../../../src/web/stores/git-repo-store.ts");
const { usePanelStore } = await import("../../../src/web/stores/panel-store.ts");

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
const A = "/tmp/nest/a";
const B = "/tmp/nest/b";

/** The `repo=` of every git request the tab made, by route. */
let asked: Array<{ route: string; repo: string | null }> = [];
let view: Mounted | null = null;

beforeEach(() => {
  asked = [];
  useGitRepoStore.setState({ discovery: {}, chosen: { nest: A } });
  installGlobal("CSS", (window as unknown as { CSS: unknown }).CSS);
  installGlobal("fetch", async (input: string) => {
    const url = new URL(String(input), "http://ppm.invalid");
    if (url.pathname.endsWith("/git/repos")) {
      return ok({ root: "/tmp/nest", rootIsRepo: false, repos: [{ path: A, name: "a", relative: "a" }, { path: B, name: "b", relative: "b" }] });
    }
    const route = url.pathname.split("/git/")[1] ?? url.pathname;
    asked.push({ route, repo: url.searchParams.get("repo") });
    if (route === "branches") return ok([{ name: "main", current: false, remote: false }, { name: "feat", current: true, remote: false }]);
    if (route === "branch-diff") return ok({ base: "main", head: "feat", mergeBase: "c".repeat(40), files: [] });
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

describe("a Branch Review the AI opened on another repository", () => {
  it("names the repository in the tab and leaves the device's choice alone", async () => {
    const opened: Array<Record<string, unknown>> = [];
    const openTab = spyOn(usePanelStore.getState(), "openTab").mockImplementation((def) => {
      opened.push((def as { metadata: Record<string, unknown> }).metadata);
      return "branch-review:1";
    });
    const sent: string[] = [];
    try {
      await answerTabOpen(
        { type: "tab_open", requestId: "r-1", tool: "open_branch_review", projectName: "nest", repo: B, base: "main", head: "feat" },
        { sessionId: "s-1", projectName: "nest" },
        (data) => sent.push(data),
      );
    } finally {
      openTab.mockRestore();
    }
    expect(sent.map((s) => JSON.parse(s))).toEqual([{ type: "tab_open_result", requestId: "r-1", opened: true }]);
    expect(opened).toEqual([expect.objectContaining({ projectName: "nest", repo: B, base: "main", head: "feat" })]);
    expect(useGitRepoStore.getState().chosen).toEqual({ nest: A });
  });

  it("reviews the repository its metadata names, not the one Source Control has chosen", async () => {
    view = await mount(<BranchReviewTab metadata={{ projectName: "nest", repo: B, base: "main", head: "feat", aiOpenAt: 1 }} tabId="br-1" />);
    await until(() => asked.some((a) => a.route.startsWith("branch-diff")));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.repo === B)).toBe(true);
    expect(useGitRepoStore.getState().chosen).toEqual({ nest: A });
  });

  it("follows the user's choice once the user picks a repository in the tab", async () => {
    useGitRepoStore.setState({ discovery: {}, chosen: {} });
    const metadata = { projectName: "nest", repo: B, base: "main", head: "feat", aiOpenAt: 1 };
    const updates: Array<{ tabId: string; metadata: unknown }> = [];
    usePanelStore.setState({ panels: { p1: { id: "p1", tabs: [{ id: "br-1", type: "branch-review", metadata }] } } as never });
    const updateTab = spyOn(usePanelStore.getState(), "updateTab").mockImplementation((tabId, u) => {
      updates.push({ tabId, metadata: u.metadata });
    });
    try {
      view = await mount(<BranchReviewTab metadata={metadata} tabId="br-1" />);
      await until(() => !!document.querySelector('[data-testid="git-repo-picker"]'));
      await click(document.querySelector('[data-testid="git-repo-picker"]'));
      await click(document.querySelector(`[data-value="${A}"]`));
    } finally {
      updateTab.mockRestore();
    }
    expect(useGitRepoStore.getState().chosen).toEqual({ nest: A });
    expect(updates).toEqual([{ tabId: "br-1", metadata: { projectName: "nest", base: "main", head: "feat", aiOpenAt: 1 } }]);
  });
});
