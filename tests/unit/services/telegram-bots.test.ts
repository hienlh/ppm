/**
 * Moving an install off the one bot and one chat list Notifications and PPMBot used to
 * share, and the two lists staying apart afterwards.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { configService } from "../../../src/services/config.service.ts";
import {
  getApprovedPairedChats,
  getConfigValue,
  getDb,
  isPairedChat,
  openTestDb,
  setDb,
  upsertApprovedPairing,
} from "../../../src/services/db.service.ts";
import {
  addNotifyChat,
  botIdOf,
  getPPMBotBot,
  listNotifyChats,
  removeNotifyChat,
  sameBot,
  setPPMBotBot,
} from "../../../src/services/telegram-bots.ts";

const SHARED = `123456789:${"A".repeat(35)}`;
const OTHER = `555666777:${"B".repeat(35)}`;
const originals = { telegram: configService.get("telegram"), clawbot: configService.get("clawbot") };
afterAll(() => {
  configService.set("telegram", originals.telegram!);
  configService.set("clawbot", originals.clawbot!);
});

function sharedInstall(ppmbotOn: boolean): void {
  configService.set("telegram", { bot_token: SHARED, bot_username: "ppm_bot" });
  configService.set("clawbot", { ...originals.clawbot!, enabled: ppmbotOn });
  upsertApprovedPairing("42", "42", "Thang (@thang)");
  // A request left waiting by the pairing codes PPMBot handed out before Connect links.
  getDb().query(
    "INSERT INTO clawbot_paired_chats (telegram_chat_id, telegram_user_id, display_name, pairing_code, status) VALUES ('43', '43', 'Waiting', 'DEF456', 'pending')",
  ).run();
}

beforeEach(() => {
  setDb(openTestDb());
});

describe("moving off the shared bot", () => {
  it("keeps PPMBot answering on the bot it used, and every chat that got alerts", () => {
    sharedInstall(true);
    expect(getPPMBotBot()).toEqual({ bot_token: SHARED, bot_username: "ppm_bot" });
    expect(listNotifyChats().map((c) => [c.chatId, c.userId, c.name])).toEqual([["42", "42", "Thang (@thang)"]]);
    // PPMBot's own approvals are untouched.
    expect(isPairedChat("42")).toBe(true);
  });

  it("starts a PPMBot that was off with no bot, so an alert chat cannot reach it", () => {
    sharedInstall(false);
    expect(getPPMBotBot()).toEqual({ bot_token: "" });
    expect(listNotifyChats().map((c) => c.chatId)).toEqual(["42"]);
  });

  it("happens once, whichever list is read first", () => {
    sharedInstall(true);
    expect(listNotifyChats()).toHaveLength(1);
    // Connected after the move: PPMBot's, not an alert chat.
    upsertApprovedPairing("43", "43", "Waiting");
    removeNotifyChat("42");
    setPPMBotBot({ bot_token: OTHER, bot_username: "ppm_ai_bot" });
    expect(listNotifyChats()).toEqual([]);
    expect(getPPMBotBot().bot_token).toBe(OTHER);
    expect(getApprovedPairedChats().map((c) => c.telegram_chat_id).sort()).toEqual(["42", "43"]);
  });

  it("starts a fresh install with nothing", () => {
    configService.set("telegram", { bot_token: "" });
    configService.set("clawbot", { ...originals.clawbot!, enabled: false });
    expect(getPPMBotBot()).toEqual({ bot_token: "" });
    expect(listNotifyChats()).toEqual([]);
  });

  it("never lets PPMBot's token reach the config object", () => {
    sharedInstall(true);
    setPPMBotBot({ bot_token: OTHER, bot_username: "ppm_ai_bot" });
    expect(getConfigValue("ppmbot_telegram")).toContain(OTHER);
    expect(JSON.stringify(configService.getAll())).not.toContain(OTHER);
  });
});

describe("the alert list", () => {
  it("adds a chat at the top, once, under its latest name", () => {
    configService.set("clawbot", { ...originals.clawbot!, enabled: false });
    addNotifyChat({ chatId: "1", userId: "1", name: "First" });
    addNotifyChat({ chatId: "2", userId: "2", name: "Second" });
    addNotifyChat({ chatId: "1", userId: "1", name: "First, renamed" });
    expect(listNotifyChats().map((c) => [c.chatId, c.name])).toEqual([["1", "First, renamed"], ["2", "Second"]]);
    expect(removeNotifyChat("2")).toBe(true);
    expect(removeNotifyChat("2")).toBe(false);
    expect(listNotifyChats().map((c) => c.chatId)).toEqual(["1"]);
    expect(isPairedChat("1")).toBe(false);
  });
});

describe("telling bots apart", () => {
  it("goes by the bot id, which a reissued token keeps", () => {
    expect(botIdOf(SHARED)).toBe("123456789");
    expect(botIdOf("")).toBeNull();
    expect(sameBot(SHARED, `123456789:${"Z".repeat(35)}`)).toBe(true);
    expect(sameBot(SHARED, OTHER)).toBe(false);
    expect(sameBot("", "")).toBe(false);
  });
});
