/**
 * The download half of DBGate's Export ▸. `POST /connections/:id/grid/export` (database-grid.ts)
 * starts the read and answers with a ticket; `GET /api/db/grid-export/:ticket` is the file, written
 * as the rows come off the database and sent as fast as the browser takes it — the read waits
 * while it does not. The export is audited once its download has ended, however it ended.
 */
import { Hono } from "hono";
import type { GridExportFormat } from "../../shared/db-grid-export.ts";
import { toJsonValue } from "../../services/database/db-values.ts";
import { exportFile, type ExportTarget } from "../../services/database/grid-export.ts";
import { claimExportTicket, issueExportTicket } from "../../services/database/grid-export-tickets.ts";
import type { GridExport } from "../../services/database/grid.service.ts";
import { EDGE_ROWS, MAX_RESULT_BYTES } from "../../services/query-audit/result-truncate.ts";
import { attachmentDisposition } from "../../services/fs-ops/fs-content-disposition.ts";
import { err } from "../../types/api.ts";
import { logQueryAs, type AuditCaller, type AuditFields } from "./query-audit-hook.ts";
import { holdRequestOpen } from "./database-route-helpers.ts";

/** Seconds the download may go without sending a byte: the database can take that long to find the next rows. */
const DOWNLOAD_IDLE_SECONDS = 300;

/** Bytes the response holds ready before it stops asking the read for more. */
const RESPONSE_BUFFER_BYTES = 1024 * 1024;

export const CONTENT_TYPES: Record<GridExportFormat, string> = {
  json: "application/json; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
  sql: "application/sql; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  csvSemicolon: "text/csv; charset=utf-8",
  csvExcel: "text/csv; charset=utf-16le",
  tsv: "text/tab-separated-values; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml; charset=utf-8",
};

/**
 * Exports open at once — waiting for their download or downloading. Each holds a connection to the
 * database of its own and a batch of rows, so a script starting exports in a loop cannot use up the
 * database's connections or PPM's memory.
 */
export const MAX_OPEN_EXPORTS = 8;

let openExports = 0;

export class TooManyExportsError extends Error {
  constructor() {
    super(`${MAX_OPEN_EXPORTS} exports are already running. Export again once one has finished.`);
  }
}

/** Take one of the export slots, or throw `TooManyExportsError`; the function returned gives it back, once. */
export function reserveExportSlot(): () => void {
  if (openExports >= MAX_OPEN_EXPORTS) throw new TooManyExportsError();
  openExports++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openExports--;
  };
}

/** A value as the audit log stores it. A string longer than the whole sample may be is cut, losing nothing stored. */
function sampleValue(value: unknown): unknown {
  const json = toJsonValue(value);
  return typeof json === "string" && json.length > MAX_RESULT_BYTES ? json.slice(0, MAX_RESULT_BYTES) : json;
}

/** The first and last few rows of an export, which its audit entry keeps as every audited read does. */
export class RowSample {
  private head: Record<string, unknown>[] = [];
  private tail: unknown[][] = [];

  constructor(private readonly columns: readonly string[]) {}

  add(batch: readonly unknown[][]): void {
    for (const row of batch) {
      // One past the edge, so the stored sample says rows were left out between head and tail.
      if (this.head.length <= EDGE_ROWS) this.head.push(this.record(row));
      else {
        this.tail.push(row);
        if (this.tail.length > EDGE_ROWS) this.tail.shift();
      }
    }
  }

  records(): Record<string, unknown>[] {
    return [...this.head, ...this.tail.map((row) => this.record(row))];
  }

  private record(row: readonly unknown[]): Record<string, unknown> {
    return Object.fromEntries(this.columns.map((c, i) => [c, sampleValue(row[i])]));
  }
}

export interface ExportAudit {
  caller: AuditCaller;
  fields: Omit<AuditFields, "sql" | "status">;
  startedAt: number;
}

/**
 * One value read whole — Save cell to file's — ticketed for its download, a slice at a time. Its
 * slot is given back once the bytes are sent, the download stopped, or nobody came for them.
 */
export function ticketCellDownload(bytes: Uint8Array, fileName: string, release: () => void): string {
  return issueExportTicket({
    fileName,
    contentType: "application/octet-stream",
    abandon: release,
    open: () => {
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.length) {
            controller.close();
            release();
            return;
          }
          controller.enqueue(bytes.subarray(at, at + RESPONSE_BUFFER_BYTES));
          at += RESPONSE_BUFFER_BYTES;
        },
        cancel: release,
      });
    },
  });
}

/**
 * The file of an opened export, ticketed for its download. `release` is called once the export has
 * ended — downloaded, failed, stopped, or never fetched.
 */
export function ticketGridExport(
  opened: GridExport, target: ExportTarget, fileName: string, audit: ExportAudit, release: () => void,
): string {
  let rows = 0;
  let ended = false;
  const sample = new RowSample(opened.columns.map((c) => c.name));
  const end = (error: string | null): void => {
    if (ended) return;
    ended = true;
    release();
    logQueryAs(audit.caller, {
      ...audit.fields,
      sql: opened.built.displaySql,
      status: error === null ? "ok" : "error",
      error,
      rows: sample.records(),
      rowCount: rows,
      durationMs: Date.now() - audit.startedAt,
    });
  };

  async function* counted(): AsyncGenerator<unknown[][]> {
    for await (const batch of opened.batches) {
      rows += batch.length;
      sample.add(batch);
      yield batch;
    }
  }

  return issueExportTicket({
    fileName,
    contentType: CONTENT_TYPES[target.format],
    abandon() {
      end("The download never started");
      opened.close().catch(() => {});
    },
    open() {
      const file = exportFile(target, opened.columns, counted());
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await file.next();
            if (next.done) {
              controller.close();
              end(null);
            } else controller.enqueue(next.value);
          } catch (e) {
            end((e as Error).message);
            controller.error(e);
          }
        },
        async cancel() {
          end(`The download was stopped after ${rows.toLocaleString("en-US")} rows`);
          await file.return(undefined);
        },
      }, { highWaterMark: RESPONSE_BUFFER_BYTES, size: (chunk) => chunk?.byteLength ?? 0 });
    },
  });
}

export const gridExportDownloadRoutes = new Hono();

/** GET /api/db/grid-export/:ticket — the file, once. The ticket stands in for the Authorization header a download cannot send. */
gridExportDownloadRoutes.get("/:ticket", (c) => {
  // Hono answers HEAD with the GET handler and throws its body away: that would spend the ticket
  // and leave the read open with nothing to take its rows.
  if (c.req.method !== "GET") return c.json(err("Download the export with GET"), 405, { Allow: "GET" });
  const download = claimExportTicket(c.req.param("ticket"));
  if (!download) return c.json(err("This export has been downloaded already, or waited too long. Export again."), 404);
  holdRequestOpen(c, DOWNLOAD_IDLE_SECONDS);
  return new Response(download.open(), {
    headers: {
      "Content-Type": download.contentType,
      "Content-Disposition": attachmentDisposition(download.fileName),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
