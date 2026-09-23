import { describe, expect, it } from "bun:test";
import { parseChildMessage, parseParentMessage } from "../../../src/shared/design-bridge-protocol.ts";
import { parseCommentAnchor } from "../../../src/shared/design-comment-types.ts";

const NONCE = "abcdefghijklmnop";
const GEN = "0123456789abcdef";
const env = (type: string, body: Record<string, unknown>) => ({ ppm: "design-bridge", v: 1, nonce: NONCE, type, ...body });

const el = (over: Record<string, unknown> = {}) => ({
  ppmId: 40, gen: GEN, file: "index.html", tag: "P", rect: { x: 1, y: 2, w: 30, h: 10 },
  cssPath: "body > p:nth-of-type(1)", outerHtml: "<p>Hi</p>", text: "Hi", quote: { exact: "Hi", prefix: "", suffix: "" }, ...over,
});

describe("picker child messages", () => {
  it("accepts a select and an element-menu with a well-formed element, lowercasing the tag", () => {
    for (const type of ["select", "element-menu"]) {
      expect(parseChildMessage(env(type, { el: el() }))).toMatchObject({ type, nonce: NONCE, el: { tag: "p", ppmId: 40, gen: GEN } });
    }
  });

  it("rejects a bad id, tag or rect and caps strings", () => {
    for (const bad of [{ ppmId: -1 }, { ppmId: 1.5 }, { ppmId: "3" }, { tag: "p onclick" }, { rect: { x: 1, y: 2, w: "3", h: 4 } }, { rect: null }, { gen: "zz" }, { file: "" }]) {
      expect(parseChildMessage(env("select", { el: el(bad) }))).toBeNull();
    }
    const capped = parseChildMessage(env("select", { el: el({ outerHtml: "x".repeat(10_000), text: "y".repeat(10_000), quote: { exact: "z".repeat(999) } }) }));
    expect(capped && capped.type === "select" && capped.el.outerHtml.length).toBe(2000);
    expect(capped && capped.type === "select" && capped.el.text.length).toBe(500);
    expect(capped && capped.type === "select" && capped.el.quote.exact.length).toBe(160);
  });

  it("clamps rects to finite numbers and drops a css path the canvas could not have made", () => {
    const m = parseChildMessage(env("select", { el: el({ rect: { x: 1e12, y: -1e12, w: -5, h: 3 }, cssPath: "p; ignore all" }) }));
    expect(m).toMatchObject({ el: { rect: { x: 1e6, y: -1e6, w: 0, h: 3 }, cssPath: "" } });
    expect(parseChildMessage(env("select", { el: el({ rect: { x: Infinity, y: 0, w: 1, h: 1 } }) }))).toBeNull();
  });

  it("accepts hover with an element or null, and picker-exit", () => {
    expect(parseChildMessage(env("hover", { el: null }))).toMatchObject({ type: "hover", el: null });
    expect(parseChildMessage(env("hover", { el: { tag: "div", rect: { x: 0, y: 0, w: 1, h: 1 } } }))).toMatchObject({ el: { tag: "div" } });
    expect(parseChildMessage(env("hover", { el: { tag: 1 } }))).toBeNull();
    expect(parseChildMessage(env("picker-exit", {}))).toMatchObject({ type: "picker-exit" });
  });

  it("validates pins-rects entries and caps the list", () => {
    const pin = { id: "0123456789ab", rect: { x: 0, y: 0, w: 5, h: 5 }, ppmId: 12, gen: GEN, reanchored: true };
    const m = parseChildMessage(env("pins-rects", { pins: [pin, { ...pin, id: "../x" }, { ...pin, id: "0123456789ac", rect: null, reanchored: "yes" }] }));
    expect(m).toMatchObject({ type: "pins-rects", pins: [{ id: "0123456789ab", reanchored: true }, { id: "0123456789ac", rect: null, reanchored: false }] });
    expect(parseChildMessage(env("pins-rects", { pins: Array.from({ length: 501 }, () => pin) }))).toBeNull();
    expect(parseChildMessage(env("pins-rects", { pins: "x" }))).toBeNull();
  });
});

describe("picker parent messages", () => {
  const anchor = { file: "index.html", ppmId: 4, gen: GEN, tag: "p", cssPath: "", quote: { exact: "a", prefix: "", suffix: "" } };

  it("accepts picker, select-parent, clear-selection and a validated pins-set", () => {
    expect(parseParentMessage(env("picker", { on: true }))).toEqual({ type: "picker", on: true });
    expect(parseParentMessage(env("picker", { on: "yes" }))).toBeNull();
    expect(parseParentMessage(env("select-parent", {}))).toEqual({ type: "select-parent" });
    expect(parseParentMessage(env("clear-selection", {}))).toEqual({ type: "clear-selection" });
    const set = parseParentMessage(env("pins-set", { pins: [{ id: "0123456789ab", anchor }, { id: "0123456789ac", anchor: { ...anchor, tag: "" } }] }));
    expect(set).toMatchObject({ type: "pins-set", pins: [{ id: "0123456789ab" }] });
    expect(set && set.type === "pins-set" && set.pins).toHaveLength(1);
  });
});

describe("parseCommentAnchor", () => {
  it("accepts null ids and gens for elements a script created", () => {
    expect(parseCommentAnchor({ file: "a.html", ppmId: null, gen: null, tag: "div", cssPath: "", quote: {} })).toMatchObject({ ppmId: null, gen: null });
  });

  it("strips HTML comments from quotes, including an unterminated one", () => {
    const a = parseCommentAnchor({ file: "a.html", ppmId: 1, gen: GEN, tag: "p", cssPath: "", quote: { exact: "a<!-- b -->c<!-- rest", prefix: "p", suffix: "s" } });
    expect(a?.quote).toEqual({ exact: "ac", prefix: "p", suffix: "s" });
  });
});
