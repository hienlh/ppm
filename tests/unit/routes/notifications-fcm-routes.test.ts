import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { getConfigValue, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { notificationRoutes } from "../../../src/server/routes/notifications.ts";
import { settingsSectionOf } from "../../../src/server/routes/settings-broadcast.ts";
import { FCM_API_BASE_ENV, FCM_OAUTH_BASE_ENV } from "../../../src/services/fcm/fcm-api-base.ts";
import { _resetFcmTokenCacheForTests } from "../../../src/services/fcm/fcm-sender.ts";
import { makeReceiver } from "../../helpers/web-push-receiver.ts";
import {
  makeGoogleServices,
  makeServiceAccount,
  PROJECT_ID,
  PROJECT_NUMBER,
  startFakeGoogle,
  unregistered,
  type FakeGoogle,
  type TestServiceAccount,
} from "../../helpers/fcm-fixtures.ts";

const app = new Hono().route("/api/notifications", notificationRoutes);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: any; error?: string } };
};

const TOKEN = `dGVzdC1mY20tdG9rZW4:APA91b${"Z".repeat(140)}`;

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
beforeEach(() => {
  setDb(openTestDb());
  _resetFcmTokenCacheForTests();
  google.requests.length = 0;
  google.respond = () => Response.json({ name: "projects/x/messages/1" });
});

describe("/api/notifications/fcm", () => {
  it("answers not set up, saves both files, and returns only the app's public config", async () => {
    expect((await call("GET", "/api/notifications/fcm")).json.data).toEqual({ configured: false, android: null });

    const saved = await call("PUT", "/api/notifications/fcm", { googleServices: JSON.stringify(makeGoogleServices()), serviceAccount: sa.json });
    expect(saved.status).toBe(200);
    const expected = {
      configured: true,
      projectId: PROJECT_ID,
      android: {
        apiKey: "AIzaSyPPM-public-key-000000000000000",
        appId: `1:${PROJECT_NUMBER}:android:ppmapp0000000000`,
        senderId: PROJECT_NUMBER,
        projectId: PROJECT_ID,
        storageBucket: `${PROJECT_ID}.firebasestorage.app`,
      },
    };
    expect(saved.json.data).toEqual(expected);
    const got = await call("GET", "/api/notifications/fcm");
    expect(got.json.data).toEqual(expected);

    // Nothing from the service account, in either answer.
    for (const answer of [saved, got]) {
      const text = JSON.stringify(answer.json);
      for (const field of ["private_key", "private_key_id", "client_email", "client_id"]) {
        expect(text).not.toContain(String(sa.json[field]));
      }
      expect(text).not.toContain("service_account");
    }
    expect(getConfigValue("fcm")).toContain("service_account");
  });

  it("refuses mismatched or incomplete files with a readable reason, saving nothing", async () => {
    const other = await makeServiceAccount("another-project");
    for (const body of [
      { googleServices: makeGoogleServices(), serviceAccount: other.json },
      { googleServices: makeGoogleServices({ packages: ["com.example.other"] }), serviceAccount: sa.json },
      { googleServices: makeGoogleServices() },
      { serviceAccount: { ...sa.json, type: "user" } },
      { googleServices: "{ nope", serviceAccount: sa.json },
      {},
    ]) {
      const res = await call("PUT", "/api/notifications/fcm", body);
      expect(res.status).toBe(400);
      expect(res.json.error).toBeString();
    }
    expect(getConfigValue("fcm")).toBeNull();
  });

  it("forgets the project on DELETE, leaving Android devices listed", async () => {
    await call("PUT", "/api/notifications/fcm", { googleServices: makeGoogleServices(), serviceAccount: sa.json });
    await call("POST", "/api/notifications/push/subscribe", { kind: "fcm", token: TOKEN, label: "Android · Pixel 7" });
    const cleared = await call("DELETE", "/api/notifications/fcm");
    expect(cleared.json.data).toEqual({ configured: false, android: null });
    expect(getConfigValue("fcm")).toBeNull();
    expect((await call("GET", "/api/notifications/push")).json.data.devices).toHaveLength(1);
  });

  it("is announced to other devices when it changes", () => {
    expect(settingsSectionOf("PUT", "/api/notifications/fcm")).toBe("notifications");
    expect(settingsSectionOf("DELETE", "/api/notifications/fcm")).toBe("notifications");
    expect(settingsSectionOf("GET", "/api/notifications/fcm")).toBeNull();
  });
});

