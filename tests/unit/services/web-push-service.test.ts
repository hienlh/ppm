import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { parsePushSubscription, pushTargetUrl, webPushService } from "../../../src/services/web-push/web-push.service.ts";
import { listSubscriptions, MAX_PUSH_DEVICES, upsertSubscription } from "../../../src/services/web-push/web-push-store.ts";
import { decryptPushBody, makeReceiver, type TestReceiver } from "../../helpers/web-push-receiver.ts";

const realFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = realFetch; });

interface Captured { url: string; headers: Headers; body: Uint8Array<ArrayBuffer> }
let captured: Captured[];
let respond: (url: string) => Response;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  captured.push({ url, headers: new Headers(init?.headers), body: new Uint8Array(init?.body as Uint8Array) });
  return respond(url);
}) as typeof fetch;

const message = {
  title: "Chat completed · devbox",
  body: "ppm — Fix login",
  path: "/project/ppm?openChat=s1",
  tag: "ppm-s1",
  project: "ppm",
  sessionId: "s1",
  urgency: "high" as const,
};

async function subscribe(endpoint: string, origin = "https://ppm.example.ts.net"): Promise<TestReceiver> {
  const receiver = await makeReceiver();
  await webPushService.subscribe(receiver.subscription(endpoint), "Chrome on Android", origin);
  return receiver;
}

describe("parsePushSubscription", () => {
  it("accepts what PushSubscription.toJSON() gives", async () => {
    const sub = (await makeReceiver()).subscription("https://fcm.googleapis.com/fcm/send/abc");
    expect(parsePushSubscription(sub)).toEqual({ ok: true, value: sub });
  });

  it("refuses anything the server should not POST to or cannot encrypt for", async () => {
    const sub = (await makeReceiver()).subscription("https://fcm.googleapis.com/fcm/send/abc");
    expect(parsePushSubscription({ ...sub, endpoint: "http://127.0.0.1:8080/x" })).toMatchObject({ ok: false, error: "Push endpoint must be https" });
    expect(parsePushSubscription({ ...sub, endpoint: "not a url" })).toMatchObject({ ok: false });
    expect(parsePushSubscription({ ...sub, keys: { ...sub.keys, p256dh: sub.keys.auth } })).toMatchObject({ ok: false, error: "Invalid p256dh key" });
    expect(parsePushSubscription({ ...sub, keys: { ...sub.keys, auth: "AAAA" } })).toMatchObject({ ok: false, error: "Invalid auth secret" });
    expect(parsePushSubscription(null)).toMatchObject({ ok: false });
  });
});

describe("pushTargetUrl", () => {
  it("opens the origin push was turned on from", () => {
    expect(pushTargetUrl("https://ppm.tail1.ts.net", "/project/a?openChat=1", null)).toBe("https://ppm.tail1.ts.net/project/a?openChat=1");
    expect(pushTargetUrl("http://localhost:8080", "/", "https://x.trycloudflare.com")).toBe("http://localhost:8080/");
  });

  it("moves a stale quick-tunnel origin to today's tunnel", () => {
    expect(pushTargetUrl("https://old-words.trycloudflare.com", "/p", "https://new-words.trycloudflare.com"))
      .toBe("https://new-words.trycloudflare.com/p");
    expect(pushTargetUrl("https://same.trycloudflare.com", "/p", "https://same.trycloudflare.com/")).toBe("https://same.trycloudflare.com/p");
    // No tunnel running: nothing better to offer.
    expect(pushTargetUrl("https://old.trycloudflare.com", "/p", null)).toBe("https://old.trycloudflare.com/p");
  });
});

