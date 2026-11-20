/**
 * Paths in an AI answer become links only after the server has checked them, in one request for
 * the whole message and never while it streams: a folder opens the file browser, a refused or
 * missing path stays plain text, in prose and in an inline code span alike.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
import type { FileBrowserLocateEntry } from "../../../src/shared/file-browser-target";

installDom();
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
const { api } = await import("../../../src/web/lib/api-client");
const locate = await import("../../../src/web/lib/file-browser-locate");
const explorer = await import("../../../src/web/components/os-explorer/open-explorer");
afterAll(uninstallDom);
afterEach(() => locate.resetLocateVerdicts());

const FOLDER = "D:\\tiktok\\story-2026-11-19-london";
const SECRET = "C:\\Users\\PC\\.ssh\\id_rsa";
const MISSING = "~/nope/never";

function answer(input: string): FileBrowserLocateEntry {
  if (input === FOLDER) return { input, ok: true, kind: "folder", dir: FOLDER, select: null };
  return { input, ok: false, error: input === SECRET ? "is where logins or keys are kept" : `There is nothing at ${input}.` };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("paths in rendered Markdown", () => {
  it("asks once for the whole message and links only what the server allowed", async () => {
    const post = spyOn(api, "post").mockImplementation(async (_path: string, body: any) => ({ results: body.paths.map(answer) }) as never);
    const view = await mount(<MarkdownRenderer projectName="ppm" content={`Saved to ${FOLDER} and \`${SECRET}\`, not ${MISSING}.`} />);
    try {
      await settle();
      expect(post).toHaveBeenCalledTimes(1);
      expect((post.mock.calls[0]![1] as { paths: string[] }).paths.sort()).toEqual([FOLDER, MISSING, SECRET].sort());
      const links = [...view.container.querySelectorAll("[data-local-path]")];
      expect(links.map((l) => l.textContent)).toEqual([FOLDER]);
      expect(view.container.textContent).toContain(SECRET);
      expect(view.container.textContent).toContain(MISSING);
      expect(view.container.querySelector("code")?.getAttribute("data-local-path")).toBeNull();
    } finally {
      await view.unmount();
      post.mockRestore();
    }
  });

  it("opens the file browser at a folder, checking it again on the tap", async () => {
    const post = spyOn(api, "post").mockImplementation(async (_path: string, body: any) => ({ results: body.paths.map(answer) }) as never);
    const open = spyOn(explorer, "openExplorer").mockResolvedValue("w1");
    const view = await mount(<MarkdownRenderer projectName="ppm" content={`Open \`${FOLDER}\``} />);
    try {
      await settle();
      const code = view.container.querySelector("code[data-local-path='folder']")!;
      expect(code).not.toBeNull();
      await click(code);
      await settle();
      expect(post).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledWith(FOLDER, { select: null });
    } finally {
      await view.unmount();
      post.mockRestore();
      open.mockRestore();
    }
  });

  it("asks nothing while the message is still streaming", async () => {
    const post = spyOn(api, "post").mockImplementation(async () => ({ results: [] }) as never);
    const view = await mount(<MarkdownRenderer projectName="ppm" isStreaming content={`Saved to ${FOLDER}`} />);
    try {
      await settle();
      expect(post).not.toHaveBeenCalled();
      expect(view.container.querySelector("[data-local-path]")).toBeNull();
    } finally {
      await view.unmount();
      post.mockRestore();
    }
  });
});
