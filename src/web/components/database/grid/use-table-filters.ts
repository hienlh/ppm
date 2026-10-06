/**
 * A table view's filters and the requests they make. A filter cell commits its text on Enter or
 * when focus leaves it, and a request goes out only when what the filters ask for has changed —
 * so a text that does not read, which asks for nothing, sends nothing, and neither does typing.
 * When the server refuses the filters, the cells to blame show its reason.
 *
 * A tab can open on filters it kept (`initial`). The table's first fetch asks for them itself
 * (`opening`), so the rows shown first are already filtered. If the server refuses them, the cells
 * to blame say why and no rows are shown until the filters change — rows read without them would
 * sit under filters that look applied.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import type { FilterableColumn } from "../../../../shared/db-filter-parser";
import { NO_FILTERS, filterRequest, type FilterRequest, type GridFilters } from "./grid-filters";

const NOTHING: FilterRequest = filterRequest(NO_FILTERS, []);

export function useTableFilters(
  columns: readonly FilterableColumn[],
  apply: (request: FilterRequest) => Promise<Error | null>,
  initial: GridFilters = NO_FILTERS,
) {
  const [filters, setFilters] = useState<GridFilters>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // What the rows on screen were read with; null until the columns are known. The table's first
  // fetch asked for the kept filters only if it could read the columns first (`opening`); if not,
  // its rows are unfiltered and the filters go out as soon as the columns are known.
  const sent = useRef<string | null>(null);
  const opened = useRef<FilterRequest | null>(null);
  // The caller's `apply` changes with every fetch it makes; only the filters should send one.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const initialRef = useRef(initial);

  const refused = useCallback((request: FilterRequest, e: Error) => {
    const blamed = refusedFilters(request, e);
    if (blamed) setErrors(blamed);
    else toast.error("Could not filter the rows", { description: e.message });
  }, []);

  useEffect(() => {
    // The columns' types say how a text reads; until they are known nothing can be sent.
    if (columns.length === 0) return;
    const request = filterRequest(filters, columns);
    const key = JSON.stringify(request);
    sent.current ??= JSON.stringify(opened.current ?? NOTHING);
    if (key === sent.current) return;
    sent.current = key;
    setErrors({});
    void applyRef.current(request).then((e) => {
      if (e && sent.current === key) refused(request, e);
    });
  }, [filters, columns, refused]);

  /** What the table's first fetch asks for, read in its columns. */
  const opening = useCallback((tableColumns: readonly FilterableColumn[]) => {
    opened.current = filterRequest(initialRef.current, tableColumns);
    return opened.current;
  }, []);

  /** The first fetch failed: the cells to blame for it say why. Any other failure is the table's own to show. */
  const openFailed = useCallback((e: Error) => {
    const blamed = opened.current && refusedFilters(opened.current, e);
    if (blamed) setErrors(blamed);
  }, []);

  return { filters, setFilters, errors, opening, openFailed };
}

/**
 * The filter cells a failed request is shown on, with the server's reason; null when the failure
 * is not one a filter explains. A database error can only come from SQL the user wrote — PPM
 * builds the rest — so it is put on the SQL conditions. A refusal of the request itself (400, or
 * 403 for a write on a readonly connection) is put on them too, or on every filtered column when
 * there are none.
 */
export function refusedFilters(request: FilterRequest, error: Error): Record<string, string> | null {
  if (!(error instanceof ApiError) || error.status === 404 || error.status === 428) return null;
  const own = request.filters.filter((g) => g.anyOf.some((and) => and.some((c) => c.op === "rawSql")));
  const blamed = own.length > 0 ? own : error.status === 400 || error.status === 403 ? request.filters : [];
  return blamed.length > 0 ? Object.fromEntries(blamed.map((g) => [g.column, error.message])) : null;
}