describe("webPushService.send", () => {
  beforeEach(() => {
    setDb(openTestDb());
    captured = [];
    respond = () => new Response(null, { status: 201 });
  });

  it("sends an encrypted, VAPID-signed message each browser can decrypt", async () => {
    const receiver = await subscribe("https://fcm.googleapis.com/fcm/send/abc");
    const result = await webPushService.send(message);
    expect(result).toEqual({ sent: 1, failed: 0, removed: 0 });

    const [req] = captured;
    expect(req!.url).toBe("https://fcm.googleapis.com/fcm/send/abc");
    expect(req!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(req!.headers.get("urgency")).toBe("high");
    expect(Number(req!.headers.get("ttl"))).toBeGreaterThan(0);
    expect(req!.headers.get("authorization")).toStartWith("vapid t=");
    expect(req!.headers.get("authorization")).toContain(`k=${await webPushService.publicKey()}`);

    const payload = JSON.parse(new TextDecoder().decode(await decryptPushBody(req!.body, receiver)));
    expect(payload).toEqual({
      title: "Chat completed · devbox",
      body: "ppm — Fix login",
      url: "https://ppm.example.ts.net/project/ppm?openChat=s1",
      tag: "ppm-s1",
      project: "ppm",
      sessionId: "s1",
    });
    expect(webPushService.devices()[0]!.lastSuccessAt).toBeNumber();
  });

  it("forgets a browser the push service says is gone, and records other failures", async () => {
    await subscribe("https://push.example/gone");
    await subscribe("https://push.example/broken");
    respond = (url) => url.endsWith("/gone") ? new Response("", { status: 410 }) : new Response("quota", { status: 429 });
    const result = await webPushService.send(message);
    expect(result).toEqual({ sent: 0, failed: 1, removed: 1 });
    const devices = webPushService.devices();
    expect(devices.map((d) => d.origin)).toHaveLength(1);
    expect(devices[0]!.lastError).toBe("429 quota");
  });

  it("does not send to a subscription made with another key, and says why", async () => {
    const receiver = await makeReceiver();
    const sub = receiver.subscription("https://push.example/old-key");
    upsertSubscription({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, label: "Old", origin: "https://a.example", vapidKey: "a-previous-key" });
    const result = await webPushService.send(message);
    expect(result).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect(captured).toHaveLength(0);
    expect(webPushService.devices()[0]!.lastError).toContain("old key");
  });

  it("sends to one device when filtered, and keys never leave the server", async () => {
    await subscribe("https://push.example/a");
    await subscribe("https://push.example/b");
    const [newest] = webPushService.devices();
    await webPushService.send(message, (d) => d.id === newest!.id);
    expect(captured.map((c) => c.url)).toEqual(["https://push.example/b"]);
    // The endpoint is how a browser finds its own row; the keys that decrypt a push stay here.
    expect(Object.keys(newest!).sort()).toEqual(["createdAt", "endpoint", "id", "label", "lastError", "lastSuccessAt", "origin"]);
  });

  it("keeps one row per endpoint and caps the list", async () => {
    await subscribe("https://push.example/same");
    await subscribe("https://push.example/same");
    expect(listSubscriptions()).toHaveLength(1);
    for (let i = 0; i < MAX_PUSH_DEVICES + 3; i++) {
      upsertSubscription({ endpoint: `https://push.example/${i}`, p256dh: "x", auth: "y", label: "L", origin: "https://o", vapidKey: "k" });
    }
    expect(listSubscriptions()).toHaveLength(MAX_PUSH_DEVICES);
    expect(listSubscriptions()[0]!.endpoint).toBe(`https://push.example/${MAX_PUSH_DEVICES + 2}`);
  });

  it("does not follow a push service's redirect somewhere else", async () => {
    // Real requests to a local server: the fake fetch above cannot say whether one would be followed.
    const hits: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        hits.push(path);
        return path === "/push"
          ? new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${server.port}/internal` } })
          : new Response(null, { status: 201 });
      },
    });
    const fakeFetch = globalThis.fetch;
    globalThis.fetch = realFetch;
    try {
      const receiver = await makeReceiver();
      const sub = receiver.subscription(`http://127.0.0.1:${server.port}/push`);
      // Stored directly: subscribe() refuses the plain-http address a test server has.
      upsertSubscription({
        endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
        label: "Redirected", origin: "https://ppm.example.ts.net", vapidKey: await webPushService.publicKey(),
      });
      const result = await webPushService.send(message);
      expect(hits).toEqual(["/push"]);
      expect(result).toEqual({ sent: 0, failed: 1, removed: 0 });
      expect(webPushService.devices()[0]!.lastError).toBe("307");
    } finally {
      globalThis.fetch = fakeFetch;
      server.stop(true);
    }
  });

  it("makes one key pair even when two first requests race, and keeps it", async () => {
    const [a, b] = await Promise.all([webPushService.publicKey(), webPushService.publicKey()]);
    expect(a).toBe(b);
    expect(await webPushService.publicKey()).toBe(a);
  });
});
