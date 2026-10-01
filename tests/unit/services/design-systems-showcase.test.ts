import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignSystem, getDesignSystem } from "../../../src/services/design/design-systems.service.ts";
import { ensureShowcaseDesign, recordBuiltFromAfterDesignTurn } from "../../../src/services/design/design-systems-showcase.ts";
import { createDesign, getDesign } from "../../../src/services/design/design-store.service.ts";

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

  it("a showcase session's finished turn always (re-)stamps builtFrom, unconditionally", async () => {
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

    // A design that does not even exist never touches builtFrom.
    await recordBuiltFromAfterDesignTurn(project, "no-such-design");
    expect((await getDesignSystem(project, app.id)).builtFrom).toBeUndefined();

    await recordBuiltFromAfterDesignTurn(project, showcase.slug);
    const firstHead = git(appRoot, "rev-parse", "HEAD").stdout.toString().trim();
    expect((await getDesignSystem(project, app.id)).builtFrom?.commit).toBe(firstHead);

    // A manual re-run (the stale "Refresh" flow) must bump builtFrom again, even though it
    // is already set — that refresh is the only thing left that can ever clear "may be
    // outdated", so this path may not be gated on builtFrom being absent.
    writeFileSync(join(appRoot, "b.ts"), "export const b = 2;\n");
    git(appRoot, "add", "-A");
    git(appRoot, "commit", "-q", "-m", "second");
    await recordBuiltFromAfterDesignTurn(project, showcase.slug);
    const secondHead = git(appRoot, "rev-parse", "HEAD").stdout.toString().trim();
    expect(secondHead).not.toBe(firstHead);
    expect((await getDesignSystem(project, app.id)).builtFrom?.commit).toBe(secondHead);
  });

  it("an ordinary design's turn stamps builtFrom only the first time its system's DESIGN.md lands, never again", async () => {
    const appRoot = join(project, "payroll-fe");
    mkdirSync(appRoot, { recursive: true });
    if (git(appRoot, "init", "-q").exitCode !== 0) return; // no git on this host
    git(appRoot, "config", "user.email", "t@example.com");
    git(appRoot, "config", "user.name", "T");
    writeFileSync(join(appRoot, "a.ts"), "export const a = 1;\n");
    git(appRoot, "add", "-A");
    git(appRoot, "commit", "-q", "-m", "init");

    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    const design = await createDesign(project, { title: "Home", kind: "page", system: app.id });

    // The system is not set up yet: an ordinary turn on this design must not stamp anything.
    await recordBuiltFromAfterDesignTurn(project, design.slug);
    expect((await getDesignSystem(project, app.id)).builtFrom).toBeUndefined();

    // The design's own turn just auto-set the system up (what the agent's Write tool would do).
    const systemDir = join(project, "designs", "systems", app.id);
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "DESIGN.md"), "# Payroll\n");
    await recordBuiltFromAfterDesignTurn(project, design.slug);
    const firstHead = git(appRoot, "rev-parse", "HEAD").stdout.toString().trim();
    expect((await getDesignSystem(project, app.id)).builtFrom?.commit).toBe(firstHead);

    // A later, unrelated edit turn on the same design must never bump it again, or the stale
    // check could never trigger.
    writeFileSync(join(appRoot, "b.ts"), "export const b = 2;\n");
    git(appRoot, "add", "-A");
    git(appRoot, "commit", "-q", "-m", "second");
    await recordBuiltFromAfterDesignTurn(project, design.slug);
    expect((await getDesignSystem(project, app.id)).builtFrom?.commit).toBe(firstHead);
  });

  it("the showcase is not listed among ordinary designs by slug shape (system-<id>)", async () => {
    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    const showcase = await ensureShowcaseDesign(project, app.id);
    const reread = await getDesign(project, showcase.slug);
    expect(reread.showcaseFor).toBe(app.id);
  });
});
