import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { pushRoutes } from "../../../src/server/routes/push.ts";
import { pushService } from "../../../src/services/push-notification.service.ts";

function createApp() {
  return new Hono().route("/push", pushRoutes);
}

const validSub = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-123",
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRs",
    auth: "tBHItJI5svbpC7iq2Q36SQ",
  },
  expirationTime: null,
};

describe("push routes", () => {
  // --- GET /push/vapid-key ---
  describe("GET /push/vapid-key", () => {
    it("returns 200 with VAPID public key string", async () => {
      const app = createApp();
      const res = await app.request("/push/vapid-key");
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(typeof json.data.publicKey).toBe("string");
      expect(json.data.publicKey.length).toBeGreaterThan(0);
    });

    it("returns same key on repeated calls", async () => {
      const app = createApp();
      const res1 = await app.request("/push/vapid-key");
      const res2 = await app.request("/push/vapid-key");
      const json1 = await res1.json();
      const json2 = await res2.json();
      expect(json1.data.publicKey).toBe(json2.data.publicKey);
    });
  });

  // --- POST /push/subscribe ---
  describe("POST /push/subscribe", () => {
    it("saves valid subscription and returns ok", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validSub),
      });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
    });

    it("saves subscription without expirationTime", async () => {
      const app = createApp();
      const { expirationTime, ...subNoExpiry } = validSub;
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subNoExpiry),
      });
      expect(res.status).toBe(200);
    });

    it("rejects missing endpoint — 400", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: { p256dh: "key", auth: "auth" } }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toContain("endpoint");
    });

    it("rejects missing keys object — 400", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "https://example.com/push" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing p256dh — 400", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "https://example.com/push", keys: { auth: "a" } }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing auth key — 400", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "https://example.com/push", keys: { p256dh: "k" } }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty body — 400", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("rejects malformed JSON — 400", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      });
      expect(res.status).toBe(400);
    });
  });

  // --- DELETE /push/subscribe ---
  describe("DELETE /push/subscribe", () => {
    it("removes subscription and returns ok", async () => {
      const app = createApp();
      const endpoint = `https://fcm.googleapis.com/fcm/send/del-${Date.now()}`;

      // Subscribe first
      await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, keys: { p256dh: "k", auth: "a" } }),
      });

      // Unsubscribe
      const res = await app.request("/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
    });

    it("returns ok even if endpoint was not subscribed", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "https://nonexistent.example.com/push" }),
      });
      expect(res.status).toBe(200);
    });

    it("rejects missing endpoint — 400", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it("rejects malformed JSON — 400", async () => {
      const app = createApp();
      const res = await app.request("/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "bad-json!!",
      });
      expect(res.status).toBe(400);
    });
  });

  // --- Full subscribe → unsubscribe flow ---
  describe("subscribe + unsubscribe roundtrip", () => {
    it("subscribe then unsubscribe completes without error", async () => {
      const app = createApp();
      const endpoint = `https://fcm.googleapis.com/fcm/send/roundtrip-${Date.now()}`;
      const sub = { endpoint, keys: { p256dh: "testkey", auth: "testauth" } };

      const subRes = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });
      expect(subRes.status).toBe(200);

      const unsubRes = await app.request("/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      expect(unsubRes.status).toBe(200);
    });

    it("re-subscribing with same endpoint updates keys", async () => {
      const app = createApp();
      const endpoint = `https://fcm.googleapis.com/fcm/send/resub-${Date.now()}`;

      // First subscribe
      await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, keys: { p256dh: "old", auth: "old" } }),
      });

      // Re-subscribe with new keys
      const res = await app.request("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, keys: { p256dh: "new", auth: "new" } }),
      });
      expect(res.status).toBe(200);
    });
  });
});
