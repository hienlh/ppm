import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configService } from "../../../src/services/config.service.ts";
import {
  getApprovedPairedChats,
  getDb,
  isPairedChat,
  openTestDb,
  revokePairing,
  setDb,
  upsertApprovedPairing,
} from "../../../src/services/db.service.ts";
import { listNotifyChats, setPPMBotBot } from "../../../src/services/telegram-bots.ts";
import {
  assistantBridgeReading,
  CONNECT_TTL_MS,
  handleConnectMessage,
  notifyConnect,
  ppmbotConnect,
  TelegramConnectError,
} from "../../../src/services/telegram-connect.service.ts";
import type { TelegramMessage } from "../../../src/types/ppmbot.ts";

const NOTIFY_TOKEN = `123456789:${"A".repeat(35)}`;
const PPMBOT_TOKEN = `555666777:${"B".repeat(35)}`;
const originals = { telegram: configService.get("telegram"), clawbot: configService.get("clawbot") };
const realFetch = globalThis.fetch;

/** Close every link before the bridge "stops", or the stop starts a poller against the real Telegram. */
function quiet(): void {
  notifyConnect.cancel();
  ppmbotConnect.cancel();
  assistantBridgeReading(null);
}

afterAll(() => {
  globalThis.fetch = realFetch;
  quiet();
  configService.set("telegram", originals.telegram!);
  configService.set("clawbot", originals.clawbot!);
});

const message = (text: string, chatId = 42): TelegramMessage => ({
  message_id: 1,
  date: 0,
  text,
  chat: { id: chatId, type: "private" },
  from: { id: chatId, first_name: "Thang", username: "thang" },
});

function tokenOf(url: string): string {
  return new URL(url).searchParams.get("start")!;
}

/** The chat's row in the Assistant's list (`clawbot_paired_chats`), whatever its state. */
function pairingRow(chatId: string): unknown {
  return getDb().query("SELECT status, pairing_code FROM clawbot_paired_chats WHERE telegram_chat_id = ?").get(chatId);
}

let replies: Array<{ chatId: string; html: string }>;
const reply = async (chatId: string, html: string) => { replies.push({ chatId, html }); };

beforeEach(() => {
  setDb(openTestDb());
  quiet();
  replies = [];
  configService.set("clawbot", { ...originals.clawbot!, enabled: false });
  configService.set("telegram", { bot_token: NOTIFY_TOKEN, bot_username: "ppm_noti_bot" });
  setPPMBotBot({ bot_token: PPMBOT_TOKEN, bot_username: "ppm_ai_bot" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  quiet();
});

type Call = { token: string; method: string; body: Record<string, unknown> };

function fakeTelegram(updatesFor: (token: string, offset: number) => unknown[] | null): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const [, token, method] = /\/bot([^/]+)\/(\w+)$/.exec(String(input))!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ token: token!, method: method!, body });
    if (method === "getUpdates" && body.timeout > 0) {
      const updates = updatesFor(token!, body.offset);
      if (updates) return Response.json({ ok: true, result: updates });
      // Long poll with nothing new: answer soon, like Telegram would after its timeout.
      await Bun.sleep(5);
    }
    return Response.json({ ok: true, result: [] });
  }) as typeof fetch;
  return calls;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
}

