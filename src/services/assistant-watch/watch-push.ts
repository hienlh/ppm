import type { NotificationPayload } from "../notification.service.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { WatchEventKind, WatchEventNotice } from "../../types/chat.ts";

/**
 * The push notification a watch sends itself, naming the watched chat. Needed in two places:
 * an Assistant session no Telegram chat talks to has no other way to reach a user who walked
 * away (its own "Chat completed — PPM Assistant" alert says nothing about which chat), and a
 * report the Assistant failed to write three times still has to reach the user somehow.
 */

const MAX_DETAIL_CHARS = 300;

const HEADLINE: Record<WatchEventKind, string> = {
  done: "Chat finished",
  stopped: "Chat stopped",
  interrupted: "Chat interrupted by a restart",
  expired: "Watch expired, chat not finished",
};

/** The first non-empty line of `text`, cut to size. */
export function firstLine(text: string | undefined, max = MAX_DETAIL_CHARS): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const titleOf = (e: WatchEventNotice) => firstLine(e.title, 80) || `Session ${e.sessionId.slice(0, 8)}`;

function headline(events: readonly WatchEventNotice[]): string {
  if (events.length === 1) return `${HEADLINE[events[0]!.kind]}: ${titleOf(events[0]!)}`;
  return `${events.length} watched chats have news: ${events.map(titleOf).join(", ")}`;
}

/**
 * The Assistant reported: the push opens the Assistant session, where the report is, and
 * quotes its first line.
 */
export function reportedPush(
  events: readonly WatchEventNotice[],
  report: string,
  assistant: { sessionId: string; providerId: string },
): NotificationPayload {
  const projects = [...new Set(events.map((e) => e.project))].join(", ");
  return {
    title: headline(events),
    body: `${projects} — reported by PPM Assistant`,
    project: ASSISTANT_PROJECT_NAME,
    sessionId: assistant.sessionId,
    providerId: assistant.providerId,
    sessionTitle: events.length === 1 ? events[0]!.title : "PPM Assistant",
    detail: firstLine(report),
    detailStyle: "quote",
  };
}

/**
 * The Assistant could not report: the push says what happened by itself. One watched chat is
 * opened directly; several open the Assistant session, which lists them.
 */
export function unreportedPush(
  events: readonly WatchEventNotice[],
  assistant: { sessionId: string; providerId: string },
): NotificationPayload {
  const only = events.length === 1 ? events[0]! : null;
  const detail = only
    ? firstLine(only.kind === "done" ? only.finalText : only.kind === "stopped" ? only.stopReason : undefined)
    : "";
  return {
    title: headline(events),
    body: only ? `${only.project} — PPM Assistant could not write a report` : "PPM Assistant could not write a report",
    project: only ? only.project : ASSISTANT_PROJECT_NAME,
    sessionId: only ? only.sessionId : assistant.sessionId,
    providerId: only ? only.providerId : assistant.providerId,
    sessionTitle: only ? only.title : "PPM Assistant",
    ...(detail ? { detail, detailStyle: "quote" as const } : {}),
  };
}
