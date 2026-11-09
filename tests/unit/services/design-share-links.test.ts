import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDbPragmas, getDb, openTestDb, runMigrations, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { createDesign, deleteDesign } from "../../../src/services/design/design-store.service.ts";
import { listSnapshots, snapshotDesign } from "../../../src/services/design/design-snapshots.service.ts";
import { restoreSnapshot } from "../../../src/services/design/design-restore.service.ts";
import { SNAPSHOT_CAP, snapshotDir } from "../../../src/services/design/design-snapshot-history.ts";
import {
  createShareLink, deleteShareLink, listShareLinks, resolveShareCode, updateShareLink,
} from "../../../src/services/design/share/design-share-links.service.ts";
import { deriveCode, loadSecret, resetShareSecretCache } from "../../../src/services/design/share/design-share-code.ts";
import { SHARE_LIMITS, type DesignShareLink } from "../../../src/shared/design-share-types.ts";

const DAY = 24 * 60 * 60 * 1000;
const codeOf = (link: DesignShareLink) => link.path!.slice("/s/".length);

async function expectRefusal(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
  } catch (e) {
    expect(e).toMatchObject({ status, code });
    return;
  }
  throw new Error(`expected a ${status} ${code} refusal`);
}

describe("design share links", () => {
  let project: string;
  let dir: string;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-share-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    previousAuth = { ...configService.get("auth") };
    configService.set("auth", { ...previousAuth, enabled: true, token: "share-test" });
    getDb().exec("DELETE FROM design_share_links");
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    rmSync(project, { recursive: true, force: true });
  });

  const create = (input: Record<string, unknown> = {}) => createShareLink(project, "home", { expiresAt: null, version: "current", ...input });

  it("issues a 256-bit code that no column of the table holds", async () => {
    const link = await create({ label: "Client A", expiresAt: Date.now() + 7 * DAY });
    expect(link).toMatchObject({ label: "Client A", status: "active", revokedAt: null });
    expect(link.path).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/);
    const code = codeOf(link);
    const rows = getDb().query("SELECT * FROM design_share_links").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    for (const value of Object.values(rows[0]!)) expect(String(value)).not.toContain(code);

    const resolved = await resolveShareCode(code);
    expect(resolved).toMatchObject({ link: { id: link.id, snapshotId: link.snapshotId }, designDir: dir });
    expect(await resolveShareCode(`${code.slice(0, -1)}${code.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(await resolveShareCode("not-a-code")).toBeNull();
    // Listing re-derives the same path.
    expect((await listShareLinks(project, "home"))[0]!.path).toBe(link.path);
  });

  it("validates label, expiry and version", async () => {
    await expectRefusal(create({ label: "x".repeat(SHARE_LIMITS.maxLabelChars + 1) }), 400, "bad-input");
    await expectRefusal(create({ label: "a\nb" }), 400, "bad-input");
    await expectRefusal(create({ expiresAt: Date.now() - 1 }), 400, "bad-input");
    await expectRefusal(create({ expiresAt: Date.now() + 367 * DAY }), 400, "bad-input");
    await expectRefusal(create({ expiresAt: "tomorrow" }), 400, "bad-input");
    await expectRefusal(createShareLink(project, "home", { version: "current" }), 400, "bad-input");
    await expectRefusal(create({ version: "../x" }), 400, "bad-input");
    await expectRefusal(create({ version: "20260101-000000-abcd" }), 404, "not-found");
    writeFileSync(join(dir, "index.html"), "<p>v2</p>");
    const snap = await snapshotDesign(project, "home", "turn");
    const pinned = await create({ version: (snap as { id: string }).id });
    expect(pinned).toMatchObject({ status: "active", snapshotId: (snap as { id: string }).id });
  });

  it("expires by server time, and an expired link can be extended", async () => {
    const link = await create({ expiresAt: Date.now() + DAY });
    getDb().query("UPDATE design_share_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, link.id);
    expect((await listShareLinks(project, "home"))[0]).toMatchObject({ status: "expired", path: link.path });
    expect(await resolveShareCode(codeOf(link))).toBeNull();
    const extended = await updateShareLink(project, "home", link.id, { expiresAt: Date.now() + DAY });
    expect(extended.link.status).toBe("active");
    expect(await resolveShareCode(codeOf(link))).not.toBeNull();
  });

  it("revokes for good", async () => {
    const link = await create();
    const { link: revoked } = await updateShareLink(project, "home", link.id, { revoke: true });
    expect(revoked).toMatchObject({ status: "revoked", path: null });
    expect(revoked.revokedAt).toBeNumber();
    expect(await resolveShareCode(codeOf(link))).toBeNull();
    await expectRefusal(updateShareLink(project, "home", link.id, { repin: true }), 409, "revoked");
    await expectRefusal(updateShareLink(project, "home", link.id, { newCode: true }), 409, "revoked");
    // Renaming a revoked link is harmless and allowed.
    expect((await updateShareLink(project, "home", link.id, { label: "old" })).link.label).toBe("old");
  });

  it("needs a new code once the secret is gone, and a new code works", async () => {
    const link = await create();
    rmSync(join(getPpmDir(), "design-share.key"));
    resetShareSecretCache();
    expect((await listShareLinks(project, "home"))[0]).toMatchObject({ status: "needs-new-code", path: null });
    expect(await resolveShareCode(codeOf(link))).toBeNull();
    const { link: renewed } = await updateShareLink(project, "home", link.id, { newCode: true });
    expect(renewed.status).toBe("active");
    expect(renewed.path).not.toBe(link.path);
    expect(await resolveShareCode(codeOf(renewed))).not.toBeNull();
  });

  it("rotating a code retires the old one", async () => {
    const link = await create();
    const { link: rotated } = await updateShareLink(project, "home", link.id, { newCode: true });
    expect(await resolveShareCode(codeOf(link))).toBeNull();
    expect((await resolveShareCode(codeOf(rotated)))?.link.id).toBe(link.id);
  });

  it("re-pins to the latest version and lists what changed", async () => {
    writeFileSync(join(dir, "old.css"), "a{}");
    const link = await create();
    writeFileSync(join(dir, "index.html"), "<p>new</p>");
    rmSync(join(dir, "old.css"));
    writeFileSync(join(dir, "new.css"), "b{}");
    const result = await updateShareLink(project, "home", link.id, { repin: true });
    expect(result.link.snapshotId).not.toBe(link.snapshotId);
    expect(result.link.path).toBe(link.path);
    expect(result.changedFiles).toEqual({ added: ["new.css"], removed: ["old.css"], changed: ["index.html"], truncated: false });
    const again = await updateShareLink(project, "home", link.id, { repin: true });
    expect(again.changedFiles).toEqual({ added: [], removed: [], changed: [], truncated: false });
  });

  it("keeps a pinned snapshot through a full history, under any spelling of the project path", async () => {
    const link = await create();
    // Windows paths are case-insensitive, so the pin must hold however the path is spelled.
    const spelled = process.platform === "win32" ? project.toUpperCase() : project;
    for (let i = 0; i <= SNAPSHOT_CAP; i++) {
      writeFileSync(join(dir, "index.html"), `turn ${i}`);
      await snapshotDesign(spelled, "home", "manual");
    }
    expect(existsSync(snapshotDir(dir, link.snapshotId))).toBe(true);
    const history = await listSnapshots(project, "home");
    expect(history).toHaveLength(SNAPSHOT_CAP + 1);
    // Restoring prunes too, and keeps the pin as well.
    writeFileSync(join(dir, "index.html"), "before restore");
    await restoreSnapshot(spelled, "home", history[3]!.id);
    expect(existsSync(snapshotDir(dir, link.snapshotId))).toBe(true);
    expect((await listShareLinks(project, "home"))[0]!.status).toBe("active");
  }, 60_000);

  it("stops at the per-design limit", async () => {
    for (let i = 0; i < SHARE_LIMITS.maxLinksPerDesign; i++) await create({ label: `#${i}` });
    await expectRefusal(create(), 409, "limit");
    expect(await listShareLinks(project, "home")).toHaveLength(SHARE_LIMITS.maxLinksPerDesign);
  });

  it("refuses to share while sign-in is off, and no code opens", async () => {
    const link = await create();
    configService.set("auth", { ...configService.get("auth"), enabled: false });
    await expectRefusal(create(), 409, "signin-off");
    await expectRefusal(updateShareLink(project, "home", link.id, { repin: true }), 409, "signin-off");
    await expectRefusal(updateShareLink(project, "home", link.id, { newCode: true }), 409, "signin-off");
    expect(await resolveShareCode(codeOf(link))).toBeNull();
    expect((await listShareLinks(project, "home"))[0]!.status).toBe("signin-off");
    configService.set("auth", { ...configService.get("auth"), enabled: true });
    expect(await resolveShareCode(codeOf(link))).not.toBeNull();
  });

  it("deletes a link, only through its own design", async () => {
    const link = await create();
    await createDesign(project, { title: "Other", kind: "page" });
    expect(() => deleteShareLink(project, "other", link.id)).toThrow();
    await expectRefusal(updateShareLink(project, "other", link.id, { label: "x" }), 404, "not-found");
    deleteShareLink(project, "home", link.id);
    expect(await listShareLinks(project, "home")).toEqual([]);
    expect(await resolveShareCode(codeOf(link))).toBeNull();
  });

  it("drops the rows when the design is deleted, so a reused slug inherits nothing", async () => {
    const link = await create();
    await deleteDesign(project, "home");
    expect(getDb().query("SELECT COUNT(*) AS n FROM design_share_links").get()).toEqual({ n: 0 });
    await createDesign(project, { title: "Home", kind: "page" });
    expect(await listShareLinks(project, "home")).toEqual([]);
    expect(await resolveShareCode(codeOf(link))).toBeNull();
  });

  it("gives the same path after the database is closed and reopened", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ppm-share-db-")), "ppm.db");
    const open = () => {
      const db = new Database(file);
      applyDbPragmas(db);
      runMigrations(db);
      return db;
    };
    setDb(open());
    try {
      const link = await create();
      setDb(open());
      resetShareSecretCache();
      expect((await listShareLinks(project, "home"))[0]!.path).toBe(link.path);
    } finally {
      setDb(openTestDb());
      rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });
});

