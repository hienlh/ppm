/**
 * DBGate's Import/Export tab, on the server:
 * - `POST /connections/:id/impexp/export[?database=]` starts an export job and answers its id;
 * - `PUT /impexp/uploads?name=` keeps the request's body as a file to import, answering its id;
 *   `POST /impexp/uploads/:id/preview` reads its first rows, `DELETE /impexp/uploads/:id` removes it;
 * - `POST /connections/:id/impexp/import[?database=]` starts an import job of uploaded files;
 * - `GET /impexp/jobs/:id[?since=n]` is how the job stands, with the messages from the n-th on;
 * - `POST /impexp/jobs/:id/stop` stops it;
 * - `POST /impexp/jobs/:id/download` answers a ticket for one of its files, which the browser then
 *   fetches as it does an export's (`GET /api/db/grid-export/:ticket`).
 * A job runs on after the request that started it — and the tab that sent it — have gone.
 */
import { Hono } from "hono";
import { READONLY_IMPORT } from "../../services/database/db-errors.ts";
import { dialectFor } from "../../services/database/dialects.ts";
import { issueExportTicket } from "../../services/database/grid-export-tickets.ts";
import { defaultSchemaFor } from "../../services/database/grid.service.ts";
import { isReadOnlyQuery } from "../../services/database/readonly-check.ts";
import { runExportJob, type ExportItemAudit } from "../../services/database/impexp/export-job-runner.ts";
import {
  TooManyJobsError, createJob, getJob, jobFile, jobStatus, stopJob, type ImpExpJob,
} from "../../services/database/impexp/impexp-job-store.ts";
import {
  ImpExpRequestError, parseExportJobRequest, parseImportJobRequest, parseImportPreviewRequest,
  type ExportItemPlan, type ExportJobPlan, type ImportItemPlan, type ImportJobPlan,
} from "../../services/database/impexp/impexp-request.ts";
import { ColumnMapError } from "../../services/database/impexp/column-map.ts";
import { UPLOAD_GONE, previewUpload, runImportJob, type ImportItemAudit } from "../../services/database/impexp/import-job-runner.ts";
import { UploadError, removeUpload, saveUpload, uploadName } from "../../services/database/impexp/import-uploads.ts";
import { CsvReadError } from "../../services/database/impexp/readers/csv-reader.ts";
import { FileTextError } from "../../services/database/impexp/readers/file-text.ts";
import { JsonReadError } from "../../services/database/impexp/readers/json-reader.ts";
import type { ImpExpJobStarted, ImpExpJobStatus, ImportPreview, ImportUpload } from "../../shared/db-impexp.ts";
import type { GridExportTicket } from "../../shared/db-grid-export.ts";
import { splitSqlStatements } from "../../shared/split-sql-statements.ts";
import { err, ok } from "../../types/api.ts";
import { CONTENT_TYPES, RowSample } from "./database-grid-export.ts";
import { connAudit, connTarget, databaseParam, holdRequestOpen, requestDatabase, resolveTargetConn } from "./database-route-helpers.ts";
import { auditCaller, logQuery, logQueryAs, type AuditFields } from "./query-audit-hook.ts";
import type { ConnectionRow } from "../../services/db.service.ts";

/** Mounted at `/connections`, behind the middleware that checks a connection's driver and login. */
export const databaseImpExpRoutes = new Hono();

/** Mounted at `/impexp`: a job is found by its id alone. */
export const impExpJobRoutes = new Hono();

export const READONLY_EXPORT_QUERY = "Connection is readonly — only SELECT queries allowed. Change this in PPM web UI.";

/**
 * Even on a connection that may write, Export runs a plain read: MariaDB writes `INTO OUTFILE` and
 * SQLite `VACUUM INTO` inside a READ ONLY transaction, which is all that stops other writes.
 */
export const EXPORT_QUERY_NOT_A_READ = "Export runs a query that only reads — SELECT, WITH, VALUES, SHOW — and never one that writes";

const JOB_GONE = "This job is gone: a job is kept for an hour after it ends, and not past a restart of PPM";

/**
 * A Query source is SQL somebody typed, so it gets `/query`'s first check, and must be one
 * statement — run without its terminator, as a cursor wants it. Answers the error response, or
 * null with the statement put in its place.
 */
function checkQuerySource(conn: ConnectionRow, plan: ExportJobPlan): { status: 400 | 403; message: string } | null {
  const item = plan.items[0];
  if (item?.read.type !== "query") return null;
  const dialect = dialectFor(conn.type).name;
  const statements = splitSqlStatements(item.read.sql, dialect);
  if (statements.length !== 1) return { status: 400, message: "Export runs one query: remove the statements after the first" };
  if (!isReadOnlyQuery(item.read.sql, dialect)) {
    return conn.readonly ? { status: 403, message: READONLY_EXPORT_QUERY } : { status: 400, message: EXPORT_QUERY_NOT_A_READ };
  }
  item.read.sql = statements[0]!;
  return null;
}