describe("the notifications link", () => {
  // These drive handleConnectMessage directly: with the bridge "reading" the bot, nothing polls it.
  beforeEach(() => assistantBridgeReading(NOTIFY_TOKEN));

  it("needs a bot token", async () => {
    configService.set("telegram", { bot_token: "" });
    await expect(notifyConnect.start()).rejects.toBeInstanceOf(TelegramConnectError);
  });

  it("connects the chat that opens it, once, for alerts and nothing else", async () => {
    const { url, expiresAt } = await notifyConnect.start();
    expect(url).toStartWith("https://t.me/ppm_noti_bot?start=");
    expect(tokenOf(url)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt - Date.now()).toBeGreaterThan(CONNECT_TTL_MS - 1000);
    expect(notifyConnect.status().active).toBe(true);

    expect(await handleConnectMessage(message(`/start ${tokenOf(url)}`), NOTIFY_TOKEN, reply)).toBe(true);
    expect(listNotifyChats().map((c) => [c.chatId, c.name])).toEqual([["42", "Thang (@thang)"]]);
    expect(replies[0]!.html).toContain("PPM notifications will arrive");
    expect(notifyConnect.status().active).toBe(false);
    // The whole point of two lists: an alert chat cannot talk to the Assistant.
    expect(isPairedChat("42")).toBe(false);
    expect(pairingRow("42")).toBeNull();

    // The same link again — from anyone — is spent.
    expect(await handleConnectMessage(message(`/start ${tokenOf(url)}`, 7), NOTIFY_TOKEN, reply)).toBe(true);
    expect(listNotifyChats()).toHaveLength(1);
    expect(replies[1]!.html).toContain("expired or was already used");
    expect(replies[1]!.html).toContain("Settings → Notifications");
  });

  it("refuses a wrong or replaced link, and ignores ordinary messages", async () => {
    const first = await notifyConnect.start();
    const second = await notifyConnect.start();
    expect(await handleConnectMessage(message(`/start ${tokenOf(first.url)}`), NOTIFY_TOKEN, reply)).toBe(true);
    expect(await handleConnectMessage(message(`/start ${"x".repeat(22)}`), NOTIFY_TOKEN, reply)).toBe(true);
    expect(listNotifyChats()).toHaveLength(0);

    expect(await handleConnectMessage(message("hello"), NOTIFY_TOKEN, reply)).toBe(false);
    expect(await handleConnectMessage(message("/start"), NOTIFY_TOKEN, reply)).toBe(false);
    expect(await handleConnectMessage(message("/status"), NOTIFY_TOKEN, reply)).toBe(false);

    expect(await handleConnectMessage(message(`/start@ppm_noti_bot ${tokenOf(second.url)}`), NOTIFY_TOKEN, reply)).toBe(true);
    expect(listNotifyChats()).toHaveLength(1);
  });

  it("refuses an expired link", async () => {
    const { url } = await notifyConnect.start();
    const realNow = Date.now;
    Date.now = () => realNow() + CONNECT_TTL_MS + 1;
    try {
      await handleConnectMessage(message(`/start ${tokenOf(url)}`), NOTIFY_TOKEN, reply);
    } finally {
      Date.now = realNow;
    }
    expect(listNotifyChats()).toHaveLength(0);
  });

  it("is not answered by another bot", async () => {
    const { url } = await notifyConnect.start();
    // A token for the notification bot, sent to the Assistant's: nothing there is waiting for it.
    expect(await handleConnectMessage(message(`/start ${tokenOf(url)}`), PPMBOT_TOKEN, reply)).toBe(true);
    expect(listNotifyChats()).toHaveLength(0);
    expect(replies[0]!.html).toContain("Settings → PPM Assistant → Telegram");
    expect(notifyConnect.status().active).toBe(true);
  });
});

describe("the Assistant's link", () => {
  beforeEach(() => assistantBridgeReading(PPMBOT_TOKEN));

  it("lets the chat that opens it use the Assistant, and does not sign it up for alerts", async () => {
    const { url } = await ppmbotConnect.start();
    expect(url).toStartWith("https://t.me/ppm_ai_bot?start=");
    expect(await handleConnectMessage(message(`/start ${tokenOf(url)}`), PPMBOT_TOKEN, reply)).toBe(true);
    expect(getApprovedPairedChats().map((c) => [c.telegram_chat_id, c.display_name])).toEqual([["42", "Thang (@thang)"]]);
    expect(listNotifyChats()).toHaveLength(0);
    expect(replies[0]!.html).toContain("chat with PPM Assistant here");
  });

  it("connects again a chat that was disconnected, or left waiting by an old pairing code", async () => {
    upsertApprovedPairing("42", "42", "Old");
    revokePairing("42");
    // Written before Connect links, when a chat that wrote to the bot first was given a code to approve.
    getDb().query(
      "INSERT INTO clawbot_paired_chats (telegram_chat_id, telegram_user_id, display_name, pairing_code, status) VALUES ('43', '43', 'Waiting', 'ABC123', 'pending')",
    ).run();
    for (const chatId of [42, 43]) {
      const { url } = await ppmbotConnect.start();
      await handleConnectMessage(message(`/start ${tokenOf(url)}`, chatId), PPMBOT_TOKEN, reply);
    }
    expect(pairingRow("42")).toEqual({ status: "approved", pairing_code: null });
    expect(pairingRow("43")).toEqual({ status: "approved", pairing_code: null });
  });

  it("says the Assistant will answer once it is on, while it is off", async () => {
    fakeTelegram(() => null);
    assistantBridgeReading(null);
    const { url } = await ppmbotConnect.start();
    await handleConnectMessage(message(`/start ${tokenOf(url)}`), PPMBOT_TOKEN, reply);
    expect(replies[0]!.html).toContain("once it is turned on");
  });
});

describe("one bot shared by both", () => {
  beforeEach(() => {
    setPPMBotBot({ bot_token: NOTIFY_TOKEN, bot_username: "ppm_noti_bot" });
    assistantBridgeReading(NOTIFY_TOKEN);
  });

  it("gives each link's /start to its own list", async () => {
    const forAlerts = await notifyConnect.start();
    const forAssistant = await ppmbotConnect.start();
    await handleConnectMessage(message(`/start ${tokenOf(forAssistant.url)}`, 1), NOTIFY_TOKEN, reply);
    await handleConnectMessage(message(`/start ${tokenOf(forAlerts.url)}`, 2), NOTIFY_TOKEN, reply);
    expect(getApprovedPairedChats().map((c) => c.telegram_chat_id)).toEqual(["1"]);
    expect(listNotifyChats().map((c) => c.chatId)).toEqual(["2"]);

    // A spent one names Settings in general: either pane could have made it.
    await handleConnectMessage(message(`/start ${tokenOf(forAlerts.url)}`, 3), NOTIFY_TOKEN, reply);
    expect(replies.at(-1)!.html).toContain("open <b>Settings</b>");
  });
});

