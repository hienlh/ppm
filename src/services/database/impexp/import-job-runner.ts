/**
 * Import's job: uploaded files into tables of one database, one file after another, each in one
 * transaction — a file that fails leaves its table as it found it, rather than DBGate's half
 * written table that an Append run again would double. MySQL commits DDL by itself, so there the
 * table a row created, dropped or emptied stays so, and the messages say it. The first file that
 * fails ends the job, and the rows after it stay Queued; Stop cancels the statement running and
 * rolls back the file being written, while the files done before it stay.
 */
import { IMPORT_PREVIEW_ROWS, type ColumnMapEntry, type ImportFileFormat, type ImportFormatOptions, type ImportPreview } from "../../../shared/db-impexp.ts";
import type { DbWriteSession } from "../../../types/database.ts";
import type { TableRef } from "../ddl/ddl-objects.ts";
import type { GridTarget } from "../grid.service.ts";
import { mapColumns, pickRow } from "./column-map.ts";
import { addMessage, finishJob, type ImpExpJob } from "./impexp-job-store.ts";
import type { ImportItemPlan, ImportJobPlan } from "./impexp-request.ts";
import { holdUpload, type HeldUpload } from "./import-uploads.ts";
import { ImportRowWriter, planImportTable } from "./import-table-writer.ts";
import { openCsv } from "./readers/csv-reader.ts";
import { previewValue, type FileRows, type FileValue } from "./readers/file-rows.ts";
import { openJson, openJsonLines } from "./readers/json-reader.ts";

/** What an upload that is no longer kept answers. */
export const UPLOAD_GONE = "The uploaded file is gone. Add it again.";

/** One row's audit entry, written once its table is committed or rolled back. */
export interface ImportItemAudit {
  /** `error` is null when the file was written whole. */
  ended(sql: string, error: string | null, rowCount: number): void;
}

export interface ImportJobContext {
  target: GridTarget;
  /** Starts the audit entry of a row about to be imported. */
  auditItem(item: ImportItemPlan): ImportItemAudit;
}

/** An uploaded file opened by the reader its format takes: its first rows are read, so a file of another shape fails here. */
export function openImportFile(path: string, format: ImportFileFormat, options: ImportFormatOptions, signal?: AbortSignal): Promise<FileRows> {
  switch (format) {
    case "csv": return openCsv(path, options.csv, signal);
    case "json": return openJson(path, options.json, signal);
    case "jsonl": return openJsonLines(path, signal);
  }
}

/**
 * Preview: the first 100 rows of an upload as Import reads them, Configure columns applied, and
 * what reading them left out. Null when the upload is gone. `signal` stops the read — a JSON
 * file whose rows are under a key at its end is read through to find them.
 */
export async function previewUpload(
  id: string, format: ImportFileFormat, options: ImportFormatOptions, columns?: ColumnMapEntry[], signal?: AbortSignal,
): Promise<ImportPreview | null> {
  const upload = holdUpload(id);
  if (!upload) return null;
  let file: FileRows | null = null;
  try {
    file = await openImportFile(upload.path, format, options, signal);
    const mapped = mapColumns(file.columns, columns, `"${upload.name}"`);
    const rows: unknown[][] = [];
    for await (const batch of file.batches) {
      for (const row of batch) {
        rows.push(pickRow(row, mapped.indexes).map((v) => previewValue(v as FileValue)));
        if (rows.length >= IMPORT_PREVIEW_ROWS) break;
      }
      if (rows.length >= IMPORT_PREVIEW_ROWS) break;
    }
    return { columns: mapped.names, rows, warnings: file.warnings() };
  } finally {
    await file?.close().catch(() => {});
    upload.release();
  }
}

const tableLabel = (t: TableRef): string => (t.schema ? `${t.schema}.${t.name}` : t.name);

function errorMessage(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)) || "The import failed";
}