/** What each row's audit entry says about it, beside the statement. */
function itemParams(plan: ExportJobPlan, item: ExportItemPlan, job: ImpExpJob | null, database: { database?: string }): Record<string, unknown> {
  return {
    ...database,
    ...(job ? { job: job.id } : {}),
    format: plan.format,
    target: item.target,
    ...(item.read.type === "table" ? { table: item.read.table, schema: item.read.schema } : {}),
    ...(item.columns ? { columns: item.columns } : {}),
    ...(plan.zip ? { zip: plan.zip } : {}),
  };
}

/** POST /connections/:id/impexp/export — Run: the job starts reading, and its id comes back at once. */
databaseImpExpRoutes.post("/:id/impexp/export", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(err("Request body must be JSON"), 400); }
  let plan: ExportJobPlan;
  try {
    plan = parseExportJobRequest(body, defaultSchemaFor(conn.type));
  } catch (e) {
    if (e instanceof ImpExpRequestError) return c.json(err(e.message), 400);
    throw e;
  }

  const database = databaseParam(c);
  const base: Omit<AuditFields, "sql" | "status" | "params"> = { ...connAudit(conn), source: "export", operation: "select" };
  const refused = checkQuerySource(conn, plan);
  if (refused) {
    if (refused.status === 403) {
      const item = plan.items[0]!;
      logQuery(c, {
        ...base, params: itemParams(plan, item, null, database), sql: item.read.type === "query" ? item.read.sql : "",
        status: "blocked", error: refused.message, durationMs: Date.now() - startedAt,
      });
    }
    return c.json(err(refused.message), refused.status);
  }

  const target = connTarget(conn, requestDatabase(c));
  let job: ImpExpJob;
  try {
    job = await createJob("export", plan.items);
  } catch (e) {
    if (e instanceof TooManyJobsError) return c.json(err(e.message), 429);
    throw e;
  }

  const caller = auditCaller(c);
  const created = job;
  void runExportJob(job, plan, {
    target,
    auditItem(item): ExportItemAudit {
      const itemStartedAt = Date.now();
      let sample: RowSample | null = null;
      return {
        rows(columns, batch) {
          (sample ??= new RowSample(columns)).add(batch);
        },
        ended(sql, error, rowCount) {
          logQueryAs(caller, {
            ...base, params: itemParams(plan, item, created, database), sql, status: error === null ? "ok" : "error", error,
            rows: (sample as RowSample | null)?.records() ?? [], rowCount, durationMs: Date.now() - itemStartedAt,
          });
        },
      };
    },
  });
  return c.json(ok<ImpExpJobStarted>({ jobId: job.id }));
});

/** What each row's audit entry says about it, beside the statements it ran. */
function importParams(plan: ImportJobPlan, item: ImportItemPlan, job: ImpExpJob | null, database: { database?: string }): Record<string, unknown> {
  const file = uploadName(item.upload);
  return {
    ...database,
    ...(job ? { job: job.id } : {}),
    format: plan.format,
    ...(file === null ? {} : { file }),
    table: item.target,
    schema: plan.schema,
    action: item.action,
    ...(item.columns ? { columns: item.columns } : {}),
  };
}

/**
 * POST /connections/:id/impexp/import — Run: each uploaded file into its table, one after another;
 * the job's id comes back at once. A readonly connection is refused before anything is read.
 */
databaseImpExpRoutes.post("/:id/impexp/import", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(err("Request body must be JSON"), 400); }
  let plan: ImportJobPlan;
  try {
    plan = parseImportJobRequest(body, conn.type, defaultSchemaFor(conn.type));
  } catch (e) {
    if (e instanceof ImpExpRequestError) return c.json(err(e.message), 400);
    throw e;
  }

  const database = databaseParam(c);
  const base: Omit<AuditFields, "sql" | "status" | "params"> = { ...connAudit(conn), source: "import", operation: "insert" };
  if (conn.readonly) {
    const d = dialectFor(conn.type);
    for (const item of plan.items) {
      const table = d.name === "sqlite" ? d.quoteIdent(item.target) : d.qualify(item.target, plan.schema);
      logQuery(c, {
        ...base, params: importParams(plan, item, null, database), sql: `INSERT INTO ${table}`,
        status: "blocked", error: READONLY_IMPORT, durationMs: Date.now() - startedAt,
      });
    }
    return c.json(err(READONLY_IMPORT), 403);
  }

  const target = connTarget(conn, requestDatabase(c));
  let job: ImpExpJob;
  try {
    job = await createJob("import", plan.items.map((i) => ({ source: i.source, target: i.target })));
  } catch (e) {
    if (e instanceof TooManyJobsError) return c.json(err(e.message), 429);
    throw e;
  }

  const caller = auditCaller(c);
  const created = job;
  void runImportJob(job, plan, {
    target,
    auditItem(item): ImportItemAudit {
      const itemStartedAt = Date.now();
      // Taken now: a file removed while it is read is gone from the uploads by the time the row ends.
      const params = importParams(plan, item, created, database);
      return {
        ended(sql, error, rowCount) {
          logQueryAs(caller, {
            ...base, params, sql, status: error === null ? "ok" : "error", error, rowCount, durationMs: Date.now() - itemStartedAt,
          });
        },
      };
    },
  });
  return c.json(ok<ImpExpJobStarted>({ jobId: job.id }));
});

