import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { HTML_PREVIEW_BRIDGE_JS } from "../../../src/services/design/bridge/html-preview-bridge.ts";

/**
 * The HTML preview's iframe has an opaque origin, where reading `window.localStorage` throws.
 * A page that reads it on its first line then renders nothing. The real assembled preview
 * bridge runs here in a happy-dom window whose storage getters throw the way a sandboxed
 * frame's do, and the page's own code must then find working stores.
 */

const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

function boot({ refuse }: { refuse: boolean }) {
  const win = new Window({ url: "http://localhost:3214/api/html-preview/content/tok/index.html" });
  open.push(win);
  Object.defineProperty(win, "parent", { value: { postMessage: () => {} }, configurable: true });
  if (refuse) {
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(win, name, {
        configurable: true,
        get() { throw new Error(`Failed to read the '${name}' property from 'Window': The document is sandboxed`); },
      });
    }
  }
  win.document.write("<!doctype html><html><head></head><body></body></html>");
  new Function("window", HTML_PREVIEW_BRIDGE_JS)(win);
  const w = win as unknown as { localStorage: Storage; sessionStorage: Storage };
  return { win, w };
}

describe("HTML preview web storage", () => {
  it("gives a sandboxed page a localStorage it can read and write", () => {
    const { w } = boot({ refuse: true });
    const store = w.localStorage;
    expect(store.getItem("pen.lang")).toBeNull();
    store.setItem("pen.lang", "vi");
    store.setItem("n", 3 as unknown as string);
    expect(store.getItem("pen.lang")).toBe("vi");
    expect(store.getItem("n")).toBe("3");
    expect(store.length).toBe(2);
    expect(store.key(0)).toBe("pen.lang");
    expect(store.key(5)).toBeNull();
    store.removeItem("n");
    expect(store.length).toBe(1);
    store.clear();
    expect(store.length).toBe(0);
  });

  it("honours property access the way a real Storage does", () => {
    const { w } = boot({ refuse: true });
    const store = w.localStorage as unknown as Record<string, unknown>;
    store.theme = "dark";
    expect(w.localStorage.getItem("theme")).toBe("dark");
    expect(store.missing).toBeUndefined();
    expect("theme" in store).toBe(true);
    expect(Object.keys(store)).toEqual(["theme"]);
    delete store.theme;
    expect(w.localStorage.getItem("theme")).toBeNull();
  });

  it("keeps the two stores apart", () => {
    const { w } = boot({ refuse: true });
    w.sessionStorage.setItem("k", "session");
    expect(w.localStorage.getItem("k")).toBeNull();
  });

  it("leaves a store the frame can reach untouched", () => {
    const win = new Window({ url: "http://localhost:3214/x.html" });
    open.push(win);
    const before = (win as unknown as { localStorage: Storage }).localStorage;
    Object.defineProperty(win, "parent", { value: { postMessage: () => {} }, configurable: true });
    win.document.write("<!doctype html><html><head></head><body></body></html>");
    new Function("window", HTML_PREVIEW_BRIDGE_JS)(win);
    expect((win as unknown as { localStorage: Storage }).localStorage).toBe(before);
  });
});
