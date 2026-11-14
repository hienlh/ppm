/**
 * POST /api/loopback/callback makes a request from the PPM host. It must
 * accept what the browser's field accepts (a phone's copy without `http://`)
 * and refuse anything that is not this machine — on its own, whatever the
 * browser sent, because a script can call the route without the field.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { loopbackRoutes } from "../../../src/server/routes/oauth-loopback.ts";

let listener: ReturnType<typeof Bun.serve>;
const received: string[] = [];

beforeAll(() => {
  listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      received.push(new URL(req.url).pathname + new URL(req.url).search);
      return new Response("You can close this window.", { status: 200 });
    },
  });
});
afterAll(() => listener.stop(true));
afterEach(() => {
  received.length = 0;
  globalThis.fetch = realFetch;
});

const realFetch = globalThis.fetch;

/** Counts every request the route sends out, so a refusal can be shown to have sent nothing. */
function spyOnFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return realFetch(input, init);
  }) as typeof fetch;
  return { calls };
}

async function post(body: unknown) {
  const res = await loopbackRoutes.request("/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: { status: number; body: string }; error?: string } };
}

describe("POST /api/loopback/callback", () => {
  it("delivers a scheme-less callback a phone copied", async () => {
    const { status, json } = await post({ url: `  127.0.0.1:${listener.port}/oauth/callback?code=c1&state=s.\n` });
    expect(status).toBe(200);
    expect(json.data?.status).toBe(200);
    expect(received).toEqual(["/oauth/callback?code=c1&state=s"]);
  });

  it("delivers a full http:// callback as before", async () => {
    const { status } = await post({ url: `http://127.0.0.1:${listener.port}/cb?code=c2` });
    expect(status).toBe(200);
    expect(received).toEqual(["/cb?code=c2"]);
  });

  it("refuses every way of dressing another host up as this one, and sends nothing", async () => {
    const spy = spyOnFetch();
    const port = listener.port;
    for (const url of [
      `localhost.evil.com:${port}/cb`,
      `http://localhost.evil.com:${port}/cb`,
      `127.0.0.1@evil.com/cb`,
      `http://127.0.0.1:${port}@evil.com/cb`,
      `http://evil.com#127.0.0.1:${port}`,
      `evil.com/?u=http://127.0.0.1:${port}`,
      `http://[::ffff:127.0.0.1]:${port}/cb`,
      `http://[fe80::1]:${port}/cb`,
      `HTTP://LOCALHOST.EVIL.COM:${port}/cb`,
      `http://169.254.169.254/latest/meta-data`,
      `0.0.0.0:${port}/cb`,
      `127.0.0.1:0/cb`,
      `127.0.0.1:70000/cb`,
      `file:///etc/passwd`,
      `ftp://127.0.0.1:${port}/cb`,
      `http://user:pw@127.0.0.1:${port}/cb`,
    ]) {
      const { status, json } = await post({ url });
      expect({ url, status }).toEqual({ url, status: 400 });
      expect(json.ok).toBe(false);
    }
    expect(spy.calls).toEqual([]);
    expect(received).toEqual([]);
  });

  it("refuses a missing, non-string or oversized url", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ url: 42 })).status).toBe(400);
    expect((await post({ url: "   " })).status).toBe(400);
    expect((await post({ url: `127.0.0.1:${listener.port}/cb?code=${"a".repeat(9000)}` })).status).toBe(400);
    const res = await loopbackRoutes.request("/callback", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect(received).toEqual([]);
  });

  it("says nothing answered when no listener is on the port", async () => {
    // Bind and release a port so nothing is listening on it.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const freePort = probe.port;
    probe.stop(true);
    const { status, json } = await post({ url: `127.0.0.1:${freePort}/cb` });
    expect(status).toBe(502);
    expect(json.error).toContain("127.0.0.1");
  });
});
