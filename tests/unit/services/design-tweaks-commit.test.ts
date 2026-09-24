import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { commitTweaks, readDesignTweaks, StaleTweakGenError } from "../../../src/services/design/design-tweaks-commit.service.ts";
import { listSnapshots } from "../../../src/services/design/design-snapshots.service.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";
import { TWEAK_INJECTIONS } from "../../fixtures/design-tweak-injections.ts";
import { undoEdit } from "../../../src/services/design/design-edit-undo-journal.ts";
import { designWriteClock, resetDesignWriteLimits } from "../../../src/services/design/design-write-rate-limit.ts";

const PAGE = '<!doctype html><html><head><style>:root { --accent: #111111; }</style><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="../tokens.css"></head><body><h1>Hi</h1></body></html>';
const THEME = ":root {\n  --radius: 4px;\n}\n.card { border-radius: var(--radius); }\n";
const TWEAKS = [
  { id: "accent", label: "Accent", type: "color", var: "--accent", default: "#000000" },
  { id: "radius", label: "Radius", type: "range", var: "--radius", min: 0, max: 32, step: 1, unit: "px", default: 4 },
  { id: "gap", label: "Gap", type: "range", var: "--gap", min: 0, max: 64, step: 2, unit: "px", default: 8 },
  { id: "font", label: "Font", type: "select", var: "--font", options: [{ label: "Sans", value: "Inter, sans-serif" }], default: "Inter, sans-serif" },
  { id: "shared", label: "Shared", type: "color", var: "--shared", default: "#000000" },
];

describe("commitTweaks", () => {
  let project: string;
  let dir: string;
  const gens = () => ({ "index.html": computeGen(read("index.html")), "theme.css": computeGen(read("theme.css")) });
  const read = (file: string) => readFileSync(join(dir, file), "utf8");
  const commit = (values: Record<string, string>, over: Record<string, unknown> = {}) =>
    commitTweaks(project, "home", { entry: "index.html", gens: gens(), values, ...over });

  const realNow = designWriteClock.now;
  beforeEach(async () => {
    resetDesignWriteLimits();
    let now = 1_000_000;
    // Writes a second apart: the canvas write limit is covered by its own tests.
    designWriteClock.now = () => (now += 1000);
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-tweaks-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    writeFileSync(join(dir, "index.html"), PAGE);
    writeFileSync(join(dir, "theme.css"), THEME);
    writeFileSync(join(project, "designs", "tokens.css"), ":root { --shared: #999999; }\n");
    const manifest = JSON.parse(read("design.json"));
    writeFileSync(join(dir, "design.json"), JSON.stringify({ ...manifest, tweaks: [...TWEAKS, { id: "bad" }] }));
  });
  afterEach(() => {
    designWriteClock.now = realNow;
    rmSync(project, { recursive: true, force: true });
  });

  it("reads the declared tweaks and the reasons for skipped ones", async () => {
    const info = await readDesignTweaks(project, "home");
    expect(info.manifestValid).toBe(true);
    expect(info.tweaks.map((t) => t.id)).toEqual(["accent", "radius", "gap", "font", "shared"]);
    expect(info.errors).toHaveLength(1);
  });

  it("patches each winning declaration, appends a missing one, snapshots first and returns fresh gens", async () => {
    const before = { html: read("index.html"), theme: read("theme.css") };
    const out = await commit({ "--accent": "#6366f1", "--radius": "12px", "--gap": "16px" });
    expect(read("index.html")).toBe(before.html.replace("#111111", "#6366f1"));
    expect(read("theme.css")).toBe(`${THEME.replace("4px", "12px")}\n:root {\n  --gap: 16px;\n}\n`);
    expect(out.gens).toEqual(gens());
    expect(out.undoId).toMatch(/^[0-9a-f]{16}$/);
    expect(read("../tokens.css")).toBe(":root { --shared: #999999; }\n");
    const history = await listSnapshots(project, "home");
    expect(history.map((s) => s.reason)).toEqual(["before-edit"]);
  });

  it("rejects a stale gen on the HTML or on a CSS file it reads, before writing anything", async () => {
    for (const stale of [{ "index.html": "0000000000000000" }, { "theme.css": "0000000000000000" }]) {
      const error = await commit({ "--accent": "#6366f1" }, { gens: { ...gens(), ...stale } }).catch((e) => e);
      expect(error).toBeInstanceOf(StaleTweakGenError);
      const file = Object.keys(stale)[0]!;
      expect(error).toMatchObject({ status: 409, file, currentGen: computeGen(read(file)) });
    }
    const missing = await commit({ "--accent": "#6366f1" }, { gens: { "index.html": computeGen(read("index.html")) } }).catch((e) => e);
    expect(missing).toMatchObject({ status: 409, file: "theme.css" });
    expect(read("index.html")).toBe(PAGE);
    expect(await listSnapshots(project, "home")).toEqual([]);
  });

  it("answers 400 for a variable the manifest does not declare or a value its type refuses", async () => {
    await expect(commit({ "--unknown": "#6366f1" })).rejects.toMatchObject({ status: 400 });
    await expect(commit({ "--radius": "99px" })).rejects.toMatchObject({ status: 400 });
    await expect(commit({})).rejects.toMatchObject({ status: 400 });
    await expect(commitTweaks(project, "home", { entry: "../x.html", gens: gens(), values: { "--accent": "#fff" } })).rejects.toMatchObject({ status: 400 });
  });

  it("lets no injection string reach a file", async () => {
    for (const value of TWEAK_INJECTIONS) {
      for (const name of ["--accent", "--radius", "--font"]) {
        await expect(commit({ [name]: value })).rejects.toMatchObject({ status: 400 });
      }
    }
    expect(read("index.html")).toBe(PAGE);
    expect(read("theme.css")).toBe(THEME);
  });

  it("refuses a variable that the shared tokens.css sets last", async () => {
    await expect(commit({ "--shared": "#6366f1" })).rejects.toMatchObject({ status: 422 });
    expect(read("../tokens.css")).toBe(":root { --shared: #999999; }\n");
  });

  it("undoes an Apply exactly: the :root value comes back and a later edit elsewhere stays", async () => {
    const out = await commit({ "--radius": "12px" });
    const later = `${read("theme.css")}.later { color: teal; }\n`;
    writeFileSync(join(dir, "theme.css"), later);
    await undoEdit(project, "home", out.undoId);
    expect(read("theme.css")).toBe(`${THEME}.later { color: teal; }\n`);
    expect(read("index.html")).toBe(PAGE);
  });

  it("counts a commit that writes against the canvas write limit, and one that writes nothing not at all", async () => {
    const t = 5_000_000;
    designWriteClock.now = () => t;
    await commit({ "--accent": "#6366f1" });
    await expect(commit({ "--radius": "20px" })).rejects.toMatchObject({ status: 429 });
    // Already in place: nothing is written, so nothing is counted or refused.
    await expect(commit({ "--accent": "#6366f1" })).resolves.toMatchObject({ undoId: null });
  });

  it("serialises concurrent commits under the design lock", async () => {
    const first = commit({ "--accent": "#6366f1" });
    const second = commit({ "--radius": "20px" });
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe("fulfilled");
    // The second request carried gens from before the first one wrote the HTML.
    expect(results[1]).toMatchObject({ status: "rejected", reason: { status: 409, file: "index.html" } });
    expect(read("theme.css")).toBe(THEME);
    expect(read("index.html")).toContain("#6366f1");
  });
});
