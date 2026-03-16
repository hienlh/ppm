import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for push-notification.service.ts
 *
 * Strategy: Test file-based subscription CRUD logic directly (same algorithm as service)
 * since the service singleton is tightly coupled to configService + web-push.
 * Route-level integration tests cover the full service through HTTP.
 */

// --- Subscription file helpers (mirror service logic) ---

interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

function loadSubscriptions(path: string): PushSubscriptionData[] {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8"));
  } catch { /* corrupt → fresh */ }
  return [];
}

function saveSubscriptions(path: string, subs: PushSubscriptionData[]): void {
  writeFileSync(path, JSON.stringify(subs, null, 2), "utf-8");
}

function addSubscription(path: string, sub: PushSubscriptionData): void {
  const subs = loadSubscriptions(path).filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub);
  saveSubscriptions(path, subs);
}

function removeSubscription(path: string, endpoint: string): void {
  saveSubscriptions(path, loadSubscriptions(path).filter((s) => s.endpoint !== endpoint));
}

// --- Tests ---

describe("push-notification.service", () => {
  const testDir = resolve(tmpdir(), `ppm-push-test-${Date.now()}`);
  const testSubsPath = resolve(testDir, "push-subscriptions.json");

  const sub1: PushSubscriptionData = {
    endpoint: "https://fcm.googleapis.com/fcm/send/sub1",
    keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpC7iq" },
  };
  const sub2: PushSubscriptionData = {
    endpoint: "https://fcm.googleapis.com/fcm/send/sub2",
    keys: { p256dh: "BMn2PLe1w1C5aAn3LHKzXMz6cdExX", auth: "x9gQ2bHCNeR" },
    expirationTime: null,
  };

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    try { unlinkSync(testSubsPath); } catch {}
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  describe("loadSubscriptions", () => {
    it("returns empty array when file does not exist", () => {
      expect(loadSubscriptions(testSubsPath)).toEqual([]);
    });

    it("returns empty array when file contains invalid JSON", () => {
      writeFileSync(testSubsPath, "{{broken json!!", "utf-8");
      expect(loadSubscriptions(testSubsPath)).toEqual([]);
    });

    it("returns parsed subscriptions from valid file", () => {
      saveSubscriptions(testSubsPath, [sub1, sub2]);
      const result = loadSubscriptions(testSubsPath);
      expect(result).toHaveLength(2);
      expect(result[0].endpoint).toBe(sub1.endpoint);
      expect(result[1].endpoint).toBe(sub2.endpoint);
    });
  });

  describe("saveSubscriptions", () => {
    it("creates file with formatted JSON", () => {
      saveSubscriptions(testSubsPath, [sub1]);
      const raw = readFileSync(testSubsPath, "utf-8");
      expect(raw).toContain("  "); // pretty-printed
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].endpoint).toBe(sub1.endpoint);
    });

    it("overwrites existing file", () => {
      saveSubscriptions(testSubsPath, [sub1, sub2]);
      saveSubscriptions(testSubsPath, [sub2]);
      expect(loadSubscriptions(testSubsPath)).toHaveLength(1);
    });
  });

  describe("addSubscription (deduplication)", () => {
    it("adds new subscription to empty list", () => {
      addSubscription(testSubsPath, sub1);
      const result = loadSubscriptions(testSubsPath);
      expect(result).toHaveLength(1);
      expect(result[0].endpoint).toBe(sub1.endpoint);
    });

    it("adds second subscription alongside existing", () => {
      addSubscription(testSubsPath, sub1);
      addSubscription(testSubsPath, sub2);
      expect(loadSubscriptions(testSubsPath)).toHaveLength(2);
    });

    it("deduplicates by endpoint — replaces keys", () => {
      addSubscription(testSubsPath, sub1);
      const updated = { ...sub1, keys: { p256dh: "NEW_KEY", auth: "NEW_AUTH" } };
      addSubscription(testSubsPath, updated);

      const result = loadSubscriptions(testSubsPath);
      expect(result).toHaveLength(1);
      expect(result[0].keys.p256dh).toBe("NEW_KEY");
      expect(result[0].keys.auth).toBe("NEW_AUTH");
    });

    it("preserves expirationTime field", () => {
      const subWithExpiry = { ...sub1, expirationTime: 1700000000000 };
      addSubscription(testSubsPath, subWithExpiry);
      const result = loadSubscriptions(testSubsPath);
      expect(result[0].expirationTime).toBe(1700000000000);
    });
  });

  describe("removeSubscription", () => {
    it("removes matching endpoint", () => {
      addSubscription(testSubsPath, sub1);
      addSubscription(testSubsPath, sub2);
      removeSubscription(testSubsPath, sub1.endpoint);

      const result = loadSubscriptions(testSubsPath);
      expect(result).toHaveLength(1);
      expect(result[0].endpoint).toBe(sub2.endpoint);
    });

    it("no-op when endpoint not found", () => {
      addSubscription(testSubsPath, sub1);
      removeSubscription(testSubsPath, "https://nonexistent.com/push");
      expect(loadSubscriptions(testSubsPath)).toHaveLength(1);
    });

    it("handles removal from empty file", () => {
      saveSubscriptions(testSubsPath, []);
      removeSubscription(testSubsPath, sub1.endpoint);
      expect(loadSubscriptions(testSubsPath)).toEqual([]);
    });
  });

  describe("expired subscription cleanup logic", () => {
    it("removes 410/404 subscriptions after notifyAll", () => {
      // Simulate: subs exist, some marked expired, cleanup runs
      addSubscription(testSubsPath, sub1);
      addSubscription(testSubsPath, sub2);

      // Simulate expired endpoints (410 from push service)
      const expired = [sub1.endpoint];
      const remaining = loadSubscriptions(testSubsPath).filter(
        (s) => !expired.includes(s.endpoint),
      );
      saveSubscriptions(testSubsPath, remaining);

      const result = loadSubscriptions(testSubsPath);
      expect(result).toHaveLength(1);
      expect(result[0].endpoint).toBe(sub2.endpoint);
    });

    it("keeps all subs when none are expired", () => {
      addSubscription(testSubsPath, sub1);
      addSubscription(testSubsPath, sub2);

      const expired: string[] = [];
      const remaining = loadSubscriptions(testSubsPath).filter(
        (s) => !expired.includes(s.endpoint),
      );
      saveSubscriptions(testSubsPath, remaining);

      expect(loadSubscriptions(testSubsPath)).toHaveLength(2);
    });
  });

  describe("VAPID key generation logic", () => {
    it("web-push generateVAPIDKeys produces valid key pair", async () => {
      // Test that the library we depend on works in Bun runtime
      const webpush = await import("web-push");
      const keys = webpush.generateVAPIDKeys();
      expect(keys.publicKey).toBeTruthy();
      expect(keys.privateKey).toBeTruthy();
      expect(typeof keys.publicKey).toBe("string");
      expect(typeof keys.privateKey).toBe("string");
      // VAPID keys are base64url encoded
      expect(keys.publicKey.length).toBeGreaterThan(40);
      expect(keys.privateKey.length).toBeGreaterThan(20);
    });
  });

  describe("notification payload format", () => {
    it("creates valid JSON payload with title and body", () => {
      const payload = JSON.stringify({
        title: "Chat completed",
        body: "my-project — Session abc123",
      });
      const parsed = JSON.parse(payload);
      expect(parsed.title).toBe("Chat completed");
      expect(parsed.body).toBe("my-project — Session abc123");
    });

    it("handles unicode in project/session names", () => {
      const payload = JSON.stringify({
        title: "Chat completed",
        body: "dự-án-mới — Phiên chat thứ nhất",
      });
      const parsed = JSON.parse(payload);
      expect(parsed.body).toContain("dự-án-mới");
    });
  });
});
