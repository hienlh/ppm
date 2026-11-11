import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { projectAddTool, projectFolderRefusal } from "../../../../src/services/assistant-mcp/assistant-project-add-tool.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";

type Result = { content: Array<{ text: string }>; isError?: boolean };

function setup(opts: { verdict?: ApprovalVerdict; projects?: { name: string; path: string }[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ppm-project-add-"));
  const home = join(root, "home");
  const ppmDir = join(home, ".ppm");
  const folder = join(home, "code", "nxsys");
  mkdirSync(join(folder, ".git"), { recursive: true });
  mkdirSync(ppmDir, { recursive: true });
  const projects = [...(opts.projects ?? [])];
  const asked: ApprovalAsk[] = [];
  const added: Array<{ path: string; name?: string }> = [];
  let announced = 0;
  const ask = async (a: ApprovalAsk): Promise<ApprovalVerdict> => {
    asked.push(a);
    return opts.verdict ?? { verdict: "approved" };
  };
  const deps = {
    home, ppmDir,
    list: () => projects,
    add: (path: string, name?: string) => {
      added.push({ path, name });
      const entry = { path, name: name ?? "x" };
      projects.push(entry);
      return entry;
    },
    announce: () => { announced++; },
  };
  const run = (args: Record<string, unknown>) => projectAddTool(args, ask, deps) as Promise<Result>;
  return { root, home, ppmDir, folder, projects, asked, added, run, announcedCount: () => announced };
}

describe("project_add", () => {
  it("registers the folder after the user approves a card naming it exactly, and tells open PPMs", async () => {
    const t = setup();
    const res = await t.run({ path: t.folder });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text)).toEqual({ added: true, name: "nxsys", path: t.folder });
    expect(t.asked).toHaveLength(1);
    const card = t.asked[0]!.summary;
    expect(card.headline).toBe("Add nxsys as a PPM project");
    expect(card.facts).toEqual(expect.arrayContaining([
      { label: "Folder", value: t.folder }, { label: "Name", value: "nxsys" }, { label: "Git repository", value: "Yes" },
    ]));
    expect(t.added).toEqual([{ path: t.folder, name: "nxsys" }]);
    expect(t.announcedCount()).toBe(1);
  });

  it("uses the name it is given", async () => {
    const t = setup();
    const res = await t.run({ path: t.folder, name: "Nxsys backend" });
    expect(JSON.parse(res.content[0]!.text).name).toBe("Nxsys backend");
    expect(t.added).toEqual([{ path: t.folder, name: "Nxsys backend" }]);
  });

  it("adds nothing when the user declines", async () => {
    const t = setup({ verdict: { verdict: "denied", reason: "The user declined." } });
    const res = await t.run({ path: t.folder });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Not added");
    expect(t.added).toEqual([]);
    expect(t.announcedCount()).toBe(0);
  });

  it("refuses a drive, the home folder, a folder holding it, and PPM's own folder without asking", async () => {
    const t = setup();
    for (const path of [parse(t.home).root, t.home, t.root, t.ppmDir, join(t.ppmDir, "codex-accounts")]) {
      mkdirSync(path, { recursive: true });
      const res = await t.run({ path });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("add it themselves");
    }
    expect(t.asked).toEqual([]);
    expect(t.added).toEqual([]);
  });

  it("refuses a folder or a name already registered, before asking", async () => {
    const t = setup({ projects: [{ name: "nxsys-old", path: "" }] });
    t.projects[0]!.path = t.folder;
    const samePath = await t.run({ path: t.folder });
    expect(samePath.content[0]!.text).toContain('already the project "nxsys-old"');
    const other = join(t.home, "code", "other");
    mkdirSync(other, { recursive: true });
    const sameName = await t.run({ path: other, name: "nxsys-old" });
    expect(sameName.content[0]!.text).toContain('already named "nxsys-old"');
    expect(t.asked).toEqual([]);
  });

  it("refuses a missing path, a file, a relative path and a missing path argument", async () => {
    const t = setup();
    const file = join(t.home, "code", "notes.txt");
    writeFileSync(file, "x");
    expect((await t.run({ path: join(t.home, "nope") })).content[0]!.text).toContain("There is no folder");
    expect((await t.run({ path: file })).content[0]!.text).toContain("is a file");
    expect((await t.run({ path: "code/nxsys" })).content[0]!.text).toContain("must be a full path");
    expect((await t.run({})).content[0]!.text).toContain("`path` is required");
    expect((await t.run({ path: t.folder, name: " " })).content[0]!.text).toContain("non-empty name");
    expect(t.asked).toEqual([]);
  });

  it("adds nothing when the folder was registered while the card waited", async () => {
    const t = setup();
    const ask = async (): Promise<ApprovalVerdict> => {
      t.projects.push({ name: "elsewhere", path: t.folder });
      return { verdict: "approved" };
    };
    const res = await projectAddTool({ path: t.folder }, ask, { home: t.home, ppmDir: t.ppmDir, list: () => t.projects, add: () => { throw new Error("must not add"); } }) as Result;
    expect(res.content[0]!.text).toContain('already the project "elsewhere"');
  });

  it("judges a folder by where it is, not by how its path is spelled", () => {
    const home = resolve("/users/me");
    expect(projectFolderRefusal(resolve(home, "code", "app"), home, resolve(home, ".ppm"))).toBeNull();
    expect(projectFolderRefusal(resolve(home, "code", ".."), home, resolve(home, ".ppm"))).toContain("home folder");
  });
});