describe("design share secret", () => {
  const keyPath = () => join(getPpmDir(), "design-share.key");
  beforeEach(() => {
    rmSync(keyPath(), { force: true });
    resetShareSecretCache();
  });

  it("creates one 32-byte key that concurrent first uses agree on", async () => {
    const [a, b] = await Promise.all([Promise.resolve().then(loadSecret), Promise.resolve().then(() => {
      resetShareSecretCache();
      return loadSecret();
    })]);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
    resetShareSecretCache();
    expect(loadSecret().equals(a)).toBe(true);
  });

  it("gives two processes racing to create it the same key", async () => {
    const modulePath = join(import.meta.dir, "../../../src/services/design/share/design-share-code.ts").replaceAll("\\", "/");
    const script = `import { loadSecret } from ${JSON.stringify(modulePath)}; console.log(loadSecret().toString("hex"));`;
    const run = () => Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PPM_HOME: getPpmDir() }, stdout: "pipe", stderr: "pipe",
    });
    const procs = Array.from({ length: 4 }, run);
    const keys = await Promise.all(procs.map(async (p) => {
      const out = (await new Response(p.stdout).text()).trim();
      expect(await p.exited).toBe(0);
      return out;
    }));
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(keys).size).toBe(1);
    resetShareSecretCache();
    expect(loadSecret().toString("hex")).toBe(keys[0]!);
  }, 30_000);

  it("never overwrites a key another process created first", () => {
    const theirs = Buffer.alloc(32, 7);
    writeFileSync(keyPath(), theirs);
    expect(loadSecret().equals(theirs)).toBe(true);
    expect(readFileSync(keyPath()).equals(theirs)).toBe(true);
  });

  it("follows the file when it is replaced", () => {
    const first = loadSecret();
    const code = deriveCode("abcdef012345", 1);
    rmSync(keyPath());
    writeFileSync(keyPath(), Buffer.alloc(32, 9));
    expect(loadSecret().equals(first)).toBe(false);
    expect(deriveCode("abcdef012345", 1)).not.toBe(code);
  });
});
