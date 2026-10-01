import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import {
  createDesignSystem, deleteDesignSystem, getDesignSystem, listDesignSystems, recordBuiltFrom,
  resolveSystemForDesign, updateDesignSystem,
} from "../../../src/services/design/design-systems.service.ts";

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd });
}

describe("design systems service", () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-systems-")));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("lists only the implicit default app for a fresh project", async () => {
    const systems = await listDesignSystems(project);
    expect(systems).toEqual([{
      id: "default", label: "Default", root: ".", platform: "web", declared: false, hasDesignMd: false, hasTokensCss: false,
    }]);
  });

  it("declares a new app, giving a colliding slug a numeric suffix", async () => {
    const a = await createDesignSystem(project, { label: "Payroll FE", root: "payroll-fe", platform: "web" });
    expect(a).toMatchObject({ id: "payroll-fe", label: "Payroll FE", root: "payroll-fe", platform: "web", declared: true });
    const b = await createDesignSystem(project, { label: "Payroll FE", root: "payroll-fe-2", platform: "mobile" });
    expect(b.id).toBe("payroll-fe-2");
    const listed = (await listDesignSystems(project)).map((s) => s.id).sort();
    expect(listed).toEqual(["default", "payroll-fe", "payroll-fe-2"]);
    expect(existsSync(join(project, "designs", "systems", "payroll-fe", "system.json"))).toBe(true);
  });

  it("rejects a bad label, platform or root", async () => {
    await expect(createDesignSystem(project, { label: "  ", root: ".", platform: "web" })).rejects.toMatchObject({ status: 400 });
    await expect(createDesignSystem(project, { label: "X", root: ".", platform: "desktop" })).rejects.toMatchObject({ status: 400 });
    await expect(createDesignSystem(project, { label: "X", root: "../etc", platform: "web" })).rejects.toMatchObject({ status: 400 });
  });

  it("edits a declared app's label, folder and platform", async () => {
    const created = await createDesignSystem(project, { label: "Umbrella", root: "umbrella-fe", platform: "web" });
    const updated = await updateDesignSystem(project, created.id, { label: "Umbrella FE", platform: "mobile" });
    expect(updated).toMatchObject({ label: "Umbrella FE", platform: "mobile", root: "umbrella-fe" });
  });

  it("edits the default app's label/platform without a pre-existing file, but never its root", async () => {
    const updated = await updateDesignSystem(project, "default", { label: "Main app", platform: "web", root: "ignored" });
    expect(updated).toMatchObject({ id: "default", label: "Main app", root: "." });
    expect(existsSync(join(project, "designs", "systems", "default", "system.json"))).toBe(true);
  });

  it("404s editing an app that was never declared", async () => {
    await expect(updateDesignSystem(project, "ghost", { label: "X" })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to remove the default app, and un-declares vs. deletes files for a real one", async () => {
    await expect(deleteDesignSystem(project, "default")).rejects.toMatchObject({ status: 400 });
    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    const dir = join(project, "designs", "systems", app.id);
    writeFileSync(join(dir, "DESIGN.md"), "# Payroll");

    await deleteDesignSystem(project, app.id); // un-declare only
    expect(existsSync(join(dir, "system.json"))).toBe(false);
    expect(existsSync(join(dir, "DESIGN.md"))).toBe(true);
    expect((await listDesignSystems(project)).map((s) => s.id)).toEqual(["default"]);

    await createDesignSystem(project, { id: app.id, label: "Payroll", root: "payroll-fe", platform: "web" });
    await deleteDesignSystem(project, app.id, { deleteFiles: true });
    expect(existsSync(dir)).toBe(false);
  });

  it("records builtFrom from the app root's real HEAD, and is a no-op with no repo there", async () => {
    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    await recordBuiltFrom(project, app.id); // payroll-fe/ does not exist yet: no-op
    expect((await getDesignSystem(project, app.id)).builtFrom).toBeUndefined();

    const appRoot = join(project, "payroll-fe");
    mkdirSync(appRoot, { recursive: true });
    if (git(appRoot, "init", "-q").exitCode !== 0) return; // no git on this host
    git(appRoot, "config", "user.email", "t@example.com");
    git(appRoot, "config", "user.name", "T");
    writeFileSync(join(appRoot, "a.ts"), "export const a = 1;\n");
    git(appRoot, "add", "-A");
    git(appRoot, "commit", "-q", "-m", "init");
    const head = git(appRoot, "rev-parse", "HEAD").stdout.toString().trim();

    await recordBuiltFrom(project, app.id);
    const updated = await getDesignSystem(project, app.id);
    expect(updated.builtFrom?.commit).toBe(head);
    expect(Number.isNaN(Date.parse(updated.builtFrom!.at))).toBe(false);
  });

  it("resolves a design's app from its own manifest, defaulting when absent or the design is missing", async () => {
    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    const forApp = await createDesign(project, { title: "Home", kind: "page", system: app.id });
    expect((await resolveSystemForDesign(project, forApp.slug)).id).toBe(app.id);

    const plain = await createDesign(project, { title: "Other", kind: "page" });
    expect((await resolveSystemForDesign(project, plain.slug)).id).toBe("default");
    expect((await resolveSystemForDesign(project, "missing-design")).id).toBe("default");

    await expect(createDesign(project, { title: "X", kind: "page", system: "ghost-app" })).rejects.toMatchObject({ status: 404 });
  });
});
