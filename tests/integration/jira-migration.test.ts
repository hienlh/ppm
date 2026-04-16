import { describe, it, expect, beforeEach } from "bun:test";
import "../test-setup.ts";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import type { Database } from "bun:sqlite";

let db: Database;

beforeEach(() => {
  db = openTestDb();
  setDb(db);
});

describe("Jira migration v18", () => {
  it("creates jira_config table", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='jira_config'").all();
    expect(tables).toHaveLength(1);
  });

  it("creates jira_watchers table with indexes", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='jira_watchers'").all();
    expect(tables).toHaveLength(1);
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_jira_watchers%'").all();
    expect(indexes.length).toBeGreaterThanOrEqual(2);
  });

  it("creates jira_watch_results table with indexes", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='jira_watch_results'").all();
    expect(tables).toHaveLength(1);
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_jira_results%'").all();
    expect(indexes.length).toBeGreaterThanOrEqual(2);
  });

  it("enforces UNIQUE(watcher_id, issue_key, issue_updated) constraint", () => {
    // Insert a project + config + watcher first
    db.query("INSERT INTO projects (path, name, sort_order) VALUES ('/tmp/test', 'test', 0)").run();
    const proj = db.query("SELECT id FROM projects WHERE name = 'test'").get() as { id: number };
    db.query("INSERT INTO jira_config (project_id, base_url, email, api_token_encrypted) VALUES (?, 'https://x.atlassian.net', 'a@b.com', 'enc')").run(proj.id);
    const config = db.query("SELECT id FROM jira_config LIMIT 1").get() as { id: number };
    db.query("INSERT INTO jira_watchers (jira_config_id, name, jql) VALUES (?, 'w1', 'project=X')").run(config.id);
    const watcher = db.query("SELECT id FROM jira_watchers LIMIT 1").get() as { id: number };

    // First insert
    db.query("INSERT INTO jira_watch_results (watcher_id, issue_key, issue_updated) VALUES (?, 'TEST-1', '2025-01-01')").run(watcher.id);

    // Duplicate should fail
    expect(() => {
      db.query("INSERT INTO jira_watch_results (watcher_id, issue_key, issue_updated) VALUES (?, 'TEST-1', '2025-01-01')").run(watcher.id);
    }).toThrow();
  });

  it("CASCADE deletes watchers and results when config is deleted", () => {
    db.query("INSERT INTO projects (path, name, sort_order) VALUES ('/tmp/cascade', 'cascade', 0)").run();
    const proj = db.query("SELECT id FROM projects WHERE name = 'cascade'").get() as { id: number };
    db.query("INSERT INTO jira_config (project_id, base_url, email, api_token_encrypted) VALUES (?, 'https://x.atlassian.net', 'a@b.com', 'enc')").run(proj.id);
    const config = db.query("SELECT id FROM jira_config WHERE project_id = ?").get(proj.id) as { id: number };
    db.query("INSERT INTO jira_watchers (jira_config_id, name, jql) VALUES (?, 'w', 'x=y')").run(config.id);
    const watcher = db.query("SELECT id FROM jira_watchers WHERE jira_config_id = ?").get(config.id) as { id: number };
    db.query("INSERT INTO jira_watch_results (watcher_id, issue_key) VALUES (?, 'X-1')").run(watcher.id);

    // Delete config
    db.query("DELETE FROM jira_config WHERE id = ?").run(config.id);

    const watchers = db.query("SELECT * FROM jira_watchers WHERE jira_config_id = ?").all(config.id);
    const results = db.query("SELECT * FROM jira_watch_results WHERE watcher_id = ?").all(watcher.id);
    expect(watchers).toHaveLength(0);
    expect(results).toHaveLength(0);
  });
});