describe("reading a bot nobody else reads", () => {
  it("polls the notification bot itself while the bridge is off, and confirms what it read", async () => {
    let link = "";
    // The poller starts inside start(), before the link is known here: nothing arrives until it is.
    const calls = fakeTelegram((token, offset) => (token === NOTIFY_TOKEN && offset === 0 && link
      ? [{ update_id: 10, message: message("unrelated") }, { update_id: 11, message: message(`/start ${tokenOf(link)}`) }]
      : null));
    link = (await notifyConnect.start()).url;
    await until(() => listNotifyChats().length > 0);
    await until(() => calls.some((c) => c.body.timeout === 0));

    expect(listNotifyChats().map((c) => c.chatId)).toEqual(["42"]);
    expect(calls.find((c) => c.method === "sendMessage")?.body).toMatchObject({ chat_id: "42", parse_mode: "HTML" });
    // Confirmed past the /start, so the next reader does not get it again.
    expect(calls.find((c) => c.method === "getUpdates" && c.body.timeout === 0)?.body.offset).toBe(12);
  });

  it("reads a link made while the last poller was still confirming what it read", async () => {
    // Like Telegram, an update is handed out until a getUpdates asks for an offset past it.
    const updates: Array<{ update_id: number; message: TelegramMessage }> = [];
    let confirming = false;
    let answerConfirm!: () => void;
    const confirmAnswer = new Promise<void>((resolve) => { answerConfirm = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = /\/(\w+)$/.exec(String(input))![1];
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (method !== "getUpdates") return Response.json({ ok: true, result: {} });
      while (updates.length > 0 && updates[0]!.update_id < body.offset) updates.shift();
      if (body.timeout === 0) {
        // The poller's last request, confirming the /start it read: held while a new link is made.
        confirming = true;
        await confirmAnswer;
        return Response.json({ ok: true, result: [] });
      }
      if (updates.length > 0) return Response.json({ ok: true, result: [...updates] });
      await Bun.sleep(5);
      return Response.json({ ok: true, result: [] });
    }) as typeof fetch;

    const first = await notifyConnect.start();
    updates.push({ update_id: 30, message: message(`/start ${tokenOf(first.url)}`, 1) });
    await until(() => confirming);
    expect(listNotifyChats().map((c) => c.chatId)).toEqual(["1"]);

    // Connecting a second chat as soon as the first one is in.
    const second = await notifyConnect.start();
    answerConfirm();
    updates.push({ update_id: 31, message: message(`/start ${tokenOf(second.url)}`, 2) });
    await until(() => listNotifyChats().length === 2);
    expect(listNotifyChats().map((c) => c.chatId)).toEqual(["2", "1"]);
  });

  it("keeps polling the notification bot while the bridge reads a different one", async () => {
    let link = "";
    const calls = fakeTelegram((token, offset) => (token === NOTIFY_TOKEN && offset === 0 && link
      ? [{ update_id: 20, message: message(`/start ${tokenOf(link)}`) }]
      : null));
    assistantBridgeReading(PPMBOT_TOKEN);
    link = (await notifyConnect.start()).url;
    await until(() => listNotifyChats().length > 0);
    expect(listNotifyChats().map((c) => c.chatId)).toEqual(["42"]);
    // And never the Assistant's bot: the bridge reads that one.
    expect(calls.some((c) => c.token === PPMBOT_TOKEN)).toBe(false);
  });

  it("leaves a bot the bridge reads to the bridge, and takes it back when the bridge stops", async () => {
    const calls = fakeTelegram(() => null);
    assistantBridgeReading(PPMBOT_TOKEN);
    await ppmbotConnect.start();
    await Bun.sleep(30);
    expect(calls).toHaveLength(0);

    assistantBridgeReading(null);
    await until(() => calls.some((c) => c.token === PPMBOT_TOKEN && c.method === "getUpdates"));
    expect(calls.some((c) => c.token === PPMBOT_TOKEN && c.method === "getUpdates")).toBe(true);
  });

  it("reports a bot it cannot read, and does not keep asking it", async () => {
    let asked = 0;
    globalThis.fetch = (async () => {
      asked++;
      // Answered on a later tick, as a network would: a poller restarting itself is then a
      // count that climbs, not a loop that never lets the test run again.
      await Bun.sleep(1);
      return Response.json({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" });
    }) as typeof fetch;
    await notifyConnect.start();
    await until(() => !!notifyConnect.status().error);
    expect(notifyConnect.status().error).toContain("webhook");
    expect(ppmbotConnect.status().error).toBeNull();
    await Bun.sleep(50);
    expect(asked).toBe(1);
  });
});
