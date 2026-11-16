/**
 * A photo sent on Telegram as a reply to one of the Assistant's cards answers that card with the
 * photo: with a caption or alone, an album gathered into one reply (five photos at most), a photo
 * Telegram does not hand over reported and never turned into an empty reply, a backlog photo-only
 * reply said to be dropped rather than silently lost, and "Send anyway" keeping the photos.
 */
import { describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, queueFor, texts, useFakeTelegram } from "./bridge-test-kit.ts";
import {
  AssistantTelegramInbound, BACKLOG_PHOTO_DROPPED_NOTE, BACKLOG_PHOTO_ONLY_NOTE,
} from "../../../../src/services/assistant-telegram/assistant-telegram-inbound.ts";
import { AssistantTelegramCardReplies, type CardReplyMessage } from "../../../../src/services/assistant-telegram/assistant-telegram-card-replies.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import { pickPhotoSize } from "../../../../src/services/assistant-telegram/assistant-telegram-photos.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import type { CardReplyResult } from "../../../../src/services/assistant-cards/card-reply-actions.ts";
import type { AssistantCard } from "../../../../src/shared/assistant-cards.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);
const CARD_MESSAGE = 900;

/** A router whose card replies are recorded rather than forwarded. */
function router(chat: number) {
  const replies: CardReplyMessage[] = [];
  const delivered: number[] = [];
  const queue = queueFor(client);
  const inbound = new AssistantTelegramInbound({
    client, token: fake.token, queue, codes: new ButtonCodes<BridgeAction>(),
    debounceMs: () => 0, albumDebounceMs: () => 40, delivered: (id) => { delivered.push(id); },
    pressCard: () => "", switchSession: () => "", relayCard: () => {},
    isCardMessage: (_c, id) => id === CARD_MESSAGE,
    replyToCard: async (_c, m) => { replies.push(m); return true; },
  });
  const settle = async () => { await inbound.settle(); await queue.whenIdle(); };
  return { inbound, replies, delivered, settle, chatId: String(chat) };
}

const replyingTo = (extra: Record<string, unknown> = {}) => ({
  extra: { reply_to_message: { message_id: CARD_MESSAGE, chat: { id: 0, type: "private" }, date: 0 }, ...extra },
});

describe("a photo replying to a card, from Telegram", () => {
  it("goes with its caption to the card, fetched as an image", async () => {
    const chat = freshChat();
    connectChat(chat);
    const r = router(chat);
    r.inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, caption: "this layout", ...replyingTo() }));
    await r.settle();
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({ text: "this layout", replyToMessageId: CARD_MESSAGE, notTheUsers: false });
    expect(r.replies[0]!.images).toEqual([{ data: Buffer.from(JPEG).toString("base64"), mediaType: "image/jpeg" }]);
  });

  it("answers the card on its own, with no caption", async () => {
    const chat = freshChat();
    connectChat(chat);
    const r = router(chat);
    r.inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, ...replyingTo() }));
    await r.settle();
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]!.text).toBe("");
    expect(r.replies[0]!.images).toHaveLength(1);
    expect(texts(fake, chat).join("\n")).not.toContain("reply to it with text");
  });

  it("gathers an album into one reply, its caption included, and confirms every update", async () => {
    const chat = freshChat();
    connectChat(chat);
    const r = router(chat);
    const group = { media_group_id: `album-${chat}` };
    const ids = [
      fake.pushPhoto(chat, chat, { bytes: JPEG, caption: "both of these", ...replyingTo(group) }),
      fake.pushPhoto(chat, chat, { bytes: JPEG, ...replyingTo(group) }),
      fake.pushPhoto(chat, chat, { bytes: JPEG, extra: group }),
    ].map((u) => { r.inbound.dispatch(u); return u.update_id; });
    await r.settle();
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]!.text).toBe("both of these");
    expect(r.replies[0]!.images).toHaveLength(3);
    expect([...r.delivered].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
  });

  it("sends the first five photos of a longer album and says so", async () => {
    const chat = freshChat();
    connectChat(chat);
    const r = router(chat);
    for (let i = 0; i < 7; i++) r.inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, ...replyingTo({ media_group_id: `big-${chat}` }) }));
    await r.settle();
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]!.images).toHaveLength(5);
    expect(texts(fake, chat)).toContain("Only the first 5 photos were sent.");
  });

  it("sends the album before a message that comes after it", async () => {
    const chat = freshChat();
    connectChat(chat);
    const r = router(chat);
    r.inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, ...replyingTo({ media_group_id: `then-${chat}` }) }));
    r.inbound.dispatch(fake.pushText(chat, chat, "and one more thing", "private", replyingTo().extra));
    await r.settle();
    expect(r.replies.map((m) => [m.text, m.images?.length ?? 0])).toEqual([["", 1], ["and one more thing", 0]]);
  });

  it("reports a photo Telegram does not hand over, and sends no empty reply", async () => {
    const chat = freshChat();
    connectChat(chat);
    const r = router(chat);
    fake.failNext("getFile", { code: 400, description: "Bad Request: file is too big" });
    r.inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, ...replyingTo() }));
    await r.settle();
    expect(r.replies).toHaveLength(0);
    expect(texts(fake, chat)).toContain("⚠️ Telegram did not hand over the photo.");
  });

  it("still sends the words when the photo with them cannot be fetched", async () => {
    const chat = freshChat();
    connectChat(chat);
    const r = router(chat);
    fake.failNext("getFile", { code: 400 });
    r.inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, caption: "go with B", ...replyingTo() }));
    await r.settle();
    expect(r.replies.map((m) => [m.text, m.images])).toEqual([["go with B", undefined]]);
    expect(texts(fake, chat)).toContain("⚠️ Telegram did not hand over the photo.");
  });

  it("says a photo-only reply sent while PPM was off is not kept, rather than dropping it silently", async () => {
    const chat = freshChat();
    connectChat(chat);
    const r = router(chat);
    const old = Math.floor(Date.now() / 1000) - 3600;
    r.inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, ...replyingTo({ date: old }) }));
    r.inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, caption: "B please", ...replyingTo({ date: old }) }));
    await r.settle();
    expect(r.replies).toHaveLength(0);
    const said = texts(fake, chat);
    expect(said).toContain(BACKLOG_PHOTO_ONLY_NOTE);
    expect(said).toContain(BACKLOG_PHOTO_DROPPED_NOTE);
    expect(said.some((t) => t.includes("B please"))).toBe(true);
  });
});

