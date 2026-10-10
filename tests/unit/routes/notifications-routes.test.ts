import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { getDb, isPairedChat, openTestDb, setDb, upsertApprovedPairing } from "../../../src/services/db.service.ts";
import { assistantBridgeReading, notifyConnect, ppmbotConnect } from "../../../src/services/telegram-connect.service.ts";
import { addNotifyChat, getPPMBotBot, listNotifyChats, setPPMBotBot } from "../../../src/services/telegram-bots.ts";
import { notificationRoutes } from "../../../src/server/routes/notifications.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../../../src/shared/notification-settings.ts";
import { makeReceiver } from "../../helpers/web-push-receiver.ts";
import { READER_TOKEN, startFakeNtfy, WRITER_TOKEN, type FakeNtfy } from "../../helpers/fake-ntfy-server.ts";

const TOKEN = `123456789:${"A".repeat(35)}`;
const PPMBOT_TOKEN = `555666777:${"B".repeat(35)}`;

/** No link open and no bot "read by the Assistant's bridge": nothing left to poll the real Telegram. */
function closeLinks(): void {
  notifyConnect.cancel();
  ppmbotConnect.cancel();
  assistantBridgeReading(null);
}
const originals = {
  telegram: configService.get("telegram"),
  notifications: configService.get("notifications"),
  clawbot: configService.get("clawbot"),
  ntfy: configService.get("ntfy"),
};
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  closeLinks();
  configService.set("telegram", originals.telegram!);
  configService.set("notifications", originals.notifications!);
  configService.set("clawbot", originals.clawbot!);
  configService.set("ntfy", originals.ntfy!);
});

const app = new Hono().route("/api/notifications", notificationRoutes).route("/api/settings", settingsRoutes);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: any; error?: string } };
};

beforeEach(() => {
  setDb(openTestDb());
  globalThis.fetch = realFetch;
  closeLinks();
  configService.set("telegram", { bot_token: "" });
  configService.set("notifications", structuredClone(DEFAULT_NOTIFICATION_SETTINGS));
  configService.set("clawbot", { ...originals.clawbot!, enabled: false });
  configService.set("ntfy", { server: "", topic: "", token: "" });
});

describe("/api/notifications/settings", () => {
  it("reads the defaults and saves a partial update", async () => {
    expect((await call("GET", "/api/notifications/settings")).json.data).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    const saved = await call("PUT", "/api/notifications/settings", { delay_seconds: 0, events: { jira: false } });
    expect(saved.status).toBe(200);
    expect(saved.json.data).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, delay_seconds: 0, events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, jira: false } });
    expect((await call("GET", "/api/notifications/settings")).json.data.delay_seconds).toBe(0);
  });

  it("refuses what it does not understand instead of half-saving it", async () => {
    for (const body of [{ delay_seconds: -1 }, { delay_seconds: 1.5 }, { events: { nope: true } }, { telegram: "yes" }, { colour: "red" }, []]) {
      const res = await call("PUT", "/api/notifications/settings", body);
      expect(res.status).toBe(400);
    }
    expect((await call("GET", "/api/notifications/settings")).json.data).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
});

