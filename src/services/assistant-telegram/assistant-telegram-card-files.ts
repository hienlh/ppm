/**
 * The files a report card carries (`payload.files`), sent to a Telegram chat after the card's own
 * message and as replies to it, so each file reads as part of that card. Every file goes by
 * `sendDocument` (`telegramFilePlan`), pictures and videos included: a document reaches the phone
 * byte for byte, where `sendPhoto` would re-encode a picture. Each caption links to the PPM page
 * that plays the original (`/card-file/<id>`), which has no size limit at all.
 *
 * Over the Bot API's 50 MB upload limit a video is compressed with ffmpeg first, when the host has
 * it (two-pass, same resolution), and its caption says what it was compressed from. That can take
 * minutes, and a chat's messages go out one at a time, so the compression
 * runs beside the send queue and the file joins it only once its copy is ready: the chat's other
 * messages are not held up behind it. The copy is kept beside PPM's own (one compression however
 * many chats get the card, none on a resend). A file that still cannot go (no ffmpeg, too long, not
 * a video) is replaced by one short message under the card saying it is too large and how to get
 * it in PPM.
 *
 * A file whose upload timed out may well have arrived (Telegram answers late, and the Bot API has
 * no idempotency key), so it is sent again at most once, after `MAYBE_SENT_RESEND_MS`: a 27 MB clip
 * arriving twice is a nuisance, five times is not acceptable.
 *
 * Only for a card shown in full: a project whose cards reach the phone by title only gets no
 * files either. A copy already pruned (30 days) is left out.
 */
import { readFile, stat } from "node:fs/promises";
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { formatFileSize, telegramFilePlan, type CardFile } from "../../shared/card-files.ts";
import { cardFilePath, cardFileTelegramCopyPath } from "../assistant-cards/card-files-store.ts";
import { canCompressVideo, compressVideoForTelegram, type CompressResult } from "../assistant-cards/card-file-video-compress.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import type { TelegramBotClient, TelegramCallResult } from "../telegram/telegram-bot-client.ts";
import { MAYBE_SENT_RESEND_MS, outcomeOf, type SendTask, type TaskOutcome } from "./assistant-telegram-send-queue.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export interface CardFileTaskDeps {
  /** The card's own message in this chat, once it was sent; the files answer it. */
  replyTo: () => number | undefined;
  /** The PPM link to the card's chat, named in a "too large" message when there is no viewer link. */
  url: string | null;
  /** The PPM page that plays file `id` as it is (`/card-file/<id>`), when PPM has an address to link. */
  viewLink?: (id: string) => string;
  canCompress?: () => boolean;
  compress?: (input: string, output: string) => Promise<CompressResult>;
  read?: (path: string) => Promise<Uint8Array | null>;
  exists?: (path: string) => Promise<boolean>;
}

/** How one file goes to Telegram, once decided (and, for a large video, once compressed). */
export type PreparedCardFile =
  | { kind: "upload"; method: "sendDocument"; path: string; name: string; mime: string; compressedFrom?: number }
  | { kind: "too_large"; why: string }
  | { kind: "gone" };

/** One file's task, and when it may join the queue: at once, or once `ready` settles. */
export interface CardFileSend {
  task: SendTask;
  ready?: Promise<unknown>;
}

/**
 * The caption under a file: its name and size, "compressed from" when Telegram gets a smaller copy,
 * and the PPM link that plays the original.
 */
export function cardFileCaption(file: CardFile, index: number, total: number, opts: { sentBytes?: number; viewLink?: string } = {}): string {
  const number = total > 1 ? `<b>${index + 1}/${total}.</b> ` : "";
  const size = opts.sentBytes !== undefined
    ? `${formatFileSize(opts.sentBytes)}, compressed from ${formatFileSize(file.size)}`
    : formatFileSize(file.size);
  const link = opts.viewLink ? `\n<a href="${escapeTelegramHtml(opts.viewLink)}">▶ ${opts.sentBytes !== undefined ? "Watch the original" : "Open"} in PPM</a>` : "";
  return `📎 ${number}${escapeTelegramHtml(file.name)} · ${size}${link}`;
}

/** The message sent in place of a file Telegram cannot take. */
export function tooLargeHtml(file: CardFile, why: string, url: string | null, viewLink?: string): string {
  const where = viewLink
    ? `<a href="${escapeTelegramHtml(viewLink)}">open it in PPM</a> (the original, nothing compressed)`
    : url ? `<a href="${escapeTelegramHtml(url)}">open the card in PPM</a>` : "open the card in PPM (PPM Assistant → the card)";
  return `⚠️ <b>${escapeTelegramHtml(file.name)}</b> (${formatFileSize(file.size)}) is too large to send here: `
    + `${escapeTelegramHtml(why)}. To watch or download it, ${where}.`;
}

const defaultRead = (path: string) => readFile(path).then((b) => new Uint8Array(b), () => null);
const defaultExists = (path: string) => stat(path).then((s) => s.isFile() && s.size > 0, () => false);