describe("which copy of a photo is fetched", () => {
  const size = (id: string, width: number, height: number, file_size?: number) =>
    ({ file_id: id, file_unique_id: `u-${id}`, width, height, ...(file_size !== undefined ? { file_size } : {}) });

  it("the largest under 2000 pixels on its longer side and under the byte cap", () => {
    const sizes = [size("s", 320, 180, 20_000), size("m", 1280, 720, 200_000), size("l", 2560, 1440, 900_000)];
    expect(pickPhotoSize(sizes)?.file_id).toBe("m");
    expect(pickPhotoSize([size("tall", 1000, 1999), size("x", 2000, 100)])?.file_id).toBe("tall");
    expect(pickPhotoSize([size("m", 1280, 720, 4_000_000), size("s", 320, 180, 20_000)], 3_750_000)?.file_id).toBe("s");
    expect(pickPhotoSize([size("l", 2560, 1440)])).toBeNull();
  });

  it("is downloaded once when the card turns out not to take the reply", async () => {
    const chat = freshChat();
    connectChat(chat);
    const queue = queueFor(client);
    const inbound = new AssistantTelegramInbound({
      client, token: fake.token, queue, codes: new ButtonCodes<BridgeAction>(),
      debounceMs: () => 0, delivered: () => {}, pressCard: () => "", switchSession: () => "", relayCard: () => {},
      isCardMessage: () => true, replyToCard: async () => false,
    });
    const before = fake.calls.filter((c) => c.method === "getFile").length;
    inbound.dispatch(fake.pushPhoto(chat, chat, { bytes: JPEG, caption: "hm", ...replyingTo() }));
    await inbound.settle();
    await queue.whenIdle();
    expect(fake.calls.filter((c) => c.method === "getFile").length - before).toBe(1);
  });
});

describe("the card side of a Telegram reply", () => {
  const card = { id: "c1" } as AssistantCard;

  it("forwards the photos with the words, and keeps them for Send anyway", async () => {
    const codes = new ButtonCodes<BridgeAction>();
    const calls: Array<{ id: string; body: Record<string, unknown> }> = [];
    let answer: CardReplyResult = { ok: false, status: 409, error: "confirm", question: "This card is from 9 Nov 14:02 — send anyway?" };
    const sent: Array<{ html: string; markup?: unknown }> = [];
    const replies = new AssistantTelegramCardReplies({
      codes, reply: (_c, html, markup) => { sent.push({ html, markup }); },
      findCard: (() => ({ id: "c1" })) as never,
      replyTo: async (id, body) => { calls.push({ id, body: body as Record<string, unknown> }); return answer; },
    });
    const image = { data: Buffer.from(JPEG).toString("base64"), mediaType: "image/jpeg" };
    expect(await replies.reply("42", { text: "", images: [image], replyToMessageId: CARD_MESSAGE, messageId: 5, notTheUsers: false })).toBe(true);
    expect(calls[0]).toEqual({ id: "c1", body: { text: "", images: [image] } });

    const button = (sent.at(-1)!.markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
    const press = codes.peek(button, "42");
    if (!press.ok || press.action.kind !== "mcard") throw new Error("no Send anyway button");
    answer = { ok: true, card, to: "manager", projectName: "nxsys" };
    expect(await replies.press("42", press.action, press.group)).toBe("Sent.");
    expect(calls[1]).toEqual({ id: "c1", body: { text: "", force: true, images: [image] } });
  });

  it("asks for words or a photo when the reply has neither", async () => {
    const sent: string[] = [];
    const replies = new AssistantTelegramCardReplies({
      codes: new ButtonCodes<BridgeAction>(), reply: (_c, html) => { sent.push(html); },
      findCard: (() => ({ id: "c1" })) as never, replyTo: async () => { throw new Error("must not send"); },
    });
    await replies.reply("42", { text: " ", replyToMessageId: CARD_MESSAGE, notTheUsers: false });
    expect(sent).toEqual(["To answer a card, reply to it with text or a photo."]);
  });
});