describe("/api/notifications/push", () => {
  it("lists a subscribed browser by label and origin, never its keys", async () => {
    const sub = (await makeReceiver()).subscription("https://fcm.googleapis.com/fcm/send/abc");
    const added = await call("POST", "/api/notifications/push/subscribe", { subscription: sub, label: "Chrome on Android", origin: "https://ppm.example.ts.net/settings" });
    expect(added.status).toBe(200);
    const status = (await call("GET", "/api/notifications/push")).json.data;
    expect(status.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(status.devices).toEqual([expect.objectContaining({ label: "Chrome on Android", origin: "https://ppm.example.ts.net" })]);
    expect(JSON.stringify(status)).not.toContain(sub.keys.auth);

    const removed = await call("POST", "/api/notifications/push/unsubscribe", { endpoint: sub.endpoint });
    expect(removed.json.data).toEqual({ removed: true });
    expect((await call("GET", "/api/notifications/push")).json.data.devices).toEqual([]);
  });

  it("refuses a subscription it could not or should not push to", async () => {
    const sub = (await makeReceiver()).subscription("http://169.254.169.254/latest");
    expect((await call("POST", "/api/notifications/push/subscribe", { subscription: sub, origin: "https://a.example" })).status).toBe(400);
    const good = (await makeReceiver()).subscription("https://push.example/1");
    expect((await call("POST", "/api/notifications/push/subscribe", { subscription: good, origin: "javascript:alert(1)" })).status).toBe(400);
    expect((await call("POST", "/api/notifications/push/unsubscribe", {})).status).toBe(400);
  });

  it("says why a test push reached nobody", async () => {
    const res = await call("POST", "/api/notifications/push/test", {});
    expect(res.status).toBe(502);
    expect(res.json.error).toContain("No browser");
    expect((await call("POST", "/api/notifications/push/test", { id: "nope" })).status).toBe(404);
  });
});

describe("/api/notifications/telegram", () => {
  it("reports an unconfigured bot and refuses to make a link for it", async () => {
    expect((await call("GET", "/api/notifications/telegram")).json.data).toEqual({
      configured: false, botUsername: null, sharedWithPPMBot: false, chats: [], connect: { active: false, expiresAt: null, error: null },
    });
    expect((await call("POST", "/api/notifications/telegram/connect")).status).toBe(400);
  });

  it("lists its own chats, not PPMBot's, and makes a one-time link", async () => {
    configService.set("telegram", { bot_token: TOKEN, bot_username: "ppm_test_bot" });
    assistantBridgeReading(TOKEN); // no poller in a unit test
    addNotifyChat({ chatId: "42", userId: "42", name: "Thang" });
    upsertApprovedPairing("44", "44", "PPMBot only");

    const link = await call("POST", "/api/notifications/telegram/connect");
    expect(link.json.data.url).toStartWith("https://t.me/ppm_test_bot?start=");
    const status = (await call("GET", "/api/notifications/telegram")).json.data;
    expect(status).toMatchObject({ configured: true, botUsername: "ppm_test_bot", sharedWithPPMBot: false, chats: [{ chatId: "42", name: "Thang" }] });
    expect(status.connect.active).toBe(true);

    await call("DELETE", "/api/notifications/telegram/connect");
    expect((await call("GET", "/api/notifications/telegram")).json.data.connect.active).toBe(false);
  });

  it("disconnects a chat from alerts without touching PPMBot", async () => {
    addNotifyChat({ chatId: "42", userId: "42", name: "Thang" });
    upsertApprovedPairing("42", "42", "Thang");
    expect((await call("DELETE", "/api/notifications/telegram/chats/42")).status).toBe(200);
    expect(listNotifyChats()).toEqual([]);
    expect(isPairedChat("42")).toBe(true);
    expect((await call("DELETE", "/api/notifications/telegram/chats/42")).status).toBe(404);
  });

  it("says when PPMBot answers through the same bot", async () => {
    configService.set("telegram", { bot_token: TOKEN, bot_username: "ppm_test_bot" });
    setPPMBotBot({ bot_token: TOKEN, bot_username: "ppm_test_bot" });
    expect((await call("GET", "/api/notifications/telegram")).json.data.sharedWithPPMBot).toBe(true);
    setPPMBotBot({ bot_token: PPMBOT_TOKEN, bot_username: "ppm_ai_bot" });
    expect((await call("GET", "/api/notifications/telegram")).json.data.sharedWithPPMBot).toBe(false);
  });

  it("keeps a token saved while it was asking Telegram for the old bot's name", async () => {
    const newToken = `987654321:${"C".repeat(35)}`;
    // Saved before PPM stored bot names, so reading the status asks Telegram for this one's.
    configService.set("telegram", { bot_token: TOKEN });
    let answerOld!: () => void;
    const oldAnswer = new Promise<void>((resolve) => { answerOld = resolve; });
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/getMe");
      if (url.includes(TOKEN)) {
        asked.push("old");
        await oldAnswer;
        return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "ppm_old_bot" } });
      }
      asked.push("new");
      return Response.json({ ok: true, result: { id: 2, is_bot: true, username: "ppm_new_bot" } });
    }) as typeof fetch;

    const status = call("GET", "/api/notifications/telegram");
    for (let i = 0; i < 100 && !asked.includes("old"); i++) await Bun.sleep(5);
    expect((await call("PUT", "/api/settings/telegram", { bot_token: newToken })).status).toBe(200);
    answerOld();

    const answered = await status;
    expect(configService.get("telegram")).toEqual({ bot_token: newToken, bot_username: "ppm_new_bot" });
    // And the pane is shown the bot saved now, not the one it asked about.
    expect(answered.json.data.botUsername).toBe("ppm_new_bot");
    expect(asked).toEqual(["old", "new"]);
  });
});

