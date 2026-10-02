/**
 * A viewer whose WebRTC cannot connect falls back to the WebSocket stream.
 *
 * WebRTC's media is UDP straight to the host's interface addresses. A viewer on the Cloudflare
 * tunnel completes the WHEP handshake (it is proxied over HTTPS) and then has no route for the
 * media, so before this the picture simply never came: Chromium takes 15 s to declare the
 * connection `failed`, and then the viewer showed an error with a perfectly good WebSocket
 * stream one reconnect away. These drive the real connection hook against a fake socket and a
 * fake peer connection, so what is asserted is what the hook sends to the host.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { useRef } from "react";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import {
  useRemoteDesktopConnection, type UseRemoteDesktopConnectionResult,
} from "../../../src/web/components/remote-desktop/use-remote-desktop-connection.ts";
import { CONNECT_DEADLINE_MS } from "../../../src/web/components/remote-desktop/use-webrtc-canvas-video.ts";

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
  close() { this.readyState = 3; }
  /** The `auth` message this socket opened with. */
  auth() { return this.sent.find((m) => m.type === "auth"); }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: { sdp: string } | null = null;
  answered = false;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: unknown = null;
  constructor() { FakePeerConnection.instances.push(this); }
  addTransceiver() {}
  async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
  async setLocalDescription(d: { sdp: string }) { this.localDescription = d; }
  async setRemoteDescription() { this.answered = true; }
  addEventListener() {}
  removeEventListener() {}
  async getStats() { return new Map(); }
  close() { this.connectionState = "closed"; }
  /** What the browser does when ICE gives up. */
  fail() { this.connectionState = "failed"; this.onconnectionstatechange?.(); }
}

let latest: UseRemoteDesktopConnectionResult | null = null;
function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  latest = useRemoteDesktopConnection(canvasRef);
  return <canvas ref={canvasRef} />;
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const { act } = await import("react");
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("waitFor: condition never held");
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

/** Open the socket the hook made and have the host answer with its relay. */
async function grantWebrtc(ws: FakeSocket): Promise<FakePeerConnection> {
  const { act } = await import("react");
  await act(async () => { ws.readyState = 1; ws.onopen?.(); });
  await act(async () => {
    ws.onmessage?.({ data: JSON.stringify({ type: "webrtc", whepPath: "/api/remote-desktop/whep/t1", preset: "balanced" }) });
  });
  await waitFor(() => FakePeerConnection.instances.at(-1)?.answered === true);
  return FakePeerConnection.instances.at(-1)!;
}

let mounted: Mounted | null = null;

beforeEach(() => {
  FakeSocket.instances = [];
  FakePeerConnection.instances = [];
  latest = null;
  sessionStorage.clear();
  installGlobal("WebSocket", FakeSocket);
  installGlobal("RTCPeerConnection", FakePeerConnection);
  installGlobal("VideoDecoder", class {});
  installGlobal("fetch", async (url: string) => {
    if (String(url).includes("/api/remote-desktop/session")) {
      return new Response(JSON.stringify({ ok: true, data: { nonce: "n", wsPath: "/ws/remote-desktop" } }));
    }
    if (String(url).includes("/api/remote-desktop/whep/")) return new Response("v=0 answer", { status: 201 });
    return new Response(JSON.stringify({ ok: true, data: null }));
  });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  jest.useRealTimers();
  sessionStorage.clear();
});
afterAll(uninstallDom);

describe("remote desktop WebRTC fallback", () => {
  it("reconnects on the WebSocket stream when the WebRTC connection fails", async () => {
    mounted = await mount(<Viewer />);
    await waitFor(() => FakeSocket.instances.length === 1);
    const first = FakeSocket.instances[0]!;
    const pc = await grantWebrtc(first);
    expect(first.auth()?.webrtc).toBe(true);

    const { act } = await import("react");
    await act(async () => { pc.fail(); });

    await waitFor(() => FakeSocket.instances.length === 2);
    const second = FakeSocket.instances[1]!;
    await act(async () => { second.readyState = 1; second.onopen?.(); });
    expect(second.auth()?.webrtc).toBe(false);
    expect(latest?.transport).toBe("websocket");
    expect(first.readyState).toBe(3);
  });

  it("does not wait out the browser's own 15 s when ICE never connects", async () => {
    mounted = await mount(<Viewer />);
    await waitFor(() => FakeSocket.instances.length === 1);
    jest.useFakeTimers();
    await grantWebrtc(FakeSocket.instances[0]!);

    const { act } = await import("react");
    await act(async () => { jest.advanceTimersByTime(CONNECT_DEADLINE_MS - 1); });
    expect(FakeSocket.instances).toHaveLength(1);
    await act(async () => { jest.advanceTimersByTime(1); });
    jest.useRealTimers();

    await waitFor(() => FakeSocket.instances.length === 2);
  });

  it("asks for the WebSocket stream straight away in a viewer reopened in the same tab", async () => {
    mounted = await mount(<Viewer />);
    await waitFor(() => FakeSocket.instances.length === 1);
    const pc = await grantWebrtc(FakeSocket.instances[0]!);
    const { act } = await import("react");
    await act(async () => { pc.fail(); });
    await waitFor(() => FakeSocket.instances.length === 2);
    await mounted.unmount();

    mounted = await mount(<Viewer />);
    await waitFor(() => FakeSocket.instances.length === 3);
    const reopened = FakeSocket.instances[2]!;
    await act(async () => { reopened.readyState = 1; reopened.onopen?.(); });
    expect(reopened.auth()?.webrtc).toBe(false);
  });

  it("keeps the error where WebCodecs is missing, since the WebSocket stream could not be decoded either", async () => {
    installGlobal("VideoDecoder", undefined); // a plain-HTTP origin
    mounted = await mount(<Viewer />);
    await waitFor(() => FakeSocket.instances.length === 1);
    const pc = await grantWebrtc(FakeSocket.instances[0]!);

    const { act } = await import("react");
    await act(async () => { pc.fail(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(FakeSocket.instances).toHaveLength(1);
    expect(latest?.decoderErrorMessage).toBe("The WebRTC connection failed.");
  });
});
