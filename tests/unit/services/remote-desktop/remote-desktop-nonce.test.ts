import { describe, it, expect } from "bun:test";
import { mintRemoteDesktopNonce, consumeRemoteDesktopNonce } from "../../../../src/services/remote-desktop/remote-desktop-nonce.ts";

describe("remote-desktop nonce", () => {
  it("consumes a freshly minted nonce exactly once", () => {
    const nonce = mintRemoteDesktopNonce();
    expect(consumeRemoteDesktopNonce(nonce)).toBe(true);
    expect(consumeRemoteDesktopNonce(nonce)).toBe(false); // single-use
  });

  it("rejects an unknown nonce", () => {
    expect(consumeRemoteDesktopNonce("not-a-real-nonce")).toBe(false);
  });

  it("mints distinct nonces per call", () => {
    const a = mintRemoteDesktopNonce();
    const b = mintRemoteDesktopNonce();
    expect(a).not.toBe(b);
    expect(consumeRemoteDesktopNonce(a)).toBe(true);
    expect(consumeRemoteDesktopNonce(b)).toBe(true);
  });
});
