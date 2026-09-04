/**
 * The host-resize signal exists because the main window's observers are late (xterm) or
 * silent (Monaco) for a size driven by a PiP window.
 *
 * Two properties carry the whole design and are asserted here: the event is dispatched
 * on every `[data-tab-pool-id]` wrapper *inside* the slot, and it does NOT bubble —
 * the slot is an ancestor of those wrappers, so an upward event dispatched on the slot
 * would never reach them.
 */
import { describe, it, expect } from "bun:test";
import {
  HOST_RESIZE_EVENT,
  onHostResize,
  signalHostResize,
} from "../../../src/web/components/floating-window/pip/pip-resize-signal.ts";

/** A wrapper that records the events dispatched on it. */
function fakeWrapper() {
  const events: Event[] = [];
  return {
    events,
    dispatchEvent(event: Event) {
      events.push(event);
      return true;
    },
  };
}

/** A slot that answers `querySelectorAll` with fixed wrappers, recording the selector. */
function fakeSlot(wrappers: ReturnType<typeof fakeWrapper>[]) {
  const selectors: string[] = [];
  return {
    selectors,
    querySelectorAll(selector: string) {
      selectors.push(selector);
      return wrappers;
    },
  };
}

describe("signalHostResize", () => {
  it("targets the pooled tab wrappers inside the slot", () => {
    const slot = fakeSlot([]);
    signalHostResize(slot as unknown as Element);
    expect(slot.selectors).toEqual(["[data-tab-pool-id]"]);
  });

  it("dispatches a non-bubbling ppm:host-resize on every wrapper", () => {
    const a = fakeWrapper();
    const b = fakeWrapper();
    signalHostResize(fakeSlot([a, b]) as unknown as Element);

    for (const wrapper of [a, b]) {
      expect(wrapper.events).toHaveLength(1);
      expect(wrapper.events[0]!.type).toBe("ppm:host-resize");
      // The slot is an ANCESTOR of the wrappers — a bubbling event would go the wrong way.
      expect(wrapper.events[0]!.bubbles).toBe(false);
    }
  });

  it("exports the event name it dispatches, so subscribers cannot drift", () => {
    const wrapper = fakeWrapper();
    signalHostResize(fakeSlot([wrapper]) as unknown as Element);
    expect(wrapper.events[0]!.type).toBe(HOST_RESIZE_EVENT);
  });

  it("is a no-op for a missing slot", () => {
    expect(() => signalHostResize(null)).not.toThrow();
    expect(() => signalHostResize(undefined)).not.toThrow();
  });
});

describe("onHostResize", () => {
  it("subscribes on the wrapper the container lives in, and unsubscribes symmetrically", () => {
    const added: [string, unknown][] = [];
    const removed: [string, unknown][] = [];
    const wrapper = {
      addEventListener: (type: string, fn: unknown) => added.push([type, fn]),
      removeEventListener: (type: string, fn: unknown) => removed.push([type, fn]),
    };
    const container = { closest: (selector: string) => (selector === "[data-tab-pool-id]" ? wrapper : null) };
    const handler = () => {};

    const unsubscribe = onHostResize(container as unknown as Element, handler);

    expect(added).toEqual([[HOST_RESIZE_EVENT, handler]]);
    unsubscribe();
    expect(removed).toEqual([[HOST_RESIZE_EVENT, handler]]);
  });

  it("returns a harmless no-op when the element is not inside a pooled tab", () => {
    const container = { closest: () => null };
    const unsubscribe = onHostResize(container as unknown as Element, () => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it("returns a harmless no-op for a missing container", () => {
    expect(() => onHostResize(null, () => {})()).not.toThrow();
    expect(() => onHostResize(undefined, () => {})()).not.toThrow();
  });
});
