/**
 * The tickets an export's download is fetched by. A browser saves a file to disk only when it
 * fetches it by navigating — a hidden `<a download>` — which cannot send the Authorization header,
 * and reading it with `fetch` instead would hold the whole file in the page. So the export's own
 * request, authenticated, answers with a ticket, and `GET /api/db/grid-export/<ticket>` takes it in
 * place of the header: once, and only within `GRID_EXPORT_TICKET_TTL_MS`.
 *
 * A ticket holds an export already reading — a connection of its own, its first rows — so one
 * nobody comes for is let go when it expires. How many may be open at once is the route's to
 * decide, as it is what opens them.
 */
import { randomBytes } from "node:crypto";
import { GRID_EXPORT_TICKET_TTL_MS } from "../../shared/db-grid-export.ts";

export interface ExportDownload {
  fileName: string;
  contentType: string;
  /** The file, read from the database as it is sent. */
  open(): ReadableStream<Uint8Array>;
  /** Lets go of the rows and the connection, when the download never starts. */
  abandon(): void;
}

/** 32 random bytes, as base64url. */
const TICKET = /^[A-Za-z0-9_-]{43}$/;

const waiting = new Map<string, { download: ExportDownload; timer: ReturnType<typeof setTimeout> }>();

/** A ticket for `download`, abandoned unless it is claimed within `ttlMs`. */
export function issueExportTicket(download: ExportDownload, ttlMs = GRID_EXPORT_TICKET_TTL_MS): string {
  const ticket = randomBytes(32).toString("base64url");
  const timer = setTimeout(() => {
    if (waiting.delete(ticket)) download.abandon();
  }, ttlMs);
  timer.unref?.();
  waiting.set(ticket, { download, timer });
  return ticket;
}

/** Whether `ticket` would be claimed now — what the auth middleware asks, without spending it. */
export function isExportTicket(ticket: string | undefined): boolean {
  return !!ticket && TICKET.test(ticket) && waiting.has(ticket);
}

/** The download `ticket` was issued for, once: null for one spent, expired or never issued. */
export function claimExportTicket(ticket: string): ExportDownload | null {
  const entry = TICKET.test(ticket) ? waiting.get(ticket) : undefined;
  if (!entry) return null;
  waiting.delete(ticket);
  clearTimeout(entry.timer);
  return entry.download;
}

/** Let go of every waiting export (shutdown, tests). */
export function abandonAllExportTickets(): void {
  for (const [ticket, { download, timer }] of waiting) {
    waiting.delete(ticket);
    clearTimeout(timer);
    download.abandon();
  }
}
