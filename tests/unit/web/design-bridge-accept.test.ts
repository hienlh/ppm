import { describe, expect, it } from "bun:test";
import {
  acceptBridgeEvent, frameLooksDead, newBridgeNonce,
} from "../../../src/web/components/design/canvas/use-design-bridge";
import { BRIDGE_CHANNEL, BRIDGE_NONCE_RE, BRIDGE_VERSION } from "../../../src/shared/design-bridge-protocol";

const frame = { name: "frame window" };
const nonce = "abcdefghijklmnop1234";
const ready = (n: string | null) => ({
  ppm: BRIDGE_CHANNEL, v: BRIDGE_VERSION, nonce: n, type: "ready",
  gen: "0123456789abcdef", cssGens: {}, file: "index.html", instrumented: true, title: "t", docHeight: 10,
});

describe("acceptBridgeEvent", () => {
  it("accepts a well-formed message from the frame with the current nonce", () => {
    const msg = acceptBridgeEvent({ source: frame, data: ready(nonce) }, { contentWindow: frame, nonce });
    expect(msg?.type).toBe("ready");
  });

  it("drops a message from any other window, even with the right nonce", () => {
    expect(acceptBridgeEvent({ source: { other: true }, data: ready(nonce) }, { contentWindow: frame, nonce })).toBeNull();
    expect(acceptBridgeEvent({ source: null, data: ready(nonce) }, { contentWindow: frame, nonce })).toBeNull();
  });

  it("drops a message with a wrong or missing nonce: a page the frame navigated to never saw it", () => {
    expect(acceptBridgeEvent({ source: frame, data: ready("zzzzzzzzzzzzzzzzzzzz") }, { contentWindow: frame, nonce })).toBeNull();
    expect(acceptBridgeEvent({ source: frame, data: ready(null) }, { contentWindow: frame, nonce })).toBeNull();
  });

  it("drops the previous document's messages once the frame reloaded with a new nonce", () => {
    const next = newBridgeNonce();
    expect(acceptBridgeEvent({ source: frame, data: ready(nonce) }, { contentWindow: frame, nonce: next })).toBeNull();
    expect(acceptBridgeEvent({ source: frame, data: ready(next) }, { contentWindow: frame, nonce: next })?.type).toBe("ready");
  });

  it("drops everything while no load is current, and malformed or unknown messages", () => {
    expect(acceptBridgeEvent({ source: frame, data: ready(nonce) }, { contentWindow: frame, nonce: null })).toBeNull();
    expect(acceptBridgeEvent({ source: frame, data: ready(nonce) }, { contentWindow: null, nonce })).toBeNull();
    expect(acceptBridgeEvent({ source: frame, data: { ...ready(nonce), type: "write-file" } }, { contentWindow: frame, nonce })).toBeNull();
    expect(acceptBridgeEvent({ source: frame, data: "ready" }, { contentWindow: frame, nonce })).toBeNull();
  });
});

describe("bridge nonce and liveness", () => {
  it("mints nonces the server and the bridge accept, and never the same one twice", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = newBridgeNonce();
      expect(BRIDGE_NONCE_RE.test(n)).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(50);
  });

  it("counts a document as dead only when a load has no ready, whichever arrives first", () => {
    expect(frameLooksDead(0, 1)).toBe(false); // ready before load
    expect(frameLooksDead(1, 1)).toBe(false);
    expect(frameLooksDead(1, 0)).toBe(true); // load, no ready (yet)
    expect(frameLooksDead(2, 1)).toBe(true); // navigated to a page with no bridge
  });
});
