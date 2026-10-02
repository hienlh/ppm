/**
 * Only the newest connection attempt may act on the viewer.
 *
 * A manual reconnect closed the old socket and called `connect()`, which reset the one shared
 * "we closed it" flag — so the old socket's `onclose`, which the browser fires after the close
 * handshake, cleared the ref to the *new* socket and scheduled a second reconnect. More of the
 * same shape: the old socket's late messages marked the viewer live while the new one was still
 * connecting, a retry already scheduled survived a manual reconnect, and a viewer closed while
 * its nonce was being minted went on to open a socket nothing would ever close. These drive the
 * real hook against a fake WebSocket and assert on the sockets it makes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useRef } from "react";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import { useAndroidSession, type AndroidSession } from "../../../src/web/components/android/use-android-session.ts";
import { encodeVideoFrame } from "../../../src/shared/android-protocol.ts";

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  readonly sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  /** Like a browser: the `close` event comes later, after the handshake. */
  close() { this.readyState = 3; }
}

/** The first automatic retry is 500 ms out; waiting past it is how its absence is seen. */
const PAST_FIRST_RETRY_MS = 700;

let latest: AndroidSession | null = null;
function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  latest = useAndroidSession({ deviceId: "emulator-1", quality: "balanced", canvasRef });
  return <canvas ref={canvasRef} />;
}

async function settle(ms: number): Promise<void> {
  const { act } = await import("react");
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("waitFor: condition never held");
    await settle(5);
  }
}

async function run(fn: () => void): Promise<void> {
  const { act } = await import("react");
  await act(async () => { fn(); });
}

async function open(socket: FakeSocket): Promise<void> {
  await run(() => { socket.readyState = 1; socket.onopen?.(); });
}

/** Whether `send` reaches this socket, i.e. whether it is the one the hook holds. */
async function isCurrent(socket: FakeSocket): Promise<boolean> {
  const before = socket.sent.length;
  await run(() => latest!.send({ type: "heartbeat" }));
  return socket.sent.length > before;
}

let releaseNonce: (() => void) | null = null;
let mounted: Mounted | null = null;

beforeEach(() => {
  FakeSocket.instances = [];
  latest = null;
  releaseNonce = null;
  installGlobal("WebSocket", FakeSocket);
  installGlobal("fetch", async () =>
    new Response(JSON.stringify({ ok: true, data: { nonce: "n" } })));
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});
afterAll(uninstallDom);

describe("android viewer reconnects", () => {
  it("is not undone by the close of the socket a manual reconnect replaced", async () => {
    mounted = await mount(<Viewer />);
    await waitFor(() => FakeSocket.instances.length === 1);
    const old = FakeSocket.instances[0]!;
    await open(old);

    await run(() => latest!.reconnect());
    await waitFor(() => FakeSocket.instances.length === 2);
    const fresh = FakeSocket.instances[1]!;
    await open(fresh);
    await run(() => old.onclose?.());        // the replaced socket's close lands afterwards

    expect(await isCurrent(fresh)).toBe(true);
    expect(latest!.state).toBe("connecting");
    await settle(PAST_FIRST_RETRY_MS);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("ignores what the socket a manual reconnect replaced still delivers", async () => {
    mounted = await mount(<Viewer />);
    await waitFor(() => FakeSocket.instances.length === 1);
    const old = FakeSocket.instances[0]!;
    await open(old);

    await run(() => latest!.reconnect());
    await waitFor(() => FakeSocket.instances.length === 2);
    // Queued on the old socket before its close: a `ready` and a keyframe arrive while the new
    // socket is still connecting.
    const ready = {
      type: "ready", sessionId: "old", sessionGeneration: 1, controller: true, codec: null, encoder: "libx264",
      geometry: { width: 1080, height: 1920, deviceWidth: 1080, deviceHeight: 1920, rotation: 0, generation: 1 },
    };
    const keyframe = encodeVideoFrame(
      { keyframe: true, codecConfig: false, sessionGeneration: 1, geometryGeneration: 1, sequence: 1, ptsMs: 0 },
      new Uint8Array([0, 0, 0, 1, 0x65]),
    );
    await run(() => old.onmessage?.({ data: JSON.stringify(ready) }));
    await run(() => old.onmessage?.({ data: keyframe.buffer }));

    expect(latest!.state).toBe("connecting");
    expect(latest!.encoder).toBeNull();
    expect(latest!.hasPicture).toBe(false);
  });

  it("drops a scheduled retry when the user reconnects first", async () => {
    mounted = await mount(<Viewer />);
    await waitFor(() => FakeSocket.instances.length === 1);
    const lost = FakeSocket.instances[0]!;
    await open(lost);
    await run(() => { lost.readyState = 3; lost.onclose?.(); });   // the host went away
    expect(latest!.state).toBe("reconnecting");

    await run(() => latest!.reconnect());
    await waitFor(() => FakeSocket.instances.length === 2);
    const fresh = FakeSocket.instances[1]!;
    await open(fresh);
    await settle(PAST_FIRST_RETRY_MS);

    expect(FakeSocket.instances).toHaveLength(2);
    expect(await isCurrent(fresh)).toBe(true);
  });

  it("opens no socket for a viewer that closed while its nonce was being minted", async () => {
    installGlobal("fetch", () => new Promise<Response>((resolve) => {
      releaseNonce = () => resolve(new Response(JSON.stringify({ ok: true, data: { nonce: "n" } })));
    }));
    mounted = await mount(<Viewer />);
    await waitFor(() => releaseNonce !== null);

    await mounted.unmount();
    mounted = null;
    releaseNonce!();
    await settle(50);

    expect(FakeSocket.instances).toHaveLength(0);
  });
});
