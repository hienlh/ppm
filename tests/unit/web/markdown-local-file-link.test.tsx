import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownUrlTransform, parseMarkdownFileTarget } from "../../../src/web/components/shared/markdown-context.ts";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
import type { FsStatResult } from "../../../src/web/lib/fs-api";

installDom();
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
const { fsApi } = await import("../../../src/web/lib/fs-api");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useFileStore } = await import("../../../src/web/stores/file-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const explorer = await import("../../../src/web/components/os-explorer/open-explorer");
const palette = await import("../../../src/web/hooks/use-global-keybindings");
const entry = (path: string, kind = "file") => ({ path, name: path.split("/").filter(Boolean).pop(), kind } as FsStatResult);
afterAll(uninstallDom);

describe("Markdown local file links", () => {
  it.each([
    ["/C:/Users/PC/ppm/src/types/config.ts:136", "C:/Users/PC/ppm/src/types/config.ts", 136, undefined],
    ["C:/repo/config.ts:10-12", "C:/repo/config.ts", 10, 12],
    ["/repo/config.ts#L10-L12", "/repo/config.ts", 10, 12],
    ["src/config.ts:136", "src/config.ts", 136, undefined],
    ["config.ts:136", "config.ts", 136, undefined],
    ["/C:/My%20Project/config.ts:3", "C:/My Project/config.ts", 3, undefined],
    ["./README.md", "./README.md", undefined, undefined],
  ])("resolves %s", (href, path, start, end) => {
    expect(parseMarkdownFileTarget(href as string)).toEqual({ path, line: start ? { start, end } : undefined });
  });

  it.each(["https://example.com/config.ts:136", "//example.com/config.ts", "mailto:user@example.ts", "javascript:foo.ts", "src/*.ts", "#section"])("does not intercept %s", (href) => {
    expect(parseMarkdownFileTarget(href)).toBeNull();
  });

  it("opens the screenshot's Codex link in an editor tab at the requested line", async () => {
    const get = spyOn(fsApi, "stat").mockResolvedValue(entry("C:/Users/PC/ppm/src/types/config.ts"));
    const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("file-tab");
    const update = spyOn(useTabStore.getState(), "updateTab").mockImplementation(() => {});
    const view = await mount(<MarkdownRenderer projectName="ppm" content="[src/types/config.ts:136](/C:/Users/PC/ppm/src/types/config.ts:136)" />);
    try {
      const anchor = view.container.querySelector("a")!;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor.dispatchEvent(event);
      await Promise.resolve();
      expect(event.defaultPrevented).toBe(true);
      expect(get).toHaveBeenCalledWith("C:/Users/PC/ppm/src/types/config.ts");
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ type: "editor", metadata: expect.objectContaining({ filePath: "C:/Users/PC/ppm/src/types/config.ts", lineNumber: 136 }) }));
      expect(update).toHaveBeenCalled();
    } finally {
      await view.unmount();
      get.mockRestore(); open.mockRestore(); update.mockRestore();
    }
  });

  it("opens a bare filename with a line number from the project tree", async () => {
    const tree = useFileStore.getState().tree;
    const projects = useProjectStore.getState().projects;
    useProjectStore.setState({ projects: [{ name: "ppm", path: "/repo" }] });
    const stat = spyOn(fsApi, "stat").mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValue(entry("/repo/src/config.ts"));
    useFileStore.setState({ tree: [{ name: "config.ts", path: "src/config.ts", type: "file" }] });
    const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("file-tab");
    const update = spyOn(useTabStore.getState(), "updateTab").mockImplementation(() => {});
    const view = await mount(<MarkdownRenderer projectName="ppm" content="[config.ts](config.ts:136)" />);
    try {
      const anchor = view.container.querySelector("a")!;
      expect(anchor.getAttribute("href")).toBe("config.ts:136");
      await click(anchor);
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ type: "editor", projectId: "ppm", metadata: expect.objectContaining({ filePath: "src/config.ts", lineNumber: 136 }) }));
    } finally {
      await view.unmount();
      open.mockRestore(); update.mockRestore();
      useFileStore.setState({ tree });
      stat.mockRestore();
      useProjectStore.setState({ projects });
    }
  });

  it.each([
    ["/Users/dev/project/Dockerfile", "/Users/dev/project/Dockerfile", "file"],
    ["/home/dev/project/.gitignore", "/home/dev/project/.gitignore", "file"],
    ["file:///C:/My%20Project/docs/", "C:/My Project/docs/", "directory"],
    ["file:///home/dev/readme.custom", "/home/dev/readme.custom", "file"],
    ["~/Documents", "~/Documents", "directory"],
    ["src/routes/[slug]/page.tsx", "/repo/src/routes/[slug]/page.tsx", "file"],
    ["docs", "/repo/docs", "directory"],
    ["../shared", "/repo/../shared", "directory"],
  ])("click routes %s using host metadata", async (href, path, kind) => {
    const projects = useProjectStore.getState().projects;
    useProjectStore.setState({ projects: [{ name: "ppm", path: "/repo" }] });
    const stat = spyOn(fsApi, "stat").mockResolvedValue(entry(path, kind));
    const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("file-tab");
    const folder = spyOn(explorer, "openExplorer").mockResolvedValue("explorer");
    const view = await mount(<MarkdownRenderer projectName="ppm" content={`[open](<${href}>)`} />);
    try {
      await click(view.container.querySelector("a"));
      expect(stat).toHaveBeenCalledWith(path);
      if (kind === "directory") {
        expect(folder).toHaveBeenCalledWith(path);
        expect(open).not.toHaveBeenCalled();
      } else {
        const inProject = path.startsWith("/repo/");
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ type: "editor", projectId: inProject ? "ppm" : null, metadata: expect.objectContaining({ filePath: inProject ? path.slice(6) : path }) }));
        expect(folder).not.toHaveBeenCalled();
      }
    } finally {
      await view.unmount(); stat.mockRestore(); open.mockRestore(); folder.mockRestore();
      useProjectStore.setState({ projects });
    }
  });

  it("searches missing explicit paths without opening an unrelated basename", async () => {
    const stat = spyOn(fsApi, "stat").mockRejectedValue(new Error("missing"));
    const search = spyOn(palette, "openCommandPalette").mockImplementation(() => {});
    const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("file-tab");
    const view = await mount(<MarkdownRenderer content="[missing](/missing/config.ts)" />);
    try {
      await click(view.container.querySelector("a"));
      expect(search).toHaveBeenCalledWith("/missing/config.ts");
      expect(open).not.toHaveBeenCalled();
    } finally {
      await view.unmount(); stat.mockRestore(); search.mockRestore(); open.mockRestore();
    }
  });

  it("preserves an absolute Windows file path for the editor link handler", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown urlTransform={markdownUrlTransform}>
        {"[Báo cáo và timeline](D:/Projects/nxsys/plans/NX-5886/diagnosis.md)"}
      </ReactMarkdown>,
    );

    expect(html).toContain('href="D:/Projects/nxsys/plans/NX-5886/diagnosis.md"');
  });

  it("continues to strip unsafe URL schemes", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown urlTransform={markdownUrlTransform}>{"[x](javascript:alert(1))"}</ReactMarkdown>,
    );

    expect(html).toContain('href=""');
  });
});
