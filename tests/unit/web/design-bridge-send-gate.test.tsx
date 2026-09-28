/**
 * `useDesignBridge`'s send gate: not the accept-side predicate (already covered by
 * `design-bridge-accept.test.ts`), but the wiring that must actually stop `send()` from
 * reaching `postMessage` while the frame looks dead, and must never put a nonce on the wire
 * for a foreign page to echo back.
 *
 * A frame that has fired `load` without yet posting `ready` might already be showing a page
 * it navigated itself to. If the parent kept sending during that window, a script running in
 * that foreign page could observe a leaked nonce and forge its own `ready` to the parent.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { useRef, type RefObject } from "react";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { useDesignBridge } = await import("../../../src/web/components/design/canvas/use-design-bridge.ts");
type DesignBridge = import("../../../src/web/components/design/canvas/use-design-bridge.ts").DesignBridge;

const NONCE = "abcdefghijklmnop1234";

/** Captures the latest bridge on every render, since the hook's return value is memoized. */
function Harness({ win, capture }: { win: { postMessage(message: unknown, origin: string): void }; capture: (b: DesignBridge) => void }) {
  // A stable ref (identity survives re-renders) standing in for the iframe: the hook only
  // ever reads `.current?.contentWindow`.
  const iframeRef = useRef({ contentWindow: win }) as unknown as RefObject<HTMLIFrameElement | null>;
  const bridge = useDesignBridge(iframeRef, NONCE, () => {});
  capture(bridge);
  return null;
}

describe("useDesignBridge send gate", () => {
  it("blocks sends once the frame has loaded without saying ready, and never sends a nonce", async () => {
    const posted: unknown[] = [];
    const win = { postMessage: (message: unknown) => posted.push(message) };
    let bridge!: DesignBridge;
    const view = await mount(<Harness win={win} capture={(b) => { bridge = b; }} />);
    try {
      // Before any `load` fired at all, nothing has had a chance to navigate away yet.
      expect(bridge.send({ type: "restore-scroll", x: 0, y: 0 })).toBe(true);
      expect(posted).toEqual([{ ppm: "design-bridge", v: 1, nonce: null, type: "restore-scroll", x: 0, y: 0 }]);

      posted.length = 0;
      bridge.frameLoaded(); // `load` fired; `ready` has not arrived for this nonce yet
      expect(bridge.send({ type: "restore-scroll", x: 1, y: 1 })).toBe(false);
      expect(posted).toHaveLength(0);

      // The real document proves itself: sends resume, still with no nonce to leak.
      const { act } = await import("react");
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", {
          data: {
            ppm: "design-bridge", v: 1, nonce: NONCE, type: "ready",
            gen: "0123456789abcdef", cssGens: {}, file: "index.html", instrumented: true, title: "t", docHeight: 0,
          },
          source: win as unknown as Window,
        }));
      });
      expect(bridge.ready).not.toBeNull();
      expect(bridge.send({ type: "restore-scroll", x: 2, y: 2 })).toBe(true);
      expect(posted).toEqual([{ ppm: "design-bridge", v: 1, nonce: null, type: "restore-scroll", x: 2, y: 2 }]);
    } finally {
      await view.unmount();
    }
  });
});
