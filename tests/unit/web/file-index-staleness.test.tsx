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
const { act } = await import("react");
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

/** `/files/index` requests, held open until a test answers them. Anything else answers `[]`. */
const indexRequests: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
const get = spyOn(apiClient.api, "get").mockImplementation(((url: string) => {
  if (!url.endsWith("/files/index")) return Promise.resolve([]);
  return new Promise((resolve, reject) => { indexRequests.push({ resolve, reject }); });
}) as never);

const entries = (...paths: string[]) => paths.map((path) => ({ path, name: path.split("/").pop()!, type: "file" }));
const indexFetches = () => get.mock.calls.filter(([url]) => String(url).endsWith("/files/index")).length;
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

describe("what marks the list stale", () => {
  it("both global events do, and neither downloads it", async () => {
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
    } finally {
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
