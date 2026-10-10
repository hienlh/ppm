/**
 * Links from a Telegram message back into PPM's Assistant.
 *
 * Telegram refuses a whole message whose inline button points at an address it does not accept
 * (`localhost`, a LAN IP, plain http): the message never arrives. So a link is a button only when
 * it is a public https address — PPM's tunnel or Tailscale Service — and otherwise sits in the
 * message's text, where a bad address costs nothing. A button that Telegram still refuses
 * (`BUTTON_URL_INVALID`) is sent again without it by the send queue.
 */
import { notificationLink } from "../notification-link.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";

export const OPEN_IN_PPM = "Open in PPM";

/** The absolute link that opens one Assistant session in PPM. */
export function assistantSessionLink(providerId: string, sessionId: string): Promise<string> {
  return notificationLink({ project: ASSISTANT_PROJECT_NAME, sessionId, providerId });
}

const PRIVATE_HOST = /^(?:localhost|.*\.localhost|.*\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[.*\])$/i;

/** True for an https URL on a public host name — the only kind Telegram takes on a button. */
export function isPublicHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname;
  // A bare IP or a single-label name is not something Telegram resolves for a button.
  if (PRIVATE_HOST.test(host) || !host.includes(".") || /^\d+(?:\.\d+){3}$/.test(host)) return false;
  return true;
}

/** A link to place under a message, or in its text when it cannot be a button. */
export interface PlacedLink {
  /** A URL button, when the link is public https. */
  button?: InlineKeyboardButton;
  /** HTML to append to the message text when it is not. */
  inline?: string;
}

export function placeLink(url: string, label = OPEN_IN_PPM): PlacedLink {
  if (isPublicHttpsUrl(url)) return { button: { text: label, url } };
  return { inline: `${escapeTelegramHtml(label)}: ${escapeTelegramHtml(url)}` };
}