describe("PUT /api/settings/telegram", () => {
  const telegramAnswers = (answer: () => Response) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/getMe");
      return answer();
    }) as typeof fetch;
  };

  it("keeps a token only once Telegram recognises it, with the bot's name", async () => {
    telegramAnswers(() => Response.json({ ok: true, result: { id: 1, is_bot: true, username: "ppm_test_bot" } }));
    const res = await call("PUT", "/api/settings/telegram", { bot_token: ` ${TOKEN} ` });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ bot_token: "123456...", bot_username: "ppm_test_bot" });
    expect(configService.get("telegram")).toEqual({ bot_token: TOKEN, bot_username: "ppm_test_bot" });
  });

  it("refuses a token Telegram does not know, and keeps the old one", async () => {
    configService.set("telegram", { bot_token: TOKEN, bot_username: "ppm_test_bot" });
    telegramAnswers(() => Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 }));
    const res = await call("PUT", "/api/settings/telegram", { bot_token: `987654321:${"B".repeat(35)}` });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("Unauthorized");
    expect(configService.get("telegram")?.bot_token).toBe(TOKEN);
  });

  it("refuses something that is not a token without asking Telegram, and tells no network apart", async () => {
    globalThis.fetch = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    expect((await call("PUT", "/api/settings/telegram", { bot_token: "hello" })).status).toBe(400);
    globalThis.fetch = (async () => { throw new Error("getaddrinfo ENOTFOUND api.telegram.org"); }) as unknown as typeof fetch;
    const offline = await call("PUT", "/api/settings/telegram", { bot_token: TOKEN });
    expect(offline.status).toBe(502);
    expect(offline.json.error).toContain("Could not reach Telegram");
  });

  it("removes the bot when the token is cleared", async () => {
    configService.set("telegram", { bot_token: TOKEN, bot_username: "ppm_test_bot" });
    const res = await call("PUT", "/api/settings/telegram", { bot_token: "" });
    expect(res.json.data).toEqual({ bot_token: "", bot_username: null });
    expect(configService.get("telegram")).toEqual({ bot_token: "" });
  });
});

