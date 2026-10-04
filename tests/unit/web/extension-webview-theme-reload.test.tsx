/**
 * A panel's theme survives the panel being moved.
 *
 * The theme is seeded into `srcDoc` once, when the panel's HTML arrives, and later changes are
 * posted in — `srcDoc` is deliberately not rewritten, because that reloads the panel. But the tab
 * pool moves a tab's DOM with `appendChild` (a split, a tab dragged to another panel, the switch
 * between the desktop and phone layouts), and a moved iframe loads its document again from the
 * same `srcDoc`. After a theme change that brought back the theme of the moment the HTML arrived,
 * and nothing corrected it until the next theme change: the Git Graph stayed dark in a light app.
 *
 * Mounted for real; the frame's window is a stand-in, since happy-dom loads no frame documents.
 * A browser fires `load` on the iframe once the moved frame's new document has loaded, which is
 * what the test dispatches.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mount, type Mounted } from "../../helpers/react-dom.tsx";

const { ExtensionWebview } = await import("../../../src/web/components/extensions/extension-webview.tsx");
const { useExtensionStore } = await import("../../../src/web/stores/extension-store.ts");
const { THEME_CHANGE_EVENT } = await import("../../../src/web/theme/apply-theme.ts");
const { HOST_THEME_MESSAGE, readHostTheme } = await import("../../../src/web/components/extensions/webview-theme.ts");
const { act } = await import("react");

const root = document.documentElement;
let posted: unknown[] = [];
let view: Mounted | null = null;
let otherSlot: HTMLElement | null = null;

function setMode(mode: "light" | "dark"): void {
  root.classList.remove("light", "dark");
  root.classList.add(mode);
  root.style.setProperty("--accent", mode === "dark" ? "#5b7cfa" : "#3557d6");
}

beforeEach(() => {
  posted = [];
  setMode("light");
  useExtensionStore.setState({
    webviewPanels: {
      p1: {
        id: "p1",
        extensionId: "ext-git-graph",
        viewType: "git-graph.view",
        title: "Git Graph",
        html: "<!DOCTYPE html><html><head></head><body>graph</body></html>",
        projectName: "demo",
      },
    },
  });
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  otherSlot?.remove();
  otherSlot = null;
  root.classList.remove("light", "dark");
  root.style.removeProperty("--accent");
});

/** The mounted iframe, with a frame window that records what is posted into it. */
function frame(): HTMLIFrameElement {
  const iframe = view!.container.querySelector("iframe");
  if (!iframe) throw new Error("no iframe was rendered");
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: { postMessage: (message: unknown) => posted.push(message) },
  });
  return iframe;
}

describe("a panel's theme", () => {
  it("is told the current theme again when the tab pool moves it and it reloads", async () => {
    view = await mount(<ExtensionWebview metadata={{ panelId: "p1", viewType: "git-graph", projectName: "demo" }} />);
    const iframe = frame();
    expect(iframe.getAttribute("srcdoc")).toContain('data-ppm-theme="light"');

    // The user switches to dark: posted to the live document, srcDoc left alone.
    setMode("dark");
    await act(async () => {
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
    });
    expect(posted).toEqual([{ command: HOST_THEME_MESSAGE, ...readHostTheme(root) }]);
    expect(iframe.getAttribute("srcdoc")).toContain('data-ppm-theme="light"');

    // The tab is moved, as the tab pool moves its wrapper on a layout switch,
    // and the frame loads its document again from the light seed.
    posted = [];
    otherSlot = document.createElement("div");
    document.body.appendChild(otherSlot);
    await act(async () => {
      otherSlot!.appendChild(view!.container);
      iframe.dispatchEvent(new Event("load"));
    });

    expect(posted.at(-1)).toEqual({ command: HOST_THEME_MESSAGE, mode: "dark", css: readHostTheme(root).css });
  });
});
