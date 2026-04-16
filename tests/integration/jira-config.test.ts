import { describe, it, expect, beforeEach } from "bun:test";
import "../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setKeyPath } from "../../src/lib/account-crypto.ts";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import {
  upsertConfig, getConfigByProjectId, getAllConfigs,
  deleteConfig, getDecryptedCredentials,
} from "../../src/services/jira-config.service.ts";

const testKeyPath = resolve(tmpdir(), `ppm-jira-cfg-${Date.now()}.key`);
setKeyPath(testKeyPath);

beforeEach(() => {
  const db = openTestDb();
  setDb(db);
  // Insert a project for FK reference
  db.query("INSERT INTO projects (path, name, sort_order) VALUES ('/tmp/p1', 'proj1', 0)").run();
});

describe("Jira Config Service", () => {
  function getProjectId(): number {
    const { getDb } = require("../../src/services/db.service.ts");
    return (getDb().query("SELECT id FROM projects WHERE name = 'proj1'").get() as { id: number }).id;
  }

  it("upsertConfig creates and returns config", () => {
    const pid = getProjectId();
    const cfg = upsertConfig(pid, "https://test.atlassian.net", "me@test.com", "secret123");
    expect(cfg.projectId).toBe(pid);
    expect(cfg.baseUrl).toBe("https://test.atlassian.net");
    expect(cfg.email).toBe("me@test.com");
    expect(cfg.hasToken).toBe(true);
  });

  it("getConfigByProjectId returns config", () => {
    const pid = getProjectId();
    upsertConfig(pid, "https://x.atlassian.net", "a@b.com", "tok");
    const cfg = getConfigByProjectId(pid);
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe("https://x.atlassian.net");
  });

  it("getConfigByProjectId returns null for missing", () => {
    expect(getConfigByProjectId(99999)).toBeNull();
  });

  it("getAllConfigs returns list", () => {
    const pid = getProjectId();
    upsertConfig(pid, "https://x.atlassian.net", "a@b.com", "tok");
    const all = getAllConfigs();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("upsert replaces on conflict", () => {
    const pid = getProjectId();
    upsertConfig(pid, "https://old.atlassian.net", "old@b.com", "old");
    upsertConfig(pid, "https://new.atlassian.net", "new@b.com", "new");
    const cfg = getConfigByProjectId(pid);
    expect(cfg!.baseUrl).toBe("https://new.atlassian.net");
    expect(cfg!.email).toBe("new@b.com");
  });

  it("deleteConfig removes config", () => {
    const pid = getProjectId();
    upsertConfig(pid, "https://x.atlassian.net", "a@b.com", "tok");
    expect(deleteConfig(pid)).toBe(true);
    expect(getConfigByProjectId(pid)).toBeNull();
  });

  it("deleteConfig returns false for missing", () => {
    expect(deleteConfig(99999)).toBe(false);
  });

  it("getDecryptedCredentials round-trips correctly", () => {
    const pid = getProjectId();
    const cfg = upsertConfig(pid, "https://x.atlassian.net", "a@b.com", "mytoken123");
    const creds = getDecryptedCredentials(cfg.id);
    expect(creds).not.toBeNull();
    expect(creds!.baseUrl).toBe("https://x.atlassian.net");
    expect(creds!.email).toBe("a@b.com");
    expect(creds!.token).toBe("mytoken123");
  });

  it("getDecryptedCredentials returns null for missing config", () => {
    expect(getDecryptedCredentials(99999)).toBeNull();
  });
});
