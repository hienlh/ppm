/**
 * What PPM does with a link a preview hands over: a PPM address opens as a PPM tab, anything
 * else on the web in a browser tab, and nothing at all without a click behind it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { openPreviewLink } = await import("../../../src/web/lib/open-preview-link");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");

let opened: Array<{ url: string; features: string }> = [];
let active = true;
const realOpen = window.open;

beforeEach(() => {
  opened = [];
  active = true;
  window.open = ((url?: string | URL, _target?: string, features?: string) => {
    opened.push({ url: String(url), features: String(features) });
    return null;
  }) as typeof window.open;
  Object.defineProperty(navigator, "userActivation", { value: { get isActive() { return active; } }, configurable: true });
  useProjectStore.setState({ projects: [{ name: "Nxsys", path: "D:/Projects/nxsys" }] as never });
  useTabStore.getState().switchProject("Nxsys");
});
afterEach(() => { window.open = realOpen; });

describe("openPreviewLink", () => {
  it("opens a PPM chat address as a chat tab in that project", async () => {
    const id = "d9c6812f-8b89-4479-9795-ec7735c5aa6b";
    expect(openPreviewLink(`${location.origin}/project/Nxsys/chat/claude/${id}`)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const tab = useTabStore.getState().tabs.find((t) => t.type === "chat");
    expect(tab?.metadata).toMatchObject({ sessionId: id, providerId: "claude", projectName: "Nxsys" });
    expect(opened).toEqual([]);
  });

  it("opens another site in a browser tab, without an opener or referrer", () => {
    expect(openPreviewLink("https://github.com/hienlh/ppm/pull/1")).toBe(true);
    expect(opened).toEqual([{ url: "https://github.com/hienlh/ppm/pull/1", features: "noopener,noreferrer" }]);
  });

  it("opens nothing without a click behind it", () => {
    active = false;
    expect(openPreviewLink("https://github.com/hienlh/ppm/pull/1")).toBe(false);
    expect(openPreviewLink(`${location.origin}/project/Nxsys/chat/claude/x`)).toBe(false);
    expect(opened).toEqual([]);
  });

  it("refuses an address that is not on the web", () => {
    expect(openPreviewLink("javascript:alert(1)")).toBe(false);
    expect(openPreviewLink("file:///C:/Windows/win.ini")).toBe(false);
    expect(opened).toEqual([]);
  });
});
