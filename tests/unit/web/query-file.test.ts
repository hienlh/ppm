/**
 * A Query tab saved to a `.sql` file: the name the first save offers, the extension added to a name
 * typed without one, the tab's title once saved, and the check for a file already in the folder.
 */
import { describe, expect, it } from "bun:test";
import {
  defaultQueryFileName, hasFileNamed, queryFileTitle, savedFileOf, savedQueryTab, splitFilePath, withSqlExtension,
} from "../../../src/web/components/database/query/query-file";
import { isQueryTabDirty, queryTabMetadata } from "../../../src/web/lib/db-tabs";

describe("savedFileOf", () => {
  it("is the file a tab was saved to, and nothing for a tab never saved", () => {
    expect(savedFileOf({ savedPath: "/home/u/sql/report.sql", currentSql: "SELECT 1" })).toBe("/home/u/sql/report.sql");
    expect(savedFileOf({ savedPath: "" })).toBeNull();
    expect(savedFileOf({ savedPath: 3 })).toBeNull();
    expect(savedFileOf({})).toBeNull();
    expect(savedFileOf(undefined)).toBeNull();
  });
});

describe("defaultQueryFileName", () => {
  it("offers the tab's title as a file name", () => {
    expect(defaultQueryFileName("Query 3")).toBe("query-3.sql");
    expect(defaultQueryFileName("  Orders: last week  ")).toBe("orders-last-week.sql");
  });

  it("keeps letters that are not English ones, and falls back when nothing is left", () => {
    expect(defaultQueryFileName("Báo cáo tháng")).toBe("báo-cáo-tháng.sql");
    expect(defaultQueryFileName(" / ")).toBe("query.sql");
  });
});

describe("withSqlExtension", () => {
  it("adds .sql to a name typed without an extension", () => {
    expect(withSqlExtension("/home/u/sql/report")).toBe("/home/u/sql/report.sql");
    expect(withSqlExtension("C:\\Users\\u\\report")).toBe("C:\\Users\\u\\report.sql");
  });

  it("leaves a name with an extension of its own as typed", () => {
    expect(withSqlExtension("/home/u/sql/report.sql")).toBe("/home/u/sql/report.sql");
    expect(withSqlExtension("/home/u/sql/report.txt")).toBe("/home/u/sql/report.txt");
  });

  it("looks only at the file's own name, not at a dot in a folder's", () => {
    expect(withSqlExtension("/home/u/v1.2/report")).toBe("/home/u/v1.2/report.sql");
    expect(withSqlExtension("C:\\x.y\\report")).toBe("C:\\x.y\\report.sql");
  });
});

describe("queryFileTitle", () => {
  it("is the file's name without .sql", () => {
    expect(queryFileTitle("/home/u/sql/Report.SQL")).toBe("Report");
    expect(queryFileTitle("C:\\Users\\u\\orders.sql")).toBe("orders");
  });

  it("keeps any other extension, and a name that is only one", () => {
    expect(queryFileTitle("/home/u/notes.txt")).toBe("notes.txt");
    expect(queryFileTitle("/home/u/.sql")).toBe(".sql");
  });
});

describe("savedQueryTab", () => {
  const typed = { ...queryTabMetadata("SELECT 1", 3), currentSql: "SELECT * FROM orders", rowLimit: 500 };

  it("names the tab after its file, keeps the file, and keeps everything else the tab had", () => {
    const saved = savedQueryTab(typed, "/home/u/sql/orders.sql", "SELECT * FROM orders");
    expect(saved.title).toBe("orders");
    expect(saved.metadata).toEqual({ ...typed, savedPath: "/home/u/sql/orders.sql", openedSql: "SELECT * FROM orders" });
    expect(savedFileOf(saved.metadata)).toBe("/home/u/sql/orders.sql");
  });

  it("is clean while the SQL is what was written, and not once more was typed while it was written", () => {
    expect(isQueryTabDirty(typed)).toBe(true);
    expect(isQueryTabDirty(savedQueryTab(typed, "/q.sql", "SELECT * FROM orders").metadata)).toBe(false);
    const typedOn = { ...typed, currentSql: "SELECT * FROM orders WHERE id = 1" };
    expect(isQueryTabDirty(savedQueryTab(typedOn, "/q.sql", "SELECT * FROM orders").metadata)).toBe(true);
  });
});

describe("splitFilePath", () => {
  it("is the folder a file is in, and its name there", () => {
    expect(splitFilePath("/home/u/sql/report.sql")).toEqual({ dir: "/home/u/sql", name: "report.sql" });
    expect(splitFilePath("C:\\Users\\u\\report.sql")).toEqual({ dir: "C:\\Users\\u", name: "report.sql" });
  });

  it("keeps a root's separator, which is the root", () => {
    expect(splitFilePath("/report.sql")).toEqual({ dir: "/", name: "report.sql" });
    expect(splitFilePath("C:\\report.sql")).toEqual({ dir: "C:\\", name: "report.sql" });
  });

  it("has no folder for a bare name", () => {
    expect(splitFilePath("report.sql")).toEqual({ dir: "", name: "report.sql" });
  });
});

describe("hasFileNamed", () => {
  const entries = [
    { name: "Report.sql", type: "file" },
    { name: "archive.sql", type: "directory" },
  ];

  it("finds a file by its name, whatever its case", () => {
    expect(hasFileNamed(entries, "report.sql")).toBe(true);
    expect(hasFileNamed(entries, "REPORT.SQL")).toBe(true);
    expect(hasFileNamed(entries, "orders.sql")).toBe(false);
  });

  it("does not count a folder by that name", () => {
    expect(hasFileNamed(entries, "archive.sql")).toBe(false);
  });
});
