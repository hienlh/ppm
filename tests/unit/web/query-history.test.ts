/**
 * The History panel's words and requests: one page of the audit log at a time, from the tab's own
 * target, a later page added after the list without repeating what runs since pushed down into it,
 * and each entry described by what it was — when, where, how many rows, how long.
 */
import { describe, expect, it } from "bun:test";
import {
  HISTORY_STATUS_LABEL, historyHasMore, historyMeta, historyUrl, mergeHistoryPage, retentionNote,
} from "../../../src/web/components/database/query/query-history";
import { QUERY_HISTORY_PAGE, type QueryHistoryItem } from "../../../src/shared/db-query-script";
import type { DbTarget } from "../../../src/web/lib/db-tabs";

const conn: DbTarget = { kind: "connection", connectionId: 5 };
const now = Date.parse("2026-10-03T10:00:00Z");
const item = (id: number, over: Partial<QueryHistoryItem> = {}): QueryHistoryItem => ({
  id, sql: `SELECT ${id}`, status: "ok", error: null, rowCount: 3, durationMs: 41, ranAt: "2026-10-03T09:59:30Z", byAgent: false, ...over,
});

describe("historyUrl", () => {
  it("asks the tab's connection for its first page, with nothing else when there is no search", () => {
    expect(historyUrl(conn, "", 0)).toBe("/api/db/connections/5/history");
    expect(historyUrl(conn, "   ", 0)).toBe("/api/db/connections/5/history");
  });

  it("carries the search, trimmed and encoded, and where a later page starts", () => {
    expect(historyUrl(conn, " users & orders ", 50)).toBe("/api/db/connections/5/history?search=users+%26+orders&offset=50");
    expect(historyUrl(conn, "", 100)).toBe("/api/db/connections/5/history?offset=100");
  });

  it("keeps what names the target: another database of the server, or a database file", () => {
    expect(historyUrl({ ...conn, database: "shop" }, "x", 0)).toBe("/api/db/connections/5/history?database=shop&search=x");
    const file = historyUrl({ kind: "file", path: "/data/app.db", projectName: "p" }, "", 50);
    expect(file).toContain("path=%2Fdata%2Fapp.db");
    expect(file).toContain("project=p");
    expect(file.endsWith("&offset=50")).toBe(true);
  });
});

describe("mergeHistoryPage", () => {
  it("makes the first page the list, whatever was shown before", () => {
    expect(mergeHistoryPage([item(9), item(8)], [item(12), item(11)], 0).map((i) => i.id)).toEqual([12, 11]);
  });

  it("puts a later page after the list, leaving out entries already in it", () => {
    // Two runs since the first page pushed 52 and 51 down into the second.
    const shown = [item(100), item(52), item(51)];
    expect(mergeHistoryPage(shown, [item(52), item(51), item(50), item(49)], 50).map((i) => i.id)).toEqual([100, 52, 51, 50, 49]);
  });
});

describe("historyHasMore", () => {
  it("is a full page, and only that", () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => item(i));
    expect(historyHasMore(page(QUERY_HISTORY_PAGE))).toBe(true);
    expect(historyHasMore(page(QUERY_HISTORY_PAGE - 1))).toBe(false);
    expect(historyHasMore([])).toBe(false);
  });
});

describe("historyMeta", () => {
  it("says when, in which database, how many rows and how long", () => {
    expect(historyMeta(item(1, { database: "shop", rowCount: 24 }), now)).toEqual(["just now", "shop", "24 rows", "41 ms"]);
    expect(historyMeta(item(1, { rowCount: 1, durationMs: 1234, ranAt: "2026-10-03T09:46:00Z" }), now)).toEqual(["14 minutes ago", "1 row", "1,234 ms"]);
  });

  it("counts rows only for a run that went through, and leaves out what was not measured", () => {
    expect(historyMeta(item(1, { status: "error", rowCount: 0 }), now)).toEqual(["just now", "41 ms"]);
    expect(historyMeta(item(1, { status: "blocked", rowCount: null, durationMs: null }), now)).toEqual(["just now"]);
    expect(historyMeta(item(1, { rowCount: 0 }), now)).toEqual(["just now", "0 rows", "41 ms"]);
  });

  it("names every status for a screen reader", () => {
    expect(HISTORY_STATUS_LABEL).toEqual({ ok: "Ran", error: "Failed", blocked: "Blocked" });
  });
});

describe("retentionNote", () => {
  it("says the history reaches only as far back as the audit settings keep", () => {
    expect(retentionNote(30, 500)).toBe("Read from the existing audit log. Kept as long as audit settings say (30 days / 500 MB).");
    expect(retentionNote(1, 1024)).toBe("Read from the existing audit log. Kept as long as audit settings say (1 day / 1,024 MB).");
  });
});
