/**
 * Export advanced's job: the tables of one schema, or one query, read a row at a time in the order
 * given and written by Export ▸'s writers into files in the job's folder — never a table held
 * whole. The first row that fails ends the job, and the rows after it stay Queued, as DBGate's do;
 * Stop cancels the statement running on the database and removes the file it was writing.
 *
 * The files are kept under names of the server's own (`0`, `1`…, `zip`): the name a row gives is
 * only what its file downloads as, and what the zip calls it.
 */
import { join } from "node:path";
import { XLSX_SINGLE_FILE_NAME, impExpFileFormat } from "../../../shared/db-impexp.ts";
import type { SqlDialect } from "../dialect.ts";
import { classifyColumnType, dialectFor } from "../dialects.ts";
import { EXPORT_BATCH_LIMITS, type BatchLimits } from "../export-batch.ts";
import { exportFile, type ExportColumn, type ExportTarget } from "../grid-export.ts";
import { xlsxWorkbook, type XlsxSheetSource } from "../grid-export-xlsx.ts";
import { buildExportSelect } from "../grid-query-builder.ts";
import { loadGridTable, type GridTarget } from "../grid.service.ts";
import { isIdentity, mapColumns, pickRow, uniqueColumnNames } from "./column-map.ts";
import { createLogger } from "../../logger.ts";
import { removePath, writeChunks } from "./impexp-files.ts";
import { addMessage, finishJob, loggableError, type ImpExpJob } from "./impexp-job-store.ts";
import type { ExportItemPlan, ExportJobPlan } from "./impexp-request.ts";
import { zipFiles } from "./zip-output.ts";

/** One row's audit entry, written once its read has ended — every row has one, as every export has. */
export interface ExportItemAudit {
  /** Rows as they are written, under the names they are written with. */
  rows(columns: readonly string[], batch: readonly unknown[][]): void;
  /** `error` is null when the rows were written whole. */
  ended(sql: string, error: string | null, rowCount: number): void;
}

export interface ExportJobContext {
  target: GridTarget;
  /** Starts the audit entry of a row about to be read. */
  auditItem(item: ExportItemPlan): ExportItemAudit;
  limits?: BatchLimits;
}

const log = createLogger("impexp");

/** What Create single file's one sheet a file is called, as DBGate names it. */
const SINGLE_SHEET = "Sheet 1";

/** One row's read, opened: its first rows are read, so a statement the database refuses fails here. */
interface OpenedRead {
  /** The columns as they are written: Configure columns applied. */
  columns: ExportColumn[];
  /** The rows as they are written, counted into the row's status. Ending them early ends the read. */
  batches: AsyncGenerator<unknown[][]>;
  /** Ends the read, iterated or not. */
  close(): Promise<void>;
}

/** The progress of one row, and what its audit entry will say. */
class ItemRun {
  /** The statement the row reads with; what it was going to run, until it is built. */
  sql: string;
  readonly audit: ExportItemAudit;
  private ended = false;

  constructor(readonly job: ImpExpJob, readonly index: number, readonly item: ExportItemPlan, ctx: ExportJobContext) {
    const d = dialectFor(ctx.target.type);
    this.sql = item.read.type === "table" ? `SELECT * FROM ${d.qualify(item.read.table, item.read.schema)}` : item.read.sql;
    this.audit = ctx.auditItem(item);
    this.status.state = "running";
  }

  get status() {
    return this.job.items[this.index]!;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  done(): void {
    if (this.ended) return;
    this.ended = true;
    this.status.state = "done";
    this.status.rowsWritten = this.status.rowsRead;
    this.audit.ended(this.sql, null, this.status.rowsRead);
  }

  /** The row failed, or the job was stopped while it ran. */
  failed(e: unknown): void {
    if (this.ended) return;
    this.ended = true;
    const rows = this.status.rowsRead.toLocaleString("en-US");
    if (this.job.abort.signal.aborted) {
      this.status.state = "stopped";
      addMessage(this.job, "info", `${this.item.source}: stopped after ${rows} rows`);
      this.audit.ended(this.sql, `Stopped after ${rows} rows`, this.status.rowsRead);
      return;
    }
    const message = errorMessage(e);
    this.status.state = "error";
    this.status.error = message;
    addMessage(this.job, "error", `${this.item.source}: ${message}`);
    this.audit.ended(this.sql, message, this.status.rowsRead);
  }
}

function errorMessage(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)) || "The export failed";
}

