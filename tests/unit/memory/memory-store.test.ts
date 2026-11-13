import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { globalMemoryDir, projectMemoryDir } from "../../../src/services/memory/memory-paths.ts";
import { parseMemoryFile } from "../../../src/services/memory/memory-file.ts";
import {
  memoryDir, memoryStore, MemoryStoreError, type MemoryWriteInput,
} from "../../../src/services/memory/memory-store.ts";

const originalPpmHome = process.env.PPM_HOME;
let home: string;
let projectPath: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-memory-store-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
  projectPath = join(home, "some-project");
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

const input = (over: Partial<MemoryWriteInput> = {}): MemoryWriteInput => ({
  scope: "project",
  projectPath,
  name: "Bash tool shell is zsh",
  description: "unquoted $LIST is one argument",
  type: "feedback",
  body: "Quote every list variable.",
  ...over,
});

/** The error a promise rejected with, or undefined when it resolved (so the check is an assertion). */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("memory store: create", () => {
  it("creates a PPM memory with an m-<8 hex> id and the file's revision, written whole and parseable", async () => {
    const { record, created, redacted } = await memoryStore.write(input(), { caller: "tool" });
    expect(record.id).toMatch(/^m-[0-9a-f]{8}$/);
    expect(created).toBe(true);
    expect(redacted).toBe(0);
    expect(record.source).toBe("ppm");
    expect(record.scope).toBe("project");
    expect(record.created).not.toBe("");
    expect(record.updated).not.toBe("");
    expect(record.revision).toMatch(/^[0-9a-f]{12}$/);

    const file = join(projectMemoryDir(projectPath), `${record.id}.md`);
    expect(existsSync(file)).toBe(true);
    const parsed = parseMemoryFile(readFileSync(file, "utf8"), record.id, "project");
    expect(parsed.revision).toBe(record.revision);
    expect(parsed.name).toBe("Bash tool shell is zsh");
    expect(parsed.type).toBe("feedback");
    expect(parsed.body).toBe("Quote every list variable.");

    // temp file + rename: nothing but finished memory files (and project.json) is left behind
    const leftovers = readdirSync(projectMemoryDir(projectPath)).filter((f) => !/^m-[0-9a-f]{8}\.md$/.test(f) && f !== "project.json");
    expect(leftovers).toEqual([]);
  });

  it("a tool cannot create a memory under a provider's source", async () => {
    const { record } = await memoryStore.write(input({ source: "claude" }), { caller: "tool" });
    expect(record.source).toBe("ppm");
  });

  it("reads back what it wrote and lists it", async () => {
    const { record } = await memoryStore.write(input({ name: "Listed one" }), { caller: "tool" });
    const read = await memoryStore.read(record.id, "project", projectPath);
    expect(read).not.toBeNull();
    expect(read!.revision).toBe(record.revision);
    expect(read!.name).toBe("Listed one");
    const ids = (await memoryStore.list("project", projectPath)).map((m) => m.id);
    expect(ids).toContain(record.id);
  });

  it("reads a missing memory as null and lists a missing folder as empty", async () => {
    expect(await memoryStore.read("m-00000000", "project", projectPath)).toBeNull();
    expect(await memoryStore.list("project", join(home, "never-used"))).toEqual([]);
  });
});

