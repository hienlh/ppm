/**
 * A report card's files on Telegram, against the fake Bot API: every file as a document (the
 * original, byte for byte), as a silent reply to the card's message, its caption linking to the
 * PPM page that plays the original; a video over 50 MB compressed first (once, however many chats)
 * and captioned "compressed from", or replaced by a "too large" message that links to that page; a
 * file whose upload may have arrived sent again once at most; and the card's own text listing the
 * files with their links.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramBotClient, MAX_TELEGRAM_UPLOAD_BYTES } from "../../../src/services/telegram/telegram-bot-client.ts";
import { TELEGRAM_API_BASE_ENV } from "../../../src/services/telegram/telegram-api-base.ts";
import { AssistantTelegramSendQueue, MAYBE_SENT_RESEND_MS } from "../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import { cardFileSends } from "../../../src/services/assistant-telegram/assistant-telegram-card-files.ts";
import { formatManagerCard } from "../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";
import { removeCardFile, storeCardFile, cardFileOf } from "../../../src/services/assistant-cards/card-files-store.ts";
import type { AssistantCard, CardFile } from "../../../src/shared/assistant-cards.ts";
import { startFakeTelegram, type FakeTelegram } from "../../helpers/fake-telegram-bot-api.ts";

const MB = 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const MP4 = Buffer.from([0, 0, 0, 0x18, ...Buffer.from("ftypisom"), 0, 0, 2, 0, ...Buffer.from("isomiso2")]);
const BASE = "https://ppm.example.com";
const viewLink = (id: string) => `${BASE}/card-file/${id}`;

let fake: FakeTelegram;
let client: TelegramBotClient;
let dir: string;
const savedBase = process.env[TELEGRAM_API_BASE_ENV];
const stored: string[] = [];

async function keep(name: string, bytes: Buffer): Promise<CardFile> {
  const src = join(dir, name);
  writeFileSync(src, bytes);
  const s = await storeCardFile(src, name, dir);
  stored.push(s.id);
  return cardFileOf(s);
}

const cardWith = (files: CardFile[]): AssistantCard => ({
  id: "card-1", kind: "done", projectName: "api", title: "Clip ready", body: "Here it is.", payload: { files },
} as unknown as AssistantCard);

const newQueue = () => new AssistantTelegramSendQueue(client, { canSend: () => true, scaleDelay: () => 1 });

beforeAll(() => {
  fake = startFakeTelegram();
  process.env[TELEGRAM_API_BASE_ENV] = fake.url;
  client = new TelegramBotClient(fake.token, { sleep: async () => {} });
  dir = mkdtempSync(join(tmpdir(), "tg-card-files-"));
});
afterAll(async () => {
  fake.stop();
  if (savedBase === undefined) delete process.env[TELEGRAM_API_BASE_ENV];
  else process.env[TELEGRAM_API_BASE_ENV] = savedBase;
  for (const id of stored) await removeCardFile(id);
  rmSync(dir, { recursive: true, force: true });
});

describe("a card's files on Telegram", () => {
  it("go as documents (pictures and videos too), each replying to the card, silent, linking to the original", async () => {
    const chat = 101;
    const files = [
      await keep("shot.png", PNG),
      await keep("clip.mp4", Buffer.concat([MP4, Buffer.from("frames")])),
      await keep("spec.pdf", Buffer.from("%PDF-1.7 body")),
      await keep("build.zip", Buffer.from("PK\x03\x04 zip")),
    ];
    const card = await client.sendMessage(chat, "<b>Clip ready</b>");
    if (!card.ok) throw new Error("card not sent");
    const queue = newQueue();
    for (const { task, ready } of cardFileSends(String(chat), cardWith(files), { replyTo: () => card.result.message_id, url: null, viewLink })) {
      expect(ready).toBeUndefined();
      queue.enqueue(String(chat), task);
    }
    await queue.whenIdle();
    const sent = fake.sent(chat).slice(1);
    expect(sent.map((m) => m.photo ? "sendPhoto" : m.file?.method)).toEqual(["sendDocument", "sendDocument", "sendDocument", "sendDocument"]);
    expect(sent.every((m) => m.reply_to === card.result.message_id && m.silent)).toBe(true);
    expect(sent.map((m) => m.file?.filename)).toEqual(["shot.png", "clip.mp4", "spec.pdf", "build.zip"]);
    expect(sent[1]!.text).toContain("2/4. clip.mp4");
    expect(sent[1]!.text).toContain("Open in PPM");
    expect(fake.calls.filter((c) => c.method === "sendDocument").at(-3)!.body.caption).toContain(viewLink(files[1]!.id));
  });

  it("replace a file Telegram cannot take with a message saying so and linking to the original", async () => {
    const chat = 102;
    const big = { ...(await keep("render.mov", Buffer.concat([MP4, Buffer.from("x")]))), size: 120 * MB };
    const archive = { ...(await keep("assets.zip", Buffer.from("PK zip"))), size: 300 * MB };
    const queue = newQueue();
    for (const { task } of cardFileSends(String(chat), cardWith([big, archive]), { replyTo: () => 7, url: "https://ppm.example.com/x", viewLink, canCompress: () => false })) {
      queue.enqueue(String(chat), task);
    }
    await queue.whenIdle();
    const [video, zip] = fake.sent(chat);
    expect(video!.text).toContain("render.mov (120.0 MB) is too large to send here");
    expect(video!.text).toContain("ffmpeg is not installed");
    expect(video!.text).toContain("open it in PPM (the original, nothing compressed)");
    expect(zip!.text).toContain("assets.zip (300.0 MB) is too large");
    const html = fake.calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === String(chat)).map((c) => String(c.body.text));
    expect(html[0]).toContain(`href="${viewLink(big.id)}"`);
    expect(fake.calls.some((c) => c.method === "sendDocument" && String(c.body.chat_id) === String(chat))).toBe(false);
  });

  it("compress an oversized video once, send the copy as a document saying what it was compressed from", async () => {
    const [chatA, chatB] = [103, 104];
    const big = { ...(await keep("long.mov", Buffer.concat([MP4, Buffer.from("x")]))), size: 83 * MB };
    let compressions = 0;
    let finish: () => void = () => {};
    const gate = new Promise<void>((r) => { finish = r; });
    const compress = async (_input: string, output: string) => {
      compressions++;
      await gate;
      await writeFile(output, Buffer.concat([MP4, Buffer.alloc(2048)]));
      return { ok: true as const, size: 2048 + MP4.length };
    };
    const queue = newQueue();
    const deps = { replyTo: () => 9, url: null, viewLink, canCompress: () => true, compress };
    const readies: Array<Promise<unknown>> = [];
    for (const chat of [chatA, chatB]) {
      for (const { task, ready } of cardFileSends(String(chat), cardWith([big]), deps)) {
        readies.push(ready!.then(() => queue.enqueue(String(chat), task)));
      }
    }
    // The chat's other messages are not held up while ffmpeg works.
    await client.sendMessage(chatA, "something else");
    expect(fake.sent(chatA).map((m) => m.text)).toEqual(["something else"]);
    finish();
    await Promise.all(readies);
    await queue.whenIdle();
    expect(compressions).toBe(1);
    for (const chat of [chatA, chatB]) {
      const copy = fake.sent(chat).find((m) => m.file);
      expect(copy?.file).toMatchObject({ method: "sendDocument", filename: "long.mp4" });
      expect(copy?.text).toContain("compressed from 83.0 MB");
      expect(copy?.text).toContain("Watch the original in PPM");
    }
  });

  it("say why when a video could not be compressed", async () => {
    const chat = 105;
    const big = { ...(await keep("huge.mp4", Buffer.concat([MP4, Buffer.from("x")]))), size: 900 * MB };
    const [send] = cardFileSends(String(chat), cardWith([big]), {
      replyTo: () => undefined, url: null, canCompress: () => true,
      compress: async () => ({ ok: false as const, why: "the video is too long to fit in 50 MB at a watchable quality" }),
    });
    await send!.ready;
    const queue = newQueue();
    queue.enqueue(String(chat), send!.task);
    await queue.whenIdle();
    expect(fake.lastText(chat)).toContain("could not be made smaller: the video is too long");
  });

  it("send a file whose upload may have arrived once more, never more", async () => {
    const file = await keep("again.pdf", Buffer.from("%PDF-1.7"));
    const [{ task }] = cardFileSends("106", cardWith([file]), { replyTo: () => undefined, url: null });
    let uploads = 0;
    const stub = { sendFile: async () => { uploads++; return { ok: false as const, errorCode: null, description: "timed out", maybeSent: true as const }; } };
    expect(await task.run(stub as unknown as TelegramBotClient)).toEqual({ kind: "retry", afterMs: MAYBE_SENT_RESEND_MS, why: "timed out" });
    expect((await task.run(stub as unknown as TelegramBotClient)).kind).toBe("failed");
    expect(uploads).toBe(2);
  });

  it("refuse an upload over the Bot API's limit before sending anything", async () => {
    const before = fake.calls.length;
    const res = await client.sendFile(107, { method: "sendDocument", bytes: new Uint8Array(MAX_TELEGRAM_UPLOAD_BYTES + 1), filename: "x.bin", mime: "application/octet-stream" });
    expect(res.ok).toBe(false);
    expect(fake.calls.length).toBe(before);
  });
});

describe("the card's own text", () => {
  const files: CardFile[] = [
    { id: "a".repeat(32), name: "clip.mp4", size: 27 * MB, kind: "video", mime: "video/mp4", sha256: "" },
    { id: "b".repeat(32), name: "render.mov", size: 83 * MB, kind: "video", mime: "video/quicktime", sha256: "" },
    { id: "c".repeat(32), name: "assets.zip", size: 300 * MB, kind: "other", mime: "application/octet-stream", sha256: "" },
  ];
  const card = { kind: "done", projectName: "api", provenance: null, title: "Clip ready", body: "", payload: { files }, okOffered: false };

  it("lists its files, each linked to the PPM page that plays the original", () => {
    const { html } = formatManagerCard({ ...card, fileLinkBase: BASE } as never, "full");
    expect(html).toContain("3 files: tap a name to watch the original in PPM. Copies follow this card.");
    expect(html).toContain(`📎 <a href="${viewLink("a".repeat(32))}">clip.mp4</a> · 27.0 MB`);
    expect(html).toContain("render.mov</a> · 83.0 MB <i>(over Telegram's 50 MB limit: a compressed copy follows if PPM can make one; the original is in PPM)</i>");
    expect(html).toContain("assets.zip</a> · 300.0 MB <i>(over Telegram's 50 MB limit: open it in PPM)</i>");
  });

  it("names them without links when PPM has no address, and not at all for a title-only project", () => {
    expect(formatManagerCard(card as never, "full").html).toContain("📎 clip.mp4 · 27.0 MB");
    expect(formatManagerCard({ ...card, fileLinkBase: BASE } as never, "title").html).not.toContain("clip.mp4");
  });
});
