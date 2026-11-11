import type { NotificationEvent } from "./notification-settings.ts";

export type FeedKind = "approval" | "question" | "done" | "schedule" | "other";

export const FEED_KINDS: readonly FeedKind[] = [
  "approval",
  "question",
  "done",
  "schedule",
  "other",
];

export const NOTIFICATION_FEED_CHANGED_EVENT = "notifications:feed_changed" as const;

export interface FeedRow {
  id: number;
  kind: FeedKind;
  project: string;
  sessionId: string | null;
  scheduleId: string | null;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
}

export interface FeedListOptions {
  limit?: number;
  before?: number;
}

export interface FeedListResult {
  rows: FeedRow[];
  hasMore: boolean;
}

export interface RecordFeedInput {
  kind: FeedKind;
  projectName?: string;
  project?: string;
  sessionId?: string | null;
  scheduleId?: string | null;
  title: string;
  body?: string;
  createdAt?: number;
}

export function isFeedKind(value: unknown): value is FeedKind {
  return typeof value === "string" && (FEED_KINDS as readonly string[]).includes(value);
}

/** Map a server notification event type to its feed kind. */
export function feedKindForEvent(event: NotificationEvent | string): FeedKind {
  switch (event) {
    case "approval_request":
    case "collab_approval":
    case "approval":
      return "approval";
    case "question":
      return "question";
    case "done":
      return "done";
    case "schedule":
      return "schedule";
    default:
      return "other";
  }
}