describe("memory store: update", () => {
  it("updates when the revision matches, keeping id and created, stamping updated", async () => {
    const first = (await memoryStore.write(input(), { caller: "tool" })).record;
    await Bun.sleep(5);
    const { record, created } = await memoryStore.write(
      input({ id: first.id, body: "Quote every list variable, always." }),
      { caller: "tool", expectedRevision: first.revision },
    );
    expect(created).toBe(false);
    expect(record.id).toBe(first.id);
    expect(record.created).toBe(first.created);
    expect(record.updated >= first.updated).toBe(true);
    expect(record.revision).not.toBe(first.revision);
    const onDisk = await memoryStore.read(first.id, "project", projectPath);
    expect(onDisk?.body).toBe("Quote every list variable, always.");
    expect(onDisk?.revision).toBe(record.revision);
  });

  it("fails on a revision mismatch, carrying the current revision, and changes nothing", async () => {
    const first = (await memoryStore.write(input(), { caller: "tool" })).record;
    const err = await rejection(memoryStore.write(input({ id: first.id, body: "stale" }), { caller: "tool", expectedRevision: "000000000000" }));
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect((err as MemoryStoreError).code).toBe("revision-mismatch");
    expect((err as MemoryStoreError).currentRevision).toBe(first.revision);
    expect((err as Error).message).toContain(first.revision);
    expect((await memoryStore.read(first.id, "project", projectPath))?.body).toBe("Quote every list variable.");
  });

  it("a tool update without a revision is a mismatch too", async () => {
    const first = (await memoryStore.write(input(), { caller: "tool" })).record;
    const err = await rejection(memoryStore.write(input({ id: first.id }), { caller: "tool" }));
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect((err as MemoryStoreError).currentRevision).toBe(first.revision);
  });

  it("a tool update of a memory that does not exist is not-found", async () => {
    const err = await rejection(memoryStore.write(input({ id: "m-deadbeef" }), { caller: "tool", expectedRevision: "000000000000" }));
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect((err as MemoryStoreError).code).toBe("not-found");
  });

  it("refuses an id that would leave the folder", async () => {
    for (const id of ["../escape", "a/b", "..", ".hidden"]) {
      const err = await rejection(memoryStore.write(input({ id }), { caller: "sync" }));
      expect(err).toBeInstanceOf(MemoryStoreError);
      expect((err as MemoryStoreError).code).toBe("invalid");
    }
  });
});

describe("memory store: imported memories", () => {
  it("sync may create and overwrite a provider's copy; a tool write or archive of it is refused", async () => {
    const sync = await memoryStore.write(
      input({ id: "claude-shell", source: "claude", origin: "/fake/claude/shell.md", originHash: "aaa" }),
      { caller: "sync" },
    );
    expect(sync.created).toBe(true);
    expect(sync.record.id).toBe("claude-shell");
    expect(sync.record.source).toBe("claude");
    expect(sync.record.originHash).toBe("aaa");

    const toolWrite = await rejection(memoryStore.write(
      input({ id: "claude-shell", body: "changed by AI" }),
      { caller: "tool", expectedRevision: sync.record.revision },
    ));
    expect(toolWrite).toBeInstanceOf(MemoryStoreError);
    expect((toolWrite as MemoryStoreError).code).toBe("imported");
    expect((toolWrite as Error).message).toContain("save a new PPM memory instead");

    const toolArchive = await rejection(memoryStore.archive("claude-shell", "project", projectPath, { caller: "tool" }));
    expect(toolArchive).toBeInstanceOf(MemoryStoreError);
    expect((toolArchive as Error).message).toContain("save a new PPM memory instead");
    expect((await memoryStore.read("claude-shell", "project", projectPath))?.archived).toBeUndefined();

    const again = await memoryStore.write(
      input({ id: "claude-shell", source: "claude", body: "new original", originHash: "bbb" }),
      { caller: "sync" },
    );
    expect(again.created).toBe(false);
    expect(again.record.body).toBe("new original");
    expect(again.record.originHash).toBe("bbb");
    expect(again.record.created).toBe(sync.record.created);

    const archived = await memoryStore.archive("claude-shell", "project", projectPath, { caller: "sync" });
    expect(archived.record.archived).toBe(true);
  });
});

describe("memory store: archive", () => {
  it("keeps the file and marks it archived", async () => {
    const { record } = await memoryStore.write(input({ name: "To forget" }), { caller: "tool" });
    const { record: archived } = await memoryStore.archive(record.id, "project", projectPath, { caller: "tool" });
    expect(archived.archived).toBe(true);
    const file = join(projectMemoryDir(projectPath), `${record.id}.md`);
    expect(existsSync(file)).toBe(true);
    const parsed = parseMemoryFile(readFileSync(file, "utf8"), record.id, "project");
    expect(parsed.archived).toBe(true);
    expect(parsed.name).toBe("To forget");
    expect(parsed.revision).toBe(archived.revision);
  });

  it("archiving a missing memory is not-found", async () => {
    const err = await rejection(memoryStore.archive("m-12345678", "project", projectPath, { caller: "tool" }));
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect((err as MemoryStoreError).code).toBe("not-found");
  });
});

