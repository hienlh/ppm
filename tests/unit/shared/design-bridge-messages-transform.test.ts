import { describe, expect, it } from "bun:test";
import { BRIDGE_CHANNEL, BRIDGE_VERSION, parseChildMessage, parseParentMessage } from "../../../src/shared/design-bridge-protocol.ts";
import { parseTransformProps } from "../../../src/shared/design-bridge-messages-transform.ts";

const NONCE = "abcdefghijklmnop";
const GEN = "0123456789abcdef";
const env = (type: string, extra: Record<string, unknown> = {}) => ({ ppm: BRIDGE_CHANNEL, v: BRIDGE_VERSION, nonce: NONCE, type, ...extra });
const commit = { file: "index.html", gen: GEN, ppmId: 120, tag: "DIV", props: { translate: "10px -4.5px", width: "320px" } };

describe("parseTransformProps", () => {
  it("accepts px translate, width and height", () => {
    expect(parseTransformProps({ translate: "0px 0px" })).toEqual({ translate: "0px 0px" });
    expect(parseTransformProps({ width: "20000px", height: "0.25px" })).toEqual({ width: "20000px", height: "0.25px" });
    expect(parseTransformProps({ translate: "-20000px 12.5px" })).toEqual({ translate: "-20000px 12.5px" });
  });

  it("refuses any other property, unit, shape or size", () => {
    const bad: unknown[] = [
      null, [], {}, "width: 1px", { color: "red" }, { width: "10%" }, { width: "-1px" }, { width: "20001px" },
      { width: "1.234px" }, { width: 10 }, { translate: "10px" }, { translate: "1px 2px 3px" }, { translate: "1px  2px" },
      { width: "1px;color:red" }, { width: '1px"' }, { height: "1e3px" }, { translate: "20001px 0px" },
      { width: "1px", height: "1px", translate: "0px 0px", extra: "1px" }, JSON.parse('{"__proto__": "1px"}'),
    ];
    for (const v of bad) expect(parseTransformProps(v)).toBeNull();
  });
});

describe("transform bridge messages", () => {
  it("validates the frame's commit proposal and lowercases its tag", () => {
    expect(parseChildMessage(env("transform-commit", commit))).toEqual({ type: "transform-commit", nonce: NONCE, ...commit, tag: "div" });
    for (const over of [{ gen: "nope" }, { ppmId: -1 }, { ppmId: null }, { tag: "not a tag" }, { file: "" }, { props: { color: "red" } }]) {
      expect(parseChildMessage(env("transform-commit", { ...commit, ...over }))).toBeNull();
    }
  });

  it("validates live reports, clamping the box", () => {
    const live = parseChildMessage(env("transform-live", { ppmId: 5, rect: { x: 1, y: 2, w: 3, h: 4 }, box: { tx: 1, ty: 2, w: -3, h: 4 } }));
    expect(live).toMatchObject({ type: "transform-live", ppmId: 5, rect: { x: 1, y: 2, w: 3, h: 4 }, box: { tx: 1, ty: 2, w: 0, h: 4 } });
    expect(parseChildMessage(env("transform-live", { ppmId: 5, rect: null }))).toMatchObject({ rect: null, box: null });
    expect(parseChildMessage(env("transform-live", { ppmId: 5, rect: "x" }))).toBeNull();
  });

  it("validates the parent's messages", () => {
    expect(parseParentMessage(env("transform-mode", { on: true, scale: 0.5 }))).toEqual({ type: "transform-mode", on: true, scale: 0.5 });
    expect(parseParentMessage(env("transform-mode", { on: true, scale: 0 }))).toBeNull();
    expect(parseParentMessage(env("transform-mode", { on: "yes", scale: 1 }))).toBeNull();
    expect(parseParentMessage(env("transform-target", { ppmId: 3, tag: "P" }))).toEqual({ type: "transform-target", ppmId: 3, tag: "p" });
    expect(parseParentMessage(env("transform-target", { ppmId: null }))).toEqual({ type: "transform-target", ppmId: null, tag: "" });
    expect(parseParentMessage(env("transform-target", { ppmId: 3 }))).toBeNull();
    expect(parseParentMessage(env("transform-nudge", { dx: -10, dy: 0 }))).toEqual({ type: "transform-nudge", dx: -10, dy: 0 });
    for (const n of [{ dx: 0, dy: 0 }, { dx: 1.5, dy: 0 }, { dx: 1001, dy: 0 }, { dx: "1", dy: 0 }]) {
      expect(parseParentMessage(env("transform-nudge", n))).toBeNull();
    }
    expect(parseParentMessage(env("transform-cancel"))).toEqual({ type: "transform-cancel" });
  });

  it("never accepts a proposal sent the other way, or a parent message from the frame", () => {
    expect(parseParentMessage(env("transform-commit", commit))).toBeNull();
    expect(parseChildMessage(env("transform-mode", { on: true, scale: 1 }))).toBeNull();
  });
});
