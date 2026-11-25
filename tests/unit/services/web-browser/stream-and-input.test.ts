import { describe, expect, test } from "bun:test";
import { resolveAddress, isNavigableUrl, SEARCH_URL } from "../../../../src/services/web-browser/address-bar.ts";
import { inputToCdp, type Viewport } from "../../../../src/services/web-browser/input-bridge.ts";
import { ScreencastPacer, SETTLE_MS } from "../../../../src/services/web-browser/screencast-pacer.ts";
import { CdpConnection, type CdpTransport } from "../../../../src/services/web-browser/cdp-connection.ts";
import { decodeBinaryFrame } from "../../../../src/shared/web-browser-binary-frames.ts";

describe("resolveAddress", () => {
  test("http(s) passes, other schemes are refused", () => {
    expect(resolveAddress("https://vnexpress.net")).toEqual({ ok: true, url: "https://vnexpress.net/" });
    for (const bad of ["file:///C:/Windows/win.ini", "chrome://settings", "javascript:alert(1)", "view-source:https://a.b", "data:text/html,x", "devtools://x"]) {
      expect(resolveAddress(bad)).toEqual({ ok: false, reason: "scheme" });
    }
  });

  test("bare hosts get a scheme: https for public names, http for local ones", () => {
    expect(resolveAddress("github.com")).toEqual({ ok: true, url: "https://github.com/" });
    expect(resolveAddress("localhost:3000")).toEqual({ ok: true, url: "http://localhost:3000/" });
    expect(resolveAddress("192.168.1.1")).toEqual({ ok: true, url: "http://192.168.1.1/" });
  });

  test("anything else is a search", () => {
    expect(resolveAddress("thời tiết Hà Nội")).toEqual({ ok: true, url: SEARCH_URL + encodeURIComponent("thời tiết Hà Nội") });
    expect(resolveAddress("  ")).toEqual({ ok: false, reason: "empty" });
  });

  test("isNavigableUrl only accepts http(s) and about:blank", () => {
    expect(isNavigableUrl("http://x.y/")).toBe(true);
    expect(isNavigableUrl("about:blank")).toBe(true);
    expect(isNavigableUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("inputToCdp", () => {
  const vp: Viewport = { cssWidth: 1000, cssHeight: 500, dpr: 1, mobile: false };
  const held = () => ({ buttons: 0, keys: new Map<string, { key: string; vk: number }>() });

  test("a click becomes press then release at page pixels", () => {
    const h = held();
    const down = inputToCdp({ type: "pointer", xFrac: 0.5, yFrac: 0.2, button: "left", down: true }, vp, h);
    expect(down[0]!.params).toMatchObject({ type: "mousePressed", x: 500, y: 100, button: "left", buttons: 1, clickCount: 1 });
    const up = inputToCdp({ type: "pointer", xFrac: 0.5, yFrac: 0.2, button: "left", down: false }, vp, h);
    expect(up[0]!.params).toMatchObject({ type: "mouseReleased", buttons: 1 });
    expect(h.buttons).toBe(0);
  });

  test("typed text and IME composition go in as text, never as key codes", () => {
    expect(inputToCdp({ type: "text", text: "thời tiết" }, vp, held())).toEqual([{ method: "Input.insertText", params: { text: "thời tiết" } }]);
    expect(inputToCdp({ type: "compose", text: "thờ", selStart: 3, selEnd: 3 }, vp, held()))
      .toEqual([{ method: "Input.imeSetComposition", params: { text: "thờ", selectionStart: 3, selectionEnd: 3 } }]);
  });

  test("Enter carries a carriage return, shortcuts carry none, and modifiers are a bitmask", () => {
    const enter = inputToCdp({ type: "key", down: true, key: "Enter", code: "Enter", location: 0, modifiers: {}, repeat: false }, vp, held());
    expect(enter[0]!.params).toMatchObject({ type: "keyDown", text: "\r", windowsVirtualKeyCode: 0x0d });
    const ctrlA = inputToCdp({ type: "key", down: true, key: "a", code: "KeyA", location: 0, modifiers: { ctrl: true }, repeat: false }, vp, held());
    expect(ctrlA[0]!.params).toMatchObject({ type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 0x41 });
    expect((ctrlA[0]!.params as { text?: string }).text).toBeUndefined();
  });

  test("releaseAll lets go of every held key and button", () => {
    const h = held();
    inputToCdp({ type: "key", down: true, key: "Shift", code: "ShiftLeft", location: 1, modifiers: {}, repeat: false }, vp, h);
    inputToCdp({ type: "pointer", xFrac: 0, yFrac: 0, button: "left", down: true }, vp, h);
    const calls = inputToCdp({ type: "releaseAll" }, vp, h);
    expect(calls.map((c) => c.params.type)).toEqual(["keyUp", "mouseReleased"]);
    expect(h.keys.size).toBe(0);
    expect(h.buttons).toBe(0);
  });

  test("touch end with fingers left is a move; with none, an empty end", () => {
    expect(inputToCdp({ type: "touch", phase: "end", points: [] }, vp, held())[0]!.params).toEqual({ type: "touchEnd", touchPoints: [] });
    expect(inputToCdp({ type: "touch", phase: "end", points: [{ id: 2, xFrac: 0.1, yFrac: 0.1 }] }, vp, held())[0]!.params)
      .toMatchObject({ type: "touchMove", touchPoints: [{ x: 100, y: 50, id: 2 }] });
  });
});

describe("ScreencastPacer", () => {
  function setup(fpsCap = 1000) {
    let deliver: (m: string) => void = () => {};
    const sent: { method: string; params: Record<string, unknown>; sessionId?: string; id: number }[] = [];
    const t: CdpTransport = {
      send: (m) => {
        const msg = JSON.parse(m);
        sent.push(msg);
        queueMicrotask(() => deliver(JSON.stringify({ id: msg.id, result: {} })));
      },
      onMessage: (cb) => { deliver = cb; },
      onClose: () => {},
      close: () => {},
    };
    const cdp = new CdpConnection(t);
    const pictures: Uint8Array[] = [];
    const pacer = new ScreencastPacer(cdp, { sendBinary: (b) => pictures.push(b) }, () => ({ fpsCap, jpegQuality: 55 }));
    const frame = (n: number) => deliver(JSON.stringify({ method: "Page.screencastFrame", sessionId: "S", params: { data: Buffer.from([0xff, 0xd8, n]).toString("base64"), sessionId: n, metadata: { deviceWidth: 390, deviceHeight: 844 } } }));
    const acks = () => sent.filter((m) => m.method === "Page.screencastFrameAck").map((m) => m.params.sessionId);
    return { pacer, frame, pictures, acks, sent };
  }

  test("sizes the stream to the viewport and caps the scale at 2x", async () => {
    const s = setup();
    await s.pacer.start("S", { cssWidth: 390, cssHeight: 844, dpr: 3, mobile: true });
    expect(s.sent.find((m) => m.method === "Page.startScreencast")!.params).toMatchObject({ maxWidth: 780, maxHeight: 1688, quality: 55 });
  });

  test("holds Chrome's ack once two pictures are unacknowledged by the viewer", async () => {
    const s = setup();
    await s.pacer.start("S", { cssWidth: 390, cssHeight: 844, dpr: 1, mobile: true });
    // Chrome sends a frame only after the previous one is acked, as here.
    s.frame(1);
    await Bun.sleep(5);
    expect(s.acks()).toEqual([1]);
    s.frame(2);
    await Bun.sleep(5);
    expect(s.acks()).toEqual([1]);
    expect(decodeBinaryFrame(s.pictures[1]!)).toMatchObject({ seq: 2, cssWidth: 390, cssHeight: 844 });
    s.pacer.ack(1);
    await Bun.sleep(5);
    expect(s.acks()).toEqual([1, 2]);
  });

  test("acks one frame per interval, every frame in turn", async () => {
    const s = setup(10); // 100 ms interval
    await s.pacer.start("S", { cssWidth: 390, cssHeight: 844, dpr: 1, mobile: true });
    s.frame(1);
    s.frame(2); // Chrome keeps more than one in flight
    s.pacer.ack(1); // the viewer drew both
    s.pacer.ack(2);
    await Bun.sleep(20);
    expect(s.acks()).toEqual([1]); // the first goes out at once
    await Bun.sleep(100);
    expect(s.acks()).toEqual([1, 2]);
    await Bun.sleep(120);
    expect(s.acks()).toEqual([1, 2]); // nothing left to ack
  });

  test("times the next ack from the previous ack, so Chrome's capture delay falls inside the interval", async () => {
    const s = setup(10); // 100 ms interval
    await s.pacer.start("S", { cssWidth: 390, cssHeight: 844, dpr: 1, mobile: true });
    const t0 = Date.now();
    s.frame(1);
    s.pacer.ack(1);
    expect(s.acks().length).toBe(1);
    await Bun.sleep(40); // Chrome answers the ack 40 ms later
    s.frame(2);
    s.pacer.ack(2);
    while (s.acks().length < 2 && Date.now() - t0 < 300) await Bun.sleep(2);
    const at = Date.now() - t0;
    expect(at).toBeGreaterThan(90);
    expect(at).toBeLessThan(125); // not 140: one interval after the first ack
  });

  test("restarts the stream once the person stops, when Chrome was held since their input", async () => {
    const s = setup(10);
    await s.pacer.start("S", { cssWidth: 390, cssHeight: 844, dpr: 1, mobile: true });
    s.pacer.noteInput();
    s.frame(1);
    s.frame(2); // held for the interval: a repaint meanwhile would be dropped
    await Bun.sleep(SETTLE_MS + 40);
    expect(s.sent.filter((m) => m.method === "Page.startScreencast").length).toBe(2);
    expect(s.sent.filter((m) => m.method === "Page.stopScreencast").length).toBe(1);
  });

  test("does not restart the stream after input when Chrome was never held", async () => {
    const s = setup(10);
    await s.pacer.start("S", { cssWidth: 390, cssHeight: 844, dpr: 1, mobile: true });
    s.pacer.noteInput();
    await Bun.sleep(SETTLE_MS + 40);
    expect(s.sent.filter((m) => m.method === "Page.startScreencast").length).toBe(1);
  });

  test("a restart keeps the viewer's count of undrawn pictures", async () => {
    const s = setup();
    await s.pacer.start("S", { cssWidth: 390, cssHeight: 844, dpr: 1, mobile: true });
    s.frame(1);
    s.frame(2);
    await Bun.sleep(5);
    s.pacer.noteInput();
    await Bun.sleep(SETTLE_MS + 30);
    const before = s.acks().length;
    s.frame(3); // the restarted stream's first frame
    await Bun.sleep(10);
    expect(s.acks().length).toBe(before); // still two undrawn pictures: held
    s.pacer.ack(1);
    s.pacer.ack(2);
    await Bun.sleep(10);
    expect(s.acks().length).toBe(before + 1);
  });

  test("ignores frames of another page session", async () => {
    const s = setup();
    await s.pacer.start("OTHER", { cssWidth: 100, cssHeight: 100, dpr: 1, mobile: false });
    s.frame(1);
    expect(s.pictures.length).toBe(0);
  });
});
