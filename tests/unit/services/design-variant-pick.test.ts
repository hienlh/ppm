import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesign, getDesign } from "../../../src/services/design/design-store.service.ts";
import { commentsAfterVariantPick, pickDesignVariant } from "../../../src/services/design/design-variant-pick.service.ts";
import { readComments, writeComments } from "../../../src/services/design/comments/design-comments-store.ts";
import type { DesignComment } from "../../../src/shared/design-comment-types.ts";
import { listSnapshots, snapshotDesign } from "../../../src/services/design/design-snapshots.service.ts";
import { restoreSnapshot } from "../../../src/services/design/design-restore.service.ts";
import { snapshotFilesDir } from "../../../src/services/design/design-snapshot-history.ts";
import { onDesignEvent } from "../../../src/services/design/design-events.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";

const PAGES = { "index.html": "<h1>Calm</h1>", "variant-2.html": "<h1>Bold</h1>", "variant-3.html": "<h1>Playful</h1>" };
const LIST = [{ file: "index.html", label: "Calm" }, { file: "variant-2.html", label: "Bold" }, { file: "variant-3.html", label: "Playful" }];

describe("design variants on disk", () => {
  let project: string;
  let dir: string;
  const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
  const manifest = () => JSON.parse(read("design.json")) as Record<string, unknown>;
  const writeManifest = (extra: Record<string, unknown>) =>
    writeFileSync(join(dir, "design.json"), JSON.stringify({ ...manifest(), ...extra }));

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-variants-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    for (const [file, html] of Object.entries(PAGES)) writeFileSync(join(dir, file), html);
    writeManifest({ variants: LIST, agentNote: "keep" });
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("lists only variants whose file exists, and says why the others are missing", async () => {
    rmSync(join(dir, "variant-3.html"));
    writeManifest({ variants: [...LIST, { file: "../escape.html" }] });
    const design = await getDesign(project, "home");
    expect(design.variants).toEqual(LIST.slice(0, 2));
    expect(design.variantWarnings).toHaveLength(2);
    expect(design.variantWarnings!.join(" ")).toContain("variant-3.html is listed in design.json but is not a file");
    writeManifest({ variants: undefined });
    const plain = await getDesign(project, "home");
    expect(plain.variants).toEqual([{ file: "index.html", label: "" }]);
    expect(plain.variantWarnings).toBeUndefined();
  });

  it("snapshots every variant first, then keeps the chosen one as the entry", async () => {
    const events: string[] = [];
    const off = onDesignEvent((type, p) => { if (p.slug === "home") events.push(type); });
    try {
      const result = await pickDesignVariant(project, "home", { file: "variant-2.html", gen: computeGen(PAGES["variant-2.html"]) });
      expect(read("index.html")).toBe(PAGES["variant-2.html"]);
      expect(existsSync(join(dir, "variant-2.html"))).toBe(false);
      expect(existsSync(join(dir, "variant-3.html"))).toBe(false);
      expect(manifest()).toMatchObject({ variants: [{ file: "index.html", label: "Bold" }], agentNote: "keep", kind: "page" });
      expect(result.design.variants).toEqual([{ file: "index.html", label: "Bold" }]);

      const snapshot = (await listSnapshots(project, "home")).find((s) => s.id === result.snapshotId);
      expect(snapshot).toMatchObject({ reason: "pre-variant-pick" });
      for (const [file, html] of Object.entries(PAGES)) {
        expect(readFileSync(join(snapshotFilesDir(dir, result.snapshotId), file), "utf8")).toBe(html);
      }
      expect(events).toContain("history_changed");

      await restoreSnapshot(project, "home", result.snapshotId);
      expect((await getDesign(project, "home")).variants).toEqual(LIST);
    } finally {
      off();
    }
  });

  it("moves the kept variant's comments to the entry and resolves the discarded ones", async () => {
    const at = "2026-09-01T00:00:00.000Z";
    const note = (id: string, file: string, extra: Partial<DesignComment> = {}): DesignComment => ({
      id, file, body: `note ${id}`, snippet: null, createdAt: at, updatedAt: at,
      anchor: { file, ppmId: 0, gen: null, tag: "h1", cssPath: "h1", quote: { exact: "x", prefix: "", suffix: "" } }, ...extra,
    });
    // Comment ids are 12 hex digits; the name of each is kept in its body.
    const ids = { kept: "00000000000a", oldentry: "00000000000b", third: "00000000000c", done: "00000000000d", elsewhere: "00000000000e" };
    await writeComments(dir, [
      note(ids.kept, "variant-2.html"), note(ids.oldentry, "index.html"), note(ids.third, "variant-3.html"),
      note(ids.done, "variant-3.html", { resolvedAt: at }), note(ids.elsewhere, "about.html"),
    ]);
    const events: string[] = [];
    const off = onDesignEvent((type, p) => { if (p.slug === "home") events.push(type); });
    try {
      await pickDesignVariant(project, "home", { file: "variant-2.html", gen: computeGen(PAGES["variant-2.html"]) });
    } finally {
      off();
    }
    const stored = await readComments(dir);
    expect(stored).toHaveLength(5);
    const byId = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, stored.find((c) => c.id === id)]));
    expect(byId.kept).toMatchObject({ file: "index.html", anchor: { file: "index.html" } });
    expect(byId.kept!.resolvedAt).toBeUndefined();
    expect(byId.oldentry!.resolvedAt).toBeString();
    expect(byId.third!.resolvedAt).toBeString();
    expect(byId.done!.resolvedAt).toBe(at);
    expect(byId.elsewhere).toMatchObject({ file: "about.html" });
    expect(byId.elsewhere!.resolvedAt).toBeUndefined();
    expect(events).toContain("comments_changed");
  });

  it("changes no comment when variant 1 is kept and its notes are on it", () => {
    const c = { id: "a", file: "index.html", anchor: { file: "index.html" } } as unknown as DesignComment;
    expect(commentsAfterVariantPick([c], "index.html", "index.html", ["index.html", "variant-2.html"], "now")).toBeNull();
  });

  it("keeping variant 1 leaves the entry as it is and deletes the others", async () => {
    await pickDesignVariant(project, "home", { file: "index.html", gen: computeGen(PAGES["index.html"]) });
    expect(read("index.html")).toBe(PAGES["index.html"]);
    expect(existsSync(join(dir, "variant-2.html"))).toBe(false);
    expect(manifest().variants).toEqual([{ file: "index.html", label: "Calm" }]);
  });

  it("reuses an identical snapshot rather than copying the tree again", async () => {
    const taken = await snapshotDesign(project, "home", "turn");
    const result = await pickDesignVariant(project, "home", { file: "variant-3.html", gen: computeGen(PAGES["variant-3.html"]) });
    if (!("id" in taken)) throw new Error("the turn snapshot was not taken");
    expect(result.snapshotId).toBe(taken.id);
    expect((await listSnapshots(project, "home")).filter((s) => s.reason === "pre-variant-pick")).toHaveLength(0);
  });

  it("refuses a variant that changed since the canvas loaded it, touching nothing", async () => {
    await expect(pickDesignVariant(project, "home", { file: "variant-2.html", gen: computeGen("older text") }))
      .rejects.toMatchObject({ status: 409 });
    expect(read("variant-2.html")).toBe(PAGES["variant-2.html"]);
    expect(read("index.html")).toBe(PAGES["index.html"]);
    expect(await listSnapshots(project, "home")).toEqual([]);
  });

  it("rejects bad input, unknown variants and a design with one variant", async () => {
    const gen = computeGen(PAGES["variant-2.html"]);
    for (const body of [null, [], { file: "../x.html", gen }, { file: "variant-2.html" }, { file: "variant-2.html", gen: "zz" }]) {
      await expect(pickDesignVariant(project, "home", body)).rejects.toMatchObject({ status: 400 });
    }
    await expect(pickDesignVariant(project, "home", { file: "stray.html", gen })).rejects.toMatchObject({ status: 404 });
    writeManifest({ variants: [LIST[0]] });
    await expect(pickDesignVariant(project, "home", { file: "index.html", gen: computeGen(PAGES["index.html"]) }))
      .rejects.toMatchObject({ status: 409 });
    writeFileSync(join(dir, "design.json"), "{ broken");
    await expect(pickDesignVariant(project, "home", { file: "variant-2.html", gen })).rejects.toMatchObject({ status: 409 });
    expect(existsSync(join(dir, "variant-2.html"))).toBe(true);
  });
});