/** One file into its table. Throws once the row has ended in Error or Stopped. */
async function importItem(job: ImpExpJob, index: number, plan: ImportJobPlan, ctx: ImportJobContext): Promise<void> {
  const item = plan.items[index]!;
  const status = job.items[index]!;
  const { type, adapter, config } = ctx.target;
  const signal = job.abort.signal;
  const table: TableRef = { schema: plan.schema, name: item.target };
  const label = tableLabel(table);
  const audit = ctx.auditItem(item);
  status.state = "running";

  let sql = `INSERT INTO ${label}`;
  let upload: HeldUpload | null = null;
  let file: FileRows | null = null;
  let session: DbWriteSession | null = null;
  let committedDdl = false;
  const stop = (): void => session?.cancel();
  signal.addEventListener("abort", stop);
  try {
    upload = holdUpload(item.upload);
    if (!upload) throw new Error(UPLOAD_GONE);
    addMessage(job, "info", `Reading file ${item.source}`);
    file = await openImportFile(upload.path, plan.format, plan.options, signal);
    if (!file.columns.length) throw new Error("The file has no columns to import");
    const mapped = mapColumns(file.columns, item.columns, `"${item.source}"`);
    const structure = await adapter.getStructure(config, item.target, plan.schema ?? undefined);
    const tablePlan = planImportTable(type, item.action, table, structure, mapped);
    for (const warning of tablePlan.warnings) addMessage(job, "warning", `${item.source}: ${warning}`);

    signal.throwIfAborted();
    session = await adapter.openWriteSession(config);
    signal.throwIfAborted();
    for (const step of tablePlan.steps) addMessage(job, "info", step);
    for (const ddl of tablePlan.ddl) {
      await session.ddl(ddl);
      if (type === "mysql" || type === "mariadb") committedDdl = true;
    }
    if (committedDdl) addMessage(job, "warning", `${item.source}: ${type === "mysql" ? "MySQL" : "MariaDB"} commits table changes at once, so "${tablePlan.steps.join("; ")}" is kept even if writing the rows fails`);

    const writer = new ImportRowWriter(session, type, table, tablePlan.columns, plan.format !== "csv");
    sql = [...tablePlan.ddl, writer.template].join(";\n");
    addMessage(job, "info", `Writing rows to ${label}`);
    for await (const rows of file.batches) {
      signal.throwIfAborted();
      status.rowsRead += rows.length;
      await writer.write(rows);
      status.rowsWritten = writer.written;
    }
    await writer.flush();
    signal.throwIfAborted();
    await session.commit();
    status.rowsWritten = writer.written;
    status.state = "done";
    for (const warning of file.warnings()) addMessage(job, "warning", `${item.source}: ${warning}`);
    addMessage(job, "info", `${item.source}: ${writer.written.toLocaleString("en-US")} rows written to ${label}`);
    audit.ended(sql, null, writer.written);
  } catch (e) {
    // Nothing of this file is kept: the transaction is rolled back when the session closes.
    status.rowsWritten = 0;
    const kept = committedDdl ? ` (the table change ${type === "mysql" ? "MySQL" : "MariaDB"} committed stays)` : "";
    if (signal.aborted) {
      status.state = "stopped";
      addMessage(job, "info", `${item.source}: stopped after ${status.rowsRead.toLocaleString("en-US")} rows; none of them were kept${kept}`);
      audit.ended(sql, `Stopped after ${status.rowsRead.toLocaleString("en-US")} rows`, 0);
    } else {
      const message = errorMessage(e);
      status.state = "error";
      status.error = message;
      addMessage(job, "error", `${item.source}: ${message}`);
      if (session) addMessage(job, "info", `${item.source}: rolled back, ${label} holds none of the file's rows${kept}`);
      audit.ended(sql, message, 0);
    }
    throw e;
  } finally {
    signal.removeEventListener("abort", stop);
    await session?.close().catch(() => {});
    await file?.close().catch(() => {});
    upload?.release();
  }
}

/**
 * Run an import job to its end. Never throws: whatever goes wrong is the job's state, its rows'
 * and its messages, which the tab reads.
 */
export async function runImportJob(job: ImpExpJob, plan: ImportJobPlan, ctx: ImportJobContext): Promise<void> {
  try {
    for (let i = 0; i < plan.items.length; i++) await importItem(job, i, plan, ctx);
    addMessage(job, "info", "Finished job");
    finishJob(job, "done");
  } catch {
    finishJob(job, job.abort.signal.aborted ? "stopped" : "error");
  }
}
