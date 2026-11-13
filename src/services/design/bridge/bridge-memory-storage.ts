import type { BridgeApi } from "./bridge-core.ts";

/**
 * Gives the HTML file preview a `localStorage` and `sessionStorage` that work.
 *
 * The preview's iframe is `sandbox="allow-scripts"` with no `allow-same-origin`, so the page
 * has an opaque origin and merely *reading* `window.localStorage` throws a SecurityError.
 * A page that remembers a setting at the top of its script (a docs site keeping the reader's
 * language, a theme toggle) therefore died on its first line and rendered blank. The bridge
 * runs first in `<head>`, so when the real store is refused it puts an in-memory one in its
 * place: the page runs, and what it saves lasts until the frame reloads. Where the real
 * store is reachable nothing is replaced.
 *
 * Both method calls and property access (`localStorage.theme = "dark"`) are honoured, as
 * they are on a real `Storage`. Shipped as source like the core, so it may only use what it
 * is handed in `ppm`.
 */
export function installMemoryStorage(ppm: BridgeApi): void {
  const win = ppm.win as unknown as Record<string, unknown>;

  function memoryStorage(): Storage {
    const items = new Map<string, string>();
    const methods: Record<string, unknown> = {
      getItem: (key: unknown) => (items.has(String(key)) ? items.get(String(key)) : null),
      setItem: (key: unknown, value: unknown) => { items.set(String(key), String(value)); },
      removeItem: (key: unknown) => { items.delete(String(key)); },
      clear: () => { items.clear(); },
      key: (index: number) => { const keys = Array.from(items.keys()); return index >= 0 && index < keys.length ? keys[index] : null; },
    };
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "length") return items.size;
        if (typeof prop !== "string") return undefined;
        if (Object.prototype.hasOwnProperty.call(methods, prop)) return methods[prop];
        return items.has(prop) ? items.get(prop) : undefined;
      },
      set(_target, prop, value) {
        if (typeof prop === "string") items.set(prop, String(value));
        return true;
      },
      has(_target, prop) {
        return typeof prop === "string" && (items.has(prop) || Object.prototype.hasOwnProperty.call(methods, prop) || prop === "length");
      },
      deleteProperty(_target, prop) {
        if (typeof prop === "string") items.delete(prop);
        return true;
      },
      ownKeys() {
        return Array.from(items.keys());
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop !== "string" || !items.has(prop)) return undefined;
        return { value: items.get(prop), writable: true, enumerable: true, configurable: true };
      },
    }) as unknown as Storage;
  }

  for (const name of ["localStorage", "sessionStorage"]) {
    let refused = false;
    try {
      void win[name];
    } catch (e) {
      refused = true;
    }
    if (!refused) continue;
    try {
      Object.defineProperty(win, name, { value: memoryStorage(), configurable: true, enumerable: true, writable: false });
    } catch (e) {
      // Nothing better to offer: the page meets the browser's own refusal, reported as usual.
    }
  }
}
