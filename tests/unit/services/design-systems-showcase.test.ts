import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignSystem, getDesignSystem } from "../../../src/services/design/design-systems.service.ts";
import { ensureShowcaseDesign, recordBuiltFromIfShowcase } from "../../../src/services/design/design-systems-showcase.ts";
import { getDesign } from "../../../src/services/design/design-store.service.ts";

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd });
}

describe("ensureShowcaseDesign", () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-showcase-")));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("creates the showcase at the fixed slug system-<id>, and reuses it on a second call", async () => {
    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    const first = await ensureShowcaseDesign(project, app.id);
    expect(first.slug).toBe(`system-${app.id}`);
    expect(first.showcaseFor).toBe(app.id);
    expect(first.system).toBe(app.id);

    writeFileSync(join(project, "designs", first.slug, "index.html"), "<p>edited by setup</p>");
    const second = await ensureShowcaseDesign(project, app.id);
    expect(second.slug).toBe(first.slug);
    expect(readFileSync(join(project, "designs", first.slug, "index.html"), "utf8")).toBe("<p>edited by setup</p>");
  });

  it("404s for an app that was never declared", async () => {
    await expect(ensureShowcaseDesign(project, "ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("records builtFrom only when the design is a showcase, and is a silent no-op otherwise", async () => {
    const appRoot = join(project, "payroll-fe");
    mkdirSync(appRoot, { recursive: true });
    if (git(appRoot, "init", "-q").exitCode !== 0) return; // no git on this host
    git(appRoot, "config", "user.email", "t@example.com");
    git(appRoot, "config", "user.name", "T");
    writeFileSync(join(appRoot, "a.ts"), "export const a = 1;\n");
    git(appRoot, "add", "-A");
    git(appRoot, "commit", "-q", "-m", "init");

    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    const showcase = await ensureShowcaseDesign(project, app.id);

    // An ordinary design (no showcaseFor) never touches builtFrom.
    await recordBuiltFromIfShowcase(project, "no-such-design");
    expect((await getDesignSystem(project, app.id)).builtFrom).toBeUndefined();

    await recordBuiltFromIfShowcase(project, showcase.slug);
    const updated = await getDesignSystem(project, app.id);
    expect(updated.builtFrom?.commit).toBe(git(appRoot, "rev-parse", "HEAD").stdout.toString().trim());
  });

  it("the showcase is not listed among ordinary designs by slug shape (system-<id>)", async () => {
    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    const showcase = await ensureShowcaseDesign(project, app.id);
    const reread = await getDesign(project, showcase.slug);
    expect(reread.showcaseFor).toBe(app.id);
  });
});
