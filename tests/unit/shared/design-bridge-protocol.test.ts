import { describe, expect, it } from "bun:test";
import {
  BRIDGE_CHANNEL, BRIDGE_VERSION, parentEnvelope, parseChildMessage, parseParentMessage,
} from "../../../src/shared/design-bridge-protocol.ts";

const NONCE = "abcdefghijklmnop";
const GEN = "0123456789abcdef";
const env = (type: string, extra: Record<string, unknown> = {}, nonce: unknown = NONCE) =>
  ({ ppm: BRIDGE_CHANNEL, v: BRIDGE_VERSION, nonce, type, ...extra });
const ready = { gen: GEN, cssGens: { "styles.css": GEN }, file: "index.html", instrumented: true, title: "T", docHeight: 900 };

describe("design bridge protocol", () => {
  it("accepts each core child message with its nonce", () => {
    expect(parseChildMessage(env("ready", ready))).toEqual({ type: "ready", nonce: NONCE, ...ready });
    expect(parseChildMessage(env("scroll", { x: 0, y: 120 }))).toEqual({ type: "scroll", nonce: NONCE, x: 0, y: 120 });
    expect(parseChildMessage(env("issue", { kind: "csp", message: "img-src blocked https://x" })))
      .toMatchObject({ type: "issue", kind: "csp", message: "img-src blocked https://x" });
    expect(parseChildMessage(env("navigate-blocked", { href: "https://evil.example/" })))
      .toEqual({ type: "navigate-blocked", nonce: NONCE, href: "https://evil.example/" });
    expect(parseChildMessage(env("expired"))).toEqual({ type: "expired", nonce: NONCE });
  });

  it("keeps a null nonce for the caller to reject, and drops a malformed or missing one", () => {
    expect(parseChildMessage(env("expired", {}, null))).toEqual({ type: "expired", nonce: null });
    const { nonce: _omitted, ...missing } = env("expired");
    expect(parseChildMessage(missing)).toBeNull();
    for (const nonce of ["", "short", "has space inside it!", 42, "x".repeat(65)]) {
      expect(parseChildMessage(env("expired", {}, nonce))).toBeNull();
    }
  });

  it("rejects wrong envelopes, unknown types and prototype keys", () => {
    for (const data of [null, "ready", [], { ...env("ready", ready), ppm: "other" }, { ...env("ready", ready), v: 2 },
      env("constructor"), env("__proto__"), env("toString"), env("restore-scroll", { x: 0, y: 0 }), env("hover")]) {
      expect(parseChildMessage(data)).toBeNull();
    }
  });

  it("validates and caps every field", () => {
    expect(parseChildMessage(env("ready", { ...ready, gen: "nothex" }))).toBeNull();
    expect(parseChildMessage(env("ready", { ...ready, cssGens: { "a.css": "bad" } }))).toBeNull();
    expect(parseChildMessage(env("ready", { ...ready, instrumented: "yes" }))).toBeNull();
    expect(parseChildMessage(env("ready", { ...ready, cssGens: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`${i}.css`, GEN])) }))).toBeNull();
    expect(parseChildMessage(env("scroll", { x: Number.NaN, y: 0 }))).toBeNull();
    expect(parseChildMessage(env("issue", { kind: "evil", message: "x" }))).toBeNull();
    const long = parseChildMessage(env("issue", { kind: "error", message: "m".repeat(5000) }));
    expect(long && long.type === "issue" && long.message.length).toBe(500);
    const title = parseChildMessage(env("ready", { ...ready, title: "t".repeat(1000), docHeight: -5 }));
    expect(title).toMatchObject({ docHeight: 0 });
    expect(title && title.type === "ready" && title.title.length).toBe(200);
  });

  it("builds parent messages whose envelope cannot be overridden, and parses them back", () => {
    const message = parentEnvelope(NONCE, { type: "restore-scroll", x: 1, y: 2 });
    expect(message).toEqual({ ppm: BRIDGE_CHANNEL, v: BRIDGE_VERSION, nonce: NONCE, type: "restore-scroll", x: 1, y: 2 });
    expect(parseParentMessage(message)).toEqual({ type: "restore-scroll", x: 1, y: 2 });
    expect(parseParentMessage(env("ready", ready))).toBeNull();
  });
});
