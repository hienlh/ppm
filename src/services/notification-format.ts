/**
 * What a notification says, for each channel. Pure functions, so the wording can be
 * tested without a bot, a browser or a clock.
 */
import type { NotificationPayload } from "./notification.service.ts";

const DETAIL_MAX = 300;

export function truncateText(text: string, max: number): string {
  const clean = text.trim().replace(/\n{3,}/g, "\n\n");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Escape for Telegram's HTML parse mode, attribute values included. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Where a notification opens PPM: the session's chat when there is one.
 * `project` must be the project's NAME — the app resolves `/project/<x>` by name, and
 * a path there falls back to whichever project sorts first.
 */
export function notificationPath(payload: Pick<NotificationPayload, "project" | "sessionId" | "providerId">): string {
  if (!payload.project) return "/";
  const base = `/project/${encodeURIComponent(payload.project)}`;
  if (!payload.sessionId) return base;
  // `provider/session`, as the app's own chat URLs name it: without the provider a chat tab
  // opens as Claude, which cannot show a Codex thread.
  const chat = payload.providerId ? `${payload.providerId}/${payload.sessionId}` : payload.sessionId;
  return `${base}?openChat=${encodeURIComponent(chat)}`;
}

/** Bold heading, one line of context, the detail, and a link back. */
export function formatTelegramNotification(payload: NotificationPayload, deviceName: string, link: string | null): string {
  let text = `<b>${escapeTelegramHtml(deviceName)} — ${escapeTelegramHtml(payload.title)}</b>\n${escapeTelegramHtml(payload.body)}`;
  if (payload.detail?.trim()) {
    const detail = escapeTelegramHtml(truncateText(payload.detail, DETAIL_MAX));
    text += payload.detailStyle === "code" ? `\n<pre>${detail}</pre>` : `\n<blockquote>${detail}</blockquote>`;
  }
  if (link) text += `\n\n<a href="${escapeTelegramHtml(link)}">Open in PPM</a>`;
  return text;
}

/** A system notification has a title and a few lines; the detail goes under the context line. */
export function formatPushNotification(payload: NotificationPayload, deviceName: string): { title: string; body: string } {
  const detail = payload.detail?.trim() ? `\n${truncateText(payload.detail, 200)}` : "";
  return { title: `${payload.title} · ${deviceName}`, body: `${payload.body}${detail}` };
}

/**
 * The one thing worth reading about a pending approval: the command, the file, the URL,
 * or the question being asked. Undefined when the tool's input has none of them.
 */
export function describeApprovalInput(tool: string, input: unknown): Pick<NotificationPayload, "detail" | "detailStyle"> {
  if (!input || typeof input !== "object") return {};
  const i = input as Record<string, unknown>;

  if (tool === "AskUserQuestion" && Array.isArray(i.questions)) {
    const questions = i.questions as Array<{ question?: unknown }>;
    const first = typeof questions[0]?.question === "string" ? questions[0].question : "";
    if (!first) return {};
    const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    return { detail: `${first}${more}`, detailStyle: "quote" };
  }
  const command = typeof i.command === "string" ? i.command
    : Array.isArray(i.command) ? i.command.filter((p) => typeof p === "string").join(" ")
    : "";
  if (command) return { detail: command, detailStyle: "code" };
  for (const key of ["file_path", "notebook_path", "path", "url"]) {
    if (typeof i[key] === "string" && i[key]) return { detail: i[key] as string, detailStyle: "code" };
  }
  return {};
}