describe("memory store: secrets", () => {
  it("redacts before the file is written and returns the count", async () => {
    const key = `sk-ant-${"a1".repeat(20)}`;
    const { record, redacted } = await memoryStore.write(
      input({ body: `Use ${key} for the API.\npassword=hunter2hunter2` }),
      { caller: "tool" },
    );
    expect(redacted).toBe(2);
    const file = join(projectMemoryDir(projectPath), `${record.id}.md`);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(key);
    expect(text).not.toContain("hunter2hunter2");
    expect(text).toContain("[REDACTED]");
    expect(record.body).toContain("[REDACTED]");
  });

  it("redacts the name and description too", async () => {
    const { record, redacted } = await memoryStore.write(
      input({ name: "token=abcdefgh12345", description: `key ghp_${"x".repeat(30)}` }),
      { caller: "tool" },
    );
    expect(redacted).toBe(2);
    expect(record.name).not.toContain("abcdefgh12345");
    expect(record.description).not.toContain("ghp_");
  });
});

describe("memory store: one lock per folder", () => {
  it("serialises two updates naming the same revision: one wins, the other sees the winner's revision", async () => {
    const first = (await memoryStore.write(input(), { caller: "tool" })).record;
    const results = await Promise.allSettled([
      memoryStore.write(input({ id: first.id, body: "A" }), { caller: "tool", expectedRevision: first.revision }),
      memoryStore.write(input({ id: first.id, body: "B" }), { caller: "tool", expectedRevision: first.revision }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    const winner = (ok[0] as PromiseFulfilledResult<{ record: { revision: string; body: string } }>).value.record;
    expect(failed[0].reason).toBeInstanceOf(MemoryStoreError);
    expect((failed[0].reason as MemoryStoreError).currentRevision).toBe(winner.revision);
    expect((await memoryStore.read(first.id, "project", projectPath))?.body).toBe(winner.body);
  });

  it("many concurrent writes to one folder all land", async () => {
    const p = join(home, "busy-project");
    const writes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => memoryStore.write(input({ projectPath: p, name: `n${i}` }), { caller: "tool" })),
    );
    expect(new Set(writes.map((w) => w.record.id)).size).toBe(20);
    expect((await memoryStore.list("project", p)).length).toBe(20);
  });
});

describe("memory store: scopes", () => {
  it("puts project memories in the project's folder and global ones in the shared folder", async () => {
    expect(memoryDir("global")).toBe(globalMemoryDir());
    expect(memoryDir("project", projectPath)).toBe(projectMemoryDir(projectPath));

    const p = join(home, "scoped-project");
    const proj = (await memoryStore.write(input({ projectPath: p, name: "project one" }), { caller: "tool" })).record;
    const glob = (await memoryStore.write(input({ scope: "global", projectPath: undefined, name: "global one" }), { caller: "tool" })).record;
    expect(glob.scope).toBe("global");
    expect(existsSync(join(projectMemoryDir(p), `${proj.id}.md`))).toBe(true);
    expect(existsSync(join(globalMemoryDir(), `${glob.id}.md`))).toBe(true);
    expect(existsSync(join(projectMemoryDir(p), "project.json"))).toBe(true);

    const projIds = (await memoryStore.list("project", p)).map((m) => m.id);
    const globIds = (await memoryStore.list("global")).map((m) => m.id);
    expect(projIds).toEqual([proj.id]);
    expect(globIds).toContain(glob.id);
    expect(globIds).not.toContain(proj.id);
    expect(await memoryStore.read(proj.id, "global")).toBeNull();
    expect(basename(memoryDir("global"))).toBe("global");
  });

  it("a project-scope call with no project path is invalid", async () => {
    const err = await rejection(memoryStore.write(input({ projectPath: undefined }), { caller: "tool" }));
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect((err as MemoryStoreError).code).toBe("invalid");
  });
});
