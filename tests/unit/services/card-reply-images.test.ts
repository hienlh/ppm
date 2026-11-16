/**
 * Images on a reply to a PPM Assistant card: every payload checked (count, type, size, base64, the
 * bytes' own signature) before anything happens; a caller's `path` never used; files written only
 * by the forward, under names the server makes up inside PPM's uploads folder, and removed again
 * when the words do not go out; image-only replies allowed; "send anyway" keeps the images.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { replyToCard, type CardReplyDeps } from "../../../src/services/assistant-cards/card-reply-actions.ts";
import { forwardUserWords, type ForwardEnv, type ForwardHow, type ForwardResult } from "../../../src/services/assistant-cards/forward-verbatim.ts";
import {
  bytesMatchMediaType, MAX_REPLY_IMAGE_BYTES, validateReplyImages, writeReplyImages, type ValidReplyImage,
} from "../../../src/services/assistant-cards/card-reply-images.ts";
import { getUploadsDir } from "../../../src/services/chat-upload-storage.service.ts";
import type { DeliverUserWordsInput } from "../../../src/server/ws/chat-user-words.ts";
import { STALE_REPLY_MS } from "../../../src/shared/assistant-limits.ts";
import type { AssistantCard } from "../../../src/shared/assistant-cards.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const b64 = (b: Buffer) => b.toString("base64");
const png = { data: b64(PNG), mediaType: "image/png" };
const jpeg = { data: b64(JPEG), mediaType: "image/jpeg" };

const uploads = (): string[] => (existsSync(getUploadsDir()) ? readdirSync(getUploadsDir()) : []);

describe("checking a reply's images", () => {
  it("takes none, or up to five of the four types whose bytes match their label", () => {
    expect(validateReplyImages(undefined)).toEqual({ ok: true, images: [] });
    expect(validateReplyImages([])).toEqual({ ok: true, images: [] });
    const r = validateReplyImages([png, jpeg, { data: b64(GIF), mediaType: "image/gif" }, { data: b64(WEBP), mediaType: "image/webp" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images.map((i) => [i.mediaType, i.bytes.length])).toEqual([["image/png", 12], ["image/jpeg", 7], ["image/gif", 10], ["image/webp", 16]]);
  });

  it("refuses more than five, an unsupported type, and something that is not a list", () => {
    expect(validateReplyImages(Array(6).fill(png))).toEqual({ ok: false, error: "A reply may carry at most 5 images" });
    expect(validateReplyImages([{ data: b64(PNG), mediaType: "image/svg+xml" }])).toEqual({ ok: false, error: "Image 1 must be a PNG, JPEG, GIF or WebP image" });
    expect(validateReplyImages("x")).toEqual({ ok: false, error: "images must be a list" });
    expect(validateReplyImages([null])).toEqual({ ok: false, error: "Image 1 is not an image" });
    expect(validateReplyImages([{ mediaType: "image/png" }])).toEqual({ ok: false, error: "Image 1 has no data" });
  });

  it("refuses an image over 5 MB, decoded or as base64", () => {
    const big = Buffer.alloc(MAX_REPLY_IMAGE_BYTES + 1);
    PNG.copy(big);
    expect(validateReplyImages([{ data: b64(big), mediaType: "image/png" }])).toEqual({ ok: false, error: "Image 1 is larger than 5 MB" });
    const exact = Buffer.alloc(MAX_REPLY_IMAGE_BYTES);
    PNG.copy(exact);
    expect(validateReplyImages([{ data: b64(exact), mediaType: "image/png" }]).ok).toBe(true);
  });

  it("refuses base64 that does not decode cleanly, a data: URL included", () => {
    for (const data of [`${png.data}!`, png.data.slice(1), `data:image/png;base64,${png.data}`, `${png.data.slice(0, -4)}\n${png.data.slice(-4)}`, "iVBO R=="]) {
      expect(validateReplyImages([{ data, mediaType: "image/png" }])).toEqual({ ok: false, error: "Image 1 is not valid base64" });
    }
  });

  it("refuses bytes that are not the type they claim, and names which image", () => {
    expect(validateReplyImages([png, { data: b64(JPEG), mediaType: "image/png" }])).toEqual({ ok: false, error: "Image 2 is not the PNG image it says it is" });
    expect(validateReplyImages([{ data: b64(Buffer.from("<svg/>")), mediaType: "image/gif" }]).ok).toBe(false);
    expect(bytesMatchMediaType(Buffer.from("RIFF0000WAVE"), "image/webp")).toBe(false);
    expect(bytesMatchMediaType(Buffer.alloc(0), "image/jpeg")).toBe(false);
  });

  it("reads only data and mediaType: a path on the entry is never carried along", () => {
    const r = validateReplyImages([{ ...png, path: "/etc/passwd", name: "x.png" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.images[0]!).sort()).toEqual(["bytes", "data", "mediaType"]);
  });
});

describe("writing them", () => {
  it("puts each under a name the server makes up, inside the uploads folder", () => {
    const r = validateReplyImages([png, jpeg]);
    if (!r.ok) throw new Error(r.error);
    const written = writeReplyImages(r.images);
    expect(written.map((w) => dirname(w.path))).toEqual([getUploadsDir(), getUploadsDir()]);
    expect(written[0]!.path).toMatch(/[\\/]card-[0-9a-f]{8}\.png$/);
    expect(written[1]!.path).toMatch(/[\\/]card-[0-9a-f]{8}\.jpg$/);
    expect(readFileSync(written[0]!.path)).toEqual(PNG);
    expect(getUploadsDir().startsWith(process.env.PPM_HOME!)).toBe(true);
  });

  it("removes what it wrote when a later write fails", () => {
    const dir = join(process.env.PPM_HOME!, `half-${crypto.randomUUID()}`);
    mkdirSync(dir);
    const good = validateReplyImages([png]);
    if (!good.ok) throw new Error(good.error);
    const broken = { data: png.data, mediaType: "image/png", bytes: undefined } as unknown as ValidReplyImage;
    expect(() => writeReplyImages([good.images[0]!, broken], dir)).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

// ── replyToCard ────────────────────────────────────────────────────────────────
let now = Date.UTC(2026, 10, 16, 8, 0, 0);
const cards = createAssistantCards({ now: () => now, projects: () => [{ name: "nxsys", path: "/p/nxsys" }], announce: () => {} });
const forwards: Array<{ text: string; how: ForwardHow }> = [];
const deps: CardReplyDeps = {
  cards, now: () => now, zone: () => "Asia/Saigon",
  forward: async (_card, text, how): Promise<ForwardResult> => {
    forwards.push({ text, how });
    return { ok: true, to: "manager", projectName: "nxsys", sessionId: "mgr" };
  },
};
const web = { channel: "ppm" as const, deviceId: "dev-1" };
const decision = () => cards.create({
  kind: "needs_decision", projectName: "nxsys", projectPath: "/p/nxsys", sessionId: "mgr", title: "Which layout?", body: "Two options.",
});

beforeEach(() => { getDb().run("DELETE FROM assistant_cards"); forwards.length = 0; now += 60_000; });

describe("a reply with images", () => {
  it("may be images alone", async () => {
    const card = decision();
    const r = await replyToCard(card.id, { text: "  ", images: [png] }, web, deps);
    expect(r.ok).toBe(true);
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!.text).toBe("  ");
    expect(forwards[0]!.how.images!.map((i) => i.mediaType)).toEqual(["image/png"]);
    expect(cards.get(card.id)!.status).toBe("answered");
  });

  it("carries words and images together", async () => {
    const r = await replyToCard(decision().id, { text: "Like this one", images: [png, jpeg] }, web, deps);
    expect(r.ok).toBe(true);
    expect(forwards[0]!.text).toBe("Like this one");
    expect(forwards[0]!.how.images).toHaveLength(2);
  });

  it("still needs words when there are no images", async () => {
    expect(await replyToCard(decision().id, { text: " ", images: [] }, web, deps)).toMatchObject({ ok: false, status: 400, error: "text is required" });
    expect(await replyToCard(decision().id, { images: [png] }, web, deps)).toMatchObject({ ok: false, status: 400, error: "text is required" });
  });

  it("refuses a bad image before touching the card, forwarding nothing and writing nothing", async () => {
    const card = decision();
    const before = uploads();
    const r = await replyToCard(card.id, { text: "see", images: [png, { data: b64(JPEG), mediaType: "image/png" }] }, web, deps);
    expect(r).toMatchObject({ ok: false, status: 400, error: "Image 2 is not the PNG image it says it is" });
    expect(forwards).toHaveLength(0);
    expect(cards.get(card.id)!.status).toBe("open");
    expect(uploads()).toEqual(before);
  });

  it("asks before a stale card, then sends the same images when told to", async () => {
    const card = decision();
    now += STALE_REPLY_MS + 1;
    const asked = await replyToCard(card.id, { text: "", images: [png] }, web, deps);
    expect(asked).toMatchObject({ ok: false, status: 409, error: "confirm" });
    expect(forwards).toHaveLength(0);
    const sent = await replyToCard(card.id, { text: "", images: [png], force: true }, web, deps);
    expect(sent.ok).toBe(true);
    expect(forwards[0]!.how.images![0]!.data).toBe(png.data);
  });
});

// ── forwardUserWords ───────────────────────────────────────────────────────────
function forwardEnv(result: { ok: true } | { ok: false; error: string } = { ok: true }) {
  const sent: DeliverUserWordsInput[] = [];
  const toAssistant: Array<{ text: string; images?: unknown }> = [];
  const env: ForwardEnv = {
    now: () => now,
    managerTarget: () => ({ sessionId: "mgr", providerId: "codex", projectName: "nxsys", projectPath: "/p/nxsys" }),
    deliverUserWords: async (input) => {
      sent.push(input);
      return result.ok ? { ok: true, content: input.text, sessionId: "mgr", delivered: "started", clientMessageId: input.clientMessageId! } : result;
    },
    sendToAssistant: async (text, _card, images) => { toAssistant.push({ text, images }); return { ok: true }; },
    userWrote: () => {}, mainSession: () => null, note: () => {}, trace: () => {},
  };
  return { env, sent, toAssistant };
}
const valid = (...raw: Array<{ data: string; mediaType: string }>): ValidReplyImage[] => {
  const r = validateReplyImages(raw);
  if (!r.ok) throw new Error(r.error);
  return r.images;
};
const managerCard = (): AssistantCard => decision();

describe("forwarding a reply's images", () => {
  it("hands the delivery door the payloads and the files it wrote, inside the uploads folder", async () => {
    const { env, sent } = forwardEnv();
    const r = await forwardUserWords(managerCard(), "", { actor: web, supersede: false, images: valid(png, jpeg) }, env);
    expect(r.ok).toBe(true);
    const images = sent[0]!.images!;
    expect(images.map((i) => i.mediaType)).toEqual(["image/png", "image/jpeg"]);
    expect(images[0]!.data).toBe(png.data);
    for (const img of images) {
      expect(dirname(img.path)).toBe(getUploadsDir());
      expect(existsSync(img.path)).toBe(true);
    }
    expect(readFileSync(images[1]!.path)).toEqual(JPEG);
  });

  it("removes the files when the words did not go out", async () => {
    const { env, sent } = forwardEnv({ ok: false, error: "The session is still starting" });
    const r = await forwardUserWords(managerCard(), "see", { actor: web, supersede: false, images: valid(png) }, env);
    expect(r).toEqual({ ok: false, error: "The session is still starting" });
    expect(existsSync(sent[0]!.images![0]!.path)).toBe(false);
  });

  it("writes nothing when the card's chat is gone", async () => {
    const { env, sent } = forwardEnv();
    env.managerTarget = () => null;
    const before = uploads();
    const r = await forwardUserWords(managerCard(), "see", { actor: web, supersede: false, images: valid(png) }, env);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(uploads()).toEqual(before);
  });

  it("sends the payloads along to the Assistant for a card no manager chat owns (Telegram)", async () => {
    const { env, toAssistant } = forwardEnv();
    const digest = cards.create({ kind: "digest", projectName: null, projectPath: null, sessionId: null, title: "Morning digest" });
    const before = uploads();
    const r = await forwardUserWords(digest, "", { actor: { channel: "telegram", telegramChatId: "42" }, supersede: false, images: valid(png) }, env);
    expect(r).toEqual({ ok: true, to: "assistant" });
    expect(toAssistant[0]!.images).toEqual([{ data: png.data, mediaType: "image/png" }]);
    expect(uploads()).toEqual(before);
  });
});
