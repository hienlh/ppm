/**
 * A chat's shell code block — tagged, or an untagged one-line command — offers Copy, Run (output
 * shown under the block) and Run in terminal (typed and run); a code block that is not a command
 * offers Copy only.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";

installDom();
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
const { api } = await import("../../../src/web/lib/api-client");
const terminal = await import("../../../src/web/lib/run-in-terminal");
afterAll(uninstallDom);

const titles = (root: Element) => [...root.querySelectorAll(".code-actions button")].map((b) => b.getAttribute("title"));
const fence = "```";

describe("code block Run buttons", () => {
  it("an untagged command gets Copy, Run and Run in terminal", async () => {
    const view = await mount(<MarkdownRenderer codeActions projectName="ppm" content={`${fence}\ngrep '^MASTER_PASSWORD=' .env\n${fence}`} />);
    try {
      expect(titles(view.container)).toEqual(["Copy", "Run (output below)", "Run in terminal"]);
    } finally {
      await view.unmount();
    }
  });

  it("a code block that is not a command gets Copy only", async () => {
    const view = await mount(<MarkdownRenderer codeActions projectName="ppm" content={`${fence}ts\nconst x = 1;\n${fence}`} />);
    try {
      expect(titles(view.container)).toEqual(["Copy"]);
    } finally {
      await view.unmount();
    }
  });

  it("Run posts the command and shows what it printed under the block", async () => {
    const post = spyOn(api, "post").mockResolvedValue({ output: "MASTER_PASSWORD=x\n", exitCode: 0, timedOut: false, stopped: false, durationMs: 42 } as never);
    const view = await mount(<MarkdownRenderer codeActions projectName="ppm" content={`${fence}bash\n$ grep '^MASTER_PASSWORD=' .env\n${fence}`} />);
    try {
      await click(view.container.querySelector('[title="Run (output below)"]'));
      await Bun.sleep(0);
      expect(post).toHaveBeenCalledWith("/api/project/ppm/shell/run", { command: "grep '^MASTER_PASSWORD=' .env" }, expect.anything());
      const out = view.container.querySelector('[data-code-block-run="done"]');
      expect(out?.textContent).toContain("MASTER_PASSWORD=x");
      expect(out?.textContent).toContain("Exit 0");
    } finally {
      await view.unmount();
      post.mockRestore();
    }
  });

  it("Run in terminal types the command and presses Enter", async () => {
    const run = spyOn(terminal, "runInTerminal").mockImplementation(() => {});
    const view = await mount(<MarkdownRenderer codeActions projectName="ppm" content={`${fence}\ngit status\n${fence}`} />);
    try {
      await click(view.container.querySelector('[title="Run in terminal"]'));
      expect(run).toHaveBeenCalledWith(expect.stringMatching(/^git status\s*$/), "ppm", { execute: true });
    } finally {
      await view.unmount();
      run.mockRestore();
    }
  });
});
