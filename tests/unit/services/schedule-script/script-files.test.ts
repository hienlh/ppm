import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { getPpmDir } from "../../../../src/services/ppm-dir.ts";
import { removeRunDir, scheduleRunDir, writeScriptFile } from "../../../../src/services/schedule-script/script-files.ts";

describe("script files", () => {
  it("live under the PPM dir, per database and schedule", () => {
    const dir = scheduleRunDir(12);
    expect(dir.startsWith(getPpmDir())).toBe(true);
    expect(basename(dir)).toBe("12");
    expect(basename(dirname(dir))).toMatch(/^ppm/);
  });

  it("are named by content, private to the user, and an edit replaces the old file", () => {
    const first = writeScriptFile(13, "export default async () => 1;");
    expect(readFileSync(first, "utf8")).toBe("export default async () => 1;");
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(writeScriptFile(13, "export default async () => 1;")).toBe(first);
    const second = writeScriptFile(13, "export default async () => 2;");
    expect(second).not.toBe(first);
    expect(readdirSync(scheduleRunDir(13))).toEqual([basename(second)]);
    removeRunDir(13);
  });
});
