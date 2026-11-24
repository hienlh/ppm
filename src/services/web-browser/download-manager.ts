/**
 * Files pages download land in the browser's own folder on the host, never anywhere a page
 * names, and reach the viewer's device only through a one-use ticket.
 *
 * The ticket exists because a plain link cannot carry PPM's Authorization header. The response
 * is always `application/octet-stream`, `nosniff` and `CSP: sandbox`, because some browsers
 * (iOS Safari) ignore `download` and would otherwise render a downloaded HTML or SVG page on
 * PPM's own origin, beside the token in localStorage.
 */
import { randomUUIDv7 } from "bun";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CdpConnection } from "./cdp-connection.ts";
import { webBrowserPaths } from "./chrome-launch-args.ts";

export interface DownloadRecord {
  id: string;
  name: string;
  sizeBytes: number | null;
  receivedBytes: number;
  state: "progress" | "done" | "canceled";
}

const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
const KEEP_MS = 24 * 3600_000;
const TICKET_TTL_MS = 60_000;
export const DOWNLOAD_TICKET_PREFIX = "/api/web-browser/download/";

const records = new Map<string, DownloadRecord>();
const tickets = new Map<string, { id: string; at: number }>();

/** Called once per Chrome start. `onChange` reports each record as it moves. */
export async function trackDownloads(cdp: CdpConnection, onChange: (r: DownloadRecord) => void): Promise<() => void> {
  const dir = webBrowserPaths.downloads();
  mkdirSync(dir, { recursive: true });
  pruneOldDownloads();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true }).catch(() => {});
  return cdp.onEvent((e) => {
    const p = e.params as Record<string, any>;
    if (e.method === "Browser.downloadWillBegin") {
      const r: DownloadRecord = { id: String(p.guid), name: String(p.suggestedFilename || "download").slice(0, 255), sizeBytes: null, receivedBytes: 0, state: "progress" };
      records.set(r.id, r);
      onChange(r);
    } else if (e.method === "Browser.downloadProgress") {
      const r = records.get(String(p.guid));
      if (!r) return;
      r.receivedBytes = Number(p.receivedBytes) || 0;
      r.sizeBytes = Number(p.totalBytes) || r.sizeBytes;
      if (p.state === "completed") r.state = "done";
      if (p.state === "canceled") r.state = "canceled";
      if (r.state === "progress" && totalBytes() > MAX_TOTAL_BYTES) {
        void cdp.send("Browser.cancelDownload", { guid: r.id }).catch(() => {});
        r.state = "canceled";
      }
      onChange(r);
    }
  });
}

function totalBytes(): number {
  let sum = 0;
  for (const r of records.values()) sum += r.receivedBytes;
  return sum;
}

export function listDownloads(): DownloadRecord[] {
  return [...records.values()];
}

/** Drops files older than a day (and their records). */
export function pruneOldDownloads(now = Date.now()): void {
  const dir = webBrowserPaths.downloads();
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    try {
      if (now - statSync(join(dir, name)).mtimeMs > KEEP_MS) {
        rmSync(join(dir, name), { force: true });
        records.delete(name);
      }
    } catch {}
  }
}

/** A one-use link for a finished download, or null when there is no such file. */
export function mintDownloadTicket(id: string): string | null {
  const r = records.get(id);
  if (!r || r.state !== "done") return null;
  const now = Date.now();
  for (const [t, v] of tickets) if (now - v.at > TICKET_TTL_MS) tickets.delete(t);
  const ticket = randomUUIDv7();
  tickets.set(ticket, { id, at: now });
  return ticket;
}

/** For the auth middleware: does this path segment name a live ticket? (Not spent here.) */
export function isDownloadTicket(ticket: string): boolean {
  const t = tickets.get(ticket);
  return !!t && Date.now() - t.at <= TICKET_TTL_MS;
}

/** Spends a ticket and returns the file to send, or null. */
export function spendDownloadTicket(ticket: string): { path: string; name: string } | null {
  const t = tickets.get(ticket);
  tickets.delete(ticket);
  if (!t || Date.now() - t.at > TICKET_TTL_MS) return null;
  const r = records.get(t.id);
  if (!r || r.state !== "done") return null;
  // `allowAndName` stores the file under its download GUID, inside the browser's own folder.
  return { path: join(webBrowserPaths.downloads(), r.id), name: r.name };
}

/** RFC 5987 attachment header for any file name. */
export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function clearDownloadRecords(): void {
  records.clear();
  tickets.clear();
}
