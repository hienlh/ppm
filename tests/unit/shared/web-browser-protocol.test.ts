import { describe, expect, test } from "bun:test";
import { parseWebBrowserClientMessage as parse } from "../../../src/shared/web-browser-protocol-parse.ts";
import { decodeBinaryFrame, encodePictureFrame, encodeSoundFrame } from "../../../src/shared/web-browser-binary-frames.ts";
import { WEB_BROWSER_MESSAGE_LIMITS } from "../../../src/shared/web-browser-protocol.ts";

const j = (v: unknown) => JSON.stringify(v);

describe("parseWebBrowserClientMessage", () => {
  test("accepts each well-formed shape", () => {
    expect(parse(j({ type: "auth", nonce: "abc" }))).toEqual({ type: "auth", nonce: "abc" });
    expect(parse(j({ type: "viewport", cssWidth: 390.4, cssHeight: 700, dpr: 3, mobile: true })))
      .toEqual({ type: "viewport", cssWidth: 390, cssHeight: 700, dpr: 3, mobile: true });
    expect(parse(j({ type: "pointer", xFrac: 0.5, yFrac: 0.2, button: "left", down: true, clickCount: 2 })))
      .toEqual({ type: "pointer", xFrac: 0.5, yFrac: 0.2, button: "left", down: true, clickCount: 2 });
    expect(parse(j({ type: "pointer", xFrac: 0.5, yFrac: 0.2, button: "none", down: null })))
      .toEqual({ type: "pointer", xFrac: 0.5, yFrac: 0.2, button: "none", down: null });
    expect(parse(j({ type: "key", down: true, key: "Enter", code: "Enter", location: 0, modifiers: { ctrl: true } })))
      .toEqual({ type: "key", down: true, key: "Enter", code: "Enter", location: 0, modifiers: { alt: false, ctrl: true, meta: false, shift: false }, repeat: false });
    expect(parse(j({ type: "compose", text: "", selStart: 0, selEnd: 0 }))).toEqual({ type: "compose", text: "", selStart: 0, selEnd: 0 });
    expect(parse(j({ type: "text", text: "thời tiết Hà Nội" }))).toEqual({ type: "text", text: "thời tiết Hà Nội" });
    expect(parse(j({ type: "touch", phase: "move", points: [{ id: 1, xFrac: 0.1, yFrac: 0.9 }] })))
      .toEqual({ type: "touch", phase: "move", points: [{ id: 1, xFrac: 0.1, yFrac: 0.9 }] });
    expect(parse(j({ type: "back" }))).toEqual({ type: "back" });
    expect(parse(j({ type: "tab.open" }))).toEqual({ type: "tab.open" });
    expect(parse(j({ type: "file.choose", chooserId: "c1", uploadIds: ["u1", "u2"] })))
      .toEqual({ type: "file.choose", chooserId: "c1", uploadIds: ["u1", "u2"] });
  });

  test("refuses malformed, oversized and unknown input", () => {
    expect(parse("not json")).toBeNull();
    expect(parse(j([1, 2]))).toBeNull();
    expect(parse(j({ type: "nope" }))).toBeNull();
    expect(parse(j({ type: "auth" }))).toBeNull();
    expect(parse(j({ type: "viewport", cssWidth: -5, cssHeight: 700, dpr: 1 }))).toBeNull();
    expect(parse(j({ type: "pointer", xFrac: "0.5", yFrac: 0.2, button: "left", down: true }))).toBeNull();
    expect(parse(j({ type: "pointer", xFrac: 9, yFrac: 0.2, button: "left", down: true }))).toBeNull();
    expect(parse(j({ type: "pointer", xFrac: 0.5, yFrac: 0.2, button: "x", down: true }))).toBeNull();
    expect(parse(j({ type: "text", text: "" }))).toBeNull();
    expect(parse(j({ type: "text", text: "a".repeat(WEB_BROWSER_MESSAGE_LIMITS.text + 1) }))).toBeNull();
    expect(parse(j({ type: "navigate", url: 5 }))).toBeNull();
    expect(parse(j({ type: "touch", phase: "move", points: Array.from({ length: 11 }, (_, i) => ({ id: i, xFrac: 0, yFrac: 0 })) }))).toBeNull();
    expect(parse(j({ type: "file.choose", chooserId: "c", uploadIds: [""] }))).toBeNull();
    expect(parse(j({ type: "dialog.answer", id: "d", accept: "yes" }))).toBeNull();
  });
});

describe("binary frames", () => {
  test("a picture round-trips with its seq and layout size", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const frame = decodeBinaryFrame(encodePictureFrame(4_000_000_001, 1280, 800, jpeg));
    expect(frame).toMatchObject({ kind: 1, seq: 4_000_000_001, cssWidth: 1280, cssHeight: 800 });
    expect([...frame!.payload]).toEqual([...jpeg]);
  });

  test("a sound frame keeps its rate and channels", () => {
    const pcm = new Uint8Array(8);
    expect(decodeBinaryFrame(encodeSoundFrame(7, 24_000, 1, pcm))).toMatchObject({ kind: 2, seq: 7, sampleRate: 24_000, channels: 1 });
  });

  test("short or unknown messages are not frames", () => {
    expect(decodeBinaryFrame(new Uint8Array(5))).toBeNull();
    const unknown = encodePictureFrame(1, 1, 1, new Uint8Array(1));
    unknown[0] = 9;
    expect(decodeBinaryFrame(unknown)).toBeNull();
  });
});
