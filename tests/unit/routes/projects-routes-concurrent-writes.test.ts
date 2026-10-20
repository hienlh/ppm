/**
 * Project writes that used to undo or lose data: an avatar upload writing back the list it read
 * before its body arrived, a rename plus a move giving the project a new row (and cascading away
 * what hangs off its id), and a stored avatar name followed out of the avatars folder.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, openTestDb, setDb, setDbProfile } from "../../../src/services/db.service.ts";
import { projectRoutes } from "../../../src/server/routes/projects.ts";
import { configService } from "../../../src/services/config.service.ts";
import { _resetPpmDir, getPpmDir } from "../../../src/services/ppm-dir.ts";
import { getAvatarsDir } from "../../../src/services/avatar-storage.service.ts";

const app = () => new Hono().route("/projects", projectRoutes);
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ ...json(body), method: "PATCH" });
const rowOf = (name: string) => getDb().query("SELECT id, path, name FROM projects WHERE name = ?").get(name) as { id: number; path: string; name: string } | null;

let home: string;
let prevHome: string | undefined;
let dirs: string[];

beforeEach(() => {
  prevHome = process.env.PPM_HOME;
  home = mkdtempSync(join(tmpdir(), "ppm-projects-writes-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
  setDb(openTestDb());
  configService.load();
  dirs = ["a", "b", "c"].map((n) => mkdtempSync(join(tmpdir(), `ppm-proj-${n}-`)));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = prevHome;
  _resetPpmDir();
  for (const d of [home, ...dirs]) rmSync(d, { recursive: true, force: true });
});

/** A multipart upload during whose body read `during` runs — as another tab or the CLI might. */
async function uploadWhile(name: string, during: () => void): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }), "a.webp");
  class SlowUpload extends Request {
    override async formData(): Promise<FormData> {
      during();
      return super.formData();
    }
  }
  return app().request(new SlowUpload(`http://localhost/projects/${name}/image`, { method: "POST", body: form }));
}

describe("an avatar upload", () => {
  it("does not revert a project added while its body was arriving", async () => {
    await app().request("/projects", json({ path: dirs[0], name: "proj" }));
    const res = await uploadWhile("proj", () => {
      // Another tab adds a project while the picture is still uploading.
      configService.set("projects", [...configService.get("projects"), { path: dirs[1]!, name: "added" }]);
    });
    expect(res.status).toBe(200);
    expect(rowOf("added")).not.toBeNull();
    expect(configService.get("projects").map((p) => p.name)).toEqual(["proj", "added"]);
  });

  it("answers 404 when its project was removed meanwhile, and stores nothing", async () => {
    await app().request("/projects", json({ path: dirs[0], name: "proj" }));
    const res = await uploadWhile("proj", () => {
      configService.set("projects", configService.get("projects").filter((p) => p.name !== "proj"));
    });
    expect(res.status).toBe(404);
    expect(rowOf("proj")).toBeNull();
  });
});

describe("PATCH /projects/:name with a new name and a new path", () => {
  it("keeps the project's row, so what references its id survives", async () => {
    await app().request("/projects", json({ path: dirs[0], name: "proj" }));
    const before = rowOf("proj")!;
    getDb().query("INSERT INTO jira_config (project_id, base_url, email, api_token_encrypted) VALUES (?, 'https://x', 'a@b', 'enc')").run(before.id);

    const res = await app().request("/projects/proj", patch({ name: "renamed", path: dirs[1] }));
    expect(res.status).toBe(200);
    const after = rowOf("renamed")!;
    expect(after.id).toBe(before.id);
    expect(after.path).toBe(configService.get("projects").find((p) => p.name === "renamed")!.path);
    expect(getDb().query("SELECT COUNT(*) AS n FROM jira_config WHERE project_id = ?").get(before.id)).toEqual({ n: 1 });
  });

  it("changes neither when the rename is refused", async () => {
    await app().request("/projects", json({ path: dirs[0], name: "proj" }));
    await app().request("/projects", json({ path: dirs[2], name: "taken" }));
    const before = rowOf("proj")!;
    const res = await app().request("/projects/proj", patch({ name: "taken", path: dirs[1] }));
    expect(res.status).toBe(400);
    expect(rowOf("proj")).toEqual(before);
  });
});

describe("a stored avatar name", () => {
  it("is never followed out of the avatars folder, to serve or to delete", async () => {
    await app().request("/projects", json({ path: dirs[0], name: "proj" }));
    const victim = join(getPpmDir(), "victim.db");
    writeFileSync(victim, "data");
    // As `ppm config set projects.0.image` or an extension could have left it.
    getDb().query("UPDATE projects SET image = '../victim.db' WHERE name = 'proj'").run();
    (configService as unknown as { config: { projects: { name: string; image?: string }[] } }).config.projects
      .find((p) => p.name === "proj")!.image = "../victim.db";

    expect((await app().request("/projects/proj/image")).status).toBe(400);
    await app().request("/projects/proj/image", { method: "DELETE" });
    expect(existsSync(victim)).toBe(true);
  });
});

describe("the avatars folder", () => {
  it("is one per database file, so a dev server never deletes a picture production uses", () => {
    expect(getAvatarsDir()).toBe(join(getPpmDir(), "avatars"));
    closeDb();
    try {
      setDbProfile("dev");
      expect(getAvatarsDir()).toBe(join(getPpmDir(), "avatars.dev"));
    } finally {
      setDbProfile(null);
      setDb(openTestDb());
      configService.load();
    }
  });

  it("still serves a dev picture left in the shared folder, and never deletes it from there", async () => {
    closeDb();
    setDbProfile("dev");
    try {
      setDb(openTestDb());
      configService.load();
      await app().request("/projects", json({ path: dirs[0], name: "proj" }));
      // Written before the folders were split: the dev row names a file in the shared one.
      const name = `${"b".repeat(64)}.webp`;
      const shared = join(getPpmDir(), "avatars", name);
      mkdirSync(join(getPpmDir(), "avatars"), { recursive: true });
      writeFileSync(shared, "webp");
      getDb().query("UPDATE projects SET image = ? WHERE name = 'proj'").run(name);
      (configService as unknown as { config: { projects: { name: string; image?: string }[] } }).config.projects
        .find((p) => p.name === "proj")!.image = name;

      const res = await app().request("/projects/proj/image");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("webp");
      // The production database may name the same file; this process cannot ask it.
      await app().request("/projects/proj/image", { method: "DELETE" });
      expect(existsSync(shared)).toBe(true);
    } finally {
      closeDb();
      setDbProfile(null);
      setDb(openTestDb());
      configService.load();
    }
  });
});
