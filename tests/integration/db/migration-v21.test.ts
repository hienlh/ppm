import { describe, it, expect } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import { openTestDb } from "../../../src/services/db.service.ts";

describe("DB migration v21 — add projects.settings column", () => {
  it("openTestDb creates fresh DB with settings column at v21", () => {
    const db = openTestDb();

    // Check settings column exists on projects table
    const cols = db
      .query("PRAGMA table_info(projects)")
      .all() as { name: string; type: string }[];
    const hasSettings = cols.some((c) => c.name === "settings");

    expect(hasSettings).toBe(true);

    // Check version is 21
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(21);

    db.close();
  });

  it("settings column has default value {}", () => {
    const db = openTestDb();

    // Insert a project without settings value
    db.query(
      "INSERT INTO projects (name, path) VALUES (?, ?)"
    ).run("test-proj", "/test/path");

    // Verify it has default empty JSON
    const project = db
      .query("SELECT settings FROM projects WHERE name = ?")
      .get("test-proj") as { settings: string };

    expect(project.settings).toBe("{}");

    db.close();
  });

  it("settings column can store and retrieve JSON", () => {
    const db = openTestDb();

    const testSettings = JSON.stringify({
      files: {
        filesExclude: ["**/*.log"],
        searchExclude: ["**/node_modules"],
      },
    });

    // Insert project with custom settings
    db.query(
      "INSERT INTO projects (name, path, settings) VALUES (?, ?, ?)"
    ).run("test-proj-2", "/test/path2", testSettings);

    // Retrieve and verify
    const project = db
      .query("SELECT settings FROM projects WHERE name = ?")
      .get("test-proj-2") as { settings: string };

    expect(project.settings).toBe(testSettings);
    const parsed = JSON.parse(project.settings);
    expect(parsed.files.filesExclude).toContain("**/*.log");

    db.close();
  });

  it("handles multiple projects with mixed settings", () => {
    const db = openTestDb();

    // Project 1: default settings
    db.query("INSERT INTO projects (name, path) VALUES (?, ?)").run(
      "proj-a",
      "/path/a"
    );

    // Project 2: custom settings
    const customSettings = JSON.stringify({ files: { useIgnoreFiles: false } });
    db.query(
      "INSERT INTO projects (name, path, settings) VALUES (?, ?, ?)"
    ).run("proj-b", "/path/b", customSettings);

    // Verify both
    const projects = db
      .query("SELECT name, settings FROM projects ORDER BY name")
      .all() as { name: string; settings: string }[];

    expect(projects).toHaveLength(2);
    expect(projects[0].name).toBe("proj-a");
    expect(projects[0].settings).toBe("{}");
    expect(projects[1].name).toBe("proj-b");
    expect(JSON.parse(projects[1].settings).files.useIgnoreFiles).toBe(false);

    db.close();
  });
});
