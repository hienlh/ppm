import { describe, expect, it } from "bun:test";
import { dbToolCall, dbToolOf } from "../../../src/web/lib/db-tool-call";

describe("dbToolCall", () => {
  it("reads Claude's and Codex's names for the three tools, and Codex's wrapped arguments", () => {
    expect(dbToolCall("mcp__ppm-db__db_query", { connection: "Prod", sql: "SELECT 1", max_rows: 5 }))
      .toEqual({ tool: "db_query", connection: "Prod", sql: "SELECT 1" });
    expect(dbToolCall("ppm_db:db_execute", {
      server: "ppm_db", tool: "db_execute",
      arguments: { connection: "Prod", sql: "DELETE FROM t", reason: "Drop it", expected_rows: 0, database: "app" },
    })).toEqual({ tool: "db_execute", connection: "Prod", sql: "DELETE FROM t", reason: "Drop it", expectedRows: 0, database: "app" });
    expect(dbToolOf("ppm_db:open_query")).toBe("open_query");
  });

  it("is not another server's tool, nor a call without a connection and SQL", () => {
    expect(dbToolOf("mcp__ppm-tabs__open_file")).toBeNull();
    expect(dbToolOf("mcp__ppm-db__db_query_all")).toBeNull();
    expect(dbToolCall("ppm_tabs:open_file", { path: "a" })).toBeNull();
    expect(dbToolCall("mcp__ppm-db__db_query", { sql: "SELECT 1" })).toBeNull();
    expect(dbToolCall("mcp__ppm-db__db_query", "SELECT 1")).toBeNull();
  });
});
