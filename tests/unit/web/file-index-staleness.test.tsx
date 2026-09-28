/**
 * The browser holds one flat file index, read by the command palette, the compare picker and
 * the chat's @-picker. It used to be refetched on every `file:changed` — the explorer dropped
 * it and loaded it again 300 ms after each change — which on nxsys-workspace (181k entries) was
 * a 22 MB download per change, and each download a request that made the server walk the
 * whole project. A change now only marks the list stale; whatever opens to read it refreshes it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// The compare picker is a radix Dialog, whose focus scope watches the DOM with one.
installGlobal("MutationObserver", window.MutationObserver);
const { act, useState } = await import("react");
const apiClient = await import("../../../src/web/lib/api-client.ts");
const { WsClient } = await import("../../../src/web/lib/ws-client.ts");
const { useFileStore } = await import("../../../src/web/stores/file-store.ts");
const { useProjectStore } = await import("../../../src/web/stores/project-store.ts");
const { useGlobalEvents } = await import("../../../src/web/hooks/use-global-events.ts");
const { FileTree } = await import("../../../src/web/components/explorer/file-tree.tsx");
const { fsChanged } = await import("../../../src/web/components/os-explorer/explorer-store.ts");
const { CommandPalette } = await import("../../../src/web/components/layout/command-palette.tsx");
const { ComparePicker } = await import("../../../src/web/components/editor/compare-picker.tsx");
const { MessageInput } = await import("../../../src/web/components/chat/message-input.tsx");
const { useRemoteFileSearch } = await import("../../../src/web/hooks/use-remote-file-search.ts");

const isIndexUrl = (url: unknown) => /\/files\/index\?/.test(String(url));
const isSearchUrl = (url: unknown) => /\/files\/index\/search\?/.test(String(url));

/**
 * `/files/index` and `/files/index/search` requests, held open until a test answers them; a
 * search is rejected when its signal aborts, as `fetch` would. Anything else answers `[]`.
 */