describe("/api/settings/clawbot/telegram", () => {
  it("starts with no bot, and refuses a link until it has one", async () => {
    const status = (await call("GET", "/api/settings/clawbot/telegram")).json.data;
    expect(status).toEqual({
      configured: false, botUsername: null, sharedWithNotifications: false, enabled: false, running: false,
      chats: [], connect: { active: false, expiresAt: null, error: null },
    });
    expect((await call("POST", "/api/settings/clawbot/telegram/connect")).status).toBe(400);
  });

  it("keeps a token of its own once Telegram recognises it, apart from the notification bot", async () => {
    configService.set("telegram", { bot_token: TOKEN, bot_username: "ppm_test_bot" });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(`/bot${PPMBOT_TOKEN}/getMe`);
      return Response.json({ ok: true, result: { id: 2, is_bot: true, username: "ppm_ai_bot" } });
    }) as typeof fetch;
    const res = await call("PUT", "/api/settings/clawbot/telegram", { bot_token: PPMBOT_TOKEN });
    expect(res.json.data).toEqual({ bot_token: "555666...", bot_username: "ppm_ai_bot" });
    expect(getPPMBotBot()).toEqual({ bot_token: PPMBOT_TOKEN, bot_username: "ppm_ai_bot" });
    expect(configService.get("telegram")).toEqual({ bot_token: TOKEN, bot_username: "ppm_test_bot" });
    expect((await call("GET", "/api/settings/clawbot/telegram")).json.data).toMatchObject({ configured: true, botUsername: "ppm_ai_bot", sharedWithNotifications: false });
  });

  it("refuses a token Telegram does not know, and keeps the old one", async () => {
    setPPMBotBot({ bot_token: PPMBOT_TOKEN, bot_username: "ppm_ai_bot" });
    globalThis.fetch = (async () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 })) as typeof fetch;
    const res = await call("PUT", "/api/settings/clawbot/telegram", { bot_token: TOKEN });
    expect(res.status).toBe(400);
    expect(getPPMBotBot().bot_token).toBe(PPMBOT_TOKEN);
  });

  it("lists the chats that may use PPMBot, and no alert chat", async () => {
    setPPMBotBot({ bot_token: PPMBOT_TOKEN, bot_username: "ppm_ai_bot" });
    assistantBridgeReading(PPMBOT_TOKEN); // no poller in a unit test
    addNotifyChat({ chatId: "40", userId: "40", name: "Alerts only" });
    upsertApprovedPairing("42", "42", "Thang");

    const link = await call("POST", "/api/settings/clawbot/telegram/connect");
    expect(link.json.data.url).toStartWith("https://t.me/ppm_ai_bot?start=");
    const status = (await call("GET", "/api/settings/clawbot/telegram")).json.data;
    expect(status.chats).toEqual([{ chatId: "42", name: "Thang" }]);
    expect(status.connect.active).toBe(true);

    await call("DELETE", "/api/settings/clawbot/telegram/connect");
    expect((await call("GET", "/api/settings/clawbot/telegram")).json.data.connect.active).toBe(false);
  });

  it("shows no request left waiting by an old pairing code, and has no way to approve one", async () => {
    setPPMBotBot({ bot_token: PPMBOT_TOKEN, bot_username: "ppm_ai_bot" });
    // Written before Connect links, when a chat that wrote to the bot first was given a code.
    getDb().query(
      "INSERT INTO clawbot_paired_chats (telegram_chat_id, telegram_user_id, display_name, pairing_code, status) VALUES ('43', '43', 'Stranger', 'DEF456', 'pending')",
    ).run();
    const status = (await call("GET", "/api/settings/clawbot/telegram")).json.data;
    expect(status.chats).toEqual([]);
    expect(status).not.toHaveProperty("requests");
    const approve = await app.request("http://localhost/api/settings/clawbot/paired/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "DEF456" }),
    });
    expect(approve.status).toBe(404);
    expect(isPairedChat("43")).toBe(false);
  });
});

