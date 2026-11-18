import { broadcastGlobalEvent } from "../server/ws/global.ts";
import {
  isFeedKind,
  NOTIFICATION_FEED_CHANGED_EVENT,
  type FeedKind,
  type FeedListOptions,
  type FeedListResult,
  type FeedRow,
  type RecordFeedInput,
} from "../shared/notification-feed.ts";
import { getDb } from "./db.service.ts";

export const MAX_FEED_ROWS = 500;
export const FEED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface RawFeedRow {
  id: number;
  kind: string;
  project: string;
  session_id: string | null;
  schedule_id: string | null;
  title: string;
  body: string;
  created_at: number;
  read_at: number | null;
}

function toFeedRow(row: RawFeedRow): FeedRow {
  return {
    id: row.id,
    kind: isFeedKind(row.kind) ? row.kind : ("other" satisfies FeedKind),
    project: row.project,
    sessionId: row.session_id,
    scheduleId: row.schedule_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    read: row.read_at !== null,
  };
}

function emitFeedChanged(): void {
  broadcastGlobalEvent({ type: NOTIFICATION_FEED_CHANGED_EVENT });
}

export class FeedNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(id: number) {
    super(`Notification ${id} not found`);
    this.name = "FeedNotFoundError";
  }
}

export class NotificationFeedService {
  record(e: RecordFeedInput): FeedRow {
    const db = getDb();
    const kind: FeedKind = isFeedKind(e.kind) ? e.kind : "other";
    const project = (e.projectName ?? e.project ?? "").trim();
    const sessionId = e.sessionId ? String(e.sessionId) : null;
    const scheduleId = e.scheduleId ? String(e.scheduleId) : null;
    const title = e.title;
    const body = e.body ?? "";
    const createdAt = e.createdAt ?? Date.now();

    const result = db
      .query(
        `INSERT INTO notification_feed (kind, project, session_id, schedule_id, title, body, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(kind, project, sessionId, scheduleId, title, body, createdAt);

    const id = Number(result.lastInsertRowid);
    if (e.createdAt === undefined) {
      this.prune(createdAt);
    }
    emitFeedChanged();

    return {
      id,
      kind,
      project,
      sessionId,
      scheduleId,
      title,
      body,
      createdAt,
      read: false,
    };
  }

  list(opts: FeedListOptions = {}): FeedListResult {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const fetchLimit = limit + 1;

    let rawRows: RawFeedRow[];
    if (opts.before !== undefined && Number.isFinite(opts.before)) {
      const cursor = db
        .query("SELECT id, created_at FROM notification_feed WHERE id = ?")
        .get(opts.before) as { id: number; created_at: number } | null;

      if (cursor) {
        rawRows = db
          .query(
            `SELECT id, kind, project, session_id, schedule_id, title, body, created_at, read_at
             FROM notification_feed
             WHERE created_at < ? OR (created_at = ? AND id < ?)
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(cursor.created_at, cursor.created_at, cursor.id, fetchLimit) as RawFeedRow[];
      } else {
        rawRows = db
          .query(
            `SELECT id, kind, project, session_id, schedule_id, title, body, created_at, read_at
             FROM notification_feed
             WHERE created_at < ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(opts.before, fetchLimit) as RawFeedRow[];
      }
    } else {
      rawRows = db
        .query(
          `SELECT id, kind, project, session_id, schedule_id, title, body, created_at, read_at
           FROM notification_feed
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(fetchLimit) as RawFeedRow[];
    }

    const hasMore = rawRows.length > limit;
    const rows = (hasMore ? rawRows.slice(0, limit) : rawRows).map(toFeedRow);
    return { rows, hasMore };
  }

  setRead(id: number, read: boolean): FeedRow {
    const db = getDb();
    const readAt = read ? Date.now() : null;
    db.query("UPDATE notification_feed SET read_at = ? WHERE id = ?").run(readAt, id);

    const row = db
      .query(
        `SELECT id, kind, project, session_id, schedule_id, title, body, created_at, read_at
         FROM notification_feed
         WHERE id = ?`,
      )
      .get(id) as RawFeedRow | null;
    if (!row) throw new FeedNotFoundError(id);

    emitFeedChanged();
    return toFeedRow(row);
  }

  markSessionRead(sessionId: string): void {
    if (!sessionId) return;
    const db = getDb();
    const res = db
      .query("UPDATE notification_feed SET read_at = ? WHERE session_id = ? AND read_at IS NULL")
      .run(Date.now(), sessionId);
    if (res.changes > 0) {
      emitFeedChanged();
    }
  }

  readAll(): void {
    const db = getDb();
    db.query("UPDATE notification_feed SET read_at = ? WHERE read_at IS NULL").run(Date.now());
    emitFeedChanged();
  }

  prune(now = Date.now()): void {
    const db = getDb();
    db.query("DELETE FROM notification_feed WHERE created_at < ?").run(now - FEED_RETENTION_MS);
    db.query(
      `DELETE FROM notification_feed
       WHERE id NOT IN (
         SELECT id FROM notification_feed
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )`,
    ).run(MAX_FEED_ROWS);
  }
}

export const notificationFeedService = new NotificationFeedService();

export function record(e: RecordFeedInput): FeedRow {
  return notificationFeedService.record(e);
}

export function list(opts?: FeedListOptions): FeedListResult {
  return notificationFeedService.list(opts);
}

export function setRead(id: number, read: boolean): FeedRow {
  return notificationFeedService.setRead(id, read);
}

export function markSessionRead(sessionId: string): void {
  notificationFeedService.markSessionRead(sessionId);
}

export function readAll(): void {
  notificationFeedService.readAll();
}

export function prune(now?: number): void {
  notificationFeedService.prune(now);
}
