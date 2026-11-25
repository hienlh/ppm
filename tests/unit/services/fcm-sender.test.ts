import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { validateFcmUpdate, saveFcmConfig } from "../../../src/services/fcm/fcm-config.ts";
import { fcmSendUrl, fcmTokenUrl, FCM_API_BASE_ENV, FCM_OAUTH_BASE_ENV } from "../../../src/services/fcm/fcm-api-base.ts";
import { _resetFcmTokenCacheForTests, fcmDataJson, MAX_FCM_DATA_BYTES } from "../../../src/services/fcm/fcm-sender.ts";
import { webPushService } from "../../../src/services/web-push/web-push.service.ts";
import { listSubscriptions, upsertSubscription } from "../../../src/services/web-push/web-push-store.ts";
import type { WebPushPayload } from "../../../src/shared/web-push-payload.ts";
import {
  invalidToken,
  makeGoogleServices,
  makeServiceAccount,
  PROJECT_ID,
  startFakeGoogle,
  unregistered,
  type FakeGoogle,
  type TestServiceAccount,
} from "../../helpers/fcm-fixtures.ts";

const TOKEN_A = `fcm-token-A:${"a".repeat(140)}`;
const TOKEN_B = `fcm-token-B:${"b".repeat(140)}`;

const message = {
  title: "Chat completed · devbox",
  body: "ppm — Fix login",
  path: "/project/ppm?openChat=s1",
  tag: "ppm-s1",
  project: "ppm",
  sessionId: "s1",
  providerId: "claude",
  urgency: "high" as const,
};

let google: FakeGoogle;
let sa: TestServiceAccount;

beforeAll(async () => {
  google = startFakeGoogle();
  process.env[FCM_OAUTH_BASE_ENV] = google.base;
  process.env[FCM_API_BASE_ENV] = google.base;
  sa = await makeServiceAccount();
});
afterAll(() => {
  google.stop();
  delete process.env[FCM_OAUTH_BASE_ENV];
  delete process.env[FCM_API_BASE_ENV];
});

async function configure(): Promise<void> {
  const checked = await validateFcmUpdate({ googleServices: makeGoogleServices(), serviceAccount: sa.json }, null);
  if (!checked.ok) throw new Error(checked.error);
  saveFcmConfig(checked.value);
}

beforeEach(async () => {
  setDb(openTestDb());
  _resetFcmTokenCacheForTests();
  google.requests.length = 0;
  google.respond = () => Response.json({ name: `projects/${PROJECT_ID}/messages/1` });
  google.tokenResponse = () => Response.json({ access_token: `ya29.fake-${google.tokenCalls()}`, expires_in: 3599, token_type: "Bearer" });
  await configure();
});