const indexRequests: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
const searchRequests: { query: string; kind: string; resolve: (v: unknown) => void }[] = [];
const get = spyOn(apiClient.api, "get").mockImplementation(((url: string, options?: { signal?: AbortSignal }) => {
  if (isSearchUrl(url)) {
    return new Promise((resolve, reject) => {
      const params = new URL(url, "http://x").searchParams;
      const request = { query: params.get("q")!, kind: params.get("kind")!, resolve };
      searchRequests.push(request);
      options?.signal?.addEventListener("abort", () => {
        searchRequests.splice(searchRequests.indexOf(request), 1);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }
  if (!isIndexUrl(url)) return Promise.resolve([]);
  return new Promise((resolve, reject) => { indexRequests.push({ resolve, reject }); });
}) as never);

const entries = (...paths: string[]) => paths.map((path) => ({ path, name: path.split("/").pop()!, type: "file" }));
const indexFetches = () => get.mock.calls.filter(([url]) => isIndexUrl(url)).length;
const searchQueries = () => get.mock.calls.filter(([url]) => isSearchUrl(url)).map(([url]) => new URL(String(url), "http://x").searchParams.get("q"));
const store = () => useFileStore.getState();
const flush = () => act(async () => { await Promise.resolve(); });

async function answer(list: unknown, request = indexRequests.shift()): Promise<void> {
  if (!request) throw new Error("no /files/index request is waiting");
  await act(async () => { request.resolve(list); });
}

/** The index as a page leaves it after its first load: `demo`'s list, fresh. */
async function loadedIndex(): Promise<void> {
  void store().loadIndex("demo");
  await answer(entries("src/a.ts"));
  get.mockClear();
}

let view: Mounted | null = null;

beforeEach(() => {
  store().reset();
  indexRequests.length = 0;
  searchRequests.length = 0;
  get.mockClear();
  useProjectStore.setState({ activeProject: { name: "demo", path: "/demo" } as never });
});

afterEach(async () => {
  await view?.unmount();
  view = null;
});

afterAll(() => {
  get.mockRestore();
  useProjectStore.setState({ activeProject: null });
  uninstallDom();
});

describe("file index store", () => {
  it("marks the list stale on a change and downloads nothing", async () => {
    await loadedIndex();
    const before = store().fileIndex;

    store().markIndexStale("demo");

    expect(indexFetches()).toBe(0);
    expect(store().fileIndex).toBe(before);
    expect(store().indexStatus).toBe("ready");
    expect(store().indexStale).toBe(true);
  });

  it("refreshes a stale list when asked, keeping the old one on screen until the answer", async () => {
    await loadedIndex();
    const before = store().fileIndex;
    store().markIndexStale("demo");

    store().ensureIndex("demo");
    expect(indexFetches()).toBe(1);
    expect(store().indexStatus).toBe("ready");
    expect(store().fileIndex).toBe(before);

    await answer(entries("src/a.ts", "src/b.ts"));
    expect(store().fileIndex.map((e) => e.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(store().indexStale).toBe(false);
  });

  it("stays stale when a change lands while the refresh is on its way", async () => {
    await loadedIndex();
    store().markIndexStale("demo");
    store().ensureIndex("demo");

    store().markIndexStale("demo");
    await answer(entries("src/a.ts", "src/b.ts"));

    // The answer may predate that change, so the next reader has to ask again.
    expect(store().indexStale).toBe(true);
  });

  it("does not fetch a list that is fresh", async () => {
    await loadedIndex();
    store().ensureIndex("demo");
    expect(indexFetches()).toBe(0);
  });

  it("ignores a change in a project whose list it does not hold", async () => {
    await loadedIndex();
    store().markIndexStale("other");
    expect(store().indexStale).toBe(false);
  });

  it("keeps the list when a refresh fails, and tries again on the next open", async () => {
    await loadedIndex();
    const before = store().fileIndex;
    store().markIndexStale("demo");
    store().ensureIndex("demo");

    await act(async () => { indexRequests.shift()!.reject(new Error("502")); });
    expect(store().fileIndex).toBe(before);
    expect(store().indexStatus).toBe("ready");

    store().ensureIndex("demo");
    expect(indexFetches()).toBe(2);
  });

  it("shares one request between readers that open together", async () => {
    await loadedIndex();
    store().markIndexStale("demo");
    store().ensureIndex("demo");
    store().ensureIndex("demo");
    expect(indexFetches()).toBe(1);
  });

  it("drops an answer for a list that was thrown away meanwhile", async () => {
    await loadedIndex();
    store().markIndexStale("demo");
    store().ensureIndex("demo");

    store().invalidateIndex();
    await answer(entries("src/a.ts", "src/b.ts"));

    expect(store().fileIndex).toEqual([]);
    expect(store().indexStatus).toBe("idle");
  });
});

describe("a list something is showing", () => {
  it("is fetched again when the server's rebuild lists other paths, and not once it closes", async () => {
    await loadedIndex();
    const close = store().openIndexReader("demo");
    expect(indexFetches()).toBe(0); // fresh: opening costs nothing

    store().indexRebuilt("demo");
    expect(indexFetches()).toBe(1);
    await answer(entries("src/a.ts", "src/new.ts"));
    expect(store().fileIndex.map((e) => e.path)).toEqual(["src/a.ts", "src/new.ts"]);

    close();
    store().indexRebuilt("demo");
    expect(indexFetches()).toBe(1);
    expect(store().indexStale).toBe(true);
  });

  it("is fetched again after a load already on its way, which may predate the rebuild", async () => {
    await loadedIndex();
    store().markIndexStale("demo");
    const close = store().openIndexReader("demo");
    expect(indexFetches()).toBe(1);

    store().indexRebuilt("demo");
    expect(indexFetches()).toBe(1); // not a second download in parallel
    await answer(entries("src/a.ts"));
    await flush();
    expect(indexFetches()).toBe(2);
    await answer(entries("src/a.ts", "src/new.ts"));
    expect(store().indexStale).toBe(false);
    close();
  });

  it("is not fetched for a rebuild of another project", async () => {
    await loadedIndex();
    const close = store().openIndexReader("demo");
    store().indexRebuilt("other");
    expect(indexFetches()).toBe(0);
    close();
  });

  it("counts each reader once, however often it is released", async () => {
    await loadedIndex();
    const palette = store().openIndexReader("demo");
    const picker = store().openIndexReader("demo");
    palette();
    palette();
    store().indexRebuilt("demo");
    // The picker is still open.
    expect(indexFetches()).toBe(1);
    await answer(entries("src/a.ts"));
    picker();
  });
});

describe("what marks the list stale", () => {
  it("both global events do, and neither downloads it unless the list is open", async () => {
    let deliver: ((e: { data: string }) => void) | null = null;
    const spies = [
      spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
      spyOn(WsClient.prototype, "disconnect").mockImplementation(() => {}),
      spyOn(WsClient.prototype, "send").mockImplementation(() => {}),
      spyOn(WsClient.prototype, "onMessage").mockImplementation(((handler: (e: { data: string }) => void) => {
        deliver = handler;
        return () => {};
      }) as never),
    ];
    const relayed: unknown[] = [];
    const onRelay = (e: Event) => relayed.push((e as CustomEvent).detail);
    window.addEventListener("file:changed", onRelay);
    function Probe() {
      useGlobalEvents(true, "demo");
      return null;
    }
    let close = () => {};
    try {
      await loadedIndex();
      view = await mount(<Probe />);
      const emit = (event: object) => act(async () => { deliver!({ data: JSON.stringify(event) }); });

      await emit({ type: "file:changed", projectName: "demo", path: "src/a.ts" });
      expect(store().indexStale).toBe(true);
      // Still relayed for the editor, previews and the tree.
      expect(relayed).toEqual([{ type: "file:changed", projectName: "demo", path: "src/a.ts" }]);

      store().ensureIndex("demo");
      await answer(entries("src/a.ts"));
      expect(store().indexStale).toBe(false);

      await emit({ type: "files:index-changed", projectName: "demo" });
      expect(store().indexStale).toBe(true);
      expect(indexFetches()).toBe(1);

      // …unless something is showing it right now.
      close = store().openIndexReader("demo");
      await answer(entries("src/a.ts"));
      expect(indexFetches()).toBe(2);
      await emit({ type: "files:index-changed", projectName: "demo" });
      expect(indexFetches()).toBe(3);
      await answer(entries("src/a.ts", "src/new.ts"));
    } finally {
      close();
      window.removeEventListener("file:changed", onRelay);
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("the explorer neither refetches it on a change nor after its own mutations", async () => {
    view = await mount(<FileTree />);
    // Its mount loads the index once, for the palette to open instantly.
    expect(indexFetches()).toBe(1);
    await answer(entries("src/a.ts"));

    await act(async () => {
      window.dispatchEvent(new CustomEvent("file:changed", { detail: { projectName: "demo", path: "src/b.ts" } }));
      await Bun.sleep(400);
    });
    await act(async () => { fsChanged("/demo/src"); });
    await flush();

    expect(indexFetches()).toBe(1);
    expect(store().indexStale).toBe(true);
  });
});

describe("what keeps an open list current", () => {
  it("the command palette, while it is open", async () => {
    await loadedIndex();
    let setOpen: (open: boolean) => void = () => {};
    function Harness() {
      const [open, set] = useState(true);
      setOpen = set;
      return <CommandPalette open={open} onClose={() => {}} />;
    }
    view = await mount(<Harness />);
    await act(async () => { store().indexRebuilt("demo"); });
    expect(indexFetches()).toBe(1);
    await answer(entries("src/a.ts", "src/new.ts"));

    await act(async () => { setOpen(false); });
    await act(async () => { store().indexRebuilt("demo"); });
    expect(indexFetches()).toBe(1);
  });

  it("the compare picker, while it is open", async () => {
    await loadedIndex();
    view = await mount(<ComparePicker open onOpenChange={() => {}} />);
    await act(async () => { store().indexRebuilt("demo"); });
    expect(indexFetches()).toBe(1);
    await answer(entries("src/a.ts", "src/new.ts"));

    await view.unmount();
    view = null;
    await act(async () => { store().indexRebuilt("demo"); });
    expect(indexFetches()).toBe(1);
  });
});

describe("what refreshes a stale list", () => {
  it("opening the command palette", async () => {
    await loadedIndex();
    store().markIndexStale("demo");
    view = await mount(<CommandPalette open onClose={() => {}} />);
    expect(indexFetches()).toBe(1);
  });

  it("opening the compare picker", async () => {
    await loadedIndex();
    store().markIndexStale("demo");
    view = await mount(<ComparePicker open onOpenChange={() => {}} />);
    expect(indexFetches()).toBe(1);
  });

  it("typing @ in the chat input", async () => {
    await loadedIndex();
    store().markIndexStale("demo");
    view = await mount(<MessageInput onSend={() => {}} projectName="demo" />);
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("no textarea");
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(textarea, "see @");
      textarea.setSelectionRange(5, 5);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(indexFetches()).toBe(1);
  });
});

/** `demo` as a page leaves it when its list is too long to send. */
async function remoteIndex(): Promise<void> {
  void store().loadIndex("demo");
  await answer({ tooLarge: true, count: 175_628 });
  get.mockClear();
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function answerSearch(query: string, list: unknown): Promise<void> {
  const request = searchRequests.find((r) => r.query === query);
  if (!request) throw new Error(`no search for ${JSON.stringify(query)} is waiting`);
  await act(async () => { request.resolve(list); });
}

describe("a project too long to send", () => {
  it("holds no list, only the fact that it is searched on the server", async () => {
    await remoteIndex();
    expect(store().indexRemote).toBe(true);
    expect(store().fileIndex).toEqual([]);
    expect(store().indexStatus).toBe("ready");
  });

  it("is forgotten while another project's list is on its way", async () => {
    await remoteIndex();
    void store().loadIndex("other");
    // Until "other" answers, nothing may search "demo"'s list on the server in its name.
    expect(store().indexRemote).toBe(false);
  });

  it("asks for directories too for a picker that shows them", async () => {
    function Probe() {
      useRemoteFileSearch("demo", "src", { enabled: true, kind: "all" });
      return null;
    }
    view = await mount(<Probe />);
    expect(searchRequests.map((r) => [r.query, r.kind])).toEqual([["src", "all"]]);
  });

  it("is sent as a list again once it is short enough", async () => {
    await remoteIndex();
    store().markIndexStale("demo");
    store().ensureIndex("demo");
    await answer(entries("src/a.ts"));
    expect(store().indexRemote).toBe(false);
    expect(store().fileIndex.map((e) => e.path)).toEqual(["src/a.ts"]);
  });

  it("the palette searches it on the server as the query changes, and shows what comes back", async () => {
    await remoteIndex();
    view = await mount(<CommandPalette open onClose={() => {}} />);
    expect(searchQueries()).toEqual([]); // no query, no files to show

    const input = document.body.querySelector<HTMLInputElement>("input[type=text]")!;
    await typeInto(input, "butt");
    expect(searchQueries()).toEqual(["butt"]);
    await answerSearch("butt", entries("src/ui/Button.tsx", "src/ui/button-group.ts"));
    expect(document.body.textContent).toContain("Button.tsx");
    expect(document.body.textContent).toContain("button-group.ts");
  });

  it("the palette drops what an earlier answer holds that no longer matches the query", async () => {
    await remoteIndex();
    view = await mount(<CommandPalette open onClose={() => {}} />);
    const input = document.body.querySelector<HTMLInputElement>("input[type=text]")!;
    await typeInto(input, "b");
    await answerSearch("b", entries("src/b.ts", "src/bu.ts"));
    expect(document.body.textContent).toContain("b.ts");

    // The answer for "bu" is still on its way; "b.ts" has no "u" in its path.
    await typeInto(input, "bu");
    expect(document.body.textContent).toContain("src/bu.ts");
    expect(document.body.textContent).not.toContain("src/b.ts");
  });

  it("the palette gives up asking about a query that was typed past", async () => {
    await remoteIndex();
    view = await mount(<CommandPalette open onClose={() => {}} />);
    const input = document.body.querySelector<HTMLInputElement>("input[type=text]")!;
    await typeInto(input, "b");
    await typeInto(input, "bu");
    expect(searchRequests.map((r) => r.query)).toEqual(["bu"]);
  });

  it("the palette asks again when the server's list changes", async () => {
    await remoteIndex();
    view = await mount(<CommandPalette open onClose={() => {}} />);
    const input = document.body.querySelector<HTMLInputElement>("input[type=text]")!;
    await typeInto(input, "new");
    await answerSearch("new", entries());

    await act(async () => { store().indexRebuilt("demo"); });
    await answer({ tooLarge: true, count: 175_629 });
    expect(searchQueries()).toEqual(["new", "new"]);
    await answerSearch("new", entries("src/new.ts"));
    expect(document.body.textContent).toContain("new.ts");
  });

  it("the compare picker searches it on the server", async () => {
    await remoteIndex();
    view = await mount(<ComparePicker open onOpenChange={() => {}} />);
    // Before anything is typed it shows the first files, as it does with a list.
    await answerSearch("", entries("README.md", "src/a.ts"));
    expect(document.body.textContent).toContain("README.md");
  });

  it("the chat's @-picker opens on it, with no list to look in", async () => {
    await remoteIndex();
    const opened: [boolean, string][] = [];
    view = await mount(<MessageInput onSend={() => {}} projectName="demo" onFileStateChange={(visible, filter) => opened.push([visible, filter])} />);
    await typeInto(view.container.querySelector("textarea")!, "see @app");
    expect(opened).toContainEqual([true, "app"]);
  });
});
