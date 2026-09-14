/**
 * A DOM to mount React components into, for the tests where the wiring *is* the
 * bug.
 *
 * The suite had none, and the gap has a shape: a handler gets extracted so its
 * decision can be asserted, the extracted function is covered, and the `onClick`
 * that calls it is not — so replacing the call with a comment leaves the suite
 * green. `renderToStaticMarkup` cannot close that, because it runs no effects
 * and dispatches no events; it can only say what the first paint looks like.
 *
 * happy-dom rather than jsdom, and it is cheap enough not to need rationing:
 * measured 87ms to import once per test process and 3ms per document after
 * that, so a suite that mounts a dozen components pays for the import and
 * almost nothing else.
 *
 * Globals are assigned before React is imported, not after. `react-dom/client`
 * reads `document` while its module body runs, so importing it first binds it to
 * a world with no DOM in it and every later render fails somewhere unhelpful.
 */
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window", "document", "navigator", "location", "history",
  "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent", "TouchEvent", "MessageEvent",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "localStorage", "sessionStorage", "matchMedia", "ResizeObserver", "IntersectionObserver",
  "DOMRect", "Image", "File", "Blob", "URL", "FormData",
] as const;

/**
 * happy-dom ships no `EventSource`, and a component that opens one does it in a
 * passive effect — so the mount throws where React reports it as a render
 * failure rather than as a missing API. Bun has a real one, which is worse
 * here: it would dial the test's own machine.
 *
 * It carries its own listener table rather than extending `EventTarget`.
 * There are two of those in scope — Bun's global and the one on the happy-dom
 * window — and `dispatchEvent` rejects an event from the other realm, so a stub
 * built on the global cannot be handed a `MessageEvent` from the installed DOM.
 *
 * Silent until a test feeds it. That is also the state the UI renders before the
 * first frame arrives, which is worth being able to assert on its own.
 */
class InertEventSource {
  static readonly instances: InertEventSource[] = [];
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    InertEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatchEvent(event: { type: string }): boolean {
    for (const cb of this.listeners.get(event.type) ?? []) cb(event);
    return true;
  }
  close(): void { this.readyState = 2; }
}

/** A stream the component under test opened. Dispatch on it to feed it a frame. */
export interface FakeEventSource {
  readonly url: string;
  readyState: number;
  dispatchEvent(event: { type: string; data?: string }): boolean;
  close(): void;
}

/** Every `EventSource` opened so far, in the order they were opened. */
export function eventSources(): FakeEventSource[] {
  return InertEventSource.instances;
}

/** Deliver one named SSE frame and flush what it caused. */
export async function emitServerEvent(source: FakeEventSource | undefined, type: string, data: unknown): Promise<void> {
  if (!source) throw new Error(`emitServerEvent(): no stream was opened`);
  const { act } = await import("react");
  // A plain object, not a `MessageEvent`: the listeners this feeds read `.data`
  // off it and nothing else, and constructing the real thing would reintroduce
  // the cross-realm problem the stub exists to avoid.
  await act(async () => {
    source.dispatchEvent({ type, data: JSON.stringify(data) });
  });
}

/** Install a DOM on `globalThis`. Safe to call from several test files. */
export function installDom(url = "http://localhost/"): void {
  if ((globalThis as Record<string, unknown>).__ppmDomInstalled) return;
  const w = new Window({ url });
  // A document with no doctype is in quirks mode, and libraries say so at
  // runtime rather than failing — KaTeX prints a warning into every test that
  // renders markdown. The doctype alone is not enough: happy-dom does not
  // implement `compatMode` at all, and the check is against its *value*, so an
  // absent property reads as quirks however the document was written.
  w.document.write("<!DOCTYPE html><html><head></head><body></body></html>");
  if ((w.document as unknown as { compatMode?: string }).compatMode === undefined) {
    Object.defineProperty(w.document, "compatMode", { value: "CSS1Compat", configurable: true });
  }
  for (const key of DOM_GLOBALS) {
    const value = (w as unknown as Record<string, unknown>)[key];
    if (value !== undefined) (globalThis as Record<string, unknown>)[key] = value;
  }
  // React refuses to run `act` without it, and without `act` a render is not
  // flushed before the assertions read the DOM. On both objects: React reads it
  // off the global scope, and once `window` is installed above that is a
  // different object from `globalThis` — setting only one leaves the warning in
  // place and the flag doing nothing.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (w as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  if ((w as unknown as Record<string, unknown>).EventSource === undefined) {
    (globalThis as Record<string, unknown>).EventSource = InertEventSource;
    (w as unknown as Record<string, unknown>).EventSource = InertEventSource;
  }
  (globalThis as Record<string, unknown>).__ppmDomInstalled = true;
}

export interface Mounted {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

/**
 * Render `element` into a detached container and flush it.
 *
 * Dynamic imports: see the note above about import order — a static
 * `import { createRoot }` at the top of this file would run before `installDom`.
 */
export async function mount(element: React.ReactNode): Promise<Mounted> {
  installDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/** Dispatch a real bubbling click and flush whatever it caused. */
export async function click(target: Element | null): Promise<void> {
  if (!target) throw new Error("click(): no element");
  const { act } = await import("react");
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