describe("/api/notifications/push with Android devices", () => {
  it("lists an FCM device next to a browser, never its token, and keeps one row per token", async () => {
    const sub = (await makeReceiver()).subscription("https://fcm.googleapis.com/fcm/send/abc");
    const browser = await call("POST", "/api/notifications/push/subscribe", { subscription: sub, label: "Chrome", origin: "https://ppm.example.ts.net" });
    expect(browser.json.data.kind).toBe("webpush");

    const phone = await call("POST", "/api/notifications/push/subscribe", { kind: "fcm", token: TOKEN, label: "Android · Pixel 7" });
    expect(phone.status).toBe(200);
    expect(phone.json.data).toMatchObject({ kind: "fcm", label: "Android · Pixel 7", endpoint: "", origin: "", lastError: null });
    expect(phone.json.data.id).toBeString();

    const again = await call("POST", "/api/notifications/push/subscribe", { kind: "fcm", token: TOKEN, label: "Android · Pixel 7 Pro" });
    expect(again.json.data.id).toBe(phone.json.data.id);

    const devices = (await call("GET", "/api/notifications/push")).json.data.devices;
    expect(devices.map((d: { kind: string }) => d.kind).sort()).toEqual(["fcm", "webpush"]);
    expect(devices.find((d: { kind: string }) => d.kind === "fcm").label).toBe("Android · Pixel 7 Pro");
    expect(JSON.stringify(devices)).not.toContain(TOKEN);
  });

  it("replaces the device's previous row when it names it, keeping its id", async () => {
    const first = await call("POST", "/api/notifications/push/subscribe", { kind: "fcm", token: TOKEN, label: "Android" });
    const rotated = `${TOKEN}-rotated`;
    const second = await call("POST", "/api/notifications/push/subscribe", { kind: "fcm", token: rotated, label: "Android", deviceId: first.json.data.id });
    expect(second.json.data.id).toBe(first.json.data.id);
    expect((await call("GET", "/api/notifications/push")).json.data.devices).toHaveLength(1);
  });

  it("refuses an FCM subscription without a usable token, or an unknown kind", async () => {
    for (const body of [{ kind: "fcm" }, { kind: "fcm", token: "short" }, { kind: "fcm", token: "has space ".repeat(5) }, { kind: "fcm", token: TOKEN, deviceId: 5 }, { kind: "apns", token: TOKEN }]) {
      expect((await call("POST", "/api/notifications/push/subscribe", body)).status).toBe(400);
    }
    expect((await call("GET", "/api/notifications/push")).json.data.devices).toEqual([]);
  });

  it("tests one Android device through Firebase, and says why when Firebase is not set up", async () => {
    const phone = (await call("POST", "/api/notifications/push/subscribe", { kind: "fcm", token: TOKEN, label: "Android" })).json.data;
    const unset = await call("POST", "/api/notifications/push/test", { id: phone.id });
    expect(unset.status).toBe(502);
    expect(unset.json.error).toContain("Firebase is not set up");

    await call("PUT", "/api/notifications/fcm", { googleServices: makeGoogleServices(), serviceAccount: sa.json });
    const sent = await call("POST", "/api/notifications/push/test", { id: phone.id });
    expect(sent.json.data).toEqual({ sent: 1, failed: 0, removed: 0 });
    const ppm = JSON.parse(google.sends()[0]!.json.message.data.ppm);
    expect(ppm).toMatchObject({ tag: "ppm-test", url: "/", body: "Push notifications from PPM are working." });

    google.respond = () => unregistered();
    expect((await call("POST", "/api/notifications/push/test", { id: phone.id })).status).toBe(502);
    expect((await call("GET", "/api/notifications/push")).json.data.devices).toEqual([]);
  });

  it("removes an FCM device by id or by token", async () => {
    const a = (await call("POST", "/api/notifications/push/subscribe", { kind: "fcm", token: TOKEN, label: "A" })).json.data;
    await call("POST", "/api/notifications/push/subscribe", { kind: "fcm", token: `${TOKEN}-b`, label: "B" });
    expect((await call("POST", "/api/notifications/push/unsubscribe", { id: a.id })).json.data).toEqual({ removed: true });
    expect((await call("POST", "/api/notifications/push/unsubscribe", { token: `${TOKEN}-b` })).json.data).toEqual({ removed: true });
    expect((await call("GET", "/api/notifications/push")).json.data.devices).toEqual([]);
  });
});
