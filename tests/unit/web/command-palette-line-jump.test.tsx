/**
 * A Markdown file link that resolves to nothing falls back to the command palette, and the
 * line it named has to survive that hop. It did not: the palette searched the whole
 * `app.ts:160` string against filenames that never contain a colon, so the query matched
 * nothing, and an item picked by hand opened at line 1.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
import type { FsStatResult } from "../../../src/web/lib/fs-api";

installDom();
const { CommandPalette } = await import("../../../src/web/components/layout/command-palette");
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useFileStore } = await import("../../../src/web/stores/file-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { fsApi } = await import("../../../src/web/lib/fs-api");
const apiClient = await import("../../../src/web/lib/api-client");
const palette = await import("../../../src/web/hooks/use-global-keybindings");

afterAll(uninstallDom);
afterEach(() => {
  useFileStore.setState({ fileIndex: [], indexStatus: "idle" });
  useProjectStore.setState({ activeProject: null });
});

/** The result row whose rendered text contains `text`. */
function row(container: HTMLElement, text: string): Element {
  const rows = [...container.querySelectorAll("button")];
  const found = rows.find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no result row for ${text}; rows: ${rows.map((b) => b.textContent).join(" | ")}`);
  return found;
}

it("opens an indexed project file at the line the query names", async () => {
  useProjectStore.setState({ activeProject: { name: "demo", path: "/demo" } as never });
  useFileStore.setState({
    fileIndex: [{ name: "app.ts", path: "src/app.ts", type: "file" }] as never,
    indexStatus: "ready",
  });
  const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("tab-1");
  const update = spyOn(useTabStore.getState(), "updateTab").mockImplementation(() => {});
  const get = spyOn(apiClient.api, "get").mockResolvedValue([] as never);
  const view = await mount(<CommandPalette open onClose={() => {}} initialQuery="src/app.ts:160-172" />);
  try {
    await click(row(view.container, "src/app.ts"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      type: "editor",
      metadata: expect.objectContaining({ filePath: "src/app.ts", lineNumber: 160, endLine: 172 }),
    }));
    // The same file may already be open on another line; the reveal only fires when the
    // new location is pushed onto that tab.
    expect(update).toHaveBeenCalledWith("tab-1", expect.objectContaining({
      metadata: expect.objectContaining({ lineNumber: 160, endLine: 172 }),
    }));
  } finally {
    await view.unmount(); open.mockRestore(); update.mockRestore(); get.mockRestore();
  }
});

it("opens an absolute path from filesystem mode at its line", async () => {
  const get = spyOn(apiClient.api, "get").mockResolvedValue(["D:/repo/src/PaymentForm.tsx"] as never);
  const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("tab-2");
  const update = spyOn(useTabStore.getState(), "updateTab").mockImplementation(() => {});
  const view = await mount(
    <CommandPalette open onClose={() => {}} initialQuery="D:/repo/src/PaymentForm.tsx:160" />,
  );
  try {
    // The directory is listed without the suffix, or the host is asked for a folder that
    // does not exist and the palette has nothing to offer.
    expect(get).toHaveBeenCalledWith(`/api/fs/list?dir=${encodeURIComponent("D:/repo/src/")}`);
    await click(row(view.container, "PaymentForm.tsx"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ filePath: "D:/repo/src/PaymentForm.tsx", lineNumber: 160 }),
    }));
  } finally {
    await view.unmount(); open.mockRestore(); update.mockRestore(); get.mockRestore();
  }
});

it("hands the line to the palette when the path resolves to nothing", async () => {
  const stat = spyOn(fsApi, "stat").mockRejectedValue(new Error("ENOENT") as never);
  const search = spyOn(palette, "openCommandPalette").mockImplementation(() => {});
  const view = await mount(<MarkdownRenderer content="[gone](/repo/missing.ts:42-50)" />);
  try {
    await click(view.container.querySelector("a"));
    expect(search).toHaveBeenCalledWith("/repo/missing.ts:42-50");
  } finally {
    await view.unmount(); stat.mockRestore(); search.mockRestore();
  }
});

it("still opens a plain path with no line to jump to", async () => {
  const stat = spyOn(fsApi, "stat").mockResolvedValue({ path: "/repo/app.ts", name: "app.ts", kind: "file" } as FsStatResult);
  const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("tab-3");
  const view = await mount(<MarkdownRenderer content="[app](/repo/app.ts)" />);
  try {
    await click(view.container.querySelector("a"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ metadata: { filePath: "/repo/app.ts" } }));
  } finally {
    await view.unmount(); stat.mockRestore(); open.mockRestore();
  }
});
