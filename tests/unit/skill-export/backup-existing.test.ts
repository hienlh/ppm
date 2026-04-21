import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { backupExisting, makeTimestamp } from "../../../src/services/skill-export/backup-existing.ts";

const tmpDirs: string[] = [];

function mkTarget(): string {
  const d = mkdtempSync(resolve(tmpdir(), "ppm-bak-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("backupExisting", () => {
  it("renames .md files to .md.bak-<ts>", () => {
    const target = mkTarget();
    mkdirSync(resolve(target, "references"), { recursive: true });
    writeFileSync(resolve(target, "SKILL.md"), "old");
    writeFileSync(resolve(target, "references/cli-reference.md"), "old-ref");

    const backed = backupExisting(target, "202604211200");

    expect(existsSync(resolve(target, "SKILL.md.bak-202604211200"))).toBe(true);
    expect(existsSync(resolve(target, "references/cli-reference.md.bak-202604211200"))).toBe(true);
    expect(existsSync(resolve(target, "SKILL.md"))).toBe(false);
    expect(backed.length).toBe(2);
  });

  it("returns empty array when target doesn't exist", () => {
    const nonexistent = resolve(tmpdir(), "ppm-does-not-exist-xyz-123");
    expect(backupExisting(nonexistent)).toEqual([]);
  });

  it("skips already-backed-up files (no .bak-X.bak-Y chains)", () => {
    const target = mkTarget();
    writeFileSync(resolve(target, "SKILL.md.bak-202604210000"), "stale");

    backupExisting(target, "202604211200");

    const files = readdirSync(target);
    // Should still have only the one stale .bak file, no new one created from it
    expect(files.filter((f) => f.includes(".bak-")).length).toBe(1);
    expect(files).toContain("SKILL.md.bak-202604210000");
  });

  it("two runs with different timestamps produce distinct backups", () => {
    const target = mkTarget();
    writeFileSync(resolve(target, "SKILL.md"), "v1");
    backupExisting(target, "202604211200");

    writeFileSync(resolve(target, "SKILL.md"), "v2");
    backupExisting(target, "202604211201");

    const files = readdirSync(target);
    expect(files).toContain("SKILL.md.bak-202604211200");
    expect(files).toContain("SKILL.md.bak-202604211201");
  });

  it("makeTimestamp produces YYYYMMDDHHmm format", () => {
    const ts = makeTimestamp(new Date("2026-04-21T17:33:50Z"));
    expect(ts).toBe("202604211733");
  });
});
