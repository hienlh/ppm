/**
 * One device, one pipeline — however the viewers arrive.
 *
 * `openDeviceSession` awaits the emulator's status and the video pipeline before there is a
 * session to register, so two viewers arriving together each started a gRPC stream and an
 * ffmpeg, and the second replaced the first in the map: closing the first then deleted the
 * entry for the second, whose pipeline kept running with nothing left that could stop it. These
 * drive the real `attachAndroidViewer` with only the emulator-facing opener faked.
 */
import { describe, expect, it } from "bun:test";
import { attachAndroidViewer, type AndroidSocket } from "../../../src/services/android/android-session.ts";
import { androidSocketFor, androidWebSocket } from "../../../src/server/ws/android.ts";

type Open = NonNullable<Parameters<typeof attachAndroidViewer>[2]>;

let nextDevice = 0;
/** A fresh device id per test: the session map is module state shared by the whole file. */
const device = () => `emulator-test-${++nextDevice}`;

interface FakeDevice { open: Open; opens: () => number; stops: () => number; release: () => void }

/** An opener that holds every open until `release()`, like an emulator taking its time. */
function fakeDevice(): FakeDevice {
  let opens = 0;
  let stops = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const open: Open = async (deviceId, emulator, quality) => {
    opens++;
    await gate;
    const sweep = setInterval(() => {}, 1 << 30);
    (sweep as unknown as { unref?: () => void }).unref?.();
    return {
      deviceId, emulator, quality,
      channel: { client: { sendTouch: (_a: unknown, _m: unknown, _o: unknown, cb: (e: null) => void) => cb(null) }, metadata: {}, target: "", close() {} },
      pipeline: {
        geometry: { width: 1080, height: 1920, rotation: 0 },
        encoder: "libx264", fps: 30,
        codecString: () => "avc1.42E01F",
        stop: async () => { stops++; },
        setPaused() {}, setQuality: async () => {},
        stats: () => ({ sourceFrames: 0, fedFrames: 0 }),
      },
      viewers: new Map(), controllerId: null, sessionGeneration: 1, geometryGeneration: 1,
      deviceWidth: 1080, deviceHeight: 1920, codec: null, sweep,
    } as never;
  };
  return { open, opens: () => opens, stops: () => stops, release };
}

function socket(closed = () => false): AndroidSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: (d) => { sent.push(d); return 1; }, close() {}, isClosed: closed };
}

const attach = (deviceId: string, s: AndroidSocket, open: Open) =>
  attachAndroidViewer(s, { deviceId, emulator: {} as never, quality: "balanced" }, open);

describe("android device sessions", () => {
  it("gives two viewers arriving together one pipeline", async () => {
    const id = device();
    const d = fakeDevice();
    const a = attach(id, socket(), d.open);
    const b = attach(id, socket(), d.open);
    d.release();
    const [va, vb] = await Promise.all([a, b]);

    expect(d.opens()).toBe(1);

    va.close();
    await Bun.sleep(10);
    expect(d.stops()).toBe(0);         // the second viewer is still watching
    vb.close();
    await Bun.sleep(10);
    expect(d.stops()).toBe(1);
  });

  it("opens the device again once its last viewer has gone", async () => {
    const id = device();
    const d = fakeDevice();
    d.release();
    const first = await attach(id, socket(), d.open);
    first.close();
    await Bun.sleep(10);

    const second = await attach(id, socket(), d.open);
    expect(d.opens()).toBe(2);
    second.close();
  });

  it("does not let a stale viewer's close take down the device's newer session", async () => {
    const id = device();
    const d = fakeDevice();
    d.release();
    const old = await attach(id, socket(), d.open);
    old.close();
    await Bun.sleep(10);
    const current = await attach(id, socket(), d.open);

    old.close();                       // a duplicate close of the first session's handle
    await Bun.sleep(10);
    const joining = await attach(id, socket(), d.open);

    expect(d.opens()).toBe(2);         // joined the live session rather than opening a third
    current.close();
    joining.close();
  });

  it("does not cache an open that failed", async () => {
    const id = device();
    let calls = 0;
    const failing: Open = async () => { calls++; throw new Error("emulator gone"); };
    const results = await Promise.allSettled([attach(id, socket(), failing), attach(id, socket(), failing)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toBe(1);

    const d = fakeDevice();
    d.release();
    const v = await attach(id, socket(), d.open);
    expect(d.opens()).toBe(1);
    v.close();
  });

  it("stops the pipeline when the only viewer's socket closed while the session was starting", async () => {
    const id = device();
    const d = fakeDevice();
    let closed = false;
    const pending = attach(id, socket(() => closed), d.open);
    closed = true;                     // the client gave up while the emulator was answering
    d.release();
    await pending;
    await Bun.sleep(10);

    expect(d.stops()).toBe(1);
  });

  it("keeps the session for a live viewer that was waiting beside one whose socket closed", async () => {
    // Both resume from the same promise, the closed one first: it must not tear the session
    // down on its way out while the live one is about to attach to it.
    const id = device();
    const d = fakeDevice();
    let closed = false;
    const live = socket();
    const a = attach(id, socket(() => closed), d.open);
    const b = attach(id, live, d.open);
    closed = true;
    d.release();
    const [, vb] = await Promise.all([a, b]);
    await Bun.sleep(10);

    expect(d.opens()).toBe(1);
    expect(d.stops()).toBe(0);
    expect(live.sent.map((m) => JSON.parse(m as string).type)).toContain("ready");

    vb.close();
    await Bun.sleep(10);
    expect(d.stops()).toBe(1);
  });

  it("stops the pipeline once when every waiting viewer's socket closed", async () => {
    const id = device();
    const d = fakeDevice();
    let closed = false;
    const pending = [attach(id, socket(() => closed), d.open), attach(id, socket(() => closed), d.open)];
    closed = true;
    d.release();
    await Promise.all(pending);
    await Bun.sleep(10);

    expect(d.stops()).toBe(1);
  });

  it("is told by the WS handler that its socket closed before the session existed", () => {
    const ws = { data: { type: "android" as const }, send: () => 1, close: () => {} };
    const s = androidSocketFor(ws);
    expect(s.isClosed?.()).toBe(false);

    androidWebSocket.close(ws);        // no session on the socket yet: attach is still running

    expect(s.isClosed?.()).toBe(true);
  });
});
