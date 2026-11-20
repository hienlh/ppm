/**
 * Where the OS file browser opens for a path someone else named (the Assistant's
 * `ui_open_file_browser`, a `/files?path=` link, a path in an AI answer): a folder as itself, a
 * file as its folder with the file selected, under the strictest rules PPM has — PPM's own folder
 * and the stores the Assistant keeps private refused before the disk is asked, a missing path
 * answered as missing, a relative path only with a folder to resolve it against.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { resolveFileBrowserTarget } from "../../../src/services/file-browser-target.ts";
import { assistantPrivateScope } from "../../../src/services/assistant/assistant-private-paths.ts";

let root: string;
let home: string;
const scope = () => assistantPrivateScope({ projectRoots: [], home, roots: [join(home, ".ssh"), getPpmDir()] });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-file-browser-target-"));
  home = join(root, "home");
  mkdirSync(join(root, "story-2026-11-19-london", "photos"), { recursive: true });
  writeFileSync(join(root, "story-2026-11-19-london", "Clip.MP4"), "x");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveFileBrowserTarget", () => {
  it("opens a folder as itself", async () => {
    const dir = join(root, "story-2026-11-19-london");
    expect(await resolveFileBrowserTarget(dir, { scope: scope() })).toEqual({ ok: true, value: { dir, select: null, kind: "folder" } });
  });

  it("opens a file's folder with the file selected", async () => {
    const dir = join(root, "story-2026-11-19-london");
    const file = join(dir, "Clip.MP4");
    expect(await resolveFileBrowserTarget(file, { scope: scope() })).toEqual({ ok: true, value: { dir, select: file, kind: "file" } });
  });

  it.if(process.platform === "win32" || process.platform === "darwin")("selects the file as the disk spells it", async () => {
    const dir = join(root, "story-2026-11-19-london");
    const outcome = await resolveFileBrowserTarget(join(dir, "clip.mp4"), { scope: scope() });
    expect(outcome.ok && outcome.value.select).toBe(join(dir, "Clip.MP4"));
  });

  it("resolves a relative path only against a folder it was given", async () => {
    expect(await resolveFileBrowserTarget("story-2026-11-19-london/photos", { baseDir: root, scope: scope() }))
      .toEqual({ ok: true, value: { dir: join(root, "story-2026-11-19-london", "photos"), select: null, kind: "folder" } });
    const refused = await resolveFileBrowserTarget("story-2026-11-19-london", { scope: scope() });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("relative");
  });

  it("says a missing path is missing", async () => {
    const outcome = await resolveFileBrowserTarget(join(root, "nope", "deeper"), { scope: scope() });
    expect(outcome).toEqual({ ok: false, error: `There is nothing at ${join(root, "nope", "deeper")}.` });
  });

  it("refuses a store of keys whether or not the file in it exists, with the same words", async () => {
    const there = await resolveFileBrowserTarget(join(home, ".ssh", "id_ed25519"), { scope: scope() });
    const absent = await resolveFileBrowserTarget(join(home, ".ssh", "id_rsa"), { scope: scope() });
    const folder = await resolveFileBrowserTarget(join(home, ".ssh"), { scope: scope() });
    for (const outcome of [there, absent, folder]) {
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toContain("logins or keys");
    }
  });

  it("refuses PPM's own folder", async () => {
    const outcome = await resolveFileBrowserTarget(getPpmDir(), { scope: scope() });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/private|logins or keys/);
  });

  it.if(process.platform === "win32")("refuses another machine's share before touching it", async () => {
    const outcome = await resolveFileBrowserTarget("\\\\attacker\\share\\x", { scope: scope() });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain("not on one of this machine's drives");
  });

  it("refuses what is not a path", async () => {
    for (const input of [undefined, 42, "", "   ", `a\0b`, "x".repeat(5000)]) {
      expect((await resolveFileBrowserTarget(input, { scope: scope() })).ok).toBe(false);
    }
  });
});