/** Starts reading `run`'s row: its columns found, Configure columns applied, its first rows read. */
async function openRead(run: ItemRun, plan: ExportJobPlan, ctx: ExportJobContext): Promise<OpenedRead> {
  const { target } = ctx;
  const { item, job } = run;
  const signal = job.abort.signal;
  const limits = ctx.limits ?? EXPORT_BATCH_LIMITS;
  let described: ExportColumn[] | null = null;
  let source: AsyncGenerator<unknown[][]>;
  if (item.read.type === "table") {
    const { table, schema } = item.read;
    addMessage(job, "info", `Reading ${schema ? `${schema}.${table}` : table}`);
    const found = await loadGridTable(target, table, schema);
    const built = buildExportSelect(dialectFor(target.type), found.columns, {
      table, schema, filters: [], anyColumn: [], sort: [], columns: found.columns.map((c) => c.name), format: plan.format,
    });
    run.sql = built.displaySql;
    described = built.columns.map(({ name, kind }) => ({ name, kind }));
    source = target.adapter.streamRows(target.config, built, limits, { signal });
  } else {
    addMessage(job, "info", "Reading query");
    source = target.adapter.streamRows(target.config, { sql: item.read.sql, params: [] }, limits, {
      signal,
      onColumns: (columns) => {
        const names = uniqueColumnNames(columns.map((c) => c.name));
        described = columns.map((c, i) => ({ name: names[i]!, kind: classifyColumnType(target.type, c.type) }));
      },
    });
  }
  const close = async (): Promise<void> => { await source.return(undefined); };

  try {
    const first = await source.next();
    // Typed as it was before the read: TypeScript cannot see the callback that set it.
    const columns = described as ExportColumn[] | null;
    if (!columns) throw new Error("The statement gives no result to export");
    const mapped = mapColumns(columns.map((c) => c.name), item.columns, item.read.type === "table" ? `"${item.source}"` : "the query's result");
    const written = mapped.indexes.map((index, i) => ({ name: mapped.names[i]!, kind: columns[index]!.kind }));
    const identity = isIdentity(mapped, columns.length);
    const status = run.status;
    async function* batches(): AsyncGenerator<unknown[][]> {
      try {
        for (let next = first; !next.done; next = await source.next()) {
          const rows = identity ? next.value : next.value.map((row) => pickRow(row, mapped.indexes));
          status.rowsRead += rows.length;
          run.audit.rows(mapped.names, rows);
          yield rows;
        }
      } finally {
        await close();
      }
    }
    return { columns: written, batches: batches(), close };
  } catch (e) {
    await close().catch(() => {});
    throw e;
  }
}

/** Export ▸'s writer settings for `item`'s file. */
function exportTarget(plan: ExportJobPlan, item: ExportItemPlan, dialect: SqlDialect): ExportTarget {
  return {
    format: plan.format,
    dialect,
    table: plan.format === "xlsx" ? SINGLE_SHEET : sqlTable(plan, item),
    csv: plan.options.csv,
    json: plan.options.json,
    xml: plan.options.xml,
  };
}

/** The table a SQL file INSERTs into: the source table, or for a query the file's own name without its extension. */
function sqlTable(plan: ExportJobPlan, item: ExportItemPlan): string {
  if (item.read.type === "table") return item.read.table;
  const extension = `.${impExpFileFormat(plan.format).extension}`;
  return item.target.toLowerCase().endsWith(extension) && item.target.length > extension.length
    ? item.target.slice(0, -extension.length)
    : item.target;
}

