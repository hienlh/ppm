/**
 * The conflict editor measures its container before it mounts Monaco, and the
 * container only exists once the file has loaded — the first render is a
 * spinner. A measuring effect that ran once on mount found no container, so
 * the height stayed unset and the editor never appeared: every conflict opened
 * as an empty pane headed "All conflicts resolved".
 */
import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("mounts the editor once the file has loaded", () => {
  // Module mocks stay in a child process so other suites keep the real Monaco wrapper.
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { installDom, installGlobal } from "./tests/helpers/react-dom";
    installDom();
    // happy-dom lays nothing out, so its own observer never reports a size.
    installGlobal("ResizeObserver", class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback([{ contentRect: { height: 480 } }]); }
      disconnect() {}
    });
    globalThis.fetch = async () =>
      Response.json({ ok: true, data: { content: "<<<<<<< HEAD\\nours\\n=======\\ntheirs\\n>>>>>>> side\\n" } });
    const React = await import("react");
    mock.module("@monaco-editor/react", () => ({
      default: (props) => React.createElement("div", { "data-editor-height": String(props.height) }),
      loader: { config() {}, init: async () => ({}) },
    }));
    const { createRoot } = await import("react-dom/client");
    const { ConflictEditor } = await import("./src/web/components/editor/conflict-editor");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const metadata = { projectName: "demo", filePath: "src/icons.ts" };
    await React.act(async () => { root.render(React.createElement(ConflictEditor, { metadata })); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const editor = container.querySelector("[data-editor-height]");
    assert.ok(editor, "the editor never mounted: " + container.textContent);
    assert.equal(editor.getAttribute("data-editor-height"), "480");
    await React.act(async () => { root.unmount(); });
  `], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
