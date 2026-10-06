/**
 * The status bar's ahead/behind comes from the background status poller while Source Control
 * is closed. That poller read every ten seconds and nothing else, so a push from the Git Graph
 * finished, said so in a toast, and left the bar showing the commits as unpushed for up to ten
 * seconds more. PPM announces every write it makes as `git:changed`; the poller now reads
 * again on that, for its own project only.
 *
 * Mounted for real against a stubbed `fetch`: the interesting part is the listener being wired
 * to the right project and torn down, which a source grep would not show.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { useGitChangesPoller, useGitStatusStore } = await import("../../../src/web/stores/git-status-store.ts");

let statusReads = 0;
let ahead = 2;

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));

beforeEach(() => {
  statusReads = 0;
  ahead = 2;
  useGitStatusStore.setState({ meta: new Map() });
  installGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/git/repos")) {
      return ok({ root: "/tmp/demo", rootIsRepo: true, repos: [{ path: "/tmp/demo", name: "demo", relative: "." }] });
    }
    if (u.includes("/git/status")) {
      statusReads++;
      return ok({ current: "main", ahead, behind: 0, tracking: "origin/main", staged: [], unstaged: [], untracked: [] });
    }
    return ok(null);
  });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

function Poller({ name }: { name: string }) {
  useGitChangesPoller(name, false);
  return null;
}

async function until(check: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const changed = (projectName: string) =>
  window.dispatchEvent(new CustomEvent("git:changed", { detail: { projectName } }));

describe("the background status poller", () => {
  it("reads the status again as soon as PPM writes to the repository", async () => {
    view = await mount(<Poller name="demo" />);
    await until(() => statusReads === 1);
    expect(useGitStatusStore.getState().meta.get("demo")?.ahead).toBe(2);

    ahead = 0; // the push went out
    changed("demo");
    await until(() => statusReads === 2, 1000);
    await until(() => useGitStatusStore.getState().meta.get("demo")?.ahead === 0, 500);
  });

  it("reads once for a burst of writes", async () => {
    view = await mount(<Poller name="demo" />);
    await until(() => statusReads === 1);
    changed("demo");
    changed("demo");
    changed("demo");
    await until(() => statusReads === 2, 1000);
    await new Promise((r) => setTimeout(r, 400));
    expect(statusReads).toBe(2);
  });

  it("leaves another project's writes alone, and stops listening when unmounted", async () => {
    view = await mount(<Poller name="demo" />);
    await until(() => statusReads === 1);
    changed("other");
    await new Promise((r) => setTimeout(r, 450));
    expect(statusReads).toBe(1);

    await view.unmount();
    view = null;
    changed("demo");
    await new Promise((r) => setTimeout(r, 450));
    expect(statusReads).toBe(1);
  });
});
