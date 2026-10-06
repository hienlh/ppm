/**
 * A terminal mounted with no layout (the dock's active tab while the dock is hidden, every dock
 * terminal on a phone) gets FitAddon's floor of 2x1, and the size the hook sends next goes to
 * the shell — where zsh with a themed prompt corrupts its heap (src/shared/terminal-size.ts).
 * The server drops such a resize too, but the hook is where the size is made, so this mounts the
 * real `useTerminal` and reads what it sends.
 */
import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

/** Mount `useTerminal` in a container FitAddon measures at `cols` x `rows`; report what it did. */
function mountTerminal(cols: number, rows: number): { fits: number; resizes: string[] } {
  // Module mocks stay in a child process so other suites keep the real xterm.
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import { installDom, installGlobal } from "./tests/helpers/react-dom";
    installDom();
    Object.defineProperty(document, "fonts", { configurable: true, value: {
      ready: Promise.resolve(), addEventListener() {}, removeEventListener() {},
    } });
    // happy-dom lays nothing out, so its own observer never reports a size.
    installGlobal("ResizeObserver", class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback([{ contentRect: { width: 300, height: 200 } }]); }
      disconnect() {}
    });
    const sent = [];
    installGlobal("WebSocket", class {
      static OPEN = 1;
      readyState = 0;
      constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { sent.push(String(data)); }
      close() {}
    });
    let fits = 0;
    class Terminal {
      cols = 80; rows = 24; options = {}; buffer = { active: { baseY: 0, cursorY: 0, getLine() {} } };
      loadAddon(addon) { addon.activate?.(this); }
      open() {}
      onData() {}
      resize(cols, rows) { this.cols = cols; this.rows = rows; }
      clear() {} write() {} dispose() {} refresh() {} clearTextureAtlas() {}
    }
    // What FitAddon does: propose from the container's layout, then resize the terminal to it.
    class FitAddon {
      activate(term) { this.term = term; }
      proposeDimensions() { return { cols: ${cols}, rows: ${rows} }; }
      fit() { fits++; const dims = this.proposeDimensions(); this.term.resize(dims.cols, dims.rows); }
      dispose() {}
    }
    class Inert { activate() {} dispose() {} onContextLoss() {} }
    mock.module("@xterm/xterm", () => ({ Terminal }));
    mock.module("@xterm/addon-fit", () => ({ FitAddon }));
    mock.module("@xterm/addon-web-links", () => ({ WebLinksAddon: Inert }));
    mock.module("@xterm/addon-webgl", () => ({ WebglAddon: Inert }));
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useTerminal } = await import("./src/web/hooks/use-terminal");
    function Probe() {
      const ref = React.useRef(null);
      useTerminal({ sessionId: "new", projectName: "demo", containerRef: ref });
      return React.createElement("div", { ref });
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await React.act(async () => { root.render(React.createElement(Probe)); });
    // Past the socket opening and the ResizeObserver's settle delay.
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    await React.act(async () => { root.unmount(); });
    console.log(JSON.stringify({ fits, resizes: sent.filter((m) => m.startsWith("\\x01RESIZE:")).map((m) => m.slice(8)) }));
  `], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    // The child keeps this run's throwaway PPM_HOME; Bun hands a child the environment the
    // process started with, not what the test setup wrote into it since.
    env: { ...process.env },
    stdout: "pipe", stderr: "pipe",
  });
  const stderr = result.stderr.toString();
  expect(stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

it("does not fit a terminal with no layout to FitAddon's 2x1, so the shell never gets that size", () => {
  const { fits, resizes } = mountTerminal(2, 1);
  expect(fits).toBe(0);
  expect(resizes.length).toBeGreaterThan(0);
  expect(resizes).not.toContain("2,1");
  expect(resizes.every((size) => size === "80,24")).toBe(true);
});

it("fits a terminal that has a size, and sends that size", () => {
  const { fits, resizes } = mountTerminal(120, 30);
  expect(fits).toBeGreaterThan(0);
  expect(resizes.length).toBeGreaterThan(0);
  expect(resizes.every((size) => size === "120,30")).toBe(true);
});
