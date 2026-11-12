/**
 * The change-bar hook against a stand-in editor: what it asks the server, what
 * it draws, and when it asks again. The diff itself is `gutter-changes.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { GitRepoDiscovery } from "../../../src/web/lib/git-repo-scope";
import type { IndexBase } from "../../../src/shared/git-index-base";

installDom();
afterAll(uninstallDom);
const { act } = await import("react");
const { useGutterChanges } = await import("../../../src/web/hooks/use-gutter-changes");
const { useGitRepoStore } = await import("../../../src/web/stores/git-repo-store");
const { api } = await import("../../../src/web/lib/api-client");

// A project folder inside a repository: git runs unscoped, paths project-relative.
const DISCOVERY: GitRepoDiscovery = { root: "/p", rootIsRepo: false, repos: [] };

interface Decoration {
  range: { startLineNumber: number; endLineNumber: number };
  options: { linesDecorationsClassName: string; isWholeLine: boolean };
}

const fakeMonaco = {
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  },
  editor: { OverviewRulerLane: { Left: 1 }, TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 } },
};

function fakeEditor(initial: string[]) {
  let lines = initial;
  let decorations: Decoration[] = [];
  let visible = true;
  const onContent: Array<() => void> = [];
  const node = document.createElement("div");
  document.body.appendChild(node);
  (node as unknown as { checkVisibility: () => boolean }).checkVisibility = () => visible;
  const model = {
    getLineCount: () => lines.length,
    getLinesContent: () => [...lines],
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
  };
  const none = { dispose() {} };
  const editor = {
    getModel: () => model,
    getDomNode: () => node,
    createDecorationsCollection: () => ({
      set: (d: Decoration[]) => { decorations = d; },
      clear: () => { decorations = []; },
    }),
    onDidChangeModelContent: (cb: () => void) => { onContent.push(cb); return none; },
    onDidChangeModel: () => none,
    onDidFocusEditorText: () => none,
  };
  return {
    editor,
    type(next: string[]) { lines = next; for (const cb of onContent) cb(); },
    hide() { visible = false; },
    bars: () => decorations.map((d) => ({
      cls: d.options.linesDecorationsClassName.replace("ppm-gutter-change ", ""),
      from: d.range.startLineNumber,
      to: d.range.endLineNumber,
    })),
  };
}

function Probe({ editor, filePath = "src/a.ts" }: { editor: unknown; filePath?: string }) {
  useGutterChanges({ editor: editor as never, monaco: fakeMonaco as never, projectName: "p", filePath, enabled: true });
  return null;
}

let view: Mounted | null = null;
let urls: string[] = [];
let answers: IndexBase[] = [];
let spy: { mockRestore: () => void } | null = null;

beforeEach(() => {
  urls = [];
  answers = [];
  useGitRepoStore.setState({ discovery: { p: DISCOVERY }, chosen: {} });
  spy = spyOn(api, "get").mockImplementation(((url: string) => {
    if (!url.includes("/index-base?")) return new Promise(() => {});
    urls.push(url);
    const next = answers.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("no answer queued"));
  }) as never);
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  spy?.mockRestore();
  useGitRepoStore.setState({ discovery: {}, chosen: {} });
});

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const params = (i: number) => new URL(urls[i]!, "http://x").searchParams;
const gitChanged = (projectName: string) =>
  act(() => { window.dispatchEvent(new CustomEvent("git:changed", { detail: { projectName } })); });

const BASE = "one\ntwo\nthree\n";

describe("useGutterChanges", () => {
  it("asks for the file's index version and draws the lines that differ", async () => {
    answers.push({ state: "ok", oid: "aaa", content: BASE });
    const ed = fakeEditor(["one", "TWO", "three", "four", ""]);
    view = await mount(<Probe editor={ed.editor} />);
    await wait(0);

    expect(params(0).get("path")).toBe("src/a.ts");
    expect(params(0).get("known")).toBeNull();
    expect(ed.bars()).toEqual([
      { cls: "ppm-gutter-modified", from: 2, to: 2 },
      { cls: "ppm-gutter-added", from: 4, to: 4 },
    ]);
  });

  it("marks deleted lines on the boundary, and at the top of the file", async () => {
    answers.push({ state: "ok", oid: "aaa", content: BASE });
    const ed = fakeEditor(["three", ""]);
    view = await mount(<Probe editor={ed.editor} />);
    await wait(0);
    expect(ed.bars()).toEqual([{ cls: "ppm-gutter-deleted ppm-gutter-deleted-top", from: 1, to: 1 }]);
  });

  it("redraws after a pause in typing, without asking the server", async () => {
    answers.push({ state: "ok", oid: "aaa", content: BASE });
    const ed = fakeEditor(["one", "two", "three", ""]);
    view = await mount(<Probe editor={ed.editor} />);
    await wait(0);
    expect(ed.bars()).toEqual([]);

    ed.type(["one", "two", "inserted", "three", ""]);
    expect(ed.bars()).toEqual([]);
    await wait(200);
    expect(ed.bars()).toEqual([{ cls: "ppm-gutter-added", from: 3, to: 3 }]);
    expect(urls).toHaveLength(1);
  });

  it("asks again on git:changed naming the blob it has, and clears bars once the change is staged", async () => {
    answers.push({ state: "ok", oid: "aaa", content: BASE });
    const ed = fakeEditor(["one", "TWO", "three", ""]);
    view = await mount(<Probe editor={ed.editor} />);
    await wait(0);
    expect(ed.bars()).toHaveLength(1);

    // Another project's change is not this file's.
    await gitChanged("other");
    await wait(350);
    expect(urls).toHaveLength(1);

    answers.push({ state: "same", oid: "aaa" });
    await gitChanged("p");
    await wait(350);
    expect(params(1).get("known")).toBe("aaa");
    expect(ed.bars()).toHaveLength(1);

    answers.push({ state: "ok", oid: "bbb", content: "one\nTWO\nthree\n" });
    await gitChanged("p");
    await wait(350);
    expect(params(2).get("known")).toBe("aaa");
    expect(ed.bars()).toEqual([]);
  });

  it("asks nothing more while the editor is parked off-screen", async () => {
    answers.push({ state: "ok", oid: "aaa", content: BASE });
    const ed = fakeEditor(["one", "TWO", "three", ""]);
    view = await mount(<Probe editor={ed.editor} />);
    await wait(0);
    ed.hide();
    await gitChanged("p");
    await wait(350);
    expect(urls).toHaveLength(1);
  });

  it("draws nothing for a file with nothing to compare with", async () => {
    answers.push({ state: "none", reason: "untracked" });
    const ed = fakeEditor(["brand", "new", ""]);
    view = await mount(<Probe editor={ed.editor} />);
    await wait(0);
    expect(urls).toHaveLength(1);
    expect(ed.bars()).toEqual([]);
  });

  it("keeps the bars it has when a later check fails", async () => {
    answers.push({ state: "ok", oid: "aaa", content: BASE });
    const ed = fakeEditor(["one", "TWO", "three", ""]);
    view = await mount(<Probe editor={ed.editor} />);
    await wait(0);
    await gitChanged("p"); // no answer queued: the request fails
    await wait(350);
    expect(urls).toHaveLength(2);
    expect(ed.bars()).toHaveLength(1);
  });
});
