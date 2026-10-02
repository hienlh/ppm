import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { configService } from "../../src/services/config.service";
import { remoteDesktopRoutes } from "../../src/server/routes/remote-desktop";
import {
  clearWhepTickets, registerWhepTarget,
} from "../../src/services/remote-desktop/remote-desktop-whep-registry";

/**
 * The WHEP proxy is the only way into the relay, whose own port is bound to loopback. These
 * cover what that buys: a client can name a *ticket* and nothing else, so no request it makes
 * can point PPM at an arbitrary upstream.
 */

const ANSWER_SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";

let upstream: ReturnType<typeof Bun.serve>;
let upstreamHits = 0;
let app: Hono;

beforeAll(async () => {
  await configService.load();
  await configService.set("auth", { ...configService.get("auth"), enabled: true } as any);
  // Stands in for MediaMTX: answers SDP the way the relay's WHEP endpoint does.
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      upstreamHits++;
      if (!(req.headers.get("content-type") ?? "").startsWith("application/sdp")) {
        return new Response("wrong type", { status: 415 });
      }
      return new Response(ANSWER_SDP, { status: 201, headers: { "content-type": "application/sdp" } });
    },
  });
  app = new Hono();
  app.route("/api/remote-desktop", remoteDesktopRoutes);
});

afterAll(() => upstream?.stop(true));
beforeEach(() => { clearWhepTickets(); upstreamHits = 0; });

const offer = (body = "v=0\r\n") =>
  ({ method: "POST", headers: { "content-type": "application/sdp" }, body });

describe("the WHEP proxy", () => {
  it("forwards an offer to the ticket's relay and returns the answer", async () => {
    const ticket = registerWhepTarget(`http://127.0.0.1:${upstream.port}/s1/whep`);
    const res = await app.request(`/api/remote-desktop/whep/${ticket}`, offer());
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/sdp");
    expect(await res.text()).toBe(ANSWER_SDP);
    expect(upstreamHits).toBe(1);
  });

  // The point of the indirection: there is no parameter that can name an upstream, so a
  // request cannot be aimed anywhere PPM did not choose.
  it("reaches no upstream at all for an unknown ticket", async () => {
    const res = await app.request("/api/remote-desktop/whep/not-a-real-ticket", offer());
    expect(res.status).toBe(404);
    expect(upstreamHits).toBe(0);
  });

  it("refuses a body that is not SDP before it forwards anything", async () => {
    const ticket = registerWhepTarget(`http://127.0.0.1:${upstream.port}/s1/whep`);
    const res = await app.request(`/api/remote-desktop/whep/${ticket}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(415);
    expect(upstreamHits).toBe(0);
  });

  it("caps the offer size rather than streaming anything the client sends", async () => {
    const ticket = registerWhepTarget(`http://127.0.0.1:${upstream.port}/s1/whep`);
    const res = await app.request(`/api/remote-desktop/whep/${ticket}`, offer("x".repeat(65 * 1024)));
    expect(res.status).toBe(413);
    expect(upstreamHits).toBe(0);
  });

  // A relay that died between the ticket being handed out and the handshake must read as a
  // host-side fault, not as a bad request the client could fix by retrying differently.
  it("answers 502 when the relay is gone", async () => {
    const dead = registerWhepTarget("http://127.0.0.1:1/s1/whep");
    const res = await app.request(`/api/remote-desktop/whep/${dead}`, offer());
    expect(res.status).toBe(502);
  });
});