/** A request body's pieces as they arrive; one left unread is cancelled, so no more of it is taken in. */
async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { done = true; return; }
      yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
  }
}

/** PUT /impexp/uploads?name= — the body is the file, written to disk as it arrives and never held whole. */
impExpJobRoutes.put("/uploads", async (c) => {
  const body = c.req.raw.body;
  try {
    return c.json(ok<ImportUpload>(await saveUpload(c.req.query("name") ?? "", body && bodyChunks(body), c.req.raw.signal)));
  } catch (e) {
    if (e instanceof UploadError) return c.json(err(e.message), e.status);
    if (c.req.raw.signal.aborted) return c.json(err("The upload was cancelled"), 400);
    throw e;
  }
});

/** A file the reader cannot read as asked: said in the Preview pane, as the job would say it. */
function isReadError(e: unknown): e is Error {
  return e instanceof CsvReadError || e instanceof JsonReadError || e instanceof FileTextError || e instanceof ColumnMapError;
}

/** POST /impexp/uploads/:id/preview `{ format, options, columns? }` — the first 100 rows as Import would write them. */
impExpJobRoutes.post("/uploads/:id/preview", async (c) => {
  let request: ReturnType<typeof parseImportPreviewRequest>;
  try {
    request = parseImportPreviewRequest(await c.req.json());
  } catch (e) {
    if (e instanceof ImpExpRequestError) return c.json(err(e.message), 400);
    if (e instanceof SyntaxError) return c.json(err("Request body must be JSON"), 400);
    throw e;
  }
  const id = c.req.param("id");
  // Finding the rows may take reading most of a file whose rows are under a key at its end.
  holdRequestOpen(c, 0);
  try {
    const preview = await previewUpload(id, request.format, request.options, request.columns, c.req.raw.signal);
    if (!preview) return c.json(err(UPLOAD_GONE), 404);
    return c.json(ok<ImportPreview>(preview));
  } catch (e) {
    if (isReadError(e)) return c.json(err(e.message), 400);
    throw e;
  }
});

/** DELETE /impexp/uploads/:id — the row's trash can; a job reading the file reads on to its end. */
impExpJobRoutes.delete("/uploads/:id", async (c) => {
  await removeUpload(c.req.param("id"));
  return c.json(ok(null));
});

/** GET /impexp/jobs/:id[?since=n] — the job's rows, its messages from the n-th on, and its files. */
impExpJobRoutes.get("/jobs/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json(err(JOB_GONE), 404);
  return c.json(ok<ImpExpJobStatus>(jobStatus(job, Number(c.req.query("since") ?? 0))));
});

/** POST /impexp/jobs/:id/stop — Stop: the statement running is cancelled; a job already ended is left as it is. */
impExpJobRoutes.post("/jobs/:id/stop", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json(err(JOB_GONE), 404);
  stopJob(job);
  return c.json(ok<ImpExpJobStatus>(jobStatus(job)));
});

/** POST /impexp/jobs/:id/download `{ name }` — a ticket for one of the job's files, which is then fetched with it. */
impExpJobRoutes.post("/jobs/:id/download", async (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json(err(JOB_GONE), 404);
  let name: unknown;
  try { name = ((await c.req.json()) as { name?: unknown } | null)?.name; } catch { return c.json(err("Request body must be JSON"), 400); }
  const file = typeof name === "string" ? jobFile(job, name) : null;
  if (!file) return c.json(err("This job wrote no such file"), 404);
  const ticket = issueExportTicket({
    fileName: file.name,
    contentType: file.format === "zip" ? "application/zip" : CONTENT_TYPES[file.format],
    open: () => Bun.file(file.path).stream(),
    abandon: () => {},
  });
  return c.json(ok<GridExportTicket>({ ticket, fileName: file.name }));
});
