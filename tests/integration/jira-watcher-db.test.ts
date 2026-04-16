import { describe, it, expect, beforeEach } from "bun:test";
import "../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setKeyPath } from "../../src/lib/account-crypto.ts";
import { openTestDb, setDb, getDb } from "../../src/services/db.service.ts";
import { upsertConfig } from "../../src/services/jira-config.service.ts";
import {
  createWatcher, updateWatcher, deleteWatcher,
  getWatcherById, getWatchersByConfigId, getAllEnabledWatchers,
  insertResult, updateResultStatus, getResultsByWatcherId,
  getResultById, softDeleteResult, getWatcherStats,
} from "../../src/services/jira-watcher-db.service.ts";

const testKeyPath = resolve(tmpdir(), `ppm-jira-wdb-${Date.now()}.key`);
setKeyPath(testKeyPath);

let configId: number;

beforeEach(() => {
  const db = openTestDb();
  setDb(db);
  db.query("INSERT INTO projects (path, name, sort_order) VALUES ('/tmp/wdb', 'wdb', 0)").run();
  const pid = (db.query("SELECT id FROM projects WHERE name = 'wdb'").get() as { id: number }).id;
  const cfg = upsertConfig(pid, "https://x.atlassian.net", "a@b.com", "tok");
  configId = cfg.id;
});

describe("Watcher CRUD", () => {
  it("createWatcher returns watcher with defaults", () => {
    const w = createWatcher(configId, "test-watcher", "project=X");
    expect(w.name).toBe("test-watcher");
    expect(w.jql).toBe("project=X");
    expect(w.enabled).toBe(true);
    expect(w.mode).toBe("debug");
    expect(w.intervalMs).toBe(120000);
  });

  it("getWatcherById returns correct watcher", () => {
    const w = createWatcher(configId, "w1", "x=y");
    const found = getWatcherById(w.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("w1");
  });

  it("updateWatcher changes fields", () => {
    const w = createWatcher(configId, "old", "old=jql");
    const updated = updateWatcher(w.id, { name: "new", jql: "new=jql", intervalMs: 60000 });
    expect(updated!.name).toBe("new");
    expect(updated!.jql).toBe("new=jql");
    expect(updated!.intervalMs).toBe(60000);
  });

  it("deleteWatcher removes watcher", () => {
    const w = createWatcher(configId, "del", "x=y");
    expect(deleteWatcher(w.id)).toBe(true);
    expect(getWatcherById(w.id)).toBeNull();
  });

  it("getWatchersByConfigId returns watchers for config", () => {
    createWatcher(configId, "w1", "a=b");
    createWatcher(configId, "w2", "c=d");
    const list = getWatchersByConfigId(configId);
    expect(list).toHaveLength(2);
  });

  it("getAllEnabledWatchers returns only enabled", () => {
    createWatcher(configId, "enabled", "x=y");
    const w2 = createWatcher(configId, "disabled", "x=y");
    updateWatcher(w2.id, { enabled: false });
    const enabled = getAllEnabledWatchers();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.name).toBe("enabled");
  });
});

describe("Result CRUD", () => {
  let watcherId: number;

  beforeEach(() => {
    const w = createWatcher(configId, "result-watcher", "x=y");
    watcherId = w.id;
  });

  it("insertResult returns inserted=true for new", () => {
    const { inserted, resultId } = insertResult(watcherId, "TEST-1", "summary", "2025-01-01");
    expect(inserted).toBe(true);
    expect(resultId).not.toBeNull();
  });

  it("insertResult deduplicates same key+updated", () => {
    insertResult(watcherId, "TEST-1", "s", "2025-01-01");
    const { inserted } = insertResult(watcherId, "TEST-1", "s", "2025-01-01");
    expect(inserted).toBe(false);
  });

  it("insertResult allows same key with different updated", () => {
    insertResult(watcherId, "TEST-1", "s", "2025-01-01");
    const { inserted } = insertResult(watcherId, "TEST-1", "s", "2025-01-02");
    expect(inserted).toBe(true);
  });

  it("updateResultStatus changes status and ai_summary", () => {
    const { resultId } = insertResult(watcherId, "TEST-2", "s", "2025-01-01");
    updateResultStatus(resultId!, "done", { aiSummary: "Fixed a bug" });
    const r = getResultById(resultId!);
    expect(r!.status).toBe("done");
    expect(r!.aiSummary).toBe("Fixed a bug");
  });

  it("getResultsByWatcherId returns results", () => {
    insertResult(watcherId, "A-1", "a", "2025-01-01");
    insertResult(watcherId, "A-2", "b", "2025-01-01");
    const results = getResultsByWatcherId(watcherId);
    expect(results).toHaveLength(2);
  });

  it("softDeleteResult excludes from default query", () => {
    const { resultId } = insertResult(watcherId, "DEL-1", "s", "2025-01-01");
    softDeleteResult(resultId!);
    const results = getResultsByWatcherId(watcherId);
    expect(results).toHaveLength(0);
  });

  it("getWatcherStats returns counts by status", () => {
    const { resultId: r1 } = insertResult(watcherId, "S-1", "s", "2025-01-01");
    insertResult(watcherId, "S-2", "s", "2025-01-02");
    updateResultStatus(r1!, "done");
    const stats = getWatcherStats();
    expect(stats.done).toBe(1);
    expect(stats.pending).toBe(1);
  });
});