describe("FCM delivery", () => {
  it("signs in with the service account and sends a data-only message carrying the push payload", async () => {
    webPushService.subscribeFcm({ token: TOKEN_A }, "Android · Pixel 7", "https://ppm.example.ts.net");
    const result = await webPushService.send(message);
    expect(result).toEqual({ sent: 1, failed: 0, removed: 0 });

    const tokenReq = google.requests.find((r) => r.path === "/token")!;
    const form = new URLSearchParams(tokenReq.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".");
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", sa.publicKey, Buffer.from(s!, "base64url"), new TextEncoder().encode(`${h}.${c}`))).toBe(true);

    const [send] = google.sends();
    expect(send!.auth).toBe("Bearer ya29.fake-1");
    expect(Object.keys(send!.json.message).sort()).toEqual(["android", "data", "token"]);
    expect(send!.json.message.token).toBe(TOKEN_A);
    expect(send!.json.message.android).toEqual({ priority: "HIGH", ttl: "86400s" });
    expect(Object.keys(send!.json.message.data)).toEqual(["ppm"]);
    expect(JSON.parse(send!.json.message.data.ppm)).toEqual({
      title: "Chat completed · devbox",
      body: "ppm — Fix login",
      url: "https://ppm.example.ts.net/project/ppm?openChat=s1",
      tag: "ppm-s1",
      project: "ppm",
      sessionId: "s1",
      providerId: "claude",
    } satisfies WebPushPayload);
    expect(webPushService.devices()[0]!.lastSuccessAt).toBeNumber();
  });

  it("sends the bare path when the app gave no origin", async () => {
    webPushService.subscribeFcm({ token: TOKEN_A }, "Android", "");
    await webPushService.send(message);
    expect(JSON.parse(google.sends()[0]!.json.message.data.ppm).url).toBe("/project/ppm?openChat=s1");
  });

  it("reuses the access token until five minutes before it expires, and shares one sign-in between devices", async () => {
    webPushService.subscribeFcm({ token: TOKEN_A }, "A", "");
    webPushService.subscribeFcm({ token: TOKEN_B }, "B", "");
    await webPushService.send(message);
    await webPushService.send(message);
    expect(google.sends()).toHaveLength(4);
    expect(google.tokenCalls()).toBe(1);

    // A token that lives less than the five-minute margin is fetched again every time.
    _resetFcmTokenCacheForTests();
    google.requests.length = 0;
    google.tokenResponse = () => Response.json({ access_token: "ya29.short", expires_in: 200 });
    await webPushService.send(message, (d) => d.label === "A");
    await webPushService.send(message, (d) => d.label === "A");
    expect(google.tokenCalls()).toBe(2);
  });

  it("forgets a device whose token is gone or was never one, and keeps one that failed otherwise", async () => {
    const gone = webPushService.subscribeFcm({ token: TOKEN_A }, "Gone", "");
    const invalid = webPushService.subscribeFcm({ token: `bad-token-${"x".repeat(40)}` }, "Invalid", "");
    const busy = webPushService.subscribeFcm({ token: TOKEN_B }, "Busy", "");
    const quota = webPushService.subscribeFcm({ token: `quota-token-${"q".repeat(40)}` }, "Quota", "");
    google.respond = (token) => {
      if (token === TOKEN_A) return unregistered();
      if (token.startsWith("bad-token")) return invalidToken();
      if (token === TOKEN_B) return Response.json({ error: { code: 500, status: "INTERNAL", message: `boom for ${token}` } }, { status: 500 });
      // An INVALID_ARGUMENT about the message itself must not cost the device.
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid JSON payload", details: [{ errorCode: "INVALID_ARGUMENT" }] } }, { status: 400 });
    };
    const result = await webPushService.send(message);
    expect(result).toEqual({ sent: 0, failed: 2, removed: 2 });
    const left = webPushService.devices();
    expect(left.map((d) => d.id).sort()).toEqual([busy.id, quota.id].sort());
    expect(left.some((d) => d.id === gone.id || d.id === invalid.id)).toBe(false);
    const busyNow = left.find((d) => d.id === busy.id)!;
    expect(busyNow.lastError).toBe("Firebase answered 500 INTERNAL");
    expect(left.find((d) => d.id === quota.id)!.lastError).toBe("Firebase answered 400 INVALID_ARGUMENT");
    expect(JSON.stringify(left)).not.toContain(TOKEN_B);
  });

  it("reports a refused sign-in by its code only, and sends nothing", async () => {
    webPushService.subscribeFcm({ token: TOKEN_A }, "A", "");
    google.tokenResponse = () => Response.json({ error: "invalid_grant", error_description: `Invalid JWT Signature for ${sa.json.client_email}` }, { status: 400 });
    expect(await webPushService.send(message)).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect(google.sends()).toHaveLength(0);
    const [device] = webPushService.devices();
    expect(device!.lastError).toBe("Firebase sign-in failed (HTTP 400 invalid_grant)");
  });

  it("keeps a device but sends nothing while Firebase is not set up", async () => {
    setDb(openTestDb());
    webPushService.subscribeFcm({ token: TOKEN_A }, "A", "");
    expect(await webPushService.send(message)).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect(google.requests).toHaveLength(0);
    expect(webPushService.devices()[0]!.lastError).toContain("Settings → Notifications");
  });

  it("sends FCM devices alongside browsers in the same list", async () => {
    upsertSubscription({ endpoint: "https://push.example/old", p256dh: "x", auth: "y", label: "Old browser", origin: "https://o", vapidKey: "a-previous-key" });
    webPushService.subscribeFcm({ token: TOKEN_A }, "Android", "");
    // The browser is skipped for its old key (no request), the phone gets its push.
    expect(await webPushService.send(message)).toEqual({ sent: 1, failed: 1, removed: 0 });
    expect(webPushService.devices().map((d) => d.kind).sort()).toEqual(["fcm", "webpush"]);
    expect(listSubscriptions()).toHaveLength(2);
  });
});

describe("fcmDataJson", () => {
  const base: WebPushPayload = { title: "T", body: "", url: "/", tag: "t", project: "p", sessionId: "s", providerId: "" };

  it("leaves a payload that fits alone", () => {
    expect(fcmDataJson({ ...base, body: "short" })).toBe(JSON.stringify({ ...base, body: "short" }));
  });

  it("cuts the body first, on a character boundary, to stay under the cap", () => {
    const json = fcmDataJson({ ...base, title: "Kept title", body: "Tiếng Việt 🎉 ".repeat(800) });
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(MAX_FCM_DATA_BYTES);
    const parsed = JSON.parse(json);
    expect(parsed.title).toBe("Kept title");
    expect(parsed.body).toEndWith("…");
    expect(parsed.body.length).toBeGreaterThan(100);
    expect(parsed.body).not.toContain("�");
  });

  it("cuts the title too when the body alone is not enough", () => {
    const json = fcmDataJson({ ...base, title: "x".repeat(5000), body: "y".repeat(5000) });
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(MAX_FCM_DATA_BYTES);
    expect(JSON.parse(json).body).toBe("");
  });
});

describe("Google endpoints", () => {
  it("accept only a loopback override", () => {
    const saved = { api: process.env[FCM_API_BASE_ENV], oauth: process.env[FCM_OAUTH_BASE_ENV] };
    try {
      process.env[FCM_API_BASE_ENV] = "https://evil.example:8443";
      process.env[FCM_OAUTH_BASE_ENV] = "http://10.0.0.5:9000";
      expect(fcmSendUrl("p1")).toBe("https://fcm.googleapis.com/v1/projects/p1/messages:send");
      expect(fcmTokenUrl()).toBe("https://oauth2.googleapis.com/token");
      process.env[FCM_API_BASE_ENV] = "http://127.0.0.1:9000";
      expect(fcmSendUrl("p1")).toBe("http://127.0.0.1:9000/v1/projects/p1/messages:send");
    } finally {
      process.env[FCM_API_BASE_ENV] = saved.api;
      process.env[FCM_OAUTH_BASE_ENV] = saved.oauth;
    }
  });
});
