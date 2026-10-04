/**
 * Fetch says what it brought, even when another read of the list overtakes its own.
 *
 * Source Control's Fetch reads the list again and counts the commits to pull
 * from that answer. The fetch is a write, so PPM also announces it as
 * `git:changed`, and the panel reads the list again 300 ms after that by itself.
 * When git took longer than that to answer, the panel's own read was overtaken,
 * came back empty-handed — and the toast said "nothing new" over two new commits.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { toast } = await import("sonner");
const { api } = await import("../../../src/web/lib/api-client.ts");
const { GitStatusPanel } = await import("../../../src/web/components/git/git-status-panel.tsx");
const { useGitRepoStore } = await import("../../../src/web/stores/git-repo-store.ts");

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));

let behind = 0;
/** Once set, every read of the list — of `heldRepo` only, when that is set — waits here until the test lets it answer. */
let held: (() => void)[] | null = null;
let heldRepo: string | null = null;
let view: Mounted | null = null;
let gets: ReturnType<typeof spyOn<typeof api, "get">>;
/** Reads of the list asked for. Concurrent ones share one request, so `fetch` cannot count them. */
const reads = () => gets.mock.calls.filter(([path]) => String(path).includes("/git/changes")).length;

beforeEach(() => {
  behind = 0;
  held = null;
  heldRepo = null;
  gets = spyOn(api, "get");
  useGitRepoStore.setState({ discovery: {}, chosen: {} });
  installGlobal("fetch", async (input: string, init?: RequestInit) => {
    const u = String(input);
    const repo = new URL(u, "http://ppm.invalid").searchParams.get("repo");
    if (u.includes("/project/nest/git/repos")) {
      return ok({ root: "/tmp/nest", rootIsRepo: false, repos: [{ path: "/tmp/nest/a", name: "a", relative: "a" }, { path: "/tmp/nest/b", name: "b", relative: "b" }] });
    }
    if (u.includes("/git/repos")) return ok({ root: "/tmp/fetchy", rootIsRepo: true, repos: [{ path: "/tmp/fetchy", name: "fetchy", relative: "." }] });
    if (u.includes("/git/fetch") && init?.method === "POST") {
      behind = 2;
      held = [];
      // What the server does for every write: tell every surface to read again.
      window.dispatchEvent(new CustomEvent("git:changed", { detail: { projectName: "fetchy" } }));
      return ok({});
    }
    if (u.includes("/git/changes")) {
      if (held && (!heldRepo || repo === heldRepo)) await new Promise<void>((resolve) => held!.push(resolve));
      return ok({
        branch: { head: "main", oid: "a".repeat(40), upstream: "origin/main", upstreamGone: false, ahead: 0, behind: repo === "/tmp/nest/b" ? 7 : behind, hasRemote: true },
        operation: null, stashes: 0, lastCommit: null, truncated: false, files: [],
      });
    }
    if (u.includes("/git/commit-draft")) return ok({ message: "", updatedAt: null });
    if (u.includes("/worktrees") || u.includes("/stashes")) return ok([]);
    return ok(null);
  });
});

afterEach(async () => {
  gets.mockRestore();
  for (const release of held ?? []) release();
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

const fetched = (from: number) =>
  (toast.getHistory().slice(from) as { title?: unknown }[]).map((t) => String(t.title)).filter((t) => t.startsWith("Fetched"));

describe("Fetch in Source Control", () => {
  it("counts the new commits when the read after a write overtakes its own", async () => {
    view = await mount(<GitStatusPanel metadata={{ projectName: "fetchy" }} />);
    const button = await (async () => {
      await until(() => !!document.querySelector('button[title^="In sync with origin/main"]'));
      return document.querySelector('button[title^="In sync with origin/main"]')!;
    })();
    const from = toast.getHistory().length;
    const before = reads();
    await click(button);

    // Fetch's own read is in flight when the read `git:changed` asked for starts:
    // after the write, the panel's own, then the one 300 ms after the event.
    await until(() => reads() >= before + 3);
    const { act } = await import("react");
    await act(async () => {
      for (const release of held!.splice(0)) release();
      held = null;
    });
    await until(() => fetched(from).length > 0);
    expect(fetched(from)).toEqual(["Fetched — 2 new commits to pull"]);
  });
});

describe("useGitChanges", () => {
  it("answers a read the repository changed under with nothing, not the next repository's list", async () => {
    const { act } = await import("react");
    const { useGitChanges } = await import("../../../src/web/hooks/use-git-changes.ts");
    let hook: ReturnType<typeof useGitChanges> | null = null;
    function Probe() {
      hook = useGitChanges("nest");
      return null;
    }
    useGitRepoStore.setState({ discovery: {}, chosen: { nest: "/tmp/nest/a" } });
    view = await mount(<Probe />);
    await until(() => !!hook?.changes);

    held = [];
    heldRepo = "/tmp/nest/a";
    const read = hook!.refresh();
    await until(() => held!.length > 0);
    // The picker moves to b while a's read is out; b's first read answers at once.
    await act(async () => { useGitRepoStore.setState({ chosen: { nest: "/tmp/nest/b" } }); });
    await until(() => hook?.changes?.branch.behind === 7);
    await act(async () => {
      for (const release of held!.splice(0)) release();
      held = null;
    });
    expect(await read).toBeNull();
  });
});
