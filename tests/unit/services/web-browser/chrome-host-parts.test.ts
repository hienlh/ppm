import { describe, expect, test } from "bun:test";
import { chromeLaunchArgs, preferredTransport } from "../../../../src/services/web-browser/chrome-launch-args.ts";
import { NulFramer } from "../../../../src/services/web-browser/cdp-transports.ts";
import { CdpConnection, type CdpTransport } from "../../../../src/services/web-browser/cdp-connection.ts";
import { idleDeadline, shouldStopForIdle } from "../../../../src/services/web-browser/browser-idle.ts";

describe("chromeLaunchArgs", () => {
  const base = { profileDir: "/p", egressPort: 4000, audio: true };

  test("routes everything through the SOCKS5 guard, loopback included", () => {
    const args = chromeLaunchArgs({ ...base, transport: "pipe" });
    expect(args).toContain("--proxy-server=socks5://127.0.0.1:4000");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--disable-extensions");
    expect(args).toContain("--mute-audio");
    expect(args).toContain("--user-data-dir=/p");
  });

  test("pipe transport opens no port", () => {
    const args = chromeLaunchArgs({ ...base, transport: "pipe" });
    expect(args).toContain("--remote-debugging-pipe");
    expect(args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
  });

  test("port transport binds loopback only, and never without a port", () => {
    const args = chromeLaunchArgs({ ...base, transport: "port", devtoolsPort: 5555 });
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=5555");
    expect(() => chromeLaunchArgs({ ...base, transport: "port" })).toThrow();
  });

  test("Windows uses the port, others the pipe", () => {
    expect(preferredTransport("win32")).toBe("port");
    expect(preferredTransport("linux")).toBe("pipe");
  });
});

describe("NulFramer", () => {
  test("joins split messages and splits joined ones", () => {
    const f = new NulFramer();
    expect(f.push(Buffer.from('{"a":'))).toEqual([]);
    expect(f.push(Buffer.from('1}\0{"b":2}\0{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(f.push(Buffer.from(":3}\0"))).toEqual(['{"c":3}']);
  });

  test("keeps multi-byte characters split across chunks", () => {
    const f = new NulFramer();
    const bytes = Buffer.from('"Hà Nội"\0');
    expect([...f.push(bytes.subarray(0, 3)), ...f.push(bytes.subarray(3))]).toEqual(['"Hà Nội"']);
  });
});

function fakeTransport() {
  let deliver: (m: string) => void = () => {};
  let closeCb: () => void = () => {};
  const sent: string[] = [];
  const t: CdpTransport = {
    send: (m) => { sent.push(m); },
    onMessage: (cb) => { deliver = cb; },
    onClose: (cb) => { closeCb = cb; },
    close: () => closeCb(),
  };
  return { t, sent, deliver: (m: unknown) => deliver(JSON.stringify(m)), closeFromChrome: () => closeCb() };
}

describe("CdpConnection", () => {
  test("matches replies to commands and passes events with their session", async () => {
    const f = fakeTransport();
    const cdp = new CdpConnection(f.t);
    const events: unknown[] = [];
    cdp.onEvent((e) => events.push(e));
    const reply = cdp.send("Browser.getVersion");
    const { id } = JSON.parse(f.sent[0]!);
    f.deliver({ method: "Page.loadEventFired", params: { t: 1 }, sessionId: "S" });
    f.deliver({ id, result: { product: "Chrome" } });
    expect(await reply).toEqual({ product: "Chrome" });
    expect(events).toEqual([{ method: "Page.loadEventFired", params: { t: 1 }, sessionId: "S" }]);
  });

  test("a CDP error rejects and a closed connection rejects everything pending", async () => {
    const f = fakeTransport();
    const cdp = new CdpConnection(f.t);
    const bad = cdp.send("Nope.x");
    f.deliver({ id: JSON.parse(f.sent[0]!).id, error: { code: -32601, message: "not found" } });
    await expect(bad).rejects.toThrow("not found");
    const pending = cdp.send("Page.navigate", { url: "x" }, "S");
    expect(JSON.parse(f.sent[1]!).sessionId).toBe("S");
    f.closeFromChrome();
    await expect(pending).rejects.toThrow("connection closed");
    await expect(cdp.send("Browser.close")).rejects.toThrow("connection closed");
  });
});

describe("idle stop", () => {
  const min = 60_000;
  const base = { now: 100 * min, idleStopMs: 10 * min, visibleViewers: 0, lastVisibleAt: 0, lastInputAt: 0, lastAiAt: 0 };

  test("nobody visible: stops idleStopMinutes after the last sign of use", () => {
    expect(shouldStopForIdle({ ...base, lastVisibleAt: 95 * min })).toBe(false);
    expect(shouldStopForIdle({ ...base, lastVisibleAt: 89 * min })).toBe(true);
    expect(shouldStopForIdle({ ...base, lastAiAt: 95 * min })).toBe(false);
  });

  test("a visible but untouched window keeps it alive at least an hour, then not", () => {
    expect(shouldStopForIdle({ ...base, visibleViewers: 1, lastInputAt: 50 * min })).toBe(false);
    expect(shouldStopForIdle({ ...base, visibleViewers: 1, lastInputAt: 39 * min })).toBe(true);
    expect(idleDeadline({ ...base, visibleViewers: 1, lastInputAt: 0, idleStopMs: 20 * min })).toBe(120 * min);
  });
});
