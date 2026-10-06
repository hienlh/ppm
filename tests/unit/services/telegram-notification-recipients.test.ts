/**
 * Who a Telegram alert goes to: the chats connected in Settings → Notifications, and not
 * the chats that may command PPMBot — the two lists used to be one.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb, upsertApprovedPairing } from "../../../src/services/db.service.ts";
import { addNotifyChat, listNotifyChats } from "../../../src/services/telegram-bots.ts";
import { telegramService } from "../../../src/services/telegram-notification.service.ts";
import { tailscaleAppService } from "../../../src/services/tailscale/tailscale-app-service.ts";

const TOKEN = `123456789:${"A".repeat(35)}`;
const originals = { telegram: configService.get("telegram"), clawbot: configService.get("clawbot"), readState: tailscaleAppService.readState };
const realFetch = globalThis.fetch;
tailscaleAppService.readState = async () => { throw new Error("no Tailscale in this test"); };
afterAll(() => {
  globalThis.fetch = realFetch;
  tailscaleAppService.readState = originals.readState;
  configService.set("telegram", originals.telegram!);
  configService.set("clawbot", originals.clawbot!);
});

let sentTo: string[];
beforeEach(() => {
  setDb(openTestDb());
  sentTo = [];
  configService.set("telegram", { bot_token: TOKEN, bot_username: "ppm_noti_bot" });
  configService.set("clawbot", { ...originals.clawbot!, enabled: false });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentTo.push(String(JSON.parse(String(init?.body)).chat_id));
    return Response.json({ ok: true, result: {} });
  }) as typeof fetch;
});

function connectBoth(): void {
  listNotifyChats(); // the one-time move happens on this first read, before PPMBot's chat exists
  addNotifyChat({ chatId: "40", userId: "40", name: "Alerts" });
  upsertApprovedPairing("42", "42", "PPMBot user");
}

describe("Telegram alerts", () => {
  it("go to the alert chats only", async () => {
    connectBoth();
    expect(await telegramService.send({ title: "Done", body: "Finished", project: "", sessionId: "" })).toBe("sent=1");
    expect(sentTo).toEqual(["40"]);
  });

  it("send their test to the alert chats only, and say how to connect one when there is none", async () => {
    connectBoth();
    expect(await telegramService.sendTest(TOKEN)).toEqual({ ok: true });
    expect(sentTo).toEqual(["40"]);

    setDb(openTestDb());
    listNotifyChats();
    upsertApprovedPairing("42", "42", "PPMBot user");
    const none = await telegramService.sendTest(TOKEN);
    expect(none.ok).toBe(false);
    expect(none.error).toContain("Connect Telegram");
  });
});
