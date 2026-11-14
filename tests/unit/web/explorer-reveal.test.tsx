/**
 * Revealing a path in the project's file tree: the folders on the way (and a folder itself) are
 * opened and loaded outermost first, the row is focused and selected, and the caller hears how
 * it ended. A reveal for another project waits for the tree to show that project; a path the
 * tree does not list is reported, never claimed as shown.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom } from "../../helpers/react-dom";
import { foldersToOpen, parentFolders, treeHasPath } from "../../../src/web/lib/explorer-reveal-paths";

installDom();
const React = await import("react");
const { act } = React;
const { useFileStore } = await import("../../../src/web/stores/file-store");
const { useExplorerReveal, revealInExplorer } = await import("../../../src/web/components/explorer/explorer-reveal");
const { useApplyExplorerReveal } = await import("../../../src/web/components/explorer/use-apply-explorer-reveal");

/** A project tree on the server: folder path → its entries. */
const DIRS: Record<string, Array<{ name: string; type: "file" | "directory" }>> = {
  "": [{ name: "src", type: "directory" }, { name: "README.md", type: "file" }],
  src: [{ name: "server", type: "directory" }],
  "src/server": [{ name: "routes", type: "directory" }],
  "src/server/routes": [{ name: "chat.ts", type: "file" }],
};
const requested: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://localhost/");
  const path = url.searchParams.get("path") ?? "";
  requested.push(path);
  const entries = DIRS[path];
  const body = entries ? { ok: true, data: entries.map((e) => ({ ...e, isIgnored: false })) } : { ok: false, error: "not found" };
  return new Response(JSON.stringify(body), { status: entries ? 200 : 404, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; uninstallDom(); });

function Tree({ project }: { project: string }) {
  useApplyExplorerReveal(project);
  return null;
}

beforeEach(async () => {
  requested.length = 0;
  useExplorerReveal.setState({ pending: null, outcome: null });
  useFileStore.getState().reset();
  await useFileStore.getState().loadChildren("demo", "");
});

describe("the pure half", () => {
  it("names the folders above a path, outermost first, and a folder itself", () => {
    expect(parentFolders("a/b/c")).toEqual(["a", "a/b"]);
    expect(parentFolders("a")).toEqual([]);
    expect(foldersToOpen("a/b", "folder")).toEqual(["a", "a/b"]);
    expect(foldersToOpen("a/b", "file")).toEqual(["a"]);
    expect(foldersToOpen("", "folder")).toEqual([]);
  });

  it("finds a path only down the folders on its way", () => {
    const tree = [{ path: "a", children: [{ path: "a/b", children: [{ path: "a/b/c.ts" }] }] }, { path: "x" }];
    expect(treeHasPath(tree, "a/b/c.ts")).toBe(true);
    expect(treeHasPath(tree, "")).toBe(true);
    expect(treeHasPath(tree, "a/b/missing")).toBe(false);
    expect(treeHasPath(tree, "x/y")).toBe(false);
  });
});

describe("revealing in the tree", () => {
  it("opens a deep folder's parents and the folder, then focuses and selects it", async () => {
    const tree = await mount(<Tree project="demo" />);
    let outcome: Awaited<ReturnType<typeof revealInExplorer>> | undefined;
    await act(async () => { outcome = await revealInExplorer({ projectName: "demo", path: "src/server/routes", kind: "folder" }); });
    expect(outcome).toMatchObject({ ok: true });
    const s = useFileStore.getState();
    expect([...s.expandedPaths]).toEqual(expect.arrayContaining(["src", "src/server", "src/server/routes"]));
    expect(requested).toEqual(["", "src", "src/server", "src/server/routes"]);
    expect(s.focusedPath).toBe("src/server/routes");
    expect(s.selectedFiles).toEqual(["src/server/routes"]);
    expect(useExplorerReveal.getState().pending).toBeNull();
    await tree.unmount();
  });

  it("scrolls to a row that already had focus: focus is cleared for one render, then set again", async () => {
    const tree = await mount(<Tree project="demo" />);
    useFileStore.getState().setFocusedPath("src");
    const seen: Array<string | null> = [];
    const stop = useFileStore.subscribe((s) => { seen.push(s.focusedPath); });
    let outcome: Awaited<ReturnType<typeof revealInExplorer>> | undefined;
    await act(async () => { outcome = await revealInExplorer({ projectName: "demo", path: "src", kind: "folder" }); });
    stop();
    expect(outcome).toMatchObject({ ok: true });
    expect(seen).toContain(null);
    expect(useFileStore.getState().focusedPath).toBe("src");
    await tree.unmount();
  });

  it("reveals a file without opening it as a folder", async () => {
    const tree = await mount(<Tree project="demo" />);
    let outcome: Awaited<ReturnType<typeof revealInExplorer>> | undefined;
    await act(async () => { outcome = await revealInExplorer({ projectName: "demo", path: "src/server/routes/chat.ts", kind: "file" }); });
    expect(outcome).toMatchObject({ ok: true });
    expect(useFileStore.getState().focusedPath).toBe("src/server/routes/chat.ts");
    expect(useFileStore.getState().expandedPaths.has("src/server/routes/chat.ts")).toBe(false);
    await tree.unmount();
  });

  it("reports a path the tree does not list instead of claiming it was shown", async () => {
    const tree = await mount(<Tree project="demo" />);
    let outcome: Awaited<ReturnType<typeof revealInExplorer>> | undefined;
    await act(async () => { outcome = await revealInExplorer({ projectName: "demo", path: ".git", kind: "folder" }); });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome && !outcome.ok && outcome.error).toContain("does not list .git");
    expect(useFileStore.getState().focusedPath).toBeNull();
    await tree.unmount();
  });

  it("waits for a tree that is not shown yet, and applies the reveal once it mounts", async () => {
    let outcome: Awaited<ReturnType<typeof revealInExplorer>> | undefined;
    const waiting = revealInExplorer({ projectName: "demo", path: "src/server", kind: "folder" }).then((o) => { outcome = o; });
    await new Promise((r) => setTimeout(r, 50));
    expect(outcome).toBeUndefined();
    const tree = await mount(<Tree project="demo" />);
    await act(async () => { await waiting; });
    expect(outcome).toMatchObject({ ok: true });
    expect(useFileStore.getState().focusedPath).toBe("src/server");
    await tree.unmount();
  });

  it("tells the caller of a reveal a newer one replaced it at once, not after its wait", async () => {
    const first = revealInExplorer({ projectName: "elsewhere", path: "src", kind: "folder" }, 60_000);
    const second = revealInExplorer({ projectName: "elsewhere", path: "src/server", kind: "folder" }, 100);
    expect(await first).toMatchObject({ ok: false, error: expect.stringContaining("newer reveal") });
    expect(await second).toMatchObject({ ok: false });
  });

  it("leaves a reveal for another project to the tree that shows it, and gives up after the wait", async () => {
    const tree = await mount(<Tree project="demo" />);
    let outcome: Awaited<ReturnType<typeof revealInExplorer>> | undefined;
    await act(async () => { outcome = await revealInExplorer({ projectName: "other", path: "src", kind: "folder" }, 200); });
    expect(outcome).toMatchObject({ ok: false });
    expect(useFileStore.getState().focusedPath).toBeNull();
    expect(useExplorerReveal.getState().pending).toBeNull();
    await tree.unmount();
  });
});
