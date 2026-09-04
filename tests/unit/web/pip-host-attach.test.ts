/**
 * `attachPipHost` up to the point where it commits to moving the slot.
 *
 * The interesting case is the race: `requestWindow()` is async, and the floating window
 * can be closed while it is pending — its body unmounts, the tab is re-docked and the
 * slot leaves the document. Moving it then would hand an orphaned subtree to a PiP
 * window nobody owns and register a handle under a dead window id.
 *
 * Only the paths that return before the DOM move are covered; the move itself needs a
 * real document.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { attachPipHost } from "../../../src/web/components/floating-window/pip/pip-host.ts";

interface FakeSlot {
  isConnected: boolean;
  parentElement: object | null;
}

/** A slot sitting in a parent, as it is at click time. */
function fakeSlot(): FakeSlot & { origin: object } {
  const origin = { id: "window-body" };
  return { isConnected: true, parentElement: origin, origin };
}

/** Install a `documentPictureInPicture` whose requestWindow resolves after `onPending`. */
function installPipApi(onPending: () => void) {
  const pipWindow = { closed: false, close() { this.closed = true; } };
  const api = {
    window: null,
    async requestWindow() {
      onPending();
      return pipWindow as unknown as Window;
    },
  };
  (globalThis as { window?: unknown }).window = { documentPictureInPicture: api };
  return pipWindow;
}

let hadWindow: boolean;
let previousWindow: unknown;

beforeEach(() => {
  hadWindow = "window" in globalThis;
  previousWindow = (globalThis as { window?: unknown }).window;
});

afterEach(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow;
  else delete (globalThis as { window?: unknown }).window;
});

describe("attachPipHost", () => {
  it("rejects when the browser has no Document PiP API", async () => {
    delete (globalThis as { window?: unknown }).window;
    const slot = fakeSlot();
    await expect(attachPipHost(slot as unknown as HTMLElement, { width: 100, height: 100, onDetach: () => {} }))
      .rejects.toThrow(/not supported/i);
  });

  it("rejects a slot that is not in the document", async () => {
    installPipApi(() => {});
    const detaches: number[] = [];
    await expect(
      attachPipHost({ isConnected: true, parentElement: null } as unknown as HTMLElement, {
        width: 100, height: 100, onDetach: () => detaches.push(1),
      }),
    ).rejects.toThrow(/must be in the document/i);
    // Nothing was requested, so there is no optimistic state to clear.
    expect(detaches).toEqual([]);
  });

  it("reports the rejection when the request itself fails, after clearing the caller's state", async () => {
    const detaches: number[] = [];
    (globalThis as { window?: unknown }).window = {
      documentPictureInPicture: {
        window: null,
        requestWindow: () => Promise.reject(new Error("no transient activation")),
      },
    };
    const slot = fakeSlot();

    await expect(
      attachPipHost(slot as unknown as HTMLElement, { width: 100, height: 100, onDetach: () => detaches.push(1) }),
    ).rejects.toThrow("no transient activation");
    expect(detaches).toEqual([1]);
  });

  it("closes the PiP window and registers nothing when the slot left while pending", async () => {
    const slot = fakeSlot();
    // The window's × is clicked while requestWindow() is in flight.
    const pipWindow = installPipApi(() => {
      slot.isConnected = false;
      slot.parentElement = null;
    });
    const detaches: number[] = [];

    const handle = await attachPipHost(slot as unknown as HTMLElement, {
      width: 400, height: 300, onDetach: () => detaches.push(1),
    });

    expect(handle).toBeNull();
    expect(pipWindow.closed).toBe(true);
    expect(detaches).toEqual([1]);
  });

  it("bails the same way when the slot was re-parented while pending", async () => {
    const slot = fakeSlot();
    // The body unmounted and remounted: same id, a different slot in a different parent.
    const pipWindow = installPipApi(() => {
      slot.parentElement = { id: "another-window-body" };
    });

    const handle = await attachPipHost(slot as unknown as HTMLElement, {
      width: 400, height: 300, onDetach: () => {},
    });

    expect(handle).toBeNull();
    expect(pipWindow.closed).toBe(true);
  });
});