describe("/api/notifications/ntfy", () => {
  let ntfy: FakeNtfy;
  beforeEach(() => {
    ntfy = startFakeNtfy();
  });
  afterEach(() => ntfy.stop());

  it("reports ntfy as not set up, with nothing to test", async () => {
    expect((await call("GET", "/api/notifications/ntfy")).json.data).toEqual({ configured: false, server: "", topic: "", tokenSet: false });
    const test = await call("POST", "/api/notifications/ntfy/test");
    expect(test.status).toBe(400);
    expect(test.json.error).toContain("Set up ntfy first");
  });

  it("saves a server that answers as ntfy with a token it accepts, and never hands the token back", async () => {
    const saved = await call("PUT", "/api/notifications/ntfy", { server: `${ntfy.url}/`, topic: " ppm-alerts ", token: ` ${WRITER_TOKEN} ` });
    expect(saved.status).toBe(200);
    expect(saved.json.data).toEqual({ configured: true, server: ntfy.url, topic: "ppm-alerts", tokenSet: true });
    expect(configService.get("ntfy")).toEqual({ server: ntfy.url, topic: "ppm-alerts", token: WRITER_TOKEN });
    expect(JSON.stringify(saved.json)).not.toContain(WRITER_TOKEN);
    expect(JSON.stringify((await call("GET", "/api/notifications/ntfy")).json)).not.toContain(WRITER_TOKEN);
    // The health check goes without the token; only the account check carries it.
    expect(ntfy.requests.map((r) => [r.path, r.auth])).toEqual([["/v1/health", null], ["/v1/account", `Bearer ${WRITER_TOKEN}`]]);
  });

  it("refuses what it cannot use without asking the server, and keeps what was saved", async () => {
    configService.set("ntfy", { server: ntfy.url, topic: "kept", token: WRITER_TOKEN });
    for (const body of [
      { server: "ftp://ntfy.sh", topic: "a" },
      { server: ntfy.url, topic: "two words" },
      { server: ntfy.url, topic: "a", token: 42 },
      { server: ntfy.url, topic: "a", token: "tk_a b" },
      [],
    ]) {
      expect((await call("PUT", "/api/notifications/ntfy", body)).status).toBe(400);
    }
    expect(ntfy.requests).toEqual([]);
    expect(configService.get("ntfy")).toEqual({ server: ntfy.url, topic: "kept", token: WRITER_TOKEN });
  });

  it("says which part is wrong: not ntfy, a token it does not know, nobody answering", async () => {
    const other = startFakeNtfy("other");
    try {
      const notNtfy = await call("PUT", "/api/notifications/ntfy", { server: other.url, topic: "a" });
      expect(notNtfy.status).toBe(400);
      expect(notNtfy.json.error).toContain("does not answer like an ntfy server");
    } finally {
      other.stop();
    }

    const badToken = await call("PUT", "/api/notifications/ntfy", { server: ntfy.url, topic: "a", token: "tk_unknown" });
    expect(badToken.status).toBe(400);
    expect(badToken.json.error).toContain("did not accept the access token");

    const gone = startFakeNtfy();
    gone.stop();
    const offline = await call("PUT", "/api/notifications/ntfy", { server: gone.url, topic: "a" });
    expect(offline.status).toBe(502);
    expect(offline.json.error).toContain(`Could not reach ${gone.url}:`);
    expect(configService.get("ntfy")).toEqual({ server: "", topic: "", token: "" });
  });

  it("keeps the saved token for the same server and never sends it to another one", async () => {
    await call("PUT", "/api/notifications/ntfy", { server: ntfy.url, topic: "a", token: WRITER_TOKEN });
    const renamed = await call("PUT", "/api/notifications/ntfy", { server: ntfy.url, topic: "b" });
    expect(renamed.json.data).toMatchObject({ topic: "b", tokenSet: true });

    const elsewhere = startFakeNtfy();
    try {
      const moved = await call("PUT", "/api/notifications/ntfy", { server: elsewhere.url, topic: "b" });
      expect(moved.json.data).toMatchObject({ server: elsewhere.url, tokenSet: false });
      expect(elsewhere.requests.length).toBeGreaterThan(0);
      expect(elsewhere.requests.every((r) => r.auth === null)).toBe(true);
      expect(configService.get("ntfy")?.token).toBe("");
    } finally {
      elsewhere.stop();
    }
  });

  it("sends a test, and says why the server refused one", async () => {
    await call("PUT", "/api/notifications/ntfy", { server: ntfy.url, topic: "ppm-alerts", token: WRITER_TOKEN });
    const sent = await call("POST", "/api/notifications/ntfy/test");
    expect(sent.status).toBe(200);
    expect(ntfy.published).toEqual([expect.objectContaining({ topic: "ppm-alerts", message: "ntfy notifications from PPM are working." })]);
    expect(String(ntfy.published[0]!.title)).toStartWith("Test · ");

    configService.set("ntfy", { server: ntfy.url, topic: "ppm-alerts", token: READER_TOKEN });
    const readOnly = await call("POST", "/api/notifications/ntfy/test");
    expect(readOnly.status).toBe(502);
    expect(readOnly.json.error).toContain('may not publish to "ppm-alerts"');

    configService.set("ntfy", { server: ntfy.url, topic: "ppm-alerts", token: "" });
    expect((await call("POST", "/api/notifications/ntfy/test")).json.error).toContain("needs an access token");
  });

  it("forgets the server, topic and token on removal", async () => {
    await call("PUT", "/api/notifications/ntfy", { server: ntfy.url, topic: "a", token: WRITER_TOKEN });
    const removed = await call("DELETE", "/api/notifications/ntfy");
    expect(removed.json.data).toEqual({ configured: false, server: "", topic: "", tokenSet: false });
    expect(configService.get("ntfy")).toEqual({ server: "", topic: "", token: "" });
  });
});
