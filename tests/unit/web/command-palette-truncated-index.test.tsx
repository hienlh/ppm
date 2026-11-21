/**
 * A project the server stopped listing at its entry cap: the palette says so, since a search for a
 * file past the cap otherwise just comes back empty, and points at the project's File Filters.
 */
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";

installDom();
const { CommandPalette } = await import("../../../src/web/components/layout/command-palette");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const { useFileStore } = await import("../../../src/web/stores/file-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const apiClient = await import("../../../src/web/lib/api-client");

const realWidth = window.innerWidth;
afterAll(uninstallDom);
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  useProjectStore.setState({ activeProject: { name: "big", path: "/big" } as never });
});
afterEach(() => Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }));

function indexHeld(truncatedAt: number | null) {
  useFileStore.setState({
    indexProject: "big",
    indexStatus: "ready",
    indexStale: false,
    indexRemote: true,
    fileIndex: [],
    indexTruncatedAt: truncatedAt,
  });
}

async function openPalette() {
  const open = spyOn(useWindowStore.getState(), "open").mockReturnValue("win-1");
  const get = spyOn(apiClient.api, "get").mockResolvedValue([] as never);
  let closed = 0;
  const view = await mount(<CommandPalette open onClose={() => { closed++; }} />);
  return {
    view,
    open,
    closed: () => closed,
    async done() { await view.unmount(); open.mockRestore(); get.mockRestore(); },
  };
}

it("says the list was cut, and opens File Filters from the notice", async () => {
  indexHeld(300_000);
  const p = await openPalette();
  try {
    const notice = p.view.container.querySelector('[role="status"]');
    expect(notice?.textContent).toContain("File list cut at 300,000 entries");
    const link = [...notice!.querySelectorAll("button")].find((b) => b.textContent?.includes("File Filters"))!;
    await click(link);
    expect(p.open).toHaveBeenCalledWith("settings", { category: "files" });
    expect(p.closed()).toBe(1);
  } finally {
    await p.done();
  }
});

it("says nothing for a list the server sent whole", async () => {
  indexHeld(null);
  const p = await openPalette();
  try {
    expect(p.view.container.textContent).not.toContain("File list cut");
  } finally {
    await p.done();
  }
});

it("keeps the store's flag from the server's answer", async () => {
  useFileStore.setState({ indexProject: null, indexStatus: "idle", indexTruncatedAt: null });
  const get = spyOn(apiClient.api, "get").mockResolvedValue({ tooLarge: true, count: 300_000, truncated: true } as never);
  try {
    await useFileStore.getState().loadIndex("big");
    expect(useFileStore.getState().indexRemote).toBe(true);
    expect(useFileStore.getState().indexTruncatedAt).toBe(300_000);
    get.mockResolvedValue({ tooLarge: true, count: 60_000 } as never);
    await useFileStore.getState().loadIndex("big");
    expect(useFileStore.getState().indexTruncatedAt).toBeNull();
  } finally {
    get.mockRestore();
  }
});
