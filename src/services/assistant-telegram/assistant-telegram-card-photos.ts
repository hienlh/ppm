/**
 * The pictures a report card carries (`payload.images`, design screenshots), sent to a Telegram
 * chat just before the card's own message, so the user sees the choices and then the card to
 * answer them on. One picture goes as a photo, several as one album; each caption numbers it the
 * way the card lists it. No link: the pictures are the picture, and PPM serves its copy only to a
 * signed-in browser.
 *
 * Sent only where the card is shown in full: a project whose cards reach the phone by title only
 * gets no pictures either. A picture whose file is gone (pruned after seven days) is left out.
 */
import { readFile } from "node:fs/promises";
import type { AssistantCard, CardImage } from "../../shared/assistant-cards.ts";
import { shotPngPath } from "../design/shots/design-shots.service.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { MAX_TELEGRAM_ALBUM, type TelegramPhotoUpload } from "../telegram/telegram-bot-client.ts";
import { outcomeOf, type SendTask } from "./assistant-telegram-send-queue.ts";

/** The caption under picture `index` (0-based) of a card. */
export function cardPhotoCaption(image: CardImage, index: number): string {
  const name = image.label ? `${image.file} · ${image.label}` : image.file;
  return `<b>${index + 1}.</b> ${escapeTelegramHtml(image.designTitle)} — ${escapeTelegramHtml(name)}`;
}

/** The task sending a card's pictures, or null when it has none. */
export function cardPhotosTask(chatId: string, card: AssistantCard, opts: {
  silent: () => boolean;
  read?: (id: string) => Promise<Uint8Array | null>;
}): SendTask | null {
  const images = (card.payload.images ?? []).slice(0, MAX_TELEGRAM_ALBUM);
  if (!images.length) return null;
  const read = opts.read ?? ((id: string) => readFile(shotPngPath(id)).then((b) => new Uint8Array(b), () => null));
  let attempts = 0;
  let uploads: TelegramPhotoUpload[] | null = null;
  return {
    final: true,
    label: `${card.kind} card pictures`,
    run: async (client) => {
      if (!uploads) {
        uploads = [];
        for (const [i, image] of images.entries()) {
          const bytes = await read(image.id);
          if (!bytes) continue;
          uploads.push({ bytes, filename: `${i + 1}-${image.file.replace(/[^\w.-]+/g, "_")}.png`, caption: cardPhotoCaption(image, i) });
        }
      }
      if (!uploads.length) return { kind: "done" };
      return outcomeOf(await client.sendPhotos(chatId, uploads, { silent: opts.silent() }), ++attempts);
    },
  };
}

