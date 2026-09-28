import { afterAll, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
import type { FsStatResult } from "../../../src/web/lib/fs-api";

installDom();
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
const { fsApi } = await import("../../../src/web/lib/fs-api");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const explorer = await import("../../../src/web/components/os-explorer/open-explorer");
const palette = await import("../../../src/web/hooks/use-global-keybindings");
afterAll(uninstallDom);

it.each(["file", "directory"])("follows a relative symlink to a %s", async (kind) => {
  const stat = spyOn(fsApi, "stat")
    .mockResolvedValueOnce({ path: "/repo/link", name: "link", kind: "symlink", target: "../target" } as FsStatResult)
    .mockResolvedValueOnce({ path: "/target", name: "target", kind } as FsStatResult);
  const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("file-tab");
  const folder = spyOn(explorer, "openExplorer").mockResolvedValue("explorer");
  const view = await mount(<MarkdownRenderer content="[link](/repo/link)" />);
  try {
    await click(view.container.querySelector("a"));
    expect(stat).toHaveBeenNthCalledWith(2, "/repo/../target");
    if (kind === "directory") {
      expect(folder).toHaveBeenCalledWith("/target");
      expect(open).not.toHaveBeenCalled();
    } else {
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ metadata: { filePath: "/target" } }));
    }
  } finally {
    await view.unmount(); stat.mockRestore(); open.mockRestore(); folder.mockRestore();
  }
});

it("stops symlink cycles and opens search", async () => {
  const stat = spyOn(fsApi, "stat").mockResolvedValue({ path: "/repo/link", name: "link", kind: "symlink", target: "link" } as FsStatResult);
  const search = spyOn(palette, "openCommandPalette").mockImplementation(() => {});
  const view = await mount(<MarkdownRenderer content="[link](/repo/link)" />);
  try {
    await click(view.container.querySelector("a"));
    expect(stat).toHaveBeenCalledTimes(9);
    expect(search).toHaveBeenCalledWith("/repo/link");
  } finally {
    await view.unmount(); stat.mockRestore(); search.mockRestore();
  }
});