/** Every row into a file of its own, one row at a time. */
async function exportFiles(job: ImpExpJob, plan: ExportJobPlan, ctx: ExportJobContext): Promise<void> {
  const dialect = dialectFor(ctx.target.type);
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i]!;
    const run = new ItemRun(job, i, item, ctx);
    const path = join(job.dir!, String(i));
    let read: OpenedRead | null = null;
    try {
      read = await openRead(run, plan, ctx);
      addMessage(job, "info", `Writing file ${item.target}`);
      const size = await writeChunks(path, exportFile(exportTarget(plan, item, dialect), read.columns, read.batches), job.abort.signal);
      job.files.push({ name: item.target, size, path, format: plan.format });
      run.done();
    } catch (e) {
      await read?.close().catch(() => {});
      await removePath(path);
      run.failed(e);
      throw e;
    }
  }
}

/** Create single file: one workbook, a sheet for each row, its tables read one after another. */
async function exportWorkbook(job: ImpExpJob, plan: ExportJobPlan, ctx: ExportJobContext): Promise<void> {
  const path = join(job.dir!, "0");
  let run: ItemRun | null = null;
  let read: OpenedRead | null = null;
  async function* sheets(): AsyncGenerator<XlsxSheetSource> {
    try {
      for (let i = 0; i < plan.items.length; i++) {
        const item = plan.items[i]!;
        run = new ItemRun(job, i, item, ctx);
        read = await openRead(run, plan, ctx);
        yield { name: item.target, columns: read.columns, batches: read.batches };
        // The workbook asks for the next table once this one's sheets are written whole.
        run.done();
      }
    } finally {
      await (read as OpenedRead | null)?.close().catch(() => {});
    }
  }
  try {
    addMessage(job, "info", `Writing file ${XLSX_SINGLE_FILE_NAME}`);
    const size = await writeChunks(path, xlsxWorkbook(sheets()), job.abort.signal);
    job.files.push({ name: XLSX_SINGLE_FILE_NAME, size, path, format: plan.format });
  } catch (e) {
    await removePath(path);
    const failing = run as ItemRun | null;
    if (failing && !failing.isEnded) failing.failed(e);
    else if (!job.abort.signal.aborted) addMessage(job, "error", `${XLSX_SINGLE_FILE_NAME}: ${errorMessage(e)}`);
    if (!job.abort.signal.aborted) addMessage(job, "warning", `${XLSX_SINGLE_FILE_NAME} was not kept: it would miss what failed`);
    throw e;
  }
}

/** Every file of the run into one zip, which replaces them. */
async function zipOutput(job: ImpExpJob, name: string): Promise<void> {
  const path = join(job.dir!, "zip");
  addMessage(job, "info", `Writing file ${name}`);
  try {
    const size = await writeChunks(path, zipFiles(job.files.map((f) => ({ path: f.path, name: f.name }))), job.abort.signal);
    const zipped = job.files.splice(0);
    job.files.push({ name, size, path, format: "zip" });
    await Promise.all(zipped.map((f) => removePath(f.path)));
    addMessage(job, "info", `ZIP file created (${size.toLocaleString("en-US")} total bytes)`);
  } catch (e) {
    await removePath(path);
    if (!job.abort.signal.aborted) addMessage(job, "error", `${name}: ${errorMessage(e)}`);
    throw e;
  }
}

/**
 * Run an export job to its end. Never throws: whatever goes wrong is the job's state, its rows'
 * and its messages, which the tab reads.
 */
export async function runExportJob(job: ImpExpJob, plan: ExportJobPlan, ctx: ExportJobContext): Promise<void> {
  try {
    if (plan.format === "xlsx" && plan.options.xlsxSingleFile) await exportWorkbook(job, plan, ctx);
    else await exportFiles(job, plan, ctx);
    if (plan.zip) await zipOutput(job, plan.zip);
    addMessage(job, "info", "Finished job");
    finishJob(job, "done");
  } catch (e) {
    if (!job.abort.signal.aborted) {
      // No row in Error means the zip or the single workbook is what failed.
      const i = job.items.findIndex((item) => item.state === "error");
      const where = i >= 0 ? `item ${i} '${job.items[i]!.source}'` : "writing its output file";
      log.error(`export job ${job.id} failed on ${where} (${ctx.target.type}): ${loggableError(e)}`);
    }
    finishJob(job, job.abort.signal.aborted ? "stopped" : "error");
  }
}
