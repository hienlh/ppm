/**
 * Save cell to file for a value the grid has only the start of: `/grid` sends bytes up to
 * `BINARY_PREVIEW_BYTES`, so a larger picture or file is read again here — its row found by the key
 * the grid read it with, the one value read whole, as the database holds it.
 */
import type { RowKey } from "../../shared/db-changeset.ts";
import { safeFileName } from "../../shared/db-grid-export.ts";
import { ChangesetBuilder } from "./changeset.ts";
import { describeChangesetTable } from "./changeset.service.ts";
import { dialectFor } from "./dialects.ts";
import { GridRequestError } from "./grid-query-builder.ts";
import type { GridTarget } from "./grid.service.ts";

export interface ValidGridCellRequest {
  table: string;
  schema: string | null;
  column: string;
  key: RowKey;
  fileName: string;
}

/** The longest name most file systems give a file. */
const MAX_FILE_NAME = 255;

/** The row the key named is gone. Maps to HTTP 404. */
export class GridCellGoneError extends Error {
  readonly status = 404;
}

/** The key names more than one row, or the cell no longer holds what can be saved. Maps to HTTP 409. */
export class GridCellConflictError extends Error {
  readonly status = 409;
}

function fail(message: string): never {
  throw new GridRequestError(message);
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function parseGridCellRequest(body: unknown, defaultSchema: string | null): ValidGridCellRequest {
  if (!isRecord(body)) fail("Request body must be an object");
  if (typeof body.table !== "string" || !body.table) fail("table is required");
  if (body.schema !== undefined && body.schema !== null && typeof body.schema !== "string") fail("schema must be text");
  if (typeof body.column !== "string" || !body.column) fail("column is required");
  if (!isRecord(body.key) || Object.keys(body.key).length === 0) fail("key must name the row");
  if (typeof body.fileName !== "string" || body.fileName.length > MAX_FILE_NAME) {
    fail(`fileName must be text of at most ${MAX_FILE_NAME} characters`);
  }
  return {
    table: body.table,
    schema: typeof body.schema === "string" && body.schema ? body.schema : defaultSchema,
    column: body.column,
    key: body.key,
    fileName: safeFileName(body.fileName, "cell.bin"),
  };
}

/** The cell's value whole: bytes as they are, text as UTF-8. */
export async function readGridCell(target: GridTarget, req: ValidGridCellRequest): Promise<Uint8Array> {
  const table = await describeChangesetTable(target, req.table, req.schema);
  const stmt = new ChangesetBuilder(dialectFor(target.type), table).selectCell(req.column, req.key);
  // Export's read: raw driver values — the grid's own would cut the bytes to their preview again.
  const source = target.adapter.streamRows(target.config, stmt, { rows: 2, bytes: Number.MAX_SAFE_INTEGER });
  const rows: unknown[][] = [];
  try {
    for await (const batch of source) {
      rows.push(...batch);
      if (rows.length > 1) break;
    }
  } finally {
    await source.return(undefined);
  }
  if (rows.length === 0) throw new GridCellGoneError("The row is no longer there: refresh the table to see it");
  if (rows.length > 1) throw new GridCellConflictError("More than one row has this key, so its cell cannot be told apart");
  const value = rows[0]![0];
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new GridCellConflictError("The cell no longer holds bytes or text: refresh the table to see what it holds");
}