/** Compressions under way, by file id: a card sent to two chats is compressed once. */
const compressing = new Map<string, Promise<CompressResult>>();

/** How `file` goes to Telegram; compresses an oversized video first when the host can. */
export async function prepareCardFile(file: CardFile, deps: Omit<CardFileTaskDeps, "replyTo" | "url"> = {}): Promise<PreparedCardFile> {
  const exists = deps.exists ?? defaultExists;
  const original = cardFilePath(file.id);
  if (!(await exists(original))) return { kind: "gone" };
  const plan = telegramFilePlan(file, (deps.canCompress ?? canCompressVideo)());
  if (plan.method === "too_large") {
    return {
      kind: "too_large",
      why: file.kind === "video"
        ? "it is over Telegram's 50 MB limit for bots, and ffmpeg is not installed on the PPM host to make it smaller"
        : "it is over Telegram's 50 MB limit for bots",
    };
  }
  if (plan.method !== "compress") return { kind: "upload", method: plan.method, path: original, name: file.name, mime: file.mime };
  const copy = cardFileTelegramCopyPath(file.id);
  // Looked up and started with no await in between, so two chats asking at once share one job.
  let job = compressing.get(file.id);
  if (!job) {
    const compress = deps.compress ?? compressVideoForTelegram;
    job = (async (): Promise<CompressResult> => ((await exists(copy)) ? { ok: true, size: 0 } : compress(original, copy)))()
      .finally(() => compressing.delete(file.id));
    compressing.set(file.id, job);
  }
  const made = await job;
  if (!made.ok) return { kind: "too_large", why: `it is over Telegram's 50 MB limit for bots and could not be made smaller: ${made.why}` };
  // Sent as a file too: the copy is already the best that fits, and a document arrives as it is.
  return { kind: "upload", method: "sendDocument", path: copy, name: `${file.name.replace(/\.[^.]+$/, "")}.mp4`, mime: "video/mp4", compressedFrom: file.size };
}

/** One send per file, in the card's order; empty when the card has none. */
export function cardFileSends(chatId: string, card: AssistantCard, deps: CardFileTaskDeps): CardFileSend[] {
  const files = card.payload.files ?? [];
  return files.map((file, i) => {
    const needsCompression = telegramFilePlan(file, (deps.canCompress ?? canCompressVideo)()).method === "compress";
    const prepared = needsCompression ? prepareCardFile(file, deps) : null;
    // Never rejects: a failed compression is a "too large" answer, and anything else is caught here.
    const ready = prepared?.catch(() => null);
    return { task: cardFileTask(chatId, card, file, i, files.length, deps, prepared), ...(ready ? { ready } : {}) };
  });
}

function cardFileTask(
  chatId: string, card: AssistantCard, file: CardFile, index: number, total: number, deps: CardFileTaskDeps,
  early: Promise<PreparedCardFile> | null,
): SendTask {
  const read = deps.read ?? defaultRead;
  let attempts = 0;
  let maybeDelivered = false;
  let prepared: PreparedCardFile | null = null;

  /** A send that may have arrived goes once more, never more (see the header). */
  const settle = (res: TelegramCallResult<unknown>): TaskOutcome => {
    if (!res.ok && "maybeSent" in res && res.maybeSent) {
      if (maybeDelivered) return { kind: "failed", why: `Telegram did not answer (${res.description}); it may have arrived, so it is not sent again` };
      maybeDelivered = true;
      log.info(`${card.kind} card file: Telegram did not answer (${res.description}); sending it once more in ${MAYBE_SENT_RESEND_MS / 1000}s, it may arrive twice`);
      return { kind: "retry", afterMs: MAYBE_SENT_RESEND_MS, why: res.description };
    }
    return outcomeOf(res, attempts);
  };

  return {
    final: true,
    label: `${card.kind} card file`,
    run: async (client: TelegramBotClient) => {
      attempts++;
      prepared ??= early ? await early : await prepareCardFile(file, deps);
      const replyTo = deps.replyTo();
      // The card rang (or not) for itself; its files follow quietly.
      const base = { ...(replyTo ? { replyTo } : {}), silent: true };
      if (prepared.kind === "gone") {
        log.info(`card ${card.id}: file ${file.id} is no longer kept; not sent`);
        return { kind: "done" };
      }
      const viewLink = deps.viewLink?.(file.id);
      if (prepared.kind === "too_large") {
        return settle(await client.sendMessage(chatId, tooLargeHtml(file, prepared.why, deps.url, viewLink), base));
      }
      const bytes = await read(prepared.path);
      if (!bytes) return { kind: "failed", why: "the file could not be read" };
      const caption = cardFileCaption(file, index, total, {
        ...(prepared.compressedFrom !== undefined ? { sentBytes: bytes.byteLength } : {}), ...(viewLink ? { viewLink } : {}),
      });
      return settle(await client.sendFile(chatId, { method: prepared.method, bytes, filename: prepared.name, mime: prepared.mime, caption }, base));
    },
  };
}
