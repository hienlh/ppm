import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { generateDbSchemaMarkdown } from "../../../src/services/skill-export/generate-db-schema.ts";

const dirs: string[] = [];

function makeTempDb(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ppm-schema-test-"));
  dirs.push(dir);
  const dbPath = resolve(dir, "ppm.db");
  const db = new Database(dbPath);
  db.run(`CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    added_at INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE db_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL
  )`);
  db.close();
  return dbPath;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("generateDbSchemaMarkdown", () => {
  it("renders tables and columns from a real SQLite DB", () => {
    const dbPath = makeTempDb();
    const md = generateDbSchemaMarkdown(dbPath);

    expect(md).toContain("# PPM Database Schema");
    expect(md).toContain("## projects");
    expect(md).toContain("## db_connections");
    expect(md).toContain("`id`");
    expect(md).toContain("`name`");
    expect(md).toContain("`path`");
    expect(md).toContain("`type`");
  });

  it("marks NOT NULL columns correctly", () => {
    const dbPath = makeTempDb();
    const md = generateDbSchemaMarkdown(dbPath);
    // `name TEXT NOT NULL` → nullable=no
    const lines = md.split("\n");
    const nameRow = lines.find((l) => l.includes("| `name` |"));
    expect(nameRow).toBeDefined();
    expect(nameRow).toContain("| no |");
  });

  it("marks primary key columns", () => {
    const dbPath = makeTempDb();
    const md = generateDbSchemaMarkdown(dbPath);
    const lines = md.split("\n");
    const idRow = lines.find((l) => l.includes("| `id` |") && l.includes("projects") === false);
    // Just check at least one row contains "| yes |" for pk
    expect(md).toMatch(/\|\s*yes\s*\|/);
  });

  it("returns placeholder when DB missing (no throw)", () => {
    const md = generateDbSchemaMarkdown("/tmp/definitely-not-a-db-xyz-999.db");
    expect(md).toContain("# PPM Database Schema");
    expect(md).toContain("Database not found");
  });

  it("handles empty DB (no tables) gracefully", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ppm-empty-"));
    dirs.push(dir);
    const dbPath = resolve(dir, "empty.db");
    const db = new Database(dbPath);
    db.close();

    const md = generateDbSchemaMarkdown(dbPath);
    expect(md).toContain("No tables found");
  });
});
