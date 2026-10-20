import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { clientFor, freshChat, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { AssistantTelegramInbound } from "../../../../src/services/assistant-telegram/assistant-telegram-inbound.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { getApprovedPairedChats } from "../../../../src/services/db.service.ts";
import { getPPMBotBot, listNotifyChats, setPPMBotBot } from "../../../../src/services/telegram-bots.ts";
import { assistantBridgeReading, notifyConnect, ppmbotConnect } from "../../../../src/services/telegram-connect.service.ts";
import type { TelegramConfig } from "../../../../src/types/config.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
const originals = { telegram: configService.get("telegram") as TelegramConfig | undefined, ppmbot: getPPMBotBot() };

function inbound(): AssistantTelegramInbound {
  return new AssistantTelegramInbound({
    client, token: fake.token, queue: queueFor(client), codes: new ButtonCodes<BridgeAction>(),
    debounceMs: () => 0, delivered: () => {}, pressCard: () => "", switchSession: () => "", relayCard: () => {},
  });
}

/** How many chats the router keeps a lane for. */
const laneCount = (router: AssistantTelegramInbound): number => router["lanes"].size;

const tokenOf = (url: string): string => new URL(url).searchParams.get("start")!;
const paired = (chatId: number): boolean => getApprovedPairedChats().some((c) => c.telegram_chat_id === String(chatId));

/** The bridge reads the fake bot, as it does while it runs, so no connect poller starts. */
function bridgeOnFakeBot(): void {
  setPPMBotBot({ bot_token: fake.token, bot_username: fake.bot.username! });
  assistantBridgeReading(fake.token);
}

afterEach(() => {
  ppmbotConnect.cancel();
  notifyConnect.cancel();
});
afterAll(() => {
  assistantBridgeReading(null);
  setPPMBotBot(originals.ppmbot);
  configService.set("telegram", originals.telegram ?? { bot_token: "" });
});

describe("the Telegram router's lanes", () => {
  it("keeps no lane for a chat once its work is done, strangers refused at the door included", async () => {
    const router = inbound();
    const strangers = Array.from({ length: 30 }, () => freshChat());
    for (const id of strangers) router.dispatch(fake.pushText(id, id, "hello"));
    await router.settle();
    expect(laneCount(router)).toBe(0);
    // Each was still answered, once.
    for (const id of strangers) expect(fake.sent(id)).toHaveLength(1);
  });
});

describe("a connect link opened in a group", () => {
  it("does not connect the group to the Assistant, and leaves the link for the private chat it was meant for", async () => {
    bridgeOnFakeBot();
    const router = inbound();
    const token = tokenOf((await ppmbotConnect.start()).url);
    const group = -freshChat();
    router.dispatch(fake.pushText(group, 42, `/start ${token}`, "group"));
    await router.settle();
    expect(paired(group)).toBe(false);
    expect(ppmbotConnect.isOpen()).toBe(true);
    expect(fake.lastText(group)).toContain("Only a private chat can be connected");

    const owner = freshChat();
    router.dispatch(fake.pushText(owner, owner, `/start ${token}`));
    await router.settle();
    expect(paired(owner)).toBe(true);
    expect(ppmbotConnect.isOpen()).toBe(false);
  });

  it("still connects a group to Notifications on a bot the two share", async () => {
    bridgeOnFakeBot();
    configService.set("telegram", { bot_token: fake.token, bot_username: fake.bot.username! });
    const router = inbound();
    const token = tokenOf((await notifyConnect.start()).url);
    const group = -freshChat();
    router.dispatch(fake.pushText(group, 42, `/start ${token}`, "supergroup"));
    await router.settle();
    expect(listNotifyChats().some((c) => c.chatId === String(group))).toBe(true);
    expect(paired(group)).toBe(false);
  });
});
